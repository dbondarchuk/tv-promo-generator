/**
 * ErsatzTV stores PlayoutItem.Start/Finish as naive UTC text, often with
 * fractional seconds (e.g. "2026-11-03 01:42:35.2569369"). Queries compare
 * those strings lexicographically, so "now" params must keep sub-second precision.
 */

/** Format a Date for SQLite string compares against PlayoutItem.Start/Finish. */
export function toUtcSqlite(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/Z$/, '');
}

/** Parse ErsatzTV UTC datetime text into a Date. */
export function fromSqliteUtc(value: string): Date {
  const trimmed = value.trim();
  if (!trimmed) return new Date(NaN);

  let normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  // JS Date only reliably accepts millisecond precision.
  normalized = normalized.replace(/(\.\d{3})\d+/, '$1');
  const hasZone = /Z|[+-]\d{2}:?\d{2}$/.test(normalized);
  return new Date(hasZone ? normalized : `${normalized}Z`);
}
