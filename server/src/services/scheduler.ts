import { AppSettings, ChannelOverrides, VoPrewarmMode } from "@promo/shared";
import { loadChannelOverrides } from "../config.js";
import { EtvApiClient } from "../ersatztv/api.js";
import {
  getCurrentPrimaryItem,
  listChannelNumbers,
  openDb,
} from "../ersatztv/db.js";
import { activeSessionChannelNumbers } from "../ersatztv/sessions.js";
import { toUtcSqlite } from "../ersatztv/time.js";
import { createLogger } from "../util/log.js";
import { JobQueue } from "./jobs.js";
import {
  isNewlyActiveSession,
  isVoSessionEligible,
  shouldEnqueueVoPrewarm,
} from "./vo-prewarm-policy.js";

const log = createLogger("scheduler");

export interface SchedulerDb {
  close(): void;
}

export interface RegenSchedulerDeps {
  openDb: (databasePath: string, readonly?: boolean) => SchedulerDb;
  listChannelNumbers: (
    db: SchedulerDb,
  ) => Array<{ number: string; name: string }>;
  getCurrentPrimaryItem: (
    db: SchedulerDb,
    channelNumber: string,
    nowUtcIso: string,
  ) => { mediaItemId: number; start: string } | null | undefined;
  loadChannelOverrides: () => ChannelOverrides;
  fetchActiveSessions: (settings: AppSettings) => Promise<Set<string>>;
}

async function defaultFetchActiveSessions(
  settings: AppSettings,
): Promise<Set<string>> {
  try {
    const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);
    const numbers = activeSessionChannelNumbers(await api.getSessions());
    log.debug("scheduler etv sessions", { count: numbers.size });
    return numbers;
  } catch (err) {
    log.warn(
      "scheduler could not fetch ETV sessions — skipping VO enqueue this tick",
      err instanceof Error ? err.message : String(err),
    );

    return new Set();
  }
}

const defaultDeps: RegenSchedulerDeps = {
  openDb: openDb as unknown as RegenSchedulerDeps["openDb"],
  listChannelNumbers:
    listChannelNumbers as unknown as RegenSchedulerDeps["listChannelNumbers"],
  getCurrentPrimaryItem:
    getCurrentPrimaryItem as unknown as RegenSchedulerDeps["getCurrentPrimaryItem"],
  loadChannelOverrides,
  fetchActiveSessions: defaultFetchActiveSessions,
};

/**
 * On each new current primary:
 * - file mode → enqueue generate (bake MP4)
 * - remote-stream → enqueue VO prewarm (live encode on play), gated by voPrewarmMode
 */
export class RegenScheduler {
  private timer?: NodeJS.Timeout;
  private settingsProvider: () => AppSettings;
  private jobs: JobQueue;
  private deps: RegenSchedulerDeps;
  private running = false;
  /** Last seen current primary key per channel (`mediaItemId@start`). */
  private lastCurrentKey = new Map<string, string>();
  /** Channels with an active ETV session on the previous tick. */
  private lastSessionActive = new Set<string>();
  /** Last time an active session was observed per channel. */
  private lastSessionSeenAt = new Map<string, number>();

  constructor(
    settingsProvider: () => AppSettings,
    jobs: JobQueue,
    deps: Partial<RegenSchedulerDeps> = {},
  ) {
    this.settingsProvider = settingsProvider;
    this.jobs = jobs;
    this.deps = { ...defaultDeps, ...deps };
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

      const fileMode = settings.promoDeliveryMode === "file";
      const voMode: VoPrewarmMode = settings.voPrewarmMode ?? "sessions";
      if (!fileMode && !settings.voiceEnabled) {
        log.debug("scheduler skip (voice disabled, remote-stream mode)");
        return;
      }

      let activeSessions = new Set<string>();
      if (!fileMode && settings.voiceEnabled && voMode === "sessions") {
        activeSessions = await this.deps.fetchActiveSessions(settings);
        const nowMs = Date.now();
        for (const number of activeSessions) {
          this.lastSessionSeenAt.set(number, nowMs);
        }
      }

      let db: SchedulerDb;
      try {
        db = this.deps.openDb(settings.etvDatabase, true);
      } catch (err) {
        log.warn(
          "scheduler could not open db",
          err instanceof Error ? err.message : String(err),
        );

        return;
      }

      try {
        const now = new Date();
        const overrides = this.deps.loadChannelOverrides();
        const channels = this.deps.listChannelNumbers(db);
        log.debug("scheduler scanning channels", {
          count: channels.length,
          mode: fileMode ? "file" : "remote-stream",
          voMode: fileMode ? undefined : voMode,
          activeSessions: activeSessions.size || undefined,
        });

        for (const channel of channels) {
          if (overrides[channel.number]?.enabled === false) continue;

          const current = this.deps.getCurrentPrimaryItem(
            db,
            channel.number,
            toUtcSqlite(now),
          );

          if (!current) continue;

          const currentKey = `${current.mediaItemId}@${current.start}`;
          const prev = this.lastCurrentKey.get(channel.number);
          const primaryChanged = prev !== currentKey;
          if (primaryChanged) {
            this.lastCurrentKey.set(channel.number, currentKey);
          }

          if (fileMode) {
            if (!primaryChanged) continue;

            if (this.jobs.hasPendingGenerate(channel.number)) {
              log.debug("scheduler skip generate (already pending)", {
                channel: channel.name,
                number: channel.number,
              });

              continue;
            }

            log.info("scheduler enqueue generate (new current item)", {
              channel: channel.name,
              number: channel.number,
              currentKey,
            });

            this.jobs.enqueue({
              channelNumber: channel.number,
              channelName: channel.name,
            });

            enqueued += 1;
            continue;
          }

          const sessionEligible = isVoSessionEligible({
            mode: voMode,
            channelNumber: channel.number,
            activeSessions,
            lastSessionSeenAt: this.lastSessionSeenAt,
            nowMs: Date.now(),
          });

          const newlyActive =
            voMode === "sessions" &&
            isNewlyActiveSession(
              channel.number,
              activeSessions,
              this.lastSessionActive,
            );

          if (
            !shouldEnqueueVoPrewarm({
              mode: voMode,
              sessionEligible,
              primaryChanged,
              newlyActive,
            })
          ) {
            continue;
          }

          if (this.jobs.hasPendingVoPrewarm(channel.number)) {
            log.debug("scheduler skip VO (already pending)", {
              channel: channel.name,
              number: channel.number,
            });

            continue;
          }

          log.info(
            newlyActive && !primaryChanged
              ? "scheduler enqueue VO prewarm (session became active)"
              : "scheduler enqueue VO prewarm (new current item)",
            {
              channel: channel.name,
              number: channel.number,
              currentKey,
            },
          );

          this.jobs.enqueueVoPrewarm({
            channelNumber: channel.number,
            channelName: channel.name,
          });

          enqueued += 1;
        }

        this.lastSessionActive =
          voMode === "sessions" ? activeSessions : new Set();
      } finally {
        db.close();
      }
    } finally {
      log.debug("scheduler tick done", { ms: Date.now() - started, enqueued });
      this.running = false;
    }
  }
}
