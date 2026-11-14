import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { mock } from "bun:test";

const realHub = await import("./hosts/hub.ts");
const realWorker = await import("./hosts/update-worker.ts");
const realNpm = await import("./npm-update.ts");
mock.module("./hosts/update-worker.ts", () => ({
  ...realWorker,
  fetchHostUpdateBytes: async (url) => Buffer.from(url.includes("raw.githubusercontent.com")
    ? "export const MIN_LINK_PROTOCOL_VERSION = 13;\nexport const LINK_PROTOCOL_VERSION = 13;\n"
    : JSON.stringify({ tag_name: "v0.8.0", assets: [{ name: "ompweb-linux-x64.tar.gz", digest: `sha256:${"a".repeat(64)}` }] })),
}));
mock.module("./npm-update.ts", () => ({ ...realNpm, checkNpmUpdate: async () => ({ availableVersion: "0.8.0", updateAvailable: true }) }));
let participants = [], readStatus, accept;
mock.module("./hosts/hub.ts", () => ({
  ...realHub,
  hostsSnapshot: () => ({ hosts: participants.map(({ host }) => host) }),
  getHostUpgradeInventory: async () => participants,
  getHostSoftwareUpdates: (...args) => readStatus(...args),
  updateHostSoftware: (...args) => accept(...args),
}));
const { buildUpgradePlan, getUpgradePlan, upgradePlanPath, upgradePlannedHosts, upgradePlanTimings, removeUpgradePlan, approveUpgradePlan } = await import("./upgrade-plan.ts");
const state = await import("./self-update-state.ts");
const id = "12345678-1234-4234-8234-123456789012";
const target = "0.8.0";
function fixture(t, count = 2) {
  const root = mkdtempSync(join(tmpdir(), "coordinator-test-"));
  const keys = ["PI_CODING_AGENT_DIR", "TMPDIR", "TMP", "TEMP"];
  const before = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = root;
  const timings = { ...upgradePlanTimings };
  upgradePlanTimings.hostTimeoutMs = 30;
  upgradePlanTimings.pollMs = 1;
  participants = Array.from({ length: count }, (_, i) => ({
    host: { id: `worker-${i}`, label: `Worker ${i}`, status: "online", hostVersion: 12,
      serverVersion: 12, ompwebVersion: "0.7.1", platform: "linux", apiVersion: 1 },
    maintenance: true, sessionProcesses: 0, activeTurns: 0, sessionIds: [],
  }));
  const plan = buildUpgradePlan({ id, fromVersion: "0.7.1", targetVersion: target,
    compatibility: { min: 13, max: 13 }, inventory: participants, sharedLocal: false, localMissing: false });
  plan.approved = { force: true, at: new Date().toISOString() };
  store(plan);
  state.ensureSecureRoot(true);
  state.atomicWrite(state.leasePath(), JSON.stringify({ attemptId: id, expiresAt: Date.now() + 50 }));
  t.after(() => {
    Object.assign(upgradePlanTimings, timings);
    keys.forEach((key, i) => { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; });
    rmSync(root, { recursive: true, force: true });
  });
  return plan;
}
function store(plan) {
  const path = upgradePlanPath(id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(plan), { mode: 0o600 });
}
function receipt(operation, version = target) { return { ompweb: { currentVersion: version }, operation }; }

test("two incompatible hosts upgrade in order and renew the attempt lease while awaiting receipts", async (t) => {
  fixture(t);
  const accepted = new Map(), order = [], polls = new Map();
  accept = async (host, _target, version, options) => {
    order.push(host);
    assert.equal(version, target);
    assert.ok(state.readStateJson(state.leasePath()).expiresAt > Date.now() + 29 * 60_000);
    accepted.set(host, { id: options.operationId, version, state: "running" });
    return { operation: accepted.get(host) };
  };
  readStatus = async (host) => {
    assert.ok(state.readStateJson(state.leasePath()).expiresAt > Date.now() + 29 * 60_000);
    const operation = accepted.get(host);
    if (!operation) return receipt(null, "0.7.1");
    const count = (polls.get(host) ?? 0) + 1;
    polls.set(host, count);
    return receipt({ ...operation, state: count > 1 ? "succeeded" : "running" }, count > 1 ? target : "0.7.1");
  };
  const result = await upgradePlannedHosts(id);
  assert.deepEqual(order, ["worker-0", "worker-1"]);
  assert.equal(result.state, "ready");
  assert.deepEqual(result.hosts.map((host) => host.stage), ["ready", "ready"]);
});

