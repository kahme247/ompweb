import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";
import { releaseRepo } from "./release-repo";
import { checkNpmUpdate } from "./npm-update";
import { isUpdateDisabled } from "./update-policy";
import { requestHostControl } from "./hosts/host-control";
import { getHostSoftwareUpdates, getHostUpgradeInventory, hostsSnapshot, updateHostSoftware, type HostUpgradeInventory } from "./hosts/hub";
import { assertOwnedPath, fetchHostUpdateBytes, HOST_VERSION_PATTERN } from "./hosts/update-worker";
import { HostOpError } from "./hosts/link-protocol";
import type { HostUpdateCompatibility } from "./hosts/update-types";
import type { UpgradeApproval, UpgradeParticipant, UpgradePlan } from "./upgrade-types";
import { inspectUpgradeProcess } from "./upgrade-process";
import { renewLease } from "./self-update-state";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PLAN_LEASE_MS = 30 * 60_000;
export const upgradePlanTimings = { hostTimeoutMs: 15 * 60_000, pollMs: 1000 };

export class UpgradePlanError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 409) { super(message); this.name = "UpgradePlanError"; }
}

export function parseReleaseCompatibility(source: string): HostUpdateCompatibility {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const values: number[] = [];
  for (const name of ["MIN_LINK_PROTOCOL_VERSION", "LINK_PROTOCOL_VERSION"]) {
    const declarations = [...text.matchAll(new RegExp(`^export const ${name}\\s*=\\s*([1-9]\\d*)\\s*;\\s*$`, "gm"))];
    if (declarations.length !== 1 || [...text.matchAll(new RegExp(`export\\s+const\\s+${name}\\b`, "g"))].length !== 1) {
      throw new UpgradePlanError("unknown_compatibility", "The candidate server's complete host protocol range could not be verified");
    }
    const value = Number(declarations[0][1]);
    if (!Number.isSafeInteger(value)) throw new UpgradePlanError("unknown_compatibility", "The candidate server's protocol range is invalid");
    values.push(value);
  }
  if (values[0] > values[1]) throw new UpgradePlanError("unknown_compatibility", "The candidate server's protocol range is inverted");
  return { min: values[0], max: values[1] };
}

async function candidateIdentity(version: string): Promise<{ compatibility: HostUpdateCompatibility; fingerprint: string }> {
  if (!HOST_VERSION_PATTERN.test(version)) throw new UpgradePlanError("invalid_version", "Invalid server update version", 400);
  const repo = releaseRepo();
  const [source, bytes] = await Promise.all([
    fetchHostUpdateBytes(`https://raw.githubusercontent.com/${repo}/v${version}/lib/hosts/link-protocol.ts`, 128 * 1024),
    fetchHostUpdateBytes(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, 2 * 1024 * 1024),
  ]);
  const release: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(release) || release.tag_name !== `v${version}` || release.draft === true || !Array.isArray(release.assets)) {
    throw new UpgradePlanError("unpublished_release", "The candidate server has no matching published release");
  }
  const digests: string[] = [];
  for (const asset of release.assets) {
    if (!isRecord(asset) || typeof asset.name !== "string" || !/^ompweb-(?:linux|darwin|windows)-/.test(asset.name)) continue;
    if (typeof asset.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new UpgradePlanError("release_integrity", "A candidate release asset has no verified digest");
    if (digests.some((entry) => entry.startsWith(`${asset.name}:`))) throw new UpgradePlanError("release_integrity", "The candidate release has duplicate platform assets");
    digests.push(`${asset.name}:${asset.digest}`);
  }
  if (!digests.length) throw new UpgradePlanError("release_integrity", "The candidate release has no verified platform assets");
  return {
    compatibility: parseReleaseCompatibility(source.toString("utf8")),
    fingerprint: createHash("sha256").update(source).update(JSON.stringify(digests.sort())).digest("hex"),
  };
}

function planDirectory(id: string, create = false): string {
  if (!ID.test(id)) throw new UpgradePlanError("invalid_plan", "Invalid upgrade plan identity", 400);
  const parent = join(getAgentDir(), "omp-web", "server-upgrades");
  if (create) { mkdirSync(parent, { recursive: true, mode: 0o700 }); assertOwnedPath(parent, true); }
  const directory = join(parent, id);
  if (existsSync(directory)) assertOwnedPath(directory, true);
  return directory;
}

export function upgradePlanPath(id: string): string { return join(planDirectory(id), "plan.json"); }

export function removeUpgradePlan(id: string): void {
  const directory = planDirectory(id);
  if (!existsSync(directory)) return;
  for (const name of ["plan.json", "identity.json"]) {
    const file = join(directory, name);
    if (existsSync(file)) { assertOwnedPath(file); unlinkSync(file); }
  }
  rmdirSync(directory);
}

