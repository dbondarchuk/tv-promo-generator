import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppSettings,
  ChannelOverrides,
  ChannelView,
  ScheduleItemPreview,
  sanitizeChannelFolderName,
} from '@promo/shared';
import { EtvApiClient } from '../ersatztv/api.js';
import {
  openDb,
  getCurrentPrimaryItem,
  getPrimaryItemsAfter,
  getMediaItemMetadata,
  metadataFromFilePath,
  stripTitleYear,
  MediaItemMetadata,
  PlayoutRow,
} from '../ersatztv/db.js';
import type Database from 'better-sqlite3';
import { parseM3u, M3uChannel } from '../ersatztv/m3u.js';
import { parseXmltv, XmltvGuide, XmltvProgramme } from '../ersatztv/xmltv.js';
import { downloadLogo, extractDominantColor } from '../color.js';
import { loadChannelOverrides, updateChannelOverride } from '../config.js';
import { fileExists, findLibraryFile, promoOutputFile, rewritePath } from '../util/paths.js';
import { createLogger } from '../util/log.js';
import { probeDurationSeconds, probeHasAudio } from '../ffmpeg/probe.js';
import { fromSqliteUtc, toUtcSqlite } from '../ersatztv/time.js';
import { formatStartsAtLabel } from '../voice/templates.js';

const log = createLogger('channels');

