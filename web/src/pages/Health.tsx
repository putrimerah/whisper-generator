import { useQuery } from "@tanstack/react-query";
import { api, formatBytes } from "../api/client.ts";
import { Card } from "../components/Ui.tsx";

export default function Health() {
  const doctor = useQuery({ queryKey: ["doctor"], queryFn: api.doctor });
  const disk = useQuery({ queryKey: ["disk"], queryFn: api.disk });

  return (
    <div className="space-y-4">
      <Card title="Environment">
        <div className="space-y-3">
          {doctor.data?.checks.map((check) => (
            <div key={check.name} className="flex gap-3">
              <span className={check.ok ? "text-emerald-400" : "text-red-400"}>
                {check.ok ? "✔" : "✘"}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{check.name}</p>
                <p className="text-xs text-slate-400">{check.detail}</p>
                {check.fix && (
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-950 p-2 font-mono text-xs text-amber-300">
                    {check.fix}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Disk">
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs text-slate-400">Windows C: free</dt>
            <dd>{disk.data ? formatBytes(disk.data.windowsFreeBytes) : "…"}</dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">Output drive free</dt>
            <dd>{disk.data ? formatBytes(disk.data.outputFreeBytes) : "…"}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-slate-400">
          Deleting files inside WSL does not shrink ext4.vhdx. To return space to Windows, run in
          PowerShell:
        </p>
        <pre className="mt-2 rounded bg-slate-950 p-3 font-mono text-xs text-slate-300">
{`wsl --shutdown
wsl --manage Ubuntu22 --set-sparse true`}
        </pre>
      </Card>
    </div>
  );
}