for (const mismatch of ["id", "version"]) test(`a succeeded receipt with another ${mismatch} cannot authorize server cutover`, async (t) => {
  const plan = fixture(t, 1);
  plan.hosts[0].operationId = "87654321-1234-4234-8234-123456789012";
  store(plan);
  readStatus = async () => receipt({ id: mismatch === "id" ? id : plan.hosts[0].operationId,
    version: mismatch === "version" ? "0.9.0" : target, state: "succeeded" });
  accept = async () => { throw new Error("A receipt at the target must not trigger another installation"); };
  await assert.rejects(upgradePlannedHosts(id), { code: "host_upgrade_timeout" });
  assert.equal(getUpgradePlan(id).state, "failed");
});

test("failure on the second host retains the first host's receipt and requires recovery", async (t) => {
  fixture(t);
  const accepted = new Map();
  accept = async (host, _target, version, options) => {
    const operation = { id: options.operationId, version, state: "running" };
    accepted.set(host, operation);
    return { operation };
  };
  readStatus = async (host) => {
    const operation = accepted.get(host);
    if (!operation) return receipt(null, "0.7.1");
    return receipt({ ...operation, state: host === "worker-0" ? "succeeded" : "failed", error: "candidate rejected" });
  };
  await assert.rejects(upgradePlannedHosts(id), { code: "host_upgrade_failed" });
  const plan = getUpgradePlan(id);
  assert.equal(plan.state, "recovery-required");
  assert.deepEqual(plan.hosts.map((host) => host.stage), ["ready", "failed"]);
});

test("resuming a host phase reuses the persisted operation rather than starting a second update", async (t) => {
  const plan = fixture(t, 1);
  Object.assign(plan, { state: "updating-hosts" });
  Object.assign(plan.hosts[0], { stage: "updating", operationId: "87654321-1234-4234-8234-123456789012" });
  store(plan);
  readStatus = async () => receipt({ id: plan.hosts[0].operationId, version: target, state: "succeeded" });
  accept = async () => { throw new Error("Must not restart an acknowledged operation"); };
  assert.equal((await upgradePlannedHosts(id)).state, "ready");
});

test("an interrupted dispatch retries the same operation identity after server restart", async (t) => {
  const plan = fixture(t, 1);
  plan.state = "updating-hosts";
  Object.assign(plan.hosts[0], { stage: "updating", operationId: "87654321-1234-4234-8234-123456789012" });
  store(plan);
  let accepted;
  readStatus = async () => accepted ? receipt({ ...accepted, state: "succeeded" }) : receipt(null, "0.7.1");
  accept = async (_host, _target, version, options) => {
    assert.equal(options.operationId, plan.hosts[0].operationId);
    accepted = { id: options.operationId, version, state: "running" };
    return { operation: accepted };
  };
  assert.equal((await upgradePlannedHosts(id)).state, "ready");
  assert.equal(accepted.id, plan.hosts[0].operationId);
});

test("stored approval does not bypass expiry, and discarded plans leave no artifacts", async (t) => {
  const plan = fixture(t, 1);
  plan.expiresAt = new Date(Date.now() - 1).toISOString();
  store(plan);
  await assert.rejects(approveUpgradePlan(id, { planId: id, force: true }), { code: "plan_expired" });
  removeUpgradePlan(id);
  assert.equal(getUpgradePlan(id), null);
});

test("replaying stored approval still rejects changed release and host inventory", async (t) => {
  fixture(t, 1);
  writeFileSync(join(dirname(upgradePlanPath(id)), "identity.json"), JSON.stringify({ snapshot: "previous inventory", release: "previous release" }), { mode: 0o600 });
  await assert.rejects(approveUpgradePlan(id, { planId: id, force: true }), { code: "plan_changed" });
  assert.equal(getUpgradePlan(id).state, "prepared");
});
