import {
  AppSettings,
  FILLER_PLACEMENTS,
  FillerPlacement,
  GraphicsPhase,
  isFillerPlacement,
  isPushOptionsActionable,
  PushOptions,
  sanitizeChannelFolderName,
} from "@promo/shared";
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { downloadLogo, logoCacheFile, resolveLogoUrl } from "./color.js";
import {
  clearSavedSettings,
  isAppConfigured,
  loadChannelOverrides,
  saveSettings,
  updateChannelOverride,
} from "./config.js";
import { EtvApiClient } from "./ersatztv/api.js";
import { parseM3u } from "./ersatztv/m3u.js";
import {
  invalidateChannelCaches,
  loadChannelViews,
  refreshChannelViews,
} from "./services/channels.js";
import {
  backupErsatzTvDatabase,
  getLatestPushBackup,
  listErsatzTvBackups,
} from "./services/etv-backup.js";
import { renderGraphicsOverlayPng } from "./services/graphics-overlay.js";
import { JobQueue } from "./services/jobs.js";
import { serveLiveMpegTs } from "./services/livePromo.js";
import { validateSettings } from "./services/validate-settings.js";
import { createLogger } from "./util/log.js";
import {
  ensureConfiguredPiperVoices,
  invalidatePiperVoiceCache,
} from "./voice/tts.js";

function isGraphicsPhase(value: unknown): value is GraphicsPhase {
  return value === "now" || value === "next";
}

const log = createLogger("http");

/** Coerce Express query values (string | string[] | ParsedQs) to a trim string. */
function queryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (Array.isArray(value) && value.length > 0) {
    return queryString(value[0]);
  }

  return undefined;
}

