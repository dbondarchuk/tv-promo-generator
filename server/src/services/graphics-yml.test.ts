import { DEFAULT_SETTINGS } from "@promo/shared";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraphicsElementYaml,
  enabledGraphicsSlots,
  isPromoGenTemplatePath,
  slotEnabled,
} from "./graphics-yml.js";

const settings = {
  ...DEFAULT_SETTINGS,
  etvOnDemandBaseUrl: "http://promo:5174",
  graphicsNowEnabled: true,
  graphicsMidEnabled: true,
  graphicsNextEnabled: false,
  graphicsMidStartPercent: 50,
  graphicsMidDurationSeconds: 8,
  graphicsFadeSeconds: 1,
};

test("slotEnabled respects per-phase toggles", () => {
  assert.equal(slotEnabled("now", settings), true);
  assert.equal(slotEnabled("midNow", settings), true);
  assert.equal(slotEnabled("midNext", settings), true);
  assert.equal(slotEnabled("next", settings), false);
});

test("enabledGraphicsSlots omits disabled next", () => {
  assert.deepEqual(enabledGraphicsSlots(settings), [
    "now",
    "midNow",
    "midNext",
  ]);
});

test("isPromoGenTemplatePath matches channel templates", () => {
  assert.equal(isPromoGenTemplatePath("image/promo-gen-1-now.yml"), true);

  assert.equal(isPromoGenTemplatePath("image/other.yml"), false);
});

test("buildGraphicsElementYaml embeds mid percent timing", () => {
  const yaml = buildGraphicsElementYaml(settings, "midNow", "12");
  assert.match(yaml, /Promo Generator — Mid Now \(#12\)/);
  assert.match(yaml, /opacity_expression:/);
  assert.match(yaml, /content_total_seconds \* 0\.5/);
  assert.match(yaml, /overlay\.png\?phase=now&channelNumber=12&at=\{\{/);

  assert.doesNotMatch(yaml, /language=/);
});

test("buildGraphicsElementYaml next phase uses next image", () => {
  const yaml = buildGraphicsElementYaml(
    { ...settings, graphicsNextEnabled: true },
    "next",
    "3",
  );

  assert.match(yaml, /phase=next/);
  assert.match(yaml, /z_index: 21/);
});

test("buildGraphicsElementYaml requires on-demand base URL", () => {
  assert.throws(
    () =>
      buildGraphicsElementYaml(
        { ...settings, etvOnDemandBaseUrl: "" },
        "now",
        "1",
      ),
    /etvOnDemandBaseUrl/,
  );
});
