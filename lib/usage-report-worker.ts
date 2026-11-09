import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAgentDir } from "./omp/paths";
import type { UsageQueryOptions, UsageReport } from "./usage-types";

/**
 * Run one usage report in a Bun Worker.
 *
 * The report itself is synchronous `bun:sqlite` work (a write transaction over
 * every changed transcript followed by several aggregate queries). Computing
 * it on the server's thread blocked every other request — `/api/app-info` polls
 * timed out behind a cold `GET /api/usage` — so the whole computation lives in
 * `lib/usage-worker.ts` and the request path only awaits a message.
 *
 * There is deliberately no in-thread fallback: running the same statements on
 * the event loop again is exactly the stall this module removes. A worker that
 * cannot start, fails, or exits without answering rejects with
 * {@link UsageWorkerError}, which the route reports as a 500.
 */

/** The worker entry as it ships in a release: a single bundled file. */
const USAGE_WORKER_BUNDLE = "usage-worker.mjs";
/** The worker entry in a checkout: TypeScript, run by Bun directly. */
const USAGE_WORKER_SOURCE = "usage-worker.ts";

/** The worker under `<dir>/lib/`, preferring the bundle a release ships. */
function packagedWorker(dir: string): string | undefined {
  for (const name of [USAGE_WORKER_BUNDLE, USAGE_WORKER_SOURCE]) {
    const candidate = join(dir, "lib", name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the worker entry from the package layout — never from
 * `process.cwd()`: a server started in an unrelated project directory would
 * otherwise execute that project's `lib/usage-worker.ts` inside a worker with
 * full server privileges.
 *
 * Both overrides are pinned to absolute paths inside the package directory:
 * the worker runs with the server's provider credentials, so a relative value
 * (resolved against whatever cwd the launcher had) or a directory another
 * process can write is not an acceptable code source. `OMP_WEB_PACKAGE_DIR`
 * is set by the launcher and by the compiled binary (to its own directory);
 * the module-relative path is the normal case for a source run, since the
 * server then lives in this package's `lib/`.
 *
 * A compiled binary's own modules sit in Bun's embedded filesystem
 * (`B:\~BUN\root\` on Windows, `/$bunfs/root/` elsewhere), where `existsSync`
 * fails and `new Worker` cannot resolve anything, so that case reads the
 * bundle the release ships beside the executable (`lib/usage-worker.mjs`,
 * scripts/build-binary.ts). `execPath` is the running program, which is the
 * binary itself there.
 */
export function getUsageWorkerPath(): string {
  return resolveUsageWorkerPath({
    packageDir: process.env.OMP_WEB_PACKAGE_DIR,
    override: process.env.OMP_WEB_USAGE_WORKER,
    moduleDir: fileURLToPath(new URL(".", import.meta.url)),
    execDir: dirname(process.execPath),
  });
}

/**
 * The decision {@link getUsageWorkerPath} makes, with every input passed in so
 * a test can exercise the release layout without building a binary.
 *
 * `OMP_WEB_USAGE_WORKER` wins over the packaged worker, in every layout: it is
 * the documented escape hatch for running a different report module, and a
 * packaged worker that silently overrode it made the variable dead exactly
 * where a release user would reach for it.
 */
export function resolveUsageWorkerPath(input: {
  packageDir?: string;
  override?: string;
  moduleDir: string;
  execDir: string;
}): string {
  if (input.override) {
    // An absolute path only: a relative value would be resolved against
    // whatever cwd the launcher happened to have, which is exactly the
    // "another project's file runs with our env" case this function exists to
    // rule out.
    if (isAbsolute(input.override)) return resolve(input.override);
    console.warn(`[usage] ignoring relative OMP_WEB_USAGE_WORKER=${input.override}`);
  }
  if (input.packageDir) {
    const fromPackage = packagedWorker(input.packageDir);
    if (fromPackage) return fromPackage;
  }
  if (/(^|[\\/])(~BUN|\$bunfs)([\\/]|$)/i.test(input.moduleDir)) {
    // OMP_WEB_PACKAGE_DIR pointed somewhere incomplete; the executable's own
    // directory is still a real directory on disk.
    return packagedWorker(input.execDir) ?? join(input.execDir, "lib", USAGE_WORKER_BUNDLE);
  }
  return packagedWorker(input.moduleDir) ?? join(input.moduleDir, USAGE_WORKER_SOURCE);
}

const DEFAULT_USAGE_WORKER_TIMEOUT_MS = 10 * 60_000;

/** A scan that has not answered by then is killed; the route answers 504. */
export function getUsageWorkerTimeoutMs(): number {
  const raw = Number(process.env.OMP_WEB_USAGE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_USAGE_WORKER_TIMEOUT_MS;
}

/** More than this many scans waiting behind the active one gets a 503. */
export const MAX_QUEUED_USAGE_SCANS = 2;

export class UsageWorkerError extends Error {
  readonly code = "usage_worker_failed";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UsageWorkerError";
  }
}

/** Another scan holds the lock and the queue is full; the route answers 503. */
export class UsageWorkerBusyError extends Error {
  readonly code = "usage_busy";
  constructor(message = "A usage scan is already running") {
    super(message);
    this.name = "UsageWorkerBusyError";
  }
}

/** The scan exceeded its deadline and its worker was terminated; the route answers 504. */
export class UsageWorkerTimeoutError extends Error {
  readonly code = "usage_timeout";
  constructor(message = "The usage report timed out") {
    super(message);
    this.name = "UsageWorkerTimeoutError";
  }
}

interface UsageWorkerQueueState {
  /** Resolves when the active scan (and everything before it) settled. */
  tail: Promise<unknown> | undefined;
  /** Scans accepted and not yet finished (one running plus the queue). */
  accepted: number;
}

declare global {
  var __ompUsageWorkerQueue: UsageWorkerQueueState | undefined;
}

function workerQueue(): UsageWorkerQueueState {
  const state = (globalThis.__ompUsageWorkerQueue ??= { tail: undefined, accepted: 0 });
  state.accepted = typeof state.accepted === "number" ? state.accepted : 0;
  return state;
}

/**
 * One report at a time. The write transaction and the analytics queries race
 * the same usage.db that another omp-web process (dev server, second install)
 * may be syncing, so running two worker reports concurrently would only trade
 * event-loop stalls for SQLITE_BUSY errors.
 *
 * The queue is bounded: one running scan plus {@link MAX_QUEUED_USAGE_SCANS}
 * waiting ones, after which a new caller gets `usage_busy` instead of joining
 * an unbounded backlog.
 */
function withUsageWorkerLock<T>(run: () => Promise<T>): Promise<T> {
  const queue = workerQueue();
  if (queue.accepted >= MAX_QUEUED_USAGE_SCANS + 1) {
    return Promise.reject(new UsageWorkerBusyError());
  }
  queue.accepted += 1;
  const start = () => Promise.resolve().then(run).finally(() => {
    queue.accepted = Math.max(0, queue.accepted - 1);
  });
  const next = queue.tail ? queue.tail.then(start, start) : start();
  queue.tail = next.catch(() => undefined);
  return next;
}

/**
 * The worker gets a minimal environment, not a copy of the server's.
 *
 * The worker runs `bun:sqlite` over the agent directory and needs exactly
 * three things: where the agent dir is (pinned to the value the parent
 * resolved, so the data read and the caller's cache key cannot drift apart),
 * the home directory the path helpers fall back to, and the OS plumbing a
 * child needs to start (`PATH`, `SystemRoot`, `TEMP`, …). Everything else —
 * above all the server's own credentials (`OMP_WEB_PASSWORD_HASH`,
 * `OMP_WEB_STT_KEY`, `OMP_WEB_TRUSTED_HEADER_*`) — must not reach a thread
 * that executes a file path, however that path was chosen
 * (`lib/project-command-env.ts` states the same rule for child processes).
 */
function workerEnvironment(agentDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: agentDir,
    HOME: process.env.HOME ?? homedir(),
    USERPROFILE: process.env.USERPROFILE ?? process.env.HOME ?? homedir(),
    // Windows resolves DLLs and the SQLite temp files through these.
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "",
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? process.env.TEMP ?? tmpdir(),
    PATH: process.env.PATH ?? "",
  };
  // `PI_CONFIG_DIR` renames the config root the agent-dir helpers build from;
  // without it a non-default install would read the wrong directory.
  if (process.env.PI_CONFIG_DIR) env.PI_CONFIG_DIR = process.env.PI_CONFIG_DIR;
  if (process.env.XDG_DATA_HOME) env.XDG_DATA_HOME = process.env.XDG_DATA_HOME;
  for (const key of Object.keys(env)) if (env[key] === "") delete env[key];
  return env;
}

/** Compute a usage report in a worker thread and resolve with its answer. */
export function runUsageReportInWorker(
  options: UsageQueryOptions = {},
  agentDir: string = getAgentDir(),
): Promise<UsageReport> {
  return withUsageWorkerLock(() => computeReportInWorker(options, agentDir));
}

function computeReportInWorker(options: UsageQueryOptions, agentDir: string): Promise<UsageReport> {
  const workerPath = getUsageWorkerPath();
  const { promise, resolve: resolveReport, reject } = Promise.withResolvers<UsageReport>();
  if (!existsSync(workerPath)) {
    const message = `Usage report worker missing at ${workerPath}; the package is incomplete or OMP_WEB_USAGE_WORKER/OMP_WEB_PACKAGE_DIR point elsewhere`;
    console.error("[usage]", message);
    reject(new UsageWorkerError(message));
    return promise;
  }
  let worker: Worker;
  try {
    worker = new Worker(pathToFileURL(workerPath), {
      type: "module",
      name: "omp-usage-report",
      env: workerEnvironment(agentDir),
    });
  } catch (error) {
    reject(new UsageWorkerError(
      `Could not start the usage report worker at ${workerPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ));
    return promise;
  }

  let settled = false;
  let closed = false;

  // A scan that hangs keeps the one worker lock forever; kill it so the queue
  // (and the route) recover instead of piling requests behind it.
  const timeoutMs = getUsageWorkerTimeoutMs();
  const timeout = setTimeout(() => {
    console.error(`[usage] report worker exceeded ${timeoutMs} ms; terminating`);
    finish(() => reject(new UsageWorkerTimeoutError(`The usage report worker exceeded ${timeoutMs} ms`)));
  }, timeoutMs);
  timeout.unref?.();

  // Wait for the thread to be gone before the caller continues: a test or a
  // shutdown may delete the agent directory right after the answer, and on
  // Windows the worker's open usage.db handle would make that fail.
  function finish(settle: () => void) {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    worker.onmessage = null;
    worker.onerror = null;
    if (closed) {
      settle();
      return;
    }
    // terminate() is asynchronous; one event-loop turn is not a guarantee that
    // the thread is gone. A closed thread always wins, but a kill that never
    // reports close must not hang the request that the timeout already
    // answered.
    const forced = setTimeout(settle, 5_000);
    forced.unref?.();
    worker.addEventListener("close", () => {
      clearTimeout(forced);
      settle();
    }, { once: true });
    worker.terminate();
  }

  // `close` also fires after `terminate()`; only an exit before an answer is a
  // failure.
  worker.addEventListener("close", (event) => {
    closed = true;
    const code = (event as CloseEvent).code;
    finish(() => reject(new UsageWorkerError(
      `The usage report worker exited (code ${code}) without returning a report`,
    )));
  });

  worker.onmessage = (event: MessageEvent) => {
    const answer = event.data as { ok?: boolean; report?: UsageReport; error?: string } | null;
    if (answer?.ok === true && answer.report) {
      finish(() => resolveReport(answer.report as UsageReport));
      return;
    }
    const reason = typeof answer?.error === "string" && answer.error ? answer.error : "unknown error";
    finish(() => reject(new UsageWorkerError(`The usage report worker failed: ${reason}`)));
  };
  worker.onerror = (event: ErrorEvent) => {
    const reason = typeof event.message === "string" && event.message ? event.message : "unknown error";
    finish(() => reject(new UsageWorkerError(`The usage report worker failed: ${reason}`)));
  };

  worker.postMessage({ options });
  return promise;
}
