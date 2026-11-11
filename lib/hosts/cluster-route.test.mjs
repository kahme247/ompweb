import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-cluster-route-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

// Spies: abortBrokerRequests is recorded instead of run; savePools is counted and still writes.
const realBroker = await import("../omp/auth-broker.ts");
const aborted = [];
mock.module("../omp/auth-broker.ts", () => ({ ...realBroker, abortBrokerRequests: (id) => aborted.push(id) }));
const realPools = await import("./pools.ts");
const realSavePools = realPools.savePools;
let saves = 0;
mock.module("./pools.ts", () => ({ ...realPools, savePools: (pools) => { saves++; realSavePools(pools); } }));

const hub = await import("./hub.ts");
const { linkHost, linkLocalHost, listedSession } = await import("./link-driver.test-helper.mjs");
const { createHost, updateHost } = await import("./registry.ts");
const route = await import("../../app/api/hosts/[id]/cluster/route.ts");

const poolsFile = join(agentDir, "omp-web", "pools.json");
const APP = "https://github.com/a/app.git";
const TOOL = "https://github.com/a/tool.git";
const LIB = "https://github.com/a/lib.git";
const ADDED = "2026-01-01T00:00:00.000Z";
const SESSION = "11111111-2222-4333-8444-555555555555";

const context = (id) => ({ params: Promise.resolve({ id }) });
const put = (id, body = { projectsRoot: "/srv/box" }, headers = { "content-type": "application/json" }) =>
  route.PUT(new Request(`http://main.test/api/hosts/${id}/cluster`, { method: "PUT", headers, body: JSON.stringify(body) }), context(id));
const del = (id) => route.DELETE(new Request(`http://main.test/api/hosts/${id}/cluster`, { method: "DELETE" }), context(id));
const savedPools = () => JSON.parse(readFileSync(poolsFile, "utf8")).pools;
const entry = (path, extra = {}) => ({ path, addedAt: ADDED, hidden: false, ...extra });
const member = (hostId, projectsRoot) => ({ hostId, projectsRoot, provisioned: true, draining: false });
const link = (id) => globalThis.__ompHostHub.links.get(id);

/** The link protocol a host reports; this branch's hub only accepts hellos up to 8. */
const speak = (driver, version) => { link(driver.id).hostVersion = version; };

/** A fake daemon: its registry, sessions, home and Git origins; returns the paths each gitOrigins call was sent. */
function serve(driver, { projects = [], sessions = [], home = "/home/me", origins = {}, gitOrigins } = {}) {
  const calls = [];
  driver.serve({
    listProjects: () => projects,
    listSessions: () => sessions,
    home: () => ({ ok: true, value: { home } }),
    gitOrigins: gitOrigins ?? (({ paths }) => {
      calls.push(paths);
      return { ok: true, value: { origins: paths.map((path) => ({ path, origin: origins[path] ?? null, mainCheckout: path in origins })) } };
    }),
  });
  return calls;
}

/** This machine's daemon and one linked host, both ready to join. */
async function linkBoth(t, box = {}) {
  const local = await linkLocalHost({ workspaceOps: ["home", "gitOrigins"] });
  const remote = await linkHost("Box", { hello: { workspaceOps: ["home", "gitOrigins"] } });
  speak(local, 9);
  speak(remote, 9);
  t.after(() => {
    remote.drop();
    local.drop();
    hub.closeHostLink("local");
    globalThis.__ompHostHub.links.delete("local");
    rmSync(poolsFile, { force: true });
  });
  return { local, box: remote, boxCalls: serve(remote, { home: "/home/box", ...box }) };
}

function seed(pools) {
  mkdirSync(join(agentDir, "omp-web"), { recursive: true });
  writeFileSync(poolsFile, `${JSON.stringify({ version: 1, pools }, null, 2)}\n`);
  return readFileSync(poolsFile);
}

const spare = {
  id: "spare", label: "Spare", enabled: true, members: [member("local", "/srv/spare")],
  projects: [{ id: "kept", name: "kept", origin: "https://github.com/a/kept.git", clonePaths: { local: "/srv/spare/kept" }, addedAt: ADDED, hidden: false }],
};
const workers = { id: "workers", label: "Workers", enabled: false, members: [], projects: [] };

