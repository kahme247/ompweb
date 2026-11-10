import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkHost, linkLocalHost, until } from "./link-driver.test-helper.mjs";

const hub = await import("./hub.ts");
const index = await import("./session-index.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");

const SHARED = "11111111-2222-4333-8444-555555555555";
const OTHER = "11111111-2222-4333-8444-666666666666";
const defaultTimings = { ...hub.linkTimings };

/** Own agent dir (so only this test's hosts are registered), optionally with one session file on this machine's disk. */
function setup(t, { localSessionId } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-index-"));
  if (localSessionId) {
    const projectDir = join(agentDir, "sessions", "-project");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      { type: "session", version: 3, id: localSessionId, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ];
    writeFileSync(join(projectDir, "2026-01-01_local.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__ompHostLists = undefined;
  invalidateSessionListCache();
  const links = [];
  t.after(() => {
    for (const link of links) hub.closeHostLink(link.id);
    Object.assign(hub.linkTimings, defaultTimings);
    // The hub's held link samples go to this test's agent dir, before it is gone.
    hub.flushLinkSamples();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
  /** Link a host that answers ops from `ops`; a null label links this machine's daemon. */
  return async (label, ops) => {
    const link = label === null ? await linkLocalHost() : await linkHost(label);
    links.push(link);
    link.serve(ops);
    return link;
  };
}

/** A session-list entry as a daemon sends it. */
const entry = (id, extra = {}) => ({
  path: `/remote/sessions/${id}.jsonl`,
  id,
  cwd: "/remote/project",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hi",
  ...extra,
});

test("an id on this machine and a remote host is listed once, as local", async (t) => {
  const link = setup(t);
  await link(null, { listSessions: () => [entry(SHARED)] });
  const remote = await link("Remote", { listSessions: () => [entry(SHARED), entry(OTHER)] });
  const sessions = await index.listSessionsAllHosts();
  assert.deepEqual(sessions.map((s) => [s.id, s.hostId]), [[SHARED, "local"], [OTHER, remote.id]]);
  assert.equal((await index.hostForSessionId(SHARED)).id, "local");
  assert.equal((await index.hostForSessionId(OTHER)).id, remote.id);
});

test("this machine's sessions come from its daemon only, never from the files on disk", async (t) => {
  const link = setup(t, { localSessionId: SHARED });
  assert.deepEqual(await index.listSessionsAllHosts(), [], "no daemon linked: nothing is read here");
  // Unknown is not gone: a 404 would make the client drop the session.
  await assert.rejects(index.hostForSessionId(SHARED), (error) => error.status === 503 && error.code === "host_offline" && error.message === "This machine is offline");

  await link(null, { listSessions: () => [entry(SHARED, { cwd: "/srv/app" })] });
  index.invalidateHostSessionList("local");
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => [s.id, s.hostId, s.path]), [[SHARED, "local", `/remote/sessions/${SHARED}.jsonl`]]);
  const host = await index.hostForSessionId(SHARED);
  assert.equal(host, hub.getHost("local"));
  assert.deepEqual(await index.sessionSpawnTarget(SHARED, host), { sessionFile: `/remote/sessions/${SHARED}.jsonl`, cwd: "/srv/app", recordedCwd: "/srv/app" });
});

test("an id no host lists is gone only once this machine's daemon has answered a list", async (t) => {
  const link = setup(t);
  let failing = true;
  await link(null, {
    listSessions: () => {
      if (failing) throw new Error("sessions dir unreadable");
      return [entry(OTHER)];
    },
  });
  await assert.rejects(index.hostForSessionId(SHARED), (error) => error.status === 503, "linked, but its list never arrived");
  failing = false;
  assert.equal(await index.hostForSessionId(SHARED), null);
  assert.equal(await index.hostForSessionId("not-a-session-id"), null, "a malformed id is never anyone's");
});

test("the hand-driven daemon answers a failed op as ompweb host does", async (t) => {
  const link = setup(t);
  const { ProjectPathError } = await import("../project-registry.ts");
  const { HostOpError } = await import("./link-protocol.ts");
  const thrown = { bad: new ProjectPathError("invalid_path", "Not a directory"), gone: new HostOpError(410, "gone", "Gone"), broken: new Error("disk on fire") };
  const remote = await link("Strict", { validateCwd: ({ path }) => { throw thrown[path]; } });
  const { sessionOps } = hub.getHost(remote.id);
  const failure = async (path) => sessionOps.validateCwd(path).then(() => assert.fail("resolved"), ({ status, code, message }) => ({ status, code, message }));
  // Main prefixes the host's label.
  assert.deepEqual(await failure("bad"), { status: 400, code: "invalid_path", message: "Strict: Not a directory" });
  assert.deepEqual(await failure("gone"), { status: 410, code: "gone", message: "Strict: Gone" });
  assert.deepEqual(await failure("broken"), { status: 500, code: "host_op_failed", message: "Strict: disk on fire" });
});

test("a change on this machine's disk drops its list on the daemon and here", async (t) => {
  const link = setup(t);
  let listed = [entry(SHARED)];
  const invalidated = [];
  await link(null, { listSessions: () => listed, invalidateSessionLists: ({ path }) => { invalidated.push(path); return null; } });
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => s.id), [SHARED]);
  listed = [entry(SHARED), entry(OTHER)];
  index.invalidateLocalSessionLists("/s/new.jsonl");
  await until(() => invalidated.length === 1, "the daemon's invalidation");
  assert.deepEqual(invalidated, ["/s/new.jsonl"]);
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => s.id), [SHARED, OTHER]);
});

