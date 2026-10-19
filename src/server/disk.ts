import { statfs } from "node:fs/promises";
import { isOnWindowsMount } from "../platform.ts";
import { diskFull } from "./errors.ts";
import { WAV_BYTES_PER_SECOND } from "./probe.ts";

/** Refuse to start a job that would leave less than this free. */
export const SAFETY_MARGIN_BYTES = 500_000_000;
/** Below this, the UI shows a persistent warning. */
export const LOW_SPACE_WARNING_BYTES = 5_000_000_000;

/**
 * `df` inside WSL reports the virtual 1 TB size of ext4.vhdx, which is a lie.
 * Writes to the WSL filesystem actually grow that vhdx on C:, and writes to
 * /mnt/<drive> consume that drive. Either way the honest number comes from
 * statfs on a Windows mount.
 */
export async function freeBytesFor(targetPath: string): Promise<number> {
  const probePath = isOnWindowsMount(targetPath)
    ? targetPath.split("/").slice(0, 3).join("/")
    : "/mnt/c";
  try {
    const { bavail, bsize } = await statfs(probePath);
    return Number(bavail) * Number(bsize);
  } catch {
    // Not on WSL, or the mount vanished: fall back to the target itself.
    const { bavail, bsize } = await statfs(targetPath);
    return Number(bavail) * Number(bsize);
  }
}

export function estimateNeeded(durationSeconds: number, extractAudio: boolean): number {
  const wav = extractAudio ? durationSeconds * WAV_BYTES_PER_SECOND : 0;
  return Math.round(wav + SAFETY_MARGIN_BYTES);
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${n} B`;
}

/** Checks both destinations and uses the smaller figure. */
export async function assertSpace(
  workDir: string,
  outDir: string,
  neededBytes: number,
): Promise<number> {
  const [workFree, outFree] = await Promise.all([freeBytesFor(workDir), freeBytesFor(outDir)]);
  const free = Math.min(workFree, outFree);
  if (neededBytes >= free) {
    throw diskFull(
      `not enough disk space: need ${formatBytes(neededBytes)}, only ${formatBytes(free)} free`,
    );
  }
  return free;
}

export async function diskReport(outputRoot: string): Promise<{
  windowsFreeBytes: number;
  outputFreeBytes: number;
  warning: string | null;
}> {
  const [windowsFreeBytes, outputFreeBytes] = await Promise.all([
    freeBytesFor("/mnt/c"),
    freeBytesFor(outputRoot),
  ]);
  const lowest = Math.min(windowsFreeBytes, outputFreeBytes);
  return {
    windowsFreeBytes,
    outputFreeBytes,
    warning:
      lowest < LOW_SPACE_WARNING_BYTES
        ? `Only ${formatBytes(lowest)} free. Transcription may fail. ` +
          `Reclaim WSL space with: wsl --shutdown, then wsl --manage <distro> --set-sparse true`
        : null,
  };
}
