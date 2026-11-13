import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { insideSystemdService, jitiPath, nodeBinary, repo, repoVersion, spawnNodeOutsideService } from "./update-fixture.test-helper.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "host-updates-check-")));
const stateRoot = join(root, "agent", "omp-web", "host-update");
const saved = { ...process.env };
const originalFetch = globalThis.fetch;
let protocol = "export const LINK_PROTOCOL_VERSION = 3;";
let latest = "99.0.0";
let failedNpm = false;
let api;
let worker;
const STAMPED = "18.20.0-int.202611130355.gd2c2eff";
const resetState = () => rmSync(stateRoot, { recursive: true, force: true });
const ownedDirectory = (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); };
async function deadPid() {
  const child = spawn(nodeBinary(), ["-e", ""], { stdio: "ignore" });
  await new Promise((done) => child.once("exit", done));
  return child.pid;
}

before(async () => {
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  delete process.env.OMP_WEB_PACKAGE_DIR;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  const script = join(root, "omp-fixture.cjs");
  // A fork integration build's omp: `omp --version` is all the host asks it.
  writeFileSync(script, `#!/usr/bin/env node\nconsole.log("omp/${STAMPED}");\n`, { mode: 0o700 });
  const bin = process.platform === "win32" ? join(root, "omp.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, `@echo off\r\nnode "${script}" %*\r\n`);
  process.env.OMP_WEB_OMP_BIN = bin;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://registry.npmjs.org/")) return new Response(failedNpm ? "broken" : JSON.stringify({ version: latest }), { status: failedNpm ? 503 : 200 });
    assert.equal(String(url), `https://raw.githubusercontent.com/kahme247/ompweb/v${latest}/lib/hosts/link-protocol.ts`);
    if (protocol === null) throw new Error("fixture offline");
    return new Response(protocol);
  };
  api = await import("./updates.ts");
  worker = await import("./update-worker.ts");
});
after(() => {
  globalThis.fetch = originalFetch;
  // Key by key, not `process.env = saved`: Bun on Windows writes process.env through to the OS (os.homedir() reads USERPROFILE).
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
});

test("candidate protocol outside server range is visible but cannot execute", async () => {
  const info = await api.checkHostUpdates({ min: 1, max: 2 }, true);
  assert.equal(info.ompweb.availableVersion, "99.0.0");
  assert.equal(info.ompweb.updateAvailable, true);
  assert.equal(info.ompweb.protocolVersion, 3);
  assert.equal(info.ompweb.canUpdate, false);
  assert.match(info.ompweb.blockedReason, /server first/i);
  await assert.rejects(api.startHostUpdate("ompweb", "99.0.0", { min: 1, max: 2 }), /server first/i);
  assert.deepEqual(info.omp, { currentVersion: STAMPED }, "omp updates with ompweb: its row carries only the version");
  assert.ok(worker.HOST_VERSION_PATTERN.test(STAMPED));
});

test("unknown or nonliteral protocol fails closed rather than assuming current", async () => {
  for (const source of ["export const LINK_PROTOCOL_VERSION = 2 + 1;", "/*\nexport const LINK_PROTOCOL_VERSION = 3;\n*/", "export const LINK_PROTOCOL_VERSION = 9007199254740992;", null]) {
    protocol = source;
    const info = await api.checkHostUpdates({ min: 1, max: 10 }, true);
    assert.equal(info.ompweb.availableVersion, "99.0.0");
    assert.equal(info.ompweb.protocolVersion, null);
    assert.equal(info.ompweb.canUpdate, false);
    assert.match(info.ompweb.blockedReason, /protocol/i);
  }
  protocol = "export const LINK_PROTOCOL_VERSION = 3;";
});

test("npm discovery failure stays explicit instead of claiming up to date", async () => {
  failedNpm = true;
  const info = await api.checkHostUpdates({ min: 1, max: 10 }, true);
  assert.equal(info.ompweb.canUpdate, false);
  assert.match(info.ompweb.blockedReason, /check|discover/i);
  failedNpm = false;
});

test("omp, version syntax and a stale candidate are rejected before execution", async () => {
  await assert.rejects(api.startHostUpdate("omp", "2.0.0", { min: 1, max: 10 }), (error) => error.code === "invalid_target");
  await assert.rejects(api.startHostUpdate("ompweb", "2.0.0; touch /tmp/unwanted", { min: 1, max: 10 }), /version/i);
  await assert.rejects(api.startHostUpdate("ompweb", "1.9.0", { min: 1, max: 10 }), /changed|candidate|available/i);
});

