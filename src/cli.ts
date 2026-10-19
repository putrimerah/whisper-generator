#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { CONFIG_FILENAME, DEFAULT_CONFIG, loadConfig } from "./config.ts";
import {
  describePlan,
  detectHost,
  isOnWindowsMount,
  resolvePlan,
  sanitizeForWindows,
  toEnginePath,
  toWslPath,
} from "./platform.ts";
import { planRun, stemOf } from "./pipeline.ts";
import { buildPrompt, PROMPT_TOKEN_BUDGET } from "./prompt.ts";
import { mkdirLine, renderScript } from "./shell.ts";
import { buildEnv, runAll } from "./exec.ts";
import { buildMeetingRecord, MEETING_FILENAME, writeMeetingRecord } from "./meeting.ts";
import { formatChecks, runDoctor } from "./doctor.ts";
import type { Config, Device, Engine, RunOptions } from "./types.ts";

const USAGE = `wg — meeting transcription pipeline

Usage:
  wg run <input> [options]      Extract audio (optional) + transcribe
  wg script <input> [options]   Print a PowerShell/bash script instead of running
  wg prompt [options]           Preview the Whisper initial_prompt
  wg doctor                     Check ffmpeg, Whisper, CUDA, and model fit
  wg plan                       Show host, engine, and resolved config
  wg init [--global]            Write a ${CONFIG_FILENAME} starter

Options:
  --out <dir>            Output directory, POSIX or Windows path
                         (default: <outputRoot>/<input stem>)
  --attendees <list>     Comma-separated names, merged with config attendees
  --terms <list>         Comma-separated jargon/product/Malay terms
  --context <text>       One or two sentences about the meeting
  --model <name>         Whisper model (default: ${DEFAULT_CONFIG.model})
  --language <code>      Forced language or "auto" (default: ${DEFAULT_CONFIG.language})
  --device <auto|cuda|cpu>
  --compute-type <auto|int8|int8_float16|float16|float32>
                         CTranslate2 quantization (default: ${DEFAULT_CONFIG.computeType})
  --engine <auto|windows|native>
  --formats <list>       Output formats (default: ${DEFAULT_CONFIG.outputFormats.join(",")})
  --extract              Extract 16 kHz mono wav first
  --word-timestamps      Per-word timings (slower; falls back on alignment bug)
  --dry-run              Show what would run, change nothing
  -h, --help             This text

Examples:
  wg run "C:/recordings/standup.mp4" --attendees "Irfan,Aisyah" --context "Weekly sprint review"
  wg script ./meeting.mkv --attendees "Irfan,Lee" | clip.exe
`;

