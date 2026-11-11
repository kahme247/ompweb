import { type ChildProcessByStdio, execFile, spawn } from "child_process";
import { homedir } from "os";
import { createInterface } from "readline";
import type { Readable } from "stream";
import { sanitizeProjectCommandEnvironment } from "../project-command-env";
import { resolveOmpBin, wrapWindowsScript } from "./omp-cli";

/**
 * Shared `omp auth-broker serve` child: omp's own credentials behind its
 * `/v1/` HTTP routes, for linked hosts (the HTTP route forwards their
 * requests through `brokerFetch`). Lazily started and stopped once idle, like
 * the auth gateway (lib/omp/auth-gateway.ts); it binds loopback on a free port
 * and the bearer token comes from `omp auth-broker token`.
 */

/** Mutable: tests shorten them. */
export const AUTH_BROKER_TIMINGS = { readyMs: 60_000, idleMs: 300_000, killMs: 5_000 };

export class AuthBrokerUnavailableError extends Error {}

interface Broker {
  url: string;
  token: string;
}

type BrokerChild = ChildProcessByStdio<null, Readable, Readable>;

interface AuthBrokerState {
  /** The shared start, then the running broker; null when none is running or starting. */
  broker: Promise<Broker> | null;
  child: BrokerChild | null;
  idleTimer: NodeJS.Timeout | undefined;
  inFlight: number;
  /** Open requests per host, so one host can be cut off. */
  requests: Map<string, Set<AbortController>>;
}

declare global {
  var __ompAuthBrokerState: AuthBrokerState | undefined;
}

function getState(): AuthBrokerState {
  if (!globalThis.__ompAuthBrokerState) {
    globalThis.__ompAuthBrokerState = { broker: null, child: null, idleTimer: undefined, inFlight: 0, requests: new Map() };
    const cleanup = () => disposeAuthBroker();
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompAuthBrokerState;
}

function terminate(child: BrokerChild): void {
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), AUTH_BROKER_TIMINGS.killMs);
  killTimer.unref?.();
  child.once("exit", () => clearTimeout(killTimer));
}

/** Stop the broker child now (SIGTERM, then SIGKILL). Safe to call any time. */
export function disposeAuthBroker(): void {
  const state = globalThis.__ompAuthBrokerState;
  if (!state) return;
  clearTimeout(state.idleTimer);
  const child = state.child;
  state.broker = null;
  state.child = null;
  if (child) terminate(child);
}

async function startBroker(state: AuthBrokerState, isCurrent: () => boolean): Promise<Broker> {
  const bin = resolveOmpBin();
  if (!bin) throw new AuthBrokerUnavailableError("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  // Same environment rules as the auth gateway: no named profile, no project env leaks.
  const env = sanitizeProjectCommandEnvironment({ ...process.env });
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
  const { readyMs } = AUTH_BROKER_TIMINGS;

  const tokenCommand = wrapWindowsScript(bin, ["auth-broker", "token"]);
  const tokenRun = Promise.withResolvers<string>();
  execFile(tokenCommand.file, tokenCommand.args, { cwd: homedir(), env, timeout: readyMs, windowsHide: true }, (error, stdout) => {
    if (error) tokenRun.reject(new AuthBrokerUnavailableError(`omp auth-broker token failed: ${error.message}`, { cause: error }));
    else tokenRun.resolve(stdout.trim());
  });
  const token = await tokenRun.promise;
  if (!token) throw new AuthBrokerUnavailableError("omp auth-broker token printed nothing");
  // disposeAuthBroker() ran while the token command did: spawning now would leave an unowned child.
  if (!isCurrent()) throw new AuthBrokerUnavailableError("omp auth-broker was stopped while starting");

  const serveCommand = wrapWindowsScript(bin, ["auth-broker", "serve", "--bind=127.0.0.1:0"]);
  const child = spawn(serveCommand.file, serveCommand.args, { cwd: homedir(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  state.child = child;
  child.stdout.on("error", () => {});
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
  });

  const { promise, resolve, reject } = Promise.withResolvers<Broker>();
  const readyTimer = setTimeout(() => {
    reject(new AuthBrokerUnavailableError("omp auth-broker did not become ready"));
    terminate(child);
  }, readyMs);
  readyTimer.unref?.();
  // Once it is ready (or gone) later rejects are no-ops.
  const gone = (what: string) => {
    clearTimeout(readyTimer);
    if (state.child === child) {
      state.child = null;
      state.broker = null;
    }
    reject(new AuthBrokerUnavailableError(`omp auth-broker ${what}${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`));
  };
  child.on("exit", (code, signal) => gone(`exited (code ${code ?? "null"}, signal ${signal ?? "none"})`));
  child.on("error", (error) => gone(`failed to start: ${error.message}`));

  let ready = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (ready) return; // keep draining stdout so the child never blocks on a full pipe
    let frame: { message?: unknown; url?: unknown } | null;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame?.message !== "auth-broker listening" || typeof frame.url !== "string" || !frame.url.startsWith("http://127.0.0.1:")) return;
    ready = true;
    clearTimeout(readyTimer);
    resolve({ url: frame.url, token });
  });
  return promise;
}

