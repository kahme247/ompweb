import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-clone-route-")));
  const keys = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const origin = "https://clone-fixture.invalid/repo.git";
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const parent = join(root, "projects");
  const ssh = join(root, "ssh");
  const config = join(root, "gitconfig");
  try {
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_COUNT = "0";
    process.env.GIT_SSH_COMMAND = ssh;
    writeFileSync(config, "");
    writeFileSync(ssh, '#!/bin/sh\nif [ "$1" = "-G" ]; then exit 1; fi\nfor command do :; done\nexec sh -c "$command"\n', { mode: 0o700 });
    git(root, "config", "--global", `url.ssh://fixture${remote}.insteadOf`, origin);
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
    await run({ root, source, remote, origin, parent, ssh, target: join(parent, "repo") });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
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

async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function blockTransport(f) {
  const started = join(f.root, "transport-started");
  const stopped = join(f.root, "descendant-stopped");
  // A real descendant holds Git's output pipes: killing only Git cannot finish the response.
  writeFileSync(f.ssh, `#!/bin/sh\nif [ "$1" = "-G" ]; then exit 1; fi\nsh -c 'trap "echo stopped > ${stopped}; exit 0" TERM; echo started > ${started}; while :; do sleep 1; done' &\nwait\n`, { mode: 0o700 });
  return { started, stopped };
}

function reject(result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.value, undefined);
  assert.equal(typeof result.code, "string");
  assert.equal(typeof result.error, "string");
}

test("shared clone execution retains validation and attempt ownership", async (t) => {
  const { cloneRepository } = await import("./project-clone.ts");

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
    writeFileSync(f.ssh, `#!/bin/sh\nif [ "$1" = "-G" ]; then exit 1; fi\nprintf '%s\\n' "$GIT_TERMINAL_PROMPT" "$GIT_ASKPASS" "$SSH_ASKPASS" "$GIT_ALLOW_PROTOCOL" > '${environment}'\necho 'Permission denied (publickey).' >&2\nexit 128\n`, { mode: 0o700 });
    const sibling = join(f.parent, "unrelated");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "private.txt"), "keep\n");
    reject(await cloneRepository({ origin: f.origin, target: f.target, signal: new AbortController().signal }));
    assert.deepEqual(readFileSync(environment, "utf8").split("\n"), ["0", "", "", "https:ssh", ""]);
    assert.equal(existsSync(f.target), false);
    assert.equal(readFileSync(join(sibling, "private.txt"), "utf8"), "keep\n");
  }));

  await t.test("cancellation terminates descendants and removes only the attempt-owned target", () => fixture(async (f) => {
    const { started, stopped } = blockTransport(f);
    const controller = new AbortController();
    const pending = cloneRepository({ origin: f.origin, target: f.target, signal: controller.signal });
    await until(() => existsSync(started), "SSH descendant did not start");
    controller.abort();
    reject(await pending);
    await until(() => existsSync(stopped), "SSH descendant survived process-group cancellation");
    assert.equal(existsSync(f.target), false);
    assert.deepEqual(readdirSync(f.parent), []);
  }));
});

test("standalone clone route preserves streamed progress and terminal frames", async (t) => {
  const { POST, DELETE } = await import("../app/api/projects/clone/route.ts");

  await t.test("success emits progress then exactly one done frame", () => fixture(async (f) => {
    let idleDisabled = false;
    const response = await POST(request("POST", { id: "route-success", parent: f.parent, url: f.origin }), { disableIdleTimeout: () => { idleDisabled = true; } });
    const values = await frames(response);
    assert.equal(idleDisabled, true);
    assert.ok(values.some((value) => value.type === "output" && value.text.length > 0));
    assert.deepEqual(values.at(-1), { type: "done", path: f.target });
    assert.equal(git(f.target, "config", "--get", "remote.origin.url"), f.origin);
    assert.equal((await DELETE(request("DELETE", { id: "route-success" }))).status, 404);
  }));

  await t.test("authentication failure emits terminal error and cleans its target", () => fixture(async (f) => {
    writeFileSync(f.ssh, '#!/bin/sh\necho "Permission denied (publickey)." >&2\nexit 128\n', { mode: 0o700 });
    const response = await POST(request("POST", { id: "route-auth", parent: f.parent, url: f.origin }), { disableIdleTimeout() {} });
    const values = await frames(response);
    assert.ok(values.some((value) => value.type === "output" && value.text.includes("Permission denied")));
    assert.equal(values.at(-1).type, "error");
    assert.equal(values.at(-1).code, "clone_failed");
    assert.equal(existsSync(f.target), false);
  }));

  await t.test("conflicting target returns 409 and preserves existing files", () => fixture(async (f) => {
    mkdirSync(f.target);
    writeFileSync(join(f.target, "private.txt"), "keep\n");
    const response = await POST(request("POST", { id: "route-conflict", parent: f.parent, url: f.origin }), { disableIdleTimeout() { assert.fail("conflict cannot start a stream"); } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "clone_target_exists");
    assert.equal(readFileSync(join(f.target, "private.txt"), "utf8"), "keep\n");
  }));

  await t.test("DELETE cancels the entire process group and emits terminal cancelled", () => fixture(async (f) => {
    const { started, stopped } = blockTransport(f);
    const response = await POST(request("POST", { id: "route-cancel", parent: f.parent, url: f.origin }), { disableIdleTimeout() {} });
    const pending = frames(response);
    await until(() => existsSync(started), "SSH descendant did not start");
    assert.equal((await DELETE(request("DELETE", { id: "route-cancel" }))).status, 200);
    const values = await pending;
    assert.deepEqual(values.at(-1), { type: "cancelled", path: f.target });
    await until(() => existsSync(stopped), "SSH descendant survived cancellation");
    assert.equal(existsSync(f.target), false);
    assert.equal((await DELETE(request("DELETE", { id: "route-cancel" }))).status, 404);
  }));

  await t.test("request disconnect still performs cancellation and owned cleanup", () => fixture(async (f) => {
    const { started, stopped } = blockTransport(f);
    const controller = new AbortController();
    const response = await POST(request("POST", { id: "route-disconnect", parent: f.parent, url: f.origin }, controller.signal), { disableIdleTimeout() {} });
    const pending = frames(response);
    await until(() => existsSync(started), "SSH descendant did not start");
    controller.abort();
    assert.deepEqual((await pending).at(-1), { type: "cancelled", path: f.target });
    await until(() => existsSync(stopped), "SSH descendant survived disconnect");
    assert.equal(existsSync(f.target), false);
  }));
});
