import {
  AppSettings,
  ChannelOverrides,
  ChannelView,
  sanitizeChannelFolderName,
  ScheduleItemPreview,
} from "@promo/shared";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadLogo,
  extractDominantColor,
  logoCacheFile,
  resolveLogoUrl,
} from "../color.js";
import { loadChannelOverrides, updateChannelOverride } from "../config.js";
import { EtvApiClient } from "../ersatztv/api.js";
import {
  getCurrentPrimaryItem,
  getMediaItemMetadata,
  getPrimaryItemsAfter,
  MediaItemMetadata,
  metadataFromFilePath,
  openDb,
  PlayoutRow,
  stripTitleYear,
} from "../ersatztv/db.js";
import { M3uChannel, parseM3u } from "../ersatztv/m3u.js";
import { fromSqliteUtc, toUtcSqlite } from "../ersatztv/time.js";
import { parseXmltv, XmltvGuide, XmltvProgramme } from "../ersatztv/xmltv.js";
import {
  pickAudioStreamForLanguage,
  probeAudioStreams,
  probeDurationSeconds,
} from "../ffmpeg/probe.js";
import { createLogger } from "../util/log.js";
import {
  fileExists,
  findLibraryFile,
  promoOutputFile,
  rewritePath,
} from "../util/paths.js";
import { formatStartsAtLabel } from "../voice/templates.js";

function livePreviewPath(channelNumber: string): string {
  return `/live/${encodeURIComponent(channelNumber)}/promo.ts`;
}

const log = createLogger("channels");

export function channelLogoProxyUrl(channelNumber: string): string {
  return `/media/logos/${encodeURIComponent(sanitizeChannelFolderName(channelNumber))}`;
}

async function ensureChannelLogo(
  settings: AppSettings,
  channelNumber: string,
  upstreamLogoUrl?: string,
): Promise<string | undefined> {
  if (!upstreamLogoUrl?.trim()) return undefined;

  const key = sanitizeChannelFolderName(channelNumber);
  const logoCacheDir = path.join(settings.cachePath, "logos");
  const resolved = resolveLogoUrl(upstreamLogoUrl, settings.etvUrl);
  const logoPath = await downloadLogo(resolved, logoCacheDir, key);
  return logoPath ? channelLogoProxyUrl(channelNumber) : undefined;
}

function matchProgramme(
  programmes: XmltvProgramme[],
  channelId: string,
  start: Date,
): XmltvProgramme | undefined {
  const t = start.getTime();
  return (
    programmes.find(
      (p) =>
        p.channelId === channelId && Math.abs(p.start.getTime() - t) < 2000,
    ) ??
    programmes.find(
      (p) =>
        p.channelId === channelId && Math.abs(p.start.getTime() - t) < 60_000,
    )
  );
}

function resolveItemLabels(
  db: Database.Database,
  row: PlayoutRow,
  prog?: XmltvProgramme,
): {
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
} {
  const meta: MediaItemMetadata | undefined =
    getMediaItemMetadata(db, row.mediaItemId) ??
    metadataFromFilePath(row.filePath);

  const title = stripTitleYear(
    meta?.title || prog?.title || `Item ${row.mediaItemId}`,
  );

  const episodeTitle = meta?.episodeTitle || prog?.episodeTitle;
  const seasonNumber = meta?.seasonNumber ?? prog?.seasonNumber;
  const episodeNumber = meta?.episodeNumber ?? prog?.episodeNumber;
  return { title, episodeTitle, seasonNumber, episodeNumber };
}

interface ResolveOptions {
  /** Recursive library scan — only for generate, never for UI polling. */
  allowLibraryScan?: boolean;
  /** ffprobe duration — only when generating. */
  allowProbe?: boolean;
}

