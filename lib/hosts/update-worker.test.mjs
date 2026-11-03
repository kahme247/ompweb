import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { nodeBinary, releaseArchive, writeManager, writeRelease } from "./update-fixture.test-helper.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "host-update-worker-")));
const saved = { ...process.env };
const stateRoot = join(base, "agent", "omp-web", "host-update");
const windows = process.platform === "win32";
const posixOnly = windows ? "The disposable binary release is a POSIX shell script; archive, digest and state validation still run on Windows" : false;
let worker;
const healthFiles = [];
const children = [];

before(async () => {
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  delete process.env.OMP_WEB_PACKAGE_DIR;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  worker = await import("./update-worker.ts");
});
after(() => {
  for (const child of children) { try { child.kill(); } catch {} }
  for (const file of healthFiles) { try { process.kill(JSON.parse(readFileSync(file)).pid, "SIGTERM"); } catch {} }
  process.env = saved;
  rmSync(base, { recursive: true, force: true });
});

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const status = () => read(join(stateRoot, "status.json"));
const versionOf = (dir) => read(join(dir, "package.json")).version;
const alive = (pid) => worker.isHostUpdateProcessAlive(pid);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** One update attempt on disk exactly as the engine leaves it, with a real old release and a real candidate release. */
async function fixture(id, { candidate = "ack", method = "npm", from = "1.0.0", to = "2.0.0", binary = false, restartOnly = false, webDuringInstall = false, identity } = {}) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const attempt = join(stateRoot, id);
  mkdirSync(attempt, { mode: 0o700 });
  healthFiles.push(join(attempt, "health.json"));
  const work = join(base, id);
  const install = binary ? join(work, "renamed-release") : join(work, "node_modules", "@kahme247", "ompweb");
  writeRelease(install, restartOnly ? to : from, "ack", { binary });
  for (let dir = install; dir !== base; dir = dirname(dir)) chmodSync(dir, 0o755);
  const release = join(work, "candidate");
  writeRelease(release, to, candidate, { binary });
  const manager = binary ? undefined : writeManager(work, { method, version: to, releaseDir: release, dependenciesDir: join(work, "candidate-modules"), webDuringInstall: webDuringInstall && { script: join(install, "bin", "idle-web.js"), pidFile: join(work, "web.pid") } });
  const daemon = spawn(nodeBinary(), ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  children.push(daemon);
  const operation = { id, target: "ompweb", version: to, state: "running" };
  writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation, daemonPid: daemon.pid, workerPid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  const descriptor = {
    id, target: "ompweb", version: to, fromVersion: from, installMethod: binary ? "binary" : method, installDir: install, runtime: nodeBinary(),
    hostArgs: ["--allow-http"], cwd: work, daemonPid: daemon.pid, daemonIdentity: identity ?? await worker.processStartIdentity(daemon.pid),
    managerPath: manager, restartOnly: restartOnly || undefined, systemd: null,
  };
  const descriptorPath = join(attempt, "descriptor.json");
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { descriptorPath, install, daemon, attempt, work, backup: join(dirname(install), `.ompweb-backup-${id}`), failed: join(dirname(install), `.ompweb-failed-${id}`), webPidFile: join(work, "web.pid") };
}
const outcome = (f) => `${JSON.stringify(status().operation)} ${f.descriptorPath}`;
async function idleWebOn(install) {
  const web = spawn(nodeBinary(), [join(install, "bin", "idle-web.js")], { stdio: "ignore" });
  children.push(web);
  await wait(300);
  return web;
}
function stubReleaseFetch(archive, asset) {
  const original = globalThis.fetch;
  const digest = asset.digest ?? "sha256:" + createHash("sha256").update(archive).digest("hex");
  globalThis.fetch = async (url) => {
    if (String(url) === "https://api.github.com/repos/kahme247/ompweb/releases/tags/v2.0.0") return Response.json({ tag_name: "v2.0.0", assets: [{ name: `${worker.hostReleaseName()}.tar.gz`, digest }] });
    assert.equal(String(url), `https://github.com/kahme247/ompweb/releases/download/v2.0.0/${worker.hostReleaseName()}.tar.gz`);
    return new Response(archive);
  };
  return () => { globalThis.fetch = original; };
}

