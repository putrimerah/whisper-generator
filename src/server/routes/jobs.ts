import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildPrompt } from "../../prompt.ts";
import { isOnWindowsMount, toWslPath } from "../../platform.ts";
import type { Device, RunOptions } from "../../types.ts";
import { badRequest, notFound } from "../errors.ts";
import { assertAllowed, isMediaPath, nextFreeDir, planOutputTarget } from "../fsService.ts";
import type { JobStore } from "../jobStore.ts";
import { TERMINAL_STATES } from "../jobTypes.ts";
import { probeMedia } from "../probe.ts";
import { assertNoUnknownKeys, type Ctx, type Router } from "../router.ts";
import { shouldExtract, type JobRunner } from "../runner.ts";
import { openSse } from "../sse.ts";
import type { AppState } from "./misc.ts";

const ALLOWED_FIELDS = [
  "input",
  "outDir",
  "attendees",
  "terms",
  "context",
  "model",
  "language",
  "computeType",
  "device",
  "outputFormats",
  "wordTimestamps",
  "keepAudio",
  "diarize",
  "speakerCount",
  "onCollision",
];

function strArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw badRequest(`\`${field}\` must be an array of strings`);
  }
  return value as string[];
}

export function registerJobRoutes(
  router: Router,
  state: AppState,
  store: JobStore,
  runner: JobRunner,
): void {
  router.get("/api/jobs", () => ({ jobs: store.list() }));

  router.get("/api/jobs/:id", (ctx: Ctx) => {
    const job = store.get(ctx.params.id as string);
    if (!job) throw notFound(`job ${ctx.params.id} not found`);
    return job;
  });

  router.post("/api/jobs", async (ctx: Ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    assertNoUnknownKeys(body, ALLOWED_FIELDS);

    if (typeof body.input !== "string" || body.input.trim() === "") {
      throw badRequest("`input` is required");
    }
    const input = assertAllowed(body.input, [state.config.outputRoot, state.projectDir]);
    if (!existsSync(input) || !statSync(input).isFile()) {
      throw badRequest(`input is not a file: ${input}`);
    }
    if (!isMediaPath(input)) throw badRequest(`not a media file: ${input}`);

    // Output directory: user-supplied or derived, always NTFS-safe.
    const target = planOutputTarget(input, state.config.outputRoot);
    let outDir =
      typeof body.outDir === "string" && body.outDir.trim() !== ""
        ? resolve(toWslPath(body.outDir))
        : target.dir;
    assertAllowed(outDir, [state.config.outputRoot, state.projectDir]);

    const onCollision = typeof body.onCollision === "string" ? body.onCollision : "new-folder";
    if (target.collision && outDir === target.dir && onCollision === "new-folder") {
      outDir = nextFreeDir(target.dir);
    }

    const probe = await probeMedia(
      input,
      state.config.ffmpegPath.replace(/ffmpeg$/, "ffprobe"),
    );

    const attendees = [...state.config.attendees, ...strArray(body.attendees, "attendees")];
    const terms = [...state.config.terms, ...strArray(body.terms, "terms")];
    const context = typeof body.context === "string" ? body.context : state.config.context;
    const prompt = buildPrompt({ context, attendees, terms });

    const options: RunOptions = {
      input,
      outDir,
      attendees,
      terms,
      context,
      model: typeof body.model === "string" ? body.model : state.config.model,
      language: typeof body.language === "string" ? body.language : state.config.language,
      device: (typeof body.device === "string" ? body.device : state.config.device) as Device,
      computeType: (typeof body.computeType === "string"
        ? body.computeType
        : state.config.computeType) as RunOptions["computeType"],
      outputFormats:
        strArray(body.outputFormats, "outputFormats").length > 0
          ? strArray(body.outputFormats, "outputFormats")
          : state.config.outputFormats,
      extractAudio: shouldExtract(input),
      wordTimestamps:
        typeof body.wordTimestamps === "boolean"
          ? body.wordTimestamps
          : state.config.wordTimestamps,
      diarize: body.diarize === true && state.config.hfToken !== "",
      speakerCount:
        typeof body.speakerCount === "number" ? body.speakerCount : state.config.speakerCount,
    };

    const job = store.create({
      input,
      outDir,
      options,
      keepAudio: typeof body.keepAudio === "boolean" ? body.keepAudio : state.config.keepAudio,
      diarize: body.diarize === true && state.config.hfToken !== "",
      prompt: {
        text: prompt.prompt,
        tokens: prompt.tokens,
        truncated: prompt.truncated,
        dropped: prompt.dropped,
      },
      probe: { durationSeconds: probe.durationSeconds, sizeBytes: probe.sizeBytes },
    });

    void runner.enqueue(job.id);
    ctx.res.statusCode = 201;
    return job;
  });

  router.delete("/api/jobs/:id", (ctx: Ctx) => {
    const id = ctx.params.id as string;
    const job = store.get(id);
    if (!job) throw notFound(`job ${id} not found`);
    if (TERMINAL_STATES.has(job.state)) {
      store.remove(id);
      return { removed: true };
    }
    runner.cancel(id);
    return { cancelled: true };
  });

  router.post("/api/jobs/:id/retry", (ctx: Ctx) => {
    const previous = store.get(ctx.params.id as string);
    if (!previous) throw notFound(`job ${ctx.params.id} not found`);
    const job = store.create({
      input: previous.input,
      outDir: previous.outDir,
      options: previous.options,
      keepAudio: previous.keepAudio,
      diarize: previous.diarize,
      prompt: previous.prompt,
      probe: previous.probe,
    });
    void runner.enqueue(job.id);
    ctx.res.statusCode = 201;
    return job;
  });

  // SSE lives outside the JSON pipeline: it writes to the socket directly.
  router.get("/api/jobs/:id/stream", (ctx: Ctx) => {
    const id = ctx.params.id as string;
    const job = store.get(id);
    if (!job) throw notFound(`job ${id} not found`);

    const sse = openSse(ctx.res);
    // Replay current state first so a reconnecting client is never blind.
    sse.send("state", { state: job.state, at: job.updatedAt });
    if (job.progress) sse.send("progress", job.progress);

    const unsubscribe = runner.subscribe((event) => {
      if (event.jobId !== id) return;
      sse.send(event.type, event.data);
      if (event.type === "done" || event.type === "error") {
        unsubscribe();
        sse.close();
      }
    });

    ctx.res.on("close", unsubscribe);
    return undefined; // response already owned by the SSE connection
  });

  router.get("/api/jobs/:id/warnings", (ctx: Ctx) => {
    const job = store.get(ctx.params.id as string);
    if (!job) throw notFound("job not found");
    const warnings: string[] = [];
    if (job.keepAudio && isOnWindowsMount(job.outDir)) {
      warnings.push("Keeping audio writes ~115 MB/hour to a Windows drive.");
    }
    if (job.prompt.truncated) {
      warnings.push(`Prompt over budget; dropped: ${job.prompt.dropped.join(", ")}`);
    }
    return { warnings };
  });
}
