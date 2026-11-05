import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after } from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

const scratch = mkdtempSync(join(tmpdir(), "omp-workspace-publication-"));
const previousAgent = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
// Load only after selecting this test file's private installation.
const { StagedUploads, STAGED_MAX_AGE_MS } = await import("./uploads.ts");
const { grantWorkspaceRoot } = await import("./workspace-roots.ts");
after(() => {
  if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgent;
  rmSync(scratch, { recursive: true, force: true });
});

async function fixture(t, Class = StagedUploads) {
  const root = mkdtempSync(join(scratch, "case-"));
  const destination = join(root, "workspace");
  const staging = join(root, "staging");
  mkdirSync(destination);
  mkdirSync(staging);
  grantWorkspaceRoot(destination);
  const acks = [];
  const staged = new Class((ack) => acks.push(ack), staging);
  const ids = [];
  t.after(async () => { for (const id of ids) await staged.abort(id); });
  return {
    root, destination, staging, staged,
    async ready(name, content) {
      const id = randomUUID();
      ids.push(id);
      const bytes = Buffer.from(content);
      await staged.start({ id, attempt: randomUUID(), name, size: bytes.length, type: "application/octet-stream" });
      if (bytes.length) {
        staged.write(id, bytes);
        const deadline = Date.now() + 2000;
        while (!acks.some((ack) => ack.id === id && ack.done)) {
          assert.ok(Date.now() < deadline, "the host must finish writing the staged fixture");
          await delay(5);
        }
      }
      return id;
    },
  };
}

test("publication writes the original bytes and a repeated receipt never replaces later user edits", async (t) => {
  const f = await fixture(t);
  const id = await f.ready("result.txt", "uploaded bytes");
  const first = await f.staged.publish(id, f.destination, "result.txt", "error");
  assert.equal(readFileSync(first.path, "utf8"), "uploaded bytes");
  const replacement = join(f.destination, "replacement.tmp");
  writeFileSync(replacement, "later user edit");
  renameSync(replacement, first.path);
  const retry = await new StagedUploads(() => {}, f.staging).publish(id, f.destination, "result.txt", "error");
  assert.deepEqual(retry, first);
  assert.equal(readFileSync(first.path, "utf8"), "later user edit");
  await assert.rejects(f.staged.publish(id, f.destination, "other.txt", "error"), (error) => error.code === "upload_destination_conflict");
  await f.staged.sweep(Date.now() + STAGED_MAX_AGE_MS + 1000);
  assert.equal(readFileSync(first.path, "utf8"), "later user edit");
});

test("conflicts are decided at publication: error preserves, skip preserves, explicit overwrite replaces", async (t) => {
  const f = await fixture(t);
  const target = join(f.destination, "taken.txt");
  const errorId = await f.ready("taken.txt", "new error bytes");
  writeFileSync(target, "created after inspection");
  await assert.rejects(f.staged.publish(errorId, f.destination, "taken.txt", "error"), (error) => error.status === 409);
  assert.equal(readFileSync(target, "utf8"), "created after inspection");
  const skipId = await f.ready("taken.txt", "new skipped bytes");
  assert.equal((await f.staged.publish(skipId, f.destination, "taken.txt", "skip")).skipped, true);
  assert.equal(readFileSync(target, "utf8"), "created after inspection");
  const overwriteId = await f.ready("taken.txt", "explicit replacement");
  await f.staged.publish(overwriteId, f.destination, "taken.txt", "overwrite");
  assert.equal(readFileSync(target, "utf8"), "explicit replacement");
  await f.staged.abort(overwriteId);
  assert.equal(readFileSync(target, "utf8"), "explicit replacement");
});

test("publication rejects unfinished uploads, traversal, symlink targets and unselected directories", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  await f.staged.start({ id, attempt: randomUUID(), name: "unfinished.txt", size: 3, type: "" });
  await assert.rejects(f.staged.publish(id, f.destination, "unfinished.txt", "error"), (error) => error.code === "upload_incomplete");
  await f.staged.abort(id);
  const ready = await f.ready("safe.txt", "safe bytes");
  await assert.rejects(f.staged.publish(ready, f.destination, "../escape.txt", "error"), (error) => error.status === 400);
  const outside = join(f.root, "not-selected"); mkdirSync(outside);
  await assert.rejects(f.staged.publish(ready, outside, "safe.txt", "error"), (error) => error.status === 403);
  const original = join(f.destination, "original.txt"); writeFileSync(original, "do not replace");
  symlinkSync(original, join(f.destination, "safe.txt"));
  await assert.rejects(f.staged.publish(ready, f.destination, "safe.txt", "overwrite"), (error) => error.status === 409);
  assert.equal(readFileSync(original, "utf8"), "do not replace");
});

