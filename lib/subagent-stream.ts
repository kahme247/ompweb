// Bandwidth limits for the subagent frames omp sends over the event stream.
//
// With `set_subagent_subscription level: "events"` omp mirrors every event of
// every child session as a `subagent_event` (message updates carry the whole
// message twice, 7-26 KB per frame) and sends a full `subagent_progress`
// snapshot every ~150 ms per child. With ten children that was ~430 KiB/s per
// open session. The browser reads very little of it:
//   - `subagent_event`: the child's id (a transcript revision tick) and the
//     one-line activity label `parseSubagentActivityEvent` derives from
//     tool_execution_start / assistant message_end / notice (lib/subagent-types.ts).
//     The transcript itself is paged from disk, never from these frames.
//   - `subagent_progress`: the latest snapshot; the hook keeps only the newest.
// So the wrapper shrinks `subagent_event` to those fields and sends at most one
// `subagent_progress` per child per interval (the newest one, trailing; a
// terminal one at once). Anything that changes what the transcript view shows
// must be added to `slimInnerEvent`.

import { isRecord } from "./type-guards";

export type SubagentFrame = { type: string; [key: string]: unknown };

/** Newest `subagent_progress` per child goes out at most this often. */
export const SUBAGENT_PROGRESS_INTERVAL_MS = 1000;
/** Streaming-only child events (no activity label) tick a child's revision at most this often. */
export const SUBAGENT_NOISY_EVENT_INTERVAL_MS = 1000;
/** Same cut `parseSubagentActivityEvent` applies to a label. */
const LABEL_MAX = 140;
const ARG_KEYS_MAX = 3;

/** Child events that stream continuously and carry no activity label. */
const NOISY_EVENTS: Record<string, true> = { message_update: true, tool_stream_update: true, tool_execution_update: true };
const TERMINAL_STATUSES: Record<string, true> = { completed: true, failed: true, aborted: true };
const isTerminalStatus = (status: unknown): boolean => typeof status === "string" && TERMINAL_STATUSES[status] === true;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The child event reduced to what `parseSubagentActivityEvent` reads. */
export function slimInnerEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = asString(event.type) ?? "unknown";
  switch (type) {
    case "tool_execution_start": {
      const slim: Record<string, unknown> = { type };
      const toolName = asString(event.toolName);
      if (toolName !== undefined) slim.toolName = toolName;
      const intent = asString(event.intent);
      if (intent !== undefined) slim.intent = intent;
      if (isRecord(event.args)) {
        const args: Record<string, null> = {};
        for (const key of Object.keys(event.args).slice(0, ARG_KEYS_MAX)) args[key] = null;
        slim.args = args;
      }
      return slim;
    }
    case "message_end": {
      const message = isRecord(event.message) ? event.message : null;
      if (!message || message.role !== "assistant") return { type };
      const content = message.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
            .filter((block): block is { type: "text"; text?: unknown } => isRecord(block) && block.type === "text")
            .map((block) => (typeof block.text === "string" ? block.text : ""))
            .join("\n")
          : "";
      const label = text.trim().slice(0, LABEL_MAX);
      return label ? { type, message: { role: "assistant", content: [{ type: "text", text: label }] } } : { type };
    }
    case "notice": {
      const message = asString(event.message);
      return message ? { type, message: message.slice(0, LABEL_MAX) } : { type };
    }
    default:
      return { type };
  }
}

/** A `subagent_event` frame with its child event slimmed; other fields (`payload.id`, `web`) are kept. */
export function slimSubagentEvent<F extends SubagentFrame>(frame: F): F {
  const payload = frame.payload;
  if (!isRecord(payload) || !isRecord(payload.event)) return frame;
  return { ...frame, payload: { ...payload, event: slimInnerEvent(payload.event) } };
}

export interface SubagentStreamLimiterOptions {
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingProgress {
  frame: SubagentFrame;
  handle: unknown;
}

/**
 * Sits between omp's frames and the wrapper's `emit`: slims `subagent_event`,
 * rate-limits `subagent_progress` and keeps `subagent_lifecycle` ordered
 * after the progress it supersedes.
 */
export class SubagentStreamLimiter {
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly progressSentAt = new Map<string, number>();
  private readonly pendingProgress = new Map<string, PendingProgress>();
  private readonly noisySentAt = new Map<string, number>();

