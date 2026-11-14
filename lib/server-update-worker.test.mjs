// The server-update worker against real directories and a real update root; only the process lifecycle, the host's
// control endpoint and the supervisor are scripted. Windows-only tests use a real running executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const state = await import("./self-update-state.ts");
const worker = await import("./server-update-worker.ts");
const { defaultServerUpdateDeps, runServerUpdateWorker, serverArtifact, swapInstallDirectory } = worker;

const OLD = "0.1.0";
const NEW = "9.9.9";
const FAST = { bootTimeoutMs: 800, hostTimeoutMs: 800, pollMs: 5, settleMs: 5 };

/** A release tree the worker accepts: `version.txt` is what a started "server" or "host" reads to say which release it runs. */
function tree(dir, version, method) {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.html"), "");
  writeFileSync(join(dir, "version.txt"), version);
  if (method === "binary") {
    writeFileSync(join(dir, "ompweb"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  } else {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@kahme247/ompweb", version }));
    for (const file of ["bin/omp-web.js", "bin/omp-web-host.js", "server/main.ts"]) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "");
    }
  }
  chmodSync(dir, 0o755);
}
const installedVersion = (dir) => readFileSync(join(dir, "version.txt"), "utf8");
const errno = (code) => Object.assign(new Error(code), { code });

/**
 * One attempt: the installation (OLD), the staged release (NEW), the update root with a running attempt and lease, the
 * descriptor and restart environment the server would have written, and the plan the server persisted.
 */
