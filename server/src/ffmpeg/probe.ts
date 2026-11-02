import { spawn } from 'node:child_process';
import { resolveFfmpegBinaries } from './binaries.js';

function runFfprobe(args: string[]): Promise<string> {
  const { ffprobe } = resolveFfmpegBinaries();
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err || `ffprobe exited ${code}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

export async function probeDurationSeconds(filePath: string): Promise<number> {
  const out = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const n = Number(out);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid duration for ${filePath}: ${out}`);
  }
  return n;
}

export async function probeHasAudio(filePath: string): Promise<boolean> {
  try {
    const out = await runFfprobe([
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      filePath,
    ]);
    return out.length > 0;
  } catch {
    return false;
  }
}

export function pickRandomWindows(duration: number, count: number, windowSeconds: number): number[] {
  if (duration <= windowSeconds + 1) {
    return Array.from({ length: count }, () => 0);
  }
  const margin = Math.max(0, duration * 0.05);
  const usableStart = margin;
  const usableEnd = Math.max(usableStart + windowSeconds, duration - margin);
  const usable = Math.max(0, usableEnd - usableStart - windowSeconds);
  if (usable <= 0) {
    return Array.from({ length: count }, () => usableStart);
  }

  const starts: number[] = [];
  const attempts = count * 20;
  for (let i = 0; i < attempts && starts.length < count; i++) {
    const candidate = usableStart + Math.random() * usable;
    const overlaps = starts.some((s) => Math.abs(s - candidate) < windowSeconds);
    if (!overlaps) starts.push(candidate);
  }
  while (starts.length < count) {
    starts.push(usableStart + Math.random() * usable);
  }
  return starts.sort((a, b) => a - b);
}
