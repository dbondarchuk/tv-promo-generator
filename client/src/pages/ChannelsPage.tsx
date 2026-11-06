import type {
  ChannelView,
  EtvBackupInfo,
  FillerPlacement,
  JobInfo,
} from "@promo/shared";
import {
  CHANNEL_LANGUAGES,
  FILLER_PLACEMENT_LABELS,
  FILLER_PLACEMENTS,
  isPushOptionsActionable,
} from "@promo/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { LivePromoPreview } from "../components/LivePromoPreview";

const DEFAULT_PUSH_FILLERS: Record<FillerPlacement, boolean> = {
  pre: true,
  middle: false,
  post: false,
  tail: false,
};

const KNOWN_LANGUAGE_CODES = new Set<string>(
  CHANNEL_LANGUAGES.map((l) => l.code),
);

function languageSelectValue(raw: string): string {
  const code = raw.trim().toLowerCase();
  if (KNOWN_LANGUAGE_CODES.has(code)) return code;
  if (code === "ukr" || code === "ua") return "uk";

  const base = code.split(/[-_]/)[0] ?? code;
  if (KNOWN_LANGUAGE_CODES.has(base)) return base;

  return raw;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLogTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

export function ChannelsPage() {
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [error, setError] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [streamStatus, setStreamStatus] = useState<
    "connecting" | "live" | "reconnecting"
  >("connecting");

  const [busy, setBusy] = useState(false);
  const [latestPushBackup, setLatestPushBackup] =
    useState<EtvBackupInfo | null>(null);

  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushFillers, setPushFillers] = useState(DEFAULT_PUSH_FILLERS);
  const [cleanupLegacy, setCleanupLegacy] = useState(true);
  const [cleanupUnselected, setCleanupUnselected] = useState(true);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const userExpandedRef = useRef(false);
  const prevJobSignatureRef = useRef("");
  const seenExclusiveFinishedRef = useRef<Set<string>>(new Set());

  const jobsActive = useMemo(
    () =>
      jobs.some(
        (j) =>
          j.status === "queued" ||
          j.status === "running" ||
          j.status === "late",
      ),
    [jobs],
  );

  const exclusiveActive = useMemo(
    () =>
      jobs.some(
        (j) =>
          (j.kind === "push" || j.kind === "rollback") &&
          (j.status === "queued" || j.status === "running"),
      ),
    [jobs],
  );

  /** Per-channel VO-prewarm job badge: running wins over queued. */
  const voJobBadgeByChannel = useMemo(() => {
    const map = new Map<string, "warming" | "queued">();
    for (const job of jobs) {
      if (job.kind !== "vo-prewarm") continue;

      if (job.status === "running" || job.status === "late") {
        map.set(job.channelNumber, "warming");
      } else if (
        job.status === "queued" &&
        map.get(job.channelNumber) !== "warming"
      ) {
        map.set(job.channelNumber, "queued");
      }
    }

    return map;
  }, [jobs]);

  const refreshChannels = useCallback(async () => {
    try {
      const chs = await api.getChannels();
      setChannels(chs);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const refreshBackups = useCallback(async () => {
    try {
      const { latestPush } = await api.listBackups();
      setLatestPushBackup(latestPush);
    } catch {
      // Backups are optional UI; don't block the page.
    }
  }, []);

  useEffect(() => {
    api
      .getSettingsStatus()
      .then((status) => {
        setConfigured(status.configured);
        setVoiceEnabled(status.voiceEnabled !== false);
      })
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (configured === false) return;

    void refreshChannels();
    void refreshBackups();
    const id = setInterval(() => void refreshChannels(), 15_000);
    return () => clearInterval(id);
  }, [configured, refreshChannels, refreshBackups]);

  useEffect(() => {
    setStreamStatus("connecting");
    const unsubscribe = api.subscribeJobs(
      (nextJobs) => {
        setJobs(nextJobs);
        setStreamStatus("live");

        const finished = nextJobs.some(
          (j) =>
            (j.status === "succeeded" || j.status === "failed") &&
            j.finishedAt &&
            Date.now() - new Date(j.finishedAt).getTime() < 5_000,
        );

        if (finished) void refreshChannels();

        for (const j of nextJobs) {
          if (
            (j.kind === "push" || j.kind === "rollback") &&
            (j.status === "succeeded" || j.status === "failed") &&
            j.finishedAt &&
            !seenExclusiveFinishedRef.current.has(j.id)
          ) {
            seenExclusiveFinishedRef.current.add(j.id);
            void refreshBackups();
          }
        }

        setExpandedJobId((prev) => {
          if (
            userExpandedRef.current &&
            prev &&
            nextJobs.some((job) => job.id === prev)
          ) {
            return prev;
          }

          if (prev && nextJobs.some((job) => job.id === prev)) return prev;

          const runningExclusive = nextJobs.find(
            (job) =>
              (job.kind === "push" || job.kind === "rollback") &&
              job.status === "running",
          );

          if (runningExclusive) return runningExclusive.id;

          const running = nextJobs.find((job) => job.status === "running");
          return running?.id ?? prev ?? nextJobs[0]?.id ?? null;
        });
      },
      () => setStreamStatus((s) => (s === "live" ? "reconnecting" : s)),
    );

    return unsubscribe;
  }, [refreshChannels, refreshBackups]);

  useEffect(() => {
    const el = logContainerRef.current;
    if (!el || !expandedJobId) return;

    const signature =
      jobs
        .find((j) => j.id === expandedJobId)
        ?.logs?.map((l) => l.at)
        .join("|") ?? "";

    if (signature === prevJobSignatureRef.current) return;

    prevJobSignatureRef.current = signature;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [jobs, expandedJobId]);

  async function voPrewarmAll() {
    setBusy(true);
    try {
      await api.voPrewarmAll();
      await refreshChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function voPrewarmOne(number: string) {
    setBusy(true);
    try {
      await api.voPrewarmOne(number);
      await refreshChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function openPushDialog() {
    setPushFillers({ ...DEFAULT_PUSH_FILLERS });
    setCleanupLegacy(true);
    setCleanupUnselected(true);
    setPushDialogOpen(true);
  }

  async function confirmPush() {
    const fillerTypes = FILLER_PLACEMENTS.filter((p) => pushFillers[p]);
    const options = { fillerTypes, cleanupLegacy, cleanupUnselected };
    if (!isPushOptionsActionable(options)) {
      setError("Select at least one filler type, or enable a cleanup option.");
      return;
    }

    setBusy(true);
    setError("");
    setPushDialogOpen(false);
    try {
      const { job } = await api.push(options);
      userExpandedRef.current = true;
      setExpandedJobId(job.id);
      stickToBottomRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rollback() {
    if (!latestPushBackup) {
      setError("No pre-push backup available to roll back.");
      return;
    }

    if (
      !window.confirm(
        `Restore ersatztv.sqlite3 from backup ${latestPushBackup.id}?\n\n` +
          "Generation will pause. If ErsatzTV has the DB locked, stop it first, then run rollback.",
      )
    ) {
      return;
    }

    setBusy(true);
    setError("");
    try {
      const { job } = await api.rollback(latestPushBackup.id);
      userExpandedRef.current = true;
      setExpandedJobId(job.id);
      stickToBottomRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function patchChannel(number: string, patch: Record<string, unknown>) {
    await api.patchChannel(number, patch);
    await refreshChannels();
  }

  function toggleJob(id: string, open: boolean) {
    userExpandedRef.current = true;
    setExpandedJobId(open ? null : id);
    stickToBottomRef.current = true;
  }

  const selectedPushCount = FILLER_PLACEMENTS.filter(
    (p) => pushFillers[p],
  ).length;

  const pushActionable = isPushOptionsActionable({
    fillerTypes: FILLER_PLACEMENTS.filter((p) => pushFillers[p]),
    cleanupLegacy,
    cleanupUnselected,
  });

  if (configured === null) {
    return <div className="panel muted">Loading…</div>;
  }

  if (!configured) {
    return (
      <div className="panel setup-needed">
        <h1>Setup required</h1>
        <p className="muted">
          Configure ErsatzTV connection and media paths before generating
          promos.
        </p>
        <p>
          <Link className="button" to="/settings">
            Open Settings
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      {pushDialogOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => !busy && setPushDialogOpen(false)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="push-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="push-dialog-title">Push to ErsatzTV</h2>
            <p className="muted">
              Backs up ersatztv.sqlite3, writes Remote Stream YAML (live HTTP
              MPEG-TS), then wires selected fillers on classic schedules.
              Requires On-demand base URL in Settings. Generation pauses until
              push finishes.
            </p>
            <fieldset className="filler-type-fieldset">
              <legend>Filler types</legend>
              {FILLER_PLACEMENTS.map((placement) => (
                <label key={placement} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={pushFillers[placement]}
                    onChange={(e) =>
                      setPushFillers((prev) => ({
                        ...prev,
                        [placement]: e.target.checked,
                      }))
                    }
                  />
                  <span>
                    {FILLER_PLACEMENT_LABELS[placement]}
                    <span className="muted"> · schedule {placement}-roll</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <fieldset className="filler-type-fieldset">
              <legend>Cleanup</legend>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={cleanupLegacy}
                  onChange={(e) => setCleanupLegacy(e.target.checked)}
                />
                <div className="label-text">
                  Remove legacy untyped fillers
                  <span className="muted">
                    Promo Generator - Next - ChannelName
                  </span>
                </div>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={cleanupUnselected}
                  onChange={(e) => setCleanupUnselected(e.target.checked)}
                />
                <div className="label-text">
                  Remove unselected typed fillers
                  <span className="muted">
                    clear slots + delete unused presets
                  </span>
                </div>
              </label>
            </fieldset>
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Typed names look like{" "}
              <code>Promo Generator - Next - Pre - ChannelName</code>. Select no
              types and enable “Remove unselected” to strip all typed promo
              fillers.
            </p>
            <div
              className="row"
              style={{ justifyContent: "flex-end", marginTop: 16 }}
            >
              <button
                className="secondary"
                disabled={busy}
                onClick={() => setPushDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                className="success"
                disabled={busy || !pushActionable}
                onClick={() => void confirmPush()}
              >
                {selectedPushCount > 0
                  ? `Push (${selectedPushCount})`
                  : cleanupLegacy || cleanupUnselected
                    ? "Cleanup"
                    : "Push"}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h1>Channels</h1>
            <p className="muted">
              Live preview, warm voice-over ahead of fillers, and push to
              ErsatzTV.
            </p>
          </div>
          <div className="row">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void refreshChannels()}
            >
              Refresh
            </button>
            {voiceEnabled && (
              <button
                disabled={busy || exclusiveActive}
                title={
                  exclusiveActive
                    ? "Paused while push/rollback is running"
                    : "Pre-synthesize voice for enabled channels"
                }
                onClick={() => void voPrewarmAll()}
              >
                Warm VO all
              </button>
            )}
            <button
              className="success"
              disabled={busy || exclusiveActive}
              onClick={openPushDialog}
            >
              Push to ErsatzTV
            </button>
            <button
              className="danger"
              disabled={busy || exclusiveActive || !latestPushBackup}
              title={
                latestPushBackup
                  ? `Restore backup ${latestPushBackup.id}`
                  : "No pre-push backup yet"
              }
              onClick={() => void rollback()}
            >
              Rollback DB
            </button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        {exclusiveActive && (
          <p className="muted" style={{ marginTop: 8 }}>
            Push/rollback job is active — VO prewarm is paused. Open the Jobs
            panel for live logs.
          </p>
        )}
        {latestPushBackup && (
          <p className="muted" style={{ marginTop: 8 }}>
            Last pre-push backup: <code>{latestPushBackup.id}</code>
            {" · "}
            {formatBytes(latestPushBackup.bytes)}
            {" · "}
            {new Date(latestPushBackup.createdAt).toLocaleString()}
          </p>
        )}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ marginBottom: 0 }}>Jobs</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {streamStatus === "live"
              ? jobsActive
                ? exclusiveActive
                  ? "Live via SSE · push/rollback pausing VO prewarm"
                  : "Live via SSE"
                : "SSE connected · idle"
              : streamStatus === "reconnecting"
                ? "SSE reconnecting…"
                : "Connecting SSE…"}
          </span>
        </div>
        <div className="jobs">
          {jobs.length === 0 && <div className="muted">No jobs yet.</div>}
          {jobs.slice(0, 20).map((j) => {
            const open = expandedJobId === j.id;
            const latest = j.logs?.[j.logs.length - 1];
            const kind = j.kind ?? "generate";
            const kindClass =
              kind === "push"
                ? "push"
                : kind === "rollback"
                  ? "rollback"
                  : kind === "vo-prewarm"
                    ? "gen"
                    : "gen";

            return (
              <div
                className={`job-block ${open ? "open" : ""} job-${kindClass}`}
                key={j.id}
              >
                <button
                  type="button"
                  className="job job-toggle"
                  onClick={() => toggleJob(j.id, open)}
                >
                  <span>
                    <span className={`badge ${kindClass}`}>{kind}</span>{" "}
                    <strong>{j.channelName}</strong>
                    {kind === "vo-prewarm" && (
                      <span className="muted"> #{j.channelNumber}</span>
                    )}
                  </span>
                  <span className="job-toggle-meta">
                    {!open && latest && (
                      <span className={`job-preview ${latest.level}`}>
                        {latest.message}
                      </span>
                    )}
                    <span
                      className={`badge ${j.status === "succeeded" ? "ok" : j.status === "failed" ? "err" : "warn"}`}
                    >
                      {j.status}
                      {j.late ? " · late" : ""}
                    </span>
                    <span className="muted">{open ? "▾" : "▸"}</span>
                  </span>
                </button>
                {open && (
                  <div
                    className="job-log"
                    ref={logContainerRef}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      stickToBottomRef.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    }}
                  >
                    {(!j.logs || j.logs.length === 0) && (
                      <div className="muted">No log lines yet.</div>
                    )}
                    {(j.logs ?? []).map((entry, idx) => (
                      <div
                        className={`job-log-line ${entry.level}`}
                        key={`${j.id}-${idx}-${entry.at}`}
                      >
                        <span className="job-log-time">
                          {formatLogTime(entry.at)}
                        </span>
                        <span className="job-log-msg">{entry.message}</span>
                      </div>
                    ))}
                    {j.error && (
                      <div className="job-log-line error">
                        <span className="job-log-msg">{j.error}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid">
        {channels.map((ch) => (
          <article className="channel-card" key={ch.number}>
            <header>
              {ch.logoUrl ? (
                <img src={ch.logoUrl} alt="" />
              ) : (
                <div
                  className="swatch"
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    background: ch.color,
                  }}
                />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{ch.name}</div>
                <div className="muted">
                  #{ch.number} · {ch.language}
                </div>
              </div>
              <span
                className="swatch"
                style={{ background: ch.color }}
                title={ch.color}
              />
            </header>
            <div className="body">
              <div className="row">
                <label style={{ flex: "0 0 auto" }}>
                  Enabled
                  <select
                    value={ch.enabled ? "1" : "0"}
                    onChange={(e) =>
                      void patchChannel(ch.number, {
                        enabled: e.target.value === "1",
                      })
                    }
                  >
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </label>
                <label style={{ flex: "0 0 auto" }}>
                  Color
                  <input
                    type="color"
                    value={ch.color}
                    onChange={(e) =>
                      void patchChannel(ch.number, {
                        color: e.target.value,
                        colorLocked: true,
                      })
                    }
                  />
                </label>
                <label>
                  Language
                  <select
                    value={languageSelectValue(ch.language)}
                    onChange={(e) =>
                      void patchChannel(ch.number, { language: e.target.value })
                    }
                  >
                    {!KNOWN_LANGUAGE_CODES.has(
                      languageSelectValue(ch.language),
                    ) &&
                      ch.language && (
                        <option value={ch.language}>{ch.language}</option>
                      )}
                    {CHANNEL_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {ch.currentItem && (
                <div className="muted">Now: {ch.currentItem.title}</div>
              )}
              {ch.nextRegenAt && (
                <div className="muted">
                  Next regen by {new Date(ch.nextRegenAt).toLocaleString()}
                </div>
              )}

              <h3 style={{ fontSize: 14, marginTop: 4 }}>
                Next {ch.nextItems.length || "items"}
              </h3>
              <ul className="item-list">
                {ch.nextItems.length === 0 && (
                  <li className="muted">No upcoming items</li>
                )}
                {ch.nextItems.map((item) => (
                  <li key={`${item.mediaItemId}-${item.start}`}>
                    <div>
                      <strong>{item.title}</strong>
                    </div>
                    <div className="muted">
                      {item.seasonNumber != null && item.episodeNumber != null
                        ? `S${item.seasonNumber}E${item.episodeNumber}${item.episodeTitle ? ` - ${item.episodeTitle}` : ""}`
                        : item.episodeTitle || "—"}
                    </div>
                    <div className="muted">
                      {new Date(item.start).toLocaleString()}
                    </div>
                    {item.error ? (
                      <div className="error">{item.error}</div>
                    ) : (
                      <div className="success">{item.filePath}</div>
                    )}
                  </li>
                ))}
              </ul>

              <div className="flex-1" />

              {ch.livePromoUrl && ch.enabled && ch.nextItems.length > 0 ? (
                <LivePromoPreview
                  src={ch.livePromoUrl}
                  channelLabel={ch.name}
                />
              ) : ch.promoExists && ch.promoUrl ? (
                <video
                  key={ch.promoUrl + (ch.lastGeneratedAt ?? "")}
                  controls
                  src={`${ch.promoUrl}?t=${encodeURIComponent(ch.lastGeneratedAt ?? "")}`}
                />
              ) : (
                <div className="muted">
                  {ch.enabled
                    ? "No upcoming items to preview."
                    : "Enable channel to preview live promo."}
                </div>
              )}
              {ch.lastError && <div className="error">{ch.lastError}</div>}

              <div className="row">
                {voiceEnabled && (
                  <button
                    disabled={busy || exclusiveActive || !ch.enabled}
                    title={
                      exclusiveActive
                        ? "Paused while push/rollback is running"
                        : "Pre-synthesize voice for upcoming items"
                    }
                    onClick={() => void voPrewarmOne(ch.number)}
                  >
                    Warm VO
                  </button>
                )}
                {voJobBadgeByChannel.get(ch.number) === "warming" && (
                  <span className="badge warn">warming VO</span>
                )}
                {voJobBadgeByChannel.get(ch.number) === "queued" && (
                  <span className="badge">VO in queue</span>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
