import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { mockBuiltin } from "../tests/mock-builtin.mjs";

const {
  getSelfUpdateStatus,
  markSelfUpdateStopping,
  parseSystemdServiceCgroup,
  resolveSelfUpdateTempRoot,
  validateCommitSelfUpdate,
} = await import("./self-update.ts");

test("parseSystemdServiceCgroup finds system and user services, and nothing outside one", () => {
  assert.deepEqual(parseSystemdServiceCgroup("0::/system.slice/ompweb-api.service\n"), { unit: "ompweb-api.service", user: false });
  assert.deepEqual(
    parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/ompweb.service\n"),
    { unit: "ompweb.service", user: true },
  );
  assert.deepEqual(
    parseSystemdServiceCgroup("12:pids:/system.slice/x.service\n1:name=systemd:/system.slice/ompweb.service\n"),
    { unit: "ompweb.service", user: false },
  );
  assert.deepEqual(
    parseSystemdServiceCgroup("1:name=systemd:/system.slice/ompweb.service\n0::/\n"),
    { unit: "ompweb.service", user: false },
  );
  assert.equal(parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/session-3.scope\n"), null);
  assert.equal(parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope\n"), null);
  assert.equal(parseSystemdServiceCgroup(""), null);
});

function withUpdateState(t, { workerPid, leaseExpiresAt, state = "running" }) {
  const temporary = mkdtempSync(join(tmpdir(), "self-update-test-"));
  // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
  const names = ["TMPDIR", "TEMP", "TMP"];
  const previous = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = temporary;
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    rmSync(temporary, { recursive: true, force: true });
  });
  const root = resolveSelfUpdateTempRoot("app");
  mkdirSync(root, { mode: 0o700 });
  const attemptId = "2e4c6460-5a8f-4ef7-8d81-42cb688a8bdc";
  if (leaseExpiresAt !== null) {
    writeFileSync(join(root, "lease.json"), JSON.stringify({ attemptId, kind: "app", expiresAt: leaseExpiresAt }), { mode: 0o600 });
  }
  writeFileSync(join(root, `${attemptId}.ready`), "{}", { mode: 0o600 });
  writeFileSync(join(root, "status.json"), JSON.stringify({
    attemptId,
    state,
    ...(state === "running" ? { stage: "stopping" } : {}),
    fromVersion: "0.5.2",
    targetVersion: "0.6.0",
    preparedAt: new Date().toISOString(),
    workerPid,
  }), { mode: 0o600 });
  return { statusFile: join(root, "status.json"), leaseFile: join(root, "lease.json"), attemptId };
}

// A pid far above any pid_max, so it is never alive.
const DEAD_PID = 2 ** 30;

test("a running update whose worker died is reported, and stored, as failed", (t) => {
  const { statusFile } = withUpdateState(t, { workerPid: DEAD_PID, leaseExpiresAt: Date.now() + 60_000 });
  const status = getSelfUpdateStatus("app");
  assert.equal(status.state, "failed");
  assert.equal(status.cleanupReady, true);
  assert.match(status.error, /worker stopped/);
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).state, "failed");
});

test("a running update past its lease is failed even when its pid is alive (reused)", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() - 1 });
  assert.equal(getSelfUpdateStatus("app").state, "failed");
});

test("a running update with a live worker inside its lease stays running", (t) => {
  const { statusFile } = withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus("app").state, "running");
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).state, "running");
});

test("a running update before its worker pid is recorded stays running", (t) => {
  withUpdateState(t, { workerPid: undefined, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus("app").state, "running");
});

test("a running update without a lease is failed", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: null });
  assert.equal(getSelfUpdateStatus("app").state, "failed");
});

test("a prepared update whose lease expired cannot be committed", (t) => {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() - 1 });
  assert.throws(() => validateCommitSelfUpdate(attemptId, "app"), { code: "lease_expired" });
});

test("starting a commit renews the lease, so a late commit is not reported as lost", (t) => {
  const { attemptId, leaseFile } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 1_000 });
  assert.equal(validateCommitSelfUpdate(attemptId, "app"), "ready");
  markSelfUpdateStopping(attemptId, "app");
  assert.ok(JSON.parse(readFileSync(leaseFile, "utf8")).expiresAt > Date.now() + 10 * 60_000);
  assert.equal(getSelfUpdateStatus("app").state, "running");
});

// commitSelfUpdate spawns its worker detached: record the spawn instead of running one.
let freshImport = 0;

async function commitAndCaptureSpawn(t, { nodeBin, systemd = false }) {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 60_000 });
  const previous = process.env.OMP_WEB_NODE_BIN;
  if (nodeBin === undefined) delete process.env.OMP_WEB_NODE_BIN;
  else process.env.OMP_WEB_NODE_BIN = nodeBin;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_WEB_NODE_BIN;
    else process.env.OMP_WEB_NODE_BIN = previous;
  });
  const spawns = [];
  const spawn = (command, args) => {
    spawns.push({ command, args });
    return { once() {}, unref() {}, pid: 2 ** 30 };
  };
  // The execFile fake reports this process as the unit's MainPID, so the systemd branch applies to it.
  const execFile = Object.assign(() => { throw new Error("execFile without promisify"); }, {
    [promisify.custom]: async (command) => ({ stdout: command === "systemctl" ? `${process.pid}\n` : "" }),
  });
  await mockBuiltin(t, "node:child_process", { spawn, execFile });
  // Pin the cgroup: the test may itself run inside a systemd service.
  const cgroup = systemd ? "0::/system.slice/ompweb-api.service\n" : "0::/user.slice/user-1000.slice/session-3.scope\n";
  const { readFileSync: realReadFileSync } = await import("node:fs");
  await mockBuiltin(t, "node:fs", {
    readFileSync: (path, ...rest) => (path === "/proc/self/cgroup" ? cgroup : realReadFileSync(path, ...rest)),
  });
  const { commitSelfUpdate } = await import(`./self-update.ts?fresh=${freshImport++}`);
  await commitSelfUpdate(attemptId, "app");
  assert.equal(spawns.length, 1);
  return spawns[0];
}

test("the update worker runs on OMP_WEB_NODE_BIN, not on the server's own runtime", async (t) => {
  const { command } = await commitAndCaptureSpawn(t, { nodeBin: "/opt/node/bin/node" });
  assert.equal(command, "/opt/node/bin/node");
});

test("the update worker falls back to the server's runtime without OMP_WEB_NODE_BIN", async (t) => {
  const { command } = await commitAndCaptureSpawn(t, {});
  assert.equal(command, process.execPath);
});

test("the update worker inside systemd-run's scope runs on OMP_WEB_NODE_BIN", { skip: process.platform !== "linux" }, async (t) => {
  const { command, args } = await commitAndCaptureSpawn(t, { nodeBin: "/opt/node/bin/node", systemd: true });
  assert.equal(command, "systemd-run");
  assert.ok(args.includes("--scope"));
  assert.equal(args[args.indexOf("--no-ask-password") + 1], "/opt/node/bin/node");
  assert.ok(!args.includes(process.execPath));
});