function currentBroker(state: AuthBrokerState): Promise<Broker> {
  if (state.broker) return state.broker;
  const start: Promise<Broker> = startBroker(state, () => state.broker === start);
  state.broker = start;
  // A failed start frees the slot so the next request starts afresh.
  start.catch(() => {
    if (state.broker === start) state.broker = null;
  });
  return start;
}

/** Wrap `response` so `release` runs once its body ends, errors or is cancelled. */
function releaseWithBody(response: Response, release: () => void): Response {
  if (!response.body) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
}

/**
 * Fetch `path` (starts with "/v1/", query included) from the broker child on behalf of `hostId`.
 * The request counts as in flight until its response body ends, errors or is cancelled; the broker
 * stops once none is. It aborts with `init.signal` or `abortBrokerRequests(hostId)`.
 */
export async function brokerFetch(
  hostId: string,
  path: string,
  init: { method: string; headers: Headers; body?: ArrayBuffer; signal: AbortSignal },
): Promise<Response> {
  const state = getState();
  clearTimeout(state.idleTimer);
  state.inFlight++;
  const controller = new AbortController();
  let hostRequests = state.requests.get(hostId);
  if (!hostRequests) state.requests.set(hostId, (hostRequests = new Set()));
  hostRequests.add(controller);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    hostRequests.delete(controller);
    if (hostRequests.size === 0) state.requests.delete(hostId);
    if (--state.inFlight === 0) {
      state.idleTimer = setTimeout(disposeAuthBroker, AUTH_BROKER_TIMINGS.idleMs);
      state.idleTimer.unref?.();
    }
  };
  try {
    // shortcut: an abort during a cold start is seen only once the start settles (at most readyMs); upgrade if that wait matters.
    const start = currentBroker(state);
    const { url, token } = await start;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const signal = AbortSignal.any([init.signal, controller.signal]);
    let response: Response;
    try {
      // Never through HTTP(S)_PROXY: a proxy cannot reach this loopback server.
      response = await fetch(`${url}${path}`, { method: init.method, headers, body: init.body, signal, proxy: false });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new AuthBrokerUnavailableError(`omp auth-broker request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (response.status === 401) {
      void response.body?.cancel();
      // Only the broker that refused: a concurrent 401 must not stop its replacement.
      if (state.broker === start) disposeAuthBroker();
      throw new AuthBrokerUnavailableError("omp auth-broker refused its own token");
    }
    return releaseWithBody(response, release);
  } catch (error) {
    release();
    throw error;
  }
}

/** Abort every open broker request of this host, streams included. */
export function abortBrokerRequests(hostId: string): void {
  for (const controller of globalThis.__ompAuthBrokerState?.requests.get(hostId) ?? []) controller.abort();
}
