// The real engine (startHostUpdate) -> the copied worker -> a real relaunched host that calls the production
// acknowledgeHostUpdateHealth(). Everything is disposable: a fake npm, fake releases and a fake "old daemon" process.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { jitiPath, repo, repoVersion, spawnNodeOutsideService, writeManager, writeRelease } from "./update-fixture.test-helper.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "host-update-e2e-")));
const children = [];
const statusFiles = [];
const hostPids = join(base, "host-pids");
/** The command line of `pid`, or null when it is gone or unreadable. */
async function commandLine(pid) {
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    if (process.platform === "win32") {
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { timeout: 10_000, windowsHide: true });
      return stdout;
    }
    return (await promisify(execFile)("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5000 })).stdout;
  } catch { return null; }
}
after(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  const running = children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => child.pid);
  const recorded = new Set();
  // On Windows the child is cmd.exe, not the actual daemon; the engine records the latter and its detached worker.
  for (const file of statusFiles) {
    if (existsSync(file)) {
      const state = read(file);
      recorded.add(state.daemonPid);
      recorded.add(state.workerPid);
    }
  }
  if (existsSync(hostPids)) for (const pid of readFileSync(hostPids, "utf8").split("\n")) recorded.add(Number(pid));
  // A recorded pid may have exited and been reused: signal it only while it still runs a script from this test's
  // own temporary directory, which no other process names.
  // shortcut: Node has no process handle for these pids, so one that exits between this check and the signal leaves a
  // reuse window (wider on Windows, where the check runs PowerShell); close it if handle-based signalling arrives.
  const ours = (line) => process.platform === "win32" ? line.toLowerCase().includes(base.toLowerCase()) : line.includes(base);
  for (const pid of recorded) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) continue;
    let line = await commandLine(pid);
    if (line === null && alive(pid)) line = await commandLine(pid);
    // A live process that cannot be identified must not be skipped silently: it may still hold the directory.
    assert.ok(line !== null || !alive(pid), `cannot read the command line of recorded process ${pid}`);
    if (!line || !ours(line)) continue;
    try { process.kill(pid, "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    running.push(pid);
  }
  // A termination signal does not release a process's cwd or open files until it exits.
  for (const deadline = Date.now() + 10_000; running.some(alive) && Date.now() < deadline;) await wait(50);
  assert.ok(!running.some(alive), "test-owned processes must exit before their directory is removed");
  // Bun ignores rmSync's maxRetries/retryDelay; handles can take a moment to release on Windows.
  for (let tries = 0; ; tries++) {
    try { return rmSync(base, { recursive: true, force: true }); }
    catch (error) {
      if (tries === 50 || !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      await wait(100);
    }
  }
});
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
function alive(pid) {
  try {
    // A zombie has already released its cwd and handles, even while kill(pid, 0) succeeds.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat[stat.lastIndexOf(")") + 2] === "Z") return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH" || error.code === "ENOENT") return false;
    throw error;
  }
}

