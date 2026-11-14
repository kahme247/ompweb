import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-hosts-route-test-"));
const configEnv = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
const previousEnv = new Map(configEnv.map((key) => [key, process.env[key]]));
for (const key of configEnv) delete process.env[key];
process.env.HOME = process.env.USERPROFILE = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.XDG_CONFIG_HOME = join(agentDir, "config");
process.env.XDG_DATA_HOME = join(agentDir, "data");
after(() => {
  // The hub's held link samples go to this file's agent dir, before it is gone.
  hub.flushLinkSamples();
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(agentDir, { recursive: true, force: true });
});

// abortBrokerRequests is the only part of the broker module this file looks at.
const realBroker = await import("../omp/auth-broker.ts");
const abortedBrokerHosts = [];
mock.module("../omp/auth-broker.ts", () => ({ ...realBroker, abortBrokerRequests: (id) => abortedBrokerHosts.push(id) }));

const route = await import("../../app/api/hosts/route.ts");
const hub = await import("./hub.ts");
const { LinkDriver, upgradeSocket } = await import("./link-driver.test-helper.mjs");
const { selectPoolHost } = await import("./pools.ts");
const { LINK_PROTOCOL_VERSION } = await import("./link-protocol.ts");

const hostsFile = join(agentDir, "omp-web", "hosts.json");
const poolsFile = join(agentDir, "omp-web", "pools.json");
const BASE = "http://main.test/api/hosts";

const send = (method, body, headers = {}) =>
  route[method](new Request(BASE, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const get = async () => (await route.GET()).json();

test("POST returns the token once; GET lists the host without any secret", async () => {
  const response = await send("POST", { label: "  laptop " }, { host: "omp.example.com:8443", "x-forwarded-proto": "https" });
  assert.equal(response.status, 200);
  const { host, token, command } = await response.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(host.label, "laptop");
  assert.equal(command, "ompweb host login --url https://omp.example.com:8443");

  const text = JSON.stringify(await get());
  assert.ok(!text.includes(token) && !text.includes("tokenHash"));
  const { hosts } = JSON.parse(text);
  assert.equal(hosts[0].id, "local");
  assert.ok(!("allowAgentStart" in hosts[0]));
  assert.equal(hosts[0].serverPlatform, process.platform);
  assert.deepEqual(hosts.slice(1).map((h) => [h.id, h.status, h.allowAgentStart]), [[host.id, "offline", false]]);
});

test("the command follows x-forwarded-host over the request host", async () => {
  const response = await send("POST", { label: "box" }, { "x-forwarded-host": "proxy.example.com", "x-forwarded-proto": "https" });
  assert.equal((await response.json()).command, "ompweb host login --url https://proxy.example.com");
});

test("DELETE revokes: the host's socket closes and its token then gets 401 on the link", async () => {
  const { host, token } = await (await send("POST", { label: "doomed" })).json();
  const link = new LinkDriver(host.id, token);
  await link.dial();

  const response = await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }));
  assert.equal(response.status, 200);
  assert.equal(await link.next(), null, "revoking closes the host's socket");
  assert.equal(upgradeSocket(token).response?.status, 401);
  assert.ok(!(await get()).hosts.some((h) => h.id === host.id));
  assert.equal((await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }))).status, 404);
});

test("PATCH renames and toggles allowAgentStart; local cannot be edited or revoked", async () => {
  const { host } = await (await send("POST", { label: "old" })).json();
  const patched = await send("PATCH", { id: host.id, label: "new", allowAgentStart: true });
  assert.equal(patched.status, 200);
  assert.deepEqual((await get()).hosts.filter((h) => h.id === host.id).map((h) => [h.label, h.allowAgentStart]), [["new", true]]);

  assert.equal((await send("PATCH", { id: "missing", label: "x" })).status, 404);
});

test("PATCH sets shareCredentials; it must be a boolean and cannot change on this machine", async () => {
  const { host } = await (await send("POST", { label: "sharer" })).json();
  const patched = await send("PATCH", { id: host.id, shareCredentials: true });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).host.shareCredentials, true);

  const bad = await send("PATCH", { id: host.id, shareCredentials: "yes" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "shareCredentials must be a boolean");

  const local = await send("PATCH", { id: "local", shareCredentials: true });
  assert.equal(local.status, 400);
  assert.equal((await local.json()).error, "This machine's credential sharing cannot be changed");
});

