import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { jitiPath, nodeBinary, releaseArchive, writeManager, writeRelease } from "./update-fixture.test-helper.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "host-update-worker-")));
const saved = { ...process.env };
const stateRoot = join(base, "agent", "omp-web", "host-update");
const windows = process.platform === "win32";
const posixOnly = windows ? "The disposable binary release is a POSIX shell script; archive, digest and state validation still run on Windows" : false;
let worker;
let ids; // lib/process-identity.ts
let lifecycle; // lib/upgrade-process.ts
let updates;
const hostPids = join(base, "host-pids"); // every fake host the worker launches appends its own pid here, health.json or not
const pidFiles = [hostPids]; // plus the web a fake manager starts
const children = [];

before(async () => {
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  delete process.env.OMP_WEB_PACKAGE_DIR;
  delete process.env.OMP_WEB_DISABLE_AUTOUPDATE;
  worker = await import("./update-worker.ts");
  ids = await import("../process-identity.ts");
  lifecycle = await import("../upgrade-process.ts");
  updates = await import("./updates.ts");
});
after(async () => {
  // Everything that may still hold `base` (its cwd or an open file): the stand-ins, every launched host and the fake manager's web.
  const pids = new Set(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => child.pid));
  for (const file of pidFiles) { try { for (const pid of readFileSync(file, "utf8").split("\n")) pids.add(Number(pid)); } catch {} }
  const running = [...pids].filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && alive(pid));
  for (const pid of running) { try { process.kill(pid, "SIGTERM"); } catch {} }
  // A kill is asynchronous and on Windows the process keeps its cwd and handles until it is gone: wait, or rmSync hits EBUSY.
  for (const stop = Date.now() + 10000; running.some(alive) && Date.now() < stop;) await wait(50);
  // Key by key, not `process.env = saved`: Bun on Windows writes process.env through to the OS (os.homedir() reads USERPROFILE).
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  // Bun ignores maxRetries/retryDelay (EBUSY comes back at once), so retry here as well.
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch (error) { if (tries === 50) throw error; await wait(100); }
  }
});

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const status = () => read(join(stateRoot, "status.json"));
const versionOf = (dir) => read(join(dir, "package.json")).version;
const alive = (pid) => ids.isProcessAlive(pid);
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** The idle child ("a session": it runs a script of the installed runner) a daemon fixture spawns; it ends with its daemon unless `orphan`. */
const sessionDaemonScript = (idle, pidFile, orphan) => `const s=require("node:child_process").spawn(process.execPath,[${JSON.stringify(idle)}],{stdio:"ignore"});require("node:fs").appendFileSync(${JSON.stringify(pidFile)},s.pid+"\\n");${orphan ? "" : `process.on("SIGTERM",()=>{s.kill();process.exit(0);});`}setInterval(()=>{},1000);`;

/**
 * One update attempt on disk exactly as the engine leaves it, with a real old release and a real candidate release. The
 * old daemon is a real process started the way its release starts a host and inspected by the real lifecycle, so the
 * descriptor carries a real process snapshot. `sessions`: the daemon also runs a session process of the install ("owned":
 * it ends with the daemon; "orphan": it outlives it). `loop`: the daemon runs under a README-style restart-loop script.
 */
