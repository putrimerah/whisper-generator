import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildEnv } from "../exec.ts";
import { buildMeetingRecord, MEETING_FILENAME, writeMeetingRecord } from "../meeting.ts";
import { ffmpegCommand, isAudio, stemOf, whisperCommand } from "../pipeline.ts";
import { isOnWindowsMount } from "../platform.ts";
import type { Command, Config, ExecutionPlan, RunOptions } from "../types.ts";
import { assertSpace, estimateNeeded } from "./disk.ts";
import { JobStore } from "./jobStore.ts";
import type { Job, JobProgress, JobState } from "./jobTypes.ts";
import { cleanupWorkspace, createWorkspace, finalizeAudio, wavPathFor } from "./workspace.ts";

export interface RunnerEvent {
  jobId: string;
  type: "state" | "progress" | "log" | "done" | "error";
  data: unknown;
}

type EventListener = (event: RunnerEvent) => void;

/** tqdm bar written by whisper-ctranslate2 to stderr. */
const TQDM_PERCENT = /(\d+)%\|/;
const TQDM_RATIO = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/;
const DETECTED_LANG = /Detected language '([^']+)' with probability ([\d.]+)/;
/** ffmpeg progress line: `time=00:01:23.45`. */
const FFMPEG_TIME = /time=(\d+):(\d{2}):(\d{2})\.(\d+)/;

const PROGRESS_INTERVAL_MS = 500;
const RATE_WINDOW_MS = 30_000;

export class JobRunner {
  private readonly listeners = new Set<EventListener>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly cancelled = new Set<string>();
  private running = false;

  private readonly store: JobStore;
  private readonly config: Config;
  private readonly plan: ExecutionPlan;

