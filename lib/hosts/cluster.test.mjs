import assert from "node:assert/strict";
import test from "node:test";
import { CLUSTER_ID, CLUSTER_LABEL, CLUSTER_PROJECTS_DIR, ClusterError, clusterJoinBlock, clusterOf, isClusterMember, isClusterTarget, joinCluster, leaveCluster, ompSharesCredentials, reconcileMember, sharesCredentials } from "./cluster.ts";
import { validatePools } from "./pools.ts";

test("clusterJoinBlock shares readiness and distinct blocking reasons between the route and the client", () => {
  const supports = (operation) => operation === "gitOrigins";
  const ompVersion = "omp/15.13.1";
  assert.equal(clusterJoinBlock({ status: "online", protocol: 10, ompVersion, supports }), null);
  assert.equal(clusterJoinBlock({ status: "online", protocol: 11, ompVersion: "16.0.0", supports }), null);
  for (const protocol of [null, 8, 9]) {
    assert.equal(clusterJoinBlock({ status: "online", protocol, ompVersion, supports }), "upgrade");
  }
  assert.equal(clusterJoinBlock({ status: "online", protocol: 10, ompVersion, supports: () => false }), "upgrade");
  // Members always share credentials: an omp that cannot, or an unknown one, has its own reason, after the daemon's.
  for (const old of ["omp/15.13.0", "15.13.1-beta.1", "omp/next", null]) {
    assert.equal(clusterJoinBlock({ status: "online", protocol: 10, ompVersion: old, supports }), "omp-old", String(old));
  }
  assert.equal(clusterJoinBlock({ status: "online", protocol: 9, ompVersion: "omp/15.13.0", supports }), "upgrade");
  for (const status of ["offline", "needs-upgrade", "omp-missing"]) {
    assert.equal(clusterJoinBlock({ status, protocol: 10, ompVersion, supports }), status);
  }
});

test("ompSharesCredentials takes omp 15.13.1 and newer, with or without the omp/ prefix", () => {
  for (const version of ["omp/15.13.1", "15.13.1", "omp/15.14.0", "omp/16.0.0-beta.1"]) assert.equal(ompSharesCredentials(version), true, version);
  for (const version of ["omp/15.13.0", "omp/15.13.1-rc.1", "omp/", "", "garbage", null]) assert.equal(ompSharesCredentials(version), false, String(version));
});

const NOW = "2026-11-11T10:00:00.000Z";
const APP = "https://github.com/a/app.git";
const APP_SCP = "git@github.com:a/app.git";
const MASTER_ROOT = `/home/me/${CLUSTER_PROJECTS_DIR}`;

const member = (hostId, projectsRoot = `/srv/${hostId}`) => ({ hostId, projectsRoot, provisioned: true, draining: false });
const clusterProject = (id, origin, clonePaths = {}, extra = {}) => ({
  id, name: "app", origin, clonePaths, addedAt: "2026-01-01T00:00:00.000Z", hidden: false, ...extra,
});
const cluster = (members, projects = [], extra = {}) => ({ id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members, projects, ...extra });
const fact = (path, origin, { mainCheckout = true, ...project } = {}) => ({ project: { path, ...project }, origin, mainCheckout });
const counter = () => {
  let n = 0;
  return () => `new-${++n}`;
};
const neverId = () => assert.fail("no project should be created");
const accept = () => true;
const joined = (pools, hostId, facts = [], root = `/srv/${hostId}`, newId = counter(), valid = accept, sessionRoots = new Set()) => {
  const result = joinCluster(pools, { hostId, projectsRoot: root }, facts, sessionRoots, NOW, newId, valid).pools;
  validatePools(result);
  return result;
};
const reconciled = (pools, hostId, facts = [], sessionRoots = new Set(), newId = counter()) => {
  const result = reconcileMember(pools, hostId, facts, sessionRoots, NOW, newId, accept);
  validatePools(result.pools);
  return result;
};
const left = (pools, hostId) => {
  const result = leaveCluster(pools, hostId);
  validatePools(result);
  return result;
};
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};
const clusterError = (code) => (error) => error instanceof ClusterError && error.code === code;

