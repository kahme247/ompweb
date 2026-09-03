// Types mirrored from oh-my-pi coding-agent session-entries (v3 format).
import type { TodoPhase } from "./pi-types";

// omp-web cannot import the Bun-only @oh-my-pi packages, so the on-disk
// shapes are re-declared here. Legacy pi v1/v2 fields are kept optional.

export type SessionTitleSource = "auto" | "user";

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  /** Current title, folded in from the fixed-width title slot (line 1) on load. */
  title?: string;
  titleSource?: SessionTitleSource;
  timestamp: string;
  cwd: string;
  /** Extra workspace roots beyond cwd (multi-root workspace). */
  additionalDirectories?: string[];
  parentSession?: string;
  providerPromptCacheKey?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

/**
 * Image block. omp persists the flat {data, mimeType} shape (data may be a
 * `blob:sha256:` reference until resolved); legacy pi entries used the nested
 * Anthropic-style `source` shape. The UI handles both.
 */
export interface ImageContent {
  type: "image";
  data?: string;
  mimeType?: string;
  source?: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Historical content omitted from the initial response and loaded on demand. */
  deferred?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  timestamp?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens?: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

/** System-slot instruction message (steering envelopes, file-mention text). */
export interface DeveloperMessage {
  role: "developer";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

/** User-initiated Python execution via the $ command (omp-only). */
export interface PythonExecutionMessage {
  role: "pythonExecution";
  code: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  excludeFromContext?: boolean;
  timestamp?: number;
}

/** Auto-read @filepath mentions packed into a single message (omp-only). */
export interface FileMentionMessage {
  role: "fileMention";
  files: Array<{
    path: string;
    content: string;
    lineCount?: number;
    byteSize?: number;
    skippedReason?: "tooLarge" | "binary";
    image?: ImageContent;
  }>;
  timestamp?: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | CustomMessage
  | BashExecutionMessage
  | DeveloperMessage
  | PythonExecutionMessage
  | FileMentionMessage;

export type ExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "custom";
      lines: string[];
      closed?: boolean;
    };

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel?: string | null;
  /** Configured selector ("auto" or a concrete level); absent on old entries. */
  configured?: string | null;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  /** omp format: "provider/modelId". */
  model?: string;
  /** Model role ("default", "smol", ...); undefined means "default". */
  role?: string;
  /** Legacy pi format kept for pre-migration files. */
  provider?: string;
  modelId?: string;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
  type: "service_tier_change";
  serviceTier: unknown;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  shortSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  /** omp ≥17.4: maintenance method that fired (e.g. "remote-compacted", "handoff"). */
  method?: string;
  tokensAfter?: number;
  details?: unknown;
  preserveData?: Record<string, unknown>;
  fromExtension?: boolean;
  fromHook?: boolean;
  warning?: string;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromExtension?: boolean;
  fromHook?: boolean;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

/** Legacy pi rename entry; omp replaced it with the title slot + title_change. */
export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

/** Append-only audit entry recording a session title change (omp). */
export interface TitleChangeEntry extends SessionEntryBase {
  type: "title_change";
  title: string;
  previousTitle?: string;
  source: SessionTitleSource;
  trigger?: string;
}

/** Tracks which time-traveling rules have been injected this session (omp). */
export interface TtsrInjectionEntry extends SessionEntryBase {
  type: "ttsr_injection";
  injectedRules: string[];
}

/** Initial context capture for subagent sessions (omp). */
export interface SessionInitEntry extends SessionEntryBase {
  type: "session_init";
  systemPrompt: string;
  task: string;
  tools: string[];
  outputSchema?: unknown;
  outputSchemaMode?: string;
  restrictToolNames?: boolean;
  spawns?: string;
  readSummarize?: boolean;
}

/** Agent mode transitions, e.g. plan mode (omp). */
export interface ModeChangeEntry extends SessionEntryBase {
  type: "mode_change";
  /** Current mode name, or "none" when exiting a mode. */
  mode: string;
  data?: Record<string, unknown>;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | ServiceTierChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry
  | TitleChangeEntry
  | TtsrInjectionEntry
  | SessionInitEntry
  | ModeChangeEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface BranchPreview {
  role?: "user" | "assistant";
  text: string;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
  branchPreview?: BranchPreview;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  /** 会话所属的 OMP profile；默认 profile 为 undefined。 */
  profile?: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string; // set if this session was forked from another
  /** Main repo root shared by all worktrees of this cwd (cwd itself for non-git dirs).
   *  Always set by the server; optional because the client builds transient
   *  SessionInfo objects before the first refresh. Fall back to cwd. */
  projectRoot?: string;
  /** Stable identity key for grouping and comparison (case-folded on Windows). */
  projectKey?: string;
  /** Branch name when cwd is a linked git worktree (not the main checkout) */
  worktreeBranch?: string;
}

/** Metadata for a gzip-compressed session in OMP's archive tree. */
export interface ArchivedSessionInfo {
  key: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  archivedAt: string;
  messageCount: number;
  firstMessage: string;
  size: number;
  status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
}

/** 工作区级 omp 启动配置；配置只影响该工作区启动的 omp 子进程。 */
export interface ProjectLaunchConfig {
  /** 使用的 OMP profile。 */
  profile?: string;
  /** 按参数数组保存的额外 OMP CLI 参数。 */
  extraArgs?: string[];
}

/** A project in the sidebar: an explicitly added directory (registered in the
 *  on-disk registry) or one discovered from existing sessions. Paths are the
 *  canonical projectRoot — worktrees resolve to their main repository. */
export interface ManagedProject {
  path: string;
  /** ISO timestamp of the last explicit add. */
  addedAt?: string;
  /** User-defined display name; never changes the directory path. */
  alias?: string;
  /** Explicit sidebar position for registered projects. */
  sortOrder?: number;
  /** 工作区级 omp 启动配置。 */
  launchConfig?: ProjectLaunchConfig;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  /** Latest persisted todo snapshot on the selected session branch. */
  todoPhases: TodoPhase[];
}
