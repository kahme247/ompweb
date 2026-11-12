"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { openEventStream } from "@/lib/event-stream";
import type { HostRow } from "@/lib/hosts/hub";
import type { HostPool } from "@/lib/hosts/pools";

/** Live host status plus pool configuration: the authenticated snapshot, then each SSE frame that carries it.
 * A frame without pools cannot erase the configured logical targets. `reload` fetches the snapshot again and
 * resolves with the pools known afterwards, or null when it failed. */
export function useHostRows(): { hosts: HostRow[] | null; pools: HostPool[]; poolsLoaded: boolean; poolsFailed: boolean; failed: boolean; reload: () => Promise<HostPool[] | null> } {
  const [hosts, setHosts] = useState<HostRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pools, setPools] = useState<HostPool[]>([]);
  const [poolsLoaded, setPoolsLoaded] = useState(false);
  const [poolsFailed, setPoolsFailed] = useState(false);
  const snapshot = useRef<AbortController | null>(null);
  const latestPools = useRef<HostPool[] | null>(null);

  const reload = useCallback(async (): Promise<HostPool[] | null> => {
    snapshot.current?.abort();
    const controller = new AbortController();
    snapshot.current = controller;
    try {
      const response = await fetch("/api/hosts", { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { hosts?: HostRow[]; pools?: HostPool[] };
      if (controller.signal.aborted) return latestPools.current;
      if (!Array.isArray(data.pools)) throw new Error("Host pool configuration is unavailable");
      latestPools.current = data.pools;
      setPools(data.pools);
      setPoolsLoaded(true);
      setPoolsFailed(false);
      // SSE owns host status; this request supplies the retained pool configuration.
      if (Array.isArray(data.hosts)) setHosts((current) => current ?? data.hosts!);
      return data.pools;
    } catch {
      // Cancelled by a frame that carried pools: those are the current ones.
      if (controller.signal.aborted) return latestPools.current;
      setPoolsFailed(true);
      setFailed(true);
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
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
          latestPools.current = data.pools;
          snapshot.current?.abort();
          setPools(data.pools);
          setPoolsLoaded(true);
          setPoolsFailed(false);
        }
      } catch {
        // A malformed frame is skipped; the next change sends a full list.
      }
    };
    stream.onerror = () => setFailed(true);
    return () => { snapshot.current?.abort(); stream.close(); };
  }, [reload]);

  return { hosts, pools, poolsLoaded, poolsFailed, failed, reload };
}