function scenario(t, { method = "npm", localHost = { kind: "absent" }, hostArgs = [], interruptSessions = false, leaseValid = true, stagedVersion = NEW } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "server-update-worker-")));
  const names = ["TMPDIR", "TEMP", "TMP", "PI_CODING_AGENT_DIR"];
  const previous = names.map((name) => process.env[name]);
  mkdirSync(join(base, "tmp"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = join(base, "tmp");
  process.env.PI_CODING_AGENT_DIR = join(base, "agent");
  t.after(() => {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index]; });
    rmSync(base, { recursive: true, force: true });
  });
  const id = randomUUID();
  const installDir = join(base, "ompweb");
  tree(installDir, OLD, method);
  const staging = serverArtifact(installDir, "staging", id);
  const release = join(staging, "release");
  mkdirSync(staging, { mode: 0o700 });
  tree(release, stagedVersion, method);
  if (method === "binary") writeFileSync(join(release, "ompweb"), `#!/bin/sh\necho ${stagedVersion}\n`, { mode: 0o755 });

  const root = state.resolveSelfUpdateTempRoot();
  mkdirSync(join(root, "attempts", id), { recursive: true, mode: 0o700 });
  state.atomicWrite(state.leasePath(), JSON.stringify({ attemptId: id, expiresAt: Date.now() + (leaseValid ? 60_000 : -1) }));
  state.atomicWrite(state.statusPath(), JSON.stringify({ attemptId: id, state: "running", stage: "preparing", fromVersion: OLD, targetVersion: NEW, preparedAt: new Date().toISOString(), coordinatorPid: process.pid }));
  const process_ = (role, pid) => ({ role, platform: process.platform, pid, identity: `id-${pid}`, executable: process.execPath, args: [], installDir, supervisor: { kind: "foreground" }, current: { pid, identity: `id-${pid}` } });
  const descriptor = {
    version: 1,
    attemptId: id,
    installMethod: method,
    installDir,
    release,
    fromVersion: OLD,
    targetVersion: NEW,
    runtime: process.execPath,
    server: { process: process_("server", 4242), launch: { command: join(installDir, "bin", "omp-web.js"), args: ["-p", "30177"], cwd: installDir }, pids: [4242] },
    localHost: localHost.kind === "shared" ? { kind: "shared", process: process_("host", 777) } : localHost,
    hostArgs,
    participantId: localHost.kind === "separate" ? null : "local",
    interruptSessions,
  };
  const descriptorPath = join(root, "attempts", id, "descriptor.json");
  writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  writeFileSync(join(root, "attempts", id, "launch-env.json"), JSON.stringify({ OMP_WEB_PASSWORD_HASH: "secret-hash", PATH: process.env.PATH ?? "" }), { mode: 0o600 });
  const planDirectory = join(base, "agent", "omp-web", "server-upgrades", id);
  mkdirSync(planDirectory, { recursive: true, mode: 0o700 });
  const planFile = join(planDirectory, "plan.json");
  writeFileSync(planFile, JSON.stringify({ id, state: "ready", hosts: [{ id: "local", stage: "pending" }, { id: "remote", stage: "ready" }] }), { mode: 0o600 });

  const host = { up: localHost.kind === "shared", pid: 777, version: OLD, linked: true, drained: false, busy: false };
  const ctx = {
    id, base, installDir, release, staging, descriptor, descriptorPath, planFile, host,
    calls: [], restarts: [], launches: [], sharedInstallCalls: [],
    /** Whether a server started from the installed tree reports ready, and with which nonce. */
    serverReady: () => true,
    forgeNonce: false,
    stopFails: () => false,
    sharing: null,
    status: () => state.readStateJson(state.statusPath()),
    plan: () => JSON.parse(readFileSync(planFile, "utf8")),
    attemptFile: (name) => join(root, "attempts", id, name),
  };
  const hostPid = { next: 778 };
  ctx.deps = {
    ...defaultServerUpdateDeps,
    ...FAST,
    inspect: async ({ role, pid }) => process_(role, pid),
    stop: async (proc) => {
      ctx.calls.push(`stop ${proc.role}`);
      if (ctx.stopFails(proc, ctx.calls.filter((call) => call === `stop ${proc.role}`).length)) throw new Error(`cannot stop the ${proc.role}`);
      if (proc.role === "host") host.up = false;
    },
    restart: async (proc, launch) => {
      ctx.calls.push(`restart ${proc.role}`);
      if (proc.role === "host") {
        host.up = true; host.pid = hostPid.next++; host.version = installedVersion(installDir);
        return host.pid;
      }
      ctx.restarts.push({ launch, installed: installedVersion(installDir) });
      const expectation = state.readStateJson(state.markerPath(id, "expect.json"));
      if (ctx.serverReady(installedVersion(installDir))) {
        state.atomicWrite(state.markerPath(id, "boot.json"), JSON.stringify({ attemptId: id, version: expectation.version, nonce: ctx.forgeNonce ? "guessed" : expectation.nonce, pid: process.pid }));
      }
      return process.pid;
    },
    launch: async (launch) => {
      ctx.calls.push("launch");
      ctx.launches.push(launch);
      host.up = true; host.pid = hostPid.next++; host.version = installedVersion(installDir);
      return host.pid;
    },
    hostControl: async (command) => {
      ctx.calls.push(`host ${command}`);
      if (!host.up) throw errno("ENOENT");
      if (command === "drain") {
        if (host.busy) throw errno("host_busy");
        host.drained = true;
      }
      if (command === "resume") host.drained = false;
      const entrypoint = method === "binary" ? join(installDir, "ompweb") : join(installDir, "bin", "omp-web-host.js");
      return { pid: host.pid, version: host.version, protocol: 1, linked: host.linked, drained: host.drained, executable: method === "binary" ? entrypoint : process.execPath, entrypoint };
    },
    sharedInstall: async (dir, ignored, owned) => {
      ctx.sharedInstallCalls.push({ dir, ignored, owned });
      return ctx.sharing;
    },
  };
  return ctx;
}
const run = (ctx) => runServerUpdateWorker(ctx.descriptorPath, ctx.deps);
/** The lifecycle calls that stop or start something, without the control-endpoint probes between them. */
const moves = (ctx) => ctx.calls.filter((call) => /^(stop|restart) /.test(call));

