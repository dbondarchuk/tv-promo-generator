import { DEFAULT_SETTINGS } from "@promo/shared";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEncoderPlan,
  escapeDrawtext,
  globalHwArgs,
  isHardwareEncodeFailure,
} from "./hwaccel.js";

test("None uses libx264", () => {
  const plan = buildEncoderPlan({
    ...DEFAULT_SETTINGS,
    hardwareAcceleration: "None",
  });

  assert.equal(plan.videoEncoder, "libx264");
});

test("Nvenc uses h264_nvenc without forced cuda decode", () => {
  const plan = buildEncoderPlan({
    ...DEFAULT_SETTINGS,
    hardwareAcceleration: "Nvenc",
  });

  assert.equal(plan.videoEncoder, "h264_nvenc");
  assert.deepEqual(plan.inputArgs, []);
});

test("Qsv uses software decode and init_hw_device", () => {
  const plan = buildEncoderPlan({
    ...DEFAULT_SETTINGS,
    hardwareAcceleration: "Qsv",
  });

  assert.equal(plan.videoEncoder, "h264_qsv");
  assert.deepEqual(plan.inputArgs, []);
  assert.ok(
    globalHwArgs({ ...DEFAULT_SETTINGS, hardwareAcceleration: "Qsv" })[0] ===
      "-init_hw_device",
  );
});

test("Vaapi adds hwupload suffix", () => {
  const plan = buildEncoderPlan({
    ...DEFAULT_SETTINGS,
    hardwareAcceleration: "Vaapi",
  });

  assert.equal(plan.videoEncoder, "h264_vaapi");
  assert.ok(plan.filterSuffix.includes("hwupload"));
});

test("isHardwareEncodeFailure detects MFX/QSV errors", () => {
  assert.equal(
    isHardwareEncodeFailure(
      "Error initializing an MFX session: -3.\nDevice creation failed",
    ),
    true,
  );

  assert.equal(
    isHardwareEncodeFailure("Error while filtering: Invalid argument"),
    false,
  );
});

test("escapeDrawtext escapes colon", () => {
  assert.equal(escapeDrawtext("A:B"), "A\\:B");
});

test("escapeDrawtext replaces apostrophe with typographic mark", () => {
  assert.equal(escapeDrawtext("Stan's Best Friend"), "Stan\u2019s Best Friend");
});
