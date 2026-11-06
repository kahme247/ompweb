// omp owns the steering/follow-up queue: the panel renders its snapshots
// (`get_state.queuedMessages` and live `queue_update` events), so every
// client viewing the session shows the same queue.
import type { QueuedMessages } from "@/lib/pi-types";
import type { OutboxEntry, OutboxMode } from "@/lib/types";
import type { LocalOutboxEntry } from "@/lib/event-stream";

export type { QueuedMessages };

export const EMPTY_QUEUE: QueuedMessages = { steering: [], followUp: [] };

/** Parse a queue snapshot from an RPC frame or state; null when absent. */
export function readQueueSnapshot(value: unknown): QueuedMessages | null {
  if (!value || typeof value !== "object" || !("steering" in value) || !("followUp" in value)) return null;
  const [steering, followUp] = [value.steering, value.followUp].map((list) =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  return { steering, followUp };
}

/**
 * `lib/rpc-manager.ts` answers a prompt/steer with this when a `!!` shell
 * command owned the session: it forwarded the message into omp's follow-up
 * queue instead of rejecting the frame. It reports what happened — it is not
 * queue state, so the chip still comes from omp's own snapshot.
 */
export function isQueuedWhileShellRunning(reply: unknown): boolean {
  if (!reply || typeof reply !== "object") return false;
  const value = reply as { queued?: unknown; queue?: unknown; reason?: unknown };
  return value.queued === true && value.queue === "followUp" && value.reason === "shellRunning";
}

/** A message omp-web holds until omp has it (docs/specs/2026-11-04-message-outbox-design.md O1): this browser's
 * (`local`, still on its first leg) or the web server's. The one exception to omp-owned queue state: omp does not
 * have these yet. */
export interface HeldMessage {
  id: string;
  mode: OutboxMode;
  message: string;
  images?: { type: "image"; data: string; mimeType: string }[];
  uploads?: string[];
  state: LocalOutboxEntry["state"] | Exclude<OutboxEntry["state"], "delivered">;
  error?: string;
  mayHaveBeenSent?: boolean;
  createdAt: number;
  local: boolean;
}

/** The server's outbox for a session (`outbox_update`), and every id it has listed: a browser copy of one is done. */
export interface ServerOutbox {
  entries: OutboxEntry[];
  seen: ReadonlySet<string>;
}

export const EMPTY_SERVER_OUTBOX: ServerOutbox = { entries: [], seen: new Set() };

export function applyOutboxSnapshot(current: ServerOutbox, entries: OutboxEntry[], settledIds: string[] = []): ServerOutbox {
  return { entries, seen: new Set([...current.seen, ...entries.map((entry) => entry.id), ...settledIds]) };
}

/** This session's held messages in delivery order, merged by id: the server's snapshot wins over a confirmation it
 * has not covered yet (`stored`), which wins over the browser's own copy; delivered ones are gone. Everything the
 * server holds goes first (its snapshot in arrival order, then newer confirmations), then this browser's first-leg
 * entries in the worker's submission order. The two `createdAt` clocks are never compared. */
export function mergeHeldMessages(sessionId: string | null, local: LocalOutboxEntry[], stored: OutboxEntry[], server: ServerOutbox): HeldMessage[] {
  const held: HeldMessage[] = [];
  const known = new Set<string>();
  for (const entry of [...server.entries, ...stored.filter((entry) => !server.seen.has(entry.id))]) {
    if (entry.sessionId !== sessionId) continue;
    known.add(entry.id);
    if (entry.state !== "delivered") held.push({ ...entry, state: entry.state, local: false });
  }
  for (const entry of local) {
    if (entry.sessionId === sessionId && !server.seen.has(entry.id) && !known.has(entry.id)) held.push({ ...entry, local: true });
  }
  return held;
}
