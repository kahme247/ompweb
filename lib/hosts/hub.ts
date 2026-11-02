// Main-server end of the host link (spec "Link protocol"): accepts `ompweb
// host` daemons on /api/hosts/link and exposes each linked machine as a
// `RemoteHost`. Everything a daemon sends is untrusted input.
// No `next/*` or `@/` imports.
import { randomUUID } from "node:crypto";
import { readBodyWithinLimit } from "../bounded-form-data";
import type { RpcTransport } from "../omp/rpc-transport";
import type { ProjectRegistryEntry } from "../project-registry";
import { isValidSessionId } from "../session-file-references-core";
import { appendTransportSamples, transportMetricsPath } from "../transport-metrics";
import { isRecord } from "../type-guards";
import type { SessionInfo } from "../types";
import { isLinkUp, type Host, type HostStatus, type SpawnRequest, type SpawnResult } from "./host";
import {
  decodeBlobFrame,
  decodeUp,
  encodeLine,
  encodeQueued,
  HostOpError,
  LINK_CLOSE,
  LINK_LIMITS,
  LINK_PROTOCOL_VERSION,
  LinkLimitError,
  LinkSender,
  MIN_LINK_PROTOCOL_VERSION,
  Outbox,
  PartJoiner,
  SeqWindow,
  SESSION_OP_PARAMS,
  type DownMessage,
  type HelloChannel,
  type HostOpName,
  type UnknownMessage,
  type Unsequenced,
  UnknownMessageLog,
  type UpMessage,
  withSeq,
} from "./link-protocol";
import { customLocalLabel, DEFAULT_LOCAL_LABEL, HostRegistryUnreadableError, hostForToken, LOCAL_HOST_ID, loadHosts, touchHost, type HostRecord } from "./registry";
import type { SessionOps } from "./session-ops";

/** Liveness and op timeouts from LINK_LIMITS; tests shorten them. */
export const linkTimings = {
  pingMs: LINK_LIMITS.pingMs,
  offlineMs: LINK_LIMITS.offlineMs,
  opTimeoutMs: LINK_LIMITS.opTimeoutMs,
};

/** What the hub keeps on each link socket (Bun's `ws.data`): the host its token named, and whether its hello came. */
export interface LinkSocketData {
  hostId: string;
  hello: boolean;
}

/** The server end of a link WebSocket: the part of Bun's ServerWebSocket the hub uses, so tests drive it with a plain object. */
export interface LinkSocket {
  readonly data: LinkSocketData;
  send(data: string | Uint8Array): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

type Hello = Extract<UpMessage, { type: "hello" }>;
type Res = Extract<UpMessage, { type: "res" }>;

interface PendingOp {
  op: HostOpName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Result bytes from the binary frames sent ahead of their `res`, in order (views into those frames). */
  blob: Uint8Array[];
  blobBytes: number;
}

/** A downlink line sent (or to resend) and not acked yet. `key`: the `sender` key it went out under; `bytes`: its
 * UTF-8 size; `part`: a `part` line; `whole`: on the last part of a line, that line as queued, which a v4 daemon gets
 * instead (partsToWhole); `sample`: on the line that completes a message, its link sample. */
interface Sent {
  seq: number;
  line: string;
  key: string;
  bytes: number;
  part: boolean;
  whole: string | null;
  sample: DownSample | null;
}

/** What a downlink message's link sample needs, taken when it is queued: the time (wall and monotonic), its UTF-8 size, the bytes queued
 * or unacked ahead of it then, and the session it serves. */
interface DownSample {
  at: number;
  /** `at` on the monotonic clock, for ackMs. */
  t: number;
  bytes: number;
  bytesAhead: number;
  session: string | null;
}

interface Link {
  readonly id: string;
  readonly host: RemoteHost;
  status: HostStatus;
  /** Link protocol version the daemon last presented (Settings shows it on a 426). */
  hostVersion: number | null;
  ompVersion: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  autoApprove: boolean;
  /** The socket whose hello this link took; null while the daemon has none. */
  socket: LinkSocket | null;
  /** Last downlink seq handed out. Lines stay in `outbox` until the daemon acks them. */
  downSeq: number;
  /** Downlink messages not numbered yet, per channel or request, sent fair (spec D7). */
  sender: LinkSender<{ line: string; size: number; sample: DownSample }>;
  outbox: Outbox<Sent>;
  /** Bytes of the outbox lines, sent or waiting for a resend. */
  outboxBytes: number;
  /** Highest outbox seq written to the current socket; `flush` sends what is past it. */
  sentSeq: number;
  /** Bytes of the outbox lines written to the current socket: the unacked window (spec D7). */
  unacked: number;
  /** Bun queued the last line over the socket's buffered data: the rest waits for its `drain`. */
  awaitingDrain: boolean;
  up: SeqWindow;
  /** The uplink line the daemon is sending in parts. */
  parts: PartJoiner;
  /** What this link has already logged about messages it skipped. */
  unknownLog: UnknownMessageLog;
  /** This link's `up` samples in the current statsFlushMs window (STATS_BUDGET_FACTOR × statsSamples at most) and those
   * dropped past it; `start` is a monotonic time. */
  statsWindow: { start: number; used: number; dropped: number };
  /** A malformed `stats` sample was logged on this link (once per link). */
  statsWarned: boolean;
  pending: Map<string, PendingOp>;
  channels: Map<string, RemoteRpcTransport>;
  pingTimer: NodeJS.Timeout | undefined;
  offlineTimer: NodeJS.Timeout | undefined;
  statusListeners: Set<(status: HostStatus) => void>;
}

/** Link samples (metric "link") waiting to be written, and the file they go to, resolved when the batch started so a
 * later flush never re-resolves the agent dir (a test's may be gone by then). */
interface LinkSampleBatch {
  samples: Record<string, unknown>[];
  file: string;
  timer: NodeJS.Timeout | undefined;
}

interface HubState {
  links: Map<string, Link>;
  changeListeners: Set<() => void>;
  helloListeners: Set<(hostId: string, channels: HelloChannel[]) => void>;
  /** This server is shutting down (freezeHostLinks): links neither send nor apply anything. */
  frozen: boolean;
  linkSamples: LinkSampleBatch;
}

declare global {
  var __ompHostHub: HubState | undefined;
}

// globalThis, like the rpc-manager registry: survives a `bun --hot` re-evaluation.
function hub(): HubState {
  globalThis.__ompHostHub ??= {
    links: new Map(),
    changeListeners: new Set(),
    helloListeners: new Set(),
    frozen: false,
    linkSamples: { samples: [], file: "", timer: undefined },
  };
  // A state kept from before a field existed (`bun --hot`) lacks it.
  globalThis.__ompHostHub.linkSamples ??= { samples: [], file: "", timer: undefined };
  return globalThis.__ompHostHub;
}

function linkFor(id: string): Link {
  const links = hub().links;
  let link = links.get(id);
  if (!link) {
    link = {
      id,
      host: new RemoteHost(id),
      status: "offline",
      hostVersion: null,
      ompVersion: null,
      platform: null,
      lastSeenAt: null,
      autoApprove: false,
      socket: null,
      downSeq: 0,
      sender: new LinkSender(true),
      outbox: new Outbox(),
      outboxBytes: 0,
      sentSeq: 0,
      unacked: 0,
      awaitingDrain: false,
      up: new SeqWindow(),
      parts: new PartJoiner(),
      unknownLog: new UnknownMessageLog("daemon"),
      statsWindow: { start: 0, used: 0, dropped: 0 },
      statsWarned: false,
      pending: new Map(),
      channels: new Map(),
      pingTimer: undefined,
      offlineTimer: undefined,
      statusListeners: new Set(),
    };
    links.set(id, link);
  }
  return link;
}

function labelOf(id: string): string {
  if (id === LOCAL_HOST_ID) return customLocalLabel() || DEFAULT_LOCAL_LABEL;
  return loadHosts().find((h) => h.id === id)?.label ?? id;
}

function notify<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
  for (const listener of listeners) {
    try {
      listener(...args);
    } catch {
      // A listener bug must not break the link.
    }
  }
}

