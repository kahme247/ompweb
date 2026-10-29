import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { validateAgentImages } from "./image-attachments";
import { hasVisibleAssistantContent } from "./assistant-response";
import { invalidateModelsCache } from "./models-cache";
import { RpcCommandError, RpcCommandTimeoutError, RpcProcess, type RpcFrame } from "./omp/rpc-process";
import type { RpcTransport } from "./omp/rpc-transport";
import { editSessionHistory, isSessionEditReply, SESSION_EDIT_COMMAND, SessionEditAgentInvocationError, type SessionEditResult } from "./omp/session-edit";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { allowFileRoot } from "./file-access";
import { loadWebServerSettings } from "./web-settings";
import {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAMES,
  AgentToolGuard,
  executeAgentTool,
  type AgentToolDeliverResult,
  type AgentToolSessionOps,
} from "./agent-tools";
import { markShuttingDown, recordRunningSessions, RESUME_PROMPT, resumeOnHostLink, takeInterruptedSessions, type InterruptibleSession } from "./session-resume";
import { samePath } from "./paths";
import { isRecord } from "./type-guards";
import { BLOCKING_UI_METHODS, createNotificationDetector } from "./notification-events";
import { publishNotification } from "./notification-hub";
import { parseSkillDiagnosticsSnapshot, type SkillDiagnosticsSnapshot } from "./skill-diagnostics";
import { eventWithToolResultImageUrls } from "./media-cache";
import type {
  BashResultInfo,
  OmpModel,
  RpcAvailableSlashCommand,
  RpcSessionState,
  SessionStatsInfo,
  WebSessionState,
} from "./pi-types";
import type { AgentMessage, CrossSessionHostToolCall, ExitedRpcSession, ExtensionWidgetItem } from "./types";
import { isLinkUp, type Host, type HostStatus } from "./hosts/host";
import { getHost, lastUplinkAt, listHosts, orphanExit } from "./hosts/hub";
import { localHost } from "./hosts/local-host";
import type { OpResult } from "./hosts/session-ops";
import { hostForSessionId, invalidateHostSessionList, listSessionsAllHosts, sessionSpawnTarget } from "./hosts/session-index";
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
/** Title generation is an LLM call on omp's side. */
const GENERATE_TITLE_TIMEOUT_MS = 60_000;
const RENAME_POLL_INTERVAL_MS = 500;
const RENAME_POLL_TIMEOUT_MS = 20_000;
/** Background title requests per session. omp declines low-signal openers
 * (a bare greeting), so a later turn of the same session retries. */
const AUTO_TITLE_MAX_ATTEMPTS = 3;
/** command_output lines printed by omp's argument-less `/rename`. */
const RENAME_OUTPUT_RE = /^(Session renamed to |Could not generate a session title|Session name not changed|Rename failed:)/;
const NON_TERMINAL_CONTINUATION_GRACE_MS = 2_000;
const AWAITING_AGENT_START_TIMEOUT_MS = 10_000;
const RESTARTING_MESSAGE = "This session is restarting — retry in a moment.";
const BASH_EXCLUDE_MESSAGE =
  "omp cannot run a shell command with its output excluded from the model context (`!!`): the RPC bash command has no exclusion option, so the output would silently enter the context anyway. Run it with a single `!` to share the output with the model, or use a terminal outside omp web.";
/** Answer to a replayed server agent tool call that changes things: it may have run before the restart. */
const AGENT_TOOL_UNKNOWN_OUTCOME = "omp-web restarted while this ran; the outcome is unknown, check with list_sessions before retrying";

/**
 * Failure raised by omp-web itself (not by omp) carrying a stable snake_case
 * code. API routes forward `{ error, code }` so the client dictionary can
 * localize it via `errors.<code>` while unknown codes fall back to the text.
 */
export class WebRpcError extends Error {
  readonly code: string;
  /** `host_offline` only: "refused" when nothing was sent, "unknown" when the
   * link dropped after the command left, so it may still run on the host. */
  readonly delivery?: "refused" | "unknown";

  constructor(message: string, code: string, delivery?: "refused" | "unknown") {
    super(message);
    this.name = "WebRpcError";
    this.code = code;
    if (delivery) this.delivery = delivery;
  }
}

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

// These commands can append to, replace, or resume the active history. Edits
// fence them across every attached client, including mutations already awaiting
// a native acknowledgement when an edit arrives. Read-only queries and dialog
// replies remain available while a navigation hook is running.
const HISTORY_MUTATING_COMMANDS = new Set([
  "edit_message", "prompt", "steer", "follow_up", "abort", "abort_and_prompt",
  "abort_and_restore_queue", "remove_queued_message", "promote_queued_message",
  "fork", "new_session", "switch_session", "compact", "abort_compaction",
  "reload", "bash", "abort_bash", "handoff", "set_todos", "set_session_name",
  "set_model", "cycle_model", "set_thinking_level", "cycle_thinking_level",
  "set_fast_mode", "set_slow_mode", "set_auto_compaction", "set_auto_retry", "abort_retry",
]);

// pi-web commands with no omp RPC equivalent. The UI tolerates these failing.
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  navigate_tree: "Branch navigation is not supported over the omp RPC protocol",
  clear_queue: "Recalling queued messages is not supported over the omp RPC protocol",
  get_tools: "Per-session tool listing is not supported over the omp RPC protocol",
  set_tools: "Changing tools on a running session is not supported over the omp RPC protocol; tool presets apply to new sessions",
  extension_ui_input: "Extension custom UI is not supported over the omp RPC protocol",
};

function toImageContents(value: unknown): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  const images = value as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  return images?.length ? images : undefined;
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

