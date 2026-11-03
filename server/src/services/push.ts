import {
  AppSettings,
  FILLER_PLACEMENT_LABELS,
  FillerPlacement,
  isPushOptionsActionable,
  JobLogLevel,
  PushChannelResult,
  PushOptions,
  PushResult,
  sanitizeChannelFolderName,
} from "@promo/shared";
import path from "node:path";
import { EtvApiClient } from "../ersatztv/api.js";
import {
  applyScheduleItemFillers,
  ensurePromoLibrary,
  FILLER_PLACEMENT_META,
  findMediaItemByFileName,
  findMediaItemByPath,
  getPlayoutForChannel,
  openDb,
  promoNextNames,
  resetSchemaCache,
  scheduleSharedByOtherChannels,
  upsertFillerPresetForCollection,
  upsertManualCollection,
} from "../ersatztv/db.js";
import { createLogger } from "../util/log.js";
import { fileExists, promoOutputFile } from "../util/paths.js";
import { loadChannelViews } from "./channels.js";
import { backupErsatzTvDatabase } from "./etv-backup.js";

const log = createLogger("push");

export type PushProgress = (message: string, level?: JobLogLevel) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isClassicSchedule(kind: number | string | null | undefined): boolean {
  // PlayoutScheduleKind: None=0, Classic=1, Block=2, Sequential=3, Scripted=4, ExternalJson=20
  if (kind == null) return true; // older schemas without kind often mean classic
  if (typeof kind === "number") return kind === 0 || kind === 1;

  const lower = String(kind).toLowerCase();
  return (
    lower === "0" || lower === "1" || lower === "classic" || lower === "none"
  );
}

