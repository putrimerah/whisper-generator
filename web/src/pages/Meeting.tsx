import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useRoute, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatCompact, formatDuration } from "../api/client.ts";
import type { MeetingDetail, Segment } from "../api/types.ts";
import { Icon, type IconName } from "../components/Icon.tsx";
import Player from "../components/Player.tsx";
import {
  Button, Card, Chip, Eyebrow, Menu, MenuDivider, MenuItem, buttonClass, inputClass, surfaceClass,
} from "../components/Ui.tsx";

/** Mirrors PROMPT_TOKEN_BUDGET in src/prompt.ts: Whisper keeps the last 224 tokens. */
const PROMPT_TOKEN_BUDGET = 224;
const MEETING_FILE = "meeting.json";
const termClass = "underline decoration-indigo-400/60 decoration-dotted decoration-2 underline-offset-4";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Underline glossary terms and mark the current search match. */
function renderText(text: string, terms: string[], filter: string): ReactNode {
  const needle = filter.trim();
  const alternatives = [
    ...(needle ? [escapeRegExp(needle)] : []),
    ...(terms.length > 0 ? [`\\b(?:${terms.map(escapeRegExp).join("|")})\\b`] : []),
  ];
  if (alternatives.length === 0) return text;
  const pattern = new RegExp(`(${alternatives.join("|")})`, "gi");
  return text.split(pattern).map((piece, i) => {
    if (i % 2 === 0) return piece;
    if (needle && piece.toLowerCase() === needle.toLowerCase()) {
      return <mark key={i} className="rounded bg-amber-400/25 px-0.5 text-amber-100">{piece}</mark>;
    }
    return <span key={i} className={termClass}>{piece}</span>;
  });
}

