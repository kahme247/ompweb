import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../omp/paths";
import { isRecord } from "../type-guards";
import { recoveryHelperRelease } from "../recovery-release";
import { buildLegacyRecoveryBootstrap, legacyRecoveryEnvelopes, type LegacyRecoveryRelease } from "./legacy-recovery";
import { assertOwnedPath, HOST_VERSION_PATTERN } from "./update-worker";
import { HostOpError } from "./link-protocol";
import type { HostUpdateCompatibility, HostUpdateInfo, HostUpdateOperation } from "./update-types";

interface LegacyUpgradeState {
  hostId: string;
  operation: HostUpdateOperation;
  helper: LegacyRecoveryRelease;
  compatibility: HostUpdateCompatibility;
  platform: string;
  startedAt: number;
  confirmedTerminal?: boolean;
}

export interface LegacyUpgradeTransport {
  open(operationId: string): Promise<string>;
  send(channel: string, lines: string[]): void;
}

function directory(hostId: string, create = false): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(hostId)) throw new HostOpError(400, "invalid_host", "Invalid host recovery identity");
  const parent = join(getAgentDir(), "omp-web", "legacy-updates");
  const root = join(parent, hostId);
  if (create) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    assertOwnedPath(parent, true);
    mkdirSync(root, { mode: 0o700, recursive: true });
  }
  if (existsSync(root)) assertOwnedPath(root, true);
  return root;
}

