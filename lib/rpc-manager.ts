import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { validateAgentImages } from "./image-attachments";
import { invalidateModelsCache } from "./models-cache";
import { RpcCommandError, RpcCommandTimeoutError, RpcProcess, type RpcFrame } from "./omp/rpc-process";
import { readNativeSettings } from "./omp/settings-config";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { PRESET_FULL } from "./tool-presets";
import { comparableProjectPath } from "./comparable-path";
import { isReservedLaunchArg, loadProjectRegistry } from "./project-registry";
import { isProfiledSessionKey, profileForSessionKey, sessionKeyForProfile } from "./session-identity";
import type {
  BashResultInfo,
  OmpModel,
  RpcAvailableSlashCommand,
  RpcSessionState,
  SessionStatsInfo,
  WebSessionState,
} from "./pi-types";
import type { ExtensionWidgetItem, ProjectLaunchConfig } from "./types";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;

interface CompactionResultLike {
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /** omp ≥17.4 reports the real post-compaction count when available. */
  tokensAfter?: number;
}

const IDLE_DESTROY_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 120_000;
const MCP_LIST_TIMEOUT_MS = 15_000;
const GET_STATE_TIMEOUT_MS = 5_000;
/** Cap on the *acknowledgement* of a prompt frame — not on model execution.
 * omp acks a prompt as soon as it accepts it and the run then reports through
 * events (agent_start/agent_end), so an ack that never arrives means the child
 * is wedged: without this the API request (and the UI spinner behind it) would
 * stay pending forever. Generous enough to cover slow local startup work the
 * child does before acking. */
const PROMPT_ACK_TIMEOUT_MS = 30_000;
const NON_TERMINAL_CONTINUATION_GRACE_MS = 2_000;
const AWAITING_AGENT_START_TIMEOUT_MS = 10_000;
const RESTARTING_MESSAGE = "This session is restarting — retry in a moment.";
const BASH_EXCLUDE_MESSAGE =
  "omp cannot run a shell command with its output excluded from the model context (`!!`): the RPC bash command has no exclusion option, so the output would silently enter the context anyway. Run it with a single `!` to share the output with the model, or use a terminal outside omp web.";

/**
 * Failure raised by omp-web itself (not by omp) carrying a stable snake_case
 * code. API routes forward `{ error, code }` so the client dictionary can
 * localize it via `errors.<code>` while unknown codes fall back to the text.
 */
export class WebRpcError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "WebRpcError";
    this.code = code;
  }
}

// Extension UI methods that stay pending until the client answers (replayed to
// newly-attached SSE listeners so dialogs survive reconnects).
const PENDING_UI_METHODS = new Set(["select", "confirm", "input", "editor", "open_url"]);

// Commands forwarded to omp verbatim (request shape already matches rpc-types).
const PASSTHROUGH_COMMANDS = new Set([
  "abort",
  "abort_and_prompt",
  "set_thinking_level",
  "cycle_thinking_level",
  "cycle_model",
  "get_available_models",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "abort_bash",
  "set_todos",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_interrupt_mode",
  "get_branch_messages",
  "get_messages",
  "get_messages_page",
  "export_html",
  "handoff",
  "get_subagents",
  "get_subagent_messages",
  "set_subagent_subscription",
  "get_login_providers",
  "login",
]);

// Commands that can carry user-attached images to the model. All of them must
// pass the same server-side per-image/count/aggregate validation before the
// payload reaches omp — a client is free to POST any of them directly.
const IMAGE_BEARING_COMMANDS = new Set(["prompt", "steer", "follow_up", "abort_and_prompt"]);

// pi-web commands with no omp RPC equivalent. The UI tolerates these failing.
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  navigate_tree: "Branch navigation is not supported over the omp RPC protocol",
  clear_queue: "Recalling queued messages is not supported over the omp RPC protocol",
  get_tools: "Per-session tool listing is not supported over the omp RPC protocol",
  set_tools: "Changing tools on a running session is not supported over the omp RPC protocol; tool presets apply to new sessions",
  extension_ui_input: "Extension custom UI is not supported over the omp RPC protocol",
};

// omp aliases "find"->"glob" and has no "ls" tool; the web UI presets still use
// the pi names (lib/tool-presets.ts), so translate before building --tools.
const TOOL_NAME_ALIASES: Record<string, string> = { find: "glob", search: "grep" };
const DROPPED_TOOL_NAMES = new Set(["ls"]);

