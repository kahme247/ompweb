import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { mock } from "bun:test";

const OLD = "0.1.0";
const NEW = "9.9.9";
const errno = (code) => Object.assign(new Error(code), { code });

// The update's collaborators are faked at their module boundary: the hub-backed plan, the supervisor lifecycle, release
// staging and the host's control endpoint. The state files, the worker bundle and the descriptor are real.
const realUpdateWorker = await import("./hosts/update-worker.ts");
const realProcess = await import("./upgrade-process.ts");
const realHostControl = await import("./hosts/host-control.ts");
const realNpm = await import("./npm-update.ts");
const calls = [];
const fakes = {
  approve: async () => { throw new Error("approve not scripted"); },
  stage: async () => { throw new Error("stage not scripted"); },
  hosts: async () => { throw new Error("hosts not scripted"); },
  control: async () => { throw errno("ENOENT"); },
};
mock.module("./upgrade-plan.ts", () => ({
  prepareUpgradePlan: async (attemptId, targetVersion, fromVersion) => ({ ...planFor(attemptId, targetVersion, fromVersion) }),
  approveUpgradePlan: async (...args) => { calls.push("approve"); return fakes.approve(...args); },
  upgradePlannedHosts: async (...args) => { calls.push("hosts"); return fakes.hosts(...args); },
  getUpgradePlan: (attemptId) => fakes.plan(attemptId),
  removeUpgradePlan: () => {},
}));
mock.module("./upgrade-process.ts", () => ({
  ...realProcess,
  inspectUpgradeProcess: async (input) => { calls.push(`inspect ${input.role}`); inspections.push(input); if (fakes.inspect) await fakes.inspect(input); return { role: input.role, platform: process.platform, pid: input.pid, identity: "id", executable: process.execPath, args: [], installDir: input.installDir, supervisor: { kind: "foreground" }, current: { pid: input.pid, identity: "id" } }; },
  launchDetachedUpgrade: async (launch) => {
    if (launch.args[0] === "--version") { if (fakes.probe) await fakes.probe(); return 4241; }
    calls.push("launch"); launches.push(launch);
    if (fakes.launch) await fakes.launch(launch);
    return 4242;
  },
}));
mock.module("./hosts/update-worker.ts", () => ({
  ...realUpdateWorker,
  stagePackage: async (...args) => { calls.push("stage"); return fakes.stage(...args); },
  stageBinary: async () => { throw new Error("a package install must not stage a binary"); },
  preflightHostRelease: async (...args) => { calls.push("preflight"); if (fakes.preflight) await fakes.preflight(...args); },
}));
mock.module("./hosts/host-control.ts", () => ({ ...realHostControl, requestHostControl: (...args) => fakes.control(...args) }));
mock.module("./npm-update.ts", () => ({
  ...realNpm,
  checkNpmUpdate: async () => ({ currentVersion: OLD, availableVersion: NEW, updateAvailable: true, installMethod: "npm", updateCommand: "" }),
}));
const inspections = [];
const launches = [];

const selfUpdate = await import("./self-update.ts");
const state = await import("./self-update-state.ts");
const { acknowledgeSelfUpdate, acknowledgeSelfUpdateBoot, commitSelfUpdate, getSelfUpdateStatus, parseUpgradeApproval, prepareSelfUpdate, resolveSelfUpdateTempRoot } = selfUpdate;

function planFor(id, targetVersion = NEW, fromVersion = OLD, local = { recovery: "local", sessionProcesses: 0, activeTurns: 0 }) {
  return {
    id, fromVersion, targetVersion, compatibility: { min: 1, max: 1 }, requiresForce: false, blockedReason: null,
    preparedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "prepared",
    hosts: [{ id: "local", label: "This machine", currentVersion: null, protocolVersion: null, targetVersion, needsUpgrade: true, blockedReason: null, stage: "pending", ...local }],
  };
}

const ENV_NAMES = ["TMPDIR", "TEMP", "TMP", "PI_CODING_AGENT_DIR", "PATH", "OMP_WEB_PACKAGE_DIR", "OMP_WEB_PORT", "OMP_WEB_HOSTNAME", "OMP_WEB_LAUNCHER_PID", "OMP_WEB_NODE_BIN", "OMP_WEB_PASSWORD_HASH", "OMP_WEB_DISABLE_AUTOUPDATE"];

