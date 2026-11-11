"use client";

import { useEffect, useState } from "react";
import { openEventStream } from "@/lib/event-stream";
import type { HostRow } from "@/lib/hosts/hub";
import type { HostPool } from "@/lib/hosts/pools";

/** Live host status plus pool configuration: the authenticated snapshot, then each SSE frame that carries it.
 * A frame without pools cannot erase the configured logical targets. */
export function useHostRows(): { hosts: HostRow[] | null; pools: HostPool[]; poolsLoaded: boolean; poolsFailed: boolean; failed: boolean } {
  const [hosts, setHosts] = useState<HostRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pools, setPools] = useState<HostPool[]>([]);
  const [poolsLoaded, setPoolsLoaded] = useState(false);
  const [poolsFailed, setPoolsFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/hosts", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { hosts?: HostRow[]; pools?: HostPool[] };
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.pools)) throw new Error("Host pool configuration is unavailable");
        setPools(data.pools);
        setPoolsLoaded(true);
        setPoolsFailed(false);
        // SSE owns host status; this request supplies the retained pool configuration.
        if (Array.isArray(data.hosts)) setHosts((current) => current ?? data.hosts!);
      })
      .catch(() => { if (!controller.signal.aborted) { setPoolsFailed(true); setFailed(true); } });
    const stream = openEventStream({ kind: "hosts" });
    stream.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { hosts?: HostRow[]; pools?: HostPool[] };
        if (Array.isArray(data.hosts)) {
          setHosts(data.hosts);
          setFailed(false);
        }
        // A frame that carries pools is as good as the snapshot: it also recovers from a failed first request,
        // and cancels one still running so its older answer, or its failure, is ignored.
        if (Array.isArray(data.pools)) {
          controller.abort();
          setPools(data.pools);
          setPoolsLoaded(true);
          setPoolsFailed(false);
        }
      } catch {
        // A malformed frame is skipped; the next change sends a full list.
      }
    };
    stream.onerror = () => setFailed(true);
    return () => { controller.abort(); stream.close(); };
  }, []);

  return { hosts, pools, poolsLoaded, poolsFailed, failed };
}
