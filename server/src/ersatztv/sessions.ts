/** Active HLS / MPEG-TS session from `GET /api/sessions`. */
export interface EtvApiSession {
  channelNumber: string;
  state?: string;
  transcodedUntil?: string | null;
  lastAccess?: string;
  startedAt?: string;
}

/**
 * Normalize ETV `/api/sessions` JSON (camelCase or PascalCase) into sessions.
 */
export function parseEtvSessions(raw: unknown): EtvApiSession[] {
  if (!Array.isArray(raw)) return [];

  const sessions: EtvApiSession[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;

    const row = entry as Record<string, unknown>;
    const channelNumber = String(
      row.channelNumber ?? row.ChannelNumber ?? "",
    ).trim();

    if (!channelNumber) continue;

    sessions.push({
      channelNumber,
      state:
        typeof row.state === "string"
          ? row.state
          : typeof row.State === "string"
            ? row.State
            : undefined,
      transcodedUntil:
        (row.transcodedUntil as string | null | undefined) ??
        (row.TranscodedUntil as string | null | undefined) ??
        null,
      lastAccess:
        typeof row.lastAccess === "string"
          ? row.lastAccess
          : typeof row.LastAccess === "string"
            ? row.LastAccess
            : undefined,
      startedAt:
        typeof row.startedAt === "string"
          ? row.startedAt
          : typeof row.StartedAt === "string"
            ? row.StartedAt
            : undefined,
    });
  }

  return sessions;
}

/** Channel numbers with an active ETV session. */
export function activeSessionChannelNumbers(
  sessions: EtvApiSession[],
): Set<string> {
  return new Set(sessions.map((s) => s.channelNumber).filter(Boolean));
}
