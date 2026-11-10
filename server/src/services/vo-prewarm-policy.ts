import { VoPrewarmMode } from "@promo/shared";

/** Keep warm-eligible briefly after a session drops (reconnects). */
export const SESSION_GRACE_MS = 5 * 60_000;

export interface SessionEligibilityInput {
  mode: VoPrewarmMode;
  channelNumber: string;
  activeSessions: Set<string>;
  lastSessionSeenAt: Map<string, number>;
  nowMs: number;
  graceMs?: number;
}

/** Whether auto VO prewarm may run for this channel under the current mode. */
export function isVoSessionEligible(input: SessionEligibilityInput): boolean {
  if (input.mode === "off") return false;
  if (input.mode === "schedule") return true;

  if (input.activeSessions.has(input.channelNumber)) return true;

  const lastSeen = input.lastSessionSeenAt.get(input.channelNumber);
  if (lastSeen == null) return false;

  const graceMs = input.graceMs ?? SESSION_GRACE_MS;
  return input.nowMs - lastSeen < graceMs;
}

export interface VoEnqueueDecisionInput {
  mode: VoPrewarmMode;
  sessionEligible: boolean;
  primaryChanged: boolean;
  newlyActive: boolean;
}

/** Whether this scheduler tick should enqueue VO for a channel. */
export function shouldEnqueueVoPrewarm(input: VoEnqueueDecisionInput): boolean {
  if (input.mode === "off") return false;
  if (!input.sessionEligible) return false;

  return input.primaryChanged || input.newlyActive;
}

/** True when channel just appeared in the active-session set. */
export function isNewlyActiveSession(
  channelNumber: string,
  activeSessions: Set<string>,
  lastSessionActive: Set<string>,
): boolean {
  return (
    activeSessions.has(channelNumber) && !lastSessionActive.has(channelNumber)
  );
}

export interface FingerprintIdentity {
  mediaItemId: number;
  start: string;
}

/**
 * Look-ahead items not already covered by the current window
 * (current is slice(0,n), look-ahead is slice(1,1+n)).
 */
export function lookAheadDeltaItems<T extends FingerprintIdentity>(
  current: T[],
  lookAhead: T[],
): T[] {
  const currentIds = new Set(
    current.map((item) => `${item.mediaItemId}@${item.start}`),
  );

  return lookAhead.filter(
    (item) => !currentIds.has(`${item.mediaItemId}@${item.start}`),
  );
}

/** Merge ETV session activity onto channel views. */
export function applyStreamingFlags<T extends { number: string }>(
  channels: T[],
  activeSessions: Set<string>,
): Array<T & { streaming: boolean }> {
  return channels.map((channel) => ({
    ...channel,
    streaming: activeSessions.has(channel.number),
  }));
}
