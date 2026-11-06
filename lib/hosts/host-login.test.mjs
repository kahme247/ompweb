import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-host-links-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const directory = join(agentDir, "omp-web");
const file = join(directory, "host.json");
const lock = `${file}.lock`;
const primary = { url: "https://production.example", token: "production-token" };
const staging = { url: "http://127.0.0.1:40000", token: "staging-token" };
const other = { url: "https://other.example", token: "other-token" };
const { addHostLink, loginHost, readHostLinks, readHostLogin, removeHostLink } = await import("./host-login.ts");
const saved = () => JSON.parse(readFileSync(file, "utf8"));
const seed = (value) => writeFileSync(file, JSON.stringify(value));
beforeEach(() => {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
});
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

test("legacy login reads one normalized link without changing the legacy reader", () => {
  assert.deepEqual(readHostLinks(), []);
  seed({ ...primary, url: `${primary.url}///` });
  assert.deepEqual(readHostLinks(), [primary]);
  assert.deepEqual(readHostLogin(), { ...primary, url: `${primary.url}///` });
});

test("explicit empty links never falls back to the legacy primary", async () => {
  seed({ ...primary, links: [] });
  assert.deepEqual(readHostLinks(), []);
  await removeHostLink(primary.url);
  assert.deepEqual(saved(), { ...primary, links: [] });
});

