export type Engine = "auto" | "windows" | "native";
export type Host = "windows" | "wsl" | "linux" | "macos";
export type Device = "auto" | "cuda" | "cpu";
/** CTranslate2 quantization. Ignored by the reference openai-whisper CLI. */
export type ComputeType = "auto" | "int8" | "int8_float16" | "float16" | "float32";

/** Where and how commands actually execute after `engine: auto` resolves. */
export interface ExecutionPlan {
  host: Host;
  engine: Exclude<Engine, "auto">;
  /** true when commands must be wrapped in powershell.exe from WSL. */
  viaInterop: boolean;
  /** Quoting dialect used when rendering a copy-paste command. */
  shell: "powershell" | "posix";
}

export interface Config {
  engine: Engine;
  /** Whisper model name. Avoid `.en` models when Malay/mixed speech appears. */
  model: string;
  /** Forced decoding language, or "auto" to let Whisper detect. */
  language: string;
  device: Device;
  computeType: ComputeType;
  outputFormats: string[];
  /** Root directory for outputs when --out is omitted. */
  outputRoot: string;
  whisperPath: string;
  ffmpegPath: string;
  /**
   * Extract a 16 kHz mono wav before transcribing. Recommended when the source
   * lives on /mnt/c, so Whisper reads from the fast WSL filesystem instead.
   */
  extractAudio: boolean;
  /** Keep the extracted wav next to the transcript so a re-run skips ffmpeg. */
  keepAudio: boolean;
  wordTimestamps: boolean;
  /** Attendees reused across meetings; per-run --attendees is merged on top. */
  attendees: string[];
  /** Domain glossary: product names, acronyms, Malay terms. Highest prompt priority. */
  terms: string[];
  /** Default meeting context sentence used when --context is omitted. */
  context: string;
}

export interface RunOptions {
  input: string;
  outDir: string;
  attendees: string[];
  terms: string[];
  context: string;
  model: string;
  language: string;
  device: Device;
  computeType: ComputeType;
  outputFormats: string[];
  extractAudio: boolean;
  wordTimestamps: boolean;
}

export interface Command {
  bin: string;
  args: string[];
  /** Human label used in logs and in generated scripts. */
  label: string;
}

export interface MeetingRecord {
  version: 1;
  createdAt: string;
  input: string;
  audio: string | null;
  outputDir: string;
  model: string;
  language: string;
  device: Device;
  attendees: string[];
  terms: string[];
  context: string;
  prompt: string;
  promptTokens: number;
  promptTruncated: boolean;
  /** Reserved for diarization (P2). null until speakers are mapped. */
  speakers: Record<string, string> | null;
  commands: { label: string; rendered: string }[];
}
