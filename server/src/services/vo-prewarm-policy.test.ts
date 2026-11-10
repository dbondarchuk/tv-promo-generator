import assert from "node:assert/strict";
import test from "node:test";
import {
  applyStreamingFlags,
  isNewlyActiveSession,
  isVoSessionEligible,
  lookAheadDeltaItems,
  SESSION_GRACE_MS,
  shouldEnqueueVoPrewarm,
} from "./vo-prewarm-policy.js";

test("isVoSessionEligible: off never eligible", () => {
  assert.equal(
    isVoSessionEligible({
      mode: "off",
      channelNumber: "1",
      activeSessions: new Set(["1"]),
      lastSessionSeenAt: new Map(),
      nowMs: 1_000,
    }),
    false,
  );
});

test("isVoSessionEligible: schedule always eligible", () => {
  assert.equal(
    isVoSessionEligible({
      mode: "schedule",
      channelNumber: "1",
      activeSessions: new Set(),
      lastSessionSeenAt: new Map(),
      nowMs: 1_000,
    }),
    true,
  );
});

test("isVoSessionEligible: sessions requires active or grace", () => {
  const nowMs = 10_000;
  assert.equal(
    isVoSessionEligible({
      mode: "sessions",
      channelNumber: "1",
      activeSessions: new Set(["1"]),
      lastSessionSeenAt: new Map(),
      nowMs,
    }),
    true,
  );

  assert.equal(
    isVoSessionEligible({
      mode: "sessions",
      channelNumber: "2",
      activeSessions: new Set(),
      lastSessionSeenAt: new Map([["2", nowMs - 1_000]]),
      nowMs,
    }),
    true,
  );

  assert.equal(
    isVoSessionEligible({
      mode: "sessions",
      channelNumber: "3",
      activeSessions: new Set(),
      lastSessionSeenAt: new Map([["3", nowMs - SESSION_GRACE_MS - 1]]),
      nowMs,
    }),
    false,
  );

  assert.equal(
    isVoSessionEligible({
      mode: "sessions",
      channelNumber: "4",
      activeSessions: new Set(),
      lastSessionSeenAt: new Map(),
      nowMs,
    }),
    false,
  );
});

test("shouldEnqueueVoPrewarm gates by mode and triggers", () => {
  assert.equal(
    shouldEnqueueVoPrewarm({
      mode: "off",
      sessionEligible: true,
      primaryChanged: true,
      newlyActive: true,
    }),
    false,
  );

  assert.equal(
    shouldEnqueueVoPrewarm({
      mode: "sessions",
      sessionEligible: false,
      primaryChanged: true,
      newlyActive: false,
    }),
    false,
  );

  assert.equal(
    shouldEnqueueVoPrewarm({
      mode: "sessions",
      sessionEligible: true,
      primaryChanged: false,
      newlyActive: false,
    }),
    false,
  );

  assert.equal(
    shouldEnqueueVoPrewarm({
      mode: "sessions",
      sessionEligible: true,
      primaryChanged: true,
      newlyActive: false,
    }),
    true,
  );

  assert.equal(
    shouldEnqueueVoPrewarm({
      mode: "sessions",
      sessionEligible: true,
      primaryChanged: false,
      newlyActive: true,
    }),
    true,
  );

  assert.equal(
    shouldEnqueueVoPrewarm({
      mode: "schedule",
      sessionEligible: true,
      primaryChanged: true,
      newlyActive: false,
    }),
    true,
  );
});

test("isNewlyActiveSession detects first appearance", () => {
  assert.equal(isNewlyActiveSession("1", new Set(["1"]), new Set()), true);

  assert.equal(
    isNewlyActiveSession("1", new Set(["1"]), new Set(["1"])),
    false,
  );

  assert.equal(isNewlyActiveSession("1", new Set(), new Set()), false);
});

test("lookAheadDeltaItems drops overlapping current window items", () => {
  const current = [
    { mediaItemId: 1, start: "a" },
    { mediaItemId: 2, start: "b" },
    { mediaItemId: 3, start: "c" },
  ];

  const lookAhead = [
    { mediaItemId: 2, start: "b" },
    { mediaItemId: 3, start: "c" },
    { mediaItemId: 4, start: "d" },
  ];

  assert.deepEqual(lookAheadDeltaItems(current, lookAhead), [
    { mediaItemId: 4, start: "d" },
  ]);
});

test("lookAheadDeltaItems empty when look-ahead fully overlapped", () => {
  const current = [
    { mediaItemId: 1, start: "a" },
    { mediaItemId: 2, start: "b" },
  ];

  const lookAhead = [{ mediaItemId: 2, start: "b" }];

  assert.deepEqual(lookAheadDeltaItems(current, lookAhead), []);
});

test("applyStreamingFlags marks active channels", () => {
  const flagged = applyStreamingFlags(
    [
      { number: "1", name: "A" },
      { number: "2", name: "B" },
    ],
    new Set(["2"]),
  );

  assert.deepEqual(flagged, [
    { number: "1", name: "A", streaming: false },
    { number: "2", name: "B", streaming: true },
  ]);
});