function matchProgramme(programmes: XmltvProgramme[], channelId: string, start: Date): XmltvProgramme | undefined {
  const t = start.getTime();
  return programmes.find((p) => p.channelId === channelId && Math.abs(p.start.getTime() - t) < 2000)
    ?? programmes.find((p) => p.channelId === channelId && Math.abs(p.start.getTime() - t) < 60_000);
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
    getMediaItemMetadata(db, row.mediaItemId) ?? metadataFromFilePath(row.filePath);

  const title = stripTitleYear(meta?.title || prog?.title || `Item ${row.mediaItemId}`);
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
    ? rewritePath(row.filePath, settings.etvPathPrefix, settings.libraryPath || settings.etvPathPrefix)
    : undefined;
  let candidate = rewritten && fileExists(rewritten) ? rewritten : undefined;

  if (row.filePath) {
    if (candidate) {
      log.debug('resolved file', { title, db: row.filePath, local: candidate });
    } else {
      log.warn('rewrite miss', {
        title,
        db: row.filePath,
        local: rewritten,
        prefix: settings.etvPathPrefix,
        library: settings.libraryPath,
      });
    }
  } else {
    log.warn('no db path', { title, mediaItemId: row.mediaItemId });
  }

  if (!candidate && options.allowLibraryScan) {
    log.info('library scan fallback', { title, season, episode, root: settings.libraryPath });
    candidate = findLibraryFile(settings.libraryPath, title, season, episode);
    if (candidate) log.info('library scan hit', { title, local: candidate });
    else log.warn('library scan miss', { title, season, episode });
  }
  if (!candidate) {
    return {
      error: row.filePath
        ? `File not found after rewrite: ${row.filePath} → ${rewritten ?? '(no rewrite)'}`
        : 'No media file path in database',
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
    return { filePath: candidate, error: err instanceof Error ? err.message : String(err) };
  }
}

interface GuideCache {
  at: number;
  m3u: M3uChannel[];
  guide: XmltvGuide;
  languageByNumber: Map<string, string>;
}

let guideCache: GuideCache | null = null;
let viewsCache: { at: number; key: string; views: ChannelView[] } | null = null;
const GUIDE_TTL_MS = 30_000;
const VIEWS_TTL_MS = 10_000;

async function loadGuide(settings: AppSettings): Promise<GuideCache> {
  if (guideCache && Date.now() - guideCache.at < GUIDE_TTL_MS) {
    log.debug('guide cache hit');
    return guideCache;
  }
  log.info('loading guide from ErsatzTV', { url: settings.etvUrl });
  const started = Date.now();
  const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);
  const [m3uText, xmltvText, apiChannels] = await Promise.all([
    api.getM3u(),
    api.getXmltv(),
    api.getChannels().catch((err) => {
      log.warn('api/channels failed; continuing without languages', String(err));
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
      apiChannels.map((c) => [String(c.number), c.language || c.preferredAudioLanguageCode || '']),
    ),
  };
  log.info('guide loaded', {
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
  ].join('|');
}

export async function loadChannelViews(settings: AppSettings): Promise<ChannelView[]> {
  const cacheKey = settingsCacheKey(settings);
  if (viewsCache && viewsCache.key === cacheKey && Date.now() - viewsCache.at < VIEWS_TTL_MS) {
    log.debug('channel views cache hit', { channels: viewsCache.views.length });
    return viewsCache.views;
  }

  log.info('building channel views', {
    db: settings.etvDatabase,
    prefix: settings.etvPathPrefix,
    library: settings.libraryPath,
  });
  const started = Date.now();
  const { m3u, guide, languageByNumber } = await loadGuide(settings);
  const overrides = loadChannelOverrides();

  let db;
  try {
    db = openDb(settings.etvDatabase, true);
    log.debug('opened ersatztv db');
  } catch (err) {
    log.error('failed to open ersatztv db', err instanceof Error ? err.message : String(err));
    const views = m3u.map((ch) => {
      const override = overrides[ch.number];
      const color = override?.color ?? '#1a468d';
      const out = promoOutputFile(settings.outputPath, ch.name);
      return {
        number: ch.number,
        name: ch.name,
        tvgId: ch.tvgId,
        logoUrl: ch.logoUrl,
        language: override?.language || languageByNumber.get(ch.number) || 'en',
        color,
        colorLocked: Boolean(override?.colorLocked),
        enabled: override?.enabled ?? true,
        nextItems: [],
        promoExists: fileExists(out),
        promoUrl: fileExists(out) ? `/media/${encodeURIComponent(sanitizeChannelFolderName(ch.name))}/next-items.mp4` : undefined,
        lastError: err instanceof Error ? err.message : String(err),
      } satisfies ChannelView;
    });
    viewsCache = { at: Date.now(), key: cacheKey, views };
    return views;
  }

  try {
    const now = new Date();
    const views: ChannelView[] = [];
    const logoCacheDir = path.join(settings.cachePath, 'logos');

    for (const ch of m3u) {
      const override = overrides[ch.number] ?? { enabled: true };
      const language = override.language || languageByNumber.get(ch.number) || 'en';
      let color = override.color;
      let colorLocked = Boolean(override.colorLocked);

      // Only download/extract color when we don't already have one (cached logo file reused).
      if (!color && ch.logoUrl) {
        const logoPath = await downloadLogo(ch.logoUrl, logoCacheDir, sanitizeChannelFolderName(ch.number));
        if (logoPath) {
          color = await extractDominantColor(logoPath);
          updateChannelOverride(ch.number, { color, colorLocked: false, enabled: override.enabled ?? true });
        }
      }
      color = color ?? '#1a468d';

      const current = getCurrentPrimaryItem(db, ch.number, toUtcSqlite(now));
      const afterIso = current ? current.finish : toUtcSqlite(now);
      const nextRows = getPrimaryItemsAfter(db, ch.number, afterIso, 3);

      const nextItems: ScheduleItemPreview[] = [];
      for (const row of nextRows) {
        const start = fromSqliteUtc(row.start);
        const finish = fromSqliteUtc(row.finish);
        const prog = matchProgramme(guide.programmes, ch.tvgId, start);
        const labels = resolveItemLabels(db, row, prog);
        const resolved = await resolveFile(
          settings,
          row,
          labels.title,
          labels.seasonNumber,
          labels.episodeNumber,
          {
            allowLibraryScan: false,
            allowProbe: false,
          },
        );
        nextItems.push({
          mediaItemId: row.mediaItemId,
          title: labels.title,
          episodeTitle: labels.episodeTitle,
          seasonNumber: labels.seasonNumber,
          episodeNumber: labels.episodeNumber,
          start: start.toISOString(),
          finish: finish.toISOString(),
          filePath: resolved.filePath,
          durationSeconds: resolved.durationSeconds,
          error: resolved.error,
        });
      }

      let currentItem: ScheduleItemPreview | undefined;
      if (current) {
        const start = fromSqliteUtc(current.start);
        const finish = fromSqliteUtc(current.finish);
        const prog = matchProgramme(guide.programmes, ch.tvgId, start);
        const labels = resolveItemLabels(db, current, prog);
        currentItem = {
          mediaItemId: current.mediaItemId,
          title: labels.title,
          episodeTitle: labels.episodeTitle,
          seasonNumber: labels.seasonNumber,
          episodeNumber: labels.episodeNumber,
          start: start.toISOString(),
          finish: finish.toISOString(),
        };
      }

      const out = promoOutputFile(settings.outputPath, ch.name);
      const leadMs = settings.regenLeadMinutes * 60_000;
      const nextRegenAt = currentItem
        ? new Date(new Date(currentItem.finish).getTime() - leadMs).toISOString()
        : undefined;

      views.push({
        number: ch.number,
        name: ch.name,
        tvgId: ch.tvgId,
        logoUrl: ch.logoUrl,
        language,
        color,
        colorLocked,
        enabled: override.enabled ?? true,
        nextItems,
        currentItem,
        nextRegenAt,
        promoExists: fileExists(out),
        promoUrl: fileExists(out) ? `/media/${encodeURIComponent(sanitizeChannelFolderName(ch.name))}/next-items.mp4` : undefined,
      });
    }

    const missingPaths = views.reduce(
      (n, v) => n + v.nextItems.filter((i) => i.error).length,
      0,
    );
    log.info('channel views ready', {
      ms: Date.now() - started,
      channels: views.length,
      nextItemErrors: missingPaths,
    });
    viewsCache = { at: Date.now(), key: cacheKey, views };
    return views;
  } finally {
    db.close();
  }
}

export function invalidateChannelCaches(): void {
  guideCache = null;
  viewsCache = null;
}

export type ChapterProgress = (message: string, level?: 'info' | 'warn' | 'error') => void;

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
  invalidateChannelCaches();
  log.info('building promo chapters', { channelNumber });
  progress('Loading guide (M3U / XMLTV)');
  const { m3u, guide, languageByNumber } = await loadGuide(settings);
  const channelMeta = m3u.find((c) => c.number === channelNumber);
  if (!channelMeta) throw new Error(`Channel ${channelNumber} not found`);

  const overrides = loadChannelOverrides();
  const override = overrides[channelNumber] ?? { enabled: true };
  if (override.enabled === false) throw new Error(`Channel ${channelNumber} is disabled`);

  progress(`Opening ErsatzTV database for ${channelMeta.name}`);
  const db = openDb(settings.etvDatabase, true);
  let labeledRows: Array<{
    row: PlayoutRow;
    start: Date;
    title: string;
    episodeTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
  }> = [];
  try {
    const now = new Date();
    const current = getCurrentPrimaryItem(db, channelNumber, toUtcSqlite(now));
    const afterIso = current ? current.finish : toUtcSqlite(now);
    const nextRows = getPrimaryItemsAfter(db, channelNumber, afterIso, 3);
    progress(`Found ${nextRows.length} upcoming primary item(s)`);
    labeledRows = nextRows.map((row) => {
      const start = fromSqliteUtc(row.start);
      const prog = matchProgramme(guide.programmes, channelMeta.tvgId, start);
      const labels = resolveItemLabels(db, row, prog);
      return { row, start, ...labels };
    });
    log.debug('upcoming playout rows', {
      channel: channelMeta.name,
      currentId: current?.mediaItemId,
      next: labeledRows.map((r) => ({
        id: r.row.mediaItemId,
        title: r.title,
        episodeTitle: r.episodeTitle,
        s: r.seasonNumber,
        e: r.episodeNumber,
        path: r.row.filePath,
      })),
    });
  } finally {
    db.close();
  }

  const logoCacheDir = path.join(settings.cachePath, 'logos');
  if (channelMeta.logoUrl) progress('Downloading channel logo');
  const logoPath = channelMeta.logoUrl
    ? await downloadLogo(channelMeta.logoUrl, logoCacheDir, sanitizeChannelFolderName(channelMeta.number))
    : undefined;
  const color = override.color
    ?? (logoPath ? await extractDominantColor(logoPath) : '#1a468d');
  const language = override.language || languageByNumber.get(channelNumber) || 'en';
  progress(`Using color ${color}, language ${language}`);

  const chapters = [];
  for (const item of labeledRows) {
    const { row, start, title, episodeTitle, seasonNumber, episodeNumber } = item;
    progress(
      `Resolving media: ${title}` +
        (seasonNumber != null && episodeNumber != null ? ` S${seasonNumber}E${episodeNumber}` : '') +
        (episodeTitle ? ` — ${episodeTitle}` : ''),
    );
    const resolved = await resolveFile(settings, row, title, seasonNumber, episodeNumber, {
      allowLibraryScan: true,
      allowProbe: true,
    });
    if (!resolved.filePath || !resolved.durationSeconds) {
      progress(
        resolved.error
          ? `Skip ${title}: ${resolved.error}`
          : `Skip ${title}: unresolved path/duration`,
        'warn',
      );
      continue;
    }
    progress(`Resolved ${title} → ${resolved.filePath} (${Math.round(resolved.durationSeconds)}s)`);
    const hasAudio = await probeHasAudio(resolved.filePath);
    chapters.push({
      filePath: resolved.filePath,
      durationSeconds: resolved.durationSeconds,
      hasAudio,
      title,
      episodeTitle,
      seasonNumber,
      episodeNumber,
      startLabel: formatStartsAtLabel(language, start, settings.timeZone),
    });
  }
  if (chapters.length === 0) {
    throw new Error(`No resolvable upcoming items for channel ${channelMeta.name}`);
  }

  progress(`Ready with ${chapters.length} chapter source(s)`);
  log.info('promo chapters ready', {
    channel: channelMeta.name,
    language,
    chapters: chapters.map((c) => ({ title: c.title, file: c.filePath, dur: c.durationSeconds })),
  });

  return {
    channelName: channelMeta.name,
    language,
    color,
    logoPath,
    chapters,
  };
}

export function getFontFile(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../assets/fonts/NotoSans-Regular.ttf'),
    path.resolve(process.cwd(), 'assets/fonts/NotoSans-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

export type { ChannelOverrides };
