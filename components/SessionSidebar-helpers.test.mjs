import assert from "node:assert/strict";
import test from "node:test";

const { livePlace } = await import("./SessionSidebar-helpers.ts");
const { groupProjectsByHost, groupSessionsByProject, projectActivityCounts } = await import("../lib/project-ordering.ts");

const hosts = [{ id: "local", label: "This machine" }, { id: "h1", label: "Build box" }];
const selected = { cwd: "/here", hostId: "local" };

test("a running remote session's placeholder project groups under its host, not This machine", () => {
  const place = livePlace("remote-run", null, { "remote-run": { cwd: "/srv/app", hostId: "h1" } }, new Map(), new Map(), selected);
  assert.deepEqual(place, { cwd: "/srv/app", hostId: "h1" });
  const groups = groupProjectsByHost([{ path: place.cwd, hostId: place.hostId }], hosts);
  assert.deepEqual(groups.map(({ host, projects }) => [host.id, projects.map((p) => p.path)]), [["local", []], ["h1", ["/srv/app"]]]);
});

test("a live session's place comes from the freshest source, with that source's host", () => {
  const optimistic = { id: "s", cwd: "/opt", hostId: "h1" };
  const running = { s: { cwd: "/run" } };
  const exited = new Map([["s", { cwd: "/exit", hostId: "h1" }]]);
  const known = new Map([["s", { cwd: "/known", hostId: "h1" }]]);
  assert.deepEqual(livePlace("s", optimistic, running, exited, known, selected), optimistic);
  assert.deepEqual(livePlace("s", null, running, exited, known, selected), { cwd: "/run" });
  assert.deepEqual(livePlace("s", null, {}, exited, known, selected), { cwd: "/exit", hostId: "h1" });
  assert.deepEqual(livePlace("s", null, {}, new Map(), known, selected), { cwd: "/known", hostId: "h1" });
  // Nothing knows it: the selected workspace, host included.
  assert.deepEqual(livePlace("s", null, {}, new Map(), new Map(), selected), selected);
});

test("hostsCameOnline: a link-up transition, or a remote host already linked at the first snapshot", async () => {
  const { hostsCameOnline } = await import("./SessionSidebar-helpers.ts");
  const row = (id, status) => ({ id, status });
  const local = row("local", "online");
  assert.equal(hostsCameOnline(null, [local]), false, "first snapshot, this machine only: the load has its sessions");
  assert.equal(hostsCameOnline(null, [local, row("h1", "offline")]), false, "first snapshot, remote host offline");
  assert.equal(hostsCameOnline(null, [local, row("h1", "online")]), true, "first snapshot, remote host linked after the load");
  assert.equal(hostsCameOnline([local, row("h1", "offline")], [local, row("h1", "online")]), true, "offline -> online");
  assert.equal(hostsCameOnline([local, row("h1", "needs-upgrade")], [local, row("h1", "omp-missing")]), true, "linked but unusable -> linked");
  assert.equal(hostsCameOnline([local], [local, row("h2", "online")]), true, "a new host appearing online");
  assert.equal(hostsCameOnline([local], [local, row("h2", "offline")]), false, "a new host appearing offline");
  assert.equal(hostsCameOnline([local, row("h1", "online")], [local, row("h1", "online")]), false, "no status change");
  assert.equal(hostsCameOnline([local, row("h1", "online")], [local, row("h1", "offline")]), false, "going offline");
});

test("sessions on different workers share one logical project while a same-path Mac project stays separate", () => {
  const projects = [
    { path: "/srv/app", hostId: "h1", poolId: "workers", projectId: "app", projectKey: "pool:workers:app" },
    { path: "/srv/app", hostId: "local" },
    { path: "/srv/app", hostId: "h1", poolId: "workers", projectId: "other", projectKey: "pool:workers:other" },
  ];
  const sessions = [
    { id: "worker-one", cwd: "/srv/app", projectRoot: "/srv/app", hostId: "h1", poolId: "workers", projectId: "app", projectKey: "pool:workers:app" },
    { id: "worker-two", cwd: "/other/worktree", projectRoot: "/other/app", hostId: "h2", poolId: "workers", projectId: "app", projectKey: "pool:workers:app" },
    { id: "mac", cwd: "/srv/app", hostId: "local" },
    { id: "unrelated", cwd: "/srv/app", hostId: "h1", poolId: "workers", projectId: "other", projectKey: "pool:workers:other" },
  ];
  assert.deepEqual([...groupSessionsByProject(projects, sessions)].map(([key, entries]) => [key, entries.map(({ id }) => id)]), [
    ["pool:workers:app", ["worker-one", "worker-two"]],
    ["/srv/app", ["mac"]],
    ["pool:workers:other", ["unrelated"]],
  ]);
  assert.deepEqual([...projectActivityCounts(sessions, ["worker-one", "worker-two"], ["worker-two", "mac"])], [
    ["pool:workers:app", { running: 2, unread: 1, exited: 0 }],
    ["/srv/app", { running: 0, unread: 1, exited: 0 }],
    ["pool:workers:other", { running: 0, unread: 0, exited: 0 }],
  ]);
});

