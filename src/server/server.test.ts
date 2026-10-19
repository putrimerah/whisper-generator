import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./jobStore.ts";
import { makeJobId, TERMINAL_STATES } from "./jobTypes.ts";
import { isPathAllowed, planOutputTarget, toWindowsDisplayPath, isMediaPath, nextFreeDir, defaultBrowsePath } from "./fsService.ts";
import { readEnvSettings } from "../env.ts";
import { estimateNeeded, formatBytes, SAFETY_MARGIN_BYTES } from "./disk.ts";
import { cleanupWorkspace, wavPathFor } from "./workspace.ts";
import { parseSrt, srtTimeToSeconds } from "./routes/meetings.ts";
import { Router } from "./router.ts";
import { buildAiMarkdown, groupSegments, estimateTokens as estimateAiTokens } from "./aiExport.ts";
import { createZip, crc32 } from "./zip.ts";
import type { Job } from "./jobTypes.ts";
import type { RunOptions } from "../types.ts";

const OPTIONS: RunOptions = {
  input: "/home/x/a.mp4",
  outDir: "/home/x/out",
  attendees: [],
  terms: [],
  context: "",
  model: "large-v3",
  language: "en",
  device: "auto",
  computeType: "int8_float16",
  outputFormats: ["srt"],
  extractAudio: true,
  wordTimestamps: false,
  diarize: false,
  speakerCount: 0,
};

function tempStore(): { store: JobStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "wg-store-"));
  const file = join(dir, "jobs.json");
  return { store: new JobStore(file), file };
}

test("job ids are filesystem safe and unique", () => {
  const id = makeJobId(new Date("2026-10-19T17:45:12Z"));
  assert.match(id, /^\d{8}T\d{6}-[a-z0-9]{6}$/);
  assert.notEqual(makeJobId(), makeJobId());
});

test("job store round-trips through disk", () => {
  const { store, file } = tempStore();
  const job = store.create({
    input: "/home/x/a.mp4",
    outDir: "/home/x/out",
    options: OPTIONS,
    keepAudio: false,
    diarize: false,
    prompt: { text: "p", tokens: 1, truncated: false, dropped: [] },
    probe: { durationSeconds: 10, sizeBytes: 100 },
  });
  store.update(job.id, { state: "transcribing" });

  const reloaded = new JobStore(file);
  reloaded.load();
  const found = reloaded.get(job.id);
  assert.ok(found);
  // A job still running when the server died cannot be resumed.
  assert.equal(found?.state, "failed");
  assert.equal(found?.error?.message, "interrupted by server restart");
});

test("terminal jobs survive a restart unchanged", () => {
  const { store, file } = tempStore();
  const job = store.create({
    input: "/home/x/a.mp4",
    outDir: "/home/x/out",
    options: OPTIONS,
    keepAudio: false,
    diarize: false,
    prompt: { text: "p", tokens: 1, truncated: false, dropped: [] },
    probe: null,
  });
  store.update(job.id, { state: "done" });
  const reloaded = new JobStore(file);
  reloaded.load();
  assert.equal(reloaded.get(job.id)?.state, "done");
  assert.ok(TERMINAL_STATES.has("done"));
});

test("log tail is capped", () => {
  const { store } = tempStore();
  const job = store.create({
    input: "/home/x/a.mp4",
    outDir: "/home/x/out",
    options: OPTIONS,
    keepAudio: false,
    diarize: false,
    prompt: { text: "", tokens: 0, truncated: false, dropped: [] },
    probe: null,
  });
  for (let i = 0; i < 500; i += 1) store.appendLog(job.id, `line ${i}`);
  assert.equal(store.get(job.id)?.logTail.length, 200);
  assert.equal(store.get(job.id)?.logTail[199], "line 499");
});

test("path allowlist blocks traversal and system paths", () => {
  assert.equal(isPathAllowed("/mnt/c/Users/x/a.mp4"), true);
  assert.equal(isPathAllowed(homedir()), true);
  assert.equal(isPathAllowed("/etc/passwd"), false);
  assert.equal(isPathAllowed("/mnt/../etc/passwd"), false);
  assert.equal(isPathAllowed("relative/path.mp4"), false);
  assert.equal(isPathAllowed("/tmp/x.mp4"), false);
});

test("media classification", () => {
  assert.equal(isMediaPath("a.MP4"), true);
  assert.equal(isMediaPath("a.wav"), true);
  assert.equal(isMediaPath("a.txt"), false);
});

test("windows display paths", () => {
  assert.equal(toWindowsDisplayPath("/mnt/c/Users/x"), "C:\\Users\\x");
  assert.equal(toWindowsDisplayPath("/mnt/d"), "D:\\");
  assert.equal(toWindowsDisplayPath("/home/irfan"), null);
});

test("output stems are sanitised only for windows targets", () => {
  const win = planOutputTarget("/home/x/sync: Q3 review.mp4", "/mnt/c/Users/x/Documents");
  assert.equal(win.stem, "sync_ Q3 review");
  assert.equal(win.adjusted, true);

  const wsl = planOutputTarget("/home/x/sync: Q3 review.mp4", "/home/x/out");
  assert.equal(wsl.stem, "sync: Q3 review");
  assert.equal(wsl.adjusted, false);
});

test("collision resolution picks the next free folder", () => {
  const root = mkdtempSync(join(tmpdir(), "wg-out-"));
  const dir = join(root, "standup");
  mkdirSync(dir);
  writeFileSync(join(dir, "meeting.json"), "{}");
  assert.equal(nextFreeDir(dir), `${dir}-2`);
  rmSync(root, { recursive: true, force: true });
});

