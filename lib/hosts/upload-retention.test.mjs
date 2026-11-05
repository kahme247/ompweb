// The daemon's retention of sent uploads (upload-retention.ts) against temp directories; no hub or daemon needed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

const { sweepSentUploads, UploadRetention } = await import("./upload-retention.ts");
const { uploadOwnerNamespace } = await import("./uploads.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const scratch = mkdtempSync(join(tmpdir(), "omp-web-retention-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Session roots under a fresh temp dir. */
function layout() {
  const dir = mkdtempSync(join(scratch, "case-"));
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  return { dir, agentDir, roots: { sessions: join(agentDir, "sessions"), archive: join(agentDir, "archive", "sessions"), tmp: { dir: join(dir, "omp-local"), namespace: uploadOwnerNamespace(agentDir) } } };
}

/** A file `ageDays` old (relative to now). */
function put(path, ageDays) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x");
  const when = (Date.now() - ageDays * DAY_MS) / 1000;
  utimesSync(path, when, when);
  return path;
}

const alive = (path) => existsSync(path);

test("a sweep deletes old uploads and keeps new ones, in an active session, an archived one and the Windows tmp fallback", async () => {
  const { roots } = layout();
  const active = join(roots.sessions, "proj", "s1", "local", "uploads");
  const archived = join(roots.archive, "proj", "s2.jsonl", "local", "uploads");
  const tmpId = randomUUID();
  const tmp = join(roots.tmp.dir, tmpId, "uploads", roots.tmp.namespace);
  const kept = [];
  const gone = [];
  for (const folder of [active, archived, tmp]) {
    gone.push(put(join(folder, "old.zip"), 31));
    kept.push(put(join(folder, "new.zip"), 29));
  }
  // Not uploads: another file in `local/`, a session file, a directory in uploads (never entered), a compressed archive file.
  kept.push(put(join(roots.sessions, "proj", "s1", "local", "notes.txt"), 90));
  kept.push(put(join(roots.sessions, "proj", "s1.jsonl"), 90));
  kept.push(put(join(roots.archive, "proj", "s2.jsonl.gz"), 90));
  kept.push(put(join(active, "dir", "inner.bin"), 90));
  // The directory itself is old too: only regular files are ever deleted.
  const oldDir = join(active, "dir");
  const longAgo = (Date.now() - 90 * DAY_MS) / 1000;
  utimesSync(oldDir, longAgo, longAgo);
  kept.push(oldDir);

  await sweepSentUploads(30, Date.now(), roots);

  assert.deepEqual(gone.filter(alive), []);
  assert.deepEqual(kept.filter((path) => !alive(path)), []);
  for (const folder of [active, archived, tmp]) assert.equal(statSync(folder).isDirectory(), true, "the uploads folder stays");
});

test("Windows fallback producer and default retention isolate copied UUIDs across daemons, including Never", async (t) => {
  const temporary = mkdtempSync(join(scratch, "shared-"));
  await mockBuiltin(t, "node:os", { tmpdir: () => temporary });
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const { StagedUploads: WindowsUploads } = await import("./uploads.ts?fresh=owner-namespace");
    const { UploadRetention: WindowsRetention } = await import("./upload-retention.ts?fresh=owner-namespace-default");
    const a = layout(), b = layout();
    const shared = join(temporary, "omp-local");
    const sessionId = randomUUID();
    const makeSession = (roots) => {
      const file = join(roots.sessions, "project", `${"x".repeat(160)}_${sessionId}.jsonl`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: scratch }) + "\n");
      return file;
    };
    const ready = async (agentDir, byte) => {
      process.env.PI_CODING_AGENT_DIR = agentDir;
      let finish;
      const completed = new Promise(resolve => { finish = resolve; });
      const store = new WindowsUploads(ack => { if (ack.done) finish(); });
      const id = randomUUID();
      await store.start({ id, attempt: randomUUID(), name: `${"n".repeat(196)}.bin`, size: 1, type: "" });
      store.write(id, new Uint8Array([byte]));
      await completed;
      return { store, id };
    };
    const fileA = makeSession(a.roots), fileB = makeSession(b.roots);
    const uploadA = await ready(a.agentDir, 65), uploadB = await ready(b.agentDir, 66);
    // Both constructors captured their own identity even though the second daemon is now the process default.
    const attachedA = await uploadA.store.attach(uploadA.id, fileA, sessionId);
    const attachedB = await uploadB.store.attach(uploadB.id, fileB, sessionId);
    assert.notEqual(attachedA.path, attachedB.path, "copied UUIDs and equal filenames do not share ownership");
    assert.equal(readFileSync(attachedA.path, "utf8"), "A");
    assert.equal(readFileSync(attachedB.path, "utf8"), "B");
    const local = join(shared, sessionId);
    for (const attached of [attachedA, attachedB]) {
      const url = new URL(attached.url);
      assert.equal(readFileSync(join(local, url.hostname, url.pathname), "utf8"), attached === attachedA ? "A" : "B", "the native local:// URL still locates the actual bytes");
      const old = (Date.now() - 40 * DAY_MS) / 1000;
      utimesSync(attached.path, old, old);
    }
    const { archiveSessionFileWithArtifacts } = await import("../omp/session-files.ts");
    archiveSessionFileWithArtifacts(fileA, { sessionsRoot: a.roots.sessions, archiveRoot: a.roots.archive });
    rmSync(fileB); // Ownership survives even when the native session metadata was deleted.
    const legacy = put(join(local, "uploads", "legacy-flat.bin"), 40);
    const foreign = put(join(local, "uploads", "foreign-owner", "foreign.bin"), 40);
    const policyA = join(a.agentDir, "omp-web", "upload-retention.json");
    const policyB = join(b.agentDir, "omp-web", "upload-retention.json");
    writeFileSync(policyA, JSON.stringify({ days: 7 }));
    writeFileSync(policyB, JSON.stringify({ days: null }));
    process.env.PI_CODING_AGENT_DIR = a.agentDir;
    const retentionA = new WindowsRetention();
    process.env.PI_CODING_AGENT_DIR = b.agentDir;
    const retentionB = new WindowsRetention();
    t.after(() => { retentionA.stop(); retentionB.stop(); });
    await retentionB.start();
    await retentionA.start();
    assert.equal(alive(attachedA.path), false, "this daemon removes its archived session's expired upload");
    assert.equal(alive(attachedB.path), true, "the other daemon's Never policy survives a copied UUID");
    assert.equal(alive(legacy), true, "legacy flat data has no attributable owner");
    assert.equal(alive(foreign), true, "another namespace is never swept");
    retentionB.set(7);
    await retentionB.sweep();
    assert.equal(alive(attachedB.path), false, "the owning daemon can expire its upload after metadata deletion");
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
  }
});

