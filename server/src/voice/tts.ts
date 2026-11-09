import { AppSettings, VoiceProvider } from "@promo/shared";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "../ffmpeg/run.js";
import { createLogger } from "../util/log.js";
import {
  buildVoiceLine,
  getCopyTemplate,
  normalizeLanguage,
  VoiceLineInput,
} from "./templates.js";
import {
  listWyomingVoices,
  pickPiperVoice,
  synthesizeWyomingToWav,
  WyomingVoice,
} from "./wyoming.js";

/** Piper may need to download a voice model on first use (often >20s). */
const PIPER_DOWNLOAD_TIMEOUT_MS = 180_000;

export interface VoiceResult {
  filePath?: string;
  text: string;
  voice: string;
  cached: boolean;
  error?: string;
}

interface VoiceRuntime {
  provider: VoiceProvider;
  piperUrl?: string;
  piperVoice?: string;
  piperVoiceByLanguage: Record<string, string>;
  piperSpeaker?: string;
  piperSpeakerByLanguage: Record<string, string>;
  pauseMs: number;
  timeoutMs: number;
}

const log = createLogger("tts");

/** After a hard edge-tts failure, skip it for the rest of the process lifetime. */
let edgeTtsDisabledReason: string | null = null;
let piperVoicesCache: {
  at: number;
  url: string;
  voices: WyomingVoice[];
} | null = null;

/** Voices that have already completed at least one successful Piper synth (downloaded). */
const piperVoicesReady = new Set<string>();

export function invalidatePiperVoiceCache(): void {
  piperVoicesCache = null;
}

function normalizePiperVoiceName(name: string): string {
  return name.trim().replace(/\s+/g, "");
}

function cleanLangOverrideMap(
  raw: Record<string, string> | undefined,
  normalizeValue: (value: string) => string = (v) => v.trim(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, value] of Object.entries(raw ?? {})) {
    const key = code.trim().toLowerCase();
    const normalized = normalizeValue(value);
    if (key && normalized) out[key] = normalized;
  }

  return out;
}

export function voiceRuntimeFromSettings(settings: AppSettings): VoiceRuntime {
  const piperUrl = settings.piperUrl.trim() || undefined;
  return {
    provider: settings.voiceProvider,
    piperUrl,
    piperVoice: settings.piperVoice.trim()
      ? normalizePiperVoiceName(settings.piperVoice)
      : undefined,
    piperVoiceByLanguage: cleanLangOverrideMap(
      settings.piperVoiceByLanguage,
      normalizePiperVoiceName,
    ),
    piperSpeaker: settings.piperSpeaker.trim() || undefined,
    piperSpeakerByLanguage: cleanLangOverrideMap(
      settings.piperSpeakerByLanguage,
    ),
    pauseMs: Math.max(
      0,
      Number.isFinite(settings.voicePauseMs) ? settings.voicePauseMs : 450,
    ),
    timeoutMs: Math.max(
      1_000,
      Number.isFinite(settings.ttsTimeoutMs) ? settings.ttsTimeoutMs : 20_000,
    ),
  };
}

function languageLookupKeys(language: string): string[] {
  const normalized = normalizeLanguage(language);
  const templateLang = getCopyTemplate(language).language;
  const raw = language.trim().toLowerCase().replace(/-/g, "_");
  const base = raw.split("_")[0] ?? raw;

  const keys = new Set<string>([raw, base, normalized, templateLang]);
  if (base === "ua" || normalized === "ua" || normalized === "ukr") {
    keys.add("uk");
    keys.add("ua");
    keys.add("ukr");
  }

  if (base === "eng") keys.add("en");
  return [...keys];
}

function lookupLangOverride(
  byLang: Record<string, string>,
  language: string,
): string | undefined {
  for (const key of languageLookupKeys(language)) {
    const value = byLang[key];
    if (value) return value;
  }

  return undefined;
}

/** Per-language override, then global piperVoice. */
function preferredPiperVoice(
  runtime: VoiceRuntime,
  language: string,
): string | undefined {
  return (
    lookupLangOverride(runtime.piperVoiceByLanguage, language) ??
    runtime.piperVoice
  );
}

