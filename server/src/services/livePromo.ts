import { AppSettings } from "@promo/shared";
import type { Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { createFfmpegProgressReporter } from "../ffmpeg/progress.js";
import { LivePromoContainer, startLivePromoEncode } from "../promo/render.js";
import { createLogger } from "../util/log.js";
import { markVoiceHashesInUse, releaseVoiceHashes } from "../voice/ledger.js";
import {
  buildPromoChaptersForChannel,
  ensureChannelScheduleForLive,
  getFontFile,
} from "./channels.js";
import type { JobQueue } from "./jobs.js";

const log = createLogger("live-promo");

/** Keep encode alive briefly so ETV probe/reconnect does not kill ffmpeg. */
const DISCONNECT_GRACE_MS = 5_000;
/** Replay this much from stream start for late joiners (PAT/PMT / fMP4 init). */
const PRIMING_BUF_MAX = 512 * 1024;

interface LiveSession {
  key: string;
  channelNumber: string;
  container: LivePromoContainer;
  startedAt: number;
  readers: Set<Response>;
  childKill: () => void;
  voiceHashes: string[];
  workDir: string;
  contentType: string;
  jobId?: string;
  exitError?: string;
  endTimer?: NodeJS.Timeout;
  /** First bytes of the mux — replayed when a client joins mid-encode. */
  primingBuf: Buffer[];
  primingBytes: number;
}

const sessions = new Map<string, LiveSession>();
/** In-flight session startups — concurrent opens await the same encode. */
const starting = new Map<string, Promise<LiveSession>>();
let jobQueue: JobQueue | null = null;

/** Wire JobQueue so live encodes show up in the Jobs UI. */
export function setLivePromoJobs(jobs: JobQueue): void {
  jobQueue = jobs;
}

function sessionKey(
  channelNumber: string,
  container: LivePromoContainer,
): string {
  return `${channelNumber}:${container}`;
}

function contentTypeFor(container: LivePromoContainer): string {
  return container === "fmp4" ? "video/mp4" : "video/MP2T";
}

function liveWorkDir(
  cachePath: string,
  channelNumber: string,
  container: LivePromoContainer,
): string {
  return path.join(
    cachePath,
    "work",
    "live",
    channelNumber,
    container,
    String(Date.now()),
  );
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

  for (const res of session.readers) {
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // ignore
    }
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

  log.info("live session ended", {
    channel: session.channelNumber,
    container: session.container,
  });
}

function scheduleEndIfEmpty(key: string): void {
  const session = sessions.get(key);
  if (!session || session.readers.size > 0) return;

  cancelScheduledEnd(session);
  log.info("live session empty — grace before stop", {
    channel: session.channelNumber,
    container: session.container,
    graceMs: DISCONNECT_GRACE_MS,
  });

  session.endTimer = setTimeout(() => {
    const current = sessions.get(key);
    if (current && current.readers.size === 0) {
      endSession(key);
    }
  }, DISCONNECT_GRACE_MS);
}

function writeLiveHeaders(res: Response, contentType: string): void {
  if (res.headersSent) return;

  res.status(200);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
}

function attachReader(session: LiveSession, res: Response, key: string): void {
  cancelScheduledEnd(session);
  writeLiveHeaders(res, session.contentType);

  // fMP4 late joiners need the init segment; MPEG-TS relies on periodic PAT/PMT
  // (replaying from t=0 would discontinuity-crash ETV).
  if (session.container === "fmp4") {
    for (const chunk of session.primingBuf) {
      if (res.writableEnded || res.destroyed) break;

      try {
        res.write(chunk);
      } catch {
        break;
      }
    }
  }

  session.readers.add(res);
  if (session.jobId && jobQueue) {
    jobQueue.logLiveStream(
      session.jobId,
      "info",
      `Client connected (${session.readers.size} reader(s))`,
    );
  }

  res.on("close", () => {
    session.readers.delete(res);
    scheduleEndIfEmpty(key);
  });
}

async function createLiveSession(
  settings: AppSettings,
  channelNumber: string,
  container: LivePromoContainer,
  key: string,
): Promise<LiveSession> {
  const contentType = contentTypeFor(container);
  const slice = await ensureChannelScheduleForLive(settings, channelNumber);
  const channelName = slice.channelName;

  const job = jobQueue?.beginLiveStream({
    channelNumber,
    channelName,
    container,
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

    const workDir = liveWorkDir(settings.cachePath, channelNumber, container);
    fs.mkdirSync(workDir, { recursive: true });

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
      container,
    );

    markVoiceHashesInUse(live.voiceHashes);

    const session: LiveSession = {
      key,
      channelNumber,
      container,
      startedAt: Date.now(),
      readers: new Set(),
      voiceHashes: live.voiceHashes,
      workDir: live.workDir,
      contentType,
      jobId: job?.id,
      primingBuf: [],
      primingBytes: 0,
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
      `Streaming · VO ${live.voiceHashes.length > 0 ? "on" : "off"} · ${built.chapters.length} chapter(s)`,
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

    live.process.stdout.on("data", (chunk: Buffer) => {
      if (session.primingBytes < PRIMING_BUF_MAX) {
        session.primingBuf.push(chunk);
        session.primingBytes += chunk.length;
      }

      for (const reader of [...session.readers]) {
        if (reader.writableEnded || reader.destroyed) {
          session.readers.delete(reader);
          continue;
        }

        try {
          reader.write(chunk);
        } catch {
          session.readers.delete(reader);
        }
      }

      if (session.readers.size === 0) {
        scheduleEndIfEmpty(key);
      }
    });

    live.process.on("close", (code) => {
      if (code && code !== 0) {
        const errText = Buffer.concat(stderrChunks)
          .toString("utf8")
          .slice(-2000);

        session.exitError = `ffmpeg exited ${code}`;
        log.error("live ffmpeg exited", {
          channel: channelNumber,
          container,
          code,
          stderr: errText,
        });

        if (errText) progress(errText.slice(-500), "error");
      }

      endSession(key);
    });

    live.process.on("error", (err) => {
      session.exitError = err.message;
      log.error("live ffmpeg spawn error", {
        channel: channelNumber,
        container,
        err: err.message,
      });

      endSession(key);
    });

    log.info("live session started", {
      channel: channelNumber,
      name: built.channelName,
      container,
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

/**
 * Attach an HTTP response to a per-channel live promo encode.
 * VO is cache-only (skipped if not warm). One ffmpeg per channel+container.
 * Concurrent opens share the startup; brief disconnects get a grace period.
 */
export async function attachLivePromoStream(
  settings: AppSettings,
  channelNumber: string,
  res: Response,
  container: LivePromoContainer = "mpegts",
  retry = false,
): Promise<void> {
  const key = sessionKey(channelNumber, container);

  const existing = sessions.get(key);
  if (existing) {
    attachReader(existing, res, key);
    return;
  }

  let pending = starting.get(key);
  if (!pending) {
    pending = createLiveSession(settings, channelNumber, container, key);
    starting.set(key, pending);
    void pending.finally(() => {
      if (starting.get(key) === pending) starting.delete(key);
    });
  } else {
    log.info("live session startup in progress — waiting", {
      channel: channelNumber,
      container,
    });
  }

  try {
    const session = await pending;
    if (!sessions.has(key)) {
      if (retry) {
        throw new Error("Live session ended before client could attach");
      }

      // Encode died during startup wait — one fresh retry.
      return attachLivePromoStream(
        settings,
        channelNumber,
        res,
        container,
        true,
      );
    }

    attachReader(session, res, key);
  } catch (err) {
    if (!res.headersSent) {
      throw err;
    }

    try {
      res.end();
    } catch {
      // ignore
    }
  }
}

export function livePromoUrl(baseUrl: string, channelNumber: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(channelNumber)}/promo.ts`;
}

/** Relative URL for Channels page HTML5 preview (fragmented MP4). */
export function livePreviewPath(channelNumber: string): string {
  return `/live/${encodeURIComponent(channelNumber)}/preview.mp4`;
}

export function formatPromoDuration(totalSeconds: number): string {
  const s = Math.max(1, Math.round(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
