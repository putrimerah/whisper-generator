import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { badRequest, notFound } from "./errors.ts";

const execFileAsync = promisify(execFile);

/** Measured on the target GPU: large-v3 int8_float16 runs ~2.3x realtime. */
export const REALTIME_FACTOR = 2.3;
/** 16 kHz, mono, 16-bit PCM. */
export const WAV_BYTES_PER_SECOND = 32000;

export interface ProbeResult {
  path: string;
  durationSeconds: number;
  sizeBytes: number;
  hasVideo: boolean;
  hasAudio: boolean;
  audioCodec: string | null;
  estimatedWavBytes: number;
  estimatedTranscribeSeconds: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

const cache = new Map<string, ProbeResult>();

export async function probeMedia(path: string, ffprobePath = "ffprobe"): Promise<ProbeResult> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw notFound(`file not found: ${path}`);
  }
  const key = `${path}:${stat.mtimeMs}:${stat.size}`;
  const cached = cache.get(key);
  if (cached) return cached;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobePath,
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", path],
      { maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (err) {
    throw badRequest(`ffprobe failed for ${path}`, (err as Error).message);
  }

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw badRequest(`ffprobe returned invalid JSON for ${path}`);
  }

  const streams = parsed.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio");
  const duration = Number(parsed.format?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw badRequest(`could not determine duration of ${path}`);
  }
  if (!audio) throw badRequest(`no audio stream in ${path}`);

  const result: ProbeResult = {
    path,
    durationSeconds: Math.round(duration * 100) / 100,
    sizeBytes: stat.size,
    hasVideo: streams.some((s) => s.codec_type === "video"),
    hasAudio: true,
    audioCodec: audio.codec_name ?? null,
    estimatedWavBytes: Math.round(duration * WAV_BYTES_PER_SECOND),
    estimatedTranscribeSeconds: Math.round(duration / REALTIME_FACTOR),
  };
  cache.set(key, result);
  return result;
}
