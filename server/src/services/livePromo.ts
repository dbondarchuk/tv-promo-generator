import { AppSettings } from "@promo/shared";
import type { Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { LivePromoContainer, startLivePromoEncode } from "../promo/render.js";
import { createLogger } from "../util/log.js";
import { markVoiceHashesInUse, releaseVoiceHashes } from "../voice/ledger.js";
import { buildPromoChaptersForChannel, getFontFile } from "./channels.js";

const log = createLogger("live-promo");

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
}

const sessions = new Map<string, LiveSession>();

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

function endSession(key: string): void {
  const session = sessions.get(key);
  if (!session) return;

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

  log.info("live session ended", {
    channel: session.channelNumber,
    container: session.container,
  });
}

function writeLiveHeaders(res: Response, contentType: string): void {
  res.status(200);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
}

/**
 * Attach an HTTP response to a per-channel live promo encode.
 * VO is cache-only (skipped if not warm). One ffmpeg per channel+container.
 * Use `mpegts` for ErsatzTV Remote Streams; `fmp4` for HTML5 preview.
 */
export async function attachLivePromoStream(
  settings: AppSettings,
  channelNumber: string,
  res: Response,
  container: LivePromoContainer = "mpegts",
): Promise<void> {
  const key = sessionKey(channelNumber, container);
  const contentType = contentTypeFor(container);
  const existing = sessions.get(key);
  if (existing) {
    writeLiveHeaders(res, existing.contentType);
    existing.readers.add(res);
    res.on("close", () => {
      existing.readers.delete(res);
      if (existing.readers.size === 0) endSession(key);
    });

    return;
  }

  const built = await buildPromoChaptersForChannel(settings, channelNumber);
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
      onProgress: (message, level) => {
        if (level === "warn") log.warn(message, { channel: channelNumber });
        else log.info(message, { channel: channelNumber });
      },
    },
    container,
  );

  markVoiceHashesInUse(live.voiceHashes);

  const session: LiveSession = {
    key,
    channelNumber,
    container,
    startedAt: Date.now(),
    readers: new Set([res]),
    voiceHashes: live.voiceHashes,
    workDir: live.workDir,
    contentType,
    childKill: () => {
      try {
        live.process.kill("SIGKILL");
      } catch {
        // ignore
      }
    },
  };

  sessions.set(key, session);
  writeLiveHeaders(res, contentType);

  const stderrChunks: Buffer[] = [];
  live.process.stderr.on("data", (d: Buffer) => {
    stderrChunks.push(d);
    if (stderrChunks.length > 40) stderrChunks.shift();
  });

  live.process.stdout.on("data", (chunk: Buffer) => {
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
  });

  live.process.on("close", (code) => {
    if (code && code !== 0) {
      const errText = Buffer.concat(stderrChunks).toString("utf8").slice(-2000);
      log.error("live ffmpeg exited", {
        channel: channelNumber,
        container,
        code,
        stderr: errText,
      });
    }

    endSession(key);
  });

  live.process.on("error", (err) => {
    log.error("live ffmpeg spawn error", {
      channel: channelNumber,
      container,
      err: err.message,
    });

    endSession(key);
  });

  res.on("close", () => {
    session.readers.delete(res);
    if (session.readers.size === 0) endSession(key);
  });

  log.info("live session started", {
    channel: channelNumber,
    name: built.channelName,
    container,
    vo: live.voiceHashes.length > 0,
  });
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
