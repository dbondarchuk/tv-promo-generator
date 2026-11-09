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

function resolveTargetChannels(settings: AppSettings): string[] {
  const overrides = loadChannelOverrides();
  let targets = Object.entries(overrides)
    .filter(([, o]) => o.enabled !== false)
    .map(([number]) => number);

  if (targets.length === 0) {
    const db = openDb(settings.etvDatabase, true);
    try {
      targets = listChannelNumbers(db).map((c) => c.number);
    } finally {
      db.close();
    }
  }

  return targets;
}

/** Deploy per-channel Now/Mid/Next graphics and attach to classic schedules. */
export async function pushGraphicsToErsatzTv(
  settings: AppSettings,
  progress: GraphicsProgress = () => undefined,
): Promise<{ ok: boolean; message: string }> {
  if (!settings.etvConfigPath?.trim()) {
    throw new Error("etvConfigPath is required to deploy graphics templates");
  }

  if (!fs.existsSync(settings.etvConfigPath)) {
    throw new Error(`etvConfigPath not found: ${settings.etvConfigPath}`);
  }

  if (!settings.etvOnDemandBaseUrl?.trim()) {
    throw new Error(
      "etvOnDemandBaseUrl is required (ETV fetches overlay PNGs from this app)",
    );
  }

  if (!settings.etvDatabase?.trim()) {
    throw new Error("etvDatabase is required");
  }

  resetSchemaCache();
  const targets = resolveTargetChannels(settings);
  const slots = enabledGraphicsSlots(settings);

  progress(
    `Writing per-channel graphics templates for ${targets.length} channel(s)`,
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

    // Drop GraphicsElement rows for stale/shared templates we no longer keep.
    for (const stored of priorManaged) {
      const rel = toRelativeGraphicsElementPath(stored);
      if (keepRelPaths.has(rel)) continue;

      deleteGraphicsElementByPath(db, rel);
      progress(`Removed GraphicsElement ${rel}`);
    }
  });

  progress(`Attaching graphics to ${targets.length} channel schedule(s)`);
  let attachedSchedules = 0;
  let totalLinks = 0;

  for (const channelNumber of targets) {
    const enabledIds = channelElementIds.get(channelNumber) ?? [];
    const applied = await withWriteDb(settings.etvDatabase, progress, (db) => {
      const playout = getPlayoutForChannel(db, channelNumber);
      if (!playout?.programScheduleId) {
        return { skipped: true as const, reason: "no classic schedule" };
      }

      if (!isClassicSchedule(playout.scheduleKind)) {
        return {
          skipped: true as const,
          reason: `schedule kind ${String(playout.scheduleKind)}`,
        };
      }

      // Detach any promo-gen links (including other channels' leftovers).
      const managedIds = graphicsElementIdsForRelativePaths(
        db,
        listManagedGraphicsElementPaths(db).map(toRelativeGraphicsElementPath),
      );

      detachGraphicsFromScheduleItems(
        db,
        playout.programScheduleId,
        managedIds,
      );

      if (enabledIds.length === 0) {
        return { skipped: false as const, items: 0, links: 0 };
      }

      const { items, links } = attachGraphicsToScheduleItems(
        db,
        playout.programScheduleId,
        enabledIds,
      );

      return { skipped: false as const, items, links };
    });

    if (applied.skipped) {
      progress(`  #${channelNumber}: skip (${applied.reason})`);
      continue;
    }

    attachedSchedules += 1;
    totalLinks += applied.links;
    progress(
      `  #${channelNumber}: ${applied.links} link(s) on ${applied.items} schedule item(s) · ${enabledIds.length} element(s)`,
    );
  }

  const message = `Graphics deploy complete · ${written.length} template(s) · ${attachedSchedules} schedule(s) · ${totalLinks} link(s)`;
  progress(message);
  log.info(message);
  return { ok: true, message };
}
