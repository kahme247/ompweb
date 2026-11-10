import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-pool-project-")));
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const origin = "https://pool-fixture.invalid/repo.git";
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const config = join(root, "gitconfig");
  const ssh = join(root, "ssh");
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_COUNT = "0";
    process.env.GIT_SSH_COMMAND = ssh;
    writeFileSync(config, "");
    // Real upload-pack over a test-only SSH transport; production still permits only https/ssh.
    writeFileSync(ssh, '#!/bin/sh\nfor command do :; done\nexec sh -c "$command"\n', { mode: 0o700 });
    git(root, "config", "--global", `url.ssh://fixture${remote}.insteadOf`, origin);
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "init", "--initial-branch=main", source);
    git(source, "config", "user.name", "Pool fixture");
    git(source, "config", "user.email", "pool@example.invalid");
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    git(source, "add", ".");
    git(source, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "main");
    const workers = join(root, "workers");
    mkdirSync(workers);
    const cloneRoot = join(workers, "registered-project");
    const input = { projectId: "registered-project", origin, cloneRoot, creationId: "creation-1" };
    const baseCommit = git(source, "rev-parse", "HEAD");
    await run({ root, workers, source, remote, ssh, origin, cloneRoot, input, baseCommit });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function prepared(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function rejected(result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
  assert.equal(typeof result.code, "string");
  assert.equal(typeof result.status, "number");
  assert.equal(result.value, undefined, "failure must not expose a launchable cwd");
}

const worktree = (f, id = "creation-1") => join(f.workers, ".registered-project_worktrees", "session", id);

// Subtests are serial: each owns its Git config and restores process.env before the next.
test("pool project preparation uses real isolated Git repositories", async (t) => {
  const { preparePoolProject } = await import("./pooled-projects.ts");

  await t.test("clones a registered origin and creates an external session branch", () => fixture(async (f) => {
    const value = prepared(await preparePoolProject(f.input));
    assert.deepEqual(value, { cwd: worktree(f), projectRoot: f.cloneRoot, baseCommit: f.baseCommit });
    assert.equal(git(f.cloneRoot, "config", "--get", "remote.origin.url"), f.origin);
    assert.equal(git(value.cwd, "branch", "--show-current"), "session/creation-1");
    assert.equal(readFileSync(join(value.cwd, "tracked.txt"), "utf8"), "committed\n");
    assert.equal(lstatSync(join(value.cwd, ".git")).isFile(), true);
    assert.deepEqual(readdirSync(f.workers).sort(), [".registered-project_worktrees", "registered-project"]);
  }));

  await t.test("fetches pushed refs from another clone without resetting a dirty checkout", () => fixture(async (f) => {
    git(f.root, "clone", f.origin, f.cloneRoot);
    writeFileSync(join(f.cloneRoot, "tracked.txt"), "local edit\n");
    writeFileSync(join(f.cloneRoot, "private.txt"), "untracked\n");
    git(f.source, "checkout", "-b", "feature/pushed");
    writeFileSync(join(f.source, "pushed.txt"), "available on every worker\n");
    git(f.source, "add", ".");
    git(f.source, "-c", "commit.gpgsign=false", "commit", "-qm", "pushed ref");
    git(f.source, "push", "origin", "feature/pushed");
    const commit = git(f.source, "rev-parse", "HEAD");
    const value = prepared(await preparePoolProject({ ...f.input, ref: "feature/pushed" }));
    assert.equal(value.baseCommit, commit);
    assert.equal(readFileSync(join(value.cwd, "pushed.txt"), "utf8"), "available on every worker\n");
    assert.equal(readFileSync(join(f.cloneRoot, "tracked.txt"), "utf8"), "local edit\n");
    assert.equal(readFileSync(join(f.cloneRoot, "private.txt"), "utf8"), "untracked\n");
    assert.equal(git(f.cloneRoot, "rev-parse", "HEAD"), f.baseCommit);
  }));

  await t.test("same creation is idempotent and preserves its dirty worktree", () => fixture(async (f) => {
    const first = prepared(await preparePoolProject(f.input));
    writeFileSync(join(first.cwd, "tracked.txt"), "session edit\n");
    writeFileSync(join(first.cwd, "notes.txt"), "session notes\n");
    writeFileSync(join(f.source, "later.txt"), "new default branch commit\n");
    git(f.source, "add", ".");
    git(f.source, "-c", "commit.gpgsign=false", "commit", "-qm", "advance default");
    git(f.source, "push", "origin", "main");
    const second = prepared(await preparePoolProject(f.input));
    assert.deepEqual(second, first);
    assert.equal(readFileSync(join(first.cwd, "tracked.txt"), "utf8"), "session edit\n");
    assert.equal(readFileSync(join(first.cwd, "notes.txt"), "utf8"), "session notes\n");
    assert.equal(git(f.cloneRoot, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 2);
  }));

  await t.test("concurrent distinct creations serialize clone publication and use unique worktrees", () => fixture(async (f) => {
    const [a, b, repeated] = await Promise.all([
      preparePoolProject(f.input),
      preparePoolProject({ ...f.input, creationId: "creation-2" }),
      preparePoolProject(f.input),
    ]);
    assert.equal(prepared(a).cwd, worktree(f));
    assert.equal(prepared(b).cwd, worktree(f, "creation-2"));
    assert.deepEqual(prepared(repeated), prepared(a));
    writeFileSync(join(prepared(a).cwd, "only-a.txt"), "isolated\n");
    assert.equal(existsSync(join(prepared(b).cwd, "only-a.txt")), false);
    assert.equal(git(f.cloneRoot, "worktree", "list", "--porcelain").match(/^worktree /gm).length, 3);
    assert.deepEqual(readdirSync(f.workers).sort(), [".registered-project_worktrees", "registered-project"]);
  }));

  await t.test("equal origin basenames do not merge different registered projects", () => fixture(async (f) => {
    const a = prepared(await preparePoolProject(f.input));
    const otherRoot = join(f.workers, "other-project");
    const b = prepared(await preparePoolProject({ ...f.input, projectId: "other-project", cloneRoot: otherRoot }));
    assert.equal(b.projectRoot, otherRoot);
    assert.equal(b.cwd, join(f.workers, ".other-project_worktrees", "session", "creation-1"));
    assert.notEqual(a.cwd, b.cwd);
  }));

  await t.test("rejects a mismatched literal origin without changing dirty data", () => fixture(async (f) => {
    git(f.root, "clone", f.origin, f.cloneRoot);
    git(f.cloneRoot, "remote", "set-url", "origin", "https://different.invalid/repo.git");
    writeFileSync(join(f.cloneRoot, "tracked.txt"), "keep me\n");
    rejected(await preparePoolProject(f.input));
    assert.equal(git(f.cloneRoot, "config", "--get", "remote.origin.url"), "https://different.invalid/repo.git");
    assert.equal(readFileSync(join(f.cloneRoot, "tracked.txt"), "utf8"), "keep me\n");
    assert.equal(existsSync(worktree(f)), false);
  }));

  await t.test("preserves a pre-existing non-repository clone target", () => fixture(async (f) => {
    mkdirSync(f.cloneRoot);
    writeFileSync(join(f.cloneRoot, "private.txt"), "not ours\n");
    rejected(await preparePoolProject(f.input));
    assert.equal(readFileSync(join(f.cloneRoot, "private.txt"), "utf8"), "not ours\n");
    assert.equal(existsSync(worktree(f)), false);
  }));

  await t.test("rejects a clone-root symlink without touching its destination", () => fixture(async (f) => {
    const outside = join(f.root, "outside");
    git(f.root, "clone", f.origin, outside);
    writeFileSync(join(outside, "private.txt"), "outside\n");
    symlinkSync(outside, f.cloneRoot, "dir");
    rejected(await preparePoolProject(f.input));
    assert.equal(lstatSync(f.cloneRoot).isSymbolicLink(), true);
    assert.equal(readFileSync(join(outside, "private.txt"), "utf8"), "outside\n");
    assert.equal(existsSync(worktree(f)), false);
  }));

  await t.test("rejects symlinked worktree parents and leaves outside data alone", () => fixture(async (f) => {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "outside\n");
    symlinkSync(outside, join(f.workers, ".registered-project_worktrees"), "dir");
    rejected(await preparePoolProject(f.input));
    assert.deepEqual(readdirSync(outside), ["private.txt"]);
    assert.equal(readFileSync(join(outside, "private.txt"), "utf8"), "outside\n");
  }));

  await t.test("rejects a symlink at the session destination", () => fixture(async (f) => {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "outside\n");
    mkdirSync(join(f.workers, ".registered-project_worktrees", "session"), { recursive: true });
    symlinkSync(outside, worktree(f), "dir");
    rejected(await preparePoolProject(f.input));
    assert.equal(lstatSync(worktree(f)).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(outside), ["private.txt"]);
    assert.equal(readFileSync(join(outside, "private.txt"), "utf8"), "outside\n");
  }));

  await t.test("rejects an occupied worktree path without deleting its files", () => fixture(async (f) => {
    mkdirSync(worktree(f), { recursive: true });
    writeFileSync(join(worktree(f), "private.txt"), "pre-existing\n");
    rejected(await preparePoolProject(f.input));
    assert.equal(readFileSync(join(worktree(f), "private.txt"), "utf8"), "pre-existing\n");
  }));

  await t.test("does not relocate a conflicting existing session branch", () => fixture(async (f) => {
    git(f.root, "clone", f.origin, f.cloneRoot);
    const existing = join(f.root, "existing-session");
    git(f.cloneRoot, "worktree", "add", "-b", "session/creation-1", existing, "HEAD");
    writeFileSync(join(existing, "private.txt"), "existing session\n");
    rejected(await preparePoolProject(f.input));
    assert.equal(readFileSync(join(existing, "private.txt"), "utf8"), "existing session\n");
    assert.equal(existsSync(worktree(f)), false);
  }));

  await t.test("unpublished local refs do not become worker session bases", () => fixture(async (f) => {
    git(f.root, "clone", f.origin, f.cloneRoot);
    git(f.cloneRoot, "branch", "local-only");
    rejected(await preparePoolProject({ ...f.input, ref: "local-only" }));
    assert.equal(existsSync(worktree(f)), false);
    assert.equal(git(f.cloneRoot, "rev-parse", "local-only"), f.baseCommit);
  }));

  await t.test("accepts opaque creation IDs including underscore at the 128-character boundary", () => fixture(async (f) => {
    const creationId = `request_${"a".repeat(120)}`;
    const value = prepared(await preparePoolProject({ ...f.input, creationId }));
    assert.equal(value.cwd, worktree(f, creationId));
    assert.equal(git(value.cwd, "branch", "--show-current"), `session/${creationId}`);
  }));

  await t.test("unsafe origins and IDs cannot create paths or escape the worker root", () => fixture(async (f) => {
    for (const change of [
      { origin: `file://${f.remote}` },
      { origin: f.remote },
      { origin: "http://pool-fixture.invalid/repo.git" },
      { origin: "https://token@pool-fixture.invalid/repo.git" },
      { origin: "https://user:password@pool-fixture.invalid/repo.git" },
      { creationId: "../../escape" },
      { creationId: "bad/ref" },
      { creationId: "a".repeat(129) },
      { creationId: "has space" },
      { creationId: "" },
      { projectId: "../escape" },
    ]) rejected(await preparePoolProject({ ...f.input, ...change }));
    assert.deepEqual(readdirSync(f.workers), []);
    assert.equal(existsSync(join(f.root, "escape")), false);
  }));

  await t.test("authentication failure leaves no clone or launchable worktree", () => fixture(async (f) => {
    writeFileSync(f.ssh, '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 128\n', { mode: 0o700 });
    rejected(await preparePoolProject(f.input));
    assert.equal(existsSync(f.cloneRoot), false);
    assert.equal(existsSync(worktree(f)), false);
    assert.deepEqual(readdirSync(f.workers), []);
  }));

  await t.test("failed fetch preserves an existing dirty clone and unrelated files", () => fixture(async (f) => {
    git(f.root, "clone", f.origin, f.cloneRoot);
    writeFileSync(join(f.cloneRoot, "tracked.txt"), "local edit\n");
    writeFileSync(join(f.cloneRoot, "private.txt"), "untracked\n");
    writeFileSync(f.ssh, '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 128\n', { mode: 0o700 });
    rejected(await preparePoolProject(f.input));
    assert.equal(readFileSync(join(f.cloneRoot, "tracked.txt"), "utf8"), "local edit\n");
    assert.equal(readFileSync(join(f.cloneRoot, "private.txt"), "utf8"), "untracked\n");
    assert.equal(git(f.cloneRoot, "rev-parse", "HEAD"), f.baseCommit);
    assert.equal(existsSync(worktree(f)), false);
  }));
});
