# P2 Implementation Plan — `wg ui` (local web app)

**Status:** approved for implementation
**Audience:** the AI coding agent that will implement this (GLM 5.3 Flash / DeepSeek Flash)
**Prerequisite:** P1 (CLI) is complete, installed, and verified working on the target machine

---

## 0. HOW TO USE THIS DOCUMENT

Read sections 1–6 fully before writing any code. Then implement tasks in
section 10 **in order**, T1 first. Each task has explicit acceptance criteria.
Do not start a task until the previous one passes its criteria.

### 0.1 Rules you MUST follow

1. **Do not invent CLI flags.** The complete, verified list of
   `whisper-ctranslate2` flags is in section 3.4. If a flag is not in that
   list, it does not exist. Do not guess.
2. **Do not modify behaviour of existing P1 modules** (`src/prompt.ts`,
   `src/pipeline.ts`, `src/platform.ts`, `src/shell.ts`, `src/exec.ts`,
   `src/meeting.ts`, `src/config.ts`) except where a task explicitly says so.
   The UI is a caller, not a rewrite.
3. **Server runtime dependencies: zero.** Use only `node:` built-in modules on
   the server. The allowed client dependency list is section 9.1. Adding any
   other dependency requires stopping and asking.
4. **Every file path in this document is relative to the repository root**
   `/home/irfan/works/whisper-generator` unless stated otherwise.
5. **Never delete, move, rename, or overwrite a file the user did not create
   through this app.** Source recordings are read-only inputs. Writing NEW
   transcript files into the user-configured output directory is allowed, even
   when that directory is on `/mnt/<drive>`. Full rules in section 5.2 and 5.8.
6. **Do not add authentication, TLS, Docker, cloud upload, or a database.**
   Out of scope, section 1.3.
7. If reality contradicts this document (a function signature differs, a flag
   is missing), **trust reality, stop, and report the contradiction**. Do not
   paper over it with a workaround.
8. TypeScript `strict` is on, `noUncheckedIndexedAccess` is on. Code must
   compile with `npm run typecheck` producing zero errors.

### 0.2 Definition of done for the whole plan

```bash
npm run typecheck     # 0 errors
npm test              # all tests pass
npm run build         # succeeds
wg ui                 # serves on http://127.0.0.1:7788
```
Plus every task's acceptance criteria met.

---

## 1. CONTEXT

### 1.1 What this project does

Turns a meeting recording into a transcript. Before this project the user did
8 manual steps: copy an ffmpeg script, edit paths, run it in PowerShell, ask an
AI for a Whisper prompt, copy a Whisper script, edit paths, paste the prompt,
run it. P1 reduced that to one command. P2 gives it a UI.

### 1.2 Goals of P2

1. Pick the recording through a file browser instead of typing a path.
2. Read the recording in place from `/mnt/c`, extract only the audio into WSL,
   and clean up that derived audio afterwards.
3. Fill in attendees, context, and glossary terms in a form, with a live
   preview of the Whisper prompt and its token budget.
4. Watch progress live instead of staring at a terminal.
5. Keep a library of past meetings, re-runnable with changed settings.

### 1.3 Explicit non-goals (do NOT build these)

- Authentication, user accounts, multi-user support
- HTTPS / TLS
- Docker or any containerisation
- Any cloud service, upload, or external API call
- A database (SQLite, Postgres, anything). State lives in JSON files
- Mobile layout. Desktop browser only
- Speaker diarization. That is P3, section 12
- LLM summaries. That is P3, section 12
- Windows-native execution. The user chose "option C — all inside WSL"

---

## 2. VERIFIED ENVIRONMENT

These values were measured on the target machine. Do not assume different ones.

| Fact | Value |
|---|---|
| Host OS | Windows 11, single 512 GB SSD, drive `C:` only |
| C: free space | ~27 GB (TIGHT — section 5.5 depends on this) |
| WSL distro | `Ubuntu22`, WSL2 |
| WSL vhdx location | `C:\WSL\Ubuntu22\ext4.vhdx`, ~59 GB, dynamically expanding |
| **WSL `df` is misleading** | Reports ~904 GB free. The real limit is C: free space. Always compute free space from `/mnt/c` |
| GPU | NVIDIA RTX 4050 Laptop, 6 GB VRAM, driver 581.86 |
| Node | v24.11.1 at `/home/irfan/.nvm/versions/node/v24.11.1/bin/node` |
| Python (venv) | 3.10.12 at `/home/irfan/.wg/venv/bin/python` |
| ffmpeg | `/home/irfan/.local/bin/ffmpeg` (static build, user-level) |
| ffprobe | `/home/irfan/.local/bin/ffprobe` |
| Whisper CLI | `/home/irfan/.wg/venv/bin/whisper-ctranslate2` v0.5.8 |
| faster-whisper | 1.2.1 |
| ctranslate2 | 4.8.3, CUDA device count 1 |
| CUDA libs | `nvidia-cublas-cu12` 12.9.2.10, `nvidia-cudnn-cu12` 9.27.0.42, inside the venv |
| Model in use | `large-v3` at `int8_float16` (~3.5 GB VRAM, fits the 6 GB GPU) |
| Model cache | `~/.cache/huggingface`, ~3.1 GB |
| Windows user | `mirfa`; home is `/mnt/c/Users/mirfa` from WSL |
| Measured speed | 60 s of audio → 26 s wall clock (~2.3× realtime) including model load |

### 2.1 Facts the implementer will get wrong without warning

- `whisper-ctranslate2` **exits with status 0 even when transcription fails.**
  Never trust its exit code. Verify output files exist. P1 already does this in
  `src/cli.ts`; the UI must do the same.
- `--output_format` accepts **one** value or `all`. A comma-separated list is
  rejected. `src/pipeline.ts` exports `outputFormatArg()` which handles this.
- CUDA libraries live in `venv/lib/python3.10/site-packages/nvidia/*/lib`,
  which the dynamic loader does not search. `src/exec.ts` exports `buildEnv()`
  which injects `LD_LIBRARY_PATH`. **Every spawn of the Whisper CLI must pass
  that env**, or it dies with `Library libcublas.so.12 is not found`.
- `faster-whisper` 1.2.1 crashes with `IndexError` in `find_alignment` when
  `--word_timestamps` is used on some files. P1 retries without it. The UI must
  do the same, section 6.6.
- Reading from `/mnt/c` is several times slower than reading from the WSL
  filesystem. That is why audio is extracted to the WSL disk once, section 5.

---

## 3. EXISTING CODE — INVENTORY

Do not re-implement any of this. Import it.

### 3.1 File layout as of today