test("npm install pins the candidate, swaps the whole release and the new daemon acknowledges for real", async () => {
  const f = await fixture("npm-success");
  writeFileSync(join(f.attempt, "runtime"), "a copied runtime");
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  assert.equal(status().operation.state, "succeeded");
  assert.equal(versionOf(f.install), "2.0.0");
  assert.equal(versionOf(f.backup), "1.0.0");
  const health = read(join(f.attempt, "health.json"));
  assert.equal(health.version, "2.0.0");
  assert.notEqual(health.pid, f.daemon.pid);
  assert.equal(alive(health.pid), true);
  assert.equal(alive(f.daemon.pid), false);
  assert.equal(existsSync(join(f.attempt, "runtime")), false, "the finished attempt's copied runtime is removed");
  assert.equal(existsSync(join(f.attempt, "descriptor.json")), true, "the latest attempt keeps its small evidence files");
});

test("bun install pins the candidate and keeps its private dependencies inside the swapped release", async () => {
  const f = await fixture("bun-success", { method: "bun" });
  mkdirSync(join(f.work, "candidate-modules", "private-dep"), { recursive: true });
  writeFileSync(join(f.work, "candidate-modules", "private-dep", "index.js"), "module.exports = 1;");
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  assert.equal(versionOf(f.install), "2.0.0");
  assert.equal(existsSync(join(f.install, "node_modules", "private-dep", "index.js")), true);
});

test("a candidate that dies at launch restores the old release, relaunches it and leaves a durable failure", async () => {
  const f = await fixture("rollback", { candidate: "exit" });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.equal(versionOf(f.install), "1.0.0");
  const { operation } = status();
  assert.equal(operation.state, "failed");
  assert.match(operation.error, /exited before health acknowledgement/);
  assert.match(operation.error, /previous host release restored/);
  const health = read(join(f.attempt, "health.json"));
  assert.equal(health.version, "1.0.0");
  assert.equal(alive(health.pid), true);
  assert.equal(versionOf(f.failed), "2.0.0");
});

test("a daemon acknowledging another version is rejected and rolled back, not accepted for its id and pid", async () => {
  const f = await fixture("wrong-version", { candidate: "wrong-version" });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.match(status().operation.error, /acknowledged version 0\.0\.1/);
  assert.equal(versionOf(f.install), "1.0.0");
  assert.equal(read(join(f.attempt, "health.json")).version, "1.0.0");
});

test("an acknowledgement from a live process other than the launched daemon is ignored: the dead candidate is rolled back", async () => {
  const f = await fixture("forged-ack", { candidate: "forged-ack" });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1, outcome(f));
  assert.match(status().operation.error, /exited before health acknowledgement \(5\)/);
  assert.equal(versionOf(f.install), "1.0.0");
  assert.equal(read(join(f.attempt, "health.json")).version, "1.0.0");
});

test("owned descriptor is required and a symlink is refused before execution", { skip: windows ? "Creating file symlinks requires Windows Developer Mode or administrator privileges" : false }, async () => {
  const f = await fixture("unsafe");
  const link = join(f.attempt, "symlink.json");
  symlinkSync(f.descriptorPath, link);
  assert.equal(await worker.runHostUpdateWorker(link), 1);
  assert.equal(versionOf(f.install), "1.0.0");
  assert.equal(alive(f.daemon.pid), true);
});

test("binary archives reject path traversal, links, excessive sizes and a bad digest", () => {
  const tar = new Uint8Array(2048);
  function entry(name, type = "0", size = "00000000000") {
    tar.fill(0); Buffer.from(name).copy(tar); Buffer.from(size).copy(tar, 124); tar[156] = type.charCodeAt(0); return tar;
  }
  assert.throws(() => worker.validateHostReleaseArchive(entry("../outside"), "ompweb-linux-x64"), /path|member/i);
  assert.throws(() => worker.validateHostReleaseArchive(entry("ompweb-linux-x64/link", "2"), "ompweb-linux-x64"), /type|link/i);
  assert.throws(() => worker.validateHostReleaseArchive(entry("ompweb-linux-x64/huge", "0", "77777777777"), "ompweb-linux-x64"), /size|large/i);
  assert.throws(() => worker.verifyHostReleaseDigest(new Uint8Array([1]), "sha256:" + "0".repeat(64)), /digest/i);
  worker.verifyHostReleaseDigest(new Uint8Array([1]), "sha256:" + createHash("sha256").update(new Uint8Array([1])).digest("hex"));
});