function languageLabel(code: string): string {
  if (code === "auto") return "Auto-detect";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time}`;
}

/** "NVIDIA GeForce RTX 4050 Laptop GPU" -> "RTX 4050 Laptop". */
function shortGpuName(name: string): string {
  return name.replace(/^NVIDIA\s+/i, "").replace(/^GeForce\s+/i, "").replace(/\s+GPU$/i, "");
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function downloadText(name: string, text: string, type = "text/markdown"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Index of the last segment that started at or before `t`, or -1. */
function segmentAt(starts: number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] ?? 0) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export default function Meeting() {
  const [, params] = useRoute("/library/:dir");
  const dir = params?.dir ? decodeURIComponent(params.dir) : "";
  const queryClient = useQueryClient();
  const audioRef = useRef<HTMLAudioElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastUserScroll = useRef(0);
  // ?t=SECONDS opens the meeting at that moment (Search results link here).
  const startAt = Math.max(0, Number(new URLSearchParams(useSearch()).get("t")) || 0);

  const meeting = useQuery({ queryKey: ["meeting", dir], queryFn: () => api.meeting(dir) });
  const transcript = useQuery({ queryKey: ["transcript", dir], queryFn: () => api.transcript(dir) });
  const config = useQuery({ queryKey: ["config"], queryFn: api.config });
  const ai = useQuery({ queryKey: ["ai", dir], queryFn: () => api.aiExport(dir) });
  const gpu = useQuery({ queryKey: ["gpu"], queryFn: api.gpu, staleTime: Infinity });

  const record = meeting.data?.record;
  const mediaPath = meeting.data?.media ?? null;
  const peaks = useQuery({
    queryKey: ["peaks", dir],
    queryFn: () => api.peaks(dir),
    enabled: mediaPath !== null,
    staleTime: Infinity,
    retry: false,
  });

  const segments = useMemo(() => transcript.data?.segments ?? [], [transcript.data]);
  const starts = useMemo(() => segments.map((s) => s.start), [segments]);
  const terms = record?.terms ?? [];

  const [filter, setFilter] = useState("");
  const shown = filter.trim() === ""
    ? segments
    : segments.filter((s) => s.text.toLowerCase().includes(filter.trim().toLowerCase()));

  // Playback position -> highlighted line. Only re-render when the line changes.
  const [activeId, setActiveId] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const onTime = useCallback((t: number) => {
    const idx = segmentAt(starts, t);
    const id = idx >= 0 ? segments[idx]?.id ?? null : null;
    setActiveId((prev) => (prev === id ? prev : id));
  }, [starts, segments]);

  // Follow the playing line, unless the user scrolled in the last few seconds.
  useEffect(() => {
    if (!playing || activeId === null) return;
    if (Date.now() - lastUserScroll.current < 4000) return;
    const box = listRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-seg="${activeId}"]`);
    if (!box || !row) return;
    const top = row.offsetTop;
    const visible = top >= box.scrollTop + 24 && top + row.offsetHeight <= box.scrollTop + box.clientHeight - 56;
    if (!visible) box.scrollTo({ top: top - box.clientHeight * 0.35, behavior: "smooth" });
  }, [activeId, playing]);

  // Land on the deep-linked line once the transcript is in.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || startAt === 0 || segments.length === 0) return;
    landed.current = true;
    onTime(startAt);
    const id = segments[segmentAt(starts, startAt)]?.id;
    requestAnimationFrame(() => {
      const box = listRef.current;
      const row = box?.querySelector<HTMLElement>(`[data-seg="${id}"]`);
      if (box && row) box.scrollTop = row.offsetTop - box.clientHeight * 0.35;
    });
  }, [segments, starts, startAt, onTime]);

  const seek = (seconds: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = seconds;
    onTime(seconds);
    void a.play().catch(() => undefined);
  };

  // "Add to glossary" from a text selection inside the transcript.
  const [selection, setSelection] = useState("");
  const [savedTerm, setSavedTerm] = useState<string | null>(null);
  const addTerm = useMutation({
    mutationFn: (term: string) => api.saveConfig({ terms: [...(config.data?.config.terms ?? []), term] }),
    onSuccess: (_, term) => {
      setSavedTerm(term);
      setSelection("");
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const [copied, setCopied] = useState(false);
  const copyForAi = async () => {
    const data = ai.data ?? (await api.aiExport(dir));
    await navigator.clipboard.writeText(data.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const downloadAi = async () => {
    const data = ai.data ?? (await api.aiExport(dir));
    downloadText(`${dir}.ai.md`, data.markdown);
  };
  const copyPlain = () => {
    void navigator.clipboard.writeText(segments.map((s) => s.text).join("\n"));
  };

  if (meeting.error) {
    return (
      <Card>
        <p className="text-sm text-red-400">{(meeting.error as Error).message}</p>
        <Link href="/library" className="mt-3 inline-block text-sm text-indigo-300">Back to Library</Link>
      </Card>
    );
  }

  const files = meeting.data?.files ?? [];
  const duration = peaks.data?.duration ?? transcript.data?.duration ?? 0;

  const meta: [IconName, string][] = record
    ? [
        ["calendar", formatWhen(record.createdAt)],
        ["clock", formatDuration(duration)],
        ["cpu", record.model],
        ["globe", languageLabel(record.language)],
        ["file", basename(record.input)],
      ]
    : [];

  return (
    <div>
      <Link href="/library" className="inline-flex items-center gap-1 text-sm text-zinc-500 transition hover:text-zinc-200">
        <Icon name="chevronLeft" className="h-3.5 w-3.5" />Library
      </Link>

      <div className="mt-2 flex items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="truncate text-[28px] font-semibold leading-tight tracking-tight">{dir}</h1>
          {record?.context && <p className="mt-1 text-[15px] text-zinc-400">{record.context}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500">
            {meta.map(([icon, text]) => (
              <span key={icon} className="tnum flex items-center gap-1.5">
                <Icon name={icon} className="h-4 w-4 text-zinc-600" />{text}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Menu label="Export" icon="download">
            <MenuItem icon="file" onClick={() => void downloadAi()} hint=".md">AI Markdown</MenuItem>
            <MenuItem icon="download" href={api.zipUrl(dir)} hint=".zip">Everything</MenuItem>
            <MenuItem icon="copy" onClick={copyPlain}>Copy plain text</MenuItem>
            {files.length > 0 && <MenuDivider />}
            {files.map((f) => (
              <MenuItem key={f.name} href={api.fileUrl(dir, f.name)} hint={f.name.split(".").pop()}>
                {f.name}
              </MenuItem>
            ))}
          </Menu>
          <Button icon={copied ? "check" : "sparkles"} onClick={() => void copyForAi()}>
            {copied ? "Copied" : "Copy for AI"}
          </Button>
        </div>
      </div>

      <div className="mt-5">
        <Player
          src={mediaPath ? api.mediaUrl(mediaPath) : null}
          peaks={peaks.data?.peaks ?? null}
          fallbackDuration={duration}
          audioRef={audioRef}
          onTime={onTime}
          onPlayingChange={setPlaying}
          initialTime={startAt}
        />
      </div>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_340px] items-start gap-5">
        <section className={`overflow-hidden ${surfaceClass}`}>
          <header className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-3">
            <h2 className="text-sm font-semibold">Transcript</h2>
            <span className="tnum rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-zinc-400">
              {filter.trim() ? `${shown.length} of ${segments.length}` : `${segments.length} segments`}
            </span>
            <label className="ml-auto flex h-8 w-60 items-center gap-2 rounded-lg bg-black/30 px-3 text-sm ring-1 ring-inset ring-white/[0.06] focus-within:ring-indigo-500/60">
              <Icon name="search" className="h-4 w-4 shrink-0 text-zinc-500" />
              <input
                className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500"
                placeholder="Find in transcript"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
          </header>

          {(selection || savedTerm) && (
            <div className="flex items-center gap-3 border-b border-white/[0.06] bg-indigo-500/[0.06] px-5 py-2.5 text-sm">
              {selection ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-zinc-300">
                    Add <span className="font-medium text-white">“{selection}”</span> to the glossary for future runs?
                  </span>
                  <Button onClick={() => addTerm.mutate(selection)} disabled={addTerm.isPending}>Add term</Button>
                  <Button variant="ghost" onClick={() => setSelection("")}>Dismiss</Button>
                </>
              ) : (
                <span className="flex items-center gap-2 text-emerald-300">
                  <Icon name="check" />Added “{savedTerm}” to the glossary.
                </span>
              )}
            </div>
          )}

          <div
            ref={listRef}
            className="fade-y relative h-[max(360px,calc(100vh_-_430px))] overflow-y-auto px-3 py-2"
            onWheel={() => { lastUserScroll.current = Date.now(); }}
            onTouchMove={() => { lastUserScroll.current = Date.now(); }}
            onMouseUp={() => {
              const text = window.getSelection()?.toString().trim() ?? "";
              if (text !== "" && text.length < 60 && !text.includes("\n")) {
                setSavedTerm(null);
                setSelection(text);
              }
            }}
          >
            {transcript.isLoading && <p className="px-3 py-4 text-sm text-zinc-500">Loading transcript…</p>}
            {!transcript.isLoading && shown.length === 0 && (
              <p className="px-3 py-4 text-sm text-zinc-500">
                {filter.trim() ? "No line matches." : "This transcript is empty."}
              </p>
            )}
            {shown.map((s) => (
              <TranscriptRow
                key={s.id}
                segment={s}
                active={s.id === activeId}
                playing={playing}
                content={renderText(s.text, terms, filter)}
                onSeek={() => seek(s.start)}
              />
            ))}
            <div className="h-10" />
          </div>
        </section>

        <aside className="space-y-3">
          <AiCard tokens={ai.data?.tokens ?? null} markdown={ai.data?.markdown ?? null} files={files} />
          {record && <HintsCard attendees={record.attendees} terms={record.terms} tokens={record.promptTokens} />}
          <SpeakersCard dir={dir} segments={segments} />
          <section className={`flex items-center gap-3 px-4 py-3 ${surfaceClass}`}>
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
              <Icon name="lock" />
            </span>
            <div className="min-w-0 text-sm">
              <p className="font-medium text-zinc-200">Transcribed on this machine</p>
              <p className="mt-0.5 truncate text-zinc-500">
                {gpu.data?.gpu ? shortGpuName(gpu.data.gpu.name) : "CPU"} · nothing uploaded
              </p>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function TranscriptRow({
  segment, active, playing, content, onSeek,
}: { segment: Segment; active: boolean; playing: boolean; content: ReactNode; onSeek: () => void }) {
  return (
    <div
      data-seg={segment.id}
      onClick={() => {
        // Selecting text for the glossary must not jump the audio.
        if (window.getSelection()?.toString()) return;
        onSeek();
      }}
      className={`group grid cursor-pointer grid-cols-[52px_1fr] items-baseline gap-4 rounded-lg px-3 py-2 transition-colors ${
        active ? "bg-indigo-500/[0.12] ring-1 ring-inset ring-indigo-400/30" : "hover:bg-white/[0.03]"
      }`}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onSeek(); }}
        className={`tnum text-right font-mono text-xs ${active ? "text-indigo-300" : "text-zinc-500 group-hover:text-zinc-300"}`}
      >
        {formatDuration(segment.start)}
      </button>
      <p className={`text-[15px] leading-relaxed ${active ? "text-white" : "text-zinc-300"}`}>
        {segment.speaker && <span className="mr-2 text-xs font-semibold text-amber-300/90">{segment.speaker}</span>}
        {content}
        {active && playing && (
          <span className="ml-2 inline-flex h-3 items-end gap-[2px] align-middle" aria-hidden="true">
            <span className="h-2 w-[3px] animate-pulse rounded-full bg-indigo-300" />
            <span className="h-3 w-[3px] animate-pulse rounded-full bg-indigo-300 [animation-delay:150ms]" />
            <span className="h-1.5 w-[3px] animate-pulse rounded-full bg-indigo-300 [animation-delay:300ms]" />
          </span>
        )}
      </p>
    </div>
  );
}

/**
 * What this transcript costs in a chatbot, per format. Ratios come from the
 * real file sizes, relative to the plain .txt.
 */
function AiCard({
  tokens, markdown, files,
}: { tokens: number | null; markdown: string | null; files: MeetingDetail["files"] }) {
  const sizeOf = (ext: string) => files.find((f) => f.name.endsWith(ext) && f.name !== MEETING_FILE)?.bytes;
  const aiBytes = markdown === null ? undefined : new TextEncoder().encode(markdown).length;
  const txt = sizeOf(".txt");
  const base = txt ?? sizeOf(".srt") ?? aiBytes;
  const rows = [
    { label: "AI .md", bytes: aiBytes, best: true },
    { label: ".txt", bytes: txt, best: false },
    { label: ".srt", bytes: sizeOf(".srt"), best: false },
    { label: ".json", bytes: sizeOf(".json"), best: false },
  ].filter((r): r is { label: string; bytes: number; best: boolean } => r.bytes !== undefined && r.bytes > 0);
  const ratios = rows.map((r) => (base ? r.bytes / base : 1));
  const max = Math.max(1, ...ratios);

  return (
    <section className="rounded-2xl bg-gradient-to-b from-indigo-500/[0.14] to-zinc-900/40 px-5 py-4 ring-1 ring-inset ring-indigo-400/20">
      <div className="flex items-center gap-2 text-sm font-medium text-indigo-200">
        <Icon name="sparkles" />AI export
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="tnum text-[32px] font-semibold leading-none tracking-tight">
          {tokens === null ? "…" : formatCompact(tokens)}
        </span>
        <span className="text-sm text-zinc-400">tokens</span>
      </div>
      <p className="mt-1.5 text-sm text-zinc-400">Includes timestamps. About the same size as the .txt.</p>
      {rows.length > 1 && (
        <div className="mt-4 space-y-2.5">
          {rows.map((r, i) => (
            <div key={r.label} className="grid grid-cols-[56px_1fr_44px] items-center gap-3 text-xs">
              <span className={`font-mono ${r.best ? "text-indigo-200" : "text-zinc-400"}`}>{r.label}</span>
              <span className="h-2 rounded-full bg-white/[0.05]">
                <span
                  className={`block h-full rounded-full ${r.best ? "bg-gradient-to-r from-indigo-500 to-violet-400" : "bg-zinc-600"}`}
                  style={{ width: `${((ratios[i] ?? 1) / max) * 100}%` }}
                />
              </span>
              <span className={`tnum text-right ${r.best ? "font-semibold text-indigo-200" : "text-zinc-500"}`}>
                {(ratios[i] ?? 1).toFixed(1)}×
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** The attendees and glossary that went into Whisper's prompt for this run. */
function HintsCard({ attendees, terms, tokens }: { attendees: string[]; terms: string[]; tokens: number }) {
  return (
    <section className={`px-5 py-4 ${surfaceClass}`}>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Spelling hints</h2>
        <span className="tnum font-mono text-xs text-zinc-500">{tokens} / {PROMPT_TOKEN_BUDGET} tokens</span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">Given to Whisper so these get spelled right.</p>
      {attendees.length === 0 && terms.length === 0 && (
        <p className="mt-3 text-sm text-zinc-500">No names or terms were given for this run.</p>
      )}
      {attendees.length > 0 && (
        <>
          <div className="mt-3.5"><Eyebrow>Attendees</Eyebrow></div>
          <div className="mt-2 flex flex-wrap gap-1.5">{attendees.map((a) => <Chip key={a}>{a}</Chip>)}</div>
        </>
      )}
      {terms.length > 0 && (
        <>
          <div className="mt-3.5"><Eyebrow>Glossary</Eyebrow></div>
          <div className="mt-2 flex flex-wrap gap-1.5">{terms.map((t) => <Chip key={t} tone="accent">{t}</Chip>)}</div>
        </>
      )}
    </section>
  );
}

/** Only shown when diarization produced speaker labels. */
function SpeakersCard({ dir, segments }: { dir: string; segments: Segment[] }) {
  const queryClient = useQueryClient();
  const labels = useMemo(() => {
    const set = new Set<string>();
    for (const s of segments) if (s.speaker) set.add(s.speaker);
    return [...set];
  }, [segments]);
  const [names, setNames] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => api.saveSpeakers(dir, names),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["transcript", dir] }),
  });
  if (labels.length === 0) return null;

  return (
    <section className={`px-5 py-4 ${surfaceClass}`}>
      <h2 className="text-sm font-semibold">Speakers</h2>
      <div className="mt-3 space-y-2">
        {labels.map((label) => (
          <label key={label} className="grid grid-cols-[90px_1fr] items-center gap-3">
            <span className="truncate font-mono text-xs text-zinc-500">{label}</span>
            <input
              className={inputClass}
              placeholder="Real name"
              value={names[label] ?? ""}
              onChange={(e) => setNames({ ...names, [label]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="mt-3">
        <button type="button" className={buttonClass("ghost")} onClick={() => save.mutate()} disabled={save.isPending}>
          Save names
        </button>
      </div>
    </section>
  );
}
