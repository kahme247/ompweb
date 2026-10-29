// What a main server that missed a child's output needs from it in the
// daemon's `hello`: the blocking requests still open on it (omp has no command
// listing them, and they never time out), and the session it runs now.
import { BLOCKING_UI_METHODS } from "../notification-events";
import { RpcFrameDecoder } from "../omp/rpc-frame";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";

// A line without one of these types cannot matter: skips JSON-parsing streamed output.
const STDOUT_TYPES = /"(?:rpc_chunk|host_tool_call|host_tool_cancel|host_uri_request|host_uri_cancel|extension_ui_request|get_state)"/;
const STDIN_TYPES = /"(?:host_tool_result|host_uri_result|extension_ui_response)"/;

/** Raw lines, or null once they no longer fit under the cap. */
type Kept = string[] | null;

export class PendingRequests {
  private decoder = new RpcFrameDecoder();
  private readonly open = new Map<string, Kept>();
  /** The raw `rpc_chunk` lines of the frame being reassembled (null: over the cap); undefined between frames. */
  private chunk: Kept | undefined;
  private bytes = 0;

  /** `sessionId`: the session the child was started on, until a successful `get_state` names
   * another (a new session's first one, a switch or a fork); null for one main could not adopt. */
  constructor(private readonly limitBytes: number, public sessionId: string | null = null) {}

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
    if (frame.type === "response" && frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
      const { sessionId } = frame.data;
      this.sessionId = typeof sessionId === "string" && isValidSessionId(sessionId) ? sessionId : null;
      return;
    }
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