test("disable policy blocks checks and starts", async () => {
  process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
  const info = await api.checkHostUpdates({ min: 1, max: 10 }, true);
  assert.equal(info.ompweb.canUpdate, false);
  assert.match(info.ompweb.blockedReason, /disabled/i);
  await assert.rejects(api.startHostUpdate("ompweb", "2.0.0", { min: 1, max: 10 }), /disabled/i);
  assert.deepEqual(info.omp, { currentVersion: STAMPED });
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
});

test("owned durable state survives reload and refuses a symlinked update directory", async () => {
  resetState();
  ownedDirectory(stateRoot);
  // An `omp update` a host recorded before omp updated with ompweb stays readable.
  const operation = { id: "a", target: "omp", version: "2.0.0", state: "failed", error: "fixture failure" };
  writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation, startedAt: Date.now(), daemonPid: process.pid }), { mode: 0o600 });
  assert.deepEqual(api.getHostUpdateOperation(), operation);
  if (process.platform !== "win32") assert.equal(statSync(join(stateRoot, "status.json")).mode & 0o777, 0o600);
  renameSync(stateRoot, `${stateRoot}-real`);
  symlinkSync(`${stateRoot}-real`, stateRoot, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => api.getHostUpdateOperation(), /unsafe/i);
  rmSync(stateRoot);
  renameSync(`${stateRoot}-real`, stateRoot);
  failedNpm = true;
  assert.deepEqual((await api.checkHostUpdates({ min: 1, max: 10 }, true)).operation, operation);
  failedNpm = false;
});

test("while an update runs, an available compatible release cannot be installed", async () => {
  resetState();
  ownedDirectory(stateRoot);
  const operation = { id: "busy", target: "ompweb", version: "99.0.0", state: "running" };
  writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation, startedAt: Date.now(), daemonPid: process.pid, workerPid: process.pid }), { mode: 0o600 });
  const info = await api.checkHostUpdates({ min: 1, max: 10 }, true);
  assert.equal(info.ompweb.updateAvailable, true);
  assert.equal(info.ompweb.protocolVersion, 3);
  assert.equal(info.ompweb.canUpdate, false);
  assert.match(info.ompweb.blockedReason, /in progress/i);
  assert.deepEqual(info.operation, operation);
  resetState();
});

test("a running operation whose worker died is reported failed, but a live worker keeps it running", async () => {
  resetState();
  ownedDirectory(stateRoot);
  const write = (startedAt, workerPid) => writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation: { id: "stale", target: "ompweb", version: "2.0.0", state: "running" }, startedAt, daemonPid: 4242, workerPid }), { mode: 0o600 });
  write(Date.now() - 60_000, await deadPid());
  const dead = api.getHostUpdateOperation();
  assert.equal(dead.state, "failed");
  assert.match(dead.error, /interrupted/);
  write(Date.now() - 60_000, process.pid);
  assert.equal(api.getHostUpdateOperation().state, "running");
  write(Date.now() - 31 * 60_000, process.pid);
  assert.equal(api.getHostUpdateOperation().state, "failed");
  write(Date.now() - 5_000, await deadPid());
  assert.equal(api.getHostUpdateOperation().state, "running", "a fresh operation has its worker pid recorded only after the spawn");
  resetState();
});

test("four simultaneous starts are serialised by the claim: exactly one gets past it", async () => {
  resetState();
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => api.startHostUpdate("ompweb", "1.9.0", { min: 1, max: 10 })));
  // The one that claimed goes on to the candidate check, which a stale version fails.
  assert.deepEqual(results.map((result) => result.reason.code).sort(), ["candidate_changed", "update_in_progress", "update_in_progress", "update_in_progress"]);
});

test("a claim left by a dead process or an expired lease is reclaimed; a live fresh one is not", async () => {
  const lock = (pid, at) => { resetState(); ownedDirectory(stateRoot); writeFileSync(join(stateRoot, "lock.json"), JSON.stringify({ id: "old", pid, at }), { mode: 0o600 }); };
  // Past the claim, the stale candidate is what stops a start.
  const start = () => api.startHostUpdate("ompweb", "1.9.0", { min: 1, max: 10 }).then(() => "accepted", (error) => error.code);
  lock(process.pid, Date.now());
  assert.equal(await start(), "update_in_progress");
  assert.match(readFileSync(join(stateRoot, "lock.json"), "utf8"), /"id":"old"/, "a refused start must not erase the claim that blocked it");
  lock(await deadPid(), Date.now());
  assert.equal(await start(), "candidate_changed");
  lock(process.pid, Date.now() - 31 * 60_000);
  assert.equal(await start(), "candidate_changed");
});

