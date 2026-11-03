import fs from 'node:fs';
import path from 'node:path';
import {
  AppSettings,
  SettingsCheck,
  ValidateSettingsResult,
  parseResolution,
} from '@promo/shared';
import { EtvApiClient } from '../ersatztv/api.js';
import { loadSchema, openDb, resetSchemaCache } from '../ersatztv/db.js';
import { resolveFfmpegBinaries } from '../ffmpeg/binaries.js';
import { createLogger } from '../util/log.js';

const log = createLogger('validate');

function check(id: string, label: string, ok: boolean, message: string): SettingsCheck {
  return { id, label, ok, message };
}

function dirStatus(dir: string, label: string, createHint: boolean): SettingsCheck {
  const id = label;
  const resolved = path.resolve(dir || '');
  if (!dir?.trim()) {
    return check(id, label, false, 'Path is empty');
  }
  if (fs.existsSync(resolved)) {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) {
      return check(id, label, false, `Not a directory: ${resolved}`);
    }
    try {
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
      return check(id, label, true, resolved);
    } catch {
      return check(id, label, false, `Not writable: ${resolved}`);
    }
  }
  if (createHint) {
    return check(id, label, true, `Will be created: ${resolved}`);
  }
  return check(id, label, false, `Missing: ${resolved}`);
}

export async function validateSettings(settings: AppSettings): Promise<ValidateSettingsResult> {
  const checks: SettingsCheck[] = [];

  try {
    const url = new URL(settings.etvUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      checks.push(check('etvUrl', 'ErsatzTV URL', false, `Unsupported protocol: ${url.protocol}`));
    } else {
      checks.push(check('etvUrl', 'ErsatzTV URL', true, url.toString()));
    }
  } catch {
    checks.push(check('etvUrl', 'ErsatzTV URL', false, 'Invalid URL'));
  }

  checks.push(
    settings.etvApiKey.trim()
      ? check('etvApiKey', 'API key', true, 'Set')
      : check('etvApiKey', 'API key', true, 'Empty — OK if ErsatzTV auth is disabled'),
  );

  const dbPath = settings.etvDatabase?.trim();
  if (!dbPath) {
    checks.push(check('etvDatabase', 'Database path', false, 'Not configured'));
  } else if (!fs.existsSync(dbPath)) {
    checks.push(check('etvDatabase', 'Database path', false, `File not found: ${dbPath}`));
  } else {
    try {
      resetSchemaCache();
      const db = openDb(dbPath, true);
      try {
        const schema = loadSchema(db);
        const required = ['Channel', 'Playout', 'ProgramScheduleItem', 'FillerPreset', 'Library'];
        const missing = required.filter((t) => !schema.tables.has(t));
        if (missing.length) {
          checks.push(
            check('etvDatabase', 'Database path', false, `Missing tables: ${missing.join(', ')}`),
          );
        } else {
          checks.push(check('etvDatabase', 'Database path', true, `Readable SQLite (${dbPath})`));
        }
      } finally {
        db.close();
      }
    } catch (err) {
      checks.push(
        check(
          'etvDatabase',
          'Database path',
          false,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  checks.push(dirStatus(settings.libraryPath, 'Library path', false));
  checks.push(dirStatus(settings.outputPath, 'Output path', true));
  checks.push(dirStatus(settings.cachePath, 'Cache path', true));
  checks.push(dirStatus(settings.etvLibraryPath || settings.outputPath, 'ETV library path', true));

  if (settings.etvPathPrefix && !settings.libraryPath) {
    checks.push(
      check(
        'etvPathPrefix',
        'Path rewrite',
        false,
        'etvPathPrefix is set but libraryPath is empty',
      ),
    );
  } else if (settings.etvPathPrefix) {
    checks.push(
      check(
        'etvPathPrefix',
        'Path rewrite',
        true,
        `${settings.etvPathPrefix} → ${settings.libraryPath}`,
      ),
    );
  } else {
    checks.push(check('etvPathPrefix', 'Path rewrite', true, 'Not set (paths used as-is)'));
  }

  const res = parseResolution(settings.resolution);
  const resOk = /^\d+x\d+$/i.test(settings.resolution.trim());
  checks.push(
    check(
      'resolution',
      'Resolution',
      resOk,
      resOk ? `${res.width}x${res.height}` : `Invalid "${settings.resolution}"`,
    ),
  );

  const bitrateOk =
    Number.isFinite(settings.videoBitrate) &&
    settings.videoBitrate > 0 &&
    Number.isFinite(settings.audioBitrate) &&
    settings.audioBitrate > 0;
  checks.push(
    check(
      'bitrate',
      'Bitrates',
      bitrateOk,
      bitrateOk
        ? `video ${settings.videoBitrate} / audio ${settings.audioBitrate} kbps`
        : 'videoBitrate and audioBitrate must be positive',
    ),
  );

  const portOk =
    Number.isInteger(settings.port) && settings.port >= 1 && settings.port <= 65535;
  checks.push(
    check('port', 'HTTP port', portOk, portOk ? String(settings.port) : 'Must be 1–65535'),
  );

  const leadOk =
    Number.isFinite(settings.regenLeadMinutes) && settings.regenLeadMinutes >= 0;
  checks.push(
    check(
      'regenLeadMinutes',
      'Regen lead',
      leadOk,
      leadOk ? `${settings.regenLeadMinutes} min` : 'Must be ≥ 0',
    ),
  );

  try {
    const bins = resolveFfmpegBinaries();
    const { spawnSync } = await import('node:child_process');
    const ff = spawnSync(bins.ffmpeg, ['-version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    const fp = spawnSync(bins.ffprobe, ['-version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (ff.status === 0 && fp.status === 0) {
      const ver = (ff.stdout || '').split('\n')[0]?.trim() || bins.ffmpeg;
      checks.push(check('ffmpeg', 'ffmpeg / ffprobe', true, `${ver} (${bins.source})`));
    } else {
      checks.push(
        check(
          'ffmpeg',
          'ffmpeg / ffprobe',
          false,
          `Not runnable (ffmpeg=${bins.ffmpeg}, ffprobe=${bins.ffprobe})`,
        ),
      );
    }
  } catch (err) {
    checks.push(
      check('ffmpeg', 'ffmpeg / ffprobe', false, err instanceof Error ? err.message : String(err)),
    );
  }

  if (checks.find((c) => c.id === 'etvUrl')?.ok) {
    try {
      const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey, 8_000);
      const channels = await api.getChannels();
      checks.push(
        check(
          'etvReachable',
          'ErsatzTV API',
          true,
          `Reachable — ${channels.length} channel(s)`,
        ),
      );
    } catch (err) {
      checks.push(
        check(
          'etvReachable',
          'ErsatzTV API',
          false,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  } else {
    checks.push(check('etvReachable', 'ErsatzTV API', false, 'Skipped — invalid URL'));
  }

  const ok = checks.every((c) => c.ok);
  log.info('settings validated', { ok, failed: checks.filter((c) => !c.ok).map((c) => c.id) });
  return { ok, checks };
}