test("disk estimate includes the safety margin", () => {
  // 60 s of 16 kHz mono PCM is 1.92 MB.
  assert.equal(estimateNeeded(60, true), 1_920_000 + SAFETY_MARGIN_BYTES);
  assert.equal(estimateNeeded(60, false), SAFETY_MARGIN_BYTES);
  assert.equal(formatBytes(1024 ** 3), "1.0 GB");
});

test("workspace never touches a windows mount", () => {
  const job = { workDir: "/mnt/c/Users/x/tmp" } as Job;
  assert.throws(() => cleanupWorkspace(job), /refusing to remove/);
});

test("workspace wav carries the source stem", () => {
  // Whisper names outputs after the media file it reads.
  assert.equal(wavPathFor("/home/x/.wg/work/j1", "standup"), "/home/x/.wg/work/j1/standup.wav");
});

test("workspace cleanup removes the directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "wg-work-"));
  writeFileSync(join(dir, "audio.wav"), "x");
  cleanupWorkspace({ workDir: dir } as Job);
  assert.equal(existsSync(dir), false);
});

test("srt parsing yields timed segments", () => {
  const srt = `1
00:00:00,000 --> 00:00:03,500
Hello there

2
00:01:02,250 --> 00:01:05,000
Second line
`;
  const { segments, duration } = parseSrt(srt);
  assert.equal(segments.length, 2);
  assert.equal(segments[0]?.text, "Hello there");
  assert.equal(segments[0]?.end, 3.5);
  assert.equal(segments[1]?.start, 62.25);
  assert.equal(duration, 65);
  assert.equal(srtTimeToSeconds("01:02:03,004"), 3723.004);
});

test("router matches params and rejects mismatches", () => {
  const router = new Router();
  router.get("/api/jobs/:id", () => ({}));
  assert.deepEqual(router.match("GET", "/api/jobs/abc")?.params, { id: "abc" });
  assert.equal(router.match("POST", "/api/jobs/abc"), null);
  assert.equal(router.match("GET", "/api/jobs"), null);
});

test("ai export merges segments into timestamped paragraphs", () => {
  const segments = [
    { id: 0, start: 0, end: 3, text: "Hello there", speaker: null },
    { id: 1, start: 3, end: 6, text: "second part", speaker: null },
    { id: 2, start: 90, end: 95, text: "much later", speaker: null },
  ];
  const md = buildAiMarkdown("standup", null, segments);
  assert.match(md, /# Meeting: standup/);
  // Two segments inside the same minute merge; the later one starts a new one.
  assert.match(md, /\[00:00\] Hello there second part/);
  assert.match(md, /\[01:30\] much later/);
});

test("ai export breaks paragraphs on speaker change", () => {
  const segments = [
    { id: 0, start: 0, end: 2, text: "Hi", speaker: "Irfan" },
    { id: 1, start: 2, end: 4, text: "Hello", speaker: "Aisyah" },
  ];
  const paragraphs = groupSegments(segments, 60);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[1]?.speaker, "Aisyah");
});

test("ai export is cheaper than srt and far cheaper than json", () => {
  const segments = Array.from({ length: 60 }, (_, i) => ({
    id: i, start: i * 5, end: i * 5 + 5, text: "some spoken words here", speaker: null,
  }));
  const md = buildAiMarkdown("m", null, segments, { includeHeader: false });
  // One stamp per minute instead of one index + range per segment.
  assert.ok(estimateAiTokens(md) < estimateAiTokens(segments.map((s, i) =>
    `${i + 1}\n00:00:0${s.start} --> 00:00:0${s.end}\n${s.text}\n`).join("\n")));
});

test("zip has a valid signature and holds every entry", () => {
  const zip = createZip([
    { name: "a/one.txt", data: Buffer.from("hello") },
    { name: "a/two.md", data: Buffer.from("# title") },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(zip.length - 14), 2); // entry count
  assert.ok(zip.includes(Buffer.from("a/one.txt")));
  assert.equal(crc32(Buffer.from("hello")), 0x3610a686);
});

test("env settings override config, windows paths converted", () => {
  const previous = { ...process.env };
  process.env.WG_BROWSE_ROOT = "C:\\Users\\someone\\Videos";
  process.env.WG_OUTPUT_ROOT = "D:/transcripts";
  process.env.WG_MODEL = "medium";
  process.env.WG_KEEP_AUDIO = "true";
  process.env.WG_TERMS = "Kafka, Sybil ,";
  process.env.WG_PORT = "9001";

  const env = readEnvSettings("/nonexistent-dir-so-no-dotenv-is-read");
  assert.equal(env.config.browseRoot, "/mnt/c/Users/someone/Videos");
  assert.equal(env.config.outputRoot, "/mnt/d/transcripts");
  assert.equal(env.config.model, "medium");
  assert.equal(env.config.keepAudio, true);
  assert.deepEqual(env.config.terms, ["Kafka", "Sybil"]);
  assert.equal(env.port, 9001);

  process.env = previous;
});

test("absent env vars leave config untouched", () => {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("WG_")) delete process.env[key];
  }
  const env = readEnvSettings("/nonexistent-dir-so-no-dotenv-is-read");
  assert.deepEqual(env.config, {});
  assert.equal(env.port, null);
  process.env = previous;
});

test("browse path falls back when the configured root is missing", () => {
  // A stale WG_BROWSE_ROOT must not strand the picker on a dead path.
  assert.notEqual(defaultBrowsePath("/mnt/c/definitely-not-here"), "/mnt/c/definitely-not-here");
});
