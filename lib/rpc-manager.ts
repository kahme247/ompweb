import { randomUUID } from "crypto";
import { validateAgentImages } from "./image-attachments";
import { hasVisibleAssistantContent } from "./assistant-response";
import { applyMessageDelta, isDeltaUpdate, withStreamedArguments } from "./message-delta";
import { invalidateModelsCache } from "./models-cache";
import { RpcCommandError, RpcCommandTimeoutError, RpcProcess, type RpcFrame } from "./omp/rpc-process";
import type { RpcTransport } from "./omp/rpc-transport";
import { editSessionHistory, isSessionEditReply, SESSION_EDIT_COMMAND, SessionEditAgentInvocationError, type SessionEditResult } from "./omp/session-edit";
import { cacheSessionPath } from "./session-reader";
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
import { markShuttingDown, recordRunningSessions, resumeOnHostLink, takeInterruptedSessions, type InterruptibleSession } from "./session-resume";
import { RESUME_PROMPT } from "./hosts/host-resume";
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
import type { AgentMessage, CrossSessionHostToolCall, CrossSessionHostToolEvent, ExitedRpcSession, ExtensionWidgetItem } from "./types";
import { isLinkUp, type Host, type HostStatus, type SpawnRequest, type SpawnResult } from "./hosts/host";
import { freezeHostLinks, getHost, hostOwnsLifecycle, isNotifier, lastUplinkAt, listHosts, orphanExit } from "./hosts/hub";
import { HISTORY_MUTATING_COMMANDS, HostOpError, PEER_MESSAGE_FRAME } from "./hosts/link-protocol";
import { LOCAL_HOST_ID } from "./hosts/registry";
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

/** No replacing frame after a successful prompt reply: expose uncertainty rather than leave it delivering. */
export const HANDOFF_FALLBACK_MS = 2 * 60_000;
type HandOff = { error?: string; mayHaveBeenSent?: boolean };
export interface MessageReplacementWatch {
  handOff(): Promise<HandOff>;
  /** omp answered `command` under wire `id`: its `prompt_result` can settle the hand-off. */
  replied(command: object, id: string): void;
  stop(): void;
}
const CHILD_EXITED: HandOff = { error: "omp exited before it showed the message", mayHaveBeenSent: true };

function queueTexts(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return [value.steering, value.followUp].flatMap((list) => Array.isArray(list) ? list.filter((text): text is string => typeof text === "string") : []);
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("") : "";
}

/** Current native skill echoes carry the original draft in details.prompt; older echoes retain native skill name and
 * argument metadata. Only used by the active command watcher, never to settle an uncertain stored row. */
function matchesNativeSkill(message: Record<string, unknown>, submitted: string): boolean {
  if (message.role !== "custom" || message.customType !== "skill-prompt" || message.attribution !== "user") return false;
  const details = isRecord(message.details) ? message.details : {};
  if (typeof details.prompt === "string") return details.prompt.trim() === submitted.trim();
  const invocation = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(submitted.trim());
  if (!invocation) return false;
  const content = messageText(message);
  const name = typeof details.name === "string" ? details.name : /User invoked the "([^"]+)" skill/.exec(content)?.[1];
  const parts = content.split(/\nUser:\s*/);
  const args = typeof details.args === "string" ? details.args : parts.length > 1 ? parts[parts.length - 1] : "";
  return name === invocation[1] && args.trim() === (invocation[2] ?? "").trim();
}

/** Every mode requires both its command reply and a replacing frame. Baseline occurrence counts distinguish a new
 * identical queue chip from a stale one; pre-existing identical messages must echo before this one can claim an echo.
 * The command is shared with attachment preparation, so comparison uses the final text, never an empty prefix. */
