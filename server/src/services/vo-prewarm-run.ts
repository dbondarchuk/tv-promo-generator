import { AppSettings, ShowVoiceDetail } from "@promo/shared";
import { recordVoiceGeneration } from "../voice/ledger.js";
import type { VoiceLineInput } from "../voice/templates.js";
import {
  peekCachedVoiceOver,
  synthesizeVoiceOver,
  voiceCacheKey,
} from "../voice/tts.js";
import {
  listUpcomingPromoMeta,
  type UpcomingPromoMetaItem,
} from "./channels.js";
import {
  promoWindowFingerprint,
  promoWindowsFromPrimaries,
} from "./fingerprint.js";
import { lookAheadDeltaItems } from "./vo-prewarm-policy.js";

export type VoPrewarmLog = (level: "info" | "warn", message: string) => void;

export interface VoPrewarmRunDeps {
  listUpcomingPromoMeta: typeof listUpcomingPromoMeta;
  peekCachedVoiceOver: typeof peekCachedVoiceOver;
  synthesizeVoiceOver: typeof synthesizeVoiceOver;
  recordVoiceGeneration: typeof recordVoiceGeneration;
  voiceCacheKey: typeof voiceCacheKey;
}

const defaultDeps: VoPrewarmRunDeps = {
  listUpcomingPromoMeta,
  peekCachedVoiceOver,
  synthesizeVoiceOver,
  recordVoiceGeneration,
  voiceCacheKey,
};

function promoVoiceLineInput(
  channelName: string,
  item: UpcomingPromoMetaItem,
  index: number,
  showVoiceDetail: ShowVoiceDetail,
): VoiceLineInput {
  return {
    channelName,
    title: item.title,
    episodeTitle: item.episodeTitle,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    cue: index === 0 ? "next" : "after",
    showVoiceDetail,
  };
}

function promoWindowVoiceHashes(
  settings: AppSettings,
  channelName: string,
  language: string,
  items: UpcomingPromoMetaItem[],
  deps: VoPrewarmRunDeps,
): string[] {
  return items.map(
    (item, index) =>
      deps.voiceCacheKey(
        settings,
        language,
        promoVoiceLineInput(channelName, item, index, settings.showVoiceDetail),
      ).hash,
  );
}

function isPromoWindowVoiceCached(
  settings: AppSettings,
  channelName: string,
  language: string,
  items: UpcomingPromoMetaItem[],
  deps: VoPrewarmRunDeps,
): boolean {
  if (items.length === 0) return true;

  return items.every((item, index) =>
    Boolean(
      deps.peekCachedVoiceOver(
        settings,
        language,
        promoVoiceLineInput(channelName, item, index, settings.showVoiceDetail),
      ),
    ),
  );
}

export interface VoPrewarmRunResult {
  skipped: boolean;
  synthesized: number;
  cacheHits: number;
}

/**
 * Warm current + look-ahead VO windows for one channel.
 * Live encode stays cache-only; this never blocks the promo URL path.
 */