function setStatus(link: Link, status: HostStatus): void {
  if (link.status !== status) {
    link.status = status;
    notify(link.statusListeners, status);
  }
  notify(hub().changeListeners);
}

const isStatus = (status: unknown): status is number => Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** Unsequenced lines (welcome, ping, pong, ack): small, sent at once, never resent. */
function enqueue(link: Link, line: string): void {
  link.socket?.send(line);
}

/** Lines that left the outbox (acked or dropped): those written to the current socket leave the unacked window. */
function released(link: Link, items: Sent[]): void {
  for (const item of items) {
    link.outboxBytes -= item.bytes;
    if (item.seq <= link.sentSeq) link.unacked -= item.bytes;
  }
}

/** Send outbox lines past `sentSeq` (a resend after a redial), then the sender's next units, while the unacked window
 * has room and until Bun queues one under backpressure (-1: the rest goes on `drain`) or drops it (0: the socket is
 * closing; the next socket starts from its hello's ack). So at most about unackedBytes of sequenced lines sit in
 * Bun's, the kernel's and the daemon's buffers (spec D7), and a daemon that stops reading is waited for instead of
 * closed. */
function flush(link: Link): void {
  const ws = link.socket;
  if (!ws || link.awaitingDrain || hub().frozen) return;
  // A v4 daemon acks only inside its next uplink frame, which may be a pong 15 s away: it gets no window.
  const limit = link.sender.parts ? LINK_LIMITS.unackedBytes : Infinity;
  const write = (item: Sent): boolean => {
    const sent = ws.send(item.line);
    if (sent !== 0) {
      link.sentSeq = item.seq;
      link.unacked += item.bytes;
    }
    if (sent > 0) return true;
    link.awaitingDrain = true;
    return false;
  };
  for (const item of link.outbox.pending()) {
    if (item.seq > link.sentSeq && (link.unacked >= limit || !write(item))) return;
  }
  while (link.unacked < limit) {
    const unit = link.sender.next(() => ++link.downSeq);
    // The hub queues lines only, so every unit is a line.
    if (!unit || !("line" in unit)) return;
    const whole = unit.part && unit.done ? unit.item.line : null;
    // One sample per message: a split one carries it on its last part.
    const item: Sent = { seq: unit.seq, line: unit.line, key: unit.key, bytes: Buffer.byteLength(unit.line), part: unit.part, whole, sample: unit.done ? { ...unit.item.sample, bytes: unit.messageBytes } : null };
    link.outbox.push(item);
    link.outboxBytes += item.bytes;
    if (!write(item)) return;
  }
}

/** A v4 daemon gets no `part`: the parts of a line that went out whole in parts go again as that line, under its last
 * part's seq; the parts of a line still going out are dropped, and the sender sends it whole from the start. */
function partsToWhole(link: Link): void {
  for (const item of link.outbox.drop(() => true)) {
    link.outboxBytes -= item.bytes;
    if (item.part && item.whole === null) continue;
    const line = item.part && item.whole !== null ? withSeq(item.whole, item.seq) : item.line;
    const bytes = Buffer.byteLength(line);
    link.outbox.push({ ...item, line, bytes, part: false, whole: null });
    link.outboxBytes += bytes;
  }
}

/** Queue under `key` (its channel or request id), numbered and kept until acked as it goes out. Throws
 * LinkLimitError before recording anything. Dropped once frozen: a kill, an answer or a command from a stopping
 * server must not reach the children. */
function sendDown(link: Link, body: Unsequenced<DownMessage>, key: string): void {
  if (hub().frozen) return;
  const line = encodeQueued(body);
  const size = Buffer.byteLength(line);
  // Ahead of it: what is queued or unacked on this link (counters, no scan); fairness may send it before some of that.
  const sample = { at: Date.now(), t: performance.now(), bytes: size, bytesAhead: link.outboxBytes + link.sender.queuedBytes, session: sessionOf(link, body) };
  link.sender.push(key, { line, size, sample });
  flush(link);
}

/** The session a downlink message serves: a session op's `id`, else its channel's child's; null for host ops. */
function sessionOf(link: Link, body: Unsequenced<DownMessage>): string | null {
  if (body.type !== "req") return "ch" in body ? link.channels.get(body.ch)?.session ?? null : null;
  return isRecord(body.args) && typeof body.args.id === "string" && isValidSessionId(body.args.id) ? body.args.id : null;
}

/** Batch link samples: written at LINK_LIMITS.statsSamples, after statsFlushMs, or when the hub stops. */
function recordLinkSamples(samples: Record<string, unknown>[]): void {
  const batch = hub().linkSamples;
  for (const sample of samples) {
    if (batch.samples.length === 0) {
      batch.file = transportMetricsPath();
      batch.timer = setTimeout(flushLinkSamples, LINK_LIMITS.statsFlushMs);
      batch.timer.unref?.();
    }
    batch.samples.push(sample);
    if (batch.samples.length >= LINK_LIMITS.statsSamples) flushLinkSamples();
  }
}

