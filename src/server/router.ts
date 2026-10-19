import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError } from "./errors.ts";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export const MAX_BODY_BYTES = 1_000_000;

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method,
      segments: pattern.split("/").filter((s) => s !== ""),
      handler,
    });
    return this;
  }

  get = (p: string, h: Handler) => this.add("GET", p, h);
  post = (p: string, h: Handler) => this.add("POST", p, h);
  put = (p: string, h: Handler) => this.add("PUT", p, h);
  delete = (p: string, h: Handler) => this.add("DELETE", p, h);

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter((s) => s !== "");
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const seg = route.segments[i] as string;
        const part = parts[i] as string;
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(part);
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new ApiError("BAD_REQUEST", "request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("BAD_REQUEST", "request body is not valid JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof ApiError) {
    sendJson(res, err.status, err.toJSON());
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: "INTERNAL", message, detail: null } });
}

/** Reject unknown keys so a typo in a client payload is loud, not silent. */
export function assertNoUnknownKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ApiError("BAD_REQUEST", `unknown field(s): ${unknown.join(", ")}`);
  }
}
