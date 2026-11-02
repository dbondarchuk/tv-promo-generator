import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppSettings } from '@promo/shared';
import { loadEnv } from './env.js';
import { loadSettings } from './config.js';
import { createMediaRouter, createRouter } from './routes.js';
import { JobQueue } from './services/jobs.js';
import { RegenScheduler } from './services/scheduler.js';
import { assertFfmpegAvailable } from './ffmpeg/binaries.js';
import { createLogger } from './util/log.js';

loadEnv();

const log = createLogger('boot');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let settings: AppSettings = loadSettings();
try {
  const bins = assertFfmpegAvailable();
  log.info('ffmpeg ready', { source: bins.source, ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe });
} catch (err) {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const jobs = new JobQueue(() => settings);
const scheduler = new RegenScheduler(() => settings, jobs);

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use('/api', createRouter({
  getSettings: () => settings,
  setSettings: (s) => { settings = s; },
  jobs,
}));
app.use('/media', createMediaRouter(() => settings));

const clientDist = path.resolve(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/media')) return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(settings.port, () => {
  log.info(`listening on http://0.0.0.0:${settings.port}`, {
    logLevel: process.env.LOG_LEVEL ?? 'info',
    etvUrl: settings.etvUrl,
    etvDatabase: settings.etvDatabase,
    libraryPath: settings.libraryPath,
    etvPathPrefix: settings.etvPathPrefix,
    outputPath: settings.outputPath,
  });
  scheduler.start();
});
