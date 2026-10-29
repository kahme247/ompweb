// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { formatApiError } from "@/lib/i18n/api-error";
import type { SessionElsewhere } from "@/lib/types";

// Sessions whose per-chat advisor toggle is on: their lazily spawned omp
// process must start with --advisor. Keyed by session id because the spawn
// decision happens inside the route, which only sees id + query string.
const advisorSpawnSessions = new Set<string>();

/** A failed `POST /api/agent/[id]` carrying the route's stable code. Callers
 * that must react differently from a plain error (a `session_slow` ack timeout
 * with `maybeStarted` is not a rolled-back prompt; `abortUnconfirmed` is not a
 * completed stop; `session_running_elsewhere` means another omp holds the
 * session and the user must decide) branch on these fields. */
export class AgentCommandError extends Error {
  readonly code: string | undefined;
  readonly maybeStarted: boolean;
  /** The abort frame may have reached omp, but nothing confirmed it: the run
   * may still be executing. */
  readonly abortUnconfirmed: boolean;
  /** For `session_running_elsewhere`: who holds the session. */
  readonly elsewhere: SessionElsewhere | null;

  constructor(
    message: string,
    code: string | undefined,
    maybeStarted: boolean,
    abortUnconfirmed: boolean,
    elsewhere: SessionElsewhere | null = null,
  ) {
    super(message);
    this.name = "AgentCommandError";
    this.code = code;
    this.maybeStarted = maybeStarted;
    this.abortUnconfirmed = abortUnconfirmed;
    this.elsewhere = elsewhere;
  }
}

export function setSessionAdvisorSpawn(sessionId: string, enabled: boolean) {
  if (enabled) advisorSpawnSessions.add(sessionId);
  else advisorSpawnSessions.delete(sessionId);
}

export interface SendAgentCommandOptions {
  /** Send into a copy even though another omp process owns the session. Only
   *  from an explicit user confirmation — never cached, never auto-retried. */
  force?: boolean;
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
  options: SendAgentCommandOptions = {},
): Promise<T> {
  const params = new URLSearchParams();
  if (advisorSpawnSessions.has(sessionId)) params.set("advisor", "1");
  if (options.force) params.set("force", "1");
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
    elsewhere?: SessionElsewhere | null;
  };
  if (!res.ok || body.error) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    throw new AgentCommandError(
      body.error || body.code ? formatApiError(body) : `HTTP ${res.status}`,
      body.code,
      body.maybeStarted === true,
      body.abortUnconfirmed === true,
      body.elsewhere ?? null,
    );
  }
  return body.data as T;
}