test("publication refuses a target that became a credential hardlink after preflight", async (t) => {
  const f = await fixture(t);
  const { inspectUploadTargets } = await import("../file-upload.ts");
  assert.deepEqual(inspectUploadTargets(f.destination, ["report.txt"]).conflicts, []);
  const id = await f.ready("report.txt", "replacement bytes");
  const agent = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(agent, { recursive: true });
  const secret = join(agent, "agent.db");
  writeFileSync(secret, "credential bytes");
  linkSync(secret, join(f.destination, "report.txt"));
  t.after(() => rmSync(secret, { force: true }));
  await assert.rejects(f.staged.publish(id, f.destination, "report.txt", "overwrite"), error => error.status === 403 && error.code === "access_denied");
  assert.equal(readFileSync(secret, "utf8"), "credential bytes");
  assert.equal(readFileSync(join(f.destination, "report.txt"), "utf8"), "credential bytes");
  assert.deepEqual(readdirSync(f.destination), ["report.txt"], "a refused publication leaves no candidate behind");
});

test("a failed cross-device copy leaves the old target intact and no partial file visible", async (t) => {
  const real = { ...await import("node:fs/promises") };
  await mockBuiltin(t, "node:fs/promises", {
    async link(from, to) {
      if (String(from).endsWith(".part")) throw Object.assign(new Error("different device"), { code: "EXDEV" });
      return real.link(from, to);
    },
    async open(path, flags, ...rest) {
      const handle = await real.open(path, flags, ...rest);
      if (flags === "wx" && String(path).includes(".omp-upload-")) {
        const write = handle.write.bind(handle);
        handle.write = async () => {
          await write(Buffer.from("partial copy"), 0, 12, 0);
          throw Object.assign(new Error("disk write failed"), { code: "EIO" });
        };
      }
      return handle;
    },
  });
  const { StagedUploads: Fresh } = await import("./uploads.ts?fresh=workspace-copy-failure");
  const f = await fixture(t, Fresh);
  writeFileSync(join(f.destination, "data.txt"), "old safe bytes");
  const id = await f.ready("data.txt", "replacement bytes");
  await assert.rejects(f.staged.publish(id, f.destination, "data.txt", "overwrite"), (error) => error.code === "EIO");
  assert.equal(readFileSync(join(f.destination, "data.txt"), "utf8"), "old safe bytes");
  assert.deepEqual(readdirSync(f.destination), ["data.txt"]);
});

test("an interrupted receipt after replacement is reconciled without overwriting a user edit", async (t) => {
  const real = { ...await import("node:fs/promises") };
  let target;
  let fail = true;
  await mockBuiltin(t, "node:fs/promises", {
    async rename(from, to) {
      if (fail && String(to).endsWith(".json") && target && existsSync(target) && readFileSync(target, "utf8") === "new bytes") {
        throw Object.assign(new Error("receipt write failed"), { code: "EIO" });
      }
      return real.rename(from, to);
    },
  });
  const { StagedUploads: Fresh } = await import("./uploads.ts?fresh=workspace-receipt-failure");
  const f = await fixture(t, Fresh);
  target = join(f.destination, "receipt.txt");
  writeFileSync(target, "old bytes");
  const id = await f.ready("receipt.txt", "new bytes");
  try {
    await assert.rejects(f.staged.publish(id, f.destination, "receipt.txt", "overwrite"), (error) => error.code === "upload_publish_uncertain");
  } finally { fail = false; }
  assert.equal(readFileSync(target, "utf8"), "new bytes");
  writeFileSync(target, "user changed the committed file");
  const replay = await f.staged.publish(id, f.destination, "receipt.txt", "overwrite");
  assert.equal(replay.path, target);
  assert.equal(readFileSync(target, "utf8"), "user changed the committed file");
});

