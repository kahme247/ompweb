// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { formatApiError } from "@/lib/i18n/api-error";
const remoteOperationIds = new Map<string, string>();

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const remote = sessionId.startsWith("w:");
  const operationKey = remote ? `${sessionId}:${JSON.stringify(command)}` : "";
  const operationId = remote ? (remoteOperationIds.get(operationKey) ?? crypto.randomUUID()) : undefined;
  if (remote && operationId) remoteOperationIds.set(operationKey, operationId);
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(remote ? { ...command, operationId } : command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
  };
  if (!res.ok || body.error) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    throw new Error(
      body.error || body.code ? formatApiError(body) : `HTTP ${res.status}`,
    );
  }
  if (remote) remoteOperationIds.delete(operationKey);
  return body.data as T;
}
