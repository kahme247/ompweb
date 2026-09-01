import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { comparableProjectPath } = await jiti.import("./comparable-path.ts");
const {
  hideProject,
  loadProjectRegistry,
  mergeProjects,
  parseProjectRegistry,
  saveProjectRegistry,
  upsertProject,
  updateProjectsPresentation,
  validateProjectPath,
} = await jiti.import("./project-registry.ts");
const { resolveProject, addWorktree } = await jiti.import("./worktree.ts");
const { samePath } = await jiti.import("./paths.ts");
/** Absolute POSIX-looking test paths become platform-native via resolve(). */
const P = (p) => resolve(p);

/** Point the omp agent dir at a throwaway location for the duration of `fn`. */
async function withAgentDir(t) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-registry-test-"));
  const previous = {
    agent: process.env.PI_CODING_AGENT_DIR,
    profile: process.env.OMP_PROFILE,
    piProfile: process.env.PI_PROFILE,
  };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  t.after(() => {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.profile === undefined) delete process.env.OMP_PROFILE;
    else process.env.OMP_PROFILE = previous.profile;
    if (previous.piProfile === undefined) delete process.env.PI_PROFILE;
    else process.env.PI_PROFILE = previous.piProfile;
    rmSync(agentDir, { recursive: true, force: true });
  });
  return agentDir;
}

test("preserves display aliases and explicit sort order", () => {
  const registry = parseProjectRegistry(JSON.stringify({ version: 1, projects: [{ path: "/one", addedAt: "2026-01-01T00:00:00.000Z", hidden: false, alias: "One", sortOrder: 2 }] }));
  const updated = updateProjectsPresentation(registry, [{ path: P("/one"), alias: "Renamed", sortOrder: 0 }]);
  assert.equal(updated.projects[0].alias, "Renamed");
  assert.equal(updated.projects[0].sortOrder, 0);
});

test("applies batch presentation updates in one pass", () => {
  const registry = parseProjectRegistry(JSON.stringify({
    version: 1,
    projects: [
      { path: P("/one"), addedAt: "2026-01-01T00:00:00.000Z", hidden: false },
      { path: P("/two"), addedAt: "2026-01-02T00:00:00.000Z", hidden: false },
    ],
  }));
  const updated = updateProjectsPresentation(registry, [
    { path: P("/one"), sortOrder: 1 },
    { path: P("/two"), sortOrder: 0, alias: "Second" },
  ]);
  assert.equal(updated.projects[0].sortOrder, 1);
  assert.equal(updated.projects[1].sortOrder, 0);
  assert.equal(updated.projects[1].alias, "Second");
  // Clearing via null removes the field entirely.
  const cleared = updateProjectsPresentation(updated, [{ path: P("/two"), sortOrder: null }]);
  assert.equal(cleared.projects[1].sortOrder, undefined);
  assert.equal("sortOrder" in cleared.projects[1], false);
  // Updates for unregistered paths change nothing.
  const untouched = updateProjectsPresentation(registry, [{ path: P("/missing"), alias: "Nope" }]);
  assert.deepEqual(untouched, registry);
});

test("parses a valid registry and resolves relative paths", () => {
  const registry = parseProjectRegistry(JSON.stringify({
    version: 1,
    projects: [
      { path: "./relative-dir", addedAt: "2026-01-02T00:00:00.000Z", hidden: false },
      { path: "/abs/dir", addedAt: "2026-01-01T00:00:00.000Z", hidden: true },
    ],
  }));
  assert.equal(registry.projects.length, 2);
  assert.match(registry.projects[0].path, /relative-dir$/);
  assert.equal(registry.projects[1].path, P("/abs/dir"));
  assert.equal(registry.projects[1].hidden, true);
});

