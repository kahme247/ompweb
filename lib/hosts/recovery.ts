// `ompweb recover-host` and the web server's local recovery: replace a host that cannot update itself (a daemon whose
// updater refuses its sessions, its supervisor or its protocol, or one that has no force) with an official release. The
// caller needs nothing from the old host but its private control endpoint (status, and drain to prove it idle): not its
// updater, not its runner. The CLI runs from a helper binary a legacy bootstrap staged in a scratch directory, never from
// the install it replaces.
//
// startHostRecovery only records a durable operation (the host update worker's own state, claim and descriptor files,
// under the operation id) and starts that worker detached from the caller, its session and the old supervisor, then
// returns: the old daemon has not been touched beyond a drain. The worker stages and preflights the full official release
// itself, then stops the old daemon through its inspected supervisor, swaps the installation and restarts, or rolls back.
// Completion is the new host's operation receipt (a maintenance receipt bound to this operation, its release's preflight
// and the approved protocol range), never anything this process prints.
// Loaded by Node/jiti and the compiled binary: no `@/` imports.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { detectInstallMethod } from "../npm-update";
import { releaseRepo } from "../release-repo";
import { isUpdateDisabled } from "../update-policy";
import { inspectUpgradeProcess, type UpgradeProcess } from "../upgrade-process";
import { dialable } from "./daemon-link";
import { requestHostControl, type HostControlStatus } from "./host-control";
import { readHostLinks } from "./host-login";
import type { HostUpdateCompatibility, HostUpdateOperation } from "./update-types";
import { candidateProtocol, claimHostUpdate, getHostUpdateOperation, HostUpdateError, hostUpdateClaimHolder, launchHostUpdateWorker, releaseHostUpdateClaim, resolvePackageManager } from "./updates";
import { assertOwnedPath, finishHostUpdate, HOST_INSTALL_SHARED, HOST_VERSION_PATTERN, hostLaunch, hostUpdateRoot, installedHostVersionMatches, sharedHostInstallReason, writeHostUpdateJson, type HostUpdateDescriptor } from "./update-worker";

/** A legacy bootstrap refuses a helper binary without this literal: an older `ompweb` takes the unknown subcommand for a positional and starts a web server. */
export const RECOVERY_CLI_MARKER = "ompweb-recovery-cli-v1";
const USAGE = `${RECOVERY_CLI_MARKER}: ompweb recover-host --operation <uuid> --version <semver> --min-protocol <n> --max-protocol <n> [--force]`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HostRecoveryInput {
  /** The durable operation's UUID: a retry names the same one and starts nothing twice. */
  operationId: string;
  /** The official release to install. */
  version: string;
  /** The protocol range the web server will speak once its cutover completes; the release must speak one of these. */
  compatibility: HostUpdateCompatibility;
  /** Explicit approval to end this host's sessions at the worker's commit. Without it the old host must prove itself idle (drain). */
  force: boolean;
}

/**
 * Why a recovery was not started. `state` is the CLI's verdict: `blocked` (a precondition holds; `forceable` when this
 * host's activity alone does and the same request with `force` would proceed), `coordination_required` (the installation
 * is shared with the web server: only the server's own coordinated worker may replace it), `failed`, or `succeeded`
 * (`already_current`: the host already runs the release).
 */
export class HostRecoveryRefusal extends HostUpdateError {
  constructor(readonly state: "blocked" | "coordination_required" | "failed" | "succeeded", code: string, message: string, readonly forceable = false, httpStatus = 409) {
    super(code, message, httpStatus);
    this.name = "HostRecoveryRefusal";
  }
}

/** The seams a test replaces; production always uses `hostRecoveryDependencies`. */
export interface HostRecoveryDependencies {
  control: typeof requestHostControl;
  inspect: typeof inspectUpgradeProcess;
  protocol: typeof candidateProtocol;
  shared: typeof sharedHostInstallReason;
  launchWorker: typeof launchHostUpdateWorker;
  repo(): string;
}
export const hostRecoveryDependencies: HostRecoveryDependencies = { control: requestHostControl, inspect: inspectUpgradeProcess, protocol: candidateProtocol, shared: sharedHostInstallReason, launchWorker: launchHostUpdateWorker, repo: releaseRepo };

interface OldHostInstall {
  installMethod: "npm" | "bun" | "binary";
  installDir: string;
  runtime: string;
}
/** The old host's installation from what its control endpoint reports (its executable and entrypoint): a complete binary release directory or an installed npm/bun package; anything else is not guessed at. */
function oldHostInstall(status: HostControlStatus): OldHostInstall {
  const binaryName = process.platform === "win32" ? "ompweb.exe" : "ompweb";
  if (basename(status.executable) === binaryName && existsSync(join(dirname(status.executable), "dist", "index.html"))) return { installMethod: "binary", installDir: dirname(status.executable), runtime: status.executable };
  const packageDir = dirname(dirname(status.entrypoint));
  if (["omp-web.js", "omp-web-host.js"].includes(basename(status.entrypoint)) && existsSync(join(packageDir, "package.json")) && JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).name === "@kahme247/ompweb") return { installMethod: detectInstallMethod(packageDir), installDir: packageDir, runtime: status.executable };
  throw new Error("The running host is neither a complete binary release nor an installed npm/bun package; recover it manually");
}

