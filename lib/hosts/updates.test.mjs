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
    assert.equal(String(url), `https://raw.githubusercontent.com/ompweb-dev/ompweb/v${latest}/lib/hosts/link-protocol.ts`);
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

/** A Node process that loads the engine through jiti as an npm-installed `ompweb host` would. `sharer`: an independent process (this test's, not the engine's child) also runs a script of the installation, as a web server sharing it would. */
async function runEngineChild(name, body, { directlyInsideService = false, sharer = false } = {}) {
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
  const hostArgs = [join(install, "bin", "omp-web-host.js"), "--allow-http"];
  const web = sharer ? spawn(nodeBinary(), [join(install, "bin", "omp-web-host.js")], { stdio: "ignore" }) : null;
  try {
    if (web) await new Promise((done) => setTimeout(done, 300));
    const child = directlyInsideService ? spawn(nodeBinary(), [script, ...hostArgs], { env, stdio: ["ignore", "pipe", "pipe"] }) : await spawnNodeOutsideService(script, env, hostArgs);
    if (!child) return null;
    let out = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { out += data; });
    const code = await new Promise((done) => child.once("exit", done));
    return { code, out };
  } finally { web?.kill(); }
}

test("Node npm-host discovery runs without Bun globals and honors protocol boundaries", async (t) => {
  const result = await runEngineChild("npm-host", `
      api.configureHostUpdateSafety(()=>null);
      const info=await api.checkHostUpdates({min:3,max:3},true);
      assert.equal(info.ompweb.canUpdate,true,JSON.stringify(info.ompweb.blockers));
      assert.deepEqual(info.ompweb.blockers,[]);
      assert.equal(info.ompweb.protocolVersion,3);
      api.configureHostUpdateSafety(()=> "Active sessions must be closed before restarting this host");
      await assert.rejects(api.startHostUpdate("ompweb","99.0.0",{min:3,max:3}),/Active sessions/);
  `);
  if (!result) return t.skip("systemd-run cannot create the scope that keeps this test outside the service running the suite");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /child passed/);
});

test("an installation an independent process uses blocks the update until the server is updated first, unless it already holds the candidate", async (t) => {
  const result = await runEngineChild("npm-host-shared", `
      api.configureHostUpdateSafety(()=>null);
      let info=await api.checkHostUpdates({min:3,max:3},true);
      assert.equal(info.ompweb.canUpdate,false);
      assert.match(info.ompweb.blockedReason,/web server first.*shared/i);
      require("node:fs").writeFileSync(install+"/package.json",JSON.stringify({name:"@kahme247/ompweb",version:"99.0.0"}));
      info=await api.checkHostUpdates({min:3,max:3},true);
      assert.equal(info.ompweb.canUpdate,true,"a shared install that already holds the candidate needs only a restart: "+info.ompweb.blockedReason);
  `, { sharer: true });
  if (!result) return t.skip("systemd-run cannot create the scope that keeps this test outside the service running the suite");
  assert.equal(result.code, 0, result.out);
});

