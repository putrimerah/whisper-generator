import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, estimateTokens, PROMPT_TOKEN_BUDGET } from "./prompt.ts";
import { quotePowerShell, quotePosix, renderCommand } from "./shell.ts";
import { isOnWindowsMount, pickWindowsUser, sanitizeForWindows, toWslPath } from "./platform.ts";
import type { ExecutionPlan } from "./types.ts";

test("prompt keeps participants and glossary last", () => {
  const r = buildPrompt({
    context: "Sprint review for the billing service",
    attendees: ["Alice", "Bob"],
    terms: ["Kafka", "mesyuarat"],
  });
  assert.match(r.prompt, /Participants: Alice, Bob\./);
  assert.ok(r.prompt.indexOf("Terms used") > r.prompt.indexOf("Participants"));
  assert.equal(r.truncated, false);
});

test("oversized context is dropped before names", () => {
  const r = buildPrompt({
    context: "word ".repeat(400),
    attendees: ["Alice", "Lee"],
    terms: ["CTranslate2"],
  });
  assert.ok(r.tokens <= PROMPT_TOKEN_BUDGET);
  assert.match(r.prompt, /Alice/);
  assert.match(r.prompt, /CTranslate2/);
  assert.deepEqual(r.dropped.includes("context"), true);
});

test("duplicate and blank names are removed", () => {
  const r = buildPrompt({ attendees: ["Alice", " alice ", "", "Bob"] });
  assert.match(r.prompt, /Participants: Alice, Bob\./);
});

test("token estimate is conservative", () => {
  assert.ok(estimateTokens("hello world") >= 2);
  assert.equal(estimateTokens("   "), 0);
});

test("powershell quoting survives apostrophes and backslashes", () => {
  assert.equal(quotePowerShell("C:\\v's\\a.mp4"), "'C:\\v''s\\a.mp4'");
  assert.equal(quotePosix("it's"), `'it'\\''s'`);
});

test("rendered powershell command uses call operator", () => {
  const plan: ExecutionPlan = { host: "windows", engine: "windows", viaInterop: false, shell: "powershell" };
  const line = renderCommand({ label: "x", bin: "whisper", args: ["--model", "large-v3"] }, plan);
  assert.equal(line, "& 'whisper' '--model' 'large-v3'");
});

test("windows paths convert to wsl paths, posix paths pass through", () => {
  assert.equal(toWslPath("C:\\Users\\you\\Videos"), "/mnt/c/Users/you/Videos");
  assert.equal(toWslPath("D:/meetings/out"), "/mnt/d/meetings/out");
  assert.equal(toWslPath("/home/you/out"), "/home/you/out");
  assert.equal(toWslPath('"C:\\Users\\you"'), "/mnt/c/Users/you");
});

test("windows mount detection", () => {
  assert.equal(isOnWindowsMount("/mnt/c/Users/you"), true);
  assert.equal(isOnWindowsMount("/mnt/d"), true);
  assert.equal(isOnWindowsMount("/home/you/out"), false);
  assert.equal(isOnWindowsMount("/mnt/wsl/something"), false);
});

test("stems are sanitised for NTFS targets", () => {
  assert.equal(sanitizeForWindows('meeting: Q3 "review"'), "meeting_ Q3 _review_");
  assert.equal(sanitizeForWindows("standup?*|"), "standup___");
  assert.equal(sanitizeForWindows("trailing dots..."), "trailing dots");
  assert.equal(sanitizeForWindows("CON"), "CON_");
  assert.equal(sanitizeForWindows("normal-name"), "normal-name");
});

test("windows user discovery skips system profiles", () => {
  const entries = ["Public", "Default", "All Users", "desktop.ini", "you"];
  const picked = pickWindowsUser(entries, (n) => n === "you");
  assert.equal(picked, "you");
  assert.equal(pickWindowsUser(["Public", "Default"], () => true), null);
});
