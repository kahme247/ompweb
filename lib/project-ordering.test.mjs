import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  groupSessionsByProject,
  projectActivityCounts,
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

test("projectActivityCounts tallies running and unread per project", () => {
  const sessions = [
    session("running-main", { projectRoot: "/repo" }),
    session("unread-main", { projectRoot: "/repo" }),
    session("running-wt", { cwd: "/repo-worktrees/x", projectRoot: "/repo" }),
    session("idle-other", { projectRoot: "/other" }),
  ];
  const counts = projectActivityCounts(sessions, ["running-main", "running-wt"], ["unread-main"]);
  // Keys are the case-folded comparable form (see projectActivityCounts docs).
  assert.deepEqual(counts.get(comparableProjectPath("/repo")), { running: 2, unread: 1 });
  assert.deepEqual(counts.get(comparableProjectPath("/other")), { running: 0, unread: 0 });
});

test("casing-only projectRoot differences still group and tally on Windows", { skip: process.platform !== "win32" }, () => {
  // A session file whose cwd casing differs from the registered project path
  // must still land in that project's bucket and its activity row.
  const projects = [{ path: "D:\\OtherProjects\\Waku", addedAt: "2026-01-01T00:00:00.000Z" }];
  const sessions = [session("s1", { projectRoot: "d:\\otherprojects\\waku" })];
  const grouped = groupSessionsByProject(projects, sessions);
  assert.deepEqual(grouped.get("D:\\OtherProjects\\Waku").map((s) => s.id), ["s1"]);
  const counts = projectActivityCounts(sessions, ["s1"], []);
  assert.deepEqual(counts.get(comparableProjectPath("d:\\otherprojects\\waku")), { running: 1, unread: 0 });
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
