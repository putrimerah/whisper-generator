# Project context

Single source of truth for how this project works. Read this before touching
code. It is written so an agent does not need to read every file to be useful.

Keep it current: when behaviour changes, update this file in the same commit.

---

## 1. What it does

Turns a meeting recording into a transcript, and into something an AI chatbot
can actually use.

Before: 8 manual steps — copy an ffmpeg script, edit paths, run in PowerShell,
ask an AI for a Whisper prompt, copy a Whisper script, edit paths, paste the
prompt, run. Now: one command, or one form in a browser.

## 2. Who runs it, and where

| | |
|---|---|
| Host | Windows 11, single 512 GB SSD, drive `C:` only |
| Dev + runtime | WSL2, distro `Ubuntu22` |
| GPU | RTX 4050 Laptop, **6 GB VRAM** — the binding constraint |
| Recordings | `C:\Users\mirfa\Videos` (local, not synced) |
| Transcripts | `C:\Users\mirfa\OneDrive\Documents\transcripts` (synced, backed up) |
| Windows Documents/Desktop | **redirected into OneDrive**; the plain folders are stubs |
| Browser | on Windows, reaching the WSL server over forwarded `localhost` |

Everything executes inside WSL. The user chose this ("option C") over calling
Windows binaries through `powershell.exe` interop.

## 3. Pipeline

```
C:\Users\mirfa\Videos\meeting.mp4      READ ONLY. never moved, renamed, deleted
        │  ffmpeg -vn -ac 1 -ar 16000  (one pass, onto fast storage)
        ▼
~/.wg/work/<jobId>/<stem>.wav          ours, temporary
        │  whisper-ctranslate2 (CTranslate2, large-v3, int8_float16, CUDA)
        ▼
<outputRoot>/<stem>/                   srt vtt txt tsv json + meeting.json
```

The wav carries the source stem because Whisper names its outputs after the
file it reads. Naming it `audio.wav` produced `audio.srt`; that was a bug.

## 4. Non-negotiable rules

1. **Never delete, move, rename or overwrite a user file.** Only files this
   project created under `~/.wg/work/` may be deleted. Writing *new*
   transcripts into `outputRoot` is fine, including on a Windows drive.
2. **Never trust `whisper-ctranslate2`'s exit code.** It exits 0 after
   catching its own exceptions. Success is proven by artifacts only.
3. **Never spawn Whisper without `buildEnv()`.** pip puts cuBLAS/cuDNN in
   `site-packages/nvidia/*/lib`, which the dynamic loader does not search.
   Without the injected `LD_LIBRARY_PATH` it dies with
   `Library libcublas.so.12 is not found`.
4. **Never read free space from `df` on `/`.** It reports the virtual 1 TB
   size of `ext4.vhdx`. The real figure comes from `statfs` on a Windows mount.
5. **Never invent a Whisper flag.** Run `whisper-ctranslate2 --help` and use
   what exists.
6. **Never hardcode the Windows username.** Discover it from `/mnt/c/Users`.
7. **Transcription runs one at a time.** 6 GB of VRAM fits exactly one
   `large-v3`.

## 5. Stack and versions

| Layer | Choice | Why |
|---|---|---|
| CLI + server | Node 24, TypeScript, **zero runtime deps** | `node:` built-ins cover everything needed |
| Inference | `whisper-ctranslate2` 0.5.8 → faster-whisper 1.2.1 → CTranslate2 4.8.3 | ~4x faster and 2.5 GB instead of 6.5 GB vs `openai-whisper`; `large-v3` fits 6 GB at `int8_float16` |
| CUDA | `nvidia-cublas-cu12`, `nvidia-cudnn-cu12` in the venv | CTranslate2 links them but does not depend on them |
| Audio | static ffmpeg in `~/.local/bin` | no sudo, no apt |
| Web client | React 18, Vite, Tailwind, React Query, wouter | small, no component library |

Installed by `scripts/install-wsl.sh`, user-level, idempotent, no sudo.

## 6. Code map

### CLI and shared core (`src/`)