test("the cluster's names are fixed", () => {
  assert.deepEqual([CLUSTER_ID, CLUSTER_LABEL, CLUSTER_PROJECTS_DIR], ["cluster", "Cluster", "ompweb-cluster"]);
});

test("clusterOf is the first pool; isClusterMember looks only at it", () => {
  const first = cluster([member("local")]);
  const second = cluster([member("other")], [], { id: "second" });
  assert.equal(clusterOf([]), undefined);
  assert.equal(clusterOf([first, second]), first);
  assert.equal(isClusterMember([], "local"), false);
  assert.equal(isClusterMember([first, second], "local"), true);
  assert.equal(isClusterMember([first, second], "other"), false);
});

test("a member shares credentials whatever its own flag says; a non-member follows its flag; local never shares", () => {
  const pools = [cluster([member("local"), member("worker")]), cluster([member("other")], [], { id: "second" })];
  assert.equal(sharesCredentials({ id: "worker", shareCredentials: false }, pools), true);
  assert.equal(sharesCredentials({ id: "other", shareCredentials: false }, pools), false, "only the first pool is the cluster");
  assert.equal(sharesCredentials({ id: "other", shareCredentials: true }, pools), true);
  assert.equal(sharesCredentials({ id: "stranger", shareCredentials: false }, []), false);
  assert.equal(sharesCredentials({ id: "local", shareCredentials: true }, pools), false);
});

test("joining with no pool creates the cluster with the member", () => {
  const result = joined([], "local", [], MASTER_ROOT);
  assert.deepEqual(result, [{
    id: "cluster", label: "Cluster", enabled: true,
    members: [{ hostId: "local", projectsRoot: "/home/me/ompweb-cluster", provisioned: true, draining: false }],
    projects: [],
  }]);
});

test("a checkout binds to the cluster project with the same repository, whatever the URL form; the project's presentation wins, the checkout's fills gaps", () => {
  const existing = clusterProject("app", APP, { local: "/home/me/app" }, { alias: "Kept", name: "Kept name", pinOrder: 2 });
  const result = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [
    fact("/home/h/app", APP_SCP, { alias: "Other", hidden: false, sortOrder: 9, pinOrder: 0 }),
  ], "/srv/h", neverId);
  const [project, ...rest] = result[0].projects;
  assert.equal(rest.length, 0);
  assert.deepEqual(project, { ...existing, sortOrder: 9, clonePaths: { local: "/home/me/app", h: "/home/h/app" } });
});

test("binding a visible checkout un-hides the cluster project; it stays hidden only when both are", () => {
  for (const [target, checkout, hidden] of [[true, false, false], [true, undefined, false], [true, true, true], [false, true, false]]) {
    const existing = clusterProject("app", APP, { local: "/home/me/app" }, { hidden: target });
    const seen = [];
    const [project] = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [fact("/home/h/app", APP_SCP, { hidden: checkout })], "/srv/h", neverId, (candidate) => {
      seen.push(candidate.hidden);
      return true;
    })[0].projects;
    assert.equal(project.hidden, hidden, `cluster project hidden ${target}, checkout hidden ${checkout}`);
    assert.deepEqual(seen, [hidden], "the check sees the project as it would become");
    assert.equal(project.clonePaths.h, "/home/h/app");
  }
});

test("a movable project nobody has is created with its presentation", () => {
  const launchConfig = { profile: "dev", advisor: true, extraArgs: ["--verbose"] };
  const result = joined([cluster([member("local", MASTER_ROOT)])], "h", [
    fact("/home/h/my-app", APP_SCP, { addedAt: "2026-02-02T00:00:00.000Z", hidden: true, alias: "My app", sortOrder: 3, pinOrder: 1, launchConfig }),
  ], "/srv/h", counter());
  assert.deepEqual(result[0].projects, [{
    id: "new-1", name: "my-app", origin: APP_SCP,
    clonePaths: { local: `${MASTER_ROOT}/new-1`, h: "/home/h/my-app" },
    addedAt: "2026-02-02T00:00:00.000Z", hidden: true, alias: "My app", sortOrder: 3, pinOrder: 1, launchConfig,
  }]);
});