test("a sweep never follows a symlink: not an uploads entry, not `uploads`, not `local`", async () => {
  const { dir, roots } = layout();
  const outside = join(dir, "outside");
  const secret = put(join(outside, "secret.bin"), 400);
  const nested = put(join(outside, "uploads", "nested.bin"), 400);

  // An entry in uploads that points at an old file, and a real old one beside it.
  const entry = join(roots.sessions, "proj", "s1", "local", "uploads");
  const real = put(join(entry, "old.bin"), 400);
  const link = join(entry, "link.bin");
  symlinkSync(secret, link);
  // The symlink itself is old (lstat's mtime), so only the non-file check keeps it.
  lutimesSync(link, (Date.now() - 400 * DAY_MS) / 1000, (Date.now() - 400 * DAY_MS) / 1000);
  // `uploads` itself a symlink to a directory with an old file.
  mkdirSync(join(roots.sessions, "proj", "s2", "local"), { recursive: true });
  symlinkSync(outside, join(roots.sessions, "proj", "s2", "local", "uploads"));
  // `local` a symlink to a directory holding uploads/.
  mkdirSync(join(roots.archive, "proj", "s3.jsonl"), { recursive: true });
  symlinkSync(outside, join(roots.archive, "proj", "s3.jsonl", "local"));
  // A session directory that is a symlink.
  symlinkSync(join(roots.sessions, "proj", "s2"), join(roots.sessions, "proj", "s4"));
  // A symlinked project directory and a symlinked session directory (under both roots), each leading to a real
  // `local/uploads` with an old file outside the roots.
  const viaProject = put(join(dir, "outside-project", "s1", "local", "uploads", "old.bin"), 400);
  const viaSession = put(join(dir, "outside-session", "local", "uploads", "old.bin"), 400);
  for (const root of [roots.sessions, roots.archive]) {
    mkdirSync(join(root, "proj"), { recursive: true });
    symlinkSync(join(dir, "outside-project"), join(root, "linked-project"));
    symlinkSync(join(dir, "outside-session"), join(root, "proj", "linked-session"));
  }
  const namespace = roots.tmp.namespace;
  const viaTempNamespace = put(join(outside, "namespace-target", "old.bin"), 400);
  const viaTempUploads = put(join(outside, "uploads-target", namespace, "old.bin"), 400);
  const viaTempSession = put(join(outside, "session-target", "uploads", namespace, "old.bin"), 400);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  mkdirSync(join(roots.tmp.dir, "namespace-link", "uploads"), { recursive: true });
  symlinkSync(join(outside, "namespace-target"), join(roots.tmp.dir, "namespace-link", "uploads", namespace), linkType);
  mkdirSync(join(roots.tmp.dir, "uploads-link"), { recursive: true });
  symlinkSync(join(outside, "uploads-target"), join(roots.tmp.dir, "uploads-link", "uploads"), linkType);
  symlinkSync(join(outside, "session-target"), join(roots.tmp.dir, "session-link"), linkType);

  await sweepSentUploads(30, Date.now(), roots);

  assert.equal(alive(real), false);
  assert.equal(alive(secret), true, "the target of a symlinked entry is not deleted");
  assert.equal(alive(nested), true, "nothing is deleted through a symlinked uploads or local");
  assert.equal(alive(join(entry, "link.bin")), true, "the symlink itself stays");
  assert.equal(alive(viaProject), true, "a symlinked project directory is not entered");
  assert.equal(alive(viaSession), true, "a symlinked session directory is not entered");
  for (const file of [viaTempNamespace, viaTempUploads, viaTempSession]) {
    assert.equal(alive(file), true, "temporary session, uploads and owner-namespace links are never followed");
  }
});

