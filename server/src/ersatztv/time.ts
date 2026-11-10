/**
 * ErsatzTV stores PlayoutItem.Start/Finish as naive UTC text, often with
 * fractional seconds (e.g. "2026-11-03 01:42:35.2569369"). Queries compare
 * those strings lexicographically, so "now" params must keep sub-second precision.
 *
 * ETV graphics templates often emit MediaItem_Start truncated to milliseconds
 * (`…fffZ`). Lexical `Start <= at` then fails when DB Start has extra digits
 * (`…3945855` > `…394`). Normalize both sides to millisecond precision.
 */

/** `yyyy-MM-dd HH:mm:ss.fff` length — use with substr for lexical compares. */
export const UTC_SQLITE_MS_LEN = 23;

/** Format a Date for SQLite string compares against PlayoutItem.Start/Finish. */
export function toUtcSqlite(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/Z$/, "");
}

/**
 * Normalize naive/ISO UTC text to `yyyy-MM-dd HH:mm:ss.fff` so truncated
 * MediaItem_Start values still match longer PlayoutItem.Start strings.
 */
export function toUtcSqliteMs(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(
    trimmed,
  );

  if (!match) return trimmed.replace("T", " ").replace(/Z$/, "");

  const frac = (match[3] ?? "0").padEnd(3, "0").slice(0, 3);
  return `${match[1]} ${match[2]}.${frac}`;
}

/** SQLite expression: truncate a PlayoutItem timestamp column to milliseconds. */
export function sqlUtcSqliteMs(columnSql: string): string {
  return `substr(${columnSql} || '.000', 1, ${UTC_SQLITE_MS_LEN})`;
}

/** Parse ErsatzTV UTC datetime text into a Date. */
export function fromSqliteUtc(value: string): Date {
  const trimmed = value.trim();
  if (!trimmed) return new Date(NaN);

  let normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  // JS Date only reliably accepts millisecond precision.
  normalized = normalized.replace(/(\.\d{3})\d+/, "$1");
  const hasZone = /Z|[+-]\d{2}:?\d{2}$/.test(normalized);
  return new Date(hasZone ? normalized : `${normalized}Z`);
}
