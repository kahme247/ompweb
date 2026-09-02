"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { useI18n } from "@/lib/i18n";
import { formatCost, formatDuration, formatTokens } from "@/lib/subagent-format";
import { MarkdownBody } from "./MarkdownBody";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "./ui/primitives";
import type { SubagentInfo } from "@/hooks/useAgentSession";
import type { SubagentActivityEvent, SubagentSnapshotLike } from "@/lib/subagent-types";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";

interface SubagentMessagesPage {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset?: boolean;
  messages: AgentMessage[];
  totalBytes?: number;
}

/** Compact, defensive row for one raw transcript message (content may be a
 * string, a block array, or absent — legacy pi / omp RPC shapes). */
function SubagentTranscriptRow({ message }: { message: AgentMessage }) {
  const label = message.role === "user" ? "U" : message.role === "assistant" ? "A" : "R";
  const labelColor = message.role === "user" ? "var(--accent)" : message.role === "assistant" ? "var(--text-muted)" : "var(--text-dim)";
  const rawContent = (message as ToolResultMessage).content;
  const blocks: Array<{ type: string; text?: unknown }> = typeof rawContent === "string"
    ? [{ type: "text", text: rawContent }]
    : Array.isArray(rawContent)
      ? rawContent as Array<{ type: string; text?: unknown }>
      : [];
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .slice(0, 400);
  const isError = (message as ToolResultMessage).isError === true;
  return (
    <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
      <span style={{ flexShrink: 0, fontSize: 10, fontFamily: "var(--font-mono)", color: labelColor, paddingTop: 2 }}>{label}</span>
      <div
        style={{
          fontSize: message.role === "toolResult" || message.role === "assistant" ? 11.5 : 12.5,
          lineHeight: 1.55,
          minWidth: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: message.role === "toolResult" ? "var(--text-muted)" : "var(--text)",
          fontFamily: message.role === "toolResult" ? "var(--font-mono)" : "inherit",
        }}
      >
        {message.role === "assistant" && typeof rawContent !== "string" && Array.isArray(rawContent)
          ? rawContent.map((block, i) => (
              <div key={i}>
                {block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
                  ? `→ ${(block as { toolName?: unknown }).toolName ?? "tool"} ${JSON.stringify((block as { input?: unknown }).input ?? {})}`
                  : block && typeof block === "object" && (block as { type?: unknown }).type === "text"
                    ? ((block as { text?: unknown }).text as string) ?? ""
                    : ""}
              </div>
            ))
          : text || (message.role === "user" || message.role === "assistant" ? "" : isError ? "(error)" : "(no output)")}
      </div>
    </div>
  );
}

const BLOCK_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

/** Recursive renderer for structured completions: string values keep their
 * line breaks (JSON.parse already unescapes them), arrays become bullet
 * lists, nested objects become aligned key/value rows. */
function JsonValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return (
      <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
        {value}
      </div>
    );
  }
  if (Array.isArray(value)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {value.map((item, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
            <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>•</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <JsonValue value={item} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {Object.keys(record).map((key) => (
          <div key={key} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", minWidth: 110, textAlign: "right", paddingTop: 2 }}>{key}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <JsonValue value={record[key]} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{String(value)}</span>;
}

/** The subagent's assignment, rendered as markdown. Exported for SSR tests. */
export function TaskBlock({ task }: { task: string }) {
  const { t } = useI18n();
  if (!task) return null;
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", padding: "10px 12px" }}>
      <span style={BLOCK_LABEL_STYLE}>{t("subagentTranscript.taskLabel")}</span>
      <div style={{ marginTop: 6 }}>
        <MarkdownBody className="markdown-subagent-text">{task}</MarkdownBody>
      </div>
    </section>
  );
}

/** The subagent's final output (`<id>.md`). Exported for SSR tests. */
export function CompletionBlock({ completion, truncated }: { completion: string | null; truncated: boolean }) {
  const { t } = useI18n();
  let parsed: Record<string, unknown> | null = null;
  if (completion) {
    try {
      const candidate = JSON.parse(completion) as unknown;
      if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
  }
  const keys = parsed ? Object.keys(parsed) : [];
  const singleText = parsed && keys.length === 1 && typeof parsed[keys[0]] === "string" ? parsed[keys[0]] as string : null;
  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={BLOCK_LABEL_STYLE}>{t("subagentTranscript.resultLabel")}</span>
        {truncated && <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>{t("subagentTranscript.completionTruncated")}</span>}
      </div>
      {singleText ? (
        <div style={{ marginTop: 6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.55 }}>
          {singleText}
        </div>
      ) : parsed ? (
        <div style={{ marginTop: 6 }}>
          <JsonValue value={parsed} />
        </div>
      ) : completion ? (
        <div style={{ marginTop: 6 }}>
          <MarkdownBody className="markdown-subagent-text">{completion}</MarkdownBody>
        </div>
      ) : (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>
          {t("subagentTranscript.noCompletion")}
        </div>
      )}
    </section>
  );
}

export function SubagentTranscriptDialog({ subagent, sessionId, transcriptVersion, events, onClose }: {
  subagent: SubagentInfo | null;
  sessionId: string | null;
  transcriptVersion: number;
  events?: SubagentActivityEvent[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<SubagentSnapshotLike | null>(null);
  const [completion, setCompletion] = useState<string | null>(null);
  const [completionTruncated, setCompletionTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptMessages, setTranscriptMessages] = useState<AgentMessage[]>([]);
  const [transcriptNextByte, setTranscriptNextByte] = useState(0);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptExhausted, setTranscriptExhausted] = useState(false);
  const requestSeqRef = useRef(0);
  const transcriptRequestSeqRef = useRef(0);
  const refetchedVersionRef = useRef(0);
  const refetchedTranscriptVersionRef = useRef(0);
  const latestVersionRef = useRef(0);
  const versionDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = subagent !== null;
  const fromDisk = subagent?.source === "history";
  const live = !fromDisk;

  const fetchCompletion = useCallback(async (): Promise<{ completion: string | null; truncated: boolean }> => {
    if (!sessionId || !subagent?.id) throw new Error("No session");
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagent.id)}?mode=completion`);
    if (res.status === 404) return { completion: null, truncated: false };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as { completion: string | null; truncated: boolean };
  }, [sessionId, subagent?.id]);

  // Full transcript page (RPC registry first, disk fallback) — mirrors the
  // get_subagent_messages response shape so both sources are interchangeable.
  const fetchTranscriptPage = useCallback(async (startByte: number, preferDisk: boolean): Promise<SubagentMessagesPage> => {
    if (!sessionId || !subagent?.id) throw new Error("No session");
    if (preferDisk) {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(subagent.id)}?fromByte=${startByte}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json() as SubagentMessagesPage;
    }
    return await sendAgentCommand<SubagentMessagesPage>(sessionId, {
      type: "get_subagent_messages",
      subagentId: subagent.id,
      sessionFile: subagent.sessionFile,
      fromByte: startByte,
    });
  }, [sessionId, subagent?.id, subagent?.sessionFile]);

  const loadTranscriptPage = useCallback(async (startByte: number) => {
    if (!sessionId || !subagent?.id) return;
    // Own sequence ref: the completion fetch and the transcript pager must not
    // invalidate each other (a shared ref would wedge `loading` forever).
    const seq = ++transcriptRequestSeqRef.current;
    setTranscriptLoading(true);
    setTranscriptError(null);
    try {
      let page: SubagentMessagesPage;
      try {
        page = await fetchTranscriptPage(startByte, fromDisk);
      } catch (rpcError) {
        // The RPC registry only knows subagents of the current process; a
        // live entry whose session restarted falls back to the disk reader.
        if (fromDisk || !subagent.id) throw rpcError;
        page = await fetchTranscriptPage(startByte, true);
      }
      if (seq !== transcriptRequestSeqRef.current) return;
      if (page.reset) {
        setTranscriptMessages(page.messages);
      } else {
        setTranscriptMessages((prev) => [...prev, ...page.messages]);
      }
      setTranscriptNextByte(page.nextByte);
      const complete = typeof page.totalBytes === "number" ? page.nextByte >= page.totalBytes : page.messages.length === 0;
      setTranscriptExhausted(complete || page.nextByte <= page.fromByte);
    } catch (e) {
      if (seq !== transcriptRequestSeqRef.current) return;
      setTranscriptError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === transcriptRequestSeqRef.current) setTranscriptLoading(false);
    }
  }, [sessionId, subagent?.id, fromDisk, fetchTranscriptPage]);

  const load = useCallback(async () => {
    if (!sessionId || !subagent?.id) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const found = await fetchCompletion();
      // Live snapshots enrich the header (resolved model etc.) but carry no
      // settled output — the on-disk `<id>.md` is the completion source.
      if (found.completion === null && live) {
        const result = await sendAgentCommand<{ subagents?: SubagentSnapshotLike[] }>(sessionId, { type: "get_subagents" });
        const snap = (result.subagents ?? []).find((s) => s.id === subagent?.id);
        if (seq !== requestSeqRef.current) return;
        if (snap) setDetail(snap);
      }
      if (seq !== requestSeqRef.current) return;
      setCompletion(found.completion);
      setCompletionTruncated(found.truncated);
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      // A failed refetch would otherwise leave the version consumed and the
      // completion stale until close/reopen — re-arm so the next version bump
      // (or this one, via latestVersionRef) retries.
      refetchedVersionRef.current = 0;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [sessionId, subagent?.id, live, fetchCompletion]);

  // Load the completion whenever the dialog opens for a subagent.
  useEffect(() => {
    if (!open || !sessionId) return;
    requestSeqRef.current += 1;
    transcriptRequestSeqRef.current += 1;
    setCompletion(null);
    setCompletionTruncated(false);
    setError(null);
    setDetail(null);
    setTranscriptOpen(false);
    setTranscriptMessages([]);
    setTranscriptNextByte(0);
    setTranscriptExhausted(false);
    setTranscriptError(null);
    // The bumped seq invalidates an in-flight request whose finally will skip
    // clearing this — reset it here or the next open shows Loading forever.
    setTranscriptLoading(false);
    // transcriptVersion is a PER-SUBAGENT counter: a coincidental value from
    // the previous subagent would make the done-guards below skip the next
    // subagent's debounced refetch, so zero the bookkeeping on every open/switch.
    refetchedVersionRef.current = 0;
    refetchedTranscriptVersionRef.current = 0;
    latestVersionRef.current = 0;
    void load();
  }, [open, sessionId, load]);

  // Live child events mean the final output may have just landed — refetch the
  // completion and (when the transcript is open) append its next page. Bumps
  // are DEBOUNCED so streaming batches coalesce into one fetch, and the latest
  // version is never dropped: a bump that arrives mid-throttle re-arms the
  // timer, and the already-processed guard prevents same-version loops.
  useEffect(() => {
    if (!open || !sessionId || transcriptVersion === 0 || loading) return;
    const completionDone = transcriptVersion === refetchedVersionRef.current && transcriptVersion === latestVersionRef.current;
    const transcriptDone = transcriptVersion === refetchedTranscriptVersionRef.current;
    if (completionDone && transcriptDone) return;
    latestVersionRef.current = transcriptVersion;
    if (versionDebounceTimerRef.current) clearTimeout(versionDebounceTimerRef.current);
    versionDebounceTimerRef.current = setTimeout(() => {
      versionDebounceTimerRef.current = null;
      // Completion fetch: consume the version only when actually fired.
      if (refetchedVersionRef.current !== latestVersionRef.current) {
        refetchedVersionRef.current = latestVersionRef.current;
        void load();
      }
      // Open transcript append: if an older page is still in flight, DO NOT
      // consume the version — when transcriptLoading flips false this effect
      // re-runs and pages the latest (a consumed version would leave the
      // open transcript stale forever with no Load-more button).
      if (transcriptOpen && !transcriptLoading && refetchedTranscriptVersionRef.current !== latestVersionRef.current) {
        refetchedTranscriptVersionRef.current = latestVersionRef.current;
        void loadTranscriptPage(transcriptNextByte);
      }
    }, 600);
    return () => {
      if (versionDebounceTimerRef.current) clearTimeout(versionDebounceTimerRef.current);
    };
  }, [open, sessionId, transcriptVersion, loading, transcriptOpen, transcriptLoading, load, loadTranscriptPage, transcriptNextByte]);

  const agent = detail?.agent ?? subagent?.agent ?? "";
  const description = detail?.description ?? subagent?.description ?? "";
  const task = detail?.task ?? subagent?.task ?? subagent?.assignment ?? "";
  const progress = subagent?.progress;
  const historyTokens = formatTokens(progress?.tokens);
  const historyMeta = subagent?.source === "history"
    ? [
        historyTokens ? t("chatWindow.tokensUnit", { count: historyTokens }) : null,
        formatCost(progress?.cost),
        formatDuration(progress?.durationMs),
        progress?.resolvedModel ? progress.resolvedModel.replace(/:.*$/, "") : null,
      ].filter(Boolean).join(" · ")
    : null;
  const outcomeError = subagent?.source === "history"
    ? subagent?.result?.abortReason ?? subagent?.result?.error
    : undefined;
  const recentEvents = live && !completion && events && events.length > 0 ? events.slice(-4) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      {subagent && (
        <DialogContent
          key={subagent.id}
          ariaLabel={t("subagentTranscript.title")}
          style={{ width: "min(94vw, 920px)", maxWidth: "min(94vw, 920px)" }}
        >
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <DialogTitle style={{ marginBottom: 2, fontSize: 16, lineHeight: 1.3 }}>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)", fontSize: 14 }}>{agent}</span>
                </DialogTitle>
                {description && (
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
                    {description}
                  </div>
                )}
                <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {detail?.sessionFile ?? subagent.sessionFile ?? subagent.id}
                </div>
                {historyMeta && (
                  <div style={{ fontSize: 10.5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: 2 }}>
                    {historyMeta}
                  </div>
                )}
                {outcomeError && (
                  <div style={{ fontSize: 11, color: "var(--status-error)", marginTop: 2, wordBreak: "break-word" }}>
                    {outcomeError}
                  </div>
                )}
              </div>
              <DialogClose
                style={{ flexShrink: 0, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 6px" }}
                aria-label={t("subagentTranscript.close")}
              >
                ×
              </DialogClose>
            </div>

            {recentEvents && (
              <div
                aria-live="polite"
                style={{
                  display: "grid",
                  gap: 2,
                  marginBottom: 8,
                  padding: "6px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-control)",
                  background: "var(--bg-panel)",
                }}
              >
                {recentEvents.map((event, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 6,
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      color: event.kind === "tool" ? "var(--accent)" : "var(--text-muted)",
                      minWidth: 0,
                    }}
                  >
                    <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                      {event.kind === "tool" ? "·" : event.kind === "notice" ? "!" : "»"}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{event.label}</span>
                  </div>
                ))}
              </div>
            )}

            {error ? (
              <div style={{ fontSize: 12, color: "var(--status-error)", padding: "8px 2px" }}>{error}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <TaskBlock task={task} />
                <CompletionBlock completion={completion} truncated={completionTruncated} />
                {loading && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("subagentTranscript.loading")}</div>}
                <button
                  type="button"
                  aria-expanded={transcriptOpen}
                  aria-controls="subagent-transcript-panel"
                  onClick={() => {
                    const next = !transcriptOpen;
                    setTranscriptOpen(next);
                    if (next && transcriptMessages.length === 0 && !transcriptLoading) {
                      void loadTranscriptPage(0);
                    }
                  }}
                  style={{
                    alignSelf: "flex-start",
                    background: "none",
                    border: "none",
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontFamily: "inherit",
                    padding: 0,
                  }}
                >
                  {transcriptOpen ? t("subagentTranscript.hideTranscript") : t("subagentTranscript.showTranscript")}
                </button>
                {transcriptOpen && (
                  <div
                    id="subagent-transcript-panel"
                    style={{
                      display: "grid",
                      gap: 8,
                      padding: "10px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-card)",
                      background: "var(--bg-panel)",
                      maxHeight: "50dvh",
                      overflowY: "auto",
                    }}
                  >
                    {transcriptError && transcriptMessages.length > 0 && (
                      <div style={{ padding: "6px 8px", border: "1px solid color-mix(in srgb, var(--status-error) 40%, var(--border))", borderRadius: "var(--radius-control)", fontSize: 12, color: "var(--status-error)" }}>{transcriptError}</div>
                    )}
                    {transcriptMessages.length === 0 && !transcriptLoading ? (
                      <div style={{ fontSize: 12, color: transcriptError ? "var(--status-error)" : "var(--text-dim)", fontStyle: transcriptError ? "normal" : "italic" }}>{transcriptError ?? t("subagentTranscript.noMessages")}</div>
                    ) : (
                      transcriptMessages.map((message, i) => <SubagentTranscriptRow key={i} message={message} />)
                    )}
                    {transcriptLoading && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("subagentTranscript.loading")}</div>}
                    {!transcriptExhausted && !transcriptLoading && (
                      <button
                        type="button"
                        onClick={() => void loadTranscriptPage(transcriptNextByte)}
                        style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontFamily: "inherit", padding: 0 }}
                      >
                        {t("subagentTranscript.loadMore")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        </DialogContent>
      )}
    </Dialog>
  );
}
