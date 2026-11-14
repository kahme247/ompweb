// Main-server end of the maintenance API (maintenance-protocol.ts): accepts `ompweb host` daemons on
// /api/hosts/maintenance and carries the server's requests to them. Independent of the application link (hub.ts): its own
// sockets, lifecycle and version, so a host whose application protocol differs stays reachable for upgrades.
// Everything a daemon sends is untrusted input. No `next/*` or `@/` imports.
import { randomUUID } from "node:crypto";
import { hostFromBearer } from "./host-bearer";
import {
  decodeFrame,
  encodeFrame,
  failure,
  MAINTENANCE_API_VERSION,
  MAINTENANCE_CLOSE,
  MAINTENANCE_LIMITS,
  MAINTENANCE_OPS,
  MaintenanceError,
  maintenanceTimings,
  parseHello,
  PING,
  WELCOME,
  type MaintenanceHello,
  type MaintenanceOp,
} from "./maintenance-protocol";
import { readHosts } from "./registry";

export { MaintenanceError };

/** What the hub keeps on each maintenance socket (Bun's `ws.data`): the host its token named, and whether its hello came. */
export interface MaintenanceSocketData {
  kind: "maintenance";
  hostId: string;
  hello?: boolean;
}

/** The server's software, as discovery reports it for the host to inspect. */
export interface MaintenanceServerInfo {
  protocolVersion: number;
  ompwebVersion: string;
}

/** The part of Bun's ServerWebSocket the hub uses, so tests drive it with a plain object. */
export interface MaintenanceSocket {
  readonly data: MaintenanceSocketData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** A host with a welcomed socket; there is no link before its hello. */
interface Link {
  id: string;
  socket: MaintenanceSocket;
  hello: MaintenanceHello;
  pending: Map<string, Pending>;
  /** performance.now() of the host's latest frame. */
  seen: number;
  heartbeat: NodeJS.Timeout;
}

interface HubState {
  links: Map<string, Link>;
  listeners: Set<() => void>;
  frozen: boolean;
}

declare global {
  var __ompMaintenanceHub: HubState | undefined;
}

// globalThis, like the application hub: survives a `bun --hot` re-evaluation.
function hub(): HubState {
  return (globalThis.__ompMaintenanceHub ??= { links: new Map(), listeners: new Set(), frozen: false });
}

const refuse = (error: string, status: number) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/**
 * GET /api/hosts/maintenance. The host's bearer token is checked first, so nothing unauthenticated gets an answer or a
 * socket. A plain GET is discovery: 200 `{apiVersion, capabilities}` plus the caller's `server` fields (this module cannot
 * know the application's versions), which a daemon needs before it dials, so a server without this API (or an old one
 * that accepts any WebSocket URL) never sees a maintenance hello. An upgrade request gets the WebSocket (undefined once
 * upgraded); its hello comes as the socket's first frame (maintenanceSocket).
 */
export function handleMaintenanceUpgrade(request: Request, upgrade: (data: MaintenanceSocketData) => boolean, server?: MaintenanceServerInfo): Response | undefined {
  const host = hostFromBearer(request);
  if (host instanceof Response) return host;
  // The daemon retries a 503: it lands on the next server instead.
  if (hub().frozen) return refuse("omp-web is shutting down", 503);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ ...server, apiVersion: MAINTENANCE_API_VERSION, capabilities: [...MAINTENANCE_OPS] }, { headers: { "cache-control": "no-store" } });
  }
  return upgrade({ kind: "maintenance", hostId: host.id }) ? undefined : refuse("The maintenance link is a WebSocket", 426);
}

