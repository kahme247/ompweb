// Client-side helper for agent commands: POST /api/agent/[id], or the session's
// WebSocket when the browser transport is "websocket" (lib/event-stream.ts).
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { sendSessionCommand, type CommandReply } from "@/lib/event-stream";
import { formatApiError } from "@/lib/i18n/api-error";

// Sessions whose per-chat advisor toggle is on: their lazily spawned omp
// process must start with --advisor. Keyed by session id because the spawn
// decision happens inside the route, which only sees id + query string.
const advisorSpawnSessions = new Set<string>();

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
  const reply = (await sendSessionCommand(sessionId, req, json, advisor)) ?? (await postAgentCommand(sessionId, json, advisor));
  const body = reply.body as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    hostOffline?: boolean;
    delivery?: string;
  };
  if (reply.status < 200 || reply.status >= 300 || body.error) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    const message = body.error || body.code ? formatApiError(body) : `HTTP ${reply.status}`;
    if (reply.status === 503 && body.hostOffline) throw new HostOfflineError(message, body.delivery === "unknown");
    if (reply.status === 503 && body.code === "transport_lost") throw new TransportLostError(message);
    throw new Error(message);
  }
  return body.data as T;
}

async function postAgentCommand(sessionId: string, body: string, advisor: boolean): Promise<CommandReply> {
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
    behindBytes: 0,
  };
}
