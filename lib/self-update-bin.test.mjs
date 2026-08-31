import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { terminateChildProcess, wireChildProcessLifecycle } from "../bin/process-lifecycle.js";

const require = createRequire(import.meta.url);
const {
  acknowledgeAndStartRestart,
  handleUpdateArm,
  resolveNextBin,
  spawnRestartGate,
  startRestartGate,
} = require("../bin/omp-web.js");
const { probeHttp } = require("../bin/omp-web-update-worker.js");

async function waitForJson(file, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (predicate(value)) return value;
    } catch { /* the producer has not completed its atomic write */ }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

async function startHttpChild(port, statusCode) {
  const script = [
    'const http = require("node:http");',
    `const server = http.createServer((_request, response) => { response.statusCode = ${statusCode}; response.end("ready"); });`,
    `server.listen(${port}, "127.0.0.1", () => process.stdout.write("ready\\n"));`,
  ].join("\n");
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`HTTP child exited with code ${code}`)));
    child.stdout.once("data", resolve);
  });
  return child;
}

async function copyWorkerWithReplacements(worker, replacements) {
  let source = await readFile(new URL("../bin/omp-web-update-worker.js", import.meta.url), "utf8");
  for (const [search, replacement] of replacements) {
    assert.ok(source.includes(search), `missing worker source fixture: ${search}`);
    source = source.replace(search, replacement);
  }
  await writeFile(worker, source);
}

async function waitForProcessToExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await delay(50);
  }
}

async function stopRestartGate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (child.connected) child.disconnect();
  else child.kill("SIGKILL");
  await Promise.race([exited, delay(5_000)]);
}

