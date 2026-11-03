import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelView, EtvBackupInfo, JobInfo, PushResult } from '@promo/shared';
import { api } from '../api';

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
  const [error, setError] = useState('');
  const [streamStatus, setStreamStatus] = useState<'connecting' | 'live' | 'reconnecting'>('connecting');
  const [busy, setBusy] = useState(false);
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [latestPushBackup, setLatestPushBackup] = useState<EtvBackupInfo | null>(null);
  const [rollbackMessage, setRollbackMessage] = useState('');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const userExpandedRef = useRef(false);
  const prevJobSignatureRef = useRef('');

  const jobsActive = useMemo(
    () => jobs.some((j) => j.status === 'queued' || j.status === 'running' || j.status === 'late'),
    [jobs],
  );

  const refreshChannels = useCallback(async () => {
    try {
      const chs = await api.getChannels();
      setChannels(chs);
      setError('');
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
    void refreshChannels();
    void refreshBackups();
    const id = setInterval(() => void refreshChannels(), 15_000);
    return () => clearInterval(id);
  }, [refreshChannels, refreshBackups]);

  useEffect(() => {
    setStreamStatus('connecting');
    const unsubscribe = api.subscribeJobs(
      (nextJobs) => {
        setJobs(nextJobs);
        setStreamStatus('live');

        const finished = nextJobs.some(
          (j) =>
            (j.status === 'succeeded' || j.status === 'failed') &&
            j.finishedAt &&
            Date.now() - new Date(j.finishedAt).getTime() < 5_000,
        );
        if (finished) void refreshChannels();

        setExpandedJobId((prev) => {
          if (userExpandedRef.current && prev && nextJobs.some((job) => job.id === prev)) {
            return prev;
          }
          if (prev && nextJobs.some((job) => job.id === prev)) return prev;
          const running = nextJobs.find((job) => job.status === 'running');
          return running?.id ?? prev ?? nextJobs[0]?.id ?? null;
        });
      },
      () => setStreamStatus((s) => (s === 'live' ? 'reconnecting' : s)),
    );
    return unsubscribe;
  }, [refreshChannels]);

  useEffect(() => {
    const el = logContainerRef.current;
    if (!el || !expandedJobId) return;
    const signature = jobs.find((j) => j.id === expandedJobId)?.logs?.map((l) => l.at).join('|') ?? '';
    if (signature === prevJobSignatureRef.current) return;
    prevJobSignatureRef.current = signature;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [jobs, expandedJobId]);

  async function generateAll() {
    setBusy(true);
    try {
      await api.generateAll();
      await refreshChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function generateOne(number: string) {
    setBusy(true);
    try {
      await api.generateOne(number);
      await refreshChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function push() {
    if (!window.confirm(
      'Push will back up ersatztv.sqlite3, then write fillers/schedules and reset classic playouts for enabled channels. Continue?',
    )) {
      return;
    }
    setBusy(true);
    setPushResult(null);
    setRollbackMessage('');
    setError('');
    try {
      const result = await api.push();
      setPushResult(result);
      if (result.backup) setLatestPushBackup(result.backup);
      else await refreshBackups();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refreshBackups();
    } finally {
      setBusy(false);
    }
  }

  async function rollback() {
    if (!latestPushBackup) {
      setError('No pre-push backup available to roll back.');
      return;
    }
    if (!window.confirm(
      `Restore ersatztv.sqlite3 from backup ${latestPushBackup.id}?\n\n` +
        'If ErsatzTV has the DB locked, stop it first, roll back, then start it again.',
    )) {
      return;
    }
    setBusy(true);
    setRollbackMessage('');
    setError('');
    try {
      const result = await api.rollback(latestPushBackup.id);
      setRollbackMessage(result.message);
      await refreshChannels();
      await refreshBackups();
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

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <h1>Channels</h1>
            <p className="muted">Preview next items, generate promos, and push pre-roll fillers to ErsatzTV.</p>
          </div>
          <div className="row">
            <button className="secondary" disabled={busy} onClick={() => void refreshChannels()}>Refresh</button>
            <button disabled={busy} onClick={() => void generateAll()}>Generate all</button>
            <button className="success" disabled={busy} onClick={() => void push()}>Push to ErsatzTV</button>
            <button
              className="danger"
              disabled={busy || !latestPushBackup}
              title={latestPushBackup ? `Restore backup ${latestPushBackup.id}` : 'No pre-push backup yet'}
              onClick={() => void rollback()}
            >
              Rollback DB
            </button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        {rollbackMessage && <p className="success">{rollbackMessage}</p>}
        {latestPushBackup && (
          <p className="muted" style={{ marginTop: 8 }}>
            Last pre-push backup: <code>{latestPushBackup.id}</code>
            {' · '}
            {formatBytes(latestPushBackup.bytes)}
            {' · '}
            {new Date(latestPushBackup.createdAt).toLocaleString()}
          </p>
        )}
        {pushResult && (
          <div style={{ marginTop: 12 }}>
            <h3>Push results</h3>
            {pushResult.backup && (
              <p className="success">
                DB backed up before push: <code>{pushResult.backup.id}</code>
                {' '}({formatBytes(pushResult.backup.bytes)})
              </p>
            )}
            <ul className="item-list">
              {pushResult.results.map((r) => (
                <li key={r.channelNumber} className={r.ok ? 'success' : 'error'}>
                  <strong>{r.channelName}</strong>: {r.message}
                  {r.replacedPreRoll ? ` (replaced ${r.replacedPreRoll})` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ marginBottom: 0 }}>Jobs</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {streamStatus === 'live'
              ? (jobsActive ? 'Live via SSE' : 'SSE connected · idle')
              : streamStatus === 'reconnecting'
                ? 'SSE reconnecting…'
                : 'Connecting SSE…'}
          </span>
        </div>
        <div className="jobs">
          {jobs.length === 0 && <div className="muted">No jobs yet.</div>}
          {jobs.slice(0, 20).map((j) => {
            const open = expandedJobId === j.id;
            const latest = j.logs?.[j.logs.length - 1];
            return (
              <div className={`job-block ${open ? 'open' : ''}`} key={j.id}>
                <button
                  type="button"
                  className="job job-toggle"
                  onClick={() => toggleJob(j.id, open)}
                >
                  <span>
                    <strong>{j.channelName}</strong>
                    <span className="muted"> #{j.channelNumber}</span>
                  </span>
                  <span className="job-toggle-meta">
                    {!open && latest && (
                      <span className={`job-preview ${latest.level}`}>{latest.message}</span>
                    )}
                    <span className={`badge ${j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'err' : 'warn'}`}>
                      {j.status}{j.late ? ' · late' : ''}
                    </span>
                    <span className="muted">{open ? '▾' : '▸'}</span>
                  </span>
                </button>
                {open && (
                  <div
                    className="job-log"
                    ref={logContainerRef}
                    onScroll={(e) => {
                      const el = e.currentTarget;
                      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    }}
                  >
                    {(!j.logs || j.logs.length === 0) && (
                      <div className="muted">No log lines yet.</div>
                    )}
                    {(j.logs ?? []).map((entry, idx) => (
                      <div className={`job-log-line ${entry.level}`} key={`${j.id}-${idx}-${entry.at}`}>
                        <span className="job-log-time">{formatLogTime(entry.at)}</span>
                        <span className="job-log-msg">{entry.message}</span>
                      </div>
                    ))}
                    {j.error && <div className="job-log-line error"><span className="job-log-msg">{j.error}</span></div>}
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
              {ch.logoUrl ? <img src={ch.logoUrl} alt="" /> : <div className="swatch" style={{ width: 48, height: 48, borderRadius: 24, background: ch.color }} />}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{ch.name}</div>
                <div className="muted">#{ch.number} · {ch.language}</div>
              </div>
              <span className="swatch" style={{ background: ch.color }} title={ch.color} />
            </header>
            <div className="body">
              <div className="row">
                <label style={{ flex: '0 0 auto' }}>
                  Enabled
                  <select
                    value={ch.enabled ? '1' : '0'}
                    onChange={(e) => void patchChannel(ch.number, { enabled: e.target.value === '1' })}
                  >
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </label>
                <label style={{ flex: '0 0 auto' }}>
                  Color
                  <input
                    type="color"
                    value={ch.color}
                    onChange={(e) => void patchChannel(ch.number, { color: e.target.value, colorLocked: true })}
                  />
                </label>
                <label>
                  Language
                  <input
                    value={ch.language}
                    onChange={(e) => void patchChannel(ch.number, { language: e.target.value })}
                  />
                </label>
              </div>

              {ch.currentItem && (
                <div className="muted">Now: {ch.currentItem.title}</div>
              )}
              {ch.nextRegenAt && (
                <div className="muted">Next regen by {new Date(ch.nextRegenAt).toLocaleString()}</div>
              )}

              <h3 style={{ fontSize: 14, marginTop: 4 }}>Next 3</h3>
              <ul className="item-list">
                {ch.nextItems.length === 0 && <li className="muted">No upcoming items</li>}
                {ch.nextItems.map((item) => (
                  <li key={`${item.mediaItemId}-${item.start}`}>
                    <div><strong>{item.title}</strong></div>
                    <div className="muted">
                      {item.seasonNumber != null && item.episodeNumber != null
                        ? `S${item.seasonNumber}E${item.episodeNumber}${item.episodeTitle ? ` - ${item.episodeTitle}` : ''}`
                        : item.episodeTitle || '—'}
                    </div>
                    <div className="muted">{new Date(item.start).toLocaleString()}</div>
                    {item.error
                      ? <div className="error">{item.error}</div>
                      : <div className="success">{item.filePath}</div>}
                  </li>
                ))}
              </ul>

              {ch.promoExists && ch.promoUrl && (
                <video key={ch.promoUrl + (ch.lastGeneratedAt ?? '')} controls src={`${ch.promoUrl}?t=${encodeURIComponent(ch.lastGeneratedAt ?? '')}`} />
              )}
              {!ch.promoExists && <div className="muted">No promo generated yet.</div>}
              {ch.lastError && <div className="error">{ch.lastError}</div>}

              <div className="row">
                <button disabled={busy || !ch.enabled} onClick={() => void generateOne(ch.number)}>Generate</button>
                <span className={`badge ${ch.promoExists ? 'ok' : 'warn'}`}>
                  {ch.promoExists ? 'promo ready' : 'missing promo'}
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
