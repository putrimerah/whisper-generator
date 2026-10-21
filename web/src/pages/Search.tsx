import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { api, formatDuration } from "../api/client.ts";
import { Card, inputClass } from "../components/Ui.tsx";

/** P4: full-text search across every transcript. */
export default function Search() {
  // The header search box lands here with ?q=.
  const fromUrl = new URLSearchParams(useSearch()).get("q") ?? "";
  const [query, setQuery] = useState(fromUrl);
  useEffect(() => setQuery(fromUrl), [fromUrl]);
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
        <Card><p className="text-sm text-zinc-400">No matches.</p></Card>
      )}
      {results.data?.results.map((r) => (
        <Card key={r.dir} title={r.dir}>
          <div className="space-y-1">
            {r.matches.map((m, i) => (
              <Link
                key={i}
                href={`/library/${encodeURIComponent(r.dir)}?t=${Math.floor(m.start)}`}
                className="-mx-2 flex gap-3 rounded-md px-2 py-1 text-sm hover:bg-white/[0.04]"
              >
                <span className="tnum w-12 shrink-0 text-right font-mono text-xs leading-5 text-indigo-300">{formatDuration(m.start)}</span>
                <p className="text-zinc-300">{m.text}</p>
              </Link>
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
