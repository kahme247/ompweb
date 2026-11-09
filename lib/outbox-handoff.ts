import { isClientMessageId, readQueueSnapshot } from "./client-message-ids";
import { isLinkUp } from "./hosts/host";
import { adoptedChild, hostListsChild, listHosts } from "./hosts/hub";
import { HostOpError } from "./hosts/link-protocol";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { hostForSessionId } from "./hosts/session-index";
import { outboxCanonicalSessions } from "./message-outbox";
import type { ClientMessageStatus } from "./pi-types";
import { getRpcSession, WebRpcError } from "./rpc-manager";
import { isRecord } from "./type-guards";
import type { AgentMessage } from "./types";

const MAX_HANDOFF_BYTES = 16 * 1024 * 1024;
const invalidNativeStatus = () => new HostOpError(502, "invalid_client_message_status", "OMP returned invalid client-message status");

/** Native evidence is selective and identity-bearing; malformed data never becomes a guessed acceptance. */
function nativeStatus(value: unknown, ids: readonly string[]): ClientMessageStatus {
  if (!isRecord(value) || !Array.isArray(value.messages) || value.messages.length > ids.length) throw invalidNativeStatus();
  const queuedMessages = readQueueSnapshot(value.queuedMessages);
  if (!queuedMessages) throw invalidNativeStatus();
  for (const field of ["resolvedClientMessageIds", "persistedClientMessageIds", "unresolvedClientMessageIds"]) {
    const values = value[field];
    if (!Array.isArray(values) || values.length > ids.length || !values.every((id) => isClientMessageId(id) && ids.includes(id))) throw invalidNativeStatus();
  }
  const messages: ClientMessageStatus["messages"] = [];
  const seen = new Set<string>();
  for (const item of value.messages) {
    if (!isRecord(item) || !isClientMessageId(item.clientMessageId) || !ids.includes(item.clientMessageId)
      || seen.has(item.clientMessageId) || !isRecord(item.message)) throw invalidNativeStatus();
    const message = item.message;
    if ((message.role !== "user" && message.role !== "custom")
      || !(typeof message.content === "string" || Array.isArray(message.content))) throw invalidNativeStatus();
    if (Array.isArray(message.content) && !message.content.every((block) => isRecord(block) && typeof block.type === "string")) throw invalidNativeStatus();
    if (message.role === "custom" && (typeof message.customType !== "string" || typeof message.display !== "boolean")) throw invalidNativeStatus();
    seen.add(item.clientMessageId);
    messages.push({ clientMessageId: item.clientMessageId, message: message as unknown as AgentMessage });
  }
  return {
    messages, queuedMessages,
    resolvedClientMessageIds: value.resolvedClientMessageIds as string[],
    persistedClientMessageIds: value.persistedClientMessageIds as string[],
    unresolvedClientMessageIds: value.unresolvedClientMessageIds as string[],
  };
}

/** The live child answering for `sessionId`; 409 only once its absence is established. A child another server started
 * is adopted here only after its daemon lists it, and an offline or unlisted host proves nothing: those are a retryable 503. */
async function liveChild(sessionId: string) {
  let live = getRpcSession(sessionId);
  if (!live) {
    await Promise.all([LOCAL_HOST_ID, ...listHosts().map(({ id }) => id)].map((id) => adoptedChild(id, sessionId)));
    live = getRpcSession(sessionId);
  }
  if (live?.isAlive()) return live;
  if (live) {
    // A wrapper disposed during a link drop proves nothing about the child: it may still run on the offline host.
    if (!isLinkUp(live.host.status())) throw new WebRpcError(`${live.host.label} is offline`, "host_offline", "refused");
    // Disposing is not exited: the child may still be flushing its history, and the registry drops the wrapper only once it has exited.
    if (live.destroyPromise) throw new HostOpError(503, "handoff_child_pending", "The session's native process is shutting down");
  } else {
    // A child a host still runs is not gone just because this server failed to adopt it: retry.
    if (hostListsChild(sessionId)) throw new HostOpError(503, "handoff_child_pending", "The session's native process is running but not attached here yet");
    // Throws a 503 while a host that may hold the session is offline or its list unavailable.
    const host = await hostForSessionId(sessionId);
    if (host && !isLinkUp(host.status())) throw new WebRpcError(`${host.label} is offline`, "host_offline", "refused");
  }
  throw new HostOpError(409, "handoff_child_unavailable", "No running native session can answer for these messages");
}

/** The child answering for `sessionId` or, after a native identity move, for the session that owns these entries now.
 * A candidate that cannot prove absence keeps the answer retryable: 409 only once every candidate is known gone. */
async function liveChildFor(sessionId: string, ids: readonly string[]) {
  let failure: unknown;
  try {
    return await liveChild(sessionId);
  } catch (error) {
    failure = error;
  }
  for (const owner of outboxCanonicalSessions(ids)) {
    if (owner === sessionId) continue;
    try {
      return await liveChild(owner);
    } catch (error) {
      if (failure instanceof HostOpError && failure.status === 409) failure = error;
    }
  }
  throw failure;
}

/** Ask the live native child about intents the browser still holds; this never starts or replaces omp. Absence of a
 * child answers 409 and the browser reads its own history instead; uncertainty answers a retryable 503. */
export async function reconcileOutboxHandoffs(sessionId: string, ids: readonly string[]): Promise<ClientMessageStatus> {
  const live = await liveChildFor(sessionId, ids);
  const nativeSessionId = live.sessionId;
  const raw = await live.send({ type: "get_client_message_status", clientMessageIds: ids });
  if (!live.isAlive() || live.sessionId !== nativeSessionId) {
    throw new HostOpError(409, "handoff_context_changed", "The native conversation changed during handoff reconciliation");
  }
  const status = nativeStatus(raw, ids);
  // Queue and message bodies share one response budget; whatever is left out is in no list, so the browser asks again.
  let budget = MAX_HANDOFF_BYTES;
  const queueBytes = Buffer.byteLength(JSON.stringify(status.queuedMessages));
  const queuedMessages = queueBytes <= budget ? status.queuedMessages : null;
  if (queuedMessages) budget -= queueBytes;
  const messages = status.messages.filter((item) => {
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (bytes > budget) return false;
    budget -= bytes;
    return true;
  });
  return {
    messages, queuedMessages,
    resolvedClientMessageIds: ids.filter((id) => status.resolvedClientMessageIds.includes(id)),
    persistedClientMessageIds: ids.filter((id) => status.persistedClientMessageIds.includes(id)),
    unresolvedClientMessageIds: ids.filter((id) => status.unresolvedClientMessageIds.includes(id)),
  };
}
