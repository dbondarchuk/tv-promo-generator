import { AppSettings } from "@promo/shared";
import type { Response } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  describeEncoderPlan,
  isHardwareEncodeFailure,
  summarizeHwFailure,
} from "../ffmpeg/hwaccel.js";
import { createFfmpegProgressReporter } from "../ffmpeg/progress.js";
import { startLivePromoEncode } from "../promo/render.js";
import { createLogger } from "../util/log.js";
import { markVoiceHashesInUse, releaseVoiceHashes } from "../voice/ledger.js";
import {
  buildPromoChaptersForChannel,
  ensureChannelScheduleForLive,
  getFontFile,
} from "./channels.js";
import type { JobQueue } from "./jobs.js";

const log = createLogger("live-promo");

/** After encode finishes, keep HLS segments available for late pulls. */
const POST_ENCODE_GRACE_MS = 45_000;
const PUMP_POLL_MS = 50;
const HLS_SEGMENT_RE = /^seg\d{3}\.ts$/;
/** MPEG-TS packets are always 188 bytes — only serve whole packets. */
const TS_PACKET = 188;
const LIVE_CONTAINER = "mpegts" as const;

interface LiveSession {
  key: string;
  channelNumber: string;
  startedAt: number;
  totalSeconds: number;
  childKill: () => void;
  voiceHashes: string[];
  workDir: string;
  /** HLS playlist path (index.m3u8) for UI preview. */
  playlistPath: string;
  /** Continuous MPEG-TS for ETV Remote Stream. */
  mpegtsPath: string;
  jobId?: string;
  exitError?: string;
  encodeDone: boolean;
  lastAccessAt: number;
  /** Active ETV continuous-TS pumps. */
  tsReaders: number;
  endTimer?: NodeJS.Timeout;
}

const sessions = new Map<string, LiveSession>();
/** In-flight session startups — concurrent opens await the same encode. */
const starting = new Map<string, Promise<LiveSession>>();
let jobQueue: JobQueue | null = null;

/** Wire JobQueue so live encodes show up in the Jobs UI. */
export function setLivePromoJobs(jobs: JobQueue): void {
  jobQueue = jobs;
}

function sessionKey(channelNumber: string): string {
  return `${channelNumber}:${LIVE_CONTAINER}`;
}

function liveWorkDir(cachePath: string, channelNumber: string): string {
  return path.join(
    cachePath,
    "work",
    "live",
    channelNumber,
    LIVE_CONTAINER,
    String(Date.now()),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cancelScheduledEnd(session: LiveSession): void {
  if (session.endTimer) {
    clearTimeout(session.endTimer);
    session.endTimer = undefined;
  }
}

function endSession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;

  cancelScheduledEnd(session);
  sessions.delete(key);
  releaseVoiceHashes(session.voiceHashes);
  try {
    session.childKill();
  } catch {
    // ignore
  }

  try {
    fs.rmSync(session.workDir, { recursive: true, force: true });
  } catch {
    // ignore
  }

  if (session.jobId && jobQueue) {
    jobQueue.finishLiveStream(
      session.jobId,
      session.exitError ? "failed" : "succeeded",
      session.exitError,
    );
  }

  log.info("live session ended", { channel: session.channelNumber });
}

function touchAccess(session: LiveSession): void {
  session.lastAccessAt = Date.now();
  cancelScheduledEnd(session);
}

function scheduleEndIfIdle(key: string): void {
  const session = sessions.get(key);
  if (!session) return;

  // Keep running until encode finishes (clients poll between segments).
  if (!session.encodeDone) return;
  if (session.tsReaders > 0) return;

  cancelScheduledEnd(session);
  log.info("live session idle — grace before stop", {
    channel: session.channelNumber,
    graceMs: POST_ENCODE_GRACE_MS,
  });

  session.endTimer = setTimeout(() => {
    const current = sessions.get(key);
    if (!current || !current.encodeDone || current.tsReaders > 0) return;

    endSession(key);
  }, POST_ENCODE_GRACE_MS);
}

function waitForDrain(res: Response): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve();
    };

    const onDrain = () => done();
    const onClose = () => done();
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