test("Windows ZIP entries are extracted from bounded central metadata and symlinks are rejected", () => {
  const name = Buffer.from("ompweb-windows-x64/ompweb.exe");
  const data = Buffer.from("hello");
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(0x3610a686, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(0x3610a686, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  name.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + data.length, 16);
  let archive = Buffer.concat([local, data, central, end]);
  const [entry] = worker.validateHostReleaseArchive(archive, "ompweb-windows-x64");
  assert.equal(entry.name, "ompweb-windows-x64/ompweb.exe");
  assert.equal(entry.data.toString(), "hello");
  central.writeUInt32LE((0o120777 << 16) >>> 0, 38);
  archive = Buffer.concat([local, data, central, end]);
  assert.throws(() => worker.validateHostReleaseArchive(archive, "ompweb-windows-x64"), /type/i);
});

test("binary release verifies the official digest and restarts a renamed host release", { skip: posixOnly }, async () => {
  const f = await fixture("binary", { binary: true });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, {});
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
    assert.equal(readFileSync(join(f.install, "dist", "index.html"), "utf8"), "static files 2.0.0");
    assert.equal(readFileSync(join(f.backup, "dist", "index.html"), "utf8"), "static files 1.0.0");
    assert.equal(read(join(f.attempt, "health.json")).version, "2.0.0");
  } finally { restore(); }
});

test("a valid archive whose digest differs from the official asset digest never reaches the install", { skip: posixOnly }, async () => {
  const f = await fixture("wrong-digest", { binary: true });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, { digest: "sha256:" + createHash("sha256").update("some other asset").digest("hex") });
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.match(status().operation.error, /digest/i);
    assert.equal(alive(f.daemon.pid), true);
    assert.equal(readFileSync(join(f.install, "dist", "index.html"), "utf8"), "static files 1.0.0");
    assert.equal(existsSync(f.backup), false);
  } finally { restore(); }
});

test("a release without an official digest fails before any daemon stop", { skip: posixOnly }, async () => {
  const f = await fixture("no-digest", { binary: true });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ tag_name: "v2.0.0", assets: [{ name: `${worker.hostReleaseName()}.tar.gz` }] });
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.match(status().operation.error, /digest/i);
    assert.equal(alive(f.daemon.pid), true);
  } finally { globalThis.fetch = original; }
});

test("a binary candidate that dies at launch restores the whole old release including its static files", { skip: posixOnly }, async () => {
  const f = await fixture("binary-rollback", { binary: true, candidate: "exit" });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, {});
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.equal(readFileSync(join(f.install, "dist", "index.html"), "utf8"), "static files 1.0.0");
    assert.equal(read(join(f.attempt, "health.json")).version, "1.0.0");
    assert.match(status().operation.error, /previous host release restored/);
  } finally { restore(); }
});

test("an installation already used by another process is refused without stopping the daemon", async () => {
  const f = await fixture("shared");
  await idleWebOn(f.install);
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.match(status().operation.error, /web server first.*shared/i);
  assert.equal(versionOf(f.install), "1.0.0");
  assert.equal(alive(f.daemon.pid), true);
});

test("a process that starts using the installation while the candidate stages is caught before the daemon stops", async () => {
  const f = await fixture("shared-after-stage", { webDuringInstall: true });
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.match(status().operation.error, /shared/i);
    assert.equal(versionOf(f.install), "1.0.0");
    assert.equal(alive(f.daemon.pid), true);
    assert.equal(existsSync(f.backup), false);
  } finally { try { process.kill(Number(readFileSync(f.webPidFile, "utf8")), "SIGTERM"); } catch {} }
});

test("a shared npm installation already holding the candidate restarts only the host", async () => {
  const f = await fixture("restart-only", { restartOnly: true });
  const web = await idleWebOn(f.install);
  rmSync(f.work + "/manager.cjs", { force: true });
  rmSync(f.work + "/manager.cmd", { force: true });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  assert.equal(alive(web.pid), true);
  assert.equal(versionOf(f.install), "2.0.0");
  assert.equal(existsSync(f.backup), false);
  assert.equal(read(join(f.attempt, "health.json")).version, "2.0.0");
});

test("a shared binary installation already holding the candidate restarts only the host", { skip: posixOnly }, async () => {
  const f = await fixture("restart-only-binary", { binary: true, restartOnly: true });
  const web = await idleWebOn(f.install);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("restart-only must not download a release"); };
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
    assert.equal(alive(web.pid), true);
    assert.equal(existsSync(f.backup), false);
    assert.equal(read(join(f.attempt, "health.json")).version, "2.0.0");
  } finally { globalThis.fetch = original; }
});

test("restart-only refuses an installation that no longer holds the candidate and leaves the daemon running", async () => {
  const f = await fixture("restart-stale", { restartOnly: true });
  writeFileSync(join(f.install, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version: "1.0.0" }));
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.match(status().operation.error, /no longer contains/);
  assert.equal(alive(f.daemon.pid), true);
});