test("claiming an update prunes what finished attempts of this installation left behind", async () => {
  resetState();
  const install = join(root, "prune-install", "node_modules", "@kahme247", "ompweb");
  mkdirSync(install, { recursive: true });
  for (let dir = install; dir !== root; dir = dirname(dir)) chmodSync(dir, 0o755);
  ownedDirectory(join(stateRoot, "old-attempt"));
  writeFileSync(join(stateRoot, "old-attempt", "descriptor.json"), JSON.stringify({ id: "old-attempt", installDir: install }), { mode: 0o600 });
  writeFileSync(join(stateRoot, "old-attempt", "runtime"), "a copied runtime");
  mkdirSync(join(dirname(install), ".ompweb-failed-old-attempt"));
  process.env.OMP_WEB_PACKAGE_DIR = install;
  try {
    await assert.rejects(api.startHostUpdate("ompweb", "1.9.0", { min: 1, max: 10 }), (error) => error.code === "candidate_changed");
    assert.equal(existsSync(join(dirname(install), ".ompweb-failed-old-attempt")), false);
    assert.equal(existsSync(join(stateRoot, "old-attempt")), false);
  } finally { delete process.env.OMP_WEB_PACKAGE_DIR; }
});

/** A running ompweb update whose attempt descriptor names `version` -> `fromVersion`. */
function runningAttempt({ id = "ack", version, fromVersion, daemonPid = 4242, state = "running" }) {
  resetState();
  ownedDirectory(join(stateRoot, id));
  writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation: { id, target: "ompweb", version, state }, startedAt: Date.now(), daemonPid }), { mode: 0o600 });
  writeFileSync(join(stateRoot, id, "descriptor.json"), JSON.stringify({ id, version, fromVersion }), { mode: 0o600 });
  return join(stateRoot, id, "health.json");
}

test("a daemon acknowledges only a version it was asked to run, and only as the new daemon", () => {
  assert.equal(existsSync(runningAttempt({ version: "9.9.9", fromVersion: "8.8.8" })), false);
  api.acknowledgeHostUpdateHealth();
  assert.equal(existsSync(join(stateRoot, "ack", "health.json")), false, "this build is neither the target nor the origin version");

  runningAttempt({ version: repoVersion, fromVersion: "0.0.1" });
  api.acknowledgeHostUpdateHealth();
  assert.deepEqual(JSON.parse(readFileSync(join(stateRoot, "ack", "health.json"), "utf8")), { id: "ack", version: repoVersion, pid: process.pid });

  runningAttempt({ version: "9.9.9", fromVersion: repoVersion });
  api.acknowledgeHostUpdateHealth();
  assert.equal(JSON.parse(readFileSync(join(stateRoot, "ack", "health.json"), "utf8")).version, repoVersion, "a rolled-back daemon acknowledges the origin version");

  runningAttempt({ version: repoVersion, fromVersion: "0.0.1", daemonPid: process.pid });
  api.acknowledgeHostUpdateHealth();
  assert.equal(existsSync(join(stateRoot, "ack", "health.json")), false, "the daemon being replaced must not acknowledge its own replacement");

  runningAttempt({ version: repoVersion, fromVersion: "0.0.1", state: "failed" });
  api.acknowledgeHostUpdateHealth();
  assert.equal(existsSync(join(stateRoot, "ack", "health.json")), false, "a finished operation takes no acknowledgement");
  resetState();
  assert.doesNotThrow(() => api.acknowledgeHostUpdateHealth(), "a healthy link never breaks when there is no update");
});