test("a retention of null deletes nothing; a number persists, sweeps, and an invalid one changes nothing", async () => {
  const { dir, roots } = layout();
  const file = join(dir, "agent", "omp-web", "upload-retention.json");
  const old = put(join(roots.sessions, "proj", "s1", "local", "uploads", "old.bin"), 400);
  const retention = new UploadRetention(file, roots);

  // Nothing said yet: nothing deleted.
  await retention.start();
  retention.stop();
  assert.equal(alive(old), true);

  assert.equal(retention.set(null), null);
  await retention.sweep();
  assert.equal(alive(old), true, "null keeps uploads for ever");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { days: null });

  for (const bad of [0, -1, 1.5, 3651, "7", undefined, NaN, Infinity, {}, [30], true]) {
    assert.throws(() => retention.set(bad), (error) => error.status === 400 && error.code === "invalid_request", `${String(bad)} is refused`);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { days: null });

  retention.set(30);
  await retention.sweep();
  assert.equal(alive(old), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { days: 30 });

  // The same value again writes nothing.
  rmSync(file);
  retention.set(30);
  assert.equal(alive(file), false);
});

test("a retention set before a restart sweeps when the daemon starts again; an absent or unreadable file sweeps nothing", async () => {
  const { dir, roots } = layout();
  const file = join(dir, "agent", "omp-web", "upload-retention.json");
  const old = join(roots.sessions, "proj", "s1", "local", "uploads", "old.bin");
  const fresh = put(join(roots.sessions, "proj", "s1", "local", "uploads", "fresh.bin"), 1);

  // Store the value through a daemon whose roots hold nothing, so its background sweep touches no fixture below.
  const first = new UploadRetention(file, { sessions: join(dir, "none"), archive: join(dir, "none"), tmp: null });
  first.set(7);

  put(old, 40);
  const restarted = new UploadRetention(file, roots);
  await restarted.start();
  restarted.stop();
  assert.equal(alive(old), false, "the stored value is used at start");
  assert.equal(alive(fresh), true);

  for (const content of [null, "not json", JSON.stringify({ days: 0 }), JSON.stringify({}), JSON.stringify({ days: "7" })]) {
    if (content === null) rmSync(file);
    else writeFileSync(file, content);
    put(old, 400);
    const unset = new UploadRetention(file, roots);
    await unset.start();
    unset.stop();
    assert.equal(alive(old), true, `${String(content)} sweeps nothing`);
  }
});

for (const relaxed of [null, 90]) {
  test(`a running sweep spares remaining files in the same folder after 7 days changes to ${relaxed}`, async (t) => {
    const { dir, roots } = layout();
    const folder = join(roots.sessions, "proj", "s1", "local", "uploads");
    const files = ["a.bin", "b.bin", "c.bin"].map((name) => put(join(folder, name), 40));
    const file = join(dir, "upload-retention.json");
    writeFileSync(file, JSON.stringify({ days: 7 }));
    const real = { ...await import("node:fs/promises") };
    const removed = [];
    let retention;
    await mockBuiltin(t, "node:fs/promises", {
      async unlink(path) {
        await real.unlink(path);
        removed.push(path);
        if (removed.length === 1) retention.set(relaxed);
      },
    });
    const { UploadRetention: FreshUploadRetention } = await import(`./upload-retention.ts?fresh=mid-folder-${relaxed}`);
    retention = new FreshUploadRetention(file, roots);
    // Capture the sweep set(90) starts too, so no background filesystem work escapes the test.
    const sweep = retention.sweep.bind(retention);
    const sweeps = [];
    retention.sweep = (...args) => {
      const pending = sweep(...args);
      sweeps.push(pending);
      return pending;
    };
    await retention.sweep();
    await Promise.all(sweeps);
    assert.equal(removed.length, 1, "only the unlink completed before the policy changed is allowed");
    assert.equal(files.filter(alive).length, 2, "the other expired files in that same folder survive");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { days: relaxed });
  });
}

test("unreadable roots and upload folders are reported; missing folders stay quiet", async (t) => {
  const { roots } = layout();
  const folder = join(roots.sessions, "proj", "s1", "local", "uploads");
  const old = put(join(folder, "old.bin"), 40);
  const real = { ...await import("node:fs/promises") };
  await mockBuiltin(t, "node:fs/promises", {
    async readdir(path, ...args) {
      if (path === roots.archive || path === folder) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return real.readdir(path, ...args);
    },
  });
  const { sweepSentUploads: freshSweep } = await import("./upload-retention.ts?fresh=read-errors");
  const errors = [];
  const error = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => { console.error = error; });
  await freshSweep(7, Date.now(), roots);
  assert.equal(alive(old), true, "an unreadable folder is skipped");
  assert.equal(errors.length, 2, "an absent temporary root is skipped without an error");
  for (const path of [roots.archive, folder]) {
    assert.ok(errors.some((line) => line.includes(path) && line.includes("permission denied")));
  }
});
