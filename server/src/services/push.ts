import path from 'node:path';
import { AppSettings, PushChannelResult, PushResult, sanitizeChannelFolderName } from '@promo/shared';
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

export async function pushToErsatzTv(settings: AppSettings): Promise<PushResult> {
  resetSchemaCache();
  const channels = (await loadChannelViews(settings)).filter((c) => c.enabled);
  const results: PushChannelResult[] = [];
  const etvLibraryPath = settings.etvLibraryPath || settings.outputPath;
  const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);

  const backup = await backupErsatzTvDatabase(settings, 'pre-push');
  log.info('pre-push backup ready', { id: backup.id, bytes: backup.bytes });

  const db = openDb(settings.etvDatabase, false);
  let libraryId: number;
  try {
    libraryId = ensurePromoLibrary(db, 'Promo Generator', etvLibraryPath).libraryId;
  } catch (err) {
    db.close();
    return {
      backup,
      results: channels.map((c) => ({
        channelNumber: c.number,
        channelName: c.name,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })),
    };
  }
  db.close();

  try {
    await api.scanLibrary(libraryId);
  } catch (err) {
    return {
      backup,
      results: channels.map((c) => ({
        channelNumber: c.number,
        channelName: c.name,
        ok: false,
        message: `Library scan failed: ${err instanceof Error ? err.message : String(err)}`,
      })),
    };
  }

  // Wait for media items to appear
  for (const channel of channels) {
    const localPath = promoOutputFile(settings.outputPath, channel.name);
    if (!fileExists(localPath)) {
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: false,
        message: 'Promo file missing; generate it first',
      });
      continue;
    }

    const etvFilePath = path.posix.join(
      etvLibraryPath.replace(/\\/g, '/').replace(/\/+$/, ''),
      sanitizeChannelFolderName(channel.name),
      'next-items.mp4',
    );

    let mediaItemId: number | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const rw = openDb(settings.etvDatabase, true);
      try {
        const byPath = findMediaItemByPath(rw, etvFilePath) ?? findMediaItemByFileName(rw, `${sanitizeChannelFolderName(channel.name)}/next-items.mp4`);
        if (byPath) {
          mediaItemId = byPath.mediaItemId;
          break;
        }
      } finally {
        rw.close();
      }
      await sleep(2000);
    }

    if (!mediaItemId) {
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: false,
        message: `Timed out waiting for scan of ${etvFilePath}`,
      });
      continue;
    }

    const writeDb = openDb(settings.etvDatabase, false);
    try {
      const playout = getPlayoutForChannel(writeDb, channel.number);
      if (!playout) {
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message: 'No playout found for channel',
        });
        continue;
      }
      if (!isClassicSchedule(playout.scheduleKind)) {
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message: `Skipped: playout kind ${String(playout.scheduleKind)} is not classic`,
        });
        continue;
      }
      if (!playout.programScheduleId) {
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message: 'Skipped: no ProgramScheduleId on playout',
        });
        continue;
      }

      const shared = scheduleSharedByOtherChannels(writeDb, playout.programScheduleId, playout.channelId);
      if (shared.length > 0) {
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message: `Skipped: schedule shared with ${shared.join(', ')}`,
        });
        continue;
      }

      const presetName = `Promo pre-roll ${channel.number}`;
      const preset = upsertFillerPreset(writeDb, presetName, mediaItemId);
      const applied = setScheduleItemsPreRoll(writeDb, playout.programScheduleId, preset.id);

      try {
        await api.resetPlayout(channel.number);
      } catch (err) {
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message: `Pre-roll set, but playout reset failed: ${err instanceof Error ? err.message : String(err)}`,
          replacedPreRoll: applied.previousNames.join(', ') || undefined,
        });
        continue;
      }

      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: true,
        message: `Pre-roll set on ${applied.updated} schedule item(s); playout reset`,
        replacedPreRoll: applied.previousNames.join(', ') || undefined,
      });
    } catch (err) {
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      writeDb.close();
    }
  }

  return { results, backup };
}
