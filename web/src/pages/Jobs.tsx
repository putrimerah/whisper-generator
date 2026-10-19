import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useState } from "react";
import { api, formatDuration } from "../api/client.ts";
import { useJobStream } from "../hooks/useJobStream.ts";
import { Button, Card } from "../components/Ui.tsx";
import type { Job, JobState } from "../api/types.ts";

const BADGE: Record<JobState, string> = {
  queued: "bg-slate-700 text-slate-200",
  extracting: "bg-blue-600/30 text-blue-200",
  transcribing: "bg-indigo-600/30 text-indigo-200",
  verifying: "bg-amber-600/30 text-amber-200",
  cleaning: "bg-amber-600/20 text-amber-200",
  done: "bg-emerald-600/30 text-emerald-200",
  failed: "bg-red-600/30 text-red-200",
  cancelled: "bg-slate-600/30 text-slate-300",
};

const TERMINAL: JobState[] = ["done", "failed", "cancelled"];

export default function Jobs() {
  const queryClient = useQueryClient();
  const jobs = useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: 2000 });
  const active = jobs.data?.jobs.find((j) => !TERMINAL.includes(j.state));
  useJobStream(active?.id ?? null, Boolean(active));

  const cancel = useMutation({
    mutationFn: api.cancelJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });
  const retry = useMutation({
    mutationFn: api.retryJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  });

  if (jobs.data?.jobs.length === 0) {
    return <Card><p className="text-sm text-slate-400">No jobs yet. Start one from “New run”.</p></Card>;
  }

  return (
    <div className="space-y-4">
      {jobs.data?.jobs.map((job) => (
        <JobCard
          key={job.id}
          job={job}
          onCancel={() => cancel.mutate(job.id)}
          onRetry={() => retry.mutate(job.id)}
        />
      ))}
    </div>
  );
}

function JobCard({ job, onCancel, onRetry }: { job: Job; onCancel: () => void; onRetry: () => void }) {
  const [showLog, setShowLog] = useState(false);
  const terminal = TERMINAL.includes(job.state);
  const name = job.input.split("/").pop();
  const dir = job.outDir.split("/").filter(Boolean).pop() ?? "";
  const percent = job.progress?.percent ?? (job.state === "done" ? 100 : 0);

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${BADGE[job.state]}`}>
              {job.state}
            </span>
            <span className="truncate font-medium">{name}</span>
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full transition-all ${job.state === "failed" ? "bg-red-500" : "bg-indigo-500"}`}
              style={{ width: `${percent}%` }}
            />
          </div>

          <div className="mt-2 flex gap-4 text-xs text-slate-400">
            <span>{percent}%</span>
            {job.progress && (
              <span>
                {formatDuration(job.progress.processedSeconds)} / {formatDuration(job.progress.totalSeconds)}
              </span>
            )}
            <span>ETA {job.progress?.etaSeconds != null ? formatDuration(job.progress.etaSeconds) : "—"}</span>
            {job.wordTimestampFallback && <span className="text-amber-300">word timings skipped</span>}
          </div>

          {job.state === "done" && (
            <p className="mt-2 text-xs text-slate-400">
              {job.outputs.join(", ")} ·{" "}
              {job.audioPath ? `Audio kept: ${job.audioPath}` : "Temporary audio deleted"}
            </p>
          )}
          {job.error && <p className="mt-2 text-sm text-red-400">{job.error.message}</p>}
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          {!terminal && <Button variant="danger" onClick={onCancel}>Cancel</Button>}
          {(job.state === "failed" || job.state === "cancelled") && (
            <Button variant="ghost" onClick={onRetry}>Retry</Button>
          )}
          {job.state === "done" && (
            <Link href={`/library/${encodeURIComponent(dir)}`}>
              <a className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm hover:bg-slate-800">Open</a>
            </Link>
          )}
          <Button variant="ghost" onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide log" : "Log"}
          </Button>
        </div>
      </div>

      {showLog && (
        <pre className="mt-3 max-h-60 overflow-y-auto rounded-lg bg-slate-950 p-3 font-mono text-xs text-slate-400">
          {job.logTail.join("\n") || "no output yet"}
        </pre>
      )}
    </Card>
  );
}