test("turning sharing off and revoking abort the host's open broker requests; turning it on does not", async () => {
  const { host } = await (await send("POST", { label: "aborting" })).json();
  abortedBrokerHosts.length = 0;
  assert.equal((await send("PATCH", { id: host.id, shareCredentials: true })).status, 200);
  assert.deepEqual(abortedBrokerHosts, []);
  assert.equal((await send("PATCH", { id: host.id, shareCredentials: false })).status, 200);
  assert.deepEqual(abortedBrokerHosts, [host.id]);
  assert.equal((await send("PATCH", { id: "missing", shareCredentials: false })).status, 404);
  assert.deepEqual(abortedBrokerHosts, [host.id], "a failed write aborts nothing");

  assert.equal((await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }))).status, 200);
  assert.deepEqual(abortedBrokerHosts, [host.id, host.id]);
});

test("turning a member's own sharing off aborts nothing, a non-member's does, an unreadable pools.json aborts; revoking always does", async (t) => {
  const { host: member } = await (await send("POST", { label: "member" })).json();
  const { host: plain } = await (await send("POST", { label: "plain" })).json();
  seedPools(t, [member.id]);
  assert.equal((await send("PATCH", { id: member.id, shareCredentials: true })).status, 200);
  assert.equal((await send("PATCH", { id: plain.id, shareCredentials: true })).status, 200);
  abortedBrokerHosts.length = 0;

  const patched = await send("PATCH", { id: member.id, shareCredentials: false });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).host.shareCredentials, false);
  assert.deepEqual(abortedBrokerHosts, [], "the member still shares, so its requests keep running");

  assert.equal((await send("PATCH", { id: plain.id, shareCredentials: false })).status, 200);
  assert.deepEqual(abortedBrokerHosts, [plain.id]);

  writeFileSync(poolsFile, "{not json");
  assert.equal((await send("PATCH", { id: member.id, shareCredentials: false })).status, 200);
  assert.deepEqual(abortedBrokerHosts, [plain.id, member.id], "membership unknown: cut the requests");

  const revoke = () => route.DELETE(new Request(`${BASE}?id=${member.id}`, { method: "DELETE" }));
  assert.equal((await revoke()).status, 503, "membership unknown: the revoke could leave a stale member");
  assert.equal(readFileSync(poolsFile, "utf8"), "{not json");
  assert.deepEqual(abortedBrokerHosts, [plain.id, member.id]);

  const pool = seedPools(t, ["local", member.id]);
  assert.equal((await revoke()).status, 200);
  assert.deepEqual(abortedBrokerHosts, [plain.id, member.id, member.id]);
  // Revoking leaves the cluster by leaveCluster's rules: the member is gone, its checkout inside its folder stays bound.
  assert.deepEqual((await get()).pools, [{ ...pool, members: pool.members.filter((m) => m.hostId !== member.id) }]);
});

test("bodies are validated at the route", async () => {
  assert.equal((await send("POST", {})).status, 400);
  assert.equal((await send("POST", { label: "   " })).status, 400);
  assert.equal((await send("POST", { label: 5 })).status, 400);
  assert.equal((await send("POST", { label: "x".repeat(101) })).status, 400);
  assert.equal((await send("POST", { label: "x".repeat(100) })).status, 200);
  const { host } = await (await send("POST", { label: "ok" })).json();
  for (const body of [
    { id: host.id },
    { id: host.id, label: "" },
    { id: host.id, label: "y".repeat(101) },
    { id: host.id, allowAgentStart: "yes" },
    { label: "no id" },
  ]) assert.equal((await send("PATCH", body)).status, 400, JSON.stringify(body));
  assert.equal((await route.POST(new Request(BASE, { method: "POST", body: "{nope" }))).status, 400);
});

test("an unreadable hosts.json answers 503 and is never rewritten; a revoke leaves the cluster untouched", async (t) => {
  const { host } = await (await send("POST", { label: "keep" })).json();
  seedPools(t, ["local", host.id]);
  const pools = readFileSync(poolsFile, "utf8");
  const broken = "{not json";
  mkdirSync(join(hostsFile, ".."), { recursive: true });
  writeFileSync(hostsFile, broken);

  assert.equal((await send("POST", { label: "new" })).status, 503);
  assert.equal((await send("PATCH", { id: host.id, label: "x" })).status, 503);
  assert.equal((await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }))).status, 503);
  assert.equal(readFileSync(hostsFile, "utf8"), broken);
  assert.equal(readFileSync(poolsFile, "utf8"), pools, "the member stays while its record and link remain");
});

