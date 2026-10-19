import { useQuery } from "@tanstack/react-query";
import { api, formatBytes } from "../api/client.ts";

export default function DiskBanner() {
  const { data } = useQuery({
    queryKey: ["disk"],
    queryFn: api.disk,
    refetchInterval: 30_000,
  });
  if (!data?.warning) return null;
  return (
    <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-200 text-sm">
      <div className="mx-auto max-w-6xl px-6 py-2">
        <strong className="font-semibold">Low disk space</strong> — {formatBytes(data.windowsFreeBytes)} free.{" "}
        {data.warning}
      </div>
    </div>
  );
}
