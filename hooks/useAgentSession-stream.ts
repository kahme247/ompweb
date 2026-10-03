// Streaming/SSE, message-transform, subagent, and session-protocol helpers
// extracted from useAgentSession (pure logic only — no hook state).

import type {
  AgentMessage,
  CustomMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionTreeNode,
} from "@/lib/types";
import type { ThinkingModelMeta } from "@/lib/thinking-levels";
import type { QueuedMessages, RpcAvailableSlashCommand, SlowModeScope, TodoPhase, UsageLimitState } from "@/lib/pi-types";
import type {
  SubagentHistoryEntry,
  SubagentInfo,
  SubagentProgress,
} from "@/lib/subagent-types";
import { translate } from "@/lib/i18n";
import type { SessionStreamCursor } from "@/lib/session-sync";

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

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
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

export interface AgentEvent {
  type: string;
  web?: SessionStreamCursor;
  [key: string]: unknown;
}

export const SUBAGENT_ACTIVITY_BUFFER_MAX = 50;
// Distinct subagent ids retained in the activity/version maps. Each per-id
// array is already capped, but a long turn can spawn unbounded ids (repeated
// or recursive task calls) — the OUTER maps must be bounded too.
export const SUBAGENT_ACTIVITY_MAX_IDS = 64;

/** Keep only the most recently inserted entries of an id-keyed map. */
export function pruneSubagentIdMap<T>(map: Record<string, T>): Record<string, T> {
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
export function historyEntryToSubagentInfo(entry: SubagentHistoryEntry): SubagentInfo {
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

export interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

export interface LastAssistantTextResponse {
  text?: string;
}

// Shape of lib/rpc-manager's WebSessionState as seen over HTTP.
export type AgentStateResponse = {
  // Raw get_state passthrough: the resolved model omp is actually running.
  model?: { provider: string; id: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  slowModeSupported?: boolean;
  slowModeEnabled?: boolean;
  slowModeScope?: SlowModeScope;
  usageLimit?: UsageLimitState;
  autoRetryEnabled?: boolean;
  interruptMode?: "immediate" | "wait";
  autoCompactionEnabled?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  responseObserved?: boolean;
  tokensPerSecond?: number | null;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: QueuedMessages;
  todoPhases?: TodoPhase[];
};

export function normalizeThinkingLevel(level: string | undefined): ThinkingLevelOption {
  // omp's "inherit" sentinel means "no explicit selection" — show as auto.
  if (!level || level === "inherit") return "auto";
  return level as ThinkingLevelOption;
}

/** Narrow the live state's model (OmpModel: id-based) to the composer's shape. */
export function toThinkingModelMeta(model: { provider?: string; id?: string; name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } } | null | undefined): ThinkingModelMeta | null {
  if (!model?.provider || !model.id) return null;
  return { provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning, thinking: model.thinking };
}

export type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" | "ask" }>;
export type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
// omp's rpc-ui frames add open_url (OAuth) and cancel on top of lib/types' union.
export type IncomingExtensionUiRequest =
  | ExtensionUiRequest
  | { type: "extension_ui_request"; id: string; method: "open_url"; url: string; launchUrl?: string; instructions?: string }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string };

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

export type ThinkingLevelOption = string;

export const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
export const USER_SCROLL_INTENT_MS = 1200;
export const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
export const PROMPT_SETTLE_POLL_MS = 600;
export const PROMPT_SETTLE_MAX_MS = 20_000;
export const AGENT_STATE_RECONCILE_MS = 15_000;
// Stop waits at most this long to take queued messages back before aborting.
export const WITHDRAW_BEFORE_ABORT_MS = 1_500;
export const BASH_STATE_RECONCILE_MS = 1_000;
// Cadence for re-reading a session that some OTHER `omp` process is running.
// omp-web owns no wrapper for those, so /api/agent/<id>/events 409s and nothing
// streams in; the only way their transcript advances is an explicit sync poll.
// Fast enough to look live, far slower than the SSE path it stands in for.
export const EXTERNAL_RUN_POLL_MS = 2_000;
// A tail that stopped growing is not a live foreign run any more (its omp died,
// or the run was interrupted between a tool call and its result). Stop polling;
// the cheap heuristic below re-arms the poll if the transcript grows again.
export const EXTERNAL_RUN_STALE_MS = 60_000;
// A cold `omp --mode rpc-ui` spawn (extension + skill + LSP discovery) can take
// far longer than a few seconds, and the SSE route may only answer once the
// child is ready. Give up only after the child would have timed out anyway
// (rpc-process waitReady is 120s server-side) rather than dropping the prompt.
export const EVENT_STREAM_CONNECT_TIMEOUT_MS = 60_000;
// Tell the user something is happening if the stream is still connecting.
export const EVENT_STREAM_SLOW_CONNECT_MS = 4_000;
// Manual reconnect backoff for a CLOSED event stream (fatal per EventSource,
// so the browser will not retry on its own). Doubles per consecutive failure,
// caps at the max; reset on any successful open. Without this, an idle
// session whose stream died (server hiccup, wrapper respawn) stays dead
// silently until a full page reload.
export const EVENT_STREAM_RETRY_MIN_MS = 1_000;
export const EVENT_STREAM_RETRY_MAX_MS = 30_000;

export const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);
export function isQuotaLikeError(text: string): boolean {
  return /429|quota|RESOURCE_EXHAUSTED|Cloud Code Assist/i.test(text);
}
export type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

