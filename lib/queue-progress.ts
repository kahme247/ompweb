// Per-session ledger of queued prompts and how far omp got with each one.
//
// omp's queue snapshots (`queue_update`, `get_state.queuedMessages`) list only
// what is still waiting: an item silently vanishes once omp takes it. The
// ledger remembers every item of the current batch and derives its progress
// from the frames omp already sends:
//
//   appears in a snapshot          → queued
//   leaves the snapshot, then its
//   text arrives as a user message → running  ("all" mode starts several at once)
//   the run that consumed it ends  → done, or failed when the run errored/aborted
//   a later follow-up starts       → done     (follow-ups only start once the
//                                              agent would otherwise stop)
//   withdrawn without delivery     → cancelled (remove_queued_message, abort)
//
// Items are plain strings without ids, so they are matched by text and order.
// Identical texts are resolved deterministically: omp delivers from the front
// and removes the first match, so when a snapshot shrinks the *earliest*
// matching item is the one that left.
//
// Pure and synchronous: the caller (lib/rpc-manager.ts) feeds frames and
// supplies the clock. The ledger lives in memory for one omp process, so it
// starts empty again whenever omp or omp-web restarts.

import type { QueuedMessages } from "./pi-types";

export type QueueName = "steering" | "followUp";
export type QueueProgressStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type QueueRunOutcome = "completed" | "failed" | "aborted";

export interface QueueProgressItem {
  id: string;
  text: string;
  queue: QueueName;
  status: QueueProgressStatus;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Still `queued`, but omp's queue no longer holds it: it was taken and has
   *  not reached the transcript yet. Edit/Delete/Steer cannot act on it. */
  departed?: true;
}

/** Wire shape (`get_state.queueProgress` and `queue_progress` frames). */
export interface QueueProgressSnapshot {
  /** Identifies one ledger (one omp process); revisions only compare within it. */
  epoch: string;
  revision: number;
  items: QueueProgressItem[];
}

const QUEUE_STATUSES: readonly QueueProgressStatus[] = ["queued", "running", "done", "failed", "cancelled"];

interface Entry extends Omit<QueueProgressItem, "departed"> {
  /** Creation order, the final tie-breaker everywhere. */
  seq: number;
  /** Index in omp's queue while queued. */
  position: number;
  /** Left omp's snapshot but has not been seen in the transcript yet. */
  departed: boolean;
  departedSeq: number;
  /** Turn in which it started (follow-ups complete earlier turns' items). */
  startedTurn: number;
  /** Started or settled by inference (a later item's delivery, the run's end)
   *  rather than by its own transcript message; a confirmed removal overrides it. */
  inferred: boolean;
}

const QUEUES: readonly QueueName[] = ["steering", "followUp"];

const isActive = (entry: Entry) => entry.status === "queued" || entry.status === "running";

/**
 * Pair old queued texts with a new snapshot (longest common subsequence),
 * leaving the EARLIEST old items unmatched when several alignments are equally
 * long. Returns, for each old index, the new index it maps to or -1.
 */
export function alignQueue(oldTexts: readonly string[], newTexts: readonly string[]): number[] {
  const n = oldTexts.length;
  const m = newTexts.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] = oldTexts[i - 1] === newTexts[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const mapping = new Array<number>(n).fill(-1);
  // Backtracking from the end matches the latest old item first, so the
  // unmatched (departed) ones are the earliest.
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (oldTexts[i - 1] === newTexts[j - 1]) {
      mapping[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return mapping;
}

/**
 * The text omp's queue chip shows for a transcript user message, or null when
 * the message cannot come from the user's queue (other roles, agent-authored
 * input, hidden companions).
 */
export function queuedTextOfUserMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const value = message as { role?: unknown; content?: unknown; attribution?: unknown };
  if (value.role !== "user" || value.attribution === "agent") return null;
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return null;
  const texts: string[] = [];
  let hasImage = false;
  for (const block of value.content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block?.type === "image") hasImage = true;
  }
  if (texts.length > 0) return texts.join("\n");
  // omp labels an image-only queued message "[Image]".
  return hasImage ? "[Image]" : null;
}

/** How a terminal `agent_end` ended, from its last assistant message. */
export function runOutcomeOfAgentEnd(event: { [key: string]: unknown }): QueueRunOutcome {
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown } | null;
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "error") return "failed";
    return "completed";
  }
  return "completed";
}

