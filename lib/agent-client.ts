// Client-side helper for agent commands: POST /api/agent/[id], or the worker's
// socket for the session in a `ws-*` browser transport (lib/event-stream.ts).
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { recordTransportSample, sendSessionCommand, type CommandReply } from "@/lib/event-stream";
import { formatApiError } from "@/lib/i18n/api-error";

// Sessions whose per-chat advisor toggle is on: their lazily spawned omp
// process must start with --advisor. Keyed by session id because the spawn
// decision happens inside the route, which only sees id + query string.
const advisorSpawnSessions = new Set<string>();

// The worker's ack timeout (public/event-stream-worker.js): 10 s plus 1 ms per 32 bytes to upload first.
const ACK_TIMEOUT_MS = 10_000;

/**
 * This tab's unanswered POSTs, for a later one's isolation bytes (spec D6 "Uplink"). fetch reports no upload progress
 * and the server's receive time arrives only with the response, so a POST counts until answered, even once its body is
 * in; the summary's LARGE_FRAME_BYTES floor keeps a small command the server is still running from reading as blocking.
 */
const inFlightPosts = new Set<{ sessionId: string; bytes: number }>();

/** 503 `{hostOffline: true}`: the session's host has no link right now. With
 *  `delivery: "refused"` the request never left, so the caller keeps what the
 *  user typed; with `"unknown"` the link dropped after it was sent, so it may
 *  still run once the host reconnects (`mayHaveRun`). */
export class HostOfflineError extends Error {
  readonly mayHaveRun: boolean;

  constructor(message: string, mayHaveRun = false) {
    super(message);
    this.mayHaveRun = mayHaveRun;
  }
}

/** 503 `transport_lost`: the session socket dropped after the command left and
 *  before its answer (lib/event-stream.ts), so it may have run; the caller must
 *  not offer it again. */
export class TransportLostError extends Error {
  readonly mayHaveRun = true;
}

export function setSessionAdvisorSpawn(sessionId: string, enabled: boolean) {
  if (enabled) advisorSpawnSessions.add(sessionId);
  else advisorSpawnSessions.delete(sessionId);
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const advisor = advisorSpawnSessions.has(sessionId);
  // The session socket's dedupe key; no crypto.randomUUID (insecure LAN origins lack it).
  const req = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const json = JSON.stringify(command);
  // Every command's `action` sample (spec D6); the worker adds the tags and its clock.
  const type = typeof command.type === "string" ? command.type : "";
  const sample = { metric: "action", req, type, session: sessionId, bytes: json.length, sentAt: Date.now() };
  let reply: CommandReply;
  try {
    reply = (await sendSessionCommand(sessionId, req, json, advisor, type)) ?? (await postAgentCommand(sessionId, json, advisor, req, type));
  } catch (error) {
    // The POST got no answer at all (offline, connection reset).
    recordTransportSample({ ...sample, via: "http", socket: "http", status: 0, outcome: "error", gotAt: Date.now() });
    throw error;
  }
  const body = reply.body as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    hostOffline?: boolean;
    delivery?: string;
  };
  const failed = reply.status < 200 || reply.status >= 300 || Boolean(body.error);
  let outcome = failed ? "error" : "ok";
  if (reply.status === 503 && body.code === "transport_lost") outcome = "lost";
  else if (reply.status === 503 && body.code === "transport_unavailable") outcome = "unavailable";
  recordTransportSample({
    ...sample,
    via: reply.via,
    socket: reply.socket,
    status: reply.status,
    outcome,
    attempts: reply.attempts,
    deduped: reply.deduped,
    behindBytes: reply.behindBytes,
    behindSameBytes: reply.behindSameBytes,
    behindOtherBytes: reply.behindOtherBytes,
    replyBehindOtherBytes: reply.replyBehindOtherBytes,
    recvAt: reply.recvAt,
    repliedAt: reply.repliedAt,
    gotAt: Date.now(),
  });
  if (failed) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    const message = body.error || body.code ? formatApiError(body) : `HTTP ${reply.status}`;
    if (reply.status === 503 && body.hostOffline) throw new HostOfflineError(message, body.delivery === "unknown");
    if (reply.status === 503 && body.code === "transport_lost") throw new TransportLostError(message);
    throw new Error(message);
  }
  return body.data as T;
}

async function postAgentCommand(sessionId: string, body: string, advisor: boolean, req: string, type: string): Promise<CommandReply> {
  let behindSameBytes = 0;
  let behindOtherBytes = 0;
  for (const other of inFlightPosts) {
    if (other.sessionId === sessionId) behindSameBytes += other.bytes;
    else behindOtherBytes += other.bytes;
  }
  const mine = { sessionId, bytes: body.length };
  inFlightPosts.add(mine);
  // The worker's ack formula over all this tab has in flight (HTTP/2 shares one connection); it records, never aborts.
  const waitedMs = ACK_TIMEOUT_MS + Math.ceil((behindSameBytes + behindOtherBytes + body.length) / 32);
  const hang = setTimeout(() => recordTransportSample({ metric: "hang", socket: "http", req, type, via: "http", bytes: body.length, waitedMs }), waitedMs);
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}${advisor ? "?advisor=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // The route's receive/reply times; test fetch fakes carry no headers.
    const time = (name: string) => {
      const value = res.headers?.get?.(name);
      return value ? Number(value) : null;
    };
    return {
      status: res.status,
      body: await res.json().catch(() => ({})),
      via: "http",
      recvAt: time("x-omp-received-at"),
      repliedAt: time("x-omp-replied-at"),
      attempts: 1,
      deduped: false,
      socket: "http",
      behindBytes: behindSameBytes,
      behindSameBytes,
      behindOtherBytes,
      replyBehindOtherBytes: null,
    };
  } finally {
    clearTimeout(hang);
    inFlightPosts.delete(mine);
  }
}
