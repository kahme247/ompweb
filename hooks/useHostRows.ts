"use client";

import { useEffect, useState } from "react";
import { openEventStream } from "@/lib/event-stream";
import type { HostRow, MasterConfigError } from "@/lib/hosts/hub";
import type { HostPool } from "@/lib/hosts/pools";

type Snapshot = { hosts?: HostRow[]; pools?: HostPool[]; masterConfigError?: MasterConfigError };

/** Live host status plus pool configuration: the authenticated snapshot, then each SSE frame that carries it.
 * A frame without pools cannot erase the configured logical targets. `masterConfigError` comes with the hosts. */
export function useHostRows(): { hosts: HostRow[] | null; pools: HostPool[]; poolsLoaded: boolean; poolsFailed: boolean; failed: boolean; masterConfigError: MasterConfigError | null } {
  const [rows, setRows] = useState<{ hosts: HostRow[]; masterConfigError: MasterConfigError | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [pools, setPools] = useState<HostPool[]>([]);
  const [poolsLoaded, setPoolsLoaded] = useState(false);
  const [poolsFailed, setPoolsFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/hosts", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as Snapshot;
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.pools)) throw new Error("Host pool configuration is unavailable");
        setPools(data.pools);
        setPoolsLoaded(true);
        setPoolsFailed(false);
        // SSE owns host status; this request supplies the retained pool configuration.
        if (Array.isArray(data.hosts)) setRows((current) => current ?? { hosts: data.hosts!, masterConfigError: data.masterConfigError ?? null });
      })
      .catch(() => { if (!controller.signal.aborted) { setPoolsFailed(true); setFailed(true); } });
    const stream = openEventStream({ kind: "hosts" });
    stream.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Snapshot;
        if (Array.isArray(data.hosts)) {
          setRows({ hosts: data.hosts, masterConfigError: data.masterConfigError ?? null });
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

  return { hosts: rows?.hosts ?? null, pools, poolsLoaded, poolsFailed, failed, masterConfigError: rows?.masterConfigError ?? null };
}