/** Per-language speaker override, then global piperSpeaker. */
function preferredPiperSpeaker(
  runtime: VoiceRuntime,
  language: string,
): string | undefined {
  return (
    lookupLangOverride(runtime.piperSpeakerByLanguage, language) ??
    runtime.piperSpeaker
  );
}

/** Human-readable voice request for job logs. */
export function describeVoiceRequest(
  settings: AppSettings,
  language: string,
): string {
  const runtime = voiceRuntimeFromSettings(settings);
  const template = getCopyTemplate(language);
  const lang = template.language;
  const parts = [`lang=${lang}`, `provider=${runtime.provider}`];

  if (wantsPiper(runtime.provider) && runtime.piperUrl) {
    const piperVoice = preferredPiperVoice(runtime, language);
    const speaker = preferredPiperSpeaker(runtime, language);
    parts.push(`piperVoice=${piperVoice ?? "(auto-pick)"}`);
    if (speaker) parts.push(`speaker=${speaker}`);
  }

  if (wantsEdge(runtime.provider)) {
    parts.push(`edgeVoice=${template.voice}`);
  }

  if (wantsSapi(runtime.provider)) {
    parts.push(`sapiLang=${lang}`);
  }

  return parts.join(" · ");
}

function piperTimeoutMs(runtime: VoiceRuntime, voice?: string): number {
  if (voice && !piperVoicesReady.has(voice)) {
    return Math.max(runtime.timeoutMs, PIPER_DOWNLOAD_TIMEOUT_MS);
  }

  return runtime.timeoutMs;
}

/**
 * Ask Wyoming Piper to synthesize a short phrase for each configured voice so
 * models are downloaded before promo generation. Safe to run in the background.
 */
export async function ensureConfiguredPiperVoices(
  settings: AppSettings,
): Promise<Array<{ voice: string; ok: boolean; error?: string }>> {
  const runtime = voiceRuntimeFromSettings(settings);
  if (!runtime.piperUrl || !wantsPiper(runtime.provider)) return [];

  invalidatePiperVoiceCache();

  const voices = new Set<string>();
  if (runtime.piperVoice) voices.add(runtime.piperVoice);
  for (const voice of Object.values(runtime.piperVoiceByLanguage)) {
    if (voice) voices.add(voice);
  }

  if (voices.size === 0) return [];

  const results: Array<{ voice: string; ok: boolean; error?: string }> = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "promo-piper-"));
  try {
    for (const voice of voices) {
      const outPath = path.join(
        tmpDir,
        `${voice.replace(/[^\w.-]+/g, "_")}.wav`,
      );

      try {
        log.info("piper voice ensure/download start", {
          voice,
          url: runtime.piperUrl,
        });

        await synthesizeWyomingToWav(runtime.piperUrl, "OK.", outPath, {
          voice,
          speaker: runtime.piperSpeaker,
          // Speakers are voice-specific; warm with default speaker only.
          timeoutMs: Math.max(runtime.timeoutMs, PIPER_DOWNLOAD_TIMEOUT_MS),
        });

        piperVoicesReady.add(voice);
        log.info("piper voice ensure/download ok", { voice });
        results.push({ voice, ok: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("piper voice ensure/download failed", { voice, error });
        results.push({ voice, ok: false, error });
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return results;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );

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

async function resolvePiperVoice(
  runtime: VoiceRuntime,
  language: string,
): Promise<string | undefined> {
  const preferred = preferredPiperVoice(runtime, language);
  const url = runtime.piperUrl;
  if (!url) return preferred;

  try {
    if (
      !piperVoicesCache ||
      piperVoicesCache.url !== url ||
      Date.now() - piperVoicesCache.at > 10 * 60_000
    ) {
      const voices = await listWyomingVoices(
        url,
        Math.min(10_000, runtime.timeoutMs),
      );

      piperVoicesCache = { at: Date.now(), url, voices };
      log.info("piper voices loaded", { count: voices.length });
    }

    return pickPiperVoice(piperVoicesCache.voices, language, preferred);
  } catch (err) {
    log.warn(
      "piper voice list failed; using preferred/default",
      err instanceof Error ? err.message : String(err),
    );

    return preferred;
  }
}

async function synthesizePiper(
  runtime: VoiceRuntime,
  text: string,
  language: string,
  outWavPath: string,
): Promise<string> {
  const url = runtime.piperUrl;
  if (!url) throw new Error("Piper URL is not configured");

  const voice = await resolvePiperVoice(runtime, language);
  const speaker = preferredPiperSpeaker(runtime, language);
  const timeoutMs = piperTimeoutMs(runtime, voice);
  log.info("piper/wyoming start", {
    url,
    voice,
    speaker,
    language,
    chars: text.length,
    timeoutMs,
    download: Boolean(voice && !piperVoicesReady.has(voice)),
  });

  const result = await synthesizeWyomingToWav(url, text, outWavPath, {
    voice,
    speaker,
    language: getCopyTemplate(language).language,
    timeoutMs,
  });

  if (voice) piperVoicesReady.add(voice);
  log.info("piper/wyoming ok", {
    voice: result.voice,
    bytes: fs.statSync(outWavPath).size,
    rate: result.rate,
  });

  return result.voice;
}

async function synthesizeEdgeTts(
  runtime: VoiceRuntime,
  text: string,
  voice: string,
  outPath: string,
): Promise<void> {
  const { Communicate } = await import("edge-tts-universal");
  const communicate = new Communicate(text, {
    voice,
    connectionTimeout: Math.min(8_000, runtime.timeoutMs),
  });

  const chunks: Buffer[] = [];

  await withTimeout(
    (async () => {
      for await (const chunk of communicate.stream()) {
        if (chunk.type === "audio" && chunk.data) {
          chunks.push(Buffer.from(chunk.data));
        }
      }
    })(),
    runtime.timeoutMs,
    "edge-tts",
  );

  if (chunks.length === 0) {
    throw new Error(
      "No audio returned from edge-tts (WebSocket likely blocked/403)",
    );
  }

  fs.writeFileSync(outPath, Buffer.concat(chunks));
}

function runPowerShell(script: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true },
    );

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Windows SAPI TTS timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (d) => {
      stderr += String(d);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(new Error(stderr.trim() || `Windows SAPI TTS exited ${code}`));
    });
  });
}

