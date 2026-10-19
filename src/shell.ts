import type { Command, ExecutionPlan } from "./types.ts";

/**
 * PowerShell single-quoted literal: only `'` needs escaping, and it doubles.
 * Backticks, `$`, and backslashes are literal inside single quotes, which is
 * exactly why prompts full of quotes and paths full of backslashes survive.
 */
export function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quotePosix(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quoteFor(shell: ExecutionPlan["shell"], value: string): string {
  return shell === "powershell" ? quotePowerShell(value) : quotePosix(value);
}

/** Render one command as a pasteable line for the target shell. */
export function renderCommand(cmd: Command, plan: ExecutionPlan): string {
  const quote = (v: string) => quoteFor(plan.shell, v);
  const parts = [cmd.bin, ...cmd.args].map(quote);
  if (plan.shell === "powershell") {
    // `&` call operator keeps quoted binaries with spaces working.
    return `& ${parts.join(" ")}`;
  }
  return parts.join(" ");
}

/** Line that creates the output directory in the target shell's dialect. */
export function mkdirLine(dir: string, plan: ExecutionPlan): string {
  return plan.shell === "powershell"
    ? `New-Item -ItemType Directory -Force -Path ${quotePowerShell(dir)} | Out-Null`
    : `mkdir -p ${quotePosix(dir)}`;
}

/** Full copy-paste script, including comments, for the "paste into PowerShell" flow. */
export function renderScript(
  commands: Command[],
  plan: ExecutionPlan,
  header?: string,
  prelude: string[] = [],
): string {
  const comment = "#";
  const lines: string[] = [];
  if (header) lines.push(`${comment} ${header}`);
  if (plan.shell === "powershell") lines.push("$ErrorActionPreference = 'Stop'");
  else lines.push("set -euo pipefail");
  lines.push(...prelude);
  for (const cmd of commands) {
    lines.push("", `${comment} ${cmd.label}`, renderCommand(cmd, plan));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Wrap a native command so WSL can run it against Windows-side Python/CUDA.
 * The inner command is rendered with PowerShell quoting, then the whole string
 * is passed as a single argv entry, so bash never re-splits it.
 */
export function wrapForInterop(cmd: Command, plan: ExecutionPlan): Command {
  if (!plan.viaInterop) return cmd;
  const inner = renderCommand(cmd, plan);
  return {
    label: cmd.label,
    bin: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", inner],
  };
}
