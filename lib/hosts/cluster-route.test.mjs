import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// The master's configuration version: the real one runs `omp plugin list` and reads the home directory.
const VERSION = "a".repeat(64);
const realConfig = await import("./cluster-config-server.ts");
mock.module("./cluster-config-server.ts", () => ({ ...realConfig, clusterConfigVersion: async () => VERSION }));

const hub = await import("./hub.ts");
const { LinkDriver, linkHost, linkLocalHost, listedSession } = await import("./link-driver.test-helper.mjs");
const { createHost, rotateLocalHostToken, updateHost } = await import("./registry.ts");
const route = await import("../../app/api/hosts/[id]/cluster/route.ts");
const index = await import("./session-index.ts");

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

/** Sets what the hub records from a host's hello, which the join gate reads: its link protocol (the hub accepts hellos
 * up to LINK_PROTOCOL_VERSION; these links say v6) and its omp version. */
const speak = (driver, version, omp = "omp/15.13.1") => Object.assign(link(driver.id), { hostVersion: version, ompVersion: omp });

/** gitOrigins' answer: a main checkout with its origin for each path in `origins`, nothing for the rest. */
const answer = (origins, paths) => ({ ok: true, value: { origins: paths.map((path) => ({ path, origin: origins[path] ?? null, mainCheckout: path in origins })) } });

/** A fake daemon: its registry, sessions, home and Git origins; returns the paths each gitOrigins call was sent. Its
 * `clusterConfig` calls go to `driver.configCalls`; `clusterConfig` replaces the answer. */
function serve(driver, { projects = [], sessions = [], home = "/home/me", origins = {}, gitOrigins, clusterConfig } = {}) {
  const calls = [];
  driver.configCalls = [];
  driver.serve({
    listProjects: () => projects,
    listSessions: () => sessions,
    home: () => ({ ok: true, value: { home } }),
    gitOrigins: gitOrigins ?? (({ paths }) => {
      calls.push(paths);
      return answer(origins, paths);
    }),
    clusterConfig: (args) => {
      driver.configCalls.push(args);
      return clusterConfig ? clusterConfig(args) : { state: { version: VERSION, files: "current", plugins: "pending", error: null, missingCommands: [] }, owned: true };
    },
  });
  return calls;
}

/** A gitOrigins that answers only after `release()`; `called` settles when the join is waiting on it. */
function gated(origins = {}) {
  const called = Promise.withResolvers();
  const released = Promise.withResolvers();
  return {
    called: called.promise,
    release: released.resolve,
    gitOrigins: async ({ paths }) => {
      called.resolve();
      await released.promise;
      return answer(origins, paths);
    },
  };
}