async function resolveFile(
  settings: AppSettings,
  row: PlayoutRow,
  title: string,
  season?: number,
  episode?: number,
  options: ResolveOptions = {},
): Promise<{ filePath?: string; durationSeconds?: number; error?: string }> {
  const rewritten = row.filePath
    ? rewritePath(
        row.filePath,
        settings.etvPathPrefix,
        settings.libraryPath || settings.etvPathPrefix,
      )
    : undefined;

  let candidate = rewritten && fileExists(rewritten) ? rewritten : undefined;

  if (row.filePath) {
    if (candidate) {
      log.debug("resolved file", { title, db: row.filePath, local: candidate });
    } else {
      log.warn("rewrite miss", {
        title,
        db: row.filePath,
        local: rewritten,
        prefix: settings.etvPathPrefix,
        library: settings.libraryPath,
      });
    }
  } else {
    log.warn("no db path", { title, mediaItemId: row.mediaItemId });
  }

  if (!candidate && options.allowLibraryScan) {
    log.info("library scan fallback", {
      title,
      season,
      episode,
      root: settings.libraryPath,
    });

    candidate = findLibraryFile(settings.libraryPath, title, season, episode);
    if (candidate) log.info("library scan hit", { title, local: candidate });
    else log.warn("library scan miss", { title, season, episode });
  }

  if (!candidate) {
    return {
      error: row.filePath
        ? `File not found after rewrite: ${row.filePath} → ${rewritten ?? "(no rewrite)"}`
        : "No media file path in database",
    };
  }

  if (row.durationSeconds && row.durationSeconds > 0) {
    return { filePath: candidate, durationSeconds: row.durationSeconds };
  }

  if (!options.allowProbe) {
    return { filePath: candidate, durationSeconds: undefined };
  }

  try {
    const durationSeconds = await probeDurationSeconds(candidate);
    return { filePath: candidate, durationSeconds };
  } catch (err) {
    return {
      filePath: candidate,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface GuideCache {
  at: number;
  m3u: M3uChannel[];
  guide: XmltvGuide;
  languageByNumber: Map<string, string>;
}

interface LabeledPlayout {
  row: PlayoutRow;
  start: Date;
  finish: Date;
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

/** Shared schedule slice — reused by UI, VO prewarm, and live encode. */
export interface ChannelScheduleSlice {
  channelNumber: string;
  channelName: string;
  tvgId: string;
  /** Upstream M3U logo URL (not the proxied path). */
  upstreamLogoUrl?: string;
  language: string;
  color: string;
  current?: LabeledPlayout;
  currentKey?: string;
  /** Current window + one look-ahead row (`promoItemCount + 1`). */
  next: LabeledPlayout[];
}

let guideCache: GuideCache | null = null;
let viewsCache: { at: number; key: string; views: ChannelView[] } | null = null;
let scheduleCache: {
  at: number;
  key: string;
  byNumber: Map<string, ChannelScheduleSlice>;
} | null = null;

/** Guide + playout snapshot TTL — force-refresh via refreshChannelViews. */
const SCHEDULE_TTL_MS = 60_000;

async function loadGuide(settings: AppSettings): Promise<GuideCache> {
  if (guideCache && Date.now() - guideCache.at < SCHEDULE_TTL_MS) {
    log.debug("guide cache hit");
    return guideCache;
  }

  log.info("loading guide from ErsatzTV", { url: settings.etvUrl });
  const started = Date.now();
  const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);
  const [m3uText, xmltvText, apiChannels] = await Promise.all([
    api.getM3u(),
    api.getXmltv(),
    api.getChannels().catch((err) => {
      log.warn(
        "api/channels failed; continuing without languages",
        String(err),
      );

      return [];
    }),
  ]);

  const m3u = parseM3u(m3uText);
  const guide = parseXmltv(xmltvText);
  guideCache = {
    at: Date.now(),
    m3u,
    guide,
    languageByNumber: new Map(
      apiChannels.map((c) => [
        String(c.number),
        c.language || c.preferredAudioLanguageCode || "",
      ]),
    ),
  };

  log.info("guide loaded", {
    ms: Date.now() - started,
    channels: m3u.length,
    programmes: guide.programmes.length,
  });

  return guideCache;
}

function settingsCacheKey(settings: AppSettings): string {
  return [
    settings.etvUrl,
    settings.etvDatabase,
    settings.libraryPath,
    settings.etvPathPrefix,
    settings.outputPath,
  ].join("|");
}

function scheduleCacheFresh(cacheKey: string): boolean {
  return Boolean(
    scheduleCache &&
    scheduleCache.key === cacheKey &&
    Date.now() - scheduleCache.at < SCHEDULE_TTL_MS,
  );
}

function viewsCacheFresh(cacheKey: string): boolean {
  return Boolean(
    viewsCache &&
    viewsCache.key === cacheKey &&
    Date.now() - viewsCache.at < SCHEDULE_TTL_MS,
  );
}

export async function loadChannelViews(
  settings: AppSettings,
): Promise<ChannelView[]> {
  const cacheKey = settingsCacheKey(settings);
  if (viewsCacheFresh(cacheKey)) {
    log.debug("channel views cache hit", {
      channels: viewsCache!.views.length,
    });

    return viewsCache!.views;
  }

  log.info("building channel views", {
    db: settings.etvDatabase,
    prefix: settings.etvPathPrefix,
    library: settings.libraryPath,
  });

  const started = Date.now();
  const { m3u, guide, languageByNumber } = await loadGuide(settings);
  const overrides = loadChannelOverrides();
  const itemCount = settings.promoItemCount ?? 3;
  const byNumber = new Map<string, ChannelScheduleSlice>();

  let db;
  try {
    db = openDb(settings.etvDatabase, true);
    log.debug("opened ersatztv db");
  } catch (err) {
    log.error(
      "failed to open ersatztv db",
      err instanceof Error ? err.message : String(err),
    );

    const views: ChannelView[] = [];
    for (const ch of m3u) {
      const override = overrides[ch.number];
      const color = override?.color ?? "#1a468d";
      const language =
        override?.language || languageByNumber.get(ch.number) || "en";

      const out = promoOutputFile(settings.outputPath, ch.name);
      const logoUrl = await ensureChannelLogo(settings, ch.number, ch.logoUrl);
      byNumber.set(ch.number, {
        channelNumber: ch.number,
        channelName: ch.name,
        tvgId: ch.tvgId,
        upstreamLogoUrl: ch.logoUrl,
        language,
        color,
        next: [],
      });

      views.push({
        number: ch.number,
        name: ch.name,
        tvgId: ch.tvgId,
        logoUrl,
        language,
        color,
        colorLocked: Boolean(override?.colorLocked),
        enabled: override?.enabled ?? true,
        nextItems: [],
        promoExists: fileExists(out),
        promoUrl: fileExists(out)
          ? `/media/${encodeURIComponent(sanitizeChannelFolderName(ch.name))}/next-items.mp4`
          : undefined,
        livePromoUrl: livePreviewPath(ch.number),
        lastError: err instanceof Error ? err.message : String(err),
      });
    }

    const at = Date.now();
    scheduleCache = { at, key: cacheKey, byNumber };
    viewsCache = { at, key: cacheKey, views };
    return views;
  }

  try {
    const now = new Date();
    const views: ChannelView[] = [];

    for (const ch of m3u) {
      const override = overrides[ch.number] ?? { enabled: true };
      const language =
        override.language || languageByNumber.get(ch.number) || "en";

      let color = override.color;
      let colorLocked = Boolean(override.colorLocked);

      // Cache logo for UI proxy; extract color only when we don't already have one.
      const logoUrl = await ensureChannelLogo(settings, ch.number, ch.logoUrl);
      if (logoUrl && !color) {
        const logoPath = logoCacheFile(
          settings.cachePath,
          sanitizeChannelFolderName(ch.number),
        );

        if (fs.existsSync(logoPath)) {
          color = await extractDominantColor(logoPath);
          updateChannelOverride(ch.number, {
            color,
            colorLocked: false,
            enabled: override.enabled ?? true,
          });
        }
      }

      color = color ?? "#1a468d";

      const current = getCurrentPrimaryItem(db, ch.number, toUtcSqlite(now));
      const afterIso = current ? current.finish : toUtcSqlite(now);
      // +1 look-ahead for VO; UI shows only promoItemCount.
      const nextRows = getPrimaryItemsAfter(
        db,
        ch.number,
        afterIso,
        itemCount + 1,
      );

      const labeledNext: LabeledPlayout[] = [];
      for (const row of nextRows) {
        const start = fromSqliteUtc(row.start);
        const finish = fromSqliteUtc(row.finish);
        const prog = matchProgramme(guide.programmes, ch.tvgId, start);
        const labels = resolveItemLabels(db, row, prog);
        labeledNext.push({ row, start, finish, ...labels });
      }

      let labeledCurrent: LabeledPlayout | undefined;
      if (current) {
        const start = fromSqliteUtc(current.start);
        const finish = fromSqliteUtc(current.finish);
        const prog = matchProgramme(guide.programmes, ch.tvgId, start);
        const labels = resolveItemLabels(db, current, prog);
        labeledCurrent = { row: current, start, finish, ...labels };
      }

      byNumber.set(ch.number, {
        channelNumber: ch.number,
        channelName: ch.name,
        tvgId: ch.tvgId,
        upstreamLogoUrl: ch.logoUrl,
        language,
        color,
        current: labeledCurrent,
        currentKey: current
          ? `${current.mediaItemId}@${current.start}`
          : undefined,
        next: labeledNext,
      });

      const nextItems: ScheduleItemPreview[] = [];
      for (const item of labeledNext.slice(0, itemCount)) {
        const resolved = await resolveFile(
          settings,
          item.row,
          item.title,
          item.seasonNumber,
          item.episodeNumber,
          {
            allowLibraryScan: false,
            allowProbe: false,
          },
        );

        nextItems.push({
          mediaItemId: item.row.mediaItemId,
          title: item.title,
          episodeTitle: item.episodeTitle,
          seasonNumber: item.seasonNumber,
          episodeNumber: item.episodeNumber,
          start: item.start.toISOString(),
          finish: item.finish.toISOString(),
          filePath: resolved.filePath,
          durationSeconds: resolved.durationSeconds,
          error: resolved.error,
        });
      }

      const currentItem: ScheduleItemPreview | undefined = labeledCurrent
        ? {
            mediaItemId: labeledCurrent.row.mediaItemId,
            title: labeledCurrent.title,
            episodeTitle: labeledCurrent.episodeTitle,
            seasonNumber: labeledCurrent.seasonNumber,
            episodeNumber: labeledCurrent.episodeNumber,
            start: labeledCurrent.start.toISOString(),
            finish: labeledCurrent.finish.toISOString(),
          }
        : undefined;

      const out = promoOutputFile(settings.outputPath, ch.name);
      const leadMs = settings.regenLeadMinutes * 60_000;
      const nextRegenAt = currentItem
        ? new Date(
            new Date(currentItem.finish).getTime() - leadMs,
          ).toISOString()
        : undefined;

      views.push({
        number: ch.number,
        name: ch.name,
        tvgId: ch.tvgId,
        logoUrl,
        language,
        color,
        colorLocked,
        enabled: override.enabled ?? true,
        nextItems,
        currentItem,
        nextRegenAt,
        promoExists: fileExists(out),
        promoUrl: fileExists(out)
          ? `/media/${encodeURIComponent(sanitizeChannelFolderName(ch.name))}/next-items.mp4`
          : undefined,
        livePromoUrl: livePreviewPath(ch.number),
      });
    }

    const missingPaths = views.reduce(
      (n, v) => n + v.nextItems.filter((i) => i.error).length,
      0,
    );

    log.info("channel views ready", {
      ms: Date.now() - started,
      channels: views.length,
      nextItemErrors: missingPaths,
      ttlSec: SCHEDULE_TTL_MS / 1000,
    });

    const at = Date.now();
    scheduleCache = { at, key: cacheKey, byNumber };
    viewsCache = { at, key: cacheKey, views };
    return views;
  } finally {
    db.close();
  }
}

export function invalidateChannelCaches(): void {
  guideCache = null;
  viewsCache = null;
  scheduleCache = null;
}

/** Bust schedule caches and reload (UI “Refresh schedule”). */
export async function refreshChannelViews(
  settings: AppSettings,
): Promise<ChannelView[]> {
  invalidateChannelCaches();
  return loadChannelViews(settings);
}

async function ensureChannelSchedule(
  settings: AppSettings,
  channelNumber: string,
): Promise<ChannelScheduleSlice> {
  const cacheKey = settingsCacheKey(settings);
  if (!scheduleCacheFresh(cacheKey)) {
    // Views + schedule share one snapshot — clear both so we never return
    // stale schedule behind a still-fresh viewsCache early-return.
    viewsCache = null;
    scheduleCache = null;
    await loadChannelViews(settings);
  }

  const slice = scheduleCache?.byNumber.get(channelNumber);
  if (!slice) {
    throw new Error(`Channel ${channelNumber} not found`);
  }

  return slice;
}

/** Public alias for live encode path (avoids a second views load for the name). */
export async function ensureChannelScheduleForLive(
  settings: AppSettings,
  channelNumber: string,
): Promise<ChannelScheduleSlice> {
  return ensureChannelSchedule(settings, channelNumber);
}

export type ChapterProgress = (
  message: string,
  level?: "info" | "warn" | "error",
) => void;

export interface UpcomingPromoMetaItem {
  mediaItemId: number;
  start: string;
  finish: string;
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  startLabel: string;
}

/**
 * Upcoming primary items for VO warm / fingerprint — no media file resolve.
 * Uses the shared 1-minute schedule snapshot (current window + look-ahead).
 */
export async function listUpcomingPromoMeta(
  settings: AppSettings,
  channelNumber: string,
): Promise<{
  channelName: string;
  language: string;
  currentKey?: string;
  items: UpcomingPromoMetaItem[];
}> {
  const overrides = loadChannelOverrides();
  const override = overrides[channelNumber] ?? { enabled: true };
  if (override.enabled === false) {
    throw new Error(`Channel ${channelNumber} is disabled`);
  }

  const slice = await ensureChannelSchedule(settings, channelNumber);
  const items = slice.next.map((item) => ({
    mediaItemId: item.row.mediaItemId,
    start: item.row.start,
    finish: item.row.finish,
    title: item.title,
    episodeTitle: item.episodeTitle,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    startLabel: formatStartsAtLabel(
      slice.language,
      item.start,
      settings.timeZone,
    ),
  }));

  return {
    channelName: slice.channelName,
    language: slice.language,
    currentKey: slice.currentKey,
    items,
  };
}

export async function buildPromoChaptersForChannel(
  settings: AppSettings,
  channelNumber: string,
  onProgress?: ChapterProgress,
): Promise<{
  channelName: string;
  language: string;
  color: string;
  logoPath?: string;
  chapters: Array<{
    filePath: string;
    durationSeconds: number;
    hasAudio?: boolean;
    title: string;
    episodeTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    startLabel: string;
  }>;
}> {
  const progress = onProgress ?? (() => undefined);
  const overrides = loadChannelOverrides();
  const override = overrides[channelNumber] ?? { enabled: true };
  if (override.enabled === false) {
    throw new Error(`Channel ${channelNumber} is disabled`);
  }

  log.info("building promo chapters", { channelNumber });
  progress("Loading schedule snapshot");
  const slice = await ensureChannelSchedule(settings, channelNumber);
  const itemCount = settings.promoItemCount ?? 3;
  const labeledRows = slice.next.slice(0, itemCount);
  progress(`Found ${labeledRows.length} upcoming primary item(s) (cached)`);

  log.debug("upcoming playout rows", {
    channel: slice.channelName,
    currentId: slice.current?.row.mediaItemId,
    next: labeledRows.map((r) => ({
      id: r.row.mediaItemId,
      title: r.title,
      episodeTitle: r.episodeTitle,
      s: r.seasonNumber,
      e: r.episodeNumber,
      path: r.row.filePath,
    })),
  });

  const logoCacheDir = path.join(settings.cachePath, "logos");
  if (slice.upstreamLogoUrl) progress("Downloading channel logo");
  const logoPath = slice.upstreamLogoUrl
    ? await downloadLogo(
        resolveLogoUrl(slice.upstreamLogoUrl, settings.etvUrl),
        logoCacheDir,
        sanitizeChannelFolderName(slice.channelNumber),
      )
    : undefined;

  const color =
    override.color ??
    slice.color ??
    (logoPath ? await extractDominantColor(logoPath) : "#1a468d");

  const language = slice.language;

  progress(`Using color ${color}, language ${language}`);

  const chapters = [];
  for (const item of labeledRows) {
    const { row, start, title, episodeTitle, seasonNumber, episodeNumber } =
      item;

    progress(
      `Resolving media: ${title}` +
        (seasonNumber != null && episodeNumber != null
          ? ` S${seasonNumber}E${episodeNumber}`
          : "") +
        (episodeTitle ? ` — ${episodeTitle}` : ""),
    );

    const resolved = await resolveFile(
      settings,
      row,
      title,
      seasonNumber,
      episodeNumber,
      {
        allowLibraryScan: true,
        allowProbe: true,
      },
    );

    if (!resolved.filePath || !resolved.durationSeconds) {
      progress(
        resolved.error
          ? `Skip ${title}: ${resolved.error}`
          : `Skip ${title}: unresolved path/duration`,
        "warn",
      );

      continue;
    }

    progress(
      `Resolved ${title} → ${resolved.filePath} (${Math.round(resolved.durationSeconds)}s)`,
    );

    const audioStreams = await probeAudioStreams(resolved.filePath).catch(
      () => [],
    );

    const picked = pickAudioStreamForLanguage(audioStreams, language);
    const hasAudio = audioStreams.length > 0;
    if (hasAudio) {
      progress(
        picked?.language
          ? `Audio track a:${picked.audioIndex} (${picked.language}) for ${title}`
          : `Audio track a:${picked?.audioIndex ?? 0} (untagged) for ${title}`,
      );
    }

    chapters.push({
      filePath: resolved.filePath,
      durationSeconds: resolved.durationSeconds,
      hasAudio,
      audioStreamIndex: picked?.audioIndex,
      audioStreamLanguage: picked?.language,
      title,
      episodeTitle,
      seasonNumber,
      episodeNumber,
      startLabel: formatStartsAtLabel(language, start, settings.timeZone),
    });
  }

  if (chapters.length === 0) {
    throw new Error(
      `No resolvable upcoming items for channel ${slice.channelName}`,
    );
  }

  progress(`Ready with ${chapters.length} chapter source(s)`);
  log.info("promo chapters ready", {
    channel: slice.channelName,
    language,
    chapters: chapters.map((c) => ({
      title: c.title,
      file: c.filePath,
      dur: c.durationSeconds,
    })),
  });

  return {
    channelName: slice.channelName,
    language,
    color,
    logoPath,
    chapters,
  };
}

export function getFontFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../assets/fonts/NotoSans-Regular.ttf"),
    path.resolve(process.cwd(), "assets/fonts/NotoSans-Regular.ttf"),
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return candidates[0]!;
}

export type { ChannelOverrides };
