import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  isOnWindowsMount,
  pickWindowsUser,
  sanitizeForWindows,
  toWslPath,
  userMediaDir,
  windowsSpecialFolder,
} from "../platform.ts";
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
 * Only Windows mounts, the user's home and explicit output roots are
 * reachable. Everything else, including /etc and /proc, is refused.
 */
export function isPathAllowed(p: string, extraRoots: string[] = []): boolean {
  if (!p.startsWith("/")) return false;
  const abs = resolve(p);
  if (abs.includes("\0")) return false;
  const roots = [
    "/mnt",
    homedir(),
    ...extraRoots.filter((r) => r !== "").map((r) => resolve(toWslPath(r))),
  ];
  return roots.some((root) => abs === root || abs.startsWith(`${root}/`));
}

export function assertAllowed(p: string, extraRoots: string[] = []): string {
  const abs = resolve(toWslPath(p));
  if (!isPathAllowed(abs, extraRoots)) {
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
  parent: string | null;
  entries: DirEntry[];
}

export function toWindowsDisplayPath(p: string): string | null {
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

  const parent = abs === "/" ? null : dirname(abs);
  return {
    path: abs,
    windowsPath: toWindowsDisplayPath(abs),
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
export function windowsUserDir(): string | null {
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
  if (winHome) {
    list.push({ label: "WSL home", path: homedir() });
  } else {
    // No Windows mounts: offer the standard local folders instead.
    const media = userMediaDir(homedir());
    if (media) list.push({ label: basename(media), path: media });
    for (const name of ["Downloads", "Documents", "Desktop"]) {
      list.push({ label: name, path: join(homedir(), name) });
    }
    list.push({ label: "Home", path: homedir() });
  }
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

export function resolveUserPath(input: string): ResolvedPath {
  const abs = assertAllowed(input);
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
export function planOutputTarget(inputPath: string, outputRoot: string): OutputTarget {
  const root = resolve(toWslPath(outputRoot));
  const originalStem = basename(inputPath, extname(inputPath));
  const onWindows = isOnWindowsMount(root);
  let stem = onWindows ? sanitizeForWindows(originalStem) : originalStem;

  let dir = join(root, stem);
  if (onWindows && dir.length > MAX_WINDOWS_PATH) {
    const overflow = dir.length - MAX_WINDOWS_PATH;
    stem = stem.slice(0, Math.max(8, stem.length - overflow));
    dir = join(root, stem);
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
