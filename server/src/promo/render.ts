import { AppSettings, parseResolution } from "@promo/shared";
import type { ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { createLowerThirdBar } from "../color.js";
import {
  buildEncoderPlan,
  describeEncoderPlan,
  escapeDrawtext,
  escapeFilterPath,
  globalHwArgs,
  isHardwareEncodeFailure,
  summarizeHwFailure,
} from "../ffmpeg/hwaccel.js";
import {
  pickAudioStreamForLanguage,
  pickRandomWindows,
  probeAudioStreams,
  probeDurationSeconds,
} from "../ffmpeg/probe.js";
import { runFfmpeg, spawnFfmpegFile } from "../ffmpeg/run.js";
import {
  formatEpisodeSubtitle,
  formatOverlayHeadline,
  VoiceCue,
} from "../voice/templates.js";
import {
  describeVoiceRequest,
  peekCachedVoiceOver,
  synthesizeVoiceOver,
  voiceCacheKey,
} from "../voice/tts.js";
import {
  barPixelWidth,
  barXExprForCount,
  barXFixed,
  getPromoTiming,
  panelGeom,
  panelWidthExpr,
  panelXExpr,
  PHASE_SECONDS,
  PromoTiming,
  TRANSITION_SECONDS,
} from "./layout.js";
import {
  PromoChapterSource,
  PromoRenderRequest,
  PromoVoiceMode,
} from "./types.js";

function expandToCount(
  chapters: PromoChapterSource[],
  count: number,
): PromoChapterSource[] {
  if (chapters.length === 0) {
    throw new Error("No chapters available to render");
  }

  const out: PromoChapterSource[] = [];
  let i = 0;
  while (out.length < count) {
    out.push(chapters[i % chapters.length]!);
    i += 1;
  }

  return out;
}

function phaseEnable(
  phaseIndex: number,
  phaseSeconds: number = PHASE_SECONDS,
): string {
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
  const barX = fullWidthBar
    ? barXFixed(barMargin)
    : barXExprForCount(g, itemCount, barMargin);

  const lines: string[] = [];

  // Prepare each item strip for the full promo duration (freeze first/last as needed).
  for (let i = 0; i < itemCount; i++) {
    const pre = preFreezeSeconds[i]!;
    const play = playSeconds[i]!;
    const post = Math.max(0, totalSeconds - pre - play);
    const tpad: string[] = [];
    if (pre > 0.001)
      tpad.push(`start_mode=clone:start_duration=${pre.toFixed(3)}`);

    if (post > 0.001)
      tpad.push(`stop_mode=clone:stop_duration=${post.toFixed(3)}`);

    const tpadFilter = tpad.length > 0 ? `,tpad=${tpad.join(":")}` : "";
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

  let overlayLabel = "base";
  for (let i = 0; i < itemCount; i++) {
    const next = i === itemCount - 1 ? "stacked" : `o${i}`;
    const xExpr = panelXExpr(g, itemCount, i);
    const xPart = xExpr === "0" ? "x=0" : `x='${xExpr}'`;
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

  let current = "withbar";
  if (opts.logoInput !== undefined) {
    const logoSize = Math.round(opts.height * 0.18);
    const logoX = opts.width - logoSize - 48;
    const logoY = opts.height - logoSize - 48;
    lines.push(
      `[${opts.logoInput}:v]scale=${logoSize}:${logoSize}:force_original_aspect_ratio=decrease[logo]`,
      `[${current}][logo]overlay=${logoX}:${logoY}:eof_action=pass[withlogo]`,
    );

    current = "withlogo";
  }

  // Per-phase labels (Next / After that).
  const drawParts: string[] = [];
  for (let i = 0; i < itemCount; i++) {
    const chapter = chapters[i]!;
    const cue: VoiceCue = i === 0 ? "next" : "after";
    const headline = escapeDrawtext(
      formatOverlayHeadline(req.language, cue, chapter.title),
    );

    const subtitle = escapeDrawtext(
      formatEpisodeSubtitle(
        req.language,
        chapter.seasonNumber,
        chapter.episodeNumber,
        chapter.episodeTitle,
      ),
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

  lines.push(`[${current}]${drawParts.join(",")}[labelled]`);
  current = "labelled";

  if (plan.filterSuffix.length > 0) {
    lines.push(`[${current}]${plan.filterSuffix.join(",")}[vout]`);
  } else {
    lines.push(`[${current}]format=yuv420p[vout]`);
  }

  const sourceVolPct = Math.max(
    0,
    Math.min(100, Math.round(settings.sourceAudioVolume ?? 0)),
  );

  const sourceVol = sourceVolPct / 100;
  const aformat =
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

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
      const aIdx = Number.isFinite(chapter.audioStreamIndex)
        ? chapter.audioStreamIndex!
        : 0;

      const label = `sa${i}`;
      const start = window.start.toFixed(3);
      const end = window.end.toFixed(3);

      // Last item: fade out over the same window used for panel transitions.
      const isLast = i === itemCount - 1;
      const fadeDur = isLast
        ? Math.min(TRANSITION_SECONDS, Math.max(0, window.end - window.start))
        : 0;

      const fadeFilter =
        fadeDur > 0.05
          ? `afade=t=out:st=${(window.end - fadeDur).toFixed(3)}:d=${fadeDur.toFixed(3)},`
          : "";

      lines.push(
        `[${i}:a:${aIdx}]${aformat},` +
          `adelay=delays=${preMs}:all=1,` +
          `apad=whole_dur=${totalSeconds},atrim=0:${totalSeconds},asetpts=PTS-STARTPTS,` +
          `volume=${sourceVol.toFixed(4)},` +
          fadeFilter +
          `volume=0:enable='lt(t\\,${start})+gte(t\\,${end})'[${label}]`,
      );

      sourceLabels.push(`[${label}]`);
    }

    if (sourceLabels.length === 1) {
      mixLabels.push(sourceLabels[0]!);
    } else if (sourceLabels.length > 1) {
      lines.push(
        `${sourceLabels.join("")}amix=inputs=${sourceLabels.length}:duration=first:dropout_transition=0:normalize=0,` +
          `atrim=0:${totalSeconds},asetpts=PTS-STARTPTS[sourcebed]`,
      );

      mixLabels.push("[sourcebed]");
    }
  }

  if (opts.hasVoice) {
    lines.push(
      `[${opts.voiceInput}:a]volume=1.0,atrim=0:${totalSeconds},asetpts=PTS-STARTPTS,` +
        `apad=whole_dur=${totalSeconds},${aformat}[voicebed]`,
    );

    mixLabels.push("[voicebed]");
  }

  if (mixLabels.length === 0) {
    lines.push(`[${opts.silenceInput}:a]anull[aout]`);
  } else if (mixLabels.length === 1) {
    lines.push(`${mixLabels[0]}${aformat}[aout]`);
  } else {
    lines.push(
      `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0,` +
        `atrim=0:${totalSeconds},asetpts=PTS-STARTPTS,${aformat}[aout]`,
    );
  }

  return lines.join(";");
}

async function mixVoiceTrack(
  voicePaths: Array<string | undefined>,
  outPath: string,
  workDir: string,
  totalSeconds: number,
): Promise<boolean> {
  const present = voicePaths
    .map((p, i) => ({ p, i, delayMs: Math.round(i * PHASE_SECONDS * 1000) }))
    .filter((x): x is { p: string; i: number; delayMs: number } =>
      Boolean(x.p),
    );

  if (present.length === 0) return false;

  const args: string[] = [];
  for (const item of present) {
    args.push("-i", item.p);
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
    `${labels.join("")}amix=inputs=${present.length}:duration=first:dropout_transition=0,` +
      `atrim=0:${totalSeconds},asetpts=PTS-STARTPTS[aout]`,
  );

  const voiceFilter = `${filters.join(";")}`;
  fs.writeFileSync(
    path.join(workDir, "voice-mix.txt"),
    `${filters.join(";\n")}\n`,
    "utf8",
  );

  args.push(
    "-filter_complex",
    voiceFilter,
    "-map",
    "[aout]",
    "-c:a",
    "pcm_s16le",
    "-t",
    String(totalSeconds),
    outPath,
  );

  const result = await runFfmpeg(args);
  if (result.code !== 0) {
    throw new Error(`voice mix failed:\n${result.stderr.slice(-2000)}`);
  }

  return true;
}

function resolveVoiceMode(req: PromoRenderRequest): PromoVoiceMode {
  if (!req.voiceEnabled) return "off";

  return req.voiceMode ?? "synthesize";
}

async function resolveVoicePaths(
  settings: AppSettings,
  req: PromoRenderRequest,
  chapters: PromoChapterSource[],
  progress: (message: string, level?: "info" | "warn" | "error") => void,
): Promise<{
  voicePaths: Array<string | undefined>;
  voiceHashes: string[];
  voiceError?: string;
}> {
  const mode = resolveVoiceMode(req);
  const voicePaths: Array<string | undefined> = [];
  const voiceHashes: string[] = [];
  let voiceError: string | undefined;

  if (mode === "off") {
    return { voicePaths: chapters.map(() => undefined), voiceHashes: [] };
  }

  progress(`Voice request: ${describeVoiceRequest(settings, req.language)}`);

  if (mode === "cache-only") {
    const peeked: Array<{ hash: string; filePath: string } | undefined> = [];
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i]!;
      const hit = peekCachedVoiceOver(settings, req.language, {
        channelName: req.channelName,
        title: chapter.title,
        episodeTitle: chapter.episodeTitle,
        seasonNumber: chapter.seasonNumber,
        episodeNumber: chapter.episodeNumber,
        cue: i === 0 ? "next" : "after",
        showVoiceDetail: settings.showVoiceDetail,
      });

      peeked.push(hit ? { hash: hit.hash, filePath: hit.filePath } : undefined);
    }

    if (peeked.some((p) => !p)) {
      progress("VO cache incomplete — encoding without voice-over", "warn");
      return { voicePaths: chapters.map(() => undefined), voiceHashes: [] };
    }

    for (const p of peeked) {
      voicePaths.push(p!.filePath);
      voiceHashes.push(p!.hash);
      progress(`Voice cache hit (${p!.hash.slice(0, 8)}…)`);
    }

    return { voicePaths, voiceHashes };
  }

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    progress(`Synthesizing voice for item ${i + 1}: ${chapter.title}`);
    const voice = await synthesizeVoiceOver(
      settings,
      req.cachePath,
      req.language,
      {
        channelName: req.channelName,
        title: chapter.title,
        episodeTitle: chapter.episodeTitle,
        seasonNumber: chapter.seasonNumber,
        episodeNumber: chapter.episodeNumber,
        cue: i === 0 ? "next" : "after",
        showVoiceDetail: settings.showVoiceDetail,
      },
    );

    if (voice.error) {
      voiceError = voice.error;
      progress(`Voice warning for item ${i + 1}: ${voice.error}`, "warn");
    } else if (voice.cached) {
      progress(`Voice cache hit for item ${i + 1} (${voice.voice})`);
    } else {
      progress(`Voice ready for item ${i + 1} (${voice.voice})`);
    }

    voicePaths.push(voice.filePath);
    if (voice.filePath) {
      voiceHashes.push(
        voiceCacheKey(settings, req.language, {
          channelName: req.channelName,
          title: chapter.title,
          episodeTitle: chapter.episodeTitle,
          seasonNumber: chapter.seasonNumber,
          episodeNumber: chapter.episodeNumber,
          cue: i === 0 ? "next" : "after",
          showVoiceDetail: settings.showVoiceDetail,
        }).hash,
      );
    }
  }

  return { voicePaths, voiceHashes, voiceError };
}

