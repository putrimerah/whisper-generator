import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatDuration } from "../api/client.ts";
import { Card, inputClass } from "../components/Ui.tsx";

/** P4: full-text search across every transcript. */
export default function Search() {
  const [query, setQuery] = useState("");
  const results = useQuery({
    queryKey: ["search", query],
    queryFn: () => api.search(query),
    enabled: query.trim().length > 1,
  });

  return (
    <div className="space-y-4">
      <input
        className={inputClass}
        placeholder="Search every transcript…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.data?.results.length === 0 && query.length > 1 && (
        <Card><p className="text-sm text-slate-400">No matches.</p></Card>
      )}
      {results.data?.results.map((r) => (
        <Card key={r.dir} title={r.dir}>
          <div className="space-y-1">
            {r.matches.map((m, i) => (
              <div key={i} className="flex gap-3 text-sm">
                <span className="font-mono text-xs text-indigo-400">{formatDuration(m.start)}</span>
                <p className="text-slate-300">{m.text}</p>
              </div>
            ))}
          </div>
          <div className="mt-3">
            <Link href={`/library/${encodeURIComponent(r.dir)}`}>
              <a className="text-sm text-indigo-400 hover:text-indigo-300">Open meeting →</a>
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}
