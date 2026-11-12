import type { spawn } from "child_process";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { isRecord } from "../type-guards";
import { resolveOmpBin } from "./omp-cli";
import { type RpcTransport, spawnLocalRpcTransport } from "./rpc-transport";
import { LINK_LIMITS } from "../hosts/link-protocol";

/**
 * Process + protocol layer for ompweb's omp (`ompweb-omp --headless`), which speaks the channel of
 * runner/src/channel.ts as NDJSON over stdio. This layer translates at the boundary so the rest of
 * ompweb keeps RPC's frame shapes:
 *
 *   hello                          → readiness (`waitReady` resolves `{type:"ready", ...hello}`)
 *   event {event}                  → the event object itself
 *   res {id, ok, data?, error?}    → settles `sendCommand`
 *   ui_request {id, method, args}  → `extension_ui_request` (formDialog → method "form" with `html`)
 *   ui_end {id}                    → `extension_ui_request` method "cancel", targetId
 *   ui {method, ...}               → `extension_ui_request` (notify, setStatus, setWidget, custom, …)
 *   {t, ...rest}                   → `{type: t, ...rest}`
 *
 * and back: `sendCommand({type, ...args})` → `cmd {id, op: type, args}`, `extension_ui_response`
 * → `ui_response {id, value}` (the omp method's return value), `extension_ui_input` → `ui_input`,
 * any other `{type, ...rest}` → `{t: type, ...rest}`.
 */

export type RpcFrame = { type: string; [key: string]: unknown };

export class RpcCommandError extends Error {
  readonly command: string;
  readonly code?: string;

  constructor(command: string, message: string, code?: string) {
    super(message);
    this.name = "RpcCommandError";
    this.command = command;
    this.code = code;
  }
}
export class RpcCommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;
  /** When the command went to the transport (or its wait started); a timer fires timeoutMs later. */
  readonly dispatchedAt: number;

  constructor(command: string, timeoutMs: number, message?: string, dispatchedAt = Date.now() - timeoutMs) {
    super(message ?? `RPC command ${command} timed out after ${timeoutMs}ms`);
    this.name = "RpcCommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.dispatchedAt = dispatchedAt;
  }
}

interface PendingCommand {
  command: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  onReply?: (success: boolean, id: string) => void;
}

/** An open omp dialog: the `ExtensionUIContext` method and its positional arguments. */
interface OpenDialog {
  method: string;
  args: unknown[];
}

export interface RpcProcessOptions {
  /** Working directory for the agent (also passed as --cwd). */
  cwd: string;
  /** Extra CLI args appended after the base `--headless --cwd <cwd>`. */
  extraArgs?: string[];
  /** Environment overrides merged over process.env. */
  env?: Record<string, string>;
  /** Called for every non-response frame (events, extension UI, subagent frames). */
  onFrame?: (frame: RpcFrame) => void;
  /** Called once when the child exits, after pending commands are rejected. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
  /** Byte transport to run over. Omitted → spawn ompweb's omp (see spawnLocalRpcTransport). */
  transport?: RpcTransport;
  /** The daemon already saw this child's hello, or it outlived its server: ready at once,
   * and frames are held until `release` (after `replay`). */
  adopted?: true;
  /** Injectable process boundary for deterministic transport tests. */
  dependencies?: {
    resolveOmpBin?: typeof resolveOmpBin;
    spawn?: typeof spawn;
  };
}

const STDERR_TAIL_LIMIT = 8 * 1024;
/**
 * Largest line omp-web writes to omp's stdin. Command bodies are already capped at 8 MiB by the
 * agent routes (`MAX_AGENT_COMMAND_REQUEST_BYTES`); this bound only turns a pathological command
 * into a clear error instead of an unbounded pipe write.
 */
const MAX_INBOUND_LINE_BYTES = 32 * 1024 * 1024;
/** Frames whose numeric `id` names the cmd they belong to; ompweb correlates them with `onReply`'s string id. */
const COMMAND_ID_FRAMES = new Set(["prompt_result", "prompt_error", "bash_output"]);

/** A stdout line as JSON; undefined when blank or not JSON (never let a stray line kill the reader). */
function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

const REQUEST_TYPES = new Set(["host_tool_call", "host_uri_request", "extension_ui_request"]);
const requestId = (frame: RpcFrame) => (REQUEST_TYPES.has(frame.type) && typeof frame.id === "string" ? frame.id : null);

const recordOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const stringsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** `timeout` of the `ExtensionUIDialogOptions` argument, when set. */
function timeoutOf(options: unknown): { timeout?: number } {
  const { timeout } = recordOf(options);
  return typeof timeout === "number" ? { timeout } : {};
}

/** Labels of an approval prompt as omp's select fallback lists them (tools/approval.ts `approvalChoiceLabels`). */
function approvalLabels(prompt: Record<string, unknown>): string[] {
  const grants = stringsOf(prompt.grants).map(recordOf);
  return [
    ...grants.map((grant) => String(grant.label)),
    ...grants.map((grant) => String(grant.alwaysLabel)),
    grants.length > 0 ? "Approve Once" : "Approve",
    ...(typeof prompt.session === "string" ? [prompt.session] : []),
    "Deny",
  ];
}

/** The approval a label from `approvalLabels` stands for (tools/approval.ts `approvalAnswerForChoice`). */
function approvalAnswer(prompt: Record<string, unknown>, choice: unknown): unknown {
  const grants = stringsOf(prompt.grants).map(recordOf);
  if (choice === (grants.length > 0 ? "Approve Once" : "Approve")) return "once";
  if (typeof prompt.session === "string" && choice === prompt.session) return "session";
  for (const grant of grants) {
    if (choice === grant.label) return { grant: grant.scope, always: false };
    if (choice === grant.alwaysLabel) return { grant: grant.scope, always: true };
  }
  return "deny";
}

/** omp's `ExtensionAskDialogSubmitResult` for the browser's `answers` (one per question, by id); unknown labels drop. */
function askResult(questions: unknown, answers: unknown): unknown {
  if (!Array.isArray(answers)) return undefined;
  return {
    kind: "submit",
    results: stringsOf(questions).map(recordOf).map((question) => {
      const answer = recordOf(answers.find((entry) => isRecord(entry) && entry.id === question.id));
      const labels = stringsOf(question.options).map((option) => recordOf(option).label);
      const custom = typeof answer.customInput === "string" ? answer.customInput.trim() : "";
      return {
        id: question.id,
        question: question.question,
        options: labels,
        multi: question.multi === true,
        selectedOptions: stringsOf(answer.selectedOptions).filter((label) => typeof label === "string" && labels.includes(label)),
        ...(custom ? { customInput: custom } : {}),
      };
    }),
  };
}

/** ompweb's `extension_ui_request` for an omp dialog; null for a method the browser cannot show. */
function dialogRequest(id: string, { method, args }: OpenDialog): RpcFrame | null {
  const base = { type: "extension_ui_request", id };
  switch (method) {
    case "select":
      return { ...base, method, title: args[0], options: stringsOf(args[1]).map((option) => (typeof option === "string" ? option : recordOf(option).label)), ...timeoutOf(args[2]) };
    case "confirm":
      return { ...base, method, title: args[0], message: args[1], ...timeoutOf(args[2]) };
    case "input":
      return { ...base, method, title: args[0], placeholder: args[1], ...(recordOf(args[2]).secret === true ? { secret: true } : {}), ...timeoutOf(args[2]) };
    case "editor":
      return { ...base, method, title: args[0], prefill: args[1], ...(recordOf(args[3]).promptStyle === true ? { promptStyle: true } : {}), ...timeoutOf(args[2]) };
    case "askDialog":
      return { ...base, method: "ask", questions: args[0], ...timeoutOf(args[1]) };
    case "formDialog":
      return { ...base, method: "form", html: args[0], ...timeoutOf(args[1]) };
    case "approve": {
      const prompt = recordOf(args[0]);
      return { ...base, method: "select", title: prompt.full, options: approvalLabels(prompt), ...timeoutOf(args[1]) };
    }
    default:
      return null;
  }
}

/**
 * The omp method's return value for the browser's `extension_ui_response`; null sends nothing.
 * A browser-side timeout sends nothing: omp runs the dialog's own timeout and then ends it.
 */
function dialogValue({ method, args }: OpenDialog, response: Record<string, unknown>): { value: unknown } | null {
  if (response.cancelled === true) {
    if (response.timedOut === true) return null;
    return { value: method === "confirm" ? false : method === "approve" ? "deny" : undefined };
  }
  switch (method) {
    case "confirm":
      return { value: response.confirmed === true };
    case "approve":
      return { value: approvalAnswer(recordOf(args[0]), response.value) };
    case "askDialog":
      return { value: askResult(args[0], response.answers) };
    case "formDialog":
      return { value: isRecord(response.data) ? { data: response.data } : undefined };
    default:
      return { value: typeof response.value === "string" ? response.value : undefined };
  }
}