test("a package update replaces the installation, restarts it on the new release and drops the backup", async (t) => {
  const ctx = scenario(t);
  assert.equal(await run(ctx), 0);
  assert.equal(installedVersion(ctx.installDir), NEW);
  assert.equal(ctx.status().state, "succeeded");
  assert.equal(ctx.status().cleanupReady, true);
  assert.equal(ctx.status().retainedBackup, undefined);
  assert.equal(ctx.status().coordinatorPid, undefined);
  assert.equal(ctx.status().workerPid, process.pid);
  assert.deepEqual(ctx.calls.filter((call) => call.startsWith("stop") || call.startsWith("restart")), ["stop server", "restart server"]);
  // The restarted process gets the server's own environment (the web password hash), which never sat in the descriptor.
  assert.equal(ctx.restarts[0].launch.env.OMP_WEB_PASSWORD_HASH, "secret-hash");
  assert.ok(!readFileSync(ctx.descriptorPath, "utf8").includes("secret-hash"));
  assert.equal(existsSync(ctx.attemptFile("launch-env.json")), false);
  assert.equal(existsSync(serverArtifact(ctx.installDir, "backup", ctx.id)), false);
  assert.equal(existsSync(ctx.staging), false);
  assert.equal(ctx.plan().state, "succeeded");
  assert.equal(ctx.plan().hosts.find((host) => host.id === "local").stage, "ready");
  assert.equal(ctx.plan().hosts.find((host) => host.id === "remote").stage, "ready");
});

test("a binary update stages a release that reports the target version and replaces the install", { skip: process.platform === "win32" }, async (t) => {
  const ctx = scenario(t, { method: "binary" });
  assert.equal(await run(ctx), 0);
  assert.equal(installedVersion(ctx.installDir), NEW);
  assert.match(readFileSync(join(ctx.installDir, "ompweb"), "utf8"), new RegExp(NEW.replaceAll(".", "\\.")));
});

test("a staged binary that reports another version stops nothing", { skip: process.platform === "win32" }, async (t) => {
  const ctx = scenario(t, { method: "binary", stagedVersion: "1.0.0" });
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /different version/);
  assert.deepEqual(ctx.calls, []);
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(ctx.plan().state, "failed");
});

test("a server that never proves it is the restarted release is rolled back to the previous installation", async (t) => {
  const ctx = scenario(t);
  ctx.serverReady = (installed) => installed === OLD;
  assert.equal(await run(ctx), 1);
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(ctx.status().state, "failed");
  assert.match(ctx.status().error, /did not report ready as 9\.9\.9/);
  assert.match(ctx.status().error, /previous release was restored/);
  assert.equal(ctx.status().retainedBackup, undefined);
  // Stop the old server, start the new one, stop the failed one, start the old again: and each restart's proof names its own release.
  assert.deepEqual(moves(ctx), ["stop server", "restart server", "stop server", "restart server"]);
  assert.deepEqual(ctx.restarts.map((restart) => restart.installed), [NEW, OLD]);
  assert.equal(installedVersion(serverArtifact(ctx.installDir, "failed", ctx.id)), NEW);
  assert.equal(state.readStateJson(state.markerPath(ctx.id, "expect.json")).version, OLD);
  assert.equal(ctx.plan().state, "failed");
});


test("a boot proof without the worker's nonce is not accepted", async (t) => {
  const ctx = scenario(t);
  ctx.forgeNonce = true;
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /did not report ready/);
  assert.equal(installedVersion(ctx.installDir), OLD);
});

test("a restarted server that exits before reporting ready fails fast", async (t) => {
  const ctx = scenario(t);
  ctx.serverReady = (installed) => installed === OLD;
  ctx.deps.restart = async (proc, launch) => {
    ctx.calls.push(`restart ${proc.role}`);
    ctx.restarts.push({ launch, installed: installedVersion(ctx.installDir) });
    if (installedVersion(ctx.installDir) === OLD) {
      const expectation = state.readStateJson(state.markerPath(ctx.id, "expect.json"));
      state.atomicWrite(state.markerPath(ctx.id, "boot.json"), JSON.stringify({ attemptId: ctx.id, version: expectation.version, nonce: expectation.nonce, pid: process.pid }));
      return process.pid;
    }
    return 2 ** 30; // dead on arrival
  };
  ctx.deps.bootTimeoutMs = 10_000;
  const started = Date.now();
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /exited before it reported ready/);
  assert.ok(Date.now() - started < 10_000, "waited for the full timeout instead of failing on the dead process");
  assert.equal(installedVersion(ctx.installDir), OLD);
});