function writePlan(plan: UpgradePlan): void {
  const path = upgradePlanPath(plan.id);
  assertOwnedPath(dirname(path), true);
  if (existsSync(path)) assertOwnedPath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(plan), { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function validParticipant(value: unknown): value is UpgradeParticipant {
  return isRecord(value) && typeof value.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value.id)
    && typeof value.label === "string" && (value.currentVersion === null || typeof value.currentVersion === "string")
    && (value.protocolVersion === null || Number.isSafeInteger(value.protocolVersion))
    && (value.targetVersion === null || typeof value.targetVersion === "string" && HOST_VERSION_PATTERN.test(value.targetVersion))
    && typeof value.needsUpgrade === "boolean" && ["maintenance", "legacy", "local", "shared-local", "none"].includes(String(value.recovery))
    && (value.sessionProcesses === null || Number.isSafeInteger(value.sessionProcesses) && Number(value.sessionProcesses) >= 0)
    && (value.activeTurns === null || Number.isSafeInteger(value.activeTurns) && Number(value.activeTurns) >= 0)
    && (value.blockedReason === null || typeof value.blockedReason === "string")
    && ["unchanged", "pending", "updating", "ready", "failed"].includes(String(value.stage))
    && (value.operationId === undefined || typeof value.operationId === "string" && value.operationId.length <= 128)
    && (value.error === undefined || typeof value.error === "string");
}

function validPlan(value: unknown): value is UpgradePlan {
  return isRecord(value) && typeof value.id === "string" && ID.test(value.id)
    && typeof value.fromVersion === "string" && HOST_VERSION_PATTERN.test(value.fromVersion)
    && typeof value.targetVersion === "string" && HOST_VERSION_PATTERN.test(value.targetVersion)
    && isRecord(value.compatibility) && Number.isSafeInteger(value.compatibility.min) && Number(value.compatibility.min) >= 1
    && Number.isSafeInteger(value.compatibility.max) && Number(value.compatibility.max) >= Number(value.compatibility.min)
    && Array.isArray(value.hosts) && value.hosts.every(validParticipant)
    && new Set(value.hosts.map((host) => host.id)).size === value.hosts.length
    && typeof value.requiresForce === "boolean" && (value.blockedReason === null || typeof value.blockedReason === "string")
    && typeof value.preparedAt === "string" && Number.isFinite(Date.parse(value.preparedAt))
    && typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))
    && ["prepared", "updating-hosts", "ready", "updating-server", "succeeded", "failed", "recovery-required"].includes(String(value.state))
    && (value.approved === undefined || isRecord(value.approved) && typeof value.approved.force === "boolean" && typeof value.approved.at === "string")
    && (value.error === undefined || typeof value.error === "string");
}

export function getUpgradePlan(id: string): UpgradePlan | null {
  const file = upgradePlanPath(id);
  if (!existsSync(file)) return null;
  assertOwnedPath(file);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!validPlan(value) || value.id !== id) throw new UpgradePlanError("invalid_plan", "Stored upgrade plan is invalid", 500);
  return value;
}