```
src/
  cli.ts          CLI entry, commands: run script prompt plan doctor init help
  config.ts       config loading and defaults
  doctor.ts       environment health checks
  exec.ts         process spawning, LD_LIBRARY_PATH injection
  meeting.ts      meeting.json sidecar
  pipeline.ts     ffmpeg + whisper command builders
  platform.ts     host detection, WSL↔Windows path translation
  prompt.ts       Whisper initial_prompt builder with 224-token budget
  shell.ts        PowerShell/POSIX quoting, script rendering
  types.ts        shared types
  prompt.test.ts  tests
scripts/
  install-wsl.sh  installs ffmpeg + whisper-ctranslate2 + CUDA libs
```

### 3.2 Exported API you will call

```ts
// src/config.ts
export const VENV_WHISPER: string;          // path to whisper-ctranslate2
export const DEFAULT_CONFIG: Config;
export const CONFIG_FILENAME = "wg.config.json";
export function configSearchPaths(cwd?: string): string[];
export function loadConfig(cwd?: string): { config: Config; source: string | null };

// src/platform.ts
export function detectHost(): Host;                                  // "wsl" here
export function resolvePlan(engine: Engine, host?: Host): ExecutionPlan;
export function toEnginePath(p: string, plan: ExecutionPlan): string;
export function describePlan(plan: ExecutionPlan): string;

// src/prompt.ts
export const PROMPT_TOKEN_BUDGET = 224;
export function estimateTokens(text: string): number;
export function buildPrompt(input: PromptInput): PromptResult;
//   PromptInput  = { context?, attendees?, terms?, lead?, budget? }
//   PromptResult = { prompt, tokens, truncated, dropped }

// src/pipeline.ts
export function stemOf(input: string): string;          // basename without extension
export function isAudio(input: string): boolean;
export function outputFormatArg(formats: string[]): string;
export function ffmpegCommand(cfg: Config, input: string, wavPath: string, plan: ExecutionPlan): Command;
export function whisperCommand(cfg: Config, opts: RunOptions, mediaPath: string, prompt: string, plan: ExecutionPlan): Command;
export function planRun(cfg: Config, opts: RunOptions, plan: ExecutionPlan): PlannedRun;
//   PlannedRun = { prompt: PromptResult; audioPath: string | null; mediaPath: string; commands: Command[] }

// src/exec.ts
export function cudaLibraryPath(whisperPath: string): string[];
export function buildEnv(whisperPath: string): NodeJS.ProcessEnv;   // ALWAYS use for whisper spawns
export class CommandError extends Error { command; code; signal }
export function runCommand(cmd: Command, plan: ExecutionPlan, env?: NodeJS.ProcessEnv): Promise<void>;
export function runAll(commands: Command[], plan: ExecutionPlan, env?: NodeJS.ProcessEnv): Promise<void>;

// src/meeting.ts
export const MEETING_FILENAME = "meeting.json";
export function buildMeetingRecord(opts, prompt, audioPath, commands, plan): MeetingRecord;
export function writeMeetingRecord(record: MeetingRecord, outDir: string): string;

// src/doctor.ts
export interface Check { name: string; ok: boolean; detail: string; fix?: string }
export function runDoctor(cfg: Config, plan: ExecutionPlan): Check[];
export function formatChecks(checks: Check[]): string;

// src/shell.ts
export function quotePowerShell(v: string): string;
export function quotePosix(v: string): string;
export function renderCommand(cmd: Command, plan: ExecutionPlan): string;
export function renderScript(commands: Command[], plan: ExecutionPlan, header?: string, prelude?: string[]): string;
```

### 3.3 Existing types (src/types.ts)

```ts
export type Engine = "auto" | "windows" | "native";
export type Host = "windows" | "wsl" | "linux" | "macos";
export type Device = "auto" | "cuda" | "cpu";
export type ComputeType = "auto" | "int8" | "int8_float16" | "float16" | "float32";

export interface ExecutionPlan {
  host: Host; engine: "windows" | "native"; viaInterop: boolean;
  shell: "powershell" | "posix";
}

export interface Config {
  engine: Engine; model: string; language: string; device: Device;
  computeType: ComputeType; outputFormats: string[]; outputRoot: string;
  whisperPath: string; ffmpegPath: string; extractAudio: boolean;
  keepAudio: boolean; wordTimestamps: boolean;
  attendees: string[]; terms: string[]; context: string;
}

export interface RunOptions {
  input: string; outDir: string; attendees: string[]; terms: string[];
  context: string; model: string; language: string; device: Device;
  computeType: ComputeType; outputFormats: string[]; extractAudio: boolean;
  wordTimestamps: boolean;
}

export interface Command { bin: string; args: string[]; label: string }

export interface MeetingRecord {
  version: 1; createdAt: string; input: string; audio: string | null;
  outputDir: string; model: string; language: string; device: Device;
  attendees: string[]; terms: string[]; context: string; prompt: string;
  promptTokens: number; promptTruncated: boolean;
  speakers: Record<string, string> | null;
  commands: { label: string; rendered: string }[];
}
```

### 3.4 Complete verified `whisper-ctranslate2` flag list

This is the full output of `whisper-ctranslate2 --help` on the target machine.
**Any flag not in this list does not exist.**

```
--append_punctuations --batch_size --batched --beam_size --best_of
--compression_ratio_threshold --compute_type --condition_on_previous_text
--device --device_index --hallucination_silence_threshold --hf_token
--highlight_words --hotwords --initial_prompt --language --length_penalty
--live_input_device --live_input_device_sample_rate --live_transcribe
--live_volume_threshold --local_files_only --logprob_threshold
--max_line_count --max_line_width --max_words_per_line --model --model_dir
--model_directory --multilingual --no_repeat_ngram_size --no_speech_threshold
--output_dir --output_format --patience --prefix --prepend_punctuations
--pretty_json --print_colors --prompt_reset_on_temperature
--repetition_penalty --speaker_name --speaker_num --suppress_blank
--suppress_tokens --task --temperature --temperature_increment_on_fallback
--threads --vad_filter --vad_max_speech_duration_s
--vad_min_silence_duration_ms --vad_min_speech_duration_ms --vad_threshold
--verbose --version --word_timestamps
```

`--output_format` valid values: `txt`, `vtt`, `srt`, `tsv`, `json`, `all`.
Using `all` produces all five.

---

## 4. ARCHITECTURE

```
WINDOWS                                WSL (Ubuntu22)
┌───────────────────┐                  ┌──────────────────────────────────────┐
│ Browser (Edge)    │  localhost:7788  │ wg ui   node:http server             │
│  React SPA        │◄────────────────►│  ├─ GET  /                static SPA │
│                   │  auto-forwarded  │  ├─ REST /api/*                      │
└───────────────────┘   by WSL2        │  └─ SSE  /api/jobs/:id/stream        │
                                       │             │                        │
  recordings live at                   │             ▼                        │
  C:\Users\mirfa\Videos\...            │   ffmpeg ──────────► whisper ──────► │
  READ ONLY, never modified            │   (extract audio)    (transcribe)    │
  visible as /mnt/c/Users/mirfa/...    │             │                        │
                                       │             ▼                        │
                                       │   ~/.wg/work/<jobId>/  (temp)        │
                                       │   <outputRoot>/<stem>/ (results)     │
                                       └──────────────────────────────────────┘
```

