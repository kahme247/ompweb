// Main-server end of the host link (spec "Link protocol"): accepts `ompweb
// host` daemons on /api/hosts/link and exposes each linked machine as a
// `RemoteHost`. Everything a daemon sends is untrusted input.
// No `next/*` or `@/` imports.
import { randomUUID } from "node:crypto";
import { readBodyWithinLimit, RequestBodyTooLargeError } from "../bounded-form-data";
import type { RpcTransport } from "../omp/rpc-transport";
import { getOmpVersion } from "../omp/omp-cli";
import type { ProjectRegistryEntry } from "../project-registry";
import { isValidSessionId } from "../session-file-references-core";
import { isRecord } from "../type-guards";
import type { SessionInfo } from "../types";
import { isLinkUp, type Host, type HostStatus, type SpawnRequest, type SpawnResult } from "./host";
import {
  decodeUp,
  encodeLine,
  HostOpError,
  LINK_ACK_HEADER,
  LINK_HELLO_HEADER,
  LINK_LIMITS,
  LINK_NONCE_HEADER,
  LINK_PROTOCOL_VERSION,
  LinkLimitError,
  Outbox,
  SeqWindow,
  SESSION_OP_PARAMS,
  type DownMessage,
  type HelloChannel,
  type HostOpName,
  type UpMessage,
} from "./link-protocol";
import { localHost } from "./local-host";
import { HostRegistryUnreadableError, hostForToken, loadHosts, touchHost, type HostRecord } from "./registry";
import type { SessionOps } from "./session-ops";

/** Liveness and op timeouts from LINK_LIMITS; tests shorten them. */
export const linkTimings = {
  pingMs: LINK_LIMITS.pingMs,
  offlineMs: LINK_LIMITS.offlineMs,
  opTimeoutMs: LINK_LIMITS.opTimeoutMs,
};

type Hello = Extract<UpMessage, { type: "hello" }>;
type Res = Extract<UpMessage, { type: "res" }>;
/** A sequenced downlink message before the link numbers it. */
type Unsequenced<M> = M extends { seq: number } ? Omit<M, "seq"> : never;

interface PendingOp {
  op: HostOpName;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** Downlink seq of its `req`; dropped from the outbox when the op fails, so it never runs after. */
  seq: number;
  /** Result bytes uploaded on the blob leg ahead of their `res`. */
  blob: Uint8Array<ArrayBuffer> | null;
}

interface Link {
  readonly id: string;
  readonly host: RemoteHost;
  status: HostStatus;
  /** Names the current downlink (`welcome.nonce`); null until a daemon says hello.
   * Uplink POSTs and blob uploads from any other link are refused. */
  nonce: string | null;
  /** The last `hello` POSTed (spec Rules → Hello): its id opens one downlink GET, once, within offlineMs. */
  helloOffer: { id: string; hello: Hello; at: number } | null;
  /** Link protocol version the daemon last presented (Settings shows it on a 426). */
  hostVersion: number | null;
  ompVersion: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  autoApprove: boolean;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  /** Last downlink seq handed out. Lines stay in `outbox` until the daemon acks them. */
  downSeq: number;
  outbox: Outbox<{ seq: number; line: string }>;
  up: SeqWindow;
  pending: Map<string, PendingOp>;
  channels: Map<string, RemoteRpcTransport>;
  pingTimer: NodeJS.Timeout | undefined;
  offlineTimer: NodeJS.Timeout | undefined;
  statusListeners: Set<(status: HostStatus) => void>;
}

interface HubState {
  links: Map<string, Link>;
  changeListeners: Set<() => void>;
  helloListeners: Set<(hostId: string, channels: HelloChannel[]) => void>;
  /** This server is shutting down (freezeHostLinks): links neither send nor apply anything. */
  frozen: boolean;
}

declare global {
  var __ompHostHub: HubState | undefined;
}

