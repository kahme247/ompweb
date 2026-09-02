"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  CustomMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
} from "@/lib/types";
import { normalizeToolCalls } from "@/lib/normalize";
import type { ThinkingModelMeta } from "@/lib/thinking-levels";
import { sendAgentCommand, setSessionAdvisorSpawn } from "@/lib/agent-client";
import { translate } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { createMessageUpdateCoalescer, type MessageUpdateCoalescer } from "@/lib/message-update-coalescer";
import { getToolNamesForPreset, type ToolPreset } from "@/lib/tool-presets";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import { toast } from "@/components/ui/toast";
import { expandWebSlashCommand } from "@/lib/web-slash-commands";
import { validateOutgoingPrompt } from "@/lib/image-attachments";
import { createActiveGoal, parseActiveGoal, type ActiveGoal, type ActivePlan } from "@/lib/web-mode-state";
import type { HostToolDefinition, HostUriSchemeDefinition, RpcAvailableSlashCommand, SessionStatsInfo, TodoPhase } from "@/lib/pi-types";
import { isRecord } from "@/lib/type-guards";
import { subscribeSessionsChanged } from "@/lib/session-change-bus";
import {
  mergeSubagentRoster,
  parseSubagentActivityEvent,
  parseSubagentLifecycle,
  parseSubagentProgress,
  parseSubagentSnapshot,
  type SubagentActivityEvent,
  type SubagentHistoryEntry,
  type SubagentInfo,
  type SubagentProgress,
  type SubagentSnapshotLike,
} from "@/lib/subagent-types";

// SubagentInfo lives in lib/subagent-types (shared with the server-side
// history module); keep the export path stable for components.
export type { SubagentInfo } from "@/lib/subagent-types";

export interface SessionData {
  sessionId: string;
  filePath: string;
  tree: SessionTreeNode[];
  leafId: string | null;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
    todoPhases: TodoPhase[];
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

const SUBAGENT_ACTIVITY_BUFFER_MAX = 50;
// Distinct subagent ids retained in the activity/version maps. Each per-id
// array is already capped, but a long turn can spawn unbounded ids (repeated
// or recursive task calls) — the OUTER maps must be bounded too.
const SUBAGENT_ACTIVITY_MAX_IDS = 64;

/** Keep only the most recently inserted entries of an id-keyed map. */
function pruneSubagentIdMap<T>(map: Record<string, T>): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= SUBAGENT_ACTIVITY_MAX_IDS) return map;
  const next = { ...map };
  let over = keys.length - SUBAGENT_ACTIVITY_MAX_IDS;
  // JS orders integer-like keys (e.g. a digits-only subagent id "12345")
  // numerically before string keys, so insertion order only holds for the
  // non-integer keys. Evict those oldest-first; integer-like keys — whose
  // relative age is unknowable from a plain object — are evicted last so an
  // actively-updated digits-only id is never wrongly pruned.
  const ordered = keys.filter((key) => !/^(?:0|[1-9]\d*)$/.test(key));
  for (const key of ordered) {
    if (over <= 0) break;
    delete next[key];
    over -= 1;
  }
  if (over > 0) {
    for (const key of keys) {
      if (over <= 0) break;
      if (next[key] === undefined) continue;
      delete next[key];
      over -= 1;
    }
  }
  return next;
}

/** Convert a recovered on-disk history entry into roster form. */
function historyEntryToSubagentInfo(entry: SubagentHistoryEntry): SubagentInfo {
  const info: SubagentInfo = {
    id: entry.id,
    agent: entry.agent,
    agentSource: entry.agentSource,
    description: entry.description,
    status: entry.status,
    task: entry.task,
    assignment: entry.assignment,
    index: entry.index,
    parentToolCallId: entry.parentToolCallId,
    batchSeq: entry.batchSeq,
    sessionFile: entry.sessionFile,
    source: "history",
    detached: entry.detached,
    result: entry.result,
  };
  const progress: SubagentProgress = {
    status: entry.status === "started" ? "running" : entry.status,
    task: entry.task,
    assignment: entry.assignment,
    description: entry.description,
    lastIntent: entry.lastIntent,
    toolCount: entry.toolCount,
    requests: entry.requests,
    tokens: entry.tokens,
    contextTokens: entry.contextTokens,
    contextWindow: entry.contextWindow,
    cost: entry.cost,
    durationMs: entry.durationMs,
    modelOverride: entry.modelOverride,
    modelRole: entry.modelRole,
    resolvedModel: entry.resolvedModel,
    resolvedModelIsFallback: entry.resolvedModelIsFallback,
    retryFailure: entry.retryFailure,
  };
  info.progress = progress;
  return info;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

// Shape of lib/rpc-manager's WebSessionState as seen over HTTP.
type AgentStateResponse = {
  // Raw get_state passthrough: the resolved model omp is actually running.
  model?: { provider: string; id: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  autoRetryEnabled?: boolean;
  interruptMode?: "immediate" | "wait";
  autoCompactionEnabled?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  tokensPerSecond?: number | null;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  // omp only reports a count; the queued texts are tracked client-side.
  queuedMessageCount?: number;
  todoPhases?: TodoPhase[];
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

const EMPTY_QUEUE: QueuedMessages = { steering: [], followUp: [] };

// omp reports only queuedMessageCount over RPC; the queued texts live in React
// state and would vanish on reload. Mirror them into sessionStorage (per
// session, best-effort, size-bounded) so a reload can restore the queue panel.
const QUEUE_STORAGE_PREFIX = "omp-queue-";
const QUEUE_STORAGE_MAX_CHARS = 50_000;

function isEmptyQueue(queue: QueuedMessages): boolean {
  return queue.steering.length === 0 && queue.followUp.length === 0;
}

function readPersistedQueue(sessionId: string): QueuedMessages | null {
  try {
    const raw = sessionStorage.getItem(QUEUE_STORAGE_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QueuedMessages> | null;
    const onlyStrings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const queue = { steering: onlyStrings(parsed?.steering), followUp: onlyStrings(parsed?.followUp) };
    return isEmptyQueue(queue) ? null : queue;
  } catch {
    return null;
  }
}

function persistQueue(sessionId: string, queue: QueuedMessages): void {
  try {
    const key = QUEUE_STORAGE_PREFIX + sessionId;
    if (isEmptyQueue(queue)) {
      sessionStorage.removeItem(key);
      return;
    }
    // Size bound: drop oldest texts until the payload fits.
    let bounded = queue;
    let raw = JSON.stringify(bounded);
    while (raw.length > QUEUE_STORAGE_MAX_CHARS && bounded.steering.length + bounded.followUp.length > 1) {
      bounded = bounded.steering.length >= bounded.followUp.length
        ? { ...bounded, steering: bounded.steering.slice(1) }
        : { ...bounded, followUp: bounded.followUp.slice(1) };
      raw = JSON.stringify(bounded);
    }
    if (raw.length > QUEUE_STORAGE_MAX_CHARS) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, raw);
  } catch {
    // Best-effort only (quota exceeded, private mode, SSR).
  }
}

function clearPersistedQueue(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    sessionStorage.removeItem(QUEUE_STORAGE_PREFIX + sessionId);
  } catch {
    // ignore storage errors
  }
}

function normalizeThinkingLevel(level: string | undefined): ThinkingLevelOption {
  // omp's "inherit" sentinel means "no explicit selection" — show as auto.
  if (!level || level === "inherit") return "auto";
  return level as ThinkingLevelOption;
}

/** Narrow the live state's model (OmpModel: id-based) to the composer's shape. */
function toThinkingModelMeta(model: { provider?: string; id?: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } } | null | undefined): ThinkingModelMeta | null {
  if (!model?.provider || !model.id) return null;
  return { provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning, thinking: model.thinking };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
// omp's rpc-ui frames add open_url (OAuth) and cancel on top of lib/types' union.
type IncomingExtensionUiRequest =
  | ExtensionUiRequest
  | { type: "extension_ui_request"; id: string; method: "open_url"; url: string; launchUrl?: string; instructions?: string }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string };
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats"; retainInput?: boolean };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  advisorEnabled?: boolean;
  onAgentEnd?: () => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  modelsRefreshKey?: number;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  /** Registers an action that lazily starts the session and loads its system prompt. */
  onSystemPromptLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
  /** Opens a file in the web UI's file viewer (used by the open_file host tool). */
  onOpenFile?: (filePath: string, name: string, sessionId?: string) => void;
}

export type ThinkingLevelOption = string;

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
// A cold `omp --mode rpc-ui` spawn (extension + skill + LSP discovery) can take
// far longer than a few seconds, and the SSE route may only answer once the
// child is ready. Give up only after the child would have timed out anyway
// (rpc-process waitReady is 120s server-side) rather than dropping the prompt.
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 60_000;
// Tell the user something is happening if the stream is still connecting.
const EVENT_STREAM_SLOW_CONNECT_MS = 4_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? translate("agentSession.eventStreamTimeout")
      : translate("agentSession.eventStreamFailed"));
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Shared guard for URLs opened from agent/extension open_url requests. Allows
 * only http, https and mailto; rejects javascript:, data:, vbscript:, file:,
 * protocol-relative (//...) and any other scheme so a hostile or malformed URL
 * cannot escape the browser. Preserves existing behavior for safe URLs.
 */
function isSafeOpenUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const url = raw.trim();
  if (!url) return false;
  // Protocol-relative (//host/...) — ambiguous scheme, reject.
  if (url.startsWith("//")) return false;
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (!match) return false;
  const scheme = match[1].toLowerCase();
  return scheme === "http" || scheme === "https" || scheme === "mailto";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function describeMcpMountNotice(message: CustomMessage): string {
  return extractMessageText(message).trim() || "The MCP tool inventory changed.";
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number") return null;
  // The server estimates estimatedTokensAfter from the summary when omp's
  // CompactionResult omits it; default to 0 as a last resort.
  return {
    reason,
    tokensBefore: r.tokensBefore,
    estimatedTokensAfter: typeof r.estimatedTokensAfter === "number" ? r.estimatedTokensAfter : 0,
  };
}

/** Shared construction for an outgoing prompt: the optimistic user bubble
 * (display shape with nested image blocks) and omp's RPC payload shape
 * (flat image objects). Used by both handleSend and handleInterruptAndReply
 * so the two paths cannot drift apart. */
function buildOutgoingPrompt(
  message: string,
  images?: AttachedImage[],
): { userMsg: AgentMessage; piImages: { type: "image"; data: string; mimeType: string }[] | undefined } {
  const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
  const userMsg: AgentMessage = {
    role: "user",
    content: imageBlocks?.length
      ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
      : message,
    timestamp: Date.now(),
  };
  const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
  return { userMsg, piImages };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  prependText: (text: string) => void;
  addFiles: (files: File[]) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string; supportsFastMode?: boolean; contextWindow?: number; maxTokens?: number };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  modelError?: string;
};

type SlashCommandsResponse = {
  commands?: RpcAvailableSlashCommand[];
};

