import fs from 'node:fs';
import path from 'node:path';
import { sanitizeChannelFolderName } from '@promo/shared';

export function rewritePath(dbPath: string, etvPrefix: string, localPrefix: string): string {
  if (!dbPath) return dbPath;
  const normalized = dbPath.replace(/\\/g, '/');
  const prefix = etvPrefix.replace(/\\/g, '/').replace(/\/+$/, '');
  const local = localPrefix.replace(/\\/g, '/').replace(/\/+$/, '');
  if (prefix && local && (normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    const rest = normalized.slice(prefix.length);
    return path.normalize(`${local}${rest}`);
  }
  return path.normalize(dbPath);
}

export function promoOutputDir(outputPath: string, channelName: string): string {
  return path.join(outputPath, sanitizeChannelFolderName(channelName));
}

export function promoOutputFile(outputPath: string, channelName: string): string {
  return path.join(promoOutputDir(outputPath, channelName), 'next-items.mp4');
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function findLibraryFile(
  libraryRoot: string,
  title: string,
  season?: number,
  episode?: number,
): string | undefined {
  if (!libraryRoot || !fs.existsSync(libraryRoot)) return undefined;
  const needleTitle = title.toLowerCase().replace(/[^a-z0-9]+/gi, '');
  const seasonEpisode =
    season !== undefined && episode !== undefined
      ? `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}`
      : undefined;

  const videoExt = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.ts', '.m2ts', '.wmv', '.webm']);
  const stack = [libraryRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!videoExt.has(ext)) continue;
      const normalized = entry.name.toLowerCase().replace(/[^a-z0-9]+/gi, '');
      if (!normalized.includes(needleTitle)) continue;
      if (seasonEpisode && !normalized.includes(seasonEpisode)) continue;
      return full;
    }
  }
  return undefined;
}
