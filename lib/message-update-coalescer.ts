// Client-side coalescing of `message_update` SSE frames.
//
// omp emits message_update per token batch (often far above display rate) and
// every frame carries the FULL accumulated partial message, so dispatching each
// one re-renders the whole streaming bubble. Only the latest pending update is
// worth showing; buffer it and flush at animation-frame rate.
//
// `tool_execution_update` frames are coalesced the same way (omp sends the full
// accumulated partial result roughly per output chunk — measured ~10-100+/s on
// chatty commands), keyed by toolCallId so concurrent tools keep their own
// latest snapshot.
//
// Ordering contract:
// - Any non-update event type flushes the pending updates synchronously BEFORE
//   it is dispatched, so no state is applied out of order.
// - `message_end` carries the complete message and therefore supersedes
//   (drops) any pending partial update. It does NOT drop pending tool updates:
//   those belong to a tool the committed message merely announced.

export type CoalescableEvent = { type: string; [key: string]: unknown };

/** Schedules `flush` and returns a cancel function. */
export type FlushScheduler = (flush: () => void) => () => void;

export interface MessageUpdateCoalescer {
  push(event: CoalescableEvent): void;
  /** Drop any pending update and cancel the scheduled flush (stream replaced or unmounted). */
  reset(): void;
}

// requestAnimationFrame matches display rate but stalls in hidden tabs, so
// fall back to a trailing 50ms timer there (and outside the browser).
function defaultScheduler(flush: () => void): () => void {
  if (
    typeof document !== "undefined"
    && !document.hidden
    && typeof requestAnimationFrame === "function"
  ) {
    const id = requestAnimationFrame(flush);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(flush, 50);
  return () => clearTimeout(id);
}

export function createMessageUpdateCoalescer(
  dispatch: (event: CoalescableEvent) => void,
  schedule: FlushScheduler = defaultScheduler,
): MessageUpdateCoalescer {
  let pending: CoalescableEvent | null = null;
  // Latest snapshot per in-flight tool. Map preserves insertion order, so
  // concurrent tools dispatch in the order they first reported progress.
  const pendingToolUpdates = new Map<string, CoalescableEvent>();
  let cancelScheduled: (() => void) | null = null;

  const cancel = () => {
    if (cancelScheduled) {
      cancelScheduled();
      cancelScheduled = null;
    }
  };

  const flush = () => {
    cancelScheduled = null;
    const event = pending;
    const toolEvents = [...pendingToolUpdates.values()];
    pending = null;
    pendingToolUpdates.clear();
    if (event) dispatch(event);
    for (const toolEvent of toolEvents) dispatch(toolEvent);
  };

  const scheduleFlush = () => {
    if (!cancelScheduled) cancelScheduled = schedule(flush);
  };

  return {
    push(event: CoalescableEvent) {
      if (event.type === "message_update") {
        pending = event;
        scheduleFlush();
        return;
      }
      if (event.type === "tool_execution_update") {
        // A frame without an id cannot be keyed; dispatch it straight away
        // rather than letting two tools overwrite each other's slot.
        const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
        if (!toolCallId) {
          flush();
          dispatch(event);
          return;
        }
        pendingToolUpdates.set(toolCallId, event);
        scheduleFlush();
        return;
      }
      if (event.type === "message_end") {
        // The complete message supersedes any pending partial message update.
        // A buffered tool update belongs to the tool the committed message
        // announced, so it survives and its scheduled flush stays armed.
        pending = null;
        if (pendingToolUpdates.size === 0) cancel();
      } else if (pending || pendingToolUpdates.size > 0) {
        cancel();
        const buffered = pending;
        const toolEvents = [...pendingToolUpdates.values()];
        pending = null;
        pendingToolUpdates.clear();
        if (buffered) dispatch(buffered);
        for (const toolEvent of toolEvents) dispatch(toolEvent);
      }
      dispatch(event);
    },
    reset() {
      pending = null;
      pendingToolUpdates.clear();
      cancel();
    },
  };
}