| File | Responsibility |
|---|---|
| `cli.ts` | commands: `run script prompt plan doctor init ui` |
| `config.ts` | defaults + `wg.config.json` loading; `defaultOutputRoot()` follows the OneDrive redirect |
| `types.ts` | `Config`, `RunOptions`, `MeetingRecord`, `Command`, `ExecutionPlan` |
| `prompt.ts` | `initial_prompt` builder, 224-token budget, trims from the front so names and glossary survive |
| `pipeline.ts` | builds ffmpeg and Whisper argv; `outputFormatArg()` (one value or `all`, never a comma list) |
| `platform.ts` | host detection, `toWslPath()`, `isOnWindowsMount()`, `sanitizeForWindows()`, `windowsSpecialFolder()` (OneDrive redirect) |
| `shell.ts` | PowerShell/POSIX quoting, script rendering for `wg script` |
| `exec.ts` | spawning, **`buildEnv()`** CUDA library injection |
| `meeting.ts` | `meeting.json` sidecar |
| `doctor.ts` | environment checks incl. VRAM vs model |

### Server (`src/server/`)

| File | Responsibility |
|---|---|
| `server.ts` | HTTP entry, static SPA serving, binds `127.0.0.1` only |
| `router.ts` | table router, JSON body limit, error envelope |
| `errors.ts` | `ApiError` + codes: `BAD_REQUEST NOT_FOUND DISK_FULL BUSY FORBIDDEN_PATH JOB_FAILED INTERNAL` |
| `jobTypes.ts` | `Job`, `JobState`, `makeJobId()` |
| `jobStore.ts` | atomic JSON persistence; jobs running at crash time become `failed` |
| `fsService.ts` | directory listing, **path allowlist**, favorites, output target planning, collision check |
| `probe.ts` | ffprobe duration/size, cached, ETA at 2.3x realtime |
| `disk.ts` | `freeBytesFor()`, `assertSpace()`, 500 MB margin |
| `workspace.ts` | temp wav lifecycle; refuses to operate on `/mnt` |
| `runner.ts` | state machine, progress parsing, queue, verification, fallbacks |
| `sse.ts` | Server-Sent Events with keepalive |
| `aiExport.ts` | chatbot-ready Markdown, paragraph merging, token estimate |
| `zip.ts` | dependency-free store-only ZIP writer |
| `routes/misc.ts` | fs, probe, prompt, config, doctor, disk |
| `routes/jobs.ts` | job CRUD, SSE stream |
| `routes/meetings.ts` | library, transcript, speakers, media Range, AI export, zip |

### Web (`web/src/`)

`pages/`: NewRun, Jobs, Library, Meeting, Search, Settings, Health.
`components/`: FilePicker, ChipInput, DiskBanner, Ui (Card/Field/Button).
`hooks/useJobStream.ts`: EventSource subscription.
`api/client.ts` + `api/types.ts`: typed wrappers mirroring the server.

## 7. Job state machine

```
queued → extracting → transcribing → verifying → cleaning → done
                                                           ↘ failed / cancelled
```

- `cleaning` always runs, including on failure and cancellation.
- `verifying` requires a non-empty `.txt` or `.srt`, and valid JSON if a
  `.json` exists. This is what catches the exit-code lie.
- If `--word_timestamps` produced nothing, the runner retries once without it
  (faster-whisper 1.2.1 `IndexError` in `find_alignment`).

## 8. HTTP API