test("the first join creates the cluster: this machine first, then the host, with both hosts' Git projects", async (t) => {
  const { local, box, boxCalls } = await linkBoth(t, {
    projects: [entry("/home/box/app"), entry("/home/box/lib")],
    origins: { "/home/box/app": APP, "/home/box/lib": LIB },
  });
  const localCalls = serve(local, {
    projects: [entry("/home/me/app")],
    sessions: [listedSession(SESSION, "/home/me/tool")],
    origins: { "/home/me/app": APP, "/home/me/tool": TOOL },
  });
  saves = 0;
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { pools } = await response.json();
  assert.equal(saves, 1);
  assert.deepEqual(savedPools(), pools);
  assert.equal(pools.length, 1);
  const [cluster] = pools;
  assert.deepEqual([cluster.id, cluster.label, cluster.enabled], ["cluster", "Cluster", true]);
  assert.deepEqual(cluster.members, [member("local", "/home/me/ompweb-cluster"), member(box.id, "/srv/box")]);
  const id = (origin) => cluster.projects.find((project) => project.origin === origin).id;
  assert.deepEqual(Object.fromEntries(cluster.projects.map((project) => [project.origin, project.clonePaths])), {
    [APP]: { local: "/home/me/app", [box.id]: "/home/box/app" },
    [TOOL]: { local: "/home/me/tool", [box.id]: `/srv/box/${id(TOOL)}` },
    [LIB]: { [box.id]: "/home/box/lib", local: `/home/me/ompweb-cluster/${id(LIB)}` },
  });
  // The registry first, then the project roots of sessions it does not list.
  assert.deepEqual(localCalls, [["/home/me/app", "/home/me/tool"]]);
  assert.deepEqual(boxCalls, [["/home/box/app", "/home/box/lib"]]);
});

test("a hidden registry project of the host becomes a hidden cluster project", async (t) => {
  const { local, box } = await linkBoth(t, {
    projects: [entry("/home/box/app", { hidden: true, alias: "Old app", sortOrder: 3 })],
    origins: { "/home/box/app": APP },
  });
  serve(local);
  const response = await put(box.id);
  assert.equal(response.status, 200);
  const [project] = (await response.json()).pools[0].projects;
  assert.deepEqual([project.origin, project.hidden, project.alias, project.sortOrder, project.clonePaths[box.id]], [APP, true, "Old app", 3, "/home/box/app"]);
});

test("a host's paths go to gitOrigins 500 at a time; a path too long to send stays pinned", async (t) => {
  const long = `/home/box/${"x".repeat(4100)}`;
  const paths = Array.from({ length: 501 }, (_, i) => `/home/box/p${i}`);
  const { local, box, boxCalls } = await linkBoth(t, {
    projects: [...paths.map((path) => entry(path)), entry(long)],
    origins: { [paths[500]]: APP, [long]: LIB },
  });
  serve(local);
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.deepEqual(boxCalls, [paths.slice(0, 500), paths.slice(500)]);
  const { pools } = await response.json();
  assert.deepEqual(pools[0].projects.map((project) => [project.origin, project.clonePaths[box.id]]), [[APP, paths[500]]]);
});

test("a pool without this machine gets it on the next join; enabled and the second pool stay as they were", async (t) => {
  seed([workers, spare]);
  const { local, box } = await linkBoth(t);
  serve(local, { home: "/Users/me" });
  saves = 0;
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.equal(saves, 1);
  const pools = savedPools();
  assert.deepEqual(pools, (await response.json()).pools);
  assert.deepEqual(pools[0], { ...workers, members: [member("local", "/Users/me/ompweb-cluster"), member(box.id, "/srv/box")] });
  assert.deepEqual(pools[1], spare);
});

test("a cluster that already has this machine adds only the host", async (t) => {
  seed([{ ...workers, members: [member("local", "/srv/local")] }]);
  const { local, box } = await linkBoth(t);
  const localCalls = serve(local, { projects: [entry("/home/me/app")], origins: { "/home/me/app": APP } });
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).pools[0].members, [member("local", "/srv/local"), member(box.id, "/srv/box")]);
  assert.deepEqual(localCalls, [], "this machine's projects were not looked at");
});