function writeState(state: LegacyUpgradeState): void {
  const root = directory(state.hostId, true);
  const file = join(root, "status.json");
  if (existsSync(file)) assertOwnedPath(file);
  const temporary = join(root, `${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
  try { renameSync(temporary, file); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function validState(value: unknown, hostId: string): value is LegacyUpgradeState {
  if (!isRecord(value) || value.hostId !== hostId || !isRecord(value.operation) || typeof value.operation.id !== "string"
    || !/^[a-f0-9-]{36}$/.test(value.operation.id) || value.operation.target !== "ompweb"
    || typeof value.operation.version !== "string" || !HOST_VERSION_PATTERN.test(value.operation.version)
    || !["running", "succeeded", "failed"].includes(String(value.operation.state))
    || (value.operation.error !== undefined && typeof value.operation.error !== "string")
    || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)
    || !isRecord(value.compatibility) || typeof value.compatibility.min !== "number" || !Number.isSafeInteger(value.compatibility.min) || value.compatibility.min < 1
    || typeof value.compatibility.max !== "number" || !Number.isSafeInteger(value.compatibility.max) || value.compatibility.max < value.compatibility.min
    || !isRecord(value.helper) || typeof value.helper.version !== "string" || !HOST_VERSION_PATTERN.test(value.helper.version)
    || typeof value.helper.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.helper.repo)
    || (value.helper.tag !== undefined && typeof value.helper.tag !== "string")
    || !Array.isArray(value.helper.assets) || typeof value.platform !== "string"
    || (value.confirmedTerminal !== undefined && typeof value.confirmedTerminal !== "boolean")) return false;
  return value.helper.assets.every((asset) => isRecord(asset) && typeof asset.name === "string"
    && typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(asset.digest));
}

export function readLegacyUpgrade(hostId: string): LegacyUpgradeState | null {
  const file = join(directory(hostId), "status.json");
  if (!existsSync(file)) return null;
  assertOwnedPath(file);
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!validState(value, hostId)) throw new HostOpError(500, "invalid_recovery_state", "Stored host recovery state is invalid");
  return value;
}

function releaseClaim(hostId: string, id: string): void {
  const lock = join(directory(hostId), "lock.json");
  if (!existsSync(lock)) return;
  assertOwnedPath(lock);
  const claim: unknown = JSON.parse(readFileSync(lock, "utf8"));
  if (isRecord(claim) && claim.id === id) unlinkSync(lock);
}

/** A rejected/failed command is not a successful upgrade; the host's own worker claim still prevents concurrent swaps. */
export function rejectLegacyBootstrap(hostId: string, operationId: string, reason: string): void {
  const state = readLegacyUpgrade(hostId);
  if (!state || state.operation.id !== operationId || state.operation.state === "succeeded") return;
  state.operation = { ...state.operation, state: "failed", error: reason.slice(0, 500) };
  state.confirmedTerminal = true;
  writeState(state);
  releaseClaim(hostId, operationId);
}

/** Completion is the authenticated operation receipt, never bootstrap stdout or a health file. */
const RECOVERY_LEASE_MS = 30 * 60 * 1000;

export function observeLegacyUpgrade(hostId: string, info: HostUpdateInfo): HostUpdateOperation | null {
  const state = readLegacyUpgrade(hostId);
  if (!state) return null;
  const receipt = info.operation;
  const matches = receipt?.id === state.operation.id && receipt.target === "ompweb" && receipt.version === state.operation.version;
  if (matches && receipt) {
    if (receipt.state === "running") {
      state.operation = receipt;
      state.confirmedTerminal = false;
      writeState(state);
      return receipt;
    }
    if (receipt.state === "failed" || (receipt.state === "succeeded" && info.ompweb.currentVersion === state.operation.version)) {
      state.operation = receipt;
      state.confirmedTerminal = true;
      writeState(state);
      releaseClaim(hostId, receipt.id);
    }
  }
  if (state.operation.state === "running" && Date.now() - state.startedAt > RECOVERY_LEASE_MS) {
    state.operation = { ...state.operation, state: "failed", error: "no receipt within 30 minutes" };
    state.confirmedTerminal = true;
    writeState(state);
    releaseClaim(hostId, state.operation.id);
  }
  return state.operation;
}

export async function startLegacyUpgrade(input: {
  hostId: string;
  version: string;
  compatibility: HostUpdateCompatibility;
  platform: string;
  transport: LegacyUpgradeTransport;
  operationId?: string;
}): Promise<{ accepted: true; operation: HostUpdateOperation }> {
  if (!HOST_VERSION_PATTERN.test(input.version)) throw new HostOpError(400, "invalid_version", "Invalid recovery target version");
  const previous = readLegacyUpgrade(input.hostId);
  if (previous?.operation.state === "running") {
    if (input.operationId && previous.operation.id === input.operationId && previous.operation.version === input.version) return { accepted: true, operation: previous.operation };
    throw new HostOpError(409, "update_in_progress", "This host already has a recovery operation; reconcile its status before starting another");
  }
  const helper = await recoveryHelperRelease();
  const id = input.operationId ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HostOpError(400, "invalid_operation", "Invalid recovery operation identity");
  const command = buildLegacyRecoveryBootstrap({ operationId: id, helper, targetVersion: input.version, compatibility: input.compatibility, platform: input.platform, force: true });
  const root = directory(input.hostId, true);
  const lock = join(root, "lock.json");
  try { writeFileSync(lock, JSON.stringify({ id }), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HostOpError(409, "update_in_progress", "A previous recovery has not reported a terminal result; recheck the host before retrying");
    throw error;
  }
  const state: LegacyUpgradeState = {
    hostId: input.hostId, operation: { id, target: "ompweb", version: input.version, state: "running" },
    helper, compatibility: input.compatibility, platform: input.platform, startedAt: Date.now(),
  };
  writeState(state);
  try {
    const channel = await input.transport.open(id);
    input.transport.send(channel, legacyRecoveryEnvelopes(command, 1));
  } catch (error) {
    // A transport loss may follow execution. Keep the claim until an authenticated receipt resolves the uncertainty.
    if (error instanceof HostOpError && [400, 403, 404, 409, 501].includes(error.status)) {
      state.operation = { ...state.operation, state: "failed", error: error.message };
      state.confirmedTerminal = true;
      writeState(state);
      releaseClaim(input.hostId, id);
      throw error;
    }
    state.operation.error = "The recovery request lost its response; waiting for the host's authenticated update receipt";
    writeState(state);
  }
  return { accepted: true, operation: state.operation };
}
