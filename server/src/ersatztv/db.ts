import {
  FILLER_PLACEMENT_LABELS,
  FILLER_PLACEMENTS,
  FillerPlacement,
} from "@promo/shared";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface DbSchema {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
}

export interface PlayoutRow {
  playoutId: number;
  channelId: number;
  channelNumber: string;
  channelName: string;
  mediaItemId: number;
  start: string;
  finish: string;
  fillerKind: number;
  filePath?: string;
  durationSeconds?: number;
  programScheduleId?: number;
  scheduleKind?: number | string;
}

export interface MediaFileRow {
  mediaItemId: number;
  path: string;
  durationSeconds?: number;
}

export interface MediaItemMetadata {
  kind: "episode" | "movie" | "other";
  /** Show name or movie title */
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

/** Strip trailing "(2014)" / "(1999)" style years from titles. */
export function stripTitleYear(title: string): string {
  return title
    .replace(/\s*[\(\[\{]\s*(?:19|20)\d{2}\s*[\)\]\}]\s*$/u, "")
    .trim();
}

let schemaCache: DbSchema | null = null;

export function openDb(
  dbPath: string,
  readonly: boolean,
  opts: { busyTimeoutMs?: number } = {},
): Database.Database {
  if (!dbPath) {
    throw new Error("ErsatzTV database path is not configured");
  }

  if (!fs.existsSync(dbPath)) {
    throw new Error(`ErsatzTV database not found: ${dbPath}`);
  }

  const busyTimeoutMs = opts.busyTimeoutMs ?? 8_000;
  const db = new Database(dbPath, {
    readonly,
    fileMustExist: true,
    timeout: busyTimeoutMs,
  });

  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  if (readonly) {
    try {
      db.pragma("query_only = ON");
    } catch {
      // older sqlite may not support query_only
    }
  }

  // Do not force journal_mode=WAL — that needs an exclusive lock and can hang
  // while ErsatzTV has the database open.
  return db;
}

/** Manual collection + typed filler names for a channel's next-items promo. */
export function promoNextNames(channelName: string): {
  collection: string;
  /**
   * Untyped filler name from the first push implementation
   * (`Promo Generator - Next - {channel}` — same string as the collection).
   */
  legacyFiller: string;
  filler: (placement: FillerPlacement) => string;
} {
  const collection = `Promo Generator - Next - ${channelName}`;
  const filler = (placement: FillerPlacement) =>
    `Promo Generator - Next - ${FILLER_PLACEMENT_LABELS[placement]} - ${channelName}`;

  return {
    collection,
    legacyFiller: collection,
    filler,
  };
}

/** Schedule-item columns that can hold a filler preset id. */
const SCHEDULE_FILLER_COLUMNS = [
  "PreRollFillerId",
  "MidRollFillerId",
  "PostRollFillerId",
  "TailFillerId",
  "FallbackFillerId",
] as const;

/** ErsatzTV FillerKind + ProgramScheduleItem column for each placement. */
export const FILLER_PLACEMENT_META: Record<
  FillerPlacement,
  { fillerKind: number; column: string }
> = {
  pre: { fillerKind: 1, column: "PreRollFillerId" },
  middle: { fillerKind: 2, column: "MidRollFillerId" },
  post: { fillerKind: 3, column: "PostRollFillerId" },
  tail: { fillerKind: 4, column: "TailFillerId" },
};

export function loadSchema(db: Database.Database): DbSchema {
  if (schemaCache) return schemaCache;

  const tables = new Set(
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );

  const columns = new Map<string, Set<string>>();
  for (const table of tables) {
    const cols = db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as Array<{ name: string }>;

    columns.set(table, new Set(cols.map((c) => c.name)));
  }

  schemaCache = { tables, columns };
  return schemaCache;
}

export function resetSchemaCache(): void {
  schemaCache = null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function requireTable(schema: DbSchema, name: string): void {
  if (!schema.tables.has(name)) {
    throw new Error(`Expected table ${name} missing from ersatztv.sqlite3`);
  }
}

function requireColumns(schema: DbSchema, table: string, cols: string[]): void {
  requireTable(schema, table);
  const have = schema.columns.get(table) ?? new Set();
  for (const col of cols) {
    if (!have.has(col)) {
      throw new Error(
        `Expected column ${table}.${col} missing from ersatztv.sqlite3`,
      );
    }
  }
}

function pickMediaFileTable(schema: DbSchema): string {
  if (schema.tables.has("MediaFile")) return "MediaFile";
  if (schema.tables.has("MediaFiles")) return "MediaFiles";

  throw new Error("MediaFile table not found");
}

function pickDurationExpression(
  schema: DbSchema,
  mediaVersionTable: string | null,
): string {
  if (
    mediaVersionTable &&
    schema.columns.get(mediaVersionTable)?.has("Duration")
  ) {
    // EF Core SQLite may store TimeSpan as "d.hh:mm:ss", "hh:mm:ss", or integer ticks.
    return `CASE
      WHEN typeof(mv.Duration) IN ('integer', 'real') THEN CAST(mv.Duration AS REAL) / 10000000.0
      WHEN mv.Duration LIKE '%.%:%:%'
        THEN (CAST(substr(mv.Duration, 1, instr(mv.Duration, '.') - 1) AS REAL) * 86400)
           + (CAST(substr(mv.Duration, instr(mv.Duration, '.') + 1, 2) AS REAL) * 3600)
           + (CAST(substr(mv.Duration, instr(mv.Duration, '.') + 4, 2) AS REAL) * 60)
           + CAST(substr(mv.Duration, instr(mv.Duration, '.') + 7, 2) AS REAL)
      WHEN mv.Duration LIKE '%:%:%'
        THEN (CAST(substr(mv.Duration, 1, instr(mv.Duration, ':') - 1) AS REAL) * 3600)
           + (CAST(substr(mv.Duration, instr(mv.Duration, ':') + 1, 2) AS REAL) * 60)
           + CAST(substr(mv.Duration, length(mv.Duration) - 1, 2) AS REAL)
      ELSE NULL
    END`;
  }

  return "NULL";
}

/** ErsatzTV stores FKs on MediaVersion as MovieId/EpisodeId/..., not MediaItemId. */
function mediaVersionOwnerColumns(schema: DbSchema): string[] {
  const cols = schema.columns.get("MediaVersion") ?? new Set();
  const known = [
    "MovieId",
    "EpisodeId",
    "MusicVideoId",
    "OtherVideoId",
    "SongId",
    "ImageId",
    "RemoteStreamId",
    "MediaItemId",
  ];

  return known.filter((c) => cols.has(c));
}

function mediaVersionJoinOnPlayoutItem(schema: DbSchema): string {
  const owners = mediaVersionOwnerColumns(schema);
  if (owners.length === 0) {
    throw new Error(
      "MediaVersion has no owner FK columns (MovieId/EpisodeId/...)",
    );
  }

  return owners.map((c) => `mv.${c} = pi.MediaItemId`).join(" OR ");
}

function mediaVersionMediaItemIdExpr(schema: DbSchema): string {
  const owners = mediaVersionOwnerColumns(schema);
  if (owners.length === 0) {
    throw new Error(
      "MediaVersion has no owner FK columns (MovieId/EpisodeId/...)",
    );
  }

  return `COALESCE(${owners.map((c) => `mv.${c}`).join(", ")})`;
}

export function getUpcomingPlayoutItems(
  db: Database.Database,
  channelNumber: string,
  afterUtcIso: string,
  limit = 20,
): PlayoutRow[] {
  const schema = loadSchema(db);
  requireColumns(schema, "PlayoutItem", [
    "Id",
    "MediaItemId",
    "Start",
    "Finish",
    "FillerKind",
    "PlayoutId",
  ]);

  requireColumns(schema, "Playout", ["Id", "ChannelId"]);
  requireColumns(schema, "Channel", ["Id", "Number", "Name"]);

  const mediaFileTable = pickMediaFileTable(schema);
  requireColumns(schema, mediaFileTable, ["Path", "MediaVersionId"]);
  requireTable(schema, "MediaVersion");
  requireColumns(schema, "MediaVersion", ["Id"]);

  const durationExpr = pickDurationExpression(schema, "MediaVersion");
  const versionJoin = mediaVersionJoinOnPlayoutItem(schema);
  const scheduleKindCol = schema.columns.get("Playout")?.has("ScheduleKind")
    ? "p.ScheduleKind"
    : schema.columns.get("Playout")?.has("PlayoutKind")
      ? "p.PlayoutKind"
      : "NULL";

  const programScheduleCol = schema.columns
    .get("Playout")
    ?.has("ProgramScheduleId")
    ? "p.ProgramScheduleId"
    : "NULL";

  const sql = `
    SELECT
      pi.PlayoutId AS playoutId,
      c.Id AS channelId,
      c.Number AS channelNumber,
      c.Name AS channelName,
      pi.MediaItemId AS mediaItemId,
      pi.Start AS start,
      pi.Finish AS finish,
      pi.FillerKind AS fillerKind,
      mf.Path AS filePath,
      ${durationExpr} AS durationSeconds,
      ${programScheduleCol} AS programScheduleId,
      ${scheduleKindCol} AS scheduleKind
    FROM PlayoutItem pi
    INNER JOIN Playout p ON p.Id = pi.PlayoutId
    INNER JOIN Channel c ON c.Id = p.ChannelId
    LEFT JOIN MediaVersion mv ON (${versionJoin})
    LEFT JOIN ${quoteIdent(mediaFileTable)} mf ON mf.MediaVersionId = mv.Id
    WHERE c.Number = ?
      AND pi.Start >= ?
    ORDER BY pi.Start ASC
    LIMIT ?
  `;

  return db.prepare(sql).all(channelNumber, afterUtcIso, limit) as PlayoutRow[];
}

export function getCurrentPrimaryItem(
  db: Database.Database,
  channelNumber: string,
  nowUtcIso: string,
): PlayoutRow | undefined {
  const schema = loadSchema(db);
  requireColumns(schema, "PlayoutItem", [
    "MediaItemId",
    "Start",
    "Finish",
    "FillerKind",
    "PlayoutId",
  ]);

  requireColumns(schema, "Playout", ["Id", "ChannelId"]);
  requireColumns(schema, "Channel", ["Id", "Number", "Name"]);
  const mediaFileTable = pickMediaFileTable(schema);
  requireTable(schema, "MediaVersion");
  const durationExpr = pickDurationExpression(schema, "MediaVersion");
  const versionJoin = mediaVersionJoinOnPlayoutItem(schema);

  const sql = `
    SELECT
      pi.PlayoutId AS playoutId,
      c.Id AS channelId,
      c.Number AS channelNumber,
      c.Name AS channelName,
      pi.MediaItemId AS mediaItemId,
      pi.Start AS start,
      pi.Finish AS finish,
      pi.FillerKind AS fillerKind,
      mf.Path AS filePath,
      ${durationExpr} AS durationSeconds,
      NULL AS programScheduleId,
      NULL AS scheduleKind
    FROM PlayoutItem pi
    INNER JOIN Playout p ON p.Id = pi.PlayoutId
    INNER JOIN Channel c ON c.Id = p.ChannelId
    LEFT JOIN MediaVersion mv ON (${versionJoin})
    LEFT JOIN ${quoteIdent(mediaFileTable)} mf ON mf.MediaVersionId = mv.Id
    WHERE c.Number = ?
      AND pi.Start <= ?
      AND pi.Finish > ?
      AND IFNULL(pi.FillerKind, 0) = 0
    ORDER BY pi.Start DESC
    LIMIT 1
  `;

  return db.prepare(sql).get(channelNumber, nowUtcIso, nowUtcIso) as
    PlayoutRow | undefined;
}

export function getPrimaryItemsAfter(
  db: Database.Database,
  channelNumber: string,
  afterUtcIso: string,
  limit = 3,
): PlayoutRow[] {
  return getUpcomingPlayoutItems(db, channelNumber, afterUtcIso, 50)
    .filter((r) => (r.fillerKind ?? 0) === 0)
    .slice(0, limit);
}

/** Resolve human titles from ErsatzTV metadata tables (preferred over XMLTV). */
export function getMediaItemMetadata(
  db: Database.Database,
  mediaItemId: number,
): MediaItemMetadata | undefined {
  const schema = loadSchema(db);

  if (schema.tables.has("Episode") && schema.tables.has("EpisodeMetadata")) {
    const epCols = schema.columns.get("EpisodeMetadata") ?? new Set();
    if (epCols.has("Title") && epCols.has("EpisodeId")) {
      const row = db
        .prepare(
          `
        SELECT
          em.Title AS episodeTitle,
          em.EpisodeNumber AS episodeNumber,
          s.SeasonNumber AS seasonNumber,
          sm.Title AS showTitle
        FROM Episode e
        INNER JOIN EpisodeMetadata em ON em.EpisodeId = e.Id
        LEFT JOIN Season s ON s.Id = e.SeasonId
        LEFT JOIN ShowMetadata sm ON sm.ShowId = s.ShowId
        WHERE e.Id = ?
        ORDER BY em.MetadataKind ASC, em.Id ASC
        LIMIT 1
      `,
        )
        .get(mediaItemId) as
        | {
            episodeTitle?: string;
            episodeNumber?: number;
            seasonNumber?: number;
            showTitle?: string;
          }
        | undefined;

      if (row && (row.showTitle || row.episodeTitle)) {
        return {
          kind: "episode",
          title: stripTitleYear(
            row.showTitle || row.episodeTitle || `Episode ${mediaItemId}`,
          ),
          episodeTitle: row.episodeTitle || undefined,
          seasonNumber: Number.isFinite(Number(row.seasonNumber))
            ? Number(row.seasonNumber)
            : undefined,
          episodeNumber: Number.isFinite(Number(row.episodeNumber))
            ? Number(row.episodeNumber)
            : undefined,
        };
      }
    }
  }

  if (schema.tables.has("Movie") && schema.tables.has("MovieMetadata")) {
    const movieCols = schema.columns.get("MovieMetadata") ?? new Set();
    if (movieCols.has("Title") && movieCols.has("MovieId")) {
      const row = db
        .prepare(
          `
        SELECT Title AS title
        FROM MovieMetadata
        WHERE MovieId = ?
        ORDER BY MetadataKind ASC, Id ASC
        LIMIT 1
      `,
        )
        .get(mediaItemId) as { title?: string } | undefined;

      if (row?.title) {
        return {
          kind: "movie",
          title: stripTitleYear(row.title),
        };
      }
    }
  }

  return undefined;
}

/** Best-effort SxxExx + title from a media file path. */
export function metadataFromFilePath(
  filePath?: string,
): MediaItemMetadata | undefined {
  if (!filePath) return undefined;

  const base = path.basename(filePath);
  const se = /[Ss](\d+)[Ee](\d+)/.exec(base);
  const showDir = path.basename(path.dirname(path.dirname(filePath))); // .../Show/Season X/file
  const seasonDir = path.basename(path.dirname(filePath));
  let title = stripTitleYear(showDir);
  if (!title || /^season\s+\d+/i.test(title)) {
    title = stripTitleYear(
      base
        .replace(/\.[^.]+$/, "")
        .replace(/\s*[-_.]?\s*[Ss]\d+[Ee]\d+.*$/, "")
        .trim(),
    );
  }

  const epName = /[Ss]\d+[Ee]\d+\s*[-_.]+\s*(.+?)\.[^.]+$/
    .exec(base)?.[1]
    ?.trim();

  if (!title && !epName && !se) return undefined;

  return {
    kind: se ? "episode" : "other",
    title: stripTitleYear(title || epName || base),
    episodeTitle: epName || undefined,
    seasonNumber: se
      ? Number(se[1])
      : /season\s+(\d+)/i.exec(seasonDir)?.[1]
        ? Number(/season\s+(\d+)/i.exec(seasonDir)![1])
        : undefined,
    episodeNumber: se ? Number(se[2]) : undefined,
  };
}

export function findMediaItemByPath(
  db: Database.Database,
  absolutePath: string,
): MediaFileRow | undefined {
  const schema = loadSchema(db);
  const mediaFileTable = pickMediaFileTable(schema);
  requireColumns(schema, mediaFileTable, ["Path", "MediaVersionId"]);
  requireColumns(schema, "MediaVersion", ["Id"]);
  const mediaItemExpr = mediaVersionMediaItemIdExpr(schema);
  const variants = [
    absolutePath,
    absolutePath.replace(/\\/g, "/"),
    absolutePath.replace(/\//g, "\\"),
  ];

  const placeholders = variants.map(() => "?").join(",");
  const sql = `
    SELECT ${mediaItemExpr} AS mediaItemId, mf.Path AS path
    FROM ${quoteIdent(mediaFileTable)} mf
    INNER JOIN MediaVersion mv ON mv.Id = mf.MediaVersionId
    WHERE mf.Path IN (${placeholders})
    LIMIT 1
  `;

  return db.prepare(sql).get(...variants) as MediaFileRow | undefined;
}

export function findMediaItemByFileName(
  db: Database.Database,
  fileName: string,
): MediaFileRow | undefined {
  const schema = loadSchema(db);
  const mediaFileTable = pickMediaFileTable(schema);
  requireColumns(schema, mediaFileTable, ["Path", "MediaVersionId"]);
  requireColumns(schema, "MediaVersion", ["Id"]);
  const mediaItemExpr = mediaVersionMediaItemIdExpr(schema);
  const sql = `
    SELECT ${mediaItemExpr} AS mediaItemId, mf.Path AS path
    FROM ${quoteIdent(mediaFileTable)} mf
    INNER JOIN MediaVersion mv ON mv.Id = mf.MediaVersionId
    WHERE mf.Path LIKE ?
    ORDER BY length(mf.Path) ASC
    LIMIT 1
  `;

  return db.prepare(sql).get(`%${fileName}`) as MediaFileRow | undefined;
}

export function listChannelNumbers(
  db: Database.Database,
): Array<{ id: number; number: string; name: string }> {
  const schema = loadSchema(db);
  requireColumns(schema, "Channel", ["Id", "Number", "Name"]);
  return db
    .prepare(`SELECT Id AS id, Number AS number, Name AS name FROM Channel`)
    .all() as Array<{
    id: number;
    number: string;
    name: string;
  }>;
}

export function getPlayoutForChannel(
  db: Database.Database,
  channelNumber: string,
):
  | {
      playoutId: number;
      channelId: number;
      programScheduleId: number | null;
      scheduleKind: number | string | null;
    }
  | undefined {
  const schema = loadSchema(db);
  requireColumns(schema, "Playout", ["Id", "ChannelId"]);
  requireColumns(schema, "Channel", ["Id", "Number"]);
  const scheduleKindCol = schema.columns.get("Playout")?.has("ScheduleKind")
    ? "p.ScheduleKind"
    : schema.columns.get("Playout")?.has("PlayoutKind")
      ? "p.PlayoutKind"
      : "NULL";

  const programScheduleCol = schema.columns
    .get("Playout")
    ?.has("ProgramScheduleId")
    ? "p.ProgramScheduleId"
    : "NULL";

  const sql = `
    SELECT
      p.Id AS playoutId,
      c.Id AS channelId,
      ${programScheduleCol} AS programScheduleId,
      ${scheduleKindCol} AS scheduleKind
    FROM Playout p
    INNER JOIN Channel c ON c.Id = p.ChannelId
    WHERE c.Number = ?
    LIMIT 1
  `;

  return db.prepare(sql).get(channelNumber) as
    | {
        playoutId: number;
        channelId: number;
        programScheduleId: number | null;
        scheduleKind: number | string | null;
      }
    | undefined;
}

export function scheduleSharedByOtherChannels(
  db: Database.Database,
  programScheduleId: number,
  channelId: number,
): string[] {
  const schema = loadSchema(db);
  if (!schema.columns.get("Playout")?.has("ProgramScheduleId")) return [];

  requireColumns(schema, "Channel", ["Id", "Number", "Name"]);
  const rows = db
    .prepare(
      `
      SELECT c.Number AS number, c.Name AS name
      FROM Playout p
      INNER JOIN Channel c ON c.Id = p.ChannelId
      WHERE p.ProgramScheduleId = ? AND c.Id != ?
    `,
    )
    .all(programScheduleId, channelId) as Array<{
    number: string;
    name: string;
  }>;

  return rows.map((r) => `${r.number} ${r.name}`);
}

export function listScheduleItemIds(
  db: Database.Database,
  programScheduleId: number,
): number[] {
  const schema = loadSchema(db);
  requireColumns(schema, "ProgramScheduleItem", ["Id", "ProgramScheduleId"]);
  const rows = db
    .prepare(
      `SELECT Id AS id FROM ProgramScheduleItem WHERE ProgramScheduleId = ?`,
    )
    .all(programScheduleId) as Array<{ id: number }>;

  return rows.map((r) => r.id);
}

export function getPreRollFillerName(
  db: Database.Database,
  fillerId: number | null | undefined,
): string | undefined {
  if (!fillerId) return undefined;

  const schema = loadSchema(db);
  requireColumns(schema, "FillerPreset", ["Id", "Name"]);
  const row = db
    .prepare(`SELECT Name AS name FROM FillerPreset WHERE Id = ?`)
    .get(fillerId) as { name: string } | undefined;

  return row?.name;
}

/**
 * Create/update a manual Collection that contains exactly one media item.
 * CollectionType.Collection = 0 in FillerPreset; items live in CollectionItem.
 */
export function upsertManualCollection(
  db: Database.Database,
  name: string,
  mediaItemId: number,
): { id: number; created: boolean } {
  const schema = loadSchema(db);
  requireTable(schema, "Collection");
  requireTable(schema, "CollectionItem");
  requireColumns(schema, "Collection", ["Id", "Name"]);
  requireColumns(schema, "CollectionItem", ["CollectionId", "MediaItemId"]);

  const cols = schema.columns.get("Collection") ?? new Set();
  let existing = db
    .prepare(`SELECT Id AS id FROM Collection WHERE Name = ?`)
    .get(name) as { id: number } | undefined;

  let created = false;

  if (!existing) {
    const insertCols = ["Name"];
    const insertVals: Array<string | number> = [name];
    if (cols.has("UseCustomPlaybackOrder")) {
      insertCols.push("UseCustomPlaybackOrder");
      insertVals.push(0);
    }

    const placeholders = insertCols.map(() => "?").join(", ");
    const info = db
      .prepare(
        `INSERT INTO Collection (${insertCols.join(", ")}) VALUES (${placeholders})`,
      )
      .run(...insertVals);

    existing = { id: Number(info.lastInsertRowid) };
    created = true;
  }

  // Replace membership so the collection always points at the current promo file.
  db.prepare(`DELETE FROM CollectionItem WHERE CollectionId = ?`).run(
    existing.id,
  );

  const itemCols = schema.columns.get("CollectionItem") ?? new Set();
  if (itemCols.has("CustomIndex")) {
    db.prepare(
      `INSERT INTO CollectionItem (CollectionId, MediaItemId, CustomIndex) VALUES (?, ?, 0)`,
    ).run(existing.id, mediaItemId);
  } else {
    db.prepare(
      `INSERT INTO CollectionItem (CollectionId, MediaItemId) VALUES (?, ?)`,
    ).run(existing.id, mediaItemId);
  }

  return { id: existing.id, created };
}

/**
 * Filler preset that plays count=1 from a manual Collection.
 * CollectionType.Collection = 0 (not OtherVideo/MediaItem).
 * FillerKind: PreRoll=1, MidRoll=2, PostRoll=3, Tail=4.
 */
export function upsertFillerPresetForCollection(
  db: Database.Database,
  name: string,
  collectionId: number,
  fillerKind: number,
): { id: number; created: boolean } {
  const schema = loadSchema(db);
  requireColumns(schema, "FillerPreset", [
    "Name",
    "FillerKind",
    "FillerMode",
    "Count",
    "CollectionType",
    "CollectionId",
    "AllowWatermarks",
  ]);

  const existing = db
    .prepare(`SELECT Id AS id FROM FillerPreset WHERE Name = ?`)
    .get(name) as { id: number } | undefined;

  const cols = schema.columns.get("FillerPreset") ?? new Set();
  // FillerMode Count = 2, CollectionType Collection = 0
  if (existing) {
    db.prepare(
      `
      UPDATE FillerPreset
      SET FillerKind = ?,
          FillerMode = 2,
          Count = 1,
          CollectionType = 0,
          CollectionId = ?,
          MediaItemId = NULL,
          AllowWatermarks = 0,
          MultiCollectionId = NULL,
          SmartCollectionId = NULL,
          PlaylistId = NULL
      WHERE Id = ?
    `,
    ).run(fillerKind, collectionId, existing.id);

    return { id: existing.id, created: false };
  }

  const insertCols = [
    "Name",
    "FillerKind",
    "FillerMode",
    "Count",
    "CollectionType",
    "CollectionId",
    "AllowWatermarks",
  ];

  const insertVals: Array<string | number> = [
    name,
    fillerKind,
    2,
    1,
    0,
    collectionId,
    0,
  ];

  if (cols.has("UseChaptersAsMediaItems")) {
    insertCols.push("UseChaptersAsMediaItems");
    insertVals.push(0);
  }

  const placeholders = insertCols.map(() => "?").join(", ");
  const info = db
    .prepare(
      `INSERT INTO FillerPreset (${insertCols.join(", ")}) VALUES (${placeholders})`,
    )
    .run(...insertVals);

  return { id: Number(info.lastInsertRowid), created: true };
}

function scheduleFillerColumnsPresent(itemCols: Set<string>): string[] {
  return SCHEDULE_FILLER_COLUMNS.filter((column) => itemCols.has(column));
}

/** Clear schedule slots that point at FillerPresets with the given names. */
function clearScheduleFillersByName(
  db: Database.Database,
  programScheduleId: number,
  columns: string[],
  fillerNames: string[],
): { cleared: number; columnsTouched: string[] } {
  if (fillerNames.length === 0 || columns.length === 0) {
    return { cleared: 0, columnsTouched: [] };
  }

  const namePlaceholders = fillerNames.map(() => "?").join(", ");
  let cleared = 0;
  const columnsTouched: string[] = [];

  for (const column of columns) {
    const result = db
      .prepare(
        `
        UPDATE ProgramScheduleItem
        SET ${column} = NULL
        WHERE ProgramScheduleId = ?
          AND ${column} IN (
            SELECT Id FROM FillerPreset WHERE Name IN (${namePlaceholders})
          )
      `,
      )
      .run(programScheduleId, ...fillerNames);

    if (result.changes > 0) {
      cleared += result.changes;
      columnsTouched.push(column);
    }
  }

  return { cleared, columnsTouched };
}

function fillerPresetReferencedAnywhere(
  db: Database.Database,
  fillerId: number,
  columns: string[],
): boolean {
  for (const column of columns) {
    const row = db
      .prepare(
        `
        SELECT 1 AS ok
        FROM ProgramScheduleItem
        WHERE ${column} = ?
        LIMIT 1
      `,
      )
      .get(fillerId) as { ok: number } | undefined;

    if (row) return true;
  }

  return false;
}

/** Delete a FillerPreset by name when no schedule item references it. */
function deleteOrphanFillerPreset(
  db: Database.Database,
  fillerName: string,
  columns: string[],
): boolean {
  const schema = loadSchema(db);
  if (!schema.tables.has("FillerPreset")) return false;

  requireColumns(schema, "FillerPreset", ["Id", "Name"]);

  const existing = db
    .prepare(`SELECT Id AS id FROM FillerPreset WHERE Name = ?`)
    .get(fillerName) as { id: number } | undefined;

  if (!existing) return false;
  if (fillerPresetReferencedAnywhere(db, existing.id, columns)) return false;

  db.prepare(`DELETE FROM FillerPreset WHERE Id = ?`).run(existing.id);
  return true;
}

export interface ApplyScheduleFillersOptions {
  selected: FillerPlacement[];
  presetIds: Partial<Record<FillerPlacement, number>>;
  cleanupLegacy: boolean;
  cleanupUnselected: boolean;
}

/**
 * Wire selected filler placements on schedule items; optionally clear legacy /
 * unselected typed promo fillers (and delete unused presets).
 */
export function applyScheduleItemFillers(
  db: Database.Database,
  programScheduleId: number,
  channelName: string,
  options: ApplyScheduleFillersOptions,
): { notes: string[]; itemCount: number } {
  const schema = loadSchema(db);
  requireColumns(schema, "ProgramScheduleItem", ["Id", "ProgramScheduleId"]);
  const itemCols = schema.columns.get("ProgramScheduleItem") ?? new Set();
  const fillerColumns = scheduleFillerColumnsPresent(itemCols);
  const names = promoNextNames(channelName);
  const selectedSet = new Set(options.selected);
  const notes: string[] = [];

  const itemCountRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ProgramScheduleItem WHERE ProgramScheduleId = ?`,
    )
    .get(programScheduleId) as { n: number };

  const itemCount = itemCountRow.n;

  if (options.cleanupLegacy) {
    // First push version used an untyped filler (same name as the collection).
    const legacyClear = clearScheduleFillersByName(
      db,
      programScheduleId,
      fillerColumns,
      [names.legacyFiller],
    );

    if (legacyClear.cleared > 0) {
      notes.push(
        `Legacy filler "${names.legacyFiller}": cleared ${legacyClear.cleared} slot(s)` +
          ` (${legacyClear.columnsTouched.join(", ")})`,
      );
    }
  }

  for (const placement of FILLER_PLACEMENTS) {
    const meta = FILLER_PLACEMENT_META[placement];
    if (!itemCols.has(meta.column)) {
      notes.push(
        `${FILLER_PLACEMENT_LABELS[placement]}: column ${meta.column} missing — skipped`,
      );

      continue;
    }

    if (selectedSet.has(placement)) {
      const presetId = options.presetIds[placement];
      if (presetId == null) {
        notes.push(
          `${FILLER_PLACEMENT_LABELS[placement]}: no preset id — skipped`,
        );

        continue;
      }

      const previous = db
        .prepare(
          `
          SELECT DISTINCT fp.Name AS name
          FROM ProgramScheduleItem psi
          LEFT JOIN FillerPreset fp ON fp.Id = psi.${meta.column}
          WHERE psi.ProgramScheduleId = ?
            AND psi.${meta.column} IS NOT NULL
            AND psi.${meta.column} != ?
        `,
        )
        .all(programScheduleId, presetId) as Array<{ name: string | null }>;

      const result = db
        .prepare(
          `UPDATE ProgramScheduleItem SET ${meta.column} = ? WHERE ProgramScheduleId = ?`,
        )
        .run(presetId, programScheduleId);

      const replaced = previous
        .map((p) => p.name)
        .filter((n): n is string => Boolean(n));

      notes.push(
        `${FILLER_PLACEMENT_LABELS[placement]}: set on ${result.changes} item(s)` +
          (replaced.length ? ` (was: ${replaced.join(", ")})` : ""),
      );

      continue;
    }

    if (!options.cleanupUnselected) continue;

    const typedName = names.filler(placement);
    const result = clearScheduleFillersByName(
      db,
      programScheduleId,
      [meta.column],
      [typedName],
    );

    if (result.cleared > 0) {
      notes.push(
        `${FILLER_PLACEMENT_LABELS[placement]}: cleared ${result.cleared} item(s) matching promo name`,
      );
    }

    if (deleteOrphanFillerPreset(db, typedName, fillerColumns)) {
      notes.push(
        `${FILLER_PLACEMENT_LABELS[placement]}: deleted unused preset "${typedName}"`,
      );
    }
  }

  if (
    options.cleanupLegacy &&
    deleteOrphanFillerPreset(db, names.legacyFiller, fillerColumns)
  ) {
    notes.push(`Legacy filler preset "${names.legacyFiller}" deleted (unused)`);
  }

  return { notes, itemCount };
}

/** LibraryMediaKind: OtherVideos = 4, RemoteStreams = 7 */
const MEDIA_KIND_OTHER_VIDEOS = 4;
const MEDIA_KIND_REMOTE_STREAMS = 7;

function ensureLibraryOfKind(
  db: Database.Database,
  libraryName: string,
  libraryPath: string,
  mediaKind: number,
): { libraryId: number } {
  const schema = loadSchema(db);
  requireTable(schema, "Library");
  requireColumns(schema, "Library", ["Id", "Name"]);

  const localSource = findLocalMediaSource(db, schema);
  let library = db
    .prepare(`SELECT Id AS id FROM Library WHERE Name = ?`)
    .get(libraryName) as { id: number } | undefined;

  if (!library) {
    if (!schema.tables.has("LocalLibrary")) {
      throw new Error(
        "LocalLibrary table not found; cannot create promo library",
      );
    }

    requireColumns(schema, "LocalLibrary", ["Id"]);
    const libCols = schema.columns.get("Library") ?? new Set();
    const insertCols = ["Name"];
    const insertVals: Array<string | number> = [libraryName];
    if (libCols.has("MediaSourceId")) {
      insertCols.push("MediaSourceId");
      insertVals.push(localSource);
    }

    if (libCols.has("MediaKind")) {
      insertCols.push("MediaKind");
      insertVals.push(mediaKind);
    }

    const placeholders = insertCols.map(() => "?").join(", ");
    const info = db
      .prepare(
        `INSERT INTO Library (${insertCols.join(", ")}) VALUES (${placeholders})`,
      )
      .run(...insertVals);

    const id = Number(info.lastInsertRowid);
    db.prepare(`INSERT INTO LocalLibrary (Id) VALUES (?)`).run(id);
    library = { id };
  }

  ensureLibraryPath(db, schema, library.id, libraryPath);
  return { libraryId: library.id };
}

export function ensurePromoLibrary(
  db: Database.Database,
  libraryName: string,
  libraryPath: string,
): { libraryId: number } {
  return ensureLibraryOfKind(
    db,
    libraryName,
    libraryPath,
    MEDIA_KIND_OTHER_VIDEOS,
  );
}

/** Remote Stream library (MediaKind = 7) for live promo `.yml` definitions. */
export function ensureRemoteStreamLibrary(
  db: Database.Database,
  libraryName: string,
  libraryPath: string,
): { libraryId: number } {
  return ensureLibraryOfKind(
    db,
    libraryName,
    libraryPath,
    MEDIA_KIND_REMOTE_STREAMS,
  );
}

/**
 * Clear LibraryFolder etags for a library so the next ForceScan re-parses
 * YAML even when file mtimes look unchanged (Docker bind mounts, etc.).
 * ETV's HTTP scan API cannot pass DeepScan=true; this is the equivalent.
 */
export function invalidateLibraryFolderEtags(
  db: Database.Database,
  libraryId: number,
): number {
  const schema = loadSchema(db);
  if (
    !schema.tables.has("LibraryFolder") ||
    !schema.tables.has("LibraryPath")
  ) {
    return 0;
  }

  requireColumns(schema, "LibraryPath", ["Id", "LibraryId"]);
  requireColumns(schema, "LibraryFolder", ["Etag", "LibraryPathId"]);

  const info = db
    .prepare(
      `UPDATE LibraryFolder
       SET Etag = ''
       WHERE LibraryPathId IN (
         SELECT Id FROM LibraryPath WHERE LibraryId = ?
       )`,
    )
    .run(libraryId);

  return info.changes;
}

/** .NET TimeSpan ticks (100ns) — common SQLite storage for Duration columns. */
function durationTicks(seconds: number): number {
  return Math.round(Math.max(0, seconds) * 10_000_000);
}

function durationHhMmSs(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function coerceDurationValue(
  seconds: number,
  sample: unknown,
): string | number {
  if (sample == null) return durationTicks(seconds);

  if (typeof sample === "string") {
    if (sample.includes(":")) return durationHhMmSs(seconds);

    const asNum = Number(sample);
    if (Number.isFinite(asNum) && Math.abs(asNum) > 1_000_000) {
      return String(durationTicks(seconds));
    }
  }

  return durationTicks(seconds);
}

/**
 * Point RemoteStream + MediaVersion Duration at the live promo length.
 * ETV prefers MediaVersion.Duration when non-zero, so both must match YAML.
 */
export function updateRemoteStreamDuration(
  db: Database.Database,
  mediaItemId: number,
  durationSeconds: number,
): { remoteStream: boolean; mediaVersion: boolean } {
  const schema = loadSchema(db);
  let remoteStream = false;
  let mediaVersion = false;

  if (
    schema.tables.has("RemoteStream") &&
    schema.columns.get("RemoteStream")?.has("Duration")
  ) {
    const sample = db
      .prepare(`SELECT Duration AS d FROM RemoteStream WHERE Id = ?`)
      .get(mediaItemId) as { d: unknown } | undefined;

    if (sample) {
      const value = coerceDurationValue(durationSeconds, sample.d);
      db.prepare(`UPDATE RemoteStream SET Duration = ? WHERE Id = ?`).run(
        value,
        mediaItemId,
      );

      remoteStream = true;
    }
  }

  if (
    schema.tables.has("MediaVersion") &&
    schema.columns.get("MediaVersion")?.has("Duration") &&
    schema.columns.get("MediaVersion")?.has("RemoteStreamId")
  ) {
    const sample = db
      .prepare(
        `SELECT Duration AS d FROM MediaVersion WHERE RemoteStreamId = ? LIMIT 1`,
      )
      .get(mediaItemId) as { d: unknown } | undefined;

    if (sample) {
      const value = coerceDurationValue(durationSeconds, sample.d);
      db.prepare(
        `UPDATE MediaVersion SET Duration = ? WHERE RemoteStreamId = ?`,
      ).run(value, mediaItemId);

      mediaVersion = true;
    }
  }

  return { remoteStream, mediaVersion };
}

function findLocalMediaSource(db: Database.Database, schema: DbSchema): number {
  if (schema.tables.has("LocalMediaSource")) {
    const row = db
      .prepare(`SELECT Id AS id FROM LocalMediaSource LIMIT 1`)
      .get() as { id: number } | undefined;

    if (row) return row.id;
  }

  if (schema.tables.has("MediaSource")) {
    // Prefer a local source if Kind/type column exists
    const cols = schema.columns.get("MediaSource") ?? new Set();
    if (cols.has("Id")) {
      const row = db
        .prepare(`SELECT Id AS id FROM MediaSource ORDER BY Id ASC LIMIT 1`)
        .get() as { id: number } | undefined;

      if (row) return row.id;
    }
  }

  throw new Error("No local media source found in ErsatzTV database");
}

function ensureLibraryPath(
  db: Database.Database,
  schema: DbSchema,
  libraryId: number,
  libraryPath: string,
): void {
  if (!schema.tables.has("LibraryPath")) {
    throw new Error("LibraryPath table not found");
  }

  requireColumns(schema, "LibraryPath", ["Id", "Path", "LibraryId"]);
  const existing = db
    .prepare(
      `SELECT Id AS id, Path AS path FROM LibraryPath WHERE LibraryId = ?`,
    )
    .all(libraryId) as Array<{ id: number; path: string }>;

  const normalized = libraryPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const match = existing.find(
    (p) => p.path.replace(/\\/g, "/").replace(/\/+$/, "") === normalized,
  );

  if (match) return;

  if (existing.length === 1) {
    db.prepare(`UPDATE LibraryPath SET Path = ? WHERE Id = ?`).run(
      libraryPath,
      existing[0].id,
    );

    return;
  }

  if (existing.length === 0) {
    db.prepare(`INSERT INTO LibraryPath (LibraryId, Path) VALUES (?, ?)`).run(
      libraryId,
      libraryPath,
    );

    return;
  }

  // Multiple paths: add ours if missing
  db.prepare(`INSERT INTO LibraryPath (LibraryId, Path) VALUES (?, ?)`).run(
    libraryId,
    libraryPath,
  );
}

export function resolveDatabasePath(
  configured: string,
  etvConfigHint?: string,
): string {
  if (configured && fs.existsSync(configured)) return configured;

  const candidates = [
    configured,
    etvConfigHint ? path.join(etvConfigHint, "ersatztv.sqlite3") : "",
    "/config/ersatztv.sqlite3",
    "/root/.local/share/ersatztv/ersatztv.sqlite3",
  ].filter(Boolean);

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  return configured;
}
