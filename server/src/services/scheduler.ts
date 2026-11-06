import { AppSettings } from "@promo/shared";
import { loadChannelOverrides } from "../config.js";
import {
  getCurrentPrimaryItem,
  listChannelNumbers,
  openDb,
} from "../ersatztv/db.js";
import { toUtcSqlite } from "../ersatztv/time.js";
import { createLogger } from "../util/log.js";
import { JobQueue } from "./jobs.js";

const log = createLogger("scheduler");

/**
 * On each new current primary, enqueue VO prewarm for that channel
 * (current next-N window + look-ahead). Does not bake MP4 for air —
 * live MPEG-TS handles playback.
 */
export class RegenScheduler {
  private timer?: NodeJS.Timeout;
  private settingsProvider: () => AppSettings;
  private jobs: JobQueue;
  private running = false;
  /** Last seen current primary key per channel (`mediaItemId@start`). */
  private lastCurrentKey = new Map<string, string>();

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
      if (!settings.voiceEnabled) {
        log.debug("scheduler skip (voice disabled)");
        return;
      }

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
        const overrides = loadChannelOverrides();
        const channels = listChannelNumbers(db);
        log.debug("scheduler scanning channels", { count: channels.length });

        for (const channel of channels) {
          if (overrides[channel.number]?.enabled === false) continue;

          const current = getCurrentPrimaryItem(
            db,
            channel.number,
            toUtcSqlite(now),
          );

          if (!current) continue;

          const currentKey = `${current.mediaItemId}@${current.start}`;
          const prev = this.lastCurrentKey.get(channel.number);
          if (prev === currentKey) {
            continue;
          }

          this.lastCurrentKey.set(channel.number, currentKey);

          if (this.jobs.hasPendingVoPrewarm(channel.number)) {
            log.debug("scheduler skip VO (already pending)", {
              channel: channel.name,
              number: channel.number,
            });

            continue;
          }

          log.info("scheduler enqueue VO prewarm (new current item)", {
            channel: channel.name,
            number: channel.number,
            currentKey,
          });

          this.jobs.enqueueVoPrewarm({
            channelNumber: channel.number,
            channelName: channel.name,
          });

          enqueued += 1;
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
