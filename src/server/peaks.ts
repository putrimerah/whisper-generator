import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { badRequest, notFound } from "./errors.ts";
import { WG_HOME } from "./jobStore.ts";

/**
 * Loudness envelope for the transcript player's waveform.
 *
 * ffmpeg decodes the audio track to low-rate mono PCM on stdout and we keep
 * one RMS value per window; no audio is written to disk and the source is
 * only read. Demuxing a long video over the Windows mount is slow, so the
 * result is cached under ~/.wg/cache, keyed by path, size and mtime.
 */
export const PEAK_SAMPLE_RATE = 4000;
export const PEAK_WINDOW_SECONDS = 0.25;
export const PEAK_CACHE_DIR = join(WG_HOME, "cache", "peaks");
export const DEFAULT_BUCKETS = 600;

export interface Peaks {
  duration: number;
  peaks: number[];
}

/** Streams signed 16-bit little-endian PCM and records RMS per window. */
export class RmsAccumulator {
  readonly windows: number[] = [];
  private readonly windowSamples: number;
  private sum = 0;
  private count = 0;
  private carry: Buffer | null = null;

  constructor(sampleRate = PEAK_SAMPLE_RATE, windowSeconds = PEAK_WINDOW_SECONDS) {
    this.windowSamples = Math.max(1, Math.round(sampleRate * windowSeconds));
  }

  push(chunk: Buffer): void {
    const buf = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const v = buf.readInt16LE(i) / 32768;
      this.sum += v * v;
      this.count += 1;
      if (this.count === this.windowSamples) this.flush();
    }
    this.carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
  }

  finish(): number[] {
    if (this.count > 0) this.flush();
    return this.windows;
  }

  private flush(): void {
    this.windows.push(Math.sqrt(this.sum / this.count));
    this.sum = 0;
    this.count = 0;
  }
}

/**
 * Collapse RMS windows into `buckets` values between 0 and 1. Each bucket is
 * the mean of its windows: a max would saturate during continuous speech and
 * hide the pauses. Normalised against the 98th percentile so one cough does
 * not flatten everything else.
 */
export function bucketPeaks(windows: number[], buckets: number): number[] {
  if (windows.length === 0 || buckets <= 0) return [];
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.min(windows.length - 1, Math.floor((b * windows.length) / buckets));
    const to = Math.min(windows.length, Math.max(from + 1, Math.floor(((b + 1) * windows.length) / buckets)));
    let sum = 0;
    for (let i = from; i < to; i++) sum += windows[i] ?? 0;
    out.push(sum / (to - from));
  }
  const sorted = [...out].sort((a, b) => a - b);
  const ref = sorted[Math.floor((sorted.length - 1) * 0.98)] || sorted[sorted.length - 1] || 1;
  return out.map((v) => Math.round(Math.min(1, v / ref) * 1000) / 1000);
}

function decodeWindows(path: string, ffmpegPath: string): Promise<number[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const acc = new RmsAccumulator();
    const child = spawn(
      ffmpegPath,
      ["-v", "error", "-nostdin", "-i", path, "-vn", "-ac", "1", "-ar", String(PEAK_SAMPLE_RATE), "-f", "s16le", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => acc.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on("error", (err) => rejectPromise(badRequest(`ffmpeg could not start: ${err.message}`)));
    child.on("close", (code) => {
      // Judge by output, not exit code: no samples means no waveform.
      const windows = acc.finish();
      if (windows.length === 0) {
        rejectPromise(badRequest(`could not read audio from ${path}`, stderr.trim() || `ffmpeg exited with ${code}`));
        return;
      }
      resolvePromise(windows);
    });
  });
}

const inflight = new Map<string, Promise<Peaks>>();

export async function peaksFor(path: string, ffmpegPath: string, buckets = DEFAULT_BUCKETS): Promise<Peaks> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw notFound(`media not found: ${path}`);
  }
  const key = createHash("sha1").update(`${path}:${stat.size}:${stat.mtimeMs}:${buckets}`).digest("hex");
  const cacheFile = join(PEAK_CACHE_DIR, `${key}.json`);
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf8")) as Peaks;
    } catch {
      // unreadable cache: recompute below
    }
  }

  const running = inflight.get(key);
  if (running) return running;

  const job = decodeWindows(path, ffmpegPath)
    .then((windows) => {
      const result: Peaks = {
        duration: Math.round(windows.length * PEAK_WINDOW_SECONDS * 100) / 100,
        peaks: bucketPeaks(windows, buckets),
      };
      try {
        mkdirSync(PEAK_CACHE_DIR, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(result));
      } catch {
        // a cache we cannot write only costs time
      }
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
