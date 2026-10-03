import { historyCursor, type SessionHistoryCursor, type SessionLiveSnapshot, type SessionStreamCursor, type SessionSyncResponse } from "@/lib/session-sync";
import type { SessionContext } from "@/lib/types";
import type { AgentEvent } from "./useAgentSession-stream";

type SessionView = { leafId: string | null; includePreCompaction: boolean };

export interface SessionLiveFields {
  message: boolean;
  lifecycle: boolean;
  /** Null rejects tool hydration; otherwise retain these newer per-tool states. */
  tools: ReadonlySet<string> | null;
}

export interface SessionCatchUp {
  request(): Promise<SessionContext | null>;
  seed(context: SessionContext, position?: SessionHistoryCursor | null): SessionContext;
  invalidate(): void;
  view(): SessionView;
  position(): SessionHistoryCursor | null;
  history(): SessionContext | null;
  select(view: SessionView): void;
  disconnect(): void;
  observe(event: AgentEvent): "epoch" | "stale" | null;
}

/** One durable cursor per selected view. Live ordering is independent of disk pagination. */
export function createSessionCatchUp(options: {
  sessionId: () => string | null;
  scope: () => string | null;
  history: (context: SessionContext, leafId: string | null, metadata?: { version: number; hasLive: boolean }) => void;
  live: (snapshot: SessionLiveSnapshot, fields: SessionLiveFields) => void;
  subscribe: (force: boolean) => boolean;
  metadataVersion?: () => number;
}): SessionCatchUp {
  let context: SessionContext | null = null;
  let cursor: SessionHistoryCursor | null = null;
  let view: SessionView = { leafId: null, includePreCompaction: false };
  let revision = 0;
  let stream: SessionStreamCursor | null = null;
  let messageSequence = 0;
  let lifecycleSequence = 0;
  let toolsSnapshotSequence = 0;
  let latestToolSequence = 0;
  const toolSequences = new Map<string, number>();
  const resetStream = () => {
    stream = null;
    messageSequence = lifecycleSequence = toolsSnapshotSequence = latestToolSequence = 0;
    toolSequences.clear();
  };
  let requested = false;
  let pending: Promise<SessionContext | null> | null = null;

  const invalidate = () => {
    revision += 1;
    if (pending) requested = true;
  };
  const seed = (next: SessionContext, position: SessionHistoryCursor | null = cursor) => {
    // A newer completed sync may reflect truncation, not just an append.
    // Keep it and re-read rather than inferring freshness from transcript length.
    if (cursor !== position && context) {
      void request();
      return context;
    }
    invalidate();
    context = next;
    cursor = historyCursor(next);
    options.history(next, view.leafId);
    return next;
  };

  const request = (): Promise<SessionContext | null> => {
    requested = true;
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      let loaded: SessionContext | null = null;
      while (requested) {
        requested = false;
        const sid = options.sessionId();
        const scope = options.scope();
        if (!sid || scope === null) break;
        const version = revision;
        const publishedCursor = cursor;
        const metadataVersion = options.metadataVersion?.() ?? 0;
        // Pages are private until the selected history is complete. A failed
        // replacement must not truncate the visible history or advance its cursor.
        let nextContext = context;
        let nextCursor = cursor;
        try {
          while (true) {
            const base = nextCursor;
            const params = new URLSearchParams({ sync: "1", deferThinking: "1", deferMedia: "1" });
            if (base) params.set("cursor", JSON.stringify(base));
            if (view.leafId) params.set("leafId", view.leafId);
            if (view.includePreCompaction) params.set("includePreCompaction", "1");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30_000);
            let page: SessionSyncResponse;
            try {
              const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, { signal: controller.signal });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              page = await res.json() as SessionSyncResponse;
            } finally {
              clearTimeout(timeout);
            }
            if (options.scope() !== scope || revision !== version || cursor !== publishedCursor || options.sessionId() !== sid) break;
            if (page.sessionId !== sid) break;
            if ((page.mode !== "append" && page.mode !== "replace") || page.context.messages.length !== page.context.entryIds.length) break;
            // This request discovered a wrapper restart that the old SSE never saw.
            if (page.live && stream && page.live.cursor.streamId !== stream.streamId) {
              options.subscribe(true);
              requested = false; // the new connection's open/connected frame starts a fresh read
              break;
            }
            if (page.mode === "append" && page.baseEntryId !== (base?.lastEntryId ?? null)) break;
            const unchanged = page.mode === "append" && page.context.entryIds.length === 0 && nextContext !== null;
            const messages = page.mode === "append" ? unchanged ? nextContext!.messages : [...(nextContext?.messages ?? [])] : [];
            const entryIds = page.mode === "append" ? unchanged ? nextContext!.entryIds : [...(nextContext?.entryIds ?? [])] : [];
            const seen = new Set(unchanged ? [] : entryIds);
            for (let i = 0; i < page.context.entryIds.length; i += 1) {
              const id = page.context.entryIds[i];
              if (!seen.has(id)) {
                seen.add(id);
                entryIds.push(id);
                messages.push(page.context.messages[i]);
              }
            }
            nextContext = { ...page.context, messages, entryIds };
            nextCursor = page.cursor;
            if (page.hasMore) {
              // Malformed/non-advancing pages must not create an unbounded read loop.
              if (base?.firstEntryId === nextCursor.firstEntryId && base?.lastEntryId === nextCursor.lastEntryId) break;
              continue;
            }
            context = nextContext;
            cursor = nextCursor;
            loaded = context;
            options.history(context, page.leafId, { version: metadataVersion, hasLive: page.live !== null });
            if (page.live) {
              if (options.subscribe(false)) {
                requested = false;
                break;
              }
              if (stream) {
                const sequence = page.live.cursor.sequence;
                const busy = page.live.isStreaming || page.live.isPromptRunning || page.live.isCompacting;
                const preserve = sequence >= Math.max(toolsSnapshotSequence, lifecycleSequence) ? new Set<string>() : null;
                const fields: SessionLiveFields = {
                  message: sequence >= Math.max(messageSequence, lifecycleSequence),
                  lifecycle: sequence >= lifecycleSequence && (busy || sequence >= Math.max(messageSequence, latestToolSequence)),
                  tools: preserve,
                };
                if (preserve) {
                  for (const [id, seen] of toolSequences) {
                    if (seen > sequence) preserve.add(id);
                    else toolSequences.delete(id);
                  }
                  toolsSnapshotSequence = sequence;
                  latestToolSequence = Math.max(latestToolSequence, sequence);
                }
                if (fields.message) messageSequence = sequence;
                if (fields.lifecycle) lifecycleSequence = sequence;
                stream = { ...stream, sequence: Math.max(stream.sequence, sequence) };
                if (fields.message || fields.lifecycle || fields.tools) options.live(page.live, fields);
              }
            }
            break;
          }
        } catch {
          // A failed read is not an empty transcript. A later trigger retries
          // from the last complete history, not a partially fetched replacement.
          loaded = null;
        }
      }
      return loaded;
    }).finally(() => {
      pending = null;
      // A trigger can arrive after the loop returned but before this finalizer.
      if (requested) void request();
    });
    return pending;
  };

  return {
    request,
    seed,
    invalidate,
    view: () => view,
    position: () => cursor,
    history: () => context,
    select(next: SessionView) {
      invalidate();
      view = next;
      cursor = null;
    },
    disconnect() {
      invalidate();
      resetStream();
    },
    /** Observe receipt before token coalescing, so queued tokens also fence HTTP. */
    observe(event: AgentEvent): "epoch" | "stale" | null {
      const next = event.web;
      if (!next) return null;
      const changed = stream !== null && next.streamId !== stream.streamId;
      if (changed) {
        invalidate();
        resetStream();
      }
      const lifecycle = /^(agent_start|agent_end|prompt_result|prompt_error|auto_compaction_start|auto_compaction_end)$/.test(event.type);
      const message = /^(message_start|message_update|message_end)$/.test(event.type)
        && (event.message as { role?: unknown } | undefined)?.role !== "user";
      const tool = /^tool_execution_(start|update|end)$/.test(event.type) && typeof event.toolCallId === "string" ? event.toolCallId : null;
      const floor = lifecycle ? Math.max(lifecycleSequence, messageSequence, latestToolSequence)
        : message ? Math.max(lifecycleSequence, messageSequence)
        : tool ? Math.max(lifecycleSequence, toolsSnapshotSequence, toolSequences.get(tool) ?? 0) : 0;
      if (next.sequence < floor) return "stale";
      if (lifecycle) {
        lifecycleSequence = next.sequence;
        toolSequences.clear();
      }
      if (message) messageSequence = next.sequence;
      if (tool) {
        toolSequences.set(tool, next.sequence);
        latestToolSequence = Math.max(latestToolSequence, next.sequence);
      }
      stream = { ...next, sequence: Math.max(stream?.sequence ?? 0, next.sequence) };
      return changed ? "epoch" : null;
    },
  };
}
