# whisper-generator

Turn a meeting recording into a transcript, and into something an AI chatbot
can actually use — from one command or one browser form.

Built around OpenAI Whisper running locally on your GPU through
[CTranslate2](https://github.com/OpenNMT/CTranslate2). Nothing is uploaded,
nothing leaves the machine.

```bash
make
```

That installs what is missing, builds what changed, and opens the web app.

---

## Contents

- [What it replaces](#what-it-replaces)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [First run](#first-run)
- [Configuration](#configuration)
- [Feeding transcripts to a chatbot](#feeding-transcripts-to-a-chatbot)
- [Writing good context](#writing-good-context)
- [CLI reference](#cli-reference)
- [Make targets](#make-targets)
- [How it works](#how-it-works)
- [Speaker labels](#speaker-labels-diarization)
- [Troubleshooting](#troubleshooting)
- [Platform notes](#platform-notes)
- [Development](#development)
- [Privacy](#privacy)

---

## What it replaces

The manual ritual this was built to kill:

1. Copy an ffmpeg script
2. Edit the file paths
3. Run it in PowerShell
4. Ask an AI to write a Whisper prompt
5. Copy a Whisper script
6. Edit the file paths again
7. Paste the prompt in
8. Run it

Now: pick the file, type who was there, press Start.

## Features

- **File picker that understands your disks.** Browses the filesystem
  server-side, so nothing is uploaded and no multi-GB copy is made.
- **Prompt builder with a real token budget.** Whisper only keeps the last 224
  tokens of `initial_prompt`; the builder trims from the front so attendee
  names and glossary terms always survive, and tells you what it dropped.
- **Live progress.** Percentage, elapsed, ETA, log tail, cancel, retry.
- **Library.** Every past meeting, and a transcript viewer with a waveform
  player: click a line to hear it, the playing line follows along, and search
  results open at the moment they matched. In-transcript search and full-text
  search across all meetings.
- **AI export.** A chatbot-ready Markdown transcript at roughly the token cost
  of plain text but with timestamps intact — about 7× cheaper than the raw
  JSON. Export several meetings as a single prompt.
- **Glossary loop.** Select a misheard word in the transcript, add it to the
  glossary, and every later run spells it correctly.
- **Speaker labels** through pyannote, when you supply a HuggingFace token.
- **Works from the terminal too.** The web app is a face over the same CLI.

## Requirements

| | Minimum | Notes |
|---|---|---|
| OS | WSL2, Linux, or macOS | Windows users run it inside WSL2 |
| Node | **22 or newer** | 24 recommended; the test runner uses native TypeScript |
| Python | 3.9+ | only to host the Whisper CLI, in its own venv |
| Disk | ~6 GB | 2.5 GB runtime + 3 GB for the `large-v3` model |
| GPU | optional | NVIDIA with 4 GB+ VRAM is roughly 10× faster than CPU |
| ffmpeg | installed for you | static build placed in `~/.local/bin` |

No `sudo` is required anywhere. Nothing is installed system-wide.

**VRAM decides the model you can run:**

| Model | Disk | VRAM at `int8_float16` | Comment |
|---|---|---|---|
| `small` | 0.5 GB | ~1 GB | fast, weak on names |
| `medium` | 1.5 GB | ~2 GB | good compromise |
| **`large-v3`** | 3 GB | **~3.5 GB** | **default**, best with mixed languages |

`wg doctor` refuses to let you pick a model that will not fit.

## Install

```bash
git clone https://github.com/<you>/whisper-generator.git
cd whisper-generator
make install
```

`make install` is idempotent and does four things:

1. npm dependencies for the server and the web app
2. a static **ffmpeg** and **ffprobe** into `~/.local/bin`
3. a Python venv at `~/.wg/venv` with **whisper-ctranslate2**, plus the
   **cuBLAS** and **cuDNN** wheels CTranslate2 needs but does not declare
4. prefetches the `large-v3` model (~3 GB) into `~/.cache/huggingface`

Expect 10–20 minutes on a normal connection, mostly model download.

Then verify:

```bash
make doctor
```

```
✔ host/engine  wsl host, Whisper runs inside wsl
✔ ffmpeg       ffmpeg version N-...
✔ whisper      ~/.wg/venv/bin/whisper-ctranslate2
✔ cuda libs    cuBLAS + cuDNN found, LD_LIBRARY_PATH injected by wg
✔ ctranslate2  v4.8.3, 1 CUDA device(s)
✔ model fit    large-v3 @ int8_float16 needs ~3.5 GB, GPU has 6 GB
```

Every failing line prints the exact command that fixes it.

### macOS

The installer's ffmpeg download is Linux-only. Install the pieces yourself,
then the rest of the project works unchanged:

```bash
brew install ffmpeg python@3.12
python3 -m venv ~/.wg/venv
~/.wg/venv/bin/pip install whisper-ctranslate2
make build && make doctor
```

There is no CUDA on macOS, so transcription runs on CPU. Use `WG_MODEL=medium`
and expect roughly realtime speed.

### No GPU

It still works, around 10× slower. Set this in `.env`:

```ini
WG_DEVICE=cpu
WG_COMPUTE_TYPE=int8
WG_MODEL=medium
```

## First run

```bash
make
```

The browser opens at `http://localhost:7788`.

1. **Source recording** — the picker opens in your recordings folder. Click a
   video. Or switch to *Paste path* and paste a Windows path copied with
   Shift+Right-click → "Copy as path".
2. **Meeting details** — add attendees, one or two sentences of context, and
   glossary terms. Watch the token meter stay green.
3. **Processing** — leave Quality on *Best*. Press **Start transcription**.
4. **Jobs** — progress, ETA and log appear live.
5. **Library** — open the finished meeting, click a timestamp to hear that
   moment, then press **Copy for AI** and paste into your chatbot.

A 17-minute recording takes about 7 minutes on an RTX 4050.

Terminal equivalent:

```bash
make transcribe FILE=~/Videos/meeting.mp4 ARGS="--attendees 'Alice,Bob' --context 'Weekly sprint review'"
```

## Configuration

Three layers, strongest first:

```
CLI flags  >  .env  >  wg.config.json  >  built-in defaults
```

`.env` is the per-machine layer and is git-ignored. It is created from
`.env.example` on your first `make`. **A value here overrides the Settings
screen**, so clear the matching line if a change in the UI seems ignored.

```ini
# locations — Windows paths are accepted and converted automatically
WG_BROWSE_ROOT=C:\Users\you\Videos
WG_OUTPUT_ROOT=C:\Users\you\OneDrive\Documents\transcripts

# transcription
WG_MODEL=large-v3
WG_LANGUAGE=en              # or "auto"
WG_COMPUTE_TYPE=int8_float16
WG_KEEP_AUDIO=false         # keep the ~115 MB/hour wav for faster re-runs
WG_WORD_TIMESTAMPS=false

# defaults applied to every run
#WG_ATTENDEES=Alice,Bob
#WG_TERMS=Kafka,Atlas
#WG_CONTEXT=Engineering team meeting

# speakers
#WG_HF_TOKEN=hf_your_token_here
#WG_DIARIZE=false
#WG_SPEAKER_COUNT=0

# server
#WG_PORT=7788
```

Full list: `WG_BROWSE_ROOT WG_OUTPUT_ROOT WG_MODEL WG_LANGUAGE WG_COMPUTE_TYPE
WG_DEVICE WG_KEEP_AUDIO WG_WORD_TIMESTAMPS WG_OUTPUT_FORMATS WG_ATTENDEES
WG_TERMS WG_CONTEXT WG_HF_TOKEN WG_DIARIZE WG_SPEAKER_COUNT WG_WHISPER_PATH
WG_FFMPEG_PATH WG_PORT`.

`wg plan` prints which config file and `.env` were actually used.

`wg.config.json`, in the project directory or `~/.wg/`, holds shared defaults
and is what the Settings screen writes.

## Feeding transcripts to a chatbot

Use **Copy for AI**, not the raw files. Measured on the same clip:

| Format | Relative tokens | Keeps timing |
|---|---|---|
| `.txt` | 1.0× | no |
| `.tsv` | 1.2× | yes, awkward |
| `.srt` | 1.4× | yes, wasteful |
| `.json` | **7.4×** | yes, very wasteful |
| **AI `.md`** | **~1.1×** | **yes** |

A one-hour meeting costs roughly 9k tokens instead of 67k as JSON.

The export puts attendees, context and glossary in a header, merges Whisper's
mid-sentence line breaks into paragraphs, and stamps one time per paragraph:

```markdown
# Meeting: team-sync

- Date: 19/10/2026, 10:31:00
- Duration: 17:18
- Language: en
- Attendees: Alice, Bob
- Context: Weekly sprint review for the billing service

## Transcript

[00:00] Are you coming tomorrow? It's probably not available for the talk,
I'll check it out a little later.
[01:12] I haven't had time to look at Atlas yet, but what I'm going through
today probably applies to it as well.
```

In the Library, tick several meetings and export them as one prompt — useful
for "summarise my week".

**Download all (.zip)** bundles every format plus the AI Markdown.

## Writing good context

The context and glossary fields become Whisper's `initial_prompt`. That is
**not** a chatbot prompt: Whisper does not follow instructions. It only biases
vocabulary, spelling and style.

| You write | Effect |
|---|---|
| `Atlas`, `eKF3`, unusual surnames | those spellings become likely — **the real win** |
| `Weekly sprint review for the billing service` | small, useful nudge |
| `Please transcribe accurately` | **nothing**, and it may be echoed into the output |
| A 300-word AI-written description | **harmful** — trimmed by the budget, raises hallucination risk |

Rules of thumb:

- Put proper nouns in **glossary terms**, not in prose. One token of `Atlas`
  beats a sentence describing the project.
- Keep context to one or two sentences containing real nouns.
- Write with normal capitalisation and punctuation — Whisper mimics the style
  of the prompt.
- Write prose in the meeting's main language; put foreign words in the
  glossary.

A chatbot *is* useful here for one job: paste a previous transcript and ask it
to list every proper noun and acronym, then paste those into the glossary.

## CLI reference

```
wg run <input>      Transcribe a file
wg ui [--port N]    Start the web app
wg doctor           Check ffmpeg, Whisper, CUDA, VRAM vs model
wg plan             Show host, engine and resolved config
wg prompt           Preview the initial_prompt and its token count
wg script <input>   Print a pasteable shell script instead of running
wg init [--global]  Write a wg.config.json starter
```

Common options:

```
--attendees "Alice,Bob"     --terms "Kafka,Atlas"      --context "..."
--model large-v3            --language en|auto         --device cuda|cpu
--out <dir>                 --formats srt,vtt,txt,json --extract
--word-timestamps           --diarize --speakers 4     --dry-run
```

## Make targets

| Command | Does |
|---|---|
| `make` | build and open the web app |
| `make install` | full setup including ffmpeg and Whisper |
| `make dev` | live-reloading UI on port 5173 |
| `make demo` | the web app on port 7799 with fictional meetings, for screenshots |
| `make doctor` | environment check |
| `make test` | test suite |
| `make check` | typecheck + tests + build + privacy scan |
| `make privacy` | scan tracked files for usernames, tokens, media |
| `make transcribe FILE=x.mp4` | transcribe from the terminal |
| `make stop` | stop a running server |
| `make link` | put `wg` on your PATH |
| `make update` | pull, reinstall, rebuild |
| `make clean` / `make reset` | remove build output / also dependencies |
| `make help` | list everything |

Override the port with `make PORT=8080`.

## How it works

```
your recording            read only, never moved, renamed or deleted
      │  ffmpeg -vn -ac 1 -ar 16000      (one pass, onto fast local storage)
      ▼
~/.wg/work/<job>/<name>.wav              temporary, deleted after verification
      │  whisper-ctranslate2             (CTranslate2, CUDA, int8_float16)
      ▼
<output>/<name>/  srt · vtt · txt · tsv · json · meeting.json
```

Why extract audio instead of pointing Whisper at the video: the wav lands on
fast local storage, so re-runs never re-read a slow or network drive, and
16 kHz mono PCM is exactly what Whisper resamples to internally.

`meeting.json` records attendees, context, prompt, model and timing, so any
run can be reproduced or repeated with different settings.

Transcription runs strictly one job at a time — two `large-v3` processes would
exhaust the GPU.

## Speaker labels (diarization)

1. Accept the licence for `pyannote/speaker-diarization` on huggingface.co.
2. Put the token in Settings, or `WG_HF_TOKEN` in `.env`.
3. Enable **Label speakers** in the form, or pass `--diarize`.
4. In the meeting page, map `SPEAKER_00` to a real name once. The mapping is
   saved in `meeting.json` and applied to the transcript and AI export.

Accuracy is good with separate microphones, weaker with one shared room mic
and people talking over each other.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Library libcublas.so.12 is not found` | CUDA wheels missing | `make install`, then `make doctor` |
| Job finishes but no transcript | Whisper exits 0 even when it fails | the job is marked failed; read its log, then run `make doctor` |
| `IndexError` in `find_alignment` | known faster-whisper bug with word timestamps | handled automatically: it retries without them |
| Out of memory on the GPU | model too large for the VRAM | Quality → *Faster*, or `WG_MODEL=medium` |
| Transcript stops early | the disk filled mid-run | free space, or set a different `WG_OUTPUT_ROOT` |
| Names spelled phonetically | they were not in the glossary | add them in the transcript viewer; future runs will be right |
| Malay or other words turned into English | `.en` model, or the words are missing from the glossary | use a multilingual model and add the terms |
| `port 7788 is already in use` | an old server is still running | `make stop` |
| Can't open a file on OneDrive | it is a cloud-only placeholder | right-click the folder → "Always keep on this device" |
| Deleted WSL files but Windows space didn't return | `ext4.vhdx` never shrinks on its own | `wsl --shutdown`, then `wsl --manage <distro> --set-sparse true` |

## Platform notes

| | WSL2 | Linux | macOS |
|---|---|---|---|
| Recordings default | Windows `Videos` | `~/Videos` | `~/Movies` |
| Transcripts default | Windows `Documents/transcripts`, following the OneDrive redirect | `~/Documents/transcripts` | `~/Documents/transcripts` |
| Free space measured on | the drive backing `ext4.vhdx` | the target filesystem | the target filesystem |
| `--open` uses | `powershell.exe` | `xdg-open` | `open` |
| Filename sanitising | on `/mnt/*` targets, for NTFS | not needed | not needed |

Nothing is hardcoded to one machine: usernames are discovered and every path
is overridable in `.env`.

## Development

```bash
make dev        # Vite hot reload on 5173, API on 7788
make demo       # fictional meetings on 7799; safe to screenshot
make check      # typecheck, tests, build, privacy scan
```

`make demo` writes made-up meetings and synthetic audio to `~/.wg/demo` and
keeps its job history there too, so nothing of yours shows up. Delete the
folder to regenerate it.

```
src/              CLI and shared core, zero runtime dependencies
src/server/       HTTP API, job runner, exports
web/src/          React UI (Vite, Tailwind, React Query, wouter)
scripts/          user-level installer, demo data generator
docs/PROJECT.md   full project context: pipeline, code map, API, decisions
```

Read [docs/PROJECT.md](docs/PROJECT.md) before changing anything — it exists so
you do not have to read every file. Tests use `node:test`; there is no test
runner dependency.

## Contributing

Pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it
covers setup, the house rules, and what is deliberately out of scope.

## Privacy

Everything runs locally: no uploads, no API calls, no telemetry.

Your recordings are treated as read-only input. The project only ever deletes
files it created itself in `~/.wg/work/`.

`.env`, recordings, transcripts and `wg.config.json` are git-ignored, and
`make privacy` blocks a commit that would leak a username, a token, or media.

## License

[MIT](LICENSE) — use it, change it, ship it, commercially or not. The only
condition is that the copyright notice travels with it, and there is no
warranty.
