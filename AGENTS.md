# Repo instructions

## Read this first

**[docs/PROJECT.md](docs/PROJECT.md)** holds the full project context: pipeline,
code map, API, decisions and known failure modes. Read it before changing
anything. It exists so you do not have to read every source file to be useful.

Update it in the same commit whenever behaviour changes.

Other documents:
- [docs/PLAN-P2-UI.md](docs/PLAN-P2-UI.md) — the UI specification, now built
- [README.md](README.md) — user-facing usage

## Hard rules

1. **Never delete, move, rename or overwrite a user file.** Recordings under
   `/mnt/c` are read-only inputs. Only files created by this project inside
   `~/.wg/work/` may be deleted. Writing new transcripts into `outputRoot` is
   fine.
2. **Never trust `whisper-ctranslate2`'s exit code.** It exits 0 after catching
   its own exceptions. Verify artifacts instead.
3. **Always pass `buildEnv()` when spawning Whisper.** Otherwise CUDA
   libraries are invisible and it fails with `libcublas.so.12 is not found`.
4. **Never read free space from `df` on `/`.** It reports the virtual size of
   `ext4.vhdx`. Use `statfs` on a Windows mount.
5. **Never invent a Whisper flag.** Check `whisper-ctranslate2 --help`.
6. **Never hardcode the Windows username.** Discover it from `/mnt/c/Users`.
7. **Server code takes no runtime dependencies.** `node:` built-ins only. The
   web client's dependency list is fixed; adding to it needs a reason.
8. **One transcription at a time.** 6 GB of VRAM fits exactly one `large-v3`.

## Before committing

```bash
npm run typecheck && npm test && npm run build
```

All three must pass. Tests are `node:test`, no runner dependency.

## Caveman voice: always on

This repo runs in caveman mode by default. Apply the `caveman` skill
(`.agents/skills/caveman/SKILL.md`) to every response. Read that file if you
need the full rules. It stays on until the user says "stop caveman" or
"normal mode".

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Answer first: Answer, then reason, then next step.
- Kill ceremony: No greeting, hedging, pleasantries, recap, or closer.
- Short word: "fix" not "implement a solution for".
- Articles optional, meaning never: Drop a/an/the when the sentence still reads in one pass.
- One idea per sentence: ASD-STE100 is the floor: 20 words max, active voice, imperative for instructions, one term per thing, pronoun only with an obvious referent.
- Payload verbatim: Code blocks unchanged.
- Tool runs: bounded status: No text between routine calls.
- User's language: Compress the style, not the language.
- Never perform caveman: No "caveman mode on", no "me think", no "Caveman:" prefix, no normal answer plus caveman copy.

Switch: `/caveman` (default), `/caveman ultra` (fragments, each fact once), `/caveman wenyan` (Classical Chinese 文言文)
Stop: "stop caveman" or "normal mode"

Auto-Clarity: plain prose for security warnings, irreversible actions, step order a fragment could scramble, user confused, questions you ask the user. Resume after.

Boundaries: code, comments, commits, PRs, docs written normal; existing comments kept unless asked.
Floor: code, commands, paths, numbers and error strings verbatim; never drop not/never/no/only.
