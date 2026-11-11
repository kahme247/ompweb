import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

const quotePath = (path) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-clone-route-")));
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
  const origin = "https://clone-fixture.invalid/repo.git";
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const parent = join(root, "projects");
  const ssh = join(root, "ssh");
  const config = join(root, "gitconfig");
  const cleanup = [];
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_COUNT = "0";
    process.env.GIT_SSH_COMMAND = `sh ${quotePath(ssh)}`;
    process.env.GIT_SSH_VARIANT = "simple";
    writeFileSync(config, "");
    writeFileSync(ssh, `#!/bin/sh\nexec git-upload-pack ${quotePath(remote)}\n`, { mode: 0o700 });
    git(root, "config", "--global", "url.ssh://fixture/repo.git.insteadOf", origin);
    git(root, "init", "--bare", "--initial-branch=main", remote);
    git(root, "init", "--initial-branch=main", source);
    git(source, "config", "user.name", "Clone fixture");
    git(source, "config", "user.email", "clone@example.invalid");
    writeFileSync(join(source, "tracked.txt"), "committed\n");
    git(source, "add", ".");
    git(source, "-c", "commit.gpgsign=false", "commit", "-qm", "initial");
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "main");
    mkdirSync(parent);
    await run({ root, source, remote, origin, parent, ssh, cleanup, target: join(parent, "repo") });
  } finally {
    for (const close of cleanup) await close();
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

async function hostileGitEnvironment(run) {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "omp-clone-outside-")));
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

const request = (method, body, signal) => new Request("http://localhost/api/projects/clone", {
  method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal,
});

async function frames(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  const text = await response.text();
  assert.ok(text.endsWith("\n"), "terminal frame remains NDJSON");
  const values = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(values.filter((value) => value.type !== "output").length, 1, "exactly one terminal frame");
  assert.notEqual(values.at(-1).type, "output");
  return values;
}