/** Write the batch now. Measurement only: a failed write is logged and dropped, never touches a link. */
export function flushLinkSamples(): void {
  const batch = hub().linkSamples;
  clearTimeout(batch.timer);
  batch.timer = undefined;
  if (batch.samples.length === 0) return;
  try {
    appendTransportSamples(batch.samples.splice(0), null, batch.file);
  } catch (error) {
    console.warn(`[omp-web] could not write host link samples: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The daemon applied the downlink through `ack`: each message it acks now (a split one at its last part) becomes a
 * `down` sample; the lines leave the outbox and the unacked window. `ackMs` is monotonic: a wall-clock step between
 * queueing and ack does not show in it. */
function ackDown(link: Link, ack: number): void {
  const now = performance.now();
  const samples: Record<string, unknown>[] = [];
  const acked = link.outbox.ack(ack);
  for (const { sample } of acked) {
    if (sample) samples.push({ metric: "link", dir: "down", host: link.id, session: sample.session, bytes: sample.bytes, bytesAhead: sample.bytesAhead, ackMs: Math.max(0, Math.round(now - sample.t)), at: sample.at });
  }
  released(link, acked);
  recordLinkSamples(samples);
}

/** `up` samples one link may write per statsFlushMs, in multiples of statsSamples (a daemon reports about one `stats`
 * per window): a daemon cannot flood the shared metrics file. */
const STATS_BUDGET_FACTOR = 8;

/** Write the samples dropped past the link's budget as one `{dropped}` sample. */
function recordDropped(link: Link): void {
  const window = link.statsWindow;
  if (window.dropped > 0) recordLinkSamples([{ metric: "link", dir: "up", host: link.id, dropped: window.dropped, at: Date.now() }]);
  window.dropped = 0;
}

/** A daemon's `stats`: valid samples within the link's budget become `up` samples; the excess is dropped and written as
 * one `{dropped}` sample when the next window starts, or when the link ends or the hub freezes. Malformed samples (already dropped by decodeUp) are logged once. */
function applyStats(link: Link, message: Extract<UpMessage, { type: "stats" }>): void {
  if (message.invalid && !link.statsWarned) {
    link.statsWarned = true;
    console.warn(`[omp-web] ${labelOf(link.id)}: dropped ${message.invalid} malformed link samples (not logged again for this host)`);
  }
  const window = link.statsWindow;
  const now = performance.now();
  if (now - window.start >= LINK_LIMITS.statsFlushMs) {
    recordDropped(link);
    Object.assign(window, { start: now, used: 0 });
  }
  const taken = message.samples.slice(0, Math.max(0, STATS_BUDGET_FACTOR * LINK_LIMITS.statsSamples - window.used));
  window.used += taken.length;
  window.dropped += message.samples.length - taken.length;
  recordLinkSamples(taken.map((sample) => ({ ...sample, metric: "link", dir: "up", host: link.id })));
}

/** Fail an op for good: a `req` not yet acked is never resent, nor the rest of one going in parts (one already
 * written may still run). */
function failOp(link: Link, id: string, error: Error): void {
  const pending = link.pending.get(id);
  if (!pending) return;
  link.pending.delete(id);
  clearTimeout(pending.timer);
  link.sender.drop(id);
  released(link, link.outbox.drop((m) => m.key === id));
  pending.reject(error);
  flush(link);
}

function failAllOps(link: Link, error: () => Error): void {
  for (const id of [...link.pending.keys()]) failOp(link, id, error());
}

/** The socket is gone: ops in flight fail now rather than at their timeout. */
function endSocket(link: Link): void {
  link.socket = null;
  recordDropped(link);
  failAllOps(link, () => new HostOpError(503, "host_offline", `${labelOf(link.id)} is offline`));
}

function stopTimers(link: Link): void {
  clearInterval(link.pingTimer);
  clearTimeout(link.offlineTimer);
  link.pingTimer = undefined;
  link.offlineTimer = undefined;
}

function persistLastSeen(link: Link): void {
  if (!link.lastSeenAt) return;
  try {
    touchHost(link.id, link.lastSeenAt);
  } catch {
    // Last-seen is informational; a failed write must not drop the link.
  }
}

/** Any uplink traffic proves the daemon alive; silence for offlineMs means the link is gone. */
function sawDaemon(link: Link): void {
  link.lastSeenAt = new Date().toISOString();
  clearTimeout(link.offlineTimer);
  link.offlineTimer = setTimeout(() => {
    stopTimers(link);
    // No close handshake on a link gone silent; the daemon redials once its own watchdog fires.
    link.socket?.terminate();
    endSocket(link);
    persistLastSeen(link);
    setStatus(link, "offline");
  }, linkTimings.offlineMs);
  link.offlineTimer.unref?.();
}

/** The host the bearer token names, or the refusal to answer with. */
function authenticate(req: Request): HostRecord | Response {
  const header = req.headers.get("authorization");
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  try {
    const record = token ? hostForToken(token) : null;
    if (!record) return json({ error: "Invalid host token" }, 401);
    return record;
  } catch (error) {
    if (!(error instanceof HostRegistryUnreadableError)) throw error;
    // Never 401 here: a daemon told its token is unknown stops every omp child.
    console.error(`[omp-web] host link refused: ${error.message}`);
    return json({ error: "The host registry cannot be read" }, 503);
  }
}

// The daemon retries a 503: what it sends lands on the next server instead.
const stopping = () => json({ error: "omp-web is shutting down" }, 503);

/**
 * This server is shutting down. From here on nothing reaches a daemon (sendDown
 * drops it), and no hello or uplink frame is applied or acked: each daemon keeps
 * its children's output unacked and sends it to the next server, which adopts the
 * children. Every link socket closes 1001, so its daemon redials. Without this a
 * tab closing on the way out would answer omp's open host tool calls with an
 * error, and output this server took but never showed would be lost to the next one.
 */
export function freezeHostLinks(): void {
  hub().frozen = true;
  for (const link of hub().links.values()) {
    recordDropped(link);
    link.socket?.close(LINK_CLOSE.goingAway, "omp-web is restarting");
  }
  // The process exits next: keep what was measured.
  flushLinkSamples();
}

/** GET /api/hosts/link: the daemon's WebSocket. The token is checked before the upgrade, so no unknown caller gets a
 * socket; undefined once upgraded. The hello comes as the socket's first frame (hostLinkSocket). */
export function handleLinkUpgrade(req: Request, upgrade: (data: LinkSocketData) => boolean): Response | undefined {
  const record = authenticate(req);
  if (record instanceof Response) return record;
  if (hub().frozen) return stopping();
  return upgrade({ hostId: record.id, hello: false }) ? undefined : json({ error: "The host link is a WebSocket" }, 426);
}

/** POST /api/hosts/link: only a daemon from before the WebSocket (v3) sends one, its hello. It gets the 426 that tells
 * it to update ompweb on its host. */
export async function handleOutdatedLinkPost(req: Request): Promise<Response> {
  const record = authenticate(req);
  if (record instanceof Response) return record;
  let raw: unknown = null;
  try {
    raw = JSON.parse(new TextDecoder().decode(await readBodyWithinLimit(req, LINK_LIMITS.uplinkBytes)));
  } catch {
    // Too large or not JSON: no version to report.
  }
  versionMismatch(linkFor(record.id), raw);
  return json({ error: "Link protocol version mismatch", hostVersion: helloVersion(raw), serverVersion: LINK_PROTOCOL_VERSION }, 426);
}

/** A hello's `v` when it is an integer, else null. */
function helloVersion(raw: unknown): number | null {
  const version = isRecord(raw) ? raw.v : undefined;
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}

/** True for a daemon outside MIN_LINK_PROTOCOL_VERSION..LINK_PROTOCOL_VERSION (a newer one too: the web app upgrades first).
 * Compared before decoding: another version may shape its hello differently. */
function versionMismatch(link: Link, raw: unknown): boolean {
  const version = helloVersion(raw);
  if (version !== null && version >= MIN_LINK_PROTOCOL_VERSION && version <= LINK_PROTOCOL_VERSION) return false;
  // A stray old daemon with this token must not take down the healthy link.
  if (!link.socket) {
    // Kept for Settings: "needs upgrade (host vN, server vM)".
    link.hostVersion = version;
    setStatus(link, "needs-upgrade");
  }
  return true;
}

/** Bun's `websocket` handler for host links (server/app.ts). */
export const hostLinkSocket = {
  // A result frame is up to blobBytes plus its id header; Bun closes 1009 above it.
  maxPayloadLength: LINK_LIMITS.blobBytes + 256,
  // A backstop: flush keeps at most about unackedBytes of sequenced lines unacked (v5) and stops when Bun reports
  // backpressure. Past the limit the socket closes instead of buffering on, and what the daemon missed is resent after
  // its redial.
  backpressureLimit: LINK_LIMITS.uplinkBytes,
  closeOnBackpressureLimit: true as const,
  message(ws: LinkSocket, data: string | Uint8Array): void {
    guarded(ws, () => {
      // Nothing is applied or answered once this server stops: the daemon keeps it for the next one.
      if (hub().frozen || failedSockets.has(ws)) return;
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket === ws) return onFrame(link, ws, data);
      // A socket a newer one replaced: what it still sends belongs to no link.
      if (ws.data.hello) return;
      onFirstFrame(ws, data);
    });
  },
  /** Bun wrote out what it had queued: send the outbox lines that waited. */
  drain(ws: LinkSocket): void {
    guarded(ws, () => {
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket !== ws) return;
      link.awaitingDrain = false;
      flush(link);
    });
  },
  close(ws: LinkSocket): void {
    guarded(ws, () => {
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket === ws) endSocket(link);
    });
  },
};

/** Sockets whose handler threw: closed, and nothing more they send is applied (it would land past a half-applied frame). */
const failedSockets = new WeakSet<LinkSocket>();

/** A throw in a websocket handler would reach uncaughtException, which exits the server: it ends that socket instead. */
function guarded(ws: LinkSocket, handle: () => void): void {
  try {
    handle();
  } catch (error) {
    failedSockets.add(ws);
    console.error(`[omp-web] host link of ${ws.data.hostId} failed; closing it: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    ws.close();
  }
}

/** A socket's first frame must be its hello. */
function onFirstFrame(ws: LinkSocket, data: string | Uint8Array): void {
  const refuse = () => ws.close(LINK_CLOSE.policy, "The first frame must be a hello");
  if (typeof data !== "string") return refuse();
  // A hello is one line: nothing longer is worth parsing.
  if (Buffer.byteLength(data) > LINK_LIMITS.maxLineBytes) return ws.close(LINK_CLOSE.tooBig, "Hello too large");
  // Revoked or deleted since the upgrade, or the registry cannot say: a plain close sends the daemon's redial through
  // the token check (401 stops its children, 503 redials).
  if (ws.data.hostId !== LOCAL_HOST_ID && !loadHosts().some((h) => h.id === ws.data.hostId)) return ws.close();
  const link = linkFor(ws.data.hostId);
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return refuse();
  }
  if (versionMismatch(link, raw)) return ws.close(LINK_CLOSE.versionMismatch, JSON.stringify({ serverVersion: LINK_PROTOCOL_VERSION }));
  let hello: UpMessage | UnknownMessage;
  try {
    hello = decodeUp(data);
  } catch {
    return refuse();
  }
  if (hello.type !== "hello") return refuse();
  ws.data.hello = true;
  openLink(link, ws, hello);
}

