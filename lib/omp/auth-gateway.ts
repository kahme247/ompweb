import { type ChildProcessWithoutNullStreams, spawn } from "child_process";
import { homedir } from "os";
import { createInterface } from "readline";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { resolveOmpBin, wrapWindowsScript } from "./omp-cli";

/**
 * Shared `omp auth-gateway stdio` child: omp's own credentials (OAuth
 * subscriptions included) and models behind its gateway routes, as JSON
 * lines — `{id, path, body}` in, `{id, status, body}` out, after a
 * `{ready: true}` line. Lazily started and idle-killed like the utility RPC
 * process (lib/omp/rpc-utility.ts): a cold start costs ~4s.
 */

const READY_TIMEOUT_MS = 60_000;
const IDLE_KILL_MS = 300_000;

export interface AuthGatewayResponse {
  status: number;
  body: unknown;
}

interface Pending {
  resolve(response: AuthGatewayResponse): void;
  reject(error: Error): void;
}

interface Gateway {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending: Map<number, Pending>;
}

interface AuthGatewayState {
  gateway: Gateway | null;
  idleTimer: NodeJS.Timeout | undefined;
  inFlight: number;
  nextId: number;
}

declare global {
  var __ompAuthGatewayState: AuthGatewayState | undefined;
}

function getState(): AuthGatewayState {
  if (!globalThis.__ompAuthGatewayState) {
    globalThis.__ompAuthGatewayState = { gateway: null, idleTimer: undefined, inFlight: 0, nextId: 1 };
    const cleanup = () => disposeAuthGateway();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompAuthGatewayState;
}

/** Stop the shared gateway now; it exits once stdin ends. Safe to call any time. */
export function disposeAuthGateway(): void {
  const state = globalThis.__ompAuthGatewayState;
  if (!state) return;
  clearTimeout(state.idleTimer);
  const gateway = state.gateway;
  state.gateway = null;
  if (!gateway) return;
  gateway.child.stdin.end();
  setTimeout(() => gateway.child.kill(), 5_000).unref?.();
}

function startGateway(state: AuthGatewayState): Gateway {
  const bin = resolveOmpBin();
  if (!bin) throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  // Same environment rules as RpcProcess: no named profile, no project env leaks.
  const env = sanitizeProjectCommandEnvironment({ ...process.env });
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  const target = wrapWindowsScript(bin, ["auth-gateway", "stdio"]);
  const child = spawn(target.file, target.args, { cwd: homedir(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});

  const pending = new Map<number, Pending>();
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
  });
  const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
  ready.catch(() => {});
  // Free the slot so the next request respawns, and kill the hung child.
  const readyTimer = setTimeout(() => {
    fail(new Error("omp auth-gateway did not become ready"));
    child.kill();
  }, READY_TIMEOUT_MS);
  readyTimer.unref?.();

  createInterface({ input: child.stdout }).on("line", (line) => {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const record = frame as { ready?: unknown; id?: unknown; status?: unknown; body?: unknown };
    if (record.ready === true) {
      clearTimeout(readyTimer);
      resolveReady();
      return;
    }
    const entry = typeof record.id === "number" ? pending.get(record.id) : undefined;
    if (!entry || typeof record.status !== "number") return;
    pending.delete(record.id as number);
    entry.resolve({ status: record.status, body: record.body });
  });

  const gateway: Gateway = { child, ready, pending };
  const fail = (error: Error) => {
    clearTimeout(readyTimer);
    rejectReady(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    if (state.gateway === gateway) state.gateway = null;
  };
  child.on("exit", (code, signal) => {
    fail(new Error(`omp auth-gateway exited (code ${code ?? "null"}, signal ${signal ?? "none"})${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`));
  });
  child.on("error", fail);
  return gateway;
}

/**
 * Run one request (`POST path` with a JSON `body`) through omp's auth gateway.
 * Abort rejects the caller only; the gateway finishes the request and drops the reply.
 */
export async function authGatewayRequest(path: string, body: unknown, signal: AbortSignal): Promise<AuthGatewayResponse> {
  const state = getState();
  clearTimeout(state.idleTimer);
  state.inFlight++;
  try {
    const gateway = (state.gateway ??= startGateway(state));
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    aborted.catch(() => {});
    await Promise.race([gateway.ready, aborted]);
    const id = state.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<AuthGatewayResponse>();
    gateway.pending.set(id, { resolve, reject });
    gateway.child.stdin.write(`${JSON.stringify({ id, path, body })}\n`);
    try {
      return await Promise.race([promise, aborted]);
    } finally {
      gateway.pending.delete(id);
    }
  } finally {
    if (--state.inFlight === 0) {
      state.idleTimer = setTimeout(disposeAuthGateway, IDLE_KILL_MS);
      state.idleTimer.unref?.();
    }
  }
}