/** Offline fallback using Windows System.Speech → WAV (ffmpeg accepts it). */
async function synthesizeWindowsSapi(
  runtime: VoiceRuntime,
  text: string,
  language: string,
  outWavPath: string,
): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Windows SAPI fallback is only available on win32");
  }

  fs.mkdirSync(path.dirname(outWavPath), { recursive: true });
  const escapedText = text.replace(/'/g, "''");
  const escapedOut = outWavPath.replace(/'/g, "''");
  const cultureHint = language.toLowerCase().startsWith("uk")
    ? "uk"
    : (language.split("-")[0] ?? "en");

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

  await runPowerShell(script, runtime.timeoutMs);
  if (!fs.existsSync(outWavPath) || fs.statSync(outWavPath).size < 44) {
    throw new Error("Windows SAPI produced an empty wav");
  }
}

/** Join audio parts with silence after each segment except the last. */
async function concatSegmentsWithPause(
  partPaths: string[],
  outWavPath: string,
  pauseSec: number,
): Promise<void> {
  if (partPaths.length === 0) throw new Error("No voice segments to concat");

  if (partPaths.length === 1) {
    fs.copyFileSync(partPaths[0]!, outWavPath);
    return;
  }

  const args: string[] = [];
  for (const p of partPaths) args.push("-i", p);

  const labels: string[] = [];
  const filterParts: string[] = [];
  for (let i = 0; i < partPaths.length; i++) {
    const padded = i < partPaths.length - 1 && pauseSec > 0;
    const label = `a${i}`;
    filterParts.push(
      `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=mono` +
        (padded ? `,apad=pad_dur=${pauseSec}` : "") +
        `[${label}]`,
    );

    labels.push(`[${label}]`);
  }

  filterParts.push(
    `${labels.join("")}concat=n=${partPaths.length}:v=0:a=1[aout]`,
  );

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[aout]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-y",
    outWavPath,
  );

  const result = await runFfmpeg(args);
  if (result.code !== 0) {
    throw new Error(`voice concat failed:\n${result.stderr.slice(-1500)}`);
  }
}

