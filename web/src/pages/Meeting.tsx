import { useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, formatDuration } from "../api/client.ts";
import { Button, Card, inputClass } from "../components/Ui.tsx";

export default function Meeting() {
  const [, params] = useRoute("/library/:dir");
  const dir = params?.dir ? decodeURIComponent(params.dir) : "";
  const queryClient = useQueryClient();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const meeting = useQuery({ queryKey: ["meeting", dir], queryFn: () => api.meeting(dir) });
  const transcript = useQuery({ queryKey: ["transcript", dir], queryFn: () => api.transcript(dir) });
  const config = useQuery({ queryKey: ["config"], queryFn: api.config });

  const addTerm = useMutation({
    mutationFn: (term: string) =>
      api.saveConfig({ terms: [...(config.data?.config.terms ?? []), term] }),
    onSuccess: (_, term) => {
      setSaved(term);
      setSelection("");
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const speakerLabels = useMemo(() => {
    const set = new Set<string>();
    for (const s of transcript.data?.segments ?? []) if (s.speaker) set.add(s.speaker);
    return [...set];
  }, [transcript.data]);

  const [speakers, setSpeakers] = useState<Record<string, string>>({});
  const saveSpeakers = useMutation({
    mutationFn: () => api.saveSpeakers(dir, speakers),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["transcript", dir] }),
  });

  const record = meeting.data?.record;
  const mediaPath = record?.audio ?? record?.input ?? "";
  const segments = (transcript.data?.segments ?? []).filter((s) =>
    filter === "" ? true : s.text.toLowerCase().includes(filter.toLowerCase()),
  );

  const seek = (seconds: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = seconds;
    void audioRef.current.play();
  };

  const copyAll = () => {
    const text = (transcript.data?.segments ?? []).map((s) => s.text).join("\n");
    void navigator.clipboard.writeText(text);
  };

  // Chatbot-ready export: header + minute-stamped paragraphs. Cheaper than
  // srt, and unlike txt it keeps timing so the bot can cite a moment.
  const [aiInfo, setAiInfo] = useState<{ tokens: number } | null>(null);

  const copyForAi = async () => {
    const { markdown, tokens } = await api.aiExport(dir);
    await navigator.clipboard.writeText(markdown);
    setAiInfo({ tokens });
  };

  const downloadAi = async () => {
    const { markdown, tokens } = await api.aiExport(dir);
    setAiInfo({ tokens });
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${dir}.ai.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card title={dir} actions={
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void copyForAi()}>Copy for AI</Button>
          <Button variant="ghost" onClick={() => void downloadAi()}>Download .md</Button>
          <a
            href={api.zipUrl(dir)}
            className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm hover:bg-slate-800"
          >
            Download all (.zip)
          </a>
          <Button variant="ghost" onClick={copyAll}>Copy plain text</Button>
        </div>
      }>
        {record && (
          <dl className="grid grid-cols-4 gap-4 text-sm">
            <div><dt className="text-xs text-slate-400">Date</dt><dd>{new Date(record.createdAt).toLocaleString()}</dd></div>
            <div><dt className="text-xs text-slate-400">Model</dt><dd>{record.model} / {record.language}</dd></div>
            <div><dt className="text-xs text-slate-400">Attendees</dt><dd>{record.attendees.join(", ") || "—"}</dd></div>
            <div><dt className="text-xs text-slate-400">Terms</dt><dd>{record.terms.join(", ") || "—"}</dd></div>
          </dl>
        )}
        {record?.context && <p className="mt-3 text-sm text-slate-300">{record.context}</p>}
        {aiInfo && (
          <p className="mt-3 text-xs text-emerald-300">
            AI export ready: ~{aiInfo.tokens.toLocaleString()} tokens. Paste it into your chatbot
            and ask for a summary, decisions, or action items.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {meeting.data?.outputs.map((name) => (
            <a
              key={name}
              href={api.fileUrl(dir, name)}
              className="rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800"
            >
              ↓ {name}
            </a>
          ))}
        </div>
      </Card>

      {mediaPath && (
        <audio ref={audioRef} controls className="w-full" src={api.mediaUrl(mediaPath)} />
      )}

      {speakerLabels.length > 0 && (
        <Card title="Speakers">
          <div className="grid grid-cols-3 gap-3">
            {speakerLabels.map((label) => (
              <label key={label} className="space-y-1">
                <span className="text-xs text-slate-400">{label}</span>
                <input
                  className={inputClass}
                  placeholder="real name"
                  value={speakers[label] ?? ""}
                  onChange={(e) => setSpeakers({ ...speakers, [label]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <div className="mt-3">
            <Button onClick={() => saveSpeakers.mutate()}>Save speaker names</Button>
          </div>
        </Card>
      )}

      <Card
        title={`Transcript · ${segments.length} segments`}
        actions={
          <input
            className={`${inputClass} w-64`}
            placeholder="Search in transcript…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
      >
        {selection && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-indigo-700 bg-indigo-950/40 p-3 text-sm">
            <span>Add “{selection}” to the glossary?</span>
            <Button onClick={() => addTerm.mutate(selection)}>Add term</Button>
            <Button variant="ghost" onClick={() => setSelection("")}>Dismiss</Button>
          </div>
        )}
        {saved && <p className="mb-3 text-xs text-emerald-300">Added “{saved}” to the glossary.</p>}

        <div
          className="max-h-[32rem] space-y-1 overflow-y-auto"
          onMouseUp={() => {
            const text = window.getSelection()?.toString().trim() ?? "";
            if (text !== "" && text.length < 60) setSelection(text);
          }}
        >
          {segments.map((s) => (
            <div key={s.id} className="flex gap-3 rounded-md px-2 py-1 hover:bg-slate-800/50">
              <button
                type="button"
                onClick={() => seek(s.start)}
                className="shrink-0 font-mono text-xs text-indigo-400 hover:text-indigo-300"
              >
                {formatDuration(s.start)}
              </button>
              {s.speaker && <span className="shrink-0 text-xs text-amber-300">{s.speaker}</span>}
              <p className="text-sm text-slate-200">{s.text}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