function openLink(link: Link, ws: LinkSocket, hello: Hello): void {
  // One link per host: the newest wins and the previous daemon exits.
  const previous = link.socket;
  link.socket = ws;
  previous?.close(LINK_CLOSE.replaced, "replaced by a newer link");
  // Every sequenced uplink message answers a downlink one, so a daemon that
  // has applied none (ack 0) has sent none: it is a fresh process whose
  // uplink numbering starts again at 1.
  if (hello.ack <= 0) {
    link.up = new SeqWindow();
    // Such a daemon is asked again and answers from byte 0: the pieces of the replaced socket would prefix its result. The
    // same process (ack above 0) resends only the `res` of a result whose pieces already arrived.
    for (const pending of link.pending.values()) Object.assign(pending, { blob: [], blobBytes: 0 });
  }
  // After a restart of this server the daemon is ahead: number above its ack.
  link.downSeq = Math.max(link.downSeq, hello.ack);
  released(link, link.outbox.ack(hello.ack));
  link.unknownLog.reset();
  // The version this link speaks: from 5 on, lines over pieceBytes go in parts.
  link.hostVersion = hello.v;
  link.sender.parts = hello.v >= 5;
  if (!link.sender.parts) partsToWhole(link);
  enqueue(link, encodeLine({ type: "welcome", v: hello.v, hostId: link.id }));
  // Resend what the daemon has not applied, in order and paced, before anything new.
  link.sentSeq = hello.ack;
  link.unacked = 0;
  link.awaitingDrain = false;
  flush(link);
  reattach(link, hello.channels);

  link.ompVersion = hello.ompVersion;
  link.platform = hello.platform;
  link.autoApprove = hello.autoApproveExtension;
  sawDaemon(link);
  persistLastSeen(link);
  clearInterval(link.pingTimer);
  link.pingTimer = setInterval(() => enqueue(link, encodeLine({ type: "ping" })), linkTimings.pingMs);
  link.pingTimer.unref?.();
  setStatus(link, hello.ompVersion === null ? "omp-missing" : "online");
  notify(hub().helloListeners, link.id, hello.channels);
}