// globalThis, like the rpc-manager registry: survives Next.js hot reload.
function hub(): HubState {
  globalThis.__ompHostHub ??= { links: new Map(), changeListeners: new Set(), helloListeners: new Set(), frozen: false };
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
      nonce: null,
      helloOffer: null,
      hostVersion: null,
      ompVersion: null,
      platform: null,
      lastSeenAt: null,
      autoApprove: false,
      stream: null,
      downSeq: 0,
      outbox: new Outbox(),
      up: new SeqWindow(),
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

const encoder = new TextEncoder();
const isStatus = (status: unknown): status is number => Number.isInteger(status) && (status as number) >= 400 && (status as number) <= 599;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

function enqueue(link: Link, line: string): void {
  try {
    link.stream?.enqueue(encoder.encode(line));
  } catch {
    // Closed under us; sequenced lines are still in the outbox.
    link.stream = null;
  }
}

/** Number, keep until acked, and send; returns the seq. Throws LinkLimitError before recording anything.
 * Dropped once frozen (0): a kill, an answer or a command from a stopping server must not reach the children. */
function sendDown(link: Link, body: Unsequenced<DownMessage>): number {
  if (hub().frozen) return 0;
  const seq = link.downSeq + 1;
  const line = encodeLine({ ...body, seq } as DownMessage);
  link.downSeq = seq;
  link.outbox.push({ seq, line });
  enqueue(link, line);
  return seq;
}

/** Fail an op for good: a `req` not yet acked is never resent (one already written may still run). */
function failOp(link: Link, id: string, error: Error): void {
  const pending = link.pending.get(id);
  if (!pending) return;
  link.pending.delete(id);
  clearTimeout(pending.timer);
  link.outbox.drop((m) => m.seq === pending.seq);
  pending.reject(error);
}

function failAllOps(link: Link, error: () => Error): void {
  for (const id of [...link.pending.keys()]) failOp(link, id, error());
}

/** The downlink is gone: ops in flight fail now rather than at their timeout. */
function endStream(link: Link): void {
  const stream = link.stream;
  link.stream = null;
  try {
    stream?.close();
  } catch {
    // Already closed.
  }
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
    // The daemon redials once its downlink ends.
    endStream(link);
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
    return record ?? json({ error: "Invalid host token" }, 401);
  } catch (error) {
    if (!(error instanceof HostRegistryUnreadableError)) throw error;
    // Never 401 here: a daemon told its token is unknown stops every omp child.
    console.error(`[omp-web] host link refused: ${error.message}`);
    return json({ error: "The host registry cannot be read" }, 503);
  }
}

/** The authenticated host's link when the request names its current nonce. */
function currentLink(req: Request, record: HostRecord): Link | null {
  const link = hub().links.get(record.id);
  return link?.nonce && req.headers.get(LINK_NONCE_HEADER) === link.nonce ? link : null;
}

const staleLink = () => json({ error: "This link was replaced; wait for the next welcome" }, 409);
// The daemon retries a 503: what it sends lands on the next server instead.
const stopping = () => json({ error: "omp-web is shutting down" }, 503);

/**
 * This server is shutting down. From here on nothing reaches a daemon (sendDown
 * drops it), and no hello, uplink batch or blob upload is applied or acked: each
 * daemon keeps its children's output unacked and sends it to the next server,
 * which adopts the children. Without this a tab closing on the way out would
 * answer omp's open host tool calls with an error, and output this server took
 * but never showed would be lost to the next one.
 */
export function freezeHostLinks(): void {
  hub().frozen = true;
}

/** GET /api/hosts/link: the daemon's downlink, an NDJSON stream, opened with the id of the hello it POSTed. */
export async function handleLinkGet(req: Request): Promise<Response> {
  const record = authenticate(req);
  if (record instanceof Response) return record;
  if (hub().frozen) return stopping();
  const link = linkFor(record.id);
  const helloId = req.headers.get(LINK_HELLO_HEADER);
  const offer = link.helloOffer;
  if (!offer || !helloId || offer.id !== helloId || Date.now() - offer.at > linkTimings.offlineMs) {
    return legacyHelloVersion(link, helloId) ?? json({ error: "Unknown or expired hello; POST a new one" }, 400);
  }
  // Taken here so the hello is applied once, however often its GET is replayed.
  link.helloOffer = null;
  return openDownlink(link, offer.hello, req.signal);
}

