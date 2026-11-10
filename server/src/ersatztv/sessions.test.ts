import assert from "node:assert/strict";
import test from "node:test";
import { activeSessionChannelNumbers, parseEtvSessions } from "./sessions.js";

test("parseEtvSessions returns empty for non-arrays", () => {
  assert.deepEqual(parseEtvSessions(null), []);
  assert.deepEqual(parseEtvSessions({}), []);
  assert.deepEqual(parseEtvSessions("x"), []);
});

test("parseEtvSessions accepts camelCase ETV payloads", () => {
  const sessions = parseEtvSessions([
    {
      channelNumber: "42",
      state: "SeekAndRealtime",
      transcodedUntil: "2026-11-10T20:00:00Z",
      lastAccess: "2026-11-10T19:59:00Z",
      startedAt: "2026-11-10T19:00:00Z",
    },
  ]);

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    channelNumber: "42",
    state: "SeekAndRealtime",
    transcodedUntil: "2026-11-10T20:00:00Z",
    lastAccess: "2026-11-10T19:59:00Z",
    startedAt: "2026-11-10T19:00:00Z",
  });
});

test("parseEtvSessions accepts PascalCase ETV payloads", () => {
  const sessions = parseEtvSessions([
    {
      ChannelNumber: "7.1",
      State: "ZeroAndWorkAhead",
      TranscodedUntil: null,
      LastAccess: "2026-11-10T19:59:00Z",
      StartedAt: "2026-11-10T19:00:00Z",
    },
  ]);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.channelNumber, "7.1");
  assert.equal(sessions[0]?.state, "ZeroAndWorkAhead");
  assert.equal(sessions[0]?.transcodedUntil, null);
});

test("parseEtvSessions skips entries without channel numbers", () => {
  const sessions = parseEtvSessions([
    { channelNumber: "1" },
    { ChannelNumber: "  " },
    null,
    { name: "nope" },
    "bad",
  ]);

  assert.deepEqual(
    sessions.map((s) => s.channelNumber),
    ["1"],
  );
});

test("activeSessionChannelNumbers dedupes channel numbers", () => {
  const numbers = activeSessionChannelNumbers(
    parseEtvSessions([
      { channelNumber: "1" },
      { ChannelNumber: "2" },
      { channelNumber: "1" },
    ]),
  );

  assert.equal(numbers.size, 2);
  assert.equal(numbers.has("1"), true);
  assert.equal(numbers.has("2"), true);
});