export function createRouter(opts: {
  getSettings: () => AppSettings;
  setSettings: (s: AppSettings) => void;
  jobs: JobQueue;
}): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.get("/settings", (_req, res) => {
    res.json(opts.getSettings());
  });

  router.get("/settings/status", (_req, res) => {
    const settings = opts.getSettings();
    res.json({
      configured: isAppConfigured(settings),
      voiceEnabled: Boolean(settings.voiceEnabled),
      promoDeliveryMode: settings.promoDeliveryMode ?? "remote-stream",
    });
  });

  router.put("/settings", (req, res) => {
    const current = opts.getSettings();
    const body = { ...(req.body ?? {}) } as Partial<AppSettings>;
    // Infra fields are env-only — ignore client overrides.
    delete body.port;
    delete body.cachePath;
    delete body.configPath;
    const next = saveSettings({ ...current, ...body });
    opts.setSettings(next);
    invalidateChannelCaches();
    invalidatePiperVoiceCache();
    log.info("settings updated");
    res.json(next);

    // Wyoming Piper downloads voice models on first synthesize — kick that off
    // after save so overrides are ready before generate jobs need them.
    if (
      next.voiceEnabled &&
      (next.voiceProvider === "auto" || next.voiceProvider === "piper")
    ) {
      void ensureConfiguredPiperVoices(next).then((results) => {
        const failed = results.filter((r) => !r.ok);
        if (failed.length === 0 && results.length > 0) {
          log.info("piper voices ready", {
            voices: results.map((r) => r.voice),
          });
        } else if (failed.length > 0) {
          log.warn("piper voice download issues", {
            ok: results.filter((r) => r.ok).map((r) => r.voice),
            failed: failed.map((r) => `${r.voice}: ${r.error}`),
          });
        }
      });
    }
  });

  router.delete("/settings", (_req, res) => {
    const next = clearSavedSettings();
    opts.setSettings(next);
    invalidateChannelCaches();
    invalidatePiperVoiceCache();
    log.info("settings reset to defaults");
    res.json(next);
  });

  router.post("/settings/validate", async (req, res) => {
    try {
      const candidate = { ...opts.getSettings(), ...(req.body ?? {}) };
      const result = await validateSettings(candidate);
      res.json(result);
    } catch (err) {
      log.error(
        "POST /settings/validate failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/backups", (_req, res) => {
    try {
      const settings = opts.getSettings();
      res.json({
        backups: listErsatzTvBackups(settings),
        latestPush: getLatestPushBackup(settings),
      });
    } catch (err) {
      log.error(
        "GET /backups failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/backups", async (_req, res) => {
    try {
      const backup = await backupErsatzTvDatabase(opts.getSettings(), "manual");
      res.json(backup);
    } catch (err) {
      log.error(
        "POST /backups failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/rollback", (req, res) => {
    try {
      const backupId =
        typeof req.body?.backupId === "string" ? req.body.backupId : undefined;

      log.info("enqueue rollback ErsatzTV database", {
        backupId: backupId ?? "latest",
      });

      const job = opts.jobs.enqueueRollback(backupId);
      res.json({ job });
    } catch (err) {
      log.error(
        "POST /rollback failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/channels", async (_req, res) => {
    try {
      const settings = opts.getSettings();
      const channels = await loadChannelViews(settings);
      const enriched = channels.map((c) => ({
        ...c,
        lastGeneratedAt: opts.jobs.getLastGenerated(c.number),
        lastError: c.lastError ?? opts.jobs.getLastError(c.number),
      }));

      res.json(enriched);
    } catch (err) {
      log.error(
        "GET /channels failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Bust the 1-minute schedule snapshot and reload from ErsatzTV. */
  router.post("/channels/refresh", async (_req, res) => {
    try {
      const settings = opts.getSettings();
      const channels = await refreshChannelViews(settings);
      const enriched = channels.map((c) => ({
        ...c,
        lastGeneratedAt: opts.jobs.getLastGenerated(c.number),
        lastError: c.lastError ?? opts.jobs.getLastError(c.number),
      }));

      res.json(enriched);
    } catch (err) {
      log.error(
        "POST /channels/refresh failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch("/channels/:number", (req, res) => {
    const overrides = updateChannelOverride(req.params.number, req.body ?? {});
    res.json(overrides[req.params.number]);
  });

  router.get("/channels/overrides", (_req, res) => {
    res.json(loadChannelOverrides());
  });

  /** Bake next-items.mp4 (file delivery mode). */
  router.post("/generate", async (req, res) => {
    try {
      const settings = opts.getSettings();
      const channels = await loadChannelViews(settings);
      const numbers: string[] | undefined = req.body?.channelNumbers;
      const selected = numbers?.length
        ? channels.filter((c) => numbers.includes(c.number))
        : channels.filter((c) => c.enabled);

      log.info("enqueue generate", {
        count: selected.length,
        numbers: selected.map((c) => c.number),
      });

      const jobs = selected.map((c) =>
        opts.jobs.enqueue({
          channelNumber: c.number,
          channelName: c.name,
          preferFront: true,
        }),
      );

      res.json({ jobs });
    } catch (err) {
      log.error(
        "POST /generate failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/generate/:number", async (req, res) => {
    try {
      const settings = opts.getSettings();
      const channels = await loadChannelViews(settings);
      const channel = channels.find((c) => c.number === req.params.number);
      if (!channel) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }

      log.info("enqueue generate one", {
        number: channel.number,
        name: channel.name,
      });

      const job = opts.jobs.enqueue({
        channelNumber: channel.number,
        channelName: channel.name,
        preferFront: true,
      });

      res.json({ job });
    } catch (err) {
      log.error(
        "POST /generate/:number failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Manual VO prewarm (remote-stream delivery; optional in file mode). */
  router.post("/vo-prewarm", async (req, res) => {
    try {
      const settings = opts.getSettings();
      if (!settings.voiceEnabled) {
        res.status(400).json({ error: "Voice-over is disabled in Settings" });
        return;
      }

      const channels = await loadChannelViews(settings);
      const numbers: string[] | undefined = req.body?.channelNumbers;
      const selected = numbers?.length
        ? channels.filter((c) => numbers.includes(c.number))
        : channels.filter((c) => c.enabled);

      log.info("enqueue vo-prewarm", {
        count: selected.length,
        numbers: selected.map((c) => c.number),
      });

      const jobs = selected.map((c) =>
        opts.jobs.enqueueVoPrewarm({
          channelNumber: c.number,
          channelName: c.name,
        }),
      );

      res.json({ jobs });
    } catch (err) {
      log.error(
        "POST /vo-prewarm failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/vo-prewarm/:number", async (req, res) => {
    try {
      const settings = opts.getSettings();
      if (!settings.voiceEnabled) {
        res.status(400).json({ error: "Voice-over is disabled in Settings" });
        return;
      }

      const channels = await loadChannelViews(settings);
      const channel = channels.find((c) => c.number === req.params.number);
      if (!channel) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }

      log.info("enqueue vo-prewarm one", {
        number: channel.number,
        name: channel.name,
      });

      const job = opts.jobs.enqueueVoPrewarm({
        channelNumber: channel.number,
        channelName: channel.name,
      });

      res.json({ job });
    } catch (err) {
      log.error(
        "POST /vo-prewarm/:number failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/jobs", (_req, res) => {
    res.json(opts.jobs.list());
  });

  router.get("/jobs/stream", (req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (
      typeof (res as { flushHeaders?: () => void }).flushHeaders === "function"
    ) {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    const write = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const unsubscribe = opts.jobs.onChange((jobs) => write("jobs", jobs));
    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 25_000);

    log.debug("SSE /jobs/stream connected");
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        /* already closed */
      }

      log.debug("SSE /jobs/stream disconnected");
    };

    req.on("close", close);
  });

  router.post("/push", (req, res) => {
    try {
      const raw = req.body?.fillerTypes;
      if (raw != null && !Array.isArray(raw)) {
        res.status(400).json({ error: "fillerTypes must be an array" });
        return;
      }

      const fillerTypes: FillerPlacement[] = [];
      for (const value of raw ?? []) {
        if (!isFillerPlacement(value)) {
          res.status(400).json({
            error: `Invalid filler type "${String(value)}"; expected: ${FILLER_PLACEMENTS.join(", ")}`,
          });

          return;
        }

        if (!fillerTypes.includes(value)) fillerTypes.push(value);
      }

      const pushOptions: PushOptions = {
        fillerTypes,
        cleanupLegacy: Boolean(req.body?.cleanupLegacy),
        cleanupUnselected: Boolean(req.body?.cleanupUnselected),
      };

      if (!isPushOptionsActionable(pushOptions)) {
        res.status(400).json({
          error:
            "Select at least one filler type, or enable cleanupLegacy / cleanupUnselected",
        });

        return;
      }

      log.info("enqueue push to ErsatzTV", pushOptions);
      const job = opts.jobs.enqueuePush(pushOptions);
      res.json({ job });
    } catch (err) {
      log.error(
        "POST /push failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/push-graphics", (_req, res) => {
    try {
      log.info("enqueue push graphics");
      const job = opts.jobs.enqueuePushGraphics();
      res.json({ job });
    } catch (err) {
      log.error(
        "POST /push-graphics failed",
        err instanceof Error ? err.message : String(err),
      );

      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

/** On-demand Now/Mid/Next overlay PNGs for ETV graphics engine. */
export function createGraphicsRouter(getSettings: () => AppSettings): Router {
  const router = Router();

  router.get("/overlay.png", async (req, res) => {
    const phaseRaw = queryString(req.query.phase) ?? "now";
    const mediaItemRaw = Number(queryString(req.query.mediaItemId));
    const mediaItemId =
      Number.isFinite(mediaItemRaw) && mediaItemRaw > 0
        ? mediaItemRaw
        : undefined;

    const at = queryString(req.query.at);
    const channelNumber = queryString(req.query.channelNumber);
    const channelName = queryString(req.query.channelName);
    const language = queryString(req.query.language);

    log.info("graphics overlay request", {
      phase: phaseRaw,
      mediaItemId: mediaItemId ?? null,
      at: at ?? null,
      channelNumber: channelNumber ?? null,
      query: req.query,
    });

    try {
      const settings = getSettings();
      if (!isGraphicsPhase(phaseRaw)) {
        const message = "phase must be now|next";
        log.warn("graphics overlay rejected", { reason: message, phaseRaw });
        res.status(400).type("text/plain").send(message);
        return;
      }

      if (!mediaItemId && !channelNumber) {
        const message = "channelNumber or mediaItemId is required";
        log.warn("graphics overlay rejected", {
          reason: message,
          query: req.query,
        });

        res.status(400).type("text/plain").send(message);
        return;
      }

      const png = await renderGraphicsOverlayPng(settings, phaseRaw, {
        mediaItemId,
        at,
        channelNumber,
        channelName,
        language,
      });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=30");
      res.send(png);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("graphics overlay failed", {
        message,
        phase: phaseRaw,
        mediaItemId: mediaItemId ?? null,
        at: at ?? null,
        channelNumber: channelNumber ?? null,
        query: req.query,
      });

      if (!res.headersSent) {
        res.status(500).type("text/plain").send(message);
      }
    }
  });

  return router;
}

export function createMediaRouter(getSettings: () => AppSettings): Router {
  const router = Router();

  router.get("/logos/:channelNumber", async (req, res) => {
    try {
      const settings = getSettings();
      const channelNumber = sanitizeChannelFolderName(
        decodeURIComponent(req.params.channelNumber),
      );

      const cached = logoCacheFile(settings.cachePath, channelNumber);
      const cacheRoot = path.resolve(settings.cachePath, "logos");
      const resolvedCache = path.resolve(cached);

      if (!resolvedCache.startsWith(cacheRoot)) {
        res.status(400).end();
        return;
      }

      if (!fs.existsSync(resolvedCache)) {
        const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);
        const m3u = parseM3u(await api.getM3u());
        const channel = m3u.find(
          (c) => sanitizeChannelFolderName(c.number) === channelNumber,
        );

        if (!channel?.logoUrl) {
          res.status(404).end();
          return;
        }

        const downloaded = await downloadLogo(
          resolveLogoUrl(channel.logoUrl, settings.etvUrl),
          cacheRoot,
          channelNumber,
        );

        if (!downloaded) {
          res.status(404).end();
          return;
        }
      }

      res.setHeader("Cache-Control", "public, max-age=3600");
      res.sendFile(resolvedCache);
    } catch (err) {
      log.error(
        "GET /media/logos failed",
        err instanceof Error ? err.message : String(err),
      );

      res.status(500).end();
    }
  });

  router.get("/:channelFolder/next-items.mp4", (req, res) => {
    const settings = getSettings();
    const folder = sanitizeChannelFolderName(
      decodeURIComponent(req.params.channelFolder),
    );

    const filePath = path.join(settings.outputPath, folder, "next-items.mp4");
    const resolved = path.resolve(filePath);
    const root = path.resolve(settings.outputPath);
    if (!resolved.startsWith(root) || !fs.existsSync(resolved)) {
      res.status(404).end();
      return;
    }

    res.sendFile(resolved);
  });

  return router;
}

/** Live MPEG-TS for ETV Remote Stream and Channels UI preview. */
export function createLiveRouter(getSettings: () => AppSettings): Router {
  const router = Router();

  async function handleLiveError(
    channelNumber: string,
    kind: string,
    res: import("express").Response,
    err: unknown,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    log.error("live promo failed", { channelNumber, kind, message });
    if (!res.headersSent) {
      res.status(503).type("text/plain").send(message);
    } else {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  }

  router.get("/:channelNumber/promo.ts", async (req, res) => {
    const channelNumber = decodeURIComponent(req.params.channelNumber);
    const settings = getSettings();
    log.info("live promo open", { channelNumber, container: "mpegts" });

    try {
      await serveLiveMpegTs(settings, channelNumber, res);
    } catch (err) {
      await handleLiveError(channelNumber, "mpegts", res, err);
    }
  });

  return router;
}