/** A v1 daemon sent its hello itself in the GET header (base64url JSON): it gets the 426 that tells it to upgrade. */
function legacyHelloVersion(link: Link, header: string | null): Response | null {
  try {
    const raw: unknown = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8"));
    return isRecord(raw) ? versionMismatch(link, raw) : null;
  } catch {
    return null;
  }
}

/** 426 for a daemon on another protocol version. Compared before decoding: another version may shape its hello differently. */
function versionMismatch(link: Link, raw: unknown): Response | null {
  const version = isRecord(raw) ? raw.v : undefined;
  if (version === LINK_PROTOCOL_VERSION) return null;
  const hostVersion = typeof version === "number" && Number.isInteger(version) ? version : null;
  // A stray old daemon with this token must not take down the healthy link.
  if (!link.stream) {
    // Kept for Settings: "needs upgrade (host vN, server vM)".
    link.hostVersion = hostVersion;
    setStatus(link, "needs-upgrade");
  }
  return json({ error: "Link protocol version mismatch", hostVersion, serverVersion: LINK_PROTOCOL_VERSION }, 426);
}

/** POST /api/hosts/link carrying LINK_HELLO_HEADER: the daemon's hello, in the body
 * (a header would cap how many channels it can list). Answers the id its downlink GET names. */
async function handleHelloPost(req: Request, record: HostRecord): Promise<Response> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await readBodyWithinLimit(req, LINK_LIMITS.uplinkBytes)).trim();
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return json({ error: "Hello too large" }, 413);
    return json({ error: "Missing or malformed hello" }, 400);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: "Missing or malformed hello" }, 400);
  }
  const link = linkFor(record.id);
  const mismatch = versionMismatch(link, raw);
  if (mismatch) return mismatch;
  let hello: UpMessage;
  try {
    hello = decodeUp(text);
  } catch {
    return json({ error: "Missing or malformed hello" }, 400);
  }
  if (hello.type !== "hello") return json({ error: "Missing or malformed hello" }, 400);
  // One offer per host: a newer hello replaces one whose GET never came.
  link.helloOffer = { id: randomUUID(), hello, at: Date.now() };
  return json({ helloId: link.helloOffer.id });
}

