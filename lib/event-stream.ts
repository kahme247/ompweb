"use client";

import type { BrowserTransport, EventStreamChannel } from "./event-stream-protocol";

export type { EventStreamChannel } from "./event-stream-protocol";

// Tab side of the live-event multiplexer: EventSource-shaped streams whose
// frames travel over the connection held by the shared worker
// (lib/event-stream-worker.ts: the one `/api/events` EventSource, or the browser
// link; see lib/event-stream-protocol.ts for why).
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

/** An agent command's answer: the server's (over the browser link or HTTP) or a local 413/503 from the worker. */
export interface CommandReply {
  status: number;
  body: unknown;
  via: "ws" | "http";
  recvAt: number | null;
  repliedAt: number | null;
  attempts: number;
  deduped: boolean;
  behindBytes: number;
  /** What it went over: `"link"`, or `"http"` for a POST. */
  socket: string;
  /** Bytes queued ahead of it at send that were this or other sessions' commands (spec D6 "Uplink"); null when never sent. */
  behindSameBytes: number | null;
  behindOtherBytes: number | null;
  /** Other sessions' large frames its reply arrived behind (spec D6 "Downlink"); null without a measure. */
  replyBehindOtherBytes: number | null;
}

/** The worker's answer to a `cmd`; `http` when it is in SSE mode, so the tab POSTs the command itself. */
type CommandMessage = { cmd: number; http: true } | ({ cmd: number } & Omit<CommandReply, "via">);

