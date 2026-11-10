import {
  AppSettings,
  JobInfo,
  JobKind,
  JobLogEntry,
  JobLogLevel,
  PushOptions,
} from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import { renderPromo } from "../promo/render.js";
import { createLogger } from "../util/log.js";
import { promoOutputFile } from "../util/paths.js";
import {
  buildPromoChaptersForChannel,
  getFontFile,
  invalidateChannelCaches,
} from "./channels.js";
import { rollbackErsatzTvDatabase } from "./etv-backup.js";
import {
  cleanupGraphicsFromErsatzTv,
  pushGraphicsToErsatzTv,
} from "./push-graphics.js";
import { pushToErsatzTv } from "./push.js";
import { runVoPrewarmForChannel } from "./vo-prewarm-run.js";

const log = createLogger("jobs");
const MAX_LOGS_PER_JOB = 400;
const BLOCKING_KINDS: JobKind[] = [
  "push",
  "push-graphics",
  "cleanup-graphics",
  "rollback",
];

/** Waiting or in-flight — includes legacy status "late" used as a queue state. */
function isPendingStatus(status: JobInfo["status"]): boolean {
  return status === "queued" || status === "running" || status === "late";
}

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

  hasPendingGenerate(channelNumber: string): boolean {
    return [...this.jobs.values()].some(
      (j) =>
        j.kind === "generate" &&
        j.channelNumber === channelNumber &&
        isPendingStatus(j.status),
    );
  }

  hasPendingVoPrewarm(channelNumber: string): boolean {
    return [...this.jobs.values()].some(
      (j) =>
        j.kind === "vo-prewarm" &&
        j.channelNumber === channelNumber &&
        isPendingStatus(j.status),
    );
  }

  /** Push/rollback pause generate until they finish. */
  hasBlockingJob(): boolean {
    return [...this.jobs.values()].some(
      (j) =>
        BLOCKING_KINDS.includes(j.kind) &&
        (j.status === "queued" || j.status === "running"),
    );
  }

  /** @deprecated use hasBlockingJob */
  hasActivePush(): boolean {
    return this.hasBlockingJob();
  }

  enqueue(opts: {
    channelNumber: string;
    channelName: string;
    deadline?: Date;
    preferFront?: boolean;
  }): JobInfo {
    const existingQueued = [...this.jobs.values()].find(
      (j) =>
        j.kind === "generate" &&
        j.channelNumber === opts.channelNumber &&
        isPendingStatus(j.status),
    );

    if (existingQueued) {
      this.appendLog(
        existingQueued.id,
        "info",
        "Generate requested again while job still queued/running",
      );

      return this.publicJob(existingQueued);
    }

    const id = `gen-${opts.channelNumber}-${Date.now()}`;
    // Keep status "queued" while waiting — "late" is a flag/label only.
    // Using status:"late" broke dedupe and re-enqueued every scheduler tick.
    const late = Boolean(opts.deadline && opts.deadline.getTime() < Date.now());
    const job: InternalJob = {
      id,
      kind: "generate",
      channelNumber: opts.channelNumber,
      channelName: opts.channelName,
      status: "queued",
      queuedAt: new Date().toISOString(),
      deadline: opts.deadline?.toISOString(),
      late,
      logs: [],
      priority:
        opts.preferFront || late
          ? 10
          : (opts.deadline?.getTime() ?? Date.now() + 86_400_000),
    };

    this.jobs.set(id, job);
    this.queue.push(id);
    this.queue.sort(
      (a, b) => this.jobs.get(a)!.priority - this.jobs.get(b)!.priority,
    );

    const paused = this.hasBlockingJob();
    this.appendLog(
      id,
      late ? "warn" : "info",
      late
        ? `Queued late (deadline ${job.deadline}) · queue #${this.queue.length}`
        : `Queued · position ${this.queue.length}${job.deadline ? ` · deadline ${job.deadline}` : ""}`,
      false,
    );

    if (paused) {
      this.appendLog(
        id,
        "warn",
        "Paused — waiting for Push/Rollback to finish",
        false,
      );
    }

    log.info("generate job queued", {
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

  enqueueVoPrewarm(opts: {
    channelNumber: string;
    channelName: string;
  }): JobInfo {
    const existingQueued = [...this.jobs.values()].find(
      (j) =>
        j.kind === "vo-prewarm" &&
        j.channelNumber === opts.channelNumber &&
        isPendingStatus(j.status),
    );

    if (existingQueued) {
      this.appendLog(
        existingQueued.id,
        "info",
        "VO prewarm requested again while still queued/running",
      );

      return this.publicJob(existingQueued);
    }

    const id = `vo-${opts.channelNumber}-${Date.now()}`;
    const job: InternalJob = {
      id,
      kind: "vo-prewarm",
      channelNumber: opts.channelNumber,
      channelName: opts.channelName,
      status: "queued",
      queuedAt: new Date().toISOString(),
      logs: [],
      priority: 5,
    };

    this.jobs.set(id, job);
    this.queue.push(id);
    this.queue.sort(
      (a, b) => this.jobs.get(a)!.priority - this.jobs.get(b)!.priority,
    );

    this.appendLog(
      id,
      "info",
      `Queued VO prewarm · position ${this.queue.length}`,
      false,
    );

    log.info("vo-prewarm queued", {
      id,
      channel: opts.channelName,
      number: opts.channelNumber,
    });

    this.emit();
    void this.pump();
    return this.publicJob(job);
  }

  enqueuePush(pushOptions: PushOptions): JobInfo {
    return this.enqueueBlocking({
      kind: "push",
      channelNumber: "push",
      channelName: "Push to ErsatzTV",
      pushOptions,
      pauseMessage: "Paused — waiting for Push to ErsatzTV to finish",
    });
  }

  enqueuePushGraphics(): JobInfo {
    return this.enqueueBlocking({
      kind: "push-graphics",
      channelNumber: "push-graphics",
      channelName: "Push Graphics",
      pauseMessage: "Paused — waiting for Push Graphics to finish",
    });
  }

  enqueueCleanupGraphics(): JobInfo {
    return this.enqueueBlocking({
      kind: "cleanup-graphics",
      channelNumber: "cleanup-graphics",
      channelName: "Remove Graphics",
      pauseMessage: "Paused — waiting for Remove Graphics to finish",
    });
  }

  enqueueRollback(backupId?: string): JobInfo {
    return this.enqueueBlocking({
      kind: "rollback",
      channelNumber: "rollback",
      channelName: "Rollback ErsatzTV DB",
      backupId,
      pauseMessage: "Paused — waiting for DB rollback to finish",
    });
  }

  /**
   * Side-band status for an in-flight live promo encode (not queued through pump).
   * One running job per channel+container; returns the job id for log/finish.
   */
  beginLiveStream(opts: {
    channelNumber: string;
    channelName: string;
    container: string;
  }): JobInfo {
    const id = `live-${opts.channelNumber}-${opts.container}`;
    const existing = this.jobs.get(id);
    if (existing && existing.status === "running") {
      this.appendLog(id, "info", "Additional client connected");
      return this.publicJob(existing);
    }

    const job: InternalJob = {
      id,
      kind: "live-stream",
      channelNumber: opts.channelNumber,
      channelName: opts.channelName,
      status: "running",
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      logs: [],
      priority: 100,
    };

    this.jobs.set(id, job);
    this.appendLog(
      id,
      "info",
      `Live ${opts.container} encode starting · #${opts.channelNumber}`,
      false,
    );

    log.info("live-stream job started", {
      id,
      channel: opts.channelName,
      container: opts.container,
    });

    this.emit();
    return this.publicJob(job);
  }

  logLiveStream(jobId: string, level: JobLogLevel, message: string): void {
    if (!this.jobs.has(jobId)) return;

    this.appendLog(jobId, level, message);
  }

  finishLiveStream(
    jobId: string,
    status: "succeeded" | "failed",
    error?: string,
  ): void {
    const job = this.jobs.get(jobId);
    if (!job || job.kind !== "live-stream") return;
    if (job.status !== "running") return;

    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (error) job.error = error;
    this.appendLog(
      jobId,
      status === "succeeded" ? "info" : "error",
      status === "succeeded"
        ? "Live stream ended"
        : `Live stream failed${error ? `: ${error}` : ""}`,
      false,
    );

    this.emit();
  }

  private enqueueBlocking(opts: {
    kind: "push" | "push-graphics" | "cleanup-graphics" | "rollback";
    channelNumber: string;
    channelName: string;
    backupId?: string;
    pushOptions?: PushOptions;
    pauseMessage: string;
  }): JobInfo {
    const existing = [...this.jobs.values()].find(
      (j) =>
        j.kind === opts.kind &&
        (j.status === "queued" || j.status === "running"),
    );

    if (existing) {
      this.appendLog(
        existing.id,
        "info",
        `${opts.kind} requested again while still queued/running`,
      );

      return this.publicJob(existing);
    }

    const id = `${opts.kind}-${Date.now()}`;
    const job: InternalJob = {
      id,
      kind: opts.kind,
      channelNumber: opts.channelNumber,
      channelName: opts.channelName,
      status: "queued",
      queuedAt: new Date().toISOString(),
      backupId: opts.backupId,
      pushOptions: opts.pushOptions,
      logs: [],
      priority: 0,
    };

    this.jobs.set(id, job);
    this.queue.push(id);
    this.queue.sort(
      (a, b) => this.jobs.get(a)!.priority - this.jobs.get(b)!.priority,
    );

    const pushBits: string[] = [];
    if (opts.pushOptions) {
      pushBits.push(
        opts.pushOptions.fillerTypes.length
          ? `fillers: ${opts.pushOptions.fillerTypes.join(", ")}`
          : "fillers: none",
      );

      if (opts.pushOptions.cleanupLegacy) pushBits.push("cleanup legacy");
      if (opts.pushOptions.cleanupUnselected)
        pushBits.push("cleanup unselected");
    }

    this.appendLog(
      id,
      "info",
      `Queued · generation jobs will pause until this finishes` +
        (opts.backupId ? ` · backup ${opts.backupId}` : "") +
        (pushBits.length ? ` · ${pushBits.join(" · ")}` : ""),
      false,
    );

    for (const other of this.jobs.values()) {
      if (
        (other.kind === "generate" || other.kind === "vo-prewarm") &&
        (other.status === "queued" || other.status === "late")
      ) {
        this.appendLog(other.id, "warn", opts.pauseMessage, false);
      }
    }

    if (
      [...this.jobs.values()].some(
        (j) =>
          (j.kind === "generate" || j.kind === "vo-prewarm") &&
          j.status === "running",
      )
    ) {
      this.appendLog(
        id,
        "info",
        "Waiting for in-flight generate job to finish first",
        false,
      );
    }

    log.info(`${opts.kind} job queued`, {
      id,
      backupId: opts.backupId,
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

  private appendLog(
    jobId: string,
    level: JobLogLevel,
    message: string,
    emit = true,
  ): void {
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

    if (level === "error")
      log.error(message, { jobId, channel: job.channelName, kind: job.kind });
    else if (level === "warn")
      log.warn(message, { jobId, channel: job.channelName, kind: job.kind });
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
    const blocking = this.hasBlockingJob();
    for (let i = 0; i < this.queue.length; i++) {
      const id = this.queue[i]!;
      const job = this.jobs.get(id);
      if (!job) {
        this.queue.splice(i, 1);
        i -= 1;
        continue;
      }

      if ((job.kind === "generate" || job.kind === "vo-prewarm") && blocking) {
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
    job.status = "running";
    job.startedAt = new Date().toISOString();
    if (job.deadline && new Date(job.deadline).getTime() < Date.now()) {
      job.late = true;
    }

    this.appendLog(
      job.id,
      "info",
      `Started${job.late ? " (late)" : ""} · ${job.kind}`,
    );

    this.emit();

    try {
      if (job.kind === "push") {
        await this.runPushJob(job);
      } else if (job.kind === "push-graphics") {
        await this.runPushGraphicsJob(job);
      } else if (job.kind === "cleanup-graphics") {
        await this.runCleanupGraphicsJob(job);
      } else if (job.kind === "rollback") {
        await this.runRollbackJob(job);
      } else if (job.kind === "vo-prewarm") {
        await this.runVoPrewarmJob(job);
      } else {
        await this.runGenerateJob(job);
      }
    } catch (err) {
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      if (job.kind === "generate") {
        this.lastErrors.set(job.channelNumber, job.error);
      }

      this.appendLog(job.id, "error", `Failed: ${job.error}`, false);
    }

    this.running = false;
    this.emit();
    void this.pump();
  }

  private async runVoPrewarmJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    await runVoPrewarmForChannel(
      settings,
      job.channelNumber,
      (level, message) => this.appendLog(job.id, level, message),
    );

    job.status = "succeeded";
    job.finishedAt = new Date().toISOString();
  }

  private async runGenerateJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    const onProgress = (message: string, level: JobLogLevel = "info") => {
      this.appendLog(job.id, level, message);
    };

    const built = await buildPromoChaptersForChannel(
      settings,
      job.channelNumber,
      onProgress,
    );

    const outputFile = promoOutputFile(settings.outputPath, built.channelName);
    const workDir = path.join(
      settings.cachePath,
      "work",
      job.channelNumber,
      String(Date.now()),
    );

    fs.mkdirSync(workDir, { recursive: true });
    this.appendLog(
      job.id,
      "info",
      `Rendering promo (${built.language}, ${built.chapters.length} sources)`,
    );

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

    job.status = "succeeded";
    job.finishedAt = new Date().toISOString();
    this.lastGenerated.set(job.channelNumber, job.finishedAt);
    this.lastErrors.delete(job.channelNumber);
    if (result.voiceError) {
      this.lastErrors.set(job.channelNumber, `Voice: ${result.voiceError}`);
      this.appendLog(job.id, "warn", `Voice: ${result.voiceError}`, false);
    }

    const ms = Date.now() - new Date(job.startedAt!).getTime();
    this.appendLog(
      job.id,
      "info",
      `Succeeded in ${Math.round(ms / 1000)}s → ${outputFile}`,
      false,
    );

    fs.rmSync(workDir, { recursive: true, force: true });
  }

  private async runPushGraphicsJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    const onProgress = (message: string, level: JobLogLevel = "info") => {
      this.appendLog(job.id, level, message);
    };

    const result = await pushGraphicsToErsatzTv(settings, onProgress);
    job.finishedAt = new Date().toISOString();
    if (result.ok) {
      job.status = "succeeded";
      this.appendLog(job.id, "info", result.message, false);
    } else {
      job.status = "failed";
      job.error = result.message;
      this.appendLog(job.id, "error", result.message, false);
    }
  }

  private async runCleanupGraphicsJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    const onProgress = (message: string, level: JobLogLevel = "info") => {
      this.appendLog(job.id, level, message);
    };

    const result = await cleanupGraphicsFromErsatzTv(settings, onProgress);
    job.finishedAt = new Date().toISOString();
    if (result.ok) {
      job.status = "succeeded";
      this.appendLog(job.id, "info", result.message, false);
    } else {
      job.status = "failed";
      job.error = result.message;
      this.appendLog(job.id, "error", result.message, false);
    }
  }

  private async runPushJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    const onProgress = (message: string, level: JobLogLevel = "info") => {
      this.appendLog(job.id, level, message);
    };

    const pushOptions = job.pushOptions ?? {
      fillerTypes: [],
      cleanupLegacy: false,
      cleanupUnselected: false,
    };

    const result = await pushToErsatzTv(settings, pushOptions, onProgress);
    const failed = result.results.filter((r) => !r.ok);
    const ok = result.results.length - failed.length;
    job.finishedAt = new Date().toISOString();

    if (result.backup) {
      this.appendLog(
        job.id,
        "info",
        `Backup id ${result.backup.id} (${result.backup.bytes} bytes)`,
        false,
      );
    }

    if (failed.length === 0) {
      job.status = "succeeded";
      this.appendLog(job.id, "info", `Succeeded · ${ok} channel(s)`, false);
    } else if (ok === 0) {
      job.status = "failed";
      job.error = failed
        .map((r) => `${r.channelName}: ${r.message}`)
        .join("; ");

      this.appendLog(
        job.id,
        "error",
        `Failed · 0/${result.results.length} channel(s)`,
        false,
      );
    } else {
      job.status = "failed";
      job.error = `${failed.length} channel(s) failed`;
      this.appendLog(
        job.id,
        "warn",
        `Finished with errors · ${ok} ok, ${failed.length} failed`,
        false,
      );
    }
  }

  private async runRollbackJob(job: InternalJob): Promise<void> {
    const settings = this.settingsProvider();
    this.appendLog(
      job.id,
      "info",
      job.backupId
        ? `Restoring backup ${job.backupId}`
        : "Restoring latest pre-push backup",
    );

    const result = await rollbackErsatzTvDatabase(settings, job.backupId);
    invalidateChannelCaches();
    job.status = "succeeded";
    job.finishedAt = new Date().toISOString();
    this.appendLog(job.id, "info", result.message, false);
  }
}
