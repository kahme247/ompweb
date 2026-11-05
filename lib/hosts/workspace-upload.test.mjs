import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