function openDownlink(link: Link, hello: Hello, signal: AbortSignal): Response {
  // One link per host: the newest wins and the previous daemon exits.
  const previous = link.stream;
  link.stream = null;
  if (previous) {
    try {
      previous.enqueue(encoder.encode(encodeLine({ type: "replaced", seq: ++link.downSeq })));
      previous.close();
    } catch {
      // Already gone.
    }
  }
  // Every sequenced uplink message answers a downlink one, so a daemon that
  // has applied none (ack 0) has sent none: it is a fresh process whose
  // uplink numbering starts again at 1.
  if (hello.ack <= 0) link.up = new SeqWindow();
  // After a restart of this server the daemon is ahead: number above its ack.
  link.downSeq = Math.max(link.downSeq, hello.ack);
  link.outbox.ack(hello.ack);

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      if (link.stream === controller) link.stream = null;
    },
  });
  signal.addEventListener("abort", () => {
    if (link.stream === controller) endStream(link);
  }, { once: true });
  link.stream = controller;
  link.nonce = randomUUID();
  link.hostVersion = LINK_PROTOCOL_VERSION;
  enqueue(link, encodeLine({ type: "welcome", v: LINK_PROTOCOL_VERSION, hostId: link.id, nonce: link.nonce }));
  // Resend what the daemon has not applied, in order, before anything new.
  for (const { line } of link.outbox.pending()) enqueue(link, line);
  reattach(link, hello.channels);

  link.ompVersion = hello.ompVersion;
  link.platform = hello.platform;
  sawDaemon(link);
  persistLastSeen(link);
  clearInterval(link.pingTimer);
  link.pingTimer = setInterval(() => enqueue(link, encodeLine({ type: "ping" })), linkTimings.pingMs);
  link.pingTimer.unref?.();
  setStatus(link, hello.ompVersion === null ? "omp-missing" : "online");
  notify(hub().helloListeners, link.id, hello.channels);
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      // no-transform keeps Next's compression from buffering the stream.
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
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
  // Asked once per hello, and fresh: a cached list may still hold a session deleted since.
  let sessions: Promise<SessionInfo[]> | undefined;
  const listSessions = () => (sessions ??= link.host.sessionOps.listSessions());
  for (const { ch, sessionId, pending } of listed) {
    if (link.channels.has(ch)) continue;
    const child = new RemoteRpcTransport(link.id, ch, sessionId);
    child.spawned = true;
    link.channels.set(ch, child);
    // A null `pending` lost open requests to the daemon's cap: adopted, the run would wait on them forever.
    if (sessionId && pending) child.adoption = adopt(link, child, sessionId, pending, listSessions);
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

/** Spec "Adopting live children": a session wrapper takes the child over; one
 * that cannot (unknown session, failed re-sync) is killed. True when adopted. */
async function adopt(link: Link, child: RemoteRpcTransport, sessionId: string, replay: string[], listSessions: () => Promise<SessionInfo[]>): Promise<boolean> {
  try {
    // rpc-manager imports this module. Awaiting it also defers the lookup past
    // openDownlink, which marks the link up (ops need it) after reattach.
    const { adoptRpcSession } = await import("../rpc-manager");
    const session = (await listSessions()).find((entry) => entry.id === sessionId);
    if (!session) throw new Error("its session is unknown");
    await adoptRpcSession({ host: link.host, transport: child, sessionId, cwd: session.cwd, replay });
    return true;
  } catch (error) {
    console.warn(`[omp-web] killing the omp child of session ${sessionId} on ${labelOf(link.id)}: it could not be adopted (${error instanceof Error ? error.message : String(error)})`);
    killOrphan(child);
    return false;
  }
}

/** POST /api/hosts/link: a batch of uplink NDJSON messages, or a hello (see handleHelloPost). */
export async function handleLinkPost(req: Request): Promise<Response> {
  const record = authenticate(req);
  if (record instanceof Response) return record;
  if (hub().frozen) return stopping();
  if (req.headers.has(LINK_HELLO_HEADER)) return handleHelloPost(req, record);
  // A replaced link's late POST must not reach the current daemon's uplink window.
  const link = currentLink(req, record);
  if (!link) return staleLink();
  const nonce = link.nonce;
  const ack = req.headers.get(LINK_ACK_HEADER);
  if (ack === null || !/^\d+$/.test(ack)) return json({ error: "Missing ack" }, 400);
  let messages: UpMessage[];
  try {
    const bytes = await readBodyWithinLimit(req, LINK_LIMITS.uplinkBytes);
    // Decode the whole batch first: a batch cut mid-line applies nothing.
    messages = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split("\n").filter(Boolean).map((line) => decodeUp(line));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return json({ error: "Uplink batch too large" }, 413);
    return json({ error: "Malformed uplink batch" }, 400);
  }
  if (hub().frozen) return stopping();
  // Replaced while the body was arriving.
  if (link.nonce !== nonce) return staleLink();
  sawDaemon(link);
  link.outbox.ack(Number(ack));
  for (const message of messages) applyUp(link, message);
  return json({ ack: link.up.acked });
}

function applyUp(link: Link, message: UpMessage): void {
  if (message.type === "ping") return enqueue(link, encodeLine({ type: "pong" }));
  if (message.type === "pong" || message.type === "hello") return;
  // Already applied before a resend.
  if (!link.up.applied(message.seq)) return;
  switch (message.type) {
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
  const blob = pending.blob;
  if (!blob || blob.byteLength !== message.blob.bytes) {
    return pending.reject(new HostOpError(502, "host_blob_missing", `${label} did not deliver the ${pending.op} result`));
  }
  if (pending.op === "readMedia") return pending.resolve({ ok: true, value: blob });
  try {
    pending.resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(blob)));
  } catch {
    pending.reject(new HostOpError(502, "host_bad_result", `${label} sent an unreadable ${pending.op} result`));
  }
}