test("the local row and getHost(local) show the reserved record's real link status", async () => {
  writeFileSync(hostsFile, '{"hosts":[]}');
  const { ensureLocalHostLink } = await import("./local-bootstrap.ts");
  const localRows = async () => (await get()).hosts.filter((h) => h.id === "local");

  // Dev server, or before the first bootstrap: no record, no daemon.
  assert.deepEqual((await localRows()).map((h) => [h.label, h.status]), [["", "offline"]], "no custom name: the UI shows the localized default");
  assert.equal(hub.getHost("local").status(), "offline");

  const { token } = await ensureLocalHostLink({ url: "http://127.0.0.1:30177" });
  assert.deepEqual((await localRows()).map((h) => h.status), ["offline"], "a record alone is not a link");

  await new LinkDriver("local", token).dial();
  const [row] = await localRows();
  assert.equal(row.status, "online");
  assert.equal(row.ompVersion, "14.0.0");
  assert.ok(!("allowAgentStart" in row), "the UI shows no revoke/rename controls for this machine");
  assert.equal((await get()).hosts[0].id, "local");
  assert.equal((await get()).hosts.filter((h) => h.id === "local").length, 1);

  // Sessions on this machine run through the same link.
  const local = hub.getHost("local");
  assert.equal(local.id, "local");
  assert.equal(local.status(), "online");

  assert.equal((await send("PATCH", { id: "local", allowAgentStart: false })).status, 400);
  assert.equal((await route.DELETE(new Request(`${BASE}?id=local`, { method: "DELETE" }))).status, 400);

  // Renamed, the name reaches the row and server-side text; an empty or blank name resets it.
  const renamed = await send("PATCH", { id: "local", label: "  Desk " });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).host.label, "Desk");
  assert.deepEqual((await localRows()).map((h) => h.label), ["Desk"]);
  assert.equal(hub.getHost("local").label, "Desk");
  assert.equal((await send("PATCH", { id: "local", label: "x".repeat(101) })).status, 400);
  assert.equal((await send("PATCH", { id: "local", label: 5 })).status, 400);
  assert.equal((await send("PATCH", { id: "local" })).status, 400);
  assert.equal((await send("PATCH", { id: "local", label: "  " })).status, 200);
  assert.deepEqual((await localRows()).map((h) => h.label), [""]);
  assert.equal(hub.getHost("local").label, "This machine");
});

function configuredPool(hostIds = ["local"]) {
  return {
    id: "workers", label: "Workers", enabled: true,
    members: hostIds.map((hostId) => ({ hostId, projectsRoot: "/srv/projects", provisioned: true, draining: false })),
    projects: [{
      id: "app", name: "App", origin: "https://example.com/team/app.git", defaultRef: "main",
      clonePaths: Object.fromEntries(hostIds.map((id) => [id, "/srv/projects/app"])),
      addedAt: "2026-11-10T00:00:00.000Z", hidden: false, alias: "Work", sortOrder: 2, pinOrder: 1,
      launchConfig: { profile: "coding", advisor: true, extraArgs: ["--verbose"] },
    }],
  };
}

function seedPools(t, hostIds) {
  const pool = configuredPool(hostIds);
  writeFileSync(poolsFile, `${JSON.stringify({ version: 1, pools: [pool] }, null, 2)}\n`);
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  return pool;
}

test("GET with no pool file retains standalone hosts and adds an empty pools list", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.pools, []);
  assert.equal(body.hosts[0].id, "local");
  assert.ok(!JSON.stringify(body).includes("tokenHash"));
});