test("a published file's age starts at publication, not at its staged part's last write", async (t) => {
  const f = await fixture(t);
  const id = await f.ready("aged.txt", "bytes");
  const staged20hAgo = (Date.now() - 20 * 60 * 60 * 1000) / 1000;
  utimesSync(join(f.staging, `${id}.part`), staged20hAgo, staged20hAgo);
  const before = Date.now();
  const result = await f.staged.publish(id, f.destination, "aged.txt", "error");
  assert.ok(statSync(result.path).mtimeMs >= before - 1000, "retention must not see the staging age");
});

test("a retention sweep cannot delete an overwrite that replaced the expired file it inspected", async (t) => {
  const real = { ...await import("node:fs/promises") };
  let target, armed = false, observed, release;
  const inspected = new Promise((resolve) => { observed = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  await mockBuiltin(t, "node:fs/promises", {
    async lstat(file, ...args) {
      const info = await real.lstat(file, ...args);
      if (armed && file === target) { armed = false; observed(); await gate; }
      return info;
    },
  });
  const { sweepSentUploads } = await import("./upload-retention.ts?fresh=overwrite-race");
  const f = await fixture(t);
  const sessions = join(f.root, "sessions");
  const uploads = join(sessions, "project", "session", "local", "uploads");
  mkdirSync(uploads, { recursive: true });
  grantWorkspaceRoot(uploads);
  target = join(uploads, "report.txt");
  writeFileSync(target, "expired bytes");
  const fortyDaysAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(target, fortyDaysAgo, fortyDaysAgo);
  const id = await f.ready("report.txt", "fresh replacement");
  armed = true;
  const sweep = sweepSentUploads(30, Date.now(), { sessions, archive: join(f.root, "archive"), tmp: null });
  await inspected;
  // The sweep holds a stale stat of the expired file while the overwrite publishes.
  const published = f.staged.publish(id, uploads, "report.txt", "overwrite");
  await delay(50);
  release();
  await sweep;
  await published;
  assert.equal(readFileSync(target, "utf8"), "fresh replacement");
});

test("the shared 2 GiB boundary accepts a sparse upload and rejects one byte beyond it", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  const size = 2 * 1024 ** 3;
  writeFileSync(join(f.staging, `${id}.part`), "");
  truncateSync(join(f.staging, `${id}.part`), size);
  writeFileSync(join(f.staging, `${id}.json`), JSON.stringify({ name: "boundary.bin", size, type: "", created: Date.now() }));
  assert.deepEqual(await f.staged.start({ id, attempt: randomUUID(), name: "boundary.bin", size, type: "" }), { received: size, done: true });
  const result = await f.staged.publish(id, f.destination, "boundary.bin", "error");
  assert.equal(statSync(result.path).size, size);
  await assert.rejects(f.staged.start({ id: randomUUID(), attempt: randomUUID(), name: "over.bin", size: size + 1, type: "" }), (error) => error.status === 413);
});

test("cross-device copying cannot follow a swapped candidate symlink into an outside file", async (t) => {
  const real = { ...await import("node:fs/promises") };
  let victim;
  await mockBuiltin(t, "node:fs/promises", {
    async link(from, to) {
      if (String(from).endsWith(".part")) throw Object.assign(new Error("different device"), { code: "EXDEV" });
      return real.link(from, to);
    },
    async open(path, flags, ...rest) {
      const handle = await real.open(path, flags, ...rest);
      if (flags === "wx" && String(path).includes(".omp-upload-")) {
        await real.rename(path, `${path}.displaced`);
        await real.symlink(victim, path);
      }
      return handle;
    },
  });
  const { StagedUploads: Fresh } = await import("./uploads.ts?fresh=workspace-candidate-swap");
  const f = await fixture(t, Fresh);
  victim = join(f.root, "outside-victim.txt");
  writeFileSync(victim, "outside original");
  writeFileSync(join(f.destination, "result.txt"), "old workspace bytes");
  const id = await f.ready("result.txt", "new upload bytes");
  let failure;
  try { await f.staged.publish(id, f.destination, "result.txt", "overwrite"); } catch (error) { failure = error; }
  assert.equal(readFileSync(victim, "utf8"), "outside original");
  assert.equal(readFileSync(join(f.destination, "result.txt"), "utf8"), "old workspace bytes");
  assert.equal(failure?.code, "upload_publish_uncertain");
});

function danglingAgentDatabase(t, target) {
  const agent = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(agent, { recursive: true });
  const link = join(agent, "agent.db");
  symlinkSync(target, link);
  t.after(() => rmSync(link, { force: true }));
  return link;
}

test("direct overwrite publication refuses a dangling agent.db credential target and creates nothing", async (t) => {
  const f = await fixture(t);
  const vault = join(f.destination, "vault.sqlite");
  const link = danglingAgentDatabase(t, vault);
  const id = await f.ready("vault.sqlite", "replacement bytes");
  await assert.rejects(f.staged.publish(id, f.destination, "vault.sqlite", "overwrite"), (error) => error.status === 403 && error.code === "access_denied");
  assert.equal(existsSync(vault), false, "the missing credential database must not be created");
  assert.equal(readlinkSync(link), vault);
  assert.deepEqual(readdirSync(f.destination), [], "a refused publication leaves no candidate behind");
});

test("an independent ordinary copy with the protected basename still publishes beside a dangling agent.db link", async (t) => {
  const f = await fixture(t);
  danglingAgentDatabase(t, join(f.destination, "vault.sqlite"));
  const copies = join(f.root, "copies");
  mkdirSync(copies);
  grantWorkspaceRoot(copies);
  const id = await f.ready("vault.sqlite", "independent bytes");
  await f.staged.publish(id, copies, "vault.sqlite", "error");
  assert.equal(readFileSync(join(copies, "vault.sqlite"), "utf8"), "independent bytes");
});

test("relative and chained dangling agent.db links protect the same missing canonical target", async (t) => {
  const agent = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(agent, { recursive: true });
  for (const form of ["relative", "chained"]) {
    const f = await fixture(t);
    const vault = join(f.destination, "vault.sqlite");
    const link = join(agent, "agent.db"), chain = join(agent, "chain.db");
    try {
      if (form === "relative") symlinkSync(relative(agent, vault), link);
      else { symlinkSync(vault, chain); symlinkSync("chain.db", link); }
      const id = await f.ready("vault.sqlite", "replacement bytes");
      await assert.rejects(f.staged.publish(id, f.destination, "vault.sqlite", "overwrite"), (error) => error.status === 403 && error.code === "access_denied", form);
      assert.equal(existsSync(vault), false, form);
      assert.deepEqual(readdirSync(f.destination), [], form);
    } finally {
      rmSync(link, { force: true });
      rmSync(chain, { force: true });
    }
  }
});

test("a configured link through a POSIX directory symlink then /../ protects the native parent target, not the lexical decoy", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  const native = join(f.root, "native");
  mkdirSync(join(native, "deep"), { recursive: true });
  grantWorkspaceRoot(native);
  symlinkSync(join(native, "deep"), join(f.destination, "dirlink"));
  // Build the target string verbatim: path.join would collapse /../ lexically.
  const link = danglingAgentDatabase(t, `${f.destination}/dirlink/../missing.sqlite`);
  // The OS, not path.join, decides where link/.. lands: the dirlink hop happens first.
  assert.equal(realpathSync.native(`${f.destination}/dirlink/..`), realpathSync.native(native));
  const control = await f.ready("control.txt", "control bytes");
  await f.staged.publish(control, native, "control.txt", "error");
  assert.equal(readFileSync(join(native, "control.txt"), "utf8"), "control bytes", "the native directory must be a granted publication root");
  const decoy = await f.ready("missing.sqlite", "decoy bytes");
  await f.staged.publish(decoy, f.destination, "missing.sqlite", "error");
  assert.equal(readFileSync(join(f.destination, "missing.sqlite"), "utf8"), "decoy bytes");
  const id = await f.ready("missing.sqlite", "native bytes");
  await assert.rejects(f.staged.publish(id, native, "missing.sqlite", "overwrite"), (error) => error.status === 403 && error.code === "access_denied");
  assert.equal(existsSync(join(native, "missing.sqlite")), false, "the native credential target must stay uncreated");
  assert.equal(readlinkSync(link), `${f.destination}/dirlink/../missing.sqlite`);
});