function titleFromResult(result: unknown): string | null {
  const value = typeof result === "string" ? result : isRecord(result) ? (result.title ?? result.name ?? result.sessionName) : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface IdentityChangeOptions {
  /** The old id still names this wrapper (session moved files, not switched). */
  keepOldId?: boolean;
}

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiRequests = new Map<string, UnsequencedAgentEvent>();
  private uiExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Dialogs omp-web itself raised (confirmFromServer): answered here, never forwarded to omp. */
  private serverUiRequests = new Map<string, (confirmed: boolean) => void>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private promptDispatchPendingCount = 0;
  private historyMutationPendingCount = 0;
  private historyEditInFlight = false;
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
  private onIdentityChangeCallback: ((oldId: string, newId: string, options?: IdentityChangeOptions) => void) | null = null;
  /** omp reported a `session-persistence` notice: its next identity change is
   * the same conversation moving to a sibling file, not a session switch. */
  private sessionMovePending = false;
  private unsubscribeFrames: (() => void) | null = null;
  private readonly detectNotification = createNotificationDetector();
  /** Agent activity since the last `session_settled`: background work may still run after the turn ended. */
  private unsettled = false;
  /** Ids this conversation had before omp moved it to a new file. */
  private readonly movedFromIds: string[] = [];
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
  /** Feeding an adopted child's open requests (see adopt): server agent tools there may already have run. */
  private replaying = false;
  /** Adopted, and no tab has registered host tools since: omp may call tools the
   * wrapper a restart lost registered, so every call routes as registered. */
  private hostToolsUnknown = false;
  private _adopted = false;
  /** host_tool_call ids awaiting a host_tool_result from the browser. */
  private pendingHostTools: Map<string, UnsequencedAgentEvent> = new Map();
  /** Own host calls no tab has seen yet (see parkHostTool), with their deadlines. */
  private parkedHostTools = new Map<string, ReturnType<typeof setTimeout>>();
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
  /** A reload gave up waiting for the old child behind a dropped link; it may still run, so commands answer host_offline until it exits. */
  private oldChildExiting = false;
  readonly cwd: string;
  /** Whether the child was spawned with --advisor. The flag is spawn-time
   * only (no runtime RPC toggles it), so applying a changed advisor setting
   * means replacing an idle child on the next startRpcSession call. */
  readonly advisorSpawned: boolean;
  /** The host's project launch config forced --advisor at spawn. Read by
   * startRpcSession's replace gate, which cannot ask the host before spawning. */
  readonly launchAdvisor: boolean;
  /** Machine the child runs on; every machine-local action goes through it. */
  readonly host: Host;
  /** The cwd recorded in the session file header; null for brand-new sessions
   * or when the header lacks one. A restart asks the host to start there again. */
  private readonly recordedCwd: string | null;
  /** The host could not start the child in its directory and used another
   * one (spawn fallback): a notice warns the user once it is ready. */
  private readonly fellBack: boolean;
  private unsubscribeHostStatus: (() => void) | null = null;

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
    host: Host = localHost,
    launchAdvisor = false,
    fellBack = false,
  ) {
    this.proc = proc;
    this.cwd = cwd;
    this.recordedCwd = recordedCwd ?? null;
    this.advisorSpawned = advisorSpawned;
    this._sessionId = expectedSessionId;
    this.disconnectDestroyMs = disconnectDestroyMs;
    this.host = host;
    this.launchAdvisor = launchAdvisor;
    this.fellBack = fellBack;
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
    // A human/host response can outlive the current streaming turn. Reaping it
    // closes stdin and OMP records "Request was aborted", even without a Stop.
    return this.isAlive() && (this.promptRunning || this.streaming || this.compacting || this.bashRunning
      || this.pendingUiRequests.size > 0 || this.pendingHostTools.size > 0 || this.pendingHostUris.size > 0);
  }

  /** Local history navigation is busy control work, not an interruptible model turn. */
  isEditingHistory(): boolean {
    return this.historyEditInFlight;
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
      || this.handshaking || this.pendingCommands > 0 || this.hostDown()) {
      // A paused human dialog produces no frames. Do not spin a zero-delay
      // timer once the old deadline has passed while protected work remains.
      this.reapDeadline = Math.max(this.reapDeadline, Date.now() + this.disconnectDestroyMs);
      this.armReap();
      return;
    }
    if (Date.now() < this.reapDeadline) {
      this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
      this.armReap();
      return;
    }
    console.info("[omp-web] automatic-session-cleanup", JSON.stringify({ sessionId: this._sessionId, reason: "disconnected-idle", at: new Date().toISOString() }));
    this.destroy("disconnected-idle");
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
    this.watchResync(this.proc);
    this.unsubscribeHostStatus = this.host.onStatus((status) => this.handleHostStatus(status));
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /** The host's link is down ("transport down", never "exited"): the child runs on, unreachable. */
  private hostDown(): boolean {
    return !isLinkUp(this.host.status());
  }

  private hostOfflineError(delivery: "refused" | "unknown"): WebRpcError {
    return new WebRpcError(`${this.host.label} is offline. The run continues there; it reconnects automatically.`, "host_offline", delivery);
  }

  /** The command timed out because its host's link went quiet, not because omp
   * wedged: the child runs on there, so it is not recycled (the kill would wait
   * for the link anyway), and the reconcile on reconnect settles the run. */
  private linkLostDuring(timeout: RpcCommandTimeoutError): boolean {
    const lastUplink = lastUplinkAt(this.host.id);
    // A linked host that sent anything after the command went down has a live
    // link: omp itself is wedged, and the caller recycles the child as before.
    return lastUplink !== null && (this.hostDown() || lastUplink <= timeout.dispatchedAt);
  }

  /** A remote link that dropped this child's buffered output asks for a reconcile.
   * Duck-typed: route bundles and instrumentation load separate hub modules. */
  private watchResync(proc: RpcProcess): void {
    proc.transport?.onResync?.(() => {
      if (this.proc === proc) void this.reconcileAfterGap();
    });
  }

  private handleHostStatus(status: HostStatus): void {
    if (!this._alive) return;
    this.emit({ type: "host_status", hostId: this.host.id, status });
    if (!isLinkUp(status)) return;
    // The idle and disconnect timers held off while the link was down; give them a full window again.
    this.resetIdleTimer(true);
    void this.reconcileAfterGap();
  }

  /** Frames may have been lost (link down, `resync`): re-read omp's state, as the client's get_state reconcile does. */
  private async reconcileAfterGap(): Promise<void> {
    try {
      const state = await this.getStateWithTimeout();
      if (!this._alive) return;
      const wasRunning = this.streaming || this.promptRunning;
      this.applyIdentity(state);
      // The run ended while its frames were lost: end it for clients, as on exit.
      if (wasRunning && !state.isStreaming && !state.isCompacting && !this.awaitingAgentStart && this.promptDispatchPendingCount === 0) {
        this.emit({ type: "agent_end", isTerminal: true, messages: [] });
      }
      notifyRunningChange({ refreshSessionList: true });
    } catch {
      // The client's own reconcile poll catches up.
    }
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
      if (this.fellBack) {
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

  /**
   * Re-sync a child that outlived the server that spawned it (adoptRpcSession):
   * the startup handshake minus the ready wait, every command bounded so a
   * wedged child fails the adoption, then the daemon's lines of its open requests.
   */
  async adopt(replay: string[]): Promise<void> {
    this.handshaking = true;
    this._adopted = true;
    this.hostToolsUnknown = true;
    // Older omp rejects some of these, as at startup; a timeout or an exit fails the adoption.
    const optional = (command: { type: string; [key: string]: unknown }) => this.proc.sendCommand(command, GET_STATE_TIMEOUT_MS).then(() => {}, (error) => {
      if (!(error instanceof RpcCommandError)) throw error;
    });
    try {
      await this.proc.negotiateProtocol(await this.proc.waitReady(), GET_STATE_TIMEOUT_MS);
      await optional({ type: "set_subagent_subscription", level: "events" });
      await optional({ type: "set_ask_dialog", enabled: true });
      // omp's state has no shell-command flag: a `!!` command the lost server started
      // leaves bashRunning false, and its result arrives as an unsolicited response.
      this.applyIdentity(await this.getStateWithTimeout());
      // The wrapper keeps neither (a tab reads both when it attaches): a child that cannot answer them fails here instead.
      await optional({ type: "get_subagents" });
      await optional({ type: "get_btw_history" });
      this.replaying = true;
      try {
        this.proc.replay(replay);
      } finally {
        this.replaying = false;
      }
    } finally {
      this.handshaking = false;
      this.noteActivity();
    }
  }

  /** Taken over from a previous run of this server (see adopt): its spawn-time --advisor flag is unknown. */
  get adopted(): boolean {
    return this._adopted;
  }

  private applyIdentity(state: RpcSessionState): void {
    const oldId = this._sessionId;
    const identityChanged = Boolean(oldId) && (state.sessionId !== oldId || (state.sessionFile && state.sessionFile !== this._sessionFile));
    // omp >= 18.5 moves a session it does not own onto a new file on its first
    // write (`session-persistence` notice). The conversation continues, so the
    // live stream and run state must survive; only the id changes.
    const moved = identityChanged && this.sessionMovePending;
    if (identityChanged && !moved) {
      this.resetStream();
      this.promptRunning = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationGraceUntil = 0;
      // A different conversation now: the old one's ids must not suppress its notifications.
      this.movedFromIds.length = 0;
    }
    this._sessionId = state.sessionId;
    this._sessionFile = state.sessionFile ?? "";
    this._sessionName = state.sessionName;
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this.fastModeEnabled = state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled;
    // The local path cache resolves ids to files on this machine only.
    if (this._sessionFile && this.host === localHost) cacheSessionPath(this._sessionId, this._sessionFile);
    if (moved) {
      this.sessionMovePending = false;
      if (oldId !== this._sessionId) {
        // Tabs still showing the old id are still viewing this conversation.
        this.movedFromIds.push(oldId);
        // Keep the old id routable: other tabs still address it, and a fresh
        // `--resume` of the old file would fork again (its owner lives on).
        this.onIdentityChangeCallback?.(oldId, this._sessionId, { keepOldId: true });
        this.invalidateSessionLists();
      }
    }
  }

  /** Whether omp answered `generate_title` with "Unknown command" (cached per child). */
  private generateTitleUnsupported = false;
  /** Background title requests made per session id (see autoTitle). */
  private autoTitleAttempts = new Map<string, number>();
  private autoTitleInFlight = false;
  /** Until this time, drop the chat output of a background `/rename`. */
  private quietRenameUntil = 0;

  /**
   * Ask omp to generate a title for this session with its own title generator.
   * Prefers the native `generate_title` RPC command and falls back to the
   * argument-less `/rename` slash command. Returns null when omp cannot do
   * either right now (older omp, or the session is mid-run, where `/rename`
   * would be queued as a prompt). With `quiet`, the `/rename` fallback skips
   * the prompt bookkeeping (the UI never sees a run) and its output stays out
   * of the chat.
   */
  async generateTitle({ quiet = false }: { quiet?: boolean } = {}): Promise<string | null> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");

    if (this.historyEditInFlight) throw new WebRpcError("Wait for the history edit to finish", "session_busy");
    this.historyMutationPendingCount += 1;
    try {
      return await this.generateSessionTitle(quiet);
    } finally {
      this.historyMutationPendingCount -= 1;
    }
  }

  private async generateSessionTitle(quiet = false): Promise<string | null> {
    if (!this.generateTitleUnsupported) {
      try {
        const result = await this.proc.sendCommand<unknown>({ type: "generate_title" }, GENERATE_TITLE_TIMEOUT_MS);
        const title = titleFromResult(result) ?? (await this.readSessionName());
        if (title) this.adoptSessionName(title);
        return title;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("Unknown command"))) throw error;
        this.generateTitleUnsupported = true;
      }
    }

    // `/rename` without arguments generates a title (omp >= 18.6). It is a
    // prompt, so it must never be sent while a run is in flight.
    if (this.isRunning()) return null;
    const before = (await this.readSessionName()) ?? "";
    if (quiet) {
      // omp saves the title before it prints the result, so the poll below can
      // finish first: the window closes on that output or on expiry instead.
      this.quietRenameUntil = Date.now() + GENERATE_TITLE_TIMEOUT_MS;
      await this.proc.sendCommand({ type: "prompt", message: "/rename" }, PROMPT_ACK_TIMEOUT_MS);
    } else {
      await this.send({ type: "prompt", message: "/rename" });
    }
    const deadline = Date.now() + RENAME_POLL_TIMEOUT_MS;
    let title = await this.readSessionName();
    while (!(title && title !== before) && Date.now() < deadline && this.isAlive()) {
      await new Promise((resolve) => setTimeout(resolve, RENAME_POLL_INTERVAL_MS));
      title = await this.readSessionName();
    }
    if (title) this.adoptSessionName(title);
    return title;
  }

  /**
   * omp does not title sessions on its own in RPC mode
   * (can1357/oh-my-pi#14616), so once a turn finishes, ask its title generator
   * to name an untitled session, as omp's terminal UI does.
   */
  private autoTitle(): void {
    const sessionId = this._sessionId;
    if (!sessionId || this._sessionName || this.autoTitleInFlight) return;
    const sessionFile = this._sessionFile;
    if (!sessionFile) return;
    // Held across the async file check so a second agent_end cannot start a parallel run.
    this.autoTitleInFlight = true;
    void this.host.sessionFileExists(sessionFile)
      .then(async (exists) => {
        // omp writes the session file once the history holds an assistant message.
        const attempts = this.autoTitleAttempts.get(sessionId) ?? 0;
        if (!exists || this._sessionName || attempts >= AUTO_TITLE_MAX_ATTEMPTS) return;
        this.autoTitleAttempts.set(sessionId, attempts + 1);
        await this.generateTitle({ quiet: true });
      })
      .catch((error) => {
        console.warn(`[omp-web] could not title session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.autoTitleInFlight = false;
      });
  }

  private async readSessionName(): Promise<string | null> {
    const state = await this.getStateWithTimeout();
    const name = typeof state.sessionName === "string" ? state.sessionName.trim() : "";
    return name || null;
  }

  private adoptSessionName(title: string): void {
    this._sessionName = title;
    this.invalidateSessionLists();
    notifyRunningChange({ refreshSessionList: true });
  }

  /** Re-read identity after omp reported that it moved this session to a new file. */
  private async followSessionMove(): Promise<void> {
    this.sessionMovePending = true;
    try {
      const state = await this.getStateWithTimeout();
      if (this._alive) this.applyIdentity(state);
    } catch {
      // The next get_state-driven refresh still applies the pending move.
    } finally {
      // A persistence warning that is not a move changes no identity; do not
      // let it mask a later genuine session switch.
      if (this.sessionMovePending && this._alive) this.sessionMovePending = false;
      notifyRunningChange({ refreshSessionList: true });
    }
  }

  handleProcessExit(
    { code, signal, stderrTail }: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
    sourceProc: RpcProcess = this.proc,
  ): void {
    if (!this._alive || sourceProc === this.expectedExitProc) return;
    const detail = (stderrTail.trim().split("\n").pop() ?? "").slice(-500);
    const status = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
    // Spec Rules → Reattach: a run whose child vanished while its host link was
    // down starts again on that host, like a local run after a restart.
    const resume: InterruptibleSession | null = sourceProc.transport?.lost === true && this._sessionId && (this.streaming || this.promptRunning)
      ? { id: this._sessionId, advisor: this.advisorSpawned, hostId: this.host.id }
      : null;
    // Recorded before destroy(): its running-change broadcast must carry the
    // record so sidebars that missed the notice below still see the exit.
    if (this._sessionId) getExitedMap().set(this._sessionId, { id: this._sessionId, cwd: this.cwd, ...(this.host.id === localHost.id ? {} : { hostId: this.host.id }), at: Date.now(), code, signal, detail });
    this.emit({
      type: "notice",
      level: "error",
      message: `The omp process for this session exited unexpectedly (${status})${detail ? `: ${detail}` : "."}`,
    });
    // Terminal agent_end so a client mid-stream stops spinning immediately
    // instead of waiting for the reconcile poll.
    if (this.streaming || this.promptRunning) this.emit({ type: "agent_end", isTerminal: true, messages: [] });
    if (this.streaming || this.promptRunning || this.unsettled) {
      this.publishNotifications({ type: "process_exit", detail: detail || status });
    }
    this.destroy();
    if (resume && loadWebServerSettings().autoResumeSessions) void resumeSession(resume);
  }

  private publishNotifications(frame: Record<string, unknown>): void {
    const session = {
      sessionId: this._sessionId,
      sessionName: this._sessionName || this.cwd.split(/[\\/]/).filter(Boolean).pop() || null,
    };
    for (const notification of this.detectNotification(frame, session)) {
      publishNotification(this.movedFromIds.length ? { ...notification, aliases: this.movedFromIds } : notification);
    }
  }

  private handleFrame(frame: RpcFrame): void {
    // The helper has its own process listener. Its correlated control replies
    // must never become browser notices, replayed dialogs, or notifications,
    // even when they arrive after a failed/timed-out edit.
    if (isSessionEditReply(frame)) return;
    this.resetIdleTimer();
    const event = frame.type === "available_commands_update" && Array.isArray(frame.commands)
      ? { ...frame, commands: (frame.commands as RpcAvailableSlashCommand[]).filter((command) => command.name !== SESSION_EDIT_COMMAND) }
      : frame;
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
        // The output of a background `/rename` (see autoTitle) is not chat content.
        if (Date.now() < this.quietRenameUntil && typeof event.text === "string" && RENAME_OUTPUT_RE.test(event.text)) {
          this.quietRenameUntil = 0;
          return;
        }
        break;
      }
      case "agent_start":
        this.unsettled = true;
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
        if (this._sessionFile) {
          void this.host.sessionFileExists(this._sessionFile).then((exists) => {
            if (!exists && this._alive) this.signalWhenSessionFileAppears();
          }, () => {});
        }
        break;
      case "agent_end":
        if (event.isTerminal !== false) {
          // A server dialog belongs to a tool call of this run; nobody can answer it after the run.
          this.dropServerUiRequests();
          this.streaming = false;
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationGraceUntil = 0;
          this.invalidateSessionLists();
          this.autoTitle();
        } else {
          this.continuationGraceUntil = Date.now() + NON_TERMINAL_CONTINUATION_GRACE_MS;
        }
        break;
      case "session_settled":
        this.unsettled = false;
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
      case "notice":
        if (event.source === "session-persistence") void this.followSessionMove();
        break;
      case "session_info_update":
        if (typeof event.title === "string") this._sessionName = event.title;
        this.invalidateSessionLists();
        refreshSessionList = true;
        break;
      case "skill_diagnostics_update":
        this.emit({
          type: "skill_diagnostics_update",
          data: parseSkillDiagnosticsSnapshot(event.data),
        });
        notifyRunningChange();
        return;
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
          const promptError = { type: "prompt_error", errorMessage: detail, error: event.error, command: event.command };
          this.publishNotifications(promptError);
          this.emit(promptError);
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
        // Server-side agent tools (#275) are answered here, before any
        // browser routing, so they work with no tab open. A disabled gate
        // is an explicit error, not a silent hang and not a browser call.
        if (id && toolName && AGENT_TOOL_NAMES.has(toolName)) {
          // A replayed call may have run before the restart: only the read-only listing runs again.
          if (this.replaying && toolName !== "list_sessions") {
            this.proc.sendFrame({
              type: "host_tool_result",
              id,
              isError: true,
              result: { content: [{ type: "text", text: AGENT_TOOL_UNKNOWN_OUTCOME }] },
            });
          } else if (loadWebServerSettings().agentToolsEnabled) {
            void this.answerServerAgentTool(event);
          } else {
            this.proc.sendFrame({
              type: "host_tool_result",
              id,
              isError: true,
              result: {
                content: [{
                  type: "text",
                  text: "Agent tools are disabled. Enable \"Agent tools\" in omp-web Settings (System & Updates) first.",
                }],
              },
            });
            this.emit({ type: "notice", level: "warning", message: `Rejected disabled agent tool: ${toolName}` });
          }
          return;
        }
        // Route REGISTERED host tools to an attached UI (the browser answers
        // via host_tool_result). With no tab on this session, hand the call to
        // any open omp-web tab (the user switched sessions mid-run). Otherwise
        // reject immediately so the agent never hangs on a tool nobody will
        // answer.
        if (id && toolName && (this.hostToolNames.has(toolName) || this.hostToolsUnknown)) {
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
          // Adopted with every tab gone with the old server: the next tab to attach answers it.
          if (this.hostToolsUnknown) {
            this.parkHostTool(id, event);
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
          this.unparkHostTool(targetId);
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

    this.publishNotifications(event);
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
    this.dropServerUiRequests();
    for (const timer of this.uiExpiryTimers.values()) clearTimeout(timer);
    this.uiExpiryTimers.clear();
    this.pendingUiRequests.clear();
  }

  /** Settle every server dialog as declined and close it in attached tabs. */
  private dropServerUiRequests(): void {
    for (const [id, resolve] of this.serverUiRequests) {
      this.serverUiRequests.delete(id);
      this.forgetPendingUiRequest(id);
      this.emit({ type: "extension_ui_request", id: `cancel:${id}`, method: "cancel", targetId: id });
      resolve(false);
    }
  }

  /**
   * Ask this session's user to confirm, as an omp dialog would: same tabs,
   * replay and input-needed notification. Resolves false when declined, when
   * the run ends, or when the session stops.
   */
  confirmFromServer(title: string): Promise<boolean> {
    if (!this._alive) return Promise.resolve(false);
    const id = `omp-web:${randomUUID()}`;
    const { promise, resolve } = Promise.withResolvers<boolean>();
    this.serverUiRequests.set(id, resolve);
    this.handleFrame({ type: "extension_ui_request", id, method: "confirm", title, message: "" });
    return promise;
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
    if (method === "confirm" && typeof event.title === "string" && /^allow tool\s*:/i.test(event.title) && this.host.autoApproveExtension()) {
      this.forgetPendingUiRequest(id);
      this.proc.sendFrame({ type: "extension_ui_response", id, confirmed: true });
      return true;
    }
    // Blocking dialogs stay pending until the client answers (replayed to
    // newly-attached SSE listeners so dialogs survive reconnects).
    if (BLOCKING_UI_METHODS.has(method)) {
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
      this.unparkHostTool(id);
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: message }] },
      });
    }
  }

  /**
   * Hold an own host call no tab can answer yet (adopted: every tab went with
   * the old server) for the next tab to attach (see onEvent). If none attaches
   * within the disconnect window it is settled, so the agent never waits forever.
   */
  private parkHostTool(id: string, event: UnsequencedAgentEvent): void {
    this.pendingHostTools.set(id, event);
    const timer = setTimeout(() => {
      this.parkedHostTools.delete(id);
      if (!this.pendingHostTools.delete(id)) return;
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: "No omp-web tab reconnected to answer this host tool" }] },
      });
      notifyRunningChange();
    }, this.disconnectDestroyMs);
    timer.unref?.();
    this.parkedHostTools.set(id, timer);
  }

  private unparkHostTool(id: string): void {
    clearTimeout(this.parkedHostTools.get(id));
    this.parkedHostTools.delete(id);
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

  private emit(nativeEvent: UnsequencedAgentEvent): void {
    // Tool-result images go out (and into the replay snapshot) as media URLs:
    // big screenshots must never sit in the browser's chat state as base64.
    const event = eventWithToolResultImageUrls(nativeEvent);
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
    this.host.invalidateSessionLists(this._sessionFile || undefined);
    invalidateHostSessionList(this.host.id);
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
      const sessionFile = this._sessionFile;
      if (!this._alive || !sessionFile) {
        this.sessionFileSignalTimer = null;
        return;
      }
      // The fired handle stays set across the async check so a re-entrant
      // call cannot start a second poll; destroy() still clears it.
      void this.host.sessionFileExists(sessionFile).then((exists) => {
        if (!this._alive) return;
        this.sessionFileSignalTimer = null;
        if (!exists) {
          attempts += 1;
          if (attempts < 40) {
            this.sessionFileSignalTimer = setTimeout(check, 250);
          }
          return;
        }
        this.invalidateSessionLists();
        notifyRunningChange({ refreshSessionList: true });
      }, () => {
        this.sessionFileSignalTimer = null;
      });
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
      if (this.isRunning() || this.handshaking || this.pendingCommands > 0 || this.hostDown()) {
        this.resetIdleTimer(true);
        return;
      }
      console.info("[omp-web] automatic-session-cleanup", JSON.stringify({ sessionId: this._sessionId, reason: "idle-timeout", at: new Date().toISOString() }));
      this.destroy("idle-timeout");
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
    // Own host calls parked while no tab could answer go to the first tab that attaches, once.
    for (const id of [...this.parkedHostTools.keys()]) {
      this.unparkHostTool(id);
      const event = this.pendingHostTools.get(id);
      if (event) listener({ ...event, web: { streamId: this.streamId, sequence: ++this.streamSequence } });
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

  /**
   * Wait for the next `terminalEndsNeeded` terminal turn ends after this
   * call (terminal agent_end, prompt_result, or prompt_error). The caller
   * registers the waiter BEFORE sending the prompt/steer/follow_up, so a
   * fast turn cannot end before the waiter exists. Rejects on timeout;
   * the target is left running (never aborted by a waiter timeout).
   * A follow_up sent to a running target needs two ends: the running
   * turn ends first, then the queued message's own turn ends.
   */
  waitForTurnEnd(timeoutMs: number, terminalEndsNeeded = 1): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      let endsSeen = 0;
      const timer = setTimeout(() => finish(new Error("Timed out waiting for the target session's response.")), timeoutMs);
      timer.unref?.();
      const detach = this.onEvent((event) => {
        if (event.type === "agent_end" && event.isTerminal === false) return;
        if (event.type === "agent_end" || event.type === "prompt_result") {
          endsSeen += 1;
          if (endsSeen >= terminalEndsNeeded) finish(null);
        } else if (event.type === "prompt_error") {
          finish(new Error(typeof event.errorMessage === "string" ? event.errorMessage : "Target session turn failed."));
        }
      });
      const finish = (error: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        detach();
        if (error) reject(error);
        else resolve();
      };
    });
  }

  /**
   * Answer a server-side agent tool call (#275) from this wrapper's child.
   * Runs on the server, with no browser involved, and answers directly
   * with host_tool_result — never via pendingHostTools, so a later tab
   * disconnect cannot settle it as a UI call.
   */
  private async answerServerAgentTool(event: UnsequencedAgentEvent): Promise<void> {
    const id = typeof event.id === "string" ? event.id : "";
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (!id) return;
    const sendResult = (text: string, isError = false) => {
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError,
        result: { content: [{ type: "text", text }] },
      });
    };
    try {
      const args = event.arguments && typeof event.arguments === "object" ? event.arguments as Record<string, unknown> : {};
      const result = await executeAgentTool(toolName, args, createAgentToolOps(), {
        sourceSessionId: this.sessionId,
        sourceCwd: this.cwd,
        sourceHostId: this.host.id,
        enabled: loadWebServerSettings().agentToolsEnabled,
        guard: getAgentToolGuard(),
        confirm: (title) => this.confirmFromServer(title),
      });
      sendResult(typeof result === "string" ? result : JSON.stringify(result));
    } catch (error) {
      sendResult(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** Called when a session-changing command re-keyed this wrapper (branch/new_session/switch_session). */
  onIdentityChange(cb: (oldId: string, newId: string, options?: IdentityChangeOptions) => void): void {
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
    return this.runMcpCommand("list");
  }

  /** RPC /mcp reload refreshes command metadata only. Reboot the idle child
   * against its saved session to actually rediscover MCP tools. */
  async changeMcp(action: "enable" | "disable" | "reload", name?: string): Promise<void> {
    if (!["enable", "disable", "reload"].includes(action)) throw new Error("Invalid MCP action");
    if (action !== "reload" && (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))) throw new Error("Invalid MCP server name");
    await this.runMcpCommand(action, name, true);
  }

  private async runMcpCommand(action: "list" | "enable" | "disable" | "reload", name?: string, apply = false): Promise<string> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (this.isRunning() || this.historyEditInFlight || this.pendingUiRequests.size > 0 || this.pendingHostTools.size > 0 || this.pendingHostUris.size > 0) throw new WebRpcError("Wait for the current operation to finish", "session_busy");
    if (this.mcpListWaiter || this.mcpListInFlight) throw new WebRpcError("MCP list is already loading", "mcp_list_loading");

    // Dedicated synchronous mutex: promptRunning alone is not atomic — two
    // concurrent callers could both pass the isRunning() check, and the second
    // would steal the waiter so the first hangs to timeout (or receives the
    // other's output). This flag is checked+set before any await.
    this.mcpListInFlight = true;
    this.historyMutationPendingCount += 1;

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
      await this.proc.sendCommand({ type: "prompt", message: action === "list" ? "/mcp list" : `/mcp ${action}${name ? ` ${name}` : ""}` }, PROMPT_ACK_TIMEOUT_MS);
      const result = await output;
      if (action !== "list" && /^(?:Failed|Usage:|Server .* not found|Unknown)/m.test(result)) {
        throw new WebRpcError("OMP could not update this MCP server. Check its source configuration.", "mcp_change_failed");
      }
      if (apply) {
        try { await this.restart(); }
        catch { throw new WebRpcError("MCP configuration was saved, but session reload failed. Reopen the session to apply it.", "mcp_reload_failed"); }
      }
      return result;
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
        if (error instanceof RpcCommandTimeoutError && this.linkLostDuring(error)) throw this.hostOfflineError("unknown");
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
      this.historyMutationPendingCount -= 1;
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
      this.historyEditInFlight ||
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
    const skillDiagnostics = parseSkillDiagnosticsSnapshot(state.skillDiagnostics);
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
      slowModeSupported: state.slowModeSupported ?? false,
      slowModeEnabled: state.slowModeEnabled ?? false,
      slowModeScope: state.slowModeScope,
      usageLimit: state.usageLimit,
      ...(skillDiagnostics ? { skillDiagnostics } : {}),
      todoPhases: state.todoPhases ?? [],
      extensionStatuses: Array.from(this.extensionStatuses, ([key, text]) => ({ key, text })),
      extensionWidgets: Array.from(this.extensionWidgets.values()),
    };
  }

  private requireSkillDiagnostics(value: unknown): SkillDiagnosticsSnapshot {
    const snapshot = parseSkillDiagnosticsSnapshot(value);
    if (!snapshot) {
      throw new WebRpcError(
        "Skill diagnostics are unavailable for this OMP session",
        "skill_diagnostics_unsupported",
      );
    }
    return snapshot;
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

  private async editMessage(entryId: unknown): Promise<SessionEditResult> {
    if (typeof entryId !== "string" || !entryId.trim()) {
      throw new WebRpcError("The edit target must be a user message", "invalid_edit_target");
    }
    if (this.isRunning() || this.historyMutationPendingCount > 1) {
      throw new WebRpcError("Wait for the current operation to finish before editing", "session_busy");
    }

    // Set synchronously, before the first native query: a second tab must not
    // send a prompt, fork, or switch the process during either preflight await.
    this.historyEditInFlight = true;
    const proc = this.proc;
    const sessionId = this._sessionId;
    const sessionFile = this._sessionFile;
    let persistenceError: Error | null = null;
    // Keep observing through the authoritative post-edit state query as well
    // as the helper's reply/ack exchange. The ordinary notice path still emits
    // the native error to every observer.
    const unsubscribe = proc.onFrame((frame) => {
      if (frame.type === "notice" && frame.source === "session-persistence" && frame.level === "error") {
        persistenceError ??= new Error(typeof frame.message === "string" ? frame.message : "OMP could not persist the history edit");
      }
    });
    notifyRunningChange();
    try {
      const before = await this.getStateWithTimeout();
      if (persistenceError) throw persistenceError;
      if (before.sessionId !== sessionId || before.sessionFile !== sessionFile
        || this._sessionId !== sessionId || this._sessionFile !== sessionFile) {
        throw new WebRpcError("The session changed before the history edit", "session_changed");
      }
      if (typeof before.isSettled !== "boolean") {
        throw new WebRpcError("Editing history requires a newer OMP that reports full session settlement", "session_edit_unsupported");
      }
      if (!before.isSettled || before.hasPendingAsyncWork === true
        || before.isStreaming || before.isCompacting || before.queuedMessageCount > 0
        || this.promptRunning || this.streaming || this.compacting || this.bashRunning) {
        throw new WebRpcError("Wait for the current run to finish before editing", "session_busy");
      }

      const result = await editSessionHistory(proc, entryId, sessionId);
      const after = await this.getStateWithTimeout();
      if (persistenceError) throw persistenceError;
      const unchanged = after.sessionId === sessionId && after.sessionFile === sessionFile;
      // Only applyIdentity's native move path can retain the originating id.
      // A reply naming a different conversation is never sufficient evidence.
      const moved = this.movedFromIds.includes(sessionId) && after.sessionId !== sessionId;
      if (!this.isAlive() || this.proc !== proc || result.sessionId !== after.sessionId
        || (!unchanged && !moved) || this._sessionId !== after.sessionId || this._sessionFile !== after.sessionFile) {
        throw new WebRpcError("The session changed during the history edit", "session_changed");
      }
      if (result.cancelled) return result;

      this.clearLiveSnapshots();
      this.responseObserved = false;
      this.responseRunActive = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationGraceUntil = 0;
      // Invalidate the confirmed edited conversation, not its preserved source.
      this.invalidateSessionLists();
      this.emit({ type: "session_history_changed", leafId: result.leafId });
      notifyRunningChange({ refreshSessionList: true });
      return result;
    } catch (error) {
      if (error instanceof RpcCommandTimeoutError) {
        if (this.linkLostDuring(error)) throw this.hostOfflineError("unknown");
        // A timed-out navigation may still be running in a hook. Do not let a
        // later mutation race it once the web-side fence is released.
        await this.destroyAndWait();
        if (persistenceError) throw persistenceError;
        throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
      }
      if (error instanceof SessionEditAgentInvocationError && !error.agentStarted) {
        // Native /retry can acknowledge before its deferred agent_start. There
        // is no observed run to own that gap: stop it before releasing Edit.
        await this.destroyAndWait();
      }
      throw persistenceError ?? error;
    } finally {
      unsubscribe();
      this.historyEditInFlight = false;
      notifyRunningChange();
    }
  }

  /** Full restart of the child process against the same session file. This is
   * omp-web's `reload`: extensions, skills, prompts, and tools are rediscovered
   * on boot, matching a fresh CLI launch. */
  private async restart(): Promise<void> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    const sessionFile = this._sessionFile;
    const old = this.proc;
    // Stays true for the whole restart so send() rejects commands that would
    // otherwise hit the disposed or half-built child.
    this.restarting = true;
    let resumable: boolean;
    try {
      // Asked before touching the live child: a remote host can be offline,
      // and the child must then keep running with its frames still read.
      resumable = !!sessionFile && await this.host.sessionFileExists(sessionFile);
    } catch (error) {
      this.restarting = false;
      throw error;
    }
    this.resetStream();
    this.streaming = false;
    this.promptRunning = false;
    this.compacting = false;
    this.unsubscribeFrames?.();
    try {
      this.expectedExitProc = old;
      let exited = false;
      const disposing = old.dispose().then(() => {
        exited = true;
      });
      // Behind a dropped link the old child's exit arrives only when the link
      // returns: the reload must not hold `restarting` through the outage.
      await untilHostDown(this.host, disposing);
      if (!exited) {
        // It may still run there, so nothing starts beside it: commands answer
        // host_offline until its exit (via the link, or `lost` on the next hello)
        // ends this wrapper, and the next request then spawns afresh.
        this.oldChildExiting = true;
        void disposing.then(() => {
          if (this.proc === old) this.destroy("reload-old-child-exited");
        });
        throw this.hostOfflineError("unknown");
      }
      if (this.expectedExitProc === old) this.expectedExitProc = null;
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
      const spawned = await this.host.spawnRpc({
        cwd: this.cwd,
        recordedCwd: this.recordedCwd,
        sessionFile: resumable ? sessionFile : "",
        toolNames: undefined,
        advisor: this.advisorSpawned,
      });
      const proc = new RpcProcess({
        cwd: spawned.cwd,
        transport: spawned.transport,
        onExit: (info) => {
          if (this.proc === proc) this.handleProcessExit(info, proc);
        },
      });
      // Destroyed while the host was spawning: nobody will ever read this child.
      if (!this._alive) {
        void proc.dispose();
        return;
      }
      this.proc = proc;
      this.unsubscribeFrames = proc.onFrame((frame) => this.handleFrame(frame));
      this.watchResync(proc);
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
        if (!resumable && this._sessionFile && await this.host.sessionFileExists(this._sessionFile)) {
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
    if (this.mcpListInFlight) throw new WebRpcError("MCP management is in progress. Try again when it finishes.", "session_busy");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (this.hostDown() || this.oldChildExiting) throw this.hostOfflineError("refused");
    if (typeof command.type === "string" && command.type.startsWith("abort")) {
      console.info("[omp-web] cancellation-command", JSON.stringify({ sessionId: this._sessionId, type: command.type, at: new Date().toISOString() }));
    }
    const mutatesHistory = HISTORY_MUTATING_COMMANDS.has(command.type as string);
    if (mutatesHistory && this.historyEditInFlight) {
      throw new WebRpcError("Wait for the history edit to finish", "session_busy");
    }
    if (mutatesHistory) this.historyMutationPendingCount += 1;
    this.resetIdleTimer();
    // Covers the whole command, including the awaits inside it: a route that
    // has an unwatched session in mid-command (predict_word on a keystroke, an
    // export, a follow-up) must never have its child reaped underneath it.
    this.pendingCommands += 1;
    try {
      return await this.dispatchCommand(command);
    } finally {
      this.pendingCommands = Math.max(0, this.pendingCommands - 1);
      if (mutatesHistory) this.historyMutationPendingCount -= 1;
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
        // A `!!` shell command owns the session until it exits (omp rejects a
        // prompt then, and treating that as a hard error tore down the client's
        // optimistic turn and lost the message). Degrade into omp's own
        // follow-up queue instead: omp keeps owning the chips and delivers the
        // message once the shell command releases the session.
        if (this.bashRunning) return await this.queueWhileShellRunning(command);
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
            if (this.linkLostDuring(error)) throw this.hostOfflineError("unknown");
            // The child took the frame but never acked it, so nothing will ever
            // report this run: recycle the unacknowledged prompt. A read-only
            // get_state timeout deliberately does not take this destructive path.
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
        // `steer` has the same collision while a `!!` shell command runs — and
        // there is no live turn to steer anyway, so it joins the follow-up
        // queue like a prompt would.
        if (type === "steer" && this.bashRunning) return await this.queueWhileShellRunning(command);
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
            // This is only an observer poll. A busy event loop or delayed RPC
            // response is not authority to stop generation or a pending tool.
            console.warn("[omp-web] status-query-timeout", JSON.stringify({ sessionId: this._sessionId, timeoutMs: GET_STATE_TIMEOUT_MS, running: this.isRunning(), action: "preserved", at: new Date().toISOString() }));
            throw new WebRpcError("The OMP status query timed out. The session was left running; retry shortly.", "session_state_timeout");
          }
          throw error;
        }
      }

      case "get_skill_diagnostics": {
        const result = await this.proc.sendCommand<unknown>({ type: "get_skill_diagnostics" }, GET_STATE_TIMEOUT_MS);
        return this.requireSkillDiagnostics(result);
      }

      case "set_skill_startup_diagnostics": {
        if (typeof command.enabled !== "boolean") {
          throw new WebRpcError("enabled must be a boolean", "invalid_skill_startup_diagnostics");
        }
        const result = await this.proc.sendCommand<unknown>({
          type: "set_skill_startup_diagnostics",
          enabled: command.enabled,
        }, GET_STATE_TIMEOUT_MS);
        return this.requireSkillDiagnostics(result);
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

      case "set_slow_mode": {
        const enabled = command.enabled === true;
        const result = await this.proc.sendCommand<{ enabled?: boolean }>({ type: "set_slow_mode", enabled });
        return { enabled: result?.enabled ?? enabled };
      }

      case "edit_message":
        return this.editMessage(command.entryId);

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
        return { ...data, commands: data.commands.filter((command) => command.name !== SESSION_EDIT_COMMAND) };
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
        const serverRequest = this.serverUiRequests.get(id);
        if (serverRequest) {
          this.serverUiRequests.delete(id);
          serverRequest(rest.confirmed === true);
        } else {
          this.proc.sendFrame({ type: "extension_ui_response", id, ...rest });
        }
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
        // Merge the server agent tools (#275) into every registration when
        // the gate is on, so a later UI registration cannot drop them and
        // a no-tab session keeps them after its startup registration.
        // With the gate off the registration is exactly what the caller
        // asked for, so existing behavior and tests are unchanged.
        const merged = loadWebServerSettings().agentToolsEnabled
          ? [...valid, ...AGENT_TOOL_DEFINITIONS.filter((t) => !valid.some((v) => v.name === t.name))]
          : valid;
        this.hostToolNames = new Set(merged.map((t) => t.name as string));
        await this.proc.sendCommand({ type: "set_host_tools", tools: merged });
        // omp now knows exactly these: an adopted child's lost registration is replaced.
        this.hostToolsUnknown = false;
        return null;
      }

      case "host_tool_result": {
        if (typeof command.id === "string") {
          this.pendingHostTools.delete(command.id);
          this.unparkHostTool(command.id);
        }
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

  /**
   * Degrade a prompt/steer frame into omp's follow-up queue while omp-web's own
   * `!!` shell command owns the child (`bashRunning`, set for the whole `bash`
   * RPC). omp would refuse a prompt then — and aborting or erroring loses the
   * user's message mid-task — so the message is forwarded as `follow_up`
   * instead: the queue stays omp-owned (its `queue_update`/`get_state`
   * snapshots feed every client's chips) and omp delivers the message after the
   * shell command finishes, exactly as a queued follow-up sent during a run.
   * The reply carries the degradation so the client can tell the user their
   * message was queued, not steered.
   */
  private async queueWhileShellRunning(command: Record<string, unknown>): Promise<unknown> {
    const images = toImageContents(command.images);
    await this.proc.sendCommand({
      type: "follow_up",
      message: command.message as string,
      ...(images ? { images } : {}),
    });
    return { queued: true, queue: "followUp", reason: "shellRunning" };
  }

  destroy(reason = "unspecified"): void {
    void this.destroyAndWait(reason);
  }

  /** Destroy and resolve only after the omp child has fully exited. Callers
   * that delete the session file afterwards must await this — omp flushes
   * session state on shutdown and would otherwise recreate the file. */
  async destroyAndWait(reason = "unspecified"): Promise<void> {
    // Re-entrant calls join the in-flight dispose; without this a new spawn
    // can overlap the old child's shutdown (see startRpcSession).
    if (this.destroyPromise) return untilHostDown(this.host, this.destroyPromise);
    if (!this._alive) return;
    console.info("[omp-web] session-dispose", JSON.stringify({ sessionId: this._sessionId, reason, running: this.isRunning(), pendingDialogs: this.pendingUiRequests.size, at: new Date().toISOString(), caller: new Error().stack?.split("\n").slice(2, 5).map((line) => line.trim()) }));
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
    this.unsubscribeHostStatus?.();
    this.unsubscribeHostStatus = null;
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
    // The registry drops this wrapper only once the child has really exited.
    const disposed = this.proc.dispose().catch(() => {}).then(() => this.onDestroyCallback?.());
    this.destroyPromise = disposed;
    this.pendingHostTools.clear();
    for (const timer of this.parkedHostTools.values()) clearTimeout(timer);
    this.parkedHostTools.clear();
    this.hostToolNames.clear();
    this.pendingHostUris.clear();
    this.hostUriSchemes.clear();
    notifyRunningChange();
    await untilHostDown(this.host, disposed);
  }
}

/** `promise`, or sooner once `host`'s link is down: a child behind a dropped
 * link exits only when it returns, and nothing may wait that long. */
function untilHostDown(host: Host, promise: Promise<void>): Promise<void> {
  if (!isLinkUp(host.status())) return Promise.resolve();
  const { promise: settled, resolve } = Promise.withResolvers<void>();
  const unsubscribe = host.onStatus((status) => {
    if (!isLinkUp(status)) resolve();
  });
  void promise.then(resolve);
  return settled.finally(unsubscribe);
}

// ============================================================================
// Session registry
// ============================================================================
export interface RunningRpcSession {
  id: string;
  cwd: string;
  /** Absent on this machine, as on `SessionInfo`: the sidebar groups a placeholder under it. */
  hostId?: string;
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
  const map = new Map<string, RunningRpcSession>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) {
      const id = session.sessionId || sessionId;
      map.set(id, { id, cwd: session.cwd, ...(session.host.id === localHost.id ? {} : { hostId: session.host.id }) });
    }
  }
  return [...map.values()];
}

export function getRunningRpcSessionIds(): string[] {
  return getRunningRpcSessions().map((s) => s.id);
}

/** Ids of sessions with a live omp process (turn running or idle). */
export function getLiveRpcSessionIds(): string[] {
  return [...getRegistry()].filter(([, session]) => session.isAlive?.()).map(([sessionId]) => sessionId);
}

/** Stop all live omp children after an explicit runtime update. The browser will
 * reconnect sessions on demand and start them with the updated executable. */
export async function restartAllRpcSessions(): Promise<number> {
  // An update changes this machine's omp only; remote runs keep going.
  const sessions = [...new Set(getRegistry().values())].filter((session) => session.host.id === localHost.id);
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
// open omp-web tab (over the `host-tools` event-stream channel) instead of being rejected.
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
  const running = new Map<string, InterruptibleSession>();
  for (const session of registry.values()) {
    if (session.sessionId && session.isRunning()) running.set(session.sessionId, { id: session.sessionId, advisor: session.advisorSpawned, hostId: session.host.id });
  }
  recordRunningSessions([...running.values()], (id) => registry.get(id)?.isAlive() === true);
}

/**
 * Restart the sessions that were mid-run when omp-web last stopped and ask
 * each to continue. Only runs when the auto-resume setting is on. A remote
 * session waits for its host's next hello and its orphan child's exit.
 */
export async function resumeInterruptedSessions(): Promise<void> {
  const sessions = takeInterruptedSessions();
  resumeOnHostLink(sessions.filter((session) => session.hostId !== localHost.id), resumeSession);
  await Promise.all(sessions.filter((session) => session.hostId === localHost.id).map(resumeSession));
}

/** Start an interrupted session again on its host and ask it to continue. Never rejects. */
async function resumeSession({ id, advisor, hostId }: InterruptibleSession): Promise<void> {
  try {
    const host = getHost(hostId);
    const target = host && await sessionSpawnTarget(id, host);
    if (!host || !target) return;
    const { session } = await startRpcSession(id, target.sessionFile, target.cwd, undefined, advisor, target.recordedCwd, undefined, host);
    await session.send({ type: "prompt", message: RESUME_PROMPT });
    console.log(`[omp-web] resumed interrupted session ${id}`);
  } catch (error) {
    console.warn(`[omp-web] could not resume session ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get or create the omp RPC process for the given session.
 * For new sessions (sessionFile === ""), omp generates its own id.
 * Pass toolNames to pre-configure the builtin toolset of a NEW session
 * (empty array = all tools disabled); ignored when resuming.
 */
declare global {
  var __ompAgentToolGuard: AgentToolGuard | undefined;
}

/** Process-wide loop/spam guard for server agent tools (#275). Stored on
 * globalThis like the session registry so a hot reload does not silently
 * reset the chain depths mid-loop. */
function getAgentToolGuard(): AgentToolGuard {
  if (!globalThis.__ompAgentToolGuard) globalThis.__ompAgentToolGuard = new AgentToolGuard();
  return globalThis.__ompAgentToolGuard;
}

/**
 * Real session operations behind lib/agent-tools executeAgentTool.
 * Reuses the existing spawn/resume and message-send paths (startRpcSession,
 * wrapper.send) instead of a second session engine. Delivery rules, kept
 * explicit because omp's commands do not all make sense in every state:
 * - prompt: only when the target is idle (starts a new turn);
 * - steer: only when the target is running (steers that turn);
 * - followUp: any state (queues behind a running turn, or starts one
 *   when idle — omp owns the queue, as with the UI's follow-ups).
 * A waited delivery registers its turn-end waiter BEFORE sending, then
 * reads the turn's final text with get_last_assistant_text.
 */
function createAgentToolOps(): AgentToolSessionOps {
  return {
    async listSessions() {
      const running = new Set(getRunningRpcSessionIds());
      const sessions = await listSessionsAllHosts();
      return sessions.map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, running: running.has(s.id), hostId: s.hostId ?? localHost.id }));
    },

    listHosts() {
      return [
        { id: localHost.id, label: localHost.label, online: true, allowAgentStart: true },
        ...listHosts().map((h) => ({ id: h.id, label: h.label, online: isLinkUp(h.status), allowAgentStart: h.allowAgentStart })),
      ];
    },

    async createSession(input) {
      const host = getHost(input.hostId);
      if (!host) throw new Error(`Unknown host: ${input.hostId}`);
      const started = await startNewRpcSession(host, input.cwd);
      if (!started.ok) throw new Error(started.error);
      const { session, realSessionId } = started.value;
      try {
        if (input.provider && input.modelId) {
          await session.send({ type: "set_model", provider: input.provider, modelId: input.modelId });
        }
        if (input.name) await session.send({ type: "set_session_name", name: input.name });
        if (input.prompt) await session.send({ type: "prompt", message: input.prompt });
      } catch (error) {
        // As /api/agent/new: behind a dropped link the prompt may be running there, so the wrapper stays.
        if (!(error instanceof WebRpcError && error.code === "host_offline")) await session.destroyAndWait();
        throw error;
      }
      return { sessionId: realSessionId };
    },

    async deliver(input): Promise<AgentToolDeliverResult> {
      const live = getRpcSession(input.sessionId);
      let wrapper = live?.isAlive() ? live : undefined;
      if (!wrapper) {
        const host = await hostForSessionId(input.sessionId);
        const target = host && await sessionSpawnTarget(input.sessionId, host);
        if (!host || !target) throw new Error(`Session not found: ${input.sessionId}`);
        const started = await startRpcSession(input.sessionId, target.sessionFile, target.cwd, undefined, undefined, target.recordedCwd, undefined, host);
        wrapper = started.session;
      }
      const wasRunning = wrapper.isRunning();
      if (input.delivery === "prompt" && wasRunning) {
        throw new Error("Target session is running; use delivery \"steer\" or \"followUp\" for a running target.");
      }
      if (input.delivery === "steer" && !wasRunning) {
        throw new Error("Target session is not running; use delivery \"prompt\" to start a turn.");
      }
      const terminalEndsNeeded = input.delivery === "followUp" && wasRunning ? 2 : 1;
      const waiter = input.wait ? wrapper.waitForTurnEnd(input.waitTimeoutMs, terminalEndsNeeded) : null;
      await wrapper.send({ type: input.delivery, message: input.message });
      if (!input.wait || !waiter) {
        return { accepted: true, targetSessionId: input.sessionId, delivery: input.delivery, waited: false, responseText: null };
      }
      await waiter;
      const last = (await wrapper.send({ type: "get_last_assistant_text" })) as { text?: unknown } | null;
      return {
        accepted: true,
        targetSessionId: input.sessionId,
        delivery: input.delivery,
        waited: true,
        responseText: typeof last?.text === "string" ? last.text : null,
      };
    },

    async sessionHostId(sessionId) {
      const live = getRpcSession(sessionId);
      if (live?.isAlive()) return live.host.id;
      return (await hostForSessionId(sessionId))?.id ?? null;
    },
  };
}

/**
 * Spawn a brand-new session on `host` in `cwd`, checked where it lives: the
 * host answers with the path it will use. Registers the cwd with this
 * machine's file routes, or refreshes the host's session list.
 */
export async function startNewRpcSession(
  host: Host,
  cwd: string,
  toolNames?: string[],
  advisor?: boolean,
): Promise<OpResult<{ session: AgentSessionWrapper; realSessionId: string }>> {
  let spawnCwd = cwd;
  if (host === localHost) {
    if (!existsSync(cwd)) return { ok: false, status: 400, code: "directory_not_found", error: `Directory does not exist: ${cwd}` };
  } else {
    const validated = await host.sessionOps.validateCwd(cwd);
    if (!validated.ok) return validated;
    spawnCwd = validated.value.cwd;
  }
  // Unique per call: startRpcSession coalesces concurrent callers that share a key onto one session.
  const tempKey = `__new__${randomUUID()}`;
  const started = await startRpcSession(tempKey, "", spawnCwd, toolNames, advisor, undefined, undefined, host);
  if (host === localHost) {
    // Without this a file request under a brand-new cwd would 403 for up to the allowed-roots cache TTL.
    // Never for another host: its paths do not exist on this machine.
    allowFileRoot(spawnCwd);
    invalidateSessionListCache();
  } else {
    invalidateHostSessionList(host.id);
  }
  return { ok: true, value: started };
}

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
  /** Model to bind at spawn time as `provider/modelId` (--model). Only used
   * when resuming: it replaces the saved model and skips its restore check,
   * so a cold set_model can recover a session whose saved model is gone
   * (#277). Ignored when a live child is reused; the caller's set_model RPC
   * then runs against that child as before. The spawn alone does not rewrite
   * the session file, so a later spawn without an override still hits the
   * old saved model until omp records a new one (a successful set_model RPC
   * or a completed turn); the picker path re-binds on each cold switch, so
   * the user is never stuck on the unrestorable model. */
  spawnModel?: string,
  host: Host = localHost,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();

  const existing = registry.get(sessionId);
  // Union semantics, matching the spawn below and the wrapper identity:
  // workspace advisor=true forces the flag on. The gate must compare this
  // same effective value — comparing the raw toggle would destroy+respawn a
  // workspace-forced child on every toggle-off prompt. The workspace half is
  // what the host reported at the live child's spawn: asking it again would
  // cost a remote host a round trip on every prompt.
  const effectiveAdvisor = advisor === true || existing?.launchAdvisor === true;

  if (existing?.isAlive()) {
    // --advisor is a spawn-time flag with no runtime RPC. When the caller
    // carries an explicit advisor setting that differs from the live child's,
    // replace the child so the toggle takes effect on the next prompt. Busy
    // children are kept (a mid-run swap would drop in-flight work) and pick
    // the new flag up at the next natural respawn; callers that pass no
    // advisor opinion (undefined) simply reuse whatever is running. An adopted
    // child's flag is unknown, so it is never replaced over it.
    if (advisor === undefined || existing.adopted || existing.advisorSpawned === effectiveAdvisor || existing.isRunning() || existing.isEditingHistory()) {
      return { session: existing, realSessionId: sessionId };
    }
    await existing.destroyAndWait();
  }
  // A wrapper whose omp child is still flushing/exiting must fully dispose
  // before a replacement spawns — two children touching the same .jsonl would
  // race on resume/delete/archive.
  if (existing?.destroyPromise) await untilHostDown(existing.host, existing.destroyPromise);

  // omp >= 18.5 lets only one process own a session file; a second `--resume`
  // child would fork into a new nested session on its first write. Reuse the
  // live wrapper that already reports this file (e.g. after it moved files).
  if (sessionFile && !existing) {
    for (const candidate of new Set(registry.values())) {
      if (candidate.isAlive() && candidate.sessionFile && samePath(candidate.sessionFile, sessionFile)) {
        registry.set(sessionId, candidate);
        return { session: candidate, realSessionId: candidate.sessionId };
      }
    }
  }

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // The wrapper needs the process and the process's onExit needs the wrapper;
    // the holder breaks that cycle (onExit only fires once the child dies).
    const holder: { wrapper?: AgentSessionWrapper } = {};
    // A child of this session the host still ran from before a restart of this
    // server is being killed: two children must never write one session file.
    if (sessionFile && host !== localHost) await orphanExit(host.id, sessionId);
    const spawned = await host.spawnRpc({ cwd, recordedCwd: recordedCwd ?? null, sessionFile, toolNames, advisor: advisor === true, spawnModel });
    const proc = new RpcProcess({
      cwd: spawned.cwd,
      transport: spawned.transport,
      onExit: (info) => holder.wrapper?.handleProcessExit(info, proc),
    });
    const created = new AgentSessionWrapper(
      proc,
      spawned.cwd,
      recordedCwd,
      advisor === true || spawned.launchAdvisor,
      sessionFile ? sessionId : "",
      DISCONNECT_DESTROY_MS,
      host,
      spawned.launchAdvisor,
      spawned.fellBack,
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
      if (!sessionFile && created.sessionFile && await host.sessionFileExists(created.sessionFile)) {
        await created.send({ type: "new_session" });
      }
      // Register server agent tools (#275) at startup when the gate is on,
      // so a session works for agent-to-agent calls even when no browser
      // tab ever registers host tools for it. send() merges these with any
      // later UI registration, so this never drops the UI tools. Older omp
      // builds without host tools simply reject the registration; ignore
      // that the way the UI registration does.
      if (loadWebServerSettings().agentToolsEnabled) {
        await created.send({ type: "set_host_tools", tools: AGENT_TOOL_DEFINITIONS }).catch(() => {});
      }
    } catch (error) {
      // Await the child's full exit before the `finally` releases the startup
      // lock: a fire-and-forget destroy() would let a retry spawn a second
      // OMP child while the failed one is still flushing/exiting, and
      // concurrent resume/delete/archive paths could race that old child.
      const disposing = created.destroyAndWait();
      // That wait ends early once the host is offline, with the child still
      // exiting there. A resume stays registered until it really exits, so a
      // retry awaits its destroyPromise instead of starting a second
      // `--resume` child beside it. Chained on destroyPromise (set by the call
      // above), not onDestroy: a child that already exited ran no callback.
      if (sessionFile) {
        registry.set(sessionId, created);
        void created.destroyPromise?.then(() => {
          if (registry.get(sessionId) === created) registry.delete(sessionId);
        });
      }
      await disposing;
      throw error;
    }

    const realSessionId = created.sessionId;
    registerSession(created);
    // A successful respawn supersedes the crash record.
    clearExitedRpcSession(sessionId);
    if (realSessionId !== sessionId) clearExitedRpcSession(realSessionId);
    return { session: created, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}

/** Key a ready wrapper under its real id and keep its keys current as omp moves or switches it. */
function registerSession(created: AgentSessionWrapper): void {
  const registry = getRegistry();
  created.onDestroy(() => {
    // Drop every key (current id, original id, moved-from aliases).
    for (const [key, wrapper] of registry) if (wrapper === created) registry.delete(key);
  });
  created.onIdentityChange((oldId, newId, options) => {
    if (!options?.keepOldId && registry.get(oldId) === created) registry.delete(oldId);
    registry.set(newId, created);
  });
  registry.set(created.sessionId, created);
}

/**
 * Take over an omp child that outlived the server that spawned it (its host
 * listed it in `hello`): no spawn and no ready wait. `replay` holds the host's
 * raw stdout lines of the child's still-open blocking requests. Rejects, with
 * the child being killed, when this server already starts or keeps a wrapper
 * for the session (never two children on one file) or when the re-sync fails.
 */
export async function adoptRpcSession({ host, transport, sessionId, cwd, replay }: {
  host: Host;
  transport: RpcTransport;
  sessionId: string;
  cwd: string;
  replay: string[];
}): Promise<AgentSessionWrapper> {
  const registry = getRegistry();
  const locks = getLocks();
  if (locks.has(sessionId) || registry.has(sessionId)) {
    transport.killTree(false);
    throw new Error(`Session ${sessionId} is already started on this server`);
  }
  const holder: { wrapper?: AgentSessionWrapper } = {};
  const proc = new RpcProcess({ cwd, transport, adopted: { protocolVersion: 2 }, onExit: (info) => holder.wrapper?.handleProcessExit(info, proc) });
  // Spawn-time facts (--advisor, a cwd fallback) died with the server that spawned it.
  const created = new AgentSessionWrapper(proc, cwd, cwd, false, sessionId, DISCONNECT_DESTROY_MS, host);
  holder.wrapper = created;
  created.start();
  const adopting = (async () => {
    try {
      await created.adopt(replay);
    } catch (error) {
      const disposing = created.destroyAndWait("adoption-failed");
      // As for a failed resume: until the child really exits, a start for this
      // session waits for it (destroyAndWait returns early behind a dropped link).
      registry.set(sessionId, created);
      void created.destroyPromise?.then(() => {
        if (registry.get(sessionId) === created) registry.delete(sessionId);
      });
      await disposing;
      throw error;
    }
    registerSession(created);
    // The run goes on: any crash record for the session is stale.
    clearExitedRpcSession(sessionId);
    if (created.sessionId !== sessionId) clearExitedRpcSession(created.sessionId);
    notifyRunningChange();
    return { session: created, realSessionId: created.sessionId };
  })().finally(() => {
    if (locks.get(sessionId) === adopting) locks.delete(sessionId);
  });
  // A start for this session meanwhile joins the adoption instead of spawning a second child beside it.
  locks.set(sessionId, adopting);
  return (await adopting).session;
}