test("tolerates missing, corrupt, and foreign-shaped registry content", () => {
  assert.equal(parseProjectRegistry("").projects.length, 0);
  assert.equal(parseProjectRegistry("not json {{{").projects.length, 0);
  assert.equal(parseProjectRegistry("[]").projects.length, 0);
  assert.equal(parseProjectRegistry("{}").projects.length, 0);
  assert.equal(parseProjectRegistry('{"version":1}').projects.length, 0);
  // Invalid entries are skipped, valid ones survive.
  const registry = parseProjectRegistry(JSON.stringify({
    projects: [null, { addedAt: "2026-01-01T00:00:00.000Z" }, { path: "  " }, { path: "/ok", addedAt: "2026-01-02T00:00:00.000Z" }],
  }));
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].path, P("/ok"));
  // Missing addedAt falls back deterministically instead of throwing.
  const noDate = parseProjectRegistry(JSON.stringify({ projects: [{ path: "/x" }] }));
  assert.ok(!Number.isNaN(Date.parse(noDate.projects[0].addedAt)));
});

test("persists atomically and round-trips through the agent dir", async (t) => {
  const agentDir = await withAgentDir(t);
  saveProjectRegistry({
    version: 1,
    projects: [{ path: "/proj/a", addedAt: "2026-01-02T00:00:00.000Z", hidden: false }],
  });
  const registryPath = join(agentDir, "projects.json");
  assert.equal(existsSync(registryPath), true);
  // No temp files left behind.
  const leftovers = readdirSync(agentDir).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
  const loaded = loadProjectRegistry();
  assert.equal(loaded.projects.length, 1);
  assert.equal(loaded.projects[0].path, P("/proj/a"));

  // A corrupt registry on disk loads as empty instead of throwing.
  writeFileSync(registryPath, "{broken", "utf8");
  assert.equal(loadProjectRegistry().projects.length, 0);
  // A missing registry loads as empty too.
  rmSync(registryPath, { force: true });
  assert.equal(loadProjectRegistry().projects.length, 0);
});

test("upsert adds, dedupes, refreshes addedAt, and restores hidden projects", () => {
  const base = { version: 1, projects: [] };
  const added = upsertProject(base, "/proj/a", "2026-01-01T00:00:00.000Z");
  assert.equal(added.projects.length, 1);
  assert.equal(added.projects[0].hidden, false);

  // Re-adding the same path dedupes and bumps addedAt.
  const reAdded = upsertProject(added, "/proj/a", "2026-02-01T00:00:00.000Z");
  assert.equal(reAdded.projects.length, 1);
  assert.equal(reAdded.projects[0].addedAt, "2026-02-01T00:00:00.000Z");

  // Adding the same path with different casing collapses on Windows.
  const caseVariant = upsertProject(added, "/PROJ/A", "2026-03-01T00:00:00.000Z");
  if (process.platform === "win32") {
    assert.equal(caseVariant.projects.length, 1);
  } else {
    assert.equal(caseVariant.projects.length, 2);
  }

  // Re-adding a hidden project unhides it.
  const hidden = hideProject(added, "/proj/a");
  assert.equal(hidden.projects[0].hidden, true);
  const restored = upsertProject(hidden, "/proj/a", "2026-04-01T00:00:00.000Z");
  assert.equal(restored.projects.length, 1);
  assert.equal(restored.projects[0].hidden, false);
});

test("hideProject marks known projects hidden and records unknown ones", () => {
  const base = upsertProject({ version: 1, projects: [] }, "/proj/a", "2026-01-01T00:00:00.000Z");
  const hidden = hideProject(base, "/proj/a");
  assert.equal(hidden.projects[0].hidden, true);
  // Hiding a session-discovered (never added) project records a hidden entry.
  const discoveredHidden = hideProject(base, "/proj/other");
  assert.equal(discoveredHidden.projects.length, 2);
  const entry = discoveredHidden.projects.find((p) => p.path === P("/proj/other"));
  assert.equal(entry.hidden, true);
});

