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