test("projects list this machine's daemon first, then linked hosts", async (t) => {
  const link = setup(t);
  const remote = await link("Remote", { listProjects: () => [], listSessions: () => [entry(OTHER)] });
  await link(null, { listProjects: () => [{ path: tmpdir(), addedAt: "2026-01-01T00:00:00.000Z", hidden: false }], listSessions: () => [] });
  assert.deepEqual((await index.listProjectsAllHosts()).map((p) => [p.path, p.hostId]), [[tmpdir(), "local"], ["/remote/project", remote.id]]);
});

test("an id on two remote hosts only is listed under the first host by label", async (t) => {
  const link = setup(t);
  await link("b-mac", { listSessions: () => [entry(SHARED)] });
  const aVm = await link("A-vm", { listSessions: () => [entry(SHARED)] });
  const sessions = await index.listSessionsAllHosts();
  assert.deepEqual(sessions.map((s) => [s.id, s.hostId]), [[SHARED, aVm.id]]);
  assert.equal((await index.hostForSessionId(SHARED)).id, aVm.id);
});

test("an offline host keeps its last list", async (t) => {
  hub.linkTimings.offlineMs = 30;
  const link = setup(t);
  const remote = await link("Laptop", { listSessions: () => [entry(OTHER)] });
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => s.id), [OTHER]);
  await remote.drop();
  await until(() => hub.getHost(remote.id).status() === "offline", "the host to go offline");
  index.invalidateHostSessionList(remote.id);
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => [s.id, s.hostId]), [[OTHER, remote.id]]);
});

test("malformed remote entries are dropped and keep only known fields", async (t) => {
  const link = setup(t);
  const remote = await link("Sloppy", {
    listSessions: () => [entry(OTHER, { hostId: "local", extra: "x" }), entry("../../etc"), { ...entry(SHARED), messageCount: "1" }, null],
  });
  const sessions = await index.listSessionsAllHosts();
  // As the sessions route serializes them.
  assert.deepEqual(JSON.parse(JSON.stringify(sessions)), [{ ...entry(OTHER), hostId: remote.id }]);
});

