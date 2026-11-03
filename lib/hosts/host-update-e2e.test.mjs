// The real engine (startHostUpdate) -> the copied worker -> a real relaunched host that calls the production
// acknowledgeHostUpdateHealth(). Everything is disposable: a fake npm, fake releases and a fake "old daemon" process.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { jitiPath, repo, repoVersion, spawnNodeOutsideService, writeManager, writeRelease } from "./update-fixture.test-helper.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "host-update-e2e-")));
const cleanup = [];
after(() => {
  for (const stop of cleanup) { try { stop(); } catch {} }
  rmSync(base, { recursive: true, force: true });
});
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function runUpdate(name, candidateKind) {
  const work = join(base, name);
  const agent = join(work, "agent");
  const stateRoot = join(agent, "omp-web", "host-update");
  const install = join(work, "node_modules", "@kahme247", "ompweb");
  // The old release IS this build's version: the daemon (the repo's engine) records it as fromVersion.
  writeRelease(install, repoVersion, "ack");
  for (let dir = install; dir !== base; dir = dirname(dir)) chmodSync(dir, 0o755);
  const candidate = join(work, "candidate");
  writeRelease(candidate, "99.0.0", candidateKind);
  const bin = join(work, "bin");
  mkdirSync(bin);
  const manager = writeManager(work, { method: "npm", version: "99.0.0", releaseDir: candidate });
  copyFileSync(manager, join(bin, process.platform === "win32" ? "npm.cmd" : "npm"));
  chmodSync(join(bin, process.platform === "win32" ? "npm.cmd" : "npm"), 0o755);
  const script = join(work, "daemon.cjs");
  writeFileSync(script, `
    const assert = require("node:assert/strict");
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
  cleanup.push(() => child.kill());
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
  const healthFile = join(attempt, "health.json");
  if (existsSync(healthFile)) cleanup.push(() => process.kill(read(healthFile).pid, "SIGTERM"));
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