function playlistHasSegment(playlistPath: string): boolean {
  try {
    const text = fs.readFileSync(playlistPath, "utf8");
    return text.includes("#EXTINF");
  } catch {
    return false;
  }
}

async function createLiveSession(
  settings: AppSettings,
  channelNumber: string,
  key: string,
): Promise<LiveSession> {
  const slice = await ensureChannelScheduleForLive(settings, channelNumber);
  const channelName = slice.channelName;

  const job = jobQueue?.beginLiveStream({
    channelNumber,
    channelName,
    container: LIVE_CONTAINER,
  });

  const progress = (
    message: string,
    level: "info" | "warn" | "error" = "info",
  ) => {
    if (level === "warn" || level === "error") {
      log.warn(message, { channel: channelNumber });
    } else {
      log.info(message, { channel: channelNumber });
    }

    if (job && jobQueue) {
      jobQueue.logLiveStream(
        job.id,
        level === "error" ? "error" : level === "warn" ? "warn" : "info",
        message,
      );
    }
  };

  try {
    const built = await buildPromoChaptersForChannel(
      settings,
      channelNumber,
      progress,
    );

    const workDir = liveWorkDir(settings.cachePath, channelNumber);
    fs.mkdirSync(workDir, { recursive: true });
    const playlistPath = path.join(workDir, "index.m3u8");
    const mpegtsPath = path.join(workDir, "stream.ts");

    const live = await startLivePromoEncode(
      settings,
      {
        channelName: built.channelName,
        channelNumber,
        language: built.language,
        color: built.color,
        logoPath: built.logoPath,
        chapters: built.chapters,
        workDir,
        fontFile: getFontFile(),
        voiceEnabled: settings.voiceEnabled,
        voiceMode: "cache-only",
        cachePath: settings.cachePath,
        onProgress: progress,
      },
      playlistPath,
      mpegtsPath,
    );

    markVoiceHashesInUse(live.voiceHashes);

    const session: LiveSession = {
      key,
      channelNumber,
      startedAt: Date.now(),
      totalSeconds: live.totalSeconds,
      voiceHashes: live.voiceHashes,
      workDir: live.workDir,
      playlistPath: live.playlistPath,
      mpegtsPath: live.mpegtsPath,
      jobId: job?.id,
      encodeDone: false,
      lastAccessAt: Date.now(),
      tsReaders: 0,
      childKill: () => {
        try {
          live.process.kill("SIGKILL");
        } catch {
          // ignore
        }
      },
    };

    sessions.set(key, session);
    progress(
      `Live tee (TS+HLS) · VO ${live.voiceHashes.length > 0 ? "on" : "off"} · ${built.chapters.length} chapter(s) · ${live.totalSeconds}s`,
    );

    const stderrChunks: Buffer[] = [];
    const reportProgress = createFfmpegProgressReporter((message) => {
      progress(message);
    });

    live.process.stderr.on("data", (d: Buffer) => {
      stderrChunks.push(d);
      if (stderrChunks.length > 40) stderrChunks.shift();
      reportProgress(d);
    });

    live.process.on("close", (code) => {
      session.encodeDone = true;
      const errText = Buffer.concat(stderrChunks).toString("utf8");
      const encoderLabel = describeEncoderPlan(live.encodeSettings);

      if (code && code !== 0) {
        const tail = errText.slice(-2000);
        session.exitError = `ffmpeg exited ${code}`;
        log.error("live ffmpeg exited", {
          channel: channelNumber,
          code,
          stderr: tail,
        });

        if (
          live.encodeSettings.hardwareAcceleration !== "None" &&
          isHardwareEncodeFailure(errText)
        ) {
          const hint = summarizeHwFailure(errText);
          progress(
            `Hardware encode failed (${live.encodeSettings.hardwareAcceleration}` +
              `${hint ? `: ${hint}` : ""}) · ${encoderLabel}`,
            "error",
          );
        }

        if (tail) progress(tail.slice(-500), "error");
      } else {
        progress(`Encode finished · encoder OK (${encoderLabel})`);
      }

      scheduleEndIfIdle(key);
    });

    live.process.on("error", (err) => {
      session.encodeDone = true;
      session.exitError = err.message;
      log.error("live ffmpeg spawn error", {
        channel: channelNumber,
        err: err.message,
      });

      scheduleEndIfIdle(key);
    });

    log.info("live session started", {
      channel: channelNumber,
      name: built.channelName,
      playlist: playlistPath,
      mpegts: mpegtsPath,
      seconds: live.totalSeconds,
      vo: live.voiceHashes.length > 0,
    });

    return session;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (job && jobQueue) {
      jobQueue.finishLiveStream(job.id, "failed", message);
    }

    throw err;
  }
}