interface PreparedPromoEncode {
  timing: PromoTiming;
  chapters: PromoChapterSource[];
  width: number;
  height: number;
  barH: number;
  barPath: string;
  voiceMixPath: string;
  hasVoice: boolean;
  voiceHashes: string[];
  voiceError?: string;
  sourceAudibleWindows: Array<{ start: number; end: number }>;
  windows: number[];
  totalSeconds: number;
  itemCount: number;
}

async function preparePromoEncode(
  settings: AppSettings,
  req: PromoRenderRequest,
): Promise<PreparedPromoEncode> {
  const progress = req.onProgress ?? (() => undefined);
  fs.mkdirSync(req.workDir, { recursive: true });

  const timing = getPromoTiming(settings.promoItemCount);
  const { itemCount, totalSeconds, playSeconds, preFreezeSeconds } = timing;
  const chapters = expandToCount(req.chapters, itemCount);
  const { width, height } = parseResolution(settings.resolution);
  const g = panelGeom(width, height, itemCount);
  const barH = Math.round(height * 0.28);

  const { voicePaths, voiceHashes, voiceError } = await resolveVoicePaths(
    settings,
    req,
    chapters,
    progress,
  );

  const voiceMixPath = path.join(req.workDir, "voice-timeline.wav");
  let hasVoice = false;
  if (voicePaths.some(Boolean)) {
    progress("Mixing voice-over timeline");
    hasVoice = await mixVoiceTrack(
      voicePaths,
      voiceMixPath,
      req.workDir,
      totalSeconds,
    );
  }

  const sourceVolPct = Math.max(
    0,
    Math.min(100, Math.round(settings.sourceAudioVolume ?? 0)),
  );

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
            "warn",
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
    const resolvedAudio = new Map<
      string,
      { audioIndex: number; language?: string; hasAudio: boolean }
    >();

    for (let i = 0; i < itemCount; i++) {
      const chapter = chapters[i]!;
      const cacheKey = chapter.filePath;
      let picked = resolvedAudio.get(cacheKey);
      if (!picked) {
        const streams = await probeAudioStreams(chapter.filePath).catch(
          () => [],
        );

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

      const lang = picked.language ? `/${picked.language}` : "";
      progress(
        `Item ${i + 1} source audio a:${picked.audioIndex}${lang} (channel ${req.language})`,
      );
    }
  }

  if (holdAfterVoice) {
    progress(
      `Original audio gates: ${sourceAudibleWindows
        .map((w, i) => `${i + 1}=${w.start.toFixed(1)}–${w.end.toFixed(1)}s`)
        .join(", ")}`,
    );
  }

  const barPath = path.join(req.workDir, "bar.png");
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
    progress(
      `Item ${i + 1} window @ ${start.toFixed(1)}s (${play.toFixed(1)}s play): ${chapter.title}`,
    );
  }

  if (sourceVolPct > 0) {
    progress(
      holdAfterVoice
        ? `Mixing original item audio at ${sourceVolPct}% (after voice-over)`
        : `Mixing original item audio at ${sourceVolPct}%`,
    );
  } else {
    progress("Skipping original item audio (volume 0)");
  }

  return {
    timing,
    chapters,
    width,
    height,
    barH,
    barPath,
    voiceMixPath,
    hasVoice,
    voiceHashes,
    voiceError,
    sourceAudibleWindows,
    windows,
    totalSeconds,
    itemCount,
  };
}

