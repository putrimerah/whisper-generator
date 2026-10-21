import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, formatBytes } from "../api/client.ts";
import { Button, ErrorText, inputClass } from "./Ui.tsx";
import { Icon } from "./Icon.tsx";

/**
 * Server-side browser. The browser's own file input hides real paths and would
 * force an upload; listing directories server-side keeps the file where it is.
 */
export default function FilePicker({
  value,
  onPick,
  dirsOnly = false,
}: {
  value: string | null;
  onPick: (path: string) => void;
  dirsOnly?: boolean;
}) {
  const [tab, setTab] = useState<"browse" | "paste">("browse");
  const storageKey = dirsOnly ? "wg.lastOutDir" : "wg.lastDir";
  const [cwd, setCwd] = useState<string | null>(() => localStorage.getItem(storageKey));
  const [draft, setDraft] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const favorites = useQuery({ queryKey: ["favorites"], queryFn: api.favorites });

  // Open where the user left off; first run falls back to the recordings
  // folder reported by the server.
  useEffect(() => {
    if (cwd === null && favorites.data?.defaultPath) setCwd(favorites.data.defaultPath);
  }, [cwd, favorites.data]);

  useEffect(() => {
    if (cwd) localStorage.setItem(storageKey, cwd);
  }, [cwd, storageKey]);
  const listing = useQuery({
    queryKey: ["fs", cwd, dirsOnly],
    queryFn: () => api.listDir(cwd as string, dirsOnly),
    enabled: cwd !== null,
  });

  const submitPaste = async () => {
    setPasteError(null);
    try {
      const resolved = await api.resolvePath(draft);
      if (!resolved.exists) {
        setPasteError(`not found: ${resolved.path}`);
        return;
      }
      if (dirsOnly && !resolved.isDirectory) {
        setPasteError("that is a file, pick a folder");
        return;
      }
      if (!dirsOnly && resolved.isDirectory) {
        setCwd(resolved.path);
        setTab("browse");
        return;
      }
      if (!dirsOnly && !resolved.media) {
        setPasteError("not a media file");
        return;
      }
      onPick(resolved.path);
    } catch (err) {
      setPasteError((err as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 text-sm">
        {(["browse", "paste"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1 ${
              tab === t ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t === "browse" ? "Browse" : "Paste path"}
          </button>
        ))}
      </div>

      {tab === "paste" ? (
        <div className="space-y-2">
          <input
            className={inputClass}
            placeholder="C:\Users\you\Videos\meeting.mp4"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submitPaste()}
          />
          <p className="text-xs text-zinc-400">
            In Explorer: Shift+Right-click a file → “Copy as path”, then paste here.
          </p>
          <Button onClick={() => void submitPaste()}>Use this path</Button>
          <ErrorText>{pasteError}</ErrorText>
        </div>
      ) : (
        <div className="grid grid-cols-[13rem_1fr] gap-3">
          <aside className="space-y-1">
            {favorites.data?.favorites.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setCwd(f.path)}
                className={`block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm ${
                  cwd === f.path ? "bg-zinc-800 text-white" : "text-zinc-300 hover:bg-zinc-800/60"
                }`}
                title={f.path}
              >
                {f.label}
              </button>
            ))}
          </aside>

          <div className="rounded-lg border border-zinc-800">
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
              {listing.data?.parent && (
                <button
                  type="button"
                  className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800"
                  onClick={() => setCwd(listing.data?.parent ?? null)}
                >
                  <span className="flex items-center gap-1"><Icon name="arrowUp" className="h-3 w-3" />up</span>
                </button>
              )}
              <span className="truncate font-mono">
                {listing.data?.displayPath ?? "Pick a folder on the left"}
              </span>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {listing.isLoading && <p className="p-3 text-sm text-zinc-400">Loading…</p>}
              {listing.error && <p className="p-3 text-sm text-red-400">{(listing.error as Error).message}</p>}
              {listing.data?.entries.length === 0 && (
                <p className="p-3 text-sm text-zinc-500">Empty folder.</p>
              )}
              {listing.data?.entries.map((entry) => {
                const selectable = entry.type === "dir" || (dirsOnly ? false : entry.media === true);
                return (
                  <button
                    key={entry.path}
                    type="button"
                    disabled={!selectable}
                    onClick={() => (entry.type === "dir" ? setCwd(entry.path) : onPick(entry.path))}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                      value === entry.path ? "bg-indigo-600/20" : ""
                    } ${
                      selectable
                        ? "hover:bg-zinc-800/60"
                        : "cursor-not-allowed text-zinc-600"
                    }`}
                  >
                    {entry.type === "dir" ? (
                      <Icon name="folder" className="h-4 w-4 shrink-0 text-zinc-500" />
                    ) : entry.media ? (
                      <Icon name="film" className="h-4 w-4 shrink-0 text-indigo-300" />
                    ) : (
                      <Icon name="file" className="h-4 w-4 shrink-0 text-zinc-600" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    {entry.size !== undefined && (
                      <span className="text-xs text-zinc-500">{formatBytes(entry.size)}</span>
                    )}
                  </button>
                );
              })}
            </div>

            {dirsOnly && cwd && (
              <div className="border-t border-zinc-800 p-2">
                <Button variant="ghost" onClick={() => onPick(cwd)}>
                  Use this folder
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
