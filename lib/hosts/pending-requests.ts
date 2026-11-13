// What a main server that missed a child's output needs from it in the
// daemon's `hello`: the blocking requests still open on it (omp has no command
// listing them, and they never time out), and the session it runs now.
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";

/** One line of the runner channel (runner/src/channel.ts), keyed by `t`. */
export type WireFrame = { t: string; [key: string]: unknown };
/** An AgentSession event inside an `event` frame. */
export type WireEvent = { type: string; [key: string]: unknown };

export function parseWire(line: string): WireFrame | null {
  try {
    const frame: unknown = JSON.parse(line);
    return isRecord(frame) && typeof frame.t === "string" ? frame as WireFrame : null;
  } catch {
    return null;
  }
}

export function wireEvent(frame: WireFrame): WireEvent | null {
  return frame.t === "event" && isRecord(frame.event) && typeof frame.event.type === "string" ? frame.event as WireEvent : null;
}

/** Wire ids are numbers; a link may still send strings. */
export const idOf = (value: unknown): string | null => typeof value === "string" || typeof value === "number" ? String(value) : null;
const OPENS = new Map([["ui_request", "ui"], ["host_tool_call", "tool"], ["host_uri_request", "uri"]]);
const CLOSES = new Map([["ui_end", "ui"], ["ui_response", "ui"], ["host_tool_result", "tool"], ["host_uri_result", "uri"]]);
const CANCELS = new Map([["host_tool_cancel", "tool"], ["host_uri_cancel", "uri"]]);

/** The blocking request a frame opens or closes. Keys carry the kind: dialogs and host callbacks number their ids apart. */
export function requestKey(frame: WireFrame): { key: string; open: boolean } | null {
  const open = OPENS.get(frame.t), close = CLOSES.get(frame.t), cancel = CANCELS.get(frame.t);
  const id = idOf(cancel ? frame.targetId : frame.id);
  const kind = open ?? close ?? cancel;
  return kind && id !== null ? { key: `${kind}:${id}`, open: open !== undefined } : null;
}

// A line without one of these cannot matter: skips JSON-parsing streamed output.
const STDOUT_LINES = /"t":"(?:hello|session|ui_request|ui_end|host_tool_call|host_tool_cancel|host_uri_request|host_uri_cancel)"|"type":"agent_(?:start|end)"/;
const STDIN_LINES = /"t":"(?:ui_response|host_tool_result|host_uri_result)"/;

export class PendingRequests {
  /** Raw line of each open request, or null once it no longer fits under the cap. */
  private readonly open = new Map<string, string | null>();
  private bytes = 0;
  private turning = false;

  /** Executing an agent turn, not merely holding an idle child process open. */
  get activeTurn(): boolean { return this.turning; }

  /** `sessionId`: the session the child runs, as its `hello` and `session` frames name it; null for one main could not adopt. */
  constructor(private readonly limitBytes: number, public sessionId: string | null = null) {}

  noteStdout(line: string): void {
    if (!STDOUT_LINES.test(line)) return;
    const frame = parseWire(line);
    if (!frame) return;
    const request = requestKey(frame);
    if (request) {
      this.close(request.key);
      if (request.open) this.keep(request.key, line);
      return;
    }
    const event = wireEvent(frame);
    if (event?.type === "agent_start") this.turning = true;
    else if (event?.type === "agent_end") this.turning = false;
    if (frame.t === "hello" || frame.t === "session") {
      this.sessionId = typeof frame.sessionId === "string" && isValidSessionId(frame.sessionId) ? frame.sessionId : null;
    }
  }

  noteStdin(line: string): void {
    if (!STDIN_LINES.test(line)) return;
    const frame = parseWire(line);
    const request = frame && requestKey(frame);
    if (request && !request.open) this.close(request.key);
  }

  /** Raw lines of the open requests in order; null when they exceed the cap. */
  lines(): string[] | null {
    const lines: string[] = [];
    for (const line of this.open.values()) {
      if (line === null) return null;
      lines.push(line);
    }
    return lines;
  }

  private close(key: string): void {
    const line = this.open.get(key);
    if (line) this.bytes -= Buffer.byteLength(line);
    this.open.delete(key);
  }

  private keep(key: string, line: string): void {
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.limitBytes) { this.open.set(key, null); return; }
    this.bytes += size;
    this.open.set(key, line);
  }
}
