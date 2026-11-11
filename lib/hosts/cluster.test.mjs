import assert from "node:assert/strict";
import test from "node:test";
import { CLUSTER_ID, CLUSTER_LABEL, CLUSTER_PROJECTS_DIR, ClusterError, clusterJoinBlock, clusterOf, isClusterMember, joinCluster, leaveCluster, sharesCredentials } from "./cluster.ts";
import { validatePools } from "./pools.ts";

test("clusterJoinBlock shares readiness and distinct blocking reasons between the route and the client", () => {
  const supports = (operation) => operation === "gitOrigins";
  assert.equal(clusterJoinBlock({ status: "online", protocol: 9, supports }), null);
  assert.equal(clusterJoinBlock({ status: "online", protocol: 10, supports }), null);
  for (const protocol of [null, 8]) {
    assert.equal(clusterJoinBlock({ status: "online", protocol, supports }), "upgrade");
  }
  assert.equal(clusterJoinBlock({ status: "online", protocol: 9, supports: () => false }), "upgrade");
  for (const status of ["offline", "needs-upgrade", "omp-missing"]) {
    assert.equal(clusterJoinBlock({ status, protocol: 9, supports }), status);
  }
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
const joined = (pools, hostId, facts = [], root = `/srv/${hostId}`, newId = counter(), valid = accept) => {
  const result = joinCluster(pools, { hostId, projectsRoot: root }, facts, NOW, newId, valid);
  validatePools(result);
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

test("a checkout binds to the cluster project with the same repository, whatever the URL form", () => {
  const existing = clusterProject("app", APP, { local: "/home/me/app" }, { alias: "Kept", name: "Kept name" });
  const result = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [
    fact("/home/h/app", APP_SCP, { alias: "Other", hidden: false, sortOrder: 9 }),
  ], "/srv/h", neverId);
  const [project, ...rest] = result[0].projects;
  assert.equal(rest.length, 0);
  assert.deepEqual(project, { ...existing, clonePaths: { local: "/home/me/app", h: "/home/h/app" } });
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
  ], NOW, counter(), accept)[0].projects;
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

for (const [position, path] of [["at", "/srv/h"], ["below", "/srv/h/mine"], ["above", "/srv"]]) {
  test(`a checkout ${position} the joining host's projectsRoot is pinned`, () => {
    const existing = clusterProject("app", APP, { local: "/home/me/app" });
    const result = joined([cluster([member("local", MASTER_ROOT)], [existing])], "h", [
      fact(path, "https://github.com/a/other.git"),
      fact(path, APP),
    ], "/srv/h", neverId);
    assert.deepEqual(result[0].projects, [{ ...existing, clonePaths: { local: "/home/me/app", h: "/srv/h/app" } }]);
  });
}

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

test("a project that already has an entry for the host keeps it, even a seeded default", () => {
  const seeded = clusterProject("app", APP, { local: "/home/me/app", h: "/srv/h/app" });
  const result = joined([cluster([member("local", MASTER_ROOT)], [seeded])], "h", [fact("/home/h/app", APP_SCP)], "/srv/h", neverId);
  assert.deepEqual(result[0].projects, [seeded]);
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
  const result = joinCluster([], { hostId: "win", projectsRoot: "C:\\cluster" }, [fact("c:/CLUSTER/mine", "https://github.com/a/mine.git"), fact("D:\\code\\app", APP)], NOW, counter(), accept);
  assert.deepEqual(result[0].projects.map((p) => p.clonePaths), [{ win: "D:\\code\\app" }]);
  const again = joinCluster([cluster([member("local", MASTER_ROOT)], [clusterProject("old", APP)])], { hostId: "win", projectsRoot: "C:\\cluster" }, [], NOW, neverId, accept);
  assert.deepEqual(again[0].projects[0].clonePaths, { local: `${MASTER_ROOT}/old`, win: "C:\\cluster\\old" });
});

test("joining twice is refused", () => {
  const pools = [cluster([member("local", MASTER_ROOT), member("h")])];
  for (const hostId of ["h", "local"]) {
    assert.throws(() => joinCluster(pools, { hostId, projectsRoot: "/srv/x" }, [], NOW, neverId, accept), clusterError("already_member"));
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

test("leaving removes the member and unbinds checkouts outside its projectsRoot", () => {
  const pools = [cluster([member("local", MASTER_ROOT), member("h", "/srv/h")], [
    clusterProject("bound", APP, { local: "/home/me/app", h: "/home/h/app" }),
    clusterProject("created", "https://github.com/a/new.git", { local: `${MASTER_ROOT}/created`, h: "/srv/h/created" }),
    clusterProject("root", "https://github.com/a/root.git", { h: "/srv/h" }),
    clusterProject("sibling", "https://github.com/a/sibling.git", { h: "/srv/h-other/x" }),
    clusterProject("case", "https://github.com/a/case.git", { h: "/SRV/h/case" }),
    clusterProject("never", "https://github.com/a/never.git", { local: `${MASTER_ROOT}/never` }),
  ])];
  const [result] = left(pools, "h");
  assert.deepEqual(result.members, [member("local", MASTER_ROOT)]);
  assert.deepEqual(result.projects.map((p) => p.clonePaths), [
    { local: "/home/me/app" },
    { local: `${MASTER_ROOT}/created`, h: "/srv/h/created" },
    { h: "/srv/h" },
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
