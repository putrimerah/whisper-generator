import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectHost } from "./platform.ts";
import { wrapForInterop } from "./shell.ts";
import type { Command, ExecutionPlan, Host } from "./types.ts";

/**
 * pip ships cuBLAS/cuDNN inside site-packages/nvidia/<pkg>/lib, which the
 * dynamic loader does not search. CTranslate2 then dies with
 * "Library libcublas.so.12 is not found". Resolve those directories from the
 * venv that owns the CLI and prepend them to LD_LIBRARY_PATH on POSIX or
 * PATH on Windows, where CTranslate2 loads the DLLs by name.
 */
export function cudaLibraryPath(whisperPath: string, host: Host = detectHost()): string[] {
  if (host === "windows") {
    if (!whisperPath.includes("/") && !whisperPath.includes("\\")) return [];
    const nvidia = join(dirname(dirname(whisperPath)), "Lib", "site-packages", "nvidia");
    if (!existsSync(nvidia)) return [];
    return readdirSync(nvidia).map((pkg) => join(nvidia, pkg, "bin")).filter(existsSync);
  }
  if (!whisperPath.includes("/")) return [];
  const venvRoot = dirname(dirname(whisperPath));
  const libRoot = join(venvRoot, "lib");
  if (!existsSync(libRoot)) return [];
  const dirs: string[] = [];
  for (const pyDir of readdirSync(libRoot)) {
    const nvidia = join(libRoot, pyDir, "site-packages", "nvidia");
    if (!existsSync(nvidia)) continue;
    for (const pkg of readdirSync(nvidia)) {
      const lib = join(nvidia, pkg, "lib");
      if (existsSync(lib)) dirs.push(lib);
    }
  }
  return dirs;
}

export function buildEnv(whisperPath: string, host: Host = detectHost()): NodeJS.ProcessEnv {
  if (host === "windows") {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    const dirs = cudaLibraryPath(whisperPath, host);
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
    if (dirs.length > 0) env[pathKey] = [...dirs, env[pathKey] ?? ""].join(";");
    return env;
  }
  const dirs = cudaLibraryPath(whisperPath, host);
  if (dirs.length === 0) return process.env;
  const existing = process.env.LD_LIBRARY_PATH;
  return {
    ...process.env,
    LD_LIBRARY_PATH: existing ? `${dirs.join(":")}:${existing}` : dirs.join(":"),
  };
}

export class CommandError extends Error {
  readonly command: Command;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(command: Command, code: number | null, signal: NodeJS.Signals | null) {
    super(
      signal
        ? `${command.bin} killed by ${signal}`
        : `${command.bin} exited with code ${code}`,
    );
    this.name = "CommandError";
    this.command = command;
    this.code = code;
    this.signal = signal;
  }
}

/** Run a command with inherited stdio so ffmpeg/Whisper progress stays live. */
export function runCommand(cmd: Command, plan: ExecutionPlan, env?: NodeJS.ProcessEnv): Promise<void> {
  const final = wrapForInterop(cmd, plan);
  // A .cmd/.bat wrapper cannot be executed directly by CreateProcess.
  const needsShell = /\.(cmd|bat)$/i.test(final.bin);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(final.bin, final.args, { stdio: "inherit", shell: needsShell, env });
    child.on("error", (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `: not found on PATH. Install it, or set the path in wg.config.json`
          : "";
      rejectPromise(new Error(`${final.bin}${hint} (${err.message})`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new CommandError(cmd, code, signal));
    });
  });
}

export async function runAll(
  commands: Command[],
  plan: ExecutionPlan,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  for (const cmd of commands) {
    process.stderr.write(`\n▶ ${cmd.label}\n`);
    await runCommand(cmd, plan, env);
  }
}
