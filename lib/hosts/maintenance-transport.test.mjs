import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The hub and a real DaemonMaintenance over loopback, served through Bun.serve the way server/app.ts does.
const dir = mkdtempSync(join(tmpdir(), "omp-maintenance-transport-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const hub = await import("./maintenance-hub.ts");
const { DaemonMaintenance } = await import("./daemon-maintenance.ts");
const { MAINTENANCE_CLOSE, MAINTENANCE_LIMITS, MAINTENANCE_OPS, maintenanceTimings } = await import("./maintenance-protocol.ts");
const { createHost, revokeHost } = await import("./registry.ts");
const timings = { ...maintenanceTimings };
Object.assign(maintenanceTimings, { retryMs: 20, retryMaxMs: 60, helloMs: 1000 });

const seen = { discoveries: 0, upgrades: 0 };
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request, bun) {
    if (new URL(request.url).pathname !== "/api/hosts/maintenance") return new Response("<html>app</html>", { headers: { "content-type": "text/html" } });
    seen[request.headers.get("upgrade") === "websocket" ? "upgrades" : "discoveries"] += 1;
    return hub.handleMaintenanceUpgrade(request, (data) => bun.upgrade(request, { data }), { protocolVersion: 12, ompwebVersion: "0.7.1" });
  },
  websocket: hub.maintenanceSocket,
});

test.after(async () => {
  await server.stop(true);
  Object.assign(maintenanceTimings, timings);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, what = "the condition") {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
/** The error a request fails with. */
const failed = (promise) => promise.then(() => assert.fail("expected a rejection"), (error) => error);
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));

const host = () => createHost("h");
const helloFor = (extra) => () => ({ type: "hello", apiVersion: 1, protocolVersion: 12, ompwebVersion: "0.7.1", ompVersion: "14.0.0", platform: "linux", capabilities: [...MAINTENANCE_OPS], ...extra });

/** A daemon end dialing `url`; `handle` answers its requests. */
function daemon(t, { token, url = `http://127.0.0.1:${server.port}`, handle = async () => ({}), hello } = {}) {
  const log = [];
  const states = [];
  const maintenance = new DaemonMaintenance({ url, token }, { hello: helloFor(hello), handleRequest: handle, log: (text) => log.push(text), onState: (up) => states.push(up) });
  t.after(() => maintenance.stop());
  maintenance.start();
  return { maintenance, log, states };
}
const linkedHost = (t, options) => {
  const { host: record, token } = host();
  return { id: record.id, token, ...daemon(t, { token, ...options }) };
};

/** A server that is not ours to control: `discovery()` answers the GET, `onHello(ws)` the socket's hello. */
function fake(t, { discovery = () => Response.json({ apiVersion: 1 }), onHello = (ws) => ws.send(JSON.stringify({ type: "welcome", apiVersion: 1 })) } = {}) {
  const state = { probes: 0, connections: 0, frames: [], socket: null, say: (frame) => state.socket.send(JSON.stringify(frame)) };
  const raw = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, bun) {
      if (request.headers.get("upgrade") !== "websocket") {
        state.probes += 1;
        return discovery(request);
      }
      return bun.upgrade(request) ? undefined : new Response("no", { status: 426 });
    },
    websocket: {
      open(ws) { state.connections += 1; state.socket = ws; },
      message(ws, data) {
        const frame = JSON.parse(data);
        state.frames.push(frame);
        if (frame.type === "hello") onHello(ws);
      },
      close() {},
    },
  });
  t.after(() => raw.stop(true));
  state.url = `http://127.0.0.1:${raw.port}`;
  return state;
}

test("answers status, list, check and update requests whatever the application protocol", async (t) => {
  const calls = [];
  const { id } = linkedHost(t, { handle: async (op, args) => { calls.push([op, args]); return { op }; }, hello: { protocolVersion: 99, apiVersion: 7 } });
  await until(() => hub.getMaintenanceHost(id), "the link");
  assert.equal(hub.getMaintenanceHost(id).protocolVersion, 99);
  assert.equal(hub.getMaintenanceHost(id).apiVersion, 1);
  assert.ok(seen.discoveries > 0);
  for (const op of MAINTENANCE_OPS) assert.deepEqual(await hub.requestMaintenance(id, op, { n: 1 }), { op });
  assert.deepEqual(calls, MAINTENANCE_OPS.map((op) => [op, { n: 1 }]));
  // A handler that returns nothing answers null.
  const silent = linkedHost(t, { handle: async () => undefined });
  await until(() => hub.getMaintenanceHost(silent.id), "the link");
  assert.equal(await hub.requestMaintenance(silent.id, "status", {}), null);
});