/** Parse omp's queue snapshot from a `queue_update` frame or `get_state`; null when absent. */
export function readQueueSnapshot(value: unknown): QueuedMessages | null {
  if (!value || typeof value !== "object" || !("steering" in value) || !("followUp" in value)) return null;
  const [steering, followUp] = [value.steering, value.followUp].map((list) =>
    Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  return { steering, followUp };
}

/** Parse a ledger snapshot from a `queue_progress` frame or `get_state.queueProgress`. */
export function readQueueProgressSnapshot(value: unknown): QueueProgressSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const { epoch, revision, items } = value as Record<string, unknown>;
  if (typeof epoch !== "string" || typeof revision !== "number" || !Array.isArray(items)) return null;
  const parsed: QueueProgressItem[] = [];
  for (const raw of items as Array<Record<string, unknown> | null>) {
    if (!raw || typeof raw.id !== "string" || typeof raw.text !== "string" || typeof raw.queuedAt !== "number") continue;
    if (raw.queue !== "steering" && raw.queue !== "followUp") continue;
    if (!QUEUE_STATUSES.includes(raw.status as QueueProgressStatus)) continue;
    parsed.push({
      id: raw.id,
      text: raw.text,
      queue: raw.queue,
      status: raw.status as QueueProgressStatus,
      queuedAt: raw.queuedAt,
      ...(typeof raw.startedAt === "number" ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.finishedAt === "number" ? { finishedAt: raw.finishedAt } : {}),
      ...(raw.departed === true ? { departed: true as const } : {}),
    });
  }
  return { epoch, revision, items: parsed };
}

export interface QueueProgressLedgerOptions {
  epoch: string;
  createId: () => string;
}

export class QueueProgressLedger {
  private readonly epoch: string;
  private readonly createId: () => string;
  private entries: Entry[] = [];
  private revision = 0;
  private seq = 0;
  private departureSeq = 0;
  private turn = 0;

  constructor({ epoch, createId }: QueueProgressLedgerOptions) {
    this.epoch = epoch;
    this.createId = createId;
  }

  snapshot(): QueueProgressSnapshot {
    // Started items in start order, then pending items in delivery order
    // (steering drains before follow-ups), then items withdrawn unstarted.
    const started: Entry[] = [];
    const queued: Entry[] = [];
    const withdrawn: Entry[] = [];
    for (const entry of this.entries) {
      if (entry.status === "queued") queued.push(entry);
      else if (entry.status === "cancelled" && entry.startedAt === undefined) withdrawn.push(entry);
      else started.push(entry);
    }
    started.sort((a, b) => (a.startedAt ?? a.finishedAt ?? 0) - (b.startedAt ?? b.finishedAt ?? 0) || a.seq - b.seq);
    queued.sort((a, b) => Number(b.departed) - Number(a.departed)
      || QUEUES.indexOf(a.queue) - QUEUES.indexOf(b.queue)
      || a.position - b.position
      || a.seq - b.seq);
    return {
      epoch: this.epoch,
      revision: this.revision,
      items: [...started, ...queued, ...withdrawn].map(publicItem),
    };
  }

