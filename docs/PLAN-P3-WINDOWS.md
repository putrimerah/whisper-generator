# PLAN-P3-WINDOWS — run natively on Windows PowerShell

Execution plan for adding a **fourth host** (`windows`) to whisper-generator,
alongside the existing `wsl`, `linux` and `macos` hosts.

**Outcome:** one codebase, one `dist/` build, runs on Windows PowerShell and on
Linux/macOS. No fork, no separate branch, no conditional compilation.

---

## 0. Instructions for the agent executing this plan

Read all of section 0 before editing anything.

### Mandatory reading

1. `AGENTS.md` — the hard rules. They are not negotiable.
2. `docs/PROJECT.md` — pipeline, code map, API, known failure modes.

### Rules of execution

1. **One phase at a time, in order.** Do not start a phase before the previous
   phase's `Verify` step passes.
2. **After every phase run:** `npm run typecheck && npm test`. Both must pass
   before you continue. If either fails, fix it inside the current phase.
3. **Only edit the files listed in the phase.** If a change seems to require a
   file not listed, stop and report it instead of editing it.
4. **If a quoted "find this" snippet does not match the file exactly, stop and
   report.** Do not guess at a similar line. The file may have moved on.
5. **Do not reformat, re-indent or re-order anything you were not asked to
   change.** Match the surrounding comment density and naming style.
6. **Never delete, move, rename or overwrite a user file.** Only files this
   project created under `~/.wg/work/` may be deleted. (Hard rule 1.)
7. **This repo is public.** Never write a real username, home directory, token,
   recording name or meeting name into any file. Use `you`, `Alice`, `Bob` and
   generic project names. (Hard rule 9.)
8. **Never invent a Whisper flag.** Check `whisper-ctranslate2 --help`.
   (Hard rule 5.)
9. Update `docs/PROJECT.md` in Phase 9, not earlier.
10. Do not commit. Leave the working tree dirty for the user to review.

### The single most important technical rule

Two kinds of function exist in this codebase, and they must be changed
differently:

| Kind | How it must handle paths |
|---|---|
| **Pure path logic** (no filesystem access) | Takes a `host: Host = detectHost()` parameter and uses **`path.win32` or `path.posix` explicitly**, chosen from `host`. |
| **I/O functions** (`existsSync`, `readdirSync`, `statSync`, `spawn`) | Keeps using the default `node:path` import, which is already correct for the machine it runs on. |

**Why this matters:** `resolve("C:\\Users\\you")` on a Linux machine returns
`/current/working/dir/C:\Users\you`, which is nonsense. If pure functions use
the default `resolve`, the Windows tests can never pass on a Linux CI runner.
Selecting `win32` or `posix` from the `host` parameter is what makes both hosts
testable from either machine.

The repo already uses this pattern: see `userMediaDir(home, host)` in
`src/platform.ts` and `resolvePlan(engine, host)`.

### Definition of done for the whole plan

- `npm run typecheck`, `npm test` and `npm run build` pass on Linux.
- The same three commands pass in Windows PowerShell.
- On Windows, `node dist/cli.js doctor` reports ffmpeg, Whisper and a CUDA
  device count above zero.
- On Linux, behaviour is byte-for-byte unchanged. No existing test was
  deleted or weakened to make a new one pass.

---

## Phase 1 — make host behaviour testable

**Goal:** before changing any behaviour, make the test suite able to assert
Windows behaviour while running on Linux. Nothing else in this plan is
verifiable until this exists.

**Files:** `src/server/server.test.ts` only.

### Steps

1. In the test file, make every assertion that today depends on the host
   explicit about which host it means. Pass the host argument that later phases
   will add. These tests will not compile yet — that is expected and correct;
   Phase 2 and Phase 3 add the parameters.

2. Change these existing tests to pass an explicit host:

   - `"path allowlist blocks traversal and system paths"` — add `"linux"` as
     the third argument to every `isPathAllowed(...)` call in it.
   - `"windows display paths"` — add `"wsl"` as the second argument to every
     `toWindowsDisplayPath(...)` call in it.
   - `"output stems are sanitised only for windows targets"` — add `"wsl"` as
     the third argument to both `planOutputTarget(...)` calls.

3. Change the test `"output root never lands inside the repository"`. Replace:

   ```ts
   assert.ok(root.startsWith("/"), `expected an absolute path, got ${root}`);
   ```

   with:

   ```ts
   assert.ok(isAbsoluteUserPath(root), `expected an absolute path, got ${root}`);
   ```

   and add `isAbsoluteUserPath` to the existing import from `../platform.ts`.

4. Change the test `"env settings override config, windows paths converted"`.
   It asserts `/mnt/c/...`, which is only true off Windows. Wrap the two
   path assertions so they only run when not on Windows:

   ```ts
   if (detectHost() !== "windows") {
     assert.equal(env.config.browseRoot, "/mnt/c/Users/someone/Videos");
     assert.equal(env.config.outputRoot, "/mnt/d/transcripts");
   }
   ```

   Add `detectHost` to the import from `../platform.ts`. Leave every other
   assertion in that test unchanged.

