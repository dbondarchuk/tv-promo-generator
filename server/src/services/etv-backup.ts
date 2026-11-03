import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppSettings, EtvBackupInfo, RollbackResult } from '@promo/shared';
import { openDb } from '../ersatztv/db.js';
import { createLogger } from '../util/log.js';

const log = createLogger('etv-backup');
const MAX_BACKUPS = 15;
const META_NAME = 'latest-push.json';

function backupsRoot(settings: AppSettings): string {
  return path.join(path.resolve(settings.configPath), 'backups');
}

function ensureBackupsDir(settings: AppSettings): string {
  const dir = backupsRoot(settings);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metaPath(settings: AppSettings): string {
  return path.join(backupsRoot(settings), META_NAME);
}

function backupFilePath(dir: string, id: string): string {
  return path.join(dir, `ersatztv-${id}.sqlite3`);
}

function sidecars(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

function readInfo(filePath: string): EtvBackupInfo | null {
  const infoPath = `${filePath}.json`;
  if (!fs.existsSync(infoPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(infoPath, 'utf8')) as EtvBackupInfo;
  } catch {
    return null;
  }
}

function writeInfo(info: EtvBackupInfo): void {
  fs.writeFileSync(`${info.path}.json`, JSON.stringify(info, null, 2), 'utf8');
}

function pruneOldBackups(dir: string): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('ersatztv-') && f.endsWith('.sqlite3'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of files.slice(MAX_BACKUPS)) {
    try {
      fs.unlinkSync(stale.full);
      const info = `${stale.full}.json`;
      if (fs.existsSync(info)) fs.unlinkSync(info);
    } catch (err) {
      log.warn('failed to prune backup', {
        file: stale.full,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Online SQLite backup of ersatztv.sqlite3 into config/backups. */
export async function backupErsatzTvDatabase(
  settings: AppSettings,
  reason: EtvBackupInfo['reason'] = 'manual',
): Promise<EtvBackupInfo> {
  const sourcePath = path.resolve(settings.etvDatabase);
  if (!settings.etvDatabase?.trim()) {
    throw new Error('ErsatzTV database path is not configured');
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`ErsatzTV database not found: ${sourcePath}`);
  }

  const dir = ensureBackupsDir(settings);
  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[:.]/g, '-');
  const destPath = backupFilePath(dir, id);

  log.info('backing up ErsatzTV database', { sourcePath, destPath, reason });

  const source = openDb(sourcePath, true);
  try {
    await source.backup(destPath);
  } finally {
    source.close();
  }

  const bytes = fs.statSync(destPath).size;
  const info: EtvBackupInfo = {
    id,
    createdAt,
    sourcePath,
    path: destPath,
    bytes,
    reason,
  };
  writeInfo(info);

  if (reason === 'pre-push') {
    fs.writeFileSync(metaPath(settings), JSON.stringify(info, null, 2), 'utf8');
  }

  pruneOldBackups(dir);
  log.info('backup complete', { id, bytes });
  return info;
}

export function listErsatzTvBackups(settings: AppSettings): EtvBackupInfo[] {
  const dir = backupsRoot(settings);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('ersatztv-') && f.endsWith('.sqlite3'))
    .map((f) => {
      const full = path.join(dir, f);
      const fromMeta = readInfo(full);
      if (fromMeta) return fromMeta;
      const id = f.replace(/^ersatztv-/, '').replace(/\.sqlite3$/, '');
      const st = fs.statSync(full);
      return {
        id,
        createdAt: st.mtime.toISOString(),
        sourcePath: settings.etvDatabase,
        path: full,
        bytes: st.size,
        reason: 'manual' as const,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getLatestPushBackup(settings: AppSettings): EtvBackupInfo | null {
  const meta = metaPath(settings);
  if (fs.existsSync(meta)) {
    try {
      const info = JSON.parse(fs.readFileSync(meta, 'utf8')) as EtvBackupInfo;
      if (info.path && fs.existsSync(info.path)) return info;
    } catch {
      // fall through to listing
    }
  }
  return listErsatzTvBackups(settings).find((b) => b.reason === 'pre-push') ?? null;
}

function resolveBackup(settings: AppSettings, backupId?: string): EtvBackupInfo {
  if (backupId) {
    const match = listErsatzTvBackups(settings).find((b) => b.id === backupId);
    if (!match) throw new Error(`Backup not found: ${backupId}`);
    return match;
  }
  const latest = getLatestPushBackup(settings) ?? listErsatzTvBackups(settings)[0];
  if (!latest) throw new Error('No ErsatzTV backups found');
  return latest;
}

/**
 * Restore ersatztv.sqlite3 from a backup using SQLite's online backup API.
 * If ErsatzTV holds a hard lock, stop it briefly and retry.
 */
export async function rollbackErsatzTvDatabase(
  settings: AppSettings,
  backupId?: string,
): Promise<RollbackResult> {
  const backup = resolveBackup(settings, backupId);
  const destPath = path.resolve(settings.etvDatabase);

  if (!settings.etvDatabase?.trim()) {
    throw new Error('ErsatzTV database path is not configured');
  }
  if (!fs.existsSync(backup.path)) {
    throw new Error(`Backup file missing: ${backup.path}`);
  }

  log.info('rolling back ErsatzTV database', {
    backupId: backup.id,
    from: backup.path,
    to: destPath,
  });

  const safetyDir = ensureBackupsDir(settings);
  const safetyId = `pre-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const safetyPath = backupFilePath(safetyDir, safetyId);

  if (fs.existsSync(destPath)) {
    try {
      const live = openDb(destPath, true);
      try {
        await live.backup(safetyPath);
      } finally {
        live.close();
      }
      writeInfo({
        id: safetyId,
        createdAt: new Date().toISOString(),
        sourcePath: destPath,
        path: safetyPath,
        bytes: fs.statSync(safetyPath).size,
        reason: 'manual',
      });
    } catch (err) {
      log.warn('could not snapshot live DB before rollback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const tmpPath = `${destPath}.promo-restore-tmp`;
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

  const source = new Database(backup.path, { readonly: true, fileMustExist: true, timeout: 10_000 });
  try {
    source.pragma('busy_timeout = 10000');
    await source.backup(tmpPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read backup ${backup.id}: ${message}`);
  } finally {
    source.close();
  }

  try {
    for (const side of sidecars(destPath)) {
      if (fs.existsSync(side)) fs.unlinkSync(side);
    }
    fs.copyFileSync(tmpPath, destPath);
    fs.unlinkSync(tmpPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Rollback failed (is ErsatzTV locking the DB?): ${message}. ` +
        `Stop ErsatzTV, restore again, then start it.`,
    );
  }

  const message =
    `Restored ${path.basename(destPath)} from backup ${backup.id}. ` +
    `Restart or reset playouts in ErsatzTV if channels look stale.`;
  log.info('rollback complete', { backupId: backup.id });
  return { ok: true, backup, message };
}