async function synthesizeSegmentsPiper(
  runtime: VoiceRuntime,
  segments: string[],
  language: string,
  outWavPath: string,
  workDir: string,
): Promise<string> {
  const partPaths: string[] = [];
  let voiceName = "piper";
  try {
    for (let i = 0; i < segments.length; i++) {
      const part = path.join(workDir, `seg-${i}.wav`);
      voiceName = await synthesizePiper(runtime, segments[i]!, language, part);
      partPaths.push(part);
    }

    await concatSegmentsWithPause(
      partPaths,
      outWavPath,
      runtime.pauseMs / 1000,
    );

    return voiceName;
  } finally {
    for (const p of partPaths) fs.rmSync(p, { force: true });
  }
}

async function synthesizeSegmentsEdge(
  runtime: VoiceRuntime,
  segments: string[],
  voice: string,
  outWavPath: string,
  workDir: string,
): Promise<void> {
  const partPaths: string[] = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const part = path.join(workDir, `seg-${i}.mp3`);
      await synthesizeEdgeTts(runtime, segments[i]!, voice, part);
      partPaths.push(part);
    }

    await concatSegmentsWithPause(
      partPaths,
      outWavPath,
      runtime.pauseMs / 1000,
    );
  } finally {
    for (const p of partPaths) fs.rmSync(p, { force: true });
  }
}

async function synthesizeSegmentsSapi(
  runtime: VoiceRuntime,
  segments: string[],
  language: string,
  outWavPath: string,
  workDir: string,
): Promise<void> {
  const partPaths: string[] = [];
  try {
    for (let i = 0; i < segments.length; i++) {
      const part = path.join(workDir, `seg-${i}.wav`);
      await synthesizeWindowsSapi(runtime, segments[i]!, language, part);
      partPaths.push(part);
    }

    await concatSegmentsWithPause(
      partPaths,
      outWavPath,
      runtime.pauseMs / 1000,
    );
  } finally {
    for (const p of partPaths) fs.rmSync(p, { force: true });
  }
}

function wantsPiper(provider: VoiceProvider): boolean {
  return provider === "auto" || provider === "piper";
}

function wantsEdge(provider: VoiceProvider): boolean {
  return provider === "auto" || provider === "edge";
}

function wantsSapi(provider: VoiceProvider): boolean {
  return provider === "auto" || provider === "sapi";
}

/** Content-addressed key for a voice line (matches synthesizeVoiceOver). */
export function voiceCacheKey(
  settings: AppSettings,
  language: string,
  input: VoiceLineInput,
): { hash: string; text: string; outWav: string; partsDir: string } {
  const runtime = voiceRuntimeFromSettings(settings);
  const built = buildVoiceLine(language, input);
  const engineHint =
    runtime.piperUrl && wantsPiper(runtime.provider)
      ? "piper"
      : runtime.provider;

  const piperVoiceHint = preferredPiperVoice(runtime, built.language) ?? "";
  const piperSpeakerHint = preferredPiperSpeaker(runtime, built.language) ?? "";
  const hash = crypto
    .createHash("sha256")
    .update(
      [
        engineHint,
        built.language,
        piperVoiceHint,
        piperSpeakerHint,
        built.voice,
        `pause${runtime.pauseMs}`,
        runtime.provider,
        built.segments.join("\u0001"),
      ].join("|"),
    )
    .digest("hex");

  const outDir = path.join(settings.cachePath, "voice");
  return {
    hash,
    text: built.text,
    outWav: path.join(outDir, `${hash}.wav`),
    partsDir: path.join(outDir, `${hash}.parts`),
  };
}

/**
 * Return cached WAV if present — never synthesizes.
 * Used by live encode (skip VO when cold) and ledger bookkeeping.
 */
export function peekCachedVoiceOver(
  settings: AppSettings,
  language: string,
  input: VoiceLineInput,
): { hash: string; filePath: string; text: string } | undefined {
  const key = voiceCacheKey(settings, language, input);
  if (fs.existsSync(key.outWav) && fs.statSync(key.outWav).size > 0) {
    return { hash: key.hash, filePath: key.outWav, text: key.text };
  }

  return undefined;
}

export function voiceCacheDir(cachePath: string): string {
  return path.join(cachePath, "voice");
}

