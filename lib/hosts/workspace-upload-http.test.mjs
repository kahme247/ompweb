import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

test("HTTP publication replays a successful upload receipt without replacing a later file or directory", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost(); await owner.host.sessionOps.validateCwd(owner.project);
  const id = randomUUID(), name = "receipt.txt", bytes = Buffer.from("original upload bytes");
  const headers = { "content-type": "application/json" };
  const start = await fetch(`${f.url}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ id, host: owner.id, name, size: bytes.length, type: "text/plain" }) });
  assert.equal(start.status, 200);
  const chunk = await fetch(`${f.url}/api/uploads/${id}?offset=0`, { method: "PUT", body: bytes });
  assert.equal(chunk.status, 200);
  const url = `${f.url}/api/files/${encodeURIComponent(owner.project)}?${new URLSearchParams({ hostId: owner.id, type: "upload", conflict: "error" })}`;
  const publish = () => fetch(url, { method: "POST", headers, body: JSON.stringify({ uploads: [{ id, name }] }) });
  const first = await publish(); assert.equal(first.status, 200); const receipt = await first.json();
  const target = join(owner.project, name); writeFileSync(target, "later user edit");
  const replay = await publish(); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), receipt);
  assert.equal(readFileSync(target, "utf8"), "later user edit");
  rmSync(target); mkdirSync(target); writeFileSync(join(target, "keep.txt"), "directory replacement");
  const directoryReplay = await publish(); assert.equal(directoryReplay.status, 200); assert.deepEqual(await directoryReplay.json(), receipt);
  assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "directory replacement");
});

test("the actual Node daemon publishes a cross-device staged file with bounded copying", { skip: process.platform !== "linux" || !existsSync("/dev/shm") }, async (t) => {
  const agentDir = mkdtempSync("/dev/shm/omp-workspace-copy-");
  let f;
  t.after(async () => { await f?.close(); rmSync(agentDir, { recursive: true, force: true }); });
  f = await workspaceHarness();
  const owner = await f.startHost(false, agentDir);
  await owner.host.sessionOps.validateCwd(owner.project);
  assert.notEqual(statSync(agentDir).dev, statSync(owner.project).dev, "this smoke requires genuinely different filesystems");
  const id = randomUUID(), name = "cross-device.bin", size = 8 * 1024 * 1024;
  const headers = { "content-type": "application/json" };
  assert.equal((await fetch(`${f.url}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ id, host: owner.id, name, size, type: "application/octet-stream" }) })).status, 200);
  const bytes = Buffer.alloc(1024 * 1024, 0x5d), expected = createHash("sha256");
  for (let at = 0; at < size; at += bytes.length) {
    assert.equal((await fetch(`${f.url}/api/uploads/${id}?offset=${at}`, { method: "PUT", body: bytes })).status, 200);
    expected.update(bytes);
  }
  const url = `${f.url}/api/files/${encodeURIComponent(owner.project)}?${new URLSearchParams({ hostId: owner.id, type: "upload", conflict: "error" })}`;
  const published = await fetch(url, { method: "POST", headers, body: JSON.stringify({ uploads: [{ id, name }] }) });
  assert.equal(published.status, 200);
  const target = join(owner.project, name), actual = createHash("sha256");
  for await (const chunk of createReadStream(target)) actual.update(chunk);
  assert.equal(statSync(target).size, size);
  assert.equal(actual.digest("hex"), expected.digest("hex"));
});