// A root path has no folder name, but it contains projectsRoot, so it stays pinned rather than falling back to the origin's name.
test("a created project keeps the name the host showed: its own name, else its folder's", () => {
  const created = joinCluster([], { hostId: "h", projectsRoot: "/srv/h" }, [
    fact("/home/h/one", "https://github.com/org1/api.git", { name: "Org one API" }),
    fact("/home/h/org2-api/", "https://github.com/org2/api.git"),
    fact("D:\\code\\win-api", "https://github.com/org3/api.git"),
    fact("/", "https://github.com/org4/api.git"),
  ], new Set(), NOW, counter(), accept).pools[0].projects;
  assert.deepEqual(created.map((project) => project.name), ["Org one API", "org2-api", "win-api"]);
});

test("a created project defaults addedAt to now and hidden to false", () => {
  const [project] = joined([], "h", [fact("/home/h/app", APP)], "/srv/h")[0].projects;
  assert.equal(project.addedAt, NOW);
  assert.equal(project.hidden, false);
  for (const key of ["alias", "sortOrder", "pinOrder", "launchConfig"]) assert.equal(project[key], undefined, key);
});

for (const [name, projectFact] of [
  ["without an origin", fact("/home/h/app", null)],
  ["with an origin that is not a repository URL", fact("/home/h/app", "/srv/x")],
  ["with an https origin that has credentials", fact("/home/h/app", "https://user:secret@github.com/a/app.git")],
  ["that is not a main checkout", fact("/home/h/app", APP, { mainCheckout: false })],
]) {
  test(`a project ${name} is left alone`, () => {
    const existing = clusterProject("app", APP, { local: "/home/me/app" });
    const result = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [projectFact], "/srv/h", neverId);
    assert.deepEqual(result[0].projects, [{ ...existing, clonePaths: { local: "/home/me/app", h: "/srv/h/app" } }]);
  });
}

test("a project the cluster does not know stays unmoved: no project is created for it", () => {
  const result = joined([cluster([member("local", MASTER_ROOT)])], "h", [fact("/home/h/a", null), fact("/home/h/b", "/srv/x")], "/srv/h", neverId);
  assert.deepEqual(result[0].projects, []);
});

test("a project the check rejects stays pinned while the others in the call still move", () => {
  const seen = [];
  const result = joined([cluster([member("local", MASTER_ROOT)])], "h", [
    fact("/home/h/bad", "https://github.com:70000/a/bad.git"),
    fact("/home/h/good", "https://github.com/a/good.git"),
  ], "/srv/h", counter(), (project) => {
    seen.push(project);
    return !project.origin.includes(":70000");
  });
  assert.deepEqual(result[0].projects.map((p) => [p.origin, p.clonePaths.h]), [["https://github.com/a/good.git", "/home/h/good"]]);
  assert.deepEqual(seen.map((p) => [p.origin, p.clonePaths.h]), [["https://github.com:70000/a/bad.git", "/home/h/bad"], ["https://github.com/a/good.git", "/home/h/good"]]);
});

test("a bind the check rejects leaves the existing cluster project unchanged", () => {
  const existing = clusterProject("app", APP, { local: "/home/me/app" }, { launchConfig: { profile: "old" } });
  const seen = [];
  const result = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [
    fact("/home/h/app", APP_SCP),
    fact("/home/h/new", "https://github.com/a/new.git", { launchConfig: { profile: "dev" } }),
    fact("/home/h/ok", "https://github.com/a/ok.git"),
  ], "/srv/h", counter(), (project) => {
    seen.push(project);
    return project.launchConfig === undefined;
  });
  assert.equal(seen.find((p) => p.id === "app").clonePaths.h, "/home/h/app", "the check sees the project as it would become");
  assert.deepEqual(result[0].projects[0], { ...existing, clonePaths: { local: "/home/me/app", h: "/srv/h/app" } });
  assert.deepEqual(result[0].projects.slice(1).map((p) => p.origin), ["https://github.com/a/ok.git"]);
});

