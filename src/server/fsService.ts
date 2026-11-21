import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, posix, resolve, win32 } from "node:path";
import {
  detectHost,
  hasWindowsFilesystem,
  isAbsoluteUserPath,
  isOnWindowsMount,
  normalizeUserPath,
  pickWindowsUser,
  sanitizeForWindows,
  toWslPath,
  userMediaDir,
  windowsSpecialFolder,
} from "../platform.ts";
import type { Host } from "../types.ts";
import { forbiddenPath, notFound } from "./errors.ts";

export const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v", ".wmv", ".flv", ".ts",
]);
export const AUDIO_EXTENSIONS = new Set([
  ".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".wma",
]);

export function isMediaPath(p: string): boolean {
  const ext = extname(p).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
}

/**
 * Only the user's home, the configured roots, and (off Windows) the Windows
 * mounts are reachable. Everything else, including /etc, /proc and
 * C:\\Windows, is refused.
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
  // An alternate data stream (C:\\x\\a.txt:payload) is a Windows-only way to
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
    // A drive root already ends in a separator: C:\\ must not become C:\\\\.
    return r.endsWith(pm.sep) ? target.startsWith(r) : target.startsWith(`${r}${pm.sep}`);
  });
}

export function assertAllowed(p: string, extraRoots: string[] = []): string {
  const host = detectHost();
  const pm = host === "windows" ? win32 : posix;
  const abs = pm.resolve(normalizeUserPath(p, host));
  if (!isPathAllowed(abs, extraRoots, host)) {
    throw forbiddenPath(`path outside the allowed roots: ${abs}`);
  }
  return abs;
}

export interface DirEntry {
  name: string;
  type: "dir" | "file";
  path: string;
  size?: number;
  mtime?: string;
  media?: boolean;
}

export interface DirListing {
  path: string;
  windowsPath: string | null;
  /** What the picker shows: the Windows form, or the path with home as `~`. */
  displayPath: string;
  parent: string | null;
  entries: DirEntry[];
}