/** The operation already started under this id (the same request: its current state), or null when none was. A different request under the same id is a conflict. */
function startedOperation(input: HostRecoveryInput): HostUpdateOperation | null {
  const root = hostUpdateRoot();
  const path = join(root, input.operationId, "descriptor.json");
  if (!existsSync(path)) return null;
  assertOwnedPath(root, true);
  assertOwnedPath(path);
  const started = JSON.parse(readFileSync(path, "utf8")) as HostUpdateDescriptor;
  if (started.id !== input.operationId || started.version !== input.version || (started.force === true) !== input.force || started.receipt?.min !== input.compatibility.min || started.receipt?.max !== input.compatibility.max) throw new HostRecoveryRefusal("failed", "operation_conflict", "This operation id was already used with different parameters");
  const operation = getHostUpdateOperation();
  if (operation?.id !== input.operationId) throw new HostRecoveryRefusal("failed", "operation_superseded", "A later host update replaced this operation's record");
  return operation;
}

function validateRequest({ version, compatibility }: Pick<HostRecoveryInput, "version" | "compatibility">): void {
  if (version.length > 100 || !HOST_VERSION_PATTERN.test(version)) throw new HostRecoveryRefusal("failed", "invalid_version", "Invalid host update version", false, 400);
  if (!Number.isSafeInteger(compatibility.min) || !Number.isSafeInteger(compatibility.max) || compatibility.min < 1 || compatibility.max < compatibility.min) throw new HostRecoveryRefusal("failed", "invalid_compatibility", "Invalid server link protocol range", false, 400);
}

interface PreparedRecovery {
  status: HostControlStatus;
  install: OldHostInstall;
  layout: Pick<HostUpdateDescriptor, "installMethod" | "installDir" | "runtime" | "hostArgs" | "cwd">;
  supervised: UpgradeProcess;
  /** The installation already holds the release (a shared one a server cutover replaced): only the host restarts and nothing is replaced. */
  restartOnly: boolean;
  managerPath: string | undefined;
}

/** Every precondition short of claiming the operation or touching the host: what the old host is, whether its installation is replaced or only restarted, and what supervises it. */
async function prepare({ version, compatibility }: Pick<HostRecoveryInput, "version" | "compatibility">, deps: HostRecoveryDependencies, refresh: boolean): Promise<PreparedRecovery> {
  // Never bypassed, force or not.
  if (isUpdateDisabled()) throw new HostRecoveryRefusal("blocked", "updates_disabled", "Updates are disabled by OMP_WEB_DISABLE_AUTOUPDATE", false, 403);
  let status: HostControlStatus;
  try { status = await deps.control("status"); }
  catch (error) { throw new HostRecoveryRefusal("failed", "no_host", `No host answers on this machine's private control endpoint: ${error instanceof Error ? error.message : String(error)}`); }
  if (!HOST_VERSION_PATTERN.test(status.version)) throw new HostRecoveryRefusal("failed", "invalid_host", "The running host reports an unreadable version");
  if (status.version === version) throw new HostRecoveryRefusal("succeeded", "already_current", `This host already runs ${version}`);
  // A local maintenance drain is an operator's own window: waited out, never forced past.
  if (status.drained) throw new HostRecoveryRefusal("blocked", "host_drained", "This host is locally drained for maintenance");
  let install: OldHostInstall;
  try { install = oldHostInstall(status); }
  catch (error) { throw new HostRecoveryRefusal("blocked", "unsupported_install", error instanceof Error ? error.message : String(error)); }
  // A release already on disk replaces nothing: only the host restarts, so a process sharing the installation (the web server) is left running and is no reason to wait.
  const restartOnly = await installedHostVersionMatches(install.installMethod, install.installDir, version);
  if (!restartOnly) {
    // The old daemon's own sessions end with it; anything else using the installation (the web server) is a sharer. Replacing files under it is never waived.
    const sharing = await deps.shared(install.installDir, [process.pid], [status.pid]);
    if (sharing === HOST_INSTALL_SHARED) throw new HostRecoveryRefusal("coordination_required", "shared_install", sharing);
    if (sharing) throw new HostRecoveryRefusal("blocked", "unsupported_install", sharing);
  }
  const protocol = await deps.protocol(version, refresh);
  if (protocol === null) throw new HostRecoveryRefusal("failed", "protocol_unverified", "The release's daemon link protocol could not be verified");
  if (protocol < compatibility.min || protocol > compatibility.max) throw new HostRecoveryRefusal("failed", "protocol_incompatible", `This release uses daemon protocol ${protocol}, outside the approved ${compatibility.min}–${compatibility.max}`);
  const layout = { installMethod: install.installMethod, installDir: install.installDir, runtime: install.runtime, hostArgs: readHostLinks().some((link) => !dialable(link.url, false)) ? ["--allow-http"] : [], cwd: homedir() };
  let supervised: UpgradeProcess;
  try { supervised = await deps.inspect({ pid: status.pid, installDir: install.installDir, role: "host", launch: hostLaunch(layout) }); }
  catch (error) { throw new HostRecoveryRefusal("blocked", "supervisor_unsupported", error instanceof Error ? error.message : String(error)); }
  if (restartOnly && supervised.supervisor.kind !== "foreground") {
    // Stopping a shared unit, loop or service would end the web server too: a server restart disguised as a host restart. When this process is the web server and answers to the very same supervisor, refuse; a caller that is no server (the recovery CLI) throws here and has nothing to compare.
    const server = await deps.inspect({ pid: process.pid, installDir: install.installDir, role: "server", launch: { command: process.execPath, args: [], cwd: homedir() } }).catch(() => null);
    if (server && JSON.stringify(server.supervisor) === JSON.stringify(supervised.supervisor)) throw new HostRecoveryRefusal("blocked", "supervisor_shared", "The host is supervised by the same service as the web server; restarting it would restart the server too");
  }
  let managerPath: string | undefined;
  try { managerPath = install.installMethod === "binary" || restartOnly ? undefined : resolvePackageManager(install.installMethod); }
  catch (error) { throw new HostRecoveryRefusal("blocked", "manager_missing", error instanceof Error ? error.message : String(error)); }
  return { status, install, layout, supervised, restartOnly, managerPath };
}

