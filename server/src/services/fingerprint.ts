import { AppSettings } from "@promo/shared";
import crypto from "node:crypto";

/** Minimal playout identity for a promo window fingerprint. */
export interface FingerprintItem {
  mediaItemId: number;
  start: string;
}

/**
 * Stable id for the next-N promo set (plus settings that change spoken lines / count).
 * Used for VO ledger generations and warm invalidation.
 */
export function promoWindowFingerprint(
  settings: AppSettings,
  items: FingerprintItem[],
): string {
  const payload = [
    `count=${settings.promoItemCount}`,
    `voice=${settings.voiceEnabled ? 1 : 0}`,
    `detail=${settings.showVoiceDetail}`,
    `provider=${settings.voiceProvider}`,
    `pause=${settings.voicePauseMs}`,
    ...items.map((i) => `${i.mediaItemId}@${i.start}`),
  ].join("|");

  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

/** Split a flat primary list into current window and +1 look-ahead window. */
export function promoWindowsFromPrimaries<T>(
  primaries: T[],
  itemCount: number,
): { current: T[]; lookAhead: T[] } {
  const n = Math.max(1, itemCount);
  return {
    current: primaries.slice(0, n),
    lookAhead: primaries.slice(1, 1 + n),
  };
}
