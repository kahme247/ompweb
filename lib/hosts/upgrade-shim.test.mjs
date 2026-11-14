import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ompweb-upgrade-shim-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const hub = await import("./hub.ts");
const { linkHost, upgradeSocket, until } = await import("./link-driver.test-helper.mjs");
const { LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");
const { getRpcSession } = await import("../rpc-manager.ts");
after(() => {
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const sid = "11111111-2222-4333-8444-5555555555bb";
const channels = [{ ch: "old-channel", sessionId: sid, cwd: "/w", pending: ['{"type":"agent_start"}'] }];
const operation = { id: "update-attempt", target: "ompweb", version: "0.7.1", state: "running" };
const info = {
  ompweb: { currentVersion: "0.6.0", availableVersion: "0.7.1", updateAvailable: true, canUpdate: true, blockedReason: null, updateCommand: "npm install -g @kahme247/ompweb", installMethod: "npm", protocolVersion: 12 },
  omp: { currentVersion: "18.20.0" }, operation: null,
};

for (const v of [10, 11]) test(`v${v} is welcomed as itself solely for its unchanged updater`, async (t) => {
  const hellos = [], sessionsChanged = [], other = [], requests = [];
  t.after(hub.onHostHello((id) => hellos.push(id)));
  t.after(hub.onHostSessionsChanged((id) => sessionsChanged.push(id)));
  const link = await linkHost(`Legacy v${v}`, { channels, hello: { v, ompwebVersion: "0.6.0" } });
  t.after(() => link.drop());
  assert.equal(link.welcome.v, v, "the old daemon rejects a welcome above its own protocol");
  const row = () => hub.listHosts().find((host) => host.id === link.id);
  assert.equal(row().status, "needs-upgrade");
  assert.equal(row().upgradeOnly, true);
  assert.deepEqual(row().workspaceOps, []);
  assert.equal(getRpcSession(sid), undefined, "the shim must not adopt legacy sessions");
  link.serve({
    checkUpdates: (args) => { requests.push(["checkUpdates", args]); return info; },
    updateSoftware: (args) => { requests.push(["updateSoftware", args]); return { accepted: true, operation }; },
  }, (message) => other.push(message));
  assert.equal((await hub.getHostSoftwareUpdates(link.id, true)).ompweb.canUpdate, true);
  assert.deepEqual(await hub.updateHostSoftware(link.id, "ompweb", "0.7.1"), { accepted: true, operation });
  assert.ok(requests.some(([op]) => op === "updateSoftware"));
  for (const [, args] of requests) assert.deepEqual(args.compatibility, { min: 12, max: 12 });
  await assert.rejects(hub.getHost(link.id).sessionFileExists("/w/session.jsonl"), { code: "host_upgrade_required" });
  await link.post(
    { type: "channels_changed", channels },
    { type: "stdout", ch: "old-channel", line: '{"type":"agent_start"}' },
    { type: "sessions_changed" },
  );
  // Give deferred imports and adoption attempts a quiet window in which to expose an accidental dispatch.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(getRpcSession(sid), undefined, "legacy channel announcements must not adopt sessions either");
  assert.deepEqual(hellos, [], "legacy hello must not trigger application startup hooks");
  assert.deepEqual(sessionsChanged, [], "legacy events must not enter application discovery");
  assert.deepEqual(other, [], "no open, kill, config sync or application command may reach the old daemon");
  link.drop();
  await until(() => !row().upgradeOnly, "the closed shim stops advertising update capability");
});

test("a legacy shim cannot replace a healthy application connection", async (t) => {
  const link = await linkHost("Current host");
  t.after(() => link.drop());
  const { socket } = upgradeSocket(link.token);
  socket.frame(JSON.stringify({ type: "hello", v: 10, ompVersion: null, platform: "linux", home: "/tmp", autoApproveExtension: false, ack: 0, channels: [] }));
  assert.equal(socket.closed?.code, 4426);
  assert.equal(link.socket.closed, null);
  const row = hub.listHosts().find((host) => host.id === link.id);
  assert.equal(row.status, "online");
  assert.equal(row.hostVersion, LINK_PROTOCOL_VERSION);
  assert.ok(!row.upgradeOnly);
});

test("a shim reconnect never replays an update whose delivery is uncertain", async (t) => {
  const link = await linkHost("Interrupted update", { hello: { v: 10 } });
  t.after(() => link.drop());
  const updating = hub.updateHostSoftware(link.id, "ompweb", "0.7.1");
  const rejected = assert.rejects(updating, { code: "transport_lost" });
  const check = await link.next();
  assert.equal(check.op, "checkUpdates");
  await link.answer(check, info);
  const update = await link.next();
  assert.equal(update.op, "updateSoftware");
  await link.dial({ hello: { v: 10 } });
  await rejected;
  assert.ok(link.socket.frames.every(line => JSON.parse(line).type !== "req"), "the old update must not run again");
});

test("unacknowledged application input never crosses into a legacy shim", async (t) => {
  const link = await linkHost("Protocol downgrade");
  t.after(() => link.drop());
  const spawning = hub.getHost(link.id).spawnRpc({ cwd: "/w", recordedCwd: null, sessionFile: "", advisor: false }, null);
  const open = await link.next();
  assert.equal(open.op, "open");
  await link.answer(open, { ch: "full-channel", joined: false, pending: [], streaming: null, advisorSpawned: false, cwd: "/w", fellBack: false, launchAdvisor: false, autoApproveExtension: false });
  const { transport } = await spawning;
  transport.write('{"t":"cmd","id":1,"op":"prompt","args":{"message":"must not replay"}}\\n', () => {});
  const stdin = await link.next();
  assert.equal(stdin.type, "stdin");
  link.drop();
  await new Promise(resolve => setImmediate(resolve));
  await link.dial({ hello: { v: 11 } });
  assert.equal(link.welcome.v, 11);
  assert.ok(link.socket.frames.every(line => ["welcome", "ack", "ping", "pong"].includes(JSON.parse(line).type)));
});
