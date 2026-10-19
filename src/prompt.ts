/**
 * Whisper's decoder keeps only the LAST 224 tokens of `initial_prompt`
 * (`model.dims.n_text_ctx // 2 - 1`). Anything earlier is dropped silently.
 *
 * So the builder:
 *   1. orders sections by priority, lowest first, highest LAST;
 *   2. drops/trims from the FRONT when over budget;
 *   3. never truncates mid-word.
 *
 * Priority, lowest to highest: lead < context < participants < glossary.
 * Names and jargon are what the prompt is actually for, so they survive.
 */
export const PROMPT_TOKEN_BUDGET = 224;

const LEAD = "The following is a verbatim transcript of a business meeting.";

export interface PromptInput {
  context?: string;
  attendees?: string[];
  terms?: string[];
  /** Override the lead sentence. */
  lead?: string;
  budget?: number;
}

export interface PromptResult {
  prompt: string;
  tokens: number;
  truncated: boolean;
  /** Sections that did not fit, for user-visible warnings. */
  dropped: string[];
}

/**
 * Conservative token estimate for Whisper's multilingual BPE.
 * Real tokenizer needs the vocab file; over-estimating costs a few words,
 * under-estimating silently loses the lead of the prompt. So: over-estimate.
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const words = trimmed.split(/\s+/).length;
  const chars = trimmed.length;
  return Math.ceil(Math.max(words * 1.35, chars / 3.5));
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t === "") return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function list(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (v === "") continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function buildPrompt(input: PromptInput): PromptResult {
  const budget = input.budget ?? PROMPT_TOKEN_BUDGET;
  const attendees = list(input.attendees ?? []);
  const terms = list(input.terms ?? []);

  const sections: { name: string; text: string }[] = [];
  const lead = sentence(input.lead ?? LEAD);
  if (lead) sections.push({ name: "lead", text: lead });
  const ctx = sentence(input.context ?? "");
  if (ctx) sections.push({ name: "context", text: ctx });
  if (attendees.length > 0) {
    sections.push({ name: "participants", text: `Participants: ${attendees.join(", ")}.` });
  }
  if (terms.length > 0) {
    sections.push({ name: "glossary", text: `Terms used: ${terms.join(", ")}.` });
  }

  const dropped: string[] = [];
  const kept = [...sections];

  const render = (parts: typeof sections): string => parts.map((p) => p.text).join(" ");

  // Drop whole low-priority sections first, front to back.
  while (kept.length > 1 && estimateTokens(render(kept)) > budget) {
    const removed = kept.shift();
    if (removed) dropped.push(removed.name);
  }

  // Single remaining section still too long: trim its front on word boundaries.
  let prompt = render(kept);
  let truncated = dropped.length > 0;
  if (estimateTokens(prompt) > budget) {
    truncated = true;
    const words = prompt.split(/\s+/);
    while (words.length > 1 && estimateTokens(words.join(" ")) > budget) words.shift();
    prompt = words.join(" ");
  }

  return { prompt, tokens: estimateTokens(prompt), truncated, dropped: dropped.reverse() };
}