test("fetchMediaFromHosts skips a host whose bytes do not hash to the requested hash", async (t) => {
  const link = setup(t);
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const hash = createHash("sha256").update(image).digest("hex");
  await link("Liar", { readMedia: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]) });
  assert.equal(await index.fetchMediaFromHosts(hash), null);
  await link("Honest", { readMedia: ({ hash: asked }) => (asked === hash ? image : new Uint8Array()) });
  assert.deepEqual([...await index.fetchMediaFromHosts(hash)], [...image]);
});

test("a route given an unknown hostId answers 404, a host that is not linked 503", async (t) => {
  setup(t);
  const { POST } = await import("../../app/api/cwd/validate/route.ts");
  const { createHost } = await import("./registry.ts");
  const validate = (hostId) => POST(new Request("http://main.test/api/cwd/validate", { method: "POST", body: JSON.stringify({ cwd: "/w", hostId }) }));
  const unknown = await validate("no-such-host");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "host_not_found");
  const { host } = createHost("Asleep");
  const offline = await validate(host.id);
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: "Asleep is offline", code: "host_offline", hostOffline: true, delivery: "refused" });
  // No hostId is this machine: offline like any host until its daemon links.
  const local = await validate(undefined);
  assert.equal(local.status, 503);
  assert.equal((await local.json()).error, "This machine is offline");
  // A command whose link dropped after it was sent may still run there.
  const { apiErrorResponse } = await import("../../lib/api-utils.ts");
  const { WebRpcError } = await import("../../lib/rpc-manager.ts");
  assert.equal((await apiErrorResponse(new WebRpcError("Asleep is offline", "host_offline", "unknown")).json()).delivery, "unknown");
});

