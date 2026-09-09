"use client";

import { memo, useState, useRef, useEffect, useMemo, useCallback, type ComponentProps } from "react";
import { Copy, Check, GitFork, CornerUpLeft, ChevronRight, ChevronDown, Brain, EyeOff, CircleAlert, CircleSlash, LoaderCircle, FileText, Search, FileEdit, Terminal, CheckSquare, Bot, Code2, Globe, Wrench } from "lucide-react";
import { MarkdownBody } from "./MarkdownBody";
import { ClickableImage } from "./ImageLightbox";
import { translate, useI18n, type Locale } from "@/lib/i18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { isEmptyThinkingBlock } from "@/lib/message-display";
import { Tooltip, Collapsible, CollapsibleTrigger } from "./ui/primitives";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";
import { formatCompactNumber } from "@/lib/format";
import { TaskResultPanel } from "./MessageView-task-panel";
import { getResultDiff, PairedDiffResult, PairedResult } from "./MessageView-diff-view";
import {
  getToolPreview,
  formatToolCommand,
  formatToolOutput,
  getToolResultMeta,
  getToolCategory,
  getTodoSummary,
  summarizeToolCallGroup,
  getSemanticToolLabel,
  type ToolCategory,
} from "./MessageView-tool-format";
export { TaskResultPanel } from "./MessageView-task-panel";
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