/** A frame on the link's current socket: a result's bytes (binary), or uplink messages (text). */
function onFrame(link: Link, ws: LinkSocket, data: string | Uint8Array): void {
  sawDaemon(link);
  if (typeof data !== "string") {
    let result: { id: string; bytes: Uint8Array };
    try {
      result = decodeBlobFrame(data);
    } catch {
      return ws.close(LINK_CLOSE.policy, "Malformed result frame");
    }
    // A large result comes in pieces, in order (a v4 daemon sends one). Pieces for an op no longer waiting are dropped;
    // past blobBytes none are kept, so its `res` then fails host_blob_missing.
    const pending = link.pending.get(result.id);
    if (pending) {
      pending.blobBytes += result.bytes.byteLength;
      if (pending.blobBytes <= LINK_LIMITS.blobBytes) {
        pending.blob.push(result.bytes);
        // The deadline is for silence: at one unacked window per round trip a valid 64 MiB result outlasts a fixed one.
        // Only bytes the hub keeps count, so empty or surplus frames cannot hold an op open.
        if (result.bytes.byteLength > 0) pending.timer.refresh();
      }
    }
    // A v5 daemon counts its frames in flight by these answers, binary ones included.
    if ((link.hostVersion ?? 0) >= 5) enqueue(link, encodeLine({ type: "ack", ack: link.up.acked }));
    return;
  }
  if (Buffer.byteLength(data) > LINK_LIMITS.uplinkBytes) return ws.close(LINK_CLOSE.tooBig, "Uplink frame too large");
  let messages: (UpMessage | UnknownMessage)[];
  // The decoded line of each part that completes one.
  const wholes = new Map<UpMessage | UnknownMessage, UpMessage | UnknownMessage>();
  const parts = link.parts.clone();
  try {
    // Decode the whole frame first, joined lines included: a frame with one bad line applies nothing. The parts go
    // through a copy of the joiner, and applyUp's dedup is mirrored by a running high mark.
    let high = link.up.acked;
    messages = data.split("\n").filter(Boolean).map((line) => {
      const message = decodeUp(line);
      const seq = "seq" in message ? message.seq : null;
      if (seq === null || seq <= high) return message;
      high = seq;
      const whole = message.type === "part" ? parts.add(message) : null;
      if (whole !== null) wholes.set(message, decodeUp(whole));
      return message;
    });
  } catch {
    return ws.close(LINK_CLOSE.invalidData, "Malformed uplink frame");
  }
  link.parts = parts;
  for (const message of messages) {
    if (message.type === "ack") ackDown(link, message.ack);
    else applyUp(link, message, wholes.get(message));
  }
  // One answer per frame, also to one with nothing sequenced in it: a v5 daemon counts its frames in flight by them.
  enqueue(link, encodeLine({ type: "ack", ack: link.up.acked }));
  // The daemon's ack may have opened the unacked window.
  flush(link);
}

/** SIGKILL an orphan this long after its SIGTERM, as the daemon does when it stops. */
const ORPHAN_KILL_GRACE_MS = 5_000;

/**
 * Spec Rules → Reattach. Listed channels this server has a transport for carry
 * on unchanged. A spawned child the daemon no longer lists died while the link
 * was down: its transport gets a synthesized exit, marked `lost`. Listed
 * channels without a transport are children of a previous run of this server:
 * adopted (see adopt), or killed as orphans when that is not possible. Either
 * way they stay registered until their `exit` (see orphanExit).
 */
function reattach(link: Link, listed: HelloChannel[]): void {
  const live = new Set(listed.map(({ ch }) => ch));
  for (const [ch, transport] of link.channels) {
    // A spawn still in flight is not listed yet.
    if (!transport.spawned || live.has(ch)) continue;
    link.channels.delete(ch);
    transport.lost = true;
    transport.deliverExit(null, null);
  }
  for (const { ch, sessionId, cwd, pending } of listed) {
    if (link.channels.has(ch)) continue;
    const child = new RemoteRpcTransport(link.id, ch, sessionId);
    child.spawned = true;
    link.channels.set(ch, child);
    // A null `pending` lost open requests to the daemon's cap: adopted, the run would wait on them forever.
    if (sessionId && pending) child.adoption = adopt(link, child, sessionId, cwd, pending);
    else killOrphan(child);
  }
}

function killOrphan(orphan: RemoteRpcTransport): void {
  orphan.orphaned = true;
  orphan.killTree(false);
  const escalate = setTimeout(() => orphan.killTree(true), ORPHAN_KILL_GRACE_MS);
  escalate.unref?.();
  orphan.onExit(() => clearTimeout(escalate));
}

/** Spec "Adopting live children": a session wrapper takes the child over, by
 * the identity the child itself reports (a new session is in no list before
 * its first reply is written). One that cannot re-sync is killed. True when adopted. */
async function adopt(link: Link, child: RemoteRpcTransport, sessionId: string, cwd: string, replay: string[]): Promise<boolean> {
  try {
    // Dynamic: rpc-manager imports this module.
    const { adoptRpcSession } = await import("../rpc-manager");
    await adoptRpcSession({ host: link.host, transport: child, sessionId, cwd, replay });
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (hub().frozen) {
      // Nothing reaches the daemon now, a kill included: the child runs on for the next server.
      console.warn(`[omp-web] left the omp child of session ${sessionId} on ${labelOf(link.id)} to the next server: this one stopped while adopting it (${reason})`);
    } else {
      // adoptRpcSession has already killed it (its wrapper's dispose escalates to SIGKILL).
      console.warn(`[omp-web] killing the omp child of session ${sessionId} on ${labelOf(link.id)}: it could not be adopted (${reason})`);
    }
    return false;
  }
}

/** `whole`: for a `part` that completes a line, that line decoded. `joined`: that line itself, which gets no dedup of
 * its own (its parts were deduped). */
function applyUp(link: Link, message: UpMessage | UnknownMessage, whole?: UpMessage | UnknownMessage, joined = false): void {
  if (message.type === "ping") return enqueue(link, encodeLine({ type: "pong" }));
  if (message.type === "pong" || message.type === "hello" || message.type === "ack") return;
  if (message.type === "unknown") {
    // A newer daemon's message, or one only the server sends: skipped, but its seq is applied so it is acked and never resent.
    if (message.seq !== null) link.up.applied(message.seq);
    const note = link.unknownLog.note(message);
    if (note) console.warn(`[omp-web] ${labelOf(link.id)}: ${note}`);
    return;
  }
  // Already applied before a resend.
  if (!joined && !link.up.applied(message.seq)) return;
  switch (message.type) {
    case "part":
      return whole ? applyUp(link, whole, undefined, true) : undefined;
    case "stdout":
      return link.channels.get(message.ch)?.deliverLine(message.line);
    case "stderr":
      return link.channels.get(message.ch)?.deliverStderr(message.chunk);
    case "resync":
      return link.channels.get(message.ch)?.deliverResync();
    case "exit": {
      const transport = link.channels.get(message.ch);
      link.channels.delete(message.ch);
      return transport?.deliverExit(message.code, message.signal as NodeJS.Signals | null);
    }
    case "res":
      return settle(link, message);
    case "stats":
      return applyStats(link, message);
  }
}