/** This machine's daemon and one linked host, both ready to join. */
async function linkBoth(t, box = {}) {
  const local = await linkLocalHost({ workspaceOps: ["home", "gitOrigins"] });
  const remote = await linkHost("Box", { hello: { workspaceOps: ["home", "gitOrigins"] } });
  speak(local, 10);
  speak(remote, 10);
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
  // This machine's paths in its own form: the route resolves its session paths here (D:\home\me\tool on Windows).
  const home = resolve("/home/me");
  const [app, tool, clusterRoot] = ["app", "tool", "ompweb-cluster"].map((name) => join(home, name));
  const { local, box, boxCalls } = await linkBoth(t, {
    projects: [entry("/home/box/app"), entry("/home/box/lib")],
    origins: { "/home/box/app": APP, "/home/box/lib": LIB },
  });
  const localCalls = serve(local, {
    home,
    projects: [entry(app)],
    sessions: [listedSession(SESSION, tool)],
    origins: { [app]: APP, [tool]: TOOL },
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
  assert.deepEqual(cluster.members, [member("local", clusterRoot), member(box.id, "/srv/box")]);
  const id = (origin) => cluster.projects.find((project) => project.origin === origin).id;
  assert.deepEqual(Object.fromEntries(cluster.projects.map((project) => [project.origin, project.clonePaths])), {
    [APP]: { local: app, [box.id]: "/home/box/app" },
    [TOOL]: { local: tool, [box.id]: `/srv/box/${id(TOOL)}` },
    [LIB]: { [box.id]: "/home/box/lib", local: join(clusterRoot, id(LIB)) },
  });
  // The registry first, then the project roots of sessions it does not list.
  assert.deepEqual(localCalls, [[app, tool]]);
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

test("a visible checkout bound to a hidden cluster project un-hides it, so the project and its sessions stay listed", async (t) => {
  const listed = "11111111-2222-4333-8444-666666666666";
  const { local, box } = await linkBoth(t, {
    projects: [entry("/home/box/app")],
    sessions: [listedSession(listed, "/home/box/app")],
    origins: { "/home/box/app": APP },
  });
  serve(local, { projects: [entry("/home/me/app", { hidden: true })], origins: { "/home/me/app": APP } });
  const response = await put(box.id);
  assert.equal(response.status, 200);
  const [project] = (await response.json()).pools[0].projects;
  assert.deepEqual([project.hidden, project.clonePaths], [false, { local: "/home/me/app", [box.id]: "/home/box/app" }]);
  const key = `pool:cluster:${project.id}`;
  const projects = await index.listProjectsAllHosts();
  assert.ok(projects.some((listedProject) => listedProject.projectKey === key), "the cluster project is listed");
  assert.equal(projects.some((listedProject) => listedProject.hostId === box.id && listedProject.path === "/home/box/app"), false);
  assert.equal((await index.listSessionsAllHosts()).find((session) => session.id === listed)?.projectKey, key);
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
    const body = await response.json();
    assert.equal(body.code, code);
    assert.deepEqual(readFileSync(poolsFile), bytes);
    assert.equal(saves, 0);
    return body;
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
  // Protocol 10: a member applies the master's configuration.
  speak(box, 9);
  await refused(await put(box.id), 409, "host_upgrade_required");
  speak(box, 10);
  link(box.id).workspaceOps.delete("gitOrigins");
  await refused(await put(box.id), 409, "host_upgrade_required");
  link(box.id).workspaceOps.add("gitOrigins");

  speak(local, 8);
  await refused(await put(box.id), 409, "host_restart_required");
  speak(local, 9);
  await refused(await put(box.id), 409, "host_restart_required");
  speak(local, 10);
  link("local").workspaceOps.delete("gitOrigins");
  await refused(await put(box.id), 409, "host_restart_required");
  link("local").workspaceOps.add("gitOrigins");

  // Members always share credentials: an omp too old for that, or an unknown one, asks to update omp on that host.
  for (const omp of ["omp/15.13.0", "omp/next"]) {
    speak(box, 10, omp);
    assert.equal((await refused(await put(box.id), 409, "host_omp_too_old")).error, "Update omp on Box to 15.13.1 or newer first");
    speak(box, 10);
    speak(local, 10, omp);
    assert.equal((await refused(await put(box.id), 409, "host_omp_too_old")).error, "Update omp on This machine to 15.13.1 or newer first");
    speak(local, 10);
  }
  // An outdated daemon is named first: updating omp alone would not let it join.
  speak(box, 9, "omp/15.13.0");
  await refused(await put(box.id), 409, "host_upgrade_required");
  speak(box, 10);

  // A dropped socket keeps its status through the offline grace; a closed link is offline at once.
  hub.closeHostLink(box.id);
  await refused(await put(box.id), 409, "host_offline");
  const other = await linkHost("Other", { hello: { workspaceOps: ["home", "gitOrigins"] } });
  t.after(() => other.drop());
  speak(other, 10);
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
  const body = await response.json();
  assert.equal(body.code, "already_member");
  assert.equal(body.error.includes(box.id), false, "the message does not name the host by its id");
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

test("a host that leaves while another joins stays gone", async (t) => {
  const leaving = createHost("Leaving").host;
  seed([{ ...workers, members: [member("local", "/srv/local"), member(leaving.id, "/srv/leaving")] }]);
  const gate = gated();
  const { local, box } = await linkBoth(t, { projects: [entry("/home/box/app")], gitOrigins: gate.gitOrigins });
  serve(local);
  const joining = put(box.id);
  await gate.called;
  assert.equal((await del(leaving.id)).status, 200);
  gate.release();
  assert.equal((await joining).status, 200);
  assert.deepEqual(savedPools()[0].members, [member("local", "/srv/local"), member(box.id, "/srv/box")]);
});

test("two joins of one host at once: one is saved, the other is already_member", async (t) => {
  const { local, box } = await linkBoth(t);
  const localCalls = serve(local, { projects: [entry("/home/me/app")], origins: { "/home/me/app": APP } });
  saves = 0;
  const responses = await Promise.all([put(box.id), put(box.id)]);
  assert.equal(localCalls.length, 2, "both joins read pools.json before either saved");
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await responses.find((response) => response.status === 409).json()).code, "already_member");
  assert.deepEqual(savedPools(), (await responses.find((response) => response.status === 200).json()).pools);
  assert.equal(saves, 1);
});

test("a pool project registered while a join waits is kept", async (t) => {
  seed([{ ...workers, members: [member("local", "/srv/local")] }]);
  const gate = gated({ "/home/box/app": APP });
  const { local, box } = await linkBoth(t, { projects: [entry("/home/box/app")], gitOrigins: gate.gitOrigins });
  serve(local);
  const joining = put(box.id);
  await gate.called;
  const added = { id: "added", name: "lib", origin: LIB, clonePaths: { local: "/srv/local/lib" }, addedAt: ADDED, hidden: false };
  seed([{ ...workers, members: [member("local", "/srv/local")], projects: [added] }]);
  gate.release();
  assert.equal((await joining).status, 200);
  const [cluster] = savedPools();
  assert.deepEqual(cluster.projects.find((project) => project.id === "added"), { ...added, clonePaths: { local: "/srv/local/lib", [box.id]: "/srv/box/added" } });
  assert.ok(cluster.projects.some((project) => project.origin === APP && project.clonePaths[box.id] === "/home/box/app"));
});

test("this machine removed from the cluster while a join waits: 409 cluster_changed, the edit stays", async (t) => {
  seed([{ ...workers, members: [member("local", "/srv/local")] }]);
  const gate = gated();
  const { local, box } = await linkBoth(t, { projects: [entry("/home/box/app")], gitOrigins: gate.gitOrigins });
  serve(local);
  saves = 0;
  const joining = put(box.id);
  await gate.called;
  const edited = seed([workers, spare]);
  gate.release();
  const response = await joining;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "cluster_changed");
  assert.deepEqual(readFileSync(poolsFile), edited);
  assert.equal(saves, 0);
});

test("a checkout another pool binds stays with that pool; the join still succeeds", async (t) => {
  const { local, box } = await linkBoth(t, {
    projects: [entry("/home/box/app"), entry("/home/box/lib")],
    origins: { "/home/box/app": APP, "/home/box/lib": LIB },
  });
  serve(local);
  const other = {
    id: "other", label: "Other", enabled: true, members: [member(box.id, "/srv/other")],
    projects: [{ id: "bound", name: "app", origin: APP, clonePaths: { [box.id]: "/home/box/app" }, addedAt: ADDED, hidden: false }],
  };
  seed([{ ...workers, members: [member("local", "/srv/local")] }, other]);
  const response = await put(box.id);
  assert.equal(response.status, 200);
  const pools = savedPools();
  assert.deepEqual(pools[0].projects.map((project) => [project.origin, project.clonePaths[box.id]]), [[LIB, "/home/box/lib"]]);
  assert.deepEqual(pools[1], other);
});

test("a host or this machine without omp is not online: 409 host_offline, nothing saved", async (t) => {
  const ops = ["home", "gitOrigins"];
  const drivers = [await linkLocalHost({ workspaceOps: ops }), await linkHost("No omp", { hello: { ompVersion: null, workspaceOps: ops } }), await linkHost("Box", { hello: { workspaceOps: ops } })];
  const [local, bare, box] = drivers;
  t.after(() => {
    for (const driver of drivers) driver.drop();
    hub.closeHostLink("local");
    rmSync(poolsFile, { force: true });
  });
  for (const driver of drivers) {
    speak(driver, 10);
    serve(driver);
  }
  const bytes = seed([workers]);
  saves = 0;
  const refused = async (id) => {
    const response = await put(id);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "host_offline");
    assert.deepEqual(readFileSync(poolsFile), bytes);
    assert.equal(saves, 0);
  };
  assert.equal(hub.getHost(bare.id).status(), "omp-missing");
  await refused(bare.id);

  // This machine without omp, while it is being added.
  hub.closeHostLink(local.id);
  const bareLocal = new LinkDriver("local", rotateLocalHostToken());
  await bareLocal.dial({ hello: { ompVersion: null, workspaceOps: ops } });
  drivers.push(bareLocal);
  speak(bareLocal, 10);
  serve(bareLocal);
  assert.equal(hub.getHost("local").status(), "omp-missing");
  await refused(box.id);
});

test("of two checkouts of one repository, the one first in the host's project order is bound", async (t) => {
  const { local, box } = await linkBoth(t, {
    // The registry lists the older first; the sidebar shows the newer first.
    projects: [entry("/home/box/old"), entry("/home/box/new", { addedAt: "2026-02-01T00:00:00.000Z" })],
    origins: { "/home/box/old": APP, "/home/box/new": APP },
  });
  serve(local);
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).pools[0].projects.map((project) => [project.origin, project.clonePaths[box.id]]), [[APP, "/home/box/new"]]);
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

// Link protocol 10: the joined host applies the master's configuration; a leaving one puts its own back (spec K6).
const { HostOpError } = await import("./link-protocol.ts");
const leftState = { version: null, files: "none", plugins: "none", error: null, missingCommands: [] };

test("a join sends apply to the joined host only and waits for its answer", async (t) => {
  const { local, box } = await linkBoth(t);
  serve(local);
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.deepEqual(box.configCalls, [{ action: "apply", version: VERSION }]);
  assert.deepEqual(local.configCalls, [], "this machine is the master");
  assert.equal(hub.listHosts().find((row) => row.id === box.id).clusterConfig.version, VERSION, "the answered state is kept before the join answers");
});

test("a join whose apply fails still answers 200 with the member saved", async (t) => {
  const { local, box } = await linkBoth(t, { clusterConfig: () => { throw new HostOpError(409, "cluster_config_failed", "the master answered 500 for the manifest"); } });
  serve(local);
  const response = await put(box.id);
  assert.equal(response.status, 200);
  assert.deepEqual(box.configCalls, [{ action: "apply", version: VERSION }]);
  assert.ok(savedPools()[0].members.some((m) => m.hostId === box.id));
});

test("leaving sends restore once pools.json no longer lists the host", async (t) => {
  const listedAtRestore = [];
  const { local, box } = await linkBoth(t, { clusterConfig: () => {
    listedAtRestore.push(savedPools()[0].members.map((m) => m.hostId));
    return { state: leftState, owned: false };
  } });
  serve(local);
  seed([{ ...workers, members: [member("local", "/srv/local"), member(box.id, "/srv/box")] }]);
  const left = await del(box.id);
  assert.equal(left.status, 200);
  assert.equal("restoreError" in await left.json(), false);
  assert.deepEqual(box.configCalls, [{ action: "restore" }]);
  assert.deepEqual(listedAtRestore, [["local"]]);
});

test("a failing restore still removes the member and answers 200 with restoreError", async (t) => {
  const { local, box } = await linkBoth(t, { clusterConfig: () => { throw new HostOpError(409, "cluster_config_failed", "omp-web/own-config/agent is not readable"); } });
  serve(local);
  seed([{ ...workers, members: [member("local", "/srv/local"), member(box.id, "/srv/box")] }]);
  const left = await del(box.id);
  assert.equal(left.status, 200);
  const body = await left.json();
  assert.equal(body.restoreError, "Box: omp-web/own-config/agent is not readable");
  assert.deepEqual(body.pools[0].members.map((m) => m.hostId), ["local"]);
  assert.deepEqual(savedPools(), body.pools);
});

test("leaving a host whose daemon is below protocol 10 sends no restore and reports no failure: it never applied a configuration", async (t) => {
  const { local, box } = await linkBoth(t);
  serve(local);
  seed([{ ...workers, members: [member("local", "/srv/local"), member(box.id, "/srv/box")] }]);
  speak(box, 9);
  const left = await del(box.id);
  assert.equal(left.status, 200);
  const body = await left.json();
  assert.equal("restoreError" in body, false);
  assert.deepEqual(body.pools[0].members.map((m) => m.hostId), ["local"]);
  assert.deepEqual(box.configCalls, []);
});

const othersState = { version: "b".repeat(64), files: "current", plugins: "current", error: null, missingCommands: [] };

test("a leave whose host still runs a configuration this server does not hold reports it as not put back", async (t) => {
  const { local, box } = await linkBoth(t, { clusterConfig: () => ({ state: othersState, owned: false }) });
  serve(local);
  seed([{ ...workers, members: [member("local", "/srv/local"), member(box.id, "/srv/box")] }]);
  const left = await del(box.id);
  assert.equal(left.status, 200);
  const body = await left.json();
  assert.equal(body.restoreError, "Box still runs a cluster configuration this server cannot put back");
  assert.deepEqual(body.pools[0].members.map((m) => m.hostId), ["local"]);
  assert.deepEqual(box.configCalls, [{ action: "restore" }]);
});

test("a host that runs another server's cluster configuration cannot join; one that runs this server's can", async (t) => {
  const bytes = seed([workers]);
  const { local, box } = await linkBoth(t);
  serve(local);
  saves = 0;
  await box.post({ type: "config_state", state: othersState, owned: false });
  const refused = await put(box.id);
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "Box runs another server's cluster configuration; it must leave that cluster first", code: "host_in_other_cluster" });
  assert.deepEqual(readFileSync(poolsFile), bytes);
  assert.equal(saves, 0);
  assert.deepEqual(box.configCalls, []);
  await box.post({ type: "config_state", state: othersState, owned: true });
  assert.equal((await put(box.id)).status, 200);
});