export type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

export class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? translate("agentSession.eventStreamTimeout")
      : translate("agentSession.eventStreamFailed"));
    this.name = "EventStreamConnectionError";
  }
}

/**
 * Shared guard for URLs opened from agent/extension open_url requests. Allows
 * only http, https and mailto; rejects javascript:, data:, vbscript:, file:,
 * protocol-relative (//...) and any other scheme so a hostile or malformed URL
 * cannot escape the browser. Preserves existing behavior for safe URLs.
 */
export function isSafeOpenUrl(raw: unknown): boolean {
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

export interface HostToolHandlers {
  /** Open a validated URL; returns the result text reported to the agent. */
  openUrl: (url: string) => string;
  /** Open a file tab; may return the result text reported to the agent. */
  openFile?: (path: string, name: string) => string | void;
}

/**
 * Execute an omp-web host tool (open_url / notify / open_file) and return the
 * toolResult text. Shared by the session's own stream and by tabs answering
 * calls for a session they are not viewing.
 */
export async function runHostTool(
  toolName: string,
  args: Record<string, unknown>,
  handlers: HostToolHandlers,
): Promise<{ text: string; isError: boolean }> {
  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  switch (toolName) {
    case "open_url": {
      const raw = str(args.url) ?? "";
      if (!isSafeOpenUrl(raw)) return { text: "Unsafe or invalid URL not opened", isError: !!raw };
      return { text: handlers.openUrl(raw), isError: false };
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
      return { text: "Notification shown", isError: false };
    }
    case "open_file": {
      const path = str(args.path) ?? "";
      if (!path) return { text: "No path provided", isError: true };
      let text: string | void = undefined;
      if (handlers.openFile) {
        try {
          text = handlers.openFile(path, path.split(/[\\/]/).pop() || path);
        } catch {
          // ignore navigation failures
        }
      }
      return { text: text || `Opened ${path}`, isError: false };
    }
    default:
      return { text: `Host tool "${toolName}" is not available in omp-web`, isError: true };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function extractMessageText(message: Partial<AgentMessage>): string {
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

export function describeMcpMountNotice(message: CustomMessage): string {
  return extractMessageText(message).trim() || "The MCP tool inventory changed.";
}

export function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
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
export function buildOutgoingPrompt(
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

export type SelectedModel = { provider: string; modelId: string };
export type ModelEntry = { id: string; name: string; provider: string; supportsFastMode?: boolean; contextWindow?: number; maxTokens?: number };
export type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  modelError?: string;
};

export type SlashCommandsResponse = {
  commands?: RpcAvailableSlashCommand[];
};

// Map omp's slash-command sources onto the palette's grouping. Builtins are
// skipped: the client intercepts its own builtin set, and other omp builtins
// still work when typed (omp executes them via the prompt command).
export function toSlashCommandInfo(command: RpcAvailableSlashCommand): SlashCommandInfo | null {
  if (command.source === "builtin") return null;
  const source: SlashCommandInfo["source"] = command.source === "extension"
    ? "extension"
    : command.source === "skill"
      ? "skill"
      : "prompt";
  return { name: command.name, description: command.description, source };
}

// omp exposes only the commands its RPC prompt path can actually run. TUI-only
// ones (`/guided-goal`, `/vibe`, `/budget`, …) never appear in `get_commands`,
// so the client has no way to run them and sending one lands in the transcript
// as literal prompt text with no hint that nothing happened (#167).
//
// Callers pass the FULL command list — including the builtins that
// `toSlashCommandInfo` hides from the palette, which are still executed by omp
// when typed and therefore must not warn. An empty list means the roster has
// not arrived yet (or failed), in which case saying "unknown" would be a guess.
export function isUnknownSlashCommand(text: string, knownNames: readonly string[]): boolean {
  if (knownNames.length === 0) return false;
  const match = /^\/([A-Za-z][A-Za-z0-9_-]*)/.exec(text.trim());
  if (!match) return false;
  const name = match[1].toLowerCase();
  return !knownNames.some((known) => known.toLowerCase() === name);
}

/** The bare command word of a prompt that tries to invoke a slash command. */
export function slashCommandName(text: string): string | null {
  return /^\/([A-Za-z][A-Za-z0-9_-]*)/.exec(text.trim())?.[1] ?? null;
}