/** An installed package (node_modules/@kahme247/ompweb), a package manager on PATH, an update root and a server environment as the launcher gives it. */
function environment(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "self-update-test-")));
  const previous = ENV_NAMES.map((name) => process.env[name]);
  const installDir = join(base, "node_modules", "@kahme247", "ompweb");
  mkdirSync(installDir, { recursive: true });
  for (const directory of [installDir, join(base, "node_modules", "@kahme247"), join(base, "node_modules")]) chmodSync(directory, 0o755);
  for (const file of ["bin/omp-web.js", "bin/omp-web-host.js", "server/main.ts"]) {
    mkdirSync(join(installDir, file, ".."), { recursive: true });
    writeFileSync(join(installDir, file), "");
  }
  mkdirSync(join(base, "tmp"));
  mkdirSync(join(base, "bin"));
  for (const name of process.platform === "win32" ? ["npm.cmd"] : ["npm"]) writeFileSync(join(base, "bin", name), "", { mode: 0o755 });
  Object.assign(process.env, {
    TMPDIR: join(base, "tmp"), TEMP: join(base, "tmp"), TMP: join(base, "tmp"),
    PI_CODING_AGENT_DIR: join(base, "agent"),
    PATH: `${join(base, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    OMP_WEB_PACKAGE_DIR: installDir, OMP_WEB_PORT: "30177", OMP_WEB_HOSTNAME: "127.0.0.1",
    OMP_WEB_LAUNCHER_PID: String(process.ppid), OMP_WEB_NODE_BIN: process.execPath, OMP_WEB_PASSWORD_HASH: "secret-hash",
  });
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  calls.length = 0; inspections.length = 0; launches.length = 0;
  fakes.preflight = undefined;
  fakes.inspect = undefined;
  fakes.probe = undefined;
  fakes.launch = undefined;
  fakes.plan = planFor;
  fakes.control = async () => { throw errno("ENOENT"); };
  fakes.stage = async (_source, staging) => { const release = join(staging, "release"); mkdirSync(release); return release; };
  fakes.approve = async (attemptId) => ({ ...planFor(attemptId), approved: { force: false, at: new Date().toISOString() } });
  fakes.hosts = async (attemptId) => ({ ...planFor(attemptId), state: "ready", approved: { force: false, at: new Date().toISOString() } });
  t.after(() => {
    ENV_NAMES.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    rmSync(base, { recursive: true, force: true });
  });
  return { base, installDir };
}

async function until(check, what) {
  for (let i = 0; i < 1200; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- stored attempt state

function withUpdateState(t, { workerPid, coordinatorPid, leaseExpiresAt, state: attemptState = "running", retainedBackup }) {
  environment(t);
  const root = resolveSelfUpdateTempRoot();
  mkdirSync(root, { mode: 0o700 });
  const attemptId = "2e4c6460-5a8f-4ef7-8d81-42cb688a8bdc";
  if (leaseExpiresAt !== null) writeFileSync(join(root, "lease.json"), JSON.stringify({ attemptId, expiresAt: leaseExpiresAt }), { mode: 0o600 });
  writeFileSync(join(root, "status.json"), JSON.stringify({
    attemptId,
    state: attemptState,
    ...(attemptState === "running" ? { stage: "stopping" } : {}),
    fromVersion: "0.5.2",
    targetVersion: "0.6.0",
    preparedAt: new Date().toISOString(),
    workerPid,
    coordinatorPid,
    retainedBackup,
  }), { mode: 0o600 });
  return { root, statusFile: join(root, "status.json"), leaseFile: join(root, "lease.json"), attemptId };
}

// A pid far above any pid_max, so it is never alive.
const DEAD_PID = 2 ** 30;

test("a running update whose worker died is reported, and stored, as failed", (t) => {
  const { statusFile } = withUpdateState(t, { workerPid: DEAD_PID, leaseExpiresAt: Date.now() + 60_000 });
  const status = getSelfUpdateStatus();
  assert.equal(status.state, "failed");
  assert.equal(status.cleanupReady, true);
  assert.match(status.error, /worker stopped/);
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).state, "failed");
});

test("a lost worker that was replacing the installation says where the previous one is kept", (t) => {
  withUpdateState(t, { workerPid: DEAD_PID, leaseExpiresAt: Date.now() + 60_000, retainedBackup: "/srv/.ompweb-server-backup-x" });
  assert.match(getSelfUpdateStatus().error, /partially replaced.*\/srv\/\.ompweb-server-backup-x/);
});

test("a running update past its lease is failed even when its pid is alive (reused)", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() - 1 });
  assert.equal(getSelfUpdateStatus().state, "failed");
});

test("a running update with a live worker inside its lease stays running, and the internals stay private", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() + 60_000, retainedBackup: "/x" });
  const status = getSelfUpdateStatus();
  assert.equal(status.state, "running");
  assert.equal("workerPid" in status || "coordinatorPid" in status || "retainedBackup" in status, false);
});

test("an update coordinated by a server process that died before the worker existed is failed", (t) => {
  withUpdateState(t, { coordinatorPid: DEAD_PID, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus().state, "failed");
});

test("a running update coordinated by a live server stays running before its worker pid is recorded", (t) => {
  withUpdateState(t, { coordinatorPid: process.pid, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus().state, "running");
});

test("a running update without a lease is failed", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: null });
  assert.equal(getSelfUpdateStatus().state, "failed");
});

// ---------------------------------------------------------------- boot proof and cleanup

test("the restarted server proves its release only to the expectation the worker wrote", (t) => {
  const { attemptId, root } = withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() + 60_000 });
  acknowledgeSelfUpdateBoot();
  assert.equal(existsSync(join(root, `${attemptId}.boot.json`)), false, "no expectation: no proof");
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  writeFileSync(join(root, `${attemptId}.expect.json`), JSON.stringify({ attemptId, version: "0.0.1", nonce: "n" }), { mode: 0o600 });
  acknowledgeSelfUpdateBoot();
  assert.equal(existsSync(join(root, `${attemptId}.boot.json`)), false, "another release expected: no proof");
  writeFileSync(join(root, `${attemptId}.expect.json`), JSON.stringify({ attemptId, version, nonce: "n" }), { mode: 0o600 });
  acknowledgeSelfUpdateBoot();
  assert.deepEqual(JSON.parse(readFileSync(join(root, `${attemptId}.boot.json`), "utf8")), { attemptId, version, nonce: "n", pid: process.pid });
});

test("acknowledging a finished update removes its files, including what older releases wrote", (t) => {
  const { attemptId, root } = withUpdateState(t, { state: "succeeded", leaseExpiresAt: Date.now() + 60_000 });
  const attemptDir = join(root, "attempts", attemptId);
  mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  for (const file of ["descriptor.json", "launch-env.json", "worker.mjs", "worker.js", "worker.lock", "runtime"]) writeFileSync(join(attemptDir, file), "x", { mode: 0o600 });
  for (const marker of ["expect.json", "boot.json", "ready", "armed.json", "complete.json", "complete-ack.json"]) writeFileSync(join(root, `${attemptId}.${marker}`), "{}", { mode: 0o600 });
  assert.deepEqual(acknowledgeSelfUpdate(attemptId), { acknowledged: true, attemptId });
  assert.equal(existsSync(root), false);
});

test("an attempt directory holding anything else is not deleted", (t) => {
  const { attemptId, root } = withUpdateState(t, { state: "failed", leaseExpiresAt: Date.now() + 60_000 });
  mkdirSync(join(root, "attempts", attemptId), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "attempts", attemptId, "keep-me.txt"), "x", { mode: 0o600 });
  assert.throws(() => acknowledgeSelfUpdate(attemptId), { code: "unsafe_update_state" });
  assert.equal(existsSync(join(root, "attempts", attemptId, "keep-me.txt")), true);
});

test("only a plan id and an explicit Force boolean make an approval", () => {
  assert.deepEqual(parseUpgradeApproval({ planId: "a", force: true }), { planId: "a", force: true });
  for (const bad of [null, [], {}, { planId: "a" }, { planId: "a", force: "yes" }, { planId: "", force: false }, { planId: "a", force: false, hosts: ["x"] }, { planId: 1, force: false }]) {
    assert.throws(() => parseUpgradeApproval(bad), { code: "invalid_approval" });
  }
});

// ---------------------------------------------------------------- prepare and commit

test("a plan nobody approved does not lock updates: preparing again replaces it", async (t) => {
  environment(t);
  const first = await prepareSelfUpdate();
  assert.equal(first.plan.id, first.attemptId);
  const second = await prepareSelfUpdate();
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(getSelfUpdateStatus().attemptId, second.attemptId);
});

test("a running update is never replaced by a new prepare", async (t) => {
  environment(t);
  const { attemptId } = await prepareSelfUpdate();
  state.patchStatus(attemptId, { state: "running", stage: "installing" });
  await assert.rejects(prepareSelfUpdate(), { code: "update_in_progress" });
});

test("an installation that is not a package or a release directory is not updated in place", async (t) => {
  const { installDir } = environment(t);
  process.env.OMP_WEB_PACKAGE_DIR = join(installDir, "bin");
  await assert.rejects(prepareSelfUpdate(), { code: "self_update_unsupported" });
  assert.equal(selfUpdate.getSelfUpdateSupport().supported, false);
});

test("a rejected approval leaves the attempt prepared and approvable", async (t) => {
  environment(t);
  const { attemptId } = await prepareSelfUpdate();
  fakes.approve = async () => { throw Object.assign(new Error("The candidate release changed"), { httpStatus: 412 }); };
  await assert.rejects(commitSelfUpdate(attemptId, { planId: attemptId, force: false }), /candidate release changed/);
  assert.equal(getSelfUpdateStatus().state, "prepared");
  assert.deepEqual(calls.filter((call) => ["stage", "hosts", "launch"].includes(call)), []);
});

test("a commit stages and preflights the release before updating hosts, then launches the detached worker", async (t) => {
  const { installDir } = environment(t);
  const { attemptId } = await prepareSelfUpdate();
  assert.deepEqual(await commitSelfUpdate(attemptId, { planId: attemptId, force: false }), { accepted: true, attemptId });
  // A replay while it runs is accepted, never a second commit.
  assert.deepEqual(await commitSelfUpdate(attemptId, { planId: attemptId, force: false }), { accepted: true, attemptId });
  await until(() => launches.length > 0, "the worker launch");
  assert.ok(calls.indexOf("preflight") < calls.indexOf("hosts"));
  assert.ok(calls.indexOf("hosts") < calls.indexOf("launch"));
  // The launcher is the supervised process: its pid is inspected, and the restart goes through it with the listen address.
  assert.equal(inspections[0].pid, process.ppid);
  assert.deepEqual(inspections[0].launch.args.slice(1), ["-p", "30177", "-H", "127.0.0.1", "--no-open"]);
  assert.equal(inspections[0].launch.cwd, installDir);

  const [launch] = launches;
  const root = resolveSelfUpdateTempRoot();
  const attemptDir = join(root, "attempts", attemptId);
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, [join(attemptDir, "worker.mjs"), "--server-update-descriptor", join(attemptDir, "descriptor.json")]);
  assert.ok(existsSync(launch.args[0]), "the Node bundle of the worker is built before the cutover");
  // Neither the web password hash nor launcher plumbing reaches the helper: it runs npm, candidate preflights and a daemon.
  assert.equal(launch.env.OMP_WEB_PASSWORD_HASH, undefined);
  assert.equal(launch.env.OMP_WEB_LAUNCHER_PID, undefined);

  const descriptorText = readFileSync(join(attemptDir, "descriptor.json"), "utf8");
  assert.ok(!descriptorText.includes("secret-hash"));
  const restartEnvironment = JSON.parse(readFileSync(join(attemptDir, "launch-env.json"), "utf8"));
  assert.equal(restartEnvironment.OMP_WEB_PASSWORD_HASH, "secret-hash");
  assert.equal("OMP_WEB_LAUNCHER_PID" in restartEnvironment, false);
  const descriptor = JSON.parse(descriptorText);
  assert.equal(descriptor.installMethod, "npm");
  assert.equal(descriptor.installDir, installDir);
  assert.equal(descriptor.localHost.kind, "absent");
  assert.equal(descriptor.participantId, "local");
  assert.equal(descriptor.interruptSessions, false);
  assert.equal(descriptor.release, join(dirname(installDir), `.ompweb-server-staging-${attemptId}`, "release"));

  // What the server wrote is exactly what the worker accepts.
  const worker = await import("./server-update-worker.ts");
  assert.equal(worker.readServerUpdateDescriptor(join(attemptDir, "descriptor.json")).targetVersion, NEW);
  const status = state.readStateJson(state.statusPath());
  assert.equal(status.workerPid, 4242);
  assert.equal(status.coordinatorPid, undefined);
  assert.equal(status.state, "running");
});

test("on Windows the update state and the restart environment are reachable by this account and SYSTEM only, whatever the temporary directory grants", { skip: process.platform !== "win32" && `Windows permissions are tested only on Windows (this host is ${process.platform})`, timeout: 120_000 }, async (t) => {
  const { base } = environment(t);
  // Who each path lets in, explicit and inherited alike, in one PowerShell run.
  const sidsOf = (...paths) => {
    const lines = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `foreach ($p in @(${paths.map((path) => `'${path}'`).join(",")})) { foreach ($r in (Get-Acl -LiteralPath $p).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) { $p + '|' + $r.IdentityReference.Value } }`], { encoding: "utf8", windowsHide: true, timeout: 60000 }).split(/\r?\n/).filter(Boolean);
    return Object.fromEntries(paths.map((path) => [path, [...new Set(lines.filter((line) => line.startsWith(`${path}|`)).map((line) => line.slice(path.length + 1)))].sort()]));
  };
  // Every user may read the temporary directory the update state is created in, as in a shared TEMP.
  execFileSync("icacls", [join(base, "tmp"), "/grant", "*S-1-5-32-545:(OI)(CI)RX"], { windowsHide: true });
  const control = join(base, "tmp", "control.txt");
  writeFileSync(control, "");
  assert.ok(sidsOf(control)[control].includes("S-1-5-32-545"), "what the temporary directory holds is readable by every user");

  const { attemptId } = await prepareSelfUpdate();
  await commitSelfUpdate(attemptId, { planId: attemptId, force: false });
  await until(() => launches.length > 0, "the worker launch");
  const [self] = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-\d+(?:-\d+)+/);
  const expected = [...new Set([self, "S-1-5-18"])].sort();
  const root = resolveSelfUpdateTempRoot();
  const attemptDir = join(root, "attempts", attemptId);
  const reachable = sidsOf(root, join(root, "status.json"), join(root, "attempts"), attemptDir, join(attemptDir, "descriptor.json"), join(attemptDir, "launch-env.json"));
  for (const [path, sids] of Object.entries(reachable)) assert.deepEqual(sids, expected, `${path} is reachable by this account and SYSTEM only`);
});

test("a release that fails its preflight is found before any host or process is touched", async (t) => {
  const { installDir } = environment(t);
  fakes.preflight = async () => { throw new Error("The new host release cannot start a session"); };
  const { attemptId } = await prepareSelfUpdate();
  await commitSelfUpdate(attemptId, { planId: attemptId, force: false });
  await until(() => getSelfUpdateStatus()?.state === "failed", "the failed attempt");
  assert.match(getSelfUpdateStatus().error, /cannot start a session/);
  assert.deepEqual(calls.filter((call) => call === "hosts" || call === "launch"), []);
  assert.equal(existsSync(join(installDir, "..", `.ompweb-server-staging-${attemptId}`)), false);
});

test("a host update that fails stops the attempt before the server is touched", async (t) => {
  environment(t);
  fakes.hosts = async () => { throw new Error("Remote did not acknowledge the expected release"); };
  const { attemptId } = await prepareSelfUpdate();
  await commitSelfUpdate(attemptId, { planId: attemptId, force: false });
  await until(() => getSelfUpdateStatus()?.state === "failed", "the failed attempt");
  assert.match(getSelfUpdateStatus().error, /did not acknowledge/);
  assert.equal(launches.length, 0);
});

test("a server whose supervisor cannot be controlled is refused at commit, before anything changes", async (t) => {
  environment(t);
  const { attemptId } = await prepareSelfUpdate();
  fakes.inspect = async () => { throw new Error("Unit ompweb.service is not what was inspected"); };
  await assert.rejects(commitSelfUpdate(attemptId, { planId: attemptId, force: false }), { code: "not_controllable", httpStatus: 409, message: /server cannot be restarted safely.*not what was inspected/ });
  assert.equal(getSelfUpdateStatus().state, "prepared");
  assert.deepEqual(calls.filter((call) => call === "stage" || call === "hosts" || call === "launch"), []);
});

test("a local host that now shares the server's installation but was not planned as shared is refused", async (t) => {
  const { installDir } = environment(t);
  fakes.control = async () => ({ pid: process.pid, version: OLD, protocol: 1, linked: true, drained: false, executable: process.execPath, entrypoint: join(installDir, "bin", "omp-web-host.js") });
  const { attemptId } = await prepareSelfUpdate();
  await assert.rejects(commitSelfUpdate(attemptId, { planId: attemptId, force: false }), { code: "plan_changed" });
  assert.equal(getSelfUpdateStatus().state, "prepared");
  assert.deepEqual(calls.filter((call) => call === "stage" || call === "hosts" || call === "launch"), []);
});

test("a shared local host with sessions is captured for the worker with the approved interruption", async (t) => {
  const { installDir } = environment(t);
  fakes.control = async () => ({ pid: process.pid, version: OLD, protocol: 1, linked: true, drained: false, executable: process.execPath, entrypoint: join(installDir, "bin", "omp-web-host.js") });
  const shared = (attemptId, force) => ({ ...planFor(attemptId, NEW, OLD, { recovery: "shared-local", sessionProcesses: 2, activeTurns: 1 }), requiresForce: true, approved: { force, at: new Date().toISOString() } });
  fakes.approve = async (attemptId) => shared(attemptId, true);
  fakes.plan = (attemptId) => shared(attemptId, true);
  fakes.hosts = async (attemptId) => ({ ...shared(attemptId, true), state: "ready" });
  const { attemptId } = await prepareSelfUpdate();
  await commitSelfUpdate(attemptId, { planId: attemptId, force: true });
  await until(() => launches.length > 0, "the worker launch");
  assert.deepEqual(inspections.map((input) => input.role), ["server", "host"]);
  const descriptor = JSON.parse(readFileSync(join(resolveSelfUpdateTempRoot(), "attempts", attemptId, "descriptor.json"), "utf8"));
  assert.equal(descriptor.localHost.kind, "shared");
  assert.equal(descriptor.localHost.process.pid, process.pid);
  assert.equal(descriptor.interruptSessions, true);
  assert.equal(descriptor.participantId, "local");
});

test("a detached launch refusal leaves hosts unchanged and the plan unapproved", async (t) => {
  environment(t);
  fakes.probe = async () => { throw new Error("permission denied"); };
  const { attemptId } = await prepareSelfUpdate();
  await assert.rejects(commitSelfUpdate(attemptId, { planId: attemptId, force: false }), { code: "not_controllable" });
  assert.equal(getSelfUpdateStatus().state, "prepared");
  assert.equal(calls.includes("approve"), false);
  assert.equal(calls.includes("hosts"), false);
});

test("a cutover launch failure after a remote host moved requires recovery", async (t) => {
  environment(t);
  const { attemptId } = await prepareSelfUpdate();
  const moved = { ...planFor(attemptId), hosts: [{ ...planFor(attemptId).hosts[0], id: "worker", recovery: "maintenance", stage: "ready" }] };
  fakes.plan = () => moved;
  const planFile = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "server-upgrades", attemptId, "plan.json");
  mkdirSync(dirname(planFile), { recursive: true, mode: 0o700 });
  writeFileSync(planFile, JSON.stringify(moved), { mode: 0o600 });
  fakes.launch = async () => { throw new Error("launch denied after host upgrade"); };
  await commitSelfUpdate(attemptId, { planId: attemptId, force: false });
  await until(() => getSelfUpdateStatus()?.state === "failed", "the failed cutover");
  assert.match(getSelfUpdateStatus().error, /launch denied/);
  assert.equal(JSON.parse(readFileSync(planFile, "utf8")).state, "recovery-required");
});

test("an interrupted approved host phase resumes without resubmitting approval or restaging", async (t) => {
  const { installDir } = environment(t);
  const { attemptId } = await prepareSelfUpdate();
  const attemptDir = join(state.attemptsDir(true), attemptId);
  mkdirSync(attemptDir);
  writeFileSync(join(attemptDir, "job.json"), JSON.stringify({ attemptId }));
  const staging = join(dirname(installDir), `.ompweb-server-staging-${attemptId}`);
  const release = join(staging, "release");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(attemptDir, "release.json"), JSON.stringify({ release }));
  state.patchStatus(attemptId, { state: "running", coordinatorPid: DEAD_PID });
  fakes.plan = () => ({ ...planFor(attemptId), state: "updating-hosts", approved: { force: false, at: new Date().toISOString() } });
  assert.equal(getSelfUpdateStatus().state, "running");
  await selfUpdate.resumeCoordinatedSelfUpdate();
  await until(() => launches.length === 1, "the resumed cutover");
  assert.equal(calls.includes("approve"), false);
  assert.equal(calls.includes("stage"), false);
  assert.equal(calls.includes("preflight"), true);
  assert.equal(calls.includes("hosts"), true);
  assert.equal(state.readStateJson(state.statusPath()).workerPid, 4242);
});
