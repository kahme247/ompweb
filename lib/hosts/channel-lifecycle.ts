import { isRecord } from "../type-guards";
import { idOf, requestKey, wireEvent, type WireFrame } from "./pending-requests";

type Timer = NodeJS.Timeout;
type LifecycleOptions = {
  stop(reason: "abandoned" | "idle"): void;
  onRunning?(running: boolean): void;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
  abandonedMs?: number; idleMs?: number; graceMs?: number;
};

export class ChannelLifecycle {
  private readonly clock: () => number;
  private readonly later: (fn: () => void, ms: number) => Timer;
  private readonly cancel: (timer: Timer) => void;
  private readonly abandonedMs: number;
  private readonly idleMs: number;
  private readonly graceMs: number;
  private readonly links = new Map<string, { on: boolean; preparing: boolean; grace?: Timer }>();
  private readonly commands = new Set<string>();
  private readonly requests = new Set<string>();
  private readonly awaitingStart = new Set<string>();
  /** True once a submitted queue command is represented by an authoritative native queue snapshot/ACK. */
  private readonly awaitingQueue = new Map<string, boolean>();
  private queuePresent = false;
  private queueRevision = 0;
  private readonly queueWithdrawals = new Map<string, number>();
  private withdrawalAfter: number | null = null;
  private running = false;
  private unsettled = false;
  private compacting = false;
  private startup = true;
  private wasProtected = true;
  private disposed = false;
  private idleSince: number;
  private abandonedSince: number | null = null;
  private timer?: Timer;

  constructor(private readonly options: LifecycleOptions) {
    this.clock = options.now ?? Date.now;
    this.later = options.setTimeout ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.cancel = options.clearTimeout ?? clearTimeout;
    const configured = Number(process.env.OMP_WEB_DISCONNECT_DESTROY_MS ?? 120000);
    this.abandonedMs = options.abandonedMs ?? (Number.isFinite(configured) && configured >= 0 ? configured : 120000);
    this.idleMs = options.idleMs ?? 600000;
    this.graceMs = options.graceMs ?? 120000;
    this.idleSince = this.clock();
  }

  get isRunning(): boolean { return this.running || this.unsettled; }
  get activeTurn(): boolean { return this.running; }
  get isIdle(): boolean {
    if (this.disposed || this.startup || this.isRunning || this.compacting || this.commands.size > 0 || this.requests.size > 0
      || this.awaitingStart.size > 0 || this.awaitingQueue.size > 0 || this.queuePresent) return false;
    for (const link of this.links.values()) if (link.preparing) return false;
    return true;
  }
  setStartup(on: boolean): void { this.startup = on; this.changed(); }
  setInterest(id: string, on: boolean): void {
    const old = this.links.get(id);
    if (old?.grace !== undefined) this.cancel(old.grace);
    this.links.set(id, { on, preparing: old?.preparing ?? false });
    this.changed();
  }
  setPreparing(id: string, on: boolean): void {
    const state = this.links.get(id) ?? { on: false, preparing: false };
    state.preparing = on; this.links.set(id, state); this.changed();
  }
  linkDown(id: string): void {
    const state = this.links.get(id);
    if (!state || state.grace !== undefined) return;
    state.grace = this.later(() => { this.links.delete(id); this.changed(); }, this.graceMs);
  }
  linkGone(id: string): void { this.linkDown(id); }
  linkUp(id: string): void {
    const state = this.links.get(id);
    if (!state) return;
    if (state.grace !== undefined) this.cancel(state.grace);
    state.grace = undefined;
    this.changed();
  }