test("add upserts only its URL and preserves root and entry metadata", async () => {
  seed({ ...primary, note: { keep: true }, links: [{ ...primary, label: "production" }, { ...staging, label: "staging" }] });
  await addHostLink({ url: `${staging.url}/`, token: " new-token \n" });
  assert.deepEqual(saved(), { ...primary, note: { keep: true }, links: [{ ...primary, label: "production" }, { ...staging, token: "new-token", label: "staging" }] });
  assert.equal(existsSync(lock), false);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("first add establishes the legacy primary and remove never deletes it", async () => {
  await addHostLink(primary);
  await addHostLink(staging);
  await removeHostLink(`${staging.url}/`);
  assert.deepEqual(saved(), { ...primary, links: [primary] });
  await removeHostLink(primary.url);
  assert.deepEqual(saved(), { ...primary, links: [] });
  assert.deepEqual(readHostLinks(), []);
});

test("login replaces the primary link but retains secondary links and unknown keys", async () => {
  seed({ ...primary, note: "keep", links: [primary, staging] });
  await loginHost(other);
  assert.deepEqual(readHostLogin(), other);
  assert.deepEqual(saved(), { ...other, note: "keep", links: [staging, other] });
});

test("login updating the same primary URL preserves its entry metadata", async () => {
  seed({ ...primary, links: [{ ...primary, label: "production" }, staging] });
  await loginHost({ ...primary, token: "rotated" });
  assert.deepEqual(saved(), { ...primary, token: "rotated", links: [{ ...primary, token: "rotated", label: "production" }, staging] });
});

test("add rotating the legacy primary's token updates the top-level pair that v6 daemons read", async () => {
  seed({ ...primary, links: [primary, staging] });
  await addHostLink({ ...primary, token: "rotated" });
  assert.deepEqual(saved(), { ...primary, token: "rotated", links: [{ ...primary, token: "rotated" }, staging] });
  seed({ ...primary, url: `${primary.url}/`, links: [primary, staging] });
  await addHostLink({ ...primary, token: "again" });
  assert.deepEqual(readHostLogin(), { ...primary, token: "again" });
  await addHostLink({ ...staging, token: "other" });
  assert.deepEqual(readHostLogin(), { ...primary, token: "again" });
});

test("malformed or unreadable configuration is never silently replaced", async () => {
  for (const contents of ["{broken", "null", "[]", '{"links":null}', '{"links":[{"url":"https://example.com"}]}', '{"url":123,"token":"keep"}']) {
    writeFileSync(file, contents);
    assert.throws(() => readHostLinks(), { name: "HostLoginUnreadableError" });
    assert.equal(readHostLogin(), null);
    for (const mutate of [() => addHostLink(staging), () => loginHost(staging), () => removeHostLink(primary.url)]) {
      await assert.rejects(mutate, { name: "HostLoginUnreadableError" });
      assert.equal(readFileSync(file, "utf8"), contents);
      assert.equal(existsSync(lock), false);
    }
  }
  rmSync(file);
  mkdirSync(file);
  await assert.rejects(addHostLink(staging), { name: "HostLoginUnreadableError" });
  assert.equal(statSync(file).isDirectory(), true);
});

test("invalid inputs fail before changing saved credentials", async () => {
  seed(primary);
  await assert.rejects(addHostLink({ url: "file:///tmp/server", token: "token" }), /https/);
  await assert.rejects(loginHost({ url: primary.url, token: " \n " }), /empty/);
  assert.deepEqual(saved(), primary);
});

async function exitedChildPid() {
  const child = spawn("node", ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return child.pid;
}

test("a lock with a proven exited owner is recovered, even when freshly written", async () => {
  seed(primary);
  writeFileSync(lock, JSON.stringify({ pid: await exitedChildPid() }), { mode: 0o600 });
  await addHostLink(staging);
  assert.deepEqual(saved(), { ...primary, links: [primary, staging] });
  assert.equal(existsSync(lock), false);
});

test("a recovery mutex held by a live process blocks recovery until it is released", { timeout: 10_000 }, async () => {
  seed(primary);
  const stale = JSON.stringify({ pid: await exitedChildPid() }), mutex = `${lock}.recover`;
  writeFileSync(lock, stale, { mode: 0o600 });
  writeFileSync(mutex, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const mutation = addHostLink(staging);
  await sleep(300);
  assert.equal(readFileSync(lock, "utf8"), stale);
  rmSync(mutex);
  await mutation;
  assert.deepEqual(saved(), { ...primary, links: [primary, staging] });
  assert.equal(existsSync(mutex), false);
});

test("a recovery mutex whose owner exited does not block recovery forever", { timeout: 10_000 }, async () => {
  seed(primary);
  const dead = JSON.stringify({ pid: await exitedChildPid() }), mutex = `${lock}.recover`;
  writeFileSync(lock, dead, { mode: 0o600 });
  writeFileSync(mutex, dead, { mode: 0o600 });
  await addHostLink(staging);
  assert.deepEqual(saved(), { ...primary, links: [primary, staging] });
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(mutex), false);
});

test("a live owner's lock times out asynchronously without removing the lock", { timeout: 10_000 }, async () => {
  seed(primary);
  const owner = JSON.stringify({ pid: process.pid });
  writeFileSync(lock, owner, { mode: 0o600 });
  const start = Date.now();
  const mutation = addHostLink(staging);
  await sleep(25);
  assert.ok(Date.now() - start < 1_000, "waiting for a lock must not block the event loop");
  assert.equal(readFileSync(lock, "utf8"), owner);
  await assert.rejects(mutation, /lock.*timed out|timed out.*lock/i);
  assert.ok(Date.now() - start >= 4_900);
  assert.ok(Date.now() - start < 8_000);
  assert.equal(readFileSync(lock, "utf8"), owner);
  assert.deepEqual(saved(), primary);
});

test("unknown lock ownership is not treated as a dead process", { timeout: 10_000 }, async () => {
  writeFileSync(lock, "{incomplete");
  await assert.rejects(addHostLink(staging), /lock.*timed out|timed out.*lock/i);
  assert.equal(readFileSync(lock, "utf8"), "{incomplete");
  assert.equal(existsSync(file), false);
});

const bin = fileURLToPath(new URL("../../bin/omp-web.js", import.meta.url));
function writer(t, args, token) {
  const child = spawn("node", [bin, "host", "login", ...args], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(`${token}\n`);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)));
  });
}

test("concurrent child writers retain both links and the legacy primary", { timeout: 20_000 }, async (t) => {
  seed(primary);
  await Promise.all([
    writer(t, ["--add", "--url", staging.url], staging.token),
    writer(t, ["--add", "--url", other.url], other.token),
  ]);
  assert.deepEqual(readHostLogin(), primary);
  assert.deepEqual(new Map(readHostLinks().map((link) => [link.url, link.token])), new Map([primary, staging, other].map((link) => [link.url, link.token])));
});

test("legacy login and concurrent add retain the additional entry", { timeout: 20_000 }, async (t) => {
  seed(primary);
  await Promise.all([
    writer(t, ["--url", other.url], other.token),
    writer(t, ["--add", "--url", staging.url], staging.token),
  ]);
  assert.deepEqual(readHostLogin(), other);
  assert.deepEqual(new Map(readHostLinks().map((link) => [link.url, link.token])), new Map([staging, other].map((link) => [link.url, link.token])));
});