test("publication returns a real conflict for a new upload and a mixed outcome only when some files succeed", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost(); await owner.host.sessionOps.validateCwd(owner.project);
  const headers = { "content-type": "application/json" };
  const stage = async (name) => {
    const id = randomUUID(), bytes = Buffer.from("new bytes");
    assert.equal((await fetch(`${f.url}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ id, host: owner.id, name, size: bytes.length, type: "text/plain" }) })).status, 200);
    assert.equal((await fetch(`${f.url}/api/uploads/${id}?offset=0`, { method: "PUT", body: bytes })).status, 200);
    return { id, name };
  };
  writeFileSync(join(owner.project, "taken.txt"), "old bytes");
  const url = `${f.url}/api/files/${encodeURIComponent(owner.project)}?${new URLSearchParams({ hostId: owner.id, type: "upload", conflict: "error" })}`;
  const publish = (uploads) => fetch(url, { method: "POST", headers, body: JSON.stringify({ uploads }) });
  const conflict = await publish([await stage("taken.txt")]);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "upload_conflict");
  assert.equal(readFileSync(join(owner.project, "taken.txt"), "utf8"), "old bytes");
  const mixed = await publish([await stage("good.txt"), await stage("taken.txt")]);
  assert.equal(mixed.status, 207);
  const body = await mixed.json();
  assert.deepEqual(body.uploaded, ["good.txt"]);
  assert.equal(body.errors[0].code, "upload_conflict");
  assert.equal(readFileSync(join(owner.project, "good.txt"), "utf8"), "new bytes");
  assert.equal(readFileSync(join(owner.project, "taken.txt"), "utf8"), "old bytes");
});

test("the owning Node daemon rejects credential preflight and an entire overwrite batch without blocking independent copies", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost();
  await owner.host.sessionOps.validateCwd(owner.agentDir);
  await owner.host.sessionOps.validateCwd(owner.project);
  const headers = { "content-type": "application/json" };
  const secret = join(owner.agentDir, "agent.db");
  writeFileSync(secret, "original credential bytes");
  const stage = async (name) => {
    const id = randomUUID(), bytes = Buffer.from("replacement bytes");
    assert.equal((await fetch(`${f.url}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ id, host: owner.id, name, size: bytes.length, type: "text/plain" }) })).status, 200);
    assert.equal((await fetch(`${f.url}/api/uploads/${id}?offset=0`, { method: "PUT", body: bytes })).status, 200);
    return { id, name };
  };
  const request = (directory, type, body) => fetch(`${f.url}/api/files/${encodeURIComponent(directory)}?${new URLSearchParams({ hostId: owner.id, type, conflict: "overwrite" })}`,
    { method: "POST", headers, body: JSON.stringify(body) });
  const check = await request(owner.agentDir, "upload-check", { fileNames: ["agent.db"] });
  assert.equal(check.status, 403);
  assert.equal((await check.json()).code, "access_denied");
  const ordinary = await stage("first.txt"), credential = await stage("agent.db");
  const refused = await request(owner.agentDir, "upload", { uploads: [ordinary, credential] });
  assert.equal(refused.status, 403);
  assert.equal(existsSync(join(owner.agentDir, "first.txt")), false, "batch preflight precedes every write");
  assert.equal(readFileSync(secret, "utf8"), "original credential bytes");
  const independent = await request(owner.project, "upload", { uploads: [credential] });
  assert.equal(independent.status, 200);
  assert.equal(readFileSync(join(owner.project, "agent.db"), "utf8"), "replacement bytes");
});

test("a dangling configured agent.db link refuses the whole upload batch before any write and leaves the missing database uncreated", async (t) => {
  const f = await workspaceHarness(); t.after(() => f.close());
  const owner = await f.startHost();
  await owner.host.sessionOps.validateCwd(owner.agentDir);
  await owner.host.sessionOps.validateCwd(owner.project);
  const headers = { "content-type": "application/json" };
  // The credential store is configured as a link to a workspace database that does not exist yet.
  const vault = join(owner.project, "vault.sqlite"), link = join(owner.agentDir, "agent.db");
  symlinkSync(vault, link);
  const stage = async (name) => {
    const id = randomUUID(), bytes = Buffer.from("replacement bytes");
    assert.equal((await fetch(`${f.url}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ id, host: owner.id, name, size: bytes.length, type: "text/plain" }) })).status, 200);
    assert.equal((await fetch(`${f.url}/api/uploads/${id}?offset=0`, { method: "PUT", body: bytes })).status, 200);
    return { id, name };
  };
  const request = (directory, type, body) => fetch(`${f.url}/api/files/${encodeURIComponent(directory)}?${new URLSearchParams({ hostId: owner.id, type, conflict: "overwrite" })}`,
    { method: "POST", headers, body: JSON.stringify(body) });
  const check = await request(owner.project, "upload-check", { fileNames: ["vault.sqlite"] });
  assert.equal(check.status, 403);
  assert.equal((await check.json()).code, "access_denied");
  const ordinary = await stage("first.txt"), credential = await stage("vault.sqlite");
  const refused = await request(owner.project, "upload", { uploads: [ordinary, credential] });
  assert.equal(refused.status, 403);
  assert.equal(existsSync(join(owner.project, "first.txt")), false, "batch preflight precedes every write");
  assert.equal(existsSync(vault), false, "the missing credential database must stay uncreated");
  assert.equal(readlinkSync(link), vault, "the configured credential link must stay unchanged");
  const copies = join(owner.project, "copies");
  mkdirSync(copies);
  await owner.host.sessionOps.validateCwd(copies);
  const independent = await request(copies, "upload", { uploads: [credential] });
  assert.equal(independent.status, 200);
  assert.equal(readFileSync(join(copies, "vault.sqlite"), "utf8"), "replacement bytes");
});