const OPTIONS = {
  out: { type: "string" },
  attendees: { type: "string" },
  terms: { type: "string" },
  context: { type: "string" },
  model: { type: "string" },
  language: { type: "string" },
  device: { type: "string" },
  "compute-type": { type: "string" },
  engine: { type: "string" },
  formats: { type: "string" },
  extract: { type: "boolean" },
  "word-timestamps": { type: "boolean" },
  "no-word-timestamps": { type: "boolean" },
  "dry-run": { type: "boolean" },
  global: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = Partial<Record<keyof typeof OPTIONS, string | boolean>>;

function splitList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

function str(flags: Flags, key: keyof typeof OPTIONS, fallback: string): string {
  const v = flags[key];
  return typeof v === "string" && v !== "" ? v : fallback;
}

function buildRunOptions(cfg: Config, flags: Flags, input: string): RunOptions {
  // outputRoot and --out may be given as Windows paths, so transcripts can be
  // written straight into a Windows folder. toWslPath is a no-op for POSIX.
  const outRoot = toWslPath(cfg.outputRoot);
  const explicitOut = str(flags, "out", "");
  const target = explicitOut !== "" ? toWslPath(explicitOut) : "";
  const windowsTarget = isOnWindowsMount(target !== "" ? target : outRoot);
  const stem = windowsTarget ? sanitizeForWindows(stemOf(input)) : stemOf(input);
  const outDir = resolve(target !== "" ? target : join(outRoot, stem));
  const formats = splitList(flags.formats);
  return {
    input: resolve(toWslPath(input)),
    outDir,
    attendees: [...cfg.attendees, ...splitList(flags.attendees)],
    terms: [...cfg.terms, ...splitList(flags.terms)],
    context: str(flags, "context", cfg.context),
    model: str(flags, "model", cfg.model),
    language: str(flags, "language", cfg.language),
    device: str(flags, "device", cfg.device) as Device,
    computeType: str(flags, "compute-type", cfg.computeType) as Config["computeType"],
    outputFormats: formats.length > 0 ? formats : cfg.outputFormats,
    extractAudio: flags.extract === true ? true : cfg.extractAudio,
    wordTimestamps:
      flags["no-word-timestamps"] === true
        ? false
        : flags["word-timestamps"] === true
          ? true
          : cfg.wordTimestamps,
  };
}

function reportPrompt(result: ReturnType<typeof buildPrompt>): void {
  process.stderr.write(
    `prompt: ~${result.tokens}/${PROMPT_TOKEN_BUDGET} tokens${result.truncated ? " (TRIMMED)" : ""}\n`,
  );
  if (result.dropped.length > 0) {
    process.stderr.write(
      `warning: dropped from prompt (over budget): ${result.dropped.join(", ")}. ` +
        `Shorten --context; names and terms are kept on purpose.\n`,
    );
  }
}

function requireInput(input: string | undefined): string {
  if (!input) throw new Error("missing <input>. See `wg --help`.");
  const abs = resolve(toWslPath(input));
  if (!existsSync(abs)) throw new Error(`input not found: ${abs}`);
  return abs;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const flags = values as Flags;
  const command = positionals[0] ?? "help";

  if (flags.help === true || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const { config, source } = loadConfig();
  const engine = str(flags, "engine", config.engine) as Engine;
  const plan = resolvePlan(engine, detectHost());

  switch (command) {
    case "doctor": {
      const checks = runDoctor(config, plan);
      process.stdout.write(formatChecks(checks));
      const failed = checks.filter((c) => !c.ok);
      if (failed.length > 0) {
        process.stderr.write(`\n${failed.length} check(s) failed. Run: bash scripts/install-wsl.sh\n`);
        return 1;
      }
      return 0;
    }

    case "plan": {
      process.stdout.write(
        [
          `host:    ${plan.host}`,
          `engine:  ${plan.engine}${plan.viaInterop ? " (powershell.exe interop)" : ""}`,
          `shell:   ${plan.shell}`,
          `how:     ${describePlan(plan)}`,
          `config:  ${source ?? "defaults (no wg.config.json found)"}`,
          "",
          JSON.stringify(config, null, 2),
          "",
        ].join("\n"),
      );
      return 0;
    }

    case "init": {
      const target =
        flags.global === true
          ? join(homedir(), ".wg", CONFIG_FILENAME)
          : join(process.cwd(), CONFIG_FILENAME);
      if (existsSync(target)) throw new Error(`refusing to overwrite ${target}`);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
      process.stdout.write(`wrote ${target}\n`);
      return 0;
    }

    case "prompt": {
      const result = buildPrompt({
        context: str(flags, "context", config.context),
        attendees: [...config.attendees, ...splitList(flags.attendees)],
        terms: [...config.terms, ...splitList(flags.terms)],
      });
      reportPrompt(result);
      process.stdout.write(`${result.prompt}\n`);
      return 0;
    }

    case "script": {
      const input = requireInput(positionals[1]);
      const opts = buildRunOptions(config, flags, input);
      const planned = planRun(config, opts, plan);
      reportPrompt(planned.prompt);
      const header = `whisper-generator ${new Date().toISOString()} — paste into ${
        plan.shell === "powershell" ? "PowerShell" : "your shell"
      }`;
      const mkdir = mkdirLine(toEnginePath(opts.outDir, plan), plan);
      process.stdout.write(renderScript(planned.commands, plan, header, [mkdir]));
      return 0;
    }

    case "run": {
      const input = requireInput(positionals[1]);
      const opts = buildRunOptions(config, flags, input);
      const planned = planRun(config, opts, plan);
      reportPrompt(planned.prompt);

      if (flags["dry-run"] === true) {
        process.stdout.write(renderScript(planned.commands, plan, "dry run, nothing executed"));
        return 0;
      }

      mkdirSync(opts.outDir, { recursive: true });
      const env = buildEnv(config.whisperPath);

      // whisper-ctranslate2 catches its own exceptions and still exits 0, so a
      // zero status proves nothing. Trust the artifacts instead.
      const transcripts = (): string[] =>
        readdirSync(opts.outDir).filter(
          (f) => f !== MEETING_FILENAME && !f.endsWith(".16k.wav"),
        );

      await runAll(planned.commands, plan, env);
      let produced = transcripts();

      // faster-whisper 1.2.x can crash in find_alignment with an IndexError
      // when a segment yields no alignment. Word timings are the only
      // casualty, so retry without them instead of losing the transcript.
      if (produced.length === 0 && opts.wordTimestamps) {
        process.stderr.write(
          `\nwarning: Whisper produced nothing with --word_timestamps (known ` +
            `faster-whisper alignment bug). Retrying without per-word timings; ` +
            `segment timestamps in srt/vtt are unaffected.\n`,
        );
        opts.wordTimestamps = false;
        const retry = planRun(config, opts, plan);
        await runAll(retry.commands, plan, env);
        produced = transcripts();
      }

      if (produced.length === 0) {
        throw new Error(
          `transcription produced no output in ${opts.outDir}. ` +
            `Read the error above, then run \`wg doctor\`.`,
        );
      }

      const record = buildMeetingRecord(opts, planned.prompt, planned.audioPath, planned.commands, plan);
      const recordPath = writeMeetingRecord(record, opts.outDir);
      process.stderr.write(
        `\n✔ done. ${produced.length} file(s) in ${opts.outDir}\n  ${produced.join(", ")}\n  metadata: ${recordPath}\n`,
      );
      return 0;
    }

    default:
      throw new Error(`unknown command "${command}". See \`wg --help\`.`);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
