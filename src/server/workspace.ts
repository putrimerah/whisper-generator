import { existsSync, mkdirSync, renameSync, rmSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { WORK_ROOT } from "./jobStore.ts";
import type { Job } from "./jobTypes.ts";

/**
 * Whisper names its output files after the media file it reads, so the wav
 * must carry the source stem. Naming it audio.wav would produce audio.srt.
 */
export function wavNameFor(stem: string): string {
  return `${stem}.wav`;
}

/**
 * Temp workspace for derived audio. Everything in here is ours and is deleted
 * in every terminal state. Nothing under /mnt is ever written or removed.
 */
export function createWorkspace(jobId: string): string {
  const dir = join(WORK_ROOT, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function wavPathFor(workDir: string, stem: string): string {
  return join(workDir, wavNameFor(stem));
}

/**
 * Move the extracted wav next to the transcript when the user asked to keep
 * it, otherwise delete it. Returns the final location, or null when dropped.
 */
export function finalizeAudio(job: Job): string | null {
  if (!job.workDir) return null;
  const wav = wavPathFor(job.workDir, baseStem(job));
  if (!existsSync(wav)) return null;
  if (!job.keepAudio) {
    unlinkSync(wav);
    return null;
  }
  mkdirSync(job.outDir, { recursive: true });
  const target = join(job.outDir, `${baseStem(job)}.16k.wav`);
  try {
    renameSync(wav, target);
  } catch {
    // rename across filesystems (WSL -> /mnt/c) fails with EXDEV; copy instead.
    copyFileSync(wav, target);
    unlinkSync(wav);
  }
  return target;
}

/** The output directory is named after the stem, so reuse it for the wav. */
function baseStem(job: Job): string {
  return job.outDir.split("/").filter(Boolean).pop() ?? "audio";
}

/** Always safe to call, in success, failure and cancellation alike. */
export function cleanupWorkspace(job: Job): void {
  if (!job.workDir) return;
  if (job.workDir.startsWith("/mnt/")) {
    throw new Error(`refusing to remove a workspace on a Windows mount: ${job.workDir}`);
  }
  rmSync(job.workDir, { recursive: true, force: true });
}
