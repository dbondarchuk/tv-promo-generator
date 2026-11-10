import assert from "node:assert/strict";
import test from "node:test";
import {
  fromSqliteUtc,
  toUtcSqlite,
  toUtcSqliteMs,
  UTC_SQLITE_MS_LEN,
} from "./time.js";

test("fromSqliteUtc parses space-separated UTC with long fractional seconds", () => {
  const d = fromSqliteUtc("2026-11-03 01:42:35.2569369");
  assert.equal(d.toISOString(), "2026-11-03T01:42:35.256Z");
});

test("toUtcSqlite keeps milliseconds for lexical compares", () => {
  const d = new Date("2026-11-05T08:49:20.123Z");
  assert.equal(toUtcSqlite(d), "2026-11-05 08:49:20.123");
});

test("fractional Start is not greater than now in the same second", () => {
  const start = "2026-11-05 08:49:20.1000000";
  const nowTruncated = "2026-11-05 08:49:20";
  const nowWithMs = toUtcSqlite(new Date("2026-11-05T08:49:20.500Z"));
  assert.equal(start <= nowTruncated, false);
  assert.equal(start <= nowWithMs, true);
});

test("toUtcSqliteMs truncates long fractional Start to milliseconds", () => {
  assert.equal(
    toUtcSqliteMs("2026-11-10 20:23:23.3945855"),
    "2026-11-10 20:23:23.394",
  );

  assert.equal(
    toUtcSqliteMs("2026-11-10T20:23:23.394Z"),
    "2026-11-10 20:23:23.394",
  );

  assert.equal(toUtcSqliteMs("2026-11-10 20:23:23").length, UTC_SQLITE_MS_LEN);
});

test("truncated MediaItem_Start matches longer DB Start at ms precision", () => {
  const dbStart = "2026-11-10 20:23:23.3945855";
  const etvTemplateAt = "2026-11-10 20:23:23.394"; // format …fffZ → parse
  assert.equal(dbStart <= etvTemplateAt, false, "raw lexical compare fails");
  assert.equal(toUtcSqliteMs(dbStart) <= toUtcSqliteMs(etvTemplateAt), true);
});