test("restart-only binary refuses an executable that reports another version", { skip: posixOnly }, async () => {
  const f = await fixture("restart-stale-binary", { binary: true, restartOnly: true });
  writeRelease(f.install, "1.0.0", "ack", { binary: true });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.match(status().operation.error, /no longer contains/);
  assert.equal(alive(f.daemon.pid), true);
});

test("restart-only launch failure is durable and does not claim the old runtime can be restored", async () => {
  const f = await fixture("restart-failure", { restartOnly: true });
  writeRelease(f.install, "2.0.0", "exit");
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  const { operation } = status();
  assert.equal(operation.state, "failed");
  assert.match(operation.error, /previous loaded runtime cannot be restored/);
  assert.equal(existsSync(join(f.attempt, "health.json")), false);
});

test("a repeated worker descriptor cannot install or start a second daemon", async () => {
  const f = await fixture("duplicate");
  writeFileSync(join(f.attempt, "worker.lock"), "123", { mode: 0o600 });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.equal(alive(f.daemon.pid), true);
  assert.equal(versionOf(f.install), "1.0.0");
});

test("a recycled daemon pid is never signalled: the recorded process identity must still match", async () => {
  const f = await fixture("identity-mismatch", { identity: "recycled:not-the-recorded-start-time" });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.match(status().operation.error, /process identity/i);
  assert.equal(alive(f.daemon.pid), true);
  assert.equal(versionOf(f.install), "1.0.0");
});

test("a daemon that already exited is not an error: the update proceeds without signalling anything", async () => {
  const f = await fixture("dead-original");
  f.daemon.kill("SIGKILL");
  while (alive(f.daemon.pid)) await wait(50);
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  assert.equal(versionOf(f.install), "2.0.0");
});