test("a remote host's session export is always an attachment, even with inline=1", async (t) => {
  const link = setup(t);
  // Daemon output is untrusted: inline, this HTML would run on main's origin.
  const html = "<script>fetch(\"/api/projects\")</script>";
  await link("Hostile", { listSessions: () => [entry(OTHER)], exportSession: () => ({ ok: true, value: { html, fileName: "x.html" } }) });
  const { GET } = await import("../../app/api/sessions/[id]/export/route.ts");
  const response = await GET(new Request(`http://main.test/api/sessions/${OTHER}/export?inline=1`), { params: Promise.resolve({ id: OTHER }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await response.text(), html);
});

const { loadPools, savePools } = await import("./pools.ts");
const projectsRoute = await import("../../app/api/projects/route.ts");
const addedAt = "2026-01-01T00:00:00.000Z";
const registeredProject = (id, clonePaths, extra = {}) => ({
  id, name: "app", origin: `git@example.com:team/${id}.git`, clonePaths, addedAt, hidden: false, ...extra,
});
const registeredPool = (members, projects, id = "cluster") => ({
  id, label: id, enabled: true,
  members: members.map(([hostId, projectsRoot]) => ({ hostId, projectsRoot, provisioned: true, draining: false })),
  projects,
});
const projectRequest = (method, body) => new Request("http://main.test/api/projects", { method, body: JSON.stringify(body) });

test("three known worker clones expose one logical project while sessions keep their real worktrees and owners", async (t) => {
  const link = setup(t);
  const ids = [SHARED, OTHER, "11111111-2222-4333-8444-777777777777"];
  const workers = [];
  for (const [i, id] of ids.entries()) {
    workers.push(await link(`Worker ${i}`, {
      listProjects: () => [{ path: `/worker-${i}/app`, addedAt, hidden: false }],
      listSessions: () => [entry(id, { cwd: `/worker-${i}/.app_worktrees/session/${i}`, projectRoot: `/worker-${i}/app` })],
    }));
  }
  savePools([registeredPool(workers.map((worker, i) => [worker.id, `/worker-${i}`]), [
    registeredProject("repo", Object.fromEntries(workers.map((worker, i) => [worker.id, `/worker-${i}/app`]))),
  ])]);
  const projects = await index.listProjectsAllHosts();
  assert.equal(projects.length, 1, "physical registries and discovered roots must both collapse");
  assert.equal(projects[0].poolId, "cluster");
  assert.equal(projects[0].projectId, "repo");
  assert.equal(projects[0].projectKey, "pool:cluster:repo");
  const sessions = await index.listSessionsAllHosts();
  for (const [i, id] of ids.entries()) {
    const session = sessions.find((item) => item.id === id);
    assert.equal(session.hostId, workers[i].id);
    assert.equal(session.cwd, `/worker-${i}/.app_worktrees/session/${i}`);
    assert.equal(session.projectRoot, `/worker-${i}/app`);
    assert.equal(session.projectKey, projects[0].projectKey);
    assert.equal(session.poolId, "cluster");
    assert.equal(session.projectId, "repo");
    const owner = await index.hostForSessionId(id);
    assert.equal(owner.id, workers[i].id);
    assert.equal((await index.sessionSpawnTarget(id, owner)).cwd, session.cwd);
  }
});

test("same names, different origins and pool IDs remain distinct; equal paths on another host stay standalone", async (t) => {
  const link = setup(t);
  const worker = await link("Worker", { listProjects: () => [], listSessions: () => [entry(SHARED, { cwd: "/srv/app", projectRoot: "/srv/app" })] });
  const mac = await link("Mac", { listProjects: () => [], listSessions: () => [entry(OTHER, { cwd: "/srv/app", projectRoot: "/srv/app", projectKey: "/srv/app" })] });
  savePools([
    registeredPool([[worker.id, "/srv"]], [
      registeredProject("one", { [worker.id]: "/srv/app" }, { origin: "git@example.com:first/app.git" }),
      registeredProject("two", { [worker.id]: "/srv/second" }, { origin: "git@example.com:second/app.git" }),
    ]),
    registeredPool([], [registeredProject("one", {}, { origin: "git@example.com:first/app.git" })], "other"),
  ]);
  const projects = await index.listProjectsAllHosts();
  assert.deepEqual(projects.filter((p) => p.poolId).map((p) => p.projectKey).sort(), [
    "pool:cluster:one", "pool:cluster:two", "pool:other:one",
  ]);
  assert.equal(projects.filter((p) => !p.poolId && p.hostId === mac.id && p.path === "/srv/app").length, 1);
  const sessions = await index.listSessionsAllHosts();
  assert.equal(sessions.find((s) => s.id === SHARED).projectKey, "pool:cluster:one");
  assert.equal(sessions.find((s) => s.id === OTHER).poolId, undefined);
  assert.equal(sessions.find((s) => s.id === OTHER).projectKey, "/srv/app");
});

test("standalone arbitrary-directory grouping is unchanged beside a pooled repository", async (t) => {
  const link = setup(t);
  const mac = await link("Mac", {
    listProjects: () => [{ path: "/Users/mac/notes", addedAt, hidden: false, alias: "Notes" }],
    listSessions: () => [
      entry(SHARED, { cwd: "/Users/mac/notes", projectRoot: "/Users/mac/notes", projectKey: "/Users/mac/notes" }),
      entry(OTHER, { cwd: "/Users/mac/scratch", projectRoot: "/Users/mac/scratch", projectKey: "/Users/mac/scratch" }),
    ],
  });
  savePools([registeredPool([], [registeredProject("notes", {}, { name: "Notes" })])]);
  const projects = await index.listProjectsAllHosts();
  assert.deepEqual(projects.filter((p) => !p.poolId).map((p) => [p.path, p.hostId, p.alias]), [
    ["/Users/mac/notes", mac.id, "Notes"], ["/Users/mac/scratch", mac.id, undefined],
  ]);
  assert.equal(projects.filter((p) => p.poolId).length, 1);
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => [s.hostId, s.projectRoot, s.projectKey, s.poolId]), [
    [mac.id, "/Users/mac/notes", "/Users/mac/notes", undefined],
    [mac.id, "/Users/mac/scratch", "/Users/mac/scratch", undefined],
  ]);
});