function settle(link: Link, message: Res): void {
  const pending = link.pending.get(message.id);
  // Timed out, or an id this server never issued.
  if (!pending) return;
  link.pending.delete(message.id);
  clearTimeout(pending.timer);
  const label = labelOf(link.id);
  if (!message.ok) {
    const { status, code, message: text } = message.error;
    pending.reject(new HostOpError(isStatus(status) ? status : 502, code, `${label}: ${text}`));
    return;
  }
  if (!message.blob) return pending.resolve(message.result);
  if (pending.blob.length === 0 || pending.blobBytes > LINK_LIMITS.blobBytes || pending.blobBytes !== message.blob.bytes) {
    return pending.reject(new HostOpError(502, "host_blob_missing", `${label} did not deliver the ${pending.op} result`));
  }
  const blob = pending.blob.length === 1 ? pending.blob[0] : Buffer.concat(pending.blob);
  if (pending.op === "readMedia") return pending.resolve({ ok: true, value: blob });
  try {
    pending.resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob)));
  } catch {
    pending.reject(new HostOpError(502, "host_bad_result", `${label} sent an unreadable ${pending.op} result`));
  }
}

function request(hostId: string, op: HostOpName, args: Record<string, unknown>): Promise<unknown> {
  const link = linkFor(hostId);
  const label = labelOf(hostId);
  if (hub().frozen) return Promise.reject(new HostOpError(503, "server_stopping", "omp-web is shutting down"));
  if (!link.socket || !isLinkUp(link.status)) {
    return Promise.reject(new HostOpError(503, "host_offline", `${label} is offline`));
  }
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const id = randomUUID();
  const timer = setTimeout(() => failOp(link, id, new HostOpError(504, "host_timeout", `${label} did not answer ${op} in time`)), linkTimings.opTimeoutMs);
  // A deadline, like the ping and offline timers: never what keeps the server running.
  timer.unref?.();
  const pending: PendingOp = { op, resolve, reject, timer, blob: [], blobBytes: 0 };
  link.pending.set(id, pending);
  try {
    sendDown(link, { type: "req", id, op, args }, id);
  } catch (error) {
    clearTimeout(timer);
    link.pending.delete(id);
    reject(error instanceof LinkLimitError ? new HostOpError(413, "host_request_too_large", `The request is too large for ${label}`) : error);
  }
  return promise;
}

/** Shape check for daemon results other than the lists: an OpResult whose
 * value has the fields main reads (a 500 TypeError in a route otherwise). */
function validResult(op: keyof SessionOps, result: unknown, args: unknown[]): boolean {
  if (!isRecord(result)) return false;
  if (result.ok === false) return isStatus(result.status) && typeof result.code === "string" && typeof result.error === "string";
  if (result.ok !== true || !("value" in result)) return false;
  const { value } = result;
  switch (op) {
    // Media bytes only ever arrive through the blob leg.
    case "readMedia":
      return value instanceof Uint8Array;
    // Main uses these paths (spawn cwd, project keys): they must be strings.
    case "validateCwd":
      return isRecord(value) && typeof value.cwd === "string" && typeof value.projectRoot === "string";
    case "exportSession":
      return isRecord(value) && typeof value.html === "string" && typeof value.fileName === "string";
    case "readSession":
      return isRecord(value) && isRecord(value.info) && isRecord(value.context);
    case "readContext": {
      // The context route reads a different shape per mode.
      const options = isRecord(args[2]) ? args[2] : {};
      if (!isRecord(value)) return false;
      if (options.boundary) return Array.isArray(value.entryIds);
      if (options.sync) return isRecord(value.history) && nullableString(value.leafId) && nullableString(value.tipId);
      return isRecord(value.context);
    }
    case "archiveSession":
      return isRecord(value) && typeof value.archivedPath === "string";
    // The route reads `projects` and iterates `newRoots`.
    case "updateProject":
      return isRecord(value) && Array.isArray(value.projects) && value.projects.every((project) => projectEntry(project) !== null)
        && Array.isArray(value.newRoots) && value.newRoots.every((root) => typeof root === "string");
    default:
      return true;
  }
}

const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const optionalNumber = (value: unknown) => value === undefined || (typeof value === "number" && Number.isFinite(value));
const nullableString = (value: unknown) => value === null || typeof value === "string";

/** A daemon's session-list entry reduced to SessionInfo's fields; null when one has the wrong type. */
function sessionEntry(value: unknown): SessionInfo | null {
  if (!isRecord(value)) return null;
  const { path, id, cwd, name, created, modified, lastMessageAt, messageCount, firstMessage, parentSessionId, projectRoot, projectKey, worktreeBranch } = value;
  if (
    typeof path !== "string" || typeof id !== "string" || !isValidSessionId(id) || typeof cwd !== "string"
    || typeof created !== "string" || typeof modified !== "string" || typeof firstMessage !== "string"
    || typeof messageCount !== "number" || !Number.isFinite(messageCount)
    || ![name, lastMessageAt, parentSessionId, projectRoot, projectKey, worktreeBranch].every(optionalString)
  ) return null;
  return { path, id, cwd, name, created, modified, lastMessageAt, messageCount, firstMessage, parentSessionId, projectRoot, projectKey, worktreeBranch } as SessionInfo;
}

/** A daemon's project-registry entry reduced to its known fields; null when one has the wrong type. */
function projectEntry(value: unknown): ProjectRegistryEntry | null {
  if (!isRecord(value)) return null;
  const { path, addedAt, hidden, alias, sortOrder, pinOrder, launchConfig } = value;
  if (
    typeof path !== "string" || !path || typeof addedAt !== "string" || typeof hidden !== "boolean"
    || !optionalString(alias) || !optionalNumber(sortOrder) || !optionalNumber(pinOrder)
    || !(launchConfig === undefined || (isRecord(launchConfig)
      && optionalString(launchConfig.profile)
      && (launchConfig.advisor === undefined || typeof launchConfig.advisor === "boolean")
      && (launchConfig.extraArgs === undefined || (Array.isArray(launchConfig.extraArgs) && launchConfig.extraArgs.every((arg) => typeof arg === "string")))))
  ) return null;
  return { path, addedAt, hidden, alias, sortOrder, pinOrder, launchConfig } as ProjectRegistryEntry;
}

const MEDIA_HASH_RE = /^[0-9a-f]{64}$/;

/** Ops that rewrite or move a session's file: an exiting orphan of that session may still flush it. */
const ORPHAN_SENSITIVE_OPS: Partial<Record<keyof SessionOps, true>> = { archiveSession: true, deleteSession: true, renameSessionFile: true };

