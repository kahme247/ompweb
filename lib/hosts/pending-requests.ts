// The blocking requests still open on one omp child, kept so the daemon's
// `hello` can replay them to a main server that missed them (omp has no
// command listing them, and they never time out).
import { BLOCKING_UI_METHODS } from "../notification-events";
import { RpcFrameDecoder } from "../omp/rpc-frame";
import { isRecord } from "../type-guards";

// A line without one of these types cannot matter: skips JSON-parsing streamed output.
const STDOUT_TYPES = /"(?:rpc_chunk|host_tool_call|host_tool_cancel|host_uri_request|host_uri_cancel|extension_ui_request)"/;
const STDIN_TYPES = /"(?:host_tool_result|host_uri_result|extension_ui_response)"/;

/** Raw lines, or null once they no longer fit under the cap. */
type Kept = string[] | null;

export class PendingRequests {
  private decoder = new RpcFrameDecoder();
  private readonly open = new Map<string, Kept>();
  /** The raw `rpc_chunk` lines of the frame being reassembled (null: over the cap); undefined between frames. */
  private chunk: Kept | undefined;
  private bytes = 0;

  constructor(private readonly limitBytes: number) {}

  noteStdout(line: string): void {
    if (this.chunk === undefined && !STDOUT_TYPES.test(line)) return;
    let frame;
    try {
      frame = this.decoder.push(JSON.parse(line));
    } catch {
      // Not JSON, or a broken chunk sequence: drop it and start clean.
      this.decoder = new RpcFrameDecoder();
      this.free(this.chunk);
      this.chunk = undefined;
      return;
    }
    const kept = this.append(this.chunk === undefined ? [] : this.chunk, line);
    if (!frame) {
      this.chunk = kept;
      return;
    }
    this.chunk = undefined;
    const blocking = frame.type === "host_tool_call" || frame.type === "host_uri_request"
      || (frame.type === "extension_ui_request" && typeof frame.method === "string" && BLOCKING_UI_METHODS.has(frame.method));
    if (blocking && typeof frame.id === "string") {
      this.close(frame.id);
      this.open.set(frame.id, kept);
      return;
    }
    this.free(kept);
    const cancel = frame.type === "host_tool_cancel" || frame.type === "host_uri_cancel"
      || (frame.type === "extension_ui_request" && frame.method === "cancel");
    if (cancel && typeof frame.targetId === "string") this.close(frame.targetId);
  }

  noteStdin(line: string): void {
    if (!STDIN_TYPES.test(line)) return;
    let command: unknown;
    try {
      command = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(command) || typeof command.id !== "string") return;
    if (command.type === "host_tool_result" || command.type === "host_uri_result" || command.type === "extension_ui_response") {
      this.close(command.id);
    }
  }

  /** Raw lines of the open requests in order; null when they exceed the cap. */
  lines(): string[] | null {
    const lines: string[] = [];
    for (const kept of this.open.values()) {
      if (!kept) return null;
      lines.push(...kept);
    }
    return lines;
  }

  private close(id: string): void {
    this.free(this.open.get(id));
    this.open.delete(id);
  }

  private append(kept: Kept, line: string): Kept {
    if (!kept) return null;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.limitBytes) {
      this.free(kept);
      return null;
    }
    this.bytes += size;
    kept.push(line);
    return kept;
  }

  private free(kept: Kept | undefined): void {
    if (kept) for (const line of kept) this.bytes -= Buffer.byteLength(line);
  }
}
