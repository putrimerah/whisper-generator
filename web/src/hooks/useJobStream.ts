import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Subscribe to a job's SSE stream. The server replays current state on
 * connect, so a reconnect after a reload is never blind.
 */
export function useJobStream(jobId: string | null, active: boolean) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!jobId || !active) return;
    const source = new EventSource(`/api/jobs/${jobId}/stream`);

    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    };

    source.addEventListener("state", invalidate);
    source.addEventListener("progress", invalidate);
    source.addEventListener("done", () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["meetings"] });
      source.close();
    });
    source.addEventListener("error", () => {
      invalidate();
      source.close();
    });

    return () => source.close();
  }, [jobId, active, queryClient]);
}