test("keeps the native status and code of a host error and stays usable", async (t) => {
  const errors = [
    Object.assign(new Error("A session is running"), { code: "host_busy", httpStatus: 409 }),
    Object.assign(new Error("Gone"), { code: "session_not_found", status: 404 }),
    new Error("boom"),
  ];
  let next = 0;
  const { id } = linkedHost(t, { handle: async (op) => { if (op === "status") return "x".repeat(MAINTENANCE_LIMITS.frameBytes); throw errors[next++]; } });
  await until(() => hub.getMaintenanceHost(id), "the link");
  const shape = (error) => [error.status, error.code, error.message];
  assert.deepEqual(shape(await failed(hub.requestMaintenance(id, "updateSoftware", {}))), [409, "host_busy", "A session is running"]);
  assert.deepEqual(shape(await failed(hub.requestMaintenance(id, "checkUpdates", {}))), [404, "session_not_found", "Gone"]);
  assert.deepEqual(shape(await failed(hub.requestMaintenance(id, "listSessions", {}))), [500, "internal", "boom"]);
  assert.deepEqual((await failed(hub.requestMaintenance(id, "status", {}))).code, "too_large");
  assert.ok(hub.getMaintenanceHost(id));
});

test("answers an unknown or unadvertised op, a bad args envelope and a duplicate id without dropping the link", async (t) => {
  const release = Promise.withResolvers();
  const state = fake(t);
  const { states } = daemon(t, { token: "t", url: state.url, hello: { capabilities: ["status"] }, handle: async () => { await release.promise; return "ok"; } });
  await until(() => states[0] === true, "the link");
  const replies = () => state.frames.filter((frame) => frame.type === "res");
  const replyTo = (id) => replies().find((frame) => frame.id === id);
  state.say({ type: "req", id: "a", op: "nope", args: {} });
  state.say({ type: "req", id: "b", op: "updateSoftware", args: {} });
  state.say({ type: "req", id: "c", op: "status", args: [] });
  state.say({ type: "req", id: "d", op: "status" });
  await until(() => ["a", "b", "c", "d"].every((id) => replyTo(id)), "the replies");
  assert.deepEqual([replyTo("a"), replyTo("b")].map((r) => [r.ok, r.status, r.code]), [[false, 501, "unsupported_op"], [false, 501, "unsupported_op"]]);
  assert.deepEqual([replyTo("c"), replyTo("d")].map((r) => [r.ok, r.status, r.code]), [[false, 400, "bad_request"], [false, 400, "bad_request"]]);
  state.say({ type: "req", id: "e", op: "status", args: {} });
  state.say({ type: "req", id: "e", op: "status", args: {} });
  await until(() => replyTo("e"), "the duplicate's reply");
  assert.deepEqual([replyTo("e").status, replyTo("e").code], [409, "duplicate_request"]);
  release.resolve();
  await until(() => replies().some((frame) => frame.id === "e" && frame.ok), "the first one's result");
  assert.deepEqual(states, [true]);
  assert.equal(state.connections, 1);
});

test("drops a link whose server sends a request before the welcome", async (t) => {
  const state = fake(t, { onHello: (ws) => ws.send(JSON.stringify({ type: "req", id: "early", op: "status", args: {} })) });
  const { states } = daemon(t, { token: "t", url: state.url });
  await until(() => state.connections >= 2, "a redial");
  assert.deepEqual(states, []);
  assert.equal(state.frames.some((frame) => frame.type === "res"), false);
});

test("never opens a socket to a server that is not maintenance API 1, and keeps retrying", async (t) => {
  const answers = {
    "no endpoint": () => new Response("Not Found", { status: 404 }),
    "a page": () => new Response("<html>app</html>", { headers: { "content-type": "text/html" } }),
    "an empty 426": () => new Response(null, { status: 426 }),
    "another API": () => Response.json({ apiVersion: 2 }),
    "a string version": () => Response.json({ apiVersion: "1" }),
    "a redirect": (request) => Response.redirect(request.url, 302),
  };
  for (const [name, discovery] of Object.entries(answers)) {
    const state = fake(t, { discovery });
    const { maintenance, log, states } = daemon(t, { token: "t", url: state.url });
    await until(() => state.probes >= 3, `${name} to be probed again`);
    assert.equal(state.connections, 0, name);
    assert.deepEqual(states, [], name);
    assert.ok(log.length > 0, name);
    await maintenance.stop();
  }
});

