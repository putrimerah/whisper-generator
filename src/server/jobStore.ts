import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  LOG_TAIL_LIMIT,
  makeJobId,
  TERMINAL_STATES,
  type CreateJobInput,
  type Job,
  type JobState,
} from "./jobTypes.ts";

/**
 * Jobs, temporary audio and caches. WG_STATE_DIR (absolute, read from the
 * shell at startup) moves them elsewhere; `make demo` uses it so the demo
 * never shows your real job history.
 */
const stateOverride = process.env.WG_STATE_DIR?.trim();
export const WG_HOME = stateOverride && isAbsolute(stateOverride) ? stateOverride : join(homedir(), ".wg");
export const JOBS_FILE = join(WG_HOME, "jobs.json");
export const WORK_ROOT = join(WG_HOME, "work");

type Listener = (job: Job) => void;

/**
 * In-memory job list with atomic JSON persistence. Deliberately not a
 * database: the queue is small, human-scale, and inspectable by hand.
 */
export class JobStore {
  private jobs: Job[] = [];
  private readonly listeners = new Set<Listener>();

  private readonly file: string;

  constructor(file: string = JOBS_FILE) {
    this.file = file;
  }

  load(): void {
    if (!existsSync(this.file)) {
      this.jobs = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      this.jobs = Array.isArray(parsed) ? (parsed as Job[]) : [];
    } catch {
      // A corrupt queue must not stop the server from starting.
      this.jobs = [];
    }
    // A job still marked running means the server died mid-run. It cannot be
    // resumed, so mark it failed rather than leaving a permanent "running" lie.
    const now = new Date().toISOString();
    for (const job of this.jobs) {
      if (!TERMINAL_STATES.has(job.state)) {
        job.state = "failed";
        job.updatedAt = now;
        job.error = { message: "interrupted by server restart", detail: null };
      }
    }
    this.persist();
  }

  create(input: CreateJobInput): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: makeJobId(),
      createdAt: now,
      updatedAt: now,
      state: "queued",
      input: input.input,
      workDir: null,
      mediaPath: input.input,
      outDir: input.outDir,
      keepAudio: input.keepAudio,
      options: input.options,
      probe: input.probe,
      progress: null,
      prompt: input.prompt,
      outputs: [],
      meetingPath: null,
      wordTimestampFallback: false,
      audioPath: null,
      diarize: input.diarize,
      error: null,
      logTail: [],
    };
    this.jobs.unshift(job);
    this.persist();
    this.emit(job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  list(): Job[] {
    return [...this.jobs];
  }

  update(id: string, patch: Partial<Job>): Job {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    this.emit(job);
    return job;
  }

  setState(id: string, state: JobState, patch: Partial<Job> = {}): Job {
    return this.update(id, { ...patch, state });
  }

  appendLog(id: string, line: string): void {
    const job = this.get(id);
    if (!job) return;
    job.logTail.push(line);
    if (job.logTail.length > LOG_TAIL_LIMIT) {
      job.logTail.splice(0, job.logTail.length - LOG_TAIL_LIMIT);
    }
    // Deliberately not persisted per line; log churn would thrash the disk.
  }

  remove(id: string): boolean {
    const index = this.jobs.findIndex((j) => j.id === id);
    if (index === -1) return false;
    this.jobs.splice(index, 1);
    this.persist();
    return true;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Write via temp file + rename so a crash cannot truncate the queue. */
  persist(): void {
    mkdirSync(WG_HOME, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.jobs, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);
  }

  private emit(job: Job): void {
    for (const listener of this.listeners) listener(job);
  }
}
