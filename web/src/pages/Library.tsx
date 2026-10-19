import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatBytes } from "../api/client.ts";
import { Card, inputClass } from "../components/Ui.tsx";

export default function Library() {
  const [query, setQuery] = useState("");
  const meetings = useQuery({ queryKey: ["meetings", query], queryFn: () => api.meetings(query) });

  return (
    <div className="space-y-4">
      <input
        className={inputClass}
        placeholder="Filter by name, attendee, term or context…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {meetings.data?.meetings.length === 0 && (
        <Card><p className="text-sm text-slate-400">No transcripts yet.</p></Card>
      )}
      <div className="grid grid-cols-2 gap-4">
        {meetings.data?.meetings.map((m) => (
          <Link key={m.dir} href={`/library/${encodeURIComponent(m.dir)}`}>
            <a className="block rounded-xl border border-slate-800 bg-slate-900/50 p-4 hover:border-indigo-600">
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
        ))}
      </div>
    </div>
  );
}