  noteStdin(frame: WireFrame): void {
    this.idleSince = this.clock();
    const request = requestKey(frame), id = frame.t === "cmd" ? idOf(frame.id) : null;
    if (request && !request.open) this.requests.delete(request.key);
    if (id !== null) {
      this.commands.add(id);
      const op = frame.op, args = isRecord(frame.args) ? frame.args : {};
      if (op === "prompt" || op === "abort_and_prompt" || op === "steer" || op === "follow_up" || op === "followUp") {
        const queued = op === "steer" || op === "follow_up" || op === "followUp"
          || args.streamingBehavior === "steer" || args.streamingBehavior === "followUp";
        if (queued) this.awaitingQueue.set(id, false);
        else this.awaitingStart.add(id);
      }
      if (op === "remove_queued_message" || op === "abort_and_restore_queue") this.queueWithdrawals.set(id, this.queueRevision);
    }
    this.changed();
  }
  noteStdout(frame: WireFrame): void {
    this.idleSince = this.clock();
    const before = this.isRunning;
    // The runner sends its own frames (prompt_result, …) top level, AgentSession's inside `event`.
    const event = wireEvent(frame) ?? { ...frame, type: frame.t };
    switch (event.type) {
      case "agent_start":
        this.running = true; this.unsettled = true; this.awaitingStart.clear(); this.awaitingQueue.clear(); break;
      case "agent_end": if (event.isTerminal !== false) this.running = false; break;
      case "session_settled":
        this.running = false; this.unsettled = false;
        this.awaitingStart.clear(); this.awaitingQueue.clear(); this.queuePresent = false; this.queueWithdrawals.clear(); this.withdrawalAfter = null; break;
      case "prompt_result": case "prompt_error":
        this.awaitingStart.clear(); this.awaitingQueue.clear(); this.queuePresent = false; this.queueWithdrawals.clear(); this.withdrawalAfter = null; break;
      case "queue_update":
        if (!Array.isArray(event.steering) || !Array.isArray(event.followUp)) break;
        this.queueRevision += 1;
        this.queuePresent = event.steering.length > 0 || event.followUp.length > 0;
        if (this.queuePresent) {
          for (const id of this.awaitingQueue.keys()) if (!this.commands.has(id)) this.awaitingQueue.set(id, true);
        }
        // Consumption also empties the queue; only an acknowledged withdrawal releases its start guard.
        this.releaseWithdrawnQueue();
        break;
      case "auto_compaction_start": this.compacting = true; break;
      case "auto_compaction_end": this.compacting = false; break;
    }
    const id = frame.t === "res" ? idOf(frame.id) : null;
    if (id !== null) {
      this.commands.delete(id);
      if (frame.ok === false || (isRecord(frame.data) && frame.data.agentInvoked === false)) {
        this.awaitingStart.delete(id); this.awaitingQueue.delete(id);
      } else if (this.awaitingQueue.has(id) && (this.queuePresent || (isRecord(frame.data) && frame.data.queued === true))) {
        this.awaitingQueue.set(id, true);
      }
      if (this.queueWithdrawals.has(id)) {
        const revision = this.queueWithdrawals.get(id)!;
        this.queueWithdrawals.delete(id);
        if (frame.ok === true) {
          this.withdrawalAfter = revision;
          this.releaseWithdrawnQueue();
        }
      }
    }
    const request = requestKey(frame);
    if (request?.open) this.requests.add(request.key);
    else if (request) this.requests.delete(request.key);
    if (before !== this.isRunning) this.options.onRunning?.(this.isRunning);
    this.changed();
  }

  /** A timeout is not proof that native execution did not start; only a rejected write releases that guard. */
  forgetCommand(id: string, rejected = false): void {
    this.commands.delete(id); this.queueWithdrawals.delete(id);
    if (rejected) { this.awaitingStart.delete(id); this.awaitingQueue.delete(id); }
    this.changed();
  }

  private releaseWithdrawnQueue(): void {
    if (this.withdrawalAfter === null || this.queueRevision <= this.withdrawalAfter) return;
    if (!this.queuePresent) {
      for (const [id, represented] of this.awaitingQueue) if (represented && !this.commands.has(id)) this.awaitingQueue.delete(id);
    }
    this.withdrawalAfter = null;
  }

  private changed(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    const now = this.clock();
    const protectedWork = !this.isIdle;
    if (protectedWork) { this.wasProtected = true; this.idleSince = now; this.abandonedSince = null; return; }
    if (this.wasProtected) this.idleSince = now;
    this.wasProtected = false;
    const interested = [...this.links.values()].some(link => link.on);
    if (interested) this.abandonedSince = null;
    else this.abandonedSince ??= now;
    const abandonedAt = this.abandonedMs > 0 && this.abandonedSince !== null ? this.abandonedSince + this.abandonedMs : Infinity;
    const idleAt = this.idleSince + this.idleMs;
    this.timer = this.later(() => {
      this.timer = undefined;
      if (this.disposed) return;
      this.disposed = true;
      this.options.stop(abandonedAt <= idleAt ? "abandoned" : "idle");
    }, Math.max(0, Math.min(abandonedAt, idleAt) - now));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    for (const link of this.links.values()) if (link.grace !== undefined) this.cancel(link.grace);
    this.links.clear();
  }
}
