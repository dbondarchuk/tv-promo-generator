import { ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { resolveFfmpegBinaries } from "./binaries.js";

export interface FfmpegRunResult {
  code: number;
  stderr: string;
}

export function runFfmpeg(args: string[]): Promise<FfmpegRunResult> {
  const { ffmpeg } = resolveFfmpegBinaries();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-y", ...args], {
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
  });
}

/** Spawn ffmpeg with stdout piped (for live MPEG-TS). Caller owns the process. */
export function spawnFfmpegPiped(
  args: string[],
): ChildProcessByStdio<null, Readable, Readable> {
  const { ffmpeg } = resolveFfmpegBinaries();
  return spawn(ffmpeg, ["-hide_banner", "-y", ...args], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
}
