import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./jobStore.ts";
import { makeJobId, TERMINAL_STATES } from "./jobTypes.ts";
import { isPathAllowed, planOutputTarget, toWindowsDisplayPath, isMediaPath, nextFreeDir } from "./fsService.ts";
import { estimateNeeded, formatBytes, SAFETY_MARGIN_BYTES } from "./disk.ts";
import { cleanupWorkspace, wavPathFor } from "./workspace.ts";
import { parseSrt, srtTimeToSeconds } from "./routes/meetings.ts";
import { Router } from "./router.ts";
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