export async function synthesizeVoiceOver(
  settings: AppSettings,
  cacheDir: string,
  language: string,
  input: VoiceLineInput,
): Promise<VoiceResult> {
  const runtime = voiceRuntimeFromSettings(settings);
  const built = buildVoiceLine(language, input);
  const engineHint =
    runtime.piperUrl && wantsPiper(runtime.provider)
      ? "piper"
      : runtime.provider;

  const piperVoiceHint = preferredPiperVoice(runtime, built.language) ?? "";
  const piperSpeakerHint = preferredPiperSpeaker(runtime, built.language) ?? "";
  // Prefer explicit cacheDir (jobs pass settings.cachePath); keep signature stable.
  const key = voiceCacheKey(
    { ...settings, cachePath: cacheDir },
    language,
    input,
  );

  const hash = key.hash;
  const outDir = path.join(cacheDir, "voice");
  fs.mkdirSync(outDir, { recursive: true });
  const outWav = key.outWav;
  const workDir = key.partsDir;

  if (fs.existsSync(outWav) && fs.statSync(outWav).size > 0) {
    const cachedVoice =
      engineHint === "piper" && piperVoiceHint
        ? `piper:${piperVoiceHint}${piperSpeakerHint ? `/${piperSpeakerHint}` : ""}`
        : built.voice;

    return {
      filePath: outWav,
      text: built.text,
      voice: cachedVoice,
      cached: true,
    };
  }

  const errors: string[] = [];
  fs.mkdirSync(workDir, { recursive: true });

  try {
    if (wantsPiper(runtime.provider) && runtime.piperUrl) {
      try {
        const voice = await synthesizeSegmentsPiper(
          runtime,
          built.segments,
          built.language,
          outWav,
          workDir,
        );

        return {
          filePath: outWav,
          text: built.text,
          voice: `piper:${voice}`,
          cached: false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`piper: ${msg}`);
        log.warn("piper failed; trying fallbacks", msg);
        if (runtime.provider === "piper") {
          return {
            text: built.text,
            voice: built.voice,
            cached: false,
            error: errors.join(" | "),
          };
        }
      }
    } else if (runtime.provider === "piper") {
      errors.push("piper: URL is not configured");
      return {
        text: built.text,
        voice: built.voice,
        cached: false,
        error: errors.join(" | "),
      };
    }

    if (wantsEdge(runtime.provider)) {
      if (!edgeTtsDisabledReason) {
        try {
          log.info("edge-tts start", {
            voice: built.voice,
            segments: built.segments.length,
          });

          await synthesizeSegmentsEdge(
            runtime,
            built.segments,
            built.voice,
            outWav,
            workDir,
          );

          log.info("edge-tts ok", { bytes: fs.statSync(outWav).size });
          return {
            filePath: outWav,
            text: built.text,
            voice: built.voice,
            cached: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          edgeTtsDisabledReason = msg;
          errors.push(`edge-tts: ${msg}`);
          log.warn("edge-tts disabled for this process", msg);
          if (runtime.provider === "edge") {
            return {
              text: built.text,
              voice: built.voice,
              cached: false,
              error: errors.join(" | "),
            };
          }
        }
      } else {
        errors.push(`edge-tts skipped (${edgeTtsDisabledReason})`);
        if (runtime.provider === "edge") {
          return {
            text: built.text,
            voice: built.voice,
            cached: false,
            error: errors.join(" | "),
          };
        }
      }
    }

    if (wantsSapi(runtime.provider)) {
      if (process.platform === "win32") {
        try {
          log.info("windows SAPI fallback start", {
            language: built.language,
            segments: built.segments.length,
          });

          await synthesizeSegmentsSapi(
            runtime,
            built.segments,
            built.language,
            outWav,
            workDir,
          );

          log.info("windows SAPI ok", { bytes: fs.statSync(outWav).size });
          return {
            filePath: outWav,
            text: built.text,
            voice: `windows-sapi:${built.language}`,
            cached: false,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`windows-sapi: ${msg}`);
          log.warn("windows SAPI failed", msg);
        }
      } else if (runtime.provider === "sapi") {
        errors.push("windows-sapi: only available on win32");
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  return {
    text: built.text,
    voice: built.voice,
    cached: false,
    error: errors.join(" | "),
  };
}