test("a failed candidate that cannot be stopped leaves its tree in place and reports recovery as required", async (t) => {
  const ctx = scenario(t);
  ctx.serverReady = (installed) => installed === OLD;
  ctx.stopFails = (proc, count) => proc.role === "server" && count === 2;
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /could not be stopped, so the previous installation was left in place/);
  // Moving or restarting now could run two servers on one installation: the new tree stays, the backup is kept and named.
  assert.equal(installedVersion(ctx.installDir), NEW);
  assert.equal(installedVersion(serverArtifact(ctx.installDir, "backup", ctx.id)), OLD);
  assert.equal(ctx.status().retainedBackup, serverArtifact(ctx.installDir, "backup", ctx.id));
  assert.equal(ctx.status().state, "failed");
  assert.equal(ctx.plan().state, "recovery-required");
  assert.deepEqual(moves(ctx), ["stop server", "restart server", "stop server"]);
});

test("a previous server that cannot be restarted after the rollback is reported, not hidden", async (t) => {
  const ctx = scenario(t);
  ctx.serverReady = () => false;
  assert.equal(await run(ctx), 1);
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.match(ctx.status().error, /The previous server 0\.1\.0 could not be restarted/);
  assert.equal(ctx.plan().state, "recovery-required");
});

test("an unknown process running from the installation stops nothing", async (t) => {
  const ctx = scenario(t);
  ctx.sharing = "This installation is shared with another running process";
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /shared with another running process/);
  assert.deepEqual(ctx.calls, []);
  // The server's own tree and its pid are expected, everything else is not.
  assert.deepEqual(ctx.sharedInstallCalls[0].owned, [4242]);
  assert.ok(ctx.sharedInstallCalls[0].ignored.includes(process.pid));
});

test("a lease that expired before the worker started refuses to touch the installation", async (t) => {
  const ctx = scenario(t, { leaseValid: false });
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /lease expired/);
  assert.deepEqual(ctx.calls, []);
  assert.equal(installedVersion(ctx.installDir), OLD);
});

test("a descriptor outside the attempt's own directory is refused", async (t) => {
  const ctx = scenario(t);
  const copy = join(ctx.base, "descriptor.json");
  writeFileSync(copy, readFileSync(ctx.descriptorPath), { mode: 0o600 });
  assert.equal(await runServerUpdateWorker(copy, ctx.deps), 1);
  assert.deepEqual(ctx.calls, []);
});

test("a second worker for the same attempt does nothing", async (t) => {
  const ctx = scenario(t);
  writeFileSync(ctx.attemptFile("worker.lock"), "1", { mode: 0o600 });
  assert.equal(await run(ctx), 1);
  assert.deepEqual(ctx.calls, []);
  assert.equal(installedVersion(ctx.installDir), OLD);
});

test("a shared local host is drained, stopped with the server, and restarted from the new release", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" } });
  assert.equal(await run(ctx), 0);
  assert.deepEqual(ctx.calls.filter((call) => !call.endsWith("status")), ["host drain", "stop host", "stop server", "restart server", "restart host"]);
  assert.equal(ctx.host.version, NEW);
  assert.equal(ctx.plan().hosts.find((host) => host.id === "local").stage, "ready");
  assert.equal(ctx.launches.length, 0);
});

test("a shared local host that is busy is not stopped without authorization", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" } });
  ctx.host.busy = true;
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /did not authorize interrupting it/);
  assert.ok(!ctx.calls.includes("stop host") && !ctx.calls.includes("stop server"));
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(ctx.plan().hosts.find((host) => host.id === "local").stage, "failed");
});

test("an authorized interruption stops a busy shared local host", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" }, interruptSessions: true });
  ctx.host.busy = true;
  assert.equal(await run(ctx), 0);
  assert.ok(ctx.calls.indexOf("stop host") < ctx.calls.indexOf("stop server"));
  assert.equal(ctx.host.version, NEW);
});

test("a host that was replaced since approval is not stopped", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" } });
  ctx.host.pid = 9999;
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /no longer the process the update was approved for/);
  assert.ok(!ctx.calls.includes("stop host") && !ctx.calls.includes("stop server"));
});