test("attention: an open dialog counts even while running; the agent's marker only while the session is not running", async () => {
  const { attentionSessionIds } = await import("./SessionSidebar-helpers.ts");
  const marker = { reason: "Pick one", at: "2026-11-13T10:00:00.000Z" };
  const sessions = [
    { id: "marker-idle", attention: marker },
    { id: "marker-running", attention: marker },
    { id: "dialog-running" },
    { id: "plain" },
  ];
  const running = new Set(["marker-running", "dialog-running", "new"]);
  assert.deepEqual([...attentionSessionIds(sessions, running, new Set(["dialog-running"]))].sort(), ["dialog-running", "marker-idle"]);
  // A dialog on a session the list does not have yet counts too (its row is a live placeholder).
  assert.deepEqual([...attentionSessionIds([], running, new Set(["new"]))], ["new"]);
});

test("attention entries: only attention sessions, workspaces by label and sessions by title A→Z, workspaces without one dropped", async () => {
  const { attentionProjectEntries } = await import("./SessionSidebar-helpers.ts");
  const session = (id, cwd, extra) => ({ id, cwd, path: `${cwd}/${id}.jsonl`, created: "", modified: "2026-11-13T10:00:00.000Z", messageCount: 1, firstMessage: "", ...extra });
  // The manual order (sortOrder) and pins do not apply.
  const projects = [
    { path: "/srv/zeta", sortOrder: 0 },
    { path: "/srv/quiet", sortOrder: 1 },
    { path: "/srv/Beta", sortOrder: 2, pinOrder: 0 },
    { path: "/srv/x", alias: "alpha", sortOrder: 3 },
  ];
  const sessions = [
    session("z1", "/srv/zeta", { name: "fix tests" }),
    session("q1", "/srv/quiet", { name: "idle" }),
    session("b2", "/srv/Beta", { name: "Zebra" }),
    session("b1", "/srv/Beta", { firstMessage: "apple pie" }),
    session("b3", "/srv/Beta", { name: "item 10", parentSessionId: "b2" }),
    session("b4", "/srv/Beta", { name: "Item 9" }),
    session("bx", "/srv/Beta", { name: "Aardvark" }),
    session("x1", "/srv/x", { name: "deploy" }),
  ];
  const byProject = groupSessionsByProject(projects, sessions);
  const entries = attentionProjectEntries(projects, byProject, new Set(["z1", "b2", "b1", "b3", "b4", "x1"]));
  assert.deepEqual(entries.map(({ project, hostId, tree }) => [project.path, hostId, tree.map((node) => node.session.id)]), [
    ["/srv/x", "local", ["x1"]],
    ["/srv/Beta", "local", ["b1", "b4", "b3", "b2"]],
    ["/srv/zeta", "local", ["z1"]],
  ]);
  assert.ok(entries.every(({ tree }) => tree.every((node) => node.children.length === 0)), "a fork does not nest under its parent");
  assert.deepEqual(attentionProjectEntries(projects, byProject, new Set()), []);
});

test("attention host groups: only hosts with an entry, A→Z by shown name with this machine not pinned first", async () => {
  const { attentionHostGroups } = await import("./SessionSidebar-helpers.ts");
  const hostList = [{ id: "local", label: "" }, { id: "h1", label: "build box" }, { id: "h2", label: "Zed" }, { id: "h3", label: "Empty" }];
  const names = { local: "This machine", h1: "build box", h2: "Zed", h3: "Empty", "pool:cluster": "Cluster" };
  const nameOf = (host) => names[host.id];
  const entries = [{ hostId: "h2", name: "z" }, { hostId: "local", name: "l" }, { hostId: "h1", name: "b2" }, { hostId: "h1", name: "b1" }];
  const shape = (groups) => groups.map(({ host, projects }) => [host.id, projects.map((entry) => entry.name)]);
  assert.deepEqual(shape(attentionHostGroups(entries, hostList, undefined, nameOf)), [["h1", ["b2", "b1"]], ["local", ["l"]], ["h2", ["z"]]]);
  // A cluster member's workspaces list under the cluster, as in Workspaces.
  const pools = [{ id: "cluster", members: [{ hostId: "h2" }] }];
  assert.deepEqual(shape(attentionHostGroups(entries, [...hostList, { id: "pool:cluster", label: "Cluster" }], pools, nameOf)), [["h1", ["b2", "b1"]], ["pool:cluster", ["z"]], ["local", ["l"]]]);
});