Process model: ONE node process. No worker threads. No cluster. Child
processes (`ffmpeg`, `whisper-ctranslate2`) are spawned per job stage.

---

## 5. SOURCE HANDLING — READ IN PLACE, EXTRACT AUDIO

The user records meetings on Windows. Those files stay on Windows, untouched.
WSL reads them directly through `/mnt/c`. **Nothing is copied. Nothing the user
owns is ever deleted.**

### 5.1 The rule

```
Windows source (/mnt/c/.../meeting.mp4)   READ ONLY, NEVER MODIFIED, NEVER DELETED
        │
        │  ffmpeg reads it once
        ▼
WSL audio (~/.wg/work/<jobId>/audio.16k.wav)   derived, ours, safe to delete
        │
        │  whisper-ctranslate2 reads the wav
        ▼
Transcripts (<outDir>/<stem>.srt .vtt .txt .tsv .json + meeting.json)
```

Why extract instead of pointing Whisper straight at the video:

1. The wav lands on the fast WSL filesystem, so a re-run never re-reads
   `/mnt/c`, which is several times slower.
2. 16 kHz mono PCM is exactly what Whisper resamples to internally, so nothing
   is lost.
3. A 1-hour meeting becomes ~115 MB of wav instead of a multi-GB video.

### 5.2 What may be deleted, and by whom

| File | Owner | Deletable |
|---|---|---|
| Windows source video | the user | **NEVER.** Not by any code path in this project |
| Any pre-existing file in `outputRoot` | the user | never overwritten without the collision check in 5.8 |
| `~/.wg/work/<jobId>/audio.16k.wav` | us, derived | yes, automatically, per `keepAudio` |
| `<outDir>/*` transcripts | us, derived | only by the user through an explicit UI action |

There is no trash, no confirmation modal, no source-deletion flag. The feature
does not exist. If an implementation step seems to require deleting something
under `/mnt/c`, that step is wrong — stop and report it.

### 5.3 Job state machine

```
queued
  → extracting     ffmpeg: /mnt/c source  →  WSL wav
  → transcribing   whisper-ctranslate2 on the wav
  → verifying      transcript files exist and are non-empty
  → cleaning       delete the wav unless keepAudio is true
  → done

any state → failed     (on error; cleaning still runs)
any state → cancelled  (on user cancel; cleaning still runs)
```

Notes:
- `extracting` is skipped when the selected source is already an audio file
  that lives on the WSL filesystem. If an audio file lives on `/mnt/c`, still
  extract, to get it onto the fast disk.
  Use `isAudio()` from `src/pipeline.ts` and a `/mnt/` prefix test.
- `cleaning` always runs, including on failure and cancellation, so partial
  wavs never leak.

### 5.4 Directory layout

```
~/.wg/
  wg.config.json          user-level config (may not exist)
  work/<jobId>/           temp workspace, removed when the job leaves `cleaning`
    audio.16k.wav         extracted audio
  jobs.json               persisted job queue, section 7.4

<outputRoot>/<stem>/      results, outputRoot defaults to ./out
  <stem>.srt .vtt .txt .tsv .json
  <stem>.16k.wav          only when keepAudio is true
  meeting.json
```

`jobId` format: `<ISO8601 compact>-<6 random lowercase alphanumerics>`,
e.g. `20261019T174512-a3f9k2`. Must be filesystem-safe. Never derive it from
the filename.

When `keepAudio` is true, the wav is **moved** from the work dir into `outDir`
during `cleaning`, so a re-run can reuse it. When false, it is deleted.

### 5.8 Output location — configurable, may be a Windows folder

`outputRoot` is user-configurable and MAY point at a Windows directory, so
transcripts land somewhere Explorer and OneDrive can see. All three forms are
accepted and normalised:

| Input form | Stored/used as |
|---|---|
| `C:\\Users\\mirfa\\Documents\\transcripts` | `/mnt/c/Users/mirfa/Documents/transcripts` |
| `C:/Users/mirfa/Documents/transcripts` | same |
| `/mnt/c/Users/mirfa/Documents/transcripts` | unchanged |
| `/home/irfan/transcripts` | unchanged |
| `./out` | resolved against the working directory |

Use `toWslPath()` from `src/platform.ts`. It is idempotent, so applying it to
an already-POSIX path is safe. Never hand a raw `C:\...` string to ffmpeg or
Whisper; they run inside WSL and will fail.

**NTFS constraints that apply when the target is on `/mnt/<drive>`**

Detect with `isOnWindowsMount(path)` from `src/platform.ts`, then:

1. Sanitise the filename stem with `sanitizeForWindows()`. NTFS rejects
   `< > : " | ? * \ /`, control characters, trailing dots and spaces, and the
   reserved device names `CON PRN AUX NUL COM1-9 LPT1-9`. Whisper derives output
   filenames from the input stem, so an unsanitised stem fails with an opaque
   I/O error. A meeting file named `sync: Q3 review.mp4` must become
   `sync_ Q3 review`.
2. Path length: keep the full output path under 240 characters. If the
   computed path exceeds that, truncate the stem, preserving the extension,
   and record the original in `meeting.json`.
3. NTFS is case-insensitive. Treat `Standup` and `standup` as the same
   directory when checking for collisions.
4. Writes to `/mnt` are slower than the WSL filesystem. Transcripts are under
   1 MB per hour, so this is irrelevant for them. It matters only when
   `keepAudio` is true, which writes ~115 MB per hour; warn in the UI when both
   conditions hold.
5. Do not attempt to set permissions or ownership on `/mnt` paths. `chmod` is
   a no-op there and may throw.

**Collision rule.** If `<outputRoot>/<stem>/` already exists and contains a
`meeting.json`, the UI must offer three choices and default to the first:
`Create a new folder <stem>-2`, `Overwrite the previous transcript`,
`Open the existing transcript instead`. Never silently overwrite.

**Validation on `POST /api/jobs`.** `outDir` must, after `toWslPath()` and
`path.resolve()`, be inside the configured `outputRoot`, or inside a path the
user explicitly chose through the output picker in the same request. Reject
anything else with `FORBIDDEN_PATH`. This stops a crafted request from writing
into, say, `/mnt/c/Windows`.

### 5.5 Disk space guard

Free space must be measured against the filesystem that will actually receive
the bytes, and never by reading `df` on `/`, whose output is meaningless here
(section 2).

