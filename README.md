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
| `wg doctor` | Check ffmpeg, Whisper, CUDA, VRAM vs model |
| `wg plan` | Show host, engine, resolved config |
| `wg init [--global]` | Write a `wg.config.json` starter |

Still want the paste-into-PowerShell flow? `wg script ... | clip.exe` puts the
whole script on the Windows clipboard.

## Config

`wg.config.json` in the project directory, or `~/.wg/wg.config.json`. Flags win over config.

```json
{
  "engine": "auto",
  "model": "large-v3",
  "language": "en",
  "device": "auto",
  "outputRoot": "D:/transcripts",
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

## Roadmap

- **P2** — local web UI (`wg ui`): form, job queue, live log, transcript preview,
  speaker-label → name mapping.
- **P2** — `--diarize` via WhisperX + pyannote, fills `speakers`.
- **P3** — voice enrollment so speaker labels auto-resolve to names; LLM-written
  context and post-meeting summary/action items.

## Development

```bash
npm test        # node:test, no runtime deps
npm run typecheck
```
