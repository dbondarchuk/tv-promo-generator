import { DEFAULT_SETTINGS } from "@promo/shared";
import assert from "node:assert/strict";
import test from "node:test";
import {
  promoWindowFingerprint,
  promoWindowsFromPrimaries,
} from "./fingerprint.js";

test("promoWindowsFromPrimaries splits current and look-ahead", () => {
  const items = [1, 2, 3, 4, 5];
  assert.deepEqual(promoWindowsFromPrimaries(items, 3), {
    current: [1, 2, 3],
    lookAhead: [2, 3, 4],
  });
});

test("promoWindowsFromPrimaries clamps itemCount to at least 1", () => {
  assert.deepEqual(promoWindowsFromPrimaries([10, 20], 0), {
    current: [10],
    lookAhead: [20],
  });
});

test("promoWindowsFromPrimaries handles short lists", () => {
  assert.deepEqual(promoWindowsFromPrimaries([1], 3), {
    current: [1],
    lookAhead: [],
  });
});

test("promoWindowFingerprint is stable for same inputs", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    promoItemCount: 3 as const,
    voiceEnabled: true,
    showVoiceDetail: "show" as const,
    voiceProvider: "piper" as const,
    voicePauseMs: 450,
  };

  const items = [
    { mediaItemId: 11, start: "2026-01-01 00:00:00" },
    { mediaItemId: 12, start: "2026-01-01 00:30:00" },
  ];

  const a = promoWindowFingerprint(settings, items);
  const b = promoWindowFingerprint(settings, items);
  assert.equal(a, b);
  assert.equal(a.length, 24);
});

test("promoWindowFingerprint changes when spoken settings change", () => {
  const items = [{ mediaItemId: 1, start: "s" }];
  const base = promoWindowFingerprint(DEFAULT_SETTINGS, items);
  const changed = promoWindowFingerprint(
    { ...DEFAULT_SETTINGS, showVoiceDetail: "show" },
    items,
  );

  assert.notEqual(base, changed);
});

test("promoWindowFingerprint changes when window items change", () => {
  const a = promoWindowFingerprint(DEFAULT_SETTINGS, [
    { mediaItemId: 1, start: "a" },
  ]);

  const b = promoWindowFingerprint(DEFAULT_SETTINGS, [
    { mediaItemId: 2, start: "a" },
  ]);

  assert.notEqual(a, b);
});