```ts
import { statfs } from "node:fs/promises";

/**
 * Paths on /mnt/<drive> consume that Windows drive directly.
 * Paths on the WSL filesystem consume ext4.vhdx, which lives on C:.
 * Either way the honest number comes from statfs on a Windows mount.
 */
async function freeBytesFor(targetPath: string): Promise<number> {
  const probePath = isOnWindowsMount(targetPath)
    ? targetPath.split("/").slice(0, 3).join("/")   // "/mnt/c"
    : "/mnt/c";                                     // vhdx backing store
  const { bavail, bsize } = await statfs(probePath);
  return bavail * bsize;
}
```

Check BOTH the work directory (always WSL) and `outDir` (may be a different
Windows drive). Use the smaller of the two results.

Required space:

```
wavBytes = durationSeconds * 32000           // 16 kHz, mono, 16-bit PCM
needed   = wavBytes + 500_000_000            // 500 MB safety margin
```

Transcripts are under 1 MB per hour and are ignored in the estimate.

If `needed > freeBytes`: refuse to start, respond `409 DISK_FULL`, name both
numbers in the message. Do not start a job that cannot finish.

If `freeBytes < 5 GB`, show a persistent warning banner in the UI.

### 5.6 Reclaiming space later

Deleting files inside WSL does not shrink `ext4.vhdx`, so C: free space does
not return on its own. The Health screen must show this hint verbatim:

```
wsl --shutdown
wsl --manage Ubuntu22 --set-sparse true
```

Run from PowerShell, once. Display it as information, never execute it.

### 5.7 Extraction command

Use `ffmpegCommand()` from `src/pipeline.ts` unchanged. It produces:

```
ffmpeg -hide_banner -loglevel warning -stats -y -i <source> \
       -vn -ac 1 -ar 16000 -c:a pcm_s16le <wavPath>
```

`-vn` drops the video stream, which is why a 2 GB mp4 yields a ~115 MB/h wav.
For UI progress, additionally parse ffmpeg's stderr `time=HH:MM:SS.ms` against
the probed duration (section 6.3).

## 6. PIPELINE EXECUTION

### 6.1 Reuse, do not rewrite

Build the command list with `planRun()` from `src/pipeline.ts`. The UI differs
from the CLI only in *where paths point* (temp workspace) and *how output is
reported* (SSE instead of inherited stdio).

### 6.2 Spawn requirements

```ts
spawn(cmd.bin, cmd.args, {
  stdio: ["ignore", "pipe", "pipe"],   // NOT "inherit" — we must parse output
  env: buildEnv(config.whisperPath),   // MANDATORY, see section 2.1
  detached: true,                      // own process group, enables group kill
});
```

### 6.3 Progress parsing

`whisper-ctranslate2` writes a tqdm progress bar to **stderr**. Observed format:

```
 62%|██████▏   | 37.0/60.0106875 [00:04<00:02, 10.04seconds/s]
```

Parse with:

```ts
const TQDM = /(\d+)%\|/;                       // percentage
const RATIO = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)/; // processed/total seconds
const LANG = /Detected language '([^']+)' with probability ([\d.]+)/;
```

Rules:
- The bar uses `\r`, not `\n`. Split incoming chunks on `/[\r\n]/`.
- Emit a progress event at most every 500 ms. Do not emit per chunk; it floods
  SSE.
- ffmpeg progress: pass `-progress pipe:1 -nostats` is NOT currently used by
  `ffmpegCommand()`. For the UI, parse ffmpeg's stderr `time=HH:MM:SS.ms` and
  divide by the known duration.

### 6.4 ETA

```
etaSeconds = (durationSeconds - processedSeconds) / observedRate
```
where `observedRate` is a rolling average of processed audio-seconds per wall
second over the last 30 s. On the target machine the steady-state rate is
roughly 2.3× realtime. Show `—` until at least 10 s of data exists. Never show
a fabricated ETA.

### 6.5 Concurrency

- Transcription: **strictly one at a time.** The GPU has 6 GB; two `large-v3`
  processes will OOM. Enforce with a queue of depth 1.
- Audio extraction (ffmpeg): may run for the next queued job while the current
  job transcribes, since it is CPU-bound. Cap total concurrent child processes
  at 3.

### 6.6 Word-timestamp fallback

Mirror the CLI logic exactly:

1. If `wordTimestamps` is on and verification finds zero output files,
2. log a warning to the job, set `wordTimestamps` to false,
3. rebuild the command with `planRun()` and run once more,
4. if it fails again, the job fails.

Record `wordTimestampFallback: true` in the job when this happens.

### 6.7 Verification (the `verifying` state)

```
1. List outDir.
2. Exclude meeting.json and any *.16k.wav.
3. Require at least one remaining file.
4. Require at least one of <stem>.txt or <stem>.srt to exist and have size > 0.
5. If the .json transcript exists, parse it; invalid JSON is a failure.
```

Failing verification means the job FAILED, regardless of child exit codes. This
is the guard against the "exits 0 while broken" behaviour.

---

## 7. SERVER API CONTRACT

Base URL `http://127.0.0.1:7788`. All request and response bodies are JSON
(`application/json`) except SSE and media streaming.

Error shape, used by every endpoint:

```json
{ "error": { "code": "DISK_FULL", "message": "human readable", "detail": "optional" } }
```

Error codes: `BAD_REQUEST`, `NOT_FOUND`, `DISK_FULL`, `BUSY`, `FORBIDDEN_PATH`,
`JOB_FAILED`, `INTERNAL`.

### 7.1 Filesystem browsing

**`GET /api/fs?path=<absolute path>&dirsOnly=<bool>`**

Lists one directory. If `path` is omitted, returns the favorites root.
`dirsOnly=true` omits files entirely; the output-directory picker uses it.
`path` is passed through `toWslPath()` first, so a Windows path works here too.

Response:

```json
{
  "path": "/mnt/c/Users/mirfa/Videos",
  "windowsPath": "C:\\Users\\mirfa\\Videos",
  "parent": "/mnt/c/Users/mirfa",
  "entries": [
    { "name": "recordings", "type": "dir",  "path": "/mnt/c/Users/mirfa/Videos/recordings" },
    { "name": "standup.mp4", "type": "file", "path": "/mnt/c/Users/mirfa/Videos/standup.mp4",
      "size": 734003200, "mtime": "2026-10-19T09:12:00.000Z", "media": true }
  ]
}
```

Rules:
- Sort directories first, then files, both case-insensitive by name.
- `media: true` when the extension is one of:
  `.mp4 .mkv .mov .avi .webm .m4v .wmv .flv .ts` (video) or
  `.wav .mp3 .m4a .flac .ogg .aac .wma` (audio).