async function until(event, message) {
  let timer;
  try {
    await Promise.race([event, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function blockTransport(f) {
  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  let socket;
  const server = createServer((peer) => {
    socket = peer;
    peer.once("close", stopped.resolve);
    peer.resume();
    started.resolve();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  f.cleanup.push(() => new Promise((resolve) => {
    socket?.destroy();
    server.close(resolve);
  }));
  // This real descendant holds Git's pipes and socket until either POSIX group kill or Windows taskkill.
  const script = join(f.root, "transport.cjs");
  writeFileSync(script, `require("node:net").connect(${server.address().port}, "127.0.0.1").resume();\n`);
  writeFileSync(f.ssh, `#!/bin/sh\nexec ${quotePath(process.execPath)} ${quotePath(script)}\n`, { mode: 0o700 });
  return { started: started.promise, stopped: stopped.promise };
}

function reject(result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.value, undefined);
  assert.equal(typeof result.code, "string");
  assert.equal(typeof result.error, "string");
}

test("shared clone execution retains validation and attempt ownership", async (t) => {
  const { cloneRepository, withProjectReservation } = await import("./project-clone.ts");

  await t.test("fixture Git cannot write an ambient outside repository or index", () => hostileGitEnvironment(() => fixture(async (f) => {
    const result = await cloneRepository({ origin: f.origin, target: f.target });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(join(f.target, "tracked.txt"), "utf8"), "committed\n");
  })));

  await t.test("a reservation owner never unlinks a replaced foreign reservation", () => fixture(async (f) => {
    let replacement;
    const result = await withProjectReservation(f.target, async () => {
      const entries = readdirSync(f.parent);
      assert.equal(entries.length, 1);
      replacement = join(f.parent, entries[0]);
      rmSync(replacement);
      writeFileSync(replacement, "foreign owner\n");
      return { ok: true, value: null };
    });
    reject(result);
    assert.equal(result.status, 409);
    assert.equal(readFileSync(replacement, "utf8"), "foreign owner\n");
    assert.equal(existsSync(f.target), false);
  }));

  await t.test("abort after clone success cannot remove its published repository", () => fixture(async (f) => {
    const controller = new AbortController();
    const result = await cloneRepository({ origin: f.origin, target: f.target, signal: controller.signal });
    assert.equal(result.ok, true, JSON.stringify(result));
    controller.abort();
    assert.equal(git(f.target, "rev-parse", "HEAD"), git(f.source, "rev-parse", "HEAD"));
    assert.equal(readFileSync(join(f.target, "tracked.txt"), "utf8"), "committed\n");
    assert.deepEqual(readdirSync(f.parent), ["repo"]);
  }));

  await t.test("clones through the allowed transport and reports actual progress", () => fixture(async (f) => {
    const output = [];
    const result = await cloneRepository({ origin: f.origin, target: f.target, signal: new AbortController().signal, onOutput: (text) => output.push(text) });
    assert.deepEqual(result, { ok: true, value: { path: f.target } });
    assert.equal(git(f.target, "config", "--get", "remote.origin.url"), f.origin);
    assert.equal(readFileSync(join(f.target, "tracked.txt"), "utf8"), "committed\n");
    assert.match(output.join(""), /Cloning into/);
  }));

  await t.test("cannot weaken transport validation for local fixtures", () => fixture(async (f) => {
    for (const origin of [f.remote, `file://${f.remote}`, "http://clone-fixture.invalid/repo.git", "--upload-pack=evil"]) {
      reject(await cloneRepository({ origin, target: f.target, signal: new AbortController().signal }));
      assert.equal(existsSync(f.target), false);
    }
  }));

  await t.test("an existing target is never owned or removed by this attempt", () => fixture(async (f) => {
    mkdirSync(f.target);
    writeFileSync(join(f.target, "private.txt"), "keep\n");
    const controller = new AbortController();
    controller.abort();
    reject(await cloneRepository({ origin: f.origin, target: f.target, signal: controller.signal }));
    assert.equal(readFileSync(join(f.target, "private.txt"), "utf8"), "keep\n");
  }));

  await t.test("credential failure is noninteractive and cleans only its own target", () => fixture(async (f) => {
    const environment = join(f.root, "credential-environment");
    writeFileSync(f.ssh, `#!/bin/sh\nprintf '%s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$SSH_ASKPASS" "$GIT_ALLOW_PROTOCOL" > ${quotePath(environment)}\necho 'Permission denied (publickey).' >&2\nexit 128\n`, { mode: 0o700 });
    const sibling = join(f.parent, "unrelated");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "private.txt"), "keep\n");
    reject(await cloneRepository({ origin: f.origin, target: f.target, signal: new AbortController().signal }));
    assert.deepEqual(readFileSync(environment, "utf8").split("\n"), ["0", "", "", "https:ssh", ""]);
    assert.equal(existsSync(f.target), false);
    assert.equal(readFileSync(join(sibling, "private.txt"), "utf8"), "keep\n");
  }));

  await t.test("cancellation terminates descendants and removes only the attempt-owned target", () => fixture(async (f) => {
    const { started, stopped } = await blockTransport(f);
    const controller = new AbortController();
    const pending = cloneRepository({ origin: f.origin, target: f.target, signal: controller.signal });
    await until(started, "SSH descendant did not start");
    controller.abort();
    reject(await pending);
    await until(stopped, "SSH descendant survived process-group cancellation");
    assert.equal(existsSync(f.target), false);
    assert.deepEqual(readdirSync(f.parent), []);
  }));
});

test("standalone clone route preserves streamed progress and terminal frames", async (t) => {
  const { POST, DELETE } = await import("../app/api/projects/clone/route.ts");
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const hub = await import("./hosts/hub.ts");
  const nativeFixture = (run) => fixture(async (f) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(f.root, "agent");
    const link = await linkLocalDaemon();
    try {
      const selected = await hub.getHost("local").sessionOps.validateCwd(f.parent);
      assert.equal(selected.ok, true);
      await run(f);
    } finally {
      hub.closeHostLink("local");
      await link.workspace.stop();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  await t.test("an active native destination reservation returns HTTP 409 without another clone", () => nativeFixture(async (f) => {
    const { started, stopped } = await blockTransport(f);
    const first = await POST(request("POST", { id: "route-reservation-owner", parent: f.parent, url: f.origin }), { disableIdleTimeout() {} });
    await until(started, "the reservation owner's SSH descendant did not start");
    const response = await POST(request("POST", { id: "route-reserved", parent: f.parent, url: f.origin }), { disableIdleTimeout() { assert.fail("reservation conflict cannot start a stream"); } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "clone_target_exists");
    assert.equal(existsSync(f.target), true, "the first attempt keeps its destination");
    assert.equal((await DELETE(request("DELETE", { id: "route-reservation-owner" }))).status, 200);
    assert.equal((await frames(first)).at(-1).type, "cancelled");
    await until(stopped, "the reservation owner's SSH descendant survived cancellation");
    assert.deepEqual(readdirSync(f.parent), []);
  }));

  await t.test("success emits progress then exactly one done frame", () => nativeFixture(async (f) => {
    let idleDisabled = false;
    const response = await POST(request("POST", { id: "route-success", parent: f.parent, url: f.origin }), { disableIdleTimeout: () => { idleDisabled = true; } });
    const values = await frames(response);
    assert.equal(idleDisabled, true);
    assert.ok(values.some((value) => value.type === "output" && value.text.length > 0));
    assert.deepEqual(values.at(-1), { type: "done", path: f.target });
    assert.equal(git(f.target, "config", "--get", "remote.origin.url"), f.origin);
    const replay = await DELETE(request("DELETE", { id: "route-success" }));
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).frames.at(-1), { type: "done", path: f.target });
  }));

  await t.test("authentication failure emits terminal error and cleans its target", () => nativeFixture(async (f) => {
    writeFileSync(f.ssh, '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 128\n', { mode: 0o700 });
    const response = await POST(request("POST", { id: "route-auth", parent: f.parent, url: f.origin }), { disableIdleTimeout() {} });
    const values = await frames(response);
    assert.ok(values.some((value) => value.type === "output" && value.text.includes("Permission denied")));
    assert.equal(values.at(-1).type, "error");
    assert.equal(values.at(-1).code, "clone_failed");
    assert.equal(existsSync(f.target), false);
  }));

  await t.test("conflicting target returns 409 and preserves existing files", () => nativeFixture(async (f) => {
    mkdirSync(f.target);
    writeFileSync(join(f.target, "private.txt"), "keep\n");
    const response = await POST(request("POST", { id: "route-conflict", parent: f.parent, url: f.origin }), { disableIdleTimeout() { assert.fail("conflict cannot start a stream"); } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "clone_target_exists");
    assert.equal(readFileSync(join(f.target, "private.txt"), "utf8"), "keep\n");
  }));

  await t.test("DELETE cancels the entire process group and emits terminal cancelled", () => nativeFixture(async (f) => {
    const { started, stopped } = await blockTransport(f);
    const response = await POST(request("POST", { id: "route-cancel", parent: f.parent, url: f.origin }), { disableIdleTimeout() {} });
    const pending = frames(response);
    await until(started, "SSH descendant did not start");
    assert.equal((await DELETE(request("DELETE", { id: "route-cancel" }))).status, 200);
    const values = await pending;
    assert.deepEqual(values.at(-1), { type: "cancelled", path: f.target });
    await until(stopped, "SSH descendant survived cancellation");
    assert.equal(existsSync(f.target), false);
    const replay = await DELETE(request("DELETE", { id: "route-cancel" }));
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).frames.at(-1), { type: "cancelled", path: f.target });
  }));

  await t.test("request disconnect still performs cancellation and owned cleanup", () => nativeFixture(async (f) => {
    const { started, stopped } = await blockTransport(f);
    const controller = new AbortController();
    const response = await POST(request("POST", { id: "route-disconnect", parent: f.parent, url: f.origin }, controller.signal), { disableIdleTimeout() {} });
    const pending = frames(response);
    await until(started, "SSH descendant did not start");
    controller.abort();
    assert.deepEqual((await pending).at(-1), { type: "cancelled", path: f.target });
    await until(stopped, "SSH descendant survived disconnect");
    assert.equal(existsSync(f.target), false);
  }));
});
