import { AppSettings } from '@promo/shared';
import { openDb, getCurrentPrimaryItem, getUpcomingPlayoutItems, listChannelNumbers } from '../ersatztv/db.js';
import { fileExists, promoOutputFile } from '../util/paths.js';
import { createLogger } from '../util/log.js';
import { loadChannelOverrides } from '../config.js';
import { JobQueue } from './jobs.js';

const log = createLogger('scheduler');

function fromSqliteUtc(value: string): Date {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const hasZone = /Z|[+-]\d{2}:?\d{2}$/.test(normalized);
  return new Date(hasZone ? normalized : `${normalized}Z`);
}

function toUtcSqlite(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace('T', ' ');
}

export class RegenScheduler {
  private timer?: NodeJS.Timeout;
  private settingsProvider: () => AppSettings;
  private jobs: JobQueue;
  private running = false;

  constructor(settingsProvider: () => AppSettings, jobs: JobQueue) {
    this.settingsProvider = settingsProvider;
    this.jobs = jobs;
  }

  start(): void {
    log.info('scheduler started', { intervalMs: 60_000 });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) {
      log.debug('scheduler tick skipped (already running)');
      return;
    }
    this.running = true;
    const started = Date.now();
    let enqueued = 0;
    try {
      const settings = this.settingsProvider();
      if (!settings.etvDatabase) return;

      let db;
      try {
        db = openDb(settings.etvDatabase, true);
      } catch (err) {
        log.warn('scheduler could not open db', err instanceof Error ? err.message : String(err));
        return;
      }

      try {
        const now = new Date();
        const leadMs = settings.regenLeadMinutes * 60_000;
        const overrides = loadChannelOverrides();
        const channels = listChannelNumbers(db);
        log.debug('scheduler scanning channels', { count: channels.length, leadMinutes: settings.regenLeadMinutes });

        for (const channel of channels) {
          if (overrides[channel.number]?.enabled === false) continue;

          const promoPath = promoOutputFile(settings.outputPath, channel.name);
          const missing = !fileExists(promoPath);

          const windowStart = toUtcSqlite(new Date(now.getTime() - 6 * 3600_000));
          const nearby = getUpcomingPlayoutItems(db, channel.number, windowStart, 40);
          const currentAny = nearby.find((row) => {
            const start = fromSqliteUtc(row.start).getTime();
            const finish = fromSqliteUtc(row.finish).getTime();
            return start <= now.getTime() && finish > now.getTime();
          });

          if (currentAny && (currentAny.fillerKind ?? 0) !== 0) {
            continue;
          }

          const current = getCurrentPrimaryItem(db, channel.number, toUtcSqlite(now));
          if (!current) {
            if (missing) {
              log.info('scheduler enqueue (missing promo, no current item)', {
                channel: channel.name,
                number: channel.number,
              });
              this.jobs.enqueue({
                channelNumber: channel.number,
                channelName: channel.name,
                preferFront: true,
              });
              enqueued += 1;
            }
            continue;
          }

          const finish = fromSqliteUtc(current.finish);
          const deadline = new Date(finish.getTime() - leadMs);
          const itemShort = finish.getTime() - now.getTime() < leadMs;

          if (missing || itemShort || deadline.getTime() <= now.getTime()) {
            log.info('scheduler enqueue', {
              channel: channel.name,
              number: channel.number,
              missing,
              itemShort,
              deadline: deadline.toISOString(),
              finish: finish.toISOString(),
            });
            this.jobs.enqueue({
              channelNumber: channel.number,
              channelName: channel.name,
              deadline,
              preferFront: missing || itemShort,
            });
            enqueued += 1;
          }
        }
      } finally {
        db.close();
      }
    } finally {
      log.debug('scheduler tick done', { ms: Date.now() - started, enqueued });
      this.running = false;
    }
  }
}