  /** A `queue_update` frame or `get_state.queuedMessages`. Returns whether anything changed. */
  observeQueue(snapshot: QueuedMessages, now: number): boolean {
    let changed = false;
    const departedNow: Entry[] = [];
    const unmatched: Record<QueueName, Array<{ text: string; position: number }>> = { steering: [], followUp: [] };
    for (const queue of QUEUES) {
      const texts = snapshot[queue];
      const pending = this.entries
        .filter((entry) => entry.status === "queued" && !entry.departed && entry.queue === queue)
        .sort((a, b) => a.position - b.position || a.seq - b.seq);
      const mapping = alignQueue(pending.map((entry) => entry.text), texts);
      const taken = new Set<number>();
      pending.forEach((entry, index) => {
        const position = mapping[index];
        if (position >= 0) {
          taken.add(position);
          if (entry.position !== position) {
            entry.position = position;
            changed = true;
          }
        } else {
          entry.departed = true;
          entry.departedSeq = ++this.departureSeq;
          departedNow.push(entry);
        }
      });
      texts.forEach((text, position) => {
        if (!taken.has(position)) unmatched[queue].push({ text, position });
      });
    }
    // promote_queued_message moves a follow-up to the end of the steering queue.
    for (const added of [...unmatched.steering]) {
      const promoted = departedNow.find((entry) => entry.queue === "followUp" && entry.departed && entry.text === added.text);
      if (!promoted) continue;
      promoted.queue = "steering";
      promoted.departed = false;
      promoted.position = added.position;
      unmatched.steering.splice(unmatched.steering.indexOf(added), 1);
      changed = true;
    }
    if (departedNow.length > 0) changed = true;

    const additions = [...unmatched.steering.map((item) => ({ ...item, queue: "steering" as const })),
      ...unmatched.followUp.map((item) => ({ ...item, queue: "followUp" as const }))];
    if (additions.length > 0) {
      // A new batch starts once nothing of the previous one is still pending.
      if (!this.entries.some(isActive)) this.entries = [];
      for (const { text, position, queue } of additions) {
        this.entries.push({
          id: this.createId(),
          text,
          queue,
          status: "queued",
          queuedAt: now,
          seq: ++this.seq,
          position,
          departed: false,
          departedSeq: 0,
          startedTurn: 0,
          inferred: false,
        });
      }
      changed = true;
    }
    return this.bump(changed);
  }

  /** A `turn_start` frame: delivered follow-ups begin a new turn. */
  observeTurnStart(): void {
    this.turn += 1;
  }

  /** A user message entered the transcript (`message_start`). */
  observeUserMessage(text: string, now: number): boolean {
    const entry = this.findDelivered(text);
    if (!entry) return false;
    // Items that left the queue before this one were delivered too, under a
    // rewritten text (slash command, template); they run alongside it.
    for (const earlier of this.entries) {
      if (earlier.status === "queued" && earlier.departed && earlier.departedSeq < entry.departedSeq) {
        this.start(earlier, now, true);
      }
    }
    if (entry.queue === "followUp") {
      // A follow-up starts only once the agent would otherwise stop, so the
      // work of every item started in an earlier turn is finished.
      for (const running of this.entries) {
        if (running.status === "running" && running.startedTurn < this.turn) this.finish(running, "done", now);
      }
    }
    this.start(entry, now);
    return this.bump(true);
  }