test("with validatePools as the check, projects it would reject stay pinned and the join still passes it", () => {
  const valid = (project) => {
    try {
      validatePools([{ id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members: [], projects: [project] }]);
      return true;
    } catch {
      return false;
    }
  };
  const result = joined([cluster([member("local", MASTER_ROOT)])], "h", [
    fact("/home/h/port", "https://github.com:70000/a/app.git"),
    fact("/home/h/ip", "https://999.1.1.1/a/app.git"),
    fact("/home/h/tld", "https://foo.123/a/app.git"),
    fact("/home/h/padded", ` ${APP}`),
    fact("/home/h/args", "https://github.com/a/args.git", { launchConfig: { extraArgs: ["--cwd=/tmp"] } }),
    fact("/home/h/empty", "https://github.com/a/empty.git", { launchConfig: { profile: "", advisor: true } }),
    fact("/home/h/dash", "https://github.com/a/dash.git", { launchConfig: { profile: "-x" } }),
    fact("/home/h/good", "https://github.com/a/good.git"),
  ], "/srv/h", counter(), valid);
  assert.deepEqual(result[0].projects.map((p) => p.clonePaths.h), ["/home/h/good"]);
});

for (const [position, path] of [["at", "/srv/h"], ["above", "/srv"]]) {
  test(`a checkout ${position} the joining host's projectsRoot is pinned`, () => {
    const existing = clusterProject("app", APP, { local: "/home/me/app" });
    const result = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [
      fact(path, "https://github.com/a/other.git"),
      fact(path, APP),
    ], "/srv/h", neverId);
    assert.deepEqual(result[0].projects, [{ ...existing, clonePaths: { local: "/home/me/app", h: "/srv/h/app" } }]);
  });
}

test("a checkout below the joining host's projectsRoot binds like any other", () => {
  const existing = clusterProject("app", APP, { local: "/home/me/app" });
  const result = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [fact("/srv/h/mine", APP)], "/srv/h", neverId);
  assert.deepEqual(result[0].projects, [{ ...existing, clonePaths: { local: "/home/me/app", h: "/srv/h/mine" } }]);
});

test("a checkout that is the projectsRoot is not bound, so nothing is seeded inside a bound checkout", () => {
  const lib = clusterProject("lib", "https://github.com/a/lib.git", { local: "/home/me/lib" });
  const result = joined([cluster([member("local", MASTER_ROOT)], [lib])], "h", [fact("/home/h/code", APP)], "/home/h/code", neverId);
  assert.deepEqual(result[0].projects, [{ ...lib, clonePaths: { local: "/home/me/lib", h: "/home/h/code/lib" } }]);
});

test("a checkout already bound for this host is skipped entirely", () => {
  const bound = clusterProject("bound", APP, { local: "/home/me/app", h: "/home/h/app" });
  const pools = [cluster([member("local", MASTER_ROOT)], [bound])];
  const lib = fact("/home/h/lib", "https://github.com/a/lib.git");
  const withBound = joined(pools, "h", [fact("/home/h/app", "https://github.com/a/other.git"), lib], "/srv/h", counter());
  assert.deepEqual(withBound, joined(pools, "h", [lib], "/srv/h", counter()));
  assert.equal(withBound[0].projects.length, 2);
});

test("a joining host's checkout replaces the folder left from an earlier membership unless a session is there", () => {
  const seeded = clusterProject("app", APP, { local: "/home/me/app", h: "/srv/h/app" });
  const pools = [cluster([member("local", MASTER_ROOT)], [seeded])];
  const result = joined(pools, "h", [fact("/home/h/app", APP_SCP)], "/srv/h", neverId);
  assert.deepEqual(result[0].projects, [{ ...seeded, clonePaths: { local: "/home/me/app", h: "/home/h/app" } }]);
  const kept = joined(pools, "h", [fact("/home/h/app", APP_SCP)], "/srv/h", neverId, accept, new Set(["/srv/h/app"]));
  assert.deepEqual(kept[0].projects, [seeded]);
});