async function runUpdate(name, candidateKind) {
  const work = join(base, name);
  const agent = join(work, "agent");
  const stateRoot = join(agent, "omp-web", "host-update");
  statusFiles.push(join(stateRoot, "status.json"));
  const install = join(work, "node_modules", "@kahme247", "ompweb");
  // The old release IS this build's version: the daemon (the repo's engine) records it as fromVersion.
  writeRelease(install, repoVersion, "ack", { pidFile: hostPids });
  for (let dir = install; dir !== base; dir = dirname(dir)) chmodSync(dir, 0o755);
  const candidate = join(work, "candidate");
  writeRelease(candidate, "99.0.0", candidateKind, { pidFile: hostPids });
  const bin = join(work, "bin");
  mkdirSync(bin);
  const manager = writeManager(work, { method: "npm", version: "99.0.0", releaseDir: candidate });
  copyFileSync(manager, join(bin, process.platform === "win32" ? "npm.cmd" : "npm"));
  chmodSync(join(bin, process.platform === "win32" ? "npm.cmd" : "npm"), 0o755);
  const script = join(work, "daemon.cjs");
  writeFileSync(script, `
    const assert = require("node:assert/strict");
    require("node:fs").appendFileSync(${JSON.stringify(hostPids)}, process.pid + "\\n");
    globalThis.fetch = async (url) => String(url).startsWith("https://registry.npmjs.org/") ? Response.json({ version: "99.0.0" }) : new Response("export const LINK_PROTOCOL_VERSION = 3;");
    process.argv = [process.execPath, ${JSON.stringify(join(install, "bin", "omp-web-host.js"))}, "--allow-http"];
    require(${JSON.stringify(jitiPath)}).createJiti(${JSON.stringify(join(repo, "package.json"))}).import(${JSON.stringify(join(repo, "lib", "hosts", "updates.ts"))}).then(async (api) => {
      api.configureHostUpdateSafety(() => null);
      const info = await api.checkHostUpdates({ min: 3, max: 3 }, true);
      assert.equal(info.ompweb.canUpdate, true, info.ompweb.blockedReason);
      const started = await api.startHostUpdate("ompweb", "99.0.0", { min: 3, max: 3 });
      console.log("started " + process.pid + " " + JSON.stringify(started));
      setInterval(() => {}, 1000);
    }).catch((error) => { console.error(error); process.exit(1); });
  `);
  const env = { ...process.env, HOME: join(work, "home"), USERPROFILE: join(work, "home"), PI_CODING_AGENT_DIR: agent, OMP_WEB_PACKAGE_DIR: install, PATH: bin + delimiter + process.env.PATH };
  delete env.OMP_WEB_DISABLE_AUTOUPDATE;
  const child = await spawnNodeOutsideService(script, env);
  if (!child) return null;
  children.push(child);
  let out = "";
  let exited = false;
  child.stdout.on("data", (data) => { out += data; });
  child.stderr.on("data", (data) => { out += data; });
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + 90_000;
  let operation;
  while (Date.now() < deadline) {
    if (/started \d+ /.test(out) && existsSync(join(stateRoot, "status.json"))) {
      operation = read(join(stateRoot, "status.json")).operation;
      if (operation.state !== "running") break;
    }
    assert.ok(!exited || /started \d+ /.test(out), `the old daemon process failed:\n${out}`);
    await wait(250);
  }
  assert.ok(operation && operation.state !== "running", `the update never finished:\n${out}`);
  const attempt = join(stateRoot, operation.id);
  return { operation, install, attempt, daemonPid: Number(/started (\d+) /.exec(out)[1]), out, versionOf: (dir) => read(join(dir, "package.json")).version, parent: dirname(install), exited: () => exited };
}

const skipReason = "systemd-run cannot create the scope that keeps this test outside the service running the suite";

test("engine update: pinned install, swapped release, the old daemon stopped, the new one acknowledged by production code", { timeout: 120_000 }, async (t) => {
  const run = await runUpdate("success", "ack");
  if (!run) return t.skip(skipReason);
  assert.equal(run.operation.state, "succeeded", run.out + JSON.stringify(run.operation));
  assert.equal(run.versionOf(run.install), "99.0.0");
  assert.equal(run.versionOf(join(run.parent, `.ompweb-backup-${run.operation.id}`)), repoVersion);
  const health = read(join(run.attempt, "health.json"));
  assert.equal(health.version, "99.0.0");
  assert.notEqual(health.pid, run.daemonPid);
  assert.equal(alive(health.pid), true);
  assert.equal(alive(run.daemonPid), false, "the daemon being replaced was stopped");
  assert.equal(existsSync(join(run.attempt, "runtime")), false, "no runtime copy outlives the attempt (a system node is not copied at all)");
});

test("engine update: a candidate that dies at launch is rolled back and the old release acknowledges for real", { timeout: 120_000 }, async (t) => {
  const run = await runUpdate("rollback", "exit");
  if (!run) return t.skip(skipReason);
  assert.equal(run.operation.state, "failed", run.out);
  assert.match(run.operation.error, /exited before health acknowledgement \(4\).*previous host release restored/);
  assert.equal(run.versionOf(run.install), repoVersion);
  const health = read(join(run.attempt, "health.json"));
  assert.equal(health.version, repoVersion);
  assert.equal(alive(health.pid), true);
  assert.equal(run.versionOf(join(run.parent, `.ompweb-failed-${run.operation.id}`)), "99.0.0", "the failed candidate stays for diagnosis until the next update");
});
