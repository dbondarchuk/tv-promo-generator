import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildVoiceLine, VoiceLineInput } from './templates.js';
import {
  listWyomingVoices,
  pickPiperVoice,
  synthesizeWyomingToWav,
  WyomingVoice,
} from './wyoming.js';
import { runFfmpeg } from '../ffmpeg/run.js';
import { createLogger } from '../util/log.js';

export interface VoiceResult {
  filePath?: string;
  text: string;
  voice: string;
  cached: boolean;
  error?: string;
}

const log = createLogger('tts');
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 20_000);
/** Silence between channel cue and show/movie name (ms). */
const VOICE_PAUSE_MS = Math.max(0, Number(process.env.VOICE_PAUSE_MS ?? 450));

/** After a hard edge-tts failure, skip it for the rest of the process lifetime. */
let edgeTtsDisabledReason: string | null = null;
let piperVoicesCache: { at: number; voices: WyomingVoice[] } | null = null;

function piperUrl(): string | undefined {
  const value = process.env.PIPER_URL?.trim() || process.env.WYOMING_PIPER_URL?.trim();
  return value || undefined;
}

/** Per-language override: PIPER_VOICE_UK, PIPER_VOICE_EN, … then global PIPER_VOICE. */
function preferredPiperVoice(language: string): string | undefined {
  const raw = language.trim().toLowerCase().replace(/-/g, '_');
  const base = raw.split('_')[0] ?? raw;
  const keys = [
    `PIPER_VOICE_${raw.toUpperCase()}`,
    `PIPER_VOICE_${base.toUpperCase()}`,
    'PIPER_VOICE',
  ];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function resolvePiperVoice(language: string): Promise<string | undefined> {
  const preferred = preferredPiperVoice(language);
  const url = piperUrl();
  if (!url) return preferred;

  try {
    if (!piperVoicesCache || Date.now() - piperVoicesCache.at > 10 * 60_000) {
      const voices = await listWyomingVoices(url, Math.min(10_000, TTS_TIMEOUT_MS));
      piperVoicesCache = { at: Date.now(), voices };
      log.info('piper voices loaded', { count: voices.length });
    }
    return pickPiperVoice(piperVoicesCache.voices, language, preferred);
  } catch (err) {
    log.warn('piper voice list failed; using preferred/default', err instanceof Error ? err.message : String(err));
    return preferred;
  }
}

async function synthesizePiper(text: string, language: string, outWavPath: string): Promise<string> {
  const url = piperUrl();
  if (!url) throw new Error('PIPER_URL is not configured');
  const voice = await resolvePiperVoice(language);
  log.info('piper/wyoming start', { url, voice, language, chars: text.length });
  const result = await synthesizeWyomingToWav(url, text, outWavPath, {
    voice,
    speaker: process.env.PIPER_SPEAKER?.trim() || undefined,
    timeoutMs: TTS_TIMEOUT_MS,
  });
  log.info('piper/wyoming ok', { voice: result.voice, bytes: fs.statSync(outWavPath).size, rate: result.rate });
  return result.voice;
}

async function synthesizeEdgeTts(text: string, voice: string, outPath: string): Promise<void> {
  const { Communicate } = await import('edge-tts-universal');
  const communicate = new Communicate(text, {
    voice,
    connectionTimeout: Math.min(8_000, TTS_TIMEOUT_MS),
  });
  const chunks: Buffer[] = [];

  await withTimeout((async () => {
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        chunks.push(Buffer.from(chunk.data));
      }
    }
  })(), TTS_TIMEOUT_MS, 'edge-tts');

  if (chunks.length === 0) {
    throw new Error('No audio returned from edge-tts (WebSocket likely blocked/403)');
  }
  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

function runPowerShell(script: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
    );
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Windows SAPI TTS timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Windows SAPI TTS exited ${code}`));
    });
  });
}

/** Offline fallback using Windows System.Speech → WAV (ffmpeg accepts it). */
async function synthesizeWindowsSapi(text: string, language: string, outWavPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Windows SAPI fallback is only available on win32');
  }
  fs.mkdirSync(path.dirname(outWavPath), { recursive: true });
  const escapedText = text.replace(/'/g, "''");
  const escapedOut = outWavPath.replace(/'/g, "''");
  const cultureHint = language.toLowerCase().startsWith('uk')
    ? 'uk'
    : language.split('-')[0] ?? 'en';

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
  $match = $voices | Where-Object { $_.Culture.Name -like '${cultureHint}*' } | Select-Object -First 1
  if (-not $match) { $match = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq '${cultureHint}' } | Select-Object -First 1 }
  if (-not $match) { $match = $voices | Where-Object { $_.Culture.Name -like 'en*' } | Select-Object -First 1 }
  if ($match) { $synth.SelectVoice($match.Name) }
  $synth.Rate = 0
  $synth.Volume = 100
  $synth.SetOutputToWaveFile('${escapedOut}')
  $synth.Speak('${escapedText}')
} finally {
  $synth.Dispose()
}
if (-not (Test-Path -LiteralPath '${escapedOut}')) { throw 'SAPI produced no wav file' }
`;
  await runPowerShell(script, TTS_TIMEOUT_MS);
  if (!fs.existsSync(outWavPath) || fs.statSync(outWavPath).size < 44) {
    throw new Error('Windows SAPI produced an empty wav');
  }
}

