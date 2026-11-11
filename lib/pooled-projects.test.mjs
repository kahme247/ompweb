import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const quotePath = (path) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-pool-project-")));
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  const origin = "https://pool-fixture.invalid/repo.git";
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const config = join(root, "gitconfig");
  const ssh = join(root, "ssh");
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_COUNT = "0";
    process.env.GIT_SSH_COMMAND = `sh ${quotePath(ssh)}`;
    process.env.GIT_SSH_VARIANT = "simple";
    writeFileSync(config, "");
    // Keep native drive letters out of the SSH URL; only the local upload-pack receives the path.
    writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack ${quotePath(remote)}\n`, { mode: 0o700 });
    git(root, "config", "--global", "url.ssh://fixture/repo.git.insteadOf", origin);
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
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

async function hostileGitEnvironment(run) {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "omp-pool-outside-")));
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  // Git for Windows maps /dev/null itself; Node's os.devNull (\\.\nul) is not a usable config path there.
  Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const repository = join(outside, "repository.git");
  const index = join(outside, "index");
  try {
    execFileSync("git", ["init", "--bare", repository], { env, stdio: ["ignore", "ignore", "pipe"] });
    const config = readFileSync(join(repository, "config"));
    writeFileSync(index, "outside index sentinel\n");
    Object.assign(process.env, {
      GIT_DIR: repository, GIT_COMMON_DIR: repository, GIT_WORK_TREE: outside,
      GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: join(repository, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repository, "objects"),
      GIT_CONFIG: join(repository, "config"), GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: outside,
      GIT_CONFIG_PARAMETERS: "'user.name=ambient-author'",
    });
    await run();
    assert.deepEqual(readFileSync(join(repository, "config")), config);
    assert.equal(readFileSync(index, "utf8"), "outside index sentinel\n");
    assert.deepEqual(readdirSync(outside).sort(), ["index", "repository.git"]);
    assert.equal(process.env.GIT_DIR, repository, "fixture restores its caller's ambient environment");
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(outside, { recursive: true, force: true });
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

  await t.test("fixture Git cannot write an ambient outside repository or index", () => hostileGitEnvironment(() => fixture(async (f) => {
    const value = prepared(await preparePoolProject(f.input));
    assert.equal(readFileSync(join(value.cwd, "tracked.txt"), "utf8"), "committed\n");
  })));

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

  await t.test("rejects a mismatched first origin even when the last literal matches", () => fixture(async (f) => {
    git(f.root, "clone", f.origin, f.cloneRoot);
    git(f.cloneRoot, "remote", "set-url", "origin", "https://different.invalid/repo.git");
    git(f.cloneRoot, "config", "--add", "remote.origin.url", f.origin);
    const contacted = join(f.root, "network-contacted");
    writeFileSync(f.ssh, `#!/bin/sh\necho contacted > ${quotePath(contacted)}\nexit 128\n`, { mode: 0o700 });
    writeFileSync(join(f.cloneRoot, "tracked.txt"), "keep me\n");
    rejected(await preparePoolProject(f.input));
    assert.equal(existsSync(contacted), false, "ambiguous origins fail before network access");
    assert.equal(readFileSync(join(f.cloneRoot, "tracked.txt"), "utf8"), "keep me\n");
    assert.equal(git(f.cloneRoot, "config", "--get-all", "remote.origin.url"), `https://different.invalid/repo.git\n${f.origin}`);
    assert.equal(existsSync(worktree(f)), false);
    for (const second of [f.origin, ""]) {
      git(f.cloneRoot, "config", "--unset-all", "remote.origin.url");
      git(f.cloneRoot, "config", "--add", "remote.origin.url", f.origin);
      git(f.cloneRoot, "config", "--add", "remote.origin.url", second);
      rejected(await preparePoolProject(f.input));
      assert.equal(existsSync(contacted), false, "duplicate and empty extra origins are also ambiguous");
      assert.equal(existsSync(worktree(f)), false);
    }
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

  await t.test("existing clone fetch cannot open its parent's controlling terminal", { skip: process.platform === "win32" }, () => fixture(async (f) => {
    git(f.root, "clone", f.origin, f.cloneRoot);
    const terminal = join(f.root, "fetch-terminal");
    const resultFile = join(f.root, "fetch-result.json");
    writeFileSync(f.ssh, `#!/bin/sh\nif (: </dev/tty) 2>/dev/null; then echo attached > ${quotePath(terminal)}; else echo detached > ${quotePath(terminal)}; fi\nexit 128\n`, { mode: 0o700 });
    const moduleUrl = new URL("./pooled-projects.ts", import.meta.url).href;
    const program = `const {preparePoolProject}=await import(${JSON.stringify(moduleUrl)}); const {writeFileSync}=await import("node:fs"); const {execFileSync}=await import("node:child_process"); execFileSync("sh",["-c","(: </dev/tty) 2>/dev/null"],{stdio:"ignore"}); writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(await preparePoolProject(${JSON.stringify(f.input)})));`;
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const args = process.platform === "darwin"
      ? ["-q", "/dev/null", process.execPath, "--eval", program]
      : ["-q", "-c", [process.execPath, "--eval", program].map(quote).join(" "), "/dev/null"];
    execFileSync("script", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    rejected(JSON.parse(readFileSync(resultFile, "utf8")));
    assert.equal(readFileSync(terminal, "utf8"), "detached\n");
    assert.equal(existsSync(worktree(f)), false);
  }));

  await t.test("a separate-process clone with valid HEAD cannot be consumed before its owner completes", () => fixture(async (f) => {
    const started = join(f.root, "post-checkout-started");
    const resultFile = join(f.root, "clone-result.json");
    const poolResultFile = join(f.root, "pool-result.json");
    const template = join(f.root, "template");
    mkdirSync(join(template, "hooks"), { recursive: true });
    // Git installs this real template hook; session worktree checkouts must not pause.
    writeFileSync(join(template, "hooks", "post-checkout"), `#!/bin/sh\nif [ "$(git rev-parse --show-toplevel)" = ${quotePath(f.cloneRoot)} ]; then echo paused > ${quotePath(started)}; while :; do sleep 1; done; fi\n`, { mode: 0o700 });
    git(f.root, "config", "--global", "init.templateDir", template);
    const cloneModule = new URL("./project-clone.ts", import.meta.url).href;
    const poolModule = new URL("./pooled-projects.ts", import.meta.url).href;
    const program = `const {cloneRepository}=await import(${JSON.stringify(cloneModule)}); const {writeFileSync}=await import("node:fs"); const controller=new AbortController(); process.stdin.once("data",()=>controller.abort()); const result=await cloneRepository({origin:${JSON.stringify(f.origin)},target:${JSON.stringify(f.cloneRoot)},signal:controller.signal}); writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result)); process.exit(0);`;
    const child = spawn(process.execPath, ["--eval", program], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();
    const closed = Promise.withResolvers();
    child.once("error", closed.reject);
    child.once("exit", closed.resolve);
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(started)) {
        assert.ok(Date.now() < deadline, "standalone clone did not reach its post-checkout hook");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(git(f.cloneRoot, "rev-parse", "--verify", "HEAD^{commit}"), f.baseCommit);
      assert.equal(readFileSync(join(f.cloneRoot, "tracked.txt"), "utf8"), "committed\n");
      const inode = lstatSync(f.cloneRoot).ino;
      writeFileSync(join(f.cloneRoot, "owned.txt"), "owned by standalone attempt\n");
      const poolProgram = `const {preparePoolProject}=await import(${JSON.stringify(poolModule)}); const {writeFileSync}=await import("node:fs"); writeFileSync(${JSON.stringify(poolResultFile)},JSON.stringify(await preparePoolProject(${JSON.stringify(f.input)})));`;
      execFileSync(process.execPath, ["--eval", poolProgram], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
      const result = JSON.parse(readFileSync(poolResultFile, "utf8"));
      rejected(result);
      assert.equal(result.status, 409, "valid HEAD does not relinquish the other process's clone ownership");
      assert.equal(lstatSync(f.cloneRoot).ino, inode);
      assert.equal(readFileSync(join(f.cloneRoot, "owned.txt"), "utf8"), "owned by standalone attempt\n");
      assert.equal(existsSync(worktree(f)), false);
    } finally {
      child.stdin.end("cancel\n");
      assert.equal(await closed.promise, 0);
    }
    rejected(JSON.parse(readFileSync(resultFile, "utf8")));
    assert.equal(existsSync(f.cloneRoot), false, "only the standalone clone owner cleans its cancelled target");
    assert.deepEqual(readdirSync(f.workers), [], "completed cancellation releases its reservation too");
  }));
});
