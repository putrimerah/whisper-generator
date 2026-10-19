import type { ServerResponse } from "node:http";

const KEEPALIVE_MS = 15_000;

export interface SseConnection {
  send(event: string, data: unknown): void;
  close(): void;
}

/** Server-Sent Events: one-way, auto-reconnecting, no WebSocket needed. */
export function openSse(res: ServerResponse): SseConnection {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const timer = setInterval(() => {
    res.write(": keepalive\n\n");
  }, KEEPALIVE_MS);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    res.end();
  };

  res.on("close", close);

  return {
    send(event: string, data: unknown) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close,
  };
}
