import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnvSettings } from "./env.ts";
import { windowsSpecialFolder, windowsUserHome } from "./platform.ts";
import type { Config } from "./types.ts";

/**
 * Transcripts go to the user's Documents folder when there is one.
 *
 * Under WSL that means the Windows profile, following the OneDrive redirect
 * when Windows has set one up, so transcripts are visible in Explorer and
 * backed up. On plain Linux or macOS it is the local Documents folder, or
 * ~/transcripts when that does not exist.
 */
export function defaultOutputRoot(): string {
  const windowsHome = windowsUserHome();
  if (windowsHome) return join(windowsSpecialFolder(windowsHome, "Documents"), "transcripts");
  const local = join(homedir(), "Documents");
  return existsSync(local) ? join(local, "transcripts") : join(homedir(), "transcripts");
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
  // Empty: fsService falls back to the Windows Videos folder.
  browseRoot: "",
  // Prefer the managed venv; fall back to PATH for Windows-native installs.
  whisperPath: existsSync(VENV_WHISPER) ? VENV_WHISPER : "whisper",
  ffmpegPath: "ffmpeg",
  // Whisper reads video directly through ffmpeg; extraction only pays off when
  // re-running transcription on the same source or reading from a slow drive.
  extractAudio: false,
  // Derived file, safe to delete; off keeps the WSL disk small.
  keepAudio: false,
  // Diarization needs a HuggingFace token and acceptance of the pyannote
  // licence. Empty token keeps the feature off and costs nothing.
  hfToken: "",
  diarize: false,
  speakerCount: 0,
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

/**
 * Precedence: .env  >  wg.config.json  >  built-in defaults.
 * CLI flags are applied by the caller and win over all of them.
 */
export function loadConfig(cwd = process.cwd()): {
  config: Config;
  source: string | null;
  envFile: string | null;
} {
  const env = readEnvSettings(cwd);
  const envFile = existsSync(join(cwd, ".env")) ? join(cwd, ".env") : null;

  for (const path of configSearchPaths(cwd)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
      return {
        config: { ...DEFAULT_CONFIG, ...parsed, ...env.config },
        source: path,
        envFile,
      };
    } catch (err) {
      throw new Error(`invalid config at ${path}: ${(err as Error).message}`);
    }
  }
  return { config: { ...DEFAULT_CONFIG, ...env.config }, source: null, envFile };
}