test("a runtime is copied only when it lives inside the installation being replaced", { skip: process.platform === "win32" ? "Needs symlinks" : false }, () => {
  const install = join(root, "rt", "ompweb");
  mkdirSync(join(install, "node_modules", "bun", "bin"), { recursive: true });
  mkdirSync(join(root, "rt", "ompweb-other"), { recursive: true });
  const inside = join(install, "node_modules", "bun", "bin", "bun");
  const outside = join(root, "rt", "system-node");
  const sibling = join(root, "rt", "ompweb-other", "node");
  for (const file of [inside, outside, sibling]) writeFileSync(file, "");
  symlinkSync(outside, join(install, "link-to-system-node"));
  symlinkSync(inside, join(root, "rt", "link-to-bundled"));
  assert.equal(api.runtimeInsideInstall(inside, install), true);
  assert.equal(api.runtimeInsideInstall(join(root, "rt", "link-to-bundled"), install), true, "a link into the install resolves into it");
  assert.equal(api.runtimeInsideInstall(outside, install), false, "a system or Homebrew node stays where its libraries are");
  assert.equal(api.runtimeInsideInstall(sibling, install), false, "a sibling directory sharing the name prefix is not inside");
  assert.equal(api.runtimeInsideInstall(join(install, "link-to-system-node"), install), false, "a link out of the install resolves outside it");
});

test("only an interactive Windows shell or Explorer may be the parent of an updatable host", () => {
  const verdicts = [
    [{ name: "powershell.exe", commandLine: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"" }, false],
    [{ name: "pwsh.exe", commandLine: "pwsh.exe -NoLogo" }, false],
    [{ name: "cmd.exe", commandLine: "C:\\Windows\\system32\\cmd.exe" }, false],
    [{ name: "explorer.exe", commandLine: "C:\\Windows\\Explorer.EXE" }, false],
    [{ name: "powershell.exe", commandLine: "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"C:\\Users\\me\\ompweb-host.ps1\"" }, true],
    [{ name: "pwsh.exe", commandLine: "pwsh.exe -Command \"ompweb host\"" }, true],
    [{ name: "cmd.exe", commandLine: "cmd.exe /c C:\\tools\\host.bat" }, true],
    [{ name: "taskeng.exe", commandLine: "taskeng.exe {ABC}" }, true],
    [{ name: "nssm.exe", commandLine: "nssm.exe" }, true],
    [null, true],
  ];
  for (const [parent, blocked] of verdicts) {
    const reason = api.windowsHostSupervisionReason(parent);
    assert.equal(reason !== null, blocked, JSON.stringify(parent));
    if (blocked) assert.match(reason, /supervis|manually/i);
  }
});

test("only a directly foreground interactive shell may be the parent of an updatable macOS host", () => {
  const verdicts = [
    ["/bin/zsh -l", false],
    ["-zsh", false],
    ["/bin/bash", false],
    ["bash --login", false],
    ["/bin/zsh -i -l", false],
    ["/bin/sh /Users/me/.omp/agent/ompweb-host-run", true],
    ["sh ompweb-host-run", true],
    ["sh -c ompweb host", true],
    ["/bin/bash -lc ompweb host", true],
    ["/bin/zsh -l /Users/me/bin/start-host.sh", true],
    ["/bin/bash -e", true],
    ["tmux: server", true],
    ["/usr/bin/python3 supervise.py", true],
    ["/sbin/launchd", true],
    ["", true],
    [null, true],
  ];
  for (const [command, blocked] of verdicts) {
    const reason = api.macHostSupervisionReason(command);
    assert.equal(reason !== null, blocked, String(command));
    if (blocked) assert.match(reason, /supervis|manually/i);
  }
});

/** A Node process that loads the engine through jiti as an npm-installed `ompweb host` would. */
async function runEngineChild(name, body, { directlyInsideService = false } = {}) {
  const install = join(root, name, "node_modules", "@kahme247", "ompweb");
  mkdirSync(join(install, "bin"), { recursive: true });
  writeFileSync(join(install, "bin", "omp-web-host.js"), "setInterval(()=>{},1000)");
  writeFileSync(join(install, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: repoVersion }));
  for (let dir = install; dir !== root; dir = dirname(dir)) chmodSync(dir, 0o755);
  const script = join(root, `${name}.cjs`);
  writeFileSync(script, `
    const assert=require("node:assert/strict");
    assert.equal(typeof Bun,"undefined");
    globalThis.fetch=async url=>String(url).startsWith("https://registry.npmjs.org/")?Response.json({version:"99.0.0"}):new Response("export const LINK_PROTOCOL_VERSION = 3;");
    process.env.OMP_WEB_PACKAGE_DIR=${JSON.stringify(install)};
    process.argv=[process.execPath,${JSON.stringify(join(install, "bin", "omp-web-host.js"))},"--allow-http"];
    const install=${JSON.stringify(install)};
    require(${JSON.stringify(jitiPath)}).createJiti(${JSON.stringify(join(repo, "package.json"))}).import(${JSON.stringify(fileURLToPath(new URL("./updates.ts", import.meta.url)))}).then(async api=>{
      ${body}
      console.log("child passed");
    }).catch(error=>{console.error(error);process.exitCode=1;});
  `);
  const env = { ...process.env };
  const child = directlyInsideService ? spawn(nodeBinary(), [script], { env, stdio: ["ignore", "pipe", "pipe"] }) : await spawnNodeOutsideService(script, env);
  if (!child) return null;
  let out = "";
  child.stdout.on("data", (data) => { out += data; });
  child.stderr.on("data", (data) => { out += data; });
  const code = await new Promise((done) => child.once("exit", done));
  return { code, out };
}

