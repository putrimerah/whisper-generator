import { basename, extname, join } from "node:path";
import { buildPrompt, type PromptResult } from "./prompt.ts";
import { toEnginePath } from "./platform.ts";
import type { Command, Config, ExecutionPlan, RunOptions } from "./types.ts";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".wma"]);

export function stemOf(input: string): string {
  return basename(input, extname(input));
}

export function isAudio(input: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(input).toLowerCase());
}

/**
 * 16 kHz mono PCM is exactly what Whisper resamples to internally, so this is
 * lossless for transcription purposes and roughly 2 MB per minute.
 */
export function ffmpegCommand(cfg: Config, input: string, wavPath: string, plan: ExecutionPlan): Command {
  return {
    label: "Extract 16 kHz mono audio",
    bin: cfg.ffmpegPath,
    args: [
      "-hide_banner",
      "-loglevel", "warning",
      "-stats",
      "-y",
      "-i", toEnginePath(input, plan),
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      toEnginePath(wavPath, plan),
    ],
  };
}

/**
 * Both `whisper` and `whisper-ctranslate2` accept ONE value here, or `all`.
 * A comma list is rejected, so several formats means `all`
 * (txt, vtt, srt, tsv, json).
 */
export function outputFormatArg(formats: string[]): string {
  if (formats.length === 0) return "all";
  if (formats.length === 1) return formats[0] as string;
  return "all";
}

export function whisperCommand(
  cfg: Config,
  opts: RunOptions,
  mediaPath: string,
  prompt: string,
  plan: ExecutionPlan,
): Command {
  const args = [
    toEnginePath(mediaPath, plan),
    "--model", opts.model,
    "--task", "transcribe",
    "--output_dir", toEnginePath(opts.outDir, plan),
    "--output_format", outputFormatArg(opts.outputFormats),
    "--verbose", "False",
  ];
  // CTranslate2 quantization. int8_float16 is what lets large-v3 fit in 6 GB.
  if (opts.computeType && opts.computeType !== "auto") {
    args.push("--compute_type", opts.computeType);
  }
  if (opts.language !== "auto") args.push("--language", opts.language);
  if (opts.device !== "auto") {
    args.push("--device", opts.device);
    // fp16 on CPU emits a warning per segment and runs slower.
    args.push("--fp16", opts.device === "cuda" ? "True" : "False");
  }
  if (opts.wordTimestamps) args.push("--word_timestamps", "True");
  if (prompt) args.push("--initial_prompt", prompt);
  return { label: "Transcribe with Whisper", bin: cfg.whisperPath, args };
}

export interface PlannedRun {
  prompt: PromptResult;
  audioPath: string | null;
  mediaPath: string;
  commands: Command[];
}

export function planRun(cfg: Config, opts: RunOptions, plan: ExecutionPlan): PlannedRun {
  const prompt = buildPrompt({
    context: opts.context,
    attendees: opts.attendees,
    terms: opts.terms,
  });

  const commands: Command[] = [];
  const needsExtract = opts.extractAudio && !isAudio(opts.input);
  const audioPath = needsExtract ? join(opts.outDir, `${stemOf(opts.input)}.16k.wav`) : null;
  const mediaPath = audioPath ?? opts.input;

  if (audioPath) commands.push(ffmpegCommand(cfg, opts.input, audioPath, plan));
  commands.push(whisperCommand(cfg, opts, mediaPath, prompt.prompt, plan));

  return { prompt, audioPath, mediaPath, commands };
}
