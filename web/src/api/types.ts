export type JobState =
  | "queued" | "extracting" | "transcribing" | "verifying"
  | "cleaning" | "done" | "failed" | "cancelled";

export const TERMINAL: JobState[] = ["done", "failed", "cancelled"];

export interface RunOptions {
  input: string; outDir: string; attendees: string[]; terms: string[];
  context: string; model: string; language: string; device: string;
  computeType: string; outputFormats: string[]; extractAudio: boolean;
  wordTimestamps: boolean; diarize: boolean; speakerCount: number;
}

export interface JobProgress {
  stage: JobState; percent: number; processedSeconds: number;
  totalSeconds: number; etaSeconds: number | null;
}

export interface Job {
  id: string; createdAt: string; updatedAt: string; state: JobState;
  input: string; workDir: string | null; mediaPath: string; outDir: string;
  keepAudio: boolean; options: RunOptions;
  probe: { durationSeconds: number; sizeBytes: number } | null;
  progress: JobProgress | null;
  prompt: { text: string; tokens: number; truncated: boolean; dropped: string[] };
  outputs: string[]; meetingPath: string | null;
  wordTimestampFallback: boolean; audioPath: string | null; diarize: boolean;
  error: { message: string; detail: string | null } | null;
  logTail: string[];
}

export interface DirEntry {
  name: string; type: "dir" | "file"; path: string;
  size?: number; mtime?: string; media?: boolean;
}

export interface DirListing {
  path: string; windowsPath: string | null; parent: string | null; entries: DirEntry[];
}

export interface Favorite { label: string; path: string }

export interface ResolvedPath {
  path: string; exists: boolean; media: boolean; size: number | null;
  isDirectory: boolean; windowsPath: string | null;
}

export interface ProbeResult {
  path: string; durationSeconds: number; sizeBytes: number;
  hasVideo: boolean; hasAudio: boolean; audioCodec: string | null;
  estimatedWavBytes: number; estimatedTranscribeSeconds: number;
}

export interface PromptResult {
  prompt: string; tokens: number; budget: number;
  truncated: boolean; dropped: string[];
}

export interface Config {
  engine: string; model: string; language: string; device: string;
  computeType: string; outputFormats: string[]; outputRoot: string;
  whisperPath: string; ffmpegPath: string; extractAudio: boolean;
  keepAudio: boolean; wordTimestamps: boolean;
  hfToken: string; diarize: boolean; speakerCount: number;
  attendees: string[]; terms: string[]; context: string;
}

export interface MeetingRecord {
  version: 1; createdAt: string; input: string; audio: string | null;
  outputDir: string; model: string; language: string; device: string;
  attendees: string[]; terms: string[]; context: string; prompt: string;
  promptTokens: number; promptTruncated: boolean;
  speakers: Record<string, string> | null;
}

export interface MeetingSummary {
  dir: string; path: string; record: MeetingRecord;
  outputs: string[]; sizeBytes: number;
}

export interface Segment {
  id: number; start: number; end: number; text: string; speaker: string | null;
}

export interface Check { name: string; ok: boolean; detail: string; fix?: string }

export interface DiskReport {
  windowsFreeBytes: number; outputFreeBytes: number; warning: string | null;
}

export interface SearchResult {
  dir: string; createdAt: string; matches: { start: number; text: string }[];
}
