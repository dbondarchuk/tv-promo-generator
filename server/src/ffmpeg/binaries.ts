import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
  source: 'env' | 'tools' | 'path';
}

const exe = process.platform === 'win32' ? '.exe' : '';

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/src/ffmpeg -> repo root (dev) or server/dist/ffmpeg -> repo root (built)
  return path.resolve(here, '../../..');
}

function toolsBin(name: 'ffmpeg' | 'ffprobe'): string {
  return path.join(projectRoot(), 'tools', 'ffmpeg', `${name}${exe}`);
}

function isRunnable(bin: string): boolean {
  if (!bin) return false;
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return fs.existsSync(bin);
  }
  const probe = spawnSync(bin, ['-version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5000,
  });
  return probe.status === 0;
}

let cached: FfmpegBinaries | null = null;

/** Resolve ffmpeg/ffprobe: env → tools/ffmpeg → PATH. */
export function resolveFfmpegBinaries(): FfmpegBinaries {
  if (cached) return cached;

  const envFfmpeg = process.env.FFMPEG_PATH?.trim();
  const envFfprobe = process.env.FFPROBE_PATH?.trim();
  if (envFfmpeg && envFfprobe && isRunnable(envFfmpeg) && isRunnable(envFfprobe)) {
    cached = { ffmpeg: envFfmpeg, ffprobe: envFfprobe, source: 'env' };
    return cached;
  }

  const toolsFfmpeg = toolsBin('ffmpeg');
  const toolsFfprobe = toolsBin('ffprobe');
  if (isRunnable(toolsFfmpeg) && isRunnable(toolsFfprobe)) {
    cached = { ffmpeg: toolsFfmpeg, ffprobe: toolsFfprobe, source: 'tools' };
    return cached;
  }

  if (isRunnable(`ffmpeg${exe}`) && isRunnable(`ffprobe${exe}`)) {
    cached = { ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}`, source: 'path' };
    return cached;
  }

  // Fall back to bare names so spawn errors stay clear if missing.
  cached = { ffmpeg: envFfmpeg || `ffmpeg${exe}`, ffprobe: envFfprobe || `ffprobe${exe}`, source: 'path' };
  return cached;
}

export function assertFfmpegAvailable(): FfmpegBinaries {
  const bins = resolveFfmpegBinaries();
  const ffmpegOk = isRunnable(bins.ffmpeg);
  const ffprobeOk = isRunnable(bins.ffprobe);
  if (ffmpegOk && ffprobeOk) return bins;

  const toolsDir = path.join(projectRoot(), 'tools', 'ffmpeg');
  throw new Error(
    `ffmpeg/ffprobe not found (ffmpeg=${bins.ffmpeg}, ffprobe=${bins.ffprobe}). ` +
      `Install system ffmpeg, set FFMPEG_PATH/FFPROBE_PATH, or run: npm run setup:ffmpeg ` +
      `(installs into ${toolsDir})`,
  );
}

export function resetFfmpegBinaryCache(): void {
  cached = null;
}
