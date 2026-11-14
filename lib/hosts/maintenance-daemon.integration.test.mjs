import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "ompweb-maintenance-runtime-"));
const oldAgent = process.env.PI_CODING_AGENT_DIR, oldBin = process.env.OMP_WEB_OMP_BIN;
process.env.PI_CODING_AGENT_DIR = root;
process.env.OMP_WEB_OMP_BIN = join(root, "missing-omp");
const { runHostDaemon } = await import("./daemon.ts");
const hub = await import("./hub.ts");
const { createHost, revokeHost } = await import("./registry.ts");
const maintenance = await import("./maintenance-hub.ts");
const { until } = await import("./link-driver.test-helper.mjs");
after(() => {
  if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
  if (oldBin === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = oldBin;
  rmSync(root, { recursive: true, force: true });
});

test("API v1 keeps the actual daemon available after application protocol rejection", async (t) => {
  const { host, token } = createHost("Maintenance only");
  const sessionId = "11111111-2222-4333-8444-5555555555cc";
  const sessions = join(root, "sessions", "-maintenance");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: root, timestamp: "2026-11-14T00:00:00.000Z" }) + "\n");
  const updateRoot = join(root, "omp-web", "host-update");
  const attempt = "api-only-health";
  mkdirSync(join(updateRoot, attempt), { recursive: true, mode: 0o700 });
  writeFileSync(join(updateRoot, "status.json"), JSON.stringify({
    operation: { id: attempt, target: "ompweb", version: "0.7.1", state: "running" }, daemonPid: 1, startedAt: Date.now(),
  }), { mode: 0o600 });
  writeFileSync(join(updateRoot, attempt, "descriptor.json"), JSON.stringify({ id: attempt, version: "0.7.1", fromVersion: "0.7.0" }), { mode: 0o600 });
  let rejected = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request, server) {
      if (new URL(request.url).pathname === "/api/hosts/maintenance") return maintenance.handleMaintenanceUpgrade(request, (data) => server.upgrade(request, { data }));
      if (request.headers.get("upgrade") !== "websocket") return new Response("", { status: 426 });
      return server.upgrade(request, { data: { kind: "application" } }) ? undefined : new Response("", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        if (ws.data.kind === "maintenance") return maintenance.maintenanceSocket.message(ws, data);
        rejected++;
        ws.close(4426, JSON.stringify({ serverVersion: 99 }));
      },
      close(ws) { if (ws.data.kind === "maintenance") maintenance.maintenanceSocket.close(ws); },
    },
  });
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: `http://127.0.0.1:${server.port}`, token }] });
  t.after(async () => { await daemon.stop(); server.stop(true); rmSync(updateRoot, { recursive: true, force: true }); });
  await daemon.started;
  await until(() => rejected > 0 && maintenance.getMaintenanceHost(host.id), "the independent API connects despite application rejection");
  const hello = maintenance.getMaintenanceHost(host.id);
  assert.equal(hello.apiVersion, 1);
  assert.equal(hello.protocolVersion, 12);
  const status = await maintenance.requestMaintenance(host.id, "status", {});
  assert.equal(status.apiVersion, 1);
  assert.equal(status.protocolVersion, 12);
  assert.equal(status.sessionProcesses, 0);
  assert.equal(status.busyReason, null, "an idle status read cannot count itself as pending work");
  assert.equal(existsSync(join(updateRoot, attempt, "health.json")), false, "maintenance alone cannot suppress rollback of a broken application connection");
  assert.ok(status.capabilities.includes("updateSoftware"));
  const inventory = await maintenance.requestMaintenance(host.id, "listSessions", {});
  const session = inventory.find((item) => item.id === sessionId);
  assert.ok(session, "maintenance lists real session metadata, not application transcript frames");
  assert.equal(session.active, false);
  assert.equal(session.processRunning, false);
  const row = hub.listHosts().find((item) => item.id === host.id);
  assert.equal(row.status, "offline", "a compatible application endpoint outage is not a version mismatch");
  assert.equal(row.apiVersion, 1);
  assert.equal(row.upgradeOnly, undefined);
  assert.equal(daemon.control("status").linked, false, "maintenance must not pretend application sessions can attach");
  revokeHost(host.id);
  maintenance.closeMaintenanceHost(host.id);
  await until(() => !maintenance.getMaintenanceHost(host.id), "revocation ends maintenance access");
});

