import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { detectHost, resolvePlan } from "../platform.ts";
import type { Config, ExecutionPlan } from "../types.ts";
import { ApiError } from "./errors.ts";
import { JobStore } from "./jobStore.ts";
import { JobRunner } from "./runner.ts";
import { readJsonBody, Router, sendError, sendJson, type Ctx } from "./router.ts";
import { registerJobRoutes } from "./routes/jobs.ts";
import { registerMeetingRoutes } from "./routes/meetings.ts";
import { registerMiscRoutes, type AppState } from "./routes/misc.ts";

export const DEFAULT_PORT = 7788;

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function webRoot(): string {
  // dist/server/server.js -> repo root/web/dist
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(here, "..", "..", "web", "dist"),
    join(here, "..", "..", "..", "web", "dist"),
    join(process.cwd(), "web", "dist"),
  ];
  return candidates.find((c) => existsSync(join(c, "index.html"))) ?? candidates[0] ?? "";
}

function serveStatic(res: ServerResponse, pathname: string): boolean {
  const root = webRoot();
  if (root === "" || !existsSync(join(root, "index.html"))) return false;

  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
  const file = rel === "" ? join(root, "index.html") : join(root, rel);
  const target = existsSync(file) && statSync(file).isFile() ? file : join(root, "index.html");

  const body = readFileSync(target);
  const isIndex = target.endsWith("index.html");
  res.writeHead(200, {
    "content-type": STATIC_MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": isIndex ? "no-store" : "public, max-age=3600",
  });
  res.end(body);
  return true;
}

export interface UiServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startServer(options: { port?: number; cwd?: string } = {}): Promise<UiServer> {
  const port = options.port ?? DEFAULT_PORT;
  const cwd = options.cwd ?? process.cwd();
  const { config } = loadConfig(cwd);
  const plan: ExecutionPlan = resolvePlan(config.engine, detectHost());

  const state: AppState = { config: config as Config, plan, projectDir: cwd };
  const store = new JobStore();
  store.load();
  const runner = new JobRunner(store, state.config, plan);

  const router = new Router();
  registerMiscRoutes(router, state);
  registerJobRoutes(router, state, store, runner);
  registerMeetingRoutes(router, state);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      try {
        const match = router.match(req.method ?? "GET", url.pathname);
        if (!match) {
          if (!url.pathname.startsWith("/api/") && serveStatic(res, url.pathname)) return;
          throw new ApiError("NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
        }
        const body =
          req.method === "POST" || req.method === "PUT" ? await readJsonBody(req) : undefined;
        const ctx: Ctx = { req, res, url, params: match.params, body };
        const result = await match.handler(ctx);
        // Handlers that wrote the response themselves return undefined.
        if (result === undefined || res.writableEnded || res.headersSent) return;
        sendJson(res, res.statusCode === 200 ? 200 : res.statusCode, result);
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        sendError(res, err);
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        rejectListen(
          new Error(`port ${port} is already in use. Stop the other process or pass --port`),
        );
      } else rejectListen(err);
    });
    // Loopback only: never expose transcripts to the network.
    server.listen(port, "127.0.0.1", () => resolveListen());
  });

  const close = async (): Promise<void> => {
    for (const job of store.list()) {
      if (job.state !== "done" && job.state !== "failed" && job.state !== "cancelled") {
        runner.cancel(job.id);
      }
    }
    store.persist();
    await new Promise<void>((done) => server.close(() => done()));
  };

  return { port, url: `http://localhost:${port}`, close };
}
