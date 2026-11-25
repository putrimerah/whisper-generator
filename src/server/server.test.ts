import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { JobStore, WORK_ROOT } from "./jobStore.ts";
import { makeJobId, TERMINAL_STATES } from "./jobTypes.ts";
import { isPathAllowed, planOutputTarget, toWindowsDisplayPath, isMediaPath, nextFreeDir, defaultBrowsePath, tildify } from "./fsService.ts";
import { readEnvSettings } from "../env.ts";
import { detectHost, isAbsoluteUserPath, normalizeUserPath, userMediaDir } from "../platform.ts";
import { DEFAULT_CONFIG, defaultOutputRoot } from "../config.ts";
import { estimateNeeded, formatBytes, SAFETY_MARGIN_BYTES } from "./disk.ts";
import { cleanupWorkspace, wavPathFor } from "./workspace.ts";
import { parseSrt, srtTimeToSeconds } from "./routes/meetings.ts";
import { Router } from "./router.ts";
import { buildAiMarkdown, groupSegments, estimateTokens as estimateAiTokens } from "./aiExport.ts";
import { createZip, crc32 } from "./zip.ts";
import { bucketPeaks, RmsAccumulator } from "./peaks.ts";
import { createLineReader } from "./runner.ts";
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

test("process output reassembles split progress and UTF-8 across chunks", () => {
  const lines: string[] = [];
  const reader = createLineReader((line) => lines.push(line));
  reader.write(Buffer.from("size= 1024KiB ti"));
  reader.write(Buffer.from("me=00:01:23.45\r5%|##| 180/3938\r"));
  const message = Buffer.from("Detected language '日本語'\nlast line");
  const split = message.indexOf(Buffer.from("日")) + 1;
  reader.write(message.subarray(0, split));
  reader.write(message.subarray(split));
  reader.end();
  assert.deepEqual(lines, [
    "size= 1024KiB time=00:01:23.45",
    "5%|##| 180/3938",
    "Detected language '日本語'",
    "last line",
  ]);
});

test("process output accepts CRLF, standalone CR, and unterminated final lines", () => {
  const lines: string[] = [];
  const reader = createLineReader((line) => lines.push(line));
  reader.write(Buffer.from("first\r"));
  reader.write(Buffer.from("\nsecond\nthird\rfourth"));
  reader.end();
  assert.deepEqual(lines, ["first", "second", "third", "fourth"]);
});

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
  assert.equal(isPathAllowed("/mnt/c/Users/x/a.mp4", [], "linux"), true);
  assert.equal(isPathAllowed(homedir(), [], "linux"), true);
  assert.equal(isPathAllowed("/etc/passwd", [], "linux"), false);
  assert.equal(isPathAllowed("/mnt/../etc/passwd", [], "linux"), false);
  assert.equal(isPathAllowed("relative/path.mp4", [], "linux"), false);
  assert.equal(isPathAllowed("/tmp/x.mp4", [], "linux"), false);
});

test("media classification", () => {
  assert.equal(isMediaPath("a.MP4"), true);
  assert.equal(isMediaPath("a.wav"), true);
  assert.equal(isMediaPath("a.txt"), false);
});

test("windows display paths", () => {
  assert.equal(toWindowsDisplayPath("/mnt/c/Users/x", "wsl"), "C:\\Users\\x");
  assert.equal(toWindowsDisplayPath("/mnt/d", "wsl"), "D:\\");
  assert.equal(toWindowsDisplayPath("/home/you", "wsl"), null);
});

test("output stems are sanitised only for windows targets", () => {
  const win = planOutputTarget("/home/x/sync: Q3 review.mp4", "/mnt/c/Users/x/Documents", "wsl");
  assert.equal(win.stem, "sync_ Q3 review");
  assert.equal(win.adjusted, true);

  const wsl = planOutputTarget("/home/x/sync: Q3 review.mp4", "/home/x/out", "wsl");
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
  mkdirSync(WORK_ROOT, { recursive: true });
  const dir = mkdtempSync(join(WORK_ROOT, "wg-work-"));
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
    { id: 0, start: 0, end: 2, text: "Hi", speaker: "Alice" },
    { id: 1, start: 2, end: 4, text: "Hello", speaker: "Bob" },
  ];
  const paragraphs = groupSegments(segments, 60);
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[1]?.speaker, "Bob");
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
  process.env.WG_TERMS = "Kafka, Atlas ,";
  process.env.WG_PORT = "9001";

  const env = readEnvSettings("/nonexistent-dir-so-no-dotenv-is-read");
  if (detectHost() !== "windows") {
    assert.equal(env.config.browseRoot, "/mnt/c/Users/someone/Videos");
    assert.equal(env.config.outputRoot, "/mnt/d/transcripts");
  }
  assert.equal(env.config.model, "medium");
  assert.equal(env.config.keepAudio, true);
  assert.deepEqual(env.config.terms, ["Kafka", "Atlas"]);
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

test("favorites fall back to local folders without windows mounts", () => {
  // Plain Linux or macOS: no /mnt/c, so the picker must still be useful.
  const home = mkdtempSync(join(tmpdir(), "wg-home-"));
  mkdirSync(join(home, "Videos"));
  assert.equal(userMediaDir(home, "linux"), join(home, "Videos"));
  assert.equal(userMediaDir(home, "macos"), join(home, "Videos"));

  const mac = mkdtempSync(join(tmpdir(), "wg-mac-"));
  mkdirSync(join(mac, "Movies"));
  // macOS prefers Movies over Videos.
  assert.equal(userMediaDir(mac, "macos"), join(mac, "Movies"));
  assert.equal(userMediaDir(mkdtempSync(join(tmpdir(), "wg-bare-")), "linux"), null);

  rmSync(home, { recursive: true, force: true });
  rmSync(mac, { recursive: true, force: true });
});

