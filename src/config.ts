import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { windowsUserHome } from "./platform.ts";
import type { Config } from "./types.ts";

/**
 * Transcripts default to the Windows Documents folder so Explorer, search and
 * OneDrive can see them without any configuration. Falls back to ./out when
 * no Windows profile is reachable (plain Linux, or /mnt/c not mounted).
 */
export function defaultOutputRoot(): string {
  const home = windowsUserHome();
  return home ? join(home, "Documents", "transcripts") : "./out";
}

/** Whisper installed by scripts/install-wsl.sh, outside any project directory. */
export const VENV_WHISPER = join(homedir(), ".wg", "venv", "bin", "whisper-ctranslate2");

export const DEFAULT_CONFIG: Config = {
  engine: "auto",
  // Multilingual on purpose: `.en` models mangle Malay and other code-switching.
  // large-v3 fits a 6 GB GPU on CTranslate2 at int8_float16 (~3.5 GB).
  model: "large-v3",
  language: "en",
  device: "auto",
  computeType: "int8_float16",
  outputFormats: ["srt", "vtt", "txt", "json"],
  outputRoot: defaultOutputRoot(),
  // Prefer the managed venv; fall back to PATH for Windows-native installs.
  whisperPath: existsSync(VENV_WHISPER) ? VENV_WHISPER : "whisper",
  ffmpegPath: "ffmpeg",
  // Whisper reads video directly through ffmpeg; extraction only pays off when
  // re-running transcription on the same source or reading from a slow drive.
  extractAudio: false,
  // Derived file, safe to delete; off keeps the WSL disk small.
  keepAudio: false,
  // Opt-in: faster-whisper 1.2.x has an alignment crash; segment timestamps
  // in srt/vtt are unaffected and enough for reading.
  wordTimestamps: false,
  attendees: [],
  terms: [],
  context: "",
};

export const CONFIG_FILENAME = "wg.config.json";

export function configSearchPaths(cwd = process.cwd()): string[] {
  return [join(cwd, CONFIG_FILENAME), join(homedir(), ".wg", CONFIG_FILENAME)];
}

export function loadConfig(cwd = process.cwd()): { config: Config; source: string | null } {
  for (const path of configSearchPaths(cwd)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
      return { config: { ...DEFAULT_CONFIG, ...parsed }, source: path };
    } catch (err) {
      throw new Error(`invalid config at ${path}: ${(err as Error).message}`);
    }
  }
  return { config: { ...DEFAULT_CONFIG }, source: null };
}
