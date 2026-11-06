import { BLOCKING_UI_METHODS } from "../notification-events";
import type { RpcFrameRecord } from "../omp/rpc-frame";
import { isRecord } from "../type-guards";
import { HostOpError } from "./link-protocol";

type Callback = { frame: RpcFrameRecord; lines: string[]; executor: string | null };
type Registration = { tools: Record<string, unknown>[]; schemes: string[] };
type SharedRequestDeps = {
  members(): string[];
  isUp(id: string): boolean;
  deliver(id: string, lines: string[]): void;
  write(frame: RpcFrameRecord): void;
};

export function validateHostTools(tools: unknown[], schemes: string[]): void {
  const valid = Array.isArray(tools) && tools.every(tool => isRecord(tool) && typeof tool.name === "string" && tool.name.length > 0
    && (tool.description === undefined || typeof tool.description === "string")
    && (tool.label === undefined || typeof tool.label === "string")
    && (tool.parameters === undefined || isRecord(tool.parameters)));
  if (!valid || !Array.isArray(schemes) || !schemes.every(scheme => typeof scheme === "string" && /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme))) {
    throw new HostOpError(400, "invalid_request", "Invalid host tool or URI registration");
  }
}

export class SharedRequests {
  private readonly dialogs = new Map<string, string[]>();
  private readonly callbacks = new Map<string, Callback>();
  private readonly completed = new Set<string>();
  private readonly registrations = new Map<string, Registration>();
  private lastPrompt: string | null = null;
  private toolUnion = "[]";
  private schemeUnion = "[]";

  constructor(private readonly deps: SharedRequestDeps) {}

  isCompleted(frame: RpcFrameRecord): boolean {
    return typeof frame.id === "string" && this.completed.has(frame.id)
      && (frame.type === "host_tool_call" || frame.type === "host_uri_request"
        || frame.type === "extension_ui_request" && typeof frame.method === "string" && BLOCKING_UI_METHODS.has(frame.method));
  }

  /** True: broadcast this frame; callbacks alone have one executor. */
  note(frame: RpcFrameRecord, lines: string[]): boolean {
    if (this.isCompleted(frame)) return false;
    if (frame.type === "extension_ui_request") {
      if (typeof frame.method === "string" && BLOCKING_UI_METHODS.has(frame.method) && typeof frame.id === "string") {
        this.dialogs.set(frame.id, lines);
      } else if (frame.method === "cancel" && typeof frame.targetId === "string") {
        this.dialogs.delete(frame.targetId); this.completed.add(frame.targetId);
      }
    }
    if ((frame.type === "host_tool_call" || frame.type === "host_uri_request") && typeof frame.id === "string") {
      if (!this.callbacks.has(frame.id)) this.callbacks.set(frame.id, { frame: { type: frame.type, toolName: frame.toolName, url: frame.url }, lines, executor: null });
      this.dispatch();
      return false;
    }
    if ((frame.type === "host_tool_cancel" || frame.type === "host_uri_cancel") && typeof frame.targetId === "string") {
      const call = this.callbacks.get(frame.targetId);
      if (call?.executor) this.deps.deliver(call.executor, lines);
      this.callbacks.delete(frame.targetId);
      this.completed.add(frame.targetId);
      return false;
    }
    return true;
  }

  answer(id: string, frame: RpcFrameRecord): boolean {
    if (typeof frame.id !== "string") return false;
    if (frame.type === "extension_ui_response") {
      if (!this.dialogs.delete(frame.id)) return false;
      this.completed.add(frame.id);
      const cancel = JSON.stringify({ type: "extension_ui_request", method: "cancel", targetId: frame.id });
      for (const other of this.deps.members()) if (other !== id) this.deps.deliver(other, [cancel]);
      return true;
    }
    const call = this.callbacks.get(frame.id);
    const resultType = call?.frame.type === "host_tool_call" ? "host_tool_result" : "host_uri_result";
    if (!call || call.executor !== id || frame.type !== resultType) return false;
    this.callbacks.delete(frame.id);
    this.completed.add(frame.id);
    return true;
  }

  prompt(id: string): void { this.lastPrompt = id; }

  setTools(id: string, tools: unknown[], schemes: string[]): void {
    validateHostTools(tools, schemes);
    this.registrations.set(id, { tools: tools as Record<string, unknown>[], schemes: [...new Set(schemes)] });
    this.updateUnion(); this.dispatch();
  }

  remove(id: string): void { this.registrations.delete(id); this.updateUnion(); this.dispatch(); }
  linkChanged(): void { this.dispatch(); }

  pending(id: string): string[] {
    return [...this.dialogs.values(), ...[...this.callbacks.values()].filter(call => call.executor === id).map(call => call.lines)].flat();
  }

  private updateUnion(): void {
    const tools = new Map<string, Record<string, unknown>>(), schemes = new Set<string>();
    for (const id of this.deps.members()) {
      const registration = this.registrations.get(id);
      for (const tool of registration?.tools ?? []) if (!tools.has(tool.name as string)) tools.set(tool.name as string, tool);
      for (const scheme of registration?.schemes ?? []) schemes.add(scheme);
    }
    const mergedTools = [...tools.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const mergedSchemes = [...schemes].sort().map(scheme => ({ scheme, writable: true }));
    const toolUnion = JSON.stringify(mergedTools), schemeUnion = JSON.stringify(mergedSchemes);
    if (toolUnion !== this.toolUnion) { this.toolUnion = toolUnion; this.deps.write({ type: "set_host_tools", tools: mergedTools }); }
    if (schemeUnion !== this.schemeUnion) { this.schemeUnion = schemeUnion; this.deps.write({ type: "set_host_uri_schemes", schemes: mergedSchemes }); }
  }

  private eligible(id: string, call: Callback): boolean {
    if (!this.deps.isUp(id) || !this.deps.members().includes(id)) return false;
    const registration = this.registrations.get(id);
    if (call.frame.type === "host_tool_call") return registration?.tools.some(tool => tool.name === call.frame.toolName) ?? false;
    const scheme = typeof call.frame.url === "string" ? call.frame.url.split(":", 1)[0] : "";
    return registration?.schemes.includes(scheme) ?? false;
  }

  private dispatch(): void {
    for (const call of this.callbacks.values()) {
      // A lost acknowledgement does not prove the action did not happen.
      if (call.executor !== null) continue;
      const executor = this.lastPrompt && this.eligible(this.lastPrompt, call) ? this.lastPrompt : this.deps.members().find(id => this.eligible(id, call));
      if (!executor) continue;
      call.executor = executor;
      this.deps.deliver(executor, call.lines);
    }
  }
}
