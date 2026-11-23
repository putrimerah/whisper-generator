# Whisper Generator Security Improvement Plan

**Status** — Planned

Secure the loopback API first. It exposes private recordings and transcripts and can change the executables the app runs. Then enforce file boundaries, harden subprocesses, and verify the software supply chain.

[Project context](PROJECT.md) defines supported platforms and pipeline constraints. Preserve read-only recordings, single-job transcription, artifact-based success checks, and the required `buildEnv()` at every Whisper spawn. Keep the server free of runtime dependencies.

## Phase 1 — Secure local API access and settings

- Keep the server on loopback. Validate `Host` against the intended loopback names and bound port. Reject unexpected hostnames before serving either the UI or API.
- Require a per-launch authenticated browser session for private routes, including media, downloads, and SSE. Design the bootstrap and session handling so credentials stay out of resource URLs and logs. Cover CLI launch and manual browser access.
- Validate `Origin` on mutations and accept only `application/json` on routes that take JSON. Preserve the existing body-size cap. Give the Vite proxy an explicit trusted development configuration with the same API protections.
- Allowlist and type-check settings the UI may change. Keep engine executable paths and secrets in trusted local configuration. Return only token availability to the UI. Keep environment-derived secrets out of config saves, including saves of unrelated settings.
- Check whether an existing config contains a persisted token. Document how users can remove it and rotate the token if it was exposed.

**Done when** authenticated users can complete the normal UI flow in production and development. Regression tests cover unauthenticated reads and writes, unexpected hosts and origins, wrong content types, protected settings, and token redaction.

## Phase 2 — Restrict file access and prevent overwrites

- Define approved recording roots, transcript roots, and artifact types. Replace arbitrary-path media serving with approved recording or artifact references. Apply the same containment checks to file browsing, probe, waveform generation, download, search, and exports.
- Resolve existing paths canonically before use. Reject symlink or junction escapes, Windows alternate data streams, and invalid meeting or artifact names. Check file type before opening. Use safe file handles or exclusive opens where a path could change between validation and use.
- Reserve fresh output directories atomically for new jobs and retries. Apply the same no-overwrite policy to CLI execution and custom destinations. Preserve existing transcripts for library access and ensure cancellation and cleanup affect only project-owned temporary files.
- Stream downloads where possible. Bound ZIP size and file count. Keep private media and downloads out of browser caches.

**Done when** tests with synthetic files cover root boundaries, symlinks, existing outputs, retries, and concurrent submissions. Verify Windows separators and junctions on Windows, and verify mounted recordings on WSL.

## Phase 3 — Harden subprocesses and resource limits

- Invoke trusted native executables with argument arrays and shell parsing disabled. Define how existing batch-wrapper configurations migrate. Validate job options before passing them to engines, including model names or paths.
- Admit only approved regular files to media tools. Restrict media input protocols where supported. Set limits for probe and waveform subprocesses, cap concurrent work and queued jobs, and handle cancellation and stream errors. Preserve the single active transcription.
- Use a supported credential channel for diarization if the engine provides one. Check the installed Whisper help before changing flags. Redact tokens in generated scripts, dry runs, logs, and errors. If the engine requires a token in process arguments, document that remaining exposure.
- Bound expensive work from untrusted or oversized input. Cover probe timeouts, cancellation, child cleanup, and job recovery after a failed stage.

**Done when** supported engines complete the normal pipeline, malformed inputs fail cleanly, and shutdown or cancellation releases subprocess and queue capacity. Verify behavior on Windows, WSL, Linux, and macOS where supported engine installations are available.

## Phase 4 — Patch dependencies and verify installers

- Patch Vite to at least `6.4.6` within the current major version and resolve `postcss-selector-parser` to at least `6.1.5`. Confirm the chosen versions against current advisories. Apply the Vite update sooner if a development server must be exposed.
- Pin native engine releases per supported platform. Verify a trusted checksum or signature before extraction or installation. Pin Python dependencies with hashes and document how to update them.
- Re-run npm audits for both lockfiles. Check Python dependencies and the installed native engine versions separately. Update the dependency notes in `PROJECT.md` with the results and any remaining exposure.

**Done when** both npm lockfiles clear the listed advisories, supported installers verify downloads and reject mismatches, and the installed engines pass `wg doctor` and a synthetic transcription.

## Verification and delivery

- Land each phase as a reviewable change. Run `make check` before committing. Update `PROJECT.md` in the same commit as any behavior change.
- Use synthetic recordings, transcripts, and credentials in tests. Record platform checks and any limits on verification before closing a phase.
- Verify the full browser flow from launch through job creation, progress, playback, and export. Verify CLI transcription and existing-library access separately.
