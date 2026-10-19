import type { MeetingRecord } from "../types.ts";
import type { Segment } from "./routes/meetings.ts";

/**
 * Chatbot-ready transcript.
 *
 * Raw Whisper output is a poor prompt: `.json` costs ~7x the tokens of `.txt`
 * and carries confidences nobody asks about, while `.txt` throws away the
 * timing a chatbot needs to cite a moment. This format keeps the header the
 * model needs, merges Whisper's mid-sentence line breaks into paragraphs, and
 * stamps one time per paragraph instead of one per line.
 */
export interface AiExportOptions {
  /** Seconds of transcript merged into a single paragraph. */
  paragraphSeconds?: number;
  includeHeader?: boolean;
}

export const DEFAULT_PARAGRAPH_SECONDS = 60;

export function formatStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export interface Paragraph {
  start: number;
  speaker: string | null;
  text: string;
}

/**
 * Group segments into paragraphs. A paragraph breaks on a speaker change or
 * once it exceeds `paragraphSeconds`, so speaker turns are never merged.
 */
export function groupSegments(segments: Segment[], paragraphSeconds: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | null = null;

  for (const segment of segments) {
    const text = segment.text.trim();
    if (text === "") continue;
    const speakerChanged = current !== null && current.speaker !== (segment.speaker ?? null);
    const tooLong = current !== null && segment.start - current.start >= paragraphSeconds;

    if (current === null || speakerChanged || tooLong) {
      current = { start: segment.start, speaker: segment.speaker ?? null, text };
      paragraphs.push(current);
    } else {
      current.text = `${current.text} ${text}`;
    }
  }
  return paragraphs;
}

export function buildAiMarkdown(
  name: string,
  record: MeetingRecord | null,
  segments: Segment[],
  options: AiExportOptions = {},
): string {
  const paragraphSeconds = options.paragraphSeconds ?? DEFAULT_PARAGRAPH_SECONDS;
  const paragraphs = groupSegments(segments, paragraphSeconds);
  const duration = segments[segments.length - 1]?.end ?? 0;
  const lines: string[] = [];

  if (options.includeHeader !== false) {
    lines.push(`# Meeting: ${name}`, "");
    if (record) {
      const date = new Date(record.createdAt);
      lines.push(
        `- Date: ${date.toLocaleString("en-GB", { hour12: false })}`,
        `- Duration: ${formatStamp(duration)}`,
        `- Language: ${record.language}`,
      );
      if (record.attendees.length > 0) lines.push(`- Attendees: ${record.attendees.join(", ")}`);
      if (record.context.trim() !== "") lines.push(`- Context: ${record.context.trim()}`);
      if (record.terms.length > 0) lines.push(`- Glossary: ${record.terms.join(", ")}`);
    } else {
      lines.push(`- Duration: ${formatStamp(duration)}`);
    }
    lines.push("", "## Transcript", "");
  }

  for (const p of paragraphs) {
    const who = p.speaker ? `**${p.speaker}:** ` : "";
    lines.push(`[${formatStamp(p.start)}] ${who}${p.text}`, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** Same estimator as the prompt budget: deliberately conservative. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const words = trimmed.split(/\s+/).length;
  return Math.ceil(Math.max(words * 1.35, trimmed.length / 3.5));
}

/** Several meetings concatenated for a single chatbot conversation. */
export function buildCombinedMarkdown(
  parts: { name: string; record: MeetingRecord | null; segments: Segment[] }[],
  options: AiExportOptions = {},
): string {
  const header = [
    `# ${parts.length} meeting transcripts`,
    "",
    ...parts.map((p, i) => `${i + 1}. ${p.name}`),
    "",
    "---",
    "",
  ];
  const bodies = parts.map((p) => buildAiMarkdown(p.name, p.record, p.segments, options));
  return `${header.join("\n")}${bodies.join("\n---\n\n")}`;
}
