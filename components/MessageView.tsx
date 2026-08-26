"use client";

import { memo, useState, useRef, useEffect, useMemo, useCallback, type ComponentProps } from "react";
import { Copy, Check, GitFork, CornerUpLeft, ChevronRight, ChevronDown, Brain, EyeOff, CircleAlert, LoaderCircle, Sparkles, Clock, ArrowRight, FileText } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { MarkdownBody } from "./MarkdownBody";
import { ClickableImage } from "./ImageLightbox";
import { translate, useI18n, type Locale } from "@/lib/i18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { isEmptyThinkingBlock } from "@/lib/message-display";
import { Tooltip, Collapsible, CollapsibleTrigger } from "./ui/primitives";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { SubagentStatusIcon } from "./SubagentStatusIcon";
import { formatCost, formatDuration, formatTokens, shortModel } from "@/lib/subagent-format";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import { formatCompactNumber } from "@/lib/format";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";


const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();
const MAX_MARKDOWN_CHARS = 100_000;

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 300;

function formatMessageSize(chars: number): string {
  return chars >= 1_000_000 ? `${(chars / 1_000_000).toFixed(1)} MB` : `${Math.round(chars / 1_000)} KB`;
}

export function SafeMarkdownBody({ children, className, ...props }: ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }

  if (!showRaw) {
    return (
      <button
        type="button"
        onClick={() => setShowRaw(true)}
        style={{ display: "block", width: "100%", margin: "4px 0", padding: "7px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
      >
        {t("messageView.largeMessageReveal", { size: formatMessageSize(children.length) })}
      </button>
    );
  }

  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: 12, lineHeight: 1.5 }}>
      <pre style={{ margin: 0, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
        {children}
      </pre>
    </div>
  );
}

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error(translate("messageView.invalidThinkingResponse"));
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  toolCallsDefaultCollapsed?: boolean;
  /** omp-reported output throughput (get_state.tokensPerSecond), live while streaming. */
  liveTokensPerSecond?: number | null;
  onTogglePreCompactionHistory?: () => void;
  showPreCompactionHistory?: boolean;
}
function formatTime(ts: number | undefined, locale: Locale): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString(locale, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

function formatFullDateTime(ts: number | undefined): string | null {
  if (!ts || Number.isNaN(ts)) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, sessionId, toolCallsDefaultCollapsed = true, liveTokensPerSecond, onTogglePreCompactionHistory, showPreCompactionHistory }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} isStreaming={isStreaming} toolResults={toolResults} modelNames={modelNames} cwd={cwd} onOpenFile={onOpenFile} showTimestamp={showTimestamp} prevTimestamp={prevTimestamp} sessionId={sessionId} entryId={entryId} toolCallsDefaultCollapsed={toolCallsDefaultCollapsed} liveTokensPerSecond={liveTokensPerSecond} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    const custom = message as CustomMessage;
    if (custom.customType === "xdev-mount-notice") {
      return null;
    }
    if (custom.customType === "compaction") {
      return (
        <CompactionMessageView
          message={custom}
          onTogglePreCompactionHistory={onTogglePreCompactionHistory}
          showPreCompactionHistory={showPreCompactionHistory}
        />
      );
    }
    if (custom.display === false) {
      return <HiddenExtensionView message={custom} cwd={cwd} onOpenFile={onOpenFile} />;
    }
    return <CustomMessageView message={custom} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.modelNames === next.modelNames
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.entryId === next.entryId
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.onEditContent === next.onEditContent
    && prev.showTimestamp === next.showTimestamp
    && prev.prevTimestamp === next.prevTimestamp
    && prev.sessionId === next.sessionId
    && prev.toolCallsDefaultCollapsed === next.toolCallsDefaultCollapsed
    && prev.liveTokensPerSecond === next.liveTokensPerSecond
    && prev.onTogglePreCompactionHistory === next.onTogglePreCompactionHistory
    && prev.showPreCompactionHistory === next.showPreCompactionHistory;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
}) {
  const { t, locale } = useI18n();
  const isMobile = useIsMobile();
  const [hovered, setHovered] = useState(false);
  const [actionsActive, setActionsActive] = useState(false);
  const [actionsPinned, setActionsPinned] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback();
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const time = formatTime(message.timestamp, locale);
  const canFork = !!entryId && !!onFork;
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  return (
    <div
      style={{ marginBottom: 18, display: "flex", flexDirection: "column", alignItems: "flex-end", paddingRight: 6 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", maxWidth: isMobile ? "92%" : "85%", minWidth: 0 }}>
        <div
          className="chat-message-card"
          onClick={isMobile ? () => setActionsPinned((p) => !p) : undefined}
          style={{
            maxWidth: "100%",
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
            borderRadius: isMobile ? "18px 18px 4px 18px" : "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
            padding: isMobile ? "10px 14px" : "8px 12px",
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--text)",
            wordBreak: "break-word",
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: "auto",
          }}
        >
          {imageBlocks.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
              {imageBlocks.map((img, i) => {
                // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
                // pi-ai on-disk format uses flat {data, mimeType} — handle both
                const flat = img as unknown as { data?: string; mimeType?: string };
                const src = img.source
                  ? img.source.type === "base64"
                    ? `data:${img.source.media_type};base64,${img.source.data}`
                    : img.source.url ?? ""
                  : flat.data
                    ? `data:${flat.mimeType};base64,${flat.data}`
                    : "";
                return (
                  <ClickableImage
                    key={i}
                    src={src}
                    alt=""
                    style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid color-mix(in srgb, var(--accent) 18%, transparent)" }}
                  />
                );
              })}
            </div>
          )}
          {content && <SafeMarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>}
        </div>

        {/* Bottom row: action buttons + timestamp — inside the bubble's column,
            spanning its width, so the timestamp aligns with its right edge. */}
        {(time || canFork || canNavigate || true) && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end",
            gap: 6, marginTop: 3, width: "100%",
          }}>
          <div
            style={{
              display: "flex", gap: 3,
              opacity: isMobile || hovered || actionsActive || actionsPinned ? 1 : 0,
              pointerEvents: isMobile || hovered || actionsActive || actionsPinned ? "auto" : "none",
              transition: "opacity var(--dur-fast) var(--ease-out-warm)",
            }}
            onFocusCapture={() => setActionsActive(true)}
            onBlurCapture={() => setActionsActive(false)}
          >
            <Tooltip content={t("messageView.copyMessage")}>
              <button
                onClick={() => copyContent(content)}
                aria-label={t("messageView.copyMessage")}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "3px 8px", height: 24, minHeight: 24,
                  background: "none", border: "none",
                  borderRadius: 5,
                  color: copied ? "var(--accent)" : "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: 11, fontWeight: 400,
                  whiteSpace: "nowrap",
                  transition: "color var(--dur-fast) var(--ease-out-warm)",
                }}
                onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = "var(--text-dim)"; }}
              >
                {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
                {copied ? t("messageView.copied") : t("messageView.copy")}
              </button>
            </Tooltip>
          </div>
          {(canFork || canNavigate) && (
            <div
              style={{
                display: "flex", gap: 3,
                opacity: (isMobile || hovered || actionsActive || forking || actionsPinned) ? 1 : 0,
                pointerEvents: (isMobile || hovered || actionsActive || forking || actionsPinned) ? "auto" : "none",
                transition: "opacity var(--dur-fast) var(--ease-out-warm)",
              }}
              onFocusCapture={() => setActionsActive(true)}
              onBlurCapture={() => setActionsActive(false)}
            >
              {canNavigate && (
                <Tooltip content={t("messageView.editFromHereTitle")}>
                  <button
                    onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(content); }}
                    aria-label={t("messageView.editFromHereTitle")}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", height: 24, minHeight: 24,
                      background: "none", border: "none",
                      borderRadius: 5,
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      fontSize: 11, fontWeight: 400,
                      whiteSpace: "nowrap",
                      transition: "color var(--dur-fast) var(--ease-out-warm)",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
                  >
                    <CornerUpLeft size={11} strokeWidth={1.8} />
                    {t("messageView.editFromHere")}
                  </button>
                </Tooltip>
              )}
              {canFork && (
                <Tooltip content={forking ? t("messageView.creatingSession") : t("messageView.newSessionTitle")}>
                  <button
                    onClick={() => { onFork!(entryId!); }}
                    disabled={forking}
                    aria-label={forking ? t("messageView.creatingSession") : t("messageView.newSessionTitle")}
                    style={{
                      display: "flex", alignItems: "center", gap: 4,
                      padding: "3px 8px", height: 24, minHeight: 24,
                      background: "none", border: "none",
                      borderRadius: 5,
                      color: forking ? "var(--accent)" : "var(--text-dim)",
                      cursor: forking ? "not-allowed" : "pointer",
                      fontSize: 11, fontWeight: 400,
                      whiteSpace: "nowrap",
                      transition: "color var(--dur-fast) var(--ease-out-warm)",
                    }}
                    onMouseEnter={(e) => { if (!forking) e.currentTarget.style.color = "var(--accent)"; }}
                    onMouseLeave={(e) => { if (!forking) e.currentTarget.style.color = "var(--text-dim)"; }}
                  >
                    <GitFork size={11} strokeWidth={1.8} />
                    {forking ? t("messageView.creating") : t("messageView.newSession")}
                  </button>
                </Tooltip>
              )}
            </div>
          )}
          {time && (
            <button
              type="button"
              onClick={() => setActionsPinned((v) => !v)}
              aria-label={t("messageView.showActions")}
              title={t("messageView.showActions")}
              aria-expanded={actionsPinned}
              style={{
                fontSize: 10,
                color: actionsPinned ? "var(--accent)" : "var(--text-dim)",
                background: "none",
                border: "none",
                padding: "2px 4px",
                margin: "-2px -4px",
                cursor: "pointer",
                fontFamily: "inherit",
                textDecoration: "underline",
                textDecorationStyle: "dotted",
                textUnderlineOffset: 2,
              }}
            >
              {time}
            </button>
          )}
          </div>
        )}
      </div>
    </div>
  );
}
function AssistantMessageView({
  message,
  isStreaming,
  toolResults,
  modelNames,
  cwd,
  onOpenFile,
  showTimestamp,
  prevTimestamp,
  sessionId,
  entryId,
  toolCallsDefaultCollapsed,
  liveTokensPerSecond,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  modelNames?: Record<string, string>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  entryId?: string;
  toolCallsDefaultCollapsed: boolean;
  liveTokensPerSecond?: number | null;
}) {
  const { t, locale } = useI18n();
  const time = showTimestamp ? formatTime(message.timestamp, locale) : null;
  const blockItems = (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming }));
  const blocks = blockItems.map(({ block }) => block);
  const hasActivityBlocks = blocks.some((block) => block.type === "thinking" || block.type === "toolCall");
  const blockItemsRef = useRef(blockItems);
  blockItemsRef.current = blockItems;


  // Streaming-based timing for thinking blocks
  const blockStartTimesRef = useRef<Map<number, number>>(new Map());
  const [streamingDurations, setStreamingDurations] = useState<Map<number, number>>(new Map());

  // Thinking duration derived from file timestamps: time from prev message end to this message end
  // This is the total generation time (thinking + any text before first tool call)
  const thinkingDurationFromFile = useMemo<number | undefined>(() => {
    if (!message.timestamp || !prevTimestamp) return undefined;
    const secs = Math.round((message.timestamp - prevTimestamp) / 1000);
    return secs > 0 ? secs : undefined;
  }, [message.timestamp, prevTimestamp]);

  // Tool call durations derived from session file timestamps (accurate for completed messages)
  // assistant message timestamp = when generation ended = when tools started running
  // toolResult timestamp = when tool execution finished
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || !message.timestamp) return map;
    for (const [callId, result] of toolResults) {
      if (result.timestamp && message.timestamp) {
        const secs = Math.round((result.timestamp - message.timestamp) / 1000);
        if (secs > 0) map.set(callId, secs);
      }
    }
    return map;
  }, [toolResults, message.timestamp]);
  useEffect(() => {
    if (!isStreaming) {
      // Finalise any un-finished thinking block durations on stream end
      const now = new Date().getTime();
      setStreamingDurations((prev: Map<number, number>) => {
        const next = new Map(prev);
        for (const [idx, start] of blockStartTimesRef.current) {
          if (!next.has(idx)) next.set(idx, Math.round((now - start) / 1000));
        }
        return next;
      });
      return;
    }
    const tick = () => {
      const items = blockItemsRef.current;
      const now = Date.now();

      // Record start time for each block the first time we see it
      items.forEach(({ originalIndex }) => {
        if (!blockStartTimesRef.current.has(originalIndex)) blockStartTimesRef.current.set(originalIndex, now);
      });

      // When a non-last block has a successor already started, finalise its duration
      setStreamingDurations((prev: Map<number, number>) => {
        let changed = false;
        const next = new Map(prev);
        for (let i = 0; i < items.length - 1; i++) {
          const originalIndex = items[i].originalIndex;
          const nextOriginalIndex = items[i + 1].originalIndex;
          if (!next.has(originalIndex) && blockStartTimesRef.current.has(originalIndex)) {
            const start = blockStartTimesRef.current.get(originalIndex)!;
            const nextStart = blockStartTimesRef.current.get(nextOriginalIndex) ?? now;
            next.set(originalIndex, Math.round((nextStart - start) / 1000));
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    const id = setInterval(tick, 300);
    tick();
    return () => clearInterval(id);
  }, [isStreaming]);

  if (blocks.length === 0 && !isStreaming) return null;

  return (
    <div
      className="chat-message"
      style={{ marginBottom: 6 }}
    >
      {/* Model label */}
      <div
        style={{
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 4,
          display: hasActivityBlocks ? "none" : "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {message.provider && (
          <span>{modelNames?.[`${message.provider}:${message.model}`] ?? modelNames?.[message.model] ?? message.model}</span>
        )}
        {isStreaming && (() => {
          let chars = 0;
          for (const b of blocks) {
            if (b.type === "text") chars += (b as TextContent).text?.length ?? 0;
            else if (b.type === "thinking") chars += (b as ThinkingContent).thinking?.length ?? 0;
          }
          const est = Math.round(chars / 4);
          return (
            <>

              {est > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text)" }} title={t("messageView.estimatedTokens")}>
                  <span style={{ display: "flex", alignItems: "center", gap: 2, fontSize: 11, fontWeight: 400 }}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
                    </svg>
                    {est}
                  </span>
                  {liveTokensPerSecond != null && (() => {
                    // Speed tiers use the semantic status tokens as TEXT color
                    // (theme-adaptive, AA-verified) over a subtle tint — the
                    // old hardcoded palette failed AA for white-on-fill.
                    const tier = liveTokensPerSecond >= 50 ? "success" : liveTokensPerSecond >= 30 ? "renamed" : liveTokensPerSecond >= 15 ? "warning" : "error";
                    const tone = `var(--status-${tier})`;
                    return (
                      <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 4, background: `color-mix(in srgb, ${tone} 14%, var(--bg-panel))`, color: tone, fontSize: 11, fontWeight: 400 }}>
                        {t("messageView.tokensPerSecond", { tps: liveTokensPerSecond.toFixed(1) })}
                      </span>
                    );
                  })()}
                </span>
              )}
            </>
          );
        })()}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {blockItems.map(({ block, originalIndex }) => (
          <BlockView key={`${entryId ?? "stream"}-${originalIndex}`} block={block} toolResults={toolResults} isStreaming={isStreaming} streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)} toolCallDurations={toolCallDurations} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} entryId={entryId} blockIndex={originalIndex} toolCallsDefaultCollapsed={toolCallsDefaultCollapsed} />
        ))}
      </div>

      {time && !isStreaming && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 3 }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>
        </div>
      )}
    </div>
  );
}