- Hide dotfiles unless `?showHidden=true`.
- **Path safety:** reject any path that is not absolute, contains `..` after
  normalisation, or resolves outside the allowlist. Allowlist roots:
  `/mnt/`, `/home/<user>/`, and `outputRoot`. Return `FORBIDDEN_PATH` otherwise.
- Never follow symlinks outside the allowlist.

**`GET /api/fs/favorites`**

```json
{
  "favorites": [
    { "label": "Videos",    "path": "/mnt/c/Users/mirfa/Videos" },
    { "label": "Downloads", "path": "/mnt/c/Users/mirfa/Downloads" },
    { "label": "Desktop",   "path": "/mnt/c/Users/mirfa/Desktop" },
    { "label": "WSL home",  "path": "/home/irfan" },
    { "label": "Output",    "path": "/home/irfan/works/whisper-generator/out" }
  ]
}
```

Derive the Windows username from `/mnt/c/Users` by picking the directory that
contains `Videos` or `Desktop`. Omit entries whose path does not exist. Do not
hardcode `mirfa` in source; discover it.

**`POST /api/fs/resolve`** — converts a pasted Windows path.

Request: `{ "path": "C:\\Users\\mirfa\\Videos\\standup.mp4" }`
Response: `{ "path": "/mnt/c/Users/mirfa/Videos/standup.mp4", "exists": true, "media": true, "size": 734003200 }`

Implementation: run `wslpath -u <input>`. If that fails, fall back to a manual
transform (`C:\x\y` → `/mnt/c/x/y`, backslashes to slashes, drive letter
lowercased). Accept forward-slash Windows paths too.

### 7.2 Media probe

**`GET /api/probe?path=<abs path>`**

Runs `ffprobe -v error -show_format -show_streams -of json <path>` and returns:

```json
{
  "path": "/mnt/c/Users/mirfa/Videos/standup.mp4",
  "durationSeconds": 1038.06,
  "sizeBytes": 734003200,
  "hasVideo": true,
  "hasAudio": true,
  "audioCodec": "aac",
  "estimatedWavBytes": 33217920,
  "estimatedTranscribeSeconds": 451
}
```

`estimatedTranscribeSeconds = durationSeconds / 2.3`, rounded. Cache probe
results in memory keyed by `path + mtime + size`.

### 7.3 Prompt preview

**`POST /api/prompt`**

Request:
```json
{ "context": "Weekly sprint review", "attendees": ["Irfan","Aisyah"], "terms": ["Kafka"] }
```
Response (straight from `buildPrompt()`, plus the budget):
```json
{ "prompt": "The following is ...", "tokens": 54, "budget": 224, "truncated": false, "dropped": [] }
```

Must call `buildPrompt()` from `src/prompt.ts`. Do not reimplement the budget.

### 7.4 Jobs

**`POST /api/jobs`** — create and enqueue.

Request (all fields required unless marked optional):

```json
{
  "input": "/mnt/c/Users/mirfa/Videos/standup.mp4",
  "outDir": "/home/irfan/works/whisper-generator/out/standup",
  "attendees": ["Irfan", "Aisyah"],
  "terms": ["Kafka", "Sybil"],
  "context": "Weekly sprint review",
  "model": "large-v3",
  "language": "en",
  "computeType": "int8_float16",
  "outputFormats": ["srt", "vtt", "txt", "json"],
  "wordTimestamps": false,
  "keepAudio": false
}
```

- `input` must pass the path allowlist and point at an existing media file.
- `keepAudio`: when true the extracted wav is moved into `outDir` instead of
  being deleted, so a re-run skips extraction.
- There is no copy mode and no source-deletion field. Reject a request body
  containing unknown keys with `400 BAD_REQUEST`.
- Validate disk space (section 5.5) before accepting. Insufficient →
  `409 DISK_FULL`.

Response `201`: the full Job object (section 7.5).

**`GET /api/jobs`** — all jobs, newest first.
**`GET /api/jobs/:id`** — one job.
**`DELETE /api/jobs/:id`** — cancel if running/queued; remove from list if
terminal. Cancelling kills the process group and runs `cleaning`.
**`POST /api/jobs/:id/retry`** — clone the job's settings into a new job.

**`GET /api/jobs/:id/stream`** — Server-Sent Events.

Event types, each `data:` is JSON on one line:

```
event: state      data: {"state":"transcribing","at":"2026-10-19T17:45:12.000Z"}
event: progress   data: {"stage":"transcribing","percent":62,"processedSeconds":37,"totalSeconds":60,"etaSeconds":10}
event: log        data: {"stream":"stderr","line":"Detected language 'English' with probability 1.000000"}
event: done       data: {"state":"done","outputs":["standup.srt","standup.txt"],"meetingPath":"..."}
event: error      data: {"message":"...","detail":"..."}
```

Send a `: keepalive` comment every 15 s. On client reconnect, immediately send
the current state before resuming the stream.

### 7.5 Job object

```ts
export type JobState =
  | "queued" | "extracting" | "transcribing"
  | "verifying" | "cleaning" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;                     // 20261019T174512-a3f9k2
  createdAt: string;              // ISO
  updatedAt: string;              // ISO
  state: JobState;
  input: string;                  // original path on /mnt/c, never modified
  workDir: string | null;         // ~/.wg/work/<id> while the wav exists
  mediaPath: string;              // the extracted wav whisper actually reads
  outDir: string;
  keepAudio: boolean;
  options: RunOptions;            // exactly the P1 type
  probe: { durationSeconds: number; sizeBytes: number } | null;
  progress: { stage: JobState; percent: number; processedSeconds: number;
              totalSeconds: number; etaSeconds: number | null } | null;
  prompt: { text: string; tokens: number; truncated: boolean; dropped: string[] };
  outputs: string[];              // filenames in outDir, filled at `done`
  meetingPath: string | null;
  wordTimestampFallback: boolean;
  audioPath: string | null;       // final wav location when keepAudio is true
  error: { message: string; detail: string | null } | null;
  logTail: string[];              // last 200 lines, for the UI
}
```

Persist the array of jobs to `~/.wg/jobs.json` after every state change, using
atomic write (write `jobs.json.tmp`, then `rename`). On startup, load it and
mark any job in a non-terminal state as `failed` with message
`"interrupted by server restart"`.

### 7.6 Results

**`GET /api/meetings`** — scan `outputRoot/*/meeting.json`, newest first.

```json
{ "meetings": [ { "dir": "...", "record": { /* MeetingRecord */ },
                  "outputs": ["standup.srt"], "sizeBytes": 123456 } ] }
```

**`GET /api/meetings/:dir/transcript`** — parsed segments for the viewer:

```json
{ "segments": [ { "id": 0, "start": 0.0, "end": 3.0, "text": "Irfan, are you coming tomorrow, or...?" } ],
  "language": "en", "duration": 1038.06 }
```