/** Spawns ompweb's omp headless with the sanitized child environment. */
export function spawnOmpTransport(options: RpcProcessOptions): RpcTransport {
  const resolveBin = options.dependencies?.resolveOmpBin ?? resolveOmpBin;
  const bin = resolveBin();
  if (!bin) {
    throw new Error("ompweb's omp binary (ompweb-omp) not found. Reinstall ompweb or set OMP_WEB_OMP_BIN.");
  }
  const args = ["--headless", "--cwd", options.cwd, ...(options.extraArgs ?? [])];
  // omp-web ignores named profiles (OMP_PROFILE/PI_PROFILE): strip them so the
  // child resolves the same default agent dir. An explicit options.env entry
  // still wins (used to force the default profile for isolated test runs).
  const env = sanitizeProjectCommandEnvironment({ ...process.env, ...options.env });
  if (options.env?.OMP_PROFILE === undefined) delete env.OMP_PROFILE;
  if (options.env?.PI_PROFILE === undefined) delete env.PI_PROFILE;
  return spawnLocalRpcTransport({ bin, args, cwd: options.cwd, env, spawn: options.dependencies?.spawn });
}

export class RpcProcess {
  readonly cwd: string;
  /** Read by the session wrapper for host-specific signals (a remote link's resync and lost child). */
  readonly transport: RpcTransport;
  private readonly exitedPromise: Promise<void>;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly frameListeners = new Set<(frame: RpcFrame) => void>();
  private readyPromise: Promise<RpcFrame>;
  private readonly resolveReady: (frame: RpcFrame) => void;
  /** omp's open dialogs by ompweb request id (the wire id as a string), until answered or ended. */
  private readonly dialogs = new Map<string, OpenDialog>();
  /** An adopted child's frames, held until `release` (see RpcProcessOptions.adopted), and the bytes of its lines since. */
  private heldFrames: RpcFrame[] | null = null;
  private heldBytes = 0;
  /** Set once an adopted child's output outgrew the cap before `release`: the adoption fails. */
  private heldOverflow: Error | null = null;
  /** Ids of the requests `replay` delivered (see `release`). */
  private readonly replayedRequests = new Set<string>();
  // The daemon maps each link's ids onto its own, so a plain counter cannot meet another server's.
  private nextId = 1;
  private nextUiId = 1;
  private stderrTail = "";
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  // Lines are written one at a time so two of them cannot interleave on the pipe.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RpcProcessOptions) {
    this.transport = options.transport ?? spawnOmpTransport(options);
    this.cwd = options.cwd;
    if (options.onFrame) this.frameListeners.add(options.onFrame);

    const ready = Promise.withResolvers<RpcFrame>();
    this.readyPromise = ready.promise;
    this.resolveReady = ready.resolve;
    // waitReady() is optional for callers; avoid unhandled-rejection noise when
    // the process dies before anyone awaited readiness.
    this.readyPromise.catch(() => {});
    const exitDeferred = Promise.withResolvers<void>();
    this.exitedPromise = exitDeferred.promise;
    if (options.adopted) {
      // Its hello went to the daemon or the server that spawned it.
      this.heldFrames = [];
      ready.resolve({ type: "ready", supportsBashExcludeFromContext: true });
    }

    this.transport.onLine((line) => {
      if (this.heldFrames && !this.holdable(line)) return;
      const parsed = parseLine(line);
      if (parsed !== undefined) this.receive(parsed);
    });

    this.transport.onStderr((chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    this.transport.onExit((code, signal) => {
      if (this.exited) return;
      this.exited = true;
      this.exitInfo = { code, signal };
      const exitError = new Error(
        `omp exited (code ${code ?? "null"}, signal ${signal ?? "none"})${this.stderrTail ? `: ${this.stderrTail.slice(-500)}` : ""}`,
      );
      ready.reject(exitError);
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(exitError);
      }
      this.pending.clear();
      exitDeferred.resolve();
      options.onExit?.({ code, signal, stderrTail: this.stderrTail });
    });
  }

  get isAlive(): boolean {
    return !this.exited;
  }

  get exitDetails(): { code: number | null; signal: NodeJS.Signals | null; stderrTail: string } | null {
    return this.exitInfo ? { ...this.exitInfo, stderrTail: this.stderrTail } : null;
  }

