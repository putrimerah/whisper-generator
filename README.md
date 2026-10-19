# whisper-generator (`wg`)

Turns the 8-step copy-paste ritual into one command:

```bash
wg run "C:/recordings/standup.mp4" --attendees "Irfan,Aisyah" --context "Weekly sprint review"
```

It extracts audio (optional), builds a token-budgeted Whisper `initial_prompt`,
runs OpenAI Whisper, and writes a `meeting.json` sidecar so a run is reproducible.

## Install

```bash
npm install && npm run build && npm link   # exposes `wg`
bash scripts/install-wsl.sh                # ffmpeg + Whisper + CUDA torch, no sudo
wg doctor                                  # verify
```

Requires Node 20+. `npm run dev -- <args>` runs from source, no build step.

`scripts/install-wsl.sh` is user-level only: static ffmpeg into `~/.local/bin`,
Whisper into a venv at `~/.wg/venv`. Nothing touches system directories, so no
`sudo` and no apt. Re-running it is safe; finished steps are skipped.

## Commands

| Command | What it does |
|---|---|
| `wg run <input>` | Extract (optional) + transcribe, live progress |
| `wg script <input>` | Print a PowerShell/bash script instead of running it |
| `wg prompt` | Preview the `initial_prompt` and its token count |
| `wg ui [--port N] [--open]` | Local web app: picker, live progress, library |
| `wg doctor` | Check ffmpeg, Whisper, CUDA, VRAM vs model |
| `wg plan` | Show host, engine, resolved config |
| `wg init [--global]` | Write a `wg.config.json` starter |

Still want the paste-into-PowerShell flow? `wg script ... | clip.exe` puts the
whole script on the Windows clipboard.

## Config

`wg.config.json` in the project directory, or `~/.wg/wg.config.json`. Flags win over config.

`outputRoot` accepts Windows paths (`C:\Users\you\Documents\transcripts`),
`/mnt/c/...` paths, or plain WSL paths; all are normalised. It defaults to the
Windows `Documents\transcripts` folder, discovered at runtime, so transcripts
land where Explorer can see them. Filenames are sanitised for NTFS when the
target is on a Windows drive.

```json
{
  "engine": "auto",
  "model": "large-v3",
  "language": "en",
  "device": "auto",
  "outputRoot": "C:\\Users\\you\\Documents\\transcripts",
  "outputFormats": ["srt", "vtt", "txt", "json"],
  "extractAudio": false,
  "attendees": ["Irfan"],
  "terms": ["Kafka", "CTranslate2"],
  "context": "Engineering team meeting"
}
```

## Where Whisper runs

`engine` resolves against the detected host:

| Host | `engine` | Result |
|---|---|---|
| Windows | any | Whisper runs natively, Windows paths, no translation |
| WSL | `native` (default) | Whisper runs inside WSL, needs CUDA in WSL |
| WSL | `windows` | Commands wrapped in `powershell.exe`, paths converted with `wslpath -w` |

Keep media on the same filesystem as the engine. Reading from `/mnt/c` inside
WSL, or from `\\wsl.localhost\...` from Windows, is several times slower.

## Prompt budget

Whisper keeps only the **last 224 tokens** of `initial_prompt`; the rest is
dropped silently. The builder orders sections lead → context → participants →
glossary and trims from the front, so names and jargon always survive. Over
budget, you get a warning naming what was dropped.

## Model and language notes

- Use multilingual models (`medium`, `large-v3`), not `.en` variants, when
  meetings mix English with Malay.
- VRAM decides the ceiling: `small` ~2 GB, `medium` ~5 GB, `large-v3` ~10 GB.
  A 6 GB laptop GPU runs `medium`; `large-v3` OOMs. `wg doctor` checks this.
- Force `--language en` for mostly-English meetings; auto-detect can flip
  language mid-recording.
- Put Malay terms and product names in `terms` so spelling stays consistent.

## Audio extraction

Off by default: Whisper already calls ffmpeg internally. Turn `--extract` on when
you re-transcribe the same source repeatedly (16 kHz mono wav, ~2 MB/min) or the
source sits on a slow network drive.

## Output

```
out/standup/
├── standup.srt
├── standup.vtt
├── standup.txt
├── standup.json
└── meeting.json     attendees, context, prompt, model, exact commands
```

`meeting.json` carries a `speakers` field, `null` until diarization lands.

## Web UI

```bash
npm run build
wg ui --open            # http://localhost:7788, opens in the Windows browser
```

- **New run** — browse `/mnt/c` server-side (no upload), or paste a Windows
  path; live prompt meter against the 224-token budget; model, language and
  compute selectors; output folder picker.
- **Jobs** — live progress over SSE, ETA, cancel, retry, log tail.
- **Library** — every past meeting, transcript viewer with click-to-seek audio,
  in-transcript search, Markdown export.
- **Glossary loop** — select a misheard word in the transcript and add it to
  `terms`; every later run spells it correctly.
- **Search** — full-text across all transcripts.
- **Speakers** — with a HuggingFace token, diarization labels speakers; map
  `SPEAKER_00` to a real name once and it is stored in `meeting.json`.
- **Health** — the `wg doctor` checks plus disk figures.

The server binds `127.0.0.1` only and never uploads or copies your recordings:
sources are read in place and only the extracted audio lives in WSL, deleted
after a verified transcript unless `keepAudio` is on.

## Speaker labels (diarization)

1. Accept the licence for `pyannote/speaker-diarization` on huggingface.co.
2. Paste your token into Settings, or set `hfToken` in `wg.config.json`.
3. Run with `--diarize` (CLI) or the Speakers toggle (UI).

## Roadmap

- Voice enrollment so speaker labels resolve to names automatically.
- LLM summaries and action items.
- Watch folder for drop-in transcription.

## Development

```bash
npm test        # node:test, no runtime deps
npm run typecheck
```
