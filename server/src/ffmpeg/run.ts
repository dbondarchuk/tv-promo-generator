import { ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { resolveFfmpegBinaries } from "./binaries.js";
import { createFfmpegProgressReporter } from "./progress.js";

export interface FfmpegRunResult {
  code: number;
  stderr: string;
}

export interface FfmpegRunOptions {
  /** Throttled ffmpeg progress lines (fps / speed / time). */
  onProgress?: (message: string) => void;
  /** Min gap between progress logs (default 2s). */
  progressIntervalMs?: number;
}

export function runFfmpeg(
  args: string[],
  opts: FfmpegRunOptions = {},
): Promise<FfmpegRunResult> {
  const { ffmpeg } = resolveFfmpegBinaries();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-y", ...args], {
      windowsHide: true,
    });

    let stderr = "";
    const report = opts.onProgress
      ? createFfmpegProgressReporter(opts.onProgress, {
          intervalMs: opts.progressIntervalMs,
        })
      : undefined;

    child.stderr.on("data", (d: Buffer) => {
      stderr += String(d);
      report?.(d);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

/** Spawn ffmpeg writing to a file path in args; stderr piped for progress/errors. */
export function spawnFfmpegFile(
  args: string[],
  opts: { cwd?: string } = {},
): ChildProcessByStdio<null, null, Readable> {
  const { ffmpeg } = resolveFfmpegBinaries();
  return spawn(ffmpeg, ["-hide_banner", "-y", ...args], {
    windowsHide: true,
    cwd: opts.cwd,
    stdio: ["ignore", "ignore", "pipe"] as const,
  });
}
