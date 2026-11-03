import path from 'node:path';
import {
  AppSettings,
  JobLogLevel,
  PushChannelResult,
  PushResult,
  sanitizeChannelFolderName,
} from '@promo/shared';
import { EtvApiClient } from '../ersatztv/api.js';
import {
  ensurePromoLibrary,
  findMediaItemByFileName,
  findMediaItemByPath,
  getPlayoutForChannel,
  openDb,
  resetSchemaCache,
  scheduleSharedByOtherChannels,
  setScheduleItemsPreRoll,
  upsertFillerPreset,
} from '../ersatztv/db.js';
import { fileExists, promoOutputFile } from '../util/paths.js';
import { createLogger } from '../util/log.js';
import { backupErsatzTvDatabase } from './etv-backup.js';
import { loadChannelViews } from './channels.js';

const log = createLogger('push');

export type PushProgress = (message: string, level?: JobLogLevel) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isClassicSchedule(kind: number | string | null | undefined): boolean {
  // PlayoutScheduleKind: None=0, Classic=1, Block=2, Sequential=3, Scripted=4, ExternalJson=20
  if (kind == null) return true; // older schemas without kind often mean classic
  if (typeof kind === 'number') return kind === 0 || kind === 1;
  const lower = String(kind).toLowerCase();
  return lower === '0' || lower === '1' || lower === 'classic' || lower === 'none';
}

export async function pushToErsatzTv(
  settings: AppSettings,
  onProgress: PushProgress = () => undefined,
): Promise<PushResult> {
  const progress = (message: string, level: JobLogLevel = 'info') => {
    onProgress(message, level);
    if (level === 'error') log.error(message);
    else if (level === 'warn') log.warn(message);
    else log.info(message);
  };

  resetSchemaCache();
  progress('Loading enabled channels');
  const channels = (await loadChannelViews(settings)).filter((c) => c.enabled);
  progress(`Enabled channels: ${channels.length}`);
  const results: PushChannelResult[] = [];
  const etvLibraryPath = settings.etvLibraryPath || settings.outputPath;
  const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);

  progress('Backing up ersatztv.sqlite3');
  const backup = await backupErsatzTvDatabase(settings, 'pre-push');
  progress(`Backup ready: ${backup.id} (${backup.bytes} bytes)`);

  progress(`Ensuring Promo Generator library at ${etvLibraryPath}`);
  const db = openDb(settings.etvDatabase, false);
  let libraryId: number;
  try {
    libraryId = ensurePromoLibrary(db, 'Promo Generator', etvLibraryPath).libraryId;
    progress(`Library id ${libraryId}`);
  } catch (err) {
    db.close();
    const message = err instanceof Error ? err.message : String(err);
    progress(message, 'error');
    return {
      backup,
      results: channels.map((c) => ({
        channelNumber: c.number,
        channelName: c.name,
        ok: false,
        message,
      })),
    };
  }
  db.close();

  try {
    progress(`Scanning library ${libraryId}`);
    await api.scanLibrary(libraryId);
  } catch (err) {
    const message = `Library scan failed: ${err instanceof Error ? err.message : String(err)}`;
    progress(message, 'error');
    return {
      backup,
      results: channels.map((c) => ({
        channelNumber: c.number,
        channelName: c.name,
        ok: false,
        message,
      })),
    };
  }

  for (const channel of channels) {
    progress(`Channel ${channel.number} (${channel.name})`);
    const localPath = promoOutputFile(settings.outputPath, channel.name);
    if (!fileExists(localPath)) {
      const message = 'Promo file missing; generate it first';
      progress(`  ${message}`, 'warn');
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: false,
        message,
      });
      continue;
    }

    const etvFilePath = path.posix.join(
      etvLibraryPath.replace(/\\/g, '/').replace(/\/+$/, ''),
      sanitizeChannelFolderName(channel.name),
      'next-items.mp4',
    );

    progress(`  Waiting for scan: ${etvFilePath}`);
    let mediaItemId: number | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const rw = openDb(settings.etvDatabase, true);
      try {
        const byPath =
          findMediaItemByPath(rw, etvFilePath) ??
          findMediaItemByFileName(rw, `${sanitizeChannelFolderName(channel.name)}/next-items.mp4`);
        if (byPath) {
          mediaItemId = byPath.mediaItemId;
          break;
        }
      } finally {
        rw.close();
      }
      if (attempt === 0 || (attempt + 1) % 5 === 0) {
        progress(`  Still waiting for media item (attempt ${attempt + 1}/30)`);
      }
      await sleep(2000);
    }

    if (!mediaItemId) {
      const message = `Timed out waiting for scan of ${etvFilePath}`;
      progress(`  ${message}`, 'error');
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: false,
        message,
      });
      continue;
    }

    progress(`  Media item ${mediaItemId}`);
    const writeDb = openDb(settings.etvDatabase, false);
    try {
      const playout = getPlayoutForChannel(writeDb, channel.number);
      if (!playout) {
        const message = 'No playout found for channel';
        progress(`  ${message}`, 'warn');
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
        });
        continue;
      }
      if (!isClassicSchedule(playout.scheduleKind)) {
        const message = `Skipped: playout kind ${String(playout.scheduleKind)} is not classic`;
        progress(`  ${message}`, 'warn');
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
        });
        continue;
      }
      if (!playout.programScheduleId) {
        const message = 'Skipped: no ProgramScheduleId on playout';
        progress(`  ${message}`, 'warn');
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
        });
        continue;
      }

      const shared = scheduleSharedByOtherChannels(writeDb, playout.programScheduleId, playout.channelId);
      if (shared.length > 0) {
        const message = `Skipped: schedule shared with ${shared.join(', ')}`;
        progress(`  ${message}`, 'warn');
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
        });
        continue;
      }

      const presetName = `Promo pre-roll ${channel.number}`;
      const preset = upsertFillerPreset(writeDb, presetName, mediaItemId);
      progress(`  Filler preset ${preset.id}${preset.created ? ' (created)' : ' (updated)'}`);
      const applied = setScheduleItemsPreRoll(writeDb, playout.programScheduleId, preset.id);
      progress(`  Pre-roll set on ${applied.updated} schedule item(s)`);

      try {
        progress('  Resetting playout');
        await api.resetPlayout(channel.number);
      } catch (err) {
        const message = `Pre-roll set, but playout reset failed: ${err instanceof Error ? err.message : String(err)}`;
        progress(`  ${message}`, 'error');
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
          replacedPreRoll: applied.previousNames.join(', ') || undefined,
        });
        continue;
      }

      const message = `Pre-roll set on ${applied.updated} schedule item(s); playout reset`;
      progress(`  OK — ${message}`);
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: true,
        message,
        replacedPreRoll: applied.previousNames.join(', ') || undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress(`  ${message}`, 'error');
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: false,
        message,
      });
    } finally {
      writeDb.close();
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  progress(`Push finished: ${okCount}/${results.length} channel(s) succeeded`);
  return { results, backup };
}