test("the shared local host returns on the previous release, linked, when the new server does not come up", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" } });
  ctx.serverReady = (installed) => installed === OLD;
  assert.equal(await run(ctx), 1);
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(ctx.host.up, true);
  assert.equal(ctx.host.version, OLD);
  assert.deepEqual(ctx.calls.filter((call) => call.startsWith("stop") || call.startsWith("restart")), ["stop host", "stop server", "restart server", "stop server", "restart server", "restart host"]);
  assert.equal(ctx.plan().hosts.find((host) => host.id === "local").stage, "failed");
});

test("a shared host stopped for a cutover that cannot stop the server returns on the previous release", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" } });
  ctx.stopFails = (proc) => proc.role === "server";
  assert.equal(await run(ctx), 1);
  // The server could not stop, so nothing was replaced: the host (stopped for the cutover) comes back on the old release.
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(ctx.host.up, true);
  assert.equal(ctx.host.version, OLD);
});

test("with no local host, the host starts from the new release after the cutover", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "absent" } });
  assert.equal(await run(ctx), 0);
  assert.equal(ctx.launches.length, 1);
  assert.equal(ctx.launches[0].cwd, homedir());
  assert.ok(ctx.launches[0].args.includes(join(ctx.installDir, "bin", "omp-web-host.js")));
  assert.equal(ctx.host.version, NEW);
  assert.equal(ctx.plan().hosts.find((host) => host.id === "local").stage, "ready");
});

test("a host the new server starts itself is used, not duplicated", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "absent" } });
  const restart = ctx.deps.restart;
  ctx.deps.restart = async (proc, launch) => {
    const pid = await restart(proc, launch);
    if (proc.role === "server") { ctx.host.up = true; ctx.host.pid = 4100; ctx.host.version = installedVersion(ctx.installDir); }
    return pid;
  };
  assert.equal(await run(ctx), 0);
  assert.equal(ctx.launches.length, 0);
  assert.equal(ctx.host.pid, 4100);
});

test("a local host that never links to the new server fails the update and restores the installation", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "absent" } });
  ctx.host.linked = false;
  assert.equal(await run(ctx), 1);
  assert.match(ctx.status().error, /did not report 9\.9\.9 linked/);
  assert.equal(installedVersion(ctx.installDir), OLD);
  // The host started for the failed release is stopped before its tree moves.
  assert.ok(ctx.calls.includes("stop host"));
});

test("a separate local host installation is left alone", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "separate" } });
  assert.equal(await run(ctx), 0);
  assert.deepEqual(ctx.calls.filter((call) => call.includes("host")), []);
  assert.equal(ctx.plan().hosts.find((host) => host.id === "local").stage, "pending");
});

test("swapping in a release that is missing puts the installation back", async (t) => {
  const ctx = scenario(t);
  const backup = serverArtifact(ctx.installDir, "backup", ctx.id);
  await assert.rejects(() => swapInstallDirectory(ctx.installDir, join(ctx.staging, "missing"), backup), { code: "ENOENT" });
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(existsSync(backup), false);
});

test("a stale backup directory stops the swap before anything moves", async (t) => {
  const ctx = scenario(t);
  const backup = serverArtifact(ctx.installDir, "backup", ctx.id);
  mkdirSync(backup);
  await assert.rejects(() => swapInstallDirectory(ctx.installDir, ctx.release, backup), /already exists/);
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(installedVersion(ctx.release), NEW);
});

// Windows keeps a directory while one of its executables runs: the running-binary replacement the other platforms never meet.
async function startRunningExecutable(t, installDir) {
  const executable = join(installDir, "ompweb.exe");
  copyFileSync(process.execPath, executable);
  const child = spawn(executable, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => { child.kill(); await exited; });
  return { child, exited };
}

test("Windows: replacing an installation whose executable still runs fails and leaves it intact", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const ctx = scenario(t);
  const { child, exited } = await startRunningExecutable(t, ctx.installDir);
  const backup = serverArtifact(ctx.installDir, "backup", ctx.id);
  await assert.rejects(() => swapInstallDirectory(ctx.installDir, ctx.release, backup));
  assert.ok(existsSync(join(ctx.installDir, "ompweb.exe")), "the installation moved while its executable ran");
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(existsSync(backup), false);
  assert.equal(child.exitCode, null);
  child.kill();
  await exited;
  await swapInstallDirectory(ctx.installDir, ctx.release, backup);
  assert.equal(installedVersion(ctx.installDir), NEW);
  assert.equal(installedVersion(backup), OLD);
});