  /** A terminal `agent_end` (or a failed prompt) ended the run. */
  observeRunEnd(outcome: QueueRunOutcome, now: number): boolean {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.status === "running") {
        this.finish(entry, outcome === "completed" ? "done" : "failed", now);
        changed = true;
      } else if (entry.status === "queued" && entry.departed) {
        // Left the queue but never matched a transcript message: delivered
        // under a rewritten text when the run completed or failed, dropped
        // by the abort otherwise.
        this.finish(entry, outcome === "completed" ? "done" : outcome === "failed" ? "failed" : "cancelled", now);
        entry.inferred = true;
        changed = true;
      }
    }
    return this.bump(changed);
  }

  /** `remove_queued_message` answered `removed: true`. */
  observeRemoval(text: string, queue: QueueName, now: number): boolean {
    const matches = this.entries.filter((entry) => entry.queue === queue && entry.text === text);
    // The snapshot that dropped it arrives first (departed). A later item's
    // delivery or the run's end may have settled it by inference before this
    // reply: the removal proves omp never ran it. Without either, omp removed
    // the first pending match.
    const entry = matches.filter((item) => item.status === "queued" && item.departed).sort((a, b) => a.departedSeq - b.departedSeq)[0]
      ?? matches.filter((item) => item.inferred && item.status !== "cancelled").sort((a, b) => a.departedSeq - b.departedSeq)[0]
      ?? matches.filter((item) => item.status === "queued").sort((a, b) => a.position - b.position || a.seq - b.seq)[0];
    if (!entry) return false;
    entry.startedAt = undefined;
    this.finish(entry, "cancelled", now);
    return this.bump(true);
  }

  /** The newest entry so far; {@link observeAbort} leaves later entries alone. */
  boundary(): number {
    return this.seq;
  }

  /**
   * `abort` / `abort_and_restore_queue` answered. The run's own `agent_end`
   * marks running items failed; this settles the queue: items omp took but
   * never recorded were dropped, and `restoreQueue` withdraws everything.
   * Only entries up to `boundary` (taken before the abort was sent) are
   * settled: a prompt queued after it can reach the ledger before the reply.
   */
  observeAbort({ restoreQueue, boundary }: { restoreQueue: boolean; boundary: number }, now: number): boolean {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.seq > boundary) continue;
      if (entry.status === "running") {
        this.finish(entry, "failed", now);
        changed = true;
      } else if (entry.status === "queued" && (entry.departed || restoreQueue)) {
        this.finish(entry, "cancelled", now);
        changed = true;
      }
    }
    return this.bump(changed);
  }

  /** Clear finished items (the user dismissed the summary). */
  dismissFinished(): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(isActive);
    return this.bump(this.entries.length !== before);
  }

  /** Forget everything (the session switched to another conversation). */
  reset(): boolean {
    const changed = this.entries.length > 0;
    this.entries = [];
    return this.bump(changed);
  }

  private findDelivered(text: string): Entry | undefined {
    const departed = this.entries
      .filter((entry) => entry.status === "queued" && entry.departed && entry.text === text)
      .sort((a, b) => a.departedSeq - b.departedSeq)[0];
    if (departed) return departed;
    // Live steering can record a message before the snapshot drops it.
    return this.entries
      .filter((entry) => entry.status === "queued" && entry.text === text)
      .sort((a, b) => QUEUES.indexOf(a.queue) - QUEUES.indexOf(b.queue) || a.position - b.position || a.seq - b.seq)[0];
  }

  private start(entry: Entry, now: number, inferred = false): void {
    entry.status = "running";
    entry.departed = false;
    entry.startedAt = now;
    entry.startedTurn = this.turn;
    entry.inferred = inferred;
  }

  private finish(entry: Entry, status: "done" | "failed" | "cancelled", now: number): void {
    entry.status = status;
    entry.departed = false;
    entry.finishedAt = now;
  }

  private bump(changed: boolean): boolean {
    if (changed) this.revision += 1;
    return changed;
  }
}

function publicItem(entry: Entry): QueueProgressItem {
  return {
    id: entry.id,
    text: entry.text,
    queue: entry.queue,
    status: entry.status,
    queuedAt: entry.queuedAt,
    ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
    ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
    ...(entry.status === "queued" && entry.departed ? { departed: true as const } : {}),
  };
}

export interface QueuePanelItem extends QueueProgressItem {
  /** The first chip with its text in omp's queue, so Edit/Delete/Steer act on it. */
  actionable: boolean;
}

/**
 * What the composer's queue panel lists: the ledger's batch, with omp's own
 * queue snapshot deciding which pending items can still be edited. A chip the
 * ledger has not reported yet (HTTP and SSE can reorder) still shows, so the
 * panel never hides something omp will run.
 *
 * omp's queue commands carry only the text and act on the first match, so of
 * several identical pending items only the first offers them; a departed item
 * left omp's queue and never claims a chip.
 */
export function buildQueuePanelItems(progress: QueueProgressSnapshot | null, queue: QueuedMessages | null): QueuePanelItem[] {
  const chips: Record<QueueName, readonly string[]> = { steering: queue?.steering ?? [], followUp: queue?.followUp ?? [] };
  const claimed: Record<QueueName, boolean[]> = {
    steering: chips.steering.map(() => false),
    followUp: chips.followUp.map(() => false),
  };
  const firstOfText = (name: QueueName, index: number) => chips[name].indexOf(chips[name][index]) === index;
  const items: QueuePanelItem[] = (progress?.items ?? []).map((item) => {
    if (item.status !== "queued" || item.departed) return { ...item, actionable: false };
    const index = chips[item.queue].findIndex((text, position) => !claimed[item.queue][position] && text === item.text);
    if (index < 0) return { ...item, actionable: false };
    claimed[item.queue][index] = true;
    return { ...item, actionable: firstOfText(item.queue, index) };
  });
  for (const name of QUEUES) {
    chips[name].forEach((text, index) => {
      if (claimed[name][index]) return;
      items.push({ id: `chip:${name}:${index}:${text}`, text, queue: name, status: "queued", queuedAt: 0, actionable: firstOfText(name, index) });
    });
  }
  return items;
}