/** `/home/you/Videos` -> `~/Videos`: shorter, and keeps usernames out of screenshots. */
export function tildify(p: string, home = homedir()): string {
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

export function toWindowsDisplayPath(p: string, host: Host = detectHost()): string | null {
  if (host === "windows") return p;
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p);
  if (!m) return null;
  const drive = (m[1] as string).toUpperCase();
  const rest = (m[2] ?? "").replace(/\//g, "\\");
  return `${drive}:${rest === "" ? "\\" : rest}`;
}

export function listDirectory(
  target: string,
  opts: { showHidden?: boolean; dirsOnly?: boolean; extraRoots?: string[] } = {},
): DirListing {
  const abs = assertAllowed(target, opts.extraRoots ?? []);
  if (!existsSync(abs)) throw notFound(`directory not found: ${abs}`);
  if (!statSync(abs).isDirectory()) throw notFound(`not a directory: ${abs}`);

  const entries: DirEntry[] = [];
  for (const name of readdirSync(abs)) {
    if (!opts.showHidden && name.startsWith(".")) continue;
    const full = join(abs, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // permission denied or a broken symlink: skip, never throw
    }
    if (stat.isDirectory()) {
      entries.push({ name, type: "dir", path: full });
    } else if (!opts.dirsOnly && stat.isFile()) {
      entries.push({
        name,
        type: "file",
        path: full,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        media: isMediaPath(name),
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  // dirname() of a filesystem root returns the root itself, on both "/" and "C:\\".
  const parentDir = dirname(abs);
  const parent = parentDir === abs ? null : parentDir;
  const windowsPath = toWindowsDisplayPath(abs);
  return {
    path: abs,
    windowsPath,
    displayPath: windowsPath ?? tildify(abs),
    parent: parent && isPathAllowed(parent, opts.extraRoots ?? []) ? parent : null,
    entries,
  };
}

export interface Favorite {
  label: string;
  path: string;
}

/**
 * Where the file browser opens before the user picks anything.
 * `browseRoot` comes from WG_BROWSE_ROOT or wg.config.json; without it the
 * Windows Videos folder is used, because screen recorders write there.
 */
export function defaultBrowsePath(browseRoot = ""): string | null {
  if (browseRoot.trim() !== "") {
    const configured = resolve(toWslPath(browseRoot));
    if (existsSync(configured)) return configured;
  }
  const winHome = windowsUserDir();
  if (winHome) return userMediaDir(winHome, "windows") ?? winHome;
  // Plain Linux or macOS: the local media folder, else the home directory.
  return userMediaDir(homedir()) ?? homedir();
}

/** Windows profile discovered at runtime; never hardcode a username. */
export function windowsUserDir(host: Host = detectHost()): string | null {
  if (host === "windows") return homedir();
  const root = "/mnt/c/Users";
  if (!existsSync(root)) return null;
  try {
    const user = pickWindowsUser(readdirSync(root), (name) =>
      existsSync(join(root, name, "Documents")) || existsSync(join(root, name, "Videos")),
    );
    return user ? join(root, user) : null;
  } catch {
    return null;
  }
}

export function favorites(outputRoot: string, browseRoot = ""): Favorite[] {
  const list: Favorite[] = [];
  if (browseRoot.trim() !== "") {
    list.push({ label: "Recordings", path: resolve(toWslPath(browseRoot)) });
  }
  const winHome = windowsUserDir();
  if (winHome) {
    // Videos first: screen recorders write there and it is not redirected.
    // Documents and Desktop follow the OneDrive redirect when present.
    list.push(
      { label: "Videos", path: join(winHome, "Videos") },
      { label: "Downloads", path: join(winHome, "Downloads") },
      { label: "Documents", path: windowsSpecialFolder(winHome, "Documents") },
      { label: "Desktop", path: windowsSpecialFolder(winHome, "Desktop") },
    );
  }
  if (detectHost() === "wsl") {
    list.push({ label: "WSL home", path: homedir() });
  } else if (!winHome) {
    // No Windows mounts: offer the standard local folders instead.
    const media = userMediaDir(homedir());
    if (media) list.push({ label: basename(media), path: media });
    for (const name of ["Downloads", "Documents", "Desktop"]) {
      list.push({ label: name, path: join(homedir(), name) });
    }
    list.push({ label: "Home", path: homedir() });
  }
  if (detectHost() === "windows") list.push({ label: "Home", path: homedir() });
  const out = resolve(toWslPath(outputRoot));
  list.push({ label: "Transcripts", path: out });
  const seen = new Set<string>();
  return list.filter((f) => {
    if (seen.has(f.path) || !existsSync(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

export interface ResolvedPath {
  path: string;
  exists: boolean;
  media: boolean;
  size: number | null;
  isDirectory: boolean;
  windowsPath: string | null;
}

export function resolveUserPath(input: string, extraRoots: string[] = []): ResolvedPath {
  const abs = assertAllowed(input, extraRoots);
  const exists = existsSync(abs);
  const stat = exists ? statSync(abs) : null;
  return {
    path: abs,
    exists,
    media: isMediaPath(abs),
    size: stat?.isFile() ? stat.size : null,
    isDirectory: stat?.isDirectory() ?? false,
    windowsPath: toWindowsDisplayPath(abs),
  };
}

/** Windows path limit is 260; leave room for the longest extension suffix. */
export const MAX_WINDOWS_PATH = 240;

export interface OutputTarget {
  dir: string;
  stem: string;
  /** True when the stem or path had to be altered for NTFS. */
  adjusted: boolean;
  originalStem: string;
  collision: boolean;
}

/**
 * Compute the output directory for an input file, applying NTFS rules when the
 * destination lives on a Windows drive. Does not create anything.
 */
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

  return {
    dir,
    stem,
    adjusted: stem !== originalStem,
    originalStem,
    collision: hasExistingTranscript(dir),
  };
}

/** NTFS is case-insensitive, so the collision check must be too. */
export function hasExistingTranscript(dir: string): boolean {
  if (!existsSync(dir)) {
    const parent = dirname(dir);
    if (!existsSync(parent)) return false;
    const wanted = basename(dir).toLowerCase();
    try {
      const match = readdirSync(parent).find((n) => n.toLowerCase() === wanted);
      if (!match) return false;
      return existsSync(join(parent, match, "meeting.json"));
    } catch {
      return false;
    }
  }
  return existsSync(join(dir, "meeting.json"));
}

/** `<stem>-2`, `<stem>-3`, ... first name that does not already exist. */
export function nextFreeDir(dir: string): string {
  if (!hasExistingTranscript(dir) && !existsSync(dir)) return dir;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${dir}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${dir}-${Date.now()}`;
}
