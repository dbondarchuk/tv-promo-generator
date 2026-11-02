import fs from 'node:fs';
import path from 'node:path';
import { AppSettings, JobInfo, JobLogEntry, JobLogLevel } from '@promo/shared';
import { promoOutputFile } from '../util/paths.js';
import { createLogger } from '../util/log.js';
import { renderPromo } from '../promo/render.js';
import { buildPromoChaptersForChannel, getFontFile } from './channels.js';

const log = createLogger('jobs');
const MAX_LOGS_PER_JOB = 200;

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

  enqueue(opts: {
    channelNumber: string;
    channelName: string;
    deadline?: Date;
    preferFront?: boolean;
  }): JobInfo {
    const existingQueued = [...this.jobs.values()].find(
      (j) => j.channelNumber === opts.channelNumber && (j.status === 'queued' || j.status === 'running'),
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

    const id = `${opts.channelNumber}-${Date.now()}`;
    const late = Boolean(opts.deadline && opts.deadline.getTime() < Date.now());
    const job: InternalJob = {
      id,
      channelNumber: opts.channelNumber,
      channelName: opts.channelName,
      status: late ? 'late' : 'queued',
      queuedAt: new Date().toISOString(),
      deadline: opts.deadline?.toISOString(),
      late,
      logs: [],
      priority: opts.preferFront || late ? 0 : (opts.deadline?.getTime() ?? Date.now() + 86_400_000),
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.queue.sort((a, b) => (this.jobs.get(a)!.priority - this.jobs.get(b)!.priority));
    this.appendLog(
      id,
      late ? 'warn' : 'info',
      late
        ? `Queued late (deadline ${job.deadline}) · queue #${this.queue.length}`
        : `Queued · position ${this.queue.length}${job.deadline ? ` · deadline ${job.deadline}` : ''}`,
      false,
    );
    log.info('job queued', {
      id,
      channel: opts.channelName,
      number: opts.channelNumber,
      late,
      deadline: job.deadline,
      queueDepth: this.queue.length,
    });
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
    if (level === 'error') log.error(message, { jobId, channel: job.channelName });
    else if (level === 'warn') log.warn(message, { jobId, channel: job.channelName });
    else log.info(message, { jobId, channel: job.channelName });
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

  private async pump(): Promise<void> {
    if (this.running) return;
    const nextId = this.queue.shift();
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
    this.appendLog(job.id, 'info', `Started${job.late ? ' (late)' : ''}`);
    this.emit();

    try {
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
      const ms = Date.now() - new Date(job.startedAt).getTime();
      this.appendLog(job.id, 'info', `Succeeded in ${Math.round(ms / 1000)}s → ${outputFile}`, false);
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      this.lastErrors.set(job.channelNumber, job.error);
      this.appendLog(job.id, 'error', `Failed: ${job.error}`, false);
    }

    this.running = false;
    this.emit();
    void this.pump();
  }
}
