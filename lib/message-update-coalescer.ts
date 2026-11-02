// Client-side coalescing of `message_update` SSE frames.
//
// omp emits message_update per token batch (often far above display rate), and
// dispatching each one re-renders the whole streaming bubble. Only the latest
// message is worth showing; buffer it and flush at animation-frame rate.
//
// A frame is either the whole message (omp's full updates, or the server's
// replay to a tab that attaches mid-message) or a delta (lib/message-delta.ts).
// The coalescer keeps the message deltas apply to, applies each one as it
// arrives, and dispatches the whole message, so the transcript only ever sees
// whole messages. A delta with no message to apply to is held, never shown,
// and `onMissingBase` asks for the server's snapshot (`seed`), which the held
// deltas newer than it then complete.
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

import { applyMessageDelta, displayMessage, isDeltaUpdate } from "./message-delta";
import { isRecord } from "./type-guards";

export type CoalescableEvent = { type: string; [key: string]: unknown };

/** Schedules `flush` and returns a cancel function. */
export type FlushScheduler = (flush: () => void) => () => void;

export interface MessageUpdateCoalescer {
  push(event: CoalescableEvent): void;
  /** Commit pending live output before applying a selectively newer snapshot. */
  flush(): void;
  /** Drop any pending update and cancel the scheduled flush (stream replaced or unmounted). */
  reset(): void;
  /**
   * The server's live snapshot of message `messageId` as of `sequence`.
   * `applied`: the transcript now shows it, so later deltas apply to it.
   * Otherwise it only completes held deltas, when it is not older than them.
   */
  seed(messageId: string | null, message: unknown, sequence: number, applied: boolean): void;
}

// requestAnimationFrame matches display rate but stalls in hidden tabs, so
// fall back to a trailing 50ms timer there (and outside the browser). Shared
// with other display-rate batching (hooks/useBtw.ts).
export function scheduleAtDisplayRate(flush: () => void): () => void {
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

/** Held deltas kept while no snapshot arrives: far above a normal catch-up, but bounded in a long message. */
export const HELD_DELTA_LIMIT = 1000;

export function createMessageUpdateCoalescer(
  dispatch: (event: CoalescableEvent) => void,
  schedule: FlushScheduler = scheduleAtDisplayRate,
  onMissingBase: () => void = () => {},
): MessageUpdateCoalescer {
  let pending: CoalescableEvent | null = null;
  // Latest snapshot per in-flight tool. Map preserves insertion order, so
  // concurrent tools dispatch in the order they first reported progress.
  const pendingToolUpdates = new Map<string, CoalescableEvent>();
  let cancelScheduled: (() => void) | null = null;
  /** The message deltas apply to, and the sequence it holds every update up to. */
  let live: { messageId: string; message: object; since: number } | null = null;
  /** Deltas that found no message, and the newest sequence seen before the first of them. */
  let held: CoalescableEvent[] = [];
  let heldFloor = 0;
  let lastSequence = 0;

  const sequenceOf = (event: CoalescableEvent) => isRecord(event.web) && typeof event.web.sequence === "number" ? event.web.sequence : 0;
  /** A frame the server merged under backpressure (event-stream-hub.ts) holds the deltas from `web.first` on. */
  const firstOf = (event: CoalescableEvent) => isRecord(event.web) && typeof event.web.first === "number" ? event.web.first : sequenceOf(event);
  const shown = (event: CoalescableEvent): CoalescableEvent => {
    if (!isRecord(event.message)) return event;
    const message = displayMessage(event.message);
    return message === event.message ? event : { ...event, message };
  };
  const rebase = (messageId: string, message: object, since: number) => {
    live = { messageId, message, since };
    held = held.filter((event) => event.messageId !== messageId);
  };
  /** The update to show, or null when a delta has no message to apply to. */
  const rebuild = (event: CoalescableEvent, floor: number): CoalescableEvent | null => {
    const messageId = typeof event.messageId === "string" ? event.messageId : null;
    if (!isDeltaUpdate(event)) {
      if (messageId !== null && isRecord(event.message)) rebase(messageId, event.message, sequenceOf(event));
      return event;
    }
    // A merged frame whose first pieces the base already holds would repeat them.
    if (live && live.messageId === messageId && firstOf(event) <= live.since) live = null;
    const message = live && live.messageId === messageId ? applyMessageDelta(live.message, event.assistantMessageEvent) : null;
    if (!live || !message) {
      // Past the limit the held deltas go; emptying the set makes this delta the first of a new one, so the
      // floor below moves to the newest sequence seen before it, which covers the dropped deltas.
      if (held.length >= HELD_DELTA_LIMIT) held = [];
      if (held.length === 0) heldFloor = floor;
      held.push(event);
      onMissingBase();
      return null;
    }
    live = { messageId: live.messageId, message, since: sequenceOf(event) };
    return { ...event, message };
  };
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
    if (event) dispatch(shown(event));
    for (const toolEvent of toolEvents) dispatch(toolEvent);
  };

  const scheduleFlush = () => {
    if (!cancelScheduled) cancelScheduled = schedule(flush);
  };

  return {
    push(event: CoalescableEvent) {
      const floor = lastSequence;
      lastSequence = Math.max(lastSequence, sequenceOf(event));
      if (event.type === "message_update") {
        const update = rebuild(event, floor);
        if (!update) return;
        pending = update;
        scheduleFlush();
        return;
      }
      if (event.type === "message_start" && typeof event.messageId === "string" && isRecord(event.message) && event.message.role === "assistant") {
        rebase(event.messageId, event.message, sequenceOf(event));
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
        if (live && live.messageId === event.messageId) live = null;
        held = held.filter((queued) => queued.messageId !== event.messageId);
        if (pendingToolUpdates.size === 0) cancel();
      } else if (pending || pendingToolUpdates.size > 0) {
        cancel();
        const buffered = pending;
        const toolEvents = [...pendingToolUpdates.values()];
        pending = null;
        pendingToolUpdates.clear();
        if (buffered) dispatch(shown(buffered));
        for (const toolEvent of toolEvents) dispatch(toolEvent);
      }
      dispatch(event);
    },
    flush() {
      cancel();
      flush();
    },
    reset() {
      pending = null;
      pendingToolUpdates.clear();
      cancel();
      live = null;
      held = [];
      lastSequence = 0;
    },
    seed(messageId, message, sequence, applied) {
      if (!applied && (sequence < heldFloor || !held.some((event) => event.messageId === messageId))) return;
      const replay = held.filter((event) => event.messageId === messageId && sequenceOf(event) > sequence);
      held = held.filter((event) => event.messageId !== messageId);
      live = messageId !== null && isRecord(message) ? { messageId, message, since: sequence } : null;
      let last: CoalescableEvent | null = null;
      for (const event of replay) {
        // Not applicable (or a merged frame the snapshot holds only part of): wait for the next snapshot.
        const next = live && firstOf(event) > live.since ? applyMessageDelta(live.message, event.assistantMessageEvent) : null;
        if (!live || !next) {
          live = null;
          onMissingBase();
          return;
        }
        live = { messageId: live.messageId, message: next, since: sequenceOf(event) };
        last = event;
      }
      if (last && live) {
        pending = { ...last, message: live.message };
        scheduleFlush();
      }
    },
  };
}
