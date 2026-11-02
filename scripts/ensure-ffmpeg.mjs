#!/usr/bin/env node
/**
 * Ensures ffmpeg + ffprobe are available for local/dev use.
 * Resolution order (same as the server): FFMPEG_PATH/FFPROBE_PATH → tools/ffmpeg → PATH.
 * Downloads a static build into tools/ffmpeg only when nothing usable is found
 * (or when FORCE_FFMPEG_DOWNLOAD=1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const toolsDir = path.join(root, 'tools', 'ffmpeg');
const exe = process.platform === 'win32' ? '.exe' : '';
const force = process.env.FORCE_FFMPEG_DOWNLOAD === '1';

function runnable(bin) {
  if (!bin) return false;
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    if (!fs.existsSync(bin)) return false;
  }
  const r = spawnSync(bin, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
  return r.status === 0;
}

function versionLine(bin) {
  const r = spawnSync(bin, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 8000 });
  return (r.stdout || '').split(/\r?\n/)[0] || 'unknown';
}

function alreadyAvailable() {
  const envF = process.env.FFMPEG_PATH?.trim();
  const envP = process.env.FFPROBE_PATH?.trim();
  if (envF && envP && runnable(envF) && runnable(envP)) {
    return { ffmpeg: envF, ffprobe: envP, source: 'env' };
  }
  const toolsF = path.join(toolsDir, `ffmpeg${exe}`);
  const toolsP = path.join(toolsDir, `ffprobe${exe}`);
  if (runnable(toolsF) && runnable(toolsP)) {
    return { ffmpeg: toolsF, ffprobe: toolsP, source: 'tools' };
  }
  if (runnable(`ffmpeg${exe}`) && runnable(`ffprobe${exe}`)) {
    return { ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}`, source: 'path' };
  }
  return null;
}

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function extractArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const ps = `
      $ErrorActionPreference = 'Stop'
      Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force
    `;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'Expand-Archive failed');
    return;
  }
  if (archive.endsWith('.tar.xz') || archive.endsWith('.txz')) {
    const r = spawnSync('tar', ['-xJf', archive, '-C', destDir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || 'tar extract failed');
    return;
  }
  const r = spawnSync('unzip', ['-o', archive, '-d', destDir], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'unzip failed');
}

function findBinary(dir, name) {
  const target = `${name}${exe}`;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (e.isFile() && e.name.toLowerCase() === target.toLowerCase()) {
        return full;
      }
    }
  }
  return null;
}

function downloadSpec() {
  const arch = process.arch;
  if (process.platform === 'win32') {
    return {
      url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      archiveName: 'ffmpeg-release-essentials.zip',
    };
  }
  if (process.platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    const buildArch = arch === 'arm64' ? 'linuxarm64' : 'linux64';
    return {
      url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${buildArch}-gpl.tar.xz`,
      archiveName: `ffmpeg-master-latest-${buildArch}-gpl.tar.xz`,
    };
  }
  if (process.platform === 'darwin') {
    // Evermeet only ships x86_64; Apple Silicon can still run via Rosetta or Homebrew.
    return {
      url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
      archiveName: 'ffmpeg-macos.zip',
      probeUrl: 'https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip',
      probeArchiveName: 'ffprobe-macos.zip',
    };
  }
  throw new Error(`Unsupported platform for auto-download: ${process.platform}/${arch}. Install ffmpeg manually.`);
}

async function installToTools() {
  const spec = downloadSpec();
  const tmp = path.join(root, 'tools', '.tmp-ffmpeg');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(toolsDir, { recursive: true });

  const archive = path.join(tmp, spec.archiveName);
  await download(spec.url, archive);
  extractArchive(archive, tmp);

  let ffmpegSrc = findBinary(tmp, 'ffmpeg');
  let ffprobeSrc = findBinary(tmp, 'ffprobe');

  if (spec.probeUrl && !ffprobeSrc) {
    const probeArchive = path.join(tmp, spec.probeArchiveName);
    await download(spec.probeUrl, probeArchive);
    extractArchive(probeArchive, tmp);
    ffprobeSrc = findBinary(tmp, 'ffprobe');
  }

  if (!ffmpegSrc || !ffprobeSrc) {
    throw new Error('Downloaded archive did not contain ffmpeg/ffprobe');
  }

  const ffmpegDest = path.join(toolsDir, `ffmpeg${exe}`);
  const ffprobeDest = path.join(toolsDir, `ffprobe${exe}`);
  fs.copyFileSync(ffmpegSrc, ffmpegDest);
  fs.copyFileSync(ffprobeSrc, ffprobeDest);
  if (process.platform !== 'win32') {
    fs.chmodSync(ffmpegDest, 0o755);
    fs.chmodSync(ffprobeDest, 0o755);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { ffmpeg: ffmpegDest, ffprobe: ffprobeDest, source: 'tools' };
}

const existing = alreadyAvailable();
if (existing && !force) {
  console.log(`[ffmpeg] using ${existing.source}`);
  console.log(`[ffmpeg] ${existing.ffmpeg}`);
  console.log(`[ffmpeg] ${versionLine(existing.ffmpeg)}`);
  console.log(`[ffprobe] ${existing.ffprobe}`);
  process.exit(0);
}

if (existing && force) {
  console.log('[ffmpeg] FORCE_FFMPEG_DOWNLOAD=1 — reinstalling into tools/ffmpeg');
}

try {
  const installed = await installToTools();
  console.log(`[ffmpeg] installed to ${installed.source}`);
  console.log(`[ffmpeg] ${installed.ffmpeg}`);
  console.log(`[ffmpeg] ${versionLine(installed.ffmpeg)}`);
  console.log(`[ffprobe] ${installed.ffprobe}`);
} catch (err) {
  console.error(`[ffmpeg] setup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
