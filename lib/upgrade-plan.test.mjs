import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "ompweb-upgrade-plan-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const { approveUpgradePlan, buildUpgradePlan, getUpgradePlan, parseReleaseCompatibility, upgradePlanPath } = await import("./upgrade-plan.ts");
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const id = "12345678-1234-4234-8234-123456789012";
const now = Date.now();
function inventory({ local = false, protocol = 12, maintenance = true, status = "online", processes = 2 } = {}) {
  return {
    host: { id: local ? "local" : "worker", label: local ? "This machine" : "Worker", status,
      hostVersion: protocol, serverVersion: 12, ompwebVersion: "0.7.1", ompVersion: "omp/18.20.0", platform: "win32", lastSeenAt: null,
      workspaceOps: [], ...(maintenance ? { apiVersion: 1 } : {}), ...(status === "needs-upgrade" ? { upgradeOnly: true } : {}),
    },
    maintenance, sessionProcesses: processes, activeTurns: processes > 0 ? 1 : 0, sessionIds: processes > 0 ? ["session-1", "session-2"] : [],
  };
}
function plan(overrides = {}) {
  return buildUpgradePlan({ id, fromVersion: "0.7.1", targetVersion: "0.8.0", compatibility: { min: 12, max: 13 },
    inventory: [inventory()], sharedLocal: false, localMissing: false, now, ...overrides });
}
function store(value) {
  const path = upgradePlanPath(value.id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

test("candidate compatibility uses both bounds and rejects unknown, repeated or inverted declarations", () => {
  assert.deepEqual(parseReleaseCompatibility("// supported hosts\nexport const MIN_LINK_PROTOCOL_VERSION = 10;\nexport const LINK_PROTOCOL_VERSION = 12;\n"), { min: 10, max: 12 });
  for (const source of [
    "export const LINK_PROTOCOL_VERSION = 12;",
    "export const MIN_LINK_PROTOCOL_VERSION = 13;\nexport const LINK_PROTOCOL_VERSION = 12;",
    "export const MIN_LINK_PROTOCOL_VERSION = 10;\nexport const LINK_PROTOCOL_VERSION = 12;\nexport const LINK_PROTOCOL_VERSION = 13;",
    "export const MIN_LINK_PROTOCOL_VERSION = 10;\nexport const LINK_PROTOCOL_VERSION = getVersion();",
  ]) assert.throws(() => parseReleaseCompatibility(source));
});

test("compatible remote hosts keep their release and active sessions during a server update", () => {
  const result = plan();
  assert.equal(result.hosts[0].needsUpgrade, false);
  assert.equal(result.hosts[0].targetVersion, "0.7.1");
  assert.equal(result.requiresForce, false);
  assert.equal(result.blockedReason, null);
});

test("an incompatible managed Windows host participates and requires explicit interruption approval", async () => {
  const result = plan({ inventory: [inventory({ protocol: 10, status: "needs-upgrade" })] });
  assert.equal(result.hosts[0].needsUpgrade, true);
  assert.equal(result.hosts[0].recovery, "maintenance");
  assert.equal(result.hosts[0].targetVersion, "0.8.0");
  assert.equal(result.requiresForce, true);
  store(result);
  await assert.rejects(approveUpgradePlan(id, { planId: id, force: false }), { code: "force_approval_required" });
  assert.equal(getUpgradePlan(id).approved, undefined);
});

test("a missing local daemon remains an initial migration participant without inventing existing sessions", () => {
  const result = plan({ inventory: [inventory({ local: true, protocol: null, maintenance: false, status: "offline", processes: null })], localMissing: true });
  assert.equal(result.hosts[0].needsUpgrade, true);
  assert.equal(result.hosts[0].recovery, "local");
  assert.equal(result.hosts[0].sessionProcesses, 0);
  assert.equal(result.requiresForce, false);
  assert.equal(result.blockedReason, null);
});

test("a shared local install participates even when its old application protocol remains compatible", () => {
  const result = plan({ inventory: [inventory({ local: true })], sharedLocal: true });
  assert.equal(result.hosts[0].recovery, "shared-local");
  assert.equal(result.hosts[0].needsUpgrade, true);
  assert.equal(result.requiresForce, true);
});

test("force does not turn an unreachable incompatible host into an approved server-only cutover", async () => {
  const result = plan({ inventory: [inventory({ protocol: 10, status: "offline", maintenance: false, processes: null })] });
  assert.ok(result.blockedReason);
  store(result);
  await assert.rejects(approveUpgradePlan(id, { planId: id, force: true }), { code: "upgrade_blocked" });
  assert.equal(getUpgradePlan(id).approved, undefined);
});

test("approval is bound to a particular unexpired plan and cannot substitute another id", async () => {
  store(plan({ now: now - 31 * 60_000 }));
  await assert.rejects(approveUpgradePlan(id, { planId: id, force: true }), { code: "plan_expired" });
  await assert.rejects(approveUpgradePlan(id, { planId: "87654321-1234-4234-8234-123456789012", force: true }), { code: "plan_mismatch" });
});

test("corrupt stored participants cannot redirect or authorize an upgrade", () => {
  const result = plan();
  result.hosts[0].id = "../../another-user";
  store(result);
  assert.throws(() => getUpgradePlan(id), { code: "invalid_plan" });
});