function snapshot(inventory: HostUpgradeInventory[]): string {
  return createHash("sha256").update(JSON.stringify(inventory.map(({ host, sessionProcesses, sessionIds }) => ({
    id: host.id, version: host.ompwebVersion ?? null, protocol: host.hostVersion,
    maintenance: host.apiVersion ?? null, sessions: sessionIds, processes: sessionProcesses,
  })).sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
}

function inside(root: string, file: string): boolean {
  const path = relative(realpathSync(root), realpathSync(file));
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function buildUpgradePlan(input: { id: string; fromVersion: string; targetVersion: string; compatibility: HostUpdateCompatibility; inventory: HostUpgradeInventory[]; sharedLocal: boolean; localMissing: boolean; now?: number }): UpgradePlan {
  const now = input.now ?? Date.now();
  const hosts: UpgradeParticipant[] = input.inventory.map(({ host, sessionProcesses, activeTurns, maintenance }) => {
    const local = host.id === "local";
    const shared = local && input.sharedLocal;
    const missing = local && input.localMissing;
    const incompatible = host.hostVersion === null || host.hostVersion < input.compatibility.min || host.hostVersion > input.compatibility.max;
    const needsUpgrade = shared || missing || incompatible;
    const recovery: UpgradeParticipant["recovery"] = local ? shared ? "shared-local" : "local" : maintenance ? "maintenance" : host.upgradeOnly ? "legacy" : "none";
    const blockedReason = needsUpgrade && !missing && (host.status === "offline" && !maintenance || recovery === "none")
      ? `${host.label || host.id}: host compatibility and recovery could not be established; reconnect it before upgrading the server` : null;
    return {
      id: host.id, label: host.label || host.id, currentVersion: host.ompwebVersion ?? null,
      protocolVersion: host.hostVersion, targetVersion: needsUpgrade ? input.targetVersion : host.ompwebVersion ?? null,
      needsUpgrade, recovery, sessionProcesses: missing ? 0 : sessionProcesses, activeTurns: missing ? 0 : activeTurns,
      blockedReason, stage: needsUpgrade ? "pending" : "unchanged",
    };
  });
  return {
    id: input.id, fromVersion: input.fromVersion, targetVersion: input.targetVersion, compatibility: input.compatibility,
    hosts, requiresForce: hosts.some((host) => host.needsUpgrade && (host.sessionProcesses === null || host.sessionProcesses > 0)),
    blockedReason: hosts.find((host) => host.blockedReason)?.blockedReason ?? null,
    preparedAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_LEASE_MS).toISOString(), state: "prepared",
  };
}

export async function prepareUpgradePlan(attemptId: string, targetVersion: string, fromVersion: string): Promise<UpgradePlan> {
  if (isUpdateDisabled()) throw new UpgradePlanError("updates_disabled", "Updates are disabled on this server", 403);
  const existing = getUpgradePlan(attemptId);
  if (existing) {
    if (existing.targetVersion !== targetVersion || existing.fromVersion !== fromVersion) throw new UpgradePlanError("plan_changed", "The upgrade attempt already belongs to another version");
    return existing;
  }
  const [candidate, inventory] = await Promise.all([candidateIdentity(targetVersion), getHostUpgradeInventory()]);
  let sharedLocal = false, localMissing = false;
  try {
    const local = await requestHostControl("status");
    sharedLocal = inside(resolve(process.env.OMP_WEB_PACKAGE_DIR || process.cwd()), local.executable)
      || inside(resolve(process.env.OMP_WEB_PACKAGE_DIR || process.cwd()), local.entrypoint);
    const packageHost = /[\\/]bin[\\/]omp-web(?:-host)?\.js$/.test(local.entrypoint);
    await inspectUpgradeProcess({
      pid: local.pid, role: "host", installDir: packageHost ? dirname(dirname(local.entrypoint)) : dirname(local.executable),
      launch: { command: local.executable, args: packageHost ? [local.entrypoint, ...(local.entrypoint.endsWith("omp-web.js") ? ["host"] : [])] : ["host"], cwd: process.env.HOME || process.cwd() },
    });
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes(String((error as NodeJS.ErrnoException).code))) localMissing = true;
    else throw new UpgradePlanError("local_host_unknown", "The local host process could not be verified; the server update is blocked");
  }
  const plan = buildUpgradePlan({ id: attemptId, fromVersion, targetVersion, compatibility: candidate.compatibility, inventory, sharedLocal, localMissing });
  await Promise.all(plan.hosts.filter((host) => host.needsUpgrade && host.recovery !== "shared-local" && !(host.id === "local" && localMissing) && !host.blockedReason).map(async (host) => {
    try {
      const status = await getHostSoftwareUpdates(host.id, true, plan.compatibility);
      if (!status.ompweb.updateAvailable || status.ompweb.availableVersion !== targetVersion || !status.ompweb.canUpdate && !status.ompweb.canForceUpdate && host.id !== "local") {
        host.blockedReason = status.ompweb.blockedReason || "This host has no verified update/recovery path to the candidate server version";
      } else if (!status.ompweb.canUpdate || host.recovery === "legacy") plan.requiresForce = true;
    } catch (error) { host.blockedReason = error instanceof Error ? error.message : "The host update path could not be checked"; }
  }));
  plan.blockedReason = plan.hosts.find((host) => host.blockedReason)?.blockedReason ?? null;
  const directory = planDirectory(attemptId, true);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "identity.json"), JSON.stringify({ snapshot: snapshot(inventory), release: candidate.fingerprint }), { flag: "wx", mode: 0o600 });
  writePlan(plan);
  return plan;
}