test("Node npm-host discovery runs without Bun globals, honors protocol boundaries and shared-install rules", async (t) => {
  const result = await runEngineChild("npm-host", `
      api.configureHostUpdateSafety(()=>null);
      let info=await api.checkHostUpdates({min:3,max:3},true);
      assert.equal(info.ompweb.canUpdate,true,info.ompweb.blockedReason);
      assert.equal(info.ompweb.protocolVersion,3);
      const web=require("node:child_process").spawn(process.execPath,[install+"/bin/omp-web-host.js"],{stdio:"ignore"});
      try {
        await new Promise(done=>setTimeout(done,300));
        info=await api.checkHostUpdates({min:3,max:3},true);
        assert.equal(info.ompweb.canUpdate,false);
        assert.match(info.ompweb.blockedReason,/web server first.*shared/i);
        require("node:fs").writeFileSync(install+"/package.json",JSON.stringify({name:"@kahme247/ompweb",version:"99.0.0"}));
        info=await api.checkHostUpdates({min:3,max:3},true);
        assert.equal(info.ompweb.canUpdate,true,"a shared install that already holds the candidate needs only a restart: "+info.ompweb.blockedReason);
        api.configureHostUpdateSafety(()=> "Active sessions must be closed before restarting this host");
        await assert.rejects(api.startHostUpdate("ompweb","99.0.0",{min:3,max:3}),/Active sessions/);
      } finally {web.kill();}
  `);
  if (!result) return t.skip("systemd-run cannot create the scope that keeps this test outside the service running the suite");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /child passed/);
});

test("inside a systemd service that is not this daemon, discovery already reports the service as the blocker", { skip: insideSystemdService() ? false : "Only meaningful when the suite itself runs inside a systemd service" }, async () => {
  const result = await runEngineChild("service-block", `
      api.configureHostUpdateSafety(()=>null);
      const info=await api.checkHostUpdates({min:3,max:3},true);
      assert.equal(info.ompweb.canUpdate,false);
      assert.match(info.ompweb.blockedReason,/service/i);
  `, { directlyInsideService: true });
  assert.equal(result.code, 0, result.out);
});

test("candidate protocol is cached by exact version while forced checks refresh it", async () => {
  protocol = "export const LINK_PROTOCOL_VERSION = 3;";
  await api.checkHostUpdates({ min: 1, max: 10 }, true);
  protocol = "export const LINK_PROTOCOL_VERSION = 4;";
  assert.equal((await api.checkHostUpdates({ min: 1, max: 10 })).ompweb.protocolVersion, 3);
  assert.equal((await api.checkHostUpdates({ min: 1, max: 10 }, true)).ompweb.protocolVersion, 4);
  protocol = "export const LINK_PROTOCOL_VERSION = 3;";
});

test("a start that fails after claiming releases only its own claim, never a newer one", async () => {
  resetState();
  const pending = api.startHostUpdate("ompweb", "1.9.0", { min: 1, max: 10 }); // claims synchronously, then rejects the stale candidate
  const lock = join(stateRoot, "lock.json");
  assert.match(readFileSync(lock, "utf8"), /"pid":/);
  writeFileSync(lock, JSON.stringify({ id: "newer-claim", pid: process.pid, at: Date.now() }), { mode: 0o600 });
  await assert.rejects(pending, (error) => error.code === "candidate_changed");
  assert.match(readFileSync(lock, "utf8"), /newer-claim/);
  resetState();
});
