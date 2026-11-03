import test from 'node:test';
import assert from 'node:assert/strict';
import { fromSqliteUtc, toUtcSqlite } from './time.js';

test('fromSqliteUtc parses space-separated UTC with long fractional seconds', () => {
  const d = fromSqliteUtc('2026-11-03 01:42:35.2569369');
  assert.equal(d.toISOString(), '2026-11-03T01:42:35.256Z');
});

test('toUtcSqlite keeps milliseconds for lexical compares', () => {
  const d = new Date('2026-11-05T08:49:20.123Z');
  assert.equal(toUtcSqlite(d), '2026-11-05 08:49:20.123');
});

test('fractional Start is not greater than now in the same second', () => {
  const start = '2026-11-05 08:49:20.1000000';
  const nowTruncated = '2026-11-05 08:49:20';
  const nowWithMs = toUtcSqlite(new Date('2026-11-05T08:49:20.500Z'));
  assert.equal(start <= nowTruncated, false);
  assert.equal(start <= nowWithMs, true);
});