5. Add these **new** tests at the end of the file. They define the target
   behaviour for Phases 2 and 3:

   ```ts
   test("absolute path detection per host", () => {
     assert.equal(isAbsoluteUserPath("/home/you/a.mp4", "linux"), true);
     assert.equal(isAbsoluteUserPath("C:\\Users\\you\\a.mp4", "linux"), false);
     assert.equal(isAbsoluteUserPath("C:\\Users\\you\\a.mp4", "windows"), true);
     assert.equal(isAbsoluteUserPath("C:/Users/you/a.mp4", "windows"), true);
     assert.equal(isAbsoluteUserPath("/home/you/a.mp4", "windows"), false);
     // UNC is refused: the allowlist cannot reason about network shares.
     assert.equal(isAbsoluteUserPath("\\\\server\\share\\a.mp4", "windows"), false);
     assert.equal(isAbsoluteUserPath("relative\\a.mp4", "windows"), false);
   });

   test("user paths are left alone on a windows host", () => {
     assert.equal(normalizeUserPath("C:\\Users\\you\\Videos", "windows"), "C:\\Users\\you\\Videos");
     // Forward slashes are accepted and normalised to backslashes.
     assert.equal(normalizeUserPath("D:/transcripts", "windows"), "D:\\transcripts");
     assert.equal(normalizeUserPath('  "C:\\Users\\you"  ', "windows"), "C:\\Users\\you");
     assert.equal(normalizeUserPath("", "windows"), "");
   });

   test("windows allowlist is case-insensitive and drive-scoped", () => {
     const root = "C:\\Users\\you";
     assert.equal(isPathAllowed("C:\\Users\\you\\a.mp4", [root], "windows"), true);
     // NTFS is case-insensitive, so the containment check must be too,
     // otherwise capitalisation walks straight past the allowlist.
     assert.equal(isPathAllowed("c:\\users\\YOU\\a.mp4", [root], "windows"), true);
     assert.equal(isPathAllowed("C:\\Windows\\System32\\cmd.exe", [root], "windows"), false);
     assert.equal(isPathAllowed("D:\\elsewhere\\a.mp4", [root], "windows"), false);
     assert.equal(isPathAllowed("C:\\Users\\you\\..\\other\\a.mp4", [root], "windows"), false);
     assert.equal(isPathAllowed("\\\\server\\share\\a.mp4", [root], "windows"), false);
     // Alternate data streams are a Windows-only way to hide a payload.
     assert.equal(isPathAllowed("C:\\Users\\you\\a.txt:hidden", [root], "windows"), false);
     // A bare drive root as the allowed root must still work.
     assert.equal(isPathAllowed("D:\\clips\\a.mp4", ["D:\\"], "windows"), true);
   });

   test("windows output stems are sanitised for NTFS", () => {
     const win = planOutputTarget(
       "C:\\Users\\you\\sync: Q3 review.mp4",
       "C:\\Users\\you\\Documents",
       "windows",
     );
     assert.equal(win.stem, "sync_ Q3 review");
     assert.equal(win.adjusted, true);
     assert.equal(win.dir, "C:\\Users\\you\\Documents\\sync_ Q3 review");
   });

   test("display path on a windows host is the path itself", () => {
     assert.equal(toWindowsDisplayPath("C:\\Users\\you", "windows"), "C:\\Users\\you");
   });
   ```

6. Add any missing imports these tests need: `isAbsoluteUserPath`,
   `normalizeUserPath`, `detectHost` from `../platform.ts`.

### Verify

`npm run typecheck` **will fail** at the end of this phase, because the
parameters do not exist yet. That is the expected state. Record the failing
symbol names and proceed to Phase 2.

### Done when

The new tests are written and the only typecheck errors are "Expected 1-2
arguments, but got 3" style errors naming `isPathAllowed`,
`toWindowsDisplayPath`, `planOutputTarget`, `isAbsoluteUserPath` and
`normalizeUserPath`.

---

## Phase 2 — the path core

**Goal:** teach `src/platform.ts` about a Windows host. This is the
highest-leverage phase: `toWslPath` is called from eight places, and fixing it
here fixes all of them without touching the callers.

**Files:** `src/platform.ts` only.

### Steps

1. Add `homedir` to the imports at the top of the file:

   ```ts
   import { homedir } from "node:os";
   ```

2. Add these two new exported functions. Put them immediately after
   `resolvePlan`:

   ```ts
   /**
    * Absolute-path test for a user-supplied path, per host. UNC paths
    * (\\server\share) are refused on purpose: the allowlist in fsService
    * cannot reason about network shares, so they must never look absolute.
    */
   export function isAbsoluteUserPath(p: string, host: Host = detectHost()): boolean {
     if (host === "windows") return /^[A-Za-z]:[\\/]/.test(p);
     return p.startsWith("/");
   }

   /**
    * Normalise a path the user typed or pasted, for the host we run on.
    * On WSL a Windows path is converted to /mnt/<drive>. On a Windows host
    * there is nothing to convert, so only the separators are tidied.
    * Idempotent: a path already in the host's own form is returned unchanged.
    */
   export function normalizeUserPath(p: string, host: Host = detectHost()): string {
     const raw = p.trim().replace(/^"|"$/g, "");
     if (raw === "") return raw;
     if (host === "windows") return raw.replace(/\//g, "\\");
     const isWindows = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("\\\\");
     if (!isWindows) return raw;
     try {
       return execFileSync("wslpath", ["-u", raw], { encoding: "utf8" }).trim();
     } catch {
       const m = /^([A-Za-z]):[\\/](.*)$/.exec(raw);
       if (!m) return raw;
       const drive = (m[1] as string).toLowerCase();
       const rest = (m[2] as string).replace(/\\/g, "/");
       return `/mnt/${drive}/${rest}`;
     }
   }
   ```

3. Replace the whole body of the existing `toWslPath` with a delegation, and
   keep its doc comment pointing at the new name. This is what spares the eight
   call sites from changing:

   ```ts
   /**
    * Accept a Windows path and return the host's own form.
    * Kept as the name the server routes already import; new code should call
    * normalizeUserPath directly.
    */
   export function toWslPath(p: string): string {
     return normalizeUserPath(p);
   }
   ```

4. Replace `isOnWindowsMount` with a host-aware version. On a Windows host
   every drive-letter path is "on a Windows filesystem", which is what gates
   NTFS filename sanitising and the free-space probe:

   ```ts
   /** True when the path lives on a Windows filesystem (NTFS). */
   export function isOnWindowsMount(p: string, host: Host = detectHost()): boolean {
     if (host === "windows") return /^[A-Za-z]:[\\/]/.test(p);
     return /^\/mnt\/[a-z](\/|$)/i.test(p);
   }
   ```

