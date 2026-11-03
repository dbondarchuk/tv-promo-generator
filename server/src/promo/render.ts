import fs from 'node:fs';
import path from 'node:path';
import { AppSettings, parseResolution } from '@promo/shared';
import { createLowerThirdBar } from '../color.js';
import {
  buildEncoderPlan,
  escapeDrawtext,
  escapeFilterPath,
  globalHwArgs,
  isHardwareEncodeFailure,
} from '../ffmpeg/hwaccel.js';
import {
  pickAudioStreamForLanguage,
  pickRandomWindows,
  probeAudioStreams,
  probeDurationSeconds,
} from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { describeVoiceRequest, synthesizeVoiceOver } from '../voice/tts.js';
import { formatEpisodeSubtitle, formatOverlayHeadline, VoiceCue } from '../voice/templates.js';
import {
  PHASE_SECONDS,
  PromoTiming,
  barPixelWidth,
  barXExprForCount,
  barXFixed,
  getPromoTiming,
  panelGeom,
  panelWidthExpr,
  panelXExpr,
} from './layout.js';
import { PromoChapterSource, PromoRenderRequest } from './types.js';

function expandToCount(chapters: PromoChapterSource[], count: number): PromoChapterSource[] {
  if (chapters.length === 0) {
    throw new Error('No chapters available to render');
  }

  const out: PromoChapterSource[] = [];
  let i = 0;
  while (out.length < count) {
    out.push(chapters[i % chapters.length]!);
    i += 1;
  }

  return out;
}

function phaseEnable(phaseIndex: number, phaseSeconds: number = PHASE_SECONDS): string {
  const start = phaseIndex * phaseSeconds;
  const end = start + phaseSeconds;

  // drawtext enable= is evaluated per-frame; escape commas for filtergraph.
  return `between(t\\,${start}\\,${end})`;
}

