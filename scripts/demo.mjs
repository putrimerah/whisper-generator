#!/usr/bin/env node
// Writes fictional meetings for screenshots and demos: no real names, no real
// recordings. Audio is synthetic noise shaped like speech, made by ffmpeg.
//
//   node scripts/demo.mjs [root]        default root: ~/.wg/demo
//
// Then run the UI against it (what `make demo` does):
//   WG_OUTPUT_ROOT=<root>/transcripts WG_BROWSE_ROOT=<root>/videos wg ui
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Under home so the file browser's allowlist accepts it.
const root = process.argv[2] ?? join(homedir(), ".wg", "demo");
const transcripts = join(root, "transcripts");
const videos = join(root, "videos");
const ffmpeg = [join(homedir(), ".local", "bin", "ffmpeg"), "ffmpeg"].find((p) => p === "ffmpeg" || existsSync(p));

// Speech-like envelope: syllables (~4 Hz), phrases, and pauses between them.
// A slow term on top varies loudness from one stretch of talk to the next.
const SPEECH =
  "(random(0)*2-1)*(0.3+0.7*abs(sin(2*PI*t/61+sin(t/23))))*(0.35+0.65*abs(sin(2*PI*t*0.13)))*(0.45+0.55*abs(sin(2*PI*t*3.7)))*gt(sin(2*PI*t/9+sin(t/5)),-0.7)";

function synthAudio(file, seconds, codecArgs) {
  if (existsSync(file)) return;
  execFileSync(ffmpeg, [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `aevalsrc=exprs='${SPEECH}':s=8000:d=${seconds}`,
    "-af", "lowpass=f=3000,volume=0.6",
    "-ac", "1", ...codecArgs, file,
  ]);
}

const SCRIPTED = [
  [662, "Okay, so where were we. Atlas is basically the only thing blocking the release, right?"],
  [669, "Bob, how are the Kafka consumers looking?"],
  [674, "Two out of three are done. Billing still drops messages whenever Orion restarts."],
  [682, "I'm pretty sure it's the offset commit. We commit before the write actually finishes."],
  [691, "Yeah, that's what QA saw on Friday. Same thing, like forty messages gone each time."],
  [700, "So it's not the retry logic then?"],
  [704, "Probably not. I can write a test that kills the consumer halfway through a batch."],
  [712, "If we commit after the write, doesn't that change the delivery guarantee?"],
  [720, "Yeah, it becomes at-least-once, so the writes have to be idempotent."],
  [728, "Most of them already are. Except the invoice table."],
  [735, "Boleh, I'll take the invoice table. I'll just put a unique key on the event ID."],
  [743, "Okay. So Bob does the commit order, Chen does the test, Dana does invoices."],
  [751, "Can we get Atlas into staging by Thursday?"],
  [756, "Thursday's fine if review doesn't drag."],
  [761, "I'll push a branch today and tag Chen."],
  [768, "Cool. Next one, the Orion dashboard."],
  [774, "Latency's down about eighteen percent since the cache change. Error rate hasn't moved."],
  [783, "That's fine for now. Let's look again after the release."],
];

// Templates with rotating fill-ins, so search results do not repeat verbatim.
const THINGS = ["login page", "billing service", "search index", "export job", "settings page", "audit log",
  "mobile build", "rate limiter", "email worker", "onboarding flow", "cache layer", "admin panel"];
const STATES = ["done", "in review", "blocked on design", "about half done", "waiting on QA", "in staging already"];
const TEMPLATES = [
  "Okay, what's the status on the {a}?",
  "The {a} is {s}.",
  "I think the {a} is {s}, but let me check.",
  "Who's picking up the {a} this sprint?",
  "I can take the {a}, it shouldn't be big.",
  "Do we need a design review for the {a}?",
  "Not really, it's mostly backend.",
  "The {a} broke again last night, same error as before.",
  "Can we pair on the {a} tomorrow morning?",
  "Sure, after standup works.",
  "Let's move the {a} to next sprint.",
  "How many points for the {a}?",
  "Three, maybe five if the {b} gets involved.",
  "I'd rather not touch the {b} this week.",
  "Fair. Let's keep the {a} small then.",
  "Any blockers on the {a}?",
  "Just waiting on access to the {b} logs.",
  "I'll sort that out after this call.",
  "Okay, next one.",
  "Can you share your screen?",
];

function fillerLine(n) {
  const t = TEMPLATES[n % TEMPLATES.length];
  const a = THINGS[(n * 7) % THINGS.length];
  const b = THINGS[(n * 7 + 5) % THINGS.length];
  return t.replace("{a}", a).replace("{b}", b).replace("{s}", STATES[(n * 5) % STATES.length]);
}