5. Add a new function next to `hasWindowsMounts`. **Leave
   `hasWindowsMounts` itself unchanged** — it means literally "/mnt/c exists"
   and the privacy tooling relies on that meaning:

   ```ts
   /**
    * True when a Windows filesystem is reachable at all: a Windows host, or
    * WSL with the drives mounted. Use this, not hasWindowsMounts(), when the
    * question is "are we dealing with NTFS", because /mnt/c does not exist on
    * a Windows host.
    */
   export function hasWindowsFilesystem(host: Host = detectHost()): boolean {
     if (host === "windows") return true;
     return existsSync("/mnt/c");
   }
   ```

6. Give `windowsUserHome` a Windows branch. On a Windows host Node reports the
   profile directly, so the `/mnt/c/Users` guessing is not needed (hard rule 6
   is still satisfied: nothing is hardcoded):

   ```ts
   export function windowsUserHome(host: Host = detectHost()): string | null {
     if (host === "windows") return homedir();
     const root = "/mnt/c/Users";
     // ... existing body unchanged from here down
   ```

7. Leave `toEnginePath`, `resolvePlan`, `detectHost`, `sanitizeForWindows`,
   `windowsSpecialFolder`, `userMediaDir`, `pickWindowsUser` and `describePlan`
   **unchanged**. They are already correct for a Windows host.

### Verify

```bash
npm run typecheck
```

The errors naming `isAbsoluteUserPath` and `normalizeUserPath` are gone. Errors
naming `isPathAllowed`, `toWindowsDisplayPath` and `planOutputTarget` remain,
and Phase 3 clears them.

### Done when

`src/platform.ts` compiles and the two new tests
`"absolute path detection per host"` and
`"user paths are left alone on a windows host"` pass:

```bash
npm test
```

---

## Phase 3 — the allowlist and the file browser

**Goal:** make the server's path guard and the file picker correct on Windows.

**This phase contains the only security-sensitive change in the whole plan.**
`isPathAllowed` decides which paths the HTTP API will touch at all. On Windows
a case-sensitive comparison is a hole, not a cosmetic bug: `C:\Users` and
`c:\users` are the same folder, so a path with changed capitalisation would
walk past a case-sensitive allowlist. Read step 2 carefully.

**Files:** `src/server/fsService.ts` only.

### Steps

1. Update the imports at the top of the file. Add `detectHost`,
   `hasWindowsFilesystem`, `isAbsoluteUserPath` and `normalizeUserPath` to the
   existing import from `../platform.ts`, add `posix` and `win32` to the
   `node:path` import, and add the `Host` type:

   ```ts
   import { basename, dirname, extname, join, posix, resolve, win32 } from "node:path";
   import type { Host } from "../types.ts";
   ```

2. Replace `isPathAllowed` entirely:

   ```ts
   /**
    * Only the user's home, the configured roots, and (off Windows) the Windows
    * mounts are reachable. Everything else, including /etc, /proc and
    * C:\Windows, is refused.
    *
    * Uses path.win32 or path.posix explicitly rather than the ambient
    * node:path, so Windows rules can be asserted from a Linux test runner.
    */
   export function isPathAllowed(
     p: string,
     extraRoots: string[] = [],
     host: Host = detectHost(),
   ): boolean {
     if (!isAbsoluteUserPath(p, host)) return false;
     if (p.includes("\0")) return false;
     const pm = host === "windows" ? win32 : posix;
     const abs = pm.resolve(normalizeUserPath(p, host));
     if (abs.includes("\0")) return false;
     // An alternate data stream (C:\x\a.txt:payload) is a Windows-only way to
     // hide content behind an allowed-looking name.
     if (host === "windows" && abs.slice(2).includes(":")) return false;

     const roots = [
       ...(host === "windows" ? [] : ["/mnt"]),
       homedir(),
       ...extraRoots
         .filter((r) => r !== "")
         .map((r) => pm.resolve(normalizeUserPath(r, host))),
     ];

     // NTFS is case-insensitive; ext4 is not. Compare accordingly.
     const fold = (s: string) => (host === "windows" ? s.toLowerCase() : s);
     const target = fold(abs);
     return roots.some((root) => {
       const r = fold(root);
       if (target === r) return true;
       // A drive root already ends in a separator: C:\ must not become C:\\.
       return r.endsWith(pm.sep) ? target.startsWith(r) : target.startsWith(`${r}${pm.sep}`);
     });
   }
   ```

3. Update `assertAllowed` so it resolves with the same path dialect and passes
   the host through:

   ```ts
   export function assertAllowed(p: string, extraRoots: string[] = []): string {
     const host = detectHost();
     const pm = host === "windows" ? win32 : posix;
     const abs = pm.resolve(normalizeUserPath(p, host));
     if (!isPathAllowed(abs, extraRoots, host)) {
       throw forbiddenPath(`path outside the allowed roots: ${abs}`);
     }
     return abs;
   }
   ```

4. Make `toWindowsDisplayPath` host-aware. On a Windows host the path already
   *is* the Windows form, so return it instead of `null`:

   ```ts
   export function toWindowsDisplayPath(p: string, host: Host = detectHost()): string | null {
     if (host === "windows") return p;
     const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p);
     // ... existing body unchanged from here down
   ```

5. **Fix a real bug in `listDirectory`.** Find this line:

   ```ts
   const parent = abs === "/" ? null : dirname(abs);
   ```

   On Windows `dirname("C:\\")` returns `"C:\\"`, so the picker offers a parent
   that is itself and the user gets stuck. Replace with:

   ```ts
   // dirname() of a filesystem root returns the root itself, on both "/" and "C:\".
   const parentDir = dirname(abs);
   const parent = parentDir === abs ? null : parentDir;
   ```

   Leave the following `isPathAllowed(parent, ...)` guard exactly as it is.

6. Give `windowsUserDir` a Windows branch:

   ```ts
   export function windowsUserDir(host: Host = detectHost()): string | null {
     if (host === "windows") return homedir();
     const root = "/mnt/c/Users";
     // ... existing body unchanged from here down
   ```

