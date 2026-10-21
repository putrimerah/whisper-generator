import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { buildEnv, cudaLibraryPath } from "./exec.ts";
import { describePlan } from "./platform.ts";
import { wrapForInterop } from "./shell.ts";
import type { Config, ExecutionPlan } from "./types.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

function probe(
  bin: string,
  args: string[],
  plan: ExecutionPlan,
  env?: NodeJS.ProcessEnv,
): { ok: boolean; out: string } {
  const cmd = wrapForInterop({ label: "probe", bin, args }, plan);
  const res = spawnSync(cmd.bin, cmd.args, { encoding: "utf8", timeout: 120_000, env });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return { ok: res.status === 0, out };
}

/** CTranslate2 reports CUDA support without pulling in torch. */
const CT2_PROBE = [
  "import ctranslate2 as c",
  "print(c.__version__, c.get_cuda_device_count())",
].join("; ");

/** Approximate VRAM at int8_float16, the default quantization. */
const MODEL_VRAM_GB: Record<string, number> = {
  tiny: 0.5,
  base: 0.7,
  small: 1,
  medium: 2,
  "large-v1": 3.5,
  "large-v2": 3.5,
  "large-v3": 3.5,
  large: 3.5,
  turbo: 2.5,
};

/** VRAM read from the driver, so no deep-learning runtime is required. */
export function gpuInfo(plan: ExecutionPlan): { name: string; vramGb: number } | null {
  const res = probe("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], plan);
  if (!res.ok) return null;
  const [name, mib] = (res.out.split("\n")[0] ?? "").split(",").map((s) => s.trim());
  if (!name || !mib) return null;
  return { name, vramGb: Math.round((Number(mib) / 1024) * 10) / 10 };
}

export function runDoctor(cfg: Config, plan: ExecutionPlan): Check[] {
  const checks: Check[] = [];

  checks.push({
    name: "host/engine",
    ok: true,
    detail: describePlan(plan),
  });

  const ff = probe(cfg.ffmpegPath, ["-version"], plan);
  checks.push({
    name: "ffmpeg",
    ok: ff.ok,
    detail: ff.ok ? (ff.out.split("\n")[0] ?? "ok") : "not found",
    fix: ff.ok ? undefined : "bash scripts/install-wsl.sh",
  });

  const wh = probe(cfg.whisperPath, ["--help"], plan);
  checks.push({
    name: "whisper",
    ok: wh.ok,
    detail: wh.ok ? cfg.whisperPath : `not runnable: ${cfg.whisperPath}`,
    fix: wh.ok ? undefined : "bash scripts/install-wsl.sh, then set whisperPath in wg.config.json",
  });

  // Reuse the venv that owns the whisper launcher, so torch is probed in the
  // same interpreter Whisper will actually import.
  const pythonPath = cfg.whisperPath.includes("/") || cfg.whisperPath.includes("\\")
    ? join(dirname(cfg.whisperPath), "python")
    : "python3";
  const env = buildEnv(cfg.whisperPath);
  const ct2 = probe(pythonPath, ["-c", CT2_PROBE], plan, env);
  const gpu = gpuInfo(plan);

  // The failure mode that produced "Library libcublas.so.12 is not found":
  // pip puts the libs in site-packages/nvidia/*/lib, off the loader's path.
  const libDirs = cudaLibraryPath(cfg.whisperPath);
  const hasCublas = libDirs.some((d) => d.includes("cublas"));
  const hasCudnn = libDirs.some((d) => d.includes("cudnn"));
  checks.push({
    name: "cuda libs",
    ok: hasCublas && hasCudnn,
    detail: hasCublas && hasCudnn
      ? `cuBLAS + cuDNN found, LD_LIBRARY_PATH injected by wg`
      : `missing: ${[!hasCublas && "cuBLAS", !hasCudnn && "cuDNN"].filter(Boolean).join(", ")}`,
    fix: hasCublas && hasCudnn
      ? undefined
      : `${dirname(cfg.whisperPath)}/pip install nvidia-cublas-cu12 'nvidia-cudnn-cu12>=9,<10'`,
  });

  if (ct2.ok) {
    const [version, deviceCount] = ct2.out.split(/\s+/);
    const hasCuda = Number(deviceCount ?? 0) > 0;
    checks.push({
      name: "ctranslate2",
      ok: hasCuda,
      detail: hasCuda
        ? `v${version}, ${deviceCount} CUDA device(s)`
        : `v${version}, CPU only (roughly 10x slower)`,
      fix: hasCuda ? undefined : "check the NVIDIA driver on Windows; WSL inherits it",
    });
  } else {
    checks.push({
      name: "ctranslate2",
      ok: false,
      detail: "not importable",
      fix: "bash scripts/install-wsl.sh",
    });
  }

  if (gpu) {
    const need = MODEL_VRAM_GB[cfg.model];
    const fits = need === undefined || need <= gpu.vramGb - 0.5;
    checks.push({
      name: "model fit",
      ok: fits,
      detail: need === undefined
        ? `${gpu.name}, ${gpu.vramGb} GB; ${cfg.model}: unknown VRAM need`
        : `${cfg.model} @ ${cfg.computeType} needs ~${need} GB, ${gpu.name} has ${gpu.vramGb} GB`,
      fix: fits ? undefined : `use --model medium, or --compute-type int8`,
    });
  }

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) => {
    const mark = c.ok ? "✔" : "✘";
    const fix = c.fix ? `\n    fix: ${c.fix}` : "";
    return `${mark} ${c.name.padEnd(11)} ${c.detail}${fix}`;
  });
  return `${lines.join("\n")}\n`;
}