/** The worker about an upload: progress (the bytes the host has), its failure, or `http` (SSE mode: the tab uploads it). */
type UploadMessage = { up: string; received: number; done: boolean } | { up: string; error: { status: number; code: string; message: string } } | { up: string; http: true };

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
  private readonly uploads = new Map<string, (message: UploadMessage) => void>();
  mode: BrowserTransport = "sse";

  constructor(private readonly port: WorkerPort) {
    port.onmessage = (event) => {
      const message = event.data as WorkerMessage | TransportMessage | CommandMessage | UploadMessage;
      if ("transport" in message) this.mode = message.transport;
      else if ("cmd" in message) this.answer(message);
      else if ("up" in message) this.uploads.get(message.up)?.(message);
      else this.streams.get(message.id)?.receive(message);
    };
    this.holdLifetimeLock();
    window.addEventListener("pagehide", () => {
      // The worker aborts these on bye, including when this page enters the bfcache. 410, not a 5xx: the host copy is
      // gone, so the chip offers Retry instead of resuming by itself (spec U2).
      for (const [id, listener] of [...this.uploads]) {
        listener({ up: id, error: { status: 410, code: "upload_failed", message: "The upload failed. Retry it." } });
      }
      this.port.postMessage({ op: "bye" });
    });
    window.addEventListener("pageshow", (event) => {
      // Back from the bfcache: pagehide already released our subscriptions.
      if (event.persisted) for (const stream of this.streams.values()) stream.resume();
    });
    // The worker redials its link when the network or the page comes back.
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

  post(message: { op: "open"; id: number; channel: EventStreamChannel } | { op: "close"; id: number } | { op: "metric"; sample: Record<string, unknown> }): void {
    this.port.postMessage(message);
  }

  forget(id: number): void {
    this.streams.delete(id);
  }

  command(sessionId: string, req: string, body: string, advisor: boolean, type: string): Promise<CommandReply | null> {
    return new Promise((resolve) => {
      const n = this.nextId++;
      this.commands.set(n, resolve);
      this.port.postMessage({ op: "cmd", n, req, sessionId, advisor, body, type });
    });
  }

  private answer({ cmd, ...reply }: CommandMessage): void {
    const resolve = this.commands.get(cmd);
    this.commands.delete(cmd);
    resolve?.("http" in reply ? null : { ...reply, via: "ws" });
  }

  /** Hands the worker the File itself: it reads the bytes, so the tab holds none. `listener` hears until done, a
   * failure or `http`. */
  upload(id: string, file: File, hostId: string, listener: (message: UploadMessage) => void): void {
    this.uploads.set(id, (message) => {
      if (!("received" in message) || message.done) this.uploads.delete(id);
      listener(message);
    });
    this.port.postMessage({ op: "upload", id, host: hostId, name: file.name, type: file.type, blob: file });
  }

  /** The worker keeps it until the server has it (a link or request that fails is retried), whatever its mode. */
  abortUpload(id: string, host: string): void {
    this.uploads.delete(id);
    this.port.postMessage({ op: "up_abort", id, host });
  }

  /** Stop the sender but retain the host's staged bytes for a later Retry. */
  pauseUpload(id: string): void {
    this.uploads.delete(id);
    this.port.postMessage({ op: "up_pause", id });
  }

  /** The worker script failed to load/run: fail every stream (fatal), so the
   * next openEventStream starts a fresh worker instead of hanging silently. */
  fail(): void {
    if (transport === this) transport = null;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.receive({ id: stream.id, type: "error", readyState: EVENT_STREAM_CLOSED });
    // The dead worker's uploads go on over HTTP from the host's offset.
    const uploads = [...this.uploads.entries()];
    this.uploads.clear();
    for (const [id, listener] of uploads) listener({ up: id, http: true });
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
        socket: "worker",
        behindSameBytes: null,
        behindOtherBytes: null,
        replyBehindOtherBytes: null,
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

/** Hands a transport sample (spec D6) to the worker, which tags and stores it; without a transport it is dropped. */
export function recordTransportSample(sample: Record<string, unknown>): void {
  transport?.post({ op: "metric", sample });
}

/** Sends an agent command over the worker's browser link (transport `ws`): null (or a promise of null, when the worker
 * turns out to be on SSE) means the caller POSTs it instead. `type` is the command's, so the worker never parses a
 * body of up to 8 MB to learn it. */
export function sendSessionCommand(sessionId: string, req: string, body: string, advisor: boolean, type: string): Promise<CommandReply | null> | null {
  return transport?.mode === "ws" ? transport.command(sessionId, req, body, advisor, type) : null;
}

/** A failed upload: the server's (or host's) status and code, or status 0 when the file could not be read. */
export class UploadFailedError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface UploadHandle {
  id: string;
  /** Resolves once the host has every byte (synced); rejects with UploadFailedError, or a network error over HTTP. */
  promise: Promise<void>;
  /** Stops it, requests deletion of the staged file, and rejects a pending upload. */
  abort(): void;
}

/** HTTP PUT bodies in SSE mode (spec U4). */
const HTTP_UPLOAD_BYTES = 1024 * 1024;

/** A UUID v4, lowercase (UPLOAD_ID_RE); no crypto.randomUUID (insecure LAN origins lack it). */
export function newUploadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Back-off before each automatic resume; the last value repeats. */
const RESUME_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000];
/** An outage (transient failures with no new bytes on the host in between) this long stops resuming: the chip then
 * shows Retry. Measured from its first failure, so time the tab spent suspended before it does not count. */
const RESUME_GIVE_UP_MS = 5 * 60_000;

/**
 * Uploads `file` to `hostId`'s staging area (docs/specs/2026-11-02-file-uploads-design.md U4): over the worker's browser
 * link in the `ws` transport, else over HTTP. `onProgress` gets the bytes the host has. Passing the `id` of a failed
 * upload resumes it from the host's offset. A transient failure resumes by itself after a back-off: `onReconnecting`
 * gets its error while it waits, and null once the host answers again.
 */
export function uploadFile(
  file: File,
  hostId: string,
  onProgress: (received: number) => void,
  id = newUploadId(),
  onReconnecting: (error: unknown) => void = () => {},
): UploadHandle {
  const controller = new AbortController();
  let viaLink = false;
  let link: Transport | null = null;
  let highest = 0;
  let failures = 0;
  let outageAt: number | null = null;
  let waiting = false;
  let expired = false;
  const progress = (received: number) => {
    // New bytes on the host end the outage: the next one starts its back-off and clock afresh.
    if (received > highest) {
      highest = received;
      failures = 0;
      outageAt = null;
    }
    if (waiting) {
      waiting = false;
      onReconnecting(null);
    }
    onProgress(received);
  };
  // One start: the transport is chosen anew each time (it may have changed while the upload waited).
  const attempt = () => new Promise<void>((resolve, reject) => {
    const request = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = outageAt === null ? null : outageAt + RESUME_GIVE_UP_MS;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      if (error === undefined) resolve();
      else reject(error);
    };
    const cancel = () => {
      finish(new DOMException("The upload was cancelled", "AbortError"));
      request.abort();
    };
    const expire = () => {
      if (settled) return;
      expired = true;
      finish(new UploadFailedError(504, "upload_stalled", "The upload stopped making progress"));
      request.abort();
      if (viaLink) link?.pauseUpload(id);
    };
    const armDeadline = () => {
      clearTimeout(timer);
      if (deadline !== null) timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
    };
    const report = (received: number): boolean => {
      if (settled) return false;
      // A suspended page can receive an ack before its overdue timer gets to run.
      if (deadline !== null && Date.now() >= deadline) {
        expire();
        return false;
      }
      const advanced = received > highest;
      progress(received);
      if (advanced && deadline !== null) {
        deadline = Date.now() + RESUME_GIVE_UP_MS;
        armDeadline();
      }
      return true;
    };
    controller.signal.addEventListener("abort", cancel, { once: true });
    if (controller.signal.aborted) return cancel();
    if (deadline !== null && Date.now() >= deadline) return expire();
    armDeadline();
    link = transport?.mode === "ws" ? transport : null;
    const overHttp = () => {
      if (settled) return;
      viaLink = false;
      uploadOverHttp(id, file, hostId, report, request.signal).then(() => finish(), finish);
    };
    viaLink = link !== null;
    if (!link) return overHttp();
    link.upload(id, file, hostId, (message) => {
      if (settled) return;
      if ("http" in message) overHttp();
      else if ("error" in message) finish(new UploadFailedError(message.error.status, message.error.code, message.error.message));
      else if (report(message.received) && message.done) finish();
    });
  });
  const promise = (async () => {
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        // The host link or the web server dropped (503, a proxy's 502/504, fetch's network TypeError), or the upload
        // stalled (504): starting the same id again resumes from the host's offset. Anything else needs the user.
        const resumable = error instanceof UploadFailedError ? error.status >= 502 && error.status <= 504 : error instanceof TypeError;
        outageAt ??= Date.now();
        if (controller.signal.aborted || expired || !resumable || Date.now() - outageAt >= RESUME_GIVE_UP_MS) throw error;
        waiting = true;
        onReconnecting(error);
        const delay = Math.min(RESUME_DELAYS_MS[Math.min(failures++, RESUME_DELAYS_MS.length - 1)], RESUME_GIVE_UP_MS - (Date.now() - outageAt));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (controller.signal.aborted || Date.now() - outageAt >= RESUME_GIVE_UP_MS) throw error;
      }
    }
  })();
  return {
    id,
    promise,
    abort() {
      if (controller.signal.aborted) return;
      controller.abort();
      // The worker keeps the abort until the server has it; only a tab without a worker deletes it itself.
      discardUpload(id, hostId);
    },
  };
}