function watchReplacement(wrapper: AgentSessionWrapper, command: Record<string, unknown>, baseline: unknown, generation: number, competingPending: boolean, previousEntryIds?: string[]): MessageReplacementWatch {
  const { promise, resolve } = Promise.withResolvers<HandOff>();
  const ambiguous: HandOff = { error: "Another message was dispatched while this message's native replacement was being confirmed", mayHaveBeenSent: true };
  // A peer server's admission (the daemon's marker) also contends: its identical echo is not this command's proof.
  const peers = wrapper.peerMessageCommands;
  const ownsWindow = () => !competingPending && wrapper.getMessageCommandGeneration() === generation + 1 && wrapper.peerMessageCommands === peers;
  const initialQueue = queueTexts(baseline);
  let priorQueue = initialQueue;
  let echoDebt: number | undefined;
  let seen = false;
  let stopped = false;
  let checkingExpansion = false;
  const boundary = previousEntryIds ? new Set(previousEntryIds) : null;
  const openedUserMessages = new Set<string>();
  let userMessageSeen = false;
  const gapsAtStart = wrapper.getFrameGaps();
  let timer: NodeJS.Timeout | undefined;
  let commandId: string | undefined;
  let expansionRetry: NodeJS.Timeout | undefined;
  let retryPending = false;
  /** This command's `prompt_result` came while a slash template's context check still had to decide. */
  let resultArrived = false;
  const unshown: HandOff = { error: "omp finished this message without showing it", mayHaveBeenSent: true };
  const expectedText = () => typeof command.message === "string" && command.message ? command.message : Array.isArray(command.images) && command.images.length ? "[Image]" : "";
  const finish = (outcome: HandOff) => {
    if (seen || stopped) return;
    seen = true;
    clearTimeout(expansionRetry);
    // Every channel receives the replacement before the removal, even if this listener was registered first.
    queueMicrotask(() => resolve(!outcome.error && !ownsWindow() ? ambiguous : outcome));
  };
  // Ordinary native templates don't echo their original slash token. While this idle claim is active, correlate its
  // new native user lifecycle to the sole new persisted user entry beyond the pre-dispatch boundary; the caller still
  // waits for THIS command's successful reply. Ambiguous/missing persisted context proves nothing.
  const checkExpandedUser = async (message: Record<string, unknown>) => {
    if (checkingExpansion || stopped || seen || !boundary || initialQueue.length || command.type !== "prompt"
      || command.streamingBehavior || !expectedText().trimStart().startsWith("/")) return;
    checkingExpansion = true;
    clearTimeout(expansionRetry);
    retryPending = false;
    let retry = false;
    try {
      const context = await wrapper.withPendingCommand(() => wrapper.host.sessionOps.readContext(wrapper.sessionId, undefined, {
        boundary: false, deferThinking: true, deferMedia: true, includePreCompaction: false, sync: null,
      }));
      if (!context.ok || !isRecord(context.value)) { retry = !context.ok && context.status >= 500; return; }
      const { entryIds, messages } = context.value;
      if (!Array.isArray(entryIds) || !Array.isArray(messages)) return;
      const added = messages.filter((item, index) => typeof entryIds[index] === "string" && !boundary.has(entryIds[index])
        && isRecord(item) && item.role === "user");
      if (added.length === 1 && isRecord(added[0]) && messageText(added[0]) === messageText(message)) finish({});
      // Native echo can precede the file flush. Re-read only this active candidate, never infer a missing entry.
      retry = added.length === 0;
    } catch {
      // No post-dispatch state is guessed from a failed read; keep waiting for a proven replacement.
      retry = true;
    } finally {
      checkingExpansion = false;
      if (retry && !stopped && !seen) {
        retryPending = true;
        expansionRetry = setTimeout(() => { void checkExpandedUser(message); }, 100);
        expansionRetry.unref?.();
      } else if (resultArrived) finish(unshown);
    }
  };
  const detach = wrapper.onEvent((event) => {
    if (seen) return;
    if (competingPending || wrapper.getMessageCommandGeneration() > generation + 1 || wrapper.peerMessageCommands !== peers) { finish(ambiguous); return; }
    if (!ownsWindow() && event.type !== "process_exit") return;
    const text = expectedText();
    if (echoDebt === undefined) echoDebt = initialQueue.filter((item) => item === text).length;
    if ((event.type === "message_start" || event.type === "message_end") && isRecord(event.message)
      && (event.message.role === "user" || (event.message.role === "custom" && event.message.attribution === "user"))) userMessageSeen = true;
    if (event.type === "message_start" && typeof event.messageId === "string" && isRecord(event.message) && event.message.role === "user") {
      openedUserMessages.add(event.messageId);
    } else if (event.type === "queue_update") {
      const next = queueTexts(event);
      const counts = new Map<string, number>();
      for (const item of priorQueue) counts.set(item, (counts.get(item) ?? 0) + 1);
      const added: string[] = [];
      for (const item of next) {
        const remaining = counts.get(item) ?? 0;
        if (remaining) counts.set(item, remaining - 1);
        else added.push(item);
      }
      if (text && (added.includes(text) || (command.type === "prompt" && text.trimStart().startsWith("/") && added.length === 1))) finish({});
      priorQueue = next;
    } else if (event.type === "message_end" && isRecord(event.message)
      && (event.message.role === "user" || (event.message.role === "custom" && event.message.attribution === "user"))) {
      if (text && (messageText(event.message) === text || matchesNativeSkill(event.message, text))) {
        if (echoDebt > 0) echoDebt -= 1;
        else finish({});
      } else if (event.message.role === "user" && (typeof event.messageId !== "string" || openedUserMessages.has(event.messageId))) {
        void checkExpandedUser(event.message);
      }
    } else if (event.type === "process_exit") finish(CHILD_EXITED);
    else if (event.type === "prompt_result" && commandId !== undefined && event.id === commandId) {
      // omp finished this prompt with no echo, so none will come. An expanded slash template's context check decides
      // first; once it has nothing left to try, the message may still be in the transcript.
      if (userMessageSeen && text.trimStart().startsWith("/")) {
        resultArrived = true;
        if (!checkingExpansion && !retryPending) finish(unshown);
        return;
      }
      // It reached no transcript when omp showed no user message (an input hook may rewrite the text) and ran no turn
      // for it: Stop or a refusal during setup, an aborted or failed run. A slash command may have acted on its own, and
      // frames lost meanwhile (a link drop, a daemon `resync`) may have carried the echo.
      const dropped = !userMessageSeen && !text.trimStart().startsWith("/") && wrapper.getFrameGaps() === gapsAtStart
        && (event.agentInvoked === false || event.status === "aborted" || event.status === "error");
      // A failed hand-off needs a non-empty error: callers treat an empty one as delivered.
      const reason = isRecord(event.error) && typeof event.error.message === "string" && event.error.message.trim() ? event.error.message
        : dropped ? "Stopped before omp showed it" : unshown.error;
      finish({ error: reason, mayHaveBeenSent: !dropped });
    } else if (event.type === "agent_end" && event.isTerminal !== false && !wrapper.isAlive()) finish(CHILD_EXITED);
    // Session-wide prompt failures may belong to an older run; only this command's reply can prove rejection.
  }, { internal: true });
  return {
    async handOff() {
      if (!ownsWindow()) return ambiguous;
      timer = setTimeout(() => finish({ error: "omp acknowledged this message but has not shown it yet", mayHaveBeenSent: true }), HANDOFF_FALLBACK_MS);
      timer.unref?.();
      const outcome = await promise;
      return ownsWindow() ? outcome : ambiguous;
    },
    replied(watched, id) { if (watched === command) commandId = id; },
    stop() { stopped = true; clearTimeout(timer); clearTimeout(expansionRetry); detach(); },
  };
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
  private messageCommandGeneration = 0;
  /** Times this child's frames may have been lost (`reconcileAfterGap`). */
  private frameGaps = 0;
  private confirmedMessageCommandGeneration = 0;
  private pendingMessageCommands = 0;
  private nativeQueuedMessages: unknown = { steering: [], followUp: [] };
  private readonly startedEmpty: boolean;
  private messageReplacement: MessageReplacementWatch | null = null;
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
  private streamingMessageId: string | null = null;
  /** Assistant messages omp is streaming, by messageId: what its delta updates apply to (lib/message-delta.ts). */
  private openMessages = new Map<string, Partial<AgentMessage>>();
  /** False once omp's deltas did not fit a message it started, or switching updates failed: full updates for good. */
  private deltasFit = true;
  /** A delta found no message to apply to: omp sends full updates until the message ends. */
  private recoveringUpdates = false;
  private liveToolEvents = new Map<string, SessionLiveToolEvent>();
  /** Calls that returned: omp keeps sending `tool_execution_update` for a backgrounded job with no later end. */
  private endedToolCalls = new Set<string>();
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
  /** Accepted browser definitions only: server tools follow the current enablement policy when a child is renewed. */
  private registeredHostTools: Array<{ name?: unknown; [key: string]: unknown }> | null = null;
  /** Feeding an adopted child's open requests (see adopt): server agent tools there may already have run. */
  private replaying = false;
  /** Adopted, and no tab has registered host tools since: omp may call tools the
   * wrapper a restart lost registered, so every call routes as registered. */
  private hostToolsUnknown = false;
  private _adopted = false;
  /** host_tool_call ids awaiting a host_tool_result from the browser. */
  private pendingHostTools = new Map<string, { event: UnsequencedAgentEvent; crossSessionId?: string }>();
  /** Own host calls no tab has seen yet (see parkHostTool), with their deadlines. */
  private parkedHostTools = new Map<string, ReturnType<typeof setTimeout>>();
  /** Listeners omp-web attaches itself (waitForTurnEnd), not tabs: a parked host call waits for a tab. */
  private readonly internalListeners = new WeakSet<EventListener>();
  /** URI schemes the web UI registered via set_host_uri_schemes. */
  private hostUriSchemes: Map<string, { writable?: boolean }> = new Map();
  private registeredHostUriSchemes: Array<{ scheme?: unknown; writable?: unknown; [key: string]: unknown }> | null = null;
  /** host_uri_request ids awaiting a host_uri_result from the browser. */
  private pendingHostUris: Map<string, UnsequencedAgentEvent> = new Map();
  /** Callback delivery is not permission to repeat an action after a snapshot/reconnect. */
  private deliveredCallbacks = new Set<string>();
  /** Message commands other servers wrote to this shared child (PEER_MESSAGE_FRAME markers). */
  peerMessageCommands = 0;
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
    host: Host = getHost(LOCAL_HOST_ID),
    launchAdvisor = false,
    fellBack = false,
  ) {
    this.proc = proc;
    this.cwd = cwd;
    this.recordedCwd = recordedCwd ?? null;
    this.advisorSpawned = advisorSpawned;
    this._sessionId = expectedSessionId;
    this.startedEmpty = expectedSessionId === "";
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

  get hostOwnedLifecycle(): boolean {
    return this.proc.transport?.hostOwnedLifecycle === true;
  }

  private reportInterest(): void {
    this.proc.transport?.setInterest?.(this._alive && (this.hasSubscribers() || this.pendingCommands > 0 || this.handshaking));
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

  /** A native terminal event can leave background work unsettled; advisor changes wait for it too. */
  canReplaceAdvisor(): boolean {
    return this.isAlive() && !this.restarting && !this.handshaking && !this.unsettled && !this.messageBoundaryBusy();
  }

  async replaceAdvisorIfIdle(launch: SpawnRequest, preparing: boolean): Promise<SpawnResult | null> {
    if (!this.hostOwnedLifecycle || !this.canReplaceAdvisor()) return null;
    const old = this.proc;
    this.restarting = true;
    this.expectedExitProc = old;
    try {
      const spawned = await this.host.spawnRpc(launch, this._sessionId, { replaceAdvisor: true, preparing });
      if (spawned.transport === old.transport) return null; // A peer became busy before the daemon's atomic check.
      await this.destroyAndWait("advisor");
      return spawned;
    } catch (error) {
      // The daemon stopped the old child before the replacement failed; its exit was ignored as expected.
      if (!old.isAlive) await this.destroyAndWait("advisor-failed");
      throw error;
    } finally {
      if (this.expectedExitProc === old) this.expectedExitProc = null;
      this.restarting = false;
    }
  }

  /** Any event observer is attached, including internal work that protects the session lifetime. */
  hasSubscribers(): boolean {
    return this.listeners.length > 0;
  }

  private hasBrowserSubscribers(): boolean {
    return this.listeners.some((listener) => !this.internalListeners.has(listener));
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
    if (this.hostOwnedLifecycle) return;
    this.lastActivityAt = Date.now();
    this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
    this.armReap();
  }

  private armReap(): void {
    if (this.hostOwnedLifecycle) return;
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
   *  - pendingCommands covers command preparation and dispatch, including a
   *    response the child still owes us;
   *  - the deadline check absorbs activity that landed while this fired.
   * Anything else keeps the session and re-arms for the remaining window.
   */
  private reapIfDisconnected(): void {
    if (this.hostOwnedLifecycle) return;
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
      streamingMessage: this.streamingMessage ? { ...withStreamedArguments(this.streamingMessage) } : null,
      streamingMessageId: this.streamingMessageId,
      toolEvents: Array.from(this.liveToolEvents.values(), (event) => ({ ...event })),
    };
  }

  private clearLiveSnapshots(): void {
    this.streamingMessage = null;
    this.streamingMessageId = null;
    this.openMessages.clear();
    this.liveToolEvents.clear();
    this.streamSequence += 1;
  }

  private resetStream(): void {
    this.clearLiveSnapshots();
    this.responseObserved = false;
    this.responseRunActive = false;
    this.endedToolCalls.clear();
    this.streamId = randomUUID();
    this.streamSequence = 0;
  }

  private endTool(toolCallId: string): void {
    this.liveToolEvents.delete(toolCallId);
    this.endedToolCalls.add(toolCallId);
  }

  start(): void {
    this.unsubscribeFrames = this.proc.onFrame((frame) => this.handleFrame(frame));
    this.watchResync(this.proc);
    this.unsubscribeHostStatus = this.host.onStatus((status) => this.handleHostStatus(status));
    this.reportInterest();
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
   * Duck-typed: a `bun --hot` re-evaluation can leave live transports on an older class. */
  private watchResync(proc: RpcProcess): void {
    proc.transport?.onResync?.(() => {
      if (this.proc !== proc) return;
      if (this.hostOwnedLifecycle) {
        this.clearLiveSnapshots();
        this.recoveringUpdates = false;
        for (const id of [...this.pendingUiRequests.keys()]) {
          if (this.serverUiRequests.has(id)) continue;
          this.forgetPendingUiRequest(id);
          this.emit({ type: "extension_ui_request", id: `cancel:${id}`, method: "cancel", targetId: id });
        }
      }
      void this.reconcileAfterGap();
    });
  }

  private handleHostStatus(status: HostStatus): void {
    if (!this._alive) return;
    this.emit({ type: "host_status", hostId: this.host.id, status });
    if (!isLinkUp(status)) return;
    if (this.hostOwnedLifecycle) return; // The hub reopens at an ordered snapshot boundary.
    // The idle and disconnect timers held off while the link was down; give them a full window again.
    this.resetIdleTimer(true);
    void this.reconcileAfterGap();
  }

  /** Frames may have been lost (link down, `resync`): re-read omp's state, as the client's get_state reconcile does. */
  private async reconcileAfterGap(): Promise<void> {
    this.frameGaps += 1;
    // A lost delta would corrupt its message silently: rebuild from the next full update instead.
    this.openMessages.clear();
    try {
      const state = await this.getStateWithTimeout();
      if (!this._alive) return;
      const wasRunning = this.streaming || this.promptRunning;
      const oldId = this._sessionId;
      const moved = this.sessionMovePending;
      // A shared reopen can install the new identity's snapshot while this read is in flight (cleared when it started).
      const live = this.hostOwnedLifecycle ? { open: new Map(this.openMessages), message: this.streamingMessage, id: this.streamingMessageId } : null;
      this.applyIdentity(state);
      if (oldId && oldId !== this._sessionId && !moved) {
        if (live) {
          for (const [messageId, message] of live.open) this.openMessages.set(messageId, message);
          this.streamingMessage = live.message;
          this.streamingMessageId = live.id;
        }
        this.onIdentityChangeCallback?.(oldId, this._sessionId);
      }
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
    this.reportInterest();
    try {
      if (!this.hostOwnedLifecycle) {
        const ready = await this.proc.waitReady(READY_TIMEOUT_MS);
        await this.proc.negotiateProtocol(ready);
        await this.proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
        await this.proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
        await this.enableDeltaUpdates(this.proc);
      }
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
      this.reportInterest();
      // The handshake is real activity, so the reap clock restarts from here
      // rather than from spawn (a slow start must not eat the whole window).
      this.noteActivity();
    }
  }

  /**
   * omp >= 18.4.5 accepts `messageUpdates: "delta"`; from 18.13.2 its deltas carry the block shells that make them
   * rebuildable (an omp in between is caught at its first block, see loseDeltaBase). An older omp rejects or
   * ignores the option and keeps full updates.
   */
  private async enableDeltaUpdates(proc: RpcProcess): Promise<void> {
    if (proc.transport?.hostOwnedLifecycle) return;
    this.recoveringUpdates = false;
    this.deltasFit = true;
    await proc.sendCommand({ type: "set_event_filter", events: null, messageUpdates: "delta" }, GET_STATE_TIMEOUT_MS).catch(() => {});
  }

  private setMessageUpdates(messageUpdates: "full" | "delta"): void {
    if (this.hostOwnedLifecycle) return;
    void this.proc.sendCommand({ type: "set_event_filter", events: null, messageUpdates }, GET_STATE_TIMEOUT_MS).catch(() => {
      // The next delta that finds no base asks again; nothing switches back to deltas.
      this.recoveringUpdates = false;
      this.deltasFit = false;
    });
  }

  /**
   * A delta found no message to apply to (attached mid-message, adopted child,
   * frames lost on the link): full updates until the message ends rebuild it.
   * `incompatible`: the message was there, so this omp's deltas do not fit
   * what it started (one before 18.13.2 sends no block shells): full updates for good.
   */
  private loseDeltaBase(incompatible: boolean): void {
    if (this.hostOwnedLifecycle) {
      if (!this.recoveringUpdates) {
        this.recoveringUpdates = true;
        void this.proc.transport.resync?.();
      }
      return;
    }
    if (incompatible) this.deltasFit = false;
    if (this.recoveringUpdates) return;
    this.recoveringUpdates = true;
    this.setMessageUpdates("full");
  }

  private resumeDeltaUpdates(): void {
    if (!this.recoveringUpdates) return;
    this.recoveringUpdates = false;
    if (this.deltasFit) this.setMessageUpdates("delta");
  }

  /**
   * Re-sync a child that outlived the server that spawned it (adoptRpcSession):
   * the startup handshake minus the ready wait, every command bounded so a
   * wedged child fails the adoption, then the daemon's lines of its open requests.
   * `joined`: false when this open started the shared child, so no other server's history precedes it.
   */
  async adopt(replay: string[], joined = true): Promise<void> {
    this.handshaking = true;
    this.reportInterest();
    this._adopted = joined;
    this.hostToolsUnknown = true;
    // Older omp rejects some of these, as at startup; a timeout or an exit fails the adoption.
    const optional = (command: { type: string; [key: string]: unknown }) => this.proc.sendCommand(command, GET_STATE_TIMEOUT_MS).then(() => {}, (error) => {
      if (!(error instanceof RpcCommandError)) throw error;
    });
    try {
      if (!this.hostOwnedLifecycle) {
        await this.proc.negotiateProtocol(await this.proc.waitReady(), GET_STATE_TIMEOUT_MS);
        await optional({ type: "set_subagent_subscription", level: "events" });
        await optional({ type: "set_ask_dialog", enabled: true });
        await this.enableDeltaUpdates(this.proc);
      }
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
      // Frames omp sent during the handshake are live: its agent tool calls there run normally.
      this.proc.release();
      if (this.hostOwnedLifecycle && loadWebServerSettings().agentToolsEnabled) {
        await this.dispatchCommand({ type: "set_host_tools", tools: this.registeredHostTools ?? [] });
      }
    } finally {
      this.handshaking = false;
      this.reportInterest();
      this.noteActivity();
    }
  }

  /** Joined an existing protocol endpoint; only legacy adoption loses spawn-time advisor metadata. */
  get adopted(): boolean {
    return this._adopted;
  }

  private applyIdentity(state: RpcSessionState): void {
    if (state.queuedMessages !== undefined) this.nativeQueuedMessages = state.queuedMessages;
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
    // The path cache resolves ids to files on this machine only (file authorization).
    if (this._sessionFile && this.host.id === LOCAL_HOST_ID) cacheSessionPath(this._sessionId, this._sessionFile);
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
      await this.sendNativeMessageCommand({ type: "prompt", message: "/rename" }, PROMPT_ACK_TIMEOUT_MS);
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
    // Every server sharing the child sees the same turn end: only the elected notifier titles it.
    if (this.hostOwnedLifecycle && !isNotifier(this.host.id)) return;
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
    // The shared host stopped it on purpose (abandoned, idle, another server's request): not a crash.
    const planned = this.hostOwnedLifecycle ? sourceProc.transport?.stopReason : undefined;
    if (planned) {
      if (this.streaming || this.promptRunning) this.emit({ type: "agent_end", isTerminal: true, messages: [] });
      this.destroy(`host-${planned}`);
      return;
    }
    const detail = (stderrTail.trim().split("\n").pop() ?? "").slice(-500);
    const status = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
    // Spec Rules → Reattach: a run whose child vanished while its host link was
    // down starts again on that host, like a local run after a restart.
    const resume: InterruptibleSession | null = !this.hostOwnedLifecycle && sourceProc.transport?.lost === true && this._sessionId && (this.streaming || this.promptRunning)
      ? { id: this._sessionId, advisor: this.advisorSpawned, hostId: this.host.id }
      : null;
    // Recorded before destroy(): its running-change broadcast must carry the
    // record so sidebars that missed the notice below still see the exit.
    if (this._sessionId) getExitedMap().set(this._sessionId, { id: this._sessionId, cwd: this.cwd, ...(this.host.id === LOCAL_HOST_ID ? {} : { hostId: this.host.id }), at: Date.now(), code, signal, detail });
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
    const notifications = this.detectNotification(frame, session);
    if (this.hostOwnedLifecycle && !isNotifier(this.host.id)) return;
    for (const notification of notifications) {
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
    if (event.type === PEER_MESSAGE_FRAME) {
      this.peerMessageCommands += 1;
      return;
    }
    if (this.hostOwnedLifecycle && (event.type === "host_tool_call" || event.type === "host_uri_request") && typeof event.id === "string") {
      const key = `${event.type}:${event.id}`;
      if (this.deliveredCallbacks.has(key)) return;
      this.deliveredCallbacks.add(key);
      // Only the read-only listing runs again (handled below); anything else may already have run.
      if (this.replaying && !(event.type === "host_tool_call" && event.toolName === "list_sessions")) {
        this.proc.sendFrame(event.type === "host_tool_call"
          ? { type: "host_tool_result", id: event.id, isError: true, result: { content: [{ type: "text", text: AGENT_TOOL_UNKNOWN_OUTCOME }] } }
          : { type: "host_uri_result", id: event.id, isError: true, error: AGENT_TOOL_UNKNOWN_OUTCOME });
        return;
      }
    }
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
      case "queue_update":
        this.nativeQueuedMessages = event;
        break;
      case "session_settled":
        this.unsettled = false;
        this.deliveredCallbacks.clear();
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
                  text: "Agent tools are disabled. Enable \"Agent tools\" in omp-web Settings (System) first.",
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
          const ownTab = this.hasBrowserSubscribers();
          if (ownTab) {
            this.pendingHostTools.set(id, { event });
            this.emit(event);
            notifyRunningChange();
            return;
          }
          const otherTabs = getHostToolListeners();
          if (otherTabs.size > 0) {
            this.pendingHostTools.set(id, { event, crossSessionId: this.sessionId });
            const args = event.arguments && typeof event.arguments === "object" ? event.arguments as Record<string, unknown> : {};
            const call: CrossSessionHostToolCall = { sessionId: this.sessionId, hostId: this.host.id, cwd: this.cwd, id, toolName, arguments: args };
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
        if (targetId && this.cancelPendingHostTool(targetId)) {
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
        if (id && scheme && registered && (operation !== "write" || registered.writable) && this.hasBrowserSubscribers()) {
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

  /** Withdraw the browser operation using the identity under which it was delivered. */
  private cancelPendingHostTool(id: string): boolean {
    const pending = this.pendingHostTools.get(id);
    if (!pending) return false;
    this.pendingHostTools.delete(id);
    this.unparkHostTool(id);
    const event = { type: "host_tool_cancel", targetId: id };
    this.emit(event);
    if (pending.crossSessionId !== undefined) {
      for (const listener of getHostToolListeners()) {
        try { listener({ type: "host_tool_cancel", targetId: id, sessionId: pending.crossSessionId }); } catch { /* ignore listener errors */ }
      }
    }
    return true;
  }

  /**
   * Reject outstanding host tool calls (browser disconnected / destroy): "own" ones went to this session's
   * stream, "cross" ones to other open tabs (see subscribeHostToolCalls).
   */
  private rejectPendingHostTools(message: string, which: "all" | "own" | "cross" = "all"): void {
    for (const [id, pending] of this.pendingHostTools) {
      const cross = pending.crossSessionId !== undefined;
      if ((which === "own" && cross) || (which === "cross" && !cross)) continue;
      // No tab ever received it: its own deadline settles it (see parkHostTool).
      if (which === "own" && this.parkedHostTools.has(id)) continue;
      this.cancelPendingHostTool(id);
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
    this.pendingHostTools.set(id, { event });
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
        this.resumeDeltaUpdates();
        break;
      case "prompt_error":
      case "prompt_result":
        this.responseRunActive = false;
        this.streaming = false;
        this.compacting = false;
        this.promptRunning = false;
        this.clearLiveSnapshots();
        this.resumeDeltaUpdates();
        break;
      case "message_start":
      case "message_update": {
        let message = event.message as Partial<AgentMessage> | undefined;
        const messageId = typeof event.messageId === "string" ? event.messageId : null;
        if (isDeltaUpdate(event)) {
          const base = messageId === null ? undefined : this.openMessages.get(messageId);
          const rebuilt = applyMessageDelta(base, event.assistantMessageEvent);
          // Never forward a delta nobody can apply: tabs get the message again from omp's full updates.
          if (!rebuilt) {
            this.loseDeltaBase(base !== undefined);
            return;
          }
          message = rebuilt;
        }
        // Daemon snapshots are ordered delta bases (including partialJson); legacy full updates are not.
        if (messageId !== null && message?.role === "assistant") {
          if (this.hostOwnedLifecycle || event.type === "message_start" || isDeltaUpdate(event)) this.openMessages.set(messageId, message);
          else this.openMessages.delete(messageId);
        }
        if (message && message.role !== "user") {
          this.streamingMessage = message;
          this.streamingMessageId = messageId;
        }
        if (this.responseRunActive && hasVisibleAssistantContent(message)) this.responseObserved = true;
        break;
      }
      case "message_end": {
        const message = event.message as Partial<AgentMessage> | undefined;
        if (this.responseRunActive && hasVisibleAssistantContent(message)) this.responseObserved = true;
        if (typeof event.messageId === "string") this.openMessages.delete(event.messageId);
        if (message?.role && message.role === this.streamingMessage?.role) {
          this.streamingMessage = null;
          this.streamingMessageId = null;
        }
        if (message?.role === "toolResult" && message.toolCallId) this.endTool(message.toolCallId);
        if (message?.role === "assistant") this.resumeDeltaUpdates();
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
        if (typeof event.toolCallId !== "string") break;
        // A start is always a new execution, even of a reused id. A returned call's updates are stale: its row
        // shows the committed result, so tabs and the snapshot both drop them (a tab would show it running again).
        // shortcut: a wrapper adopted after a server restart never saw the ends and still passes those updates; filter against committed results if adopted chats show them.
        if (event.type === "tool_execution_start") this.endedToolCalls.delete(event.toolCallId);
        else if (this.endedToolCalls.has(event.toolCallId)) return;
        this.liveToolEvents.set(event.toolCallId, {
          ...this.liveToolEvents.get(event.toolCallId),
          ...event,
          type: event.type,
          toolCallId: event.toolCallId,
        });
        break;
      case "tool_execution_end":
        if (typeof event.toolCallId === "string") this.endTool(event.toolCallId);
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
    for (const tap of globalThis.__ompFrameTaps ?? []) {
      try {
        tap(this, event as AgentEvent);
      } catch {
        // Same isolation as the listeners above.
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
    if (this.hostOwnedLifecycle) return;
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

  /** `internal`: omp-web's own listener (waitForTurnEnd), never handed a parked host call. */
  onEvent(listener: EventListener, { internal = false }: { internal?: boolean } = {}): () => void {
    if (internal) this.internalListeners.add(listener);
    this.listeners.push(listener);
    this.reportInterest();
    this.noteActivity();
    const now = Date.now();
    // A tab attaching mid-message needs the whole message before omp's next delta.
    if (!internal && this.streamingMessage?.role === "assistant" && this.streamingMessageId !== null) {
      listener({
        type: "message_update",
        messageId: this.streamingMessageId,
        message: withStreamedArguments(this.streamingMessage),
        web: { streamId: this.streamId, sequence: this.streamSequence },
      });
    }
    for (const [id, event] of this.pendingUiRequests) {
      const expiresAt = event.expiresAt as number | undefined;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.forgetPendingUiRequest(id);
        continue;
      }
      listener({ ...event, web: { streamId: this.streamId, sequence: ++this.streamSequence } });
    }
    // Own host calls parked while no tab could answer go to the first tab that attaches, once.
    for (const id of internal ? [] : [...this.parkedHostTools.keys()]) {
      this.unparkHostTool(id);
      const event = this.pendingHostTools.get(id)?.event;
      if (event) listener({ ...event, web: { streamId: this.streamId, sequence: ++this.streamSequence } });
    }
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
      this.reportInterest();
      // No UI attached anymore: reject outstanding host tool calls so the
      // agent never waits forever on a tool nobody will answer.
      if (!this.hasBrowserSubscribers()) {
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

  /** Record an id this conversation was reached by before omp moved it; tabs still on it are still viewing it. */
  keepMovedFromId(id: string): void {
    if (!this.movedFromIds.includes(id)) this.movedFromIds.push(id);
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
      }, { internal: true });
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
      await this.sendNativeMessageCommand({ type: "prompt", message: action === "list" ? "/mcp list" : `/mcp ${action}${name ? ` ${name}` : ""}` }, PROMPT_ACK_TIMEOUT_MS);
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
        await this.destroyAndWait("session-unresponsive", true);
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
    // Other web apps sharing the child are fenced by the host's lease, acquired before preflight and held through postflight.
    let leased = false;
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
      if (proc.transport?.setEditing) {
        leased = await proc.transport.setEditing(true).then(() => true, (error: unknown) => {
          if (error instanceof HostOpError && error.code === "session_busy") throw new WebRpcError(error.message, "session_busy");
          // shortcut: pre-release v7 daemons (62a195b) lack the op; edit unfenced across servers until they restart.
          if (error instanceof HostOpError && error.code === "unknown_op") return false;
          throw error;
        });
      }
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
        await this.destroyAndWait("session-unresponsive", true);
        if (persistenceError) throw persistenceError;
        throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
      }
      if (error instanceof SessionEditAgentInvocationError && !error.agentStarted) {
        // Native /retry can acknowledge before its deferred agent_start. There
        // is no observed run to own that gap: stop it before releasing Edit.
        await this.destroyAndWait("session-unresponsive", true);
      }
      throw persistenceError ?? error;
    } finally {
      unsubscribe();
      this.historyEditInFlight = false;
      if (leased) void proc.transport?.setEditing?.(false).catch(() => {}); // A lost release ends when this link drops.
      notifyRunningChange();
    }
  }

  /** Full restart of the child process against the same session file. This is
   * omp-web's `reload`: extensions, skills, prompts, and tools are rediscovered
   * on boot, matching a fresh CLI launch. */
  private async restart(requireIdle = false): Promise<void> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    const sessionFile = this._sessionFile;
    const old = this.proc;
    const generation = this.messageCommandGeneration;
    // Stays true for the whole restart so send() rejects commands that would
    // otherwise hit the disposed or half-built child.
    this.restarting = true;
    let resumable: boolean;
    try {
      if (requireIdle && this.hostDown()) throw this.hostOfflineError("refused");
      // Asked before touching the live child: a remote host can be offline,
      // and the child must then keep running with its frames still read.
      resumable = !!sessionFile && await this.host.sessionFileExists(sessionFile);
      if (requireIdle) {
        if (this.hostDown()) throw this.hostOfflineError("refused");
        if (!resumable) throw new WebRpcError("The saved session is not available for an idle restart", "session_busy");
        if (!this.isAlive() || this.proc !== old || this.messageCommandGeneration !== generation || this.messageBoundaryBusy(1)) {
          throw new WebRpcError("Wait for the current operation to finish", "session_busy");
        }
      }
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
      const disposing = old.dispose(5_000, true).then(() => {
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
      }, resumable ? this._sessionId : null);
      const proc = new RpcProcess({
        cwd: spawned.cwd,
        transport: spawned.transport,
        ...(spawned.transport.hostOwnedLifecycle ? { adopted: { protocolVersion: 2 as const } } : {}),
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
      // Callback ids belong to the old child; the replacement's must not be suppressed.
      this.deliveredCallbacks.clear();
      this.messageCommandGeneration += 1;
      this.confirmedMessageCommandGeneration = this.messageCommandGeneration;
      this.unsubscribeFrames = proc.onFrame((frame) => this.handleFrame(frame));
      this.watchResync(proc);
      this.reportInterest();
      try {
        if (this.hostOwnedLifecycle) {
          await this.adopt([...(spawned.pending ?? []), ...(spawned.streaming ? [spawned.streaming] : [])]);
        } else {
          const ready = await proc.waitReady(READY_TIMEOUT_MS);
          await proc.negotiateProtocol(ready);
          await proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
          await proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
          await this.enableDeltaUpdates(proc);
        }
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
        if (requireIdle || this.hostOwnedLifecycle) {
          if (this.registeredHostTools !== null) {
            await this.dispatchCommand({ type: "set_host_tools", tools: this.registeredHostTools });
          } else if (loadWebServerSettings().agentToolsEnabled) {
            // Like initial startup, a runtime that never accepted host tools may reject this optional registration.
            await this.dispatchCommand({ type: "set_host_tools", tools: [] }).catch(() => {});
          }
          if (this.registeredHostUriSchemes !== null) {
            await this.dispatchCommand({ type: "set_host_uri_schemes", schemes: this.registeredHostUriSchemes });
          }
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

  /** Protect submitted command work, including route preparation, from both idle reapers.
   * `takeOverOpen`: this is the command its open requested a preparation lease for. */
  async withPendingCommand<T>(callback: () => Promise<T>, takeOverOpen = false): Promise<T> {
    this.resetIdleTimer();
    this.pendingCommands += 1;
    this.reportInterest();
    const preparing = this.proc.transport;
    preparing?.setPreparing?.(true, takeOverOpen);
    try {
      return await callback();
    } finally {
      this.pendingCommands -= 1;
      preparing?.setPreparing?.(false);
      this.reportInterest();
    }
  }
  /** Process-local admission only, not a native message id: overlapping writes make echo inference uncertain. */
  getMessageCommandGeneration(): number { return this.messageCommandGeneration; }
  /** Changes whenever frames may have been lost, so a missing echo then proves nothing. */
  getFrameGaps(): number { return this.frameGaps; }
  /** ACKs/settlement aren't command-specific echo receipts: earlier writes need an uncontended replacement proof. */
  hasPendingMessageCommands(): boolean {
    return this.pendingMessageCommands > 0 || this.confirmedMessageCommandGeneration !== this.messageCommandGeneration;
  }

  /** Only advance a contiguous, uncontended admission after its replacing frame (or a no-agent builtin receipt). */
  confirmMessageCommandGeneration(generation: number): void {
    if (generation === this.messageCommandGeneration && generation === this.confirmedMessageCommandGeneration + 1) {
      this.confirmedMessageCommandGeneration = generation;
    }
  }

  private messageBoundaryBusy(ownedPendingCommands = 0): boolean {
    return this.isRunning() || this.historyEditInFlight || this.historyMutationPendingCount > 0
      || this.pendingCommands > ownedPendingCommands
      || this.pendingMessageCommands > 0 || this.pendingUiRequests.size > 0
      || this.pendingHostTools.size > 0 || this.pendingHostUris.size > 0;
  }

  /** A settled idle child may be replaced to stop OLD uncertain effects; this never confirms or replays them. */
  async renewMessageProofBoundaryIfIdle(): Promise<boolean> {
    if (this.hostOwnedLifecycle || !this.hasPendingMessageCommands() || this.restarting || this.hostDown() || this.messageBoundaryBusy()) return false;
    return this.withPendingCommand(async () => {
      const proc = this.proc;
      const generation = this.messageCommandGeneration;
      const before = await this.getStateWithTimeout();
      if (before.isSettled !== true || before.hasPendingAsyncWork === true
        || before.isStreaming !== false || before.isCompacting !== false
        || before.queuedMessageCount > 0 || queueTexts(before.queuedMessages).length > 0
        || before.sessionId !== this._sessionId || before.sessionFile !== this._sessionFile
        || this.proc !== proc || this.messageCommandGeneration !== generation
        || this.restarting || this.messageBoundaryBusy(1) || !this.hasPendingMessageCommands()) return false;
      await this.restart(true);
      return this.proc !== proc;
    });
  }

  /** The outbox supplies its persisted pre-dispatch boundary; direct writes reuse this same proof below. */
  watchMessageReplacement(command: Record<string, unknown>, baseline: unknown, generation: number, competingPending: boolean, previousEntryIds?: string[]): MessageReplacementWatch {
    const proof = watchReplacement(this, command, baseline, generation, competingPending, previousEntryIds);
    this.messageReplacement = proof;
    return {
      handOff: proof.handOff,
      replied: proof.replied,
      stop: () => {
        proof.stop();
        if (this.messageReplacement === proof) this.messageReplacement = null;
      },
    };
  }

  /** `origin`: the command a caller submitted through `send`; marked once its native message write begins. */
  private async sendNativeMessageCommand<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number, origin?: object): Promise<T> {
    const message = IMAGE_BEARING_COMMANDS.has(command.type);
    const proof = message && !this.messageReplacement && !this.hasPendingMessageCommands()
      ? watchReplacement(this, command, this.nativeQueuedMessages, this.messageCommandGeneration, false,
        this.startedEmpty && !this.adopted && this.messageCommandGeneration === 0 ? [] : undefined)
      : null;
    if (message) {
      this.messageCommandGeneration += 1;
      this.pendingMessageCommands += 1;
      if (origin) nativeWrites().add(origin);
    }
    const generation = this.messageCommandGeneration;
    try {
      const replacement = proof ?? this.messageReplacement;
      const result = await this.proc.sendCommand<T>(command, timeoutMs, message && replacement
        ? (_ok, id) => replacement.replied(proof ? command : origin ?? command, id)
        : undefined);
      if (message && isRecord(result) && result.agentInvoked === false) {
        this.confirmMessageCommandGeneration(generation);
        proof?.stop();
      } else if (proof) {
        void proof.handOff().then((outcome) => {
          if (!outcome.error || outcome.mayHaveBeenSent === false) this.confirmMessageCommandGeneration(generation);
        }).finally(proof.stop);
      }
      return result;
    } catch (error) {
      proof?.stop();
      if (message && error instanceof RpcCommandError) this.confirmMessageCommandGeneration(generation);
      throw error;
    } finally {
      if (message) this.pendingMessageCommands -= 1;
    }
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
    try {
      return await this.withPendingCommand(() => this.dispatchCommand(command));
    } finally {
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
      case "set_subagent_subscription":
        if (this.hostOwnedLifecycle) return null;
        return this.proc.sendCommand(command as { type: string; [key: string]: unknown });
      case "prompt": {
        // A `!!` shell command owns the session until it exits (omp rejects a
        // prompt then, and treating that as a hard error tore down the client's
        // optimistic turn and lost the message). Degrade into omp's own
        // follow-up queue instead: omp keeps owning the chips and delivers the
        // message once the shell command releases the session.
        if (this.bashRunning && !this.streaming) return await this.queueWhileShellRunning(command);
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
          const ack = await this.sendNativeMessageCommand<{ agentInvoked?: boolean } | undefined>({
            type: "prompt",
            message: command.message as string,
            ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
          }, PROMPT_ACK_TIMEOUT_MS, command);
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
          if (ack?.agentInvoked === false) return ack;
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
            await this.destroyAndWait("session-unresponsive", true);
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
        if (type === "steer" && this.bashRunning && !this.streaming) return await this.queueWhileShellRunning(command);
        await this.sendNativeMessageCommand({
          type,
          message: command.message as string,
          ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
        }, undefined, command);
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
        // A turn may be running: omp runs the command beside it and, as its
        // terminal does, records the result only when the next prompt starts.
        if (this.bashRunning) {
          throw new Error("A shell command is already running");
        }
        this.bashRunning = true;
        notifyRunningChange();
        try {
          // omp holds the result back while it streams; frames and the reply
          // share stdout, so `streaming` when the reply is read is omp's own
          // `isStreaming`. Read it then: an agent_end in the same batch is
          // applied before this await resumes.
          let deferred = this.streaming;
          const result = await this.proc.sendCommand<BashResultInfo>({ type: "bash", command: command.command as string }, undefined, () => { deferred = this.streaming; });
          return { ...result, deferred };
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
        if (this.hostOwnedLifecycle) {
          const previousNames = this.hostToolNames;
          this.hostToolNames = new Set(merged.map((t) => t.name as string));
          try {
            await this.proc.transport.setHostTools!(merged, [...this.hostUriSchemes].map(([scheme, { writable }]) => ({ scheme, writable: writable === true })));
          } catch (error) {
            this.hostToolNames = previousNames;
            throw error;
          }
          this.registeredHostTools = valid.filter((tool) => !AGENT_TOOL_NAMES.has(tool.name as string));
          this.hostToolsUnknown = false;
          return null;
        }
        // Applied as the successful reply is read, before a call in the same host-link batch is routed.
        await this.proc.sendCommand({ type: "set_host_tools", tools: merged }, undefined, (success) => {
          if (!success) return;
          this.hostToolNames = new Set(merged.map((t) => t.name as string));
          this.registeredHostTools = valid.filter((tool) => !AGENT_TOOL_NAMES.has(tool.name as string));
          // omp now knows exactly these: an adopted child's lost registration is replaced.
          this.hostToolsUnknown = false;
        });
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
        if (this.hostOwnedLifecycle) {
          const previous = this.hostUriSchemes;
          this.hostUriSchemes = new Map(schemes.filter((entry) => typeof entry.scheme === "string" && entry.scheme).map((entry) => [entry.scheme as string, { writable: entry.writable === true }]));
          try {
            const tools = this.registeredHostTools ?? [];
            const merged = loadWebServerSettings().agentToolsEnabled
              ? [...tools, ...AGENT_TOOL_DEFINITIONS.filter((tool) => !tools.some((entry) => entry.name === tool.name))]
              : tools;
            await this.proc.transport.setHostTools!(merged, [...this.hostUriSchemes].map(([scheme, { writable }]) => ({ scheme, writable: writable === true })));
          } catch (error) {
            this.hostUriSchemes = previous;
            throw error;
          }
          this.registeredHostUriSchemes = schemes;
          return null;
        }
        await this.proc.sendCommand({ type: "set_host_uri_schemes", schemes }, undefined, (success) => {
          if (!success) return;
          this.registeredHostUriSchemes = schemes;
          this.hostUriSchemes = new Map();
          for (const entry of schemes) {
            if (typeof entry.scheme === "string" && entry.scheme) {
              this.hostUriSchemes.set(entry.scheme, { writable: entry.writable === true });
            }
          }
        });
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
          const result: unknown = await this.sendNativeMessageCommand(
            command as { type: string },
            type === "predict_word" ? PREDICT_WORD_TIMEOUT_MS : undefined,
            command,
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
    await this.sendNativeMessageCommand({
      type: "follow_up",
      message: command.message as string,
      ...(images ? { images } : {}),
    }, undefined, command);
    return { queued: true, queue: "followUp", reason: "shellRunning" };
  }

  destroy(reason = "unspecified"): void {
    void this.destroyAndWait(reason);
  }

  /** Destroy and resolve only after the omp child has fully exited. Callers
   * that delete the session file afterwards must await this — omp flushes
   * session state on shutdown and would otherwise recreate the file. */
  async destroyAndWait(reason = "unspecified", stopShared = false): Promise<void> {
    // Re-entrant calls join the in-flight dispose; without this a new spawn
    // can overlap the old child's shutdown (see startRpcSession).
    if (this.destroyPromise) return untilHostDown(this.host, this.destroyPromise);
    if (!this._alive) return;
    console.info("[omp-web] session-dispose", JSON.stringify({ sessionId: this._sessionId, reason, running: this.isRunning(), pendingDialogs: this.pendingUiRequests.size, at: new Date().toISOString(), caller: new Error().stack?.split("\n").slice(2, 5).map((line) => line.trim()) }));
    this._alive = false;
    this.reportInterest();
    this.deliveredCallbacks.clear();
    this.emit({ type: "process_exit", reason });
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
    const disposed = this.proc.dispose(5_000, stopShared).catch(() => {}).then(() => this.onDestroyCallback?.());
    this.destroyPromise = disposed;
    for (const id of this.pendingHostTools.keys()) this.cancelPendingHostTool(id);
    for (const timer of this.parkedHostTools.values()) clearTimeout(timer);
    this.parkedHostTools.clear();
    this.hostToolNames.clear();
    this.registeredHostTools = null;
    this.pendingHostUris.clear();
    this.hostUriSchemes.clear();
    this.registeredHostUriSchemes = null;
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
  var __ompHostToolListeners: Set<(call: CrossSessionHostToolEvent) => void> | undefined;
  var __ompExitedSessions: Map<string, ExitedRpcSession> | undefined;
  var __ompFrameTaps: Set<(wrapper: AgentSessionWrapper, event: AgentEvent) => void> | undefined;
  var __ompSessionMoveListeners: Set<(from: string, to: string) => void> | undefined;
  var __ompNativeWrites: WeakSet<object> | undefined;
}

function nativeWrites(): WeakSet<object> {
  return (globalThis.__ompNativeWrites ??= new WeakSet());
}

/** True once some wrapper began writing this submitted command to omp's stdin; never before. */
export function nativeWriteStarted(command: object): boolean {
  return nativeWrites().has(command);
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
      // Every child runs under a host daemon: nothing more reaches it (no kill, no
      // host tool rejection as tabs close on the way out), and the next server adopts them.
      freezeHostLinks();
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

/** Every registry key of the wrapper under `sessionId` (its id and the aliases omp's moves left), else `[sessionId]`. */
export function getRpcSessionKeys(sessionId: string): string[] {
  const wrapper = getRegistry().get(sessionId);
  if (!wrapper) return [sessionId];
  return [...getRegistry()].flatMap(([key, live]) => (live === wrapper ? [key] : []));
}

export function getRunningRpcSessions(): RunningRpcSession[] {
  const map = new Map<string, RunningRpcSession>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) {
      const id = session.sessionId || sessionId;
      map.set(id, { id, cwd: session.cwd, ...(session.host.id === LOCAL_HOST_ID ? {} : { hostId: session.host.id }) });
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
  const sessions = [...new Set(getRegistry().values())].filter((session) => session.host.id === LOCAL_HOST_ID);
  await Promise.all(sessions.map((session) => session.destroyAndWait("runtime-update", true)));
  return sessions.length;
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive a `bun --hot` re-evaluation.
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

/** See every wrapper's frames after its listeners, without counting as a subscriber (the reapers ignore it):
 * server bookkeeping such as the message outbox's late hand-off. */
export function tapSessionFrames(tap: (wrapper: AgentSessionWrapper, event: AgentEvent) => void): () => void {
  const taps = (globalThis.__ompFrameTaps ??= new Set());
  taps.add(tap);
  return () => { taps.delete(tap); };
}

/** Confirmed ownership moves only, after registry aliases exist and before observers see the new identity. */
export function onSessionMove(listener: (from: string, to: string) => void): () => void {
  const listeners = (globalThis.__ompSessionMoveListeners ??= new Set());
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ----------------------------------------------------------------------------
// Cross-session host tool calls
//
// A registered host tool called while no tab watches its session goes to every
// open omp-web tab (over the `host-tools` event-stream channel) instead of being rejected.
// ----------------------------------------------------------------------------

function getHostToolListeners(): Set<(call: CrossSessionHostToolEvent) => void> {
  if (!globalThis.__ompHostToolListeners) globalThis.__ompHostToolListeners = new Set();
  return globalThis.__ompHostToolListeners;
}

/** Subscribe to host tool calls for sessions no tab is currently watching. */
export function subscribeHostToolCalls(listener: (call: CrossSessionHostToolEvent) => void): () => void {
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
    if (!session.hostOwnedLifecycle && session.sessionId && session.isRunning()) running.set(session.sessionId, { id: session.sessionId, advisor: session.advisorSpawned, hostId: session.host.id });
  }
  recordRunningSessions([...running.values()], (id) => registry.get(id)?.isAlive() === true);
}

/**
 * Restart the sessions that were mid-run when omp-web last stopped and ask
 * each to continue. Only runs when the auto-resume setting is on. Each session,
 * this machine's included, waits for its host's hello: a child its daemon still
 * runs is adopted there, and only a dead one resumes, after its orphan's exit.
 */
export async function resumeInterruptedSessions(): Promise<void> {
  resumeOnHostLink(takeInterruptedSessions(), resumeSession);
}

/** Start an interrupted session again on its host and ask it to continue. Never rejects. */
async function resumeSession({ id, advisor, hostId }: InterruptibleSession): Promise<void> {
  try {
    const host = getHost(hostId);
    if (hostOwnsLifecycle(hostId)) return;
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
      return sessions.map((s) => ({ id: s.id, name: s.name, cwd: s.cwd, running: running.has(s.id), hostId: s.hostId ?? LOCAL_HOST_ID }));
    },

    listHosts() {
      const local = getHost(LOCAL_HOST_ID);
      return [
        { id: local.id, label: local.label, online: isLinkUp(local.status()), allowAgentStart: true },
        ...listHosts().map((h) => ({ id: h.id, label: h.label, online: isLinkUp(h.status), allowAgentStart: h.allowAgentStart })),
      ];
    },

    async createSession(input) {
      const host = getHost(input.hostId);
      if (!host) throw new Error(`Unknown host: ${input.hostId}`);
      const preparing = !!(input.prompt || input.name || (input.provider && input.modelId));
      const started = await startNewRpcSession(host, input.cwd, undefined, undefined, preparing);
      if (!started.ok) throw new Error(started.error);
      const { session, realSessionId } = started.value;
      try {
        const run = async () => {
          if (input.provider && input.modelId) await session.send({ type: "set_model", provider: input.provider, modelId: input.modelId });
          if (input.name) await session.send({ type: "set_session_name", name: input.name });
          if (input.prompt) await session.send({ type: "prompt", message: input.prompt });
        };
        if (preparing) await session.withPendingCommand(run, true);
        else await run();
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
      let cold = false;
      if (!wrapper) {
        const host = await hostForSessionId(input.sessionId);
        const target = host && await sessionSpawnTarget(input.sessionId, host);
        if (!host || !target) throw new Error(`Session not found: ${input.sessionId}`);
        // The open's preparation lease keeps an idle shared child (and its advisor mode) until the message is sent.
        const started = await startRpcSession(input.sessionId, target.sessionFile, target.cwd, undefined, undefined, target.recordedCwd, undefined, host, true);
        wrapper = started.session;
        cold = true;
      }
      const target = wrapper;
      const send = async () => {
        const wasRunning = target.isRunning();
        if (input.delivery === "prompt" && wasRunning) {
          throw new Error("Target session is running; use delivery \"steer\" or \"followUp\" for a running target.");
        }
        if (input.delivery === "steer" && !wasRunning) {
          throw new Error("Target session is not running; use delivery \"prompt\" to start a turn.");
        }
        const terminalEndsNeeded = input.delivery === "followUp" && wasRunning ? 2 : 1;
        const waiter = input.wait ? target.waitForTurnEnd(input.waitTimeoutMs, terminalEndsNeeded) : null;
        await target.send({ type: input.delivery, message: input.message });
        return { waiter }; // Boxed: the lease ends at delivery, not at the turn's end.
      };
      const { waiter } = cold ? await wrapper.withPendingCommand(send, true) : await send();
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
 * host answers with the path it will use. Registers this machine's cwd with
 * its file routes, and refreshes the host's session list.
 */
export async function startNewRpcSession(
  host: Host,
  cwd: string,
  toolNames?: string[],
  advisor?: boolean,
  preparingCommand = false,
): Promise<OpResult<{ session: AgentSessionWrapper; realSessionId: string }>> {
  const validated = await host.sessionOps.validateCwd(cwd);
  if (!validated.ok) return validated;
  const spawnCwd = validated.value.cwd;
  // Unique per call: startRpcSession coalesces concurrent callers that share a key onto one session.
  const tempKey = `__new__${randomUUID()}`;
  const started = await startRpcSession(tempKey, "", spawnCwd, toolNames, advisor, undefined, undefined, host, preparingCommand);
  // Without this a file request under a brand-new cwd would 403 for up to the allowed-roots cache TTL.
  // Never for another host: its paths do not exist on this machine.
  if (host.id === LOCAL_HOST_ID) allowFileRoot(spawnCwd);
  invalidateHostSessionList(host.id);
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
  host: Host = getHost(LOCAL_HOST_ID),
  preparingCommand = false,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const registry = getRegistry();
  const locks = getLocks();
  const launch: SpawnRequest = { cwd, recordedCwd: recordedCwd ?? null, sessionFile, toolNames, advisor: advisor === true, spawnModel };
  let replacement: SpawnResult | undefined;

  // A child of this session the host still ran from before a restart of this
  // server is being adopted or killed. Waiting here, before the registry and
  // the lock, lets a start join an adopted child; a killed one must exit first:
  // two children must never write one session file. A live wrapper is past that.
  if (sessionFile && !registry.get(sessionId)?.isAlive()) await orphanExit(host.id, sessionId);

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
    // advisor opinion (undefined) simply reuse whatever is running. Only a legacy
    // adopted child's flag is unknown; shared channels report their actual launch mode.
    if (advisor === undefined || (existing.adopted && !existing.hostOwnedLifecycle) || existing.advisorSpawned === effectiveAdvisor
      || existing.isRunning() || existing.isEditingHistory() || (existing.hostOwnedLifecycle && !existing.canReplaceAdvisor())) {
      return { session: existing, realSessionId: sessionId };
    }
    if (existing.hostOwnedLifecycle) {
      replacement = await existing.replaceAdvisorIfIdle(launch, preparingCommand) ?? undefined;
      if (!replacement) return { session: existing, realSessionId: sessionId };
    } else {
      await existing.destroyAndWait("advisor", true);
    }
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
        notifyRunningChange({ refreshSessionList: true });
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
    const spawned = replacement ?? await host.spawnRpc(launch, sessionFile ? sessionId : null, { replaceAdvisor: advisor !== undefined, preparing: preparingCommand });
    const proc = new RpcProcess({
      cwd: spawned.cwd,
      transport: spawned.transport,
      ...(spawned.transport.hostOwnedLifecycle ? { adopted: { protocolVersion: 2 as const } } : {}),
      onExit: (info) => holder.wrapper?.handleProcessExit(info, proc),
    });
    const created = new AgentSessionWrapper(
      proc,
      spawned.cwd,
      recordedCwd,
      spawned.transport.hostOwnedLifecycle ? spawned.advisorSpawned! : advisor === true || spawned.launchAdvisor,
      sessionFile ? sessionId : "",
      DISCONNECT_DESTROY_MS,
      host,
      spawned.launchAdvisor,
      spawned.fellBack,
    );
    holder.wrapper = created;
    created.start();
    try {
      if (spawned.transport.hostOwnedLifecycle) {
        await created.adopt([...(spawned.pending ?? []), ...(spawned.streaming ? [spawned.streaming] : [])], spawned.joined !== false);
      } else {
        await created.waitUntilReady();
      }
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
      if (!created.hostOwnedLifecycle && loadWebServerSettings().agentToolsEnabled) {
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
    // omp can move a resumed session during startup, before identity is known; keep the requested id routable.
    if (sessionFile && realSessionId !== sessionId) {
      registry.set(sessionId, created);
      created.keepMovedFromId(sessionId);
      for (const listener of globalThis.__ompSessionMoveListeners ?? []) listener(sessionId, realSessionId);
    }
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
    notifyRunningChange({ refreshSessionList: true });
  });
  created.onIdentityChange((oldId, newId, options) => {
    // A move keeps the old ids routable; a branch/new/switch serves another conversation, so every old key goes.
    if (!options?.keepOldId) for (const [key, wrapper] of registry) if (wrapper === created) registry.delete(key);
    registry.set(newId, created);
    if (options?.keepOldId) for (const listener of globalThis.__ompSessionMoveListeners ?? []) listener(oldId, newId);
    notifyRunningChange({ refreshSessionList: true });
  });
  registry.set(created.sessionId, created);
  notifyRunningChange({ refreshSessionList: true });
}

/**
 * Take over an omp child that outlived the server that spawned it (its host
 * listed it in `hello`): no spawn and no ready wait. `replay` holds the host's
 * raw stdout lines of the child's still-open blocking requests. Rejects, with
 * the child being killed, when this server already starts or keeps a wrapper
 * for the session (never two children on one file) or when the re-sync fails.
 */
export async function adoptRpcSession({ host, transport, sessionId, cwd, replay, advisorSpawned, launchAdvisor }: {
  host: Host;
  transport: RpcTransport;
  sessionId: string;
  cwd: string;
  replay: string[];
  advisorSpawned?: boolean;
  launchAdvisor?: boolean;
}): Promise<AgentSessionWrapper> {
  if (transport.hostOwnedLifecycle && typeof advisorSpawned !== "boolean") {
    transport.close!();
    throw new Error("The shared host did not report the child's actual advisor mode");
  }
  const registry = getRegistry();
  const locks = getLocks();
  if (locks.has(sessionId) || registry.has(sessionId)) {
    if (transport.hostOwnedLifecycle) transport.close?.();
    else transport.killTree(false);
    throw new Error(`Session ${sessionId} is already started on this server`);
  }
  const holder: { wrapper?: AgentSessionWrapper } = {};
  const proc = new RpcProcess({ cwd, transport, adopted: { protocolVersion: 2 }, onExit: (info) => holder.wrapper?.handleProcessExit(info, proc) });
  // Legacy adoption cannot recover spawn-time flags; a shared daemon returns the actual launch metadata.
  const created = new AgentSessionWrapper(proc, cwd, cwd, advisorSpawned ?? false, sessionId, DISCONNECT_DESTROY_MS, host, launchAdvisor ?? false);
  holder.wrapper = created;
  created.start();
  const adopting = (async () => {
    try {
      await created.adopt(replay);
      // The host names a child by the session it last reported; one that has since moved
      // to a session this server already runs would be its second writer.
      if (created.sessionId !== sessionId && (locks.has(created.sessionId) || registry.has(created.sessionId))) {
        throw new Error(`Session ${created.sessionId} is already started on this server`);
      }
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
