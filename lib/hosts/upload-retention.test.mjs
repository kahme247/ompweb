// The daemon's retention of sent uploads (upload-retention.ts) against temp directories; no hub or daemon needed.
import assert from "node:assert/strict";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const { sweepSentUploads, UploadRetention } = await import("./upload-retention.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const scratch = mkdtempSync(join(tmpdir(), "omp-web-retention-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Session roots under a fresh temp dir. */
function layout() {
  const dir = mkdtempSync(join(scratch, "case-"));
  return { dir, roots: { sessions: join(dir, "sessions"), archive: join(dir, "archive"), tmp: join(dir, "omp-local") } };
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
  const tmp = join(roots.tmp, "s3", "uploads");
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

  await sweepSentUploads(30, Date.now(), roots);

  assert.equal(alive(real), false);
  assert.equal(alive(secret), true, "the target of a symlinked entry is not deleted");
  assert.equal(alive(nested), true, "nothing is deleted through a symlinked uploads or local");
  assert.equal(alive(join(entry, "link.bin")), true, "the symlink itself stays");
  assert.equal(alive(viaProject), true, "a symlinked project directory is not entered");
  assert.equal(alive(viaSession), true, "a symlinked session directory is not entered");
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

test("a sweep still running when the setting is made longer, or Never, follows the new value", async () => {
  for (const relaxed of [null, 90]) {
    const { dir, roots } = layout();
    const files = Array.from({ length: 50 }, (_, i) => put(join(roots.sessions, "proj", `s${i}`, "local", "uploads", "old.bin"), 40));
    const retention = new UploadRetention(join(dir, "agent", "omp-web", "upload-retention.json"), roots);
    retention.set(7);
    // The sweep set(7) started is still walking; the next one relaxes the policy under it.
    retention.set(relaxed);
    await retention.sweep();
    await new Promise((done) => setTimeout(done, 50));
    assert.deepEqual(files.filter((file) => !alive(file)), [], `a 40-day-old upload survives a change to ${relaxed}`);
  }
});
