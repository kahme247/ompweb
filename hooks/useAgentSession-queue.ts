// omp owns the steering/follow-up queue: the panel renders its snapshots
// (`get_state.queuedMessages` and live `queue_update` events), so every
// client viewing the session shows the same queue.
import type { QueuedMessages } from "@/lib/pi-types";
import type { OutboxEntry, OutboxMode } from "@/lib/types";
import type { LocalOutboxEntry } from "@/lib/event-stream";

export type { QueuedMessages };

export const EMPTY_QUEUE: QueuedMessages = { steering: [], followUp: [] };


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
  known: ReadonlyMap<string, HeldMessage & { sessionId: string }>;
  nativeSettled: ReadonlySet<string>;
  /** Native-settled bridges omp reports no trace of (its child ended, /new): shown as Not sent, may have been sent. */
  uncertain: ReadonlySet<string>;
  represented: ReadonlySet<string>;
}

export const EMPTY_SERVER_OUTBOX: ServerOutbox = {
  entries: [], seen: new Set(), known: new Map(), nativeSettled: new Set(), uncertain: new Set(), represented: new Set(),
};

/** Remember payloads independently of the server's pending list: its settlement can beat this peer's echo. A receipt
 * without native correlation (an OMP without client message IDs) retires at once, as before correlation existed. */
export function rememberOutboxEntries(current: ServerOutbox, entries: (OutboxEntry | LocalOutboxEntry)[], local = false): ServerOutbox {
  if (entries.length === 0) return current;
  const known = new Map(current.known);
  const nativeSettled = new Set(current.nativeSettled);
  const seen = new Set(current.seen);
  const retired: string[] = [];
  for (const entry of entries) {
    if (current.represented.has(entry.id)) continue;
    // A worker replay names the session the row was typed in; the server's copy may have moved to another since.
    if (local && current.known.get(entry.id)?.local === false) continue;
    if (entry.state === "delivered") {
      seen.add(entry.id);
      if (entry.settlement === "native") nativeSettled.add(entry.id);
      else {
        if (entry.settlement === "uncorrelated") retired.push(entry.id);
        continue;
      }
    }
    known.set(entry.id, { ...entry, state: entry.state === "delivered" ? "delivering" : entry.state, local });
  }
  return representOutboxIds({ ...current, known, nativeSettled, seen }, retired);
}

export function markOutboxUncertain(current: ServerOutbox, ids: Iterable<string>): ServerOutbox {
  const added = [...ids].filter((id) => current.nativeSettled.has(id) && !current.represented.has(id) && !current.uncertain.has(id));
  return added.length ? { ...current, uncertain: new Set([...current.uncertain, ...added]) } : current;
}

/** Both actual native representation and explicit withdrawal are terminal for a browser bridge. */
export function representOutboxIds(current: ServerOutbox, ids: Iterable<string>): ServerOutbox {
  const added = [...ids].filter((id) => !current.represented.has(id));
  if (added.length === 0) return current;
  const known = new Map(current.known);
  for (const id of added) known.delete(id);
  return { ...current, known, represented: new Set([...current.represented, ...added]) };
}

export function applyOutboxSnapshot(current: ServerOutbox, entries: OutboxEntry[], settledIds: string[] = [], nativeSettledIds: string[] = []): ServerOutbox {
  const remembered = rememberOutboxEntries(current, entries);
  const nativeSettled = new Set([...remembered.nativeSettled, ...nativeSettledIds]);
  return representOutboxIds({
    ...remembered, entries, nativeSettled,
    seen: new Set([...current.seen, ...entries.map((entry) => entry.id), ...settledIds]),
  }, settledIds.filter((id) => !nativeSettled.has(id)));
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
    if (server.represented.has(entry.id)) continue;
    known.add(entry.id);
    if (entry.state !== "delivered") held.push({ ...entry, state: entry.state, local: false });
  }
  for (const entry of local) {
    if (entry.sessionId === sessionId && !server.represented.has(entry.id) && !server.seen.has(entry.id) && !known.has(entry.id)) {
      known.add(entry.id);
      held.push({ ...entry, local: true });
    }
  }
  for (const [id, entry] of server.known) {
    if (entry.sessionId !== sessionId || known.has(id) || server.represented.has(id)) continue;
    if (server.uncertain.has(id)) held.push({ ...entry, state: "failed", mayHaveBeenSent: true, local: false });
    else if (server.nativeSettled.has(id)) held.push({ ...entry, state: "delivering", local: false });
  }
  return held;
}