Base `http://127.0.0.1:7788`. Errors: `{ "error": { code, message, detail } }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness |
| GET | `/api/fs?path=&dirsOnly=` | list a directory; empty path returns favorites + `defaultPath` |
| GET | `/api/fs/favorites` | favorites + default browse path |
| POST | `/api/fs/resolve` | Windows path → WSL path |
| GET | `/api/probe?path=` | duration, size, codec, ETA |
| POST | `/api/prompt` | prompt preview + token count |
| GET/PUT | `/api/config` | read/write `wg.config.json` |
| GET | `/api/doctor` | environment checks |
| GET | `/api/disk` | free space + warning |
| GET/POST | `/api/jobs` | list / create |
| GET/DELETE | `/api/jobs/:id` | read / cancel or remove |
| POST | `/api/jobs/:id/retry` | clone settings into a new job |
| GET | `/api/jobs/:id/stream` | SSE: `state progress log done error` |
| GET | `/api/meetings?q=` | library, filtered |
| GET | `/api/meetings/:dir` | one meeting |
| GET | `/api/meetings/:dir/transcript` | segments with speaker names applied |
| PUT | `/api/meetings/:dir/speakers` | save label → name map |
| GET | `/api/meetings/:dir/ai` | chatbot-ready Markdown + token count |
| GET | `/api/meetings/:dir/zip` | every artifact + AI Markdown |
| GET | `/api/meetings/:dir/file/:name` | download one file |
| POST | `/api/export/ai` | several meetings in one Markdown |
| GET | `/api/search?q=` | full-text across transcripts |
| GET | `/api/media?path=` | Range streaming for click-to-seek |

## 9. Decisions, and the reasoning behind them

| Decision | Why |
|---|---|
| CTranslate2, not `openai-whisper` | 4x faster, 2.5 GB vs 6.5 GB, and `large-v3` fits 6 GB at `int8_float16`, where openai-whisper could only manage `medium` |
| `large-v3` default | user chose quality over speed; also best at English/Malay code-switching |
| `--language en` forced | mostly-English meetings; auto-detect flips language mid-recording |
| No `.en` models | they mangle Malay words |
| Read in place, extract audio only | copying a 2 GB video into WSL grows `ext4.vhdx` on the same C: drive it was meant to spare |
| `keepAudio` default off | ~115 MB/hour; the transcript is the artifact worth keeping |
| Word timestamps opt-in | faster-whisper 1.2.1 crashes on some files; segment timestamps are enough to read |
| Quality presets, not a quantization dropdown | "compute type" is meaningless to the user; Best/Faster/Compatibility is not |
| Zero server dependencies | the whole value is in orchestration; a framework would add supply chain for no benefit |
| Transcripts in OneDrive | user wants backup and multi-device access |
| Store-only ZIP | text files on loopback; compression would buy nothing |
| AI Markdown export | `.json` costs ~7x the tokens of `.txt`, `.txt` loses all timing; this keeps timing at ~`.txt` cost |

## 10. Format cost, measured

Same 45-second clip:

| File | Bytes | Relative tokens |
|---|---|---|
| `.txt` | 520 | 1.0x |
| `.tsv` | 637 | 1.2x |
| `.vtt` | 753 | 1.3x |
| `.srt` | 817 | 1.4x |
| `.json` | 3841 | **7.4x** |
| **AI `.md`** | ~640 | **~1.1x, and keeps timestamps** |

## 11. Known failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `Library libcublas.so.12 is not found` | spawn without `buildEnv()` | pass the env |
| Job says done, no transcript | exit code 0 on failure | artifact verification |
| `IndexError` in `find_alignment` | `--word_timestamps` on faster-whisper 1.2.1 | automatic retry without |
| `unrecognized arguments: --output_format srt,vtt` | comma list | `outputFormatArg()` |
| Outputs named `audio.16k.srt` | wav lacked the source stem | `wavPathFor(dir, stem)` |
| Opaque I/O error writing to `/mnt` | NTFS-illegal characters in the stem | `sanitizeForWindows()` |
| C: free space never grows after deleting WSL files | vhdx does not auto-shrink | `wsl --shutdown` then `wsl --manage Ubuntu22 --set-sparse true` |
| OneDrive file unreadable from WSL | cloud-only placeholder | "Always keep on this device" |
| Two jobs OOM the GPU | parallel transcription | queue depth 1 |

## 12. Commands

```bash
npm run build        # server + web
npm test             # 29 tests, node:test, no runner dependency
npm run typecheck
wg ui --open         # web app
wg run <file> --attendees "A,B" --context "..."
wg doctor            # ffmpeg, whisper, CUDA libs, ctranslate2, VRAM vs model
bash scripts/install-wsl.sh   # user-level install, no sudo
```

## 13. Still open

- Voice enrollment so speaker labels resolve to names automatically.
- LLM summaries in-app (needs a provider decision; today the AI export covers
  it by hand).
- Watch folder for drop-in transcription.
- Real glossary content: `Sybil`, `Janaya`, `Godot`, `Judgement` are phonetic
  guesses at Malay words. The user fixes these through the transcript viewer's
  "add to glossary" action.
