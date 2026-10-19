import type {
  Check, Config, DirListing, DiskReport, Favorite, Job, MeetingSummary,
  ProbeResult, PromptResult, ResolvedPath, SearchResult, Segment,
} from "./types.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text === "" ? null : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const err = body as { error?: { message?: string; code?: string } } | null;
    const message = err?.error?.message ?? `request failed: ${res.status}`;
    throw Object.assign(new Error(message), { code: err?.error?.code });
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/health"),

  favorites: () =>
    request<{ favorites: Favorite[]; defaultPath: string | null }>("/api/fs/favorites"),
  listDir: (path: string, dirsOnly = false) =>
    request<DirListing>(`/api/fs?path=${encodeURIComponent(path)}&dirsOnly=${dirsOnly}`),
  resolvePath: (path: string) =>
    request<ResolvedPath>("/api/fs/resolve", { method: "POST", body: JSON.stringify({ path }) }),

  probe: (path: string) => request<ProbeResult>(`/api/probe?path=${encodeURIComponent(path)}`),

  prompt: (input: { context: string; attendees: string[]; terms: string[] }) =>
    request<PromptResult>("/api/prompt", { method: "POST", body: JSON.stringify(input) }),

  config: () => request<{ config: Config; defaults: Config }>("/api/config"),
  saveConfig: (patch: Partial<Config>) =>
    request<{ config: Config; source: string }>("/api/config", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  doctor: () => request<{ checks: Check[] }>("/api/doctor"),
  disk: () => request<DiskReport>("/api/disk"),

  jobs: () => request<{ jobs: Job[] }>("/api/jobs"),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  createJob: (body: Record<string, unknown>) =>
    request<Job>("/api/jobs", { method: "POST", body: JSON.stringify(body) }),
  cancelJob: (id: string) => request<unknown>(`/api/jobs/${id}`, { method: "DELETE" }),
  retryJob: (id: string) => request<Job>(`/api/jobs/${id}/retry`, { method: "POST" }),

  meetings: (q = "") => request<{ meetings: MeetingSummary[] }>(`/api/meetings?q=${encodeURIComponent(q)}`),
  meeting: (dir: string) => request<MeetingSummary>(`/api/meetings/${encodeURIComponent(dir)}`),
  transcript: (dir: string) =>
    request<{ segments: Segment[]; language: string | null; duration: number }>(
      `/api/meetings/${encodeURIComponent(dir)}/transcript`,
    ),
  saveSpeakers: (dir: string, speakers: Record<string, string>) =>
    request<{ speakers: Record<string, string> }>(
      `/api/meetings/${encodeURIComponent(dir)}/speakers`,
      { method: "PUT", body: JSON.stringify({ speakers }) },
    ),
  aiExport: (dir: string) =>
    request<{ markdown: string; tokens: number; segments: number }>(
      `/api/meetings/${encodeURIComponent(dir)}/ai`,
    ),
  aiExportMany: (dirs: string[]) =>
    request<{ markdown: string; tokens: number; meetings: number }>("/api/export/ai", {
      method: "POST",
      body: JSON.stringify({ dirs }),
    }),
  zipUrl: (dir: string) => `/api/meetings/${encodeURIComponent(dir)}/zip`,
  search: (q: string) => request<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}`),

  mediaUrl: (path: string) => `/api/media?path=${encodeURIComponent(path)}`,
  fileUrl: (dir: string, name: string) =>
    `/api/meetings/${encodeURIComponent(dir)}/file/${encodeURIComponent(name)}`,
};

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
