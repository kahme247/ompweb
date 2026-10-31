import type { spawn } from "child_process";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { resolveOmpBin } from "./omp-cli";
import { type RpcTransport, spawnLocalRpcTransport } from "./rpc-transport";
import { encodeRpcCommand, RpcFrameDecoder, type RpcFrameRecord, type RpcProtocolVersion } from "./rpc-frame";

/**
 * Process + protocol layer for `omp --mode rpc-ui` (NDJSON over stdio).
 * Protocol v1: commands `{id, type, ...}` on stdin; `{type:"response", id, ...}`
 * plus interleaved event frames on stdout. omp announces readiness with a
 * `{type:"ready"}` frame before accepting commands. When readiness advertises
 * protocol v2, callers negotiate it before sending normal commands and omp's
 * oversized outbound frames arrive as bounded `rpc_chunk` sequences, which the
 * decoder below reassembles. Commands written to stdin stay single unchunked
 * JSONL objects — see `encodeRpcCommand` (issue #105).
 */

export interface RpcResponseFrame {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
}

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
}

export interface RpcProcessOptions {
  /** Working directory for the agent (also passed as --cwd). */
  cwd: string;
  /** Extra CLI args appended after the base `--mode rpc-ui --cwd <cwd>`. */
  extraArgs?: string[];
  /** Environment overrides merged over process.env. */
  env?: Record<string, string>;
  /** Called for every non-response frame (events, extension UI, subagent frames). */
  onFrame?: (frame: RpcFrame) => void;
  /** Called once when the child exits, after pending commands are rejected. */
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }) => void;
  /** Byte transport to run over. Omitted → spawn the installed omp (see spawnLocalRpcTransport). */
  transport?: RpcTransport;
  /** Injectable process boundary for deterministic transport tests. */
  dependencies?: {
    resolveOmpBin?: typeof resolveOmpBin;
    spawn?: typeof spawn;
  };
}

const STDERR_TAIL_LIMIT = 8 * 1024;

