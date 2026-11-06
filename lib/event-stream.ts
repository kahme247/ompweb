"use client";

import type { BrowserTransport, ConnectionDiagnostics, EventStreamChannel } from "./event-stream-protocol";
import { registerNotificationWorker } from "./notification-client";
import type { OutboxEntry, OutboxMode } from "./types";

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
type UploadMessage = { up: string; received: number; done: boolean; proof?: string } | { up: string; error: { status: number; code: string; message: string } } | { up: string; http: true };

type DiagnosticsMessage = { diag: number; data: ConnectionDiagnostics };

/** A diagnostics poll the worker has not answered by then resolves null. */
const DIAGNOSTICS_TIMEOUT_MS = 2000;

/** A message in this browser's outbox (the worker's, in IndexedDB): its first leg, until the web server has stored it. */
export interface LocalOutboxEntry {
  id: string;
  sessionId: string;
  /** Captured at submission: never rebound to a later installation or sign-in. */
  scope: string;
  mode: OutboxMode;
  advisor?: boolean;
  message: string;
  images?: { type: "image"; data: string; mimeType: string }[];
  uploads?: string[];
  uploadProofs?: Record<string, string>;
  createdAt: number;
  /** Allocated atomically by IndexedDB acceptance; absent only on preexisting rows. */
  enqueueOrder?: number;
  /** failed: the server refused outbox_add for good (spec O6). */
  state: "sending" | "failed";
  /** The server's error text for "failed". */
  error?: string;
}

/** Every local entry (on subscribe once known, then on every change), or one the server answered 200 for. */
export type OutboxEvent = { entries: LocalOutboxEntry[] } | { stored: OutboxEntry };

