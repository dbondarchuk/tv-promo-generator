import { AppSettings, GraphicsPhase, parseResolution } from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createLowerThirdBarBuffer } from "../color.js";
import { loadChannelOverrides } from "../config.js";
import {
  getCurrentPrimaryItem,
  getGraphicsMediaContext,
  openDb,
  type GraphicsMediaContext,
} from "../ersatztv/db.js";
import { runFfmpegStdout } from "../ffmpeg/run.js";
import { createLogger } from "../util/log.js";
import { rewritePath } from "../util/paths.js";
import { formatEpisodeSubtitle, getCopyTemplate } from "../voice/templates.js";
import { resolveChannelLanguage } from "./channels.js";

const log = createLogger("graphics-overlay");

export interface GraphicsOverlayHints {
  /** Optional pin; otherwise resolve from channel schedule at `at`. */
  mediaItemId?: number;
  /**
   * ETV MediaItem_Start (content start). Used with channelNumber to pick
   * the correct now/next playout rows (troubleshoot-safe).
   */
  at?: string;
  channelName?: string;
  channelNumber?: string;
  language?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function extractRandomStillBuffer(
  videoPath: string,
): Promise<Buffer | undefined> {
  const seekPct = 0.1 + Math.random() * 0.6;
  const seekSec = Math.max(1, Math.round(seekPct * 600));
  const argsFor = (ss: string) => [
    "-ss",
    ss,
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ];

  try {
    let result = await runFfmpegStdout(argsFor(String(seekSec)));
    if (result.code !== 0 || result.stdout.length < 100) {
      result = await runFfmpegStdout(argsFor("1"));
    }

    if (result.code !== 0 || result.stdout.length < 100) {
      log.warn("still extract failed", {
        videoPath,
        stderr: result.stderr.slice(-400),
      });

      return undefined;
    }

    return result.stdout;
  } catch (err) {
    log.warn("still extract error", {
      videoPath,
      err: err instanceof Error ? err.message : String(err),
    });

    return undefined;
  }
}

function resolveLocalMediaPath(
  settings: AppSettings,
  dbPath?: string,
): string | undefined {
  if (!dbPath) return undefined;

  const rewritten = rewritePath(
    dbPath,
    settings.etvPathPrefix,
    settings.libraryPath || settings.etvPathPrefix,
  );

  if (rewritten && fs.existsSync(rewritten)) return rewritten;
  if (fs.existsSync(dbPath)) return dbPath;

  return undefined;
}

function resolveArtworkFile(
  settings: AppSettings,
  artworkSourcePath?: string,
  artworkHashPath?: string,
): string | undefined {
  const fromSource = resolveLocalMediaPath(settings, artworkSourcePath);
  if (fromSource) return fromSource;

  if (artworkHashPath && settings.etvConfigPath) {
    const hash = artworkHashPath.replace(/\\/g, "/").split("/").pop()!;
    const candidates = [
      path.join(settings.etvConfigPath, "artwork", hash.slice(0, 2), hash),
      path.join(settings.etvConfigPath, "artwork", hash),
      path.join(settings.etvConfigPath, "cache", "artwork", hash),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }

  return undefined;
}

async function resolveThumbBuffer(
  settings: AppSettings,
  ctx: {
    mediaItemId: number;
    filePath?: string;
    artworkSourcePath?: string;
    artworkHashPath?: string;
  },
): Promise<Buffer | undefined> {
  const videoPath = resolveLocalMediaPath(settings, ctx.filePath);

  if (settings.graphicsImageSource === "artwork") {
    const art = resolveArtworkFile(
      settings,
      ctx.artworkSourcePath,
      ctx.artworkHashPath,
    );

    if (art) return fs.promises.readFile(art);
  }

  if (videoPath) {
    const still = await extractRandomStillBuffer(videoPath);
    if (still) return still;
  }

  const art = resolveArtworkFile(
    settings,
    ctx.artworkSourcePath,
    ctx.artworkHashPath,
  );

  if (art) return fs.promises.readFile(art);

  return undefined;
}

export interface GraphicsItemParts {
  /** Show / movie title. */
  primary: string;
  /** Localized "Season N, Episode M" (no episode name). */
  seasonEpisode?: string;
  /** Episode name on its own line. */
  episodeTitle?: string;
}

/** Split show label so episode title is never jammed onto the primary line. */
export function formatGraphicsItemParts(
  language: string,
  item: {
    title: string;
    episodeTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  },
): GraphicsItemParts {
  const seasonEpisode = formatEpisodeSubtitle(
    language,
    item.seasonNumber,
    item.episodeNumber,
    undefined,
  );

  const episodeTitle =
    item.episodeTitle && item.episodeTitle !== item.title
      ? item.episodeTitle
      : undefined;

  return {
    primary: item.title,
    seasonEpisode: seasonEpisode || undefined,
    episodeTitle,
  };
}

function primaryWithSeason(parts: GraphicsItemParts): string {
  if (parts.seasonEpisode) return `${parts.primary} — ${parts.seasonEpisode}`;

  return parts.primary;
}

function resolveChannelNumber(
  ctx: GraphicsMediaContext,
  hints: GraphicsOverlayHints,
): string {
  return hints.channelNumber?.trim() || ctx.channelNumber || "";
}

function resolveChannelName(
  ctx: GraphicsMediaContext,
  hints: GraphicsOverlayHints,
  channelNumber: string,
): string {
  const fromHint = hints.channelName?.trim();
  if (fromHint) return fromHint;

  if (ctx.channelName?.trim()) return ctx.channelName.trim();
  if (channelNumber) return `Channel ${channelNumber}`;

  return "Channel";
}

type OverlayLine = { text: string; kind: "primary" | "episode" };

function pushItemLines(lines: OverlayLine[], parts: GraphicsItemParts): void {
  lines.push({ text: primaryWithSeason(parts), kind: "primary" });

  if (parts.episodeTitle) {
    lines.push({ text: parts.episodeTitle, kind: "episode" });
  }
}

function phaseCopy(
  phase: GraphicsPhase,
  language: string,
  channelName: string,
  now: GraphicsItemParts,
  next?: GraphicsItemParts,
): { headline: string; lines: OverlayLine[] } {
  const t = getCopyTemplate(language);
  const lines: OverlayLine[] = [];

  if (phase === "next") {
    pushItemLines(lines, next ?? now);
    return { headline: t.nextOn(channelName), lines };
  }

  pushItemLines(lines, now);
  return { headline: t.nowOn(channelName), lines };
}

/** Normalize ETV MediaItem_Start / query `at` into an ISO UTC string. */
export function parseOverlayAt(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;

  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum > 1_000_000_000) {
    // Unix seconds or ms
    const ms = asNum > 1_000_000_000_000 ? asNum : asNum * 1000;
    return new Date(ms).toISOString();
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();

  return undefined;
}

function resolveOverlayMediaItemId(
  settings: AppSettings,
  hints: GraphicsOverlayHints,
): {
  mediaItemId: number;
  channelNumber?: string;
  channelName?: string;
  atUtcIso?: string;
} {
  const channelNumber = hints.channelNumber?.trim();
  const atUtcIso = parseOverlayAt(hints.at) ?? new Date().toISOString();

  if (channelNumber) {
    const db = openDb(settings.etvDatabase, true);
    try {
      const current = getCurrentPrimaryItem(db, channelNumber, atUtcIso);
      if (current?.mediaItemId) {
        return {
          mediaItemId: current.mediaItemId,
          channelNumber: String(current.channelNumber ?? channelNumber),
          channelName: current.channelName || undefined,
          atUtcIso,
        };
      }
    } finally {
      db.close();
    }

    if (
      hints.mediaItemId == null ||
      !Number.isFinite(hints.mediaItemId) ||
      hints.mediaItemId <= 0
    ) {
      throw new Error(
        `No schedule item for channel ${channelNumber} at ${atUtcIso}`,
      );
    }
  }

  if (
    hints.mediaItemId != null &&
    Number.isFinite(hints.mediaItemId) &&
    hints.mediaItemId > 0
  ) {
    return {
      mediaItemId: hints.mediaItemId,
      channelNumber,
      atUtcIso,
    };
  }

  throw new Error("channelNumber or mediaItemId is required");
}

/** Render a bar-only Now/Mid/Next overlay PNG for ETV graphics. */
export async function renderGraphicsOverlayPng(
  settings: AppSettings,
  phase: GraphicsPhase,
  hints: GraphicsOverlayHints = {},
): Promise<Buffer> {
  const resolved = resolveOverlayMediaItemId(settings, hints);
  const mediaItemId = resolved.mediaItemId;
  const hintsWithChannel: GraphicsOverlayHints = {
    ...hints,
    channelNumber: hints.channelNumber || resolved.channelNumber,
    channelName: hints.channelName || resolved.channelName,
    at: resolved.atUtcIso,
  };

  const db = openDb(settings.etvDatabase, true);
  let ctx;
  try {
    ctx = getGraphicsMediaContext(db, mediaItemId, {
      channelNumber: hintsWithChannel.channelNumber,
      atUtcIso: hintsWithChannel.at,
    });
  } finally {
    db.close();
  }

  if (!ctx) {
    throw new Error(`Media item ${mediaItemId} not found`);
  }

  const { width, height } = parseResolution(settings.resolution);
  const barH = Math.max(
    80,
    Math.round((height * (settings.graphicsBarHeightPercent || 18)) / 100),
  );

  const overrides = loadChannelOverrides();
  const channelNumber = resolveChannelNumber(ctx, hintsWithChannel);
  const channelName = resolveChannelName(ctx, hintsWithChannel, channelNumber);
  const language = await resolveChannelLanguage(
    settings,
    channelNumber,
    hintsWithChannel.language,
  );

  const color = (channelNumber && overrides[channelNumber]?.color) || "#1a468d";

  const nowParts = formatGraphicsItemParts(language, {
    title: ctx.title,
    episodeTitle: ctx.episodeTitle,
    seasonNumber: ctx.seasonNumber,
    episodeNumber: ctx.episodeNumber,
  });

  const nextParts = ctx.nextTitle
    ? formatGraphicsItemParts(language, {
        title: ctx.nextTitle,
        episodeTitle: ctx.nextEpisodeTitle,
        seasonNumber: ctx.nextSeasonNumber,
        episodeNumber: ctx.nextEpisodeNumber,
      })
    : undefined;

  const copy = phaseCopy(phase, language, channelName, nowParts, nextParts);

  const thumbMediaId =
    phase === "next" && ctx.nextMediaItemId
      ? ctx.nextMediaItemId
      : ctx.mediaItemId;

  let thumbCtx = ctx;
  if (thumbMediaId !== ctx.mediaItemId) {
    const db2 = openDb(settings.etvDatabase, true);
    try {
      thumbCtx = getGraphicsMediaContext(db2, thumbMediaId) || ctx;
    } finally {
      db2.close();
    }
  }

  const thumbBufRaw = await resolveThumbBuffer(settings, thumbCtx);
  const barBuf = await createLowerThirdBarBuffer(width, barH, color);

  const margin = Math.round(width * 0.025);
  const thumbSize = Math.round(barH * 0.78);
  const bodyCount = Math.max(1, copy.lines.length);
  const scale = bodyCount >= 2 ? 0.9 : 1;
  const headlineSize = Math.round(barH * 0.17 * scale);
  const bodySize = Math.round(barH * 0.22 * scale);
  const subSize = Math.round(barH * 0.17 * scale);
  const rowGap = Math.round(barH * 0.045 * scale);

  const rows: { text: string; size: number; weight: number }[] = [
    { text: copy.headline, size: headlineSize, weight: 600 },
    ...copy.lines.map((line) => ({
      text: line.text.slice(0, 100),
      size: line.kind === "primary" ? bodySize : subSize,
      weight: line.kind === "primary" ? 700 : 600,
    })),
  ];

  // Render text tightly (top-anchored), then place the trimmed bitmap
  // vertically centered so font baseline quirks don't matter.
  let cursorY = rows[0]!.size;
  const textEls = rows.map((row, i) => {
    if (i > 0) cursorY += rowGap + row.size;
    const y = cursorY;
    return `<text x="0" y="${y}" font-size="${row.size}" font-weight="${row.weight}" font-family="Segoe UI, Arial, sans-serif" text-anchor="start" fill="#ffffff">${escapeXml(row.text)}</text>`;
  });

  const textSvgH = cursorY + Math.round(rows[rows.length - 1]!.size * 0.35);
  const textSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${textSvgH}" xmlns="http://www.w3.org/2000/svg">
  ${textEls.join("\n  ")}
</svg>`;

  const textRaw = await sharp(Buffer.from(textSvg)).png().toBuffer();
  const trimmed = await sharp(textRaw)
    .trim({ threshold: 0 })
    .png()
    .toBuffer({ resolveWithObject: true });

  const textTop = Math.max(0, Math.round((barH - trimmed.info.height) / 2));
  const layers: sharp.OverlayOptions[] = [
    { input: barBuf, top: 0, left: 0 },
    { input: trimmed.data, top: textTop, left: margin },
  ];

  if (thumbBufRaw) {
    const thumbBuf = await sharp(thumbBufRaw)
      .resize(thumbSize, thumbSize, { fit: "cover" })
      .png()
      .toBuffer();

    layers.push({
      input: thumbBuf,
      top: Math.round((barH - thumbSize) / 2),
      left: width - margin - thumbSize,
    });
  }

  return sharp({
    create: {
      width,
      height: barH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
}