async function fixture(id, { candidate = "ack", installKind = "ack", method = "npm", from = "1.0.0", to = "2.0.0", binary = false, restartOnly = false, webDuringInstall = false, identity, force = false, receipt, sessions, loop = false } = {}) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const attempt = join(stateRoot, id);
  mkdirSync(attempt, { mode: 0o700 });
  const work = join(base, id);
  const webPidFile = join(work, "web.pid");
  const sessionPids = join(work, "session.pid");
  pidFiles.push(webPidFile, sessionPids);
  const install = binary ? join(work, "renamed-release") : join(work, "node_modules", "@kahme247", "ompweb");
  writeRelease(install, restartOnly ? to : from, installKind, { binary, pidFile: hostPids });
  for (let dir = install; dir !== base; dir = dirname(dir)) chmodSync(dir, 0o755);
  const release = join(work, "candidate");
  writeRelease(release, to, candidate, { binary, pidFile: hostPids });
  const manager = binary ? undefined : writeManager(work, { method, version: to, releaseDir: release, dependenciesDir: join(work, "candidate-modules"), webDuringInstall: webDuringInstall && { script: join(install, "bin", "idle-web.js"), pidFile: webPidFile } });
  const layout = { installMethod: binary ? "binary" : method, installDir: install, runtime: nodeBinary(), hostArgs: ["--allow-http"], cwd: tmpdir() }; // the daemons run in cwd: not inside `base`, which a live process blocks removing
  const launch = worker.hostLaunch(layout);
  let starter;
  let daemonPid;
  if (loop) {
    const hostPidFile = join(work, "host.pid");
    const script = join(work, "ompweb-host-run");
    writeFileSync(script, `#!/bin/sh\nwhile true; do\n  ${[launch.command, ...launch.args].map((arg) => `"${arg}"`).join(" ")} &\n  echo $! > "${hostPidFile}"\n  wait $!\n  code=$?\n  [ "$code" -eq 0 ] && break\n  sleep 1\ndone\n`, { mode: 0o700 });
    starter = spawn("sh", [script], { cwd: tmpdir(), env: launch.env, stdio: "ignore" });
    pidFiles.push(hostPidFile);
    for (let tries = 0; !existsSync(hostPidFile) || !readFileSync(hostPidFile, "utf8").trim(); tries++) { assert.ok(tries < 100, "the restart loop never started its host"); await wait(100); }
    daemonPid = Number(readFileSync(hostPidFile, "utf8"));
  } else {
    // `node -e <script> <host script> ...` is still `omp-web-host.js` to the inspection: a daemon that also owns a session.
    starter = sessions ? spawn(nodeBinary(), ["-e", sessionDaemonScript(join(install, "bin", "idle-web.js"), sessionPids, sessions === "orphan"), ...launch.args], { cwd: launch.cwd, env: launch.env, stdio: "ignore" }) : spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "ignore" });
    daemonPid = starter.pid;
    for (let tries = 0; sessions && !existsSync(sessionPids); tries++) { assert.ok(tries < 100, "the daemon never started its session"); await wait(100); }
  }
  children.push(starter);
  const daemon = { pid: daemonPid, kill: (signal) => process.kill(daemonPid, signal) };
  const snapshot = await lifecycle.inspectUpgradeProcess({ pid: daemonPid, installDir: install, role: "host", launch });
  const operation = { id, target: "ompweb", version: to, state: "running", ...(force ? { force: true } : {}) };
  writeFileSync(join(stateRoot, "status.json"), JSON.stringify({ operation, daemonPid, workerPid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
  const descriptor = {
    id, target: "ompweb", version: to, fromVersion: from, installMethod: layout.installMethod, installDir: install, runtime: layout.runtime,
    hostArgs: layout.hostArgs, cwd: layout.cwd, daemonPid,
    // `identity` fakes a recycled pid: the snapshot names another process start.
    process: identity ? { ...snapshot, identity, current: { ...snapshot.current, identity } } : snapshot,
    managerPath: manager, restartOnly: restartOnly || undefined, releaseRepo: "ompweb-dev/ompweb", force: force || undefined, receipt,
  };
  const descriptorPath = join(attempt, "descriptor.json");
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  return { descriptorPath, install, daemon, starter, snapshot, attempt, work, sessionPids, backup: join(dirname(install), `.ompweb-backup-${id}`), failed: join(dirname(install), `.ompweb-failed-${id}`), webPidFile };
}
const sessionPidsOf = (f) => readFileSync(f.sessionPids, "utf8").split("\n").filter(Boolean).map(Number);
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
    if (String(url) === "https://api.github.com/repos/ompweb-dev/ompweb/releases/tags/v2.0.0") return Response.json({ tag_name: "v2.0.0", assets: [{ name: `${worker.hostReleaseName()}.tar.gz`, digest }] });
    assert.equal(String(url), `https://github.com/ompweb-dev/ompweb/releases/download/v2.0.0/${worker.hostReleaseName()}.tar.gz`);
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
  assert.match(status().operation.error, /exited before health acknowledgement/);
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

test("repository metadata remains required for installation and malformed metadata cannot authorize a restart", async () => {
  for (const restartOnly of [false, true]) {
    const f = await fixture(`repository-boundary-${restartOnly}`, { restartOnly });
    const descriptor = read(f.descriptorPath);
    if (restartOnly) descriptor.releaseRepo = "not/a/repository";
    else delete descriptor.releaseRepo;
    writeFileSync(f.descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.match(status().operation.error, /descriptor/);
    assert.equal(alive(f.daemon.pid), true);
    assert.equal(versionOf(f.install), restartOnly ? "2.0.0" : "1.0.0");
  }
});

test("binary archives reject path traversal, links and excessive sizes; a release with its omp runner fits", () => {
  const tar = new Uint8Array(2048);
  function entry(name, type = "0", size = "00000000000") {
    tar.fill(0); Buffer.from(name).copy(tar); Buffer.from(size).copy(tar, 124); tar[156] = type.charCodeAt(0); return tar;
  }
  assert.throws(() => worker.validateHostReleaseArchive(entry("../outside"), "ompweb-linux-x64"), /path|member/i);
  assert.throws(() => worker.validateHostReleaseArchive(entry("ompweb-linux-x64/link", "2"), "ompweb-linux-x64"), /type|link/i);
  assert.throws(() => worker.validateHostReleaseArchive(entry("ompweb-linux-x64/huge", "0", "77777777777"), "ompweb-linux-x64"), /size|large/i);
  // The measured linux-x64 runner is 283,711,664 B and ompweb 111.6 MB: both must fit with headroom.
  assert.ok(worker.HOST_RELEASE_MAX_MEMBER >= 1.5 * 283_711_664);
  assert.ok(worker.HOST_RELEASE_MAX_EXPANDED >= 2 * (283_711_664 + 111_600_000));
  assert.ok(worker.HOST_RELEASE_MAX_ARCHIVE >= 2 * 231_000_000, "the gzipped release is about 231 MB");
  const sized = (size) => { entry("ompweb-linux-x64/ompweb-omp", "0", size.toString(8).padStart(11, "0")); Buffer.from("        ").copy(tar, 148); Buffer.from(tar.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") + "\0 ").copy(tar, 148); return tar; };
  // The header alone claims the size: past the limit it is refused before the (missing) data is looked at.
  assert.throws(() => worker.validateHostReleaseArchive(sized(worker.HOST_RELEASE_MAX_MEMBER + 1), "ompweb-linux-x64"), /too large/i);
  assert.throws(() => worker.validateHostReleaseArchive(sized(283_711_664), "ompweb-linux-x64"), /invalid release tar header or size/i, "a runner-sized member passes the size limits and fails only on the missing data");
});

test("a release download streams to disk with its digest and stops at the size limit", async () => {
  const original = globalThis.fetch;
  const dir = mkdtempSync(join(base, "download-"));
  const chunk = new Uint8Array(64 * 1024).fill(7);
  let pulled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({ pull(controller) { if (pulled++ < 16) controller.enqueue(chunk); else controller.close(); } }));
  try {
    const file = join(dir, "ok.tar.gz");
    const digest = await worker.downloadHostUpdateFile("https://github.com/x", file, 16 * chunk.length);
    const expected = createHash("sha256");
    for (let index = 0; index < 16; index++) expected.update(chunk);
    assert.equal(digest, `sha256:${expected.digest("hex")}`);
    assert.equal(readFileSync(file).length, 16 * chunk.length);
    pulled = 0;
    await assert.rejects(worker.downloadHostUpdateFile("https://github.com/x", join(dir, "big.tar.gz"), 4 * chunk.length), /too large/i);
    assert.ok(pulled < 16, "the body is cancelled at the limit, not read to the end");
    globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) { init.signal.addEventListener("abort", () => controller.error(init.signal.reason)); } }));
    await assert.rejects(worker.downloadHostUpdateFile("https://github.com/x", join(dir, "slow.tar.gz"), 1024, 50), /abort/i);
  } finally { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
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
  const out = join(mkdtempSync(join(base, "zip-")), "ompweb.exe");
  entry.write(out);
  assert.equal(readFileSync(out, "utf8"), "hello");
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

test("a binary candidate whose omp fails its preflight never stops the daemon or touches the install", { skip: posixOnly }, async () => {
  const f = await fixture("binary-preflight", { binary: true, candidate: "no-hello" });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, {});
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.match(status().operation.error, /cannot start a session: preflight failed: .*ompweb-omp: no hello within 30 s/);
    assert.equal(alive(f.daemon.pid), true);
    assert.equal(readFileSync(join(f.install, "dist", "index.html"), "utf8"), "static files 1.0.0");
    assert.equal(existsSync(f.backup), false);
  } finally { restore(); }
});

test("a binary release without its runner fetches it with its own fetch-omp before its preflight", { skip: posixOnly }, async () => {
  const f = await fixture("binary-fetch", { binary: true, candidate: "fetch-omp" });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, {});
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
    assert.equal(readFileSync(join(f.install, "steps"), "utf8"), "fetch-omp\npreflight\n");
    assert.equal(existsSync(join(f.install, "ompweb-omp")), true, "the fetched runner is part of the new install");
  } finally { restore(); }
});