// The pfBlockerNG case: every member was seeded a folder under /root/git, while the real checkout there stayed a host project.
test("a member's existing checkout replaces its seeded folder that has no session, and its sessions move with it", () => {
  const seeded = clusterProject("p1", "https://github.com/pfBlockerNG/pfBlockerNG", { local: "/root/git/p1", a: "/root/git/p1", b: "/root/git/p1" }, { name: "p1" });
  const pools = [cluster([member("local", "/root/git"), member("a", "/root/git"), member("b", "/root/git")], [seeded])];
  const facts = [fact("/root/git/pfBlockerNG", "git@github.com:pfBlockerNG/pfBlockerNG.git", { alias: "pf" }), fact("/root/git/notes", null)];
  const sessions = new Set(["/root/git/pfblockerng-other", "/root/git/pfBlockerNG", "/root/git/notes"]);
  const first = reconciled(pools, "local", facts, sessions, neverId);
  assert.deepEqual(first.conflicts, []);
  assert.deepEqual(first.pools[0].projects, [{ ...seeded, alias: "pf", clonePaths: { ...seeded.clonePaths, local: "/root/git/pfBlockerNG" } }]);
  // Idempotent: a second run (the next hello) changes nothing.
  assert.deepEqual(reconciled(first.pools, "local", facts, sessions, neverId).pools, first.pools);
  // Another member has no checkout: its folder stays, for a lazy clone at its first session.
  assert.deepEqual(reconciled(first.pools, "a", [], new Set(), neverId).pools, first.pools);
});

test("a binding that holds sessions is never replaced; the checkout stays separate and is reported", () => {
  const bound = clusterProject("app", APP, { local: "/root/git/app-id", h: "/srv/h/app" });
  const pools = [cluster([member("local", "/root/git"), member("h")], [bound])];
  const result = reconciled(pools, "local", [fact("/root/git/app", APP)], new Set(["/root/git/app-id", "/root/git/app"]), neverId);
  assert.deepEqual(result.pools, pools);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0], /local: \/root\/git\/app stays separate .* has sessions/);
});

test("two checkouts of one repository never take turns: the bound one stays", () => {
  const bound = clusterProject("app", APP, { local: "/home/me/one" });
  const pools = [cluster([member("local", MASTER_ROOT)], [bound])];
  const facts = [fact("/home/me/two", APP), fact("/home/me/one", APP)];
  const result = reconciled(pools, "local", facts, new Set(), neverId);
  assert.deepEqual(result.pools, pools);
  assert.match(result.conflicts[0], /is another checkout of it/);
});

test("reconciling a host that is not a member changes nothing", () => {
  const pools = [cluster([member("local", MASTER_ROOT)], [clusterProject("app", APP, { local: "/home/me/app" })])];
  assert.deepEqual(reconciled(pools, "stranger", [fact("/home/s/new", "https://github.com/a/new.git")], new Set(), neverId).pools, pools);
  assert.deepEqual(reconciled([], "local", [], new Set(), neverId).pools, []);
});

test("another pool's binding keeps its checkout", () => {
  const other = cluster([member("local")], [clusterProject("o", APP, { local: "/home/me/app" })], { id: "second" });
  const pools = [cluster([member("local", MASTER_ROOT)], [clusterProject("app", APP, { local: `${MASTER_ROOT}/app` })]), other];
  assert.deepEqual(reconciled(pools, "local", [fact("/home/me/app", APP)], new Set(), neverId).pools, pools);
});

test("two checkouts of one repository: the first binds, the other stays unbound", () => {
  const facts = [fact("/home/h/one", APP), fact("/home/h/two", APP_SCP)];
  const created = joined([], "h", facts, "/srv/h", counter());
  assert.deepEqual(created[0].projects.map((p) => p.clonePaths), [{ h: "/home/h/one" }]);
  const existing = clusterProject("app", APP, {});
  const bound = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", facts, "/srv/h", neverId);
  assert.deepEqual(bound[0].projects[0].clonePaths, { local: `${MASTER_ROOT}/app`, h: "/home/h/one" });
});

test("members get a folder under their projectsRoot for every project they have no checkout of", () => {
  const old = clusterProject("old", "https://github.com/a/old.git", { local: "/home/me/old", h1: "/srv/h1/old" });
  const pools = [cluster([member("local", MASTER_ROOT), member("h1")], [old])];
  const result = joined(pools, "h2", [fact("/home/h2/new-checkout", "https://github.com/a/new.git")], "/srv/h2", counter());
  assert.deepEqual(result[0].projects, [
    { ...old, clonePaths: { local: "/home/me/old", h1: "/srv/h1/old", h2: "/srv/h2/old" } },
    {
      id: "new-1", name: "new-checkout", origin: "https://github.com/a/new.git", addedAt: NOW, hidden: false,
      clonePaths: { h2: "/home/h2/new-checkout", local: `${MASTER_ROOT}/new-1`, h1: "/srv/h1/new-1" },
      alias: undefined, sortOrder: undefined, pinOrder: undefined, launchConfig: undefined,
    },
  ]);
});

