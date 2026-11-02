import type { AgentMessage, SessionContext } from "./types";

/** Durable display-history position, scoped to one session and selected view. */
export interface SessionHistoryCursor {
  firstEntryId: string | null;
  lastEntryId: string | null;
}

/** Ordering within one web-owned RPC process; resets when that process changes. */
export interface SessionStreamCursor {
  streamId: string;
  sequence: number;
}

export interface SessionLiveToolEvent {
  type: "tool_execution_start" | "tool_execution_update";
  toolCallId: string;
  [key: string]: unknown;
}

export interface SessionLiveSnapshot {
  cursor: SessionStreamCursor;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isCompacting: boolean;
  streamingMessage: Partial<AgentMessage> | null;
  /** omp's messageId of `streamingMessage`: the message its delta updates apply to. */
  streamingMessageId?: string | null;
  toolEvents: SessionLiveToolEvent[];
  /** Positive run-scoped evidence survives message_end's delayed file write. */
  responseObserved?: boolean;
}

export interface SessionHistoryPage {
  mode: "append" | "replace";
  baseEntryId: string | null;
  context: SessionContext;
  cursor: SessionHistoryCursor;
  hasMore: boolean;
}

export interface SessionHistoryRange extends Omit<SessionHistoryPage, "context"> {
  start: number;
  end: number;
}

export interface SessionSyncResponse extends SessionHistoryPage {
  sessionId: string;
  leafId: string | null;
  /** Null for a file-only session or a view pinned to a historical branch. */
  live: SessionLiveSnapshot | null;
}

export const MAX_SYNC_MESSAGES = 200;

export function historyCursor(context: Pick<SessionContext, "entryIds">): SessionHistoryCursor {
  return {
    firstEntryId: context.entryIds[0] ?? null,
    lastEntryId: context.entryIds.at(-1) ?? null,
  };
}

/** Decode only bounded IDs; a cursor never authorizes a session or a file path. */
export function parseHistoryCursor(raw: string | null): SessionHistoryCursor | null {
  if (raw === null) return null;
  if (raw.length > 2048) throw new Error("Invalid history cursor");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history cursor");
  const cursor = value as Record<string, unknown>;
  const validId = (id: unknown): id is string | null => id === null || (typeof id === "string" && id.length > 0 && id.length <= 256);
  if (!validId(cursor.firstEntryId) || !validId(cursor.lastEntryId)
    || (cursor.firstEntryId === null) !== (cursor.lastEntryId === null)) {
    throw new Error("Invalid history cursor");
  }
  return { firstEntryId: cursor.firstEntryId, lastEntryId: cursor.lastEntryId };
}

/** Page the selected display path; an invalidated branch/compaction cursor resets it. */
export function selectSessionHistory(
  context: SessionContext,
  cursor: SessionHistoryCursor | null,
  limit = MAX_SYNC_MESSAGES,
): SessionHistoryPage {
  const { start, end, ...page } = selectHistoryRange(context.entryIds, cursor, limit);
  return {
    ...page,
    context: { ...context, messages: context.messages.slice(start, end), entryIds: context.entryIds.slice(start, end) },
  };
}

/** Indexed readers can locate a cursor without scanning the delivered prefix again. */
export function selectHistoryRange(
  entryIds: readonly string[],
  cursor: SessionHistoryCursor | null,
  limit = MAX_SYNC_MESSAGES,
  positions?: ReadonlyMap<string, number>,
): SessionHistoryRange {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SYNC_MESSAGES) throw new RangeError("Invalid history page limit");
  const firstEntryId = entryIds[0] ?? null;
  const cursorIndex = cursor?.lastEntryId
    ? positions ? positions.get(cursor.lastEntryId) ?? -1 : entryIds.indexOf(cursor.lastEntryId)
    : -1;
  const append = cursor !== null && cursor.firstEntryId === firstEntryId
    && ((cursorIndex >= 0 && entryIds[cursorIndex] === cursor.lastEntryId) || (cursor.lastEntryId === null && entryIds.length === 0));
  const start = append ? cursorIndex + 1 : 0;
  const end = Math.min(start + limit, entryIds.length);
  return {
    mode: append ? "append" : "replace",
    baseEntryId: append ? cursor.lastEntryId : null,
    start,
    end,
    cursor: { firstEntryId, lastEntryId: entryIds[end - 1] ?? null },
    hasMore: end < entryIds.length,
  };
}
