import { runAgentCommand } from "./agent-command";
import { EventStreamConnection, type FrameSink } from "./event-stream-hub";
import { parseEventStreamChannel, SUBSCRIPTION_ID_RE } from "./event-stream-protocol";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "./image-attachments";

// The browser's WebSocket transport (docs/specs/2026-10-31-browser-transport-experiment-design.md D3/D4): one
// EventStreamConnection per socket, plus a session socket's agent commands. Server → client frames are
// "<name> <server ms>\n<json>"; client → server frames are one JSON object each.

export const WS_HEARTBEAT_MS = 10_000;
/** Bun's buffered bytes past which replaceable `message_update` frames coalesce until `drain`. */
export const WS_COALESCE_BYTES = 256 * 1024;
export const MAX_COMMAND_FRAME_BYTES = MAX_AGENT_COMMAND_REQUEST_BYTES + 64 * 1024;
export const DEDUPE_WINDOW_MS = 120_000;
export const DEDUPE_MAX = 500;

const MAX_SESSION_ID_LENGTH = 512;
const MAX_RID_LENGTH = 64;
const CLOSE = { badFrame: 1007, tooBig: 1009, failed: 1011 } as const;
const INVALID_REQUEST = { error: "Invalid event stream request", code: "invalid_event_stream_request" };

/** What Bun keeps on a browser socket (`ws.data`): its session (null: the general socket) and, once open, its connection. */
export interface BrowserSocketData {
  kind: "browser";
  sessionId: string | null;
  connection: EventStreamConnection | null;
}

/** The part of Bun's ServerWebSocket the handler uses, so tests drive it with a plain object. */
export interface BrowserSocket {
  readonly data: BrowserSocketData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  getBufferedAmount(): number;
}

interface Reply {
  status: number;
  body: unknown;
}

/** A command's run by session and rid; `expiresAt` is Infinity while it runs. */
interface Remembered {
  result: Promise<Reply>;
  expiresAt: number;
}

declare global {
  var __ompBrowserCommands: Map<string, Remembered> | undefined;
}

/** GET /api/events/ws[?session=<id>]: the gate already ran (proxy.ts); undefined once upgraded. */
export function handleBrowserSocketUpgrade(req: Request, upgrade: (data: BrowserSocketData) => boolean): Response | undefined {
  const sessionId = new URL(req.url).searchParams.get("session");
  if (sessionId !== null && (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH)) {
    return Response.json(INVALID_REQUEST, { status: 400 });
  }
  return upgrade({ kind: "browser", sessionId, connection: null })
    ? undefined
    : Response.json({ error: "The event stream socket is a WebSocket", code: "upgrade_required" }, { status: 426 });
}

/** Bun's `websocket` handler for browser sockets (server/app.ts dispatches on `ws.data.kind`). */
export const browserSocket = {
  open(ws: BrowserSocket): void {
    guarded(ws, () => {
      ws.data.connection = new EventStreamConnection(undefined, socketSink(ws));
    });
  },
  message(ws: BrowserSocket, data: string | Uint8Array): void {
    guarded(ws, () => onFrame(ws, data));
  },
  /** Bun wrote out its queue: coalesced updates go now. */
  drain(ws: BrowserSocket): void {
    guarded(ws, () => ws.data.connection?.resume());
  },
  close(ws: BrowserSocket): void {
    guarded(ws, () => ws.data.connection?.close());
  },
};

function socketSink(ws: BrowserSocket): FrameSink {
  // Bun's send: bytes sent, -1 queued under backpressure, 0 dropped (closed).
  return {
    heartbeatMs: WS_HEARTBEAT_MS,
    write: (name, at, data) => ws.send(`${name} ${at}\n${data}`) !== 0,
    backpressured: () => ws.getBufferedAmount() > WS_COALESCE_BYTES,
    heartbeat: () => ws.send(`ping ${Date.now()}\n{}`) !== 0,
    close: () => ws.close(),
  };
}

function send(ws: BrowserSocket, name: string, payload: unknown): void {
  ws.send(`${name} ${Date.now()}\n${JSON.stringify(payload)}`);
}

/** A throw in a websocket handler would reach uncaughtException, which exits the server: it ends that socket instead. */
function guarded(ws: BrowserSocket, handle: () => void): void {
  try {
    handle();
  } catch (error) {
    fail(ws, error);
  }
}

