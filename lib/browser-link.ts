import { randomBytes } from "crypto";
import { runAgentCommand } from "./agent-command";
import { EventStreamConnection, serverId, type FrameSink } from "./event-stream-hub";
import {
  BROWSER_LINK_VERSION,
  COMMAND_DEDUPE_MS,
  isIdempotentCommand,
  LINK_RESUME_MS,
  parseEventStreamChannel,
  SUBSCRIPTION_ID_RE,
} from "./event-stream-protocol";
import { decodeBlobFrame, HostOpError, LINK_LIMITS, LinkSender, Outbox, PartJoiner, queuedLine, SeqWindow } from "./hosts/link-protocol";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "./image-attachments";
import { isRecord } from "./type-guards";
import { UPLOAD_ID_RE } from "./upload-limits";
import { abortUpload, forwardUploadFrame, releaseUploadSink, startUpload, type UploadSink } from "./uploads";
import { requestOwner } from "./web-auth";

// The browser link (docs/specs/2026-11-01-browser-link-design.md): one WebSocket per browser at /api/events/link,
// carrying every subscription and agent command with the host link's delivery (lib/hosts/link-protocol.ts): sequenced
// lines both ways, acked and resent after a reconnect, large lines in pieces, fair per-key queues and an unacked
// window. A link outlives its socket for LINK_RESUME_MS, so a reconnect resumes it instead of re-subscribing.

/** Mutable so tests can shorten them. `helloMs`: a socket that has not said hello by then is closed. */
export const browserLinkTimings = { pingMs: LINK_LIMITS.pingMs, offlineMs: LINK_LIMITS.offlineMs, resumeMs: LINK_RESUME_MS, helloMs: 10_000, ackMs: 120_000 };
/** Mutable so tests can shrink them. A link holding more than `backlogBytes` (sent and unacked, plus queued) is dropped;
 * past `totalBacklogBytes` across every link, the links whose sockets have been gone longest are dropped first. Either
 * way their browsers resync. */
export const browserLinkLimits = { backlogBytes: 32 * 1024 * 1024, totalBacklogBytes: 256 * 1024 * 1024 };
/** Remembered commands, kept COMMAND_DEDUPE_MS for a resend. At the cap, a command that changes something is answered
 * 429 `too_many_commands` until one expires: forgetting a remembered one early would let its resend run it twice. */
export const DEDUPE_MAX = 500;
/** The longest joined command line: the route's body cap plus room for the envelope. */
const MAX_COMMAND_CHARS = MAX_AGENT_COMMAND_REQUEST_BYTES + 64 * 1024;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_RID_LENGTH = 64;
const CLOSE = { invalidData: 1007, policy: 1008, tooBig: 1009, failed: 1011, replaced: 4409, gone: 4410, versionMismatch: 4426 } as const;
const INVALID_REQUEST = { error: "Invalid event stream request", code: "invalid_event_stream_request" };

/** The unacked window follows the link: about WINDOW_TARGET_MS of what the browser acks, between WINDOW_MIN_BYTES and
 * LINK_LIMITS.unackedBytes (see `measure`). A command's reply queued behind a backlog waits behind about that much on
 * the wire, plus at most one line or piece that started below it. */
const WINDOW_TARGET_MS = 1000;
const WINDOW_MIN_BYTES = 64 * 1024;
/** What Bun keeps on a browser socket (`ws.data`): the web session it was opened by, and its link after the hello. */
export interface BrowserLinkData {
  kind: "browser";
  owner: string;
  link: BrowserLink | null;
}