  constructor(store: JobStore, config: Config, plan: ExecutionPlan) {
    this.store = store;
    this.config = config;
    this.plan = plan;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RunnerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setState(job: Job, state: JobState, patch: Partial<Job> = {}): Job {
    const updated = this.store.setState(job.id, state, patch);
    this.emit({ jobId: job.id, type: "state", data: { state, at: updated.updatedAt } });
    return updated;
  }

  private log(job: Job, stream: "stdout" | "stderr", line: string): void {
    if (line.trim() === "") return;
    this.store.appendLog(job.id, line);
    this.emit({ jobId: job.id, type: "log", data: { stream, line } });
  }

  /** Transcription is strictly serial: a second large-v3 would OOM the GPU. */
  async enqueue(jobId: string): Promise<void> {
    if (this.running) return;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.store.list().reverse().find((j) => j.state === "queued");
        if (!next) break;
        await this.execute(next);
      }
    } finally {
      this.running = false;
    }
  }

  cancel(jobId: string): boolean {
    const job = this.store.get(jobId);
    if (!job) return false;
    this.cancelled.add(jobId);
    const child = this.children.get(jobId);
    if (child?.pid) {
      try {
        // Negative pid kills the whole process group, so ffmpeg/whisper
        // children die with their parent instead of becoming orphans.
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    if (job.state === "queued") {
      this.setState(job, "cancelled");
      this.cleanup(job);
    }
    return true;
  }

  private cleanup(job: Job): void {
    try {
      cleanupWorkspace(this.store.get(job.id) ?? job);
    } catch (err) {
      this.log(job, "stderr", `cleanup failed: ${(err as Error).message}`);
    }
  }

  private async execute(initial: Job): Promise<void> {
    let job = initial;
    try {
      if (this.cancelled.has(job.id)) {
        this.setState(job, "cancelled");
        this.cleanup(job);
        return;
      }

      const duration = job.probe?.durationSeconds ?? 0;
      const workDir = createWorkspace(job.id);
      job = this.store.update(job.id, { workDir });

      await assertSpace(workDir, job.outDir, estimateNeeded(duration, job.options.extractAudio));
      mkdirSync(job.outDir, { recursive: true });

      // Extraction: pull audio off the Windows drive once, onto fast storage.
      let mediaPath = job.input;
      if (job.options.extractAudio) {
        job = this.setState(job, "extracting");
        const wav = wavPathFor(workDir, stemOf(job.input));
        const cmd = ffmpegCommand(this.config, job.input, wav, this.plan);
        await this.spawnStage(job, cmd, "extracting", duration);
        if (this.cancelled.has(job.id)) throw new CancelledError();
        if (!existsSync(wav) || statSync(wav).size === 0) {
          throw new Error("audio extraction produced no output");
        }
        mediaPath = wav;
        job = this.store.update(job.id, { mediaPath });
      }

      job = this.setState(job, "transcribing");
      const options: RunOptions = { ...job.options, input: mediaPath, outDir: job.outDir };
      await this.spawnStage(
        job,
        whisperCommand(this.config, options, mediaPath, job.prompt.text, this.plan),
        "transcribing",
        duration,
      );
      if (this.cancelled.has(job.id)) throw new CancelledError();

      // whisper-ctranslate2 exits 0 even when it failed, so trust artifacts.
      job = this.setState(job, "verifying");
      let outputs = this.verify(job);

      if (outputs.length === 0 && options.wordTimestamps) {
        this.log(
          job,
          "stderr",
          "no output with --word_timestamps (known faster-whisper alignment bug); retrying without",
        );
        const retryOptions: RunOptions = { ...options, wordTimestamps: false };
        job = this.store.update(job.id, {
          wordTimestampFallback: true,
          options: { ...job.options, wordTimestamps: false },
          state: "transcribing",
        });
        await this.spawnStage(
          job,
          whisperCommand(this.config, retryOptions, mediaPath, job.prompt.text, this.plan),
          "transcribing",
          duration,
        );
        job = this.setState(job, "verifying");
        outputs = this.verify(job);
      }

      if (outputs.length === 0) {
        throw new Error(
          "transcription produced no output files. Check the log above and run `wg doctor`.",
        );
      }

      job = this.setState(job, "cleaning");
      const audioPath = finalizeAudio(job);
      this.cleanup(job);

      const record = buildMeetingRecord(
        { ...job.options, input: job.input, outDir: job.outDir },
        {
          prompt: job.prompt.text,
          tokens: job.prompt.tokens,
          truncated: job.prompt.truncated,
          dropped: job.prompt.dropped,
        },
        audioPath,
        [],
        this.plan,
      );
      const meetingPath = writeMeetingRecord(record, job.outDir);

      job = this.setState(job, "done", {
        outputs,
        audioPath,
        meetingPath,
        workDir: null,
        progress: {
          stage: "done",
          percent: 100,
          processedSeconds: duration,
          totalSeconds: duration,
          etaSeconds: 0,
        },
      });
      this.emit({ jobId: job.id, type: "done", data: { state: "done", outputs, meetingPath } });
    } catch (err) {
      const cancelled = err instanceof CancelledError || this.cancelled.has(job.id);
      this.cleanup(job);
      if (cancelled) {
        this.setState(job, "cancelled", { workDir: null });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.setState(job, "failed", {
          workDir: null,
          error: { message, detail: null },
        });
        this.emit({ jobId: job.id, type: "error", data: { message, detail: null } });
      }
    } finally {
      this.cancelled.delete(job.id);
      this.children.delete(job.id);
    }
  }

  private verify(job: Job): string[] {
    if (!existsSync(job.outDir)) return [];
    const files = readdirSync(job.outDir).filter(
      (f) => f !== MEETING_FILENAME && !f.endsWith(".16k.wav"),
    );
    const meaningful = files.filter((f) => {
      try {
        return statSync(join(job.outDir, f)).size > 0;
      } catch {
        return false;
      }
    });
    const hasText = meaningful.some((f) => f.endsWith(".txt") || f.endsWith(".srt"));
    if (!hasText) return [];
    const jsonFile = meaningful.find((f) => f.endsWith(".json"));
    if (jsonFile) {
      try {
        JSON.parse(readFileSync(join(job.outDir, jsonFile), "utf8"));
      } catch {
        return [];
      }
    }
    return meaningful.sort();
  }

  private spawnStage(
    job: Job,
    command: Command,
    stage: JobState,
    totalSeconds: number,
  ): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(command.bin, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildEnv(this.config.whisperPath),
        detached: true,
      });
      this.children.set(job.id, child);

      const started = Date.now();
      const samples: { at: number; seconds: number }[] = [];
      let lastEmit = 0;
      let processed = 0;

      const pushProgress = (seconds: number, percentHint?: number) => {
        processed = seconds;
        const now = Date.now();
        samples.push({ at: now, seconds });
        while (samples.length > 2 && now - (samples[0] as { at: number }).at > RATE_WINDOW_MS) {
          samples.shift();
        }
        if (now - lastEmit < PROGRESS_INTERVAL_MS) return;
        lastEmit = now;

        const first = samples[0];
        const elapsed = (now - (first?.at ?? started)) / 1000;
        const advanced = seconds - (first?.seconds ?? 0);
        const rate = elapsed > 0 ? advanced / elapsed : 0;
        const remaining = Math.max(0, totalSeconds - seconds);
        const enoughData = now - started > 10_000 && rate > 0;

        const progress: JobProgress = {
          stage,
          percent:
            percentHint ??
            (totalSeconds > 0 ? Math.min(99, Math.round((seconds / totalSeconds) * 100)) : 0),
          processedSeconds: Math.round(seconds),
          totalSeconds: Math.round(totalSeconds),
          etaSeconds: enoughData ? Math.round(remaining / rate) : null,
        };
        this.store.update(job.id, { progress });
        this.emit({ jobId: job.id, type: "progress", data: progress });
      };

      const handle = (chunk: Buffer, streamName: "stdout" | "stderr") => {
        const text = chunk.toString("utf8");
        for (const raw of text.split(/[\r\n]/)) {
          const line = raw.trim();
          if (line === "") continue;

          const ratio = TQDM_RATIO.exec(line);
          const percent = TQDM_PERCENT.exec(line);
          if (percent && ratio) {
            pushProgress(Number(ratio[1]), Number(percent[1]));
            continue;
          }
          const ff = FFMPEG_TIME.exec(line);
          if (ff) {
            const seconds =
              Number(ff[1]) * 3600 + Number(ff[2]) * 60 + Number(ff[3]) + Number(`0.${ff[4]}`);
            pushProgress(seconds);
            continue;
          }
          if (DETECTED_LANG.test(line)) this.log(job, streamName, line);
          else if (!percent) this.log(job, streamName, line);
        }
      };

      child.stdout?.on("data", (c: Buffer) => handle(c, "stdout"));
      child.stderr?.on("data", (c: Buffer) => handle(c, "stderr"));

      child.on("error", (err) => {
        this.children.delete(job.id);
        const hint =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `${command.bin} not found. Run: bash scripts/install-wsl.sh`
            : err.message;
        rejectPromise(new Error(hint));
      });

      child.on("close", (code, signal) => {
        this.children.delete(job.id);
        void processed;
        if (this.cancelled.has(job.id)) {
          rejectPromise(new CancelledError());
          return;
        }
        // Exit code is not evidence of success here; verification decides.
        if (code === 0 || code === null) resolvePromise();
        else rejectPromise(new Error(`${command.label} failed with exit code ${code}${signal ? ` (${signal})` : ""}`));
      });
    });
  }
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** Audio already on the WSL filesystem needs no extraction pass. */
export function shouldExtract(inputPath: string): boolean {
  if (isOnWindowsMount(inputPath)) return true;
  return !isAudio(inputPath);
}
