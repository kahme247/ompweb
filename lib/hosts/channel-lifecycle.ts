import { BLOCKING_UI_METHODS } from "../notification-events";
import type { RpcFrameRecord } from "../omp/rpc-frame";

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

  noteStdin(frame: RpcFrameRecord): void {
    this.idleSince = this.clock();
    if (frame.type === "extension_ui_response" || frame.type === "host_tool_result" || frame.type === "host_uri_result") {
      if (typeof frame.id === "string") this.requests.delete(frame.id);
    } else if (typeof frame.id === "string") this.commands.add(frame.id);
    this.changed();
  }
  noteStdout(frame: RpcFrameRecord): void {
    this.idleSince = this.clock();
    const before = this.isRunning;
    switch (frame.type) {
      case "agent_start": this.running = true; this.unsettled = true; break;
      case "agent_end": if (frame.isTerminal !== false) this.running = false; break;
      case "session_settled": this.running = false; this.unsettled = false; break;
      case "auto_compaction_start": this.compacting = true; break;
      case "auto_compaction_end": this.compacting = false; break;
      case "response": if (typeof frame.id === "string") this.commands.delete(frame.id); break;
      case "host_tool_call": case "host_uri_request":
        if (typeof frame.id === "string") this.requests.add(frame.id); break;
      case "extension_ui_request":
        if (typeof frame.method === "string" && BLOCKING_UI_METHODS.has(frame.method) && typeof frame.id === "string") this.requests.add(frame.id);
        else if (frame.method === "cancel" && typeof frame.targetId === "string") this.requests.delete(frame.targetId);
        break;
      case "host_tool_cancel": case "host_uri_cancel":
        if (typeof frame.targetId === "string") this.requests.delete(frame.targetId); break;
    }
    if (before !== this.isRunning) this.options.onRunning?.(this.isRunning);
    this.changed();
  }

  /** An expired command correlation must also release its lifecycle lease. */
  forgetCommand(id: string): void { this.commands.delete(id); this.changed(); }

  private changed(): void {
    if (this.disposed) return;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    const now = this.clock();
    const protectedWork = this.startup || this.isRunning || this.compacting || this.commands.size > 0 || this.requests.size > 0
      || [...this.links.values()].some(link => link.preparing);
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