test("removing pool membership retains clone identity and the existing session's owner", async (t) => {
  const link = setup(t);
  const worker = await link("Removed worker", {
    listProjects: () => [],
    listSessions: () => [entry(SHARED, { cwd: "/srv/.app_worktrees/session/old", projectRoot: "/srv/app" })],
  });
  const pool = registeredPool([[worker.id, "/srv"]], [registeredProject("repo", { [worker.id]: "/srv/app" })]);
  savePools([pool]);
  assert.equal((await index.listSessionsAllHosts())[0].projectId, "repo");
  pool.members = [];
  savePools([pool]);
  const session = (await index.listSessionsAllHosts())[0];
  assert.equal(session.poolId, "cluster");
  assert.equal(session.projectId, "repo");
  assert.equal(session.hostId, worker.id);
  assert.equal(session.cwd, "/srv/.app_worktrees/session/old");
  assert.equal((await index.hostForSessionId(SHARED)).id, worker.id);
  assert.equal((await index.listProjectsAllHosts()).length, 1);
  assert.equal(loadPools()[0].projects[0].clonePaths[worker.id], "/srv/app");
});

test("corrupt or ambiguous pool identities fail closed instead of listing physical clones as local projects", async (t) => {
  const link = setup(t);
  const worker = await link("Worker", { listProjects: () => [], listSessions: () => [entry(SHARED, { cwd: "/srv/app", projectRoot: "/srv/app" })] });
  const file = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "pools.json");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "{broken");
  await assert.rejects(index.listProjectsAllHosts());
  await assert.rejects(index.listSessionsAllHosts());
  assert.ok((await projectsRoute.GET()).status >= 400);
  // Both entries are individually valid, but assigning one host/root to two identities is not.
  writeFileSync(file, JSON.stringify({ version: 1, pools: [registeredPool([[worker.id, "/srv"]], [
    registeredProject("one", { [worker.id]: "/srv/app" }),
    registeredProject("two", { [worker.id]: "/srv/app" }),
  ])] }));
  await assert.rejects(index.listProjectsAllHosts());
  await assert.rejects(index.listSessionsAllHosts());
});