Source of truth is `<stem>.json` produced by Whisper. If absent, parse the
`.srt`. `:dir` is the directory name only, resolved under `outputRoot`; reject
anything containing `/` or `..`.

**`GET /api/meetings/:dir/file/:name`** — download one artifact.
`Content-Type` by extension, `Content-Disposition: attachment`.

**`GET /api/media?path=<abs>`** — stream source audio/video with HTTP Range
support, so the transcript viewer can seek. Honour `Range`, respond `206` with
`Content-Range`. Apply the same path allowlist as `/api/fs`.

### 7.7 Config, doctor, disk

**`GET /api/config`** → `{ "config": Config, "source": string | null, "defaults": Config }`
**`PUT /api/config`** → body is a partial `Config`; merge, validate, write to
`./wg.config.json` (project) and return the merged result. Reject unknown keys.
**`GET /api/doctor`** → `{ "checks": Check[] }` from `runDoctor()`.
**`GET /api/disk`** → `{ "windowsFreeBytes": n, "wslVhdxBytes": n, "warning": string|null }`.
Compute the first with `statfs("/mnt/c")`. Warning when under 5 GB.

---

## 8. SERVER IMPLEMENTATION NOTES

### 8.1 No framework

Use `node:http`. Routing is a small table of `[method, pattern, handler]` with
`URLPattern` or a hand-rolled matcher. Keep it in `src/server/router.ts`.

### 8.2 Static assets

In production serve `web/dist` from disk with correct MIME types and
`Cache-Control: no-store` for `index.html`. In development the user runs Vite on
port 5173 with a proxy to 7788; the node server does not need to know about it.

### 8.3 Binding and opening

Bind to `127.0.0.1` only. Never `0.0.0.0`.
Port default 7788, override with `--port`. If the port is in use, fail with a
clear message; do not auto-increment silently.
`wg ui --open` additionally runs:
```ts
spawn("powershell.exe", ["-NoProfile", "-Command", "Start-Process", "http://localhost:7788"], { detached: true });
```
Failure to open the browser is a warning, not an error.

### 8.4 Shutdown

On `SIGINT`/`SIGTERM`: stop accepting connections, kill all child process
groups, run `cleaning` for active jobs, persist `jobs.json`, exit 0. Do not
leave orphaned ffmpeg or whisper processes.

---

## 9. FRONTEND SPECIFICATION

### 9.1 Allowed dependencies

Exactly these, no others:

| Package | Purpose |
|---|---|
| `react`, `react-dom` | UI |
| `typescript`, `vite`, `@vitejs/plugin-react` | build |
| `tailwindcss`, `postcss`, `autoprefixer` | styling |
| `@tanstack/react-query` | server state, polling, caching |
| `wouter` | routing (3 kB; do not use react-router) |

No component library, no icon package (use inline SVG), no state manager, no
form library, no date library.

### 9.2 Layout

```
web/
  index.html
  vite.config.ts            proxy /api → http://127.0.0.1:7788
  src/
    main.tsx
    App.tsx                 routes + shell
    api/client.ts           typed fetch wrappers, one function per endpoint
    api/types.ts            mirrors section 7 types EXACTLY
    hooks/useJobStream.ts   EventSource subscription
    components/
      FilePicker.tsx
      MeetingForm.tsx
      PromptMeter.tsx
      JobCard.tsx
      JobProgress.tsx
      TranscriptViewer.tsx
      DiskBanner.tsx
    pages/
      NewRun.tsx            "/"
      Jobs.tsx              "/jobs"
      Library.tsx           "/library"
      Meeting.tsx           "/library/:dir"
      Settings.tsx          "/settings"
      Health.tsx            "/health"
```

### 9.3 Screen: New Run (`/`)

Three stacked sections, each collapsible, all visible on one page.

**Section 1 — Source**
- Tab A "Browse": breadcrumb bar, favorites sidebar, directory listing.
  Directories navigate on single click. Media files are selectable; non-media
  files are greyed out and unclickable. Show size and modified date.
- Tab B "Paste path": a text input accepting a Windows path, with a hint
  reading `Shift+Right-click a file in Explorer → "Copy as path"`. Calls
  `POST /api/fs/resolve` on blur and shows the resolved WSL path.
- After selection, show a probe summary card: filename, duration formatted
  `H:MM:SS`, size, estimated transcription time.

**Section 2 — Meeting details**
- Attendees: chip input. Enter or comma commits a chip. Backspace on empty
  input removes the last chip. Suggestions come from the union of attendees
  across `/api/meetings` plus config defaults.
- Context: textarea, 3 rows, placeholder
  `One or two sentences: what this meeting is about.`
- Terms: chip input, same behaviour. Helper text: `Project names, acronyms,
  Malay words — anything Whisper would otherwise spell phonetically.`
- `PromptMeter`: debounced 400 ms call to `POST /api/prompt`. Renders a bar of
  `tokens / 224`. Green under 180, amber 180–224, red when `truncated`. When
  `dropped` is non-empty, list the dropped section names with the sentence
  `Over budget — these were dropped: context. Names and terms are kept.`

**Section 3 — Processing**
- A static, non-interactive info line stating what will happen:
  `Audio is extracted from the recording into WSL. Your Windows file is read
   only and is never moved, changed, or deleted.`
- `Keep extracted audio` toggle, off by default, with the hint
  `Keeps a ~115 MB/hour wav next to the transcript so a re-run skips
   extraction.`
- Model select, language select, compute-type select, output-format
  multi-select, word-timestamps toggle (off by default, with the hint
  `Known faster-whisper crash; wg retries without them automatically`).
- Output directory: defaults to `<outputRoot>/<stem>`, editable through the
  same `FilePicker` in `dirsOnly` mode, plus a paste field accepting a Windows
  path. Show the resolved POSIX path and, when it is on `/mnt`, the Windows
  form too, so the user can confirm where Explorer will find the files.
  On a collision, present the three choices from section 5.8.
  When the target is on `/mnt` and `keepAudio` is on, show the note
  `Keeping audio writes ~115 MB/hour to a Windows drive.`
- Submit button `Start transcription`. Disabled until a valid media file is
  selected.

**Submit flow**
1. `POST /api/jobs`.
2. On `201`, navigate to `/jobs` and auto-subscribe to the new job's stream.
3. On `409 DISK_FULL`, show the server message inline above the submit button.

There is no delete confirmation anywhere, because nothing the user owns is
ever deleted.

### 9.4 Screen: Jobs (`/jobs`)

- List of `JobCard`, newest first, polled every 2 s via React Query, plus a
  live `EventSource` for any job in a non-terminal state.
- `JobCard` shows: filename, state badge, progress bar with percent, elapsed,
  ETA, current stage label, and an expandable log tail (last 200 lines,
  monospace, auto-scrolled).
