import { AppSettings } from "@promo/shared";
import { loadChannelOverrides } from "../config.js";
import {
  getCurrentPrimaryItem,
  getUpcomingPlayoutItems,
  listChannelNumbers,
  openDb,
} from "../ersatztv/db.js";
import { fromSqliteUtc, toUtcSqlite } from "../ersatztv/time.js";
import { createLogger } from "../util/log.js";
import { fileExists, promoOutputFile } from "../util/paths.js";
import { JobQueue } from "./jobs.js";

const log = createLogger("scheduler");

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
    log.info("scheduler started", { intervalMs: 60_000 });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) {
      log.debug("scheduler tick skipped (already running)");
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
        log.warn(
          "scheduler could not open db",
          err instanceof Error ? err.message : String(err),
        );

        return;
      }

      try {
        const now = new Date();
        const leadMs = settings.regenLeadMinutes * 60_000;
        const overrides = loadChannelOverrides();
        const channels = listChannelNumbers(db);
        log.debug("scheduler scanning channels", {
          count: channels.length,
          leadMinutes: settings.regenLeadMinutes,
        });

        for (const channel of channels) {
          if (overrides[channel.number]?.enabled === false) continue;

          const promoPath = promoOutputFile(settings.outputPath, channel.name);
          const missing = !fileExists(promoPath);

          const windowStart = toUtcSqlite(
            new Date(now.getTime() - 6 * 3600_000),
          );

          const nearby = getUpcomingPlayoutItems(
            db,
            channel.number,
            windowStart,
            40,
          );

          const currentAny = nearby.find((row) => {
            const start = fromSqliteUtc(row.start).getTime();
            const finish = fromSqliteUtc(row.finish).getTime();
            return start <= now.getTime() && finish > now.getTime();
          });

          if (currentAny && (currentAny.fillerKind ?? 0) !== 0) {
            continue;
          }

          const current = getCurrentPrimaryItem(
            db,
            channel.number,
            toUtcSqlite(now),
          );

          if (!current) {
            if (missing && !this.jobs.hasPendingGenerate(channel.number)) {
              log.info("scheduler enqueue (missing promo, no current item)", {
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
          const itemStart = fromSqliteUtc(current.start);

          // Regen window opens this far before the current item ends.
          const regenAt = new Date(finish.getTime() - leadMs);

          // Promo must be ready by the time the current item ends — not by regenAt,
          // or every in-window enqueue would already be "late".
          const readyBy = finish;
          const remainingMs = finish.getTime() - now.getTime();
          const itemShort = remainingMs < leadMs;
          const inLeadWindow = regenAt.getTime() <= now.getTime();

          // One auto job per current airing (same next-items). Manual generate bypasses this.
          const lastGenAt = this.jobs.getLastGenerated(channel.number);
          const alreadyGeneratedForItem =
            Boolean(lastGenAt) &&
            new Date(lastGenAt!).getTime() >= itemStart.getTime() &&
            !missing;

          if (alreadyGeneratedForItem) {
            log.debug("scheduler skip (already generated for current item)", {
              channel: channel.name,
              number: channel.number,
              lastGenAt,
              itemStart: itemStart.toISOString(),
            });

            continue;
          }

          if (this.jobs.hasPendingGenerate(channel.number)) {
            log.debug("scheduler skip (generate already pending)", {
              channel: channel.name,
              number: channel.number,
            });

            continue;
          }

          if (missing || itemShort || inLeadWindow) {
            log.info("scheduler enqueue", {
              channel: channel.name,
              number: channel.number,
              missing,
              itemShort,
              inLeadWindow,
              readyBy: readyBy.toISOString(),
              finish: finish.toISOString(),
            });

            this.jobs.enqueue({
              channelNumber: channel.number,
              channelName: channel.name,
              deadline: readyBy,
              preferFront: missing || itemShort,
            });

            enqueued += 1;
          }
        }
      } finally {
        db.close();
      }
    } finally {
      log.debug("scheduler tick done", { ms: Date.now() - started, enqueued });
      this.running = false;
    }
  }
}