test("pooled registration records an origin and safe clone roots without contacting a daemon or cloning centrally", async (t) => {
  setup(t);
  const root = mkdtempSync(join(tmpdir(), "omp-pool-registration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  savePools([registeredPool([["worker-a", root], ["worker-b", "/remote/projects"]], [])]);
  const origin = "git@example.com:Team/App.git";
  const response = await projectsRoute.POST(projectRequest("POST", { poolId: "cluster", origin, name: "Application", defaultRef: "release", launchConfig: { profile: "work" } }));
  assert.equal(response.status, 200, "registration must not require a linked worker");
  const { project } = await response.json();
  assert.equal(project.poolId, "cluster");
  assert.match(project.projectId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(project.projectKey, `pool:cluster:${project.projectId}`);
  const saved = loadPools()[0].projects[0];
  assert.equal(saved.id, project.projectId);
  assert.equal(saved.origin, origin, "preserve the literal, not display-derived identity");
  assert.equal(saved.name, "Application");
  assert.equal(saved.defaultRef, "release");
  assert.deepEqual(saved.launchConfig, { profile: "work" });
  assert.deepEqual(saved.clonePaths, { "worker-a": join(root, saved.id), "worker-b": `/remote/projects/${saved.id}` });
  assert.deepEqual(readdirSync(root), [], "registration must not create a checkout");
  const again = await projectsRoute.POST(projectRequest("POST", { poolId: "cluster", origin }));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).project.projectId, saved.id);
  assert.equal(loadPools()[0].projects.length, 1);
  const distinct = await projectsRoute.POST(projectRequest("POST", { poolId: "cluster", origin: "git@example.com:Other/App.git", name: "Application" }));
  assert.equal(distinct.status, 200);
  assert.notEqual((await distinct.json()).project.projectId, saved.id);
});

test("logical presentation updates, hide and origin re-add preserve settings, clones and sessions", async (t) => {
  const link = setup(t);
  const root = mkdtempSync(join(tmpdir(), "omp-pool-presentation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clone = join(root, "existing-checkout");
  mkdirSync(clone);
  writeFileSync(join(clone, "dirty.txt"), "unpublished work\n");
  const worker = await link("Worker", { listProjects: () => [], listSessions: () => [entry(SHARED, { cwd: `${root}/.app_worktrees/session/old`, projectRoot: clone })] });
  const project = registeredProject("repo", { [worker.id]: clone }, { defaultRef: "main" });
  savePools([registeredPool([[worker.id, root]], [project])]);
  const update = await projectsRoute.PATCH(projectRequest("PATCH", {
    poolId: "cluster", projectId: "repo", alias: "Renamed", sortOrder: 2, pinOrder: 0,
    launchConfig: { profile: "work", advisor: true, extraArgs: ["--verbose"] },
  }));
  assert.equal(update.status, 200);
  const presented = (await index.listProjectsAllHosts())[0];
  assert.equal(presented.alias, "Renamed");
  assert.equal(presented.sortOrder, 2);
  assert.equal(presented.pinOrder, 0);
  assert.deepEqual(presented.launchConfig, { profile: "work", advisor: true, extraArgs: ["--verbose"] });
  assert.equal((await projectsRoute.DELETE(projectRequest("DELETE", { poolId: "cluster", projectId: "repo" }))).status, 200);
  assert.deepEqual(await index.listProjectsAllHosts(), []);
  assert.equal((await index.listSessionsAllHosts())[0].hostId, worker.id);
  assert.equal(readFileSync(join(clone, "dirty.txt"), "utf8"), "unpublished work\n");
  const restored = await projectsRoute.POST(projectRequest("POST", { poolId: "cluster", origin: project.origin }));
  assert.equal(restored.status, 200);
  const saved = loadPools()[0].projects[0];
  assert.equal(saved.id, "repo");
  assert.equal(saved.hidden, false);
  assert.equal(saved.alias, "Renamed");
  assert.equal(saved.sortOrder, 2);
  assert.equal(saved.pinOrder, 0);
  assert.equal(saved.defaultRef, "main");
  assert.deepEqual(saved.clonePaths, { [worker.id]: clone }, "an administrative existing-checkout binding must not move");
  assert.deepEqual(saved.launchConfig, presented.launchConfig);
  const cleared = await projectsRoute.PATCH(projectRequest("PATCH", { poolId: "cluster", projectId: "repo", alias: null, sortOrder: null, pinOrder: null, launchConfig: null }));
  assert.equal(cleared.status, 200);
  const clean = loadPools()[0].projects[0];
  for (const field of ["alias", "sortOrder", "pinOrder", "launchConfig"]) assert.equal(field in clean, false, field);
  assert.equal(existsSync(join(clone, "dirty.txt")), true);
});

test("pool batch edits validate every target and field before saving, without changing standalone batch semantics", async (t) => {
  const link = setup(t);
  savePools([registeredPool([], [registeredProject("one", {}), registeredProject("two", {})])]);
  const response = await projectsRoute.PATCH(projectRequest("PATCH", {
    poolId: "cluster", updates: [{ projectId: "one", sortOrder: 1 }, { projectId: "two", sortOrder: 0, alias: "Second" }],
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(loadPools()[0].projects.map((p) => [p.id, p.sortOrder, p.alias]), [["one", 1, undefined], ["two", 0, "Second"]]);
  const file = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "pools.json");
  const before = readFileSync(file, "utf8");
  const badBodies = [
    { poolId: "cluster", updates: [{ projectId: "one", alias: "No" }, { projectId: "missing", sortOrder: 0 }] },
    { poolId: "cluster", updates: [{ projectId: "one", sortOrder: 2 }, { projectId: "one", sortOrder: 3 }] },
    { poolId: "cluster", updates: [{ projectId: "one", alias: "No" }, { projectId: "two", sortOrder: "bad" }] },
    { poolId: "cluster", projectId: "one", launchConfig: { extraArgs: ["--cwd=/other"] } },
    { poolId: "cluster", projectId: "one", launchConfig: { profile: "--evil" } },
    { poolId: "cluster", projectId: "one", hostId: "local", alias: "No" },
    { poolId: "cluster", projectId: "one", cwd: "/srv/app", alias: "No" },
    { poolId: "cluster", updates: [{ projectId: "one", hostId: "local", alias: "No" }] },
    { poolId: "cluster", updates: [{ projectId: "one", cwd: "/srv/app", alias: "No" }] },
    { poolId: "missing", projectId: "one", alias: "No" },
  ];
  for (const body of badBodies) {
    const rejected = await projectsRoute.PATCH(projectRequest("PATCH", body));
    assert.ok(rejected.status >= 400 && rejected.status < 500, JSON.stringify(body));
    assert.equal(readFileSync(file, "utf8"), before, "a rejected batch must not partially persist");
  }
  // Exercise the existing real local registry through its daemon, not an update echo.
  const { sessionOps: ops } = await import("./session-ops.ts");
  await link(null, { updateProject: ({ updates }) => ops.updateProject(updates) });
  const root = mkdtempSync(join(tmpdir(), "omp-standalone-presentation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const standalone = await projectsRoute.PATCH(projectRequest("PATCH", { updates: [{ cwd: root, alias: "Local", sortOrder: 0 }] }));
  assert.equal(standalone.status, 200);
  const { loadProjectRegistry } = await import("../project-registry.ts");
  assert.equal(loadProjectRegistry().projects.find((p) => p.alias === "Local").sortOrder, 0);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("pool registration and hiding reject mixed, invalid and unknown targets without persistence", async (t) => {
  setup(t);
  savePools([registeredPool([], [registeredProject("repo", {})])]);
  const file = join(process.env.PI_CODING_AGENT_DIR, "omp-web", "pools.json");
  const before = readFileSync(file, "utf8");
  for (const body of [
    { poolId: "cluster", origin: "git@example.com:team/app.git", hostId: "local" },
    { poolId: "cluster", origin: "git@example.com:team/app.git", cwd: "/srv/app" },
    { poolId: "cluster", origin: "file:///srv/app" },
    { poolId: "cluster", origin: "https://user:secret@example.com/team/app.git" },
    { poolId: "cluster", origin: "git@example.com:team/app.git", defaultRef: 42 },
    { poolId: "missing", origin: "git@example.com:team/app.git" },
  ]) {
    const response = await projectsRoute.POST(projectRequest("POST", body));
    assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(body));
    assert.equal(readFileSync(file, "utf8"), before);
  }
  for (const body of [
    { poolId: "cluster", projectId: "missing" },
    { poolId: "cluster", projectId: "repo", cwd: "/srv/app" },
    { poolId: "cluster", projectId: "repo", hostId: "local" },
  ]) {
    const response = await projectsRoute.DELETE(projectRequest("DELETE", body));
    assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(body));
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

test("GET never authorizes an unprepared local representative of a logical project for file browsing", async (t) => {
  setup(t);
  const root = mkdtempSync(join(tmpdir(), "omp-unprepared-pool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clone = join(root, "repo");
  savePools([registeredPool([["local", root]], [registeredProject("repo", { local: clone })])]);
  const oldCache = globalThis.__piAllowedRootsCache;
  const oldAdditional = globalThis.__piAdditionalAllowedRoots;
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piAdditionalAllowedRoots = new Set();
  t.after(() => {
    globalThis.__piAllowedRootsCache = oldCache;
    globalThis.__piAdditionalAllowedRoots = oldAdditional;
  });
  const response = await projectsRoute.GET();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).projects[0].projectId, "repo");
  const { getAllowedFileRoots, isPathWithinRoots } = await import("../file-access.ts");
  assert.equal(isPathWithinRoots(join(clone, "secret.txt"), await getAllowedFileRoots()), false);
  assert.equal(existsSync(clone), false);
});