7. In `favorites`, the `"WSL home"` entry must appear only under WSL. Find:

   ```ts
   if (winHome) {
     list.push({ label: "WSL home", path: homedir() });
   } else {
   ```

   Replace the condition with an explicit host test, and make the `else` branch
   the fallback for every host that has no separate Windows profile:

   ```ts
   if (detectHost() === "wsl") {
     list.push({ label: "WSL home", path: homedir() });
   } else if (!winHome) {
   ```

   Then add, after that whole if/else block, so a Windows host still offers its
   own home folder:

   ```ts
   if (detectHost() === "windows") list.push({ label: "Home", path: homedir() });
   ```

8. Add a `host` parameter to `planOutputTarget` and switch it to the explicit
   path dialect. Replace its first four lines:

   ```ts
   export function planOutputTarget(
     inputPath: string,
     outputRoot: string,
     host: Host = detectHost(),
   ): OutputTarget {
     const pm = host === "windows" ? win32 : posix;
     const root = pm.resolve(normalizeUserPath(outputRoot, host));
     const originalStem = pm.basename(inputPath, pm.extname(inputPath));
     const onWindows = isOnWindowsMount(root, host);
     let stem = onWindows ? sanitizeForWindows(originalStem) : originalStem;

     let dir = pm.join(root, stem);
     if (onWindows && dir.length > MAX_WINDOWS_PATH) {
       const overflow = dir.length - MAX_WINDOWS_PATH;
       stem = stem.slice(0, Math.max(8, stem.length - overflow));
       dir = pm.join(root, stem);
     }
   ```

   Leave the returned object and the rest of the function unchanged.

9. Leave `tildify` unchanged. On a Windows host `toWindowsDisplayPath` now
   always returns a value, so `displayPath` never falls through to `tildify`.

### Verify

```bash
npm run typecheck && npm test
```

All typecheck errors from Phase 1 are now gone, and all five new tests pass.

### Done when

The full suite is green on Linux and no pre-existing test was changed beyond
the explicit host arguments added in Phase 1.

---

## Phase 4 — the four real bugs the port exposes

**Goal:** fix four defects that are latent today and become visible failures on
Windows. Each is independent and two or three lines.

**Files:** `src/server/routes/misc.ts`, `src/server/workspace.ts`, `src/cli.ts`.

### Step 4a — ffprobe is never found on Windows

In `src/server/routes/misc.ts`, find this line inside the `/api/probe` route:

```ts
    return probeMedia(toWslPath(path), state.config.ffmpegPath.replace(/ffmpeg$/, "ffprobe"));
```

The regex is anchored at the end of the string, so it never matches
`ffmpeg.exe` and media probing silently fails. Replace with:

```ts
    // The extension must survive the swap: ffmpeg.exe -> ffprobe.exe.
    const ffprobePath = state.config.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    return probeMedia(normalizeUserPath(path), ffprobePath);
```

Change the import on line 6 from `toWslPath` to `normalizeUserPath`, and update
the other use of it in the same file (inside the `PUT /api/config` route) to the
new name.

Then grep for any other place that derives ffprobe from ffmpeg and apply the
same fix:

```bash
grep -rn "ffprobe" src/
```

### Step 4b — the output folder name is wrong on backslash paths

In `src/server/workspace.ts`, find:

```ts
function baseStem(job: Job): string {
  return job.outDir.split("/").filter(Boolean).pop() ?? "audio";
}
```

Splitting on `/` returns the entire path when the separators are backslashes.
Replace with:

```ts
function baseStem(job: Job): string {
  return basename(job.outDir) || "audio";
}
```

Add `basename` to the `node:path` import at the top of the file.

### Step 4c — the workspace deletion guard

Still in `src/server/workspace.ts`, replace `cleanupWorkspace`:

```ts
/** Always safe to call, in success, failure and cancellation alike. */
export function cleanupWorkspace(job: Job): void {
  if (!job.workDir) return;
  // Hard rule 1: only our own files may be removed. Asserting containment in
  // WORK_ROOT is stronger than the old "/mnt/" test and works on every host.
  const dir = resolve(job.workDir);
  const root = resolve(WORK_ROOT);
  if (dir === root || !dir.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to remove a workspace outside ${root}: ${job.workDir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}
```

Add `resolve` and `sep` to the `node:path` import.

The existing test that asserts a `/mnt/c/...` work directory is refused must
still pass: such a path is outside `WORK_ROOT`, so it still throws. **Do not
change that test.** If it fails, your containment logic is wrong.

### Step 4d — the browser never opens on Windows

In `src/cli.ts`, inside the `if (flags.open === true)` block, find:

```ts
        const [bin, args] =
          host === "wsl"
            ? ["powershell.exe", ["-NoProfile", "-Command", "Start-Process", server.url]]
            : host === "macos"
              ? ["open", [server.url]]
              : ["xdg-open", [server.url]];
```

A Windows host falls through to `xdg-open`, which does not exist there. Add a
branch as the first case:

```ts
        const [bin, args] =
          host === "windows"
            // The empty "" is the window title start expects before the URL.
            ? ["cmd", ["/c", "start", "", server.url]]
            : host === "wsl"
              ? ["powershell.exe", ["-NoProfile", "-Command", "Start-Process", server.url]]
              : host === "macos"
                ? ["open", [server.url]]
                : ["xdg-open", [server.url]];
```

### Verify

```bash
npm run typecheck && npm test
```

### Done when

All four edits are in and the suite is green. No new test is required for these;
they are covered by manual verification in Phase 10.

---

## Phase 5 — host branches in disk, doctor and config

**Goal:** make the free-space report and the health report truthful on Windows.
Both currently contain WSL-specific workarounds that would lie on a Windows
host.

**Files:** `src/server/disk.ts`, `src/doctor.ts`.

### Step 5a — free space

In `src/server/disk.ts`, add to the imports:

```ts
import { parse, resolve } from "node:path";
import { detectHost, hasWindowsMounts, isOnWindowsMount } from "../platform.ts";
import type { Host } from "../types.ts";
```

Replace `freeBytesFor`:

```ts
/**
 * `df` inside WSL reports the virtual 1 TB size of ext4.vhdx, which is a lie.
 * Writes to the WSL filesystem actually grow that vhdx on C:, and writes to
 * /mnt/<drive> consume that drive. Either way the honest number comes from
 * statfs on a Windows mount.
 *
 * On a Windows host that lie does not exist: statfs the target's own drive.
 */
export async function freeBytesFor(
  targetPath: string,
  host: Host = detectHost(),
): Promise<number> {
  const probePath =
    host === "windows"
      ? parse(resolve(targetPath)).root
      : isOnWindowsMount(targetPath, host)
        ? targetPath.split("/").slice(0, 3).join("/")
        : hasWindowsMounts()
          ? "/mnt/c" // WSL: writes grow ext4.vhdx, which lives on C:
          : targetPath; // plain Linux or macOS: the filesystem is the truth
  try {
    const { bavail, bsize } = await statfs(probePath);
    return Number(bavail) * Number(bsize);
  } catch {
    // Not on WSL, or the mount vanished: fall back to the target itself.
    const { bavail, bsize } = await statfs(targetPath);
    return Number(bavail) * Number(bsize);
  }
}
```

Replace `diskReport`. It gains a `host` field so the web UI can stop showing WSL
advice on a Windows machine, and the WSL reclaim hint becomes conditional:

```ts
export async function diskReport(outputRoot: string): Promise<{
  host: Host;
  windowsFreeBytes: number;
  outputFreeBytes: number;
  warning: string | null;
}> {
  const host = detectHost();
  // The system drive: C: on Windows, the drive holding ext4.vhdx under WSL.
  const systemProbe = host === "windows" ? homedir() : hasWindowsMounts() ? "/mnt/c" : homedir();
  const [windowsFreeBytes, outputFreeBytes] = await Promise.all([
    freeBytesFor(systemProbe, host),
    freeBytesFor(outputRoot, host),
  ]);
  const lowest = Math.min(windowsFreeBytes, outputFreeBytes);
  return {
    host,
    windowsFreeBytes,
    outputFreeBytes,
    warning:
      lowest < LOW_SPACE_WARNING_BYTES
        ? `Only ${formatBytes(lowest)} free. Transcription may fail.` +
          (host === "wsl"
            ? ` Reclaim WSL space with: wsl --shutdown, then wsl --manage <distro> --set-sparse true`
            : "")
        : null,
  };
}
```

Keep the field name `windowsFreeBytes` so the web client's types do not churn.
Its meaning is now "the system drive".

### Step 5b — the doctor

In `src/doctor.ts`, add to the imports:

```ts
import { existsSync, readdirSync } from "node:fs";
```

Find the `pythonPath` derivation:

```ts
  const pythonPath = cfg.whisperPath.includes("/") || cfg.whisperPath.includes("\\")
    ? join(dirname(cfg.whisperPath), "python")
    : "python3";
```

Replace with a version that knows the Windows venv layout (`Scripts\python.exe`,
not `bin/python`):

```ts
  const onWindows = plan.host === "windows";
  const pythonPath = cfg.whisperPath.includes("/") || cfg.whisperPath.includes("\\")
    ? join(dirname(cfg.whisperPath), onWindows ? "python.exe" : "python")
    : onWindows
      ? "python"
      : "python3";
```

Replace the `cuda libs` check block. On Windows the libraries are DLLs sitting
beside the executable, not Python packages in a venv:

```ts
  // The failure mode that produced "Library libcublas.so.12 is not found":
  // pip puts the libs in site-packages/nvidia/*/lib, off the loader's path.
  // On Windows the loader searches the executable's own folder instead, so the
  // DLLs must live there and the equivalent names are cublas64_*.dll / cudnn*.dll.
  const libDirs = cudaLibraryPath(cfg.whisperPath, plan.host);
  let hasCublas: boolean;
  let hasCudnn: boolean;
  if (onWindows) {
    const dllDir = dirname(cfg.whisperPath);
    const dlls = existsSync(dllDir) ? readdirSync(dllDir) : [];
    hasCublas = dlls.some((f) => /^cublas64_\d+\.dll$/i.test(f));
    hasCudnn = dlls.some((f) => /^cudnn.*\.dll$/i.test(f));
  } else {
    hasCublas = libDirs.some((d) => d.includes("cublas"));
    hasCudnn = libDirs.some((d) => d.includes("cudnn"));
  }
  checks.push({
    name: "cuda libs",
    ok: hasCublas && hasCudnn,
    detail: hasCublas && hasCudnn
      ? onWindows
        ? `cuBLAS + cuDNN DLLs found beside ${basename(cfg.whisperPath)}`
        : `cuBLAS + cuDNN found, LD_LIBRARY_PATH injected by wg`
      : `missing: ${[!hasCublas && "cuBLAS", !hasCudnn && "cuDNN"].filter(Boolean).join(", ")}`,
    fix: hasCublas && hasCudnn
      ? undefined
      : onWindows
        ? `put cublas64_*.dll and cudnn*.dll next to ${cfg.whisperPath}`
        : `${dirname(cfg.whisperPath)}/pip install nvidia-cublas-cu12 'nvidia-cudnn-cu12>=9,<10'`,
  });
```

Add `basename` to the `node:path` import.

Then fix the `ctranslate2` check. With a self-contained Whisper build there is
no Python at all, so a failed import probe is **not** a failure — reporting one
would send the user chasing a problem that does not exist:

```ts
  } else if (onWindows) {
    // A self-contained Windows build ships no interpreter; the GPU check
    // below is the real signal.
    checks.push({
      name: "ctranslate2",
      ok: true,
      detail: "no Python interpreter beside the executable; bundled build assumed",
    });
  } else {
    checks.push({
      name: "ctranslate2",
      ok: false,
      detail: "not importable",
      fix: "bash scripts/install-wsl.sh",
    });
  }
```

Finally, replace the installer hint in every remaining `fix:` string so it names
the right script per host. The `ffmpeg` and `whisper` checks both say
`bash scripts/install-wsl.sh`; make each read:

```ts
    fix: ff.ok ? undefined : onWindows
      ? "powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1"
      : "bash scripts/install-wsl.sh",
```