  constructor(private readonly emit: (frame: SubagentFrame) => void, options: SubagentStreamLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => {
      const handle: unknown = setTimeout(run, ms);
      // Bun/Node timers have unref; a held-back frame must not keep the process alive.
      if (isRecord(handle) && typeof handle.unref === "function") handle.unref();
      return handle;
    });
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));
  }

  /** Handles a subagent frame (emitting now or later) and returns true; false for any other frame. */
  push(frame: SubagentFrame): boolean {
    switch (frame.type) {
      case "subagent_event":
        this.pushEvent(frame);
        return true;
      case "subagent_progress":
        this.pushProgress(frame);
        return true;
      case "subagent_lifecycle":
        this.pushLifecycle(frame);
        return true;
      default:
        return false;
    }
  }

  /** Emits what is held back (the run ended: nothing may stay behind). */
  flushAll(): void {
    for (const id of [...this.pendingProgress.keys()]) this.flushProgress(id);
  }

  /** Drops everything held back without emitting (the wrapper is gone). */
  dispose(): void {
    for (const pending of this.pendingProgress.values()) this.clearTimer(pending.handle);
    this.pendingProgress.clear();
    this.progressSentAt.clear();
    this.noisySentAt.clear();
  }

  private pushEvent(frame: SubagentFrame): void {
    const payload = frame.payload;
    const id = isRecord(payload) ? asString(payload.id) : undefined;
    const innerType = isRecord(payload) && isRecord(payload.event) ? asString(payload.event.type) : undefined;
    if (id !== undefined && innerType !== undefined && NOISY_EVENTS[innerType] === true) {
      const now = this.now();
      const last = this.noisySentAt.get(id);
      if (last !== undefined && now - last < SUBAGENT_NOISY_EVENT_INTERVAL_MS) return;
      this.noisySentAt.set(id, now);
    }
    this.emit(slimSubagentEvent(frame));
  }

  private pushProgress(frame: SubagentFrame): void {
    const id = progressId(frame);
    // A frame that names no child cannot be keyed: pass it as omp sent it.
    if (id === undefined) {
      this.emit(frame);
      return;
    }
    if (isTerminalProgress(frame)) {
      this.cancelPending(id);
      this.progressSentAt.set(id, this.now());
      this.emit(frame);
      return;
    }
    const existing = this.pendingProgress.get(id);
    if (existing) {
      existing.frame = frame;
      return;
    }
    const last = this.progressSentAt.get(id);
    const wait = last === undefined ? 0 : SUBAGENT_PROGRESS_INTERVAL_MS - (this.now() - last);
    if (wait <= 0) {
      this.progressSentAt.set(id, this.now());
      this.emit(frame);
      return;
    }
    this.pendingProgress.set(id, { frame, handle: this.setTimer(() => this.flushProgress(id), wait) });
  }

  private pushLifecycle(frame: SubagentFrame): void {
    const payload = frame.payload;
    const id = isRecord(payload) ? asString(payload.id) : undefined;
    if (id !== undefined) {
      // The newest snapshot must not land after the status change that supersedes it.
      this.flushProgress(id);
      if (isRecord(payload) && isTerminalStatus(payload.status)) {
        this.progressSentAt.delete(id);
        this.noisySentAt.delete(id);
      }
    }
    this.emit(frame);
  }

  private flushProgress(id: string): void {
    const pending = this.pendingProgress.get(id);
    if (!pending) return;
    this.clearTimer(pending.handle);
    this.pendingProgress.delete(id);
    this.progressSentAt.set(id, this.now());
    this.emit(pending.frame);
  }

  private cancelPending(id: string): void {
    const pending = this.pendingProgress.get(id);
    if (!pending) return;
    this.clearTimer(pending.handle);
    this.pendingProgress.delete(id);
  }
}

/** The child a `subagent_progress` frame is about: `payload.progress.id` as the hook keys it. */
function progressId(frame: SubagentFrame): string | undefined {
  const payload = frame.payload;
  if (!isRecord(payload) || !isRecord(payload.progress)) return undefined;
  return asString(payload.progress.id);
}

function isTerminalProgress(frame: SubagentFrame): boolean {
  const payload = frame.payload;
  if (!isRecord(payload) || !isRecord(payload.progress)) return false;
  return isTerminalStatus(payload.progress.status);
}