test("maintenance reports a live prompt as active without inspecting its application transcript", async (t) => {
  const { host, token } = createHost("Activity inventory");
  const id = "11111111-2222-4333-8444-5555555555dd";
  const sessionDir = join(root, "sessions", "-activity");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, "active.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd: root }) + "\n");
  const fakeOmp = join(root, process.platform === "win32" ? "activity-omp.cmd" : "activity-omp");
  const source = `if (process.argv.includes("--version")) { console.log("99.0.0-fake"); process.exit(0); }
const emit = frame => process.stdout.write(JSON.stringify(frame) + "\\n");
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const command = JSON.parse(line);
  if (command.t === "cmd") emit({t:"res",id:command.id,ok:true,data:{}});
  if (command.op === "prompt") emit({t:"event",event:{type:"agent_start"}});
});
emit({t:"hello",proto:1,pid:process.pid,sessionId:${JSON.stringify(id)},cwd:${JSON.stringify(root)},sessionFile:${JSON.stringify(file)}});
`;
  if (process.platform === "win32") {
    writeFileSync(fakeOmp + ".cjs", source);
    writeFileSync(fakeOmp, `@"${process.execPath}" "${fakeOmp}.cjs" %*\r\n`);
  } else writeFileSync(fakeOmp, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  process.env.OMP_WEB_OMP_BIN = fakeOmp;
  const { resolveOmpBin } = await import("../omp/omp-cli.ts");
  resolveOmpBin(true);
  let socket, seq = 0;
  const messages = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request, server) {
      if (new URL(request.url).pathname === "/api/hosts/maintenance") return maintenance.handleMaintenanceUpgrade(request, data => server.upgrade(request, { data }));
      return server.upgrade(request, { data: { kind: "application" } }) ? undefined : new Response("", { status: 426 });
    },
    websocket: {
      message(ws, data) {
        if (ws.data.kind === "maintenance") return maintenance.maintenanceSocket.message(ws, data);
        for (const line of String(data).split("\n").filter(Boolean)) {
          const frame = JSON.parse(line);
          if (frame.type === "hello") { socket = ws; ws.send(JSON.stringify({ type: "welcome", v: 12, hostId: host.id })); }
          else if (frame.seq) {
            messages.push(frame);
            ws.send(JSON.stringify({ type: "ack", ack: frame.seq }));
          }
        }
      },
      close(ws) { if (ws.data.kind === "maintenance") maintenance.maintenanceSocket.close(ws); },
    },
  });
  const daemon = runHostDaemon({ allowHttp: false, links: [{ url: `http://127.0.0.1:${server.port}`, token }] });
  t.after(async () => { await daemon.stop(); server.stop(true); });
  await daemon.started;
  await until(() => socket && maintenance.getMaintenanceHost(host.id), "both connections to be ready");
  socket.send(JSON.stringify({ type: "req", seq: ++seq, id: "open-active", op: "open", args: { sessionId: id, launch: { cwd: root, recordedCwd: root, sessionFile: file, advisor: false } } }));
  await until(() => messages.some(frame => frame.type === "res" && frame.id === "open-active"), "the real daemon to start its child");
  const opened = messages.find(frame => frame.type === "res" && frame.id === "open-active");
  assert.equal(opened.ok, true, JSON.stringify(opened));
  socket.send(JSON.stringify({ type: "stdin", seq: ++seq, ch: opened.result.ch, line: JSON.stringify({ t: "cmd", id: 1, op: "prompt", args: { message: "work" } }) + "\n" }));
  await until(() => messages.some(frame => frame.type === "stdout" && JSON.parse(frame.line).event?.type === "agent_start"), "the prompt to become active");
  const status = await maintenance.requestMaintenance(host.id, "status", {});
  assert.equal(status.sessionProcesses, 1);
  assert.equal(status.sessions.find(session => session.id === id)?.active, true);
  assert.ok(status.busyReason, "an active child still blocks updating its daemon");
  const inventory = await maintenance.requestMaintenance(host.id, "listSessions", {});
  assert.equal(inventory.find(session => session.id === id)?.active, true);
  assert.equal(inventory.find(session => session.id === id)?.processRunning, true);
});