test("Windows: an update whose old binary never exits is rolled back, restarting the previous server", { skip: process.platform !== "win32", timeout: 60_000 }, async (t) => {
  const ctx = scenario(t);
  await startRunningExecutable(t, ctx.installDir);
  // The scripted stop reports success while the process keeps running, as a lifecycle that lost its process would.
  assert.equal(await run(ctx), 1);
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.ok(existsSync(join(ctx.installDir, "ompweb.exe")));
  assert.equal(ctx.status().state, "failed");
  assert.deepEqual(ctx.restarts.map((restart) => restart.installed), [OLD]);
  assert.equal(ctx.plan().state, "failed");
});

async function livePid(t) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1e9)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });
  return child.pid;
}
function pointHostAt(ctx, pid) {
  ctx.host.pid = pid;
  const proc = ctx.descriptor.localHost.process;
  proc.pid = pid;
  proc.identity = `id-${pid}`;
  proc.current = { pid, identity: `id-${pid}` };
  writeFileSync(ctx.descriptorPath, JSON.stringify(ctx.descriptor), { mode: 0o600 });
}
function hostStopError(ctx, text) {
  const stop = ctx.deps.stop;
  ctx.deps.stop = async (proc) => {
    if (proc.role === "host") { ctx.calls.push("stop host"); throw new Error(text); }
    return stop(proc);
  };
}

test("a forced stop that times out is retried, and rollback restarts the host", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" }, interruptSessions: true });
  ctx.host.busy = true;
  pointHostAt(ctx, await livePid(t));
  hostStopError(ctx, `Process ${ctx.host.pid} did not stop within 10 seconds; it was not killed`);
  assert.equal(await run(ctx), 1);
  assert.equal(ctx.calls.filter((call) => call === "stop host").length, 5);
  assert.equal(ctx.calls.includes("restart host"), true);
  assert.equal(ctx.status().state, "failed");
});

test("a timed-out stop is not retried without force, and rollback still restarts the host", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" } });
  pointHostAt(ctx, await livePid(t));
  hostStopError(ctx, `Process ${ctx.host.pid} did not stop within 10 seconds; it was not killed`);
  assert.equal(await run(ctx), 1);
  assert.equal(ctx.calls.filter((call) => call === "stop host").length, 1);
  assert.equal(ctx.calls.includes("restart host"), true);
});

test("a stop that was not signalled does not restart a host that is still running", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "shared" }, interruptSessions: true });
  pointHostAt(ctx, await livePid(t));
  hostStopError(ctx, "cannot stop the host");
  assert.equal(await run(ctx), 1);
  assert.equal(ctx.calls.filter((call) => call === "stop host").length, 5);
  assert.equal(ctx.calls.includes("restart host"), false);
  assert.equal(ctx.calls.includes("host resume"), true);
});

test("a recovered local rollback is recovery-required when a non-shared host is already ready", async (t) => {
  const ctx = scenario(t);
  const plan = ctx.plan();
  plan.hosts.push({ id: "remote-moved", needsUpgrade: true, recovery: "maintenance", stage: "ready" });
  writeFileSync(ctx.planFile, JSON.stringify(plan), { mode: 0o600 });
  ctx.serverReady = (installed) => installed === OLD;
  assert.equal(await run(ctx), 1);
  assert.equal(installedVersion(ctx.installDir), OLD);
  assert.equal(ctx.plan().state, "recovery-required");
});

test("a missing host is started without waiting out autostart grace", async (t) => {
  const ctx = scenario(t, { localHost: { kind: "absent" } });
  const started = Date.now();
  assert.equal(await run(ctx), 0);
  assert.ok(Date.now() - started < 2_000, `waited ${Date.now() - started} ms for a host autostart will not start`);
  assert.equal(ctx.launches.length, 1);
});