test("every refused join answers its status and code and leaves pools.json byte-identical", async (t) => {
  const bytes = seed([workers, spare]);
  const { local, box } = await linkBoth(t);
  serve(local);
  saves = 0;
  const refused = async (response, status, code) => {
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.deepEqual(readFileSync(poolsFile), bytes);
    assert.equal(saves, 0);
  };
  await refused(await put(box.id, undefined, { "content-type": "application/json", origin: "https://other.test" }), 403, "cross_origin_forbidden");
  await refused(await put(box.id, undefined, {}), 415, "unsupported_media_type");
  await refused(await put("missing"), 404, "unknown_host");
  await refused(await put("local"), 404, "unknown_host");
  for (const body of [{}, { projectsRoot: 5 }, { projectsRoot: "srv/box" }, { projectsRoot: "/" }, { projectsRoot: "/srv/../box" }, { projectsRoot: "/srv/box/" },
    { projectsRoot: "/srv/box", extra: true }, ["/srv/box"]]) {
    await refused(await put(box.id, body), 400, "invalid_projects_root");
  }

  speak(box, 8);
  await refused(await put(box.id), 409, "host_upgrade_required");
  speak(box, 9);
  link(box.id).workspaceOps.delete("gitOrigins");
  await refused(await put(box.id), 409, "host_upgrade_required");
  link(box.id).workspaceOps.add("gitOrigins");

  speak(local, 8);
  await refused(await put(box.id), 409, "host_restart_required");
  speak(local, 9);
  link("local").workspaceOps.delete("gitOrigins");
  await refused(await put(box.id), 409, "host_restart_required");
  link("local").workspaceOps.add("gitOrigins");

  // A dropped socket keeps its status through the offline grace; a closed link is offline at once.
  hub.closeHostLink(box.id);
  await refused(await put(box.id), 409, "host_offline");
  const other = await linkHost("Other", { hello: { workspaceOps: ["home", "gitOrigins"] } });
  t.after(() => other.drop());
  speak(other, 9);
  hub.closeHostLink("local");
  await refused(await put(other.id), 409, "host_offline");

  writeFileSync(poolsFile, "{");
  const damaged = readFileSync(poolsFile);
  const response = await put(box.id);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "pool_storage_unavailable");
  assert.deepEqual(readFileSync(poolsFile), damaged);
});

test("a host that is already a member is refused", async (t) => {
  const { local, box } = await linkBoth(t);
  serve(local);
  const bytes = seed([{ ...workers, members: [member("local", "/srv/local"), member(box.id, "/srv/box")] }]);
  saves = 0;
  const response = await put(box.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "already_member");
  assert.deepEqual(readFileSync(poolsFile), bytes);
  assert.equal(saves, 0);
});

test("gitOrigins failing on the host saves nothing, although this machine was computed first", async (t) => {
  const bytes = seed([workers, spare]);
  const { local, box } = await linkBoth(t, {
    projects: [entry("/home/box/app")],
    gitOrigins: () => ({ ok: false, status: 503, code: "git_busy", error: "Git is busy" }),
  });
  const localCalls = serve(local, { projects: [entry("/home/me/app")], origins: { "/home/me/app": APP } });
  saves = 0;
  const response = await put(box.id);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "git_busy");
  assert.deepEqual(localCalls, [["/home/me/app"]]);
  assert.deepEqual(readFileSync(poolsFile), bytes);
  assert.equal(saves, 0);
});

test("leaving removes the member and aborts the host's broker requests only when it does not share credentials itself", async (t) => {
  t.after(() => rmSync(poolsFile, { force: true }));
  const quiet = createHost("Quiet").host;
  const sharing = createHost("Sharing").host;
  updateHost(sharing.id, { shareCredentials: true });
  seed([{ ...workers, members: [member("local", "/srv/local"), member(quiet.id, "/srv/quiet"), member(sharing.id, "/srv/sharing")] }, spare]);
  aborted.length = 0;
  saves = 0;
  const left = await del(quiet.id);
  assert.equal(left.status, 200);
  assert.equal(left.headers.get("cache-control"), "no-store");
  const { pools } = await left.json();
  assert.deepEqual(pools, savedPools());
  assert.deepEqual(pools[0].members.map((m) => m.hostId), ["local", sharing.id]);
  assert.deepEqual(pools[1], spare);
  assert.deepEqual(aborted, [quiet.id]);
  assert.equal(saves, 1);

  assert.equal((await del(sharing.id)).status, 200);
  assert.deepEqual(aborted, [quiet.id], "a host that shares credentials itself keeps its broker requests");
  assert.equal(saves, 2);

  const bytes = readFileSync(poolsFile);
  for (const [id, code] of [["local", "master_cannot_leave"], [quiet.id, "not_member"]]) {
    const response = await del(id);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, code);
  }
  assert.deepEqual(readFileSync(poolsFile), bytes);
  assert.equal(saves, 2);
  assert.deepEqual(aborted, [quiet.id]);
  const crossOrigin = await route.DELETE(new Request(`http://main.test/api/hosts/${sharing.id}/cluster`, { method: "DELETE", headers: { origin: "https://other.test" } }), context(sharing.id));
  assert.equal(crossOrigin.status, 403);
});

test("the hosts channel frame after a join carries the new pools; it has none while pools.json is unreadable", async (t) => {
  const { local, box } = await linkBoth(t);
  serve(local);
  const frames = [];
  t.after(hub.onHostsChange(() => frames.push(hub.hostsSnapshot())));
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.deepEqual(frames.at(-1).pools, (await response.json()).pools);
  writeFileSync(poolsFile, "{");
  assert.equal("pools" in hub.hostsSnapshot(), false);
});