function remoteSessionOps(hostId: string): SessionOps {
  const ops: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [op, params] of Object.entries(SESSION_OP_PARAMS) as [keyof SessionOps, readonly string[]][]) {
    ops[op] = async (...args) => {
      if (op === "readMedia" && !MEDIA_HASH_RE.test(String(args[0]))) {
        return { ok: false, status: 400, code: "invalid_hash", error: "Invalid media hash" };
      }
      if (ORPHAN_SENSITIVE_OPS[op]) await orphanExit(hostId, String(args[0]));
      const result = await request(hostId, op, Object.fromEntries(params.map((name, i) => [name, args[i]])));
      const list: ((value: unknown) => object | null) | null = op === "listSessions" ? sessionEntry : op === "listProjects" ? projectEntry : null;
      // Untrusted list entries: malformed ones are dropped, the rest keep only their known fields.
      if (list && Array.isArray(result)) return result.map(list).filter((entry) => entry !== null);
      if (!list && validResult(op, result, args)) return result;
      throw new HostOpError(502, "host_bad_result", `${labelOf(hostId)} sent an invalid ${op} result`);
    };
  }
  return ops as unknown as SessionOps;
}

/** An omp child on a linked host. Output that arrives before `RpcProcess`
 * subscribes is held for the first listener, as the local transport does, up
 * to channelBufferBytes: past that the child is killed instead of held on. */
export class RemoteRpcTransport implements RpcTransport {
  readonly hostId: string;
  readonly ch: string;
  /** RpcTransport.id: the channel id, for log correlation. */
  get id(): string {
    return this.ch;
  }
  /** Set for a child of a previous run the daemon listed in `hello` (the session it runs); null for children this server spawned. */
  readonly sessionId: string | null;
  /** The session the child last named in a get_state answer, else `sessionId`: tags its link samples. */
  session: string | null;
  /** The daemon confirmed the spawn (or listed the channel); until then a `hello` without it is not a loss. */
  spawned = false;
  /** The daemon stopped listing this child: it died while the link was down. Set before the synthesized exit. */
  lost = false;
  /** Killed: a child of a previous run of this server that it could not adopt. Its output has no reader and is dropped. */
  orphaned = false;
  /** A listed child being taken over (see reattach): resolves true once adopted, false once killed instead. */
  adoption: Promise<boolean> | null = null;
  private readonly lineListeners: Array<(line: string) => void> = [];
  private readonly stderrListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private readonly resyncListeners: Array<() => void> = [];
  private readonly pendingLines: string[] = [];
  private readonly pendingStderr: string[] = [];
  private heldLineBytes = 0;
  private heldStderrBytes = 0;
  private overflowed = false;
  private exitInfo: [number | null, NodeJS.Signals | null] | null = null;

  constructor(hostId: string, ch: string, sessionId: string | null = null) {
    this.hostId = hostId;
    this.ch = ch;
    this.sessionId = sessionId;
    this.session = sessionId;
  }

  write(line: string, callback: (error?: Error | null) => void): void {
    if (this.exitInfo) return callback(new Error("RPC process is not running"));
    // sendDown would drop it: a command waiting on it fails now instead of at its timeout.
    if (hub().frozen) return callback(new Error("omp-web is shutting down"));
    try {
      // Kept in the link outbox until the daemon acks it, across reconnects; queued per channel, in order.
      sendDown(linkFor(this.hostId), { type: "stdin", ch: this.ch, line }, this.ch);
      callback(null);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
    for (const line of this.pendingLines.splice(0)) listener(line);
    this.heldLineBytes = 0;
  }

  onStderr(listener: (chunk: string) => void): void {
    this.stderrListeners.push(listener);
    for (const chunk of this.pendingStderr.splice(0)) listener(chunk);
    this.heldStderrBytes = 0;
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(listener);
    const info = this.exitInfo;
    if (info) queueMicrotask(() => listener(info[0], info[1]));
  }

  /** The host dropped buffered output for this child; the session must reconcile. */
  onResync(listener: () => void): void {
    this.resyncListeners.push(listener);
  }

  /** The link has no stdin EOF: closing input terminates the child. */
  endInput(): void {
    this.killTree(false);
  }

  killTree(force: boolean): void {
    if (this.exitInfo) return;
    sendDown(linkFor(this.hostId), { type: "kill", ch: this.ch, force }, this.ch);
  }

  /** The byte size of `text` when it may be held for a listener; null past the cap, where the child is killed once. */
  private holdable(text: string): number | null {
    const bytes = Buffer.byteLength(text);
    if (!this.overflowed && this.heldLineBytes + this.heldStderrBytes + bytes <= LINK_LIMITS.channelBufferBytes) return bytes;
    if (!this.overflowed) {
      this.overflowed = true;
      this.killTree(true);
    }
    return null;
  }

  deliverLine(line: string): void {
    if (line.includes('"get_state"')) this.noteSession(line);
    if (this.orphaned) return;
    if (this.lineListeners.length > 0) return notify(this.lineListeners, line);
    const bytes = this.holdable(line);
    if (bytes === null) return;
    this.pendingLines.push(line);
    this.heldLineBytes += bytes;
  }

  deliverStderr(chunk: string): void {
    if (this.orphaned) return;
    if (this.stderrListeners.length > 0) return notify(this.stderrListeners, chunk);
    const bytes = this.holdable(chunk);
    if (bytes === null) return;
    this.pendingStderr.push(chunk);
    this.heldStderrBytes += bytes;
  }

  deliverResync(): void {
    notify(this.resyncListeners);
  }

  deliverExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitInfo) return;
    this.exitInfo = [code, signal];
    notify(this.exitListeners, code, signal);
  }

  private noteSession(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord(frame) && frame.type === "response" && frame.command === "get_state" && frame.success === true && isRecord(frame.data)) {
      const { sessionId } = frame.data;
      if (typeof sessionId === "string" && isValidSessionId(sessionId)) this.session = sessionId;
    }
  }
}

function isSpawnResult(value: unknown): value is { cwd: string; fellBack: boolean; launchAdvisor: boolean; autoApproveExtension: boolean } {
  return isRecord(value)
    && typeof value.cwd === "string"
    && typeof value.fellBack === "boolean"
    && typeof value.launchAdvisor === "boolean"
    && typeof value.autoApproveExtension === "boolean";
}

/** A linked machine: the `Host` calls go over its link. */
export class RemoteHost implements Host {
  readonly id: string;
  readonly sessionOps: SessionOps;

  constructor(id: string) {
    this.id = id;
    this.sessionOps = remoteSessionOps(id);
  }

  get label(): string {
    return labelOf(this.id);
  }

  status(): HostStatus {
    return linkFor(this.id).status;
  }