/** Translate pi-web preset tool names into omp builtin tool names. */
export function mapPresetToolNames(toolNames: string[]): string[] {
  const out: string[] = [];
  for (const raw of toolNames) {
    const lower = raw.toLowerCase();
    if (DROPPED_TOOL_NAMES.has(lower)) continue;
    const mapped = TOOL_NAME_ALIASES[lower] ?? lower;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

const FULL_PRESET_KEY = [...PRESET_FULL].map((n) => n.toLowerCase()).sort().join(",");

/** Extra CLI args for spawning `omp --mode rpc-ui` for a session. */
/** 生成 OMP 启动参数；profile 必须先于 --resume 传入以选择正确的会话存储。 */
export function buildSessionSpawnArgs(sessionFile: string, toolNames?: string[], advisor = false, launchConfig?: ProjectLaunchConfig): string[] {
  const args: string[] = [];
  if (advisor) args.push("--advisor");
  if (launchConfig?.profile && !launchConfig.profile.startsWith("-")) args.push("--profile", launchConfig.profile);
  if (launchConfig?.extraArgs) args.push(...launchConfig.extraArgs.filter((arg) => !isReservedLaunchArg(arg)));
  if (sessionFile) {
    args.push("--resume", sessionFile);
  } else if (toolNames !== undefined) {
    const presetKey = toolNames.map((n) => n.toLowerCase()).sort().join(",");
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else if (presetKey !== FULL_PRESET_KEY) {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  return args;
}

function toImageContents(value: unknown): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  const images = value as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  return images?.length ? images : undefined;
}

/**
 * Pick a spawn cwd that actually exists. A session records the directory it was
 * created in, but that directory may have been deleted since: spawn() would
 * fail with ENOENT and `omp --cwd <missing>` throws in setProjectDir. omp's own
 * resume path skips the chdir when the recorded project dir is gone and keeps
 * the launch cwd (main.ts), so hand it a live directory and let it decide.
 */
export function resolveSpawnCwd(recordedCwd?: string | null): string {
  return resolveSpawnCwdResult(recordedCwd).cwd;
}

/**
 * Resolve a spawn cwd and report whether it differs from the session's recorded
 * directory. Callers that surface a UI (the SSE resume paths) use the result to
 * emit a notice so the user knows the agent is running somewhere other than the
 * directory the sidebar/header still advertises — a silent wrong-tree fallback
 * would let file tool calls edit an unexpected repo with no signal.
 */
export function resolveSpawnCwdResult(recordedCwd?: string | null): { cwd: string; fellBack: boolean } {
  if (recordedCwd && existsSync(recordedCwd)) return { cwd: recordedCwd, fellBack: false };
  try {
    const serverCwd = process.cwd();
    if (serverCwd && existsSync(serverCwd)) return { cwd: serverCwd, fellBack: true };
  } catch {
    // process.cwd() itself throws when the server's own cwd was removed.
  }
  return { cwd: homedir(), fellBack: true };
}

/** omp's CompactionResult historically omitted any post-compaction token
 * count; approximate it from the summary so the compaction banner can show
 * savings instead of "→ 0 tokens". Newer omp reports a real `tokensAfter` —
 * prefer it when present. */
function patchEstimatedTokensAfter(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const compaction = result as CompactionResultLike;
  if (compaction.estimatedTokensAfter === undefined) {
    // Prefer omp ≥17.4's real post-compaction count; fall back to the
    // summary-length estimate for older builds.
    const rawTokensAfter = typeof compaction.tokensAfter === "number"
      ? Math.max(0, compaction.tokensAfter)
      : (compaction.summary?.length ?? 0) / 4;
    compaction.estimatedTokensAfter = Math.round(rawTokensAfter);
  }
}

// ============================================================================
// AgentSessionWrapper
// Wraps one spawned `omp --mode rpc-ui` process with the interface the rest of
// the app expects (same command surface pi-web's in-process wrapper offered).
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiRequests = new Map<string, AgentEvent>();
  private uiExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private promptDispatchPendingCount = 0;
  private awaitingAgentStart = false;
  private awaitingAgentStartDeadline = 0;
  private continuationGraceUntil = 0;
  private bashRunning = false;
  private streaming = false;
  private compacting = false;
  private fastModeEnabled = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private onIdentityChangeCallback: ((oldId: string, newId: string) => void) | null = null;
  private unsubscribeFrames: (() => void) | null = null;
  private initPromise: Promise<void> | null = null;
  private restarting = false;
  private mcpListWaiter: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Synchronous mutex for getMcpList: checked+set before any await, so two
   *  concurrent callers can never both enter (the waiter/promptRunning
   *  bookkeeping alone is not an atomic gate). */
  private mcpListInFlight = false;
  private _alive = true;
  /** Host tools the web UI registered via set_host_tools (agent-callable). */
  private hostToolNames: Set<string> = new Set();
  /** host_tool_call ids awaiting a host_tool_result from the browser. */
  private pendingHostTools: Map<string, AgentEvent> = new Map();
  /** URI schemes the web UI registered via set_host_uri_schemes. */
  private hostUriSchemes: Map<string, { writable?: boolean }> = new Map();
  /** host_uri_request ids awaiting a host_uri_result from the browser. */
  private pendingHostUris: Map<string, AgentEvent> = new Map();
  /** Resolves once an in-flight destroyAndWait finishes; null when idle. Read
   * by startRpcSession so a replacement spawn awaits the old child's exit. */
  destroyPromise: Promise<void> | null = null;
  private _sessionId = "";
  private _sessionFile = "";
  private _sessionName: string | undefined;
  private proc: RpcProcess;
  readonly cwd: string;
  /** Whether the child was spawned with --advisor. The flag is spawn-time
   * only (no runtime RPC toggles it), so applying a changed advisor setting
   * means replacing an idle child on the next startRpcSession call. */
  readonly advisorSpawned: boolean;
  /** 会话文件所属的 profile；所有 Web 侧缓存与路由键必须携带它。 */
  readonly profile: string | undefined;
  /** The cwd recorded in the session file header; null for brand-new sessions
   * or when the header lacks one. Used to detect a spawn fallback so a notice
   * can warn the user the agent is running in a different directory. */
  private readonly recordedCwd: string | null;

  // Plain field assignments (not TS parameter properties) keep this module
  // runnable under Node's strip-only TypeScript mode for probes/tests.
  constructor(proc: RpcProcess, cwd: string, recordedCwd?: string | null, advisorSpawned = false, profile?: string) {
    this.proc = proc;
    this.cwd = cwd;
    this.recordedCwd = recordedCwd ?? null;
    this.advisorSpawned = advisorSpawned;
    this.profile = profile;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get sessionFile(): string {
    return this._sessionFile;
  }

  isAlive(): boolean {
    return this._alive && this.proc.isAlive;
  }

  isRunning(): boolean {
    return this.isAlive() && (this.promptRunning || this.streaming || this.compacting || this.bashRunning);
  }

  start(): void {
    this.unsubscribeFrames = this.proc.onFrame((frame) => this.handleFrame(frame));
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /** Resolves once the child announced readiness and identity is known. */
  waitUntilReady(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    const ready = await this.proc.waitReady(READY_TIMEOUT_MS);
    await this.proc.negotiateProtocol(ready);
    // Subscribe to subagent lifecycle/progress/event frames so the UI can show
    // a live subagent roster. Older omp builds may not know the command —
    // degrade silently (the UI falls back to no subagent info).
    await this.proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
    const state = await this.getStateWithTimeout();
    this.applyIdentity(state);
    // Warn when the spawn cwd differs from the session's recorded directory.
    // This happens when the recorded cwd was deleted (removed worktree, moved
    // repo, different machine): resolveSpawnCwd silently substituted a live
    // directory so omp can spawn, but without a notice the user would see the
    // sidebar/header still advertise the (gone) recorded path while file tool
    // calls operate on a different tree.
    if (this.recordedCwd && this.recordedCwd !== this.cwd) {
      this.emit({
        type: "notice",
        level: "warning",
        message: `This session's working directory no longer exists; the agent is running in ${this.cwd}.`,
      });
    }
  }

  private applyIdentity(state: RpcSessionState): void {
    this._sessionId = state.sessionId;
    this._sessionFile = state.sessionFile ?? "";
    this._sessionName = state.sessionName;
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this.fastModeEnabled = state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled;
    if (this._sessionFile) cacheSessionPath(sessionKeyForProfile(this.profile, this._sessionId), this._sessionFile);
  }

  handleProcessExit(stderrTail: string): void {
    // A restart disposes the old child on purpose — not a crash.
    if (!this._alive || this.restarting) return;
    const detail = stderrTail.trim().split("\n").pop() ?? "";
    this.emit({
      type: "notice",
      level: "error",
      message: `The omp process for this session exited unexpectedly${detail ? `: ${detail}` : "."}`,
    });
    // Terminal agent_end so a client mid-stream stops spinning immediately
    // instead of waiting for the reconcile poll.
    if (this.streaming || this.promptRunning) this.emit({ type: "agent_end", isTerminal: true, messages: [] });
    this.destroy();
  }

  private handleFrame(frame: RpcFrame): void {
    this.resetIdleTimer();
    const event = frame as AgentEvent;
    let refreshSessionList = false;

    switch (event.type) {
      case "command_output": {
        // `/mcp list` is a local OMP command. Capture its authoritative text for
        // Settings instead of adding an invisible command to the chat stream.
        const waiter = this.mcpListWaiter;
        if (waiter && typeof event.text === "string") {
          clearTimeout(waiter.timer);
          this.mcpListWaiter = null;
          waiter.resolve(event.text);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "agent_start":
        this.promptRunning = true;
        this.streaming = true;
        this.awaitingAgentStart = false;
        this.awaitingAgentStartDeadline = 0;
        this.continuationGraceUntil = 0;
        // The session file can appear just after the prompt acknowledgement.
        // Invalidate and signal the sidebar now rather than waiting for the
        // agent's first reply or terminal event.
        invalidateSessionListCache();
        refreshSessionList = true;
        // If the file is not on disk yet, the sidebar refresh above may walk
        // the sessions dir before it exists — and the mtime-keyed walk cache
        // then stays stale (NTFS does not bump the sessions-root mtime for
        // files added inside a project subdirectory), hiding the running
        // session from the list until the next invalidation (agent_end).
        // Re-signal once the file actually lands.
        if (this._sessionFile && !existsSync(this._sessionFile)) {
          this.signalWhenSessionFileAppears();
        }
        break;
      case "agent_end":
        if (event.isTerminal !== false) {
          this.streaming = false;
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationGraceUntil = 0;
          invalidateSessionListCache();
        } else {
          this.continuationGraceUntil = Date.now() + NON_TERMINAL_CONTINUATION_GRACE_MS;
        }
        break;
      case "prompt_result":
        // Local-only prompt (builtin/extension slash command) — no agent run.
        this.promptRunning = false;
        this.awaitingAgentStart = false;
        this.awaitingAgentStartDeadline = 0;
        break;
      case "auto_compaction_start":
        this.compacting = true;
        break;
      case "auto_compaction_end":
        this.compacting = false;
        // Same patch the manual `compact` path applies — the client reads
        // event.result.estimatedTokensAfter for the banner.
        patchEstimatedTokensAfter(event.result);
        invalidateSessionListCache();
        break;
      case "session_info_update":
        if (typeof event.title === "string") this._sessionName = event.title;
        invalidateSessionListCache();
        refreshSessionList = true;
        break;
      case "response": {
        // Unsolicited failed responses surface async prompt failures (omp
        // reuses the original command id after the immediate ack).
        if (event.success === false && event.command === "prompt") {
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.emit({ type: "prompt_error", errorMessage: (event.error as string) ?? "Prompt failed" });
          notifyRunningChange();
          return;
        }
        break;
      }
      case "extension_ui_request": {
        if (this.trackExtensionUiRequest(event)) {
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_tool_call": {
        const id = typeof event.id === "string" ? event.id : "";
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        // Route REGISTERED host tools to an attached UI (the browser answers
        // via host_tool_result); unregistered tools or no attached listener
        // are rejected immediately so the agent never hangs on a tool nobody
        // will answer.
        if (id && toolName && this.hostToolNames.has(toolName) && this.listeners.length > 0) {
          this.pendingHostTools.set(id, event);
          this.emit(event);
          notifyRunningChange();
          return;
        }
        // Unregistered tool / no listener: reject (emits a notice) and do NOT
        // re-emit the frame — the UI must not answer a call nobody routed.
        this.rejectUnexpectedHostTool(event);
        return;
      }
      case "host_tool_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostTools.delete(targetId)) {
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_uri_request": {
        const id = typeof event.id === "string" ? event.id : "";
        const url = typeof event.url === "string" ? event.url : "";
        // Route registered schemes to an attached UI (the browser answers via
        // host_uri_result); unknown schemes / no listener are rejected so the
        // agent's read/write never hangs.
        const scheme = url.split(":")[0] ?? "";
        const operation = event.operation === "write" ? "write" : "read";
        const registered = this.hostUriSchemes.get(scheme);
        if (id && scheme && registered && (operation !== "write" || registered.writable) && this.listeners.length > 0) {
          this.pendingHostUris.set(id, event);
          this.emit(event);
          notifyRunningChange();
          return;
        }
        this.proc.sendFrame({
          type: "host_uri_result",
          id,
          isError: true,
          error: `URI scheme \"${scheme}\" is not registered by omp-web`,
        });
        return;
      }
      case "host_uri_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostUris.delete(targetId)) {
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
    }

    this.emit(event);
    notifyRunningChange({ refreshSessionList });
  }

  /** Forget a pending dialog and its expiry timer. */
  private forgetPendingUiRequest(id: string): void {
    this.pendingUiRequests.delete(id);
    const timer = this.uiExpiryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.uiExpiryTimers.delete(id);
    }
  }

  private clearPendingUiRequests(): void {
    for (const timer of this.uiExpiryTimers.values()) clearTimeout(timer);
    this.uiExpiryTimers.clear();
    this.pendingUiRequests.clear();
  }

  private trackExtensionUiRequest(event: AgentEvent): boolean {
    const method = event.method as string;
    const id = event.id as string;
    if (method === "cancel") {
      this.forgetPendingUiRequest(event.targetId as string);
      return false;
    }
    // Only the “Allow tool: <name>” confirmation is covered. Other extension
    // prompts, including login/editor confirmations, remain interactive.
    let autoApproveExtension = false;
    try {
      autoApproveExtension = readNativeSettings().settings.tools?.approval?.extension === "allow";
    } catch {
      // A malformed config must not prevent normal interactive approval.
    }
    if (method === "confirm" && typeof event.title === "string" && /^allow tool\s*:/i.test(event.title) && autoApproveExtension) {
      this.forgetPendingUiRequest(id);
      this.proc.sendFrame({ type: "extension_ui_response", id, confirmed: true });
      return true;
    }
    if (PENDING_UI_METHODS.has(method)) {
      this.forgetPendingUiRequest(id);
      const timeout = typeof event.timeout === "number" ? event.timeout : undefined;
      if (timeout && timeout > 0) {
        event.expiresAt = Date.now() + timeout;
        const timer = setTimeout(() => this.forgetPendingUiRequest(id), timeout);
        timer.unref?.();
        this.uiExpiryTimers.set(id, timer);
      }
      this.pendingUiRequests.set(id, event);
      return false;
    }
    if (method === "setStatus") {
      const key = event.statusKey as string;
      const text = event.statusText as string | undefined;
      if (text === undefined) this.extensionStatuses.delete(key);
      else this.extensionStatuses.set(key, text);
      return false;
    }
    if (method === "setWidget") {
      const key = event.widgetKey as string;
      const lines = event.widgetLines as string[] | undefined;
      if (lines === undefined) {
        this.extensionWidgets.delete(key);
      } else {
        this.extensionWidgets.set(key, {
          key,
          lines,
          placement: (event.widgetPlacement as "aboveEditor" | "belowEditor" | undefined) ?? "aboveEditor",
        });
      }
    }
    return false;
  }

  /**
   * Settle a host_tool_call the UI did not register (or arrived with no
   * attached listener) with an explicit error so its agent turn cannot hang
   * forever waiting for a response. Registered host tools are routed to
   * listeners in handleFrame (see the host_tool_call case).
   */
  private rejectUnexpectedHostTool(event: AgentEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) return;
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    this.proc.sendFrame({
      type: "host_tool_result",
      id,
      isError: true,
      result: {
        content: [{
          type: "text",
          text: `Host tool \"${toolName}\" is not available in omp-web. Use OMP's built-in tools within the selected workspace.`,
        }],
      },
    });
    this.emit({ type: "notice", level: "warning", message: `Rejected unavailable host tool: ${toolName}` });
  }

  /** Reject every outstanding host tool call (browser disconnected / destroy). */
  private rejectPendingHostTools(message: string): void {
    for (const id of this.pendingHostTools.keys()) {
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: message }] },
      });
    }
    this.pendingHostTools.clear();
  }

  /** Reject every outstanding host URI request (browser disconnected / destroy). */
  private rejectPendingHostUris(message: string): void {
    for (const id of this.pendingHostUris.keys()) {
      this.proc.sendFrame({
        type: "host_uri_result",
        id,
        isError: true,
        error: message,
      });
    }
    this.pendingHostUris.clear();
  }

  private emit(event: AgentEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A throwing subscriber (SSE encode failure, UI handler bug) must not
        // starve the remaining subscribers — same isolation RpcProcess and
        // notifyRunningChange apply to their listener sets.
      }
    }
  }

  private sessionFileSignalTimer: NodeJS.Timeout | null = null;

  /** Poll briefly for the session file to appear after agent_start, then
   *  invalidate the session-list caches and re-signal the sidebar so the
   *  running session shows up even though the file landed after the first
   *  refresh (see the agent_start case). Bounded (max ~10s) and stops on
   *  destroy. */
  private signalWhenSessionFileAppears(): void {
    if (this.sessionFileSignalTimer) return;
    let attempts = 0;
    const check = () => {
      this.sessionFileSignalTimer = null;
      if (!this._alive || !this._sessionFile) return;
      if (!existsSync(this._sessionFile)) {
        attempts += 1;
        if (attempts < 40) {
          this.sessionFileSignalTimer = setTimeout(check, 250);
        }
        return;
      }
      invalidateSessionListCache();
      notifyRunningChange({ refreshSessionList: true });
    };
    this.sessionFileSignalTimer = setTimeout(check, 250);
  }
  private lastIdleReset = 0;
  private resetIdleTimer(force = false): void {
    const now = Date.now();
    if (!force && this.idleTimer && now - this.lastIdleReset < 5000) {
      return;
    }
    this.lastIdleReset = now;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning()) {
        this.resetIdleTimer(true);
        return;
      }
      this.destroy();
    }, IDLE_DESTROY_MS);
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    const now = Date.now();
    for (const [id, event] of this.pendingUiRequests) {
      const expiresAt = event.expiresAt as number | undefined;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.forgetPendingUiRequest(id);
        continue;
      }
      listener(event);
    }
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
      // No UI attached anymore: reject outstanding host tool calls so the
      // agent never waits forever on a tool nobody will answer.
      if (this.listeners.length === 0) {
        this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool");
        this.rejectPendingHostUris("The web UI disconnected while the agent was waiting for this URI request");
      }
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /** Called when a session-changing command re-keyed this wrapper (branch/new_session/switch_session). */
  onIdentityChange(cb: (oldId: string, newId: string) => void): void {
    this.onIdentityChangeCallback = cb;
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  /** Get OMP's own complete MCP inventory and live connection states. */
  async getMcpList(): Promise<string> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (this.isRunning()) throw new WebRpcError("Wait for the current run to finish", "session_busy");
    if (this.mcpListWaiter || this.mcpListInFlight) throw new WebRpcError("MCP list is already loading", "mcp_list_loading");

    // Dedicated synchronous mutex: promptRunning alone is not atomic — two
    // concurrent callers could both pass the isRunning() check, and the second
    // would steal the waiter so the first hangs to timeout (or receives the
    // other's output). This flag is checked+set before any await.
    this.mcpListInFlight = true;

    this.promptRunning = true;
    notifyRunningChange();
    let resolveOutput!: (text: string) => void;
    let rejectOutput!: (error: Error) => void;
    const output = new Promise<string>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // The timeout, destroy, and sendCommand-failure paths all reject this
    // promise while the only `await output` (success path) may never run —
    // swallow the orphan so it cannot surface as an unhandledRejection.
    void output.catch(() => {});
    const waiter = {
      resolve: resolveOutput,
      reject: rejectOutput,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    waiter.timer = setTimeout(() => {
        if (this.mcpListWaiter !== waiter) return;
        this.mcpListWaiter = null;
        rejectOutput(new WebRpcError("Timed out while loading MCP servers", "mcp_list_timeout"));
      }, MCP_LIST_TIMEOUT_MS);
    // Don't pin the event loop if the caller never awaits (route aborted): the
    // pending-UI timers already unref, this one should too.
    waiter.timer.unref?.();
    this.mcpListWaiter = waiter;

    try {
      await this.proc.sendCommand({ type: "prompt", message: "/mcp list" });
      return await output;
    } catch (error) {
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    } finally {
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
      }
      this.mcpListInFlight = false;
      this.promptRunning = false;
      notifyRunningChange();
    }
  }
  private buildWebState(state: RpcSessionState): WebSessionState {
    const wasRunning = this.isRunning();

    // Reconcile process-side flags with authoritative child state.
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this._sessionName = state.sessionName;
    if (state.sessionId) {
      this._sessionId = state.sessionId;
      this._sessionFile = state.sessionFile ?? this._sessionFile;
    }

    const awaitingExpired = !this.awaitingAgentStart || Date.now() >= this.awaitingAgentStartDeadline;
    const hasPendingWork =
      this.promptDispatchPendingCount > 0 ||
      (this.awaitingAgentStart && !awaitingExpired) ||
      this.mcpListWaiter !== null ||
      this.pendingUiRequests.size > 0 ||
      this.pendingHostTools.size > 0 ||
      this.pendingHostUris.size > 0;

    if (
      state.isStreaming === false &&
      state.isCompacting === false &&
      !hasPendingWork &&
      Date.now() >= this.continuationGraceUntil
    ) {
      this.promptRunning = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
    }

    if (wasRunning && !this.isRunning()) {
      notifyRunningChange();
    }
    return {
      sessionId: state.sessionId,
      sessionFile: state.sessionFile ?? "",
      sessionName: state.sessionName,
      isStreaming: state.isStreaming,
      isPromptRunning: this.promptRunning,
      isBashRunning: this.bashRunning,
      isCompacting: state.isCompacting,
      autoCompactionEnabled: state.autoCompactionEnabled,
      autoRetryEnabled: state.autoRetryEnabled,
      interruptMode: state.interruptMode,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      model: state.model
        ? {
            id: state.model.id,
            provider: state.model.provider,
            name: state.model.name,
            reasoning: state.model.reasoning,
            thinking: state.model.thinking ? { efforts: state.model.thinking.efforts } : undefined,
          }
        : undefined,
      messageCount: state.messageCount,
      queuedMessageCount: state.queuedMessageCount,
      tokensPerSecond: state.tokensPerSecond ?? null,
      contextUsage: state.contextUsage ?? null,
      systemPrompt: state.systemPrompt?.join("\n\n") ?? "",
      thinkingLevel: state.thinkingLevel ?? "off",
      // The child's per-family tier map is authoritative: it changes when the
      // model switches families (isFastModeEnabled is family-scoped) or when
      // the runtime auto-disables priority (e.g. after an Anthropic reject).
      // The wrapper's own flag is only the spawn-time cache.
      fastModeEnabled: state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled,
      fastModeActive: state.fastModeActive,
      todoPhases: state.todoPhases ?? [],
      extensionStatuses: Array.from(this.extensionStatuses, ([key, text]) => ({ key, text })),
      extensionWidgets: Array.from(this.extensionWidgets.values()),
    };
  }

  private async getStateWithTimeout(): Promise<RpcSessionState> {
    return this.proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
  }

  /** After branch/new_session/switch_session the child is on a different
   * session file — re-read identity and re-register in the registry. */
  private async refreshIdentityAfterSessionChange(): Promise<string> {
    const oldId = this._sessionId;
    const state = await this.getStateWithTimeout();
    this.applyIdentity(state);
    if (oldId && oldId !== this._sessionId) {
      this.onIdentityChangeCallback?.(oldId, this._sessionId);
    }
    invalidateSessionListCache();
    return this._sessionId;
  }

  /** Full restart of the child process against the same session file. This is
   * omp-web's `reload`: extensions, skills, prompts, and tools are rediscovered
   * on boot, matching a fresh CLI launch. */
  private async restart(): Promise<void> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    const sessionFile = this._sessionFile;
    const resumable = !!sessionFile && existsSync(sessionFile);
    const old = this.proc;
    // Stays true for the whole restart so send() rejects commands that would
    // otherwise hit the disposed or half-built child.
    this.restarting = true;
    this.unsubscribeFrames?.();
    try {
      await old.dispose();
      if (!this._alive) return;

      this.extensionStatuses.clear();
      this.extensionWidgets.clear();
      this.clearPendingUiRequests();
      this.continuationGraceUntil = 0;
      this.bashRunning = false;
      this.streaming = false;
      this.compacting = false;
      const launchConfig = launchConfigForSession(sessionKeyForProfile(this.profile, this._sessionId), this.cwd);
      const proc = new RpcProcess({
        cwd: this.cwd,
        env: launchEnvForConfig(launchConfig),
        extraArgs: buildSessionSpawnArgs(resumable ? sessionFile : "", undefined, this.advisorSpawned, launchConfig),
        onExit: ({ stderrTail }) => {
          if (this.proc === proc) this.handleProcessExit(stderrTail);
        },
      });
      this.proc = proc;
      this.unsubscribeFrames = proc.onFrame((frame) => this.handleFrame(frame));
      try {
        const ready = await proc.waitReady(READY_TIMEOUT_MS);
        await proc.negotiateProtocol(ready);
        // The replacement process starts with subscriptions disabled; restore
        // the live roster/transcript event stream before reading its state.
        await proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
        const state = await proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
        this.applyIdentity(state);
      } catch (error) {
        // Never leave the replacement running with nobody reading its frames.
        this.unsubscribeFrames?.();
        this.unsubscribeFrames = null;
        void proc.dispose();
        // The wrapper has no usable child left; drop it from the registry so the
        // next request starts a fresh session instead of reusing a corpse.
        this.destroy();
        throw error;
      }
    } finally {
      this.restarting = false;
    }
    notifyRunningChange();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    this.resetIdleTimer();
    const type = command.type as string;

    if (IMAGE_BEARING_COMMANDS.has(type)) {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    const unsupported = UNSUPPORTED_COMMANDS[type];
    if (unsupported) throw new RpcCommandError(type, unsupported, "unsupported");

    switch (type) {
      case "prompt": {
        if (this.bashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        if (!streamingBehavior) {
          this.promptRunning = true;
          this.promptDispatchPendingCount += 1;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationGraceUntil = 0;
          notifyRunningChange();
        }
        try {
          // omp acks immediately; agent output streams as events, completion is
          // agent_end (agent runs) or prompt_result (local-only slash commands).
          const ack = await this.proc.sendCommand<{ agentInvoked?: boolean } | undefined>({
            type: "prompt",
            message: command.message as string,
            ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
          }, PROMPT_ACK_TIMEOUT_MS);
          // Slash commands fully consumed by a builtin report agentInvoked:false
          // in the ack itself — no prompt_result frame follows.
          if (ack?.agentInvoked === false && !streamingBehavior) {
            this.promptRunning = false;
            this.awaitingAgentStart = false;
            this.awaitingAgentStartDeadline = 0;
            this.emit({ type: "prompt_result", agentInvoked: false });
            notifyRunningChange();
          } else if (!streamingBehavior && ack?.agentInvoked !== false) {
            // OMP acked but agent hasn't started yet — keep promptRunning alive
            // until agent_start arrives (or a timeout expires).
            this.awaitingAgentStart = true;
            this.awaitingAgentStartDeadline = Date.now() + AWAITING_AGENT_START_TIMEOUT_MS;
          }
        } catch (error) {
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          notifyRunningChange();
          if (error instanceof RpcCommandTimeoutError) {
            // The child took the frame but never acked it, so nothing will ever
            // report this run: recycle it exactly like the get_state timeout
            // path so the next request spawns a fresh child instead of talking
            // to a wedged one.
            await this.destroyAndWait();
            throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
          }
          throw error;
        } finally {
          if (!streamingBehavior) {
            this.promptDispatchPendingCount = Math.max(0, this.promptDispatchPendingCount - 1);
          }
        }
        return null;
      }

      case "steer":
      case "follow_up": {
        await this.proc.sendCommand({
          type,
          message: command.message as string,
          ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
        });
        return null;
      }

      case "abort":
        await this.withFinalRunningNotification(async () => {
          await this.proc.sendCommand({ type: "abort" });
          // If the prompt was aborted before the agent loop started, no
          // agent_end will arrive to clear the flag; the streaming flag still
          // tracks a live turn that ends with its own agent_end.
          this.promptRunning = false;
          // Clear the pending-start bookkeeping too: hasPendingWork would
          // otherwise suppress stale-state reconciliation for the full
          // AWAITING_AGENT_START_TIMEOUT_MS, leaving the UI showing "running"
          // after an early abort.
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationGraceUntil = 0;
        });
        return null;

      case "get_state": {
        try {
          const state = await this.proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
          return this.buildWebState(state);
        } catch (error) {
          if (error instanceof RpcCommandTimeoutError) {
            await this.destroyAndWait();
            throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
          }
          throw error;
        }
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = await this.proc.sendCommand<OmpModel>({ type: "set_model", provider, modelId });
        invalidateModelsCache();
        invalidateSessionListCache();
        return { id: model.id, provider: model.provider };
      }

      case "set_fast_mode": {
        const enabled = command.enabled === true;
        const result = await this.proc.sendCommand<{ enabled?: boolean; active?: boolean }>({ type: "set_fast_mode", enabled });
        this.fastModeEnabled = result?.enabled ?? enabled;
        return { enabled: this.fastModeEnabled, active: result?.active ?? false };
      }

      case "fork": {
        // omp's `branch` is pi-web's fork: it creates a branched session file
        // and switches this live process onto it (entryId must be a user
        // message entry, matching the web UI's fork buttons).
        if (this.bashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const result = await this.proc.sendCommand<{ text: string; cancelled: boolean }>({
          type: "branch",
          entryId: command.entryId as string,
        });
        if (result.cancelled) return { cancelled: true };
        const newSessionId = await this.refreshIdentityAfterSessionChange();
        return { cancelled: false, newSessionId };
      }

      case "new_session":
      case "switch_session": {
        const result = await this.proc.sendCommand<{ cancelled: boolean }>(command as { type: string });
        if (!result.cancelled) {
          const newSessionId = await this.refreshIdentityAfterSessionChange();
          return { cancelled: false, newSessionId };
        }
        return result;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(async () => {
            this.compacting = true;
            notifyRunningChange();
            try {
              const result = await this.proc.sendCommand<CompactionResultLike>({
                type: "compact",
                ...(command.customInstructions ? { customInstructions: command.customInstructions } : {}),
              });
              patchEstimatedTokensAfter(result);
              return result;
            } finally {
              this.compacting = false;
            }
          });
        } finally {
          invalidateSessionListCache();
        }
      }

      case "abort_compaction":
        // No dedicated RPC command; a plain abort cancels the in-flight turn
        // including compaction work.
        await this.withFinalRunningNotification(() => this.proc.sendCommand({ type: "abort" }));
        return null;

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.proc.sendCommand({ type: "set_session_name", name });
        this._sessionName = name;
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        const stats = await this.proc.sendCommand<Omit<SessionStatsInfo, "sessionName">>({ type: "get_session_stats" });
        return { ...stats, sessionName: this._sessionName };
      }

      case "get_last_assistant_text": {
        const data = await this.proc.sendCommand<{ text: string | null }>({ type: "get_last_assistant_text" });
        return { text: data.text ?? "" };
      }

      case "get_commands": {
        const data = await this.proc.sendCommand<{ commands: RpcAvailableSlashCommand[] }>({
          type: "get_available_commands",
        });
        return data;
      }

      case "reload": {
        await this.restart();
        return { success: true };
      }

      case "extension_ui_response": {
        const { id, ...rest } = command as { id: string; [key: string]: unknown };
        this.forgetPendingUiRequest(id);
        this.proc.sendFrame({ type: "extension_ui_response", id, ...rest });
        return null;
      }

      case "bash": {
        // omp's RPC bash command is `{type:"bash", command}` only (rpc-types.ts)
        // — there is no excludeFromContext option anywhere in modes/rpc. Running
        // a `!!` command anyway would put output the user meant to keep private
        // into the model context, so refuse instead of silently ignoring it.
        if (command.excludeFromContext === true) {
          throw new WebRpcError(BASH_EXCLUDE_MESSAGE, "bash_exclude_unsupported");
        }
        if (this.isRunning()) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        this.bashRunning = true;
        notifyRunningChange();
        try {
          return await this.proc.sendCommand<BashResultInfo>({ type: "bash", command: command.command as string });
        } finally {
          this.bashRunning = false;
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "set_host_tools": {
        const tools = Array.isArray(command.tools) ? command.tools as Array<{ name?: unknown; [key: string]: unknown }> : [];
        const valid = tools.filter((t) => typeof t.name === "string" && t.name);
        this.hostToolNames = new Set(valid.map((t) => t.name as string));
        await this.proc.sendCommand({ type: "set_host_tools", tools: valid });
        return null;
      }

      case "host_tool_result": {
        if (typeof command.id === "string") this.pendingHostTools.delete(command.id);
        await this.proc.sendCommand(command as { type: string });
        return null;
      }

      case "set_host_uri_schemes": {
        const schemes = Array.isArray(command.schemes) ? command.schemes as Array<{ scheme?: unknown; writable?: unknown; [key: string]: unknown }> : [];
        this.hostUriSchemes = new Map();
        for (const entry of schemes) {
          if (typeof entry.scheme === "string" && entry.scheme) {
            this.hostUriSchemes.set(entry.scheme, { writable: entry.writable === true });
          }
        }
        await this.proc.sendCommand({ type: "set_host_uri_schemes", schemes });
        return null;
      }

      case "host_uri_result": {
        if (typeof command.id === "string") this.pendingHostUris.delete(command.id);
        await this.proc.sendCommand(command as { type: string });
        return null;
      }

      default: {
        if (PASSTHROUGH_COMMANDS.has(type)) {
          const result: unknown = await this.proc.sendCommand(command as { type: string });
          if (type === "set_thinking_level") invalidateSessionListCache();
          return result ?? null;
        }
        throw new Error(`Unsupported command: ${type}`);
      }
    }
  }

  destroy(): void {
    void this.destroyAndWait();
  }

  /** Destroy and resolve only after the omp child has fully exited. Callers
   * that delete the session file afterwards must await this — omp flushes
   * session state on shutdown and would otherwise recreate the file. */
  async destroyAndWait(): Promise<void> {
    // Re-entrant calls join the in-flight dispose; without this a new spawn
    // can overlap the old child's shutdown (see startRpcSession).
    if (this.destroyPromise) return this.destroyPromise;
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sessionFileSignalTimer) {
      clearTimeout(this.sessionFileSignalTimer);
      this.sessionFileSignalTimer = null;
    }
    this.unsubscribeFrames?.();
    this.clearPendingUiRequests();
    this.promptDispatchPendingCount = 0;
    this.awaitingAgentStart = false;
    this.awaitingAgentStartDeadline = 0;
    this.continuationGraceUntil = 0;
    if (this.mcpListWaiter) {
      clearTimeout(this.mcpListWaiter.timer);
      this.mcpListWaiter.reject(new Error("Session was closed while loading MCP servers"));
      this.mcpListWaiter = null;
    }
    const disposed = this.proc.dispose().catch(() => {});
    this.destroyPromise = disposed;
    this.pendingHostTools.clear();
    this.hostToolNames.clear();
    this.pendingHostUris.clear();
    this.hostUriSchemes.clear();
    notifyRunningChange();
    await disposed;
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================
export interface RunningRpcSession {
  /** 含 profile 的 Web 会话标识，避免不同 profile 的原生 id 碰撞。 */
  id: string;
  cwd: string;
}

export interface RunningSessionUpdate {
  ids: string[];
  runningSessions: RunningRpcSession[];
  refreshSessionList: boolean;
}

declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompRunningListeners: Set<(update: RunningSessionUpdate) => void> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => globalThis.__ompSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) globalThis.__ompStartLocks = new Map();
  return globalThis.__ompStartLocks;
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

export function getRunningRpcSessions(): RunningRpcSession[] {
  const map = new Map<string, string>();
  for (const [sessionKey, session] of getRegistry()) {
    if (session.isRunning()) {
      const nativeSessionId = session.sessionId || sessionKey;
      map.set(sessionKeyForProfile(session.profile, nativeSessionId), session.cwd);
    }
  }
  return [...map.entries()].map(([id, cwd]) => ({ id, cwd }));
}

export function getRunningRpcSessionIds(): string[] {
  return getRunningRpcSessions().map((s) => s.id);
}

/** Stop all live omp children after an explicit runtime update. The browser will
 * reconnect sessions on demand and start them with the updated executable. */
export async function restartAllRpcSessions(): Promise<number> {
  const sessions = [...new Set(getRegistry().values())];
  await Promise.all(sessions.map((session) => session.destroyAndWait()));
  return sessions.length;
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(update: RunningSessionUpdate) => void> {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  return globalThis.__ompRunningListeners;
}

/** Subscribe to running-session-id changes and session-list refreshes. */
export function subscribeRunningSessions(listener: (update: RunningSessionUpdate) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, when it changes, broadcast it.
 * A session file may first appear after its id starts running, so callers can
 * force one otherwise-identical update to refresh sidebar session metadata.
 */
export function notifyRunningChange({ refreshSessionList = false }: { refreshSessionList?: boolean } = {}): void {
  const runningSessions = getRunningRpcSessions();
  const ids = runningSessions.map((s) => s.id);
  if (runningSessions.length === 0 && lastRunningSnapshot === "[]" && !refreshSessionList) return;
  const snapshot = JSON.stringify(runningSessions.slice().sort((a, b) => a.id.localeCompare(b.id)));
  if (snapshot === lastRunningSnapshot && !refreshSessionList) return;
  lastRunningSnapshot = snapshot;
  const update: RunningSessionUpdate = { ids, runningSessions, refreshSessionList };
  for (const listener of getRunningListeners()) {
    try { listener(update); } catch { /* ignore listener errors */ }
  }
}

/** 为 OMP 子进程注入 profile 环境，确保路径解析早于 CLI 恢复流程生效。 */
function launchEnvForConfig(launchConfig: ProjectLaunchConfig | undefined): Record<string, string> | undefined {
  const profile = launchConfig?.profile;
  return profile ? { OMP_PROFILE: profile, PI_PROFILE: profile } : undefined;
}

/** 将工作区配置绑定到会话自身的 profile，避免恢复时被当前设置改写。 */
function launchConfigForSession(sessionKey: string, cwd: string): ProjectLaunchConfig | undefined {
  const config = launchConfigForCwd(cwd);
  if (!isProfiledSessionKey(sessionKey)) return config;
  return { ...config, profile: profileForSessionKey(sessionKey) };
}

/** 获取工作区注册的启动配置；未注册项目不附加配置。 */
function launchConfigForCwd(cwd: string): ProjectLaunchConfig | undefined {
  let canonical = cwd;
  try { canonical = realpathSync(cwd); } catch {}
  const key = comparableProjectPath(canonical);
  return loadProjectRegistry().projects.find((project) => {
    if (project.hidden) return false;
    const projectKey = comparableProjectPath(project.path);
    return projectKey === key || key.startsWith(`${projectKey}-worktrees/`);
  })?.launchConfig;
}

/**
 * 获取或创建 omp RPC 会话。
 * 新会话必须在进程 ready 后切换到空会话，避免 omp 默认加载当前 profile
 * 最近一次历史记录；恢复会话则始终通过 --resume 指定文件。
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  /** Spawn-time --advisor flag. Pass an explicit boolean to replace an idle
   * child whose flag differs; pass undefined to reuse whatever is alive. */
  advisor?: boolean,
  /** The cwd recorded in the session file header, used to detect a spawn
   * fallback (recorded dir gone) and warn the user. Omit for new sessions. */
  recordedCwd?: string | null,
  launchConfig?: ProjectLaunchConfig,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();
  launchConfig = launchConfig ?? launchConfigForSession(sessionId, cwd);

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    // --advisor is a spawn-time flag with no runtime RPC. When the caller
    // carries an explicit advisor setting that differs from the live child's,
    // replace the child so the toggle takes effect on the next prompt. Busy
    // children are kept (a mid-run swap would drop in-flight work) and pick
    // the new flag up at the next natural respawn; callers that pass no
    // advisor opinion (undefined) simply reuse whatever is running.
    if (advisor === undefined || existing.advisorSpawned === advisor || existing.isRunning()) {
      return { session: existing, realSessionId: sessionId };
    }
    await existing.destroyAndWait();
  }
  // A wrapper whose omp child is still flushing/exiting must fully dispose
  // before a replacement spawns — two children touching the same .jsonl would
  // race on resume/delete/archive.
  if (existing?.destroyPromise) await existing.destroyPromise;

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // The wrapper needs the process and the process's onExit needs the wrapper;
    // the holder breaks that cycle (onExit only fires once the child dies).
    const holder: { wrapper?: AgentSessionWrapper } = {};
    const proc = new RpcProcess({
      cwd,
      env: launchEnvForConfig(launchConfig),
      extraArgs: buildSessionSpawnArgs(sessionFile, toolNames, advisor === true, launchConfig),
      onExit: ({ stderrTail }) => holder.wrapper?.handleProcessExit(stderrTail),
    });
    const sessionProfile = profileForSessionKey(sessionId) ?? launchConfig?.profile;
    const created = new AgentSessionWrapper(proc, cwd, recordedCwd, advisor === true, sessionProfile);
    holder.wrapper = created;
    created.start();
    try {
      await created.waitUntilReady();
      if (!sessionFile) {
        // omp RPC 启动可能自动附着 profile 最近会话；ready 后显式切换到
        // 新会话，确保新建对话不会继承旧历史内容。
        await created.send({ type: "new_session" });
      }
    } catch (error) {
      // Await the child's full exit before the `finally` releases the startup
      // lock，避免失败重试与旧进程并发操作同一会话。
      await created.destroyAndWait();
      throw error;
    }

    const realSessionId = sessionKeyForProfile(created.profile, created.sessionId);
    created.onDestroy(() => {
      if (registry.get(sessionKeyForProfile(created.profile, created.sessionId)) === created) registry.delete(sessionKeyForProfile(created.profile, created.sessionId));
      if (registry.get(realSessionId) === created) registry.delete(realSessionId);
    });
    created.onIdentityChange((oldId, newId) => {
      const oldSessionKey = sessionKeyForProfile(created.profile, oldId);
      if (registry.get(oldSessionKey) === created) registry.delete(oldSessionKey);
      registry.set(sessionKeyForProfile(created.profile, newId), created);
    });
    registry.set(realSessionId, created);
    return { session: created, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
