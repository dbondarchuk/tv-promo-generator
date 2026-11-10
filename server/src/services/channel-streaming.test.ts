import { DEFAULT_SETTINGS, type ChannelView } from "@promo/shared";
import assert from "node:assert/strict";
import test from "node:test";
import { withStreamingFlags } from "./channel-streaming.js";

function channel(number: string, name: string): ChannelView {
  return {
    number,
    name,
    tvgId: number,
    language: "en",
    color: "#000000",
    colorLocked: false,
    enabled: true,
    graphicsEnabled: true,
    nextItems: [],
    promoExists: false,
  };
}

test("withStreamingFlags marks channels from mocked sessions", async () => {
  const flagged = await withStreamingFlags(
    DEFAULT_SETTINGS,
    [channel("1", "One"), channel("2", "Two")],
    {
      getActiveSessions: async () => new Set(["2"]),
    },
  );

  assert.equal(flagged[0]?.streaming, false);
  assert.equal(flagged[1]?.streaming, true);
});

test("withStreamingFlags clears streaming when sessions fetch fails", async () => {
  const flagged = await withStreamingFlags(
    DEFAULT_SETTINGS,
    [channel("1", "One")],
    {
      getActiveSessions: async () => {
        throw new Error("ETV down");
      },
    },
  );

  assert.equal(flagged[0]?.streaming, false);
});