function fmtSrt(t) {
  const ms = Math.round(t * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
}

/** Deterministic segments over the whole duration, scripted lines in place. */
function buildSegments(duration, scripted, offset = 0) {
  const out = [];
  let t = 2.4;
  let f = 0;
  let step = 0;
  const first = scripted[0]?.[0] ?? Infinity;
  const last = scripted[scripted.length - 1]?.[0] ?? -Infinity;
  while (t < duration - 4) {
    if (t >= first - 1 && t <= last + 1) {
      for (const [start, text] of scripted) out.push({ start, text });
      t = last + 8;
      continue;
    }
    out.push({ start: Math.round(t * 100) / 100, text: fillerLine(offset + f++) });
    step = (step * 7 + 3) % 11;
    t += 4.2 + step * 0.45;
  }
  return out.map((s, i) => ({
    id: i,
    start: s.start,
    end: Math.round(Math.min(duration, (out[i + 1]?.start ?? s.start + 5) - 0.3) * 100) / 100,
    text: s.text,
  }));
}

function writeMeeting({ folder, stem, created, duration, attendees, terms, context, segments, audio, input }) {
  const dir = join(transcripts, folder);
  mkdirSync(dir, { recursive: true });

  // Whisper's JSON carries token ids and scores; that is why it is so expensive.
  const json = {
    text: segments.map((s) => ` ${s.text}`).join(""),
    segments: segments.map((s) => ({
      id: s.id, seek: Math.floor(s.start * 100), start: s.start, end: s.end, text: ` ${s.text}`,
      tokens: Array.from({ length: Math.ceil(s.text.length / 4.2) }, (_, k) => 50364 + ((s.id * 31 + k * 17) % 9000)),
      temperature: 0, avg_logprob: -0.21, compression_ratio: 1.43, no_speech_prob: 0.012,
    })),
    language: "en",
  };
  writeFileSync(join(dir, `${stem}.json`), JSON.stringify(json));
  writeFileSync(join(dir, `${stem}.txt`), `${segments.map((s) => s.text).join("\n")}\n`);
  writeFileSync(
    join(dir, `${stem}.srt`),
    segments.map((s, i) => `${i + 1}\n${fmtSrt(s.start)} --> ${fmtSrt(s.end)}\n${s.text}\n`).join("\n"),
  );
  writeFileSync(
    join(dir, `${stem}.vtt`),
    `WEBVTT\n\n${segments.map((s) => `${fmtSrt(s.start).replace(",", ".")} --> ${fmtSrt(s.end).replace(",", ".")}\n${s.text}\n`).join("\n")}`,
  );
  writeFileSync(
    join(dir, `${stem}.tsv`),
    `start\tend\ttext\n${segments.map((s) => `${Math.round(s.start * 1000)}\t${Math.round(s.end * 1000)}\t${s.text}`).join("\n")}\n`,
  );

  let audioPath = null;
  if (audio) {
    audioPath = join(dir, `${stem}.16k.wav`);
    synthAudio(audioPath, duration, ["-ar", "16000", "-c:a", "pcm_s16le"]);
  }

  const prompt = `${context} Attendees: ${attendees.join(", ")}. Terms: ${terms.join(", ")}.`;
  writeFileSync(join(dir, "meeting.json"), `${JSON.stringify({
    version: 1,
    createdAt: created.toISOString(),
    input,
    audio: audioPath,
    outputDir: dir,
    model: "large-v3",
    language: "en",
    device: "auto",
    attendees,
    terms,
    context,
    prompt,
    promptTokens: Math.ceil(prompt.length / 4),
    promptTruncated: false,
    speakers: null,
    commands: [],
  }, null, 2)}\n`);
  console.log(`  ${folder}`);
}

if (!ffmpeg) {
  console.error("ffmpeg not found; run `make install` first");
  process.exit(1);
}

mkdirSync(videos, { recursive: true });
console.log(`demo data in ${root}`);

// Recordings for the New run file picker; audio-only to stay small.
for (const [name, seconds] of [["2025-10-14 10-00-12.mp4", 2538], ["2025-10-16 14-30-05.mp4", 1865], ["2025-10-17 09-15-40.mp4", 1660]]) {
  synthAudio(join(videos, name), seconds, ["-c:a", "aac", "-b:a", "16k"]);
}

writeMeeting({
  folder: "Atlas sprint planning",
  stem: "2025-10-14 10-00-12",
  created: new Date(2025, 9, 14, 10, 0, 12),
  duration: 2538,
  attendees: ["Alice", "Bob", "Chen", "Dana"],
  terms: ["Atlas", "Kafka", "Orion", "QA"],
  context: "Weekly planning. Mostly the Atlas migration.",
  segments: buildSegments(2538, SCRIPTED),
  audio: true,
  input: join(videos, "2025-10-14 10-00-12.mp4"),
});

for (const [folder, stem, day, minutes, attendees, terms, context] of [
  ["Orion design review", "2025-10-13 15-02-44", 13, 31, ["Alice", "Erin"], ["Orion", "Figma"], "New settings page and the empty states."],
  ["Weekly sync", "2025-10-13 09-30-10", 13, 27, ["Alice", "Bob", "Chen", "Dana"], ["Atlas"], ""],
  ["Northwind client call", "2025-10-10 11-00-03", 10, 55, ["Alice", "Frank"], ["Northwind", "SSO"], "Contract renewal and the SSO rollout."],
]) {
  writeMeeting({
    folder, stem,
    created: new Date(2025, 9, day, Number(stem.slice(11, 13)), Number(stem.slice(14, 16))),
    duration: minutes * 60,
    attendees, terms, context,
    segments: buildSegments(minutes * 60, [], day * 13),
    audio: false,
    input: join(videos, `${stem}.mp4`),
  });
}

console.log(`\nWG_OUTPUT_ROOT=${transcripts} WG_BROWSE_ROOT=${videos} wg ui`);
