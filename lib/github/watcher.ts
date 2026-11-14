import { createHash } from "node:crypto";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "../image-attachments";
import { readAgentToolsEnabledFromDisk } from "../web-settings";
import { fetchSnapshot } from "./api";
import { diffSnapshot, formatUpdate, splitUpdateEvents, updateEntryId } from "./events";
import { checkGh, defaultGhRunner, formatTarget, GhUnavailableError, parseGithubTarget, type GhRunner } from "./gh";
import { advanceCursor, advancePendingBatch, claimPending, closeWatchStore, commitUpdate, getPending, isPosting, listWatches, postedIds, removeSessionWatches, renameSession, type PendingUpdate, type Watch } from "./watch-store";

/**
 * Server-only poller: every watched item is fetched once per interval (items
 * spread across it), and what is new goes into each watching session's message
 * outbox. A stored pending row per watch makes a crash between the outbox add
 * and the cursor save replay the same entry id.
 */

/** `rejected`: a refusal retrying cannot fix, as "<status> <code>". */
export type Delivery = "ok" | "gone" | "retry" | { rejected: string };

export interface WatcherDeps {
  run?: GhRunner;
  deliver?: (sessionId: string, entryId: string, message: string) => Promise<Delivery>;
  now?: () => number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const INTERVAL_MS = 60_000;
/** At most one snapshot per 1.5 s, about 2400 GraphQL points an hour of the login's 5000. */
const ITEM_SPACING_MS = 1500;
/** Below this many points left, polling waits for the reset so the user's own `gh` keeps working. */
const BUDGET_FLOOR = 200;

// Both generated tokens are fixed-length base64url strings and do not need JSON escaping.
const OUTBOX_ID_PLACEHOLDER = `gh-${"0".repeat(40)}`;
const OUTBOX_SCOPE_PLACEHOLDER = "0".repeat(43);
const EMPTY_OUTBOX_COMMAND_BYTES = Buffer.byteLength(JSON.stringify({
  type: "outbox_add",
  id: OUTBOX_ID_PLACEHOLDER,
  scope: OUTBOX_SCOPE_PLACEHOLDER,
  mode: "prompt",
  message: "",
}));
const MAX_UPDATE_MESSAGE_CONTENT_BYTES = MAX_AGENT_COMMAND_REQUEST_BYTES - EMPTY_OUTBOX_COMMAND_BYTES;

interface Outage {
  message: string;
  minute: number;
  paused: Set<string>;
  recovered?: { minute: number; told: Set<string> };
}

interface WatcherState {
  deps: Required<WatcherDeps>;
  cancels: Set<() => void>;
  inFlight: Set<string>;
  failing: Set<string>;
  /** Refusals already logged by watch; retained size errors use a separate key. */
  refused: Set<string>;
  /** Epoch ms of the GraphQL budget reset polling waits for. */
  budgetResetAt?: number;
  outage?: Outage;
  detachMove?: () => void;
  stopped: boolean;
}

declare global {
  var __ompGithubWatcher: WatcherState | undefined;
}

async function defaultDeliver(sessionId: string, id: string, message: string): Promise<Delivery> {
  try {
    // Lazy: message-outbox pulls in rpc-manager, which will load the agent tools that load this module.
    const { runOutboxCommand, outboxScope } = await import("../message-outbox");
    return await deliveryOf(await runOutboxCommand(sessionId, { type: "outbox_add", id, scope: outboxScope(), mode: "prompt", message }, false, "omp-web:github-watch"));
  } catch {
    return "retry";
  }
}

/** Lazy to avoid message-outbox -> rpc-manager -> agent-tools -> watcher import cycles. */
const outboxReceipts = () => import("../message-outbox");

/** Reconciles orphaned receipts only after snapshotting the pins, so newly claimed batches are not unpinned. */
async function reconcileOutboxReceiptPins(): Promise<void> {
  const { listOutboxReceiptPins, releaseOutboxReceipt } = await outboxReceipts();
  const pins = listOutboxReceiptPins();
  for (const { entryId } of pins) {
    let pending = false;
    for (const watch of listWatches()) {
      const update = getPending(watch.sessionId, watch.itemKey, watch.registrationId);
      if (!update) continue;
      for (let index = update.batchIndex; index < update.batches.length; index++) {
        if (update.batches[index].entryId === entryId) {
          pending = true;
          break;
        }
      }
      if (pending) break;
    }
    if (!pending) releaseOutboxReceipt(entryId);
  }
}

/** 404: the session is gone. 429 (outbox full) and 5xx pass; any other 4xx would refuse the same entry forever. */
export async function deliveryOf(response: Response): Promise<Delivery> {
  if (response.ok) return "ok";
  if (response.status === 404) return "gone";
  if (response.status === 429 || response.status >= 500) return "retry";
  const code: unknown = await response.json().then((body: { code?: unknown } | null) => body?.code, () => undefined);
  return { rejected: typeof code === "string" ? `${response.status} ${code}` : String(response.status) };
}

const defaultSchedule: Required<WatcherDeps>["schedule"] = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const warn = (what: string, error: unknown) => console.warn(`[omp-web] github watcher: ${what}: ${error instanceof Error ? error.message : String(error)}`);

/**
 * Delivers persisted batches in order; only the final accepted batch commits the cursor or removes a final watch.
 */
async function deliverPending(state: WatcherState, watch: Watch, pending: PendingUpdate): Promise<void> {
  const { sessionId, itemKey, registrationId } = watch;
  while (true) {
    if (state.stopped || !readAgentToolsEnabledFromDisk()) return;
    if (pending.batchIndex === pending.batches.length) {
      commitUpdate(sessionId, itemKey, registrationId, pending.entryId, pending.cursor, pending.final);
      return;
    }
    const batch = pending.batches[pending.batchIndex];
    const { pinOutboxReceipt } = await outboxReceipts();
    pinOutboxReceipt(sessionId, batch.entryId);
    if (state.stopped || !readAgentToolsEnabledFromDisk()) return;
    const outcome = await state.deps.deliver(sessionId, batch.entryId, batch.message);
    if (state.stopped) return;
    if (outcome === "gone") {
      if (readAgentToolsEnabledFromDisk()) removeSessionWatches(sessionId, { itemKey, registrationId, entryId: pending.entryId });
      return;
    }
    if (outcome === "retry") return;
    if (outcome !== "ok") {
      const watchKey = `${sessionId}\0${itemKey}`;
      if (outcome.rejected.startsWith("413")) {
        const sizeKey = `${watchKey}\0size`;
        if (!state.refused.has(sizeKey)) {
          state.refused.add(sizeKey);
          console.warn(`[omp-web] github watcher: the outbox of ${sessionId} rejected an oversized update batch for ${itemKey} (${outcome.rejected}); batch retained`);
        }
        return;
      }
      if (!state.refused.has(watchKey)) {
        state.refused.add(watchKey);
        console.warn(`[omp-web] github watcher: the outbox of ${sessionId} refused an update for ${itemKey} (${outcome.rejected}); dropped it`);
      }
    }
    if (state.stopped) return;
    if (!advancePendingBatch(sessionId, itemKey, registrationId, pending.entryId, pending.batchIndex)) return;
    const { releaseOutboxReceipt } = await outboxReceipts();
    releaseOutboxReceipt(batch.entryId);
    const next = getPending(sessionId, itemKey, registrationId);
    if (!next) return;
    pending = next;
  }
}
async function pollItem(state: WatcherState, itemKey: string): Promise<void> {
  if (state.stopped || !readAgentToolsEnabledFromDisk() || state.inFlight.has(itemKey)) return;
  state.inFlight.add(itemKey);
  try {
    const watches = listWatches().filter((w) => w.itemKey === itemKey);
    // A stored update is redelivered as it is; only watches without one are diffed anew.
    const fresh: Watch[] = [];
    for (const watch of watches) {
      const pending = getPending(watch.sessionId, itemKey, watch.registrationId);
      if (pending) await deliverPending(state, watch, pending);
      else fresh.push(watch);
    }
    if (state.stopped || !readAgentToolsEnabledFromDisk()) return;
    if (!fresh.length) return;
    if (isPosting(itemKey)) return;
    // A low GraphQL budget waits for its reset; stored updates above cost no GitHub call.
    if (state.deps.now() < (state.budgetResetAt ?? 0)) return;

    const target = parseGithubTarget(itemKey);
    const targetText = formatTarget(target);
    // Ids every watch already knows: paging stops there, so a lagging watch still sees what came after its own cursor.
    const known = fresh.map((w) => new Set([...w.cursor.commentIds, ...w.cursor.reviewIds]));
    const since = new Set([...known[0]].filter((id) => known.every((ids) => ids.has(id))));
    let snapshot;
    try {
      await checkGh(state.deps.run, state.deps.now); // gh missing or logged out arrives as GhUnavailableError only through here
      if (state.stopped || !readAgentToolsEnabledFromDisk()) return;
      snapshot = await fetchSnapshot(state.deps.run, target, since);
    } catch (error) {
      if (error instanceof GhUnavailableError) await announcePaused(state, error.message);
      else if (!state.failing.has(itemKey)) {
        state.failing.add(itemKey);
        warn(`${itemKey} could not be fetched`, error);
      }
      return;
    }
    if (state.stopped || !readAgentToolsEnabledFromDisk()) return;
    state.failing.delete(itemKey);
    await announceResumed(state);
    if (state.stopped || !readAgentToolsEnabledFromDisk()) return;
    const budget = snapshot.rateLimit;
    if (budget && budget.remaining < BUDGET_FLOOR && state.deps.now() >= (state.budgetResetAt ?? 0)) {
      state.budgetResetAt = Date.parse(budget.resetAt) || state.deps.now() + INTERVAL_MS;
      console.warn(`[omp-web] github watcher: GraphQL budget low (${budget.remaining} points left); polling paused until ${budget.resetAt}`);
    }

    for (const watch of fresh) {
      if (state.stopped || !readAgentToolsEnabledFromDisk() || isPosting(itemKey)) return;
      let diff = diffSnapshot(watch.cursor, snapshot, postedIds(itemKey));
      if (!diff.events.length && JSON.stringify(diff.cursor) === JSON.stringify(watch.cursor)) continue;

      // Re-read shared post state immediately before mutating this watch; the SQL guards repeat it atomically.
      if (state.stopped || !readAgentToolsEnabledFromDisk() || isPosting(itemKey)) return;
      diff = diffSnapshot(watch.cursor, snapshot, postedIds(itemKey));
      if (!diff.events.length) {
        advanceCursor(watch.sessionId, itemKey, watch.registrationId, watch.cursor, diff.cursor);
        continue;
      }

      const { events, cursor } = diff;
      let batches: PendingUpdate["batches"];
      try {
        batches = splitUpdateEvents(targetText, snapshot.url, events, MAX_UPDATE_MESSAGE_CONTENT_BYTES).map((batchEvents, index) => {
          const entryId = updateEntryId(`${watch.sessionId}\0${itemKey}\0${watch.registrationId}\0batch:${index}`, batchEvents);
          const message = formatUpdate(targetText, snapshot.url, batchEvents);
          const bytes = Buffer.byteLength(JSON.stringify({
            type: "outbox_add",
            id: entryId,
            scope: OUTBOX_SCOPE_PLACEHOLDER,
            mode: "prompt",
            message,
          }));
          if (bytes > MAX_AGENT_COMMAND_REQUEST_BYTES) throw new RangeError("A GitHub update batch exceeds the agent command size limit.");
          return { entryId, message };
        });
      } catch (error) {
        const watchKey = `${watch.sessionId}\0${itemKey}`;
        if (!state.refused.has(watchKey)) {
          state.refused.add(watchKey);
          warn(`${itemKey} has an event that exceeds the agent command size limit`, error);
        }
        continue;
      }
      const update: PendingUpdate = {
        entryId: updateEntryId(`${watch.sessionId}\0${itemKey}\0${watch.registrationId}\0update`, events),
        cursor,
        final: events.some((e) => e.kind === "merged" || e.kind === "closed"),
        batches,
        batchIndex: 0,
      };
      if (state.stopped || !readAgentToolsEnabledFromDisk() || isPosting(itemKey)) return;
      const eventIds = events.flatMap((event) => {
        if (event.kind === "review" && event.databaseId !== undefined) return [event.id, `review:${event.databaseId}`];
        return [event.id];
      });
      const claimed = claimPending(watch.sessionId, itemKey, watch.registrationId, watch.cursor, update, eventIds);
      if (claimed) await deliverPending(state, watch, claimed);
    }
  } catch (error) {
    warn(`${itemKey} poll failed`, error);
  } finally {
    state.inFlight.delete(itemKey);
  }
}
async function notify(state: WatcherState, sessionId: string, kind: "paused" | "resumed", minute: number, text: string): Promise<boolean> {
  if (state.stopped || !readAgentToolsEnabledFromDisk()) return false;
  const id = `gh-${createHash("sha256").update(`${sessionId}\0${kind}\0${minute}`).digest("base64url").slice(0, 40)}`;
  const outcome = await state.deps.deliver(sessionId, id, `GitHub update (omp-web): ${text}`);
  if (state.stopped || !readAgentToolsEnabledFromDisk()) return false;
  if (outcome === "gone") removeSessionWatches(sessionId);
  return outcome !== "retry";
}


async function announcePaused(state: WatcherState, message: string): Promise<void> {
  if (!state.outage || state.outage.recovered) state.outage = { message, minute: Math.floor(state.deps.now() / 60_000), paused: new Set() };
  const outage = state.outage;
  for (const sessionId of new Set(listWatches().map((w) => w.sessionId))) {
    if (outage.paused.has(sessionId)) continue;
    if (await notify(state, sessionId, "paused", outage.minute, `watching paused: ${outage.message}`)) outage.paused.add(sessionId);
  }
}

async function announceResumed(state: WatcherState): Promise<void> {
  const outage = state.outage;
  if (!outage) return;
  outage.recovered ??= { minute: Math.floor(state.deps.now() / 60_000), told: new Set() };
  const { recovered } = outage;
  for (const sessionId of outage.paused) {
    if (recovered.told.has(sessionId)) continue;
    if (await notify(state, sessionId, "resumed", recovered.minute, "watching resumed")) recovered.told.add(sessionId);
  }
  if (recovered.told.size === outage.paused.size) state.outage = undefined;
}


const itemsOf = (): string[] => [...new Set(listWatches().map((w) => w.itemKey))];

/** One pass over every watched item, now. Does nothing while Agent tools is off. */
export async function pollOnce(): Promise<void> {
  const state = globalThis.__ompGithubWatcher;
  if (!state || !readAgentToolsEnabledFromDisk()) return;
  try {
    await reconcileOutboxReceiptPins();
  } catch (error) {
    warn("outbox receipts could not be reconciled", error);
    return;
  }
  for (const itemKey of itemsOf()) await pollItem(state, itemKey);
}

function cycle(state: WatcherState): void {
  if (state.stopped) return;
  const track = (fn: () => void, ms: number) => {
    const cancel = state.deps.schedule(() => {
      state.cancels.delete(cancel);
      fn();
    }, ms);
    state.cancels.add(cancel);
  };
  let items: string[] = [];
  try {
    items = readAgentToolsEnabledFromDisk() ? itemsOf() : [];
  } catch (error) {
    warn("watches could not be read", error); // the next cycle is still scheduled below
  }
  const interval = Math.max(INTERVAL_MS, items.length * ITEM_SPACING_MS);
  track(() => cycle(state), interval);
  items.forEach((itemKey, index) => track(() => void pollItem(state, itemKey), Math.floor((index * interval) / items.length)));
}

export function startGithubWatcher(deps: WatcherDeps = {}): void {
  if (globalThis.__ompGithubWatcher) return;
  const state: WatcherState = {
    deps: { run: deps.run ?? defaultGhRunner, deliver: deps.deliver ?? defaultDeliver, now: deps.now ?? Date.now, schedule: deps.schedule ?? defaultSchedule },
    cancels: new Set(),
    inFlight: new Set(),
    failing: new Set(),
    refused: new Set(),
    stopped: false,
  };
  globalThis.__ompGithubWatcher = state;
  process.once("exit", stopGithubWatcher);
  // Lazy for the same reason as the default deliver: rpc-manager loads the agent tools that load this module.
  void import("../rpc-manager")
    .then(({ onSessionMove }) => {
      if (state.stopped) return;
      state.detachMove = onSessionMove((from, to) => {
        try {
          renameSession(from, to);
        } catch (error) {
          warn(`watches of ${from} did not follow the move`, error); // rpc-manager calls listeners unguarded
        }
      });
    })
    .catch((error) => warn("session moves are not followed", error));
  cycle(state);
}

export function stopGithubWatcher(): void {
  const state = globalThis.__ompGithubWatcher;
  if (!state) return;
  state.stopped = true;
  for (const cancel of state.cancels) cancel();
  state.cancels.clear();
  state.detachMove?.();
  process.off("exit", stopGithubWatcher);
  globalThis.__ompGithubWatcher = undefined;
  closeWatchStore();
}