/** Join audio parts with silence after each segment except the last. */
async function concatSegmentsWithPause(partPaths: string[], outWavPath: string, pauseSec: number): Promise<void> {
  if (partPaths.length === 0) throw new Error('No voice segments to concat');
  if (partPaths.length === 1) {
    fs.copyFileSync(partPaths[0]!, outWavPath);
    return;
  }

  const args: string[] = [];
  for (const p of partPaths) args.push('-i', p);

  const labels: string[] = [];
  const filterParts: string[] = [];
  for (let i = 0; i < partPaths.length; i++) {
    const padded = i < partPaths.length - 1 && pauseSec > 0;
    const label = `a${i}`;
    filterParts.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono` +
        (padded ? `,apad=pad_dur=${pauseSec}` : '') +
        `[${label}]`,
    );
    labels.push(`[${label}]`);
  }
  filterParts.push(`${labels.join('')}concat=n=${partPaths.length}:v=0:a=1[aout]`);

  args.push(
    '-filter_complex', filterParts.join(';'),
    '-map', '[aout]',
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '1',
    '-y',
    outWavPath,
  );

  const result = await runFfmpeg(args);
  if (result.code !== 0) {
    throw new Error(`voice concat failed:\n${result.stderr.slice(-1500)}`);
  }
}

async function synthesizeSegmentsPiper(
  segments: string[],
  language: string,
  outWavPath: string,
  workDir: string,
): Promise<string> {
  const partPaths: string[] = [];
  let voiceName = 'piper';
  try {
    for (let i = 0; i < segments.length; i++) {
      const part = path.join(workDir, `seg-${i}.wav`);
      voiceName = await synthesizePiper(segments[i]!, language, part);
      partPaths.push(part);
    }
    await concatSegmentsWithPause(partPaths, outWavPath, VOICE_PAUSE_MS / 1000);
    return voiceName;
  } finally {
    for (const p of partPaths) fs.rmSync(p, { force: true });
  }
}

async function synthesizeSegmentsEdge(
  segments: string[],
  voice: string,
  outWavPath: string,
  workDir: string,
): Promise<void> {
  const partPaths: string[] = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const part = path.join(workDir, `seg-${i}.mp3`);
      await synthesizeEdgeTts(segments[i]!, voice, part);
      partPaths.push(part);
    }
    await concatSegmentsWithPause(partPaths, outWavPath, VOICE_PAUSE_MS / 1000);
  } finally {
    for (const p of partPaths) fs.rmSync(p, { force: true });
  }
}

async function synthesizeSegmentsSapi(
  segments: string[],
  language: string,
  outWavPath: string,
  workDir: string,
): Promise<void> {
  const partPaths: string[] = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const part = path.join(workDir, `seg-${i}.wav`);
      await synthesizeWindowsSapi(segments[i]!, language, part);
      partPaths.push(part);
    }
    await concatSegmentsWithPause(partPaths, outWavPath, VOICE_PAUSE_MS / 1000);
  } finally {
    for (const p of partPaths) fs.rmSync(p, { force: true });
  }
}

export async function synthesizeVoiceOver(
  cacheDir: string,
  language: string,
  input: VoiceLineInput,
): Promise<VoiceResult> {
  const built = buildVoiceLine(language, input);
  const engineHint = piperUrl() ? 'piper' : 'edge';
  const piperVoiceHint = preferredPiperVoice(built.language) ?? '';
  const hash = crypto
    .createHash('sha256')
    .update(`${engineHint}|${built.language}|${piperVoiceHint}|${built.voice}|pause${VOICE_PAUSE_MS}|${built.segments.join('\u0001')}`)
    .digest('hex');
  const outDir = path.join(cacheDir, 'voice');
  fs.mkdirSync(outDir, { recursive: true });
  const outWav = path.join(outDir, `${hash}.wav`);
  const workDir = path.join(outDir, `${hash}.parts`);

  if (fs.existsSync(outWav) && fs.statSync(outWav).size > 0) {
    return { filePath: outWav, text: built.text, voice: built.voice, cached: true };
  }

  const errors: string[] = [];
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (piperUrl()) {
      try {
        const voice = await synthesizeSegmentsPiper(built.segments, built.language, outWav, workDir);
        return {
          filePath: outWav,
          text: built.text,
          voice: `piper:${voice}`,
          cached: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`piper: ${msg}`);
        log.warn('piper failed; trying fallbacks', msg);
      }
    }

    if (!edgeTtsDisabledReason) {
      try {
        log.info('edge-tts start', { voice: built.voice, segments: built.segments.length });
        await synthesizeSegmentsEdge(built.segments, built.voice, outWav, workDir);
        log.info('edge-tts ok', { bytes: fs.statSync(outWav).size });
        return { filePath: outWav, text: built.text, voice: built.voice, cached: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        edgeTtsDisabledReason = msg;
        errors.push(`edge-tts: ${msg}`);
        log.warn('edge-tts disabled for this process', msg);
      }
    } else {
      errors.push(`edge-tts skipped (${edgeTtsDisabledReason})`);
    }

    if (process.platform === 'win32') {
      try {
        log.info('windows SAPI fallback start', { language: built.language, segments: built.segments.length });
        await synthesizeSegmentsSapi(built.segments, built.language, outWav, workDir);
        log.info('windows SAPI ok', { bytes: fs.statSync(outWav).size });
        return {
          filePath: outWav,
          text: built.text,
          voice: `windows-sapi:${built.language}`,
          cached: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`windows-sapi: ${msg}`);
        log.warn('windows SAPI failed', msg);
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return {
    text: built.text,
    voice: built.voice,
    cached: false,
    error: errors.join(' | '),
  };
}