test("PUT replaces the complete pool registry and GET returns its project metadata", async (t) => {
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  const { host } = await (await send("POST", { label: "Pool worker" })).json();
  const pool = configuredPool(["local", host.id]);
  const response = await send("PUT", { pools: [pool] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await get()).pools, [pool]);
  assert.deepEqual(JSON.parse(readFileSync(poolsFile, "utf8")), { version: 1, pools: [pool] });

  const { host: unlisted } = await (await send("POST", { label: "Not a member" })).json();
  assert.ok(!(await get()).pools[0].members.some((member) => member.hostId === unlisted.id));
  assert.equal((await send("PATCH", { id: host.id, label: "Renamed worker" })).status, 200);
  assert.deepEqual((await get()).pools, [pool], "standalone changes do not change explicit membership");

  const replacement = { ...pool, id: "replacement", label: "Replacement", enabled: false, members: [] };
  assert.equal((await send("PUT", { pools: [replacement] })).status, 200);
  assert.deepEqual((await get()).pools, [replacement]);
  assert.equal((await send("PUT", { pools: [] })).status, 200);
  assert.deepEqual((await get()).pools, []);
  assert.deepEqual(JSON.parse(readFileSync(poolsFile, "utf8")), { version: 1, pools: [] });
});

test("PUT tells hosts subscribers, so open hosts streams get the new pools; a refused PUT tells nobody", async (t) => {
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  const frames = [];
  t.after(hub.onHostsChange(() => frames.push(hub.hostsSnapshot().pools)));
  const pool = configuredPool();
  assert.equal((await send("PUT", { pools: [pool] })).status, 200);
  assert.deepEqual(frames, [[pool]]);
  assert.equal((await send("PUT", { pools: [{ ...pool, members: "broken" }] })).status, 400);
  assert.equal(frames.length, 1);
});

test("PUT rejects malformed and ambiguous bodies without changing existing pool bytes", async (t) => {
  const pool = seedPools(t);
  const original = readFileSync(poolsFile, "utf8");
  for (const body of [
    null, [], {}, { pools: null }, { pools: {} },
    ...["id", "label", "allowAgentStart", "hosts", "status", "linkProtocol", "capacity", "unexpected"]
      .map((key) => ({ pools: [pool], [key]: key === "allowAgentStart" ? true : "forged" })),
  ]) {
    assert.equal((await send("PUT", body)).status, 400, JSON.stringify(body));
    assert.equal(readFileSync(poolsFile, "utf8"), original);
  }
  assert.equal((await route.PUT(new Request(BASE, { method: "PUT", body: "{broken" }))).status, 400);
  assert.equal(readFileSync(poolsFile, "utf8"), original);
});

test("PUT rejects invalid pool domain data without replacing the last valid configuration", async (t) => {
  const pool = seedPools(t);
  const original = readFileSync(poolsFile, "utf8");
  for (const pools of [
    [{ ...pool, id: "../escape" }],
    [pool, pool],
    [{ ...pool, enabled: "yes" }],
    [{ ...pool, members: [pool.members[0], pool.members[0]] }],
    [{ ...pool, members: [{ ...pool.members[0], projectsRoot: "relative" }] }],
    [{ ...pool, members: [{ ...pool.members[0], provisioned: "yes" }] }],
    [{ ...pool, projects: [{ ...pool.projects[0], origin: "https://user:secret@example.com/app.git" }] }],
    [{ ...pool, projects: [{ ...pool.projects[0], clonePaths: { local: "relative" } }] }],
    [{ ...pool, projects: [{ ...pool.projects[0], launchConfig: { extraArgs: ["--cwd"] } }] }],
  ]) {
    assert.equal((await send("PUT", { pools })).status, 400, JSON.stringify(pools));
    assert.equal(readFileSync(poolsFile, "utf8"), original);
  }
});

test("PUT accepts only known members but retains clone paths after a member is removed", async (t) => {
  const pool = seedPools(t);
  const original = readFileSync(poolsFile, "utf8");
  const unknown = configuredPool(["never-linked"]);
  assert.equal((await send("PUT", { pools: [unknown] })).status, 400);
  assert.equal(readFileSync(poolsFile, "utf8"), original);

  const { host } = await (await send("POST", { label: "Former member" })).json();
  const withWorker = configuredPool([host.id]);
  assert.equal((await send("PUT", { pools: [withWorker] })).status, 200);
  assert.equal((await route.DELETE(new Request(`${BASE}?id=${host.id}`, { method: "DELETE" }))).status, 200);
  const beforeRejected = readFileSync(poolsFile, "utf8");
  assert.equal((await send("PUT", { pools: [withWorker] })).status, 400, "a revoked host is not a known member");
  assert.equal(readFileSync(poolsFile, "utf8"), beforeRejected);
  const removed = { ...withWorker, members: [] };
  assert.equal((await send("PUT", { pools: [removed] })).status, 200);
  assert.deepEqual((await get()).pools[0].projects[0].clonePaths, { [host.id]: "/srv/projects/app" });
  assert.equal((await send("PUT", { pools: [pool] })).status, 200, "the reserved local daemon remains an explicit valid member");
});

