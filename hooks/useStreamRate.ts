"use client";

import { useEffect, useRef, useState } from "react";
import { StreamRateTracker, estimateStreamTokens } from "@/lib/generation-speed";
import type { AgentMessage } from "@/lib/types";

/** UI publication cadence of the live rate; keeps screen readers, layout and
 * the stream cost out of the delta rate. */
export const STREAM_RATE_PUBLISH_MS = 500;

/**
 * Live tokens-per-second estimate from the streaming assistant snapshot.
 *
 * omp's RPC has no live meter: `get_state.tokensPerSecond` is a whole-message
 * average that only becomes meaningful once `usage.output` exists. The
 * client therefore estimates from the streamed text/thinking deltas and the
 * final badge corrects it with `usage.output`/`duration`.
 */
export function useStreamRate(message: Partial<AgentMessage> | null | undefined, streaming: boolean): number | null {
  const trackerRef = useRef<StreamRateTracker | null>(null);
  const identityRef = useRef<number | null | undefined>(undefined);
  const [rate, setRate] = useState<number | null>(null);
  if (trackerRef.current === null) trackerRef.current = new StreamRateTracker();

  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    if (!streaming) {
      tracker.reset();
      identityRef.current = undefined;
      setRate((previous) => (previous === null ? previous : null));
      return;
    }
    // Advisor/custom snapshots can appear mid-stream; they must not reset the
    // assistant's measurement.
    if (message?.role !== "assistant") return;
    const identity = typeof message.timestamp === "number" ? message.timestamp : null;
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      tracker.reset();
      // The next message starts a new measurement; the previous message's
      // number must not survive until the next publication tick.
      setRate((previous) => (previous === null ? previous : null));
    }
    tracker.observe(estimateStreamTokens(message), Date.now());
  }, [message, streaming]);

  useEffect(() => {
    if (!streaming) return;
    const id = setInterval(() => {
      // The badge and the footer print one decimal, so only a change of that
      // decimal may re-render them: the raw rate jitters every tick.
      const measured = trackerRef.current?.rate(Date.now()) ?? null;
      const next = measured === null ? null : Math.round(measured * 10) / 10;
      setRate((previous) => (previous === next ? previous : next));
    }, STREAM_RATE_PUBLISH_MS);
    return () => clearInterval(id);
  }, [streaming]);

  return streaming ? rate : null;
}