test("launcher classifies Windows control roots outside the package", async () => {
  const source = await readFile(new URL("../bin/omp-web.js", import.meta.url), "utf8");
  const guard = source.slice(
    source.indexOf("function isExternalControlRoot"),
    source.indexOf("\n}", source.indexOf("function isExternalControlRoot")),
  );
  assert.ok(guard.includes('path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)'));

  const packageRoot = String.raw`C:\apps\ompweb`;
  const isExternal = (controlRoot) => {
    const relative = path.win32.relative(packageRoot, controlRoot);
    return path.win32.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.win32.sep}`);
  };
  assert.equal(isExternal(packageRoot), false);
  assert.equal(isExternal(path.win32.join(packageRoot, "control")), false);
  assert.equal(isExternal(path.win32.dirname(packageRoot)), true);
  assert.equal(isExternal(String.raw`C:\apps\control`), true);
  assert.equal(path.win32.isAbsolute(path.win32.relative(packageRoot, String.raw`D:\temp\ompweb`)), true);
  assert.equal(isExternal(String.raw`D:\temp\ompweb`), true);
});

test("launcher rejects a delayed arm after abort cleanup", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-late-arm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptId = randomUUID();
  const statusFile = path.join(root, "status.json");
  await writeFile(statusFile, JSON.stringify({
    attemptId,
    state: "failed",
    stage: "stopping",
    fromVersion: "0.3.6",
    targetVersion: "0.3.7",
    preparedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    workerPid: process.pid,
    cleanupReady: true,
  }));

  let acknowledgement;
  handleUpdateArm({
    connected: true,
    send(message) { acknowledgement = message; },
  }, {
    type: "ompweb:update-control",
    protocol: 1,
    attemptId,
    root,
  });

  assert.equal(acknowledgement?.ok, false);
  assert.match(acknowledgement?.error ?? "", /no longer active/);
  await assert.rejects(access(path.join(root, `${attemptId}.armed.json`)), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(statusFile, "utf8")).cleanupReady, true);
});

test("worker accepts exactly the healthy login statuses", async () => {
  for (const [statusCode, ready] of [[200, true], [307, true], [308, true], [201, false], [302, false], [404, false], [500, false]]) {
    const server = createHttpServer((request, response) => {
      response.statusCode = request.url === "/login" ? statusCode : 500;
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      assert.equal(await probeHttp(server.address().port, "127.0.0.1"), ready, String(statusCode));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("new update attempts reset restart generation", async () => {
  const source = await readFile(new URL("../bin/omp-web.js", import.meta.url), "utf8");
  const newControl = source.slice(
    source.indexOf("if (!updateControl)"),
    source.indexOf("} else {", source.indexOf("if (!updateControl)")),
  );
  const reset = newControl.indexOf("currentGeneration = 0");
  const publish = newControl.indexOf("updateControl = control");
  assert.ok(reset >= 0 && publish > reset);
});

test("launcher rearms the restart watcher after a child-exit race", async () => {
  const source = await readFile(new URL("../bin/omp-web.js", import.meta.url), "utf8");
  const finalizer = source.slice(
    source.indexOf("} finally {", source.indexOf("async function waitForRestartRequest")),
    source.indexOf("\n  }\n}", source.indexOf("} finally {", source.indexOf("async function waitForRestartRequest"))),
  );
  assert.match(finalizer, /updateControl === control && !currentChild/);
  assert.match(finalizer, /waitForRestartRequest\(control\)\.catch/);
});

test("launcher resolves the Next fallback in a spaced install path without .bin", async (t) => {
  const packageDirectory = await mkdtemp(path.join(tmpdir(), "omp web install "));
  t.after(() => rm(packageDirectory, { recursive: true, force: true }));
  const nextDirectory = path.join(packageDirectory, "node_modules", "next");
  const nextBinary = path.join(nextDirectory, "dist", "bin", "next");
  await mkdir(path.dirname(nextBinary), { recursive: true });
  await writeFile(path.join(nextDirectory, "package.json"), JSON.stringify({
    name: "next",
    version: "1.0.0",
    exports: { "./package.json": "./package.json" },
  }));
  await writeFile(nextBinary, "");

  assert.equal(resolveNextBin(packageDirectory), nextBinary);
  await assert.rejects(access(path.join(packageDirectory, "node_modules", ".bin", "next")), { code: "ENOENT" });
});

test("restart gate starts Next only after its PID acknowledgement is durable and forwards I/O", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = { root, attemptId: randomUUID() };
  const request = { generation: 1 };
  const requestFile = path.join(root, `${control.attemptId}.restart-request.json`);
  const acknowledgementFile = path.join(root, `${control.attemptId}.restart-ack.json`);
  await writeFile(requestFile, JSON.stringify(request));

  let acknowledgementWasDurable = false;
  const remove = fs.rmSync.bind(fs);
  t.mock.method(fs, "rmSync", (file, options) => {
    if (path.resolve(file) === path.resolve(requestFile)) acknowledgementWasDurable = fs.existsSync(acknowledgementFile);
    return remove(file, options);
  });

  const child = spawnRestartGate();
  t.after(() => stopRestartGate(child));
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const readyMessage = once(child, "message");
  const nestedScript = [
    'const fs = require("node:fs");',
    `const acknowledgement = JSON.parse(fs.readFileSync(${JSON.stringify(acknowledgementFile)}, "utf8"));`,
    'process.stdout.write("nested stdout\\n");',
    'process.send({ type: "nested-ready", acknowledgement, pid: process.pid });',
    'process.on("message", (message) => {',
    '  process.stdout.write(`parent ${message.value}\\n`);',
    '  process.exitCode = message.exitCode; process.disconnect();',
    '});',
  ].join("\n");

  assert.equal(await acknowledgeAndStartRestart(control, request, child, ["-e", nestedScript]), true);
  const [ready] = await readyMessage;
  assert.equal(acknowledgementWasDurable, true);
  assert.deepEqual(ready.acknowledgement, {
    protocol: 1,
    attemptId: control.attemptId,
    generation: 1,
    pid: child.pid,
  });
  assert.notEqual(ready.pid, child.pid);

  const childExit = once(child, "exit");
  child.send({ value: "IPC", exitCode: 7 });
  const [code, signal] = await childExit;
  assert.equal(code, 7);
  assert.equal(signal, null);
  assert.match(output, /nested stdout/);
  assert.match(output, /parent IPC/);
});

test("restart acknowledgement failure exits the gate without starting Next", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = { root, attemptId: randomUUID() };
  const request = { generation: 2 };
  const requestFile = path.join(root, `${control.attemptId}.restart-request.json`);
  const nestedMarker = path.join(root, "nested-started");
  await writeFile(requestFile, JSON.stringify(request));

  t.mock.method(fs, "renameSync", () => {
    const error = new Error("ack storage unavailable");
    error.code = "EACCES";
    throw error;
  });
  const child = spawnRestartGate();
  t.after(() => stopRestartGate(child));
  const nestedScript = `require("node:fs").writeFileSync(${JSON.stringify(nestedMarker)}, "started")`;

  assert.equal(await acknowledgeAndStartRestart(control, request, child, ["-e", nestedScript]), false);
  assert.equal(child.exitCode === null && child.signalCode === null, false);
  await assert.rejects(access(nestedMarker), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(requestFile, "utf8")), request);
});

test("restart acknowledgement rejects a gate without a process id", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omp-web-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = { root, attemptId: randomUUID() };
  const request = { generation: 1 };
  const child = new EventEmitter();
  child.connected = true;
  child.send = () => assert.fail("an unacknowledged gate must not start Next");

  assert.equal(await acknowledgeAndStartRestart(control, request, child, ["unused"]), false);
  await assert.rejects(access(path.join(root, `${control.attemptId}.restart-ack.json`)), { code: "ENOENT" });
});

test("restart gate disconnect terminates its nested child tree", async (t) => {
  const child = spawnRestartGate();
  t.after(() => stopRestartGate(child));
  const readyMessage = once(child, "message");
  await startRestartGate(child, [
    "-e",
    'process.send({ pid: process.pid }); setInterval(() => {}, 1_000);',
  ]);
  const [{ pid }] = await readyMessage;

  const childExit = once(child, "exit");
  child.disconnect();
  await childExit;
  await waitForProcessToExit(pid);
  assert.throws(() => process.kill(pid, 0));
});

test("repeated launcher signals force-kill the complete restart gate tree", async (t) => {
  const child = spawnRestartGate();
  t.after(() => stopRestartGate(child));
  const readyMessage = once(child, "message");
  await startRestartGate(child, [
    "-e",
    'process.on("SIGTERM", () => {}); process.send({ pid: process.pid }); setInterval(() => {}, 1_000);',
  ]);
  const [{ pid }] = await readyMessage;
  const parent = new EventEmitter();
  parent.platform = process.platform;
  parent.exit = () => {};
  wireChildProcessLifecycle(child, parent);

  const childExit = once(child, "exit");
  parent.emit("SIGTERM");
  parent.emit("SIGTERM");
  await childExit;
  await waitForProcessToExit(pid);
  assert.throws(() => process.kill(pid, 0));
});

test("worker retains ownership when taskkill cannot attest the manager tree", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "omp-web-manager-timeout-"));
  const attemptId = randomUUID();
  const root = path.join(temporary, "control");
  const attemptDirectory = path.join(root, "attempts", attemptId);
  const packageDirectory = path.join(temporary, "package");
  const worker = path.join(attemptDirectory, "worker.js");
  const managerLog = path.join(temporary, "manager.log");
  const managerScript = path.join(temporary, "manager.cjs");
  await mkdir(attemptDirectory, { recursive: true });
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await copyWorkerWithReplacements(worker, [
    ["const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;", "const COMMAND_TIMEOUT_MS = 1_000;"],
    ["const TREE_TERMINATION_TIMEOUT_MS = 5_000;", "const TREE_TERMINATION_TIMEOUT_MS = 300;"],
    [
      'if (process.platform === "win32") {\n    const taskkillExited',
      "if (true) {\n    const taskkillExited",
    ],
    [
      'cp.spawn("taskkill", ["/pid", String(pid), "/t", "/f"]',
      `cp.spawn(process.execPath, ["-e", "process.kill(+process.argv[1], 'SIGKILL'); setInterval(() => {}, 60_000)", String(pid)]`,
    ],
    [
      "if (!await waitForPort(descriptor.port, descriptor.hostname, false, 5_000)) {",
      "if (!await waitForPort(descriptor.port, descriptor.hostname, false, 200)) {",
    ],
  ]);
  await writeFile(path.join(packageDirectory, "bin", "omp-web.js"), "");
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@kahme247/ompweb",
    version: "0.3.5",
  }));
  await writeFile(managerScript, [
    'const fs = require("node:fs");',
    `const spec = process.argv.find((value) => value.startsWith("@kahme247/ompweb@"));`,
    "const version = spec.slice(spec.lastIndexOf('@') + 1);",
    `fs.appendFileSync(${JSON.stringify(managerLog)}, version + " " + process.pid + "\\n");`,
    "setInterval(() => {}, 60_000);",
  ].join("\n"));
  await writeFile(path.join(root, "lease.json"), JSON.stringify({ attemptId }));
  await writeFile(path.join(root, "status.json"), JSON.stringify({
    attemptId,
    state: "prepared",
    stage: "preparing",
    fromVersion: "0.3.5",
    targetVersion: "0.3.6",
  }));
  await writeFile(path.join(root, `${attemptId}.go`), "");

  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const originalServer = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  await once(originalServer, "spawn");
  let managerPid;
  t.after(async () => {
    try { originalServer.kill("SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
    if (!managerPid) {
      try { managerPid = Number((await readFile(managerLog, "utf8")).trim().split(" ").at(-1)); }
      catch {}
    }
    if (managerPid) {
      try { process.kill(managerPid, "SIGKILL"); } catch {}
      await waitForProcessToExit(managerPid);
    }
    await rm(temporary, { recursive: true, force: true });
  });

  const descriptor = JSON.stringify({
    launcherPath: path.join(packageDirectory, "bin", "omp-web.js"),
    hostname: "127.0.0.1",
    port: String(port),
  });
  const child = spawn(process.execPath, [
    worker,
    "--attempt", attemptId,
    "--root", root,
    "--package-dir", packageDirectory,
    "--manager", "npm",
    "--manager-path", process.execPath,
    "--manager-prefix", JSON.stringify([managerScript]),
    "--target", "0.3.6",
    "--from", "0.3.5",
    "--launcher-pid", String(process.pid),
    "--server-pid", String(originalServer.pid),
    "--descriptor", descriptor,
  ], { stdio: "ignore" });
  const workerExit = once(child, "exit");
  const statusPath = path.join(root, "status.json");
  const status = await waitForJson(statusPath, (value) => value.state === "failed");

  assert.equal(child.exitCode, null, "unsafe manager ownership must keep the worker alive");
  const managerCalls = (await readFile(managerLog, "utf8")).trim().split(/\r?\n/);
  assert.equal(managerCalls.length, 1);
  assert.match(managerCalls[0], /^0\.3\.6 \d+$/);
  managerPid = Number(managerCalls[0].split(" ")[1]);
  assert.notEqual(status.managerPid, managerPid);
  await waitForProcessToExit(status.managerPid);
  assert.throws(() => process.kill(status.managerPid, 0));
  await access(path.join(root, "lease.json"));
  assert.equal(status.recovered, false);
  assert.match(status.error, /rollback was not attempted/);
  assert.match(status.error, /package manager timed out/);

  try { process.kill(managerPid, "SIGKILL"); } catch {}
  await waitForProcessToExit(managerPid);
  await delay(500);
  assert.equal(child.exitCode, null, "unattested partial tree termination must retain ownership");
  await access(path.join(root, "lease.json"));
  child.kill("SIGKILL");
  await workerExit;
});

test("worker suppresses rollback after an unacknowledged restart request times out", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "omp-web-restart-timeout-"));
  const attemptId = randomUUID();
  const root = path.join(temporary, "control");
  const attemptDirectory = path.join(root, "attempts", attemptId);
  const packageDirectory = path.join(temporary, "package");
  const worker = path.join(attemptDirectory, "worker.js");
  const managerLog = path.join(temporary, "manager.log");
  const managerScript = path.join(temporary, "manager.cjs");
  const manifest = path.join(packageDirectory, "package.json");
  await mkdir(attemptDirectory, { recursive: true });
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await copyWorkerWithReplacements(worker, [
    ["const READY_TIMEOUT_MS = 90 * 1000;", "const READY_TIMEOUT_MS = 1_000;"],
    [
      "if (!await waitForPort(descriptor.port, descriptor.hostname, false, 5_000)) {",
      "if (!await waitForPort(descriptor.port, descriptor.hostname, false, 200)) {",
    ],
  ]);
  await writeFile(path.join(packageDirectory, "bin", "omp-web.js"), "");
  await writeFile(manifest, JSON.stringify({ name: "@kahme247/ompweb", version: "0.3.5" }));
  await writeFile(managerScript, [
    'const fs = require("node:fs");',
    `const spec = process.argv.find((value) => value.startsWith("@kahme247/ompweb@"));`,
    "const version = spec.slice(spec.lastIndexOf('@') + 1);",
    `const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifest)}, "utf8"));`,
    "manifest.version = version;",
    `fs.writeFileSync(${JSON.stringify(manifest)}, JSON.stringify(manifest));`,
    `fs.appendFileSync(${JSON.stringify(managerLog)}, version + "\\n");`,
  ].join("\n"));
  await writeFile(path.join(root, "lease.json"), JSON.stringify({ attemptId }));
  await writeFile(path.join(root, "status.json"), JSON.stringify({
    attemptId,
    state: "prepared",
    stage: "preparing",
    fromVersion: "0.3.5",
    targetVersion: "0.3.6",
  }));
  await writeFile(path.join(root, `${attemptId}.go`), "");

  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const originalServer = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  await once(originalServer, "spawn");
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  await once(launcher, "spawn");
  let transientServer;
  t.after(async () => {
    try { originalServer.kill("SIGKILL"); } catch {}
    try { launcher.kill("SIGKILL"); } catch {}
    transientServer?.closeAllConnections?.();
    if (transientServer?.listening) await new Promise((resolve) => transientServer.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const descriptor = JSON.stringify({
    launcherPath: path.join(packageDirectory, "bin", "omp-web.js"),
    hostname: "127.0.0.1",
    port: String(port),
  });
  const child = spawn(process.execPath, [
    worker,
    "--attempt", attemptId,
    "--root", root,
    "--package-dir", packageDirectory,
    "--manager", "npm",
    "--manager-path", process.execPath,
    "--manager-prefix", JSON.stringify([managerScript]),
    "--target", "0.3.6",
    "--from", "0.3.5",
    "--launcher-pid", String(launcher.pid),
    "--server-pid", String(originalServer.pid),
    "--descriptor", descriptor,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const workerExit = once(child, "exit");
  await waitForJson(path.join(root, `${attemptId}.restart-request.json`), (value) => value.generation === 1);
  transientServer = createServer();
  await new Promise((resolve, reject) => {
    transientServer.once("error", reject);
    transientServer.listen(port, "127.0.0.1", resolve);
  });
  const status = await waitForJson(path.join(root, "status.json"), (value) => value.state === "failed");

  assert.equal(child.exitCode, null, "an unknown restarted child must retain update ownership");
  assert.deepEqual((await readFile(managerLog, "utf8")).trim().split(/\r?\n/), ["0.3.6"]);
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "0.3.6");
  await access(path.join(root, "lease.json"));
  assert.equal(status.recovered, false);
  assert.match(status.error, /rollback was not attempted/);
  assert.match(status.error, /original launcher did not restart ompweb/);

  transientServer.closeAllConnections?.();
  await new Promise((resolve) => transientServer.close(resolve));
  transientServer = undefined;
  await delay(500);
  assert.equal(child.exitCode, null, "a transient port-closed gap must not release unknown restart ownership");
  await access(path.join(root, "lease.json"));

  const restartAck = path.join(root, `${attemptId}.restart-ack.json`);
  await writeFile(restartAck, "{");

  const launcherExit = once(launcher, "exit");
  launcher.kill("SIGKILL");
  await launcherExit;
  await delay(500);
  assert.equal(child.exitCode, null, "a malformed restart acknowledgement must retain unknown ownership");
  await access(path.join(root, "lease.json"));
  await rm(restartAck);
  const [code, signal] = await workerExit;
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  await assert.rejects(access(path.join(root, "lease.json")), { code: "ENOENT" });
});

test("worker suppresses rollback while the server port remains live", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "omp-web-worker-"));
  const attemptId = randomUUID();
  const root = path.join(temporary, "control");
  const attemptDirectory = path.join(root, "attempts", attemptId);
  const packageDirectory = path.join(temporary, "package");
  const worker = path.join(attemptDirectory, "worker.js");
  const managerMarker = path.join(temporary, "manager-called");
  const managerScript = path.join(temporary, "manager.cjs");
  await mkdir(attemptDirectory, { recursive: true });
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await copyWorkerWithReplacements(worker, [
    ["const STOP_TIMEOUT_MS = 15 * 1000;", "const STOP_TIMEOUT_MS = 200;"],
  ]);
  await writeFile(path.join(packageDirectory, "bin", "omp-web.js"), "");
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@kahme247/ompweb",
    version: "0.3.5",
  }));
  await writeFile(managerScript, `require("node:fs").writeFileSync(${JSON.stringify(managerMarker)}, "called");`);
  await writeFile(path.join(root, "lease.json"), JSON.stringify({ attemptId }));
  await writeFile(path.join(root, "status.json"), JSON.stringify({
    attemptId,
    state: "prepared",
    stage: "preparing",
    fromVersion: "0.3.5",
    targetVersion: "0.3.6",
  }));
  await writeFile(path.join(root, `${attemptId}.go`), "");

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const originalServer = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  await once(originalServer, "spawn");
  t.after(async () => {
    try { originalServer.kill("SIGKILL"); } catch {}
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const descriptor = JSON.stringify({
    launcherPath: path.join(packageDirectory, "bin", "omp-web.js"),
    hostname: "127.0.0.1",
    port: String(port),
  });
  const child = spawn(process.execPath, [
    worker,
    "--attempt", attemptId,
    "--root", root,
    "--package-dir", packageDirectory,
    "--manager", "npm",
    "--manager-path", process.execPath,
    "--manager-prefix", JSON.stringify([managerScript]),
    "--target", "0.3.6",
    "--from", "0.3.5",
    "--launcher-pid", String(process.pid),
    "--server-pid", String(originalServer.pid),
    "--descriptor", descriptor,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const workerExit = once(child, "exit");
  const status = await waitForJson(path.join(root, "status.json"), (value) => value.state === "failed", 25_000);

  assert.equal(child.exitCode, null, "a live unknown server must retain update ownership");
  await access(path.join(root, "lease.json"));
  await assert.rejects(access(managerMarker), { code: "ENOENT" });
  assert.equal(status.recovered, false);
  assert.match(status.error, /rollback was not attempted because an update process remained live/);

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  const [code, signal] = await workerExit;
  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  await assert.rejects(access(path.join(root, "lease.json")), { code: "ENOENT" });
});

test("worker retains its lease when unsafe failure status cannot be persisted", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "omp-web-status-failure-"));
  const attemptId = randomUUID();
  const root = path.join(temporary, "control");
  const attemptDirectory = path.join(root, "attempts", attemptId);
  const packageDirectory = path.join(temporary, "package");
  const worker = path.join(attemptDirectory, "worker.js");
  const managerMarker = path.join(temporary, "manager-called");
  const managerScript = path.join(temporary, "manager.cjs");
  await mkdir(attemptDirectory, { recursive: true });
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await copyWorkerWithReplacements(worker, [
    ["const STOP_TIMEOUT_MS = 15 * 1000;", "const STOP_TIMEOUT_MS = 200;"],
    [
      "function atomicWrite(file, value) {",
      [
        "function atomicWrite(file, value) {",
        '  if (file === statusFile() && JSON.parse(value).state === "failed") {',
        '    fs.writeFileSync(markerFile("status-write-attempted"), "{}");',
        '    throw new Error("status storage unavailable");',
        "  }",
      ].join("\n"),
    ],
    [
      "if (!await waitForPort(descriptor.port, descriptor.hostname, false, 5_000)) {",
      "if (!await waitForPort(descriptor.port, descriptor.hostname, false, 200)) {",
    ],
  ]);
  await writeFile(path.join(packageDirectory, "bin", "omp-web.js"), "");
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@kahme247/ompweb",
    version: "0.3.5",
  }));
  await writeFile(managerScript, `require("node:fs").writeFileSync(${JSON.stringify(managerMarker)}, "called");`);
  await writeFile(path.join(root, "lease.json"), JSON.stringify({ attemptId }));
  await writeFile(path.join(root, "status.json"), JSON.stringify({
    attemptId,
    state: "prepared",
    stage: "preparing",
    fromVersion: "0.3.5",
    targetVersion: "0.3.6",
  }));
  await writeFile(path.join(root, `${attemptId}.go`), "");

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const originalServer = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  await once(originalServer, "spawn");
  t.after(async () => {
    try { originalServer.kill("SIGKILL"); } catch {}
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });

  const descriptor = JSON.stringify({
    launcherPath: path.join(packageDirectory, "bin", "omp-web.js"),
    hostname: "127.0.0.1",
    port: String(server.address().port),
  });
  const child = spawn(process.execPath, [
    worker,
    "--attempt", attemptId,
    "--root", root,
    "--package-dir", packageDirectory,
    "--manager", "npm",
    "--manager-path", process.execPath,
    "--manager-prefix", JSON.stringify([managerScript]),
    "--target", "0.3.6",
    "--from", "0.3.5",
    "--launcher-pid", String(process.pid),
    "--server-pid", String(originalServer.pid),
    "--descriptor", descriptor,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const workerExit = once(child, "exit");
  await waitForJson(path.join(root, `${attemptId}.status-write-attempted`), () => true);

  assert.equal(child.exitCode, null, "failed diagnostics must not release unsafe ownership");
  await access(path.join(root, "lease.json"));
  await assert.rejects(access(managerMarker), { code: "ENOENT" });

  await new Promise((resolve) => server.close(resolve));
  const [code, signal] = await workerExit;
  assert.equal(signal, null);
  assert.equal(code, 1, stderr);
  await assert.rejects(access(path.join(root, "lease.json")), { code: "ENOENT" });
});

for (const [statusCode, ready] of [[200, true], [307, true], [404, false], [500, false]]) {
test(`worker ${ready ? "accepts" : "rolls back after"} login ${statusCode}`, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "omp-web-http-worker-"));
  const attemptId = randomUUID();
  const root = path.join(temporary, "control");
  const attemptDirectory = path.join(root, "attempts", attemptId);
  const packageDirectory = path.join(temporary, "package");
  const worker = path.join(attemptDirectory, "worker.js");
  const managerLog = path.join(temporary, "manager.log");
  const managerScript = path.join(temporary, "manager.cjs");
  const manifest = path.join(packageDirectory, "package.json");
  await mkdir(attemptDirectory, { recursive: true });
  await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
  await copyFile(new URL("../bin/omp-web-update-worker.js", import.meta.url), worker);
  await writeFile(path.join(packageDirectory, "bin", "omp-web.js"), "");
  await writeFile(manifest, JSON.stringify({ name: "@kahme247/ompweb", version: "0.3.5" }));
  await writeFile(managerScript, [
    'const fs = require("node:fs");',
    `const spec = process.argv.find((value) => value.startsWith("@kahme247/ompweb@"));`,
    "const version = spec.slice(spec.lastIndexOf('@') + 1);",
    `const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifest)}, "utf8"));`,
    "manifest.version = version;",
    `fs.writeFileSync(${JSON.stringify(manifest)}, JSON.stringify(manifest));`,
    `fs.appendFileSync(${JSON.stringify(managerLog)}, version + "\\n");`,
  ].join("\n"));
  await writeFile(path.join(root, "lease.json"), JSON.stringify({ attemptId }));
  await writeFile(path.join(root, "status.json"), JSON.stringify({
    attemptId,
    state: "prepared",
    stage: "preparing",
    fromVersion: "0.3.5",
    targetVersion: "0.3.6",
  }));
  await writeFile(path.join(root, `${attemptId}.go`), "");

  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const originalServer = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  await once(originalServer, "spawn");
  let brokenServer;
  let recoveredServer;
  t.after(async () => {
    const exits = [];
    for (const serverChild of [originalServer, brokenServer, recoveredServer]) {
      if (!serverChild || serverChild.exitCode !== null || serverChild.signalCode !== null) continue;
      exits.push(once(serverChild, "exit").catch(() => {}));
      try { serverChild.kill("SIGKILL"); } catch {}
    }
    await Promise.all(exits);
    await rm(temporary, { recursive: true, force: true });
  });

  const descriptor = JSON.stringify({
    launcherPath: path.join(packageDirectory, "bin", "omp-web.js"),
    hostname: "127.0.0.1",
    port: String(port),
  });
  const child = spawn(process.execPath, [
    worker,
    "--attempt", attemptId,
    "--root", root,
    "--package-dir", packageDirectory,
    "--manager", "npm",
    "--manager-path", process.execPath,
    "--manager-prefix", JSON.stringify([managerScript]),
    "--target", "0.3.6",
    "--from", "0.3.5",
    "--launcher-pid", String(process.pid),
    "--server-pid", String(originalServer.pid),
    "--descriptor", descriptor,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const requestFile = path.join(root, `${attemptId}.restart-request.json`);
  const acknowledgementFile = path.join(root, `${attemptId}.restart-ack.json`);

  await waitForJson(requestFile, (request) => request.generation === 1);
  brokenServer = await startHttpChild(port, statusCode);
  const brokenExit = ready ? null : once(brokenServer, "exit");
  await writeFile(acknowledgementFile, JSON.stringify({
    protocol: 1,
    attemptId,
    generation: 1,
    pid: brokenServer.pid,
  }));
  await rm(requestFile);
  if (ready) {
    const [code, signal] = await once(child, "exit");
    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
    assert.deepEqual((await readFile(managerLog, "utf8")).trim().split(/\r?\n/), ["0.3.6"]);
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "0.3.6");
    const status = JSON.parse(await readFile(path.join(root, "status.json"), "utf8"));
    assert.equal(status.state, "succeeded");
    assert.equal(status.recovered, false);
    return;
  }
  await brokenExit;

  await waitForJson(requestFile, (request) => request.generation === 2);
  recoveredServer = await startHttpChild(port, 200);
  await writeFile(acknowledgementFile, JSON.stringify({
    protocol: 1,
    attemptId,
    generation: 2,
    pid: recoveredServer.pid,
  }));
  await rm(requestFile);
  const [code, signal] = await once(child, "exit");

  assert.equal(signal, null);
  assert.equal(code, 0, stderr);
  assert.deepEqual((await readFile(managerLog, "utf8")).trim().split(/\r?\n/), ["0.3.6", "0.3.5"]);
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "0.3.5");
  const status = JSON.parse(await readFile(path.join(root, "status.json"), "utf8"));
  assert.equal(status.state, "failed");
  assert.equal(status.recovered, true);
  assert.match(status.error, /HTTP readiness check/);
});
}


test("update-aware launcher lifecycle retains the parent after child exit", () => {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  const exitCodes = [];
  parent.exit = (code) => exitCodes.push(code);
  child.kill = () => true;
  wireChildProcessLifecycle(child, parent, 10, () => true);
  child.emit("exit", 0, null);
  assert.deepEqual(exitCodes, []);
});

test("restarted-child termination resolves only after child exit", async () => {
  const child = new EventEmitter();
  const signals = [];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => { child.signalCode = signal; child.emit("exit", null, signal); });
    return true;
  };
  assert.equal(await terminateChildProcess(child, 10, "linux"), true);
  assert.deepEqual(signals, ["SIGKILL"]);
});
