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

/** A failed `POST /api/agent/[id]` carrying the route's stable code. Callers
 * that must react differently from a plain error (a `session_slow` ack timeout
 * with `maybeStarted` is not a rolled-back prompt; `abortUnconfirmed` is not a
 * completed stop) branch on these fields. */
export class AgentCommandError extends Error {
  readonly code: string | undefined;
  readonly maybeStarted: boolean;
  /** The abort frame may have reached omp, but nothing confirmed it: the run
   * may still be executing. */
  readonly abortUnconfirmed: boolean;

  constructor(
    message: string,
    code: string | undefined,
    maybeStarted: boolean,
    abortUnconfirmed: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
    this.code = code;
    this.maybeStarted = maybeStarted;
    this.abortUnconfirmed = abortUnconfirmed;
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
  const params = new URLSearchParams();
  if (advisorSpawnSessions.has(sessionId)) params.set("advisor", "1");
  const query = params.size > 0 ? `?${params.toString()}` : "";
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
    maybeStarted?: boolean;
    abortUnconfirmed?: boolean;
  };
  if (!res.ok || body.error) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    throw new AgentCommandError(
      body.error || body.code ? formatApiError(body) : `HTTP ${res.status}`,
      body.code,
      body.maybeStarted === true,
      body.abortUnconfirmed === true,
    );
  }
  return body.data as T;
}
