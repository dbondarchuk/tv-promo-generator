import { AppSettings, JobLogLevel } from "@promo/shared";
import fs from "node:fs";
import { loadChannelOverrides } from "../config.js";
import {
  attachGraphicsToScheduleItems,
  deleteGraphicsElementByPath,
  detachGraphicsFromScheduleItems,
  getPlayoutForChannel,
  graphicsElementIdsForRelativePaths,
  listChannelNumbers,
  listManagedGraphicsElementPaths,
  openDb,
  resetSchemaCache,
  toRelativeGraphicsElementPath,
  upsertGraphicsElement,
} from "../ersatztv/db.js";
import { createLogger } from "../util/log.js";
import {
  channelGraphicsTemplatePath,
  enabledGraphicsSlots,
  writeGraphicsTemplates,
} from "./graphics-yml.js";

const log = createLogger("push-graphics");

export type GraphicsProgress = (message: string, level?: JobLogLevel) => void;

function isClassicSchedule(kind: number | string | null | undefined): boolean {
  if (kind == null) return true;
  if (typeof kind === "number") return kind === 0 || kind === 1;

  const lower = String(kind).toLowerCase();
  return (
    lower === "0" || lower === "1" || lower === "classic" || lower === "none"
  );
}

async function withWriteDb<T>(
  dbPath: string,
  progress: GraphicsProgress,
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
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "DB write failed"));
}

function listAllChannelNumbers(settings: AppSettings): string[] {
  const db = openDb(settings.etvDatabase, true);
  try {
    return listChannelNumbers(db).map((c) => c.number);
  } finally {
    db.close();
  }
}

/** Channels that should receive Now/Mid/Next overlays (default on). */
function resolveGraphicsTargetChannels(settings: AppSettings): string[] {
  const overrides = loadChannelOverrides();
  return listAllChannelNumbers(settings).filter(
    (number) => overrides[number]?.graphicsEnabled !== false,
  );
}

function managedGraphicsElementIds(db: ReturnType<typeof openDb>): number[] {
  return graphicsElementIdsForRelativePaths(
    db,
    listManagedGraphicsElementPaths(db).map(toRelativeGraphicsElementPath),
  );
}

function syncScheduleGraphics(
  db: ReturnType<typeof openDb>,
  channelNumber: string,
  enabledIds: number[],
):
  | { skipped: true; reason: string }
  | { skipped: false; items: number; links: number } {
  const playout = getPlayoutForChannel(db, channelNumber);
  if (!playout?.programScheduleId) {
    return { skipped: true, reason: "no classic schedule" };
  }

  if (!isClassicSchedule(playout.scheduleKind)) {
    return {
      skipped: true,
      reason: `schedule kind ${String(playout.scheduleKind)}`,
    };
  }

  detachGraphicsFromScheduleItems(
    db,
    playout.programScheduleId,
    managedGraphicsElementIds(db),
  );

  if (enabledIds.length === 0) {
    return { skipped: false, items: 0, links: 0 };
  }

  const { items, links } = attachGraphicsToScheduleItems(
    db,
    playout.programScheduleId,
    enabledIds,
  );

  return { skipped: false, items, links };
}

function requireGraphicsDeploySettings(settings: AppSettings): void {
  if (!settings.etvConfigPath?.trim()) {
    throw new Error("etvConfigPath is required to deploy graphics templates");
  }

  if (!fs.existsSync(settings.etvConfigPath)) {
    throw new Error(`etvConfigPath not found: ${settings.etvConfigPath}`);
  }

  if (!settings.etvDatabase?.trim()) {
    throw new Error("etvDatabase is required");
  }
}