async function ensureSession(
  settings: AppSettings,
  channelNumber: string,
  retry = false,
): Promise<LiveSession> {
  const key = sessionKey(channelNumber);

  const existing = sessions.get(key);
  if (existing) return existing;

  let pending = starting.get(key);
  if (!pending) {
    pending = createLiveSession(settings, channelNumber, key);
    starting.set(key, pending);
    void pending.finally(() => {
      if (starting.get(key) === pending) starting.delete(key);
    });
  } else {
    log.info("live session startup in progress — waiting", {
      channel: channelNumber,
    });
  }

  const session = await pending;
  if (!sessions.has(key)) {
    if (retry) {
      throw new Error("Live session ended before client could attach");
    }

    return ensureSession(settings, channelNumber, true);
  }

  return session;
}

/**
 * ETV Remote Stream: continuous MPEG-TS from the live tee output.
 * Only whole 188-byte packets are sent (avoids torn TS at the growing edge).
 */
export async function serveLiveMpegTs(
  settings: AppSettings,
  channelNumber: string,
  res: Response,
): Promise<void> {
  const key = sessionKey(channelNumber);
  const session = await ensureSession(settings, channelNumber);
  touchAccess(session);
  session.tsReaders += 1;

  if (session.jobId && jobQueue) {
    jobQueue.logLiveStream(
      session.jobId,
      "info",
      `ETV MPEG-TS pump · encode ${session.encodeDone ? "done" : "running"}`,
    );
  }

  // Wait until the continuous TS has at least one packet before headers.
  const startDeadline = Date.now() + 120_000;
  while (!res.writableEnded && !res.destroyed) {
    if (session.exitError) throw new Error(session.exitError);

    try {
      if (
        fs.existsSync(session.mpegtsPath) &&
        fs.statSync(session.mpegtsPath).size >= TS_PACKET
      ) {
        break;
      }
    } catch {
      // not ready
    }

    if (session.encodeDone) {
      throw new Error("Live encode finished before any MPEG-TS data");
    }

    if (Date.now() > startDeadline) {
      throw new Error("Timed out waiting for MPEG-TS output");
    }

    await sleep(PUMP_POLL_MS);
  }

  if (res.writableEnded || res.destroyed) {
    session.tsReaders = Math.max(0, session.tsReaders - 1);
    scheduleEndIfIdle(key);
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "video/MP2T");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");

  let offset = 0;
  const buf = Buffer.alloc(64 * 1024);
  let fd: number | undefined;

  try {
    fd = fs.openSync(session.mpegtsPath, "r");

    while (!res.writableEnded && !res.destroyed) {
      let size = 0;
      try {
        size = fs.fstatSync(fd).size;
      } catch {
        break;
      }

      const readable = Math.floor((size - offset) / TS_PACKET) * TS_PACKET;
      if (readable > 0) {
        let left = readable;
        while (left > 0 && !res.writableEnded && !res.destroyed) {
          const n = fs.readSync(
            fd,
            buf,
            0,
            Math.min(buf.length, left),
            offset,
          );
          if (n <= 0) break;

          offset += n;
          left -= n;
          const ok = res.write(buf.subarray(0, n));
          if (!ok) await waitForDrain(res);
        }

        touchAccess(session);
        continue;
      }

      if (session.encodeDone) break;
      if (session.exitError) throw new Error(session.exitError);

      await sleep(PUMP_POLL_MS);
    }
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }

    session.tsReaders = Math.max(0, session.tsReaders - 1);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // ignore
    }

    if (session.jobId && jobQueue) {
      jobQueue.logLiveStream(
        session.jobId,
        "info",
        `ETV MPEG-TS pump finished · ${offset} bytes`,
      );
    }

    scheduleEndIfIdle(key);
  }
}