async function withWriteDb<T>(
  dbPath: string,
  progress: PushProgress,
  fn: (db: ReturnType<typeof openDb>) => T,
): Promise<T> {
  const attempts = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      progress(`Opening DB for write (attempt ${attempt}/${attempts})`);
      const db = openDb(dbPath, false, { busyTimeoutMs: 10_000 });
      try {
        return fn(db);
      } finally {
        db.close();
      }
    } catch (err) {
      lastErr = err;
      const message = err instanceof Error ? err.message : String(err);
      progress(`DB write open/query failed: ${message}`, "warn");
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }

  throw new Error(
    `Could not write ErsatzTV database after ${attempts} attempts` +
      ` (is ErsatzTV locking it?): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

export async function pushToErsatzTv(
  settings: AppSettings,
  options: PushOptions,
  onProgress: PushProgress = () => undefined,
): Promise<PushResult> {
  const progress = (message: string, level: JobLogLevel = "info") => {
    onProgress(message, level);
    if (level === "error") log.error(message);
    else if (level === "warn") log.warn(message);
    else log.info(message);
  };

  if (!isPushOptionsActionable(options)) {
    throw new Error(
      "Select at least one filler type, or enable a cleanup option",
    );
  }

  const fillerTypes = options.fillerTypes;
  const wireFillers = fillerTypes.length > 0;

  resetSchemaCache();
  progress(
    wireFillers
      ? `Filler slots: ${fillerTypes.map((t) => FILLER_PLACEMENT_LABELS[t]).join(", ")}`
      : "Filler slots: (none — cleanup only)",
  );

  progress(
    `Cleanup: legacy=${options.cleanupLegacy ? "yes" : "no"},` +
      ` unselected=${options.cleanupUnselected ? "yes" : "no"}`,
  );

  progress("Loading enabled channels");
  const channels = (await loadChannelViews(settings)).filter((c) => c.enabled);
  progress(`Enabled channels: ${channels.length}`);
  const results: PushChannelResult[] = [];
  const etvLibraryPath = settings.etvLibraryPath || settings.outputPath;
  const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);

  progress("Backing up ersatztv.sqlite3");
  const backup = await backupErsatzTvDatabase(settings, "pre-push");
  progress(`Backup ready: ${backup.id} (${backup.bytes} bytes)`);

  let libraryId: number | undefined;
  if (wireFillers) {
    progress(`Ensuring Promo Generator library at ${etvLibraryPath}`);
    try {
      libraryId = await withWriteDb(
        settings.etvDatabase,
        progress,
        (db) =>
          ensurePromoLibrary(db, "Promo Generator", etvLibraryPath).libraryId,
      );

      progress(`Library id ${libraryId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress(message, "error");
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

    try {
      progress(`Scanning library ${libraryId}`);
      await api.scanLibrary(libraryId);
    } catch (err) {
      const message = `Library scan failed: ${err instanceof Error ? err.message : String(err)}`;
      progress(message, "error");
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
  }

  for (const channel of channels) {
    progress(`Channel ${channel.number} (${channel.name})`);
    const names = promoNextNames(channel.name);

    let mediaItemId: number | undefined;
    if (wireFillers) {
      const localPath = promoOutputFile(settings.outputPath, channel.name);
      if (!fileExists(localPath)) {
        const message = "Promo file missing; generate it first";
        progress(`  ${message}`, "warn");
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
        });

        continue;
      }

      const etvFilePath = path.posix.join(
        etvLibraryPath.replace(/\\/g, "/").replace(/\/+$/, ""),
        sanitizeChannelFolderName(channel.name),
        "next-items.mp4",
      );

      progress(`  Waiting for scan: ${etvFilePath}`);
      for (let attempt = 0; attempt < 30; attempt++) {
        const rw = openDb(settings.etvDatabase, true);
        try {
          const byPath =
            findMediaItemByPath(rw, etvFilePath) ??
            findMediaItemByFileName(
              rw,
              `${sanitizeChannelFolderName(channel.name)}/next-items.mp4`,
            );

          if (byPath) {
            mediaItemId = byPath.mediaItemId;
            break;
          }
        } finally {
          rw.close();
        }

        if (attempt === 0 || (attempt + 1) % 5 === 0) {
          progress(
            `  Still waiting for media item (attempt ${attempt + 1}/30)`,
          );
        }

        await sleep(2000);
      }

      if (!mediaItemId) {
        const message = `Timed out waiting for scan of ${etvFilePath}`;
        progress(`  ${message}`, "error");
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
        });

        continue;
      }

      progress(`  Media item ${mediaItemId}`);
    }

    try {
      const applied = await withWriteDb(
        settings.etvDatabase,
        progress,
        (writeDb) => {
          const playout = getPlayoutForChannel(writeDb, channel.number);
          if (!playout) {
            return {
              ok: false as const,
              message: "No playout found for channel",
            };
          }

          if (!isClassicSchedule(playout.scheduleKind)) {
            return {
              ok: false as const,
              message: `Skipped: playout kind ${String(playout.scheduleKind)} is not classic`,
            };
          }

          if (!playout.programScheduleId) {
            return {
              ok: false as const,
              message: "Skipped: no ProgramScheduleId on playout",
            };
          }

          const shared = scheduleSharedByOtherChannels(
            writeDb,
            playout.programScheduleId,
            playout.channelId,
          );

          if (shared.length > 0) {
            return {
              ok: false as const,
              message: `Skipped: schedule shared with ${shared.join(", ")}`,
            };
          }

          const presetIds: Partial<Record<FillerPlacement, number>> = {};
          if (wireFillers && mediaItemId != null) {
            const collection = upsertManualCollection(
              writeDb,
              names.collection,
              mediaItemId,
            );

            progress(
              `  Collection "${names.collection}" id ${collection.id}` +
                `${collection.created ? " (created)" : " (updated)"}`,
            );

            for (const placement of fillerTypes) {
              const meta = FILLER_PLACEMENT_META[placement];
              const fillerName = names.filler(placement);
              const preset = upsertFillerPresetForCollection(
                writeDb,
                fillerName,
                collection.id,
                meta.fillerKind,
              );

              presetIds[placement] = preset.id;
              progress(
                `  Filler "${fillerName}" (${FILLER_PLACEMENT_LABELS[placement]}) id ${preset.id}` +
                  `${preset.created ? " (created)" : " (updated)"}`,
              );
            }
          }

          const schedule = applyScheduleItemFillers(
            writeDb,
            playout.programScheduleId,
            channel.name,
            {
              selected: fillerTypes,
              presetIds,
              cleanupLegacy: options.cleanupLegacy,
              cleanupUnselected: options.cleanupUnselected,
            },
          );

          for (const note of schedule.notes) {
            progress(`  ${note}`);
          }

          return {
            ok: true as const,
            itemCount: schedule.itemCount,
            scheduleNotes: schedule.notes.join("; ") || undefined,
          };
        },
      );

      if (!applied.ok) {
        progress(`  ${applied.message}`, "warn");
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message: applied.message,
        });

        continue;
      }

      try {
        progress("  Resetting playout");
        await api.resetPlayout(channel.number);
      } catch (err) {
        const message = `Schedule updated, but playout reset failed: ${err instanceof Error ? err.message : String(err)}`;
        progress(`  ${message}`, "error");
        results.push({
          channelNumber: channel.number,
          channelName: channel.name,
          ok: false,
          message,
          scheduleNotes: applied.scheduleNotes,
        });

        continue;
      }

      const parts: string[] = [];
      if (wireFillers) {
        parts.push(
          `wired ${fillerTypes.map((t) => FILLER_PLACEMENT_LABELS[t]).join("+")} (${applied.itemCount} item(s))`,
        );
      }

      if (options.cleanupLegacy) parts.push("legacy cleanup");
      if (options.cleanupUnselected) parts.push("unselected cleanup");
      const message = `${parts.join(" · ") || "no-op"}; playout reset`;
      progress(`  OK — ${message}`);
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: true,
        message,
        scheduleNotes: applied.scheduleNotes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress(`  ${message}`, "error");
      results.push({
        channelNumber: channel.number,
        channelName: channel.name,
        ok: false,
        message,
      });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  progress(`Push finished: ${okCount}/${results.length} channel(s) succeeded`);
  return { results, backup };
}
