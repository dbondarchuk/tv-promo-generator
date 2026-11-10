import assert from "node:assert/strict";
import test from "node:test";
import { parseOverlayAt } from "./graphics-overlay.js";

test("parseOverlayAt converts ISO Z to sqlite naive UTC", () => {
  assert.equal(
    parseOverlayAt("2026-11-10T16:31:53.538Z"),
    "2026-11-10 16:31:53.538",
  );
});

test("parseOverlayAt keeps sqlite-shaped MediaItem_Start", () => {
  assert.equal(
    parseOverlayAt("2026-11-10 16:31:53.5385855"),
    "2026-11-10 16:31:53.5385855",
  );
});

test("parseOverlayAt accepts unix seconds", () => {
  assert.equal(parseOverlayAt("1731256313"), "2024-11-10 16:31:53.000");
});
