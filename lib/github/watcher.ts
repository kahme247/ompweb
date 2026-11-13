import { createHash } from "node:crypto";
import { loadWebServerSettings } from "../web-settings";
import { fetchSnapshot } from "./api";
import { diffSnapshot, formatUpdate, updateEntryId } from "./events";
import { defaultGhRunner, formatTarget, GhUnavailableError, parseGithubTarget, type GhRunner } from "./gh";
import { closeWatchStore, commitUpdate, getPending, listWatches, postedIds, removeSessionWatches, renameSession, setPending, type PendingUpdate, type Watch } from "./watch-store";

/**
 * Server-only poller: every watched item is fetched once per interval (items
 * spread across it), and what is new goes into each watching session's message
 * outbox. A stored pending row per watch makes a crash between the outbox add
 * and the cursor save replay the same entry id.
 */

export type Delivery = "ok" | "gone" | "retry";

export interface WatcherDeps {
  run?: GhRunner;
  deliver?: (sessionId: string, entryId: string, message: string) => Promise<Delivery>;
  now?: () => number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

const INTERVAL_MS = 60_000;

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
    const response = await runOutboxCommand(sessionId, { type: "outbox_add", id, scope: outboxScope(), mode: "prompt", message }, false, "omp-web:github-watch");
    return response.ok ? "ok" : response.status === 404 ? "gone" : "retry";
  } catch {
    return "retry";
  }
}

const defaultSchedule: Required<WatcherDeps>["schedule"] = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const warn = (what: string, error: unknown) => console.warn(`[omp-web] github watcher: ${what}: ${error instanceof Error ? error.message : String(error)}`);

/** Delivers a stored update; `ok` saves its cursor, `gone` ends the session's watches, `retry` leaves the row for the next poll. */
async function deliverPending(state: WatcherState, sessionId: string, itemKey: string, pending: PendingUpdate): Promise<void> {
  const outcome = await state.deps.deliver(sessionId, pending.entryId, pending.message);
  if (outcome === "ok") commitUpdate(sessionId, itemKey, pending.cursor, pending.final);
  else if (outcome === "gone") removeSessionWatches(sessionId);
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

    const target = parseGithubTarget(itemKey);
    const since = new Set(fresh.flatMap((w) => [...w.cursor.commentIds, ...w.cursor.reviewIds]));
    let snapshot;
    try {
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

    const posted = postedIds(itemKey);
    for (const watch of fresh) {
      const { events, cursor } = diffSnapshot(watch.cursor, snapshot, posted);
      if (!events.length) {
        if (JSON.stringify(cursor) !== JSON.stringify(watch.cursor)) commitUpdate(watch.sessionId, itemKey, cursor, false);
        continue;
      }
      const update = {
        entryId: updateEntryId(`${watch.sessionId}\0${itemKey}`, events),
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
  const items = loadWebServerSettings().agentToolsEnabled ? itemsOf() : [];
  items.forEach((itemKey, index) => track(() => void pollItem(state, itemKey), Math.floor((index * INTERVAL_MS) / items.length)));
  track(() => cycle(state), INTERVAL_MS);
}

export function startGithubWatcher(deps: WatcherDeps = {}): void {
  if (globalThis.__ompGithubWatcher) return;
  const state: WatcherState = {
    deps: { run: deps.run ?? defaultGhRunner, deliver: deps.deliver ?? defaultDeliver, now: deps.now ?? Date.now, schedule: deps.schedule ?? defaultSchedule },
    cancels: new Set(),
    inFlight: new Set(),
    failing: new Set(),
    stopped: false,
  };
  globalThis.__ompGithubWatcher = state;
  process.once("exit", stopGithubWatcher);
  // Lazy for the same reason as the default deliver: rpc-manager loads the agent tools that load this module.
  void import("../rpc-manager")
    .then(({ onSessionMove }) => {
      if (state.stopped) return;
      state.detachMove = onSessionMove((from, to) => renameSession(from, to));
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
  globalThis.__ompGithubWatcher = undefined;
  closeWatchStore();
}
