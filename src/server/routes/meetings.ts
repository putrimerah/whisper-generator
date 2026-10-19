import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { toWslPath } from "../../platform.ts";
import { MEETING_FILENAME } from "../../meeting.ts";
import type { MeetingRecord } from "../../types.ts";
import { badRequest, notFound } from "../errors.ts";
import { assertAllowed } from "../fsService.ts";
import { buildAiMarkdown, buildCombinedMarkdown, estimateTokens } from "../aiExport.ts";
import { createZip } from "../zip.ts";
import { assertNoUnknownKeys, type Ctx, type Router } from "../router.ts";
import type { AppState } from "./misc.ts";

export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

const MIME: Record<string, string> = {
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".txt": "text/plain; charset=utf-8",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

function meetingDirs(outputRoot: string): string[] {
  const root = resolve(toWslPath(outputRoot));
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((name) => join(root, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, MEETING_FILENAME));
      } catch {
        return false;
      }
    });
}

function readRecord(dir: string): MeetingRecord | null {
  try {
    return JSON.parse(readFileSync(join(dir, MEETING_FILENAME), "utf8")) as MeetingRecord;
  } catch {
    return null;
  }
}

function safeMeetingDir(outputRoot: string, name: string): string {
  if (name.includes("/") || name.includes("..") || name === "") {
    throw badRequest(`invalid meeting directory: ${name}`);
  }
  const dir = join(resolve(toWslPath(outputRoot)), name);
  if (!existsSync(dir)) throw notFound(`meeting not found: ${name}`);
  return dir;
}

/** Whisper's own JSON is the source of truth; SRT is the fallback. */
export function parseSegments(dir: string): { segments: Segment[]; language: string | null; duration: number } {
  const files = readdirSync(dir);
  const jsonName = files.find((f) => f.endsWith(".json") && f !== MEETING_FILENAME);
  if (jsonName) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, jsonName), "utf8")) as {
        segments?: { id?: number; start: number; end: number; text: string; speaker?: string }[];
        language?: string;
      };
      const segments = (raw.segments ?? []).map((s, i) => ({
        id: s.id ?? i,
        start: s.start,
        end: s.end,
        text: s.text.trim(),
        speaker: s.speaker ?? null,
      }));
      if (segments.length > 0) {
        return {
          segments,
          language: raw.language ?? null,
          duration: segments[segments.length - 1]?.end ?? 0,
        };
      }
    } catch {
      // fall through to SRT
    }
  }

  const srtName = files.find((f) => f.endsWith(".srt"));
  if (!srtName) return { segments: [], language: null, duration: 0 };
  return { ...parseSrt(readFileSync(join(dir, srtName), "utf8")), language: null };
}

export function parseSrt(text: string): { segments: Segment[]; duration: number } {
  const segments: Segment[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (lines.length < 2) continue;
    const timing = lines.find((l) => l.includes("-->"));
    if (!timing) continue;
    const [startRaw, endRaw] = timing.split("-->").map((s) => s.trim());
    const body = lines.slice(lines.indexOf(timing) + 1).join(" ").trim();
    if (!startRaw || !endRaw || body === "") continue;
    segments.push({
      id: segments.length,
      start: srtTimeToSeconds(startRaw),
      end: srtTimeToSeconds(endRaw),
      text: body,
      speaker: null,
    });
  }
  return { segments, duration: segments[segments.length - 1]?.end ?? 0 };
}

export function srtTimeToSeconds(value: string): number {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(value);
  if (!m) return 0;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  );
}