function buildPromoFfmpegArgs(
  settings: AppSettings,
  req: PromoRenderRequest,
  prepared: PreparedPromoEncode,
  output:
    | { kind: "file"; path: string }
    /** Live continuous MPEG-TS (relative `stream.ts`, cwd=workDir). */
    | { kind: "live" },
): string[] {
  const {
    timing,
    chapters,
    width,
    height,
    barH,
    barPath,
    voiceMixPath,
    hasVoice,
    sourceAudibleWindows,
    windows,
    totalSeconds,
    itemCount,
  } = prepared;

  const { playSeconds } = timing;
  const plan = buildEncoderPlan(settings);
  const args: string[] = [...globalHwArgs(settings)];

  for (let i = 0; i < itemCount; i++) {
    const chapter = chapters[i]!;
    const play = playSeconds[i]!;
    args.push(
      ...plan.inputArgs,
      "-ss",
      windows[i]!.toFixed(3),
      "-t",
      play.toFixed(3),
      "-i",
      chapter.filePath,
    );
  }

  let nextInput = itemCount;
  let voiceInput = -1;
  if (hasVoice) {
    args.push("-i", voiceMixPath);
    voiceInput = nextInput;
    nextInput += 1;
  }

  args.push(
    "-f",
    "lavfi",
    "-t",
    String(totalSeconds),
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
  );

  const silenceInput = nextInput;
  nextInput += 1;

  args.push("-loop", "1", "-t", String(totalSeconds), "-i", barPath);
  const barInput = nextInput;
  nextInput += 1;

  let logoInput: number | undefined;
  if (req.logoPath && fs.existsSync(req.logoPath)) {
    args.push("-loop", "1", "-t", String(totalSeconds), "-i", req.logoPath);
    logoInput = nextInput;
    nextInput += 1;
  }

  const script = buildFilterScript(settings, req, chapters, timing, {
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

  fs.writeFileSync(
    path.join(req.workDir, "filter_complex.txt"),
    script,
    "utf8",
  );

  args.push(
    "-filter_complex",
    script,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    ...plan.outputVideoArgs,
    "-c:a",
    "aac",
    "-b:a",
    `${settings.audioBitrate}k`,
    "-ac",
    "2",
    "-ar",
    "48000",
    "-t",
    String(totalSeconds),
  );

  if (output.kind === "live") {
    // Relative stream.ts — caller must spawn ffmpeg with cwd=workDir.
    args.push(
      "-g",
      "60",
      "-keyint_min",
      "60",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
      "-f",
      "mpegts",
      "-mpegts_flags",
      "+resend_headers",
      "-flush_packets",
      "1",
      "stream.ts",
    );
  } else {
    args.push("-movflags", "+faststart", output.path);
  }

  return args;
}

export async function renderPromo(
  settings: AppSettings,
  req: PromoRenderRequest,
): Promise<{ voiceError?: string }> {
  const progress = req.onProgress ?? (() => undefined);
  if (!req.outputFile) {
    throw new Error("renderPromo requires outputFile");
  }

  const prepared = await preparePromoEncode(settings, req);
  const tempOut = path.join(req.workDir, "next-items.tmp.mp4");
  const layoutLabel =
    prepared.itemCount === 1
      ? "single"
      : prepared.itemCount === 2
        ? "dual"
        : "triptych";

  let usedSettings = settings;
  progress(
    `Encoding ${layoutLabel} promo (${prepared.itemCount} item(s), ${prepared.totalSeconds}s)`,
  );

  progress(`Encoder: ${describeEncoderPlan(usedSettings)}`);

  const encodeWith = (encodeSettings: AppSettings) =>
    runFfmpeg(
      buildPromoFfmpegArgs(encodeSettings, req, prepared, {
        kind: "file",
        path: tempOut,
      }),
      { onProgress: (message) => progress(message) },
    );

  let result = await encodeWith(usedSettings);
  if (
    result.code !== 0 &&
    usedSettings.hardwareAcceleration !== "None" &&
    isHardwareEncodeFailure(result.stderr)
  ) {
    const hint = summarizeHwFailure(result.stderr);
    progress(
      `Hardware encode failed (${usedSettings.hardwareAcceleration}` +
        `${hint ? `: ${hint}` : ""}) — retrying with software`,
      "warn",
    );

    fs.writeFileSync(
      path.join(req.workDir, "ffmpeg-hw-error.txt"),
      result.stderr.slice(-8000),
      "utf8",
    );

    usedSettings = { ...settings, hardwareAcceleration: "None" };
    progress(`Encoder fallback: ${describeEncoderPlan(usedSettings)}`, "warn");
    result = await encodeWith(usedSettings);
  }

  if (result.code !== 0) {
    throw new Error(
      `ffmpeg promo render failed:\n${result.stderr.slice(-5000)}`,
    );
  }

  fs.mkdirSync(path.dirname(req.outputFile), { recursive: true });
  const finalPath = `${req.outputFile}.tmp-${process.pid}`;
  fs.copyFileSync(tempOut, finalPath);
  fs.renameSync(finalPath, req.outputFile);
  fs.rmSync(tempOut, { force: true });
  progress(
    `Promo file written · encoder OK (${describeEncoderPlan(usedSettings)})`,
  );

  return { voiceError: prepared.voiceError };
}

/**
 * Live encode to continuous MPEG-TS (VO cache-only).
 * Same `stream.ts` is pumped to ETV and the Channels UI (mpegts.js).
 */
export async function startLivePromoEncode(
  settings: AppSettings,
  req: PromoRenderRequest,
  mpegtsPath: string,
): Promise<{
  process: ChildProcessByStdio<null, null, Readable>;
  mpegtsPath: string;
  voiceHashes: string[];
  totalSeconds: number;
  workDir: string;
  encodeSettings: AppSettings;
}> {
  const progress = req.onProgress ?? (() => undefined);
  const prepared = await preparePromoEncode(settings, {
    ...req,
    voiceMode: req.voiceMode ?? "cache-only",
  });

  const layoutLabel =
    prepared.itemCount === 1
      ? "single"
      : prepared.itemCount === 2
        ? "dual"
        : "triptych";

  progress(
    `Live ${layoutLabel} MPEG-TS (${prepared.itemCount} item(s), ${prepared.totalSeconds}s, VO ${prepared.hasVoice ? "on" : "off"})`,
  );

  progress(`Encoder: ${describeEncoderPlan(settings)}`);

  const workDir = req.workDir;
  fs.mkdirSync(workDir, { recursive: true });

  const args = buildPromoFfmpegArgs(settings, req, prepared, {
    kind: "live",
  });

  // Relative stream.ts requires cwd=workDir.
  const child = spawnFfmpegFile(args, { cwd: workDir });

  return {
    process: child,
    mpegtsPath,
    voiceHashes: prepared.voiceHashes,
    totalSeconds: prepared.totalSeconds,
    workDir,
    encodeSettings: settings,
  };
}
