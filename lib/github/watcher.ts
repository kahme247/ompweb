import { createHash } from "node:crypto";
import { loadWebServerSettings } from "../web-settings";
import { fetchSnapshot } from "./api";
import { diffSnapshot, formatUpdate, updateEntryId } from "./events";
import { checkGh, defaultGhRunner, formatTarget, GhUnavailableError, parseGithubTarget, type GhRunner } from "./gh";
import { closeWatchStore, commitUpdate, getPending, isPosting, listWatches, postedIds, removeSessionWatches, renameSession, setPending, type PendingUpdate, type Watch } from "./watch-store";

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
  /** Watches whose refused update was logged ("session\0item"). */
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
 * Delivers a stored update; `ok` saves its cursor, `gone` ends the session's watches, `retry` leaves the row for the next poll.
 * `rejected` drops the update but saves its cursor, so the watch goes on instead of retrying a refusal forever.
 */
async function deliverPending(state: WatcherState, sessionId: string, itemKey: string, pending: PendingUpdate): Promise<void> {
  const outcome = await state.deps.deliver(sessionId, pending.entryId, pending.message);
  if (outcome === "gone") removeSessionWatches(sessionId);
  else if (outcome !== "retry") {
    const watchKey = `${sessionId}\0${itemKey}`;
    if (outcome !== "ok" && !state.refused.has(watchKey)) {
      state.refused.add(watchKey);
      console.warn(`[omp-web] github watcher: the outbox of ${sessionId} refused an update for ${itemKey} (${outcome.rejected}); dropped it`);
    }
    commitUpdate(sessionId, itemKey, pending.cursor, pending.final);
  }
}

/** Same id for the same session, kind and minute, so a repeat after a crash collapses in the outbox. */
async function notify(state: WatcherState, sessionId: string, kind: "paused" | "resumed", minute: number, text: string): Promise<boolean> {
  const id = `gh-${createHash("sha256").update(`${sessionId}\0${kind}\0${minute}`).digest("base64url").slice(0, 40)}`;
  const outcome = await state.deps.deliver(sessionId, id, `GitHub update (omp-web): ${text}`);
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

async function pollItem(state: WatcherState, itemKey: string): Promise<void> {
  if (state.stopped || !loadWebServerSettings().agentToolsEnabled || state.inFlight.has(itemKey)) return;
  state.inFlight.add(itemKey);
  try {
    const watches = listWatches().filter((w) => w.itemKey === itemKey);
    // A stored update is redelivered as it is; only watches without one are diffed anew.
    const fresh: Watch[] = [];
    for (const watch of watches) {
      const pending = getPending(watch.sessionId, itemKey);
      if (pending) await deliverPending(state, watch.sessionId, itemKey, pending);
      else fresh.push(watch);
    }
    if (!fresh.length) return;
    // A low GraphQL budget waits for its reset; stored updates above cost no GitHub call.
    if (state.deps.now() < (state.budgetResetAt ?? 0)) return;

    const target = parseGithubTarget(itemKey);
    // Ids every watch already knows: paging stops there, so a lagging watch still sees what came after its own cursor.
    const known = fresh.map((w) => new Set([...w.cursor.commentIds, ...w.cursor.reviewIds]));
    const since = new Set([...known[0]].filter((id) => known.every((ids) => ids.has(id))));
    let snapshot;
    try {
      await checkGh(state.deps.run, state.deps.now); // gh missing or logged out arrives as GhUnavailableError only through here
      snapshot = await fetchSnapshot(state.deps.run, target, since);
    } catch (error) {
      if (error instanceof GhUnavailableError) await announcePaused(state, error.message);
      else if (!state.failing.has(itemKey)) {
        state.failing.add(itemKey);
        warn(`${itemKey} could not be fetched`, error);
      }
      return;
    }
    state.failing.delete(itemKey);
    await announceResumed(state);
    const budget = snapshot.rateLimit;
    if (budget && budget.remaining < BUDGET_FLOOR && state.deps.now() >= (state.budgetResetAt ?? 0)) {
      state.budgetResetAt = Date.parse(budget.resetAt) || state.deps.now() + INTERVAL_MS;
      console.warn(`[omp-web] github watcher: GraphQL budget low (${budget.remaining} points left); polling paused until ${budget.resetAt}`);
    }
    // An agent post to this item may be in the snapshot before its id is recorded: the next poll diffs it.
    if (isPosting(itemKey)) return;

    const posted = postedIds(itemKey);
    for (const watch of fresh) {
      const { events, cursor } = diffSnapshot(watch.cursor, snapshot, posted);
      if (!events.length) {
        if (JSON.stringify(cursor) !== JSON.stringify(watch.cursor)) commitUpdate(watch.sessionId, itemKey, cursor, false);
        continue;
      }
      const update = {
        // createdAt: a close after a re-watch repeats the first close's event id, and the outbox keeps delivered ids for days.
        entryId: updateEntryId(`${watch.sessionId}\0${itemKey}\0${watch.createdAt}`, events),
        message: formatUpdate(formatTarget(target), snapshot.url, events),
        cursor,
        final: events.some((e) => e.kind === "merged" || e.kind === "closed"),
      };
      if (setPending(watch.sessionId, itemKey, update)) await deliverPending(state, watch.sessionId, itemKey, update);
    }
  } catch (error) {
    warn(`${itemKey} poll failed`, error);
  } finally {
    state.inFlight.delete(itemKey);
  }
}

const itemsOf = (): string[] => [...new Set(listWatches().map((w) => w.itemKey))];

/** One pass over every watched item, now. Does nothing while Agent tools is off. */
export async function pollOnce(): Promise<void> {
  const state = globalThis.__ompGithubWatcher;
  if (!state || !loadWebServerSettings().agentToolsEnabled) return;
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
    items = loadWebServerSettings().agentToolsEnabled ? itemsOf() : [];
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
