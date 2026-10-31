"use client";

import { useEffect, useState } from "react";
import { openEventStream } from "@/lib/event-stream";
import type { HostRow } from "@/lib/hosts/hub";

/** Every host's live status from the `hosts` channel: this machine first, then
 *  the linked hosts. `hosts` is null until the first snapshot; `failed` is
 *  true while the stream is down. */
export function useHostRows(): { hosts: HostRow[] | null; failed: boolean } {
  const [hosts, setHosts] = useState<HostRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const stream = openEventStream({ kind: "hosts" });
    stream.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { hosts?: HostRow[] };
        if (Array.isArray(data.hosts)) {
          setHosts(data.hosts);
          setFailed(false);
        }
      } catch {
        // A malformed frame is skipped; the next change sends a full list.
      }
    };
    stream.onerror = () => setFailed(true);
    return () => stream.close();
  }, []);

  return { hosts, failed };
}