/** Deletes a finished (or failed) upload the composer no longer attaches: the host drops what it staged. `hostId`: the
 * upload's host, so the server can tell it even when it no longer knows the upload. */
export function discardUpload(id: string, hostId: string): void {
  if (transport) transport.abortUpload(id, hostId);
  else fetch(`/api/uploads/${id}?host=${encodeURIComponent(hostId)}`, { method: "DELETE" }).catch(() => {});
}

/** POST opens or resumes it at the host's offset; each PUT carries up to HTTP_UPLOAD_BYTES from the offset the server
 * last reported (a 409 `upload_offset` says where to go on from). */
async function uploadOverHttp(id: string, file: File, hostId: string, onProgress: (received: number) => void, signal: AbortSignal): Promise<void> {
  const answer = async (response: Response, from: number): Promise<number> => {
    const body = await response.json().catch((error: unknown) => {
      if (!(error instanceof SyntaxError)) throw error;
      return {};
    }) as { received?: unknown; error?: string; code?: string };
    if (!response.ok && !(response.status === 409 && body.code === "upload_offset")) {
      throw new UploadFailedError(response.status, body.code ?? "upload_failed", body.error ?? `HTTP ${response.status}`);
    }
    const received = Number(body.received);
    // An offset that does not move would loop forever.
    if (!Number.isSafeInteger(received) || received < 0 || received > file.size || (from >= 0 && received === from)) {
      throw new UploadFailedError(response.status, "upload_failed", "The server reported no progress");
    }
    onProgress(received);
    return received;
  };
  let received = await answer(await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, host: hostId, name: file.name, size: file.size, type: file.type }),
    signal,
  }), -1);
  while (received < file.size) {
    const body = file.slice(received, received + HTTP_UPLOAD_BYTES);
    received = await answer(await fetch(`/api/uploads/${id}?offset=${received}`, { method: "PUT", body, signal }), received);
  }
}
