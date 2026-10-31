"use client";

import type { BrowserTransport, EventStreamChannel } from "./event-stream-protocol";

export type { EventStreamChannel } from "./event-stream-protocol";

// Tab side of the live-event multiplexer: EventSource-shaped streams whose
// frames travel over the connections held by public/event-stream-worker.js
// (the one `/api/events` EventSource, or WebSockets; see
// lib/event-stream-protocol.ts for why).
// Semantics follow EventSource: `onerror` with readyState CONNECTING means
// the stream is reconnecting on its own (a later `onopen` follows);
// CLOSED is fatal and the caller decides whether to open a new stream.

export const EVENT_STREAM_CONNECTING = 0;
export const EVENT_STREAM_OPEN = 1;
export const EVENT_STREAM_CLOSED = 2;
export type EventStreamReadyState = typeof EVENT_STREAM_CONNECTING | typeof EVENT_STREAM_OPEN | typeof EVENT_STREAM_CLOSED;

export interface EventStream {
  readonly channel: EventStreamChannel;
  readonly readyState: EventStreamReadyState;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

type WorkerMessage =
  | { id: number; type: "open" }
  | { id: number; type: "message"; data: string }
  | { id: number; type: "error"; readyState: typeof EVENT_STREAM_CONNECTING | typeof EVENT_STREAM_CLOSED };

/** The worker's transport, on attach once known and on every change. */
type TransportMessage = { transport: BrowserTransport };

/** An agent command's answer: the server's (over the session socket or HTTP) or a local 413/503 from the worker. */
export interface CommandReply {
  status: number;
  body: unknown;
  via: "ws" | "http";
  recvAt: number | null;
  repliedAt: number | null;
  attempts: number;
  deduped: boolean;
  behindBytes: number;
}

/** The worker's answer to a `cmd`; `http` when it is in SSE mode, so the tab POSTs the command itself. */
type CommandMessage = { cmd: number; http: true } | ({ cmd: number } & Omit<CommandReply, "via">);

type WakeReason = "init" | "visible" | "hidden" | "online" | "network";

interface WorkerPort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

// Content-hashed at build time (server/client-env.ts) so a new worker version gets
// a new SharedWorker instead of old tabs' copy speaking a stale protocol.
const WORKER_URL = `/event-stream-worker.js?v=${process.env.OMP_WEB_PUBLIC_EVENT_STREAM_WORKER_VERSION ?? "dev"}`;

const CLIENT_ID_KEY = "omp-web:transport-client-id";
let clientId: string | null = null;

/** This browser's id in transport samples: stored once, or one per page load where storage throws. */
function transportClientId(): string {
  if (clientId !== null) return clientId;
  const fresh = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    clientId = localStorage.getItem(CLIENT_ID_KEY);
    if (clientId === null) localStorage.setItem(CLIENT_ID_KEY, fresh);
  } catch {
    // Storage blocked: fall through to this load's id.
  }
  clientId ??= fresh;
  return clientId;
}

class Transport {
  private nextId = 1;
  private readonly streams = new Map<number, MultiplexedEventStream>();
  private readonly commands = new Map<number, (reply: CommandReply | null) => void>();
  mode: BrowserTransport = "sse";

  constructor(private readonly port: WorkerPort) {
    port.onmessage = (event) => {
      const message = event.data as WorkerMessage | TransportMessage | CommandMessage;
      if ("transport" in message) this.mode = message.transport;
      else if ("cmd" in message) this.answer(message);
      else this.streams.get(message.id)?.receive(message);
    };
    this.holdLifetimeLock();
    window.addEventListener("pagehide", () => this.port.postMessage({ op: "bye" }));
    window.addEventListener("pageshow", (event) => {
      // Back from the bfcache: pagehide already released our subscriptions.
      if (event.persisted) for (const stream of this.streams.values()) stream.resume();
    });
    // The worker redials its sockets when the network or the page comes back.
    this.wake("init");
    document.addEventListener("visibilitychange", () => this.wake(document.visibilityState === "visible" ? "visible" : "hidden"));
    window.addEventListener("online", () => this.wake("online"));
    (navigator as Navigator & { connection?: EventTarget }).connection?.addEventListener("change", () => this.wake("network"));
  }

  private wake(reason: WakeReason): void {
    this.port.postMessage({ op: "wake", reason, visible: document.visibilityState === "visible", clientId: transportClientId() });
  }

  open(channel: EventStreamChannel): MultiplexedEventStream {
    const stream = new MultiplexedEventStream(this, this.nextId++, channel);
    this.streams.set(stream.id, stream);
    this.post({ op: "open", id: stream.id, channel });
    return stream;
  }

