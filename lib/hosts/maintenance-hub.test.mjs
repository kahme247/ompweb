import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "omp-maintenance-hub-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const hub = await import("./maintenance-hub.ts");
const { MAINTENANCE_CLOSE, MAINTENANCE_LIMITS, MaintenanceError, maintenanceTimings } = await import("./maintenance-protocol.ts");
const { createHost, revokeHost } = await import("./registry.ts");
const timings = { ...maintenanceTimings };

test.after(() => {
  Object.assign(maintenanceTimings, timings);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hello = (extra = {}) => ({ type: "hello", apiVersion: 1, protocolVersion: 12, ompwebVersion: "0.7.1", ompVersion: "14.0.0", platform: "linux", capabilities: ["status", "listSessions", "checkUpdates", "updateSoftware"], ...extra });

/** The hub's view of a socket: what it sent and how it was closed. */
function socket(hostId) {
  return {
    data: { kind: "maintenance", hostId },
    sent: [],
    closed: null,
    terminated: false,
    send(line) { this.sent.push(JSON.parse(line)); return line.length; },
    close(code, reason) { this.closed = { code, reason }; },
    terminate() { this.terminated = true; },
  };
}
const say = (ws, frame) => hub.maintenanceSocket.message(ws, typeof frame === "string" ? frame : JSON.stringify(frame));
const requests = (ws) => ws.sent.filter((frame) => frame.type === "req");
const request = (headers) => new Request("http://server/api/hosts/maintenance", { headers });
const reject = (promise) => promise.then(() => assert.fail("expected a rejection"), (error) => error);

function reset() {
  for (const link of [...(globalThis.__ompMaintenanceHub?.links.values() ?? [])]) hub.closeMaintenanceHost(link.id);
  globalThis.__ompMaintenanceHub = undefined;
  Object.assign(maintenanceTimings, timings);
}
const it = (name, body) => test(name, async (t) => { t.after(reset); await body(t); });

/** A registered host whose daemon has said hello on a fresh socket. */
function linked(extra) {
  const { host } = createHost("h");
  const ws = socket(host.id);
  say(ws, hello(extra));
  return { id: host.id, ws };
}

it("authenticates before discovery or upgrade", () => {
  const { token } = createHost("auth");
  let upgraded = null;
  const upgrade = (data) => { upgraded = data; return true; };
  assert.equal(hub.handleMaintenanceUpgrade(request({ upgrade: "websocket" }), upgrade).status, 401);
  assert.equal(hub.handleMaintenanceUpgrade(request({ authorization: "Bearer wrong", upgrade: "websocket" }), upgrade).status, 401);
  assert.equal(hub.handleMaintenanceUpgrade(request(), upgrade).status, 401);
  assert.equal(upgraded, null);
  assert.equal(hub.handleMaintenanceUpgrade(request({ authorization: `Bearer ${token}`, upgrade: "websocket" }), upgrade), undefined);
  assert.equal(upgraded.kind, "maintenance");
  assert.equal(hub.handleMaintenanceUpgrade(request({ authorization: `Bearer ${token}`, upgrade: "websocket" }), () => false).status, 426);
});

it("answers a plain GET with the API version, never a socket", async () => {
  const { token } = createHost("discovery");
  const response = hub.handleMaintenanceUpgrade(request({ authorization: `Bearer ${token}` }), () => assert.fail("no upgrade"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { apiVersion: 1, capabilities: ["status", "listSessions", "checkUpdates", "updateSoftware"] });
});

it("adds the server's software to the discovery answer when given", async () => {
  const { token } = createHost("server-info");
  const response = hub.handleMaintenanceUpgrade(request({ authorization: `Bearer ${token}` }), () => assert.fail("no upgrade"), { protocolVersion: 12, ompwebVersion: "0.7.1" });
  assert.deepEqual(await response.json(), { protocolVersion: 12, ompwebVersion: "0.7.1", apiVersion: 1, capabilities: ["status", "listSessions", "checkUpdates", "updateSoftware"] });
});

it("welcomes a hello whatever the application protocol version", async () => {
  const seen = [];
  const off = hub.onMaintenanceChange(() => seen.push(1));
  const { id, ws } = linked({ protocolVersion: 99 });
  assert.deepEqual(ws.sent, [{ type: "welcome", apiVersion: 1 }]);
  assert.equal(hub.getMaintenanceHost(id).protocolVersion, 99);
  assert.equal(seen.length, 1);
  const pending = hub.requestMaintenance(id, "status", { a: 1 });
  const [asked] = requests(ws);
  assert.deepEqual({ op: asked.op, args: asked.args }, { op: "status", args: { a: 1 } });
  say(ws, { type: "res", id: asked.id, ok: true, result: { busy: false } });
  assert.deepEqual(await pending, { busy: false });
  off();
});

it("refuses another API version, even when the rest of its hello is not ours", () => {
  const { host } = createHost("v2");
  const ws = socket(host.id);
  say(ws, { type: "hello", apiVersion: 2, whatever: [] });
  assert.deepEqual(ws.closed, { code: MAINTENANCE_CLOSE.apiMismatch, reason: JSON.stringify({ apiVersion: 1 }) });
  assert.equal(hub.getMaintenanceHost(host.id), null);
});

it("closes a socket whose first frame is not a valid hello", () => {
  const { host } = createHost("bad");
  const closeOf = (frame) => { const ws = socket(host.id); say(ws, frame); return ws.closed.code; };
  assert.equal(closeOf({ type: "res", id: "x" }), MAINTENANCE_CLOSE.policy);
  assert.equal(closeOf("not json"), MAINTENANCE_CLOSE.policy);
  assert.equal(closeOf(hello({ platform: 3 })), MAINTENANCE_CLOSE.policy);
  assert.equal(closeOf(JSON.stringify({ type: "hello", pad: "x".repeat(MAINTENANCE_LIMITS.frameBytes) })), MAINTENANCE_CLOSE.tooBig);
  const binary = socket(host.id);
  hub.maintenanceSocket.message(binary, new Uint8Array(4));
  assert.equal(binary.closed.code, MAINTENANCE_CLOSE.policy);
  assert.equal(hub.getMaintenanceHost(host.id), null);
});

it("closes a socket that never says hello", async () => {
  maintenanceTimings.helloMs = 20;
  const { host } = createHost("silent");
  const ws = socket(host.id);
  hub.maintenanceSocket.open(ws);
  await sleep(60);
  assert.equal(ws.closed.code, MAINTENANCE_CLOSE.policy);
  const welcomed = socket(host.id);
  hub.maintenanceSocket.open(welcomed);
  say(welcomed, hello());
  await sleep(60);
  assert.equal(welcomed.closed, null);
});

it("rechecks the registry after the hello and rejects a revoked host", () => {
  const { host } = createHost("revoked");
  const ws = socket(host.id);
  revokeHost(host.id);
  say(ws, hello());
  assert.equal(ws.closed.code, MAINTENANCE_CLOSE.policy);
  assert.equal(hub.getMaintenanceHost(host.id), null);
});

it("drops capabilities it does not know and never sends an op the host did not advertise", async () => {
  const { id, ws } = linked({ capabilities: ["status", "future"] });
  assert.deepEqual(hub.getMaintenanceHost(id).capabilities, ["status"]);
  const error = await reject(hub.requestMaintenance(id, "updateSoftware", {}));
  assert.deepEqual([error.status, error.code], [501, "unsupported_op"]);
  assert.equal(requests(ws).length, 0);
});

it("fails a request for a host without a link, an oversized one and too many at once", async () => {
  assert.equal((await reject(hub.requestMaintenance("nobody", "status", {}))).code, "no_link");
  const { id, ws } = linked();
  const big = await reject(hub.requestMaintenance(id, "status", { text: "x".repeat(MAINTENANCE_LIMITS.frameBytes) }));
  assert.deepEqual([big.status, big.code], [413, "too_large"]);
  const open = Array.from({ length: MAINTENANCE_LIMITS.inFlight }, () => hub.requestMaintenance(id, "status", {}));
  assert.equal((await reject(hub.requestMaintenance(id, "status", {}))).code, "busy");
  assert.equal(requests(ws).length, MAINTENANCE_LIMITS.inFlight);
  for (const asked of requests(ws)) say(ws, { type: "res", id: asked.id, ok: true, result: null });
  assert.deepEqual(await Promise.all(open), open.map(() => null));
});

it("keeps the host's native error status and code", async () => {
  const { id, ws } = linked();
  const failed = hub.requestMaintenance(id, "updateSoftware", {});
  say(ws, { type: "res", id: requests(ws)[0].id, ok: false, status: 409, code: "host_busy", message: "Sessions are running" });
  const error = await reject(failed);
  assert.ok(error instanceof MaintenanceError);
  assert.deepEqual([error.status, error.code, error.message], [409, "host_busy", "Sessions are running"]);
  const odd = hub.requestMaintenance(id, "status", {});
  say(ws, { type: "res", id: requests(ws)[1].id, ok: false, status: 200, code: "Not Snake", message: "m" });
  const normalized = await reject(odd);
  assert.deepEqual([normalized.status, normalized.code], [500, "internal"]);
});

it("a malformed error response rejects its request instead of losing its settlement", async () => {
  const { id, ws } = linked();
  const failed = hub.requestMaintenance(id, "status", {});
  say(ws, { type: "res", id: requests(ws)[0].id, ok: false, toString: null });
  const error = await Promise.race([reject(failed), sleep(100).then(() => null)]);
  assert.ok(error instanceof MaintenanceError, "the malformed response must not leave the caller pending");
  assert.deepEqual([error.status, error.code], [500, "internal"]);
});

it("times out without repeating the request and ignores its late answer", async () => {
  const { id, ws } = linked();
  const error = await reject(hub.requestMaintenance(id, "status", {}, 20));
  assert.deepEqual([error.status, error.code], [504, "timeout"]);
  say(ws, { type: "res", id: requests(ws)[0].id, ok: true, result: 1 });
  assert.equal(requests(ws).length, 1);
  const next = hub.requestMaintenance(id, "status", {});
  say(ws, { type: "res", id: requests(ws)[1].id, ok: true, result: 2 });
  assert.equal(await next, 2);
});

it("fails a request in flight when the link drops and never replays it on the next link", async () => {
  const { id, ws } = linked();
  const lost = hub.requestMaintenance(id, "updateSoftware", { version: "1" });
  const lateId = requests(ws)[0].id;
  hub.maintenanceSocket.close(ws);
  const error = await reject(lost);
  assert.deepEqual([error.status, error.code], [502, "delivery_unknown"]);
  assert.equal(hub.getMaintenanceHost(id), null);
  const again = socket(id);
  say(again, hello());
  assert.deepEqual(again.sent, [{ type: "welcome", apiVersion: 1 }]);
  say(ws, { type: "res", id: lateId, ok: true, result: "late" });
  assert.equal(requests(again).length, 0);
});

it("lets a newer socket replace the old one, closing and failing only the old", async () => {
  const { id, ws: old } = linked();
  const inFlight = hub.requestMaintenance(id, "status", {});
  const fresh = socket(id);
  say(fresh, hello({ ompwebVersion: "0.7.2" }));
  assert.equal(old.closed.code, MAINTENANCE_CLOSE.replaced);
  assert.equal(fresh.closed, null);
  assert.equal((await reject(inFlight)).code, "delivery_unknown");
  assert.equal(hub.getMaintenanceHost(id).ompwebVersion, "0.7.2");
  // The old socket's close event and frames belong to no link.
  hub.maintenanceSocket.close(old);
  say(old, { type: "res", id: "x", ok: true });
  assert.equal(hub.getMaintenanceHost(id).ompwebVersion, "0.7.2");
  const next = hub.requestMaintenance(id, "status", {});
  assert.equal(requests(old).length, 1);
  say(fresh, { type: "res", id: requests(fresh)[0].id, ok: true, result: "fresh" });
  assert.equal(await next, "fresh");
});

it("closeMaintenanceHost closes the socket, fails what is in flight and notifies", async () => {
  const { id, ws } = linked();
  const seen = [];
  const off = hub.onMaintenanceChange(() => seen.push(hub.getMaintenanceHost(id)));
  const inFlight = hub.requestMaintenance(id, "status", {});
  hub.closeMaintenanceHost(id);
  assert.equal(ws.closed.code, MAINTENANCE_CLOSE.policy);
  assert.equal((await reject(inFlight)).code, "delivery_unknown");
  assert.deepEqual(seen, [null]);
  off();
  hub.closeMaintenanceHost(id);
  assert.equal(seen.length, 1);
});

it("a throwing listener does not break the link", () => {
  const off = hub.onMaintenanceChange(() => { throw new Error("listener"); });
  const { id } = linked();
  assert.ok(hub.getMaintenanceHost(id));
  off();
});

it("pings, and drops a host that stays silent", async () => {
  maintenanceTimings.pingMs = 10;
  maintenanceTimings.offlineMs = 45;
  const { id, ws } = linked();
  // Handled at once: it fails while the test sleeps.
  const outcome = reject(hub.requestMaintenance(id, "status", {}));
  await sleep(25);
  assert.ok(ws.sent.some((frame) => frame.type === "ping"));
  say(ws, { type: "pong" });
  assert.equal(ws.terminated, false);
  await sleep(120);
  assert.equal(ws.terminated, true);
  assert.equal(hub.getMaintenanceHost(id), null);
  assert.equal((await outcome).code, "delivery_unknown");
});

it("closes a link whose frame is malformed or too large", () => {
  const first = linked();
  say(first.ws, "{");
  assert.equal(first.ws.closed.code, MAINTENANCE_CLOSE.policy);
  assert.equal(hub.getMaintenanceHost(first.id), null);
  const second = linked();
  say(second.ws, JSON.stringify({ type: "res", pad: "x".repeat(MAINTENANCE_LIMITS.frameBytes) }));
  assert.equal(second.ws.closed.code, MAINTENANCE_CLOSE.tooBig);
  assert.equal(hub.getMaintenanceHost(second.id), null);
});

it("freezing refuses requests and upgrades, closes links 1001 and ignores what arrives after", async () => {
  const { token } = createHost("frozen");
  const { id, ws } = linked();
  const inFlight = hub.requestMaintenance(id, "status", {});
  hub.freezeMaintenance();
  assert.equal(ws.closed.code, MAINTENANCE_CLOSE.goingAway);
  assert.equal((await reject(inFlight)).code, "delivery_unknown");
  assert.equal(hub.getMaintenanceHost(id), null);
  assert.equal((await reject(hub.requestMaintenance(id, "status", {}))).code, "frozen");
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(hub.handleMaintenanceUpgrade(request({ ...headers, upgrade: "websocket" }), () => true).status, 503);
  assert.equal(hub.handleMaintenanceUpgrade(request(headers), () => true).status, 503);
  const late = socket(id);
  say(late, hello());
  assert.equal(late.sent.length, 0);
});

it("keeps its state on globalThis across a hot reload", () => {
  const { id } = linked();
  const state = globalThis.__ompMaintenanceHub;
  assert.ok(state.links.has(id));
  assert.equal(hub.getMaintenanceHost(id).platform, "linux");
});