- State badge colours: queued grey, extracting blue,
  transcribing indigo, verifying/cleaning amber, done green, failed red,
  cancelled slate.
- Actions: Cancel (non-terminal), Retry (failed/cancelled),
  Open results (done, links to `/library/<dir>`), Remove from list (terminal).
- A `done` card states the disposition of the derived audio, either
  `Temporary audio deleted` or `Audio kept: <path>`. The Windows source is
  never mentioned as changed, because it never is.

### 9.5 Screen: Library (`/library`) and Meeting (`/library/:dir`)

Library: cards from `/api/meetings` showing date, stem, duration, attendees,
model, and output formats present. Click opens the meeting.

Meeting page:
- Header: filename, date, model, language, attendees, terms.
- `TranscriptViewer`: virtualised list of segments, each `[HH:MM:SS] text`.
  Clicking a timestamp seeks the `<audio>` element sourced from
  `/api/media?path=<record.audio ?? record.input>`.
- Search box filters segments case-insensitively and highlights matches.
- Buttons: copy full transcript, download each artifact, re-run with changes
  (prefills New Run with this meeting's settings).
- "Fix a word" affordance: selecting text in a segment offers
  `Add "<selection>" to glossary`, which PUTs the term into config. This is the
  loop that fixes phonetic misspellings of Malay words and project names.

### 9.6 Screens: Settings and Health

Settings: a form over `Config`, grouped as Engine / Model / Output / Defaults.
Shows which file the config came from. Save calls `PUT /api/config`.

Health: renders `/api/doctor` checks as rows with ✔/✘, detail, and the fix
command in a copyable code block. Plus the disk figures from `/api/disk`.

### 9.7 Global

- `DiskBanner` at the top of every page when `windowsFreeBytes < 5 GB`.
- All times displayed as `H:MM:SS` for durations and local time for timestamps.
- No toasts for errors; render errors inline where the action happened.

---

## 10. TASK BREAKDOWN

Implement in this order. Each task ends with a working, committed state.

### T1 — Job types and store
**Files:** `src/server/jobTypes.ts`, `src/server/jobStore.ts`, `src/server/jobStore.test.ts`
**Do:** Define `JobState` and `Job` exactly as section 7.5.
Implement `JobStore` with `create`, `get`, `list`, `update`, `remove`,
`persist`, `load`. Atomic write via tmp + rename. On `load`, mark non-terminal
jobs as `failed` with `"interrupted by server restart"`.
**Acceptance:** tests cover create→update→persist→load round-trip, id format
`/^\d{8}T\d{6}-[a-z0-9]{6}$/`, and the restart-recovery rule. `npm test` passes.

### T2 — Path safety and filesystem service
**Files:** `src/server/fsService.ts`, `src/server/fsService.test.ts`
**Do:** `isPathAllowed(p)`, `listDirectory(p, { showHidden, dirsOnly })`,
`favorites()`, media-extension classification per section 7.1.
For Windows-path conversion, import `toWslPath()` from `src/platform.ts`; do
not write a second implementation. Also export `ensureOutputDir(p)` applying
section 5.8: convert, resolve, sanitise the stem when
`isOnWindowsMount(p)`, enforce the 240-character limit, and perform the
case-insensitive collision check.
Discover the Windows username from `/mnt/c/Users`; do not hardcode it.
**Acceptance:** tests prove `..` traversal, relative paths, and `/etc/passwd`
are rejected; `C:\Users\x\a.mp4` resolves to `/mnt/c/Users/x/a.mp4`;
directories sort before files; `dirsOnly` returns no files; a stem containing
`: " ?` is sanitised only when the target is on `/mnt`, and left untouched for
a WSL target.

### T3 — Probe service
**Files:** `src/server/probe.ts`, `src/server/probe.test.ts`
**Do:** Run `ffprobe` with the exact arguments in section 7.2, parse JSON,
compute `estimatedWavBytes` and `estimatedTranscribeSeconds`, cache by
`path+mtime+size`.
**Acceptance:** returns correct duration for `medias/ai_module_clarity.mp4`;
a missing file produces a typed error, not a crash.

### T4 — Disk guard
**Files:** `src/server/disk.ts`, `src/server/disk.test.ts`
**Do:** `freeBytesFor(targetPath)` exactly as section 5.5 (probing the correct
Windows mount for `/mnt` targets and `/mnt/c` for WSL targets),
`estimateNeeded(...)`, `assertSpace(workDir, outDir, needed)` taking the
smaller of the two free-space figures and throwing a `DISK_FULL` typed error.
**Acceptance:** unit test with injected numbers covers the boundary at exactly
`needed === free` (must fail) and `needed < free` (must pass); a `/mnt/d`
target probes `/mnt/d`, not `/mnt/c`.

### T5 — HTTP server skeleton
**Files:** `src/server/router.ts`, `src/server/server.ts`, `src/server/errors.ts`
**Do:** `node:http` server, table-based router, JSON body parsing with a 1 MB
limit, uniform error envelope, 127.0.0.1 binding, `--port`, static file serving
of `web/dist` when present.
**Acceptance:** `GET /api/health` returns `{"ok":true}`; unknown route returns
404 in the error envelope; a malformed JSON body returns `BAD_REQUEST`.

### T6 — Read-only endpoints
**Files:** `src/server/routes/fs.ts`, `routes/probe.ts`, `routes/prompt.ts`,
`routes/config.ts`, `routes/doctor.ts`, `routes/disk.ts`
**Do:** Implement sections 7.1, 7.2, 7.3, 7.7. `/api/prompt` must call
`buildPrompt()`; `/api/doctor` must call `runDoctor()`.
**Acceptance:** curl examples in section 11.2 all return the documented shapes.

### T7 — Workspace service
**Files:** `src/server/workspace.ts`, `src/server/workspace.test.ts`
**Do:** Implement section 5: `createWorkspace(jobId)` under `~/.wg/work/`,
`wavPathFor(job)`, `finalizeAudio(job)` which moves the wav into `outDir` when
`keepAudio` is true and deletes it otherwise, and `cleanupWorkspace(job)` which
removes the work dir in every terminal state.
**Acceptance:** tests with temp files prove the work dir is removed on success,
failure, and cancellation; `keepAudio: true` leaves the wav in `outDir` and
removes the work dir; `keepAudio: false` leaves neither. Include a test
asserting no function in this module ever writes to or unlinks a path starting
with `/mnt/`.

### T8 — Job runner
**Files:** `src/server/runner.ts`, `src/server/runner.test.ts`
**Do:** The state machine of section 5.3 (queued → extracting → transcribing →
verifying → cleaning → done) wired to `planRun()`, `buildEnv()`,
progress parsing (6.3), ETA (6.4), queue depth 1 for transcription (6.5),
word-timestamp fallback (6.6), verification (6.7), `meeting.json` writing,
cancellation via process-group kill.
**Acceptance:** an integration test transcribes a generated 5-second silent wav
with `--model tiny` and reaches `done` with real output files; a cancelled job
reaches `cancelled` and leaves no work dir and no orphan process.

### T9 — Job endpoints and SSE
**Files:** `src/server/routes/jobs.ts`, `src/server/sse.ts`
**Do:** Section 7.4 endpoints plus the SSE stream with the five event types,
15 s keepalive, and send-current-state-on-connect.
**Acceptance:** `curl -N` on the stream shows `state` then `progress` events
during a real run and terminates after `done`.

### T10 — Meetings endpoints
**Files:** `src/server/routes/meetings.ts`
**Do:** Section 7.6 including Range-supporting `/api/media`.
**Acceptance:** `curl -H "Range: bytes=0-1023"` returns `206` with a correct
`Content-Range`; transcript segments parse from `.json`, and from `.srt` when
`.json` is absent.

### T11 — Frontend scaffold
**Files:** `web/*` per section 9.2
**Do:** Vite + React + TS + Tailwind + React Query + wouter. `api/types.ts`
mirroring the server types. `api/client.ts` with one typed function per
endpoint. App shell with navigation and `DiskBanner`.
**Acceptance:** `npm run dev:web` runs; the shell loads and `/health` renders
live doctor checks from the server.

### T12 — New Run screen
**Files:** `web/src/pages/NewRun.tsx` plus `FilePicker`, `MeetingForm`,
`PromptMeter`
**Do:** Section 9.3 exactly, including the chip inputs, the debounced prompt
meter, the read-only-source info line, and the keep-audio toggle.
**Acceptance:** selecting a real file from `/mnt/c` and submitting creates a
job visible in `/api/jobs`; a `DISK_FULL` response renders inline; the source
file's size and mtime are unchanged after the run completes.

### T13 — Jobs screen
**Files:** `web/src/pages/Jobs.tsx`, `JobCard`, `JobProgress`, `useJobStream`
**Do:** Section 9.4 with live SSE, cancel, retry, and the audio-disposition
line.
**Acceptance:** progress advances visibly during a real transcription; cancel
stops it within 2 s and leaves no work dir; the card states whether the
extracted audio was kept or deleted.

### T14 — Library, Meeting, Settings
**Files:** `web/src/pages/Library.tsx`, `Meeting.tsx`, `Settings.tsx`,
`TranscriptViewer`
**Do:** Sections 9.5 and 9.6, including click-to-seek audio, search, re-run
prefill, and "add to glossary".
**Acceptance:** clicking a timestamp seeks the audio element; adding a glossary
term persists into `wg.config.json` and appears in the next run's prompt.

### T15 — Wire `wg ui` into the CLI
**Files:** `src/cli.ts`, `README.md`, `package.json`
**Do:** Add the `ui` command with `--port` and `--open`. Add npm scripts
`dev:web`, `build:web`, and make `npm run build` build both server and web.
Document the UI in the README.
**Acceptance:** `npm run build && wg ui --open` serves the built SPA and opens
the Windows browser.

---

## 11. VERIFICATION

### 11.1 Commands that must pass after every task

```bash
npm run typecheck
npm test
npm run build
```

### 11.2 Manual API checks

```bash
curl -s localhost:7788/api/health
curl -s "localhost:7788/api/fs?path=/mnt/c/Users" | head -c 400
curl -s -X POST localhost:7788/api/fs/resolve \
  -H 'content-type: application/json' \
  -d '{"path":"C:\\Users\\mirfa\\Videos"}'
curl -s "localhost:7788/api/probe?path=$PWD/medias/ai_module_clarity.mp4"
curl -s -X POST localhost:7788/api/prompt -H 'content-type: application/json' \
  -d '{"context":"Sprint review","attendees":["Irfan"],"terms":["Sybil"]}'
curl -s localhost:7788/api/doctor
curl -s localhost:7788/api/disk
```

### 11.3 End-to-end acceptance

1. Start `wg ui`, open `http://localhost:7788` in Windows.
2. Browse to `/mnt/c/Users/<user>/Videos`, select a recording.
3. Record the source file's size and mtime: `stat -c '%s %Y' <file>`.
4. Fill attendees, context, and one glossary term.
5. Confirm the prompt meter shows a token count under 224.
6. Submit with `Keep extracted audio` off.
7. Watch progress reach 100 % with a sane ETA.
8. Verify `~/.wg/work/` is empty and no wav remains.
9. Re-run with `Keep extracted audio` on; verify `<outDir>/<stem>.16k.wav`
   exists and `~/.wg/work/` is still empty.
10. Re-check the source file's size and mtime. They MUST be identical to
    step 3, and the file must still exist.
11. Open the meeting, click a timestamp, confirm audio seeks.

---

## 12. OUT OF SCOPE FOR P2 (do not implement)

- Diarization. Note for the future: `whisper-ctranslate2` already supports
  `--hf_token`, `--speaker_name`, `--speaker_num`. P3 will wire these and fill
  `MeetingRecord.speakers`.
- LLM summaries or action items.
- Batch folder watching.
- Packaging as a Windows executable.

---

## 13. COMMON FAILURE MODES, FOR REFERENCE

| Symptom | Cause | Correct handling |
|---|---|---|
| `Library libcublas.so.12 is not found` | spawn without `buildEnv()` | always pass `buildEnv(config.whisperPath)` |
| Job reports success, no transcript | `whisper-ctranslate2` exits 0 on failure | verification step 6.7 |
| `IndexError` in `find_alignment` | faster-whisper 1.2.1 + `--word_timestamps` | fallback 6.6 |
| `unrecognized arguments: --output_format srt,vtt` | comma list | `outputFormatArg()` |
| Transcript stops early, no error | disk filled mid-run | disk guard 5.5 |
| ffmpeg or Whisper fails with an opaque I/O error on a `/mnt` output path | stem contains NTFS-illegal characters | `sanitizeForWindows()`, section 5.8 |
| `C:\\Users\\...` passed to ffmpeg verbatim | missing conversion | `toWslPath()`, section 5.8 |
| Source file missing or altered after a run | code touched `/mnt/c` | forbidden; see rule 5 in section 0.1 and section 5.2 |
| C: free space does not grow after deleting WSL files | vhdx does not auto-shrink | surface the hint: `wsl --shutdown` then `wsl --manage Ubuntu22 --set-sparse true` |
| Two jobs OOM the GPU | parallel transcription | queue depth 1, section 6.5 |
| Browser cannot reach the server | bound to a non-loopback address, or wrong port | bind `127.0.0.1`, port 7788 |
