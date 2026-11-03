import fs from 'node:fs';
import path from 'node:path';
import { AppSettings, JobInfo, JobLogEntry, JobLogLevel } from '@promo/shared';
import { promoOutputFile } from '../util/paths.js';
import { createLogger } from '../util/log.js';
import { renderPromo } from '../promo/render.js';
import { buildPromoChaptersForChannel, getFontFile } from './channels.js';
import { pushToErsatzTv } from './push.js';

const log = createLogger('jobs');
const MAX_LOGS_PER_JOB = 400;

type Listener = (jobs: JobInfo[]) => void;

interface InternalJob extends JobInfo {
  priority: number;
}

export class JobQueue {
  private jobs = new Map<string, InternalJob>();
  private queue: string[] = [];
  private running = false;
  private listeners = new Set<Listener>();
  private settingsProvider: () => AppSettings;
  private lastGenerated = new Map<string, string>();
  private lastErrors = new Map<string, string>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly emitDebounceMs = 100;

  constructor(settingsProvider: () => AppSettings) {
    this.settingsProvider = settingsProvider;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    // Push current snapshot immediately so SSE clients don't wait for the next change.
    listener(this.list());
    return () => this.listeners.delete(listener);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()]
      .map(({ priority: _p, ...rest }) => rest)
      .sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1));
  }

  getLastGenerated(channelNumber: string): string | undefined {
    return this.lastGenerated.get(channelNumber);
  }

  getLastError(channelNumber: string): string | undefined {
    return this.lastErrors.get(channelNumber);
  }

  hasActivePush(): boolean {
    return [...this.jobs.values()].some(
      (j) => j.kind === 'push' && (j.status === 'queued' || j.status === 'running'),
    );
  }

  enqueue(opts: {
    channelNumber: string;
    channelName: string;
    deadline?: Date;
    preferFront?: boolean;
  }): JobInfo {
    const existingQueued = [...this.jobs.values()].find(
      (j) =>
        j.kind === 'generate' &&
        j.channelNumber === opts.channelNumber &&
        (j.status === 'queued' || j.status === 'running'),
    );
    if (existingQueued) {
      this.appendLog(existingQueued.id, 'info', 'Generate requested again while job still queued/running');
      log.debug('job already queued/running', {
        id: existingQueued.id,
        channel: opts.channelNumber,
        status: existingQueued.status,
      });
      return this.publicJob(existingQueued);
    }

    const id = `gen-${opts.channelNumber}-${Date.now()}`;
    const late = Boolean(opts.deadline && opts.deadline.getTime() < Date.now());
    const job: InternalJob = {
      id,
      kind: 'generate',
      channelNumber: opts.channelNumber,
      channelName: opts.channelName,
      status: late ? 'late' : 'queued',
      queuedAt: new Date().toISOString(),
      deadline: opts.deadline?.toISOString(),
      late,
      logs: [],
      priority: opts.preferFront || late ? 10 : (opts.deadline?.getTime() ?? Date.now() + 86_400_000),
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.queue.sort((a, b) => this.jobs.get(a)!.priority - this.jobs.get(b)!.priority);

    const paused = this.hasActivePush();
    this.appendLog(
      id,
      late ? 'warn' : 'info',
      late
        ? `Queued late (deadline ${job.deadline}) · queue #${this.queue.length}`
        : `Queued · position ${this.queue.length}${job.deadline ? ` · deadline ${job.deadline}` : ''}`,
      false,
    );
    if (paused) {
      this.appendLog(id, 'warn', 'Paused — waiting for Push to ErsatzTV to finish', false);
    }
    log.info('generate job queued', {
      id,
      channel: opts.channelName,
      number: opts.channelNumber,
      late,
      paused,
      queueDepth: this.queue.length,
    });
    this.emit();
    void this.pump();
    return this.publicJob(job);
  }

  enqueuePush(): JobInfo {
    const existing = [...this.jobs.values()].find(
      (j) => j.kind === 'push' && (j.status === 'queued' || j.status === 'running'),
    );
    if (existing) {
      this.appendLog(existing.id, 'info', 'Push requested again while still queued/running');
      return this.publicJob(existing);
    }

    const id = `push-${Date.now()}`;
    const job: InternalJob = {
      id,
      kind: 'push',
      channelNumber: 'push',
      channelName: 'Push to ErsatzTV',
      status: 'queued',
      queuedAt: new Date().toISOString(),
      logs: [],
      // Ahead of generate jobs (those use deadline timestamps / 10+).
      priority: 0,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.queue.sort((a, b) => this.jobs.get(a)!.priority - this.jobs.get(b)!.priority);

    this.appendLog(id, 'info', `Queued · generation jobs will pause until this finishes`, false);
    for (const other of this.jobs.values()) {
      if (other.kind === 'generate' && other.status === 'queued') {
        this.appendLog(other.id, 'warn', 'Paused — waiting for Push to ErsatzTV to finish', false);
      }
    }
    if ([...this.jobs.values()].some((j) => j.kind === 'generate' && j.status === 'running')) {
      this.appendLog(id, 'info', 'Waiting for in-flight generate job to finish first', false);
    }

    log.info('push job queued', { id, queueDepth: this.queue.length });
    this.emit();
    void this.pump();
    return this.publicJob(job);
  }

  private publicJob(job: InternalJob): JobInfo {
    const { priority: _p, ...rest } = job;
    return rest;
  }

  private appendLog(jobId: string, level: JobLogLevel, message: string, emit = true): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const entry: JobLogEntry = {
      at: new Date().toISOString(),
      level,
      message,
    };
    job.logs.push(entry);
    if (job.logs.length > MAX_LOGS_PER_JOB) {
      job.logs.splice(0, job.logs.length - MAX_LOGS_PER_JOB);
    }
    if (level === 'error') log.error(message, { jobId, channel: job.channelName, kind: job.kind });
    else if (level === 'warn') log.warn(message, { jobId, channel: job.channelName, kind: job.kind });
    else log.info(message, { jobId, channel: job.channelName, kind: job.kind });
    if (emit) this.emit();
  }

  private emit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const snapshot = this.list();
      for (const listener of this.listeners) listener(snapshot);
    }, this.emitDebounceMs);
  }

  private pickNextJobId(): string | undefined {
    const pushActiveOrQueued = this.hasActivePush();
    for (let i = 0; i < this.queue.length; i++) {
      const id = this.queue[i]!;
      const job = this.jobs.get(id);
      if (!job) {
        this.queue.splice(i, 1);
        i -= 1;
        continue;
      }
      if (job.kind === 'generate' && pushActiveOrQueued) {
        // Leave generate jobs in queue until push is done.
        continue;
      }
      this.queue.splice(i, 1);
      return id;
    }
    return undefined;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const nextId = this.pickNextJobId();
    if (!nextId) return;
    const job = this.jobs.get(nextId);
    if (!job) {
      void this.pump();
      return;
    }
    this.running = true;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    if (job.deadline && new Date(job.deadline).getTime() < Date.now()) {
      job.late = true;
    }
    this.appendLog(job.id, 'info', `Started${job.late ? ' (late)' : ''} · ${job.kind}`);
    this.emit();

    try {
      if (job.kind === 'push') {
        await this.runPushJob(job);
      } else {
        await this.runGenerateJob(job);
      }
    } catch (err) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      if (job.kind === 'generate') {
        this.lastErrors.set(job.channelNumber, job.error);
      }
      this.appendLog(job.id, 'error', `Failed: ${job.error}`, false);
    }

    this.running = false;
    this.emit();
    void this.pump();
  }

  private async runGenerateJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    const onProgress = (message: string, level: JobLogLevel = 'info') => {
      this.appendLog(job.id, level, message);
    };

    const built = await buildPromoChaptersForChannel(settings, job.channelNumber, onProgress);
    const outputFile = promoOutputFile(settings.outputPath, built.channelName);
    const workDir = path.join(settings.cachePath, 'work', job.channelNumber, String(Date.now()));
    fs.mkdirSync(workDir, { recursive: true });
    this.appendLog(job.id, 'info', `Rendering promo (${built.language}, ${built.chapters.length} sources)`);

    const result = await renderPromo(settings, {
      channelName: built.channelName,
      channelNumber: job.channelNumber,
      language: built.language,
      color: built.color,
      logoPath: built.logoPath,
      chapters: built.chapters,
      outputFile,
      workDir,
      fontFile: getFontFile(),
      voiceEnabled: settings.voiceEnabled,
      cachePath: settings.cachePath,
      onProgress,
    });
    job.status = 'succeeded';
    job.finishedAt = new Date().toISOString();
    this.lastGenerated.set(job.channelNumber, job.finishedAt);
    this.lastErrors.delete(job.channelNumber);
    if (result.voiceError) {
      this.lastErrors.set(job.channelNumber, `Voice: ${result.voiceError}`);
      this.appendLog(job.id, 'warn', `Voice: ${result.voiceError}`, false);
    }
    const ms = Date.now() - new Date(job.startedAt!).getTime();
    this.appendLog(job.id, 'info', `Succeeded in ${Math.round(ms / 1000)}s → ${outputFile}`, false);
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  private async runPushJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    const onProgress = (message: string, level: JobLogLevel = 'info') => {
      this.appendLog(job.id, level, message);
    };

    const result = await pushToErsatzTv(settings, onProgress);
    const failed = result.results.filter((r) => !r.ok);
    const ok = result.results.length - failed.length;
    job.finishedAt = new Date().toISOString();

    if (result.backup) {
      this.appendLog(
        job.id,
        'info',
        `Backup id ${result.backup.id} (${result.backup.bytes} bytes)`,
        false,
      );
    }

    if (failed.length === 0) {
      job.status = 'succeeded';
      this.appendLog(job.id, 'info', `Succeeded · ${ok} channel(s)`, false);
    } else if (ok === 0) {
      job.status = 'failed';
      job.error = failed.map((r) => `${r.channelName}: ${r.message}`).join('; ');
      this.appendLog(job.id, 'error', `Failed · 0/${result.results.length} channel(s)`, false);
    } else {
      job.status = 'failed';
      job.error = `${failed.length} channel(s) failed`;
      this.appendLog(
        job.id,
        'warn',
        `Finished with errors · ${ok} ok, ${failed.length} failed`,
        false,
      );
    }
  }
}
