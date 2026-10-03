// Local mirrors of the omp shapes used by omp-web. omp's SDK packages are
// Bun-only, so these types are hand-maintained against
// oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts (protocol v1).

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export type UsageLimitState =
  | { stage: "low_priority"; resetsAtSec: number; allowanceLeftPercent?: number }
  | { stage: "wrap_up"; resetsAtSec?: number; extraUsage: boolean };

export type SlowModeScope = "session" | "global";

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

/** Subset of omp's Model (pi-ai) that the web UI reads; extra fields pass through. */
export interface OmpModel {
  id: string;
  provider: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  thinking?: {
    mode?: string;
    efforts?: string[];
    requiresEffort?: boolean;
    defaultLevel?: string;
  };
  [key: string]: unknown;
}

export interface TodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "blocked" | "abandoned";
  blocker?: string;
}

export interface TodoPhase {
  id?: string;
  name: string;
  tasks: TodoItem[];
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

/** Mirror of omp's RpcSessionState (the raw `get_state` payload). */
export interface RpcSessionState {
  model?: OmpModel;
  thinkingLevel: string | undefined;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  interruptMode: "immediate" | "wait";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  autoRetryEnabled?: boolean;
  messageCount: number;
  queuedMessageCount: number;
  /** Displayable queue-chip texts (omp ≥ 18.4.4); mirrored live by `queue_update`. */
  queuedMessages?: QueuedMessages;
  todoPhases: TodoPhase[];
  systemPrompt?: string[];
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  fastMode?: boolean;
  fastModeEnabled?: boolean;
  fastModeActive?: boolean;
  /** `/slow` applies to the active model (omp ≥ slow-mode RPC). */
  slowModeSupported?: boolean;
  /** Slow setting for the active model; false whenever unsupported. */
  slowModeEnabled?: boolean;
  /** Present iff supported: `global` = persisted omp config shared by every session/terminal; `session` = this session's flex tier. */
  slowModeScope?: SlowModeScope;
  /** Structured provider usage-limit state; absent outside wrap-up and low priority. */
  usageLimit?: UsageLimitState;
  /** omp's reported output throughput; null/undefined when not generating. */
  tokensPerSecond?: number | null;
}

/**
 * The state shape omp-web's own API returns to the browser
 * (AgentSessionWrapper adapts RpcSessionState and adds process-side flags).
 */
export interface WebSessionState {
  sessionId: string;
  sessionFile: string;
  sessionName?: string;
  isStreaming: boolean;
  isPromptRunning: boolean;
  isBashRunning: boolean;
  isCompacting: boolean;
  /** Web-observed current-run response; not a persisted-history cursor. */
  responseObserved?: boolean;
  autoCompactionEnabled: boolean;
  interruptMode: "immediate" | "wait";
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  model?: ModelLike & { name?: string; reasoning?: boolean; thinking?: { efforts?: string[] } };
  messageCount: number;
  queuedMessageCount: number;
  queuedMessages: QueuedMessages;
  contextUsage: ContextUsage | null;
  systemPrompt: string;
  thinkingLevel: string;
  fastModeEnabled: boolean;
  fastModeActive?: boolean;
  slowModeSupported: boolean;
  slowModeEnabled: boolean;
  slowModeScope?: SlowModeScope;
  usageLimit?: UsageLimitState;
  autoRetryEnabled?: boolean;
  tokensPerSecond?: number | null;
  todoPhases: TodoPhase[];
  extensionStatuses: Array<{ key: string; text: string }>;
  extensionWidgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
}

export type AvailableSlashCommandSource =
  | "builtin"
  | "skill"
  | "extension"
  | "custom"
  | "mcp_prompt"
  | "file";

/** Mirror of omp's RpcAvailableSlashCommand (`get_available_commands`). */
export interface RpcAvailableSlashCommand {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint?: string };
  subcommands?: Array<{ name: string; description?: string; usage?: string }>;
  source: AvailableSlashCommandSource;
}

/** Mirror of omp's BashResult (`bash` command response). */
export interface BashResultInfo {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timedOut?: boolean;
  truncated: boolean;
  totalLines?: number;
  totalBytes?: number;
  outputLines?: number;
  outputBytes?: number;
  artifactId?: string;
  workingDir?: string;
}

export interface GenerationSpeedInfo {
  current: number | null;
  average: number | null;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  premiumRequests?: number;
  cost: number;
  contextUsage?: ContextUsage;
}

/** One question of omp's RPC ask dialog (`method: "ask"`, opt-in via `set_ask_dialog`). */
export interface RpcAskDialogQuestion {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multi?: boolean;
  /** Index into `options`. */
  recommended?: number;
}

/** Per-question answer, sent back in question order. */
export interface RpcAskDialogAnswer {
  id: string;
  selectedOptions: string[];
  customInput?: string;
}

/**
 * omp's rpc-ui extension UI request frames, including the methods missing from
 * the browser-facing union in lib/types.ts (`open_url`, `cancel`). The wrapper
 * adds `expiresAt` when a timeout is present so reconnecting clients can
 * expire stale dialogs.
 */
export type OmpExtensionUiRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string; promptStyle?: boolean; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "ask"; questions: RpcAskDialogQuestion[]; timeout?: number; expiresAt?: number }
  | { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
  | { type: "extension_ui_request"; id: string; method: "open_url"; url: string; launchUrl?: string; instructions?: string };

/**
 * omp's RPC host-tool bridge: omp-web registers host tools (set_host_tools)
 * that the agent can call; the server emits host_tool_call frames the UI
 * executes, and the UI answers with host_tool_result. Mirrors
 * oh-my-pi modes/rpc/rpc-types.ts.
 */
export interface HostToolParameter {
  type?: string;
  description?: string;
  [key: string]: unknown;
}

export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: "always" | "discoverable" | "explicit";
}

export interface HostToolCallFrame {
  type: "host_tool_call";
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface HostToolCancelFrame {
  type: "host_tool_cancel";
  id: string;
  targetId: string;
}

export interface HostToolResultFrame {
  type: "host_tool_result";
  id: string;
  result: unknown;
  isError?: boolean;
}

/**
 * omp's RPC host-URI bridge: the host registers URL schemes
 * (set_host_uri_schemes) that the agent's read/write tools resolve through
 * the UI; the server emits host_uri_request frames the UI satisfies with
 * host_uri_result. Mirrors oh-my-pi modes/rpc/rpc-types.ts.
 */
export interface HostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

export type HostUriOperation = "read" | "write";

export interface HostUriRequestFrame {
  type: "host_uri_request";
  id: string;
  operation: HostUriOperation;
  url: string;
  /** Present for write operations. */
  content?: string;
}

export interface HostUriCancelFrame {
  type: "host_uri_cancel";
  id: string;
  targetId: string;
}

export interface HostUriResultFrame {
  type: "host_uri_result";
  id: string;
  content?: string;
  contentType?: "text/markdown" | "application/json" | "text/plain";
  isError?: boolean;
  error?: string;
}