// Map omp's slash-command sources onto the palette's grouping. Builtins are
// skipped: the client intercepts its own builtin set, and other omp builtins
// still work when typed (omp executes them via the prompt command).
function toSlashCommandInfo(command: RpcAvailableSlashCommand): SlashCommandInfo | null {
  if (command.source === "builtin") return null;
  const source: SlashCommandInfo["source"] = command.source === "extension"
    ? "extension"
    : command.source === "skill"
      ? "skill"
      : "prompt";
  return { name: command.name, description: command.description, source };
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, onAgentEnd, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemPromptLoaderChange, onSessionStatsPanelOpen,
    onOpenFile,
  } = opts;
  const reducedMotion = usePrefersReducedMotion();
  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [showPreCompactionHistory, setShowPreCompactionHistory] = useState(false);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  // False once this hook instance unmounts: background loops (prompt/bash
  // settlement polling) must not keep firing on a dead instance.
  const hookAliveRef = useRef(true);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [liveModelMeta, setLiveModelMeta] = useState<ThinkingModelMeta | null>(null);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  // Start at the default for SSR; hydrate from localStorage in an effect
  // to avoid a server/client mismatch when the user stored a different preset.
  const [toolPreset, setToolPreset] = useState<ToolPreset>("full");
  useEffect(() => { setToolPreset(getPreferredToolPreset()); }, []);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [fastModeEnabled, setFastModeEnabled] = useState(false);
  const [fastModeActive, setFastModeActive] = useState<boolean | undefined>(undefined);
  // Runtime session modes returned by get_state and changed via RPC
  // (set_interrupt_mode / set_auto_compaction).
  const [interruptMode, setInterruptMode] = useState<"immediate" | "wait">("immediate");
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState(true);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState(false);
  // Queue delivery modes (set_steering_mode / set_follow_up_mode).
  const [steeringMode, setSteeringMode] = useState<"all" | "one-at-a-time">("all");
  const [followUpMode, setFollowUpMode] = useState<"all" | "one-at-a-time">("all");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  // omp's own output throughput from get_state. omp reports a number only
  // when it has throughput data (typically around generation); null otherwise.
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const extensionDialogClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (extensionDialogClearTimerRef.current) clearTimeout(extensionDialogClearTimerRef.current);
  }, []);
  const terminalReconcileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTerminalReconcileTimer = useCallback(() => {
    if (terminalReconcileTimerRef.current) {
      clearTimeout(terminalReconcileTimerRef.current);
      terminalReconcileTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => {
    clearTerminalReconcileTimer();
  }, [clearTerminalReconcileTimer]);
  // Blocks prompt submission while the initial hydration's live-state fetch is
  // still pending. Without this, showLoading=false after disk messages lets
  // a prompt increment runId before the stale pre-prompt state arrives and
  // clobbers the new run's derived state (model/fast-mode).
  const initialHydrationPendingRef = useRef(false);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [subagentEvents, setSubagentEvents] = useState<Record<string, SubagentActivityEvent[]>>({});
  const [subagentTranscriptVersions, setSubagentTranscriptVersions] = useState<Record<string, number>>({});
  const [todoPhases, setTodoPhases] = useState<TodoPhase[]>([]);
  const [activeGoal, setActiveGoal] = useState<ActiveGoal | null>(null);
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null);
  const [advisorActiveAt, setAdvisorActiveAt] = useState(0);
  // Advisor is a per-chat toggle (composer Sparkles + /advisor command), not a
  // global setting: each session remembers its own choice in localStorage.
  const [advisorEnabled, setAdvisorEnabled] = useState(false);
  const activeSubagentCount = subagents.filter((subagent) => subagent.source !== "history" && subagent.status === "started").length;

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  // Guards stale branch/leaf context responses: two rapid navigate clicks must
  // not let the older response overwrite the newer branch's messages.
  const contextRequestSeqRef = useRef(0);
  // Mirror of the isCompacting state that survives render batching, so two
  // clicks in the same tick cannot double-send a compact command.
  const isCompactingRef = useRef(false);
  // Set while an interrupt-and-reply (abort_and_prompt) is in flight: the
  // aborted turn's terminal agent_end must not tear down the new run that is
  // starting. Cleared on the new run's agent_start (or the intercept itself).
  const interruptReplyPendingRef = useRef(false);
  // Timestamp of the last client-side queue mutation (steer/follow-up sent).
  // get_state snapshots may lag behind the RPC round-trip, so a snapshot
  // reporting queuedMessageCount === 0 must not wipe a queue we just wrote.
  const queueMutatedAtRef = useRef(0);
  const agentRunningRef = useRef(false);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(false);
  const pendingScrollToUserRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  // Raw child-session events stream at token rate; coalesce the per-subagent
  // revision bumps to one per animation frame so an open dialog only re-pages
  // once per frame instead of per event.
  const subagentVersionFlushRef = useRef<Set<string> | null>(null);
  const subagentActivityFlushRef = useRef<Map<string, SubagentActivityEvent[]> | null>(null);
  const subagentVersionFlushFrameRef = useRef<number | null>(null);
  const wasRunningForGaugeRef = useRef(false);
  // so a stale get_subagents cannot target a session that was switched away.
  const rosterRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptRunIdRef = useRef(0);
  // Bumped on every roster clear (run end): in-flight get_subagents/history
  // responses from the finished run must not merge into the cleared (or next
  // run's) roster. The prompt runId alone is not enough — it is not
  // invalidated on terminal.
  const subagentRosterGenerationRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  // True once this mount has persisted a non-empty queue: gates removal so a
  // just-mounted empty state cannot wipe a stored queue before restore runs.
  const queuePersistDirtyRef = useRef(false);
  const eventCoalescerRef = useRef<MessageUpdateCoalescer | null>(null);
  if (eventCoalescerRef.current === null) {
    eventCoalescerRef.current = createMessageUpdateCoalescer((event) => {
      handleAgentEventRef.current?.(event as AgentEvent);
    });
  }
  const eventCoalescer = eventCoalescerRef.current;

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  // For existing sessions, the live state's resolved model wins over the
  // session file's entry: omp may have fallen back to the default model when
  // the recorded one is gone (disabled provider, renamed id), and the file
  // entry then describes a model that is not actually running. pendingModel
  // stays at the bottom (below the file entry) — it only fills the gap while
  // a brand-new session has no file data yet, and a failed new-session
  // set_model must not mask omp's actual resolved model.
  const displayModel = useMemo(
    () =>
      isNew
        ? (newSessionModel ?? newSessionDefaultModel)
        : (currentModelOverride ?? (liveModelMeta
            ? { provider: liveModelMeta.provider, modelId: liveModelMeta.modelId }
            : data?.context.model ?? pendingModel)),
    [isNew, newSessionModel, newSessionDefaultModel, currentModelOverride, liveModelMeta, data?.context.model, pendingModel],
  );

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) return sessionStatsOverride;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, session?.id, session?.name]);

  // Goal mode is web-hosted because omp's native /goal is TUI-only. Keep it
  // scoped to its session so switching conversations never leaks objectives.
  useEffect(() => {
    const sid = session?.id;
    setActivePlan(null);
    if (!sid) {
      setActiveGoal(null);
      return;
    }
    setActiveGoal(parseActiveGoal(sessionStorage.getItem(`omp-web:goal:${sid}`)));
  }, [session?.id]);

  // A plan request is in progress only for its current agent turn.
  useEffect(() => {
    if (!agentRunning) setActivePlan(null);
  }, [agentRunning]);

  // First phase that still has unfinished work; null once everything is done
  // (or no todo list exists), which hides the status-line suffix.
  const currentTodoPhase = useMemo(() => {
    for (let index = 0; index < todoPhases.length; index++) {
      const phase = todoPhases[index];
      const tasks = Array.isArray(phase?.tasks) ? phase.tasks : [];
      const done = tasks.filter((task) => task.status === "completed").length;
      if (tasks.some((task) => task.status === "pending" || task.status === "in_progress")) {
        return { name: phase.name, index: index + 1, phaseCount: todoPhases.length, done, total: tasks.length };
      }
    }
    return null;
  }, [todoPhases]);
  // Load the per-session advisor choice on session switch; brand-new chats
  // start disabled until the user toggles the composer icon.
  useEffect(() => {
    const sid = session?.id;
    if (!sid) {
      setAdvisorEnabled(false);
      return;
    }
    let stored = false;
    try {
      stored = localStorage.getItem(`omp-advisor-enabled:${sid}`) === "true";
    } catch {
      stored = false;
    }
    setAdvisorEnabled(stored);
    // The spawn registry must match before any command POST can lazily start
    // the omp process; localStorage alone would leave resumed sessions dark.
    setSessionAdvisorSpawn(sid, stored);
  }, [session?.id]);

  const handleAdvisorChange = useCallback((enabled: boolean) => {
    setAdvisorEnabled(enabled);
    const sid = sessionIdRef.current;
    if (!sid) return;
    setSessionAdvisorSpawn(sid, enabled);
    try {
      localStorage.setItem(`omp-advisor-enabled:${sid}`, String(enabled));
    } catch {
      // In-memory state still applies for this page load.
    }
  }, []);

  // Merge a batch of roster entries; ordering and live-over-history precedence
  // live in `mergeSubagentRoster` so both rules stay testable outside React.
  const mergeSubagents = useCallback((incoming: SubagentInfo[], options?: { skipNewerThan?: number }) => {
    if (!incoming.length) return;
    const generation = subagentRosterGenerationRef.current;
    const runId = promptRunIdRef.current;
    const sid = sessionIdRef.current;
    setSubagents((prev) => {
      if (subagentRosterGenerationRef.current !== generation || promptRunIdRef.current !== runId || sessionIdRef.current !== sid) return prev;
      return mergeSubagentRoster(prev, incoming, options?.skipNewerThan);
    });
  }, []);

  // Recover the ON-DISK roster from the parent session's task toolResults.
  // Survives page reloads and shows finished runs from previous sessions.
  const refreshSubagentHistory = useCallback(async (sid: string) => {
    const generation = subagentRosterGenerationRef.current;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/subagents`);
      if (!res.ok) return;
      const data = await res.json() as { subagents?: SubagentHistoryEntry[] };
      // Fence AFTER the awaited json: the session or roster generation may
      // have changed while the response was in flight.
      if (sessionIdRef.current !== sid || subagentRosterGenerationRef.current !== generation) return;
      const entries = (data.subagents ?? []).map(historyEntryToSubagentInfo);
      mergeSubagents(entries);
    } catch {
      // Best effort; live frames take precedence while a run is active.
    }
  }, [mergeSubagents]);

  // Hydrate the LIVE roster from get_subagents. The registry only holds
  // currently-running subagents, so this fills gaps after an SSE reconnect or
  // a missed lifecycle frame; it never reports finished runs.
  const refreshSubagentRoster = useCallback(async (sid: string) => {
    const requestedAt = Date.now();
    const runId = promptRunIdRef.current;
    const generation = subagentRosterGenerationRef.current;
    try {
      const result = await sendAgentCommand<{ subagents?: SubagentSnapshotLike[] }>(sid, { type: "get_subagents" });
      // Fence: the request may resolve after the user switched sessions, the
      // run ended and a new prompt started, or the roster was cleared — its
      // snapshot belongs to a different roster generation and must not merge
      // or prune the new one.
      if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId || subagentRosterGenerationRef.current !== generation) return;
      const snapshots = (result.subagents ?? [])
        .map(parseSubagentSnapshot)
        .filter((subagent): subagent is SubagentInfo => subagent !== undefined);
      // The snapshot is a point-in-time view: never overwrite entries that
      // live frames updated after the request was made (their state is newer).
      mergeSubagents(snapshots, { skipNewerThan: requestedAt });
      // The registry deletes a subagent before get_subagents returns once its
      // lifecycle is terminal, so a live entry missing from the snapshot means
      // a terminal frame was missed over SSE. Drop it; history recovery and
      // fresh lifecycle frames remain authoritative for other entries. Entries
      // updated AFTER the snapshot was requested are newer than the registry
      // state we got and must survive the prune.
      const liveIds = new Set(snapshots.map((s) => s.id));
      setSubagents((prev) => {
        const next = prev.filter((s) => s.source !== "live" || liveIds.has(s.id) || (s.lastUpdate ?? 0) >= requestedAt);
        return next.length === prev.length ? prev : next;
      });
      // Mid-run disk history can gain completed task calls that live frames
      // missed (a child finishing before the subscription attached is deleted
      // from the registry) — re-check so such children appear before agent_end.
      void refreshSubagentHistory(sid);
    } catch {
      // Best effort: subagent_lifecycle/progress frames are the primary source.
    }
  }, [mergeSubagents, refreshSubagentHistory]);

  // Clear per-run activity state at run end. MUST also cancel the pending
  // version-flush rAF: a queued subagent_event flush would otherwise repopulate
  // the version map for dead subagent ids right after the clear.
  const resetSubagentActivityState = useCallback(() => {
    if (subagentVersionFlushFrameRef.current !== null) {
      cancelAnimationFrame(subagentVersionFlushFrameRef.current);
      subagentVersionFlushFrameRef.current = null;
    }
    subagentVersionFlushRef.current = null;
    subagentActivityFlushRef.current = null;
    setSubagentEvents({});
    setSubagentTranscriptVersions({});
  }, []);

  // Monotonic sequence for authoritative model syncs. Every async sync
  // (state fetch, model_changed GET) captures a token at START and only
  // applies its snapshot if it is still the newest — a slow stale response
  // can never clobber a newer one (e.g. an old model_changed GET landing
  // after the user picked another model).
  const authoritativeModelSeqRef = useRef(0);
  const beginAuthoritativeModelSync = useCallback((): number => {
    authoritativeModelSeqRef.current += 1;
    return authoritativeModelSeqRef.current;
  }, []);

  // Authoritative resolved-model sync (model_changed / config_update events,
  // post-command refreshes). A runtime model switch (retry-fallback, prewalk
  // hand-off, /model) supersedes the user's last explicit pick — the composer
  // must reflect the model actually running. `token` guards stale async
  // snapshots; synchronous event payloads apply unconditionally. Returns
  // whether the snapshot was applied — callers must drop ALL state derived
  // from a stale response (including its thinking level), not just the model.
  const applyAuthoritativeModel = useCallback((model: ThinkingModelMeta | null, token?: number): boolean => {
    if (token !== undefined && token !== authoritativeModelSeqRef.current) return false;
    authoritativeModelSeqRef.current += 1;
    setLiveModelMeta(model);
    if (!model) return true;
    setCurrentModelOverride((prev) =>
      prev && (prev.provider !== model.provider || prev.modelId !== model.modelId) ? null : prev
    );
    return true;
  }, []);

  // Lightweight live-state sync after composer commands. A command against an
  // idle-disposed session restarts omp, which re-resolves the model from the
  // session file — the freshly resolved model (and clamped thinking level)
  // must reach the composer so the ladder/active level match reality.
  const refreshLiveModelState = useCallback(async (sid: string) => {
    const token = beginAuthoritativeModelSync();
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
      if (!res.ok) return;
      const agentState = await res.json() as { running: boolean; state?: AgentStateResponse };
      if (sessionIdRef.current !== sid) return;
      const applied = applyAuthoritativeModel(toThinkingModelMeta(agentState.state?.model), token);
      if (!applied) return; // stale snapshot — drop its thinking level too
      if (agentState.state?.thinkingLevel !== undefined) {
        setThinkingLevel(normalizeThinkingLevel(agentState.state.thinkingLevel));
      }
      // Fast mode is family-scoped in omp: switching to a fast-supported
      // model flips the child's state without any event, so the composer
      // toggle must re-sync from the refreshed state.
      if (agentState.state?.fastModeEnabled !== undefined) {
        setFastModeEnabled(agentState.state.fastModeEnabled);
      }
      setFastModeActive(agentState.state?.fastModeActive);
      if (agentState.state?.autoRetryEnabled !== undefined) setAutoRetryEnabled(agentState.state.autoRetryEnabled);
      if (agentState.state?.interruptMode !== undefined) setInterruptMode(agentState.state.interruptMode);
      if (agentState.state?.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(agentState.state.autoCompactionEnabled);
      if (agentState.state?.steeringMode !== undefined) setSteeringMode(agentState.state.steeringMode);
      if (agentState.state?.followUpMode !== undefined) setFollowUpMode(agentState.state.followUpMode);
    } catch {
      // Best effort; the next loadSession/reconcile re-syncs.
    }
  }, [applyAuthoritativeModel, beginAuthoritativeModelSync]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false, fenceRunId?: number) => {
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid) return null;
      // A terminal reload for a finished run must not overwrite the messages
      // of a run that started while this fetch was in flight (it would delete
      // the new run's optimistic user bubble).
      if (fenceRunId !== undefined && promptRunIdRef.current !== fenceRunId) return null;
      setData(d);
      setActiveLeafId(d.leafId);
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setShowPreCompactionHistory(false);
      setTodoPhases(d.context.todoPhases ?? []);
      // Recover on-disk subagent history (task toolResults) for this session —
      // populates the composer roster for finished/past runs.
      void refreshSubagentHistory(sid);
      setCurrentModelOverride(null);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) {
        return null;
      }

      // Track initial hydration so prompt submission waits for the live state.
      const isInitialHydration = showLoading && includeState;
      if (isInitialHydration) initialHydrationPendingRef.current = true;

      try {
        // Capture the sequence token BEFORE the fetch: a response snapshotted
        // earlier must not mint a fresh token on arrival and clobber a newer
        // sync that started while this request was in flight.
        const token = beginAuthoritativeModelSync();
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) {
          if (showLoading) setLoading(false);
          return null;
        }
        if (fenceRunId !== undefined && promptRunIdRef.current !== fenceRunId) {
          if (showLoading) setLoading(false);
          return null;
        }

        const liveState = agentState.state;
        const modelApplied = applyAuthoritativeModel(toThinkingModelMeta(liveState?.model), token);
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt || null);
          if (modelApplied && liveState.thinkingLevel !== undefined) setThinkingLevel(normalizeThinkingLevel(liveState.thinkingLevel));
          if (liveState.fastModeEnabled !== undefined) setFastModeEnabled(liveState.fastModeEnabled);
          setFastModeActive(liveState.fastModeActive);
          if (liveState.autoRetryEnabled !== undefined) setAutoRetryEnabled(liveState.autoRetryEnabled);
          if (liveState.interruptMode !== undefined) setInterruptMode(liveState.interruptMode);
          if (liveState.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(liveState.autoCompactionEnabled);
          if (liveState.steeringMode !== undefined) setSteeringMode(liveState.steeringMode);
          if (liveState.followUpMode !== undefined) setFollowUpMode(liveState.followUpMode);
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.todoPhases !== undefined) setTodoPhases(liveState.todoPhases ?? []);
          if (liveState.queuedMessageCount === 0 && Date.now() - queueMutatedAtRef.current >= 5000) setQueuedMessages(EMPTY_QUEUE);
        } else if (!agentState.running && Date.now() - queueMutatedAtRef.current >= 5000) {
          setQueuedMessages(EMPTY_QUEUE);
        }
        if (showLoading) setLoading(false);
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        if (showLoading) setLoading(false);
        return null;
      } finally {
        if (isInitialHydration) initialHydrationPendingRef.current = false;
      }
    } catch (e) {
      // loadSession runs fire-and-forget as a background reconciler (file
      // watcher, agent_end, bash, compaction) with showLoading=false. A
      // transient failure there must not replace the chat with an error
      // screen — only surface it when the user is actively waiting.
      if (showLoading) setError(String(e));
      else console.warn("Background loadSession failed:", e);
      if (showLoading && includeState) initialHydrationPendingRef.current = false;
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
      // Ensure the flag is cleared even if the pre-state early-return path was taken
      if (showLoading && includeState && !messagesLoaded) initialHydrationPendingRef.current = false;
    }
  }, [refreshSubagentHistory, applyAuthoritativeModel, beginAuthoritativeModelSync]);

  const loadContext = useCallback(async (sid: string, leafId: string | null, includePreCompaction = false): Promise<boolean> => {
    const seq = ++contextRequestSeqRef.current;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      if (includePreCompaction) params.set("includePreCompaction", "1");
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: { messages: AgentMessage[]; entryIds: string[]; todoPhases: TodoPhase[] } };
      // Fence like loadSession: drop the response if the session changed or a
      // newer navigate started while this request was in flight.
      if (sessionIdRef.current !== sid || contextRequestSeqRef.current !== seq) return false;
      setMessages(d.context.messages);
      setEntryIds(d.context.entryIds ?? []);
      setShowPreCompactionHistory(includePreCompaction);
      setTodoPhases(d.context.todoPhases ?? []);
    } catch (e) {
      console.error("Failed to load context:", e);
      return false;
    }
    return true;
  }, []);

  const togglePreCompactionHistory = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    void loadContext(sid, activeLeafId, !showPreCompactionHistory);
  }, [activeLeafId, loadContext, showPreCompactionHistory]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage?: string) => {
    firstMessage ??= translate("agentSession.noMessages");
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      const selectedModel = newSessionModel ?? newSessionDefaultModel;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(thinkingLevel !== "auto" ? { thinkingLevel } : {}),
          ...(advisorEnabled ? { advisor: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as { sessionId: string };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      // The toggle handler could not persist while the chat had no id; carry
      // the pre-prompt choice over so it survives a reload after this point.
      if (advisorEnabled) {
        setSessionAdvisorSpawn(realId, true);
        try {
          localStorage.setItem(`omp-advisor-enabled:${realId}`, "true");
        } catch {
          // Best-effort: the spawned process already has --advisor.
        }
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [advisorEnabled, isNew, newSessionCwd, newSessionModel, newSessionDefaultModel, toolPreset, thinkingLevel]);

  // The system panel may initialize a dormant session, but must not create a
  // prompt or model run just to inspect the resolved system prompt.
  const loadSystemPrompt = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;

    const state = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
    if (!hookAliveRef.current || sessionIdRef.current !== sid) return;
    setSystemPrompt(state.systemPrompt ?? "");
  }, [ensureNewSession]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = (data?.commands ?? [])
        .map(toSlashCommandInfo)
        .filter((c): c is SlashCommandInfo => c !== null);
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  // A session omp is writing outside the web UI has no RPC stream to deliver
  // its turns, so reload the transcript when the watcher reports that this
  // session's file grew. Skipped while an event stream is attached: that
  // stream is already the authority and a reload would fight it.
  useEffect(() => {
    return subscribeSessionsChanged((sessionIds) => {
      const sid = sessionIdRef.current;
      if (!sid || eventSourceRef.current || !sessionIds.includes(sid)) return;
      void loadSession(sid);
    });
  }, [loadSession]);

  // Reconnect actions captured after their definitions (host-tool and URI
  // registrations are per-wrapper and are not persisted by omp, and the
  // roster needs a fresh get_subagents snapshot) so the fatal-error reconnect
  // below can restore everything the mount flow sets up — not just the stream.
  const reconnectActionsRef = useRef<((sid: string) => void) | null>(null);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    // A pending coalesced update belongs to the stream being replaced.
    eventCoalescer.reset();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      // The stream is live as soon as the response headers land, whether or not
      // the server also sends an explicit `connected` frame.
      es.onopen = () => settle("connected");

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "connected") settle("connected");
          // message_update frames arrive at network rate (often 30-100+/s);
          // the coalescer buffers the latest one and dispatches at display
          // rate, flushing synchronously before any other event type.
          eventCoalescer.push(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions. Keep the timer in a ref so unmount or a
          // session switch cancels it — otherwise an orphaned stream respawns
          // (and can 404-loop) after the hook is torn down.
          settle("closed");
          if (eventSourceRef.current === es && agentRunningRef.current) {
            eventSourceRef.current = null;
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              if (agentRunningRef.current && sessionIdRef.current === sid) {
                void connectEvents(sid);
                // The reconnect restores the event stream, but host tools, URI
                // schemes, and the subagent roster were registered on the old
                // connection — re-register them so the agent keeps working.
                reconnectActionsRef.current?.(sid);
              }
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
  }, [eventCoalescer]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      setExtensionDialog((current) => current?.id === request.id ? null : current);
      return;
    }
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    } finally {
      // OMP commonly emits the next Ask select immediately after this response.
      // Keep the current panel mounted for a short hand-off window so the composer
      // never flashes empty between sequential questions.
      if (extensionDialogClearTimerRef.current) clearTimeout(extensionDialogClearTimerRef.current);
      extensionDialogClearTimerRef.current = setTimeout(() => {
        setExtensionDialog((current) => current?.id === request.id ? null : current);
        extensionDialogClearTimerRef.current = null;
      }, 250);
    }
  }, []);

  // ---------------------------------------------------------------------
  // Host-tool bridge: omp-web registers tools the AGENT can call. The server
  // emits host_tool_call frames; this UI executes them and answers with
  // host_tool_result (lib/rpc-manager routes registered tools to listeners).
  // The built-in `ask` tool already covers user questions via the extension
  // UI protocol, so we only register web-UI-specific capabilities.
  // ---------------------------------------------------------------------
  const HOST_TOOL_DEFINITIONS = useMemo<HostToolDefinition[]>(() => [
    {
      name: "open_url",
      description: "Open a URL in the user's browser.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
    {
      name: "notify",
      description: "Show a browser notification to the user.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string", description: "Optional notification body." },
        },
        required: ["title"],
      },
    },
    {
      name: "open_file",
      description: "Open a file in the workspace file viewer.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute or workspace-relative file path." } },
        required: ["path"],
      },
    },
  ], []);

  /** Re-register host tools on run start / SSE reconnect so the agent always
   * has them available (set_host_tools is per-wrapper, not persisted). */
  const registerHostTools = useCallback(async (sid: string) => {
    try {
      await sendAgentCommand(sid, { type: "set_host_tools", tools: HOST_TOOL_DEFINITIONS });
    } catch {
      // Older omp builds without host tools: the UI simply stays passive.
    }
  }, [HOST_TOOL_DEFINITIONS]);

  /** URI schemes the agent's read/write tools can resolve through the web UI.
   * `pi-web://clipboard` lets the agent read the user's clipboard (best-effort:
   * the browser may gate clipboard reads behind a permission prompt) and copy
   * text back. */
  const HOST_URI_SCHEMES = useMemo<HostUriSchemeDefinition[]>(() => [
    {
      scheme: "pi-web",
      description: "Browser-integrated resources: pi-web://clipboard reads/writes the user's clipboard via the web UI.",
      writable: true,
    },
  ], []);

  const registerHostUriSchemes = useCallback(async (sid: string) => {
    try {
      await sendAgentCommand(sid, { type: "set_host_uri_schemes", schemes: HOST_URI_SCHEMES });
    } catch {
      // Older omp builds: no URI bridge, nothing to do.
    }
  }, [HOST_URI_SCHEMES]);

  reconnectActionsRef.current = (sid: string) => {
    void registerHostTools(sid);
    void registerHostUriSchemes(sid);
    void refreshSubagentRoster(sid);
  };

  /** Answer a host_tool_call with a toolResult payload. */
  const respondHostTool = useCallback(async (sid: string, id: string, text: string, isError = false) => {
    try {
      await sendAgentCommand(sid, {
        type: "host_tool_result",
        id,
        isError,
        result: { content: [{ type: "text", text }] },
      });
    } catch (e) {
      console.error("Failed to send host tool result:", e);
    }
  }, []);

  const handleHostToolCall = useCallback(async (id: string, toolName: string, args: Record<string, unknown>) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    switch (toolName) {
      case "open_url": {
        const raw = typeof args.url === "string" ? args.url : "";
        const safe = isSafeOpenUrl(raw);
        const url = safe ? raw : "";
        if (url && typeof window !== "undefined") {
          const opened = window.open(url, "_blank", "noopener,noreferrer");
          opened?.focus?.();
        }
        const message = safe ? (raw ? `Opened ${raw}` : "No URL provided") : "Unsafe or invalid URL not opened";
        await respondHostTool(sid, id, message, !safe && !!raw);
        break;
      }
      case "notify": {
        const title = str(args.title) ?? "OMP";
        const message = str(args.message) ?? "";
        if (typeof Notification !== "undefined") {
          try {
            if (Notification.permission === "granted") {
              new Notification(title, { body: message });
            } else if (Notification.permission === "default") {
              const permission = await Notification.requestPermission();
              if (permission === "granted") new Notification(title, { body: message });
            }
          } catch {
            // Notification API blocked — the result still succeeds.
          }
        }
        await respondHostTool(sid, id, "Notification shown");
        break;
      }
      case "open_file": {
        const path = str(args.path) ?? "";
        if (path && onOpenFile) {
          try {
            const name = path.split(/[\\/]/).pop() || path;
            onOpenFile(path, name, sid);
          } catch {
            // ignore navigation failures
          }
        }
        await respondHostTool(sid, id, path ? `Opened ${path}` : "No path provided", !path);
        break;
      }
      default:
        await respondHostTool(sid, id, `Host tool \"${toolName}\" is not available in omp-web`, true);
    }
  }, [onOpenFile, respondHostTool]);

  /** Answer a host_uri_request (agent read/write of a registered scheme). */
  const respondHostUri = useCallback(async (sid: string, id: string, frame: { content?: string; contentType?: "text/markdown" | "application/json" | "text/plain"; isError?: boolean; error?: string }) => {
    try {
      await sendAgentCommand(sid, { type: "host_uri_result", id, ...frame });
    } catch (e) {
      console.error("Failed to send host URI result:", e);
    }
  }, []);

  const handleHostUriRequest = useCallback(async (id: string, operation: "read" | "write", url: string, content?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const resource = url.replace(/^pi-web:\/\//i, "") || "";
    if (resource === "clipboard") {
      if (operation === "read") {
        if (typeof navigator === "undefined" || !navigator.clipboard?.readText) {
          await respondHostUri(sid, id, { isError: true, error: "Clipboard read is not available in this browser" });
          return;
        }
        try {
          const text = await navigator.clipboard.readText();
          await respondHostUri(sid, id, { content: text || "(clipboard is empty)", contentType: "text/plain" });
        } catch {
          // Permission denied / document not focused: surface a readable error.
          await respondHostUri(sid, id, { isError: true, error: "Clipboard read was denied. Click into the omp-web window and try again." });
        }
        return;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(content ?? "");
          await respondHostUri(sid, id, {});
          return;
        } catch {
          await respondHostUri(sid, id, { isError: true, error: "Clipboard write failed in this browser" });
          return;
        }
      }
      await respondHostUri(sid, id, { isError: true, error: "Clipboard write is not available in this browser" });
      return;
    }
    await respondHostUri(sid, id, { isError: true, error: `Unknown pi-web resource: ${resource}` });
  }, [respondHostUri]);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  // Declared after addNotice: the dependency array below is evaluated during
  // render, so addNotice must already be initialized.
  const ensureEventsConnected = useCallback(async (sid: string) => {
    // Only this (send-blocking) path announces a slow connect; the mount and
    // auto-reconnect paths call connectEvents directly and stay silent.
    const slowNotice = setTimeout(() => {
      addNotice({ type: "info", message: translate("agentSession.startingAgent") });
    }, EVENT_STREAM_SLOW_CONNECT_MS);
    let result: EventStreamConnectionResult;
    try {
      result = await connectEvents(sid);
    } finally {
      clearTimeout(slowNotice);
    }
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [addNotice, connectEvents]);

  const handleExtensionUiRequest = useCallback((request: IncomingExtensionUiRequest) => {
    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        if (extensionDialogClearTimerRef.current) {
          clearTimeout(extensionDialogClearTimerRef.current);
          extensionDialogClearTimerRef.current = null;
        }
        setExtensionDialog(request);
        break;
      case "cancel":
        setExtensionDialog((current) => current?.id === request.targetId ? null : current);
        break;
      case "open_url": {
        // OAuth and similar flows: try to open a tab (often blocked outside a
        // user gesture), and always surface the URL as a notice fallback.
        // Reject unsafe schemes (javascript:/data:/file:/protocol-relative).
        const url = request.launchUrl ?? request.url;
        const safeUrl = isSafeOpenUrl(url) ? url : "";
        if (safeUrl) {
          try {
            window.open(safeUrl, "_blank", "noopener,noreferrer");
          } catch {
            // Pop-up blocked — the notice below still carries the URL.
          }
        }
        addNotice({
          id: request.id,
          type: "info",
          message: safeUrl
            ? (request.instructions ? `${request.instructions}\n${safeUrl}` : translate("agentSession.openInBrowser", { url: safeUrl }))
            : translate("agentSession.unsafeUrlBlocked"),
        });
        break;
      }
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText ? [...rest, { key: request.statusKey, text: request.statusText }] : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request as ExtensionUiCustomRequest;
        });
        break;
    }
  }, [addNotice, opts.chatInputRef]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId?: number) => {
    clearTerminalReconcileTimer();
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (runId !== undefined && promptRunIdRef.current !== runId) return;
    try {
      // Pass the fence into loadSession: the pre-check above only guards the
      // start — a next prompt that begins while the reload is in flight must
      // not be overwritten by the finished run's snapshot.
      if (sid) await loadSession(sid, false, true, runId);
    } finally {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      optimisticUserMessageKeyRef.current = null;
      if (!agentRunningRef.current) return;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      setRetryInfo(null);
      setSubagents([]);
      setAdvisorActiveAt(0);
      subagentRosterGenerationRef.current += 1;
      // Bound per-run activity state: without this, subagentEvents and the
      // transcript-version map retain one entry per subagent id forever.
      resetSubagentActivityState();
      // loadSession above already hydrated on-disk history, but it may have
      // resolved BEFORE this clear — re-issue so finished runs repopulate the
      // roster (merge is idempotent).
      if (sid) void refreshSubagentHistory(sid);
      dispatch({ type: "end" });
      onAgentEnd?.();
    }
  }, [clearTerminalReconcileTimer, loadSession, onAgentEnd, refreshSubagentHistory, resetSubagentActivityState]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (
      hookAliveRef.current
      && sessionIdRef.current === sid
      && agentRunningRef.current
      && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS
    ) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same path as prompt_done.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      isCompactingRef.current = state?.isCompacting ?? false;
      setIsCompacting(state?.isCompacting ?? false);
      // Also mid-run: this poll is the only todo-phase refresh while streaming.
      if (state?.todoPhases !== undefined) setTodoPhases(state.todoPhases ?? []);
      // And the only reliable re-sync for a missed subagent lifecycle frame.
      void refreshSubagentRoster(sid);
      if ((!state || state.queuedMessageCount === 0) && Date.now() - queueMutatedAtRef.current >= 5000) setQueuedMessages(EMPTY_QUEUE);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, refreshSubagentRoster]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  // Sample omp's own tokensPerSecond (get_state) at a gauge-friendly cadence
  // while a run is active; the 15s reconcile above is too slow for a gauge.
  // On run end take one trailing sample: omp publishes its final throughput
  // right around agent_end, possibly after the last in-run poll.
  useEffect(() => {
    if (!agentRunning) {
      if (!wasRunningForGaugeRef.current) return;
      wasRunningForGaugeRef.current = false;
      const sid = sessionIdRef.current;
      if (!sid) return;
      let cancelled = false;
      void fetch(`/api/agent/${encodeURIComponent(sid)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { state?: AgentStateResponse } | null) => {
          if (cancelled) return;
          const tps = data?.state?.tokensPerSecond;
          setTokensPerSecond(typeof tps === "number" && Number.isFinite(tps) && tps > 0 ? tps : null);
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }
    wasRunningForGaugeRef.current = true;
    const id = setInterval(() => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      void fetch(`/api/agent/${encodeURIComponent(sid)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { state?: AgentStateResponse } | null) => {
          const tps = data?.state?.tokensPerSecond;
          setTokensPerSecond(typeof tps === "number" && Number.isFinite(tps) && tps > 0 ? tps : null);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [agentRunning]);

  // A different session starts from a clean slate — no stale gauge carry-over.
  useEffect(() => {
    setTokensPerSecond(null);
  }, [data?.sessionId]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const consumeQueuedMessage = useCallback((text: string) => {
    if (!text) return;
    setQueuedMessages((prev) => {
      const si = prev.steering.indexOf(text);
      if (si !== -1) return { ...prev, steering: prev.steering.filter((_, i) => i !== si) };
      const fi = prev.followUp.indexOf(text);
      if (fi !== -1) return { ...prev, followUp: prev.followUp.filter((_, i) => i !== fi) };
      return prev;
    });
  }, []);

  /** Remove one queued message from the client-side queue mirror. omp's RPC
   *  protocol has no queue-mutation commands, so this only affects the queue
   *  panel: a message removed here may still be delivered by the running agent
   *  (it then arrives in the chat like any delivered turn). */
  const removeQueuedMessage = useCallback((text: string) => {
    if (!text) return;
    setQueuedMessages((prev) => {
      const si = prev.steering.indexOf(text);
      const fi = prev.followUp.indexOf(text);
      if (si === -1 && fi === -1) return prev;
      return {
        steering: si === -1 ? prev.steering : prev.steering.filter((_, i) => i !== si),
        followUp: fi === -1 ? prev.followUp : prev.followUp.filter((_, i) => i !== fi),
      };
    });
  }, []);

  /** Promote the first queued follow-up to a steering message (client-side
   *  relabel; the delivery order itself is owned by omp). */
  const promoteQueuedToSteer = useCallback((text: string) => {
    if (!text) return;
    setQueuedMessages((prev) => {
      const fi = prev.followUp.indexOf(text);
      if (fi === -1) return prev;
      return {
        steering: [...prev.steering, text],
        followUp: prev.followUp.filter((_, i) => i !== fi),
      };
    });
  }, []);

  // Mirror queued texts into sessionStorage so a reload can restore them.
  // The dirty gate keeps the initial empty state from wiping a stored queue
  // before the mount-time restore has run.
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const empty = isEmptyQueue(queuedMessages);
    if (empty && !queuePersistDirtyRef.current) return;
    queuePersistDirtyRef.current = !empty;
    persistQueue(sid, queuedMessages);
  }, [queuedMessages]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        interruptReplyPendingRef.current = false;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // isTerminal === false means an async delivery resumes this run soon.
        if (event.isTerminal === false) break;
        // An interrupt-and-reply aborts the current turn: its terminal
        // agent_end arrives while abort_and_prompt is already starting the new
        // run — keep the running state alive for it.
        if (interruptReplyPendingRef.current) {
          interruptReplyPendingRef.current = false;
          break;
        }
        clearTerminalReconcileTimer();
        // A late agent_end can arrive over SSE after reconcileAgentState
        // already finished this run — don't re-trigger completion.
        if (!agentRunningRef.current) break;
        // async, and a next prompt (or session switch) that starts while it is
        // in flight must not be overwritten by this finished run's snapshot.
        const endedSid = sessionIdRef.current;
        const endedRunId = promptRunIdRef.current;
        agentRunningRef.current = false;
        setAgentRunning(false);
        setAgentPhase(null);
        setRetryInfo(null);
        setSubagents([]);
        setAdvisorActiveAt(0);
        subagentRosterGenerationRef.current += 1;
        resetSubagentActivityState();
        dispatch({ type: "end" });
        if (endedSid) {
          void loadSession(endedSid, false, false, endedRunId);
          const endToken = beginAuthoritativeModelSync();
          fetch(`/api/agent/${encodeURIComponent(endedSid)}`)
            .then((r) => (r.ok ? r.json() as Promise<{ state?: AgentStateResponse }> : null))
            .then((d) => {
              if (!d?.state?.model) return;
              // Stale terminal snapshot: the user switched sessions or started
              // the next run while this request was in flight — drop it.
              if (sessionIdRef.current !== endedSid || promptRunIdRef.current !== endedRunId) return;
              const applied = applyAuthoritativeModel(toThinkingModelMeta(d.state.model), endToken);
              if (!applied) return; // stale snapshot — drop everything derived from it
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt || null);
              // Fast mode is family-scoped in omp: re-sync from the terminal
              // state so a run that switched models/families never leaves the
              // composer toggle stuck on a stale value.
              if (d.state?.fastModeEnabled !== undefined) setFastModeEnabled(d.state.fastModeEnabled);
              setFastModeActive(d.state?.fastModeActive);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.todoPhases !== undefined) setTodoPhases(d.state.todoPhases ?? []);
              // omp reports only a queued count; an empty (or dead) session
              // means the client-tracked queue texts are stale.
              if ((!d.state || d.state.queuedMessageCount === 0) && Date.now() - queueMutatedAtRef.current >= 5000) setQueuedMessages(EMPTY_QUEUE);
            })
            .catch(() => {});
        }
        onAgentEnd?.();
        break;
      case "prompt_result":
        // A prompt handled entirely by a builtin/extension slash command:
        // no agent_start/agent_end pair will follow.
        if (event.agentInvoked !== false) break;
        if (!agentRunningRef.current) break;
        // Fence with the current run id like agent_end does: the reload below
        // is async, and a prompt that starts while it is in flight must not be
        // overwritten by this finished run's snapshot.
        void finishPromptWithoutStream(sessionIdRef.current, promptRunIdRef.current);
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? translate("agentSession.commandFailed") });
        // A failed prompt is terminal: no agent_end follows it. Without this the
        // spinner and the locked input wait for the 15s reconcile poll. Fenced
        // with the run id for the same reason as prompt_result above.
        if (agentRunningRef.current) void finishPromptWithoutStream(sessionIdRef.current, promptRunIdRef.current);
        break;
      case "notice": {
        const level = event.level as string | undefined;
        const message = (event.message as string | undefined)?.trim() ?? "";
        if (/^xd:\/\/:\s*mounted\s+mcp__/i.test(message)) {
          toast.info("MCP tools updated", message, { clamp: true });
        } else {
          addNotice({
            type: level === "error" ? "error" : level === "warning" ? "warning" : "info",
            message,
          });
        }
        break;
      }
      case "command_output": {
        const text = (event.text as string | undefined)?.trim() ?? "";
        if (/^xd:\/\/:\s*mounted\s+mcp__/i.test(text)) toast.info("MCP tools updated", text, { clamp: true });
        else if (text) addNotice({ type: "info", message: text });
        break;
      }
      case "thinking_level_changed":
        setThinkingLevel(normalizeThinkingLevel(event.thinkingLevel as string | undefined));
        break;
      case "model_changed": {
        // Bare event: omp switched the resolved model (explicit /model,
        // retry-fallback, prewalk hand-off). No payload — sync from state.
        const sid = sessionIdRef.current;
        if (!sid) break;
        const token = beginAuthoritativeModelSync();
        void fetch(`/api/agent/${encodeURIComponent(sid)}`)
          .then((r) => (r.ok ? r.json() as Promise<{ state?: AgentStateResponse }> : null))
          .then((d) => {
            if (!d?.state?.model) return;
            if (sessionIdRef.current !== sid) return;
            const applied = applyAuthoritativeModel(toThinkingModelMeta(d.state.model), token);
            if (!applied) return; // stale snapshot — drop its thinking level too
            if (d.state.thinkingLevel !== undefined) setThinkingLevel(normalizeThinkingLevel(d.state.thinkingLevel));
            if (d.state.fastModeEnabled !== undefined) setFastModeEnabled(d.state.fastModeEnabled);
            setFastModeActive(d.state.fastModeActive);
            if (d.state.autoRetryEnabled !== undefined) setAutoRetryEnabled(d.state.autoRetryEnabled);
            if (d.state.interruptMode !== undefined) setInterruptMode(d.state.interruptMode);
            if (d.state.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(d.state.autoCompactionEnabled);
            if (d.state.steeringMode !== undefined) setSteeringMode(d.state.steeringMode);
            if (d.state.followUpMode !== undefined) setFollowUpMode(d.state.followUpMode);
          })
          .catch(() => {});
        break;
      }
      case "config_update": {
        // Payload event: model + thinkingLevel snapshot after a
        // config-affecting slash command (e.g. /model).
        const model = event.model as { provider?: string; id?: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } } | undefined;
        if (model) applyAuthoritativeModel(toThinkingModelMeta(model));
        if (event.thinkingLevel !== undefined) setThinkingLevel(normalizeThinkingLevel(event.thinkingLevel as string | undefined));
        break;
      }
      case "available_commands_update": {
        const commands = (event.commands as RpcAvailableSlashCommand[] | undefined) ?? [];
        setSlashCommands(commands.map(toSlashCommandInfo).filter((c): c is SlashCommandInfo => c !== null));
        break;
      }
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        if (msg?.role === "user") {
          break;
        }
        if (msg?.role === "custom" && (msg as CustomMessage).customType === "advisor") {
          // The advisor review streams in mid-run: light the composer thunder
          // while it works, not only once its message completes. Functional
          // update keeps per-frame updates from re-rendering needlessly.
          setAdvisorActiveAt((prev) => (prev === 0 ? Date.now() : prev));
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          // Delivered steering/follow-up texts leave the client-tracked queue.
          consumeQueuedMessage(extractMessageText(delivered));
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed?.role === "custom" && (completed as CustomMessage).customType === "xdev-mount-notice") {
          toast.info("MCP tools updated", describeMcpMountNotice(completed as CustomMessage), { clamp: true });
        } else if (completed) {
          // The advisor model injects its review as a custom message mid-run;
          // surface it as live advisor activity for the composer thunder icon.
          if ((completed as CustomMessage).customType === "advisor") setAdvisorActiveAt(Date.now());
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        if (completed?.role === "assistant") {
          clearTerminalReconcileTimer();
          const targetSid = sessionIdRef.current;
          const targetRunId = promptRunIdRef.current;
          if (targetSid) {
            terminalReconcileTimerRef.current = setTimeout(() => {
              terminalReconcileTimerRef.current = null;
              if (
                hookAliveRef.current &&
                agentRunningRef.current &&
                sessionIdRef.current === targetSid &&
                promptRunIdRef.current === targetRunId
              ) {
                void reconcileAgentState(targetSid);
              }
            }, 1000);
          }
        }
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        if (event.toolName === "todo" && sessionIdRef.current) {
          void reconcileAgentState(sessionIdRef.current);
        }
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "todo_reminder":
      case "todo_auto_clear":
        if (sessionIdRef.current) void reconcileAgentState(sessionIdRef.current);
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted && !event.skipped) {
          setCompactResult(readCompactResult(event.result, "auto"));
          if (sessionIdRef.current) void loadSession(sessionIdRef.current);
        }
        break;
      case "subagent_lifecycle": {
        // Roster fed by omp's subagent_lifecycle frames. Payload mirrors
        // SubagentLifecyclePayload (oh-my-pi task/types.ts); defensive
        // parsing degrades to ignoring the frame, never breaking the run.
        const info = parseSubagentLifecycle(event.payload);
        if (!info) break;
        mergeSubagents([info]);
        break;
      }
      case "host_tool_call": {
        // The wrapper only forwards REGISTERED host tools (see rpc-manager),
        // so a frame here is always one this UI can answer.
        const id = typeof event.id === "string" ? event.id : "";
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        const args = isRecord(event.arguments) ? event.arguments : {};
        if (id && toolName) void handleHostToolCall(id, toolName, args);
        break;
      }
      case "host_uri_request": {
        // The wrapper only forwards REGISTERED schemes (see rpc-manager).
        const id = typeof event.id === "string" ? event.id : "";
        const url = typeof event.url === "string" ? event.url : "";
        const operation = event.operation === "write" ? "write" as const : "read" as const;
        const content = typeof event.content === "string" ? event.content : undefined;
        if (id && url) void handleHostUriRequest(id, operation, url, content);
        break;
      }
      case "subagent_progress": {
        // Progress frames carry the full AgentProgress snapshot (throttled to
        // one per 150ms and flushed at terminal). The reliable key is
        // progress.id; parentToolCallId/index are fallbacks.
        const payload = event.payload as { index?: unknown; agent?: unknown; agentSource?: unknown; task?: unknown; parentToolCallId?: unknown; sessionFile?: unknown; assignment?: unknown; detached?: unknown; progress?: unknown } | undefined;
        const progress = parseSubagentProgress(payload?.progress);
        const progressId = progress?.id;
        const index = typeof payload?.index === "number" ? payload.index : (progress?.index ?? -1);
        const parentToolCallId = typeof payload?.parentToolCallId === "string" ? payload.parentToolCallId : null;
        const task = typeof payload?.task === "string" && payload.task.trim() ? payload.task : (progress?.task ?? null);
        const assignment = typeof payload?.assignment === "string" ? payload.assignment : progress?.assignment;
        if (!progressId && !task && !parentToolCallId && index < 0) break;
        // Fence progress frames against roster clear / new run (same as mergeSubagents).
        const progressGeneration = subagentRosterGenerationRef.current;
        const progressRunId = promptRunIdRef.current;
        const progressSid = sessionIdRef.current;
        setSubagents((prev) => {
          if (subagentRosterGenerationRef.current !== progressGeneration || promptRunIdRef.current !== progressRunId || sessionIdRef.current !== progressSid) return prev;
          if (prev.length === 0) return prev;
          let target = -1;
          if (progressId) {
            // A valid progress frame names its subagent; if that id is gone the
            // frame is stale (terminal frame was missed, then cleared) — falling
            // back to parentToolCallId/index could overwrite a DIFFERENT child.
            target = prev.findIndex((subagent) => subagent.id === progressId);
          } else {
            // ID-less fallback frames: prefer the exact (parent, index) pair
            // (batch children share parentToolCallId), then each key alone.
            if (parentToolCallId && index >= 0) {
              target = prev.findIndex((subagent) => subagent.parentToolCallId === parentToolCallId && subagent.index === index);
            }
            if (target === -1 && parentToolCallId) target = prev.findIndex((subagent) => subagent.parentToolCallId === parentToolCallId);
            if (target === -1 && index >= 0) target = prev.findIndex((subagent) => subagent.index === index);
          }
          if (target === -1) return prev;
          const current = prev[target];
          const nextEntry: SubagentInfo = {
            ...current,
            agent: typeof payload?.agent === "string" ? payload.agent : current.agent,
            // The snapshot's agent-source literal lives in payload.agentSource,
            // not payload.agent (which holds the agent name).
            agentSource:
              typeof payload?.agentSource === "string"
                && (payload.agentSource === "bundled" || payload.agentSource === "user" || payload.agentSource === "project")
                ? payload.agentSource
                : current.agentSource,
            ...(typeof payload?.sessionFile === "string" ? { sessionFile: payload.sessionFile } : {}),
            ...(typeof payload?.detached === "boolean" ? { detached: payload.detached } : {}),
            ...(task ? { task } : {}),
            ...(assignment !== undefined ? { assignment } : {}),
            ...(progress ? { progress } : {}),
            lastUpdate: Date.now(),
            source: "live",
          };
          // Progress frames arrive every ~150ms; skip rerender when no displayed field changed.
          // Avoid double JSON.stringify on hot path — field compare is cheaper than serializing whole entries.
          if (
            current.agent === nextEntry.agent &&
            current.agentSource === nextEntry.agentSource &&
            current.sessionFile === nextEntry.sessionFile &&
            current.detached === nextEntry.detached &&
            current.task === nextEntry.task &&
            current.assignment === nextEntry.assignment &&
            JSON.stringify(current.progress) === JSON.stringify(nextEntry.progress)
          ) return prev;
          const next = [...prev];
          next[target] = nextEntry;
          return next;
        });
        break;
      }
      case "subagent_event": {
        // An events-level subscription embeds raw child-session events here.
        // The transcript remains paged on the server; a per-child revision
        // tells an open dialog to fetch only the appended byte range. Also
        // keep a bounded live-activity buffer for the transcript dialog.
        const payload = event.payload as { id?: unknown; event?: unknown } | undefined;
        const subagentId = typeof payload?.id === "string" ? payload.id : null;
        if (subagentId) {
          const pending = subagentVersionFlushRef.current ?? (subagentVersionFlushRef.current = new Set());
          pending.add(subagentId);
          const activity = parseSubagentActivityEvent(payload);
          if (activity) {
            const actMap = subagentActivityFlushRef.current ?? (subagentActivityFlushRef.current = new Map());
            const list = actMap.get(subagentId) ?? [];
            list.push(activity);
            actMap.set(subagentId, list);
          }
          if (subagentVersionFlushFrameRef.current === null) {
            subagentVersionFlushFrameRef.current = requestAnimationFrame(() => {
              subagentVersionFlushFrameRef.current = null;
              const queued = subagentVersionFlushRef.current;
              subagentVersionFlushRef.current = null;
              const queuedActs = subagentActivityFlushRef.current;
              subagentActivityFlushRef.current = null;
              if (queued && queued.size > 0) {
                setSubagentTranscriptVersions((prev) => {
                  let next = prev;
                  for (const id of queued) next = { ...next, [id]: (next[id] ?? 0) + 1 };
                  return pruneSubagentIdMap(next);
                });
              }
              if (queuedActs && queuedActs.size > 0) {
                setSubagentEvents((prev) => {
                  const next = { ...prev };
                  for (const [id, acts] of queuedActs.entries()) {
                    const existing = next[id] ?? [];
                    const merged = [...existing, ...acts];
                    const trimmed = merged.length > SUBAGENT_ACTIVITY_BUFFER_MAX
                      ? merged.slice(merged.length - SUBAGENT_ACTIVITY_BUFFER_MAX)
                      : merged;
                    delete next[id];
                    next[id] = trimmed;
                  }
                  return pruneSubagentIdMap(next);
                });
              }
            });
          }
        }
        break;
      }
      case "extension_ui_request":
        handleExtensionUiRequest(event as unknown as IncomingExtensionUiRequest);
        break;
    }
  }, [addNotice, clearTerminalReconcileTimer, consumeQueuedMessage, finishPromptWithoutStream, handleExtensionUiRequest, handleHostToolCall, handleHostUriRequest, loadSession, mergeSubagents, onAgentEnd, reconcileAgentState, resetSubagentActivityState, applyAuthoritativeModel, beginAuthoritativeModelSync]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    if (agentRunningRef.current || bashRunningRef.current) return false;
    if (initialHydrationPendingRef.current) return false;
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return false;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return true;
    }

    // This is the final dispatch boundary, after web slash commands have been
    // expanded. Keep programmatic callers from entering optimistic state with
    // a body the agent route will reject.
    const promptError = validateOutgoingPrompt(message, images);
    if (promptError) {
      addNotice({ type: "error", message: promptError });
      return false;
    }

    const promptRunId = promptRunIdRef.current + 1;
    clearTerminalReconcileTimer();

    const { userMsg, piImages } = buildOutgoingPrompt(message, images);
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    setAdvisorActiveAt(0);
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;
    // The send click bubbles through the global pointer listener below. It is
    // not a request to stop following the response that this prompt starts.
    userScrollIntentUntilRef.current = 0;

    try {
      let sentSessionId: string | null = null;
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          // omp assigns the real id before the first prompt finishes. Promote
          // now so the sidebar can show this active session during streaming.
          promoteNewSession(1, message);
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          void refreshSubagentRoster(sid);
          await sendAgentCommand(sid, {
            type: "prompt",
            message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
        }
      } else if (session) {
        sentSessionId = session.id;
        // The event route is observer-only. Start or resume the web-owned RPC
        // wrapper with a supported command before opening the SSE connection.
        await sendAgentCommand(session.id, { type: "get_state" });
        await ensureEventsConnected(session.id);
        void refreshSubagentRoster(session.id);
        void registerHostTools(session.id);
        void registerHostUriSchemes(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
      return true;
    } catch (e) {
      console.error("Failed to send message:", e);
      // Every failure here (stream connect, startup, set_model, or the prompt
      // POST itself) means the prompt never started, so roll back the optimistic bubble.
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      addNotice({
        type: "error",
        message: e instanceof EventStreamConnectionError
          ? e.message
          : translate("agentSession.sendFailed", { detail: e instanceof Error ? e.message : String(e) }),
      });
      // Restore the user's text into the input instead of losing it. Mirrors the
      // shell-command recovery in executeBash; insertIfEmpty avoids clobbering
      // anything typed since.
      if (message) opts.chatInputRef?.current?.insertIfEmpty(message);
      optimisticUserMessageKeyRef.current = null;
      agentRunningRef.current = false;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
      return false;
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, opts.chatInputRef, refreshSubagentRoster, registerHostTools, registerHostUriSchemes, clearTerminalReconcileTimer]);

  /** Abort the running agent and send the message as a fresh prompt
   * (abort_and_prompt). Only valid mid-run; the old turn's agent_end is
   * consumed by the pending-interrupt guard so the new run keeps streaming. */
  const handleInterruptAndReply = useCallback(async (message: string, images?: AttachedImage[]): Promise<boolean> => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return false;
    const sid = sessionIdRef.current;
    if (!sid || !agentRunningRef.current) return false;

    // Same dispatch boundary as handleSend: refuse a body the agent route
    // would reject with 413 before the optimistic bubble and run state exist.
    const promptError = validateOutgoingPrompt(trimmedMessage, images);
    if (promptError) {
      addNotice({ type: "error", message: promptError });
      return false;
    }

    clearTerminalReconcileTimer();
    // Advance the run generation so late agent_end / prompt_error / stale
    // loadSession from the aborted turn cannot stop or clobber the replacement.
    promptRunIdRef.current += 1;

    const { userMsg, piImages: interruptPiImages } = buildOutgoingPrompt(message, images);
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    interruptReplyPendingRef.current = true;
    pendingScrollToUserRef.current = true;
    completionScrollAllowedRef.current = true;
    userScrollIntentUntilRef.current = 0;
    try {
      await ensureEventsConnected(sid);
      void refreshSubagentRoster(sid);
      await sendAgentCommand(sid, {
        type: "abort_and_prompt",
        message: trimmedMessage,
        ...(interruptPiImages?.length ? { images: interruptPiImages } : {}),
      });
      return true;
    } catch (e) {
      console.error("Failed to interrupt and reply:", e);
      interruptReplyPendingRef.current = false;
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      optimisticUserMessageKeyRef.current = null;
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      // Mirror handleSend: the interrupt never started, so hand the text back
      // instead of losing it with the rolled-back bubble.
      if (trimmedMessage) opts.chatInputRef?.current?.insertIfEmpty(trimmedMessage);
      return false;
    }
  }, [addNotice, ensureEventsConnected, refreshSubagentRoster, clearTerminalReconcileTimer, opts.chatInputRef]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error(translate("agentSession.shellSessionFailed"));
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current || agentRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  // omp's RPC protocol has no navigate-within-tree command, so branch
  const handleNavigate = useCallback(async (entryId: string): Promise<boolean> => {
    // While a run is active its streaming frames append to the displayed
    // message list — swapping in another branch's context mid-run would mix
    // the running turn into the wrong branch (same gating as MessageView's
    // sessionBusy-navigable check).
    if (bashRunningRef.current || agentRunningRef.current) return false;
    const sid = sessionIdRef.current;
    if (!sid) return false;
    setActiveLeafId(entryId);
    const ok = await loadContext(sid, entryId);
    if (!ok) return false;
    return true;
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current || agentRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      setNewSessionModel({ provider, modelId });
      setPendingModel({ provider, modelId });
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      setCurrentModelOverride({ provider, modelId });
      void refreshLiveModelState(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
    }
  }, [isNew, setNewSessionModel, refreshLiveModelState]);

  const handleFastModeChange = useCallback(async (enabled: boolean) => {
    // A brand-new session has no runtime yet: the model picker updates local
    // state (so the Fast button appears), but set_fast_mode is a live-process
    // command — without spawning the session the click silently no-ops.
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current ?? await ensureNewSession();
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ enabled?: boolean; active?: boolean }>(sid, { type: "set_fast_mode", enabled });
      setFastModeEnabled(result?.enabled ?? enabled);
      setFastModeActive(result?.active);
      void refreshLiveModelState(sid);
    } catch (error) {
      console.error("Failed to change Fast mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, ensureNewSession, refreshLiveModelState]);

  /** Toggle automatic retry for transient model failures. */
  const handleAutoRetryChange = useCallback(async (enabled: boolean) => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setAutoRetryEnabled(enabled);
    try {
      await sendAgentCommand(sid, { type: "set_auto_retry", enabled });
    } catch (error) {
      setAutoRetryEnabled((current) => (current === enabled ? !enabled : current));
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Change how steering interrupts the running agent (immediate vs wait). */
  const handleInterruptModeChange = useCallback(async (mode: "immediate" | "wait") => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setInterruptMode(mode);
    try {
      await sendAgentCommand(sid, { type: "set_interrupt_mode", mode });
    } catch (error) {
      console.error("Failed to change interrupt mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Toggle automatic context compaction on the live session. */
  const handleAutoCompactionChange = useCallback(async (enabled: boolean) => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setAutoCompactionEnabled(enabled);
    try {
      await sendAgentCommand(sid, { type: "set_auto_compaction", enabled });
    } catch (error) {
      console.error("Failed to change auto-compaction:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Change how queued steering messages are delivered (all at once / one at a time). */
  const handleSteeringModeChange = useCallback(async (mode: "all" | "one-at-a-time") => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setSteeringMode(mode);
    try {
      await sendAgentCommand(sid, { type: "set_steering_mode", mode });
    } catch (error) {
      console.error("Failed to change steering mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Change how queued follow-up messages are delivered. */
  const handleFollowUpModeChange = useCallback(async (mode: "all" | "one-at-a-time") => {
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    setFollowUpMode(mode);
    try {
      await sendAgentCommand(sid, { type: "set_follow_up_mode", mode });
    } catch (error) {
      console.error("Failed to change follow-up mode:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  /** Cycle to the next available model (⌘/Ctrl+Alt+M). */
  const handleCycleModel = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "cycle_model" });
      void refreshLiveModelState(sid);
    } catch (error) {
      console.error("Failed to cycle model:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, refreshLiveModelState]);

  /** Cycle to the next thinking level (⌘/Ctrl+Alt+T). */
  const handleCycleThinkingLevel = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "cycle_thinking_level" });
      void refreshLiveModelState(sid);
    } catch (error) {
      console.error("Failed to cycle thinking level:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, refreshLiveModelState]);

  /** Stop an in-progress automatic retry from the retry banner. */
  const handleAbortRetry = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setRetryInfo(null);
    try {
      await sendAgentCommand(sid, { type: "abort_retry" });
    } catch (error) {
      console.error("Failed to abort retry:", error);
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice]);

  const handleHandoff = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompactingRef.current || agentRunningRef.current || bashRunningRef.current) return;
    try {
      await sendAgentCommand(sid, { type: "handoff" });
      await loadSession(sid, true);
      void refreshLiveModelState(sid);
    } catch (error) {
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [addNotice, loadSession, refreshLiveModelState]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompactingRef.current || isCompacting) return;
    isCompactingRef.current = true;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
      void refreshLiveModelState(sid);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      isCompactingRef.current = false;
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession, refreshLiveModelState]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    setModelsLoading(true);
    try {
      const modelCwd = newSessionCwd ?? session?.cwd ?? "";
      const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
      const res = await fetch(modelsUrl, { cache: "no-store", ...(signal ? { signal } : {}) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as ModelsResponse;
      setModelNames(d.models);
      setModelError(d.modelError ?? null);
      setModelThinkingLevels(d.thinkingLevels ?? {});
      setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
      const nextModelList = d.modelList ?? [];
      setModelList(nextModelList);
      if (isNew) {
        const match = d.defaultModel
          ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
          : undefined;
        const displayModel = match ?? nextModelList[0];
        setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      }
    } catch (e) {
      // Surface fetch/parse failures instead of silently rendering an empty
      // model list with no error state.
      if (!signal?.aborted) setModelError(e instanceof Error ? e.message : String(e));
    } finally {
      setModelsLoading(false);
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? translate("agentSession.commandCompleted") });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompactingRef.current || isCompacting) return complete({ handled: true, error: translate("agentSession.noSessionToCompact") });
          isCompactingRef.current = true;
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          await loadSession(sid, true);
          isCompactingRef.current = false;
          setIsCompacting(false);
          // loadSession resolves to null unless state was requested, so promote
          // unconditionally — promoteNewSession no-ops for existing sessions and
          // is idempotent via newSessionPromotedRef.
          promoteNewSession();
          return complete({ handled: true, message: translate("agentSession.compactedContext") });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noSessionToReload") });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: translate("agentSession.reloadedResources") });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noSessionToName") });
          if (!args) return complete({ handled: true, error: translate("agentSession.nameUsage") });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          await loadSession(sid);
          promoteNewSession();
          return complete({ handled: true, message: translate("agentSession.sessionRenamed", { name: args }) });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noActiveSession") });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: translate("agentSession.noActiveSession") });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: translate("agentSession.noMessageToCopy") });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: translate("agentSession.copiedLastMessage") });
        }

        default: {
          // Web-native prompt commands (/goal, /plan, ...). omp's same-named
          // builtins are TUI-only and never execute over RPC, so the palette
          // shows these instead (CLIENT_BUILTIN_COMMAND_NAMES drops omp's
          // copies). handleSend runs the full prompt pipeline — optimistic
          // bubble, running state, settlement — with the expanded text.
          // /advisor is gated on the per-chat composer toggle: refuse with a
          // pointer to that toggle while the advisor is disabled.
          if (commandName === "advisor" && !advisorEnabled) {
            return complete({ handled: true, error: translate("agentSession.advisorDisabled") });
          }
          const expansion = expandWebSlashCommand(text);
          if (expansion.kind === "not-web") return { handled: false };
          if (expansion.kind === "usage-error") {
            // error keeps the user's text in the input so they can append args.
            return complete({
              handled: true,
              error: translate("agentSession.commandRequiresArgs", {
                command: expansion.command,
                usage: translate(expansion.argumentHintKey),
              }),
            });
          }
          if (commandName === "plan") setActivePlan({ objective: args });
          const sent = await handleSend(expansion.prompt);
          if (!sent) {
            if (commandName === "plan") setActivePlan(null);
            return { handled: true, retainInput: true };
          }
          if (commandName === "goal") {
            const goal = createActiveGoal(args);
            setActiveGoal(goal);
            const activeSessionId = sessionIdRef.current;
            if (activeSessionId) sessionStorage.setItem(`omp-web:goal:${activeSessionId}`, JSON.stringify(goal));
          }
          return { handled: true };
        }
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") {
        isCompactingRef.current = false;
        setIsCompacting(false);
      }
    }
  }, [addNotice, advisorEnabled, ensureNewSession, handleSend, isCompacting, loadModels, loadSession, loadSlashCommands, promoteNewSession, onSessionStatsPanelOpen]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const toPiImages = (images?: AttachedImage[]) => images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = toPiImages(images);
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      // omp emits no queue snapshots; track the queued text locally until it
      // is delivered (user message_end) or the queue count drops to zero.
      queueMutatedAtRef.current = Date.now();
      setQueuedMessages((prev) => ({ ...prev, steering: [...prev.steering, message] }));
    } catch (e) {
      console.error("Failed to steer:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(message);
    }
  }, [addNotice, opts.chatInputRef]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = toPiImages(images);
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      queueMutatedAtRef.current = Date.now();
      setQueuedMessages((prev) => behavior === "steer"
        ? { ...prev, steering: [...prev.steering, message] }
        : { ...prev, followUp: [...prev.followUp, message] });
    } catch (e) {
      console.error("Failed to queue prompt:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(message);
    }
  }, [addNotice, opts.chatInputRef]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const piImages = toPiImages(images);
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message,
        ...(piImages?.length ? { images: piImages } : {}),
      });
      queueMutatedAtRef.current = Date.now();
      setQueuedMessages((prev) => ({ ...prev, followUp: [...prev.followUp, message] }));
    } catch (e) {
      console.error("Failed to follow up:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(message);
    }
  }, [addNotice, opts.chatInputRef]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
      void refreshLiveModelState(sid);
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [refreshLiveModelState]);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    setToolPresetState(preset);
    setPreferredToolPreset(preset);
    // The preset is applied at spawn time (--tools/--no-tools flags); omp's
    // RPC protocol cannot change the toolset of an already-running session.
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (sid) {
      addNotice({ type: "info", message: translate("agentSession.toolPresetNotice") });
    }
  }, [setToolPresetState, addNotice]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    // `behavior: "auto"` falls back to the container's computed
    // `scroll-behavior` (which inherits `html { scroll-behavior: smooth }`),
    // so a per-frame live follow would restart an eased scroll animation
    // every frame — an endless chase that lags the growing content. Callers
    // pass "instant" for live follow; "smooth" stays for idle scrolls.
    end.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "instant" : behavior });
  }, [reducedMotion]);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    const userScrollIntent = Date.now() <= userScrollIntentUntilRef.current;
    // A user wheel, keyboard, touch, or scrollbar scroll must win over the
    // timer used to suppress our own scroll events. During a busy stream that
    // timer is refreshed every frame, so checking it first would trap the user
    // at the bottom.
    if (!userScrollIntent && Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    if (!userScrollIntent) return;
    const container = scrollContainerRef.current;
    const end = messagesEndRef.current;
    if (!container || !end) return;
    // Recompute even while idle: otherwise the flag stays false after a run
    // ends while the user is scrolled up, and a message that arrives outside
    // a run (queued follow-up, steering reply) would never auto-scroll.
    completionScrollAllowedRef.current = end.getBoundingClientRect().bottom - container.getBoundingClientRect().bottom <= 24;
  }, []);

  // Load session on mount
  useEffect(() => {
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(session.id);
            // Register the host-tool + URI bridges so the agent can call
            // open_url/notify/open_file and resolve pi-web://clipboard.
            void registerHostTools(session.id);
            void registerHostUriSchemes(session.id);
            // Rehydrate the live roster (missed lifecycle/progress frames).
            // Tracked + session-guarded: a session switch during the delay must
            // not issue a stale get_subagents against the old session.
            if (rosterRefreshTimerRef.current) {
              clearTimeout(rosterRefreshTimerRef.current);
              rosterRefreshTimerRef.current = null;
            }
            const rosterTimerSid = session.id;
            rosterRefreshTimerRef.current = setTimeout(() => {
              rosterRefreshTimerRef.current = null;
              if (sessionIdRef.current !== rosterTimerSid) return;
              void refreshSubagentRoster(rosterTimerSid);
            }, 600);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          // Model + thinking level are owned by loadSession (token-guarded);
          // re-applying this same snapshot here would mint a fresh token and
          // bypass the stale-response guard.
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt || null);
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessageCount === 0 && Date.now() - queueMutatedAtRef.current >= 5000) {
            setQueuedMessages(EMPTY_QUEUE);
            // The queue drained while the page was closed — a stored copy
            // from a previous page load is stale.
            clearPersistedQueue(session.id);
          } else if (typeof agentState.state.queuedMessageCount === "number") {
            // omp still holds queued messages: restore the client-tracked
            // texts persisted by the previous page load.
            const persisted = readPersistedQueue(session.id);
            if (persisted) {
              setQueuedMessages((prev) => (isEmptyQueue(prev) ? persisted : prev));
            }
          }
        }
      });
    }
    return () => {
      clearTerminalReconcileTimer();
      bashRecoveryIdRef.current += 1;
      eventCoalescerRef.current?.reset();
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (rosterRefreshTimerRef.current) {
        clearTimeout(rosterRefreshTimerRef.current);
        rosterRefreshTimerRef.current = null;
      }
      if (subagentVersionFlushFrameRef.current !== null) {
        cancelAnimationFrame(subagentVersionFlushFrameRef.current);
        subagentVersionFlushFrameRef.current = null;
      }
      subagentVersionFlushRef.current = null;
      subagentActivityFlushRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSubagentRoster, registerHostTools, registerHostUriSchemes]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onSystemPromptLoaderChange?.(loadSystemPrompt);
    return () => onSystemPromptLoaderChange?.(null);
  }, [loadSystemPrompt, onSystemPromptLoaderChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
      window.removeEventListener("pointerdown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  // Follow the conversation: scroll to the user's latest message when they
  // send one, then keep the newest content in view while the agent streams.
  // `messages` identity changes on every message boundary and `streamState`
  // on every streaming token batch, so the scroll is throttled to one frame
  // during a run to avoid layout thrash. A manual scroll-up
  // (completionScrollAllowedRef === false) disables following.
  const followScrollFrameRef = useRef<number | null>(null);
  // Reset scroll anchors when the active session changes. Not every navigation
  // bumps ChatWindow's sessionKey (promoted new sessions, hydration), so a
  // revisited compacted session would otherwise stay pinned at the top
  // (compaction summary) instead of the latest turn.
  const prevSessionIdForScrollRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = session?.id ?? null;
    if (prevSessionIdForScrollRef.current !== sid) {
      prevSessionIdForScrollRef.current = sid;
      initialScrollDoneRef.current = false;
      completionScrollAllowedRef.current = true;
      pendingScrollToUserRef.current = false;
      if (followScrollFrameRef.current !== null) {
        cancelAnimationFrame(followScrollFrameRef.current);
        followScrollFrameRef.current = null;
      }
    }
  }, [session?.id]);
  useEffect(() => {
    const hasContent = messages.length > 0 || streamState.isStreaming;
    if (!hasContent) return;
    if (pendingScrollToUserRef.current) {
      pendingScrollToUserRef.current = false;
      initialScrollDoneRef.current = true;
      scrollToBottom(streamState.isStreaming || agentRunningRef.current ? "instant" : "smooth");
    } else if (!initialScrollDoneRef.current) {
      // Wait for the message list to actually be mounted: while `loading` is
      // true the scroll container does not exist, so scrolling now would
      // no-op yet mark the initial scroll as done - leaving the viewport at
      // the top (which then auto-loads the full history) after load ends.
      // The `loading` dep re-runs this effect once the list is rendered.
      if (loading) return;
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
    } else if (completionScrollAllowedRef.current) {
      if (followScrollFrameRef.current === null) {
        followScrollFrameRef.current = requestAnimationFrame(() => {
          followScrollFrameRef.current = null;
          if (!completionScrollAllowedRef.current) return;
          scrollToBottom(agentRunningRef.current || streamState.isStreaming ? "instant" : "smooth");
        });
      }
    }
  }, [messages, streamState, agentRunning, agentPhase, extensionWidgets, isCompacting, retryInfo, activeSubagentCount, todoPhases, scrollToBottom, loading]);

  useEffect(() => () => {
    hookAliveRef.current = false;
    if (followScrollFrameRef.current !== null) cancelAnimationFrame(followScrollFrameRef.current);
  }, []);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  // Compact error auto-dismiss
  useEffect(() => {
    if (!compactError) return;
    const t = setTimeout(() => setCompactError(null), 3000);
    return () => clearTimeout(t);
  }, [compactError]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, showPreCompactionHistory, streamState,
    agentRunning, modelNames, modelList, modelsLoading, modelError, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel, fastModeEnabled, fastModeActive, autoRetryEnabled, interruptMode, autoCompactionEnabled, steeringMode, followUpMode,
    liveModelMeta,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, tokensPerSecond, currentModel, displayModel, isAutoModelSelection: !displayModel, sessionStats, agentPhase,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    advisorActive: advisorActiveAt > 0, advisorEnabled, handleAdvisorChange,
    subagents, subagentEvents, subagentTranscriptVersions, activeSubagentCount, currentTodoPhase, todoPhases,
    activeGoal, activePlan,
    isNew,
    // Refs
    sessionIdRef, messagesEndRef, scrollContainerRef,
    pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleFastModeChange, handleAutoRetryChange, handleInterruptModeChange, handleAutoCompactionChange, handleSteeringModeChange, handleFollowUpModeChange, handleCycleModel, handleCycleThinkingLevel, handleAbortRetry, handleInterruptAndReply,
    handleCompact, handleHandoff, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    removeQueuedMessage, promoteQueuedToSteer,
    handleBuiltinSlashCommand, togglePreCompactionHistory,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
