# Contributing

Thanks for looking. This project transcribes meetings locally with Whisper, so
most contributions touch audio handling, platform paths, or the web UI.

## Before you start

Read **[docs/PROJECT.md](docs/PROJECT.md)**. It holds the pipeline, the code
map, the HTTP API, and the reasoning behind each decision. It exists so you do
not have to read every file, and it will save you re-discovering problems that
are already solved there.

For anything larger than a bug fix, open an issue first. The project has a
deliberately narrow scope, listed at the end of this file.

## Setup

```bash
git clone https://github.com/<your-fork>/whisper-generator.git
cd whisper-generator
make install     # dependencies, ffmpeg, whisper-ctranslate2, CUDA libs
make doctor      # every line should be green
make dev         # API on 7788, UI with hot reload on 5173
```

Requires Node 22+. No `sudo` is needed; nothing installs system-wide.

If you have no NVIDIA GPU, set `WG_DEVICE=cpu`, `WG_MODEL=medium` and
`WG_COMPUTE_TYPE=int8` in `.env`. Everything works, about ten times slower.

## Before every commit

```bash
make check
```

Typecheck, tests, build and the privacy scan must all pass.

CI runs typecheck, tests and the build on every pull request. The privacy scan
stays local, because it greps for *your* machine's username, which a CI runner
does not have.

## House rules

These are not style preferences; each one exists because breaking it caused a
real bug.

1. **Never delete, move, rename or overwrite a user's file.** Recordings are
   read-only input. The only files this project may delete are ones it created
   in `~/.wg/work/`.
2. **Never trust the Whisper CLI's exit code.** `whisper-ctranslate2` catches
   its own exceptions and still exits 0. Success is proven by inspecting the
   output files.
3. **Always pass `buildEnv()` when spawning Whisper.** pip installs cuBLAS and
   cuDNN where the dynamic loader cannot see them; without the injected
   `LD_LIBRARY_PATH` it dies with `libcublas.so.12 is not found`.
4. **Never read free space from `df` on `/` under WSL.** It reports the
   virtual size of `ext4.vhdx`. Use `statfs` on the backing drive.
5. **Never invent a Whisper flag.** Check `whisper-ctranslate2 --help`.
6. **Never hardcode a username, home directory or `/mnt/c`.** Detect the
   platform. WSL, Linux and macOS all have to work.
7. **No new server dependencies.** The server uses `node:` built-ins only.
   The web client's dependency list is fixed; adding to it needs a reason in
   the PR description.
8. **One transcription at a time.** A second concurrent `large-v3` exhausts a
   6 GB GPU.
9. **Never commit a real username, path, token, recording or transcript.**
   `make privacy` enforces this.

## Tests

`node:test`, no test runner dependency.

```bash
npm test
node --experimental-strip-types --test src/server/server.test.ts   # one file
```

Add a test when you fix a bug, so it cannot come back. Pure functions are
preferred over mocks: that is why path translation, prompt budgeting, segment
grouping and ZIP writing are all separately testable.

## Pull requests

- One concern per PR.
- Explain **why**, not just what. The diff shows what changed.
- Say which platform you tested on (WSL, Linux, macOS; GPU or CPU).
- Update `docs/PROJECT.md` in the same PR when behaviour changes.
- Attach a screenshot for UI changes.

## Reporting bugs

Include:

- the output of `make doctor`, which identifies your whole environment
- the failing job's log tail, from the Jobs screen or the terminal
- the file type and roughly how long the recording is
- your platform and GPU

Please do not attach meeting audio or transcripts. They are usually
confidential, and a short description is enough.

## Scope

In scope: transcription quality, speed, the pipeline, the UI, platform
support, exports.

Out of scope, by choice:

- Cloud transcription APIs. This runs locally, on purpose.
- Authentication, multi-user support, hosting on a public network. The server
  binds to loopback only.
- A database. State is JSON files you can read and delete.
- Mobile layouts.

If you want one of those, fork it — that is what the MIT licence is for.