export async function approveUpgradePlan(attemptId: string, approval: UpgradeApproval): Promise<UpgradePlan> {
  if (isUpdateDisabled()) throw new UpgradePlanError("updates_disabled", "Updates are disabled on this server", 403);
  const plan = getUpgradePlan(attemptId);
  if (!plan || approval.planId !== plan.id || typeof approval.force !== "boolean") throw new UpgradePlanError("plan_mismatch", "Approval does not match this upgrade plan", 400);
  if (plan.approved && plan.approved.force !== approval.force) {
    throw new UpgradePlanError("approval_changed", "An upgrade's force approval cannot change after commit");
  }
  if (plan.state !== "prepared" || Date.parse(plan.expiresAt) <= Date.now()) throw new UpgradePlanError("plan_expired", "The upgrade plan expired; check and approve a new plan", 410);
  if (plan.blockedReason) throw new UpgradePlanError("upgrade_blocked", plan.blockedReason);
  if (plan.requiresForce && !approval.force) throw new UpgradePlanError("force_approval_required", "This update interrupts host sessions or requires forced recovery; explicit approval is required");
  const identityFile = join(planDirectory(attemptId), "identity.json");
  assertOwnedPath(identityFile);
  const identity: unknown = JSON.parse(readFileSync(identityFile, "utf8"));
  const [candidate, inventory, available] = await Promise.all([candidateIdentity(plan.targetVersion), getHostUpgradeInventory(), checkNpmUpdate(true)]);
  if (!isRecord(identity) || identity.release !== candidate.fingerprint || identity.snapshot !== snapshot(inventory)
    || available.availableVersion !== plan.targetVersion || !available.updateAvailable) {
    throw new UpgradePlanError("plan_changed", "The candidate release, registered hosts or affected sessions changed; review a new upgrade plan", 412);
  }
  if (!plan.approved) {
    plan.approved = { force: approval.force, at: new Date().toISOString() };
    writePlan(plan);
  }
  return plan;
}

const coordinating = new Map<string, Promise<UpgradePlan>>();
export function upgradePlannedHosts(attemptId: string): Promise<UpgradePlan> {
  const active = coordinating.get(attemptId);
  if (active) return active;
  const operation = coordinateHosts(attemptId).finally(() => coordinating.delete(attemptId));
  coordinating.set(attemptId, operation);
  return operation;
}

async function coordinateHosts(attemptId: string): Promise<UpgradePlan> {
  const plan = getUpgradePlan(attemptId);
  if (!plan?.approved) throw new UpgradePlanError("approval_required", "The upgrade plan has not been approved");
  if (plan.state === "ready" || plan.state === "updating-server" || plan.state === "succeeded") return plan;
  if (plan.state === "failed" || plan.state === "recovery-required") throw new UpgradePlanError("recovery_required", plan.error || "The previous coordinated update requires recovery");
  plan.state = "updating-hosts";
  writePlan(plan);
  try {
    const registered = hostsSnapshot().hosts.map((host) => host.id).sort();
    if (JSON.stringify(registered) !== JSON.stringify(plan.hosts.map((host) => host.id).sort())) throw new UpgradePlanError("plan_changed", "The registered host set changed before server cutover", 412);
    for (const host of plan.hosts) {
      renewLease(attemptId);
      if (!host.needsUpgrade || host.recovery === "shared-local" || host.stage === "ready") continue;
      if (host.id === "local" && host.currentVersion === null) continue; // Started from the selected release by the server worker.
      host.stage = "updating";
      host.operationId ??= randomUUID();
      writePlan(plan);
      const deadline = Date.now() + upgradePlanTimings.hostTimeoutMs;
      for (;;) {
        renewLease(attemptId);
        try {
          const status = await getHostSoftwareUpdates(host.id, true, plan.compatibility);
          if (status.operation?.state === "failed" && status.operation.id === host.operationId) throw new UpgradePlanError("host_upgrade_failed", `${host.label}: ${status.operation.error || "Host update failed"}`);
          if (status.ompweb.currentVersion === plan.targetVersion && status.operation?.state === "succeeded"
            && status.operation.id === host.operationId && status.operation.version === plan.targetVersion) break;
          if (status.ompweb.currentVersion !== plan.targetVersion && status.operation?.id !== host.operationId) {
            const accepted = await updateHostSoftware(host.id, "ompweb", plan.targetVersion, { force: plan.approved.force, compatibility: plan.compatibility, operationId: host.operationId });
            if (accepted.operation.id !== host.operationId) throw new UpgradePlanError("host_operation_changed", `${host.label} accepted a different update operation`);
          }
        } catch (error) {
          if (!(error instanceof HostOpError && [503, 504].includes(error.status))) throw error;
        }
        if (Date.now() >= deadline) throw new UpgradePlanError("host_upgrade_timeout", `${host.label} did not acknowledge the expected release and update operation; server cutover was not performed`);
        await pause(upgradePlanTimings.pollMs);
      }
      host.stage = "ready";
      writePlan(plan);
    }
    plan.state = "ready";
    writePlan(plan);
    return plan;
  } catch (error) {
    plan.error = error instanceof Error ? error.message : "The coordinated host update failed";
    const host = plan.hosts.find((item) => item.stage === "updating");
    if (host) { host.stage = "failed"; host.error = plan.error; }
    plan.state = plan.hosts.some((item) => item.stage === "ready") ? "recovery-required" : "failed";
    writePlan(plan);
    throw error;
  }
}