/** The hosts whose open broker requests one PUT of `pools` cut off. */
async function abortedByPut(pools) {
  abortedBrokerHosts.length = 0;
  const response = await send("PUT", { pools });
  assert.equal(response.status, 200, await response.clone().text());
  return [...abortedBrokerHosts];
}

async function clusterHosts(t, ...labels) {
  const hosts = [];
  for (const label of labels) hosts.push((await (await send("POST", { label })).json()).host);
  seedPools(t, hosts.map((host) => host.id));
  return hosts;
}

test("a PUT cuts off a member's broker requests only when it stops sharing", async (t) => {
  const [off, on, spare] = await clusterHosts(t, "off", "on", "spare");
  assert.equal((await send("PATCH", { id: on.id, shareCredentials: true })).status, 200);
  const cluster = (...hosts) => configuredPool(hosts.map((host) => host.id));

  assert.deepEqual(await abortedByPut([cluster(off, on)]), [spare.id], "a member with its own flag off left");
  assert.deepEqual(await abortedByPut([cluster(off, on)]), [], "membership unchanged");
  assert.deepEqual(await abortedByPut([cluster(off, on, spare)]), [], "a host added to the first pool");
  assert.deepEqual(await abortedByPut([cluster(off, spare)]), [], "the member that left still shares by its own flag");
  assert.deepEqual(await abortedByPut([cluster(spare)]), [off.id], "exactly once, for the member whose flag is off");
});

test("a PUT that puts another pool first cuts off each former member whose own flag is off", async (t) => {
  const [off, on, spare] = await clusterHosts(t, "off", "on", "spare");
  assert.equal((await send("PATCH", { id: on.id, shareCredentials: true })).status, 200);
  const front = { id: "front", label: "Front", enabled: true, members: [], projects: [] };
  assert.deepEqual((await abortedByPut([front, configuredPool([off.id, on.id, spare.id])])).sort(), [off.id, spare.id].sort());
});

test("GET and PUT fail closed for damaged existing pool registries without overwriting them", async (t) => {
  const pool = seedPools(t);
  for (const broken of [
    "{not json", JSON.stringify({ pools: [] }), JSON.stringify({ version: 2, pools: [] }),
    JSON.stringify({ version: 1, pools: [{ ...pool, members: "broken" }] }),
  ]) {
    writeFileSync(poolsFile, broken);
    assert.equal((await route.GET()).status, 503);
    assert.equal((await send("PUT", { pools: [] })).status, 503);
    assert.equal(readFileSync(poolsFile, "utf8"), broken);
  }
});

test("unreadable existing pool state returns 503 rather than an empty pool or replacement", async (t) => {
  t.after(() => rmSync(poolsFile, { recursive: true, force: true }));
  mkdirSync(poolsFile);
  const sentinel = join(poolsFile, "keep");
  writeFileSync(sentinel, "untouched");
  assert.equal((await route.GET()).status, 503);
  assert.equal((await send("PUT", { pools: [] })).status, 503);
  assert.equal(readFileSync(sentinel, "utf8"), "untouched");
});

test("a real persistence permission failure is 503, not invalid submission 400", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
  const pool = seedPools(t);
  const original = readFileSync(poolsFile, "utf8");
  const directory = join(agentDir, "omp-web");
  chmodSync(directory, 0o500);
  try {
    assert.equal((await route.GET()).status, 200, "the existing registry remains readable");
    assert.equal((await send("PUT", { pools: [{ ...pool, label: "Changed" }] })).status, 503);
    assert.equal(readFileSync(poolsFile, "utf8"), original);
  } finally {
    chmodSync(directory, 0o700);
  }
});

test("PUT cannot configure pools against an unreadable host registry", async (t) => {
  const pool = seedPools(t);
  const originalPools = readFileSync(poolsFile, "utf8");
  const originalHosts = readFileSync(hostsFile, "utf8");
  writeFileSync(hostsFile, "{broken");
  try {
    assert.equal((await send("PUT", { pools: [pool] })).status, 503);
    assert.equal(readFileSync(poolsFile, "utf8"), originalPools);
    assert.equal(readFileSync(hostsFile, "utf8"), "{broken");
  } finally {
    writeFileSync(hostsFile, originalHosts);
  }
});

