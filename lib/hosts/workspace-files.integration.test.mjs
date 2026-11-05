import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, symlinkSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { join } from "node:path";
import test, { before, after } from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

let h, owner;
before(async () => {
  h = await workspaceHarness();
  owner = await h.startHost();
  const selected = await owner.host.sessionOps.validateCwd(owner.project);
  assert.equal(selected.ok, true);
});
after(async () => h?.close());

test("a remote workspace read returns its file after daemon-owned cwd selection", async () => {
  const file = join(owner.project, "remote.txt");
  writeFileSync(file, "bytes on the selected host\n");
  const res = await h.file(owner.id, file);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { content: "bytes on the selected host\n", language: "text", size: 27 });
});

test("an invalid requested filename does not masquerade as unavailable credential metadata", async () => {
  const response = await h.file(owner.id, join(owner.project, "invalid\0name.txt"));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "file_not_found");
});

test("workspace listing admits hidden items only when requested without broadening authorization", async () => {
  const directory = join(owner.project, "tree");
  mkdirSync(join(directory, "build"), { recursive: true });
  writeFileSync(join(directory, "source.txt"), "source");
  const normal = await h.file(owner.id, directory, "list");
  assert.equal(normal.status, 200);
  assert.deepEqual((await normal.json()).entries.map((entry) => entry.name), ["source.txt"]);
  const hidden = await h.file(owner.id, directory, "list", { hidden: "1" });
  assert.deepEqual((await hidden.json()).entries.map((entry) => entry.name), ["build", "source.txt"]);
  const outside = join(h.root, "unselected");
  mkdirSync(outside);
  assert.equal((await h.file(owner.id, outside, "list", { hidden: "1" })).status, 403);
});

test("credential symlinks and unselected files cannot be read through workspace roots", async () => {
  const secret = join(owner.agentDir, "agent.db");
  writeFileSync(secret, "secret credentials");
  const alias = join(owner.project, "harmless.txt");
  symlinkSync(secret, alias);
  assert.equal((await h.file(owner.id, alias)).status, 403);
  assert.equal((await h.file(owner.id, secret, "download")).status, 403);
});

test("preview boundaries do not cap downloads and suffix ranges preserve bytes", async () => {
  const file = join(owner.project, "preview.txt");
  writeFileSync(file, Buffer.alloc(256 * 1024, 120));
  assert.equal((await h.file(owner.id, file)).status, 200);
  writeFileSync(file, Buffer.alloc(256 * 1024 + 1, 121));
  assert.equal((await h.file(owner.id, file)).status, 413);
  const suffix = await h.file(owner.id, file, "download", {}, { range: "bytes=-3" });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), "bytes 262142-262144/262145");
  assert.equal(await suffix.text(), "yyy");
  assert.equal((await h.file(owner.id, file, "download", {}, { range: "bytes=300000-" })).status, 416);
  const empty = join(owner.project, "empty.txt");
  writeFileSync(empty, "");
  const zero = await h.file(owner.id, empty, "download");
  assert.equal(zero.status, 200);
  assert.equal(await zero.text(), "");
});

test("a download larger than one link result is streamed byte-exact", async () => {
  const file = join(owner.project, "large.bin");
  const size = 64 * 1024 * 1024 + 17;
  const fd = openSync(file, "w");
  ftruncateSync(fd, size);
  closeSync(fd);
  const response = await h.file(owner.id, file, "download");
  assert.equal(response.status, 200);
  const actual = createHash("sha256");
  let received = 0;
  for await (const chunk of response.body) { received += chunk.byteLength; actual.update(chunk); }
  const expected = createHash("sha256");
  const zero = Buffer.alloc(64 * 1024);
  for (let at = 0; at < size; at += zero.length) expected.update(zero.subarray(0, Math.min(zero.length, size - at)));
  assert.equal(received, size);
  assert.equal(actual.digest("hex"), expected.digest("hex"));
});

test("a session reference permits only its owning host and never grants directory listing", async () => {
  const id = randomUUID();
  const outside = join(owner.home, "referenced.txt");
  writeFileSync(outside, "referenced on this host");
  const dir = join(owner.agentDir, "sessions", "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-11-03_${id}.jsonl`), [
    { type: "session", version: 3, id, cwd: owner.project, timestamp: "2026-11-03T00:00:00Z" },
    { type: "message", id: "ref-entry", parentId: null, message: { role: "assistant", content: [{ type: "text", text: outside }] } },
  ].map(JSON.stringify).join("\n") + "\n");
  owner.host.invalidateSessionLists();
  const allowed = await h.file(owner.id, outside, "read", { sessionId: id });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).content, "referenced on this host");
  assert.equal((await h.file(owner.id, owner.home, "list", { sessionId: id })).status, 403);
  const other = await h.startHost();
  assert.equal((await h.file(other.id, outside, "read", { sessionId: id })).status, 409);
});

test("an older linked daemon refuses workspace access instead of reading main's disk", async () => {
  const { linkHost } = await import("./link-driver.test-helper.mjs");
  const older = await linkHost("Old daemon");
  try {
    const response = await h.file(older.id, join(owner.project, "remote.txt"));
    assert.equal(response.status, 501);
    assert.equal((await response.json()).code, "workspace_unsupported");
  } finally { older.drop(); }
});

test("a malformed file result from a linked host is refused at the boundary", async () => {
  const { linkHost } = await import("./link-driver.test-helper.mjs");
  const bad = await linkHost("Malformed daemon", { hello: { workspaceOps: ["fileInfo"] } });
  bad.serve({ fileInfo: () => ({ ok: true, value: { path: "/secret", size: "not a byte count" } }) });
  try {
    const response = await h.file(bad.id, "/secret");
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "host_bad_result");
  } finally { bad.drop(); }
});