test("a host that is only busy can be forced; a local drain or an installation shared with a server cannot be forced past", async (t) => {
  const busy = `const busy="Active sessions must be closed before restarting this host";api.configureHostUpdateSafety(()=>busy,{drained:()=>false,sessions:()=>2});`;
  const only = await runEngineChild("force-busy", `
      ${busy}
      let info=await api.checkHostUpdates({min:3,max:3},true);
      assert.equal(info.ompweb.canUpdate,false);
      assert.equal(info.ompweb.canForceUpdate,true,JSON.stringify(info.ompweb.blockers));
      assert.equal(info.ompweb.forceMethod,"native");
      assert.deepEqual(info.ompweb.blockers.map(b=>[b.code,b.forceable]),[["host_busy",true]]);
      assert.equal(info.ompweb.activeSessions,2);
      await assert.rejects(api.startHostUpdate("ompweb","99.0.0",{min:3,max:3}),error=>error.code==="host_busy");
      api.configureHostUpdateSafety(()=>"This host is locally drained for maintenance.",{drained:()=>true,sessions:()=>0});
      info=await api.checkHostUpdates({min:3,max:3},true);
      assert.deepEqual([info.ompweb.canForceUpdate,info.ompweb.forceMethod,info.ompweb.blockers[0].code,info.ompweb.blockers[0].forceable],[false,undefined,"host_drained",false]);
      await assert.rejects(api.startHostUpdate("ompweb","99.0.0",{min:3,max:3},{force:true}),error=>error.code==="update_blocked");
  `);
  if (!only) return t.skip("systemd-run cannot create the scope that keeps this test outside the service running the suite");
  assert.equal(only.code, 0, only.out);
  const shared = await runEngineChild("force-shared", `
      ${busy}
      const info=await api.checkHostUpdates({min:3,max:3},true);
      assert.equal(info.ompweb.canForceUpdate,false,"force does not resolve a shared installation");
      const sharing=info.ompweb.blockers.find(b=>b.code==="shared_install");
      assert.deepEqual([sharing.forceable,sharing.coordination],[false,"server"]);
      await assert.rejects(api.startHostUpdate("ompweb","99.0.0",{min:3,max:3},{force:true}),error=>error.code==="update_blocked");
  `, { sharer: true });
  assert.equal(shared.code, 0, shared.out);
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

test("a candidate outside the server's range is a final blocker that only an approved server cutover resolves", async () => {
  const final = await api.checkHostUpdates({ min: 1, max: 2 }, true);
  const protocolBlocker = final.ompweb.blockers.find((blocker) => blocker.code === "protocol_incompatible");
  assert.deepEqual([protocolBlocker.forceable, protocolBlocker.coordination, final.ompweb.canForceUpdate, final.ompweb.forceMethod], [false, "server", false, undefined]);
  const approved = await api.checkHostUpdates({ min: 1, max: 2 }, true, { min: 3, max: 3 });
  assert.ok(!approved.ompweb.blockers.some((blocker) => blocker.code === "protocol_incompatible"), "inside the approved target range the host may be staged to await the cutover");
  const outside = await api.checkHostUpdates({ min: 1, max: 2 }, true, { min: 1, max: 2 });
  assert.ok(outside.ompweb.blockers.some((blocker) => blocker.code === "protocol_incompatible" && blocker.coordination === "server"), "a target range the candidate does not speak is never approved");
  await assert.rejects(api.startHostUpdate("ompweb", "99.0.0", { min: 1, max: 2 }, { force: true }), (error) => error.code === "update_blocked");
});

test("an operation id names one update: a retry returns its state and a different request is refused", async () => {
  resetState();
  ownedDirectory(stateRoot);
  const id = "11111111-2222-4333-8444-555555555555";
  const operation = { id, target: "ompweb", version: "99.0.0", state: "running" };
  writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation, startedAt: Date.now(), daemonPid: process.pid, workerPid: process.pid }), { mode: 0o600 });
  assert.deepEqual(await api.startHostUpdate("ompweb", "99.0.0", { min: 1, max: 10 }, { operationId: id }), { accepted: true, operation });
  await assert.rejects(api.startHostUpdate("ompweb", "98.0.0", { min: 1, max: 10 }, { operationId: id }), (error) => error.code === "operation_conflict");
  await assert.rejects(api.startHostUpdate("ompweb", "99.0.0", { min: 1, max: 10 }, { operationId: "not-a-uuid" }), (error) => error.code === "invalid_request");
  await assert.rejects(api.startHostUpdate("ompweb", "99.0.0", { min: 1, max: 10 }, { force: "yes" }), (error) => error.code === "invalid_request");
  resetState();
});

test("a running update refuses new work, except a forced one before its commit", () => {
  const running = (extra) => ({ id: "a", target: "ompweb", version: "2.0.0", state: "running", ...extra });
  assert.equal(api.hostUpdateBlocksNewWork(null), false);
  assert.equal(api.hostUpdateBlocksNewWork(running({})), true);
  assert.equal(api.hostUpdateBlocksNewWork(running({ force: true })), false);
  assert.equal(api.hostUpdateBlocksNewWork(running({ force: true, committing: true })), true);
  assert.equal(api.hostUpdateBlocksNewWork(running({ state: "failed" })), false);
});

test("a maintenance receipt is written only for the approved target release, with this operation's preflight proof", async () => {
  const id = "receipt-attempt";
  const prepare = ({ version = repoVersion, receipt = { min: 12, max: 12 }, proof = { id, version: repoVersion, nonce: "nonce-1" }, daemonPid = 4242 } = {}) => {
    resetState();
    ownedDirectory(join(stateRoot, id));
    writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation: { id, target: "ompweb", version, state: "running" }, startedAt: Date.now(), daemonPid }), { mode: 0o600 });
    writeFileSync(join(stateRoot, id, "descriptor.json"), JSON.stringify({ id, version, fromVersion: "0.0.1", receipt }), { mode: 0o600 });
    if (proof) writeFileSync(join(stateRoot, id, "preflight.json"), JSON.stringify(proof), { mode: 0o600 });
    return join(stateRoot, id, "health.json");
  };
  let health = prepare();
  await api.acknowledgeHostUpdateReceipt(12);
  const marker = JSON.parse(readFileSync(health, "utf8"));
  assert.deepEqual([marker.id, marker.version, marker.pid, marker.protocol, marker.receipt], [id, repoVersion, process.pid, 12, "nonce-1"]);
  for (const [label, options, protocol] of [
    ["another release", { version: "9.9.9" }, 12],
    ["an operation that approved no range", { receipt: null }, 12],
    ["a protocol outside the approved range", {}, 13],
    ["a release without preflight proof", { proof: null }, 12],
    ["proof of another operation", { proof: { id: "other", version: repoVersion, nonce: "n" } }, 12],
    ["the daemon being replaced", { daemonPid: process.pid }, 12],
  ]) {
    health = prepare(options);
    await api.acknowledgeHostUpdateReceipt(protocol);
    assert.equal(existsSync(health), false, label);
  }
  resetState();
});