test("the process identity read from the live daemon is stable and differs between processes", async () => {
  const other = spawn(nodeBinary(), ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  children.push(other);
  const first = await worker.processStartIdentity(process.pid);
  assert.ok(first && first === await worker.processStartIdentity(process.pid));
  assert.notEqual(await worker.processStartIdentity(other.pid), first);
  other.kill();
  while (alive(other.pid)) await wait(50);
  assert.equal(await worker.processStartIdentity(other.pid), null);
});

test("copied standalone worker runs on Node without the original package or Bun globals", async () => {
  const f = await fixture("standalone");
  writeFileSync(join(f.attempt, "package.json"), '{"type":"commonjs"}');
  const copy = join(f.attempt, "worker.mts");
  copyFileSync(new URL("./update-worker.ts", import.meta.url), copy);
  const child = spawn(nodeBinary(), [copy, "--host-update-descriptor", f.descriptorPath], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
  assert.equal(code, 0, `${stderr}\n${outcome(f)}`);
  assert.equal(status().operation.state, "succeeded");
});

test("service restart command must point to this host install rather than a retargeted release", { skip: process.platform !== "linux" ? "systemd restart-command validation applies only to Linux hosts" : false }, async () => {
  const f = await fixture("service-path");
  const bin = join(f.attempt, "bin");
  mkdirSync(bin);
  const executable = join(bin, "systemctl");
  const answer = (target) => `#!/bin/sh\nprintf '%s\\n' '{ path=${process.execPath} ; argv[]=${process.execPath} ${target} --allow-http ; ignore_errors=no ; }'\n`;
  writeFileSync(executable, answer(`${f.install}/bin/omp-web-host.js`), { mode: 0o700 });
  const path = process.env.PATH;
  process.env.PATH = bin + delimiter + path;
  try {
    await worker.verifyHostServiceInstall({ unit: "ompweb-host.service", user: false }, f.install, false, process.execPath);
    writeFileSync(executable, answer("/new-release/bin/omp-web-host.js"), { mode: 0o700 });
    await assert.rejects(worker.verifyHostServiceInstall({ unit: "ompweb-host.service", user: false }, f.install, false, process.execPath), /different installation|unsupported wrapper/);
  } finally { process.env.PATH = path; }
});

/** The artifacts of a finished attempt the way the worker leaves them. */
function finishedAttempt(id, install, seconds, siblings = ["backup", "failed", "staging"]) {
  const attempt = join(stateRoot, id);
  mkdirSync(attempt, { recursive: true, mode: 0o700 });
  const descriptor = join(attempt, "descriptor.json");
  writeFileSync(descriptor, JSON.stringify({ id, installDir: install }), { mode: 0o600 });
  utimesSync(descriptor, seconds, seconds);
  writeFileSync(join(attempt, "runtime"), "a copied executable");
  writeFileSync(join(attempt, "worker.mts"), "worker");
  for (const kind of siblings) {
    const dir = join(dirname(install), `.ompweb-${kind}-${id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "release.txt"), id);
  }
  return attempt;
}
function pruneScenario(name) {
  const install = join(base, name, "node_modules", "@kahme247", "ompweb");
  mkdirSync(install, { recursive: true });
  for (let dir = install; dir !== base; dir = dirname(dir)) chmodSync(dir, 0o755);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  return { install, parent: dirname(install) };
}
const latestStatus = (id, state = "succeeded") => writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation: { id, target: "ompweb", version: "2.0.0", state }, startedAt: Date.now(), daemonPid: 4242 }), { mode: 0o600 });

test("pruning keeps only the newest rollback backup and deletes only what a trusted attempt proves it created", () => {
  const { install, parent } = pruneScenario("prune");
  finishedAttempt("prune-a", install, 1000);
  finishedAttempt("prune-b", install, 2000);
  const latest = finishedAttempt("prune-c", install, 3000);
  latestStatus("prune-c");
  // Not provably ours: no attempt descriptor, a descriptor for another install, and a symlink named like a staging dir.
  mkdirSync(join(parent, ".ompweb-backup-user-data"));
  const otherInstall = join(base, "prune-other", "node_modules", "@kahme247", "ompweb");
  mkdirSync(otherInstall, { recursive: true });
  const other = finishedAttempt("prune-other-install", otherInstall, 500);
  mkdirSync(join(parent, ".ompweb-failed-prune-other-install"));
  const outside = join(base, "outside-the-install");
  mkdirSync(outside);
  writeFileSync(join(outside, "precious.txt"), "keep");
  const link = finishedAttempt("prune-link", install, 100, []);
  if (!windows) symlinkSync(outside, join(parent, ".ompweb-staging-prune-link"));

  worker.pruneHostUpdateArtifacts(install);

  assert.equal(existsSync(join(parent, ".ompweb-backup-prune-c")), true);
  for (const id of ["prune-a", "prune-b"]) assert.equal(existsSync(join(parent, `.ompweb-backup-${id}`)), false, `old backup ${id}`);
  for (const id of ["prune-a", "prune-b", "prune-c"]) {
    assert.equal(existsSync(join(parent, `.ompweb-failed-${id}`)), false, `failed ${id}`);
    assert.equal(existsSync(join(parent, `.ompweb-staging-${id}`)), false, `staging ${id}`);
  }
  assert.equal(existsSync(join(stateRoot, "prune-a")), false);
  assert.equal(existsSync(join(stateRoot, "prune-b")), false);
  assert.equal(existsSync(join(latest, "descriptor.json")), true);
  assert.equal(existsSync(join(latest, "runtime")), false);
  assert.equal(existsSync(join(latest, "worker.mts")), false);
  assert.equal(existsSync(join(parent, ".ompweb-backup-user-data")), true);
  assert.equal(existsSync(join(parent, ".ompweb-failed-prune-other-install")), true);
  assert.equal(existsSync(join(other, "runtime")), true);
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep");
  if (!windows) {
    assert.equal(existsSync(join(parent, ".ompweb-staging-prune-link")), true);
    assert.equal(existsSync(link), true, "an attempt whose staging path is a link is not provably ours");
  }
});

test("pruning leaves everything alone while an update is running and keeps the finishing attempt's failed candidate", () => {
  const { install, parent } = pruneScenario("prune-running");
  finishedAttempt("running-a", install, 1000);
  latestStatus("running-a", "running");
  worker.pruneHostUpdateArtifacts(install);
  assert.equal(existsSync(join(parent, ".ompweb-staging-running-a")), true);
  assert.equal(existsSync(join(stateRoot, "running-a", "runtime")), true);

  finishedAttempt("keep-b", install, 2000);
  latestStatus("keep-b");
  worker.pruneHostUpdateArtifacts(install, { keepAttempt: "keep-b" });
  assert.equal(existsSync(join(parent, ".ompweb-failed-keep-b")), true, "the finishing attempt's failed candidate stays for diagnosis");
  assert.equal(existsSync(join(parent, ".ompweb-failed-running-a")), false);
  assert.equal(existsSync(join(stateRoot, "keep-b", "runtime")), false);
});