  onStatus(listener: (status: HostStatus) => void): () => void {
    const listeners = linkFor(this.id).statusListeners;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async spawnRpc(spawnRequest: SpawnRequest): Promise<SpawnResult> {
    const link = linkFor(this.id);
    if (link.status === "omp-missing") throw new HostOpError(503, "host_omp_missing", `omp is not installed on ${this.label}`);
    const ch = randomUUID();
    const transport = new RemoteRpcTransport(this.id, ch);
    // Registered first: the child's output can overtake the spawn result.
    link.channels.set(ch, transport);
    try {
      const result = await request(this.id, "spawn", { ch, ...spawnRequest });
      if (!isSpawnResult(result)) throw new HostOpError(502, "host_bad_result", `${this.label} sent an invalid spawn result`);
      transport.spawned = true;
      link.autoApprove = result.autoApproveExtension;
      return { transport, cwd: result.cwd, fellBack: result.fellBack, launchAdvisor: result.launchAdvisor };
    } catch (error) {
      link.channels.delete(ch);
      // The daemon may have started it after we gave up: never leave it unread.
      transport.killTree(true);
      throw error;
    }
  }

  async sessionFileExists(path: string): Promise<boolean> {
    const exists = await request(this.id, "sessionFileExists", { path });
    if (typeof exists !== "boolean") throw new HostOpError(502, "host_bad_result", `${this.label} sent an invalid sessionFileExists result`);
    return exists;
  }

  invalidateSessionLists(sessionFile?: string): void {
    // Best effort, like the local cache drop.
    request(this.id, "invalidateSessionLists", { path: sessionFile }).catch(() => {});
  }

  autoApproveExtension(): boolean {
    return linkFor(this.id).autoApprove;
  }
}

/** `local` is this machine, reached through its daemon link (offline while none is linked); other ids must be registered hosts. */
export function getHost(id: typeof LOCAL_HOST_ID): Host;
export function getHost(id: string): Host | null;
export function getHost(id: string): Host | null {
  return id === LOCAL_HOST_ID || loadHosts().some((h) => h.id === id) ? linkFor(id).host : null;
}

export interface LinkedHostRow {
  id: string;
  label: string;
  status: HostStatus;
  ompVersion: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  allowAgentStart: boolean;
  /** Link protocol version the daemon last presented; null before it ever dialed. */
  hostVersion: number | null;
  serverVersion: number;
}

export function listHosts(): LinkedHostRow[] {
  return loadHosts().filter((record) => record.id !== LOCAL_HOST_ID).map((record) => {
    const link = hub().links.get(record.id);
    return {
      id: record.id,
      label: record.label,
      status: link?.status ?? "offline",
      ompVersion: link?.ompVersion ?? null,
      platform: link?.platform ?? null,
      lastSeenAt: link?.lastSeenAt ?? record.lastSeenAt,
      allowAgentStart: record.allowAgentStart,
      hostVersion: link?.hostVersion ?? null,
      serverVersion: LINK_PROTOCOL_VERSION,
    };
  });
}

export interface LocalHostRow {
  id: "local";
  /** The user's name for this machine; "" while it goes by the localized default. */
  label: string;
  status: HostStatus;
  ompVersion: string | null;
  platform: string | null;
  lastSeenAt: null;
  hostVersion: number | null;
  serverVersion: number;
  /** `process.platform` of this server: picks the daemon install command while no daemon has linked. */
  serverPlatform: string;
  /** False under the dev server (`NODE_ENV=development`), where this machine runs sessions in-process and is offline by design: no install hints. */
  daemonManaged: boolean;
}

export type HostRow = LocalHostRow | LinkedHostRow;

/** Settings → Hosts payload (`GET /api/hosts` and the `hosts` channel): this machine first, then linked hosts. This machine's status is its daemon link's. */
export function hostsSnapshot(): { hosts: HostRow[] } {
  const link = hub().links.get(LOCAL_HOST_ID);
  const local: LocalHostRow = {
    id: "local",
    label: customLocalLabel(),
    status: link?.status ?? "offline",
    ompVersion: link?.ompVersion ?? null,
    platform: link?.platform ?? null,
    lastSeenAt: null,
    hostVersion: link?.hostVersion ?? null,
    serverVersion: LINK_PROTOCOL_VERSION,
    serverPlatform: process.platform,
    daemonManaged: process.env.NODE_ENV !== "development",
  };
  return { hosts: [local, ...listHosts()] };
}

/** Tell `hosts` subscribers the registry changed (rename, toggle, revoke); link changes notify on their own. */
export function notifyHostsChange(): void {
  notify(hub().changeListeners);
}

/** When the host last sent anything on its uplink (pongs included); null when it has no link here. */
export function lastUplinkAt(hostId: string): number | null {
  const lastSeenAt = hub().links.get(hostId)?.lastSeenAt;
  return lastSeenAt ? Date.parse(lastSeenAt) : null;
}

export function onHostsChange(listener: () => void): () => void {
  const listeners = hub().changeListeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fires on every accepted hello with the omp children the daemon still runs. Listeners
 * run after reattach: lost channels have exited, the rest are being adopted or killed. */
export function onHostHello(listener: (hostId: string, channels: HelloChannel[]) => void): () => void {
  const listeners = hub().helloListeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether this server adopted a child of `sessionId` the host listed in a hello; waits for an adoption still running. */
export async function adoptedChild(hostId: string, sessionId: string): Promise<boolean> {
  const listed = [...(hub().links.get(hostId)?.channels.values() ?? [])].filter((child) => child.sessionId === sessionId);
  return (await Promise.all(listed.map((child) => child.adoption))).includes(true);
}

/** Resolves once every child of `sessionId` the host listed in a hello has exited or been adopted.
 * Rejects with 503 if the host goes offline first: waiting through an outage
 * would hold the session's start lock until the host redials. */
export async function orphanExit(hostId: string, sessionId: string): Promise<void> {
  const link = hub().links.get(hostId);
  const listed = [...(link?.channels.values() ?? [])].filter((child) => child.sessionId === sessionId);
  if (!link || listed.length === 0) return;
  const { promise: offline, reject } = Promise.withResolvers<never>();
  const onStatus = (status: HostStatus) => {
    if (!isLinkUp(status)) reject(new HostOpError(503, "host_offline", `${labelOf(hostId)} is offline`));
  };
  onStatus(link.status);
  link.statusListeners.add(onStatus);
  const gone = listed.map((child) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    child.onExit(() => resolve());
    // An adopted child runs the live session: not an orphan to wait for.
    void child.adoption?.then((adopted) => adopted && resolve());
    return promise;
  });
  try {
    await Promise.race([offline, Promise.all(gone)]);
  } finally {
    link.statusListeners.delete(onStatus);
  }
}

/** End a host's link now (revoke). Its daemon gets 401 when it redials and stops its children. */
export function closeHostLink(id: string): void {
  const link = hub().links.get(id);
  if (!link) return;
  hub().links.delete(id);
  stopTimers(link);
  failAllOps(link, () => new HostOpError(503, "host_offline", "The host link was closed"));
  link.socket?.close();
  endSocket(link);
  // Nothing will report these children again.
  for (const transport of link.channels.values()) transport.deliverExit(null, null);
  setStatus(link, "offline");
}
