"use client";

import type { EventStreamChannel } from "./event-stream-protocol";

export type { EventStreamChannel } from "./event-stream-protocol";

// Tab side of the live-event multiplexer: EventSource-shaped streams whose
// frames travel over the one `/api/events` socket held by
// public/event-stream-worker.js (see lib/event-stream-protocol.ts for why).
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

interface WorkerPort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

// Content-hashed at build time (next.config.ts) so a new worker version gets
// a new SharedWorker instead of old tabs' copy speaking a stale protocol.
const WORKER_URL = `/event-stream-worker.js?v=${process.env.NEXT_PUBLIC_EVENT_STREAM_WORKER_VERSION ?? "dev"}`;

class Transport {
  private nextId = 1;
  private readonly streams = new Map<number, MultiplexedEventStream>();

  constructor(private readonly port: WorkerPort) {
    port.onmessage = (event) => this.streams.get((event.data as WorkerMessage).id)?.receive(event.data as WorkerMessage);
    this.holdLifetimeLock();
    window.addEventListener("pagehide", () => this.port.postMessage({ op: "bye" }));
    window.addEventListener("pageshow", (event) => {
      // Back from the bfcache: pagehide already released our subscriptions.
      if (event.persisted) for (const stream of this.streams.values()) stream.resume();
    });
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

  /** The worker script failed to load/run: fail every stream (fatal), so the
   * next openEventStream starts a fresh worker instead of hanging silently. */
  fail(): void {
    if (transport === this) transport = null;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.receive({ id: stream.id, type: "error", readyState: EVENT_STREAM_CLOSED });
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
