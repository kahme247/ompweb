import { isClientMessageId, readQueueSnapshot } from "./client-message-ids";
import { isLinkUp } from "./hosts/host";
import { adoptedChild, listHosts } from "./hosts/hub";
import { HostOpError } from "./hosts/link-protocol";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { hostForSessionId } from "./hosts/session-index";
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
  if (!live) {
    // Throws a 503 while a host that may hold the session is offline or its list unavailable.
    const host = await hostForSessionId(sessionId);
    if (host && !isLinkUp(host.status())) throw new WebRpcError(`${host.label} is offline`, "host_offline", "refused");
  }
  throw new HostOpError(409, "handoff_child_unavailable", "No running native session can answer for these messages");
}

/** Ask the live native child about intents the browser still holds; this never starts or replaces omp. Absence of a
 * child answers 409 and the browser reads its own history instead; uncertainty answers a retryable 503. */
export async function reconcileOutboxHandoffs(sessionId: string, ids: readonly string[]): Promise<ClientMessageStatus> {
  const live = await liveChild(sessionId);
  const nativeSessionId = live.sessionId;
  const raw = await live.send({ type: "get_client_message_status", clientMessageIds: ids });
  if (!live.isAlive() || live.sessionId !== nativeSessionId) {
    throw new HostOpError(409, "handoff_context_changed", "The native conversation changed during handoff reconciliation");
  }
  const status = nativeStatus(raw, ids);
  // Queue and message bodies share one response budget; a message left out stays unresolved for the history read.
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
  const answered = new Set([
    ...messages.map((item) => item.clientMessageId), ...status.resolvedClientMessageIds, ...status.persistedClientMessageIds,
    ...(queuedMessages?.clientMessageIds ? [...queuedMessages.clientMessageIds.steering, ...queuedMessages.clientMessageIds.followUp] : []),
  ]);
  return {
    messages, queuedMessages,
    resolvedClientMessageIds: ids.filter((id) => status.resolvedClientMessageIds.includes(id)),
    persistedClientMessageIds: ids.filter((id) => status.persistedClientMessageIds.includes(id)),
    unresolvedClientMessageIds: ids.filter((id) => !answered.has(id)),
  };
}