test("a binary candidate that cannot fetch its runner never stops the daemon", { skip: posixOnly }, async () => {
  const f = await fixture("binary-fetch-fails", { binary: true, candidate: "fetch-fails" });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, {});
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.match(status().operation.error, /could not fetch its omp: fetch-omp failed: Could not fetch ompweb's omp from https:\/\/github\.com\/x/);
    assert.equal(alive(f.daemon.pid), true);
    assert.equal(readFileSync(join(f.install, "dist", "index.html"), "utf8"), "static files 1.0.0");
  } finally { restore(); }
});

test("a binary candidate built before the preflight command ships a runner, so it is refused before any stop", { skip: posixOnly }, async () => {
  const f = await fixture("binary-no-preflight", { binary: true, candidate: "no-preflight" });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, {});
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.equal(status().operation.error, "The new host release has no preflight command to check its omp with");
    assert.equal(alive(f.daemon.pid), true);
    assert.equal(readFileSync(join(f.install, "dist", "index.html"), "utf8"), "static files 1.0.0");
  } finally { restore(); }
});

test("the updater looks for the marker only lib/hosts/preflight.ts embeds", async () => {
  const { PREFLIGHT_MARKER } = await import("./preflight.ts");
  assert.equal(Buffer.from(worker.PREFLIGHT_MARKER_BASE64, "base64").toString(), PREFLIGHT_MARKER);
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

test("restart-only of a binary installation from before the preflight command restarts it unchecked", { skip: posixOnly }, async () => {
  const f = await fixture("restart-only-no-preflight", { binary: true, restartOnly: true, installKind: "no-preflight" });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("restart-only must not download a release"); };
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
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
  const first = await ids.processStartIdentity(process.pid);
  assert.ok(first && first === await ids.processStartIdentity(process.pid));
  assert.notEqual(await ids.processStartIdentity(other.pid), first);
  other.kill();
  while (alive(other.pid)) await wait(50);
  assert.equal(await ids.processStartIdentity(other.pid), null);
});

test("copied standalone worker runs on Node without the original package or Bun globals", async () => {
  const f = await fixture("standalone");
  writeFileSync(join(f.attempt, "package.json"), '{"type":"commonjs"}');
  // The same copy the engine makes: the worker and the modules it imports at runtime, beside it as .mts.
  const copy = updates.copyHostWorkerSources(fileURLToPath(new URL("./update-worker.ts", import.meta.url)), f.attempt);
  assert.deepEqual(readdirSync(f.attempt).filter((name) => name.endsWith(".mts")).sort(), ["process-identity.mts", "upgrade-process.mts", "worker.mts"]);
  const child = spawn(nodeBinary(), [copy, "--host-update-descriptor", f.descriptorPath], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
  assert.equal(code, 0, `${stderr}\n${outcome(f)}`);
  assert.equal(status().operation.state, "succeeded");
});

/** Runs `copy` as a launched worker runs: `runtime` with the descriptor. */
async function runCopiedWorker(runtime, copy, f) {
  const child = spawn(runtime, [copy, "--host-update-descriptor", f.descriptorPath], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
  return { code, stderr };
}

test("a copied worker runs under Bun too, from the private copies beside it and not the install it replaces", { skip: process.versions.bun ? false : "the suite runs under Bun; this test needs the Bun that runs it" }, async () => {
  // A web server on Bun (npm install) starts local recovery with this same loose copy; it is not a compiled binary with embedded modules.
  const f = await fixture("standalone-bun");
  const copy = updates.copyHostWorkerSources(fileURLToPath(new URL("./update-worker.ts", import.meta.url)), f.attempt);
  const { code, stderr } = await runCopiedWorker(process.execPath, copy, f);
  assert.equal(code, 0, `${stderr}\n${outcome(f)}`);
  assert.equal(status().operation.state, "succeeded");
  assert.equal(versionOf(f.install), "2.0.0");
  assert.equal(read(join(f.attempt, "health.json")).version, "2.0.0");
});

test("a copied worker launched through a symlinked directory still runs the update", async (t) => {
  const f = await fixture("symlink-entry");
  updates.copyHostWorkerSources(fileURLToPath(new URL("./update-worker.ts", import.meta.url)), f.attempt);
  const linkDir = join(f.work, "linked-agent");
  try { symlinkSync(f.attempt, linkDir, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (error?.code === "EPERM") return t.skip("Creating symbolic links requires additional privileges on this platform");
    throw error;
  }
  const linked = join(linkDir, "worker.mts");
  assert.notEqual(realpathSync(linked), linked);
  const { code, stderr } = await runCopiedWorker(nodeBinary(), linked, f);
  assert.equal(code, 0, `${stderr}\n${outcome(f)}`);
  assert.equal(status().operation.state, "succeeded");
  assert.equal(versionOf(f.install), "2.0.0");
});

test("a historical updater that copies only the worker file still runs it on Node, loading the lifecycle from the owned installation", async () => {
  // The restart-only worker of a daemon that predates the flat copies: no dependencies beside it, no release repository.
  const f = await fixture("single-file", { restartOnly: true });
  const shim = join(f.work, "node_modules", "jiti");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "package.json"), '{"name":"jiti","main":"index.js"}');
  writeFileSync(join(shim, "index.js"), `module.exports = require(${JSON.stringify(jitiPath)});`);
  const descriptor = read(f.descriptorPath);
  delete descriptor.releaseRepo;
  writeFileSync(f.descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  const copy = join(f.attempt, "worker.mts");
  copyFileSync(fileURLToPath(new URL("./update-worker.ts", import.meta.url)), copy);
  assert.deepEqual(readdirSync(f.attempt).filter((name) => name.endsWith(".mts")), ["worker.mts"]);
  const { code, stderr } = await runCopiedWorker(nodeBinary(), copy, f);
  assert.equal(code, 0, `${stderr}\n${outcome(f)}`);
  assert.equal(status().operation.state, "succeeded");
  assert.equal(read(join(f.attempt, "health.json")).version, "2.0.0");
  assert.equal(alive(f.daemon.pid), false);
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

test("a legacy restart-only descriptor needs no release repository and still verifies the new daemon", async () => {
  const f = await fixture("legacy-restart-only", { restartOnly: true });
  const descriptor = read(f.descriptorPath);
  delete descriptor.releaseRepo;
  writeFileSync(f.descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  assert.equal(read(join(f.attempt, "health.json")).version, "2.0.0");
  assert.equal(existsSync(f.backup), false);
  assert.equal(alive(f.daemon.pid), false);
});

test("a normal update records neither a force nor a commit", async () => {
  const f = await fixture("normal-record");
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  const { operation } = status();
  assert.deepEqual([operation.state, operation.force, operation.committing], ["succeeded", undefined, undefined]);
});

test("a descriptor an earlier engine wrote (an identity, no process snapshot) is inspected now and stays bound to that identity", async () => {
  const legacy = (f, daemonIdentity) => {
    const descriptor = read(f.descriptorPath);
    delete descriptor.process;
    writeFileSync(f.descriptorPath, JSON.stringify({ ...descriptor, daemonIdentity, systemd: null }), { mode: 0o600 });
  };
  const good = await fixture("legacy-descriptor");
  legacy(good, good.snapshot.identity);
  assert.equal(await worker.runHostUpdateWorker(good.descriptorPath), 0, outcome(good));
  assert.equal(versionOf(good.install), "2.0.0");
  const recycled = await fixture("legacy-recycled");
  legacy(recycled, "recycled:not-the-recorded-start-time");
  assert.equal(await worker.runHostUpdateWorker(recycled.descriptorPath), 1);
  assert.match(status().operation.error, /process identity/i);
  assert.equal(alive(recycled.daemon.pid), true);
  assert.equal(versionOf(recycled.install), "1.0.0");
});

test("a forced update ends the daemon and the sessions it owns without taking them for sharers, then the new daemon acknowledges", { skip: windows ? "the stand-in daemon ends its session on SIGTERM; Windows has no such signal" : false }, async () => {
  const f = await fixture("force-sessions", { force: true, sessions: "owned" });
  const [session] = sessionPidsOf(f);
  assert.equal(alive(session), true);
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  const { operation } = status();
  assert.deepEqual([operation.state, operation.force, operation.committing], ["succeeded", true, true], "the commit that freezes new sessions is recorded before the stop");
  assert.equal(versionOf(f.install), "2.0.0");
  assert.equal(alive(f.daemon.pid), false);
  assert.equal(alive(session), false);
  assert.equal(read(join(f.attempt, "health.json")).version, "2.0.0");
});

test("force never replaces an installation an independent process uses, and ends nothing", { skip: windows ? "the stand-in daemon ends its session on SIGTERM; Windows has no such signal" : false }, async () => {
  const f = await fixture("force-shared", { force: true, sessions: "owned" });
  const [session] = sessionPidsOf(f);
  await idleWebOn(f.install);
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
  assert.match(status().operation.error, /web server first.*shared/i);
  assert.equal(status().operation.committing, undefined, "refused before the commit");
  assert.equal(alive(f.daemon.pid), true);
  assert.equal(alive(session), true);
  assert.equal(versionOf(f.install), "1.0.0");
});

test("a session that outlives the stopped daemon stops the swap and the old release is restarted", { skip: windows ? "the stand-in daemon leaves its session on SIGTERM; Windows has no such signal" : false, timeout: 120_000 }, async () => {
  const f = await fixture("force-orphan", { force: true, sessions: "orphan" });
  const [session] = sessionPidsOf(f);
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1, outcome(f));
  const { operation } = status();
  assert.match(operation.error, /shared with another running process.*did not free it/);
  assert.match(operation.error, /previous host release restored/);
  assert.equal(versionOf(f.install), "1.0.0");
  assert.equal(existsSync(f.backup), false, "nothing was swapped");
  assert.equal(alive(f.daemon.pid), false);
  assert.equal(read(join(f.attempt, "health.json")).version, "1.0.0");
  assert.equal(alive(session), true, "the independent process is untouched");
});

test("force never waives the disable setting or the daemon's process identity", async () => {
  const disabled = await fixture("force-disabled", { force: true });
  process.env.OMP_WEB_DISABLE_AUTOUPDATE = "1";
  try { assert.equal(await worker.runHostUpdateWorker(disabled.descriptorPath), 1); } finally { delete process.env.OMP_WEB_DISABLE_AUTOUPDATE; }
  assert.match(status().operation.error, /disabled/i);
  assert.equal(alive(disabled.daemon.pid), true);
  assert.equal(versionOf(disabled.install), "1.0.0");
  const recycled = await fixture("force-recycled", { force: true, identity: "recycled:not-the-recorded-start-time" });
  assert.equal(await worker.runHostUpdateWorker(recycled.descriptorPath), 1);
  assert.match(status().operation.error, /process identity/i);
  assert.equal(alive(recycled.daemon.pid), true);
  assert.equal(versionOf(recycled.install), "1.0.0");
});

test("force never waives release integrity: a digest mismatch leaves the daemon and the install untouched", { skip: posixOnly }, async () => {
  const f = await fixture("force-wrong-digest", { binary: true, force: true });
  const archive = gzipSync(releaseArchive(join(f.work, "candidate"), worker.hostReleaseName()));
  const restore = stubReleaseFetch(archive, { digest: "sha256:" + createHash("sha256").update("some other asset").digest("hex") });
  try {
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1);
    assert.match(status().operation.error, /digest/i);
    assert.equal(status().operation.committing, undefined, "staging failed before the commit");
    assert.equal(alive(f.daemon.pid), true);
    assert.equal(readFileSync(join(f.install, "dist", "index.html"), "utf8"), "static files 1.0.0");
  } finally { restore(); }
});

test("a maintenance receipt acknowledges a candidate awaiting its server's cutover only with this operation's preflight proof and an approved protocol", async () => {
  const accepted = await fixture("receipt-accepted", { candidate: "receipt", receipt: { min: 12, max: 12 } });
  assert.equal(await worker.runHostUpdateWorker(accepted.descriptorPath), 0, outcome(accepted));
  const health = read(join(accepted.attempt, "health.json"));
  assert.equal(health.receipt, read(join(accepted.attempt, "preflight.json")).nonce);
  assert.equal(health.protocol, 12);
  assert.equal(versionOf(accepted.install), "2.0.0");
  for (const [id, candidate, receipt] of [["receipt-forged", "forged-receipt", { min: 12, max: 12 }], ["receipt-range", "out-of-range-receipt", { min: 12, max: 12 }], ["receipt-unapproved", "forged-receipt", undefined]]) {
    const f = await fixture(id, { candidate, receipt });
    assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 1, id);
    assert.match(status().operation.error, /maintenance receipt does not match/, id);
    assert.match(status().operation.error, /previous host release restored/, id);
    assert.equal(versionOf(f.install), "1.0.0", id);
    assert.equal(read(join(f.attempt, "health.json")).version, "1.0.0", id);
  }
});

test("a host under a restart-loop script is stopped and restarted through the loop, never beside it", { skip: windows ? "the restart loop is a POSIX shell script; Windows supervisors are inspected by their own native tests" : false, timeout: 120_000 }, async () => {
  const f = await fixture("restart-loop", { loop: true });
  assert.equal(f.snapshot.supervisor.kind, "restart-loop");
  assert.equal(await worker.runHostUpdateWorker(f.descriptorPath), 0, outcome(f));
  assert.equal(versionOf(f.install), "2.0.0");
  const health = read(join(f.attempt, "health.json"));
  assert.equal(health.version, "2.0.0");
  assert.equal(alive(f.starter.pid), true, "the loop survives the update it supervises");
  assert.equal(Number(execFileSync("ps", ["-o", "ppid=", "-p", String(health.pid)], { encoding: "utf8" }).trim()), f.starter.pid, "the new host is the loop's own child, not a second daemon beside it");
  assert.equal(alive(f.daemon.pid), false);
});

test("a running Windows executable locks its release directory, and the swap waits for it to exit", { skip: windows ? false : "directory locking by a running .exe is Windows behaviour" }, async () => {
  const dir = join(base, "locked-release");
  mkdirSync(dir);
  const executable = join(dir, "ompweb.exe");
  writeFileSync(executable, readFileSync(nodeBinary()), { mode: 0o755 });
  const running = spawn(executable, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", cwd: tmpdir() });
  children.push(running);
  await wait(500);
  setTimeout(() => running.kill(), 1200);
  await worker.moveHostRelease(dir, `${dir}-moved`);
  assert.equal(existsSync(join(`${dir}-moved`, "ompweb.exe")), true);
  assert.equal(existsSync(dir), false);
});