/**
 * Whether `startHostRecovery` with force would pass every precondition now, without claiming, draining or writing
 * anything: resolves when it would, else throws the HostRecoveryRefusal it would. The activity-waiving force is assumed:
 * what is checked is only what a force cannot waive.
 */
export async function checkHostRecovery(input: Pick<HostRecoveryInput, "version" | "compatibility">, deps: HostRecoveryDependencies = hostRecoveryDependencies): Promise<void> {
  validateRequest(input);
  await prepare(input, deps, false);
}

/**
 * Starts the recovery of this machine's host and returns once its detached worker is launched (`operation.state` is
 * "running"; a retry of the same id returns that operation as it now stands and starts nothing). Throws
 * HostRecoveryRefusal when nothing was started. Force waives only this host's activity: a disabled updater, an unsupported
 * or shared installation, an uncontrollable supervisor, a local drain and an unverified or out-of-range release still
 * refuse. A release already on disk is only restarted into (`restartOnly`): the installation is not replaced, so a
 * sharing web server stays up.
 */
export async function startHostRecovery(input: HostRecoveryInput, deps: HostRecoveryDependencies = hostRecoveryDependencies): Promise<{ accepted: true; operation: HostUpdateOperation }> {
  const { operationId, version, compatibility, force } = input;
  if (!UUID.test(operationId)) throw new HostRecoveryRefusal("failed", "invalid_request", "operationId must be a UUID", false, 400);
  validateRequest(input);
  const replayed = startedOperation(input);
  if (replayed) return { accepted: true, operation: replayed };
  const { status, install, layout, supervised, restartOnly, managerPath } = await prepare(input, deps, true);

  let root: string;
  try { root = claimHostUpdate(operationId, install.installDir); }
  catch (error) {
    // The same operation started by a concurrent caller is running, not an error.
    if (hostUpdateClaimHolder() === operationId) return { accepted: true, operation: { id: operationId, target: "ompweb", version, state: "running", ...(force ? { force: true as const } : {}) } };
    throw error instanceof HostUpdateError ? new HostRecoveryRefusal("failed", error.code, error.message) : error;
  }
  let drained = false;
  let recorded = false;
  try {
    if (!force) {
      // Drain is the old host's own proof that nothing runs: it refuses while sessions, uploads or operations do.
      try { await deps.control("drain"); drained = true; }
      catch (error) {
        const busy = error instanceof Error && "code" in error && error.code === "host_busy";
        throw new HostRecoveryRefusal("blocked", busy ? "host_busy" : "drain_failed", error instanceof Error ? error.message : String(error), busy);
      }
    }
    const operation: HostUpdateOperation = { id: operationId, target: "ompweb", version, state: "running", ...(force ? { force: true as const } : {}) };
    writeHostUpdateJson(join(root, "status.json"), { operation, startedAt: Date.now(), daemonPid: status.pid });
    recorded = true;
    const descriptor: HostUpdateDescriptor = { id: operationId, target: "ompweb", version, fromVersion: status.version, ...layout, daemonPid: status.pid, process: supervised, managerPath, releaseRepo: deps.repo(), restartOnly: restartOnly || undefined, force: force || undefined, receipt: compatibility, recovery: { drained } };
    await deps.launchWorker(root, descriptor, typeof Bun !== "undefined" && Bun.isStandaloneExecutable ? "compiled" : "script");
    return { accepted: true, operation };
  } catch (error) {
    // Nothing was stopped: the old host goes back to work, and the claim ends with the failure.
    if (drained) await deps.control("resume").catch(() => undefined);
    if (recorded) finishHostUpdate(operationId, error instanceof Error ? error.message : String(error));
    else releaseHostUpdateClaim(root, operationId);
    throw error instanceof HostRecoveryRefusal ? error : new HostRecoveryRefusal("failed", "recovery_failed", error instanceof Error ? error.message : String(error), false, 500);
  }
}

