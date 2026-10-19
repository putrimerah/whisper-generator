import type { Device, RunOptions } from "../types.ts";

export type JobState =
  | "queued"
  | "extracting"
  | "transcribing"
  | "verifying"
  | "cleaning"
  | "done"
  | "failed"
  | "cancelled";

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "done",
  "failed",
  "cancelled",
]);

export interface JobProgress {
  stage: JobState;
  percent: number;
  processedSeconds: number;
  totalSeconds: number;
  etaSeconds: number | null;
}

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: JobState;
  /** Original path, read only, never modified. */
  input: string;
  workDir: string | null;
  /** What Whisper actually reads: the extracted wav, or the input itself. */
  mediaPath: string;
  outDir: string;
  keepAudio: boolean;
  options: RunOptions;
  probe: { durationSeconds: number; sizeBytes: number } | null;
  progress: JobProgress | null;
  prompt: { text: string; tokens: number; truncated: boolean; dropped: string[] };
  outputs: string[];
  meetingPath: string | null;
  wordTimestampFallback: boolean;
  /** Final wav location when keepAudio is true, else null. */
  audioPath: string | null;
  /** P3: diarization requested for this job. */
  diarize: boolean;
  error: { message: string; detail: string | null } | null;
  logTail: string[];
}

export interface CreateJobInput {
  input: string;
  outDir: string;
  options: RunOptions;
  keepAudio: boolean;
  diarize: boolean;
  prompt: Job["prompt"];
  probe: Job["probe"];
  device?: Device;
}

export const LOG_TAIL_LIMIT = 200;

/** `20261019T174512-a3f9k2`. Filesystem safe, never derived from a filename. */
export function makeJobId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${iso}-${suffix}`;
}
