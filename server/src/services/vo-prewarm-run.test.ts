import { DEFAULT_SETTINGS, type AppSettings } from "@promo/shared";
import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceLineInput } from "../voice/templates.js";
import type { UpcomingPromoMetaItem } from "./channels.js";
import { runVoPrewarmForChannel } from "./vo-prewarm-run.js";

function settings(partial: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    voiceEnabled: true,
    promoItemCount: 3,
    cachePath: "/tmp/vo-cache",
    ...partial,
  };
}

function item(
  id: number,
  start: string,
  title = `Show ${id}`,
): UpcomingPromoMetaItem {
  return {
    mediaItemId: id,
    start,
    finish: `${start}-end`,
    title,
    startLabel: `at ${start}`,
  };
}

function mockVoiceKey(_s: AppSettings, _lang: string, input: VoiceLineInput) {
  const hash = `hash-${input.cue}-${input.title}`;
  return {
    hash,
    text: input.title,
    outWav: `/tmp/${hash}.wav`,
    partsDir: `/tmp/${hash}.parts`,
  };
}

test("runVoPrewarmForChannel skips when voice disabled", async () => {
  const logs: string[] = [];
  const result = await runVoPrewarmForChannel(
    settings({ voiceEnabled: false }),
    "1",
    (_level, message) => logs.push(message),
    {
      listUpcomingPromoMeta: async () => {
        throw new Error("should not load schedule");
      },
    },
  );

  assert.equal(result.skipped, true);
  assert.match(logs.join("\n"), /Voice disabled/);
});

test("runVoPrewarmForChannel short-circuits when windows already cached", async () => {
  const items = [item(1, "a"), item(2, "b"), item(3, "c"), item(4, "d")];
  let synthCalls = 0;
  const recorded: string[] = [];

  const result = await runVoPrewarmForChannel(
    settings(),
    "1",
    () => undefined,
    {
      listUpcomingPromoMeta: async () => ({
        channelName: "SciFi",
        language: "en",
        items,
      }),
      peekCachedVoiceOver: () => ({
        hash: "x",
        filePath: "/tmp/x.wav",
        text: "t",
      }),
      synthesizeVoiceOver: async () => {
        synthCalls += 1;
        return { text: "t", voice: "mock", cached: false };
      },
      recordVoiceGeneration: (_cache, channel, fp) => {
        recorded.push(`${channel}:${fp}`);
      },
      voiceCacheKey: mockVoiceKey,
    },
  );

  assert.equal(result.skipped, true);
  assert.equal(synthCalls, 0);
  assert.equal(recorded.length, 0);
});

test("runVoPrewarmForChannel synthesizes only look-ahead delta when current cached", async () => {
  const items = [item(1, "a"), item(2, "b"), item(3, "c"), item(4, "d")];
  const synthTitles: string[] = [];
  const ledger: Array<{ fpPrefix: string; hashes: string[] }> = [];

  const result = await runVoPrewarmForChannel(
    settings(),
    "7",
    () => undefined,
    {
      listUpcomingPromoMeta: async () => ({
        channelName: "SciFi",
        language: "en",
        items,
      }),
      peekCachedVoiceOver: (_settings, _lang, input) => {
        // Current window titles Show 1/2/3 are cached; Show 4 is not.
        if (input.title === "Show 4") return undefined;

        return {
          hash: `hash-${input.title}`,
          filePath: `/tmp/${input.title}.wav`,
          text: input.title,
        };
      },
      synthesizeVoiceOver: async (_s, _c, _l, input) => {
        synthTitles.push(input.title);
        return {
          text: input.title,
          voice: "mock-voice",
          cached: false,
          filePath: `/tmp/${input.title}.wav`,
        };
      },
      recordVoiceGeneration: (_cache, _channel, fingerprint, hashes) => {
        ledger.push({ fpPrefix: fingerprint.slice(0, 8), hashes });
      },
      voiceCacheKey: mockVoiceKey,
    },
  );

  assert.equal(result.skipped, false);
  assert.deepEqual(synthTitles, ["Show 4"]);
  assert.equal(result.synthesized, 1);
  assert.ok(ledger.length >= 1);
});

test("runVoPrewarmForChannel synthesizes current window when cold", async () => {
  const items = [
    item(1, "a", "Alpha"),
    item(2, "b", "Beta"),
    item(3, "c", "Gamma"),
  ];

  const synthTitles: string[] = [];

  const result = await runVoPrewarmForChannel(
    settings({ promoItemCount: 2 }),
    "1",
    () => undefined,
    {
      listUpcomingPromoMeta: async () => ({
        channelName: "SciFi",
        language: "en",
        items,
      }),
      peekCachedVoiceOver: () => undefined,
      synthesizeVoiceOver: async (_s, _c, _l, input) => {
        synthTitles.push(`${input.cue}:${input.title}`);
        return { text: input.title, voice: "mock", cached: false };
      },
      recordVoiceGeneration: () => undefined,
      voiceCacheKey: mockVoiceKey,
    },
  );

  assert.equal(result.skipped, false);
  // current=[Alpha,Beta], lookAhead=[Beta,Gamma] → delta=[Gamma]
  assert.deepEqual(synthTitles, ["next:Alpha", "after:Beta", "after:Gamma"]);

  assert.equal(result.synthesized, 3);
});