/** The part of Bun's ServerWebSocket the handler uses, so tests drive it with a plain object. */
export interface BrowserSocket {
  readonly data: BrowserLinkData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

interface Sent {
  seq: number;
  line: string;
  bytes: number;
}

interface BrowserLink {
  readonly token: string;
  readonly owner: string;
  socket: BrowserSocket | null;
  connection: EventStreamConnection;
  /** Lines not numbered yet, per subscription or session, sent fair. */
  readonly sender: LinkSender<{ line: string; size: number }>;
  /** Sent lines until the browser acks them; resent from its ack after a reconnect. */
  readonly outbox: Outbox<Sent>;
  outboxBytes: number;
  downSeq: number;
  /** Highest outbox seq written to the current socket; `flush` sends what is past it. */
  sentSeq: number;
  /** Bytes of the outbox lines written to the current socket: the unacked window. */
  unacked: number;
  /** The window's size now (see `measure`). */
  window: number;
  /** Bytes acked over `busyMs`, the time lines were in flight (from `busyFrom`, performance.now), and whether the
   * window or the socket's backpressure held lines back meanwhile: what `measure` sizes the window from. */
  acked: number;
  busyMs: number;
  busyFrom: number;
  limited: boolean;
  /** Bun queued the last line under backpressure: the rest waits for `drain`. */
  awaitingDrain: boolean;
  readonly up: SeqWindow;
  readonly parts: PartJoiner;
  /** Uploads this link started (docs/specs/2026-11-02-file-uploads-design.md U4), by id: only theirs may come as
   * binary frames. An upload that failed stays, so its chunks still in flight are dropped rather than refused. */
  readonly uploads: Map<string, UploadSink>;
  offlineTimer: NodeJS.Timeout | undefined;
  /** Runs while lines are unacked: ackMs without an ack that frees any closes the socket (see `watchAcks`). */
  ackTimer: NodeJS.Timeout | undefined;
  expiryTimer: NodeJS.Timeout | undefined;
  disposed: boolean;
  /** When its socket went, in detach order (Infinity while it has never been detached): the budget drops the oldest. */
  detachedAt: number;
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
  var __ompBrowserLinks: Map<string, BrowserLink> | undefined;
  var __ompBrowserCommands: Map<string, Remembered> | undefined;
}

function links(): Map<string, BrowserLink> {
  return (globalThis.__ompBrowserLinks ??= new Map());
}

/** Counts detaches, so "the oldest detached link" needs no clock (two in one millisecond still order). */
let detachCount = 0;
/** The hello deadline of each socket that has not said hello yet. */
const helloTimers = new WeakMap<BrowserSocket, NodeJS.Timeout>();

/** GET /api/events/link: the gate already ran (proxy.ts); undefined once upgraded. The owner is the web session a
 * socket belongs to: a resume token, and an upload, are honored only for the same one. */
export function handleBrowserLinkUpgrade(request: Request, upgrade: (data: BrowserLinkData) => boolean): Response | undefined {
  return upgrade({ kind: "browser", owner: requestOwner(request), link: null })
    ? undefined
    : Response.json({ error: "The browser link is a WebSocket", code: "upgrade_required" }, { status: 426 });
}

/** Bun's `websocket` handler for browser sockets (server/app.ts dispatches on `ws.data.kind`). */
export const browserLink = {
  /** A socket gets helloMs to say hello: until then Bun holds what it sends for nothing (see the spec's B3). */
  open(ws: BrowserSocket): void {
    guarded(ws, () => {
      const timer = setTimeout(() => {
        if (!ws.data.link) ws.close(CLOSE.policy, "No hello");
      }, browserLinkTimings.helloMs);
      timer.unref?.();
      helloTimers.set(ws, timer);
    });
  },
  message(ws: BrowserSocket, data: string | Uint8Array): void {
    guarded(ws, () => onFrame(ws, data));
  },
  /** Bun wrote out what it had queued: send what waited. */
  drain(ws: BrowserSocket): void {
    guarded(ws, () => {
      const link = ws.data.link;
      if (link?.socket !== ws) return;
      link.awaitingDrain = false;
      flush(link);
      link.connection.resume();
    });
  },
  /** 1000/1001: the browser is done with the link (nothing left to carry, a switch to SSE, the worker going away), so
   * it ends now; any other close is a drop the browser comes back from. */
  close(ws: BrowserSocket, code?: number): void {
    guarded(ws, () => {
      clearTimeout(helloTimers.get(ws));
      const link = ws.data.link;
      if (link?.socket !== ws) return;
      if (code === 1000 || code === 1001) dispose(link, code);
      else detach(link);
    });
  },
};

/** A throw in a websocket handler would reach uncaughtException, which exits the server: it ends that link instead. */
function guarded(ws: BrowserSocket, handle: () => void): void {
  try {
    handle();
  } catch (error) {
    fail(ws, error);
  }
}

function fail(ws: BrowserSocket, error: unknown): void {
  console.error(`[omp-web] browser link failed; closing it: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  const link = ws.data.link;
  // Nothing half-applied is resumed: the browser resyncs.
  if (link) dispose(link, CLOSE.failed);
  else ws.close(CLOSE.failed, "Internal error");
}

function control(ws: BrowserSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

function createLink(owner: string): BrowserLink {
  const link: BrowserLink = {
    token: randomBytes(32).toString("base64url"),
    owner,
    socket: null,
    connection: null as unknown as EventStreamConnection,
    sender: new LinkSender(true),
    outbox: new Outbox(),
    outboxBytes: 0,
    downSeq: 0,
    sentSeq: 0,
    unacked: 0,
    window: LINK_LIMITS.unackedBytes,
    acked: 0,
    busyMs: 0,
    busyFrom: 0,
    limited: false,
    awaitingDrain: false,
    up: new SeqWindow(),
    parts: new PartJoiner(MAX_COMMAND_CHARS),
    uploads: new Map(),
    offlineTimer: undefined,
    ackTimer: undefined,
    expiryTimer: undefined,
    detachedAt: Infinity,
    disposed: false,
  };
  links().set(link.token, link);
  // Its hello is the link's first line (seq 1).
  link.connection = new EventStreamConnection(undefined, linkSink(link));
  return link;
}

/** The link's EventStreamConnection writes here: every frame a sequenced `e` line, keyed by its subscription. */
function linkSink(link: BrowserLink): FrameSink {
  return {
    heartbeatMs: browserLinkTimings.pingMs,
    write: (name, at, data) => {
      // A control frame goes with its subscription's frames (`open` before them, `end` after); hello and transport alone.
      const frame: unknown = name === "mux" ? JSON.parse(data) : null;
      const key = name !== "mux" ? name : isRecord(frame) && typeof frame.sub === "string" ? frame.sub : "mux";
      return queue(link, key, `{"type":"e","name":${JSON.stringify(name)},"at":${at},"data":${data}}`);
    },
    // Replaceable updates merge while the socket is gone or lines wait for the window; every ack resumes them.
    backpressured: () => !link.socket || link.sender.queuedBytes > 0,
    heartbeat: () => {
      if (link.socket) control(link.socket, { type: "ping", at: Date.now() });
      return true;
    },
    close: () => dispose(link, CLOSE.gone),
  };
}

/** Queues a sequenced line under `key`; false (and the link is dropped) once its backlog passes backlogBytes, or the
 * budget across every link drops it. */
function queue(link: BrowserLink, key: string, json: string): boolean {
  if (link.disposed) return false;
  const line = queuedLine(json);
  link.sender.push(key, { line, size: Buffer.byteLength(line) });
  if (link.outboxBytes + link.sender.queuedBytes > browserLinkLimits.backlogBytes) {
    dispose(link, CLOSE.gone);
    return false;
  }
  enforceBudget();
  if (link.disposed) return false;
  flush(link);
  return true;
}

/** Past totalBacklogBytes across every link, the detached links whose sockets are gone longest go first, and only ones
 * holding bytes: dropping an empty one frees nothing. Attached links are never dropped here: each stays under
 * backlogBytes, and `watchAcks` detaches one whose browser stops acking, which makes it droppable here. */
function enforceBudget(): void {
  const held = (link: BrowserLink) => link.outboxBytes + link.sender.queuedBytes;
  let total = 0;
  for (const each of links().values()) total += held(each);
  while (total > browserLinkLimits.totalBacklogBytes) {
    let oldest: BrowserLink | undefined;
    for (const each of links().values()) {
      if (!each.socket && held(each) > 0 && each.detachedAt < (oldest?.detachedAt ?? Infinity)) oldest = each;
    }
    if (!oldest) return;
    total -= held(oldest);
    dispose(oldest, CLOSE.gone);
  }
}

/** Send outbox lines past `sentSeq` (a resend after a reconnect), then the sender's next units, while the unacked
 * window has room and until Bun queues one under backpressure (the rest goes on `drain`): the hub's flush. */
function flush(link: BrowserLink): void {
  const ws = link.socket;
  if (!ws || link.awaitingDrain) return;
  const write = (item: Sent): boolean => {
    // Lines start going into an empty window: idle time says nothing about the link.
    if (link.unacked === 0) link.busyFrom = performance.now();
    const sent = ws.send(item.line);
    if (sent !== 0) {
      link.sentSeq = item.seq;
      link.unacked += item.bytes;
      link.ackTimer ??= startAckTimer(link);
    }
    if (sent > 0) return true;
    // The kernel's buffer is full: the link, not the browser's traffic, sets the ack rate now.
    link.awaitingDrain = true;
    link.limited = true;
    return false;
  };
  for (const item of link.outbox.pending()) {
    if (item.seq <= link.sentSeq) continue;
    if (link.unacked >= link.window) {
      link.limited = true;
      return;
    }
    if (!write(item)) return;
  }
  while (link.unacked < link.window) {
    const unit = link.sender.next(() => ++link.downSeq);
    // Lines only: the browser link queues no result bytes.
    if (!unit || !("line" in unit)) return;
    const item = { seq: unit.seq, line: unit.line, bytes: Buffer.byteLength(unit.line) };
    link.outbox.push(item);
    link.outboxBytes += item.bytes;
    if (!write(item)) return;
  }
  if (link.sender.queuedBytes > 0) link.limited = true;
}

/** Lines that left the outbox: those written to the current socket leave the unacked window. Returns their bytes. */
function released(link: BrowserLink, items: Sent[]): number {
  let acked = 0;
  for (const item of items) {
    link.outboxBytes -= item.bytes;
    if (item.seq <= link.sentSeq) {
      link.unacked -= item.bytes;
      acked += item.bytes;
    }
  }
  return acked;
}

/** Each WINDOW_TARGET_MS or more of busy time in which the window or backpressure held lines back sizes the window to
 * WINDOW_TARGET_MS of the ack rate over that time. A stretch nothing was held back changes nothing: that rate is the
 * browser's traffic, not what the link can carry. */
function measure(link: BrowserLink, acked: number): void {
  if (acked === 0) return;
  const now = performance.now();
  link.acked += acked;
  link.busyMs += now - link.busyFrom;
  link.busyFrom = now;
  if (link.busyMs < WINDOW_TARGET_MS) return;
  const fit = Math.min(LINK_LIMITS.unackedBytes, Math.max(WINDOW_MIN_BYTES, Math.round((link.acked * WINDOW_TARGET_MS) / link.busyMs)));
  if (link.limited) link.window = fit;
  Object.assign(link, { acked: 0, busyMs: 0, limited: false });
}

/** The socket is gone (closed, silent or replaced): the link waits resumeMs for the browser to come back. */
function detach(link: BrowserLink): void {
  link.socket = null;
  link.detachedAt = ++detachCount;
  link.awaitingDrain = false;
  clearTimeout(link.offlineTimer);
  clearTimeout(link.ackTimer);
  link.ackTimer = undefined;
  clearTimeout(link.expiryTimer);
  link.expiryTimer = setTimeout(() => dispose(link, CLOSE.gone), browserLinkTimings.resumeMs);
  link.expiryTimer.unref?.();
}

/** The link is gone for good: its subscriptions are released and its token resumes nothing. */
function dispose(link: BrowserLink, code: number): void {
  if (link.disposed) return;
  link.disposed = true;
  links().delete(link.token);
  clearTimeout(link.offlineTimer);
  clearTimeout(link.ackTimer);
  link.ackTimer = undefined;
  clearTimeout(link.expiryTimer);
  const ws = link.socket;
  link.socket = null;
  ws?.close(code, "Browser link gone");
  link.connection.close();
  // Uploads outlive their link: a later up_start (a new link after a resync) takes them up again.
  for (const [id, sink] of link.uploads) releaseUploadSink(id, sink);
}

/** Bytes sent and unacked for ackMs without any ack that frees some mean a stuck or hostile browser: pings alone keep
 * `sawBrowser` quiet, and the link would hold its backlog for nothing. The socket closes like a silent one (the link
 * stays resumable, so the total budget then applies to it). An honest browser acks only after a whole message has
 * arrived, so ackMs (120 s) is the time one piece (256 KiB) may take: a link under about 2.2 KB/s (17 kbit/s) cannot
 * finish one, and its partial piece is lost at each close. Any finite deadline bounds a hostile peer to backlogBytes. */
function startAckTimer(link: BrowserLink): NodeJS.Timeout {
  const timer = setTimeout(() => {
    const ws = link.socket;
    if (!ws || link.unacked === 0) return;
    detach(link);
    ws.close();
  }, browserLinkTimings.ackMs);
  timer.unref?.();
  return timer;
}

/** Restarts the ack deadline after progress; nothing unacked leaves it stopped. */
function watchAcks(link: BrowserLink): void {
  clearTimeout(link.ackTimer);
  link.ackTimer = link.unacked > 0 ? startAckTimer(link) : undefined;
}

/** Any frame proves the browser alive; offlineMs of silence drops the socket (the link stays resumable). */
function sawBrowser(link: BrowserLink): void {
  clearTimeout(link.offlineTimer);
  link.offlineTimer = setTimeout(() => {
    const ws = link.socket;
    if (!ws) return;
    detach(link);
    ws.close();
  }, browserLinkTimings.offlineMs);
  link.offlineTimer.unref?.();
}

const isSafeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function onFrame(ws: BrowserSocket, data: string | Uint8Array): void {
  if (typeof data !== "string") return onUploadFrame(ws, data);
  // Every line the browser sends fits a piece: longer ones go as parts.
  if (Buffer.byteLength(data) > LINK_LIMITS.pieceBytes) return ws.close(CLOSE.tooBig, "Frame too large");
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return ws.close(CLOSE.invalidData, "Invalid JSON");
  }
  if (!isRecord(message)) return ws.close(CLOSE.invalidData, "Not a message");
  const link = ws.data.link;
  if (!link) return message.type === "hello" ? onHello(ws, message) : ws.close(CLOSE.policy, "The first frame must be a hello");
  // A socket a newer one replaced: what it still sends belongs to no link.
  if (link.socket !== ws) return;
  sawBrowser(link);
  switch (message.type) {
    case "ack": {
      if (!isSafeCount(message.ack)) return ws.close(CLOSE.invalidData, "Invalid ack");
      const freed = released(link, link.outbox.ack(message.ack));
      // Progress restarts the deadline; an ack that frees nothing does not.
      if (freed > 0) watchAcks(link);
      measure(link, freed);
      flush(link);
      // The window moved: merged updates go now.
      link.connection.resume();
      return;
    }
    case "ping":
      return control(ws, { type: "pong", c: message.c, at: Date.now() });
    case "pong":
      return;
  }
  if (!isSafeCount(message.seq) || message.seq === 0) return ws.close(CLOSE.invalidData, "Invalid seq");
  if (link.up.applied(message.seq)) {
    if (message.type !== "part") apply(link, ws, message);
    else {
      const { at, end, data: slice } = message;
      if (!isSafeCount(at) || typeof end !== "boolean" || typeof slice !== "string") return ws.close(CLOSE.invalidData, "Invalid part");
      const line = link.parts.add({ at, end, data: slice });
      if (line !== null) {
        let joined: unknown;
        try {
          joined = JSON.parse(line);
        } catch {
          return ws.close(CLOSE.invalidData, "Invalid JSON");
        }
        if (!isRecord(joined)) return ws.close(CLOSE.invalidData, "Not a message");
        apply(link, ws, joined, Buffer.byteLength(line));
      }
    }
  }
  if (link.socket === ws) control(ws, { type: "ack", ack: link.up.acked });
}

/** A binary frame `[n][id][payload]`: the next chunk of an upload this link started, of at most a piece. Bytes go on
 * to its host as they came; any other binary frame is refused. */
function onUploadFrame(ws: BrowserSocket, data: Uint8Array): void {
  const link = ws.data.link;
  if (!link) return ws.close(CLOSE.invalidData, "Text frames only");
  if (link.socket !== ws) return;
  // 256: the longest header (a length byte and 255 bytes of id).
  if (data.byteLength > LINK_LIMITS.pieceBytes + 256) return ws.close(CLOSE.tooBig, "Frame too large");
  let frame: { id: string; bytes: Uint8Array };
  try {
    frame = decodeBlobFrame(data);
  } catch {
    return ws.close(CLOSE.invalidData, "Invalid binary frame");
  }
  if (frame.bytes.byteLength > LINK_LIMITS.pieceBytes) return ws.close(CLOSE.tooBig, "Frame too large");
  if (!link.uploads.has(frame.id)) return ws.close(CLOSE.invalidData, "Not an upload of this link");
  sawBrowser(link);
  // False once the upload ended on this server (failed, aborted or evicted idle): say so instead of letting it stall.
  // A failed start already sent its up_error; the worker ignores errors for an upload it dropped.
  const sink = link.uploads.get(frame.id)!;
  if (!forwardUploadFrame(link.owner, frame.id, frame.bytes, sink)) sink.error(404, "upload_missing", "The upload is no longer open");
}

function onHello(ws: BrowserSocket, hello: Record<string, unknown>): void {
  if (hello.v !== BROWSER_LINK_VERSION) return ws.close(CLOSE.versionMismatch, JSON.stringify({ serverVersion: BROWSER_LINK_VERSION }));
  if (!isSafeCount(hello.ack) || (hello.token !== null && typeof hello.token !== "string")) return ws.close(CLOSE.policy, "Invalid hello");
  const known = typeof hello.token === "string" ? links().get(hello.token) : undefined;
  // Another web session's token resumes nothing, and its link is left alone.
  const resumed = known !== undefined && known.owner === ws.data.owner;
  clearTimeout(helloTimers.get(ws));
  const link = resumed ? known : createLink(ws.data.owner);
  ws.data.link = link;
  const previous = link.socket;
  if (previous) {
    detach(link);
    previous.close(CLOSE.replaced, "Replaced by a newer socket");
  }
  clearTimeout(link.expiryTimer);
  link.socket = ws;
  // An ack past what was sent (a confused or hostile browser) acks what was sent and no more.
  const ack = resumed ? Math.min(hello.ack, link.downSeq) : 0;
  if (resumed) released(link, link.outbox.ack(ack));
  // Resend what the browser has not applied, in order and paced, before anything new.
  link.sentSeq = ack;
  link.unacked = 0;
  link.awaitingDrain = false;
  control(ws, { type: "welcome", v: BROWSER_LINK_VERSION, token: link.token, serverId: serverId(), resumed, ack: link.up.acked });
  sawBrowser(link);
  flush(link);
  // Updates merged while the socket was gone go now: no ack may come to resume them.
  link.connection.resume();
}

const isSubscriptionId = (id: unknown): id is string => typeof id === "string" && SUBSCRIPTION_ID_RE.test(id);

function apply(link: BrowserLink, ws: BrowserSocket, message: Record<string, unknown>, lineBytes = 0): void {
  const { connection } = link;
  switch (message.type) {
    case "sub": {
      const id = message.id;
      if (!isSubscriptionId(id)) return ws.close(CLOSE.invalidData, "Invalid subscription id");
      const channel = parseEventStreamChannel(message.channel);
      // `refused` stands in for the 400 a POST /api/events would answer.
      if (!channel) return connection.control({ type: "refused", sub: id, status: 400, ...INVALID_REQUEST });
      void connection.subscribe(id, channel).then((result) => {
        if (!result.ok) connection.control({ type: "refused", sub: id, status: result.status, error: result.error, code: result.code });
      }).catch((error: unknown) => fail(ws, error));
      return;
    }
    case "unsub":
      if (!isSubscriptionId(message.id)) return ws.close(CLOSE.invalidData, "Invalid subscription id");
      return connection.unsubscribe(message.id);
    case "up_start":
      return onUploadStart(link, ws, message);
    case "up_abort": {
      const { id, host } = message;
      if (typeof id !== "string" || !UPLOAD_ID_RE.test(id)) return ws.close(CLOSE.invalidData, "Invalid upload id");
      // The worker sends nothing of it after this line, so no chunk of it can follow.
      link.uploads.delete(id);
      abortUpload(id, link.owner, typeof host === "string" && host.length <= 128 ? host : undefined).catch((error: unknown) => console.error(`[omp-web] upload abort failed: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    case "cmd":
      return onCommand(link, ws, message, lineBytes);
    // A newer browser's message type: skipped, but its seq is acked so it is never resent.
  }
}

/** Opens, or resumes, an upload: all of its sink's acks and errors carry this start's `n`, so queued callbacks from
 * an earlier generation cannot advance or fail a newer attempt. */
function onUploadStart(link: BrowserLink, ws: BrowserSocket, message: Record<string, unknown>): void {
  // `mime`: the file's type (`type` is the message's).
  const { id, n, host, name, size, mime } = message;
  if (typeof id !== "string" || !UPLOAD_ID_RE.test(id)) return ws.close(CLOSE.invalidData, "Invalid upload id");
  const key = `up:${id}`;
  const sink: UploadSink = {
    ack: (received, done, proof) => void queue(link, key, JSON.stringify({ type: "up_ack", id, received, done, start: n, ...(done && proof ? { proof } : {}) })),
    error: (status, code, error) => void queue(link, key, JSON.stringify({ type: "up_error", id, status, code, message: error, start: n })),
  };
  if (!link.uploads.has(id)) link.uploads.set(id, sink);
  if (!isSafeCount(n) || typeof host !== "string" || typeof name !== "string" || !isSafeCount(size) || typeof mime !== "string") {
    return sink.error(400, "invalid_request", "Invalid upload");
  }
  startUpload({ id, hostId: host, owner: link.owner, name, size, type: mime, sink, onRegistered: () => link.uploads.set(id, sink) }).then(({ received, proof }) => {
    queue(link, key, JSON.stringify({ type: "up_ack", id, received, done: received >= size, start: n, ...(proof ? { proof } : {}) }));
  }, (error: unknown) => {
    if (error instanceof HostOpError) return sink.error(error.status, error.code, error.message);
    console.error(`[omp-web] upload start failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    sink.error(500, "upload_failed", "The upload could not start");
  });
}

function onCommand(link: BrowserLink, ws: BrowserSocket, message: Record<string, unknown>, lineBytes: number): void {
  const { rid, session } = message;
  if (typeof rid !== "string" || !rid || rid.length > MAX_RID_LENGTH) return ws.close(CLOSE.invalidData, "Invalid rid");
  const recvAt = Date.now();
  const type = isRecord(message.command) && typeof message.command.type === "string" ? message.command.type : "";
  // One key per session, as the worker sends them: its commands and replies keep their order.
  const key = `cmd:${typeof session === "string" ? session : ""}`;
  const reply = ({ status, body }: Reply, deduped: boolean) => {
    queue(link, key, `{"type":"reply","rid":${JSON.stringify(rid)},"status":${status},"recvAt":${recvAt},"at":${Date.now()},"deduped":${deduped},"data":${JSON.stringify(body)}}`);
  };
  // A bad session fails only this command: the link carries other sessions' commands.
  if (typeof session !== "string" || !session || session.length > MAX_SESSION_ID_LENGTH) return reply({ status: 400, body: INVALID_REQUEST }, false);
  // The route's cap on the request body, on the command: the line's cap leaves room for the envelope, and only a joined
  // line can pass it. Not remembered, so a resend is refused again.
  if (lineBytes > MAX_AGENT_COMMAND_REQUEST_BYTES && Buffer.byteLength(JSON.stringify(message.command)) > MAX_AGENT_COMMAND_REQUEST_BYTES) {
    return reply({ status: 413, body: { error: "Agent command is too large", code: "request_too_large" } }, false);
  }
  // Scoped to the session, not the link: a resend after a resync comes on a new link, and a rid another session
  // happens to use never replays this one's reply. JSON keeps the pair unambiguous for any session id. A read-only
  // command is safe to run again and is not remembered, so it never takes the room of one that changes something.
  const run = async () => {
    const response = await runAgentCommand(session, message.command, message.advisor === true, link.owner);
    return { status: response.status, body: await response.json() };
  };
  const started = isIdempotentCommand(type) ? { result: run(), deduped: false } : runOnce(JSON.stringify([session, rid]), run);
  // Every remembered command is still inside its window: forgetting one would let its resend run it twice.
  if (!started) return reply({ status: 429, body: { error: "Too many commands in the last 10 minutes", code: "too_many_commands" } }, false);
  started.result.then((answer) => reply(answer, started.deduped)).catch((error: unknown) => fail(ws, error));
}

/** One run per key: a known key joins the run in flight or replays its settled reply (a resend after a lost reply).
 * Undefined when DEDUPE_MAX commands are remembered and none has expired: nothing is forgotten early. */
function runOnce(key: string, run: () => Promise<Reply>): { result: Promise<Reply>; deduped: boolean } | undefined {
  const map = (globalThis.__ompBrowserCommands ??= new Map());
  const now = Date.now();
  const known = map.get(key);
  if (known && known.expiresAt > now) return { result: known.result, deduped: true };
  for (const [stale, entry] of map) if (entry.expiresAt <= now) map.delete(stale);
  if (map.size >= DEDUPE_MAX) return undefined;
  // Called now, not after an await: on the fast path the command reaches omp in the link's order.
  const entry: Remembered = { result: run(), expiresAt: Infinity };
  const settle = () => {
    entry.expiresAt = Date.now() + COMMAND_DEDUPE_MS;
  };
  entry.result.then(settle, settle);
  map.set(key, entry);
  return { result: entry.result, deduped: false };
}
