import { AppSettings, JobLogLevel } from "@promo/shared";
import fs from "node:fs";
import { loadChannelOverrides } from "../config.js";
import {
  attachGraphicsToScheduleItems,
  deleteGraphicsElementByPath,
  detachGraphicsFromScheduleItems,
  getPlayoutForChannel,
  LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS,
  listChannelNumbers,
  openDb,
  PROMO_GRAPHICS_TEMPLATE_PATHS,
  resetSchemaCache,
  upsertGraphicsElement,
} from "../ersatztv/db.js";
import { createLogger } from "../util/log.js";
import { writeGraphicsTemplates } from "./graphics-yml.js";

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

const SLOT_NAMES: Record<keyof typeof PROMO_GRAPHICS_TEMPLATE_PATHS, string> = {
  now: "Promo Generator — Now",
  midNow: "Promo Generator — Mid Now",
  midNext: "Promo Generator — Mid Next",
  next: "Promo Generator — Next",
};

function slotEnabled(
  slot: keyof typeof PROMO_GRAPHICS_TEMPLATE_PATHS,
  settings: AppSettings,
): boolean {
  if (slot === "now") return settings.graphicsNowEnabled;
  if (slot === "next") return settings.graphicsNextEnabled;

  return settings.graphicsMidEnabled;
}

function graphicsElementIdsByPaths(
  db: ReturnType<typeof openDb>,
  paths: string[],
): number[] {
  const ids: number[] = [];
  for (const rel of paths) {
    const row = db
      .prepare(`SELECT Id AS id FROM GraphicsElement WHERE Path = ?`)
      .get(rel) as { id: number } | undefined;

    if (row) ids.push(row.id);
  }

  return ids;
}

/** Deploy Now/Mid/Next graphics templates and attach to classic schedules. */
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
  progress("Writing graphics element YAML templates");
  const { written, removed } = writeGraphicsTemplates(settings);
  progress(
    `Templates written: ${written.length ? written.join(", ") : "(none)"}` +
      (removed.length ? `; removed: ${removed.join(", ")}` : ""),
  );

  const enabledSlots = (
    Object.keys(PROMO_GRAPHICS_TEMPLATE_PATHS) as Array<
      keyof typeof PROMO_GRAPHICS_TEMPLATE_PATHS
    >
  ).filter((slot) => slotEnabled(slot, settings));

  const disabledPaths = [
    ...(
      Object.keys(PROMO_GRAPHICS_TEMPLATE_PATHS) as Array<
        keyof typeof PROMO_GRAPHICS_TEMPLATE_PATHS
      >
    )
      .filter((slot) => !enabledSlots.includes(slot))
      .map((slot) => PROMO_GRAPHICS_TEMPLATE_PATHS[slot]),
    ...LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS,
  ];

  const enabledIds = await withWriteDb(settings.etvDatabase, progress, (db) => {
    // Capture prior managed ids (including disabled/legacy) so we can detach.
    const managedPaths = [
      ...Object.values(PROMO_GRAPHICS_TEMPLATE_PATHS),
      ...LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS,
    ];

    const priorIds = graphicsElementIdsByPaths(db, managedPaths);

    const ids: number[] = [];
    for (const slot of enabledSlots) {
      const rel = PROMO_GRAPHICS_TEMPLATE_PATHS[slot];
      const upserted = upsertGraphicsElement(db, rel, SLOT_NAMES[slot]);
      ids.push(upserted.id);
      progress(
        `${upserted.created ? "Created" : "Updated"} GraphicsElement ${rel} (id=${upserted.id})`,
      );
    }

    // Stash prior+enabled ids on the db handle via return payload.
    (db as unknown as { __priorIds?: number[] }).__priorIds = [
      ...new Set([...priorIds, ...ids]),
    ];

    return ids;
  });

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

  progress(`Attaching graphics to ${targets.length} channel schedule(s)`);
  let attachedSchedules = 0;
  let totalLinks = 0;

  for (const channelNumber of targets) {
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

      const managedIds = graphicsElementIdsByPaths(db, [
        ...Object.values(PROMO_GRAPHICS_TEMPLATE_PATHS),
        ...LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS,
      ]);

      detachGraphicsFromScheduleItems(
        db,
        playout.programScheduleId,
        managedIds,
      );

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
      `  #${channelNumber}: ${applied.links} link(s) on ${applied.items} schedule item(s)`,
    );
  }

  if (disabledPaths.length > 0) {
    await withWriteDb(settings.etvDatabase, progress, (db) => {
      for (const rel of disabledPaths) {
        deleteGraphicsElementByPath(db, rel);
        progress(`Removed GraphicsElement ${rel}`);
      }
    });
  }

  const message = `Graphics deploy complete · ${written.length} template(s) · ${attachedSchedules} schedule(s) · ${totalLinks} link(s)`;
  progress(message);
  log.info(message);
  return { ok: true, message };
}
