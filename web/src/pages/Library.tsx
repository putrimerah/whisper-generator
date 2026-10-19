import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatBytes } from "../api/client.ts";
import { Button, Card, inputClass } from "../components/Ui.tsx";

export default function Library() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const meetings = useQuery({ queryKey: ["meetings", query], queryFn: () => api.meetings(query) });

  const toggle = (dir: string) =>
    setSelected((prev) => (prev.includes(dir) ? prev.filter((d) => d !== dir) : [...prev, dir]));

  // One prompt covering several meetings: "summarise my week".
  const exportSelected = async (copy: boolean) => {
    const { markdown, tokens, meetings: count } = await api.aiExportMany(selected);
    if (copy) {
      await navigator.clipboard.writeText(markdown);
      setInfo(`Copied ${count} meeting(s), ~${tokens.toLocaleString()} tokens.`);
      return;
    }
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `meetings-${count}.ai.md`;
    a.click();
    URL.revokeObjectURL(url);
    setInfo(`Downloaded ${count} meeting(s), ~${tokens.toLocaleString()} tokens.`);
  };

  return (
    <div className="space-y-4">
      <input
        className={inputClass}
        placeholder="Filter by name, attendee, term or context…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {selected.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-indigo-800 bg-indigo-950/30 p-3">
          <span className="text-sm">{selected.length} selected</span>
          <Button onClick={() => void exportSelected(true)}>Copy for AI</Button>
          <Button variant="ghost" onClick={() => void exportSelected(false)}>Download .md</Button>
          <Button variant="ghost" onClick={() => setSelected([])}>Clear</Button>
          {info && <span className="text-xs text-emerald-300">{info}</span>}
        </div>
      )}

      {meetings.data?.meetings.length === 0 && (
        <Card><p className="text-sm text-slate-400">No transcripts yet.</p></Card>
      )}
      <div className="grid grid-cols-2 gap-4">
        {meetings.data?.meetings.map((m) => (
          <div
            key={m.dir}
            className={`rounded-xl border bg-slate-900/50 p-4 ${
              selected.includes(m.dir) ? "border-indigo-500" : "border-slate-800"
            }`}
          >
            <label className="mb-2 flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={selected.includes(m.dir)}
                onChange={() => toggle(m.dir)}
              />
              select for AI export
            </label>
            <Link href={`/library/${encodeURIComponent(m.dir)}`}>
            <a className="block hover:text-indigo-300">
              <p className="truncate font-medium">{m.dir}</p>
              <p className="mt-1 text-xs text-slate-400">
                {new Date(m.record.createdAt).toLocaleString()} · {m.record.model}
              </p>
              {m.record.attendees.length > 0 && (
                <p className="mt-2 truncate text-sm text-slate-300">{m.record.attendees.join(", ")}</p>
              )}
              {m.record.context && (
                <p className="mt-1 line-clamp-2 text-xs text-slate-400">{m.record.context}</p>
              )}
              <p className="mt-2 text-xs text-slate-500">
                {m.outputs.length} files · {formatBytes(m.sizeBytes)}
              </p>
            </a>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