/** Spawns the installed omp in RPC mode with the sanitized child environment. */
export function spawnOmpTransport(options: RpcProcessOptions): RpcTransport {
  const resolveBin = options.dependencies?.resolveOmpBin ?? resolveOmpBin;
  const bin = resolveBin();
  if (!bin) {
    throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  }
  const args = ["--mode", "rpc-ui", "--cwd", options.cwd, ...(options.extraArgs ?? [])];
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
  private readonly pending = new Map<string, PendingCommand>();
  private readonly frameListeners = new Set<(frame: RpcFrame) => void>();
  private readyPromise: Promise<RpcFrame>;
  private nextId = 1;
  private stderrTail = "";
  private exited = false;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private protocolVersion: RpcProtocolVersion = 1;
  // Commands are written to stdin one logical frame at a time (never chunked,
  // however large) so two of them cannot interleave on the pipe.
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RpcProcessOptions) {
    this.transport = options.transport ?? spawnOmpTransport(options);
    this.cwd = options.cwd;
    if (options.onFrame) this.frameListeners.add(options.onFrame);

    let resolveReady: (frame: RpcFrame) => void;
    let rejectReady: (error: Error) => void;
    this.readyPromise = new Promise<RpcFrame>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // waitReady() is optional for callers; avoid unhandled-rejection noise when
    // the process dies before anyone awaited readiness.
    this.readyPromise.catch(() => {});
    const exitDeferred = Promise.withResolvers<void>();
    this.exitedPromise = exitDeferred.promise;

    const decoder = new RpcFrameDecoder();
    this.transport.onLine((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // omp guards stdout in RPC mode, but never let a stray line kill the reader.
        return;
      }
      let frame: RpcFrameRecord;
      try {
        if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "rpc_chunk" && this.protocolVersion !== 2) {
          throw new Error("RPC chunk received before protocol negotiation");
        }
        const decoded = decoder.push(parsed);
        if (!decoded) return;
        frame = decoded;
      } catch (error) {
        this.stderrTail = (this.stderrTail + `\nRPC protocol error: ${error instanceof Error ? error.message : String(error)}`).slice(-STDERR_TAIL_LIMIT);
        console.warn("[omp-web] rpc-protocol-dispose", JSON.stringify({ transport: this.transport.id, protocolVersion: this.protocolVersion, errorType: error instanceof Error ? error.name : typeof error, at: new Date().toISOString() }));
        void this.dispose(0);
        return;
      }
      if (frame.type === "ready") {
        resolveReady(frame);
        return;
      }
      if (frame.type === "response") {
        this.handleResponse(frame as unknown as RpcResponseFrame);
        return;
      }
      for (const listener of this.frameListeners) {
        try {
          listener(frame);
        } catch {
          // Listener bugs must not break the protocol reader.
        }
      }
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
      rejectReady(exitError);
      for (const [, entry] of this.pending) {
        if (entry.timer) clearTimeout(entry.timer);
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

  /** Resolves with the `ready` frame; rejects if the process dies first or the
   * timeout elapses. omp startup can take a few seconds (extensions, LSP). */
  waitReady(timeoutMs = 60_000): Promise<RpcFrame> {
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`omp RPC ready timeout after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
      this.readyPromise.finally(() => clearTimeout(timer)).catch(() => {});
    });
    return Promise.race([this.readyPromise, timeout]);
  }

  /** Enables bounded protocol-v2 framing when the ready frame advertises it. */
  async negotiateProtocol(ready: RpcFrame): Promise<RpcProtocolVersion> {
    const supported = Array.isArray(ready.supportedProtocolVersions) ? ready.supportedProtocolVersions : [];
    if (!supported.includes(2)) return this.protocolVersion;
    const response = await this.sendCommand<{ protocolVersion?: unknown }>({ type: "negotiate_protocol", protocolVersion: 2 });
    if (response?.protocolVersion !== 2) throw new Error("OMP rejected RPC protocol v2 negotiation");
    this.protocolVersion = 2;
    return this.protocolVersion;
  }

  onFrame(listener: (frame: RpcFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Send a command and await its response `data`. A failed response rejects
   * with RpcCommandError. No timeout by default — some commands (login,
   * long prompts via bash) legitimately take minutes, and the session wrapper
   * reclaims wedged children via idle-kill and dispose(). Callers that want a
   * cap pass `timeoutMs` (>0); when set, the timer is unref'd so it never
   * keeps the event loop alive on its own. */
  sendCommand<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error("omp RPC process has exited"));
    }
    const dispatchedAt = Date.now();
    const id = `w${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCommand = {
        command: command.type,
        resolve: resolve as (data: unknown) => void,
        reject,
      };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          // Only reject if this exact entry is still pending — a reused id or a
          // response that landed between the timer firing and this callback must
          // not spuriously reject a different command.
          if (this.pending.get(id) === entry) {
            this.pending.delete(id);
            reject(new RpcCommandTimeoutError(command.type, timeoutMs, undefined, dispatchedAt));
          }
        }, timeoutMs);
        // A pending command timer must never keep the event loop alive on its own
        // (it would block graceful shutdown when omp has stopped answering).
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.writeFrame({ ...command, id }, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            if (pending.timer) clearTimeout(pending.timer);
            reject(error);
          }
        }
      });
    });
  }

  /** Fire-and-forget frame write (extension_ui_response, host_tool_result). */
  sendFrame(frame: { type: string; [key: string]: unknown }): void {
    if (this.exited) return;
    this.writeFrame(frame, () => {});
  }

  private writeFrame(frame: RpcFrame, callback: (error?: Error | null) => void): void {
    let line: string;
    try {
      line = encodeRpcCommand(frame);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // Commands are serialized so two of them never interleave on the pipe and a
    // failed write cannot reorder the responses callers are awaiting.
    this.writeQueue = this.writeQueue.then(
      () => new Promise<void>((resolve) => {
        if (this.exited) {
          callback(new Error("RPC process is not running"));
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

  private handleResponse(response: RpcResponseFrame): void {
    const id = response.id;
    const entry = id ? this.pending.get(id) : undefined;
    if (!entry || !id) {
      // Unsolicited response (or a command we already timed out) — surface to
      // frame listeners so nothing is silently dropped.
      for (const listener of this.frameListeners) {
        try {
          listener(response as unknown as RpcFrame);
        } catch {}
      }
      return;
    }
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (response.success) {
      entry.resolve(response.data);
    } else {
      entry.reject(new RpcCommandError(response.command, response.error ?? "RPC command failed", response.code));
    }
  }

  /** Graceful shutdown: close stdin (omp exits on EOF), escalate to SIGTERM
   * then SIGKILL on the whole process group. Resolves once the process has
   * exited. Safe to call during server teardown — escalation timers are
   * unref'd so they never keep the event loop alive on their own. */
  async dispose(gracePeriodMs = 5_000): Promise<void> {
    if (this.exited) return;
    this.transport.endInput();
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
