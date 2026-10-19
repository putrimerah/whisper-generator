import { existsSync } from "node:fs";
import { join } from "node:path";
import { toWslPath } from "./platform.ts";
import type { Config } from "./types.ts";

export const ENV_FILENAME = ".env";

/**
 * Settings precedence, strongest first:
 *   CLI flags  >  .env  >  wg.config.json  >  built-in defaults
 *
 * `.env` sits above the config file because it is the per-machine,
 * git-ignored layer: paths and secrets that differ between machines belong
 * there, while shared defaults belong in wg.config.json.
 */
export interface EnvSettings {
  config: Partial<Config>;
  port: number | null;
  /** Where the file browser opens. Empty string means auto-detect. */
  browseRoot: string | null;
}

let loaded = false;

/** Reads .env into process.env once. Node 24 parses it natively. */
export function loadEnvFile(cwd = process.cwd()): string | null {
  if (loaded) return null;
  loaded = true;
  const file = join(cwd, ENV_FILENAME);
  if (!existsSync(file)) return null;
  try {
    process.loadEnvFile(file);
    return file;
  } catch {
    return null;
  }
}

function str(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function path(name: string): string | undefined {
  const value = str(name);
  return value === undefined ? undefined : toWslPath(value);
}

function bool(name: string): boolean | undefined {
  const value = str(name)?.toLowerCase();
  if (value === undefined) return undefined;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function num(name: string): number | undefined {
  const value = str(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function list(name: string): string[] | undefined {
  const value = str(name);
  if (value === undefined) return undefined;
  const items = value.split(/[,;]/).map((v) => v.trim()).filter((v) => v !== "");
  return items.length > 0 ? items : undefined;
}

/** Only defined keys are returned, so an empty .env changes nothing. */
export function readEnvSettings(cwd = process.cwd()): EnvSettings {
  loadEnvFile(cwd);

  const config: Partial<Config> = {};
  const assign = <K extends keyof Config>(key: K, value: Config[K] | undefined) => {
    if (value !== undefined) config[key] = value;
  };

  assign("outputRoot", path("WG_OUTPUT_ROOT"));
  assign("browseRoot", path("WG_BROWSE_ROOT"));
  assign("model", str("WG_MODEL"));
  assign("language", str("WG_LANGUAGE"));
  assign("computeType", str("WG_COMPUTE_TYPE") as Config["computeType"] | undefined);
  assign("device", str("WG_DEVICE") as Config["device"] | undefined);
  assign("keepAudio", bool("WG_KEEP_AUDIO"));
  assign("wordTimestamps", bool("WG_WORD_TIMESTAMPS"));
  assign("outputFormats", list("WG_OUTPUT_FORMATS"));
  assign("attendees", list("WG_ATTENDEES"));
  assign("terms", list("WG_TERMS"));
  assign("context", str("WG_CONTEXT"));
  assign("hfToken", str("WG_HF_TOKEN"));
  assign("diarize", bool("WG_DIARIZE"));
  assign("speakerCount", num("WG_SPEAKER_COUNT"));
  assign("whisperPath", path("WG_WHISPER_PATH"));
  assign("ffmpegPath", path("WG_FFMPEG_PATH"));

  return {
    config,
    port: num("WG_PORT") ?? null,
    browseRoot: path("WG_BROWSE_ROOT") ?? null,
  };
}