test("retries a refused token and a server error without ending, and links once rekeyed", async (t) => {
  const { host: record, token } = host();
  const { maintenance, log, states } = daemon(t, { token: "wrong" });
  const before = seen.discoveries;
  await until(() => seen.discoveries >= before + 3, "retries");
  assert.equal(hub.getMaintenanceHost(record.id), null);
  assert.ok(log.some((line) => line.includes("refused this host's token")), log.join("\n"));
  maintenance.rekey(token);
  await until(() => hub.getMaintenanceHost(record.id) && states.includes(true), "both ends to accept the link after rekey");
  assert.deepEqual(states, [true]);
});

test("a hello the server refuses as another API is retried, never fatal", async (t) => {
  const state = fake(t, { onHello: (ws) => ws.close(MAINTENANCE_CLOSE.apiMismatch, JSON.stringify({ apiVersion: 2 })) });
  const { log, states } = daemon(t, { token: "t", url: state.url });
  await until(() => state.connections >= 3, "redials");
  assert.deepEqual(states, []);
  assert.ok(log.some((line) => line.includes("apiVersion")), log.join("\n"));
  const welcome2 = fake(t, { onHello: (ws) => ws.send(JSON.stringify({ type: "welcome", apiVersion: 2 })) });
  const second = daemon(t, { token: "t", url: welcome2.url });
  await until(() => welcome2.connections >= 2, "redials");
  assert.deepEqual(second.states, []);
});

test("gives up on a server that goes silent and dials again", async (t) => {
  maintenanceTimings.offlineMs = 80;
  t.after(() => { maintenanceTimings.offlineMs = timings.offlineMs; });
  const state = fake(t);
  const { states } = daemon(t, { token: "t", url: state.url });
  await until(() => states.length >= 2, "the watchdog");
  assert.deepEqual(states.slice(0, 2), [true, false]);
  await until(() => state.connections >= 2, "the redial");
});

test("does not repeat a request that was in flight when the link dropped", async (t) => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const { id, states } = linkedHost(t, { handle: async () => { calls += 1; if (calls === 1) await gate.promise; return calls; } });
  await until(() => hub.getMaintenanceHost(id), "the link");
  const lost = outcome(hub.requestMaintenance(id, "updateSoftware", {}));
  await until(() => calls === 1, "the handler to start");
  hub.closeMaintenanceHost(id);
  assert.equal((await lost).error.code, "delivery_unknown");
  await until(() => states.join() === "true,false,true", "the redial");
  await until(() => hub.getMaintenanceHost(id), "the new link");
  await sleep(50);
  assert.equal(calls, 1);
  // The old connection's late result goes nowhere; the new link works.
  gate.resolve();
  await sleep(30);
  assert.equal(await hub.requestMaintenance(id, "status", {}), 2);
  assert.equal(calls, 2);
});

test("stop closes the link, drops what is running and never dials again", async (t) => {
  const gate = Promise.withResolvers();
  const { id, maintenance, states } = linkedHost(t, { handle: async () => { await gate.promise; return "late"; } });
  await until(() => hub.getMaintenanceHost(id), "the link");
  const pending = outcome(hub.requestMaintenance(id, "status", {}));
  await sleep(30);
  await maintenance.stop();
  assert.deepEqual(states, [true, false]);
  assert.equal((await pending).error.code, "delivery_unknown");
  await until(() => hub.getMaintenanceHost(id) === null, "the server to see the close");
  const dials = seen.discoveries;
  gate.resolve();
  await sleep(150);
  assert.equal(seen.discoveries, dials);
  assert.deepEqual(states, [true, false]);
});

test("a revoked host's daemon keeps retrying and is not let back in", async (t) => {
  const { id, states } = linkedHost(t);
  await until(() => hub.getMaintenanceHost(id), "the link");
  revokeHost(id);
  hub.closeMaintenanceHost(id);
  await until(() => states.join() === "true,false", "the drop");
  const dials = seen.discoveries;
  await until(() => seen.discoveries >= dials + 3, "retries");
  assert.equal(hub.getMaintenanceHost(id), null);
});

test("freezing the server closes links and refuses dials until it restarts, without ending the daemon", async (t) => {
  t.after(() => { globalThis.__ompMaintenanceHub = undefined; });
  const { id, states } = linkedHost(t);
  await until(() => hub.getMaintenanceHost(id), "the link");
  hub.freezeMaintenance();
  await until(() => states.join() === "true,false", "the close");
  const upgrades = seen.upgrades;
  const dials = seen.discoveries;
  await until(() => seen.discoveries >= dials + 3, "refused dials");
  assert.equal(seen.upgrades, upgrades);
  assert.equal(hub.getMaintenanceHost(id), null);
  // The next server process starts with fresh state.
  globalThis.__ompMaintenanceHub = undefined;
  await until(() => hub.getMaintenanceHost(id), "the link on the restarted server");
  assert.deepEqual(states, [true, false, true]);
});