  /** Resolves with `{type:"ready", ...hello}`; rejects if the process dies first or the
   * timeout elapses. omp startup can take a few seconds (extensions, LSP). */
  waitReady(timeoutMs = 60_000): Promise<RpcFrame> {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`omp ready timeout after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
      this.readyPromise.finally(() => clearTimeout(timer)).catch(() => {});
    });
    return Promise.race([this.readyPromise, timeout]);
  }

  onFrame(listener: (frame: RpcFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Adopted child: feeds the daemon's raw lines of its still-open requests as
   * if just read. They are older than anything held, which `release` delivers next. */
  replay(lines: string[]): void {
    if (this.heldOverflow) throw this.heldOverflow;
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed !== undefined) this.receive(parsed, true);
    }
  }

  /** Adopted child, after `replay`: delivers the frames held since and stops holding. A request
   * opened while the old server stopped is in both (replayed, and resent unacked): it is delivered once. */
  release(): void {
    if (this.heldOverflow) throw this.heldOverflow;
    const held = this.heldFrames ?? [];
    this.heldFrames = null;
    for (const frame of held) {
      const id = requestId(frame);
      if (id === null || !this.replayedRequests.has(id)) this.dispatch(frame);
    }
    this.replayedRequests.clear();
  }

  /**
   * Counts an adopted child's output until `release`, up to LINK_LIMITS.channelBufferBytes
   * as RemoteRpcTransport holds it. Past that the adoption fails: its commands
   * reject, `replay` and `release` throw, and the output is dropped while the wrapper kills it.
   */
  private holdable(line: string): boolean {
    if (this.heldOverflow) return false;
    this.heldBytes += Buffer.byteLength(line);
    if (this.heldBytes <= LINK_LIMITS.channelBufferBytes) return true;
    const overflow = new Error(`omp's output during adoption exceeded ${LINK_LIMITS.channelBufferBytes} bytes`);
    this.heldOverflow = overflow;
    this.heldFrames = [];
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(overflow);
    }
    this.pending.clear();
    return false;
  }

  /** One channel frame from omp. `replayed`: a daemon line (see `replay`), delivered past the frames still held. */
  private receive(parsed: unknown, replayed = false): void {
    if (!isRecord(parsed) || typeof parsed.t !== "string") return;
    const { t, ...rest } = parsed;
    switch (t) {
      case "hello":
        this.resolveReady({ type: "ready", ...rest, supportsBashExcludeFromContext: true });
        return;
      case "res":
        this.handleResponse(rest);
        return;
      case "event":
        if (isRecord(rest.event) && typeof rest.event.type === "string") this.dispatch(rest.event as RpcFrame, replayed);
        return;
      case "ui_request": {
        if (typeof rest.id !== "number" || typeof rest.method !== "string") return;
        const id = String(rest.id);
        const dialog = { method: rest.method, args: stringsOf(rest.args) };
        const frame = dialogRequest(id, dialog);
        if (!frame) {
          // Nothing here can answer it: cancel instead of leaving omp waiting.
          this.writeFrame({ t: "ui_response", id: rest.id }, () => {});
          return;
        }
        this.dialogs.set(id, dialog);
        this.dispatch(frame, replayed);
        return;
      }
      case "ui_end": {
        if (typeof rest.id !== "number") return;
        const targetId = String(rest.id);
        this.dialogs.delete(targetId);
        this.dispatch({ type: "extension_ui_request", id: `${targetId}:end`, method: "cancel", targetId }, replayed);
        return;
      }
      case "ui":
        this.dispatch({ ...rest, type: "extension_ui_request", id: rest.id === undefined ? `ui:${this.nextUiId++}` : String(rest.id) }, replayed);
        return;
      default:
        this.dispatch({ type: t, ...rest, ...(COMMAND_ID_FRAMES.has(t) && typeof rest.id === "number" ? { id: String(rest.id) } : {}) }, replayed);
    }
  }

  private dispatch(frame: RpcFrame, replayed = false): void {
    if (this.heldFrames && !replayed) {
      this.heldFrames.push(frame);
      return;
    }
    const id = replayed ? requestId(frame) : null;
    if (id !== null) this.replayedRequests.add(id);
    for (const listener of this.frameListeners) {
      try {
        listener(frame);
      } catch {
        // Listener bugs must not break the protocol reader.
      }
    }
  }

  /** Send a command and await its response `data`. A failed response rejects
   * with RpcCommandError. No timeout by default — some commands (login,
   * long prompts via bash) legitimately take minutes, and the session wrapper
   * reclaims wedged children via idle-kill and dispose(). Callers that want a
   * cap pass `timeoutMs` (>0); when set, the timer is unref'd so it never
   * keeps the event loop alive on its own. `onReply` runs synchronously when
   * the response is read, before any frame after it is dispatched; it is told whether the command succeeded and its
   * wire id as a string (what `prompt_result`, `prompt_error` and `bash_output` name). */
  sendCommand<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number, onReply?: (success: boolean, id: string) => void): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error("omp process has exited"));
    }
    if (this.heldOverflow) return Promise.reject(this.heldOverflow);
    const dispatchedAt = Date.now();
    const id = this.nextId++;
    const { type: op, ...args } = command;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCommand = {
        command: op,
        resolve: resolve as (data: unknown) => void,
        reject,
        onReply,
      };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          // Only reject if this exact entry is still pending — a response that
          // landed between the timer firing and this callback must not
          // spuriously reject.
          if (this.pending.get(id) === entry) {
            this.pending.delete(id);
            reject(new RpcCommandTimeoutError(op, timeoutMs, undefined, dispatchedAt));
          }
        }, timeoutMs);
        // A pending command timer must never keep the event loop alive on its own
        // (it would block graceful shutdown when omp has stopped answering).
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.writeFrame({ t: "cmd", id, op, args }, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            reject(error);
          }
        }
      });
    });
  }

  /** Fire-and-forget frame in ompweb's shape (extension_ui_response, host_tool_result, login_input_response, …). */
  sendFrame(frame: { type: string; [key: string]: unknown }): void {
    if (this.exited) return;
    const { type, ...rest } = frame;
    if (type === "extension_ui_response") {
      const id = String(rest.id);
      const dialog = this.dialogs.get(id);
      const answer = dialog && dialogValue(dialog, rest);
      if (!answer) return;
      this.dialogs.delete(id);
      this.writeFrame({ t: "ui_response", id: Number(id), ...answer }, () => {});
      return;
    }
    if (type === "extension_ui_input") {
      this.writeFrame({ t: "ui_input", id: Number(rest.id), data: rest.data }, () => {});
      return;
    }
    this.writeFrame({ t: type, ...rest }, () => {});
  }

  private writeFrame(frame: { t: string; [key: string]: unknown }, callback: (error?: Error | null) => void): void {
    const line = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_INBOUND_LINE_BYTES) {
      callback(new Error(`omp command exceeds the ${MAX_INBOUND_LINE_BYTES}-byte inbound transport limit`));
      return;
    }
    // Serialized so two lines never interleave on the pipe and a failed write
    // cannot reorder the responses callers are awaiting.
    this.writeQueue = this.writeQueue.then(
      () => new Promise<void>((resolve) => {
        if (this.exited) {
          callback(new Error("omp process is not running"));
          resolve();
          return;
        }
        this.transport.write(line, (error) => {
          callback(error ?? null);
          resolve();
        });
      }),
    );
  }

  /** A `res`; one for no pending command (timed out, or another server's) is dropped. */
  private handleResponse(response: Record<string, unknown>): void {
    const id = response.id;
    const entry = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!entry || typeof id !== "number") return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.onReply?.(response.ok === true, String(id));
    if (response.ok === true) {
      entry.resolve(response.data);
    } else {
      entry.reject(new RpcCommandError(entry.command, typeof response.error === "string" ? response.error : "omp command failed", typeof response.code === "string" ? response.code : undefined));
    }
  }

  /** Close shared membership unless explicitly stopping the child. Local shutdown
   * closes stdin, escalates to SIGTERM/SIGKILL and waits for actual exit. */
  async dispose(gracePeriodMs = 5_000, stopShared = false): Promise<void> {
    if (this.exited) return;
    if (this.transport.hostOwnedLifecycle) {
      if (!stopShared) {
        this.transport.close!();
        return;
      }
      this.transport.killTree(false);
    } else {
      this.transport.endInput();
    }
    const timer = setTimeout(() => {
      if (!this.exited) this.transport.killTree(false);
    }, gracePeriodMs);
    const killTimer = setTimeout(() => {
      if (!this.exited) this.transport.killTree(true);
    }, gracePeriodMs * 2);
    timer.unref?.();
    killTimer.unref?.();
    await this.exitedPromise;
    clearTimeout(timer);
    clearTimeout(killTimer);
  }
}