/** What the CLI prints as one JSON line. */
export interface HostRecoveryOutcome {
  marker: typeof RECOVERY_CLI_MARKER;
  operation: string;
  version: string;
  state: "running" | "succeeded" | "failed" | "blocked" | "coordination_required";
  /** Machine-readable cause of a refusal or failure. */
  code?: string;
  message?: string;
  force: boolean;
  /** A forced recovery ends the old host's sessions at its commit; the old control endpoint does not report how many run. */
  sessionsMayEnd?: true;
  /** Blocked only by this host's activity: the same request with `force` would proceed. */
  forceable?: boolean;
}
const EXIT = { running: 0, succeeded: 0, failed: 1, blocked: 3, coordination_required: 3 } as const;

/** Strict parsing: every flag exactly once (`--force` at most once), values as the next argument, nothing else. */
export function parseHostRecoveryArgs(argv: string[]): HostRecoveryInput {
  const values = new Map<string, string>();
  let force = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--force") {
      if (force) throw new Error("--force given twice");
      force = true;
    } else if (["--operation", "--version", "--min-protocol", "--max-protocol"].includes(flag)) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      if (values.has(flag)) throw new Error(`${flag} given twice`);
      values.set(flag, value);
    } else throw new Error(`Unknown argument ${flag.slice(0, 40)}`);
  }
  const operation = values.get("--operation");
  const version = values.get("--version");
  const min = values.get("--min-protocol");
  const max = values.get("--max-protocol");
  if (operation === undefined || version === undefined || min === undefined || max === undefined) throw new Error("--operation, --version, --min-protocol and --max-protocol are required");
  if (!UUID.test(operation)) throw new Error("--operation must be a UUID");
  if (version.length > 100 || !HOST_VERSION_PATTERN.test(version)) throw new Error("--version must be a release version");
  if (!/^[1-9]\d{0,8}$/.test(min) || !/^[1-9]\d{0,8}$/.test(max) || Number(max) < Number(min)) throw new Error("--min-protocol and --max-protocol must be positive integers, max not below min");
  return { operationId: operation.toLowerCase(), version, compatibility: { min: Number(min), max: Number(max) }, force };
}

/** `ompweb recover-host <argv>`: the exit code; one JSON line on stdout says what happened. 0 only once the detached worker was launched (or the host already runs the release). */
export async function runHostRecoveryCli(argv: string[]): Promise<number> {
  let input: HostRecoveryInput;
  try { input = parseHostRecoveryArgs(argv); }
  catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const outcome = (state: HostRecoveryOutcome["state"], extra: Partial<HostRecoveryOutcome> = {}): HostRecoveryOutcome => ({ marker: RECOVERY_CLI_MARKER, operation: input.operationId, version: input.version, state, force: input.force, ...(input.force ? { sessionsMayEnd: true as const } : {}), ...extra });
  let result: HostRecoveryOutcome;
  try {
    const { operation } = await startHostRecovery(input);
    result = outcome(operation.state, operation.error ? { code: "update_failed", message: operation.error } : {});
    // A worker that refuses its descriptor or the disable setting fails within moments: report that rather than a launch that cannot succeed.
    for (const end = Date.now() + 3000; result.state === "running" && Date.now() < end; await pause(250)) {
      const current = getHostUpdateOperation();
      if (current?.id === input.operationId && current.state !== "running") result = outcome(current.state, current.error ? { code: "update_failed", message: current.error } : {});
    }
  } catch (error) {
    result = error instanceof HostRecoveryRefusal ? outcome(error.state, { code: error.code, message: error.message, ...(error.forceable ? { forceable: true } : {}) }) : outcome("failed", { code: "recovery_failed", message: error instanceof Error ? error.message : String(error) });
  }
  console.log(JSON.stringify(result));
  return EXIT[result.state];
}
