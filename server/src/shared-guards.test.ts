import {
  canonicalizeChannelLanguage,
  isPromoDeliveryMode,
  isVoPrewarmMode,
  parseResolution,
  VO_PREWARM_MODES,
} from "@promo/shared";
import assert from "node:assert/strict";
import test from "node:test";

test("isVoPrewarmMode accepts known modes only", () => {
  for (const mode of VO_PREWARM_MODES) {
    assert.equal(isVoPrewarmMode(mode), true);
  }

  assert.equal(isVoPrewarmMode("on-demand"), false);
  assert.equal(isVoPrewarmMode(""), false);
  assert.equal(isVoPrewarmMode(null), false);
});

test("isPromoDeliveryMode accepts file and remote-stream", () => {
  assert.equal(isPromoDeliveryMode("file"), true);
  assert.equal(isPromoDeliveryMode("remote-stream"), true);
  assert.equal(isPromoDeliveryMode("live"), false);
});

test("canonicalizeChannelLanguage maps eng to en", () => {
  assert.equal(canonicalizeChannelLanguage("eng"), "en");
  assert.equal(canonicalizeChannelLanguage("EN"), "en");
  assert.equal(canonicalizeChannelLanguage("ukr"), "uk");
  assert.equal(canonicalizeChannelLanguage("en-US"), "en");
  assert.equal(canonicalizeChannelLanguage(""), "en");
  assert.equal(canonicalizeChannelLanguage(undefined), "en");
});

test("parseResolution parses WxH with fallback", () => {
  assert.deepEqual(parseResolution("1280x720"), { width: 1280, height: 720 });
  assert.deepEqual(parseResolution("bad"), { width: 1920, height: 1080 });
});
