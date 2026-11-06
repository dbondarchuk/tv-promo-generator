import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../util/log.js";
import { voiceCacheDir } from "./tts.js";

const log = createLogger("voice-ledger");

/** Keep previous current + current + look-ahead. */
export const VO_LEDGER_MAX_GENERATIONS = 3;

export interface VoiceLedgerGeneration {
  fingerprint: string;
  hashes: string[];
  at: string;
}

export interface VoiceLedgerFile {
  channels: Record<string, { generations: VoiceLedgerGeneration[] }>;
}

const inUseHashes = new Set<string>();

export function markVoiceHashesInUse(hashes: string[]): void {
  for (const h of hashes) inUseHashes.add(h);
}

export function releaseVoiceHashes(hashes: string[]): void {
  for (const h of hashes) inUseHashes.delete(h);
}

function ledgerPath(cachePath: string): string {
  return path.join(voiceCacheDir(cachePath), "ledger.json");
}

export function loadVoiceLedger(cachePath: string): VoiceLedgerFile {
  const file = ledgerPath(cachePath);
  try {
    if (!fs.existsSync(file)) return { channels: {} };

    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as VoiceLedgerFile;
    if (!raw || typeof raw !== "object" || !raw.channels) {
      return { channels: {} };
    }

    return raw;
  } catch {
    return { channels: {} };
  }
}

function saveVoiceLedger(cachePath: string, ledger: VoiceLedgerFile): void {
  const dir = voiceCacheDir(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    ledgerPath(cachePath),
    JSON.stringify(ledger, null, 2),
    "utf8",
  );
}

/**
 * Record a VO warm generation for a channel fingerprint and prune older ones.
 * Deletes unreferenced `.wav` / `.parts` under the voice cache.
 */
export function recordVoiceGeneration(
  cachePath: string,
  channelNumber: string,
  fingerprint: string,
  hashes: string[],
): void {
  const ledger = loadVoiceLedger(cachePath);
  const entry = ledger.channels[channelNumber] ?? { generations: [] };
  const uniqueHashes = [...new Set(hashes.filter(Boolean))];
  const withoutDup = entry.generations.filter(
    (g) => g.fingerprint !== fingerprint,
  );

  withoutDup.push({
    fingerprint,
    hashes: uniqueHashes,
    at: new Date().toISOString(),
  });

  while (withoutDup.length > VO_LEDGER_MAX_GENERATIONS) {
    withoutDup.shift();
  }

  ledger.channels[channelNumber] = { generations: withoutDup };
  saveVoiceLedger(cachePath, ledger);
  pruneUnreferencedVoiceFiles(cachePath, ledger);
}

/** All hashes retained by any channel generation. */
function retainedHashes(ledger: VoiceLedgerFile): Set<string> {
  const keep = new Set<string>();
  for (const ch of Object.values(ledger.channels)) {
    for (const gen of ch.generations) {
      for (const h of gen.hashes) keep.add(h);
    }
  }

  return keep;
}

export function pruneUnreferencedVoiceFiles(
  cachePath: string,
  ledger = loadVoiceLedger(cachePath),
): { deleted: number } {
  const dir = voiceCacheDir(cachePath);
  if (!fs.existsSync(dir)) return { deleted: 0 };

  const keep = retainedHashes(ledger);
  let deleted = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { deleted: 0 };
  }

  for (const entry of entries) {
    if (entry.name === "ledger.json") continue;

    let hash: string | undefined;
    if (entry.isFile() && entry.name.endsWith(".wav")) {
      hash = entry.name.slice(0, -4);
    } else if (entry.isDirectory() && entry.name.endsWith(".parts")) {
      hash = entry.name.slice(0, -6);
    } else {
      continue;
    }

    if (keep.has(hash) || inUseHashes.has(hash)) continue;

    const full = path.join(dir, entry.name);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      deleted += 1;
    } catch (err) {
      log.warn("voice cache delete failed", {
        path: full,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deleted > 0) {
    log.info("pruned voice cache", { deleted, retained: keep.size });
  }

  return { deleted };
}