`onWindows` must be declared before the first use, so move its declaration to
the top of `runDoctor`, immediately after the `host/engine` check is pushed.

### Verify

```bash
npm run typecheck && npm test
node dist/cli.js doctor   # on Linux: output must be identical to before this phase
```

### Done when

The suite is green and `doctor` output on Linux is unchanged.

---

## Phase 6 — CUDA and process spawning

**Goal:** stop the Linux CUDA trick from misfiring on Windows, and make spawning
a Windows Whisper executable reliable.

**Files:** `src/exec.ts`, `src/server/runner.ts`.

### Background the agent must not get wrong

On Linux, `buildEnv()` injects `LD_LIBRARY_PATH` because pip hides cuBLAS and
cuDNN inside the venv where the dynamic loader cannot see them. **The naive
Windows translation — prepend the folder to `PATH` — does not work**, because
Python 3.8 and later deliberately stopped searching `PATH` for the dependencies
of compiled extension modules. Correctness on Windows therefore comes from the
*install layout* (DLLs beside the executable), not from the environment.

So the right change here is to make these functions honest no-ops on Windows.
**Do not add `PATH` injection.** Hard rule 3 still stands: `buildEnv()` must
still be passed to every Whisper spawn. It simply has nothing to add on Windows.

### Steps

1. In `src/exec.ts`, add the host imports:

   ```ts
   import { detectHost } from "./platform.ts";
   import type { Command, ExecutionPlan, Host } from "./types.ts";
   ```

2. Give `cudaLibraryPath` a Windows branch as its first statement:

   ```ts
   export function cudaLibraryPath(whisperPath: string, host: Host = detectHost()): string[] {
     // Windows resolves a DLL's dependencies from the executable's own folder,
     // and Python 3.8+ ignores PATH for extension modules, so there is nothing
     // useful to inject. The DLLs must be installed beside the executable.
     if (host === "windows") return [];
     if (!whisperPath.includes("/")) return [];
     // ... existing body unchanged from here down
   ```

3. Give `buildEnv` the same parameter and pass it through. Its existing
   `dirs.length === 0` early return then does the right thing automatically:

   ```ts
   export function buildEnv(whisperPath: string, host: Host = detectHost()): NodeJS.ProcessEnv {
     const dirs = cudaLibraryPath(whisperPath, host);
     if (dirs.length === 0) return process.env;
     // ... existing body unchanged
   ```

4. In `runCommand` in the same file, make spawning tolerate a batch wrapper.
   `spawn` with `shell: false` cannot execute a `.cmd` or `.bat` on Windows and
   fails with `EINVAL`:

   ```ts
     const final = wrapForInterop(cmd, plan);
     // A .cmd/.bat wrapper cannot be executed directly by CreateProcess.
     const needsShell = /\.(cmd|bat)$/i.test(final.bin);
     return new Promise((resolvePromise, rejectPromise) => {
       const child = spawn(final.bin, final.args, { stdio: "inherit", shell: needsShell, env });
   ```

5. Apply the same `needsShell` treatment to `spawnStage` in
   `src/server/runner.ts`. Find its `spawn(command.bin, command.args, {` call
   and add the same computed `shell` option. Change nothing else in that
   function — in particular **do not touch the artifact verification after the
   process exits.** Hard rule 2: `whisper-ctranslate2` exits 0 after catching
   its own exceptions, so the output files are the only proof of success.

### Verify

```bash
npm run typecheck && npm test
```

On Linux, `cudaLibraryPath` must still return the venv nvidia lib folders.
Confirm with:

```bash
node --experimental-strip-types -e "import('./src/exec.ts').then(m => console.log(m.cudaLibraryPath(process.env.HOME + '/.wg/venv/bin/whisper-ctranslate2')))"
```

### Done when

The suite is green and the command above still prints a non-empty array on a
Linux machine that has the venv installed.

---

## Phase 7 — the web client

**Goal:** stop the UI telling a Windows user to run WSL commands.

**Files:** `web/src/api/types.ts`, `web/src/pages/Health.tsx`,
`web/src/pages/NewRun.tsx`.

Hard rule 7: the web client's dependency list is fixed. **Add no packages.**

### Steps

1. In `web/src/api/types.ts`, add `host` to the disk report type:

   ```ts
   host: "windows" | "wsl" | "linux" | "macos";
   ```

   Put it on the type that already carries `windowsFreeBytes` and
   `outputFreeBytes`.

2. In `web/src/pages/Health.tsx`, find the block containing the text
   `Deleting files inside WSL does not shrink ext4.vhdx` and the
   `wsl --shutdown` / `wsl --manage` snippet. Render it only under WSL. Guard it
   with the new field, for example:

   ```tsx
   {disk?.host === "wsl" && (
     // ... the existing block, unchanged
   )}
   ```

   Use whatever the surrounding code already calls the disk query result. Do not
   restructure the component.

3. In `web/src/pages/NewRun.tsx`, find the copy:

   ```
   Audio is extracted from the recording into WSL. Your Windows file is read only and is
   ```

   Rewrite it host-neutrally, keeping the reassurance that the source file is
   never modified, which is the point of the sentence:

   ```
   Audio is extracted into a temporary working folder. Your recording is read
   only and is never changed.
   ```

### Verify

```bash
npm run build
```

### Done when

The web build succeeds and no file under `web/` mentions WSL outside a
`host === "wsl"` guard:

```bash
grep -rn "WSL\|wsl --" web/src
```

---

## Phase 8 — the Windows installer and entry points

**Goal:** give a Windows user a way to install the engines and run the app
without `make`, which Git for Windows does not ship.

**Files:** new `scripts/install-windows.ps1`, new `.gitattributes`,
edit `package.json`.

### Step 8a — line endings

Create `.gitattributes` at the repo root. Without it, Git on Windows can convert
the shell scripts to CRLF, and they then fail under Linux with
`bad interpreter: /bin/bash^M` — a symptom that looks nothing like its cause:

```
* text=auto eol=lf
*.sh text eol=lf
Makefile text eol=lf
*.ps1 text eol=crlf
*.cmd text eol=crlf
*.bat text eol=crlf
*.mp4 binary
*.mkv binary
*.wav binary
```

### Step 8b — npm entry points

In `package.json`, add to `scripts`. Do not remove or rename any existing
script, and do not add a dependency:

```json
    "setup:windows": "powershell -ExecutionPolicy Bypass -File scripts/install-windows.ps1",
    "start": "node dist/cli.js ui --open",
    "doctor": "node dist/cli.js doctor"
```

### Step 8c — the installer

Create `scripts/install-windows.ps1`. It mirrors the design of
`scripts/install-wsl.sh`: no administrator rights, every step skipped when
already satisfied, safe to re-run.

**Do not hardcode a download URL for the Whisper build.** Asset names change
between releases. Query the GitHub releases API, and if nothing suitable is
found, fail loudly with manual instructions rather than guessing.

```powershell
#Requires -Version 5.1
# Install the Windows-side runtime for whisper-generator.
# No administrator rights needed. Safe to re-run; each step is skipped when
# already satisfied.
$ErrorActionPreference = 'Stop'

$Root    = Join-Path $env:USERPROFILE '.wg'
$BinDir  = Join-Path $Root 'bin'
$EngDir  = Join-Path $Root 'engine'
New-Item -ItemType Directory -Force -Path $BinDir, $EngDir | Out-Null

function Log($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1/4 ffmpeg
Log '1/4 ffmpeg'
$ffmpeg = Join-Path $BinDir 'ffmpeg.exe'
if (Test-Path $ffmpeg) {
  Write-Host "already installed: $ffmpeg"
} else {
  $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
  $zip = Join-Path $env:TEMP 'wg-ffmpeg.zip'
  $tmp = Join-Path $env:TEMP 'wg-ffmpeg-extract'
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Get-ChildItem $tmp -Recurse -Include 'ffmpeg.exe','ffprobe.exe' |
    ForEach-Object { Copy-Item $_.FullName -Destination $BinDir -Force }
  Remove-Item $zip, $tmp -Recurse -Force
  Write-Host "installed: $ffmpeg"
}

# ---------------------------------------------------------------- 2/4 whisper
Log '2/4 whisper engine'
$whisper = Get-ChildItem $EngDir -Recurse -Filter 'whisper*.exe' -ErrorAction SilentlyContinue |
           Select-Object -First 1
if ($whisper) {
  Write-Host "already installed: $($whisper.FullName)"
} else {
  Write-Host 'Fetching the latest self-contained Whisper build...'
  $api = 'https://api.github.com/repos/Purfview/whisper-standalone-win/releases/latest'
  try {
    $rel   = Invoke-RestMethod -Uri $api -UseBasicParsing -Headers @{ 'User-Agent' = 'whisper-generator' }
    $asset = $rel.assets | Where-Object { $_.name -match 'XXL.*\.7z$|Windows.*\.zip$' } | Select-Object -First 1
  } catch { $asset = $null }

  if (-not $asset) {
    Write-Warning @"
Could not resolve a download automatically.
Install the engine by hand, then re-run this script:
  1. Open https://github.com/Purfview/whisper-standalone-win/releases
  2. Download the Faster-Whisper build for Windows with CUDA support
  3. Extract it so that whisper-faster.exe sits inside:
       $EngDir
The CUDA DLLs (cublas64_*.dll, cudnn*.dll) MUST stay in the same folder
as the .exe. Windows resolves them from the executable's own directory.
"@
  } else {
    $pkg = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $pkg -UseBasicParsing
    if ($pkg -like '*.zip') {
      Expand-Archive -Path $pkg -DestinationPath $EngDir -Force
      Remove-Item $pkg -Force
      Write-Host "installed into: $EngDir"
    } else {
      Write-Warning "Downloaded $pkg. Extract it into $EngDir with 7-Zip, then re-run this script."
    }
  }
  $whisper = Get-ChildItem $EngDir -Recurse -Filter 'whisper*.exe' -ErrorAction SilentlyContinue |
             Select-Object -First 1
}

# ---------------------------------------------------------------- 3/4 .env
Log '3/4 .env'
$envFile = Join-Path $PSScriptRoot '..\.env' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $envFile) {
  $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  $example = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.example'
  if (Test-Path $example) { Copy-Item $example $envPath }
  else { New-Item -ItemType File -Path $envPath -Force | Out-Null }
  Add-Content $envPath "`nWG_FFMPEG_PATH=$ffmpeg"
  if ($whisper) { Add-Content $envPath "WG_WHISPER_PATH=$($whisper.FullName)" }
  Write-Host "created .env -- edit it to change the default folders"
} else {
  Write-Host ".env already exists; not modified. Check WG_FFMPEG_PATH and WG_WHISPER_PATH by hand."
}

# ---------------------------------------------------------------- 4/4 verify
Log '4/4 verify'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  npm install --no-audit --no-fund | Out-Null
  npm --prefix web install --no-audit --no-fund | Out-Null
  npm run build
  node dist/cli.js doctor
} finally { Pop-Location }

Write-Host "`nDone. Start the app with: npm start" -ForegroundColor Green
```

### Verify

The script cannot be run on Linux. Check only that the files exist, that
`package.json` is still valid JSON, and that nothing else broke:

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json ok')"
npm run typecheck && npm test && npm run build
```

### Done when

`.gitattributes` and `scripts/install-windows.ps1` exist, `package.json` parses,
and the Linux checks still pass.

---

## Phase 9 — documentation

**Goal:** satisfy the repo rule that `docs/PROJECT.md` is updated in the same
change as the behaviour.

**Files:** `docs/PROJECT.md`, `README.md`, `AGENTS.md`.

### Steps