test("caller telemetry cannot make offline or refused-version members eligible; real capacity controls selection", async (t) => {
  const credentials = [];
  for (const label of ["Offline", "Old protocol", "Ready"]) {
    credentials.push(await (await send("POST", { label })).json());
  }
  const [offline, old, ready] = credentials;
  const readyLink = new LinkDriver(ready.host.id, ready.token);
  t.after(() => {
    hub.closeHostLink(old.host.id);
    hub.closeHostLink(ready.host.id);
  });
  const { socket: refused } = upgradeSocket(old.token);
  refused.frame(`${JSON.stringify({ type: "hello", v: 9 })}\n`);
  assert.equal(refused.closed?.code, 4426, "a daemon below the minimum link protocol is refused");
  await readyLink.dial();
  const pool = seedPools(t, credentials.map(({ host }) => host.id));
  const original = readFileSync(poolsFile, "utf8");
  const sample = {
    effectiveCpus: 4, load1: 0.5, busyFraction: 0.1, stealFraction: 0.05,
    availableMemoryBytes: 8 * 1024 ** 3, activeSessions: 1,
  };
  const telemetry = { status: "online", linkProtocol: LINK_PROTOCOL_VERSION, capacity: { sample, receivedAt: performance.now() } };
  for (const key of Object.keys(telemetry)) {
    for (const forged of [
      { ...pool, [key]: telemetry[key] },
      { ...pool, members: pool.members.map((member) => ({ ...member, [key]: telemetry[key] })) },
    ]) {
      assert.equal((await send("PUT", { pools: [forged] })).status, 400, `caller ${key} is not configuration`);
      assert.equal(readFileSync(poolsFile, "utf8"), original);
    }
  }
  assert.equal((await send("PUT", { pools: [pool] })).status, 200);
  const choose = async () => {
    const registered = (await get()).pools[0];
    const snapshots = new Map(registered.members.map(({ hostId }) => [hostId, {
      status: hub.getHost(hostId).status(),
      linkProtocol: hub.getHostLinkProtocol(hostId),
      configCurrent: true,
      capacity: hub.getHostCapacity(hostId),
    }]));
    return selectPoolHost(registered, snapshots, new Map(), performance.now());
  };
  assert.equal(hub.getHostCapacity(old.host.id), null);
  assert.equal(hub.getHost(offline.host.id).status(), "offline");
  assert.equal(await choose(), null, "offline and refused-version links and a link without a report are not ready");
  await readyLink.post({ type: "capacity", sample: { ...sample, availableMemoryBytes: 3 * 1024 ** 3 - 1 } });
  assert.equal(await choose(), null, "actual insufficient memory cannot be forged by configuration");
  await readyLink.post({ type: "capacity", sample });
  assert.deepEqual(hub.getHostCapacity(ready.host.id).sample, sample);
  assert.equal(await choose(), ready.host.id);
  const draining = { ...pool, members: pool.members.map((member) => ({ ...member, draining: true })) };
  assert.equal((await send("PUT", { pools: [draining] })).status, 200);
  assert.equal(await choose(), null, "administrative draining excludes even a genuinely ready host");
  const unprovisioned = { ...pool, members: pool.members.map((member) => ({ ...member, provisioned: false })) };
  assert.equal((await send("PUT", { pools: [unprovisioned] })).status, 200);
  assert.equal(await choose(), null, "administrative provisioning is distinct from live readiness");
});

test("PATCH { poolId, label } renames only that pool and keeps the rest of its configuration", async (t) => {
  const pool = seedPools(t, ["local"]);
  const response = await send("PATCH", { poolId: pool.id, label: "  Proxmox  " });
  assert.equal(response.status, 200);
  assert.deepEqual((await get()).pools, [{ ...pool, label: "Proxmox" }]);
  assert.equal((await send("PATCH", { poolId: pool.id, label: "   " })).status, 400);
  assert.equal((await send("PATCH", { poolId: "missing", label: "x" })).status, 404);
  assert.equal((await send("PATCH", { poolId: pool.id, label: "x", enabled: false })).status, 400);
  assert.equal((await get()).pools[0].label, "Proxmox");
});
