import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCommand } from "./shell.ts";
import type { Command, ExecutionPlan, MeetingRecord, RunOptions } from "./types.ts";
import type { PromptResult } from "./prompt.ts";

export const MEETING_FILENAME = "meeting.json";

/**
 * Sidecar written next to the transcript. Makes a run reproducible and gives
 * the future UI (and diarization step) a place to store the speaker map.
 */
export function buildMeetingRecord(
  opts: RunOptions,
  prompt: PromptResult,
  audioPath: string | null,
  commands: Command[],
  plan: ExecutionPlan,
): MeetingRecord {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    input: opts.input,
    audio: audioPath,
    outputDir: opts.outDir,
    model: opts.model,
    language: opts.language,
    device: opts.device,
    attendees: opts.attendees,
    terms: opts.terms,
    context: opts.context,
    prompt: prompt.prompt,
    promptTokens: prompt.tokens,
    promptTruncated: prompt.truncated,
    speakers: null,
    commands: commands.map((c) => ({ label: c.label, rendered: renderCommand(c, plan) })),
  };
}

export function writeMeetingRecord(record: MeetingRecord, outDir: string): string {
  const path = join(outDir, MEETING_FILENAME);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}
