// `ompweb recover-host` / startHostRecovery against a real private control endpoint (a Unix socket, or the named pipe and
// descriptor on Windows) served by this test as the old host. Only what a test cannot do for real is replaced: the
// lifecycle inspection of the old host and the launch of the detached worker (the worker's own flow is covered by
// update-worker.test.mjs), the release protocol lookup, and the registry.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { nodeBinary } from "./update-fixture.test-helper.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "host-recovery-")));
const saved = { ...process.env };
const agent = join(base, "agent");
const stateRoot = join(agent, "omp-web", "host-update");
const install = join(base, "npm", "lib", "node_modules", "@kahme247", "ompweb");
const OPERATION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const children = [];
let recovery;
let control;
let updates;
let endpoint;
let calls;
let behaviour;
let oldHost;
async function waitForFile(path) {
  for (const deadline = Date.now() + 5000; !existsSync(path);) {
    if (Date.now() > deadline) throw new Error(`Test process did not become ready: ${path}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

before(async () => {
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  // A package manager on PATH, as an npm-installed host's session environment has.
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const manager = join(bin, process.platform === "win32" ? "npm.cmd" : "npm");
  writeFileSync(manager, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
  process.env.PATH = bin + delimiter + process.env.PATH;
  mkdirSync(join(install, "bin"), { recursive: true });
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: "0.6.0" }));
  writeFileSync(join(install, "bin", "omp-web-host.js"), 'if(process.argv[2]) require("node:fs").writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)');
  for (let dir = install; dir !== base; dir = dirname(dir)) chmodSync(dir, 0o755);
  recovery = await import("./recovery.ts");
  control = await import("./host-control.ts");
  updates = await import("./updates.ts");
  mkdirSync(agent, { recursive: true });
  const ready = join(base, "old-host-ready");
  oldHost = spawn(nodeBinary(), [join(install, "bin", "omp-web-host.js"), ready], { stdio: "ignore" });
  children.push(oldHost);
  await waitForFile(ready);
  // The old host's private control endpoint; `behaviour` scripts what it answers.
  behaviour = { drained: false, drainError: undefined };
  calls = [];
  endpoint = await control.createHostControlServer((command) => {
    calls.push(command);
    if (command === "drain" && behaviour.drainError) throw behaviour.drainError;
    if (command === "drain") behaviour.drained = true;
    if (command === "resume") behaviour.drained = false;
    return { pid: oldHost.pid, version: "0.6.0", protocol: 10, linked: true, drained: behaviour.drained, executable: nodeBinary(), entrypoint: join(install, "bin", "omp-web-host.js") };
  }, agent);
});
after(async () => {
  await endpoint?.close();
  for (const child of children) child.kill();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true }); } catch (error) { if (tries === 50) throw error; await new Promise((done) => setTimeout(done, 100)); }
  }
});

const fresh = () => { rmSync(stateRoot, { recursive: true, force: true }); behaviour.drained = false; behaviour.drainError = undefined; calls.length = 0; };
const plan = () => ({ role: "host", platform: process.platform, pid: oldHost.pid, identity: "stand-in", executable: nodeBinary(), args: [], installDir: install, supervisor: { kind: "foreground" }, current: { pid: oldHost.pid, identity: "stand-in" } });
/** The real control endpoint, shared-install check and release repository; the rest as stand-ins that record what they were given. */
function dependencies(overrides = {}) {
  const launches = [];
  return {
    launches,
    deps: {
      ...recovery.hostRecoveryDependencies,
      inspect: async () => plan(),
      protocol: async () => 12,
      launchWorker: async (root, descriptor, style) => {
        launches.push({ root, descriptor, style });
        // What the real launch leaves behind before it starts the worker.
        mkdirSync(join(root, descriptor.id), { mode: 0o700 });
        writeFileSync(join(root, descriptor.id, "descriptor.json"), JSON.stringify(descriptor), { mode: 0o600 });
        return 4242;
      },
      ...overrides,
    },
  };
}
const input = (extra = {}) => ({ operationId: OPERATION, version: "0.8.0", compatibility: { min: 12, max: 12 }, force: false, ...extra });
const refusal = (state, code) => (error) => error instanceof recovery.HostRecoveryRefusal && error.state === state && error.code === code;
const status = () => JSON.parse(readFileSync(join(stateRoot, "status.json"), "utf8"));


test("the CLI's arguments are strict: every flag once, values as separate arguments, nothing else", () => {
  const good = ["--operation", OPERATION, "--version", "0.8.0", "--min-protocol", "12", "--max-protocol", "13"];
  assert.deepEqual(recovery.parseHostRecoveryArgs(good), { operationId: OPERATION, version: "0.8.0", compatibility: { min: 12, max: 13 }, force: false });
  assert.equal(recovery.parseHostRecoveryArgs([...good, "--force"]).force, true);
  assert.equal(recovery.parseHostRecoveryArgs(["--force", ...good]).force, true);
  const without = (flag) => { const at = good.indexOf(flag); return good.filter((_, index) => index !== at && index !== at + 1); };
  for (const bad of [
    [], without("--operation"), without("--version"), without("--min-protocol"), without("--max-protocol"),
    [...good, "--force", "--force"], [...good, "--version", "0.9.0"], [...good, "extra"], [...good, "--unknown"],
    good.map((value) => (value === "--version" ? "--version=0.8.0" : value)).filter((value) => value !== "0.8.0"),
    good.map((value) => (value === OPERATION ? "not-a-uuid" : value)),
    good.map((value) => (value === "0.8.0" ? "0.8" : value)),
    good.map((value) => (value === "0.8.0" ? "0.8.0; touch x" : value)),
    good.map((value) => (value === "12" ? "0" : value)),
    good.map((value) => (value === "12" ? "1e3" : value)),
    good.map((value) => (value === "13" ? "11" : value)),
    [...good.slice(0, 3), "--min-protocol", ...good.slice(4)],
  ]) assert.throws(() => recovery.parseHostRecoveryArgs(bad), Error, JSON.stringify(bad));
});

test("an idle host is drained through its private control endpoint, then recovered by a detached worker whose descriptor is durable", async () => {
  fresh();
  const { deps, launches } = dependencies();
  const accepted = await recovery.startHostRecovery(input(), deps);
  assert.deepEqual(accepted, { accepted: true, operation: { id: OPERATION, target: "ompweb", version: "0.8.0", state: "running" } });
  assert.equal(behaviour.drained, true, "recovery cannot commit an idle-only update without the old host's drain");
  assert.equal(launches.length, 1);
  const { descriptor } = launches[0];
  assert.deepEqual([descriptor.id, descriptor.version, descriptor.fromVersion, descriptor.installMethod, descriptor.installDir, descriptor.daemonPid], [OPERATION, "0.8.0", "0.6.0", "npm", install, oldHost.pid]);
  assert.deepEqual([descriptor.force, descriptor.receipt, descriptor.recovery, descriptor.process], [undefined, { min: 12, max: 12 }, { drained: true }, plan()]);
  assert.match(descriptor.managerPath, /npm(\.cmd)?$/);
  assert.equal(descriptor.releaseRepo, recovery.hostRecoveryDependencies.repo());
  assert.deepEqual(status().operation, accepted.operation);
  assert.equal(JSON.parse(readFileSync(join(stateRoot, "lock.json"), "utf8")).id, OPERATION, "the claim stays held while the worker runs");
});

test("a retry of the same operation returns its state and starts nothing; a different request under the id is refused", async () => {
  fresh();
  const { deps, launches } = dependencies();
  const first = await recovery.startHostRecovery(input(), deps);
  assert.deepEqual(await recovery.startHostRecovery(input(), deps), first);
  assert.equal(launches.length, 1);
  assert.deepEqual(calls, ["status", "drain"], "the retry did not touch the host again");
  await assert.rejects(recovery.startHostRecovery(input({ force: true }), deps), refusal("failed", "operation_conflict"));
  await assert.rejects(recovery.startHostRecovery(input({ version: "0.9.0" }), deps), refusal("failed", "operation_conflict"));
  await assert.rejects(recovery.startHostRecovery(input({ compatibility: { min: 12, max: 13 } }), deps), refusal("failed", "operation_conflict"));
  // A later update replaced the record: the old operation can no longer be reported.
  writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation: { id: "later", target: "ompweb", version: "0.9.0", state: "failed" }, startedAt: Date.now(), daemonPid: process.pid }), { mode: 0o600 });
  await assert.rejects(recovery.startHostRecovery(input(), deps), refusal("failed", "operation_superseded"));
});

test("a busy host is refused without force, nothing is claimed, and the same request with force skips the drain and records the force", async () => {
  fresh();
  behaviour.drainError = Object.assign(new Error("Close this host's sessions before updating its daemon."), { code: "host_busy" });
  const { deps, launches } = dependencies();
  await assert.rejects(recovery.startHostRecovery(input(), deps), (error) => refusal("blocked", "host_busy")(error) && error.forceable === true);
  assert.equal(launches.length, 0);
  assert.equal(existsSync(join(stateRoot, "lock.json")), false, "the claim was released");
  assert.equal(existsSync(join(stateRoot, "status.json")), false, "nothing was recorded");
  calls.length = 0;
  const forced = await recovery.startHostRecovery(input({ force: true }), deps);
  assert.deepEqual(forced.operation, { id: OPERATION, target: "ompweb", version: "0.8.0", state: "running", force: true });
  assert.deepEqual(calls, ["status"], "a force never drains: the sessions end at the worker's commit");
  assert.deepEqual([launches[0].descriptor.force, launches[0].descriptor.recovery], [true, { drained: false }]);
});

test("force waives only activity: a disabled updater, a drained host, an unsupported install, an unverified or out-of-range release and an uncontrollable supervisor still refuse", async () => {
  const cases = [
    ["updates_disabled", "blocked", {}, () => { process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1"; return () => delete process.env.OMP_WEB_DISABLE_AUTOUPDATE; }],
    ["host_drained", "blocked", {}, () => { behaviour.drained = true; return () => {}; }],
    ["protocol_unverified", "failed", { protocol: async () => null }],
    ["protocol_incompatible", "failed", { protocol: async () => 13 }],
    ["supervisor_unsupported", "blocked", { inspect: async () => { throw new Error("This process runs from a shell command that loops"); } }],
    ["unsupported_install", "blocked", { shared: async () => "Cannot establish that this installation is host-only; update it manually" }],
  ];
  for (const [code, state, overrides, arrange] of cases) {
    fresh();
    const restore = arrange?.();
    try {
      const { deps, launches } = dependencies(overrides);
      await assert.rejects(recovery.startHostRecovery(input({ force: true }), deps), refusal(state, code), code);
      assert.equal(launches.length, 0, code);
      assert.equal(existsSync(join(stateRoot, "lock.json")), false, code);
      assert.ok(!calls.includes("drain"), code);
    } finally { restore?.(); }
  }
});

test("an installation an independent process uses is left to the server's coordinated worker", async () => {
  fresh();
  const ready = join(base, "independent-process-ready");
  const web = spawn(nodeBinary(), [join(install, "bin", "omp-web-host.js"), ready], { stdio: "ignore" });
  children.push(web);
  await waitForFile(ready);
  try {
    const { deps, launches } = dependencies();
    await assert.rejects(recovery.startHostRecovery(input({ force: true }), deps), refusal("coordination_required", "shared_install"));
    assert.equal(launches.length, 0);
    assert.equal(existsSync(join(stateRoot, "status.json")), false);
  } finally { web.kill(); }
});

/** The installation's manifest names `version`, as after a server cutover already replaced the shared files; the returned function restores it. */
function installHolds(version) {
  const manifest = join(install, "package.json");
  const original = readFileSync(manifest, "utf8");
  writeFileSync(manifest, JSON.stringify({ name: "@kahme247/ompweb", version }));
  return () => writeFileSync(manifest, original);
}

test("a release already on disk is only restarted into: a sharing web server stays up, nothing is replaced and no package manager is needed", async () => {
  fresh();
  const ready = join(base, "restart-only-web-ready");
  const web = spawn(nodeBinary(), [join(install, "bin", "omp-web-host.js"), ready], { stdio: "ignore" });
  children.push(web);
  await waitForFile(ready);
  const manager = join(base, "bin", process.platform === "win32" ? "npm.cmd" : "npm");
  const managerText = readFileSync(manager);
  const restore = installHolds("0.8.0");
  rmSync(manager);
  try {
    // The real sharing inventory finds the web server; an inventory that cannot be established is no reason either, since no file is replaced.
    for (const shared of [undefined, async () => "Cannot establish that this installation is host-only; update it manually"]) {
      fresh();
      const { deps, launches } = dependencies(shared ? { shared } : {});
      const accepted = await recovery.startHostRecovery(input({ force: true }), deps);
      assert.deepEqual(accepted.operation, { id: OPERATION, target: "ompweb", version: "0.8.0", state: "running", force: true });
      assert.equal(launches.length, 1);
      const { descriptor } = launches[0];
      assert.deepEqual([descriptor.restartOnly, descriptor.managerPath, descriptor.installDir, descriptor.daemonPid, descriptor.fromVersion], [true, undefined, install, oldHost.pid, "0.6.0"]);
      assert.equal(web.exitCode === null && web.signalCode === null, true, "the web server sharing the installation was not touched");
    }
    // Replacing files under that web server is still left to the server's coordinated worker.
    restore();
    fresh();
    const { deps, launches } = dependencies();
    await assert.rejects(recovery.startHostRecovery(input({ force: true }), deps), refusal("coordination_required", "shared_install"));
    assert.equal(launches.length, 0);
  } finally {
    restore();
    writeFileSync(manager, managerText, { mode: 0o755 });
    // Gone before the next test: the real sharing inventory would still see it.
    if (web.exitCode === null && web.signalCode === null) {
      const exited = new Promise((done) => web.once("exit", done));
      web.kill();
      await exited;
    }
  }
});

test("a host whose supervisor also supervises the web server is not restarted alone; a separate or unreadable server supervisor is", async () => {
  fresh();
  const restore = installHolds("0.8.0");
  const unit = { kind: "systemd", unit: "ompweb-both.service", user: true, configHash: "same" };
  const supervisors = (server) => ({ inspect: async ({ role }) => (role === "host" ? { ...plan(), supervisor: unit } : server()) });
  try {
    const both = dependencies(supervisors(async () => ({ ...plan(), role: "server", supervisor: unit })));
    await assert.rejects(recovery.startHostRecovery(input({ force: true }), both.deps), refusal("blocked", "supervisor_shared"));
    assert.equal(both.launches.length, 0);
    assert.equal(existsSync(join(stateRoot, "lock.json")), false);
    for (const server of [async () => ({ ...plan(), role: "server", supervisor: { ...unit, unit: "ompweb-host.service" } }), async () => { throw new Error("not a web server process"); }]) {
      fresh();
      const { deps, launches } = dependencies(supervisors(server));
      assert.equal((await recovery.startHostRecovery(input({ force: true }), deps)).operation.state, "running");
      assert.deepEqual([launches[0].descriptor.restartOnly, launches[0].descriptor.process.supervisor], [true, unit]);
    }
  } finally { restore(); }
});

test("checking a recovery reports what a forced start would refuse and touches nothing", async () => {
  fresh();
  const request = { version: "0.8.0", compatibility: { min: 12, max: 12 } };
  const { deps, launches } = dependencies();
  await recovery.checkHostRecovery(request, deps);
  assert.deepEqual(calls, ["status"], "no drain: an idle or busy host is left as it is");
  assert.equal(launches.length, 0);
  assert.equal(existsSync(join(stateRoot, "lock.json")), false);
  behaviour.drained = true;
  await assert.rejects(recovery.checkHostRecovery(request, deps), refusal("blocked", "host_drained"));
  behaviour.drained = false;
  await assert.rejects(recovery.checkHostRecovery({ ...request, compatibility: { min: 13, max: 13 } }, deps), refusal("failed", "protocol_incompatible"));
  await assert.rejects(recovery.checkHostRecovery({ ...request, version: "0.6.0" }, deps), refusal("succeeded", "already_current"));
  await assert.rejects(recovery.checkHostRecovery({ ...request, version: "not-a-version" }, deps), (error) => refusal("failed", "invalid_version")(error) && error.httpStatus === 400);
});

test("a host that already runs the release or is not running is reported, not touched", async () => {
  fresh();
  const { deps } = dependencies();
  await assert.rejects(recovery.startHostRecovery(input({ version: "0.6.0" }), deps), refusal("succeeded", "already_current"));
  const missing = dependencies({ control: async () => { throw Object.assign(new Error("No host daemon is running for this agent directory"), { code: "ENOENT" }); } });
  await assert.rejects(recovery.startHostRecovery(input(), missing.deps), refusal("failed", "no_host"));
});

test("a launch that fails after the drain resumes the old host and ends the claim with the failure", async () => {
  fresh();
  const { deps } = dependencies({ launchWorker: async () => { throw new Error("cannot start the worker"); } });
  await assert.rejects(recovery.startHostRecovery(input(), deps), (error) => refusal("failed", "recovery_failed")(error) && /cannot start the worker/.test(error.message));
  assert.deepEqual(calls, ["status", "drain", "resume"]);
  assert.equal(behaviour.drained, false);
  assert.equal(status().operation.state, "failed");
  assert.match(status().operation.error, /cannot start the worker/);
  assert.equal(existsSync(join(stateRoot, "lock.json")), false);
});

test("the CLI prints one JSON line that names the marker and exits non-zero for every refusal", async () => {
  fresh();
  const lines = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => lines.push(line);
  console.error = () => {};
  try {
    assert.equal(await recovery.runHostRecoveryCli(["--bogus"]), 2);
    assert.deepEqual(lines, [], "a usage error prints no outcome");
    // The real host is not running here as far as the real endpoint is concerned once it is closed: simulate with a version that is already current.
    assert.equal(await recovery.runHostRecoveryCli(["--operation", OPERATION, "--version", "0.6.0", "--min-protocol", "12", "--max-protocol", "12"]), 0);
    const outcome = JSON.parse(lines.at(-1));
    assert.deepEqual([outcome.marker, outcome.operation, outcome.state, outcome.code], ["ompweb-recovery-cli-v1", OPERATION, "succeeded", "already_current"]);
    await endpoint.close();
    assert.equal(await recovery.runHostRecoveryCli(["--operation", OPERATION, "--version", "0.8.0", "--min-protocol", "12", "--max-protocol", "12"]), 1);
    assert.equal(JSON.parse(lines.at(-1)).code, "no_host");
  } finally { console.log = log; console.error = error; endpoint = undefined; }
  assert.equal(typeof updates.claimHostUpdate, "function");
});