test("output root never lands inside the repository", () => {
  // ./out would pollute a cloned checkout; Documents or ~/transcripts instead.
  const root = defaultOutputRoot();
  assert.ok(isAbsoluteUserPath(root), `expected an absolute path, got ${root}`);
  assert.ok(!root.includes("whisper-generator"), `output root must not be in the repo: ${root}`);
});

test("default config resolves paths at runtime, never from literals", () => {
  // Defaults must be derived from the host, so a clone picks up its own user.
  // Privacy of committed files is checked separately by `make privacy`.
  assert.ok(DEFAULT_CONFIG.outputRoot.startsWith("/"));
  assert.equal(DEFAULT_CONFIG.browseRoot, "");
});

test("waveform rms survives chunks split mid-sample", () => {
  // 8 samples, 4 per window: silence then full-scale square wave.
  const pcm = Buffer.alloc(16);
  for (let i = 4; i < 8; i++) pcm.writeInt16LE(i % 2 === 0 ? 32767 : -32768, i * 2);
  const acc = new RmsAccumulator(4, 1);
  acc.push(pcm.subarray(0, 7));
  acc.push(pcm.subarray(7));
  const windows = acc.finish();
  assert.equal(windows.length, 2);
  assert.equal(windows[0], 0);
  assert.ok((windows[1] ?? 0) > 0.99);
});

test("waveform buckets are normalised and sized as asked", () => {
  const windows = Array.from({ length: 1000 }, (_, i) => (i === 500 ? 50 : (i % 10) / 10));
  const peaks = bucketPeaks(windows, 100);
  assert.equal(peaks.length, 100);
  assert.ok(peaks.every((p) => p >= 0 && p <= 1));
  // One outlier must not squash the rest towards zero.
  assert.ok((peaks[10] ?? 0) > 0.5);
  assert.deepEqual(bucketPeaks([], 10), []);
  assert.equal(bucketPeaks([0.2, 0.4], 6).length, 6);
});

test("picker paths show home as ~", () => {
  assert.equal(tildify("/home/you/Videos", "/home/you"), "~/Videos");
  assert.equal(tildify("/home/you", "/home/you"), "~");
  assert.equal(tildify("/home/younger/x", "/home/you"), "/home/younger/x");
  assert.equal(tildify("/mnt/c/Users", "/home/you"), "/mnt/c/Users");
});

test("absolute path detection per host", () => {
  assert.equal(isAbsoluteUserPath("/home/you/a.mp4", "linux"), true);
  assert.equal(isAbsoluteUserPath("C:\\Users\\you\\a.mp4", "linux"), false);
  assert.equal(isAbsoluteUserPath("C:\\Users\\you\\a.mp4", "windows"), true);
  assert.equal(isAbsoluteUserPath("C:/Users/you/a.mp4", "windows"), true);
  assert.equal(isAbsoluteUserPath("/home/you/a.mp4", "windows"), false);
  // UNC is refused: the allowlist cannot reason about network shares.
  assert.equal(isAbsoluteUserPath("\\\\server\\share\\a.mp4", "windows"), false);
  assert.equal(isAbsoluteUserPath("relative\\a.mp4", "windows"), false);
});

test("user paths are left alone on a windows host", () => {
  assert.equal(normalizeUserPath("C:\\Users\\you\\Videos", "windows"), "C:\\Users\\you\\Videos");
  // Forward slashes are accepted and normalised to backslashes.
  assert.equal(normalizeUserPath("D:/transcripts", "windows"), "D:\\transcripts");
  assert.equal(normalizeUserPath('  "C:\\Users\\you"  ', "windows"), "C:\\Users\\you");
  assert.equal(normalizeUserPath("", "windows"), "");
});

test("windows allowlist is case-insensitive and drive-scoped", () => {
  const root = "C:\\Users\\you";
  assert.equal(isPathAllowed("C:\\Users\\you\\a.mp4", [root], "windows"), true);
  // NTFS is case-insensitive, so the containment check must be too,
  // otherwise capitalisation walks straight past the allowlist.
  assert.equal(isPathAllowed("c:\\users\\YOU\\a.mp4", [root], "windows"), true);
  assert.equal(isPathAllowed("C:\\Windows\\System32\\cmd.exe", [root], "windows"), false);
  assert.equal(isPathAllowed("D:\\elsewhere\\a.mp4", [root], "windows"), false);
  assert.equal(isPathAllowed("C:\\Users\\you\\..\\other\\a.mp4", [root], "windows"), false);
  assert.equal(isPathAllowed("\\\\server\\share\\a.mp4", [root], "windows"), false);
  // Alternate data streams are a Windows-only way to hide a payload.
  assert.equal(isPathAllowed("C:\\Users\\you\\a.txt:hidden", [root], "windows"), false);
  // A bare drive root as the allowed root must still work.
  assert.equal(isPathAllowed("D:\\clips\\a.mp4", ["D:\\"], "windows"), true);
});

test("windows output stems are sanitised for NTFS", () => {
  const win = planOutputTarget(
    "C:\\Users\\you\\sync: Q3 review.mp4",
    "C:\\Users\\you\\Documents",
    "windows",
  );
  assert.equal(win.stem, "sync_ Q3 review");
  assert.equal(win.adjusted, true);
  assert.equal(win.dir, "C:\\Users\\you\\Documents\\sync_ Q3 review");
});

test("display path on a windows host is the path itself", () => {
  assert.equal(toWindowsDisplayPath("C:\\Users\\you", "windows"), "C:\\Users\\you");
});
