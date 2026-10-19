import { existsSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import type { Engine, ExecutionPlan, Host } from "./types.ts";

let cachedHost: Host | undefined;

export function detectHost(): Host {
  if (cachedHost) return cachedHost;
  if (process.platform === "win32") return (cachedHost = "windows");
  if (process.platform === "darwin") return (cachedHost = "macos");
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    if (version.includes("microsoft")) return (cachedHost = "wsl");
  } catch {
    /* not Linux or /proc unavailable */
  }
  return (cachedHost = "linux");
}

export function resolvePlan(engine: Engine, host: Host = detectHost()): ExecutionPlan {
  if (host === "windows") {
    return { host, engine: "windows", viaInterop: false, shell: "powershell" };
  }
  const wanted: Exclude<Engine, "auto"> = engine === "auto" ? "native" : engine;
  if (wanted === "windows") {
    if (host !== "wsl") {
      throw new Error(`engine "windows" requires Windows or WSL, current host is "${host}"`);
    }
    return { host, engine: "windows", viaInterop: true, shell: "powershell" };
  }
  return { host, engine: "native", viaInterop: false, shell: "posix" };
}

/**
 * Convert a path for the engine that will consume it.
 * WSL -> Windows uses wslpath; a UNC fallback keeps \\wsl$ paths working when
 * the file lives on the Linux filesystem.
 */
export function toEnginePath(p: string, plan: ExecutionPlan): string {
  const abs = isAbsolute(p) ? p : resolve(p);
  if (!plan.viaInterop) return abs;
  try {
    return execFileSync("wslpath", ["-w", abs], { encoding: "utf8" }).trim();
  } catch {
    const distro = process.env.WSL_DISTRO_NAME ?? "Ubuntu";
    return `\\\\wsl$\\${distro}${abs.replace(/\//g, "\\")}`;
  }
}

/** Directories under C:\Users that are never a real person. */
const NON_USER_DIRS = new Set([
  "public",
  "default",
  "default user",
  "all users",
  "defaultaccount",
  "wdagutilityaccount",
  "desktop.ini",
]);

/**
 * Pick the real Windows user from the entries of C:\Users.
 * Pure, so it can be tested without a Windows mount. `hasProfileDirs` reports
 * whether a candidate contains the folders a genuine profile always has.
 */
export function pickWindowsUser(
  entries: string[],
  hasProfileDirs: (name: string) => boolean,
): string | null {
  const candidates = entries
    .filter((name) => !NON_USER_DIRS.has(name.toLowerCase()))
    .filter((name) => !name.startsWith("."))
    .filter(hasProfileDirs);
  return candidates[0] ?? null;
}

/**
 * Windows redirects Documents and Desktop into OneDrive when it is set up, so
 * `<profile>/Documents` becomes a near-empty stub. Prefer the redirected
 * folder when it exists, fall back to the profile folder when it does not.
 */
export function windowsSpecialFolder(
  profile: string,
  folder: "Documents" | "Desktop" | "Pictures",
): string {
  const oneDrive = join(profile, "OneDrive", folder);
  if (existsSync(oneDrive)) return oneDrive;
  return join(profile, folder);
}

/** Absolute WSL path of the Windows user profile, or null when unavailable. */
export function windowsUserHome(): string | null {
  const root = "/mnt/c/Users";
  if (!existsSync(root)) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const user = pickWindowsUser(entries, (name) =>
    existsSync(join(root, name, "Documents")) || existsSync(join(root, name, "Videos")),
  );
  return user ? join(root, user) : null;
}

/** True when the path lives on a mounted Windows drive (NTFS via drvfs). */
export function isOnWindowsMount(p: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(p);
}

/**
 * Accept a Windows path and return the WSL path. Idempotent: a path that is
 * already POSIX is returned unchanged, so this is safe to apply to any
 * user-supplied location.
 */
export function toWslPath(p: string): string {
  const raw = p.trim().replace(/^"|"$/g, "");
  if (raw === "") return raw;
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

/**
 * NTFS rejects these characters, and Windows reserves these device names.
 * Whisper derives output filenames from the input stem, so an unsanitised
 * stem makes ffmpeg or Whisper fail with a confusing I/O error when the
 * output directory is on /mnt/<drive>.
 */
export function sanitizeForWindows(stem: string): string {
  const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  let out = stem
    .replace(/[<>:"|?*\\/]/g, "_")
    // Control characters are invalid on NTFS.
    .replace(/[\u0000-\u001f]/g, "")
    // Trailing dots and spaces are silently dropped by Windows.
    .replace(/[. ]+$/g, "");
  if (out === "") out = "transcript";
  if (RESERVED.test(out)) out = `${out}_`;
  return out;
}

export function describePlan(plan: ExecutionPlan): string {
  if (plan.host === "windows") return "Windows host, Whisper runs natively";
  if (plan.viaInterop) return `${plan.host} host, Whisper runs on Windows via powershell.exe interop`;
  return `${plan.host} host, Whisper runs inside ${plan.host}`;
}