export function registerMeetingRoutes(router: Router, state: AppState): void {
  router.get("/api/meetings", (ctx: Ctx) => {
    const query = (ctx.url.searchParams.get("q") ?? "").toLowerCase();
    const meetings = meetingDirs(state.config.outputRoot)
      .map((dir) => {
        const record = readRecord(dir);
        if (!record) return null;
        const outputs = readdirSync(dir).filter((f) => f !== MEETING_FILENAME);
        const sizeBytes = outputs.reduce((sum, f) => {
          try {
            return sum + statSync(join(dir, f)).size;
          } catch {
            return sum;
          }
        }, 0);
        return { dir: basename(dir), path: dir, record, outputs, sizeBytes };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .filter((m) => {
        if (query === "") return true;
        const haystack = [
          m.dir,
          m.record.context,
          ...m.record.attendees,
          ...m.record.terms,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
    return { meetings };
  });

  /** P4: full-text search across every transcript. */
  router.get("/api/search", (ctx: Ctx) => {
    const query = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase();
    if (query === "") return { results: [] };
    const results: {
      dir: string;
      createdAt: string;
      matches: { start: number; text: string }[];
    }[] = [];
    for (const dir of meetingDirs(state.config.outputRoot)) {
      const record = readRecord(dir);
      if (!record) continue;
      const { segments } = parseSegments(dir);
      const matches = segments
        .filter((s) => s.text.toLowerCase().includes(query))
        .slice(0, 20)
        .map((s) => ({ start: s.start, text: s.text }));
      if (matches.length > 0) {
        results.push({ dir: basename(dir), createdAt: record.createdAt, matches });
      }
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { results, query };
  });

  router.get("/api/meetings/:dir", (ctx: Ctx) => {
    const dir = safeMeetingDir(state.config.outputRoot, ctx.params.dir as string);
    const record = readRecord(dir);
    if (!record) throw notFound("meeting.json missing or invalid");
    return { dir: basename(dir), path: dir, record, outputs: readdirSync(dir) };
  });

  router.get("/api/meetings/:dir/transcript", (ctx: Ctx) => {
    const dir = safeMeetingDir(state.config.outputRoot, ctx.params.dir as string);
    const record = readRecord(dir);
    const parsed = parseSegments(dir);
    const speakers = record?.speakers ?? null;
    // Apply the saved speaker map so the viewer shows names, not SPEAKER_00.
    const segments = parsed.segments.map((s) => ({
      ...s,
      speaker: s.speaker && speakers ? speakers[s.speaker] ?? s.speaker : s.speaker,
    }));
    return { ...parsed, segments };
  });

  /** P3: persist SPEAKER_00 -> real name mapping. */
  router.put("/api/meetings/:dir/speakers", (ctx: Ctx) => {
    const dir = safeMeetingDir(state.config.outputRoot, ctx.params.dir as string);
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    assertNoUnknownKeys(body, ["speakers"]);
    const speakers = body.speakers;
    if (typeof speakers !== "object" || speakers === null || Array.isArray(speakers)) {
      throw badRequest("`speakers` must be an object of label -> name");
    }
    const record = readRecord(dir);
    if (!record) throw notFound("meeting.json missing");
    record.speakers = speakers as Record<string, string>;
    writeFileSync(join(dir, MEETING_FILENAME), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return { speakers: record.speakers };
  });

  router.get("/api/meetings/:dir/file/:name", (ctx: Ctx) => {
    const dir = safeMeetingDir(state.config.outputRoot, ctx.params.dir as string);
    const name = ctx.params.name as string;
    if (name.includes("/") || name.includes("..")) throw badRequest("invalid filename");
    const file = join(dir, name);
    if (!existsSync(file)) throw notFound(`file not found: ${name}`);
    const body = readFileSync(file);
    ctx.res.writeHead(200, {
      "content-type": MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "content-disposition": `attachment; filename="${name}"`,
    });
    ctx.res.end(body);
    return undefined;
  });

  /** Range streaming so the transcript viewer can seek the source audio. */
  router.get("/api/media", (ctx: Ctx) => {
    const raw = ctx.url.searchParams.get("path");
    if (!raw) throw badRequest("`path` query parameter is required");
    const file = assertAllowed(raw, [state.config.outputRoot, state.projectDir]);
    if (!existsSync(file)) throw notFound(`media not found: ${file}`);

    const size = statSync(file).size;
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const range = ctx.req.headers.range;

    if (!range) {
      ctx.res.writeHead(200, {
        "content-type": type,
        "content-length": size,
        "accept-ranges": "bytes",
      });
      createReadStream(file).pipe(ctx.res);
      return undefined;
    }

    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      ctx.res.writeHead(416, { "content-range": `bytes */${size}` });
      ctx.res.end();
      return undefined;
    }
    ctx.res.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    });
    createReadStream(file, { start, end }).pipe(ctx.res);
    return undefined;
  });

  /**
   * Chatbot-ready export. `.json` costs ~7x the tokens of plain text and
   * `.txt` loses all timing, so neither is a good prompt; this is both.
   */
  router.get("/api/meetings/:dir/ai", (ctx: Ctx) => {
    const dir = safeMeetingDir(state.config.outputRoot, ctx.params.dir as string);
    const record = readRecord(dir);
    const { segments } = parseSegments(dir);
    const paragraphSeconds = Number(ctx.url.searchParams.get("paragraphSeconds") ?? 60) || 60;
    const markdown = buildAiMarkdown(basename(dir), record, segments, { paragraphSeconds });
    return { markdown, tokens: estimateTokens(markdown), segments: segments.length };
  });

  /** Several meetings in one prompt, for "summarise my week". */
  router.post("/api/export/ai", (ctx: Ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    assertNoUnknownKeys(body, ["dirs", "paragraphSeconds"]);
    const dirs = Array.isArray(body.dirs) ? (body.dirs as string[]) : [];
    if (dirs.length === 0) throw badRequest("`dirs` must list at least one meeting");
    const paragraphSeconds = typeof body.paragraphSeconds === "number" ? body.paragraphSeconds : 60;
    const parts = dirs.map((name) => {
      const dir = safeMeetingDir(state.config.outputRoot, name);
      return { name: basename(dir), record: readRecord(dir), segments: parseSegments(dir).segments };
    });
    const markdown =
      parts.length === 1 && parts[0]
        ? buildAiMarkdown(parts[0].name, parts[0].record, parts[0].segments, { paragraphSeconds })
        : buildCombinedMarkdown(parts, { paragraphSeconds });
    return { markdown, tokens: estimateTokens(markdown), meetings: parts.length };
  });

  /** Every artifact of one meeting, plus the AI markdown, as a zip. */
  router.get("/api/meetings/:dir/zip", (ctx: Ctx) => {
    const dir = safeMeetingDir(state.config.outputRoot, ctx.params.dir as string);
    const name = basename(dir);
    const record = readRecord(dir);
    const { segments } = parseSegments(dir);

    const entries = readdirSync(dir)
      .filter((f) => {
        try {
          return statSync(join(dir, f)).isFile() && !f.endsWith(".wav");
        } catch {
          return false;
        }
      })
      .map((f) => ({ name: `${name}/${f}`, data: readFileSync(join(dir, f)) }));
    entries.push({
      name: `${name}/${name}.ai.md`,
      data: Buffer.from(buildAiMarkdown(name, record, segments), "utf8"),
    });

    const zip = createZip(entries);
    ctx.res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": zip.length,
      "content-disposition": `attachment; filename="${name}.zip"`,
    });
    ctx.res.end(zip);
    return undefined;
  });
}