test("a Windows host is seeded with its own separator", () => {
  const result = joinCluster([], { hostId: "win", projectsRoot: "C:\\cluster" }, [fact("c:/CLUSTER", "https://github.com/a/mine.git"), fact("D:\\code\\app", APP)], new Set(), NOW, counter(), accept).pools;
  assert.deepEqual(result[0].projects.map((p) => p.clonePaths), [{ win: "D:\\code\\app" }]);
  const again = joinCluster([cluster([member("local", MASTER_ROOT)], [clusterProject("old", APP)])], { hostId: "win", projectsRoot: "C:\\cluster" }, [], new Set(), NOW, neverId, accept).pools;
  assert.deepEqual(again[0].projects[0].clonePaths, { local: `${MASTER_ROOT}/old`, win: "C:\\cluster\\old" });
});

test("joining twice is refused", () => {
  const pools = [cluster([member("local", MASTER_ROOT), member("h")])];
  for (const hostId of ["h", "local"]) {
    assert.throws(() => joinCluster(pools, { hostId, projectsRoot: "/srv/x" }, [], new Set(), NOW, neverId, accept), clusterError("already_member"));
  }
});

test("only the first pool changes; the rest are the same objects", () => {
  const other = cluster([member("other")], [clusterProject("o", APP, { other: "/srv/other/o" })], { id: "second" });
  const pools = [cluster([member("local", MASTER_ROOT), member("h")]), other];
  const joinedPools = joined(pools, "h2", [fact("/home/h2/app", APP)], "/srv/h2");
  assert.equal(joinedPools[1], other);
  assert.notEqual(joinedPools[0], pools[0]);
  assert.equal(left(pools, "h")[1], other);
});

test("join and leave never mutate their input", () => {
  const pools = [
    cluster([member("local", MASTER_ROOT), member("h", "/srv/h")], [clusterProject("app", APP, { local: "/home/me/app", h: "/home/h/app" })]),
    cluster([member("other")], [], { id: "second" }),
  ];
  const facts = [fact("/home/h2/app", APP_SCP, { launchConfig: { extraArgs: ["--x"] } }), fact("/home/h2/new", "https://github.com/a/new.git")];
  const before = structuredClone(pools);
  deepFreeze(pools);
  deepFreeze(facts);
  joined(pools, "h2", facts, "/srv/h2");
  left(pools, "h");
  assert.deepEqual(pools, before);
});

test("leaving removes the member and unbinds every path but the folders the cluster made for it", () => {
  const pools = [cluster([member("local", MASTER_ROOT), member("h", "/srv/h")], [
    clusterProject("bound", APP, { local: "/home/me/app", h: "/home/h/app" }),
    clusterProject("created", "https://github.com/a/new.git", { local: `${MASTER_ROOT}/created`, h: "/srv/h/created" }),
    clusterProject("root", "https://github.com/a/root.git", { h: "/srv/h" }),
    clusterProject("sibling", "https://github.com/a/sibling.git", { h: "/srv/h-other/x" }),
    clusterProject("below", "https://github.com/a/below.git", { h: "/srv/h/own-checkout" }),
    clusterProject("never", "https://github.com/a/never.git", { local: `${MASTER_ROOT}/never` }),
  ])];
  const [result] = left(pools, "h");
  assert.deepEqual(result.members, [member("local", MASTER_ROOT)]);
  assert.deepEqual(result.projects.map((p) => p.clonePaths), [
    { local: "/home/me/app" },
    { local: `${MASTER_ROOT}/created`, h: "/srv/h/created" },
    { },
    { },
    { },
    { local: `${MASTER_ROOT}/never` },
  ]);
  assert.deepEqual(result.projects.map((p) => p.id), pools[0].projects.map((p) => p.id));
});