test("mergeProjects combines registered and discovered, excluding hidden", () => {
  const registry = {
    version: 1,
    projects: [
      { path: P("/proj/registered"), addedAt: "2026-01-01T00:00:00.000Z", hidden: false },
      { path: P("/proj/hidden"), addedAt: "2026-01-02T00:00:00.000Z", hidden: true },
    ],
  };
  const merged = mergeProjects(registry, [P("/proj/hidden"), P("/proj/discovered"), P("/proj/registered")]);
  assert.deepEqual(merged.map((p) => p.path), [P("/proj/registered"), P("/proj/discovered")]);
  // Registered entries carry addedAt; discovered ones do not.
  assert.equal(merged[0].addedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(merged[1].addedAt, undefined);
  // Discovered duplicates collapse (same path, and case variants on Windows).
  const duplicated = mergeProjects({ version: 1, projects: [] }, ["/p", "/p", "/P"]);
  assert.equal(duplicated.length, process.platform === "win32" ? 1 : 2);
  // Registered projects come first in most-recently-added order (paths are
  // returned exactly as stored — registration resolves them upstream).
  const ordered = mergeProjects(
    {
      version: 1,
      projects: [
        { path: "/a", addedAt: "2026-01-01T00:00:00.000Z", hidden: false },
        { path: "/b", addedAt: "2026-02-01T00:00:00.000Z", hidden: false },
      ],
    },
    [],
  );
  assert.deepEqual(ordered.map((p) => p.path), ["/b", "/a"]);
});

test("comparableProjectPath is case-insensitive on Windows", () => {
  assert.equal(comparableProjectPath("/a/b"), comparableProjectPath("/a/b"));
  if (process.platform === "win32") {
    assert.equal(comparableProjectPath("C:/Foo/Bar"), comparableProjectPath("c:\\foo\\bar"));
  } else {
    assert.notEqual(comparableProjectPath("/Foo"), comparableProjectPath("/foo"));
  }
});

test("validateProjectPath rejects empty, missing, and non-directory paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-path-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "existing-dir");
  mkdirSync(dir);
  const file = join(root, "plain-file.txt");
  writeFileSync(file, "x");

  assert.throws(() => validateProjectPath(""), (e) => e.code === "path_required");
  assert.throws(() => validateProjectPath("   "), (e) => e.code === "path_required");
  assert.throws(() => validateProjectPath(join(root, "missing")), (e) => e.code === "directory_not_found");
  assert.throws(() => validateProjectPath(file), (e) => e.code === "not_a_directory");
  assert.equal(validateProjectPath(dir), dir);
});

test("worktree paths canonicalize to the main repo root when registered", async (t) => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("git is not installed");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "omp-web-registry-worktree-"));
  const repo = join(root, "repo");
  const worktreeBase = `${repo}-worktrees`;
  try {
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.email", "omp-web@example.invalid"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "config", "user.name", "omp-web test"], { stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["-C", repo, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "commit", "-m", "fixture"], { stdio: "ignore" });

    const created = await addWorktree(repo, "feature/projects");
    const project = await resolveProject(created.path);
    assert.ok(samePath(project.projectRoot, repo));

    // Registering the canonicalized root stores the main repo, not the worktree.
    const registered = upsertProject({ version: 1, projects: [] }, project.projectRoot);
    assert.ok(samePath(registered.projects[0].path, repo));

    // Sessions discovered from the worktree carry the main repo as their
    // projectRoot, so they merge into the same project.
    const merged = mergeProjects(registered, [project.projectRoot, repo]);
    assert.equal(merged.length, 1);
    assert.ok(samePath(merged[0].path, repo));
  } finally {
    rmSync(worktreeBase, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject returns canonical on-disk casing for plain directories", (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-canonical-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "PlainDir");
  mkdirSync(dir);
  // Same-directory input resolves to the realpath (on-disk) form.
  return resolveProject(dir).then((info) => {
    const real = execFileSync("node", ["-e", "console.log(require('fs').realpathSync(process.argv[1]))", dir], { encoding: "utf8" }).trim();
    assert.equal(info.projectRoot, real);
  });
});