1. In `docs/PROJECT.md`:
   - In the code map, note that `platform.ts` now exports
     `normalizeUserPath()`, `isAbsoluteUserPath()` and
     `hasWindowsFilesystem()`, and that `toWslPath()` delegates to
     `normalizeUserPath()`.
   - Rewrite hard rule 4 ("Never read free space from `df` on `/`") to say the
     rule applies to WSL, and that on a Windows host `statfs` on the target's
     own drive root is correct.
   - Rewrite hard rule 6 ("Never hardcode the Windows username") to say it is
     discovered from `/mnt/c/Users` under WSL and from `homedir()` on Windows.
   - Add a short "Windows host" subsection: the engines are `.exe` files, the
     CUDA DLLs must sit beside the Whisper executable, and `buildEnv()` is a
     deliberate no-op there.
   - Add to the failure-modes table: *"Whisper runs on CPU on Windows"* →
     *"CUDA DLLs not in the executable's folder"* → *"re-run the installer; check
     `doctor`"*.

2. In `README.md`:
   - The requirements table says *"Windows users run it inside WSL2"*. Add
     Windows-native as a supported option.
   - Add a Windows quick start: `npm run setup:windows`, then `npm start`.
   - In the defaults table at the bottom, add a Windows column.

3. In `AGENTS.md`, update hard rules 4 and 6 to match the `docs/PROJECT.md`
   wording so the two files do not contradict each other.

Keep hard rule 9 in mind in every example: `you`, `Alice`, `Bob`, generic
project names.

### Verify

```bash
make check
```

This runs typecheck, tests, build and the privacy scan. All four must pass.

### Done when

`make check` is green and no doc still claims WSL is the only way to run on
Windows.

---

## Phase 10 — verification on Windows (human-run)

**Goal:** prove the port works. These steps cannot be done from Linux and are
not optional — everything before this point is unverified on the target
platform.

Run in **PowerShell**, not Git Bash. Git Bash rewrites arguments that look like
Unix paths before the program sees them, which corrupts paths and flags, and it
has no proper terminal for interactive prompts. Use Git Bash for `git` only.

| # | Step | Expected result |
|---|---|---|
| 1 | `node --version` | 22 or newer |
| 2 | `npm run setup:windows` | Finishes; `doctor` runs at the end |
| 3 | `npm run doctor` | `ffmpeg` ✔, `whisper` ✔, `cuda libs` ✔, `ctranslate2` reports CUDA device count **above zero**, `model fit` ✔ |
| 4 | `npm start` | Browser opens at `http://localhost:7788` |
| 5 | Open the file picker | Shows `Videos`, `Downloads`, `Documents`, `Desktop`, `Home`; paths display as `C:\Users\you\...` |
| 6 | Navigate to a drive root, then up | The "up" control is absent at `C:\`, not stuck pointing at itself |
| 7 | Health page | No `wsl --shutdown` advice; free space matches what File Explorer reports for `C:` |
| 8 | Transcribe a short recording | Progress advances; transcript appears under `Documents\transcripts\<name>\` |
| 9 | Check the source recording | Unchanged, same timestamp, not moved or deleted |
| 10 | Transcribe a file named `sync: Q3 review.mp4` | Output folder named `sync_ Q3 review`; no I/O error |
| 11 | Library and Search pages | The new transcript is listed and searchable |
| 12 | Task Manager during a run | GPU utilisation is non-zero |

**If step 3 reports CPU-only, the port is not finished**, regardless of whether
the UI works: transcription will be roughly 10x slower. The cause is almost
always the CUDA DLLs not being in the same folder as the Whisper executable.
Fix the install layout, not the code.

---

## Appendix A — files touched, by phase

| File | Phases |
|---|---|
| `src/server/server.test.ts` | 1 |
| `src/platform.ts` | 2 |
| `src/server/fsService.ts` | 3 |
| `src/server/routes/misc.ts` | 4, 5 |
| `src/server/workspace.ts` | 4 |
| `src/cli.ts` | 4 |
| `src/server/disk.ts` | 5 |
| `src/doctor.ts` | 5 |
| `src/exec.ts` | 6 |
| `src/server/runner.ts` | 6 |
| `web/src/api/types.ts` | 7 |
| `web/src/pages/Health.tsx` | 7 |
| `web/src/pages/NewRun.tsx` | 7 |
| `.gitattributes` *(new)* | 8 |
| `scripts/install-windows.ps1` *(new)* | 8 |
| `package.json` | 8 |
| `docs/PROJECT.md`, `README.md`, `AGENTS.md` | 9 |

## Appendix B — files that must NOT be changed

These were checked and need no edit. Changing them is out of scope:

`src/types.ts` (`Host` already includes `"windows"`, `Engine` already includes
`"windows"`), `src/shell.ts`, `src/pipeline.ts`, `src/prompt.ts`,
`src/config.ts`, `src/env.ts`, `src/meeting.ts`, `src/server/server.ts`,
`src/server/router.ts`, `src/server/sse.ts`, `src/server/errors.ts`,
`src/server/jobStore.ts`, `src/server/jobTypes.ts`, `src/server/probe.ts`,
`src/server/peaks.ts`, `src/server/zip.ts`, `src/server/aiExport.ts`,
`src/server/routes/jobs.ts`, `src/server/routes/meetings.ts`,
`scripts/install-wsl.sh`, `Makefile`, `tsconfig.json`.

`src/server/routes/jobs.ts` and `src/server/routes/meetings.ts` call
`toWslPath`, which Phase 2 makes host-aware from the inside. They inherit the
fix and must not be edited.

## Appendix C — optional follow-up, not part of this plan

- **Windows CI.** Add `windows-latest` to a `strategy.matrix` in
  `.github/workflows/ci.yml`. The suite needs no GPU, ffmpeg or Whisper, so it
  runs on a bare runner. Worth doing, but the user testing on Windows daily
  already catches Windows breakage; the existing Ubuntu job is what protects
  the Linux path.
- **Drive switcher** in the file picker, so the user can jump between `C:` and
  `D:`. On Linux everything hangs off `/`; Windows has no single root above the
  drives.
- **Rename `toWslPath` to `normalizeUserPath` at all eight call sites** and drop
  the delegation. Cosmetic; the delegation exists so this plan does not have to
  touch eight files.