/**
 * UI preview: HLS playlist once the first segment exists.
 */
export async function serveLiveHlsPlaylist(
  settings: AppSettings,
  channelNumber: string,
  res: Response,
): Promise<void> {
  const key = sessionKey(channelNumber);
  const session = await ensureSession(settings, channelNumber);
  touchAccess(session);

  if (session.jobId && jobQueue) {
    jobQueue.logLiveStream(
      session.jobId,
      "info",
      `HLS playlist request · encode ${session.encodeDone ? "done" : "running"}`,
    );
  }

  const deadline = Date.now() + 60_000;
  while (!playlistHasSegment(session.playlistPath)) {
    if (session.exitError) {
      throw new Error(session.exitError);
    }

    if (session.encodeDone && !playlistHasSegment(session.playlistPath)) {
      throw new Error("HLS encode finished without a playable playlist");
    }

    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for first HLS segment");
    }

    if (res.writableEnded || res.destroyed) return;

    await sleep(PUMP_POLL_MS);
  }

  touchAccess(session);
  res.status(200);
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(session.playlistPath).pipe(res);
  res.on("close", () => scheduleEndIfIdle(key));
}

/** Serve one finished HLS segment (`seg000.ts`, …). */
export async function serveLiveHlsSegment(
  settings: AppSettings,
  channelNumber: string,
  segmentName: string,
  res: Response,
): Promise<void> {
  if (!HLS_SEGMENT_RE.test(segmentName)) {
    res.status(400).type("text/plain").send("invalid segment");
    return;
  }

  const key = sessionKey(channelNumber);
  const session = await ensureSession(settings, channelNumber);
  touchAccess(session);

  const segPath = path.join(session.workDir, segmentName);
  const resolved = path.resolve(segPath);
  if (!resolved.startsWith(path.resolve(session.workDir) + path.sep)) {
    res.status(400).end();
    return;
  }

  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(resolved)) {
    if (session.exitError) {
      throw new Error(session.exitError);
    }

    if (session.encodeDone) {
      res.status(404).type("text/plain").send("segment not found");
      scheduleEndIfIdle(key);
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${segmentName}`);
    }

    if (res.writableEnded || res.destroyed) return;

    await sleep(PUMP_POLL_MS);
  }

  // Wait until file size is stable briefly so we don't serve a half-written seg.
  let lastSize = -1;
  for (let i = 0; i < 20; i++) {
    const size = fs.statSync(resolved).size;
    if (size > 0 && size === lastSize) break;

    lastSize = size;
    await sleep(25);
  }

  touchAccess(session);
  res.status(200);
  res.setHeader("Content-Type", "video/MP2T");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(resolved, (err) => {
    if (err && !res.headersSent) {
      res.status(500).end();
    }

    scheduleEndIfIdle(key);
  });
}

/** Absolute URL written into Remote Stream YAML for ETV (continuous MPEG-TS). */
export function livePromoUrl(baseUrl: string, channelNumber: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(channelNumber)}/promo.ts`;
}

/** Relative URL for Channels page HLS preview. */
export function livePreviewPath(channelNumber: string): string {
  return `/live/${encodeURIComponent(channelNumber)}/promo.m3u8`;
}

export function formatPromoDuration(totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
