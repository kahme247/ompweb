import { randomUUID } from "crypto";
import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { validateAgentImages } from "./image-attachments";
import { hasVisibleAssistantContent } from "./assistant-response";
import { invalidateModelsCache } from "./models-cache";
import { RpcCommandError, RpcCommandTimeoutError, RpcProcess, type RpcFrame } from "./omp/rpc-process";
import { readNativeSettings } from "./omp/settings-config";
import { getAgentEnvOverrides } from "./omp/agent-env";
import {
  cacheSessionPath,
  invalidateSessionEntriesCache,
  invalidateSessionListCache,
  invalidateSessionListMeta,
  readSessionHeader,
  resolveSessionPath,
} from "./session-reader";
import { markShuttingDown, recordRunningSessions, RESUME_PROMPT, takeInterruptedSessions } from "./session-resume";
import { PRESET_FULL } from "./tool-presets";
import { comparableProjectPath } from "./comparable-path";
import { isRecord } from "./type-guards";
import { isReservedLaunchArg, loadProjectRegistry } from "./project-registry";
import type {
  BashResultInfo,
  OmpModel,
  RpcAvailableSlashCommand,
  RpcSessionState,
  SessionStatsInfo,
  WebSessionState,
} from "./pi-types";
import type { AgentMessage, CrossSessionHostToolCall, ExitedRpcSession, ExtensionWidgetItem, ProjectLaunchConfig } from "./types";
import type { SessionLiveSnapshot, SessionLiveToolEvent, SessionStreamCursor } from "./session-sync";

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  web: SessionStreamCursor;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;
type UnsequencedAgentEvent = { type: string; [key: string]: unknown };

interface CompactionResultLike {
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /** omp ≥17.4 reports the real post-compaction count when available. */
  tokensAfter?: number;
}

const IDLE_DESTROY_MS = 10 * 60 * 1000;
/**
 * How long a session may sit with **no web UI attached** before its omp child is
 * torn down. IDLE_DESTROY_MS (10min) is the backstop for a session that keeps
 * receiving traffic; this is the much faster path for "the user closed the tab
 * and walked away", so abandoned children don't hold a slot for 10 minutes.
 *
 * The floor is set by the *client*, not the server: when an SSE stream dies the
 * browser retries with capped backoff (`EVENT_STREAM_RETRY_MAX_MS` = 30s in
 * `hooks/useAgentSession-stream.ts`), and a backgrounded tab clamps its timers
 * to ~1/min. A window anywhere near 60s therefore races the reconnect and turns
 * a returning tab into a 409 "Session is not managed by omp-web" plus a cold
 * respawn. 120s keeps ~2x the retry ceiling and still reclaims 5x faster than
 * the idle backstop. Set `OMP_WEB_DISCONNECT_DESTROY_MS=0` to disable reaping
 * and fall back to IDLE_DESTROY_MS alone.
 */
const DISCONNECT_DESTROY_MS = process.env.OMP_WEB_DISCONNECT_DESTROY_MS !== undefined
  ? Math.max(0, Number(process.env.OMP_WEB_DISCONNECT_DESTROY_MS) || 0)
  : 120_000;
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
const PENDING_UI_METHODS = new Set(["select", "confirm", "input", "editor", "ask", "open_url"]);

/** Shape check for an ask-dialog `answers` payload; omp validates the content. */
function isAskAnswers(value: unknown): boolean {
  return Array.isArray(value) && value.every((answer: unknown) =>
    isRecord(answer)
    && typeof answer.id === "string"
    && Array.isArray(answer.selectedOptions)
    && answer.selectedOptions.every((option: unknown) => typeof option === "string")
    && (answer.customInput === undefined || typeof answer.customInput === "string"));
}

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
  "predict_word",
  "predict_word_feedback",
  "btw",
  "btw_cancel",
  "get_btw_history",
]);