  post(message: { op: "open"; id: number; channel: EventStreamChannel } | { op: "close"; id: number }): void {
    this.port.postMessage(message);
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  command(sessionId: string, req: string, body: string, advisor: boolean): Promise<CommandReply | null> {
    return new Promise((resolve) => {
      const n = this.nextId++;
      this.commands.set(n, resolve);
      this.port.postMessage({ op: "cmd", n, req, sessionId, advisor, body });
    });
  }

  private answer({ cmd, ...reply }: CommandMessage): void {
    const resolve = this.commands.get(cmd);
    this.commands.delete(cmd);
    resolve?.("http" in reply ? null : { ...reply, via: "ws" });
  }

  /** The worker script failed to load/run: fail every stream (fatal), so the
   * next openEventStream starts a fresh worker instead of hanging silently. */
  fail(): void {
    if (transport === this) transport = null;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.receive({ id: stream.id, type: "error", readyState: EVENT_STREAM_CLOSED });
    // The dead worker may have sent them: answered like a socket that dropped before the reply.
    for (const resolve of this.commands.values()) {
      resolve({
        status: 503,
        body: { error: "The connection to omp-web dropped before the answer arrived; the command may have run.", code: "transport_lost" },
        via: "ws",
        recvAt: null,
        repliedAt: null,
        attempts: 1,
        deduped: false,
        behindBytes: 0,
      });
    }
    this.commands.clear();
  }

  /** Workers cannot see a tab close; a Web Lock held for the tab's lifetime
   * is granted to the worker once the tab is gone, however it died. */
  private holdLifetimeLock(): void {
    const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
    if (!locks) return;
    const name = `omp-web-event-stream:${crypto.randomUUID()}`;
    void locks.request(name, () => {
      this.port.postMessage({ op: "lock", name });
      return new Promise<never>(() => {});
    });
  }
}

class MultiplexedEventStream implements EventStream {
  readyState: EventStreamReadyState = EVENT_STREAM_CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    private readonly transport: Transport,
    readonly id: number,
    readonly channel: EventStreamChannel,
  ) {}

  close(): void {
    if (this.readyState === EVENT_STREAM_CLOSED) return;
    this.readyState = EVENT_STREAM_CLOSED;
    this.transport.forget(this.id);
    this.transport.post({ op: "close", id: this.id });
  }

  receive(message: WorkerMessage): void {
    if (this.readyState === EVENT_STREAM_CLOSED) return;
    switch (message.type) {
      case "open":
        this.readyState = EVENT_STREAM_OPEN;
        this.onopen?.();
        break;
      case "message":
        this.onmessage?.({ data: message.data });
        break;
      case "error":
        this.readyState = message.readyState;
        if (message.readyState === EVENT_STREAM_CLOSED) this.transport.forget(this.id);
        this.onerror?.();
        break;
    }
  }

  resume(): void {
    if (this.readyState === EVENT_STREAM_CLOSED) return;
    this.readyState = EVENT_STREAM_CONNECTING;
    this.onerror?.();
    this.transport.post({ op: "open", id: this.id, channel: this.channel });
  }
}

let transport: Transport | null = null;

function connectTransport(): Transport {
  if (typeof SharedWorker === "function") {
    const worker = new SharedWorker(WORKER_URL, { name: "omp-web-event-stream" });
    const shared = new Transport(worker.port);
    worker.onerror = () => shared.fail();
    worker.port.start();
    return shared;
  }
  // No SharedWorker (e.g. Chrome for Android): one worker per tab still keeps
  // a tab to a single socket.
  const worker = new Worker(WORKER_URL);
  const dedicated = new Transport(worker);
  worker.onerror = () => dedicated.fail();
  return dedicated;
}

/** Open a live-event stream multiplexed over the browser's shared socket. */
export function openEventStream(channel: EventStreamChannel): EventStream {
  transport ??= connectTransport();
  return transport.open(channel);
}

/** How the worker reaches omp-web: SSE until it says otherwise, and without a transport. */
export function transportMode(): BrowserTransport {
  return transport?.mode ?? "sse";
}

/** Sends an agent command over its session's socket: null (or a promise of null, when the worker turns out to be
 * in SSE mode) means the caller POSTs it instead. */
export function sendSessionCommand(sessionId: string, req: string, body: string, advisor: boolean): Promise<CommandReply | null> | null {
  return transport?.mode === "websocket" ? transport.command(sessionId, req, body, advisor) : null;
}