export async function runVoPrewarmForChannel(
  settings: AppSettings,
  channelNumber: string,
  log: VoPrewarmLog,
  deps: Partial<VoPrewarmRunDeps> = {},
): Promise<VoPrewarmRunResult> {
  const resolved: VoPrewarmRunDeps = { ...defaultDeps, ...deps };

  if (!settings.voiceEnabled) {
    log("info", "Voice disabled — skipping VO prewarm");
    return { skipped: true, synthesized: 0, cacheHits: 0 };
  }

  const meta = await resolved.listUpcomingPromoMeta(settings, channelNumber);
  const { current, lookAhead } = promoWindowsFromPrimaries(
    meta.items,
    settings.promoItemCount ?? 3,
  );

  const lookAheadDelta = lookAheadDeltaItems(current, lookAhead);
  const windows: Array<{
    label: string;
    items: UpcomingPromoMetaItem[];
    fingerprintItems: UpcomingPromoMetaItem[];
  }> = [
    {
      label: "current",
      items: current,
      fingerprintItems: current,
    },
    {
      label: "look-ahead",
      items: lookAheadDelta,
      fingerprintItems: lookAhead,
    },
  ];

  const currentCached = isPromoWindowVoiceCached(
    settings,
    meta.channelName,
    meta.language,
    current,
    resolved,
  );

  const lookAheadCached = isPromoWindowVoiceCached(
    settings,
    meta.channelName,
    meta.language,
    lookAhead,
    resolved,
  );

  if (
    (current.length === 0 || currentCached) &&
    (lookAhead.length === 0 || lookAheadCached)
  ) {
    log("info", "VO already cached for current + look-ahead — skipping");
    return { skipped: true, synthesized: 0, cacheHits: 0 };
  }

  let synthesized = 0;
  let cacheHits = 0;

  for (const window of windows) {
    if (window.fingerprintItems.length === 0) continue;

    const fingerprint = promoWindowFingerprint(
      settings,
      window.fingerprintItems.map((i) => ({
        mediaItemId: i.mediaItemId,
        start: i.start,
      })),
    );

    if (
      isPromoWindowVoiceCached(
        settings,
        meta.channelName,
        meta.language,
        window.fingerprintItems,
        resolved,
      )
    ) {
      const hashes = promoWindowVoiceHashes(
        settings,
        meta.channelName,
        meta.language,
        window.fingerprintItems,
        resolved,
      );

      resolved.recordVoiceGeneration(
        settings.cachePath,
        channelNumber,
        fingerprint,
        hashes,
      );

      log(
        "info",
        `VO already cached (${window.label}) · fp ${fingerprint.slice(0, 8)}…`,
      );

      continue;
    }

    if (window.items.length === 0) {
      const hashes = promoWindowVoiceHashes(
        settings,
        meta.channelName,
        meta.language,
        window.fingerprintItems,
        resolved,
      );

      resolved.recordVoiceGeneration(
        settings.cachePath,
        channelNumber,
        fingerprint,
        hashes,
      );

      log(
        "info",
        `Look-ahead overlap already covered · fp ${fingerprint.slice(0, 8)}…`,
      );

      continue;
    }

    log(
      "info",
      `Warming VO (${window.label}) · ${window.items.length} item(s)` +
        (window.items.length !== window.fingerprintItems.length
          ? ` (+${window.fingerprintItems.length - window.items.length} cached overlap)`
          : "") +
        ` · fp ${fingerprint.slice(0, 8)}…`,
    );

    for (let i = 0; i < window.items.length; i++) {
      const item = window.items[i]!;
      const cueIndex =
        window.label === "look-ahead"
          ? window.fingerprintItems.findIndex(
              (f) =>
                f.mediaItemId === item.mediaItemId && f.start === item.start,
            )
          : i;

      const input = promoVoiceLineInput(
        meta.channelName,
        item,
        cueIndex < 0 ? i : cueIndex,
        settings.showVoiceDetail,
      );

      const key = resolved.voiceCacheKey(settings, meta.language, input);
      log("info", `  ${i + 1}. ${item.title} → ${key.hash.slice(0, 10)}…`);

      const voice = await resolved.synthesizeVoiceOver(
        settings,
        settings.cachePath,
        meta.language,
        input,
      );

      if (voice.error) {
        log("warn", `  Voice: ${voice.error}`);
      } else if (voice.cached) {
        cacheHits += 1;
        log("info", `  Cache hit (${voice.voice})`);
      } else {
        synthesized += 1;
        log("info", `  Synthesized (${voice.voice})`);
      }
    }

    const hashes = promoWindowVoiceHashes(
      settings,
      meta.channelName,
      meta.language,
      window.fingerprintItems,
      resolved,
    );

    resolved.recordVoiceGeneration(
      settings.cachePath,
      channelNumber,
      fingerprint,
      hashes,
    );
  }

  log("info", "VO prewarm complete");
  return { skipped: false, synthesized, cacheHits };
}