/** Bun's `websocket` handlers for maintenance links (server/app.ts); `open` arms the hello deadline. */
export const maintenanceSocket = {
  open(ws: MaintenanceSocket): void {
    // An authenticated socket that never says hello must not hang forever.
    const timer = setTimeout(() => {
      if (!ws.data.hello) ws.close(MAINTENANCE_CLOSE.policy, "No hello");
    }, maintenanceTimings.helloMs);
    timer.unref?.();
  },
  message(ws: MaintenanceSocket, data: string | Uint8Array): void {
    guarded(ws, () => {
      // Nothing is applied once this server stops.
      if (hub().frozen) return;
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket === ws) return onFrame(link, data);
      // A socket a newer one replaced, or one that was dropped: what it still sends belongs to no link.
      if (ws.data.hello) return;
      onHello(ws, data);
    });
  },
  close(ws: MaintenanceSocket): void {
    guarded(ws, () => {
      const link = hub().links.get(ws.data.hostId);
      if (link?.socket === ws) endLink(link);
    });
  },
};

/** A throw in a websocket handler would reach uncaughtException, which exits the server: it closes that socket instead. */
function guarded(ws: MaintenanceSocket, handle: () => void): void {
  try {
    handle();
  } catch (error) {
    console.error(`[omp-web] maintenance link of ${ws.data.hostId} failed; closing it: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    ws.close();
  }
}

const tooBig = (error: unknown) => (error instanceof MaintenanceError && error.status === 413 ? MAINTENANCE_CLOSE.tooBig : MAINTENANCE_CLOSE.policy);

/** A socket's first frame must be its hello. */
function onHello(ws: MaintenanceSocket, data: string | Uint8Array): void {
  let frame: Record<string, unknown>;
  try {
    frame = decodeFrame(data);
  } catch (error) {
    return ws.close(tooBig(error), error instanceof Error ? error.message : "Bad frame");
  }
  if (frame.type !== "hello") return ws.close(MAINTENANCE_CLOSE.policy, "The first frame must be a hello");
  // Compared before the rest is read: another API version may shape its hello differently.
  if (frame.apiVersion !== MAINTENANCE_API_VERSION) return ws.close(MAINTENANCE_CLOSE.apiMismatch, JSON.stringify({ apiVersion: MAINTENANCE_API_VERSION }));
  const hello = parseHello(frame);
  if (!hello) return ws.close(MAINTENANCE_CLOSE.policy, "Invalid hello");
  // Revoked or deleted since the upgrade, or the registry cannot say.
  let known: boolean;
  try {
    known = readHosts().some((host) => host.id === ws.data.hostId);
  } catch {
    return ws.close(MAINTENANCE_CLOSE.tryLater, "The host registry cannot be read");
  }
  if (!known) return ws.close(MAINTENANCE_CLOSE.policy, "Unknown host");
  ws.data.hello = true;
  const { links } = hub();
  const link: Link = {
    id: ws.data.hostId,
    socket: ws,
    hello,
    pending: new Map(),
    seen: performance.now(),
    heartbeat: setInterval(() => beat(link), maintenanceTimings.pingMs),
  };
  link.heartbeat.unref?.();
  // One link per host: the newest wins; only the old socket closes.
  const previous = links.get(link.id);
  if (previous) {
    previous.socket.close(MAINTENANCE_CLOSE.replaced, "replaced by a newer maintenance link");
    retire(previous);
  }
  links.set(link.id, link);
  ws.send(WELCOME);
  changed();
}

function onFrame(link: Link, data: string | Uint8Array): void {
  let frame: Record<string, unknown>;
  try {
    frame = decodeFrame(data);
  } catch (error) {
    return closeLink(link, tooBig(error), error instanceof Error ? error.message : "Bad frame");
  }
  link.seen = performance.now();
  // A pong only proves liveness; types a later revision of API 1 adds are ignored.
  if (frame.type !== "res" || typeof frame.id !== "string") return;
  const pending = link.pending.get(frame.id);
  // An answer to a request that already timed out.
  if (!pending) return;
  link.pending.delete(frame.id);
  clearTimeout(pending.timer);
  if (frame.ok === true) pending.resolve(frame.result ?? null);
  else {
    const { status, code, message } = failure(frame);
    pending.reject(new MaintenanceError(status, code, message));
  }
}

/** Heartbeat: a ping, or the socket dropped once the host has been silent too long (a laptop that slept, a NAT that forgot it). */
function beat(link: Link): void {
  if (performance.now() - link.seen > maintenanceTimings.offlineMs) {
    link.socket.terminate();
    endLink(link);
  } else link.socket.send(PING);
}

/** Forget a link. Requests it still carried may or may not have run on the host: they fail, and none is ever repeated. */
function retire(link: Link): void {
  clearInterval(link.heartbeat);
  const { links } = hub();
  if (links.get(link.id) === link) links.delete(link.id);
  for (const pending of link.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new MaintenanceError(502, "delivery_unknown", "The maintenance link closed before the host answered; the request may have been applied and is not repeated"));
  }
  link.pending.clear();
}

function endLink(link: Link): void {
  retire(link);
  changed();
}

function closeLink(link: Link, code: number, reason: string): void {
  link.socket.close(code, reason);
  endLink(link);
}

function changed(): void {
  for (const listener of hub().listeners) {
    try {
      listener();
    } catch (error) {
      console.error(`[omp-web] maintenance listener failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }
}

/** The host's hello while its maintenance link is up, else null. */
export function getMaintenanceHost(id: string): MaintenanceHello | null {
  return hub().links.get(id)?.hello ?? null;
}

/**
 * One request, answered by the host's result or a MaintenanceError. Never repeated: after a timeout or a lost link
 * (504 `timeout`, 502 `delivery_unknown`) the host may or may not have run it. Other failures: 503 `frozen` / `no_link`,
 * 501 `unsupported_op` (the host did not advertise it), 413 `too_large`, 429 `busy`, and whatever the host reports.
 */
export async function requestMaintenance(id: string, op: MaintenanceOp, args: Record<string, unknown>, timeoutMs: number = maintenanceTimings.requestMs): Promise<unknown> {
  if (hub().frozen) throw new MaintenanceError(503, "frozen", "omp-web is shutting down");
  const link = hub().links.get(id);
  if (!link) throw new MaintenanceError(503, "no_link", "The host has no maintenance link");
  if (!link.hello.capabilities.includes(op)) throw new MaintenanceError(501, "unsupported_op", `The host does not support ${op}`);
  if (link.pending.size >= MAINTENANCE_LIMITS.inFlight) throw new MaintenanceError(429, "busy", "Too many maintenance requests are in flight to this host");
  const requestId = randomUUID();
  const line = encodeFrame({ type: "req", id: requestId, op, args });
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const timer = setTimeout(() => {
    link.pending.delete(requestId);
    reject(new MaintenanceError(504, "timeout", `The host did not answer ${op} in time; it may still be running and is not repeated`));
  }, timeoutMs);
  link.pending.set(requestId, { resolve, reject, timer });
  // 0: Bun dropped it, so it never left.
  if (link.socket.send(line) === 0) {
    clearTimeout(timer);
    link.pending.delete(requestId);
    reject(new MaintenanceError(503, "no_link", "The maintenance link dropped the request; it was not sent"));
  }
  return promise;
}

/** Runs on every change to which hosts have a link (a hello, a closed or replaced socket). */
export function onMaintenanceChange(listener: () => void): () => void {
  const { listeners } = hub();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Close a host's maintenance link (a revoked or deleted host); its daemon redials and its token check decides. */
export function closeMaintenanceHost(id: string): void {
  const link = hub().links.get(id);
  if (link) closeLink(link, MAINTENANCE_CLOSE.policy, "The host's maintenance link was closed by omp-web");
}

/** This server is shutting down: from here on no request or upgrade is accepted and every link closes 1001, so its
 * daemon redials the next server. Host children are untouched. */
export function freezeMaintenance(): void {
  hub().frozen = true;
  for (const link of [...hub().links.values()]) closeLink(link, MAINTENANCE_CLOSE.goingAway, "omp-web is restarting");
}
