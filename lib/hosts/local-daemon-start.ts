// Starts this machine's host daemon for the web server unless one already answers its private control endpoint.
// Pure Node: no Next or `@/` imports (instrumentation.node.ts loads it).
import { join, resolve } from "node:path";
import { isProcessAlive } from "../process-identity";
import { isActiveLease, leasePath, readStateJson, statusPath, type StoredStatus } from "../self-update-state";
import { launchDetachedUpgrade, type UpgradeLaunch } from "../upgrade-process";
import { requestHostControl, type HostControlStatus } from "./host-control";
import { ensureLocalHostLink, localLinkUrl } from "./local-bootstrap";
import { getHostUpdateOperation } from "./updates";

export interface LocalDaemonOptions {
  /** The web server's environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The host command; defaults to this install's host. Tests use it to run a fake host. */
  launch?: UpgradeLaunch;
}

export interface LocalDaemonResult {
  started: boolean;
  pid?: number;
  /** Set when no daemon was checked or started, with the reason. */
  skipped?: string;
}

/** A supervisor that is still starting binds the control endpoint within seconds: wait for it rather than run a duplicate. */
const SUPERVISOR_GRACE_MS = 5_000;
/** A cold start loads the daemon's modules before it binds; the update worker allows its replacement the same time. */
const START_TIMEOUT_MS = 30_000;
/** A host that lost the singleton race exits while the winner is still binding: give the winner this long. */
const EXIT_SETTLE_MS = 3_000;
const PROBE_INTERVAL_MS = 250;
/** The server's secrets and paths stay out of the daemon, as the update worker's environment keeps them out. */
const SERVER_ONLY: Record<string, true> = { PORT: true, NODE_ENV: true, OMP_WEB_PASSWORD: true, OMP_WEB_PASSWORD_HASH: true, OMP_WEB_TRUSTED_HEADER_SECRET: true, OMP_WEB_TRUSTED_HEADER_SHA256: true, OMP_WEB_PACKAGE_DIR: true, OMP_WEB_LAUNCHER_PID: true };

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The running daemon's status, or null when nothing listens: no socket or pipe, or a stale socket nobody answers. Any other failure is an error, so a daemon that cannot be probed is never duplicated. */
async function probe(): Promise<HostControlStatus | null> {
  try {
    return await requestHostControl("status");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ECONNREFUSED") return null;
    throw error;
  }
}

/** This install's host command: the standalone binary's `host`, or the package's entrypoint under the Node runtime. */
export function localHostLaunch(env: NodeJS.ProcessEnv = process.env): UpgradeLaunch {
  if (typeof Bun !== "undefined" && Bun.isStandaloneExecutable) return { command: process.execPath, args: ["host"], cwd: process.cwd() };
  const packageDir = env.OMP_WEB_PACKAGE_DIR;
  if (!packageDir) throw new Error("OMP_WEB_PACKAGE_DIR is not set, so the host entrypoint cannot be found");
  // The daemon is Node-only: a web server running on Bun must start it with the launcher's Node binary.
  const command = env.OMP_WEB_NODE_BIN || (process.versions.bun ? "node" : process.execPath);
  return { command, args: [join(resolve(packageDir), "bin", "omp-web-host.js")], cwd: process.cwd() };
}

function daemonEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined && !SERVER_ONLY[name.toUpperCase()]));
}

/** The reason an update owns this machine's daemon, or null. That update stops the daemon and starts its replacement itself. */
function updateInProgress(): string | null {
  const operation = getHostUpdateOperation();
  if (operation?.state === "running") return `a host update to ${operation.version} is in progress and starts this machine's host when it finishes`;
  // Host-phase resume keeps this running after the coordinator dies, until the lease ends. A live pid is not required.
  const status = readStateJson<StoredStatus>(statusPath());
  if (status?.state !== "running" || !isActiveLease(readStateJson<{ expiresAt?: unknown }>(leasePath()))) return null;
  return `a server update to ${status.targetVersion} is in progress and starts this machine's host when it finishes`;
}

/** Waits until the launched daemon answers, or fails with a reason: it exited, or it did not answer in time. Never waits forever. */
async function awaitHost(pid: number | undefined, launch: UpgradeLaunch): Promise<HostControlStatus> {
  const described = `${launch.command} ${launch.args.join(" ")}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  let exitedAt: number | undefined;
  let last: unknown;
  for (;;) {
    try {
      return await requestHostControl("status");
    } catch (error) {
      last = error;
    }
    if (pid !== undefined && !isProcessAlive(pid)) {
      exitedAt ??= Date.now();
      if (Date.now() - exitedAt >= EXIT_SETTLE_MS) throw new Error(`The local host exited during startup (${described}): ${message(last)}`);
    }
    if (Date.now() >= deadline) throw new Error(`The local host did not answer its control endpoint within ${START_TIMEOUT_MS / 1000} s (${described}): ${message(last)}`);
    await sleep(PROBE_INTERVAL_MS);
  }
}

async function startLocalHostDaemon({ env = process.env, launch }: LocalDaemonOptions): Promise<LocalDaemonResult> {
  if (env.NODE_ENV === "development") return { started: false, skipped: "the development server does not start the local daemon" };
  const target = localLinkUrl(env);
  if ("skip" in target) return { started: false, skipped: target.skip };
  // The daemon reads host.json as it starts, so the link is prepared before any probe or launch.
  await ensureLocalHostLink({ url: target.url });
  const graceEnds = Date.now() + SUPERVISOR_GRACE_MS;
  for (;;) {
    const running = await probe();
    if (running) return { started: false, pid: running.pid };
    const busy = updateInProgress();
    if (busy) return { started: false, skipped: busy };
    if (Date.now() >= graceEnds) break;
    await sleep(PROBE_INTERVAL_MS);
  }
  const plan = launch ?? localHostLaunch(env);
  let pid: number | undefined;
  try {
    pid = await launchDetachedUpgrade({ env: daemonEnvironment(env), ...plan });
  } catch (error) {
    throw new Error(`Could not start the local host (${plan.command}): ${message(error)}`);
  }
  const status = await awaitHost(pid, plan);
  // When another starter won the singleton race, its daemon answers and this launch is not the host.
  return { started: pid === undefined || status.pid === pid, pid: status.pid };
}

let starting: Promise<LocalDaemonResult> | undefined;

/** Starts this machine's host unless one answers, and reports the result or the reason it could not. Concurrent calls in this process share one start; across processes the host-control singleton lets exactly one daemon bind. */
export function ensureLocalHostDaemon(options: LocalDaemonOptions = {}): Promise<LocalDaemonResult> {
  starting ??= startLocalHostDaemon(options).finally(() => { starting = undefined; });
  return starting;
}