function fail(ws: BrowserSocket, error: unknown): void {
  console.error(`[omp-web] browser socket failed; closing it: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  ws.close(CLOSE.failed, "Internal error");
}

const isSubscriptionId = (id: unknown): id is string => typeof id === "string" && SUBSCRIPTION_ID_RE.test(id);

function onFrame(ws: BrowserSocket, data: string | Uint8Array): void {
  if (typeof data !== "string") return ws.close(CLOSE.badFrame, "Text frames only");
  if (Buffer.byteLength(data) > MAX_COMMAND_FRAME_BYTES) return ws.close(CLOSE.tooBig, "Frame too large");
  let frame: Record<string, unknown> | null;
  try {
    frame = JSON.parse(data);
  } catch {
    return ws.close(CLOSE.badFrame, "Invalid JSON");
  }
  const connection = ws.data.connection;
  switch (frame?.t) {
    case "sub": {
      const id = frame.id;
      if (!isSubscriptionId(id)) return ws.close(CLOSE.badFrame, "Invalid subscription id");
      const channel = parseEventStreamChannel(frame.channel);
      // `refused` stands in for the 400 a POST /api/events would answer.
      if (!channel) return connection?.control({ type: "refused", sub: id, status: 400, ...INVALID_REQUEST });
      void connection?.subscribe(id, channel).then((result) => {
        if (!result.ok) connection.control({ type: "refused", sub: id, status: result.status, error: result.error, code: result.code });
      }).catch((error: unknown) => fail(ws, error));
      return;
    }
    case "unsub":
      if (!isSubscriptionId(frame.id)) return ws.close(CLOSE.badFrame, "Invalid subscription id");
      return connection?.unsubscribe(frame.id);
    case "cmd":
      return onCommand(ws, frame);
    case "ping":
      return send(ws, "pong", { c: frame.c });
    default:
      return ws.close(CLOSE.badFrame, "Unknown frame");
  }
}

function onCommand(ws: BrowserSocket, frame: Record<string, unknown>): void {
  const { rid } = frame;
  if (typeof rid !== "string" || !rid || rid.length > MAX_RID_LENGTH) return ws.close(CLOSE.badFrame, "Invalid rid");
  send(ws, "ack", { rid });
  const sessionId = ws.data.sessionId;
  // Commands belong to a session: the general socket carries none.
  if (sessionId === null) return send(ws, "reply", { rid, status: 400, body: INVALID_REQUEST });
  // Scoped to the session, not the socket: a resend comes on the session's next socket, and a rid another session
  // happens to use never replays this one's reply. JSON keeps the pair unambiguous for any session id.
  const { result, deduped } = runOnce(JSON.stringify([sessionId, rid]), async () => {
    const response = await runAgentCommand(sessionId, frame.command, frame.advisor === true);
    return { status: response.status, body: await response.json() };
  });
  result
    .then((reply) => send(ws, "reply", { rid, ...reply, ...(deduped ? { deduped: true } : {}) }))
    .catch((error: unknown) => fail(ws, error));
}

/** One run per key: a known key joins the run in flight or replays its settled reply (a resend after a lost reply). */
function runOnce(key: string, run: () => Promise<Reply>): { result: Promise<Reply>; deduped: boolean } {
  const map = (globalThis.__ompBrowserCommands ??= new Map());
  const now = Date.now();
  const known = map.get(key);
  if (known && known.expiresAt > now) return { result: known.result, deduped: true };
  for (const [stale, entry] of map) if (entry.expiresAt <= now) map.delete(stale);
  if (map.size >= DEDUPE_MAX) {
    // The oldest settled goes first; one in flight (Infinity) only when none has settled.
    let oldest: [string, Remembered] | undefined;
    for (const item of map) if (!oldest || item[1].expiresAt < oldest[1].expiresAt) oldest = item;
    if (oldest) map.delete(oldest[0]);
  }
  // Called now, not after an await: on the fast path the command reaches omp in this socket's frame order.
  const entry: Remembered = { result: run(), expiresAt: Infinity };
  const settle = () => {
    entry.expiresAt = Date.now() + DEDUPE_WINDOW_MS;
  };
  entry.result.then(settle, settle);
  map.set(key, entry);
  return { result: entry.result, deduped: false };
}
