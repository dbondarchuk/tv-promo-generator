import type {
  AppSettings,
  ChannelView,
  EtvBackupInfo,
  JobInfo,
  PromoDeliveryMode,
  PushOptions,
  ValidateSettingsResult,
} from "@promo/shared";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export const api = {
  getSettings: () => request<AppSettings>("/api/settings"),
  getSettingsStatus: () =>
    request<{
      configured: boolean;
      voiceEnabled?: boolean;
      promoDeliveryMode?: PromoDeliveryMode;
    }>("/api/settings/status"),
  saveSettings: (settings: AppSettings) =>
    request<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  resetSettings: () =>
    request<AppSettings>("/api/settings", { method: "DELETE" }),
  validateSettings: (settings: AppSettings) =>
    request<ValidateSettingsResult>("/api/settings/validate", {
      method: "POST",
      body: JSON.stringify(settings),
    }),
  getChannels: () => request<ChannelView[]>("/api/channels"),
  /** Force-refresh schedule snapshot (bypasses 1-minute server cache). */
  refreshChannels: () =>
    request<ChannelView[]>("/api/channels/refresh", {
      method: "POST",
      body: "{}",
    }),
  patchChannel: (number: string, patch: Record<string, unknown>) =>
    request(`/api/channels/${encodeURIComponent(number)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  generateAll: () =>
    request<{ jobs: JobInfo[] }>("/api/generate", {
      method: "POST",
      body: "{}",
    }),
  generateOne: (number: string) =>
    request<{ job: JobInfo }>(`/api/generate/${encodeURIComponent(number)}`, {
      method: "POST",
      body: "{}",
    }),
  voPrewarmAll: () =>
    request<{ jobs: JobInfo[] }>("/api/vo-prewarm", {
      method: "POST",
      body: "{}",
    }),
  voPrewarmOne: (number: string) =>
    request<{ job: JobInfo }>(`/api/vo-prewarm/${encodeURIComponent(number)}`, {
      method: "POST",
      body: "{}",
    }),
  getJobs: () => request<JobInfo[]>("/api/jobs"),
  /** Live job updates via SSE. Returns an unsubscribe function. */
  subscribeJobs: (
    onJobs: (jobs: JobInfo[]) => void,
    onError?: (err: Error) => void,
  ): (() => void) => {
    const es = new EventSource("/api/jobs/stream");
    const onMessage = (ev: MessageEvent<string>) => {
      try {
        onJobs(JSON.parse(ev.data) as JobInfo[]);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    es.addEventListener("jobs", onMessage as EventListener);
    es.onerror = () => {
      // Browser auto-reconnects; surface a soft status only.
      onError?.(new Error("Job stream disconnected — reconnecting…"));
    };

    return () => {
      es.removeEventListener("jobs", onMessage as EventListener);
      es.close();
    };
  },
  push: (options: PushOptions) =>
    request<{ job: JobInfo }>("/api/push", {
      method: "POST",
      body: JSON.stringify(options),
    }),
  pushGraphics: () =>
    request<{ job: JobInfo }>("/api/push-graphics", {
      method: "POST",
      body: "{}",
    }),
  cleanupGraphics: () =>
    request<{ job: JobInfo }>("/api/cleanup-graphics", {
      method: "POST",
      body: "{}",
    }),
  listBackups: () =>
    request<{ backups: EtvBackupInfo[]; latestPush: EtvBackupInfo | null }>(
      "/api/backups",
    ),
  createBackup: () =>
    request<EtvBackupInfo>("/api/backups", { method: "POST", body: "{}" }),
  rollback: (backupId?: string) =>
    request<{ job: JobInfo }>("/api/rollback", {
      method: "POST",
      body: JSON.stringify(backupId ? { backupId } : {}),
    }),
};
