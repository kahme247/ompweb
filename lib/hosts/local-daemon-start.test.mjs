import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-local-daemon-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const hostJson = join(agentDir, "omp-web", "host.json");
// Every host this file launches, killed at the end so no test leaves a daemon behind.
const launched = new Set();
after(() => {
  for (const pid of launched) kill(pid);
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

const { ensureLocalHostDaemon, localHostLaunch } = await import("./local-daemon-start.ts");
const { createHostControlServer, hostControlPath, requestHostControl } = await import("./host-control.ts");
const { ensureHostUpdateRoot, hostUpdateRoot, writeHostUpdateJson } = await import("./update-worker.ts");

const kill = (pid) => {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
};
async function sleep(ms) {
  const { promise, resolve: done } = Promise.withResolvers();
  setTimeout(done, ms);
  await promise;
}

const prodEnv = () => ({ ...process.env, NODE_ENV: "production", OMP_WEB_PORT: "30177", OMP_WEB_PASSWORD: "server-secret" });
const missingLaunch = { command: join(agentDir, "no-such-host"), args: [], cwd: agentDir };

// A stand-in daemon: it serves the real control endpoint. Exit codes name what the start must have done first.
const hostControlModule = pathToFileURL(fileURLToPath(new URL("./host-control.ts", import.meta.url))).href;
const fakeHost = join(agentDir, "fake-host.mjs");
writeFileSync(fakeHost, `import { existsSync } from "node:fs";
import { join } from "node:path";
// The link must exist before the daemon starts, and server secrets must not reach it.
if (!existsSync(join(process.env.PI_CODING_AGENT_DIR, "omp-web", "host.json"))) process.exit(3);
if (process.env.OMP_WEB_PASSWORD) process.exit(4);
const { createHostControlServer } = await import(${JSON.stringify(hostControlModule)});
await createHostControlServer(() => ({ pid: process.pid, version: "0.0.0", protocol: 10, linked: false, drained: false, executable: process.execPath, entrypoint: "fake-host" }));
setInterval(() => {}, 1 << 30);
`);
const fakeLaunch = { command: process.execPath, args: [fakeHost], cwd: agentDir };

// A web server's start, in its own process that exits right after starting the daemon.
const launcherModule = pathToFileURL(fileURLToPath(new URL("./local-daemon-start.ts", import.meta.url))).href;
const starter = join(agentDir, "starter.mjs");
writeFileSync(starter, `import { writeFileSync } from "node:fs";
const { ensureLocalHostDaemon } = await import(${JSON.stringify(launcherModule)});
const result = await ensureLocalHostDaemon({ env: { ...process.env, NODE_ENV: "production", OMP_WEB_PORT: "30177" }, launch: JSON.parse(process.env.OMP_TEST_LAUNCH) });
writeFileSync(process.env.OMP_TEST_RESULT, JSON.stringify(result));
process.exit(0);
`);
async function startFromServer(name) {
  const resultFile = join(agentDir, `result-${name}.json`);
  const child = spawn(process.execPath, [starter], {
    env: { ...process.env, OMP_TEST_LAUNCH: JSON.stringify(fakeLaunch), OMP_TEST_RESULT: resultFile },
    stdio: "ignore",
  });
  const exited = Promise.withResolvers();
  child.once("error", exited.reject);
  child.once("exit", (code) => (code === 0 ? exited.resolve() : exited.reject(new Error(`server start exited ${code}`))));
  await exited.promise;
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  if (result.pid) launched.add(result.pid);
  return result;
}

/** Kills a host and waits until its endpoint stops answering, so the next start sees no daemon. */
async function stopHost(pid) {
  kill(pid);
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await requestHostControl("status"); } catch { return; }
    await sleep(100);
  }
  throw new Error(`host ${pid} still answers after SIGKILL`);
}

test("with no daemon, the server prepares the link, then starts the host it launched", { timeout: 30_000 }, async () => {
  rmSync(hostJson, { force: true });
  const result = await ensureLocalHostDaemon({ env: prodEnv(), launch: fakeLaunch });
  launched.add(result.pid);
  assert.deepEqual(result, { started: true, pid: result.pid });
  assert.equal((await requestHostControl("status")).pid, result.pid);
  await stopHost(result.pid);
});

test("an existing daemon, current or drained, is reused and nothing is launched", async (t) => {
  const endpoint = await createHostControlServer(() => ({ pid: process.pid, version: "0.6.0", protocol: 10, linked: true, drained: true, executable: process.execPath, entrypoint: "test" }));
  t.after(() => endpoint.close());
  assert.deepEqual(await ensureLocalHostDaemon({ env: prodEnv(), launch: missingLaunch }), { started: false, pid: process.pid });
});