function ToolCategoryIcon({
  category,
  size = 12,
  className,
  style,
}: {
  category: ToolCategory;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  switch (category) {
    case "read":
      return <FileText size={size} strokeWidth={1.8} className={className} style={{ color: "var(--status-renamed, #7CA8FF)", ...style }} />;
    case "search":
      return <Search size={size} strokeWidth={1.8} className={className} style={{ color: "var(--accent, #EC5BAB)", ...style }} />;
    case "edit":
      return <FileEdit size={size} strokeWidth={1.8} className={className} style={{ color: "var(--status-modified, #E0B24D)", ...style }} />;
    case "terminal":
      return <Terminal size={size} strokeWidth={1.8} className={className} style={{ color: "var(--status-success, #7DD8A8)", ...style }} />;
    case "todo":
      return <CheckSquare size={size} strokeWidth={1.8} className={className} style={{ color: "var(--accent, #EC5BAB)", ...style }} />;
    case "task":
      return <Bot size={size} strokeWidth={1.8} className={className} style={{ color: "var(--accent-2, #7DD7E8)", ...style }} />;
    case "code":
      return <Code2 size={size} strokeWidth={1.8} className={className} style={{ color: "var(--accent, #EC5BAB)", ...style }} />;
    case "web":
      return <Globe size={size} strokeWidth={1.8} className={className} style={{ color: "var(--accent-2, #7DD7E8)", ...style }} />;
    default:
      return <Wrench size={size} strokeWidth={1.8} className={className} style={{ color: "var(--text-muted)", ...style }} />;
  }
}

type GroupedBlockItem =
  | { type: "single"; item: { block: AssistantContentBlock; originalIndex: number } }
  | { type: "toolGroup"; items: Array<{ block: ToolCallContent; originalIndex: number }> };

function groupAdjacentBlocks(items: Array<{ block: AssistantContentBlock; originalIndex: number }>): GroupedBlockItem[] {
  const result: GroupedBlockItem[] = [];
  let currentGroup: Array<{ block: ToolCallContent; originalIndex: number }> | null = null;

  for (const item of items) {
    if (item.block.type === "toolCall") {
      if (!currentGroup) currentGroup = [];
      currentGroup.push({ block: item.block as ToolCallContent, originalIndex: item.originalIndex });
    } else {
      if (currentGroup) {
        if (currentGroup.length === 1) {
          result.push({ type: "single", item: currentGroup[0] });
        } else {
          result.push({ type: "toolGroup", items: currentGroup });
        }
        currentGroup = null;
      }
      result.push({ type: "single", item });
    }
  }

  if (currentGroup) {
    if (currentGroup.length === 1) {
      result.push({ type: "single", item: currentGroup[0] });
    } else {
      result.push({ type: "toolGroup", items: currentGroup });
    }
  }

  return result;
}

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
  onNavigate?: (entryId: string) => boolean | Promise<boolean>;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
  showTimestamp?: boolean;
  prevTimestamp?: number;
  sessionId?: string;
  toolCallsDefaultCollapsed?: boolean;
  /** omp-reported output throughput (get_state.tokensPerSecond), live while streaming. */
  liveTokensPerSecond?: number | null;
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

export const MessageView = memo(function MessageView({ message, isStreaming, toolResults, modelNames, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, showTimestamp, prevTimestamp, sessionId, toolCallsDefaultCollapsed = true, liveTokensPerSecond }: Props) {
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
      return <CompactionMessageView message={custom} />;
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
    && (!prev.isStreaming || prev.liveTokensPerSecond === next.liveTokensPerSecond);
});

// lib/types.ts ImageContent uses the Anthropic-style {source:{type,data,media_type,url}}
// shape; pi-ai on-disk format uses flat {data, mimeType} — handle both.
function imageBlockSrc(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  return img.source
    ? img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? ""
    : flat.data
      ? `data:${flat.mimeType};base64,${flat.data}`
      : "";
}

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => boolean | Promise<boolean>;
  prevAssistantEntryId?: string;
  onEditContent?: (content: string) => void;
}) {
  const { t, locale } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [actionsActive, setActionsActive] = useState(false);
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
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", maxWidth: "85%", minWidth: 0 }}>
        <div
          className="chat-message-card"
          style={{
            maxWidth: "100%",
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid color-mix(in srgb, var(--accent) 28%, transparent)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
            padding: "8px 12px",
            fontSize: "var(--chat-user-font-size)",
            lineHeight: "var(--chat-line-height)",
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
                const src = imageBlockSrc(img);
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
        {(time || canFork || canNavigate) && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "flex-end",
            gap: 6, marginTop: 3, width: "100%",
          }}>
          <div
            style={{
              display: "flex", gap: 3,
              opacity: hovered || actionsActive ? 1 : 0,
              pointerEvents: hovered || actionsActive ? "auto" : "none",
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
                opacity: (hovered || actionsActive || forking) ? 1 : 0,
                pointerEvents: (hovered || actionsActive || forking) ? "auto" : "none",
                transition: "opacity var(--dur-fast) var(--ease-out-warm)",
              }}
              onFocusCapture={() => setActionsActive(true)}
              onBlurCapture={() => setActionsActive(false)}
            >
              {canNavigate && (
                <Tooltip content={t("messageView.editFromHereTitle")}>
                  <button
                    onClick={async () => { if (!(await onNavigate!(prevAssistantEntryId!))) return; onEditContent?.(content); }}
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
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{time}</span>}
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
  const errorMessage = message.errorMessage?.trim() || null;
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
    if (!toolResults || !message.timestamp || !Array.isArray(message.content)) return map;
    for (const block of message.content) {
      if (block.type === "toolCall") {
        const tc = block as ToolCallContent;
        const result = toolResults.get(tc.toolCallId);
        if (result?.timestamp && message.timestamp) {
          const secs = Math.round((result.timestamp - message.timestamp) / 1000);
          if (secs > 0) map.set(tc.toolCallId, secs);
        }
      }
    }
    return map;
  }, [toolResults, message.content, message.timestamp]);
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

  if (blocks.length === 0 && !isStreaming && !errorMessage) return null;

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
        {errorMessage && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 6,
              padding: "7px 9px",
              border: "1px solid color-mix(in srgb, var(--status-error) 35%, var(--border))",
              borderRadius: "var(--radius-control)",
              background: "color-mix(in srgb, var(--status-error) 7%, var(--bg-panel))",
              color: "var(--status-error)",
              fontSize: 12,
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            <CircleAlert size={14} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
            <span><strong>{t("messageView.responseError")}:</strong> {errorMessage}</span>
          </div>
        )}
        {groupAdjacentBlocks(blockItems).map((group, groupIdx) => {
          if (group.type === "single") {
            const { block, originalIndex } = group.item;
            return (
              <BlockView
                key={`${entryId ?? "stream"}-${originalIndex}`}
                block={block}
                toolResults={toolResults}
                isStreaming={isStreaming}
                streamingDuration={streamingDurations.get(originalIndex) ?? (block.type === "thinking" ? thinkingDurationFromFile : undefined)}
                toolCallDurations={toolCallDurations}
                cwd={cwd}
                onOpenFile={onOpenFile}
                sessionId={sessionId}
                entryId={entryId}
                blockIndex={originalIndex}
                toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
              />
            );
          }
          return (
            <ToolCallGroupBlock
              key={`${entryId ?? "stream"}-group-${groupIdx}`}
              items={group.items}
              toolResults={toolResults}
              isStreaming={isStreaming}
              toolCallDurations={toolCallDurations}
              onOpenFile={onOpenFile}
              toolCallsDefaultCollapsed={toolCallsDefaultCollapsed}
            />
          );
        })}
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
    return <ToolCallBlock block={tc} result={result} duration={duration} isStreaming={isStreaming} defaultCollapsed={toolCallsDefaultCollapsed} onOpenFile={onOpenFile} />;
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
            size={12}
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
          <div className="thinking-details">
            <div
              className={`thinking-output${error ? " thinking-output-error" : ""}`}
            >
              {loading ? t("messageView.loadingThinking") : error ?? (block.deferred ? content : block.thinking)}
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


