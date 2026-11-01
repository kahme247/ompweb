// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

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

export function setSessionAdvisorSpawn(sessionId: string, enabled: boolean) {
  if (enabled) advisorSpawnSessions.add(sessionId);
  else advisorSpawnSessions.delete(sessionId);
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const query = advisorSpawnSessions.has(sessionId) ? "?advisor=1" : "";
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    hostOffline?: boolean;
    delivery?: string;
  };
  if (!res.ok || body.error) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    const message = body.error || body.code ? formatApiError(body) : `HTTP ${res.status}`;
    throw res.status === 503 && body.hostOffline ? new HostOfflineError(message, body.delivery === "unknown") : new Error(message);
  }
  return body.data as T;
}