/** POST /api/hosts/link/blob/<reqId>: the bytes of one large op result, sent before its `res`. */
export async function handleLinkBlob(req: Request, reqId: string): Promise<Response> {
  const record = authenticate(req);
  if (record instanceof Response) return record;
  if (hub().frozen) return stopping();
  const link = currentLink(req, record);
  if (!link) return staleLink();
  const nonce = link.nonce;
  const pending = link.pending.get(reqId);
  if (!pending) return json({ error: "Unknown request" }, 404);
  // Not 409: the daemon reads a 409 as "link replaced" and retries on the next link.
  if (pending.blob) return json({ error: "Result already uploaded" }, 400);
  let blob: Uint8Array<ArrayBuffer>;
  try {
    blob = await readBodyWithinLimit(req, LINK_LIMITS.blobBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return json({ error: "Result too large" }, 413);
    return json({ error: "Malformed result upload" }, 400);
  }
  if (hub().frozen) return stopping();
  if (link.nonce !== nonce) return staleLink();
  pending.blob = blob;
  return json({ ok: true });
}

function request(hostId: string, op: HostOpName, args: Record<string, unknown>): Promise<unknown> {
  const link = linkFor(hostId);
  const label = labelOf(hostId);
  if (hub().frozen) return Promise.reject(new HostOpError(503, "server_stopping", "omp-web is shutting down"));
  if (!link.nonce || !isLinkUp(link.status)) {
    return Promise.reject(new HostOpError(503, "host_offline", `${label} is offline`));
  }
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const id = randomUUID();
  const timer = setTimeout(() => failOp(link, id, new HostOpError(504, "host_timeout", `${label} did not answer ${op} in time`)), linkTimings.opTimeoutMs);
  // A deadline, like the ping and offline timers: never what keeps the server running.
  timer.unref?.();
  const pending: PendingOp = { op, resolve, reject, timer, seq: 0, blob: null };
  link.pending.set(id, pending);
  try {
    pending.seq = sendDown(link, { type: "req", id, op, args });
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
  }

  write(line: string, callback: (error?: Error | null) => void): void {
    if (this.exitInfo) return callback(new Error("RPC process is not running"));
    try {
      // Kept in the link outbox until the daemon acks it, across reconnects.
      sendDown(linkFor(this.hostId), { type: "stdin", ch: this.ch, line });
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
    sendDown(linkFor(this.hostId), { type: "kill", ch: this.ch, force });
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

/** "local" is this machine; other ids must be registered hosts. */
export function getHost(id: string): Host | null {
  if (id === localHost.id) return localHost;
  return loadHosts().some((h) => h.id === id) ? linkFor(id).host : null;
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
  return loadHosts().map((record) => {
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
  label: string;
  status: "online";
  ompVersion: string | null;
  platform: string;
  lastSeenAt: null;
}

export type HostRow = LocalHostRow | LinkedHostRow;

/** Settings → Hosts payload (`GET /api/hosts` and the `hosts` channel): this machine first, then linked hosts. */
export async function hostsSnapshot(): Promise<{ hosts: HostRow[] }> {
  const local: LocalHostRow = {
    id: "local",
    label: "This machine",
    status: "online",
    ompVersion: await getOmpVersion(),
    platform: process.platform,
    lastSeenAt: null,
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
  endStream(link);
  // Nothing will report these children again.
  for (const transport of link.channels.values()) transport.deliverExit(null, null);
  setStatus(link, "offline");
}
