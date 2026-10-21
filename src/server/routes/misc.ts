import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt, PROMPT_TOKEN_BUDGET } from "../../prompt.ts";
import { gpuInfo, runDoctor } from "../../doctor.ts";
import { CONFIG_FILENAME, DEFAULT_CONFIG } from "../../config.ts";
import { toWslPath } from "../../platform.ts";
import type { Config, ExecutionPlan } from "../../types.ts";
import { diskReport } from "../disk.ts";
import { badRequest } from "../errors.ts";
import { defaultBrowsePath, favorites, listDirectory, resolveUserPath } from "../fsService.ts";
import { probeMedia } from "../probe.ts";
import { assertNoUnknownKeys, type Ctx, type Router } from "../router.ts";

export interface AppState {
  config: Config;
  plan: ExecutionPlan;
  projectDir: string;
}

export function registerMiscRoutes(router: Router, state: AppState): void {
  router.get("/api/health", () => ({ ok: true, version: 1 }));

  router.get("/api/fs", (ctx: Ctx) => {
    const path = ctx.url.searchParams.get("path") ?? "";
    const dirsOnly = ctx.url.searchParams.get("dirsOnly") === "true";
    const showHidden = ctx.url.searchParams.get("showHidden") === "true";
    if (path === "") {
      return {
        favorites: favorites(state.config.outputRoot, state.config.browseRoot),
        defaultPath: defaultBrowsePath(state.config.browseRoot),
      };
    }
    return listDirectory(path, {
      dirsOnly,
      showHidden,
      extraRoots: [state.config.outputRoot, state.projectDir],
    });
  });

  router.get("/api/fs/favorites", () => ({
    favorites: favorites(state.config.outputRoot, state.config.browseRoot),
    defaultPath: defaultBrowsePath(state.config.browseRoot),
  }));

  router.post("/api/fs/resolve", (ctx: Ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    assertNoUnknownKeys(body, ["path"]);
    if (typeof body.path !== "string" || body.path.trim() === "") {
      throw badRequest("`path` is required");
    }
    return resolveUserPath(body.path);
  });

  router.get("/api/probe", async (ctx: Ctx) => {
    const path = ctx.url.searchParams.get("path");
    if (!path) throw badRequest("`path` query parameter is required");
    return probeMedia(toWslPath(path), state.config.ffmpegPath.replace(/ffmpeg$/, "ffprobe"));
  });

  router.post("/api/prompt", (ctx: Ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    assertNoUnknownKeys(body, ["context", "attendees", "terms"]);
    const result = buildPrompt({
      context: typeof body.context === "string" ? body.context : "",
      attendees: Array.isArray(body.attendees) ? (body.attendees as string[]) : [],
      terms: Array.isArray(body.terms) ? (body.terms as string[]) : [],
    });
    return { ...result, budget: PROMPT_TOKEN_BUDGET };
  });

  router.get("/api/config", () => ({
    config: state.config,
    defaults: DEFAULT_CONFIG,
  }));

  router.put("/api/config", (ctx: Ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    assertNoUnknownKeys(body, Object.keys(DEFAULT_CONFIG));
    const merged: Config = { ...state.config, ...(body as Partial<Config>) };
    if (typeof merged.outputRoot === "string") merged.outputRoot = toWslPath(merged.outputRoot);
    const target = join(state.projectDir, CONFIG_FILENAME);
    writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    Object.assign(state.config, merged);
    return { config: state.config, source: target };
  });

  router.get("/api/doctor", () => ({ checks: runDoctor(state.config, state.plan) }));

  // The GPU does not change while the server runs, so ask the driver once.
  let gpu: ReturnType<typeof gpuInfo> | undefined;
  router.get("/api/gpu", () => {
    if (gpu === undefined) gpu = gpuInfo(state.plan);
    return { gpu };
  });

  router.get("/api/disk", () => diskReport(state.config.outputRoot));
}
