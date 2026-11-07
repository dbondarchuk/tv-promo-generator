import assert from "node:assert/strict";
import test from "node:test";
import { formatFfmpegProgress, parseFfmpegProgressChunk } from "./progress.js";

test("parseFfmpegProgressChunk reads fps and speed", () => {
  const snap = parseFfmpegProgressChunk(
    "frame=  312 fps= 52 q=28.0 size=    2048kB time=00:00:10.40 bitrate=1612.3kbits/s speed=1.73x",
  );

  assert.ok(snap);
  assert.equal(snap!.frame, 312);
  assert.equal(snap!.fps, 52);
  assert.equal(snap!.time, "00:00:10.40");
  assert.equal(snap!.speed, 1.73);
  assert.match(formatFfmpegProgress(snap!), /1\.73x/);
  assert.match(formatFfmpegProgress(snap!), /52 fps/);
});

test("parseFfmpegProgressChunk uses last \\r-rewritten line", () => {
  const snap = parseFfmpegProgressChunk(
    "frame=1 fps=1.0 time=00:00:00.01 speed=0.50x\rframe=  900 fps= 30 q=-1.0 size=N/A time=00:00:30.00 bitrate=N/A speed=1.00x",
  );

  assert.ok(snap);
  assert.equal(snap!.time, "00:00:30.00");
  assert.equal(snap!.speed, 1);
});
