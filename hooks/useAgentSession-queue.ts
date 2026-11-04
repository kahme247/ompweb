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

/** This session's held messages in submission order, merged by id: the server's snapshot wins over a confirmation it
 * has not covered yet (`stored`), which wins over the browser's own copy; delivered ones are gone. */
export function mergeHeldMessages(sessionId: string | null, local: LocalOutboxEntry[], stored: OutboxEntry[], server: ServerOutbox): HeldMessage[] {
  const held = new Map<string, HeldMessage>();
  for (const entry of local) {
    if (entry.sessionId === sessionId && !server.seen.has(entry.id)) held.set(entry.id, { ...entry, local: true });
  }
  for (const entry of [...stored.filter((entry) => !server.seen.has(entry.id)), ...server.entries]) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.state === "delivered") held.delete(entry.id);
    else held.set(entry.id, { ...entry, state: entry.state, local: false });
  }
  return [...held.values()].sort((a, b) => a.createdAt - b.createdAt);
}