// message_update frames re-parse toolCall blocks each frame, so input objects
// are never reference-equal; shallow-compare the small input objects instead.
function inputsShallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

const ToolCallBlock = memo(function ToolCallBlock({
  block,
  result,
  duration,
  isStreaming,
  defaultCollapsed = true,
  inGroup = false,
  onOpenFile,
}: {
  block: ToolCallContent;
  result?: ToolResultMessage;
  duration?: number;
  isStreaming?: boolean;
  defaultCollapsed?: boolean;
  cwd?: string;
  inGroup?: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
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
  const resultImages = result && Array.isArray(result.content)
    ? result.content.filter((b): b is ImageContent => b.type === "image")
    : [];
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;
  const resultDiff = expanded && result && !isError ? getResultDiff(result) : null;
  const resultMeta = getToolResultMeta(result);
  const command = formatToolCommand(block);
  const category = getToolCategory(block.toolName);
  const semantic = getSemanticToolLabel(block);
  const todoSummary = category === "todo" ? getTodoSummary(block.input) : null;
  const preview = getToolPreview(block);

  const cleanFilePath = semantic.isFile && typeof block.input === "object" && block.input && "path" in block.input
    ? String((block.input as Record<string, unknown>).path).split(":")[0]
    : null;

  return (
    <div className={inGroup ? "activity-group-item" : "activity-row"} data-activity-operation="true">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className={inGroup ? "activity-group-item-trigger" : "activity-row-trigger"}>
          <span className={`activity-row-indicator${isError ? " activity-row-indicator-error" : ""}`} aria-hidden>
            {isError ? (
              <CircleAlert size={12} strokeWidth={1.8} />
            ) : result ? (
              <Check size={12} strokeWidth={2} />
            ) : isStreaming ? (
              <LoaderCircle size={12} strokeWidth={1.8} className="activity-row-spinner" />
            ) : (
              <CircleSlash size={12} strokeWidth={1.8} style={{ opacity: 0.5 }} />
            )}
          </span>
          <span className="activity-tool-icon" aria-hidden>
            <ToolCategoryIcon category={category} size={12} />
          </span>
          <span className={`activity-row-tool${isError ? " activity-row-tool-error" : ""}`}>{block.toolName}</span>
          <span className="activity-row-preview">
            {cleanFilePath && onOpenFile ? (
              <span
                role="button"
                tabIndex={0}
                className="activity-file-link"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFile(cleanFilePath);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    onOpenFile(cleanFilePath);
                  }
                }}
                title={preview}
              >
                {preview}
              </span>
            ) : (
              preview
            )}
          </span>
          {duration !== undefined && (
            <span className="activity-row-duration">{t("messageView.durationSeconds", { seconds: duration })}</span>
          )}
          <ChevronDown
            size={12}
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
            {todoSummary && (
              <div className="tool-call-todo-badge">
                <span className={`todo-op-tag todo-op-${todoSummary.op}`}>
                  {todoSummary.action}
                </span>
                <span className="todo-task-name">{todoSummary.task ?? todoSummary.label}</span>
              </div>
            )}
            <TaskResultPanel details={result?.details} />
            {result ? (
              resultDiff ? (
                <PairedDiffResult diff={resultDiff} />
              ) : (
                <>
                  {resultImages.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {resultImages.map((img, i) => (
                        <ClickableImage
                          key={i}
                          src={imageBlockSrc(img)}
                          alt=""
                          style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid color-mix(in srgb, var(--accent) 18%, transparent)" }}
                        />
                      ))}
                    </div>
                  )}
                  {!(resultIsEmpty && resultImages.length > 0) && (
                    <PairedResult text={formatToolOutput(resultText ?? "", block.toolName)} isEmpty={resultIsEmpty} isError={isError} />
                  )}
                </>
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
  && inputsShallowEqual(prev.block.input, next.block.input)
  && prev.result === next.result
  && prev.duration === next.duration
  && prev.defaultCollapsed === next.defaultCollapsed
  && prev.inGroup === next.inGroup
  && prev.onOpenFile === next.onOpenFile
));

const ToolCallGroupBlock = memo(function ToolCallGroupBlock({
  items,
  toolResults,
  isStreaming,
  toolCallDurations,
  onOpenFile,
  toolCallsDefaultCollapsed,
}: {
  items: Array<{ block: ToolCallContent; originalIndex: number }>;
  toolResults?: Map<string, ToolResultMessage>;
  isStreaming?: boolean;
  toolCallDurations?: Map<string, number>;
  onOpenFile?: (filePath: string) => void;
  toolCallsDefaultCollapsed: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(!toolCallsDefaultCollapsed);
  const blocks = items.map((i) => i.block);
  const groupSummary = useMemo(() => summarizeToolCallGroup(blocks), [blocks]);

  const hasError = blocks.some((b) => toolResults?.get(b.toolCallId)?.isError);
  const isPending = isStreaming && blocks.some((b) => !toolResults?.has(b.toolCallId));

  const totalDuration = useMemo(() => {
    if (!toolCallDurations) return undefined;
    let sum = 0;
    let counted = 0;
    for (const b of blocks) {
      const d = toolCallDurations.get(b.toolCallId);
      if (d !== undefined) {
        sum += d;
        counted++;
      }
    }
    return counted > 0 ? sum : undefined;
  }, [blocks, toolCallDurations]);

  return (
    <div className="activity-group" data-activity-operation="true">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger className="activity-group-header">
          <span className="activity-group-icon-cluster" aria-hidden>
            {groupSummary.categories.slice(0, 3).map((cat) => (
              <ToolCategoryIcon key={cat} category={cat} size={12} />
            ))}
          </span>
          <span className="activity-group-summary">
            {groupSummary.summaryText}
          </span>
          {totalDuration !== undefined && (
            <span className="activity-row-duration">
              {t("messageView.durationSeconds", { seconds: totalDuration })}
            </span>
          )}
          <span className={`activity-row-indicator${hasError ? " activity-row-indicator-error" : ""}`} aria-hidden>
            {hasError ? (
              <CircleAlert size={12} strokeWidth={1.8} />
            ) : isPending ? (
              <LoaderCircle size={12} strokeWidth={1.8} className="activity-row-spinner" />
            ) : (
              <Check size={12} strokeWidth={2} />
            )}
          </span>
          <ChevronDown
            size={12}
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
          <div className="activity-group-body">
            {items.map(({ block }) => {
              const result = toolResults?.get(block.toolCallId);
              const duration = toolCallDurations?.get(block.toolCallId);
              return (
                <ToolCallBlock
                  key={block.toolCallId}
                  block={block}
                  result={result}
                  duration={duration}
                  isStreaming={isStreaming}
                  defaultCollapsed={true}
                  inGroup={true}
                  onOpenFile={onOpenFile}
                />
              );
            })}
          </div>
        )}
      </Collapsible>
    </div>
  );
}, (prev, next) => (
  prev.items.length === next.items.length
  && prev.items.every((item, i) => item.block.toolCallId === next.items[i]?.block.toolCallId)
  && prev.onOpenFile === next.onOpenFile
  && (!prev.toolResults || !next.toolResults || prev.items.every((item) => prev.toolResults?.get(item.block.toolCallId) === next.toolResults?.get(item.block.toolCallId)))
));


