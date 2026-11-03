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
import { pickRandomWindows } from '../ffmpeg/probe.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { synthesizeVoiceOver } from '../voice/tts.js';
import { formatEpisodeSubtitle, formatOverlayHeadline, VoiceCue } from '../voice/templates.js';
import {
  PLAY_SECONDS,
  PRE_FREEZE_SECONDS,
  TOTAL_SECONDS,
  barXExpr,
  panelGeom,
  widthExprA,
  widthExprB,
  widthExprC,
  xExprB,
  xExprC,
} from './layout.js';
import { PromoChapterSource, PromoRenderRequest } from './types.js';

function expandToThree(chapters: PromoChapterSource[]): PromoChapterSource[] {
  if (chapters.length === 0) {
    throw new Error('No chapters available to render');
  }

  const out: PromoChapterSource[] = [];
  let i = 0;
  while (out.length < 3) {
    out.push(chapters[i % chapters.length]!);
    i += 1;
  }

  return out;
}

function phaseEnable(phaseIndex: number): string {
  const start = phaseIndex * 10;
  const end = start + 10;

  // drawtext enable= is evaluated per-frame; escape commas for filtergraph.
  return `between(t\\,${start}\\,${end})`;
}

function buildFilterScript(
  settings: AppSettings,
  req: PromoRenderRequest,
  chapters: PromoChapterSource[],
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
  },
): string {
  const g = panelGeom(opts.width, opts.height);
  const plan = buildEncoderPlan(settings);
  const font = escapeFilterPath(req.fontFile);
  const titleSize = Math.round(opts.height * 0.042);
  const subSize = Math.round(opts.height * 0.026);
  const barMargin = 40;
  const barY = opts.height - opts.barH - 40;
  const textPadX = 36;
  const textPadY = 28;

  const wA = widthExprA(g);
  const wB = widthExprB(g);
  const wC = widthExprC(g);
  const xB = xExprB(g);
  const xC = xExprC(g);
  const barX = barXExpr(g, barMargin);

  const lines: string[] = [];

  // Prepare each item as a 50%-width strip for the full 30s (freeze first/last as needed).
  for (let i = 0; i < 3; i++) {
    const pre = PRE_FREEZE_SECONDS[i]!;
    const play = PLAY_SECONDS[i]!;
    const post = Math.max(0, TOTAL_SECONDS - pre - play);
    const tpad: string[] = [];
    if (pre > 0.001) tpad.push(`start_mode=clone:start_duration=${pre.toFixed(3)}`);
    if (post > 0.001) tpad.push(`stop_mode=clone:stop_duration=${post.toFixed(3)}`);

    const tpadFilter = tpad.length > 0 ? `,tpad=${tpad.join(':')}` : '';
    lines.push(
      `[${i}:v]fps=30,scale=${g.stripW}:${g.height}:force_original_aspect_ratio=increase,` +
        `crop=${g.stripW}:${g.height},setsar=1,format=yuv420p${tpadFilter},` +
        `trim=duration=${TOTAL_SECONDS},setpts=PTS-STARTPTS[v${i}full]`,
    );
  }

  // Animated panel widths via scale=eval=frame.
  // crop w='expr' is NOT re-evaluated per-frame on this ffmpeg (t is NAN at init,
  // so every panel locked to the else-branch 25% width and left a black gap while
  // overlay x still animated to the true 50% layout).
  lines.push(
    `[v0full]scale=w='${wA}':h=${g.height}:eval=frame:flags=bicubic[v0p]`,
    `[v1full]scale=w='${wB}':h=${g.height}:eval=frame:flags=bicubic[v1p]`,
    `[v2full]scale=w='${wC}':h=${g.height}:eval=frame:flags=bicubic[v2p]`,
  );

  // Stack onto a black canvas with animated x positions.
  lines.push(
    `color=c=black:s=${opts.width}x${opts.height}:d=${TOTAL_SECONDS}:r=30,format=yuv420p[base]`,
    `[base][v0p]overlay=x=0:y=0:eof_action=pass[o0]`,
    `[o0][v1p]overlay=x='${xB}':y=0:eof_action=pass[o1]`,
    `[o1][v2p]overlay=x='${xC}':y=0:eof_action=pass[stacked]`,
  );

  // Lower-third bar tracks the focused panel.
  lines.push(
    `[stacked][${opts.barInput}:v]overlay=x='${barX}':y=${barY}:eof_action=pass[withbar]`,
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
  for (let i = 0; i < 3; i++) {
    const chapter = chapters[i]!;
    const cue: VoiceCue = i === 0 ? 'next' : 'after';
    const headline = escapeDrawtext(formatOverlayHeadline(req.language, cue, chapter.title));
    const subtitle = escapeDrawtext(
      formatEpisodeSubtitle(req.language, chapter.seasonNumber, chapter.episodeNumber, chapter.episodeTitle),
    );

    const startsAt = escapeDrawtext(chapter.startLabel);
    const enable = phaseEnable(i);
    // Text X follows the bar (focused panel) + padding.
    const textX = `'${barX}+${textPadX}'`;
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

  // Voice-over only (no source audio).
  if (opts.hasVoice) {
    lines.push(
      `[${opts.voiceInput}:a]volume=1.0,atrim=0:${TOTAL_SECONDS},asetpts=PTS-STARTPTS,` +
        `apad=whole_dur=${TOTAL_SECONDS},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[aout]`,
    );
  } else {
    lines.push(`[${opts.silenceInput}:a]anull[aout]`);
  }

  return lines.join(';');
}

async function mixVoiceTrack(
  voicePaths: Array<string | undefined>,
  outPath: string,
  workDir: string,
): Promise<boolean> {
  const present = voicePaths
    .map((p, i) => ({ p, i, delayMs: Math.round(i * 10_000) }))
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
        `adelay=${item.delayMs}|${item.delayMs},apad=whole_dur=${TOTAL_SECONDS}[${label}]`,
    );
    labels.push(`[${label}]`);
  }

  filters.push(
    `${labels.join('')}amix=inputs=${present.length}:duration=first:dropout_transition=0,` +
      `atrim=0:${TOTAL_SECONDS},asetpts=PTS-STARTPTS[aout]`,
  );

  const voiceFilter = `${filters.join(';')}`;
  fs.writeFileSync(path.join(workDir, 'voice-mix.txt'), `${filters.join(';\n')}\n`, 'utf8');
  args.push(
    '-filter_complex', voiceFilter,
    '-map', '[aout]',
    '-c:a', 'pcm_s16le',
    '-t', String(TOTAL_SECONDS),
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

  const chapters = expandToThree(req.chapters);
  const { width, height } = parseResolution(settings.resolution);
  const g = panelGeom(width, height);
  const barH = Math.round(height * 0.28);

  let voiceError: string | undefined;
  const voicePaths: Array<string | undefined> = [];

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    if (!req.voiceEnabled) {
      voicePaths.push(undefined);
      continue;
    }

    progress(`Synthesizing voice for item ${i + 1}: ${chapter.title}`);
    const voice = await synthesizeVoiceOver(req.cachePath, req.language, {
      channelName: req.channelName,
      title: chapter.title,
      episodeTitle: chapter.episodeTitle,
      seasonNumber: chapter.seasonNumber,
      episodeNumber: chapter.episodeNumber,
      cue: i === 0 ? 'next' : 'after',
    });

    if (voice.error) {
      voiceError = voice.error;
      progress(`Voice warning for item ${i + 1}: ${voice.error}`, 'warn');
    } else if (voice.cached) {
      progress(`Voice cache hit for item ${i + 1}`);
    } else {
      progress(`Voice ready for item ${i + 1}`);
    }

    voicePaths.push(voice.filePath);
  }

  const voiceMixPath = path.join(req.workDir, 'voice-timeline.wav');
  let hasVoice = false;
  if (req.voiceEnabled) {
    progress('Mixing voice-over timeline');
    hasVoice = await mixVoiceTrack(voicePaths, voiceMixPath, req.workDir);
  }

  const barPath = path.join(req.workDir, 'bar.png');
  // Bar spans the focused 50% panel (minus margins).
  await createLowerThirdBar(g.width50 - 48, barH, req.color, barPath);

  // One random window per next-item, duration = that item's play length.
  const windows: number[] = [];
  for (let i = 0; i < 3; i++) {
    const chapter = chapters[i]!;
    const play = PLAY_SECONDS[i]!;
    const start = pickRandomWindows(chapter.durationSeconds, 1, play)[0] ?? 0;
    windows.push(start);
    progress(`Item ${i + 1} window @ ${start.toFixed(1)}s (${play.toFixed(1)}s play): ${chapter.title}`);
  }

  const tempOut = path.join(req.workDir, 'next-items.tmp.mp4');

  const encodeWith = async (encodeSettings: AppSettings) => {
    const plan = buildEncoderPlan(encodeSettings);
    const args: string[] = [...globalHwArgs(encodeSettings)];

    for (let i = 0; i < 3; i++) {
      const chapter = chapters[i]!;
      const play = PLAY_SECONDS[i]!;
      args.push(
        ...plan.inputArgs,
        '-ss', windows[i]!.toFixed(3),
        '-t', play.toFixed(3),
        '-i', chapter.filePath,
      );
    }

    let nextInput = 3;
    let voiceInput = -1;
    if (hasVoice) {
      args.push('-i', voiceMixPath);
      voiceInput = nextInput;
      nextInput += 1;
    }

    args.push('-f', 'lavfi', '-t', String(TOTAL_SECONDS), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    const silenceInput = nextInput;
    nextInput += 1;

    args.push('-loop', '1', '-t', String(TOTAL_SECONDS), '-i', barPath);
    const barInput = nextInput;
    nextInput += 1;

    let logoInput: number | undefined;
    if (req.logoPath && fs.existsSync(req.logoPath)) {
      args.push('-loop', '1', '-t', String(TOTAL_SECONDS), '-i', req.logoPath);
      logoInput = nextInput;
      nextInput += 1;
    }

    const script = buildFilterScript(encodeSettings, req, chapters, {
      width,
      height,
      barPath,
      barH,
      hasVoice,
      voiceInput,
      silenceInput,
      barInput,
      logoInput,
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
      '-t', String(TOTAL_SECONDS),
      '-movflags', '+faststart',
      tempOut,
    );

    return runFfmpeg(args);
  };

  progress(`Encoding animated triptych (30s, ${settings.hardwareAcceleration})`);
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
