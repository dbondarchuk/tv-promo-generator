import express, { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { AppSettings, sanitizeChannelFolderName } from '@promo/shared';
import {
  clearSavedSettings,
  hasSavedSettings,
  loadSettings,
  saveSettings,
  loadChannelOverrides,
  updateChannelOverride,
} from './config.js';
import { invalidateChannelCaches, loadChannelViews } from './services/channels.js';
import {
  backupErsatzTvDatabase,
  getLatestPushBackup,
  listErsatzTvBackups,
} from './services/etv-backup.js';
import { JobQueue } from './services/jobs.js';
import { validateSettings } from './services/validate-settings.js';
import { createLogger } from './util/log.js';

const log = createLogger('http');

export function createRouter(opts: {
  getSettings: () => AppSettings;
  setSettings: (s: AppSettings) => void;
  jobs: JobQueue;
}): Router {
  const router = Router();

  router.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      const payload = { status: res.statusCode, ms };
      // Polling endpoints stay quiet at info; slow/error responses always show.
      if (res.statusCode >= 400 || ms >= 1000 || (req.method !== 'GET')) {
        log.info(`${req.method} ${req.originalUrl}`, payload);
      } else {
        log.debug(`${req.method} ${req.originalUrl}`, payload);
      }
    });
    next();
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/settings', (_req, res) => {
    res.json(opts.getSettings());
  });

  router.get('/settings/status', (_req, res) => {
    res.json({ saved: hasSavedSettings() });
  });

  router.put('/settings', (req, res) => {
    const next = saveSettings({ ...opts.getSettings(), ...req.body });
    opts.setSettings(next);
    invalidateChannelCaches();
    log.info('settings updated');
    res.json(next);
  });

  router.delete('/settings', (_req, res) => {
    const next = clearSavedSettings();
    opts.setSettings(next);
    invalidateChannelCaches();
    log.info('saved settings cleared; using env/defaults');
    res.json(next);
  });

  router.post('/settings/validate', async (req, res) => {
    try {
      const candidate = { ...opts.getSettings(), ...(req.body ?? {}) };
      const result = await validateSettings(candidate);
      res.json(result);
    } catch (err) {
      log.error('POST /settings/validate failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/backups', (_req, res) => {
    try {
      const settings = opts.getSettings();
      res.json({
        backups: listErsatzTvBackups(settings),
        latestPush: getLatestPushBackup(settings),
      });
    } catch (err) {
      log.error('GET /backups failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/backups', async (_req, res) => {
    try {
      const backup = await backupErsatzTvDatabase(opts.getSettings(), 'manual');
      res.json(backup);
    } catch (err) {
      log.error('POST /backups failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/rollback', (req, res) => {
    try {
      const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId : undefined;
      log.info('enqueue rollback ErsatzTV database', { backupId: backupId ?? 'latest' });
      const job = opts.jobs.enqueueRollback(backupId);
      res.json({ job });
    } catch (err) {
      log.error('POST /rollback failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/channels', async (_req, res) => {
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
      log.error('GET /channels failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch('/channels/:number', (req, res) => {
    const overrides = updateChannelOverride(req.params.number, req.body ?? {});
    res.json(overrides[req.params.number]);
  });

  router.get('/channels/overrides', (_req, res) => {
    res.json(loadChannelOverrides());
  });

  router.post('/generate', async (req, res) => {
    try {
      const settings = opts.getSettings();
      const channels = await loadChannelViews(settings);
      const numbers: string[] | undefined = req.body?.channelNumbers;
      const selected = numbers?.length
        ? channels.filter((c) => numbers.includes(c.number))
        : channels.filter((c) => c.enabled);
      log.info('enqueue generate', { count: selected.length, numbers: selected.map((c) => c.number) });
      const jobs = selected.map((c) =>
        opts.jobs.enqueue({
          channelNumber: c.number,
          channelName: c.name,
          preferFront: true,
        }),
      );
      res.json({ jobs });
    } catch (err) {
      log.error('POST /generate failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/generate/:number', async (req, res) => {
    try {
      const settings = opts.getSettings();
      const channels = await loadChannelViews(settings);
      const channel = channels.find((c) => c.number === req.params.number);
      if (!channel) {
        res.status(404).json({ error: 'Channel not found' });
        return;
      }
      log.info('enqueue generate one', { number: channel.number, name: channel.name });
      const job = opts.jobs.enqueue({
        channelNumber: channel.number,
        channelName: channel.name,
        preferFront: true,
      });
      res.json({ job });
    } catch (err) {
      log.error('POST /generate/:number failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/jobs', (_req, res) => {
    res.json(opts.jobs.list());
  });

  router.get('/jobs/stream', (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    const write = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const unsubscribe = opts.jobs.onChange((jobs) => write('jobs', jobs));
    const heartbeat = setInterval(() => {
      res.write(`: ping ${Date.now()}\n\n`);
    }, 25_000);

    log.debug('SSE /jobs/stream connected');
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try { res.end(); } catch { /* already closed */ }
      log.debug('SSE /jobs/stream disconnected');
    };
    req.on('close', close);
  });

  router.post('/push', (_req, res) => {
    try {
      log.info('enqueue push to ErsatzTV');
      const job = opts.jobs.enqueuePush();
      res.json({ job });
    } catch (err) {
      log.error('POST /push failed', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

export function createMediaRouter(getSettings: () => AppSettings): Router {
  const router = Router();
  router.get('/:channelFolder/next-items.mp4', (req, res) => {
    const settings = getSettings();
    const folder = sanitizeChannelFolderName(decodeURIComponent(req.params.channelFolder));
    const filePath = path.join(settings.outputPath, folder, 'next-items.mp4');
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