// Outlasts omp's cold prediction-daemon start (up to 3 × 30s start rounds plus a
// 30s first completion), so omp's answer or error decides; a wedged daemon still
// cannot pin the request forever.
const PREDICT_WORD_TIMEOUT_MS = 125_000;

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
export function buildSessionSpawnArgs(sessionFile: string, toolNames?: string[], advisor = false, launchConfig?: ProjectLaunchConfig): string[] {
  const args: string[] = [];
  if (sessionFile) {
    // An absolute path (or anything containing "/") resolves deterministically:
    // omp's createSessionManager opens it directly via SessionManager.open
    // without any interactive resume/fork prompts (main.ts resume handling).
    args.push("--resume", sessionFile);
  } else if (toolNames !== undefined) {
    const presetKey = toolNames.map((n) => n.toLowerCase()).sort().join(",");
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else if (presetKey === FULL_PRESET_KEY) {
      // "Full" means everything: leave omp's complete default toolset intact
      // rather than restricting it to the (much smaller) pi preset list.
    } else {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  if (advisor) args.push("--advisor");
  else if (launchConfig?.advisor) args.push("--advisor");
  // Defense in depth: the registry is hand-editable, so re-strip reserved
  // args and dash-leading profiles at the spawn boundary even though the
  // API validates them on write.
  if (launchConfig?.profile && !launchConfig.profile.startsWith("-")) args.push("--profile", launchConfig.profile);
  if (launchConfig?.extraArgs) args.push(...launchConfig.extraArgs.filter((arg) => !isReservedLaunchArg(arg)));
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
  private pendingUiRequests = new Map<string, UnsequencedAgentEvent>();
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
  private streamId = randomUUID();
  private streamSequence = 0;
  private streamingMessage: Partial<AgentMessage> | null = null;
  private liveToolEvents = new Map<string, SessionLiveToolEvent>();
  /** Positive evidence for this run, retained after native completion but before disk append. */
  private responseObserved = false;
  private responseRunActive = false;
  private fastModeEnabled = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lazily-armed deadline for tearing down a session nobody is watching. */
  private reapTimer: ReturnType<typeof setTimeout> | null = null;
  private reapDeadline = 0;
  private lastActivityAt = 0;
  /** In-flight `send()` calls: the reaper must never dispose the child out from
   * under a command that is still awaiting its response. */
  private pendingCommands = 0;
  /** The start handshake (ready + protocol negotiation + get_state) is in flight. */
  private handshaking = false;
  private readonly disconnectDestroyMs: number;
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
  private pendingHostTools: Map<string, UnsequencedAgentEvent> = new Map();
  /** URI schemes the web UI registered via set_host_uri_schemes. */
  private hostUriSchemes: Map<string, { writable?: boolean }> = new Map();
  /** host_uri_request ids awaiting a host_uri_result from the browser. */
  private pendingHostUris: Map<string, UnsequencedAgentEvent> = new Map();
  /** Resolves once an in-flight destroyAndWait finishes; null when idle. Read
   * by startRpcSession so a replacement spawn awaits the old child's exit. */
  destroyPromise: Promise<void> | null = null;
  private _sessionId = "";
  private _sessionFile = "";
  private _sessionName: string | undefined;
  private proc: RpcProcess;
  /** Process whose exit is expected because reload is deliberately disposing it. */
  private expectedExitProc: RpcProcess | null = null;
  readonly cwd: string;
  /** Whether the child was spawned with --advisor. The flag is spawn-time
   * only (no runtime RPC toggles it), so applying a changed advisor setting
   * means replacing an idle child on the next startRpcSession call. */
  readonly advisorSpawned: boolean;
  /** The cwd recorded in the session file header; null for brand-new sessions
   * or when the header lacks one. Used to detect a spawn fallback so a notice
   * can warn the user the agent is running in a different directory. */
  private readonly recordedCwd: string | null;

  // Plain field assignments (not TS parameter properties) keep this module
  // runnable under Node's strip-only TypeScript mode for probes/tests.
  constructor(
    proc: RpcProcess,
    cwd: string,
    recordedCwd?: string | null,
    advisorSpawned = false,
    expectedSessionId = "",
    /** Test seam: the real value is DISCONNECT_DESTROY_MS (120s), far too long
     *  for a unit test. 0 disables reaping for that wrapper. */
    disconnectDestroyMs: number = DISCONNECT_DESTROY_MS,
  ) {
    this.proc = proc;
    this.cwd = cwd;
    this.recordedCwd = recordedCwd ?? null;
    this.advisorSpawned = advisorSpawned;
    this._sessionId = expectedSessionId;
    this.disconnectDestroyMs = disconnectDestroyMs;
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

  /** A web UI (SSE stream) is currently attached to this session. */
  hasSubscribers(): boolean {
    return this.listeners.length > 0;
  }

  /**
   * Any real use of the session: an attached UI, a command from an API route, or
   * a frame from the child. `resetIdleTimer()` is the single choke point for all
   * three (start(), handleFrame(), send()), so driving reaping from here means
   * the deadline can never drift away from what the session is actually doing.
   *
   * Deliberately does NOT touch a timer: only the *deadline* moves, and
   * `armReap` keeps at most one timer alive, so a 100fps token stream costs a
   * timestamp write instead of clearTimeout/setTimeout churn.
   */
  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
    this.armReap();
  }

  private armReap(): void {
    if (this.reapTimer || this.disconnectDestroyMs <= 0) return;
    if (this.hasSubscribers() || !this.isAlive()) return;
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null;
      this.reapIfDisconnected();
    }, Math.max(0, this.reapDeadline - Date.now()));
    // Never pin the event loop for a cleanup deadline (cf. the MCP waiter and
    // lib/session-resume.ts): an unref'd reap must not delay process exit.
    this.reapTimer.unref?.();
  }

  /**
   * Tear the child down only when nobody can observe the loss. Every condition
   * here is a hard invariant, not a heuristic:
   *  - a subscriber means an open HTTP 200 stream that `destroy()` would leave
   *    half-open (the route holds its own detach + heartbeat), so the run would
   *    vanish silently and the tab would only notice via a later 409;
   *  - isRunning() covers an in-flight turn that no listener is watching;
   *  - handshaking covers a spawn that has not finished its startup handshake;
   *  - pendingCommands covers a route command (predict_word, mcp list, export)
   *    whose response the child still owes us;
   *  - the deadline check absorbs activity that landed while this fired.
   * Anything else keeps the session and re-arms for the remaining window.
   */
  private reapIfDisconnected(): void {
    if (!this.isAlive() || this.hasSubscribers() || this.isRunning()
      || this.handshaking || this.pendingCommands > 0) {
      this.armReap();
      return;
    }
    if (Date.now() < this.reapDeadline) {
      this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
      this.armReap();
      return;
    }
    this.destroy();
  }

  /** NDJSON messages are fresh snapshots; copy containers, not token payloads. */
  getStreamSnapshot(): SessionLiveSnapshot {
    return {
      cursor: { streamId: this.streamId, sequence: this.streamSequence },
      isStreaming: this.streaming,
      isPromptRunning: this.promptRunning,
      isCompacting: this.compacting,
      responseObserved: this.responseObserved,
      streamingMessage: this.streamingMessage ? { ...this.streamingMessage } : null,
      toolEvents: Array.from(this.liveToolEvents.values(), (event) => ({ ...event })),
    };
  }

  private clearLiveSnapshots(): void {
    this.streamingMessage = null;
    this.liveToolEvents.clear();
    this.streamSequence += 1;
  }

  private resetStream(): void {
    this.clearLiveSnapshots();
    this.responseObserved = false;
    this.responseRunActive = false;
    this.streamId = randomUUID();
    this.streamSequence = 0;
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
    // READY_TIMEOUT_MS and the reap window are the same order of magnitude, so
    // the handshake itself counts as in-flight work: a child that is slow to
    // announce itself must be torn down by its own startup timeout (which
    // reports a real error), never by the reaper.
    this.handshaking = true;
    try {
      const ready = await this.proc.waitReady(READY_TIMEOUT_MS);
      await this.proc.negotiateProtocol(ready);
      // Subscribe to subagent lifecycle/progress/event frames so the UI can show
      // a live subagent roster. Older omp builds may not know the command —
      // degrade silently (the UI falls back to no subagent info).
      await this.proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
      // Opt into omp's all-questions ask dialog; older omp rejects the command
      // and keeps the per-question select/editor fallback.
      // Bounded like get_state so a child that never answers cannot stall startup.
      await this.proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
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
    } finally {
      this.handshaking = false;
      // The handshake is real activity, so the reap clock restarts from here
      // rather than from spawn (a slow start must not eat the whole window).
      this.noteActivity();
    }
  }

  private applyIdentity(state: RpcSessionState): void {
    if (this._sessionId && (state.sessionId !== this._sessionId || (state.sessionFile && state.sessionFile !== this._sessionFile))) {
      this.resetStream();
      this.promptRunning = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationGraceUntil = 0;
    }
    this._sessionId = state.sessionId;
    this._sessionFile = state.sessionFile ?? "";
    this._sessionName = state.sessionName;
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this.fastModeEnabled = state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled;
    if (this._sessionFile) cacheSessionPath(this._sessionId, this._sessionFile);
  }

  handleProcessExit(
    { code, signal, stderrTail }: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
    sourceProc: RpcProcess = this.proc,
  ): void {
    if (!this._alive || sourceProc === this.expectedExitProc) return;
    const detail = (stderrTail.trim().split("\n").pop() ?? "").slice(-500);
    const status = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
    // Recorded before destroy(): its running-change broadcast must carry the
    // record so sidebars that missed the notice below still see the exit.
    if (this._sessionId) getExitedMap().set(this._sessionId, { id: this._sessionId, cwd: this.cwd, at: Date.now(), code, signal, detail });
    this.emit({
      type: "notice",
      level: "error",
      message: `The omp process for this session exited unexpectedly (${status})${detail ? `: ${detail}` : "."}`,
    });
    // Terminal agent_end so a client mid-stream stops spinning immediately
    // instead of waiting for the reconcile poll.
    if (this.streaming || this.promptRunning) this.emit({ type: "agent_end", isTerminal: true, messages: [] });
    this.destroy();
  }

  private handleFrame(frame: RpcFrame): void {
    this.resetIdleTimer();
    const event = frame;
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
        this.invalidateSessionLists();
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
          this.invalidateSessionLists();
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
        this.invalidateSessionLists();
        break;
      case "session_info_update":
        if (typeof event.title === "string") this._sessionName = event.title;
        this.invalidateSessionLists();
        refreshSessionList = true;
        break;
      case "response": {
        // Unsolicited failed responses surface async prompt failures (omp
        // reuses the original command id after the immediate ack). Some omp
        // versions omit `command` on that second response, so the active run
        // is also a terminal-failure signal. Otherwise this frame would be
        // ignored and the UI would stop with no explanation.
        if (event.success === false) {
          const promptFailure =
            event.command === "prompt" ||
            (!event.command && (this.promptRunning || this.streaming));
          const detail = typeof event.error === "string"
            ? event.error
            : typeof event.message === "string"
              ? event.message
              : "RPC command failed";
          if (!promptFailure) {
            this.emit({ type: "error", error: event.error, message: detail, command: event.command });
            notifyRunningChange();
            return;
          }
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.emit({ type: "prompt_error", errorMessage: detail, error: event.error, command: event.command });
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
        // via host_tool_result). With no tab on this session, hand the call to
        // any open omp-web tab (the user switched sessions mid-run). Otherwise
        // reject immediately so the agent never hangs on a tool nobody will
        // answer.
        if (id && toolName && this.hostToolNames.has(toolName)) {
          if (this.listeners.length > 0) {
            this.pendingHostTools.set(id, event);
            this.emit(event);
            notifyRunningChange();
            return;
          }
          const otherTabs = getHostToolListeners();
          if (otherTabs.size > 0) {
            this.pendingHostTools.set(id, { ...event, webCrossSession: true });
            const args = event.arguments && typeof event.arguments === "object" ? event.arguments as Record<string, unknown> : {};
            const call: CrossSessionHostToolCall = { sessionId: this.sessionId, id, toolName, arguments: args };
            for (const listener of otherTabs) {
              try { listener(call); } catch { /* ignore listener errors */ }
            }
            notifyRunningChange();
            return;
          }
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

  private trackExtensionUiRequest(event: UnsequencedAgentEvent): boolean {
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
  private rejectUnexpectedHostTool(event: UnsequencedAgentEvent): void {
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

  /**
   * Reject outstanding host tool calls (browser disconnected / destroy): "own" ones went to this session's
   * stream, "cross" ones to other open tabs (see subscribeHostToolCalls).
   */
  private rejectPendingHostTools(message: string, which: "all" | "own" | "cross" = "all"): void {
    for (const [id, event] of this.pendingHostTools) {
      const cross = event.webCrossSession === true;
      if ((which === "own" && cross) || (which === "cross" && !cross)) continue;
      this.pendingHostTools.delete(id);
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: message }] },
      });
    }
  }

  /** The last other tab left: settle calls routed to other tabs. */
  rejectCrossSessionHostTools(): void {
    this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool", "cross");
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

  private emit(event: UnsequencedAgentEvent): void {
    // `web` belongs to this wrapper, never to native/extension-supplied frames.
    // Strip it before caching tool snapshots as well as before wire emission.
    delete event.web;
    switch (event.type) {
      case "agent_start":
        this.responseObserved = false;
        this.responseRunActive = true;
        this.clearLiveSnapshots();
        break;
      case "agent_end":
        if (event.isTerminal === false) break;
        this.responseRunActive = false;
        this.streaming = false;
        this.promptRunning = false;
        this.compacting = false;
        this.clearLiveSnapshots();
        break;
      case "prompt_error":
      case "prompt_result":
        this.responseRunActive = false;
        this.streaming = false;
        this.compacting = false;
        this.promptRunning = false;
        this.clearLiveSnapshots();
        break;
      case "message_start":
      case "message_update": {
        const message = event.message as Partial<AgentMessage> | undefined;
        if (message && message.role !== "user") this.streamingMessage = message;
        if (this.responseRunActive && hasVisibleAssistantContent(message)) this.responseObserved = true;
        break;
      }
      case "message_end": {
        const message = event.message as Partial<AgentMessage> | undefined;
        if (this.responseRunActive && hasVisibleAssistantContent(message)) this.responseObserved = true;
        if (message?.role && message.role === this.streamingMessage?.role) this.streamingMessage = null;
        if (message?.role === "toolResult" && message.toolCallId) this.liveToolEvents.delete(message.toolCallId);
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
        if (typeof event.toolCallId === "string") {
          this.liveToolEvents.set(event.toolCallId, {
            ...this.liveToolEvents.get(event.toolCallId),
            ...event,
            type: event.type,
            toolCallId: event.toolCallId,
          });
        }
        break;
      case "tool_execution_end":
        if (typeof event.toolCallId === "string") this.liveToolEvents.delete(event.toolCallId);
        break;
    }
    event.web = { streamId: this.streamId, sequence: ++this.streamSequence };
    for (const l of this.listeners) {
      try {
        l(event as AgentEvent);
      } catch {
        // A throwing subscriber (SSE encode failure, UI handler bug) must not
        // starve the remaining subscribers — same isolation RpcProcess and
        // notifyRunningChange apply to their listener sets.
      }
    }
  }

  private sessionFileSignalTimer: NodeJS.Timeout | null = null;

  /** Invalidate session-list metadata plus ONLY this session's parse caches
   * when the file path is known, else fall back to the full invalidation.
   * Use this on the hot event paths (agent_end, auto_compaction_end,
   * session_info_update, …) so a busy session does not flush every other
   * open session's parsed-entry cache. List metadata (sidebar order/counts)
   * still always refreshes. */
  private invalidateSessionLists(): void {
    if (this._sessionFile) {
      invalidateSessionListMeta();
      invalidateSessionEntriesCache(this._sessionFile);
    } else {
      invalidateSessionListCache();
    }
  }

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
      this.invalidateSessionLists();
      notifyRunningChange({ refreshSessionList: true });
    };
    this.sessionFileSignalTimer = setTimeout(check, 250);
  }
  private lastIdleReset = 0;
  private resetIdleTimer(force = false): void {
    // The single activity choke point: start(), every child frame, and every
    // send() land here, so this is where "someone is using this session" is
    // observed. Tracked before the throttle below, which only limits timer
    // churn — it must never hide activity from the reaper.
    this.noteActivity();
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
    // A cleanup deadline must not keep the process alive; the registry's
    // process-exit handler disposes every child anyway.
    this.idleTimer.unref?.();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    this.noteActivity();
    const now = Date.now();
    for (const [id, event] of this.pendingUiRequests) {
      const expiresAt = event.expiresAt as number | undefined;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.forgetPendingUiRequest(id);
        continue;
      }
      listener({ ...event, web: { streamId: this.streamId, sequence: ++this.streamSequence } });
    }
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
      // No UI attached anymore: reject outstanding host tool calls so the
      // agent never waits forever on a tool nobody will answer.
      if (this.listeners.length === 0) {
        this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool", "own");
        this.rejectPendingHostUris("The web UI disconnected while the agent was waiting for this URI request");
        // The last tab left. Start (not extend) the reap clock, so a session
        // that was never watched at all — predict_word, /api/agent/new — is
        // cleaned up on the same schedule as one whose tab just closed.
        this.reapDeadline = Date.now() + this.disconnectDestroyMs;
        this.armReap();
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
      // Bounded like the prompt ack: a child that accepts the frame but never
      // acks it would otherwise suspend this call forever — the `finally` below
      // would never run and the wrapper would keep reporting itself as busy
      // (later calls fail with session_busy) until unrelated traffic cleared
      // the wedge. The 15s output wait above stays a separate concern.
      await this.proc.sendCommand({ type: "prompt", message: "/mcp list" }, PROMPT_ACK_TIMEOUT_MS);
      return await output;
    } catch (error) {
      const expired = error instanceof RpcCommandTimeoutError;
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
        waiter.reject(
          expired
            ? new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive")
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
      }
      if (expired) {
        // Nothing on this child will ever resolve the waiter; recycle it like
        // the prompt-ack timeout path so the next request gets a fresh child.
        await this.destroyAndWait();
        throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
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
    this.applyIdentity({ ...state, sessionFile: state.sessionFile ?? this._sessionFile });
    this.streamSequence += 1;

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
      this.clearLiveSnapshots();
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
      responseObserved: this.responseObserved,
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
      queuedMessages: state.queuedMessages ?? { steering: [], followUp: [] },
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
      anthropicSlowMode: state.anthropicSlowMode,
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
    this.invalidateSessionLists();
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
    this.resetStream();
    this.streaming = false;
    this.promptRunning = false;
    this.compacting = false;
    this.unsubscribeFrames?.();
    try {
      this.expectedExitProc = old;
      try {
        await old.dispose();
      } finally {
        if (this.expectedExitProc === old) this.expectedExitProc = null;
      }
      if (!this._alive) return;

      this.extensionStatuses.clear();
      this.extensionWidgets.clear();
      this.clearPendingUiRequests();
      this.promptRunning = false;
      this.promptDispatchPendingCount = 0;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationGraceUntil = 0;
      this.bashRunning = false;
      this.streaming = false;
      this.compacting = false;
      const proc = new RpcProcess({
        cwd: this.cwd,
        // Re-read per spawn so a restart picks up environment values the user
        // added in Settings after this session was created (#104).
        env: getAgentEnvOverrides(),
        extraArgs: buildSessionSpawnArgs(resumable ? sessionFile : "", undefined, this.advisorSpawned, launchConfigForCwd(this.cwd)),
        onExit: (info) => {
          if (this.proc === proc) this.handleProcessExit(info, proc);
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
        await proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
        const state = await proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
        this.applyIdentity(state);
        // Same fresh-spawn guard as startRpcSession: a sessionless wrapper
        // restarts bare, and omp's startup resume handling could land it on the
        // cwd's most recent session. An on-disk session file is the resume
        // signal (fresh children report a not-yet-created path).
        if (!resumable && this._sessionFile && existsSync(this._sessionFile)) {
          await proc.sendCommand({ type: "new_session" });
          this.applyIdentity(await proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS));
        }
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
    // Covers the whole command, including the awaits inside it: a route that
    // has an unwatched session in mid-command (predict_word on a keystroke, an
    // export, a follow-up) must never have its child reaped underneath it.
    this.pendingCommands += 1;
    try {
      return await this.dispatchCommand(command);
    } finally {
      this.pendingCommands = Math.max(0, this.pendingCommands - 1);
    }
  }

  private async dispatchCommand(command: Record<string, unknown>): Promise<unknown> {
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
          this.responseObserved = false;
          this.responseRunActive = false;
          if (!this.isRunning()) this.clearLiveSnapshots();
          this.streamSequence += 1;
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
          this.streaming = false;
          this.clearLiveSnapshots();
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

      case "remove_queued_message":
      case "promote_queued_message": {
        // Queue mutations are synchronous control operations, like get_state.
        // Expiry must not abort unrelated work or replay a possibly applied mutation.
        const result = await this.proc.sendCommand(command as { type: string }, GET_STATE_TIMEOUT_MS);
        return result ?? null;
      }

      // abort_and_restore_queue is omp's Esc: it takes queued user input back
      // atomically, then aborts, and returns the withdrawn messages.
      case "abort":
      case "abort_and_restore_queue": {
        this.responseObserved = false;
        this.responseRunActive = false;
        const result = await this.withFinalRunningNotification(async () => {
          const response: unknown = await this.proc.sendCommand({ type });
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
          this.clearLiveSnapshots();
          return response;
        });
        return type === "abort" ? null : result ?? null;
      }

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
        this.invalidateSessionLists();
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
        // `text` is the branched prompt omp hands back for edit-and-resend.
        return { cancelled: false, newSessionId, text: result.text };
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
            this.streamSequence += 1;
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
              this.streamSequence += 1;
            }
          });
        } finally {
          this.invalidateSessionLists();
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
        this.invalidateSessionLists();
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
        const pendingAsk = this.pendingUiRequests.get(id)?.method === "ask";
        // A pending ask accepts only its answers or a cancel; anything else would
        // drop it from reconnect replay while omp rejects the payload.
        if (("answers" in rest || pendingAsk) && !isAskAnswers(rest.answers) && !(pendingAsk && rest.cancelled === true)) {
          throw new WebRpcError("Invalid ask dialog answers", "invalid_ask_answers");
        }
        const wasPending = this.pendingUiRequests.has(id);
        this.forgetPendingUiRequest(id);
        this.proc.sendFrame({ type: "extension_ui_response", id, ...rest });
        // omp sends no cancel for an answered dialog; other tabs on this
        // session would keep showing it, so settle it for them here.
        if (wasPending) this.emit({ type: "extension_ui_request", id: `cancel:${id}`, method: "cancel", targetId: id });
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
          this.invalidateSessionLists();
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
        this.proc.sendFrame(command as { type: string; [key: string]: unknown });
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
        this.proc.sendFrame(command as { type: string; [key: string]: unknown });
        return null;
      }

      default: {
        if (PASSTHROUGH_COMMANDS.has(type)) {
          if (type === "abort_and_prompt") {
            this.responseObserved = false;
            this.responseRunActive = false;
            this.streamSequence += 1;
          }
          const result: unknown = await this.proc.sendCommand(
            command as { type: string },
            type === "predict_word" ? PREDICT_WORD_TIMEOUT_MS : undefined,
          );
          if (type === "set_thinking_level") this.invalidateSessionLists();
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
    this.streaming = false;
    this.promptRunning = false;
    this.compacting = false;
    this.responseObserved = false;
    this.responseRunActive = false;
    this.clearLiveSnapshots();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = null;
    }
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
  id: string;
  cwd: string;
}

export interface RunningSessionUpdate {
  ids: string[];
  runningSessions: RunningRpcSession[];
  exitedSessions: ExitedRpcSession[];
  refreshSessionList: boolean;
}


declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompRunningListeners: Set<(update: RunningSessionUpdate) => void> | undefined;
  var __ompHostToolListeners: Set<(call: CrossSessionHostToolCall) => void> | undefined;
  var __ompExitedSessions: Map<string, ExitedRpcSession> | undefined;
}

function getExitedMap(): Map<string, ExitedRpcSession> {
  if (!globalThis.__ompExitedSessions) globalThis.__ompExitedSessions = new Map();
  return globalThis.__ompExitedSessions;
}

export function getExitedRpcSessions(): ExitedRpcSession[] {
  return [...getExitedMap().values()];
}

export function getExitedRpcSession(sessionId: string): ExitedRpcSession | undefined {
  return getExitedMap().get(sessionId);
}

/** Clear the visible crash state once a replacement child is ready. */
export function clearExitedRpcSession(sessionId: string): boolean {
  const cleared = getExitedMap().delete(sessionId);
  if (cleared) notifyRunningChange();
  return cleared;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => {
      // Children dying from here on are the shutdown, not finished runs.
      markShuttingDown();
      globalThis.__ompSessions?.forEach((s) => s.destroy());
    };
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
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) {
      const realId = session.sessionId || sessionId;
      map.set(realId, session.cwd);
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

// ----------------------------------------------------------------------------
// Cross-session host tool calls
//
// A registered host tool called while no tab watches its session goes to every
// open omp-web tab (over /api/agent/host-tools/events) instead of being rejected.
// ----------------------------------------------------------------------------

function getHostToolListeners(): Set<(call: CrossSessionHostToolCall) => void> {
  if (!globalThis.__ompHostToolListeners) globalThis.__ompHostToolListeners = new Set();
  return globalThis.__ompHostToolListeners;
}

/** Subscribe to host tool calls for sessions no tab is currently watching. */
export function subscribeHostToolCalls(listener: (call: CrossSessionHostToolCall) => void): () => void {
  const listeners = getHostToolListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      for (const session of getRegistry().values()) session.rejectCrossSessionHostTools();
    }
  };
}

// Starts at the empty state so an idle server never broadcasts "nothing changed".
let lastRunningSnapshot = "[[],[]]";

/**
 * Recompute the running-session-id set and, when it changes, broadcast it.
 * A session file may first appear after its id starts running, so callers can
 * force one otherwise-identical update to refresh sidebar session metadata.
 */
export function notifyRunningChange({ refreshSessionList = false }: { refreshSessionList?: boolean } = {}): void {
  const runningSessions = getRunningRpcSessions();
  const exitedSessions = getExitedRpcSessions();
  const ids = runningSessions.map((s) => s.id);
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const snapshot = JSON.stringify([runningSessions.slice().sort(byId), exitedSessions.slice().sort(byId)]);
  if (snapshot === lastRunningSnapshot && !refreshSessionList) return;
  lastRunningSnapshot = snapshot;
  syncInterruptibleSessions();
  const update: RunningSessionUpdate = { ids, runningSessions, exitedSessions, refreshSessionList };
  for (const listener of getRunningListeners()) {
    try { listener(update); } catch { /* ignore listener errors */ }
  }
}

/** Record which sessions are mid-run, for resume after a restart. */
export function syncInterruptibleSessions(): void {
  const registry = getRegistry();
  const running = new Map<string, { id: string; advisor: boolean }>();
  for (const session of registry.values()) {
    if (session.sessionId && session.isRunning()) running.set(session.sessionId, { id: session.sessionId, advisor: session.advisorSpawned });
  }
  recordRunningSessions([...running.values()], (id) => registry.get(id)?.isAlive() === true);
}

/**
 * Restart the sessions that were mid-run when omp-web last stopped and ask
 * each to continue. Only runs when the auto-resume setting is on.
 */
export async function resumeInterruptedSessions(): Promise<void> {
  await Promise.all(takeInterruptedSessions().map(async ({ id, advisor }) => {
    try {
      const filePath = await resolveSessionPath(id);
      if (!filePath) return;
      const header = readSessionHeader(filePath);
      const { cwd } = resolveSpawnCwdResult(header?.cwd);
      const { session } = await startRpcSession(id, filePath, cwd, undefined, advisor, header?.cwd);
      await session.send({ type: "prompt", message: RESUME_PROMPT });
      console.log(`[omp-web] resumed interrupted session ${id}`);
    } catch (error) {
      console.warn(`[omp-web] could not resume session ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

/** Look up the workspace-registered launch config; unregistered projects attach none. */
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
 * Get or create the omp RPC process for the given session.
 * For new sessions (sessionFile === ""), omp generates its own id.
 * Pass toolNames to pre-configure the builtin toolset of a NEW session
 * (empty array = all tools disabled); ignored when resuming.
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
  launchConfig = launchConfig ?? launchConfigForCwd(cwd);
  // Union semantics, matching the spawn below and the wrapper identity:
  // workspace advisor=true forces the flag on. The gate must compare this
  // same effective value — comparing the raw toggle would destroy+respawn a
  // workspace-forced child on every toggle-off prompt.
  const effectiveAdvisor = advisor === true || launchConfig?.advisor === true;

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) {
    // --advisor is a spawn-time flag with no runtime RPC. When the caller
    // carries an explicit advisor setting that differs from the live child's,
    // replace the child so the toggle takes effect on the next prompt. Busy
    // children are kept (a mid-run swap would drop in-flight work) and pick
    // the new flag up at the next natural respawn; callers that pass no
    // advisor opinion (undefined) simply reuse whatever is running.
    if (advisor === undefined || existing.advisorSpawned === effectiveAdvisor || existing.isRunning()) {
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
      // User-configured variables for MCP servers and generated configs (#104).
      env: getAgentEnvOverrides(),
      extraArgs: buildSessionSpawnArgs(sessionFile, toolNames, advisor === true, launchConfig),
      onExit: (info) => holder.wrapper?.handleProcessExit(info, proc),
    });
    const created = new AgentSessionWrapper(
      proc,
      cwd,
      recordedCwd,
      advisor === true || launchConfig?.advisor === true,
      sessionFile ? sessionId : "",
    );
    holder.wrapper = created;
    created.start();
    try {
      await created.waitUntilReady();
      // A fresh spawn (no --resume) must never land in an existing conversation:
      // omp's startup resume handling can be config- or version-driven into
      // continuing the cwd's most recent session, which would silently send the
      // first prompt into an old .jsonl. The child's reported session file
      // existing on disk is the resume signal — a genuinely fresh child reports
      // a path it has not created yet (session files are written lazily on the
      // first message), so this never fires for a real new session.
      if (!sessionFile && created.sessionFile && existsSync(created.sessionFile)) {
        await created.send({ type: "new_session" });
      }
    } catch (error) {
      // Await the child's full exit before the `finally` releases the startup
      // lock: a fire-and-forget destroy() would let a retry spawn a second
      // OMP child while the failed one is still flushing/exiting, and
      // concurrent resume/delete/archive paths could race that old child.
      await created.destroyAndWait();
      throw error;
    }

    const realSessionId = created.sessionId;
    created.onDestroy(() => {
      if (registry.get(created.sessionId) === created) registry.delete(created.sessionId);
      if (registry.get(realSessionId) === created) registry.delete(realSessionId);
    });
    created.onIdentityChange((oldId, newId) => {
      if (registry.get(oldId) === created) registry.delete(oldId);
      registry.set(newId, created);
    });
    registry.set(realSessionId, created);
    // A successful respawn supersedes the crash record.
    clearExitedRpcSession(sessionId);
    if (realSessionId !== sessionId) clearExitedRpcSession(realSessionId);
    return { session: created, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