/** Deploy per-channel Now/Mid/Next graphics and attach to classic schedules. */
export async function pushGraphicsToErsatzTv(
  settings: AppSettings,
  progress: GraphicsProgress = () => undefined,
): Promise<{ ok: boolean; message: string }> {
  requireGraphicsDeploySettings(settings);

  if (!settings.etvOnDemandBaseUrl?.trim()) {
    throw new Error(
      "etvOnDemandBaseUrl is required (ETV fetches overlay PNGs from this app)",
    );
  }

  resetSchemaCache();
  const allChannels = listAllChannelNumbers(settings);
  const targets = resolveGraphicsTargetChannels(settings);
  const slots = enabledGraphicsSlots(settings);
  const targetSet = new Set(targets);

  progress(
    `Writing per-channel graphics templates for ${targets.length}/${allChannels.length} channel(s)`,
  );

  const { written, removed } = writeGraphicsTemplates(settings, targets);
  progress(
    `Templates written: ${written.length}` +
      (removed.length ? `; removed: ${removed.length}` : ""),
  );

  progress(`Upserting GraphicsElement rows (${slots.length} slot(s) each)`);
  const channelElementIds = new Map<string, number[]>();

  await withWriteDb(settings.etvDatabase, progress, (db) => {
    const priorManaged = listManagedGraphicsElementPaths(db);
    const keepRelPaths = new Set<string>();

    for (const channelNumber of targets) {
      const ids: number[] = [];
      for (const slot of slots) {
        const rel = channelGraphicsTemplatePath(channelNumber, slot);
        keepRelPaths.add(rel);
        const upserted = upsertGraphicsElement(db, rel);
        ids.push(upserted.id);
        progress(
          `  #${channelNumber} ${slot}: ${upserted.created ? "created" : "updated"} id=${upserted.id} · ${upserted.path}`,
        );
      }

      channelElementIds.set(channelNumber, ids);
    }

    for (const stored of priorManaged) {
      const rel = toRelativeGraphicsElementPath(stored);
      if (keepRelPaths.has(rel)) continue;

      deleteGraphicsElementByPath(db, rel);
      progress(`Removed GraphicsElement ${rel}`);
    }
  });

  progress(`Syncing graphics on ${allChannels.length} channel schedule(s)`);
  let attachedSchedules = 0;
  let clearedSchedules = 0;
  let totalLinks = 0;

  for (const channelNumber of allChannels) {
    const enabledIds = targetSet.has(channelNumber)
      ? (channelElementIds.get(channelNumber) ?? [])
      : [];

    const applied = await withWriteDb(settings.etvDatabase, progress, (db) =>
      syncScheduleGraphics(db, channelNumber, enabledIds),
    );

    if (applied.skipped) {
      progress(`  #${channelNumber}: skip (${applied.reason})`);
      continue;
    }

    if (enabledIds.length === 0) {
      clearedSchedules += 1;
      progress(`  #${channelNumber}: cleared overlay links`);
      continue;
    }

    attachedSchedules += 1;
    totalLinks += applied.links;
    progress(
      `  #${channelNumber}: ${applied.links} link(s) on ${applied.items} schedule item(s) · ${enabledIds.length} element(s)`,
    );
  }

  const message = `Graphics deploy complete · ${written.length} template(s) · ${attachedSchedules} attached · ${clearedSchedules} cleared · ${totalLinks} link(s)`;

  progress(message);
  log.info(message);
  return { ok: true, message };
}

/** Remove all promo-gen graphics templates, DB rows, and schedule links. */
export async function cleanupGraphicsFromErsatzTv(
  settings: AppSettings,
  progress: GraphicsProgress = () => undefined,
): Promise<{ ok: boolean; message: string }> {
  requireGraphicsDeploySettings(settings);

  resetSchemaCache();
  const allChannels = listAllChannelNumbers(settings);

  progress("Removing all promo-gen graphics templates");
  const { removed } = writeGraphicsTemplates(settings, []);
  progress(`Templates removed: ${removed.length}`);

  progress("Detaching overlays and deleting GraphicsElement rows");
  let clearedSchedules = 0;
  let deletedElements = 0;

  await withWriteDb(settings.etvDatabase, progress, (db) => {
    const managedPaths = listManagedGraphicsElementPaths(db);
    const managedIds = managedGraphicsElementIds(db);

    for (const channelNumber of allChannels) {
      const playout = getPlayoutForChannel(db, channelNumber);
      if (!playout?.programScheduleId) continue;
      if (!isClassicSchedule(playout.scheduleKind)) continue;

      detachGraphicsFromScheduleItems(
        db,
        playout.programScheduleId,
        managedIds,
      );

      clearedSchedules += 1;
      progress(`  #${channelNumber}: cleared overlay links`);
    }

    const seenRel = new Set<string>();
    for (const stored of managedPaths) {
      const rel = toRelativeGraphicsElementPath(stored);
      if (seenRel.has(rel)) continue;

      seenRel.add(rel);
      deleteGraphicsElementByPath(db, rel);
      deletedElements += 1;
      progress(`Removed GraphicsElement ${rel}`);
    }
  });

  const message = `Graphics cleanup complete · ${removed.length} template(s) · ${deletedElements} element(s) · ${clearedSchedules} schedule(s)`;

  progress(message);
  log.info(message);
  return { ok: true, message };
}