test("a web server that exits leaves the host it started running", { timeout: 40_000 }, async () => {
  const result = await startFromServer("exit");
  assert.equal(result.started, true);
  // The server process has exited; its host must still answer on the control endpoint.
  assert.equal((await requestHostControl("status")).pid, result.pid);
  await stopHost(result.pid);
});

test("two web servers starting at once leave exactly one host", { timeout: 60_000 }, async () => {
  const results = await Promise.all([startFromServer("first"), startFromServer("second")]);
  assert.equal(results.filter((result) => result.started).length, 1);
  const host = (await requestHostControl("status")).pid;
  assert.deepEqual(results.map((result) => result.pid), [host, host]);
  await stopHost(host);
});

test("development and unlinked servers start no daemon and write no link", async () => {
  rmSync(hostJson, { force: true });
  const development = await ensureLocalHostDaemon({ env: { NODE_ENV: "development", OMP_WEB_PORT: "30177" }, launch: missingLaunch });
  assert.equal(development.started, false);
  assert.match(development.skipped, /development/);
  const unlinked = await ensureLocalHostDaemon({ env: { NODE_ENV: "production" }, launch: missingLaunch });
  assert.equal(unlinked.started, false);
  assert.match(unlinked.skipped, /OMP_WEB_PORT/);
  assert.equal(existsSync(hostJson), false);
});

test("a host update that owns this machine is not replaced while its daemon is down", async () => {
  ensureHostUpdateRoot();
  const status = join(hostUpdateRoot(), "status.json");
  writeHostUpdateJson(status, { operation: { id: "update-1", target: "ompweb", version: "0.7.0", state: "running" }, startedAt: Date.now(), daemonPid: process.pid });
  try {
    const result = await ensureLocalHostDaemon({ env: prodEnv(), launch: missingLaunch });
    assert.equal(result.started, false);
    assert.match(result.skipped, /0\.7\.0/);
  } finally {
    rmSync(status, { force: true });
  }
});

test("an active leased server update is not replaced by autostart, even if its coordinator is gone", async () => {
  const state = await import("../self-update-state.ts");
  const root = state.resolveSelfUpdateTempRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = "00000000-0000-4000-8000-0000000000a1";
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  try {
    for (const owner of [{ workerPid: process.pid }, { coordinatorPid: child.pid }]) {
      state.atomicWrite(state.leasePath(), JSON.stringify({ attemptId: id, expiresAt: Date.now() + 60_000 }));
      state.atomicWrite(state.statusPath(), JSON.stringify({ attemptId: id, state: "running", fromVersion: "0.7.1", targetVersion: "0.7.2", preparedAt: new Date().toISOString(), ...owner }));
      const result = await ensureLocalHostDaemon({ env: prodEnv(), launch: missingLaunch });
      assert.equal(result.started, false);
      assert.match(result.skipped, /0\.7\.2/);
    }
  } finally {
    state.removeSecureFile(state.statusPath());
    state.removeSecureFile(state.leasePath());
  }
});

test("an expired server update does not block autostart", { timeout: 20_000 }, async () => {
  const state = await import("../self-update-state.ts");
  const root = state.resolveSelfUpdateTempRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = "00000000-0000-4000-8000-0000000000a2";
  state.atomicWrite(state.leasePath(), JSON.stringify({ attemptId: id, expiresAt: Date.now() - 1 }));
  state.atomicWrite(state.statusPath(), JSON.stringify({ attemptId: id, state: "running", fromVersion: "0.7.1", targetVersion: "0.7.2", preparedAt: new Date().toISOString(), coordinatorPid: process.pid }));
  try {
    await assert.rejects(ensureLocalHostDaemon({ env: prodEnv(), launch: missingLaunch }), /Could not start the local host/);
  } finally {
    state.removeSecureFile(state.statusPath());
    state.removeSecureFile(state.leasePath());
  }
});

test("an endpoint that cannot be probed is an error, never a second daemon", { skip: process.platform === "win32" }, async () => {
  const path = hostControlPath(agentDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  writeFileSync(path, "not a socket");
  try {
    await assert.rejects(ensureLocalHostDaemon({ env: prodEnv(), launch: missingLaunch }), /Unsafe host control/);
  } finally {
    rmSync(path, { force: true });
  }
});

test("the host runs as this binary's host command, or the package entrypoint on Node, never as Bun", () => {
  assert.deepEqual(localHostLaunch({ OMP_WEB_PACKAGE_DIR: "/opt/ompweb", OMP_WEB_NODE_BIN: "/usr/bin/node" }), { command: "/usr/bin/node", args: [join(resolve("/opt/ompweb"), "bin", "omp-web-host.js")], cwd: process.cwd() });
  assert.equal(localHostLaunch({ OMP_WEB_PACKAGE_DIR: "/opt/ompweb" }).command, process.versions.bun ? "node" : process.execPath);
  assert.throws(() => localHostLaunch({}), /OMP_WEB_PACKAGE_DIR/);
});