function buildFilterScript(
  settings: AppSettings,
  req: PromoRenderRequest,
  chapters: PromoChapterSource[],
  timing: PromoTiming,
  opts: {
    width: number;
    height: number;
    barPath: string;
    barH: number;
    hasVoice: boolean;
    voiceInput: number;
    silenceInput: number;
    barInput: number;
    logoInput?: number;
    /** Per-item source audio gate: audible only in [start, end). */
    sourceAudibleWindows: Array<{ start: number; end: number }>;
  },
): string {
  const { itemCount, totalSeconds, playSeconds, preFreezeSeconds } = timing;
  const g = panelGeom(opts.width, opts.height, itemCount);
  const plan = buildEncoderPlan(settings);
  const font = escapeFilterPath(req.fontFile);
  const titleSize = Math.round(opts.height * 0.042);
  const subSize = Math.round(opts.height * 0.026);
  const barMargin = 40;
  const barY = opts.height - opts.barH - 40;
  const textPadX = 36;
  const textPadY = 28;
  const fullWidthBar = settings.lowerThirdFullWidth || itemCount === 1;
  const barX = fullWidthBar ? barXFixed(barMargin) : barXExprForCount(g, itemCount, barMargin);

  const lines: string[] = [];

  // Prepare each item strip for the full promo duration (freeze first/last as needed).
  for (let i = 0; i < itemCount; i++) {
    const pre = preFreezeSeconds[i]!;
    const play = playSeconds[i]!;
    const post = Math.max(0, totalSeconds - pre - play);
    const tpad: string[] = [];
    if (pre > 0.001) tpad.push(`start_mode=clone:start_duration=${pre.toFixed(3)}`);
    if (post > 0.001) tpad.push(`stop_mode=clone:stop_duration=${post.toFixed(3)}`);

    const tpadFilter = tpad.length > 0 ? `,tpad=${tpad.join(':')}` : '';
    lines.push(
      `[${i}:v]fps=30,scale=${g.stripW}:${g.height}:force_original_aspect_ratio=increase,` +
        `crop=${g.stripW}:${g.height},setsar=1,format=yuv420p${tpadFilter},` +
        `trim=duration=${totalSeconds},setpts=PTS-STARTPTS[v${i}full]`,
    );
  }

  // Animated panel widths via scale=eval=frame (3-item). 1/2-item use constant widths.
  for (let i = 0; i < itemCount; i++) {
    const wExpr = panelWidthExpr(g, itemCount, i);
    lines.push(
      `[v${i}full]scale=w='${wExpr}':h=${g.height}:eval=frame:flags=bicubic[v${i}p]`,
    );
  }

  // Stack onto a black canvas.
  lines.push(
    `color=c=black:s=${opts.width}x${opts.height}:d=${totalSeconds}:r=30,format=yuv420p[base]`,
  );
  let overlayLabel = 'base';
  for (let i = 0; i < itemCount; i++) {
    const next = i === itemCount - 1 ? 'stacked' : `o${i}`;
    const xExpr = panelXExpr(g, itemCount, i);
    const xPart = xExpr === '0' ? 'x=0' : `x='${xExpr}'`;
    lines.push(
      `[${overlayLabel}][v${i}p]overlay=${xPart}:y=0:eof_action=pass[${next}]`,
    );
    overlayLabel = next;
  }

  // Lower-third: full-width fixed left, or tracks the focused panel.
  lines.push(
    fullWidthBar
      ? `[stacked][${opts.barInput}:v]overlay=x=${barX}:y=${barY}:eof_action=pass[withbar]`
      : `[stacked][${opts.barInput}:v]overlay=x='${barX}':y=${barY}:eof_action=pass[withbar]`,
  );

  let current = 'withbar';
  if (opts.logoInput !== undefined) {
    const logoSize = Math.round(opts.height * 0.18);
    const logoX = opts.width - logoSize - 48;
    const logoY = opts.height - logoSize - 48;
    lines.push(
      `[${opts.logoInput}:v]scale=${logoSize}:${logoSize}:force_original_aspect_ratio=decrease[logo]`,
      `[${current}][logo]overlay=${logoX}:${logoY}:eof_action=pass[withlogo]`,
    );
    current = 'withlogo';
  }

  // Per-phase labels (Next / After that).
  const drawParts: string[] = [];
  for (let i = 0; i < itemCount; i++) {
    const chapter = chapters[i]!;
    const cue: VoiceCue = i === 0 ? 'next' : 'after';
    const headline = escapeDrawtext(formatOverlayHeadline(req.language, cue, chapter.title));
    const subtitle = escapeDrawtext(
      formatEpisodeSubtitle(req.language, chapter.seasonNumber, chapter.episodeNumber, chapter.episodeTitle),
    );

    const startsAt = escapeDrawtext(chapter.startLabel);
    const enable = phaseEnable(i);
    const textX = fullWidthBar
      ? String(barMargin + textPadX)
      : `'${barX}+${textPadX}'`;
    drawParts.push(
      `drawtext=fontfile='${font}':text='${headline}':fontsize=${titleSize}:fontcolor=white:` +
        `x=${textX}:y=${barY + textPadY}:enable='${enable}'`,
    );

    if (subtitle) {
      drawParts.push(
        `drawtext=fontfile='${font}':text='${subtitle}':fontsize=${subSize}:fontcolor=white:` +
          `x=${textX}:y=${barY + textPadY + titleSize + 12}:enable='${enable}'`,
      );
    }

    drawParts.push(
      `drawtext=fontfile='${font}':text='${startsAt}':fontsize=${subSize}:fontcolor=white:` +
        `x=${textX}:y=${barY + textPadY + titleSize + (subtitle ? subSize + 24 : 12)}:enable='${enable}'`,
    );
  }

  lines.push(`[${current}]${drawParts.join(',')}[labelled]`);
  current = 'labelled';

  if (plan.filterSuffix.length > 0) {
    lines.push(`[${current}]${plan.filterSuffix.join(',')}[vout]`);
  } else {
    lines.push(`[${current}]format=yuv420p[vout]`);
  }

  const sourceVolPct = Math.max(0, Math.min(100, Math.round(settings.sourceAudioVolume ?? 0)));
  const sourceVol = sourceVolPct / 100;
  const aformat = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const mixLabels: string[] = [];

  if (sourceVol > 0) {
    const sourceLabels: string[] = [];
    for (let i = 0; i < itemCount; i++) {
      const chapter = chapters[i]!;
      if (chapter.hasAudio === false) continue;

      const window = opts.sourceAudibleWindows[i];
      if (!window || window.end - window.start < 0.05) continue;

      const pre = preFreezeSeconds[i]!;
      const preMs = Math.round(pre * 1000);
      const aIdx = Number.isFinite(chapter.audioStreamIndex) ? chapter.audioStreamIndex! : 0;
      const label = `sa${i}`;
      const start = window.start.toFixed(3);
      const end = window.end.toFixed(3);
      lines.push(
        `[${i}:a:${aIdx}]${aformat},` +
          `adelay=delays=${preMs}:all=1,` +
          `apad=whole_dur=${totalSeconds},atrim=0:${totalSeconds},asetpts=PTS-STARTPTS,` +
          `volume=${sourceVol.toFixed(4)},` +
          `volume=0:enable='lt(t\\,${start})+gte(t\\,${end})'[${label}]`,
      );
      sourceLabels.push(`[${label}]`);
    }

    if (sourceLabels.length === 1) {
      mixLabels.push(sourceLabels[0]!);
    } else if (sourceLabels.length > 1) {
      lines.push(
        `${sourceLabels.join('')}amix=inputs=${sourceLabels.length}:duration=first:dropout_transition=0:normalize=0,` +
          `atrim=0:${totalSeconds},asetpts=PTS-STARTPTS[sourcebed]`,
      );
      mixLabels.push('[sourcebed]');
    }
  }

  if (opts.hasVoice) {
    lines.push(
      `[${opts.voiceInput}:a]volume=1.0,atrim=0:${totalSeconds},asetpts=PTS-STARTPTS,` +
        `apad=whole_dur=${totalSeconds},${aformat}[voicebed]`,
    );
    mixLabels.push('[voicebed]');
  }

  if (mixLabels.length === 0) {
    lines.push(`[${opts.silenceInput}:a]anull[aout]`);
  } else if (mixLabels.length === 1) {
    lines.push(`${mixLabels[0]}${aformat}[aout]`);
  } else {
    lines.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,` +
        `atrim=0:${totalSeconds},asetpts=PTS-STARTPTS,${aformat}[aout]`,
    );
  }

  return lines.join(';');
}

async function mixVoiceTrack(
  voicePaths: Array<string | undefined>,
  outPath: string,
  workDir: string,
  totalSeconds: number,
): Promise<boolean> {
  const present = voicePaths
    .map((p, i) => ({ p, i, delayMs: Math.round(i * PHASE_SECONDS * 1000) }))
    .filter((x): x is { p: string; i: number; delayMs: number } => Boolean(x.p));
  if (present.length === 0) return false;

  const args: string[] = [];
  for (const item of present) {
    args.push('-i', item.p);
  }

  const filters: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < present.length; i++) {
    const item = present[i]!;
    const label = `vo${i}`;
    filters.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `adelay=delays=${item.delayMs}:all=1,apad=whole_dur=${totalSeconds}[${label}]`,
    );
    labels.push(`[${label}]`);
  }

  filters.push(
    `${labels.join('')}amix=inputs=${present.length}:duration=first:dropout_transition=0,` +
      `atrim=0:${totalSeconds},asetpts=PTS-STARTPTS[aout]`,
  );

  const voiceFilter = `${filters.join(';')}`;
  fs.writeFileSync(path.join(workDir, 'voice-mix.txt'), `${filters.join(';\n')}\n`, 'utf8');
  args.push(
    '-filter_complex', voiceFilter,
    '-map', '[aout]',
    '-c:a', 'pcm_s16le',
    '-t', String(totalSeconds),
    outPath,
  );

  const result = await runFfmpeg(args);
  if (result.code !== 0) {
    throw new Error(`voice mix failed:\n${result.stderr.slice(-2000)}`);
  }

  return true;
}

export async function renderPromo(settings: AppSettings, req: PromoRenderRequest): Promise<{ voiceError?: string }> {
  const progress = req.onProgress ?? (() => undefined);
  fs.mkdirSync(req.workDir, { recursive: true });

  const timing = getPromoTiming(settings.promoItemCount);
  const { itemCount, totalSeconds, playSeconds, preFreezeSeconds } = timing;
  const chapters = expandToCount(req.chapters, itemCount);
  const { width, height } = parseResolution(settings.resolution);
  const g = panelGeom(width, height, itemCount);
  const barH = Math.round(height * 0.28);

  let voiceError: string | undefined;
  const voicePaths: Array<string | undefined> = [];

  if (req.voiceEnabled) {
    progress(`Voice request: ${describeVoiceRequest(settings, req.language)}`);
  }

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    if (!req.voiceEnabled) {
      voicePaths.push(undefined);
      continue;
    }

    progress(`Synthesizing voice for item ${i + 1}: ${chapter.title}`);
    const voice = await synthesizeVoiceOver(settings, req.cachePath, req.language, {
      channelName: req.channelName,
      title: chapter.title,
      episodeTitle: chapter.episodeTitle,
      seasonNumber: chapter.seasonNumber,
      episodeNumber: chapter.episodeNumber,
      cue: i === 0 ? 'next' : 'after',
      showVoiceDetail: settings.showVoiceDetail,
    });

    if (voice.error) {
      voiceError = voice.error;
      progress(`Voice warning for item ${i + 1}: ${voice.error}`, 'warn');
    } else if (voice.cached) {
      progress(`Voice cache hit for item ${i + 1} (${voice.voice})`);
    } else {
      progress(`Voice ready for item ${i + 1} (${voice.voice})`);
    }

    voicePaths.push(voice.filePath);
  }

  const voiceMixPath = path.join(req.workDir, 'voice-timeline.wav');
  let hasVoice = false;
  if (req.voiceEnabled) {
    progress('Mixing voice-over timeline');
    hasVoice = await mixVoiceTrack(voicePaths, voiceMixPath, req.workDir, totalSeconds);
  }

  const sourceVolPct = Math.max(0, Math.min(100, Math.round(settings.sourceAudioVolume ?? 0)));
  const holdAfterVoice =
    settings.sourceAudioAfterVoice !== false && sourceVolPct > 0 && hasVoice;
  const sourceAudibleWindows: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < itemCount; i++) {
    const phaseStart = i * PHASE_SECONDS;
    const phaseEnd = Math.min(totalSeconds, (i + 1) * PHASE_SECONDS);
    const pre = preFreezeSeconds[i]!;
    const play = playSeconds[i]!;
    let start = pre;
    let end = Math.min(pre + play, phaseEnd);

    if (holdAfterVoice && voicePaths[i]) {
      try {
        const voDur = await probeDurationSeconds(voicePaths[i]!);
        start = Math.min(phaseStart + voDur + 0.12, phaseEnd);
        end = phaseEnd;
        const remain = end - start;
        if (remain < 0.35) {
          progress(
            `Item ${i + 1}: VO ${voDur.toFixed(1)}s leaves ${Math.max(0, remain).toFixed(1)}s for original audio in phase`,
            'warn',
          );
        }
      } catch {
        start = phaseStart;
        end = phaseEnd;
      }
    }

    sourceAudibleWindows.push({ start, end });
  }
  if (sourceVolPct > 0) {
    const resolvedAudio = new Map<string, { audioIndex: number; language?: string; hasAudio: boolean }>();
    for (let i = 0; i < itemCount; i++) {
      const chapter = chapters[i]!;
      const cacheKey = chapter.filePath;
      let picked = resolvedAudio.get(cacheKey);
      if (!picked) {
        const streams = await probeAudioStreams(chapter.filePath).catch(() => []);
        const match = pickAudioStreamForLanguage(streams, req.language);
        picked = {
          audioIndex: match?.audioIndex ?? 0,
          language: match?.language,
          hasAudio: streams.length > 0,
        };
        resolvedAudio.set(cacheKey, picked);
      }
      chapter.hasAudio = picked.hasAudio;
      chapter.audioStreamIndex = picked.audioIndex;
      chapter.audioStreamLanguage = picked.language;
      if (!picked.hasAudio) continue;
      const lang = picked.language ? `/${picked.language}` : '';
      progress(`Item ${i + 1} source audio a:${picked.audioIndex}${lang} (channel ${req.language})`);
    }
  }
  if (holdAfterVoice) {
    progress(
      `Original audio gates: ${sourceAudibleWindows
        .map((w, i) => `${i + 1}=${w.start.toFixed(1)}–${w.end.toFixed(1)}s`)
        .join(', ')}`,
    );
  }

  const barPath = path.join(req.workDir, 'bar.png');
  const barMargin = 40;
  const fullWidthBar = settings.lowerThirdFullWidth || itemCount === 1;
  const barW = barPixelWidth(width, g, fullWidthBar, barMargin, itemCount);
  await createLowerThirdBar(barW, barH, req.color, barPath);
  progress(
    fullWidthBar
      ? `Lower-third full width (${barW}px)`
      : `Lower-third follows focus (${barW}px)`,
  );

  const windows: number[] = [];
  for (let i = 0; i < itemCount; i++) {
    const chapter = chapters[i]!;
    const play = playSeconds[i]!;
    const start = pickRandomWindows(chapter.durationSeconds, 1, play)[0] ?? 0;
    windows.push(start);
    progress(`Item ${i + 1} window @ ${start.toFixed(1)}s (${play.toFixed(1)}s play): ${chapter.title}`);
  }

  const tempOut = path.join(req.workDir, 'next-items.tmp.mp4');

  const encodeWith = async (encodeSettings: AppSettings) => {
    const plan = buildEncoderPlan(encodeSettings);
    const args: string[] = [...globalHwArgs(encodeSettings)];

    for (let i = 0; i < itemCount; i++) {
      const chapter = chapters[i]!;
      const play = playSeconds[i]!;
      args.push(
        ...plan.inputArgs,
        '-ss', windows[i]!.toFixed(3),
        '-t', play.toFixed(3),
        '-i', chapter.filePath,
      );
    }

    let nextInput = itemCount;
    let voiceInput = -1;
    if (hasVoice) {
      args.push('-i', voiceMixPath);
      voiceInput = nextInput;
      nextInput += 1;
    }

    args.push('-f', 'lavfi', '-t', String(totalSeconds), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    const silenceInput = nextInput;
    nextInput += 1;

    args.push('-loop', '1', '-t', String(totalSeconds), '-i', barPath);
    const barInput = nextInput;
    nextInput += 1;

    let logoInput: number | undefined;
    if (req.logoPath && fs.existsSync(req.logoPath)) {
      args.push('-loop', '1', '-t', String(totalSeconds), '-i', req.logoPath);
      logoInput = nextInput;
      nextInput += 1;
    }

    const script = buildFilterScript(encodeSettings, req, chapters, timing, {
      width,
      height,
      barPath,
      barH,
      hasVoice,
      voiceInput,
      silenceInput,
      barInput,
      logoInput,
      sourceAudibleWindows,
    });

    fs.writeFileSync(path.join(req.workDir, 'filter_complex.txt'), script, 'utf8');

    args.push(
      '-filter_complex', script,
      '-map', '[vout]',
      '-map', '[aout]',
      ...plan.outputVideoArgs,
      '-c:a', 'aac',
      '-b:a', `${settings.audioBitrate}k`,
      '-ac', '2',
      '-ar', '48000',
      '-t', String(totalSeconds),
      '-movflags', '+faststart',
      tempOut,
    );

    return runFfmpeg(args);
  };

  if (sourceVolPct > 0) {
    progress(
      holdAfterVoice
        ? `Mixing original item audio at ${sourceVolPct}% (after voice-over)`
        : `Mixing original item audio at ${sourceVolPct}%`,
    );
  } else {
    progress('Skipping original item audio (volume 0)');
  }

  const layoutLabel =
    itemCount === 1 ? 'single' : itemCount === 2 ? 'dual' : 'triptych';
  progress(`Encoding ${layoutLabel} promo (${itemCount} item(s), ${totalSeconds}s, ${settings.hardwareAcceleration})`);
  let result = await encodeWith(settings);
  if (
    result.code !== 0 &&
    settings.hardwareAcceleration !== 'None' &&
    isHardwareEncodeFailure(result.stderr)
  ) {
    progress(
      `Hardware encode failed (${settings.hardwareAcceleration}); retrying with software libx264`,
      'warn',
    );
    fs.writeFileSync(
      path.join(req.workDir, 'ffmpeg-hw-error.txt'),
      result.stderr.slice(-8000),
      'utf8',
    );
    result = await encodeWith({ ...settings, hardwareAcceleration: 'None' });
  }
  if (result.code !== 0) {
    throw new Error(`ffmpeg promo render failed:\n${result.stderr.slice(-5000)}`);
  }

  fs.mkdirSync(path.dirname(req.outputFile), { recursive: true });
  fs.copyFileSync(tempOut, req.outputFile);
  fs.rmSync(tempOut, { force: true });
  progress('Promo file written');
  return { voiceError };
}