test("a Windows member's paths compare as Windows paths when it leaves", () => {
  const pools = [cluster([member("local", MASTER_ROOT), member("win", "C:\\Cluster")], [
    clusterProject("inside", APP, { win: "c:/cluster/inside" }),
    clusterProject("sibling", "https://github.com/a/s.git", { win: "C:\\Cluster2\\s" }),
    clusterProject("outside", "https://github.com/a/o.git", { win: "D:\\code\\o" }),
  ])];
  const [result] = leaveCluster(pools, "win");
  assert.deepEqual(result.projects.map((p) => p.clonePaths), [{ win: "c:/cluster/inside" }, {}, {}]);
});

test("leaving fails for a host that is not a member", () => {
  assert.throws(() => leaveCluster([cluster([member("local", MASTER_ROOT)])], "ghost"), clusterError("not_member"));
  assert.throws(() => leaveCluster([], "ghost"), clusterError("not_member"));
});

test("this machine cannot leave", () => {
  assert.throws(() => leaveCluster([cluster([member("local", MASTER_ROOT), member("h")])], "local"), clusterError("master_cannot_leave"));
  assert.throws(() => leaveCluster([], "local"), clusterError("master_cannot_leave"));
});

test("join, leave and join again with the same facts keeps the same projects", () => {
  const facts = [
    fact("/home/h/app", APP_SCP, { alias: "App" }),
    fact("/home/h/lib", "https://github.com/a/lib.git"),
    fact("/home/h/notes", null),
  ];
  const newId = counter();
  const first = joined([], "local", [fact("/home/me/mine", "https://github.com/a/mine.git")], MASTER_ROOT, newId);
  const afterJoin = joined(first, "h", facts, "/srv/h", newId);
  const ids = afterJoin[0].projects.map((p) => p.id);
  assert.equal(new Set(ids).size, 3);
  const afterLeave = left(afterJoin, "h");
  const again = joined(afterLeave, "h", facts, "/srv/h", neverId);
  assert.deepEqual(again, afterJoin);
  assert.deepEqual(again[0].projects.map((p) => p.id), ids);
});

test("a host that is the first member and leaves keeps its projects, unbound", () => {
  const facts = [fact("/home/h/app", APP)];
  const afterJoin = joined([], "h", facts, "/srv/h", counter());
  const afterLeave = left(afterJoin, "h");
  assert.deepEqual(afterLeave[0].projects.map((p) => [p.id, p.clonePaths]), [["new-1", {}]]);
  assert.deepEqual(joined(afterLeave, "h", facts, "/srv/h", neverId)[0].projects, afterJoin[0].projects);
});

test("isClusterTarget: Settings act for the cluster for its pool and its members' projects, while the host is a member", () => {
  const member = (hostId) => ({ hostId, projectsRoot: `/srv/${hostId}`, provisioned: true, draining: false });
  const pools = [
    { id: CLUSTER_ID, label: CLUSTER_LABEL, enabled: true, members: [member("local"), member("h1")], projects: [] },
    { id: "other", label: "Other", enabled: true, members: [member("h4")], projects: [] },
  ];
  for (const [label, target, hostId, expected] of [
    ["a pool project with no node", { poolId: CLUSTER_ID }, undefined, true],
    ["a member's pool session", { poolId: CLUSTER_ID, hostId: "h1" }, "h1", true],
    ["a member's own project", { hostId: "h1" }, "h1", true],
    ["this machine's project, a member", { hostId: "local" }, undefined, true],
    ["a pool session of a host that has left", { poolId: CLUSTER_ID, hostId: "h2" }, "h2", false],
    ["a standalone host's project", { hostId: "h3" }, "h3", false],
    ["a project of another pool", { poolId: "other", hostId: "h4" }, "h4", false],
    ["nothing open", null, undefined, false],
  ]) assert.equal(isClusterTarget(target, hostId, pools), expected, label);
  assert.equal(isClusterTarget({ hostId: "local" }, undefined, [{ ...pools[0], members: [member("h1")] }]), false, "this machine is not a member yet");
  assert.equal(isClusterTarget({ hostId: "h1" }, "h1", []), false, "no cluster");
});
