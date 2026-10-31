import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  foldedHostProjectKey,
  groupProjectsByHost,
  groupSessionsByProject,
  hostProjectKey,
  projectActivityCounts,
  nextPinOrder,
  orderProjects,
  sortManagedProjects,
} = await jiti.import("./project-ordering.ts");
const { comparableProjectPath } = await jiti.import("./comparable-path.ts");

function session(id, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: `/work/${id}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    ...overrides,
  };
}

test("sorts registered projects by most-recently-added, tie-broken by path", () => {
  const projects = [
    { path: "/proj/oldest", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/newest", addedAt: "2026-03-01T00:00:00.000Z" },
    { path: "/proj/middle", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/newest", "/proj/middle", "/proj/oldest"]);
});

test("manual workspace order overrides add time and remains stable", () => {
  const projects = [
    { path: "/proj/new", addedAt: "2026-03-01T00:00:00.000Z", sortOrder: 1 },
    { path: "/proj/old", addedAt: "2026-01-01T00:00:00.000Z", sortOrder: 0 },
  ];
  assert.deepEqual(sortManagedProjects(projects).map((project) => project.path), ["/proj/old", "/proj/new"]);
});

test("project order is stable regardless of session activity", () => {
  const projects = [
    { path: "/proj/a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/b", addedAt: "2026-02-01T00:00:00.000Z" },
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  // A session whose modified timestamp is newer than project B's must NOT
  // bump project A above it — rows must never reorder from activity.
  const sessions = [
    session("s-a", { modified: "2026-06-01T00:00:00.000Z", projectRoot: "/proj/a" }),
    session("s-b", { modified: "2026-03-01T00:00:00.000Z", projectRoot: "/proj/b" }),
  ];
  const sortedAfterActivity = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/b", "/proj/a"]);
  assert.deepEqual(sortedAfterActivity, sorted);
  assert.ok(sessions.length === 2); // sessions are irrelevant to ordering
});

test("session-discovered projects without addedAt sort below registered, by path", () => {
  const projects = [
    { path: "/proj/registered" }, // discovered, no addedAt
    { path: "/proj/active", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/proj/inactive", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/proj/zzz" }, // discovered
  ];
  const sorted = sortManagedProjects(projects).map((p) => p.path);
  assert.deepEqual(sorted, ["/proj/inactive", "/proj/active", "/proj/registered", "/proj/zzz"]);
});

test("groups sessions under their project, including worktree sessions", () => {
  const projects = [
    { path: "/repo", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/empty", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/other" },
  ];
  const sessions = [
    // Worktree session: cwd differs, projectRoot is the main repo.
    session("wt", { cwd: "/repo-worktrees/feature", projectRoot: "/repo" }),
    // Forked session groups under its project like any other session.
    session("fork", { parentSessionId: "parent", projectRoot: "/other" }),
    session("parent", { projectRoot: "/other" }),
  ];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("/repo").map((s) => s.id), ["wt"]);
  // Empty managed project gets an (empty) bucket.
  assert.deepEqual(grouped.get("/empty"), []);
  assert.deepEqual(grouped.get("/other").map((s) => s.id).sort(), ["fork", "parent"]);
});

test("projectActivityCounts tallies running, unread, and exited sessions per project", () => {
  const sessions = [
    session("running-main", { projectRoot: "/repo" }),
    session("unread-main", { projectRoot: "/repo" }),
    session("exited-main", { projectRoot: "/repo" }),
    session("running-wt", { cwd: "/repo-worktrees/x", projectRoot: "/repo" }),
    session("idle-other", { projectRoot: "/other" }),
  ];
  const counts = projectActivityCounts(sessions, ["running-main", "running-wt"], ["unread-main"], ["exited-main"]);
  // Keys are the case-folded comparable form (see projectActivityCounts docs).
  assert.deepEqual(counts.get(comparableProjectPath("/repo")), { running: 2, unread: 1, exited: 1 });
  assert.deepEqual(counts.get(comparableProjectPath("/other")), { running: 0, unread: 0, exited: 0 });
});

test("casing-only projectRoot differences still group and tally on Windows", { skip: process.platform !== "win32" }, () => {
  // A session file whose cwd casing differs from the registered project path
  // must still land in that project's bucket and its activity row.
  const projects = [{ path: "D:\\OtherProjects\\Waku", addedAt: "2026-01-01T00:00:00.000Z" }];
  const sessions = [session("s1", { projectRoot: "d:\\otherprojects\\waku" })];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("D:\\OtherProjects\\Waku").map((s) => s.id), ["s1"]);
  const counts = projectActivityCounts(sessions, ["s1"], []);
  assert.deepEqual(counts.get(comparableProjectPath("d:\\otherprojects\\waku")), { running: 1, unread: 0, exited: 0 });
});

test("running session placeholders group stably under their own project cwd, not active workspace", () => {
  const projects = [
    { path: "/project-a", addedAt: "2026-01-01T00:00:00.000Z" },
    { path: "/project-b", addedAt: "2026-02-01T00:00:00.000Z" },
    { path: "/project-c", addedAt: "2026-03-01T00:00:00.000Z" },
  ];
  // Session started in project A (running placeholder with path: "")
  const runningSessionInA = session("running-in-a", {
    path: "",
    cwd: "/project-a",
    projectRoot: "/project-a",
  });
  // Existing sessions in project B and C
  const sessionInB = session("session-b", { projectRoot: "/project-b" });
  const sessionInC = session("session-c", { projectRoot: "/project-c" });

  const visibleSessions = [sessionInB, sessionInC, runningSessionInA];
  const grouped = groupSessionsByProject(projects, visibleSessions);

  assert.deepEqual(grouped.get("/project-a").map((s) => s.id), ["running-in-a"]);
  assert.deepEqual(grouped.get("/project-b").map((s) => s.id), ["session-b"]);
  assert.deepEqual(grouped.get("/project-c").map((s) => s.id), ["session-c"]);
});

test("sort modes: pins lead in pin order, the rest follow the mode; none ignores pins", () => {
  const projects = [
    { path: "/proj/charlie", sortOrder: 0 },
    { path: "/proj/alpha", sortOrder: 1, pinOrder: 5 },
    { path: "/proj/Bravo", sortOrder: 2 },
    { path: "/proj/delta", sortOrder: 3, pinOrder: 2 },
    { path: "/proj/echo", sortOrder: 4, alias: "aardvark" },
  ];
  const sessions = [
    session("c-old", { projectRoot: "/proj/charlie", modified: "2026-02-01T00:00:00.000Z" }),
    session("b-new", { projectRoot: "/proj/Bravo", modified: "2026-05-01T00:00:00.000Z" }),
    session("c-new", { projectRoot: "/proj/charlie", modified: "2026-04-01T00:00:00.000Z" }),
    session("a-newest", { projectRoot: "/proj/alpha", modified: "2026-09-01T00:00:00.000Z" }),
  ];
  const label = (p) => p.alias ?? p.path.split("/").pop();
  const order = (mode) => orderProjects(projects, mode, sessions, label).map((p) => p.path);
  assert.deepEqual(order("none"), ["/proj/charlie", "/proj/alpha", "/proj/Bravo", "/proj/delta", "/proj/echo"]);
  // Case-insensitive by displayed label (alias "aardvark" first).
  assert.deepEqual(order("alphabetical"), ["/proj/delta", "/proj/alpha", "/proj/echo", "/proj/Bravo", "/proj/charlie"]);
  // Newest session first; pinned alpha stays in its pin slot; no sessions last.
  assert.deepEqual(order("updated"), ["/proj/delta", "/proj/alpha", "/proj/Bravo", "/proj/charlie", "/proj/echo"]);
});

test("last updated: each project's newest session wins, and its last message time beats the file mtime", () => {
  const projects = [{ path: "/p/a", sortOrder: 0 }, { path: "/p/b", sortOrder: 1 }, { path: "/p/c", sortOrder: 2 }];
  const sessions = [
    session("a-new", { projectRoot: "/p/a", modified: "2026-03-01T00:00:00.000Z" }),
    session("b-renamed", { projectRoot: "/p/b", modified: "2026-06-01T00:00:00.000Z", lastMessageAt: "2026-02-01T00:00:00.000Z" }),
    session("c-only", { projectRoot: "/p/c", modified: "2026-02-15T00:00:00.000Z" }),
    session("a-old", { projectRoot: "/p/a", modified: "2026-01-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(orderProjects(projects, "updated", sessions, (p) => p.path).map((p) => p.path), ["/p/a", "/p/c", "/p/b"]);
});

test("alphabetical ignores case and compares digits numerically", () => {
  const projects = [{ path: "/w/ws10" }, { path: "/w/WS3" }, { path: "/w/ws2" }];
  assert.deepEqual(orderProjects(projects, "alphabetical", [], (p) => p.path.slice(3)).map((p) => p.path), ["/w/ws2", "/w/WS3", "/w/ws10"]);
});

test("a newly pinned project goes after every pinned one", () => {
  assert.equal(nextPinOrder([{ path: "/x" }]), 0);
  assert.equal(nextPinOrder([{ path: "/x", pinOrder: 3 }, { path: "/y" }, { path: "/z", pinOrder: 0 }]), 4);
});

// ---- Host-aware keys and grouping -------------------------------------------

test("a local project keeps its bare path as key, a remote one is prefixed with its host", () => {
  assert.equal(hostProjectKey("local", "/work/a"), "/work/a");
  assert.equal(hostProjectKey(undefined, "/work/a"), "/work/a");
  assert.equal(hostProjectKey("h1", "/work/a"), "h1:/work/a");
  // Stored expanded-projects keys are comparable local paths; they must still match.
  assert.equal(foldedHostProjectKey("local", "/Work/A"), comparableProjectPath("/Work/A"));
  assert.equal(foldedHostProjectKey("h1", "/Work/A"), `h1:${comparableProjectPath("/Work/A")}`);
});

test("host groups put this machine first, then the remote hosts by label, each with its own projects", () => {
  const hosts = [
    { id: "h-z", label: "zeta" },
    { id: "local", label: "This machine" },
    { id: "h-a", label: "Alpha" },
    { id: "h-empty", label: "Beta" },
  ];
  const projects = [
    { path: "/p/1", hostId: "h-z" },
    { path: "/p/2", hostId: "local" },
    { path: "/p/3", hostId: "h-a" },
    { path: "/p/4" },
    { path: "/p/5", hostId: "gone" },
  ];
  const groups = groupProjectsByHost(projects, hosts);
  assert.deepEqual(groups.map((g) => g.host.id), ["local", "h-a", "h-empty", "h-z"]);
  assert.deepEqual(groups.map((g) => g.projects.map((p) => p.path)), [["/p/2", "/p/4"], ["/p/3"], [], ["/p/1"]]);
});

test("the same path on two hosts is two projects with their own sessions and counts", () => {
  const projects = [{ path: "/w/app", hostId: "local" }, { path: "/w/app", hostId: "h1" }];
  const sessions = [
    session("s-local", { projectRoot: "/w/app", projectKey: "/w/app", hostId: "local" }),
    session("s-remote", { projectRoot: "/w/app", projectKey: "/w/app", hostId: "h1" }),
    session("s-bare", { projectRoot: "/w/app", projectKey: "/w/app" }),
  ];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual([...grouped.keys()], ["/w/app", "h1:/w/app"]);
  assert.deepEqual(grouped.get("/w/app").map((s) => s.id), ["s-local", "s-bare"]);
  assert.deepEqual(grouped.get("h1:/w/app").map((s) => s.id), ["s-remote"]);
  const counts = projectActivityCounts(sessions, ["s-remote"], ["s-local"]);
  assert.deepEqual(counts.get(foldedHostProjectKey("local", "/w/app")), { running: 0, unread: 1, exited: 0 });
  assert.deepEqual(counts.get(foldedHostProjectKey("h1", "/w/app")), { running: 1, unread: 0, exited: 0 });
});

test("last updated sorts a host's project by that host's sessions only", () => {
  const projects = [{ path: "/w/app", hostId: "local", sortOrder: 0 }, { path: "/w/app", hostId: "h1", sortOrder: 1 }];
  const sessions = [
    session("a", { projectRoot: "/w/app", hostId: "local", modified: "2026-01-01T00:00:00.000Z" }),
    session("b", { projectRoot: "/w/app", hostId: "h1", modified: "2026-06-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(orderProjects(projects, "updated", sessions, (p) => p.path).map((p) => p.hostId), ["h1", "local"]);
});