/** The worker about the outbox: an add committed, the whole list, or one the server stored. */
type OutboxMessage = { outboxAdded: number; error?: string } | { outboxDropped: number; error?: string } | { outbox: LocalOutboxEntry[]; partial?: true } | { outboxStored: OutboxEntry };

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
  private readonly outboxWrites = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly uploads = new Map<string, (message: UploadMessage) => void>();
  private readonly diagnostics = new Map<number, (data: ConnectionDiagnostics | null) => void>();
  mode: BrowserTransport = "sse";

  constructor(private readonly port: WorkerPort) {
    port.onmessage = (event) => {
      const message = event.data as WorkerMessage | TransportMessage | CommandMessage | UploadMessage | DiagnosticsMessage | OutboxMessage;
      if ("transport" in message) this.mode = message.transport;
      else if ("cmd" in message) this.answer(message);
      else if ("up" in message) this.uploads.get(message.up)?.(message);
      else if ("diag" in message) this.diagnostics.get(message.diag)?.(message.data);
      else if ("outboxAdded" in message || "outboxDropped" in message) {
        const n = "outboxAdded" in message ? message.outboxAdded : message.outboxDropped;
        const pending = this.outboxWrites.get(n);
        if (message.error !== undefined) pending?.reject(new Error(message.error));
        else pending?.resolve();
        this.outboxWrites.delete(n);
      } else if ("outbox" in message) {
        outboxEntries = message.outbox;
        outboxPartial = message.partial === true;
        for (const listener of outboxListeners) listener({ entries: message.outbox });
      } else if ("outboxStored" in message) {
        for (const listener of outboxListeners) listener({ stored: message.outboxStored });
      } else this.streams.get(message.id)?.receive(message);
    };
    this.holdLifetimeLock();
    window.addEventListener("pagehide", () => {
      // The worker aborts these on bye, including when this page enters the bfcache. 410, not a 5xx: the host copy is
      // gone, so the chip offers Retry instead of resuming by itself (spec U2).
      for (const [id, listener] of [...this.uploads]) {
        listener({ up: id, error: { status: 410, code: "upload_failed", message: "The upload failed. Retry it." } });
      }
      postOutboxOnExit();
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
    if (reason === "online") void registerOutboxSync();
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

  addToOutbox(entry: Omit<LocalOutboxEntry, "state" | "error">): Promise<void> {
    return new Promise((resolve, reject) => {
      const n = this.nextId++;
      this.outboxWrites.set(n, { resolve, reject });
      this.port.postMessage({ op: "outbox_add", n, entry });
    });
  }

  dropFromOutbox(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const n = this.nextId++;
      this.outboxWrites.set(n, { resolve, reject });
      this.port.postMessage({ op: "outbox_drop", n, id });
    });
  }

  private answer({ cmd, ...reply }: CommandMessage): void {
    const resolve = this.commands.get(cmd);
    this.commands.delete(cmd);
    resolve?.("http" in reply ? null : { ...reply, via: "ws" });
  }

  requestDiagnostics(): Promise<ConnectionDiagnostics | null> {
    return new Promise((resolve) => {
      const n = this.nextId++;
      const done = (data: ConnectionDiagnostics | null) => {
        clearTimeout(timer);
        this.diagnostics.delete(n);
        resolve(data);
      };
      const timer = setTimeout(() => done(null), DIAGNOSTICS_TIMEOUT_MS);
      this.diagnostics.set(n, done);
      this.port.postMessage({ op: "diag", n });
    });
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
    // It may have died before committing the change: the caller keeps the draft or held bubble.
    for (const { reject } of this.outboxWrites.values()) reject(new Error("The message change was not saved. Try again."));
    this.outboxWrites.clear();
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

const outboxListeners = new Set<(event: OutboxEvent) => void>();
/** The worker's latest list; null until it has told this tab. */
let outboxEntries: LocalOutboxEntry[] | null = null;
/** The worker's list may miss another worker's earlier entry: a keepalive from it could overtake that entry. */
let outboxPartial = false;
/** Ids this tab added: only these go out on its pagehide (every tab covers its own). */
const addedHere = new Set<string>();
/** keepalive request bodies share 64 KiB per page. */
const KEEPALIVE_BYTES = 64 * 1024;

/** The page is going (spec O2 "Send, then close the tab at once"): each session's oldest unconfirmed entry, if this
 * tab added it and it fits, goes as a keepalive POST the browser finishes after the page is gone. Only the head, so a
 * later entry never overtakes it (the server queues by arrival), and none from a partial list, whose head may not be the
 * real one; the worker or the service worker sends the rest. */
function postOutboxOnExit(): void {
  if (outboxPartial) return;
  let left = KEEPALIVE_BYTES;
  const sessions = new Set<string>();
  for (const { id, sessionId, scope, advisor, mode, message, images, uploads, uploadProofs, state, createdAt } of outboxEntries ?? []) {
    if (state !== "sending" || typeof scope !== "string" || !scope || Date.now() - createdAt > 7 * 24 * 60 * 60 * 1000 || sessions.has(sessionId)) continue;
    sessions.add(sessionId);
    if (!addedHere.has(id)) continue;
    const body = JSON.stringify({ type: "outbox_add", id, scope, mode, message, images, uploads, uploadProofs });
    const bytes = new Blob([body]).size;
    if (bytes > left) continue;
    left -= bytes;
    fetch(`/api/agent/${encodeURIComponent(sessionId)}${advisor === true ? "?advisor=1" : ""}`, { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  }
}

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

/** The Connection tab's snapshot from the worker; null without a transport or when the worker does not answer. */
export function requestConnectionDiagnostics(): Promise<ConnectionDiagnostics | null> {
  return transport ? transport.requestDiagnostics() : Promise.resolve(null);
}

/** Sends an agent command over the worker's browser link (transport `ws`): null (or a promise of null, when the worker
 * turns out to be on SSE) means the caller POSTs it instead. `type` is the command's, so the worker never parses a
 * body of up to 8 MB to learn it. */
export function sendSessionCommand(sessionId: string, req: string, body: string, advisor: boolean, type: string): Promise<CommandReply | null> | null {
  return transport?.mode === "ws" ? transport.command(sessionId, req, body, advisor, type) : null;
}

/** Same generator as the worker's ids (spec O2). */
export function newOutboxId(): string {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}

/** Resolves once the worker has committed the entry to IndexedDB: the composer clears only then. Rejects when storage
 * is unavailable or fails, or if the worker dies first; the composer keeps its draft. Starts the transport if none. */
export async function addToOutbox(entry: Omit<LocalOutboxEntry, "state" | "error">): Promise<void> {
  transport ??= connectTransport();
  addedHere.add(entry.id);
  await transport.addToOutbox(entry);
  void registerOutboxSync();
}

function supportsOutboxSync(worker: ServiceWorker | null): Promise<boolean> {
  if (!worker) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (supported: boolean) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(supported);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    channel.port1.onmessage = ({ data }) => finish(data?.type === "omp-outbox-capability" && data.version === 1);
    try {
      worker.postMessage({ type: "omp-outbox-capability" }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

/** ready may still mean the old push-only worker while its replacement installs. */
function waitForOutboxWorker(registration: ServiceWorkerRegistration): Promise<boolean> {
  return new Promise((resolve) => {
    const checked = new Set<ServiceWorker>();
    const observed = new Set<ServiceWorker>();
    const finish = (supported: boolean) => {
      clearTimeout(timer);
      registration.removeEventListener("updatefound", check);
      navigator.serviceWorker.removeEventListener("controllerchange", check);
      for (const worker of observed) worker.removeEventListener("statechange", check);
      resolve(supported);
    };
    const check = () => {
      for (const worker of [registration.installing, registration.waiting]) {
        if (!worker || observed.has(worker)) continue;
        observed.add(worker);
        worker.addEventListener("statechange", check);
      }
      const worker = registration.active;
      if (!worker || checked.has(worker)) return;
      checked.add(worker);
      void supportsOutboxSync(worker).then((supported) => {
        if (supported && registration.active === worker) finish(true);
      });
    };
    const timer = setTimeout(() => finish(false), 5_000);
    registration.addEventListener("updatefound", check);
    navigator.serviceWorker.addEventListener("controllerchange", check);
    check();
  });
}

/** Background Sync (Chromium only): the service worker sends what IndexedDB still holds once online, with no tab open. */
async function registerOutboxSync(): Promise<void> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    // A proven active worker works offline; a pre-outbox registration must go through the normal update flow.
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active && await supportsOutboxSync(existing.active)) {
      await (existing as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register("omp-outbox");
      return;
    }
    const registration = await registerNotificationWorker() as (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | null;
    // Re-registering a recently checked URL can return the old worker without fetching changed script bytes.
    if (registration?.sync && registration.active === existing?.active) await registration.update();
    if (registration?.sync && await waitForOutboxWorker(registration)) {
      await registration.sync.register("omp-outbox");
    }
  } catch {
    // Refused (no permission, private window): the next page that opens sends it.
  }
}

/** Resolves only once a browser-held entry is durably removed; Edit/Delete must keep it until this succeeds. */
export function dropFromOutbox(id: string): Promise<void> {
  transport ??= connectTransport();
  return transport.dropFromOutbox(id);
}

/** Every local entry of every session in submission order: at once if the worker already told this tab, then on every
 * change; `{ stored }` when the server answered 200 for one (its entry leaves `entries` in the same or next event).
 * Starts the transport if none, so a chat view alone starts the worker that resends IndexedDB's entries. */
export function subscribeOutbox(listener: (event: OutboxEvent) => void): () => void {
  transport ??= connectTransport();
  void registerOutboxSync();
  outboxListeners.add(listener);
  if (outboxEntries) listener({ entries: outboxEntries });
  return () => {
    outboxListeners.delete(listener);
  };
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
  promise: Promise<{ proof?: string }>;
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
  const attempt = () => new Promise<{ proof?: string }>((resolve, reject) => {
    const request = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline = outageAt === null ? null : outageAt + RESUME_GIVE_UP_MS;
    const finish = (error?: unknown, result?: { proof?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", cancel);
      if (error === undefined) resolve(result ?? {});
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
      uploadOverHttp(id, file, hostId, report, request.signal).then((result) => finish(undefined, result), finish);
    };
    viaLink = link !== null;
    if (!link) return overHttp();
    link.upload(id, file, hostId, (message) => {
      if (settled) return;
      if ("http" in message) overHttp();
      else if ("error" in message) finish(new UploadFailedError(message.error.status, message.error.code, message.error.message));
      else if (report(message.received) && message.done) finish(undefined, typeof message.proof === "string" ? { proof: message.proof } : {});
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
async function uploadOverHttp(id: string, file: File, hostId: string, onProgress: (received: number) => void, signal: AbortSignal): Promise<{ proof?: string }> {
  let proof: string | undefined;
  const answer = async (response: Response, from: number): Promise<number> => {
    const body = await response.json().catch((error: unknown) => {
      if (!(error instanceof SyntaxError)) throw error;
      return {};
    }) as { received?: unknown; proof?: unknown; error?: string; code?: string };
    if (!response.ok && !(response.status === 409 && body.code === "upload_offset")) {
      throw new UploadFailedError(response.status, body.code ?? "upload_failed", body.error ?? `HTTP ${response.status}`);
    }
    const received = Number(body.received);
    // An offset that does not move would loop forever.
    if (!Number.isSafeInteger(received) || received < 0 || received > file.size || (from >= 0 && received === from)) {
      throw new UploadFailedError(response.status, "upload_failed", "The server reported no progress");
    }
    if (response.ok && received === file.size && typeof body.proof === "string") proof = body.proof;
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
  return proof === undefined ? {} : { proof };
}