function BlockView({ block, toolResults, isStreaming, streamingDuration, toolCallDurations, cwd, onOpenFile, sessionId, entryId, blockIndex, toolCallsDefaultCollapsed }: { block: AssistantContentBlock; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; sessionId?: string; entryId?: string; blockIndex: number; toolCallsDefaultCollapsed: boolean }) {
  if (block.type === "text") {
    return <TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} isStreaming={isStreaming} defaultCollapsed={toolCallsDefaultCollapsed} />;
  }
  return null;
}

// Every message_update frame delivers freshly parsed block objects, so the
// block memos below compare content (text/thinking strings, tool call ids)
// instead of object identity: finished blocks of the streaming message then
// skip their ReactMarkdown re-parse and only the actively growing block
// re-renders per frame.
const TextBlock = memo(function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
}, (prev, next) => (
  prev.block.text === next.block.text
  && prev.isStreaming === next.isStreaming
  && prev.cwd === next.cwd
  && prev.onOpenFile === next.onOpenFile
));

const ThinkingBlock = memo(function ThinkingBlock({ block, duration, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    setExpanded(nextOpen);
    if (!nextOpen || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(t("messageView.thinkingUnavailable"));
      return;
    }

    setLoading(true);
    setError(null);
    void loadThinkingContent(sessionId, entryId, blockIndex)
      .then((text) => setContent(text))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  return (
    <div className="activity-row" data-activity-operation="true">
      <Collapsible open={expanded} onOpenChange={handleOpenChange}>
        <CollapsibleTrigger className="activity-row-trigger">
          <span className="activity-row-indicator" aria-hidden>
            <Brain size={12} strokeWidth={1.8} />
          </span>
          <span className="activity-row-tool">{t("messageView.thinking")}</span>
          <span className="activity-row-preview" />
          {duration !== undefined && (
            <span className="activity-row-duration">{t("messageView.durationSeconds", { seconds: duration })}</span>
          )}
          <ChevronDown
            size={11}
            strokeWidth={1.8}
            aria-hidden
            style={{
              flexShrink: 0,
              transform: expanded ? "none" : "rotate(-90deg)",
              transition: "transform var(--dur-fast) var(--ease-out-warm)",
            }}
          />
        </CollapsibleTrigger>
        {expanded && (
          <div className="tool-call-details">
            <div
              className={`tool-call-output${error ? " tool-call-output-error" : ""}`}
              style={{
                whiteSpace: "pre-wrap",
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                lineHeight: 1.45,
                color: error ? "var(--status-error)" : "var(--text-muted)",
              }}
            >
              <pre className="tool-call-output-text">
                {loading ? t("messageView.loadingThinking") : error ?? (block.deferred ? content : block.thinking)}
              </pre>
            </div>
          </div>
        )}
      </Collapsible>
    </div>
  );
}, (prev, next) => (
  prev.block.thinking === next.block.thinking
  && prev.block.deferred === next.block.deferred
  && prev.duration === next.duration
  && prev.sessionId === next.sessionId
  && prev.entryId === next.entryId
  && prev.blockIndex === next.blockIndex
));


const ToolCallBlock = memo(function ToolCallBlock({ block, result, duration, isStreaming, defaultCollapsed = true }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; isStreaming?: boolean; defaultCollapsed?: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(Boolean(isStreaming) && !defaultCollapsed);
  const resultText = result
    ? (typeof result.content === "string"
        ? result.content
        : (Array.isArray(result.content) ? result.content : [])
            .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n"))
    : null;
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;
  const resultDiff = expanded && result && !isError ? getResultDiff(result) : null;
  const resultMeta = getToolResultMeta(result);
  const command = formatToolCommand(block);

  return (
    <div className="activity-row" data-activity-operation="true">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="activity-row-trigger">
          <span className={`activity-row-indicator${isError ? " activity-row-indicator-error" : ""}`} aria-hidden>
            {isError ? <CircleAlert size={12} strokeWidth={1.8} /> : result ? <Check size={12} strokeWidth={2} /> : <LoaderCircle size={12} strokeWidth={1.8} className="activity-row-spinner" />}
          </span>
          <span className={`activity-row-tool${isError ? " activity-row-tool-error" : ""}`}>{block.toolName}</span>
          <span className="activity-row-preview">{getToolPreview(block)}</span>
          {duration !== undefined && (
            <span className="activity-row-duration">{t("messageView.durationSeconds", { seconds: duration })}</span>
          )}
          <ChevronDown
            size={11}
            strokeWidth={1.8}
            aria-hidden
            style={{
              flexShrink: 0,
              transform: expanded ? "none" : "rotate(-90deg)",
              transition: "transform var(--dur-fast) var(--ease-out-warm)",
            }}
          />
        </CollapsibleTrigger>
        {resultMeta && <div className="activity-row-secondary">{resultMeta}</div>}
        {expanded && (
          <div className={`tool-call-details${isError ? " tool-call-details-error" : ""}`}>
            <div className="tool-call-command">
              <span className="tool-call-command-prompt" aria-hidden>$</span>
              <code>{command}</code>
            </div>
            <TaskResultPanel details={result?.details} />
            {result ? (
              resultDiff ? (
                <PairedDiffResult diff={resultDiff} />
              ) : (
                <PairedResult text={formatToolOutput(resultText ?? "", block.toolName)} isEmpty={resultIsEmpty} isError={isError} />
              )
            ) : null}
          </div>
        )}
      </Collapsible>
    </div>
  );
}, (prev, next) => (
  prev.block.toolCallId === next.block.toolCallId
  && prev.block.toolName === next.block.toolName
  && prev.block.input === next.block.input
  && prev.result === next.result
  && prev.duration === next.duration
  && prev.defaultCollapsed === next.defaultCollapsed
));


type TaskResultRowLike = Record<string, unknown>;

function taskRowStatus(row: TaskResultRowLike): "started" | "completed" | "failed" | "aborted" {
  if (row.aborted === true) return "aborted";
  if (typeof row.error === "string" && row.error) return "failed";
  if (typeof row.exitCode === "number") return row.exitCode === 0 ? "completed" : "failed";
  const status = row.status;
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "started";
}

function TaskResultStatusIcon({ status }: { status: "started" | "completed" | "failed" | "aborted" }) {
  return <SubagentStatusIcon status={status} />;
}

/**
 * Compact per-subagent summary rendered inside an expanded `task` tool call.
 * Feeds off the size-bounded task details allowlisted by the session reader
 * (lib/session-reader.ts stripToolResultDetails): settled results when
 * present, otherwise the mid-run progress snapshot.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function TaskResultPanel({ details }: { details: unknown }) {
  const { t, tn } = useI18n();
  if (!isRecord(details)) return null;
  const results = (Array.isArray(details.results) ? details.results : []).filter(isRecord);
  const progress = (Array.isArray(details.progress) ? details.progress : []).filter(isRecord);
  const asyncInfo = isRecord(details.async) ? details.async : null;
  if (results.length === 0 && progress.length === 0 && !asyncInfo) return null;

  // Settled results win; otherwise the mid-run progress snapshot; a bare
  // async marker (spawn recorded, no rows yet) still names the job.
  const rows = results.length > 0
    ? results
    : progress.length > 0
      ? progress
      : asyncInfo && typeof asyncInfo.jobId === "string"
        ? [{ id: asyncInfo.jobId, agent: "task", status: "started", task: asyncInfo.jobId } as TaskResultRowLike]
        : [];
  const totalTokens = rows.reduce((sum, row) => sum + (typeof row.tokens === "number" ? row.tokens : 0), 0);
  const totalCost = rows.reduce((sum, row) => sum + (typeof row.cost === "number" ? row.cost : 0), 0);
  const totalDurationMs = typeof details.totalDurationMs === "number" ? details.totalDurationMs : undefined;
  const totalTokensLabel = formatTokens(totalTokens);
  const totalParts = [
    tn("chatWindow.subagentCount", rows.length),
    totalTokensLabel ? t("chatWindow.tokensUnit", { count: totalTokensLabel }) : null,
    formatCost(totalCost),
    formatDuration(totalDurationMs),
  ].filter(Boolean);

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg-subtle)",
        padding: "8px 10px",
        display: "grid",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{t("messageView.taskSubagents")}</span>
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", color: "var(--text-dim)", fontSize: 10.5 }}>
          {totalParts.join(" · ")}
        </span>
        {asyncInfo && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>⤴</span>
        )}
      </div>
      {rows.map((row, index) => {
        const id = typeof row.id === "string" ? row.id : `row-${index}`;
        const status = taskRowStatus(row);
        const task = typeof row.task === "string" && row.task ? row.task : (typeof row.assignment === "string" ? row.assignment : null);
        const rowTokens = formatTokens(typeof row.tokens === "number" ? row.tokens : undefined);
        const rowParts = [
          rowTokens ? t("chatWindow.tokensUnit", { count: rowTokens }) : null,
          formatCost(typeof row.cost === "number" ? row.cost : undefined),
          status !== "started" ? formatDuration(typeof row.durationMs === "number" ? row.durationMs : undefined) : null,
          shortModel(typeof row.resolvedModel === "string" ? row.resolvedModel : undefined),
        ].filter(Boolean);
        return (
          <div
            key={id}
            aria-label={`${typeof row.agent === "string" ? row.agent : "subagent"}: ${t(`chatWindow.subagentState.${status}`)}${task ? ` — ${task}` : ""}`}
            style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 11.5 }}
          >
            <TaskResultStatusIcon status={status} />
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 10.5, color: "var(--accent)", flexShrink: 0 }}>
              {typeof row.agent === "string" ? row.agent : "subagent"}
            </span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, color: "var(--text)" }}>
              {task ?? ""}
            </span>
            {rowParts.length > 0 && (
              <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                {rowParts.join(" · ")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ResultDiff {
  text: string;
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const record = details as Record<string, unknown>;
  const patch = typeof record.patch === "string" ? record.patch : null;
  if (patch) return { text: patch };
  const diff = typeof record.diff === "string" ? record.diff : null;
  if (diff) return { text: diff };
  return null;
}

function PairedDiffResult({ diff }: { diff: ResultDiff }) {
  return (
    <div
      style={{
        borderTop: "1px solid color-mix(in srgb, var(--status-success) 15%, transparent)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const { t } = useI18n();
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <SplitDiffHeader title={file.oldPath || t("messageView.diffBefore")} side="left" />
              <SplitDiffHeader title={file.newPath || t("messageView.diffAfter")} side="right" />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "color-mix(in srgb, var(--status-success) 12%, transparent)"
      : cell.type === "removed"
      ? "color-mix(in srgb, var(--status-error) 13%, transparent)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "var(--status-success)" : cell.type === "removed" ? "var(--status-error)" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "color-mix(in srgb, var(--status-success) 12%, transparent)" :
          kind === "removed" ? "color-mix(in srgb, var(--status-error) 13%, transparent)" :
          kind === "hunk" ? "color-mix(in srgb, var(--accent) 12%, transparent)" :
          "transparent";
        const color =
          kind === "added" ? "var(--status-success)" :
          kind === "removed" ? "var(--status-error)" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid var(--status-success)"
                : kind === "removed"
                ? "3px solid var(--status-error)"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function PairedResult({ text, isEmpty, isError }: {
  text: string;
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={`tool-call-output${isError ? " tool-call-output-error" : ""}`}>
      <pre className="tool-call-output-text" data-tool-output="true">
        {isEmpty ? t("messageView.noOutput") : text}
      </pre>
    </div>
  );
}

function CompactionMessageView({
  message,
  onTogglePreCompactionHistory,
  showPreCompactionHistory,
}: {
  message: CustomMessage;
  onTogglePreCompactionHistory?: () => void;
  showPreCompactionHistory?: boolean;
}) {
  const { t, locale } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);

  const fullTime = formatFullDateTime(message.timestamp);
  const shortTime = formatTime(message.timestamp, locale);

  const details = (message.details ?? null) as {
    tokensBefore?: unknown;
    tokensAfter?: unknown;
    method?: unknown;
    shortSummary?: unknown;
  } | null;

  const tokensBefore = typeof details?.tokensBefore === "number" ? details.tokensBefore : null;
  const tokensAfter = typeof details?.tokensAfter === "number" ? details.tokensAfter : null;
  const method = typeof details?.method === "string" && details.method ? details.method : null;

  const savedTokens = tokensBefore !== null && tokensAfter !== null ? Math.max(0, tokensBefore - tokensAfter) : null;
  const savingsPercent = tokensBefore !== null && tokensAfter !== null && tokensBefore > 0
    ? Math.round(((tokensBefore - tokensAfter) / tokensBefore) * 100)
    : null;
  const { copied, copy } = useCopyFeedback();
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  const handleCopySummary = useCallback(() => {
    copy(parsedSummary.body || summary);
  }, [copy, parsedSummary.body, summary]);
  return (
    <div style={{ marginBottom: detailsExpanded ? 20 : 12, marginTop: detailsExpanded ? 14 : 10 }}>
      {/* Timeline Divider */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: detailsExpanded ? 12 : 0 }}>
        <div style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--border) 75%, transparent)" }} />
        <button
          type="button"
          onClick={() => setDetailsExpanded((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 12px",
            borderRadius: 20,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            cursor: "pointer",
            boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
            transition: "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg-panel)"; e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <Sparkles size={12} style={{ color: "var(--accent)" }} />
          <span>{shortTime || fullTime || t("messageView.compactionLabel")}</span>
          <span style={{ color: "var(--text-dim)" }}>·</span>
          <span style={{ fontWeight: 650, color: "var(--text)" }}>{t("messageView.conversationCompacted")}</span>
          {tokensBefore !== null && (
            <>
              <span style={{ color: "var(--text-dim)" }}>·</span>
              <span>{formatCompactNumber(tokensBefore, locale)} → {formatCompactNumber(tokensAfter ?? 0, locale)}</span>
              {savingsPercent !== null && savingsPercent > 0 && (
                <span style={{ color: "var(--status-success)", fontWeight: 700 }}>(-{savingsPercent}%)</span>
              )}
            </>
          )}
          <ChevronDown
            size={13}
            style={{
              marginLeft: 2,
              color: "var(--text-dim)",
              transform: detailsExpanded ? "rotate(180deg)" : "none",
              transition: "transform var(--dur-fast) var(--ease-out-warm)",
            }}
          />
        </button>
        <div style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--border) 75%, transparent)" }} />
      </div>

      {/* Compaction Card (Rendered when expanded) */}
      {detailsExpanded && (
        <div style={{
          border: "1px solid color-mix(in srgb, var(--border) 80%, var(--accent))",
          borderRadius: "var(--radius-card)",
          overflow: "hidden",
          background: "var(--bg)",
          boxShadow: "var(--shadow-card)",
          animation: "ui-scale-in var(--dur-med) var(--ease-out-warm)",
        }}>
          {/* Header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--bg-panel) 85%, var(--bg))",
            flexWrap: "wrap",
            gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--accent)",
              }}>
                <Sparkles size={14} />
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.01em" }}>
                {t("messageView.conversationCompacted")}
              </span>
              {method ? (
                <span style={{
                  padding: "2px 7px",
                  borderRadius: 4,
                  background: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                  fontSize: 10.5,
                  fontFamily: "var(--font-mono)",
                  fontWeight: 650,
                  border: "1px solid var(--border)",
                }}>
                  {method}
                </span>
              ) : (
                <span style={{
                  padding: "2px 7px",
                  borderRadius: 4,
                  background: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                  fontSize: 10.5,
                  fontWeight: 600,
                  border: "1px solid var(--border)",
                }}>
                  {t("messageView.compactionAuto")}
                </span>
              )}
            </div>

            {fullTime && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                <Clock size={12} />
                <span>{fullTime}</span>
              </div>
            )}
          </div>

          {/* Token Delta Metrics Banner */}
          {tokensBefore !== null && (
            <div style={{
              padding: "10px 14px",
              background: "color-mix(in srgb, var(--bg-surface, var(--bg-subtle)) 60%, var(--bg))",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
                <span style={{ color: "var(--text-muted)" }}>{t("messageView.compactionTokenUsage")}</span>
                <span style={{ fontWeight: 650, color: "var(--text)" }}>
                  {formatCompactNumber(tokensBefore, locale)}
                </span>
                <ArrowRight size={13} style={{ color: "var(--text-dim)" }} />
                <span style={{ fontWeight: 700, color: "var(--accent)" }}>
                  {formatCompactNumber(tokensAfter ?? 0, locale)}
                </span>
              </div>

              {savingsPercent !== null && savingsPercent > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {savedTokens !== null && (
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      {t("messageView.compactionSavedTokens", { saved: formatCompactNumber(savedTokens, locale) })}
                    </span>
                  )}
                  <span style={{
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "color-mix(in srgb, var(--status-success) 14%, transparent)",
                    color: "var(--status-success)",
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "var(--font-mono)",
                  }}>
                    -{savingsPercent}%
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Summary Content Body */}
          <div style={{ padding: "14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, color: "var(--text-muted)", fontSize: 12, fontWeight: 650 }}>
              <FileText size={13} />
              <span>{t("messageView.compactionSummaryTitle")}</span>
            </div>

            <div style={{ color: "var(--text)", fontSize: 13.5, lineHeight: 1.6 }}>
              {parsedSummary.body ? (
                <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
              ) : (
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("messageView.noSummary")}</span>
              )}
            </div>

            <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
          </div>

          {/* Action Footer */}
          <div style={{
            padding: "8px 14px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-panel)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}>
            {onTogglePreCompactionHistory ? (
              <button
                type="button"
                onClick={onTogglePreCompactionHistory}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  color: "var(--text)",
                  fontSize: 12,
                  fontWeight: 550,
                  cursor: "pointer",
                }}
              >
                <ChevronDown
                  size={14}
                  style={{
                    transform: showPreCompactionHistory ? "rotate(180deg)" : "none",
                    transition: "transform 0.2s ease",
                  }}
                />
                <span>
                  {showPreCompactionHistory
                    ? t("chatWindow.returnToCompactHistory")
                    : t("chatWindow.viewPreCompactionHistory")}
                </span>
              </button>
            ) : <div />}

            <button
              type="button"
              onClick={handleCopySummary}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: copied ? "var(--status-success)" : "var(--text-muted)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? t("messageView.copied") : t("messageView.copy")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(t("messageView.filesReadCount", { count: readFiles.length }));
  if (modifiedFiles.length > 0) parts.push(t("messageView.filesModifiedCount", { count: modifiedFiles.length }));

  return (
    <details className="compaction-file-details">
      <summary>{t("messageView.fileContext", { parts: parts.join(", ") })}</summary>
      {modifiedFiles.length > 0 && <CompactionFileList title={t("messageView.modifiedFiles")} files={modifiedFiles} />}
      {readFiles.length > 0 && <CompactionFileList title={t("messageView.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function stripHiddenWrappers(text: string): string {
  let t = text.trim();
  t = t.replace(/^<!--[\s\S]*?-->\s*/, "").trim();
  const outer = t.match(/^<([a-zA-Z0-9_-]+)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>\s*$/);
  if (outer) return outer[2].trim();
  return t;
}

function friendlyHiddenLabel(customType: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    "mid-run-todo-nudge": "Todo reminder",
    "todo-error-reminder": "Todo reminder",
    "resolve-reminder": "Pending preview",
    "interrupted-thinking": "Interrupted",
    "autoresearch-resume": "Resume hint",
    "plan-mode-context": "Plan context",
    "plan-mode-reference": "Plan reference",
    "goal-mode-context": "Goal context",
    "goal-continuation": "Goal continuation",
    "goal-budget-limit": "Budget limit",
    "thinking-loop-redirect": "Loop guard",
    "image-attachment-description": "Image note",
    "extension_debug": "Extension",
    "lsp-late-diagnostic": "Diagnostics",
  };
  if (map[customType]) return map[customType];
  if (!customType) return t("messageView.extensionType");
  return customType.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function HiddenExtensionView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const { t, locale } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback();
  const rawText = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const cleanText = useMemo(() => stripHiddenWrappers(rawText), [rawText]);
  const preview = useMemo(() => {
    const normalized = cleanText.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    return normalized.length > 92 ? `${normalized.slice(0, 92)}…` : normalized;
  }, [cleanText]);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const label = friendlyHiddenLabel(message.customType, t);
  const time = formatTime(message.timestamp, locale);

  return (
    <div style={{ marginBottom: 8, display: "flex", justifyContent: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0, width: "100%", maxWidth: 640 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
          <div style={{ flex: 1, height: 1, background: "var(--border)", opacity: 0.55 }} />
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? t("messageView.collapse") : t("messageView.expand")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              maxWidth: "78%",
              padding: "4px 10px",
              border: "1px dashed color-mix(in srgb, var(--border) 88%, transparent)",
              borderRadius: 999,
              background: "color-mix(in srgb, var(--bg-subtle) 92%, var(--bg))",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
            }}
          >
            <EyeOff size={12} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.85 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 650, letterSpacing: "0.01em", color: "var(--text-muted)", fontSize: 11 }}>
              {label}
            </span>
            {preview ? (
              <>
                <span style={{ width: 3, height: 3, borderRadius: 999, background: "var(--text-dim)", opacity: 0.5, flexShrink: 0 }} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, fontSize: 11 }}>{preview}</span>
              </>
            ) : null}
            <ChevronRight size={11} strokeWidth={1.8} style={{ flexShrink: 0, opacity: 0.7, transform: expanded ? "rotate(90deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} />
          </button>
          <div style={{ flex: 1, height: 1, background: "var(--border)", opacity: 0.55 }} />
        </div>
        {time ? <span style={{ marginTop: 2, color: "var(--text-dim)", fontSize: 10, fontVariantNumeric: "tabular-nums", opacity: 0.75 }}>{time}</span> : null}
        {expanded ? (
          <div
            style={{
              marginTop: 6,
              width: "100%",
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflow: "hidden",
              background: "var(--bg-subtle)",
            }}
          >
            <div style={{ padding: "8px 10px" }}>
              {images.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: cleanText ? 8 : 0 }}>
                  {images.map((img, i) => {
                    const src = imageSource(img);
                    if (!src) return null;
                    return (
                      <ClickableImage
                        key={i}
                        src={src}
                        alt=""
                        style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                      />
                    );
                  })}
                </div>
              )}
              {cleanText ? (
                <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>
                  {cleanText}
                </MarkdownBody>
              ) : (
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("messageView.noMessage")}</span>
              )}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 9px",
                borderTop: "1px solid var(--border)",
                background: "var(--bg-panel)",
              }}
            >
              {(cleanText || detailsText) ? (
                <button
                  onClick={() => copyContent(cleanText || detailsText)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 7px",
                    border: "none",
                    background: "none",
                    color: copied ? "var(--accent)" : "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.8} />}
                  {copied ? t("messageView.copied") : t("messageView.copy")}
                </button>
              ) : null}
              {hasDetails ? (
                <button
                  onClick={() => setDetailsExpanded((v) => !v)}
                  style={{
                    marginLeft: "auto",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 7px",
                    border: "none",
                    background: "none",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {detailsExpanded ? t("messageView.hideDetails") : t("messageView.showDetails")}
                  <ChevronDown size={11} strokeWidth={1.8} style={{ transform: detailsExpanded ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }} />
                </button>
              ) : (
                <button
                  onClick={() => setExpanded(false)}
                  style={{
                    marginLeft: "auto",
                    padding: "3px 7px",
                    border: "none",
                    background: "none",
                    color: "var(--text-dim)",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {t("messageView.collapse")}
                </button>
              )}
            </div>
            {hasDetails && detailsExpanded ? (
              <pre
                style={{
                  margin: 0,
                  padding: "9px 10px",
                  borderTop: "1px solid var(--border)",
                  backgroundColor: "var(--bg)",
                  color: "var(--text-muted)",
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 360,
                  overflow: "auto",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {detailsText}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const { t, locale } = useI18n();
  const [contentExpanded, setContentExpanded] = useState(true);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const { copied, copy: copyContent } = useCopyFeedback();
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const isIrc = IRC_CUSTOM_TYPES.has(message.customType);
  const ircEnvelope = isIrc ? parseIrcEnvelope(text) : null;
  const displayText = ircEnvelope ? ircEnvelope.body : text;
  const title = isIrc
    ? (ircEnvelope?.sender ?? formatCustomType(message.customType))
    : message.customType === "advisor"
      ? t("messageView.advisorLabel")
      : formatCustomType(message.customType);
  const time = formatTime(message.timestamp, locale);


  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {isIrc && message.customType === "irc:incoming" ? `← ${title}` : title}
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: displayText ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    <ClickableImage
                      key={i}
                      src={src}
                      alt=""
                      style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                    />
                  );
                })}
              </div>
            )}
            {displayText ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{displayText}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("messageView.noMessage")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
            {displayText ? previewText(displayText) : t("messageView.showExtensionMessage")}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={() => copyContent(displayText || detailsText)}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {copied ? t("messageView.copied") : t("messageView.copy")}
            </button>
          ) : null}
          {hasDetails && (
            <button
              onClick={() => {
                setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {detailsExpanded ? t("messageView.hideDetails") : t("messageView.showDetails")}
            </button>
          )}
        </div>

        {hasDetails && detailsExpanded && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              backgroundColor: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatCustomType(type: string): string {
  return type || translate("messageView.extensionType");
}

// Peer IRC messages are persisted as custom_message entries whose content is
// an envelope: "<irc>\nIncoming IRC message from agent `Name`:\n<body>". The
// card title must show the SENDER, not the raw customType.
const IRC_CUSTOM_TYPES = new Set(["irc:incoming", "irc:autoreply", "irc:relay"]);

function parseIrcEnvelope(content: string): { sender: string | null; body: string } {
  const lines = content.split("\n");
  let sender: string | null = null;
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/agent\s*`([^`]+)`/);
    if (match) {
      sender = match[1];
      bodyStart = i + 1;
      break;
    }
  }
  return { sender, body: lines.slice(bodyStart).join("\n").trim() };
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return translate("messageView.showExtensionMessage");
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}
function formatToolCommand(block: ToolCallContent): string {
  const input = block.input;
  if (input && typeof input.command === "string") return input.command;
  if (input && typeof input.path === "string") return `${block.toolName} ${input.path}`;
  if (input && typeof input.file_path === "string") return `${block.toolName} ${input.file_path}`;
  if (input && typeof input.query === "string") return `${block.toolName} ${input.query}`;
  try {
    return `${block.toolName} ${JSON.stringify(input)}`;
  } catch {
    return block.toolName;
  }
}

function formatToolOutput(text: string, toolName: string): string {
  if (!isReadToolName(toolName)) return text;
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+:\s?/, ""))
    .join("\n");
}

function isReadToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "read" || name.endsWith(".read") || name.endsWith("_read");
}

function getToolResultMeta(result: ToolResultMessage | undefined): string | null {
  if (!result || !isRecord(result.details)) return null;
  const details = result.details;
  const usage = isRecord(details.usage) ? details.usage : details;
  const readNumber = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  };
  const input = readNumber("input", "inputTokens", "input_tokens");
  const output = readNumber("output", "outputTokens", "output_tokens");
  const cacheRead = readNumber("cacheRead", "cache_read", "cacheReadTokens");
  const cacheWrite = readNumber("cacheWrite", "cache_write", "cacheWriteTokens");
  const parts = [
    input ? `in ${formatCompactNumber(input)}` : null,
    output ? `out ${formatCompactNumber(output)}` : null,
    cacheRead ? `cache R ${formatCompactNumber(cacheRead)}` : null,
    cacheWrite ? `cache W ${formatCompactNumber(cacheWrite)}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const { t } = useI18n();
  const [fullOutput, setFullOutput] = useState<{ phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; output: string } | null>(null);
  // Bumped on every message change; an in-flight fetch from the previous
  // message must not write into the reused component instance.
  const fullOutputGenRef = useRef(0);
  // Branch navigation can swap a different bashExecution message into the same
  // index; the component instance is reused, so drop any loaded full output
  // (and its "ready" re-load guard) whenever the message identity changes.
  useEffect(() => {
    fullOutputGenRef.current += 1;
    setFullOutput(null);
  }, [message.command, message.fullOutputPath, message.output, message.timestamp]);
  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: message.output ? [{ type: "text", text: message.output }] : [],
        isError,
        timestamp: message.timestamp,
      };

  // Large executions record their full output to a temp file (fullOutputPath);
  // fetch it through the guarded bash-output route instead of re-reading the
  // truncated session payload.
  const loadFullOutput = useCallback(async () => {
    if (!message.fullOutputPath || !sessionId || fullOutput?.phase === "ready") return;
    const gen = fullOutputGenRef.current;
    setFullOutput({ phase: "loading" });
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`);
      const data = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (fullOutputGenRef.current !== gen) return;
      if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
      setFullOutput({ phase: "ready", output: data.data?.output ?? "" });
    } catch (e) {
      if (fullOutputGenRef.current !== gen) return;
      setFullOutput({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [message.fullOutputPath, sessionId, fullOutput?.phase]);

  const downloadUrl = message.fullOutputPath && sessionId
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}&download=1`
    : null;

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {downloadUrl && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
          {fullOutput?.phase !== "ready" && (
            <button
              type="button"
              disabled={fullOutput?.phase === "loading"}
              onClick={() => void loadFullOutput()}
              style={{ padding: 0, border: "none", background: "none", color: "var(--accent)", cursor: fullOutput?.phase === "loading" ? "default" : "pointer", fontSize: 12, opacity: fullOutput?.phase === "loading" ? 0.6 : 1, fontFamily: "inherit" }}
            >
              {fullOutput?.phase === "loading" ? t("messageView.fullOutputLoading") : t("messageView.viewFullOutput")}
            </button>
          )}
          <a href={downloadUrl} download style={{ color: "var(--text-dim)", fontSize: 12, textDecoration: "none" }}>
            {t("messageView.fullOutputDownload")}
          </a>
        </div>
      )}
      {fullOutput?.phase === "ready" && (
        <div style={{ maxHeight: 420, overflow: "auto", marginTop: 6, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
          <pre style={{ margin: 0, padding: "8px 10px", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)" }}>
            {fullOutput.output}
          </pre>
        </div>
      )}
      {fullOutput?.phase === "error" && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--status-error)" }}>{fullOutput.message}</div>
      )}
    </div>
  );
}