function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t, locale } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp, locale);
  // omp ≥17.4 compaction entries carry the maintenance method and the real
  // post-compaction token count; older sessions only have tokensBefore.
  const details = (message.details ?? null) as { tokensBefore?: unknown; tokensAfter?: unknown; method?: unknown } | null;
  const tokensBefore = typeof details?.tokensBefore === "number" ? details.tokensBefore : null;
  const tokensAfter = typeof details?.tokensAfter === "number" ? details.tokensAfter : null;
  const method = typeof details?.method === "string" && details.method ? details.method : null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", background: "var(--bg)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>{t("messageView.compactionLabel")}</span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>
        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: 15, fontWeight: 700, lineHeight: 1.35 }}>{t("messageView.conversationCompacted")}</div>
          {(method || (tokensBefore !== null && tokensAfter !== null)) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              {method && (
                <span style={{ padding: "1px 7px", borderRadius: 4, background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                  {method}
                </span>
              )}
              {tokensBefore !== null && tokensAfter !== null && (
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                  {t("messageView.compactionTokenDelta", {
                    before: formatCompactNumber(tokensBefore, locale),
                    after: formatCompactNumber(tokensAfter, locale),
                  })}
                </span>
              )}
            </div>
          )}
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: 14, lineHeight: 1.5 }}>{t("messageView.compactionDescription")}</div>
          {parsedSummary.body ? <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("messageView.noSummary")}</span>}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
      </div>
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
