import { AppSettings, ChannelView } from "@promo/shared";
import { EtvApiClient } from "../ersatztv/api.js";
import { activeSessionChannelNumbers } from "../ersatztv/sessions.js";
import { createLogger } from "../util/log.js";
import { applyStreamingFlags } from "./vo-prewarm-policy.js";

const log = createLogger("channel-streaming");

export interface ChannelStreamingDeps {
  getActiveSessions: (settings: AppSettings) => Promise<Set<string>>;
}

async function defaultGetActiveSessions(
  settings: AppSettings,
): Promise<Set<string>> {
  const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey);
  return activeSessionChannelNumbers(await api.getSessions());
}

/** Attach live ETV session flags (not cached with schedule views). */
export async function withStreamingFlags(
  settings: AppSettings,
  channels: ChannelView[],
  deps: Partial<ChannelStreamingDeps> = {},
): Promise<ChannelView[]> {
  const getActiveSessions = deps.getActiveSessions ?? defaultGetActiveSessions;

  try {
    const active = await getActiveSessions(settings);
    return applyStreamingFlags(channels, active);
  } catch (err) {
    log.debug(
      "ETV sessions unavailable for channel badges",
      err instanceof Error ? err.message : String(err),
    );

    return applyStreamingFlags(channels, new Set());
  }
}
