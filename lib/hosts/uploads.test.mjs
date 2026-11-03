// The daemon's staging (StagedUploads) against a temp dir, and sanitizeUploadName; no hub or daemon needed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

const { sanitizeUploadName, StagedUploads, STAGED_MAX_AGE_MS } = await import("./uploads.ts");

const scratch = mkdtempSync(join(tmpdir(), "omp-web-staged-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function staging() {
  const dir = mkdtempSync(join(scratch, "dir-"));
  const acks = [];
  return { dir, acks, staged: new StagedUploads((ack) => acks.push(ack), dir), part: (id) => join(dir, `${id}.part`), json: (id) => join(dir, `${id}.json`) };
}

async function until(check, what) {
  for (let i = 0; i < 200 && !check(); i++) await sleep(10);
  assert.ok(check(), `timed out waiting for ${what}`);
}

test("sweep aborts an open upload idle past STAGED_MAX_AGE_MS, keeps a fresh open one, deletes old closed files", async () => {
  const { dir, staged, part, json } = staging();
  const idle = randomUUID();
  await staged.start({ id: idle, attempt: randomUUID(), name: "idle.bin", size: 10, type: "" });
  staged.write(idle, new Uint8Array(2));
  await until(() => statSync(part(idle)).size === 2, "the write");
  const fresh = randomUUID();
  await staged.start({ id: fresh, attempt: randomUUID(), name: "fresh.bin", size: 10, type: "" });
  const old = (Date.now() - 2 * STAGED_MAX_AGE_MS) / 1000;
  utimesSync(part(fresh), old, old);
  utimesSync(json(fresh), old, old);
  writeFileSync(join(dir, "stale.part"), "x");
  utimesSync(join(dir, "stale.part"), old, old);

  await staged.sweep();
  assert.equal(existsSync(part(fresh)), true, "a fresh open upload keeps its files, however old their mtime");
  assert.equal(existsSync(json(fresh)), true);
  assert.equal(existsSync(join(dir, "stale.part")), false, "an old closed file is deleted");
  assert.equal(existsSync(part(idle)), true);

  // A day after the idle upload's last write (the fresh one is just as idle by then).
  await staged.sweep(Date.now() + STAGED_MAX_AGE_MS + 1000);
  assert.equal(existsSync(part(idle)), false, "an idle open upload is aborted");
  assert.equal(existsSync(json(idle)), false);
  staged.write(idle, new Uint8Array(1));
  await sleep(20);
  assert.equal(existsSync(part(idle)), false, "frames for a swept upload are dropped");
});

test("a sweep that cannot delete an idle upload's files resolves, still cleans the rest, and lets new uploads start", async () => {
  const { dir, staged, part } = staging();
  const stuck = randomUUID();
  await staged.start({ id: stuck, attempt: randomUUID(), name: "stuck.bin", size: 10, type: "" });
  // Its .part became a non-empty directory: rm(force) cannot delete it.
  rmSync(part(stuck));
  mkdirSync(join(part(stuck), "inner"), { recursive: true });
  const old = (Date.now() - 2 * STAGED_MAX_AGE_MS) / 1000;
  writeFileSync(join(dir, "stale.part"), "x");
  utimesSync(join(dir, "stale.part"), old, old);

  // A rejection here would be unhandled in the daemon's hourly timer and stop the host.
  await staged.sweep(Date.now() + STAGED_MAX_AGE_MS + 1000);
  assert.equal(existsSync(join(dir, "stale.part")), false, "the other expired files still go");
  const next = randomUUID();
  const started = await staged.start({ id: next, attempt: randomUUID(), name: "next.bin", size: 1, type: "" });
  assert.deepEqual(started, { received: 0, done: false }, "an uploadStart (which sweeps first) is not failed by the stuck file");
});

test("a write keeps an open upload alive for another STAGED_MAX_AGE_MS", async () => {
  const { staged, part } = staging();
  const id = randomUUID();
  const realNow = Date.now;
  const started = realNow();
  try {
    await staged.start({ id, attempt: randomUUID(), name: "slow.bin", size: 10, type: "" });
    Date.now = () => started + STAGED_MAX_AGE_MS - 1000;
    staged.write(id, new Uint8Array(1));
  } finally {
    Date.now = realNow;
  }
  await until(() => statSync(part(id)).size === 1, "the write");
  await staged.sweep(started + STAGED_MAX_AGE_MS + 1000);
  assert.equal(existsSync(part(id)), true);
  await staged.abort(id);
});

test("start resets a staged part longer than the announced size", async () => {
  const { staged, part, json } = staging();
  const id = randomUUID();
  writeFileSync(json(id), JSON.stringify({ name: "x", size: 5, type: "", created: Date.now() }));
  writeFileSync(part(id), new Uint8Array(10));
  assert.deepEqual(await staged.start({ id, attempt: randomUUID(), name: "x", size: 5, type: "" }), { received: 0, done: false });
  assert.equal(statSync(part(id)).size, 0);
});

test("two concurrent starts for a new id run one after the other: the second finds the first's upload, nothing truncated twice", async () => {
  const { staged, part } = staging();
  const id = randomUUID();
  const meta = staged.meta.bind(staged);
  let metaReads = 0;
  staged.meta = async (key) => {
    metaReads += 1;
    await sleep(30);
    return meta(key);
  };
  const args = { id, attempt: randomUUID(), name: "x.bin", size: 10, type: "" };
  assert.deepEqual(await Promise.all([staged.start(args), staged.start(args)]), [{ received: 0, done: false }, { received: 0, done: false }]);
  assert.equal(metaReads, 1, "only the first start installed the upload");
  assert.equal(statSync(part(id)).size, 0);
});

test("a start for an open id with another name, type or size fails 409 upload_id_conflict", async () => {
  const { staged } = staging();
  const id = randomUUID();
  await staged.start({ id, attempt: randomUUID(), name: "x.bin", size: 10, type: "a/b" });
  const conflict = { status: 409, code: "upload_id_conflict" };
  for (const other of [{ name: "y.bin" }, { type: "a/c" }, { size: 11 }]) {
    await assert.rejects(staged.start({ id, attempt: randomUUID(), name: "x.bin", size: 10, type: "a/b", ...other }), conflict);
  }
  assert.deepEqual(await staged.start({ id, attempt: randomUUID(), name: "x.bin", size: 10, type: "a/b" }), { received: 0, done: false }, "the same file resumes");
});

test("a closed partial of another name or type is reset, the same file resumes", async () => {
  const { dir, part, json } = staging();
  const id = randomUUID();
  writeFileSync(json(id), JSON.stringify({ name: "x.bin", size: 5, type: "a/b", created: Date.now() }));
  writeFileSync(part(id), new Uint8Array(3));
  assert.deepEqual(await new StagedUploads(() => {}, dir).start({ id, attempt: randomUUID(), name: "x.bin", size: 5, type: "a/b" }), { received: 3, done: false });
  for (const other of [{ name: "y.bin" }, { type: "a/c" }]) {
    writeFileSync(part(id), new Uint8Array(3));
    assert.deepEqual(await new StagedUploads(() => {}, dir).start({ id, attempt: randomUUID(), name: "x.bin", size: 5, type: "a/b", ...other }), { received: 0, done: false });
    assert.equal(statSync(part(id)).size, 0);
    writeFileSync(json(id), JSON.stringify({ name: "x.bin", size: 5, type: "a/b", created: Date.now() }));
  }
});

test("attach of an unfinished upload fails 409 upload_incomplete, closed or still open", async () => {
  const { dir, staged, part, json } = staging();
  const sessionFile = join(scratch, "sessions", "s.jsonl");
  const sessionId = randomUUID();
  const incomplete = { status: 409, code: "upload_incomplete" };

  const short = randomUUID();
  writeFileSync(json(short), JSON.stringify({ name: "short", size: 5, type: "", created: Date.now() }));
  writeFileSync(part(short), new Uint8Array(3));
  await assert.rejects(new StagedUploads(() => {}, dir).attach(short, sessionFile, sessionId), incomplete);

  // Open here: refused even when the part already has every byte.
  const open = randomUUID();
  await staged.start({ id: open, attempt: randomUUID(), name: "open", size: 5, type: "" });
  appendFileSync(part(open), new Uint8Array(5));
  await assert.rejects(staged.attach(open, sessionFile, sessionId), incomplete);
});

test("an attach retried after a lost reply returns its receipt: one file, same path; another session file gets 404", async () => {
  const { dir, staged, acks, part, json } = staging();
  const sessionFile = join(scratch, "sessions", "r.jsonl");
  const sessionId = randomUUID();
  const id = randomUUID();
  await staged.start({ id, attempt: randomUUID(), name: "r.bin", size: 3, type: "a/b" });
  staged.write(id, new Uint8Array(3));
  await until(() => acks.some((ack) => ack.id === id && ack.done), "the done ack");
  const first = await staged.attach(id, sessionFile, sessionId);
  assert.equal(existsSync(part(id)), false, "the part is gone");
  assert.equal(existsSync(json(id)), true, "the receipt stays");
  assert.deepEqual(await staged.attach(id, sessionFile, sessionId), first);
  assert.deepEqual(await new StagedUploads(() => {}, dir).attach(id, sessionFile, sessionId), first, "the receipt survives a daemon restart");
  assert.deepEqual(readdirSync(dirname(first.path)), ["r.bin"], "exactly one attached file");
  await assert.rejects(staged.attach(id, join(scratch, "sessions", "other.jsonl"), sessionId), { status: 404, code: "upload_missing" });
  assert.deepEqual(await staged.start({ id, attempt: randomUUID(), name: "r.bin", size: 3, type: "a/b" }), { received: 3, done: true }, "a start for it reports it done");
  for (const other of [{ name: "different.bin" }, { type: "a/c" }, { size: 4 }]) {
    await assert.rejects(staged.start({ id, attempt: randomUUID(), name: "r.bin", size: 3, type: "a/b", ...other }), { status: 409, code: "upload_id_conflict" });
  }
  await staged.sweep(Date.now() + STAGED_MAX_AGE_MS + 1000);
  assert.equal(existsSync(json(id)), false, "the sweep removes the receipt");
  assert.equal(existsSync(first.path), true, "the attached file stays");
});

test("an attach receipt whose target file was removed returns 404", async () => {
  const { staged } = staging();
  const id = randomUUID();
  const sessionFile = join(scratch, "sessions", "missing-target.jsonl");
  const sessionId = randomUUID();
  await staged.start({ id, attempt: randomUUID(), name: "removed.bin", size: 0, type: "" });
  const attached = await staged.attach(id, sessionFile, sessionId);
  rmSync(attached.path);
  await assert.rejects(staged.attach(id, sessionFile, sessionId), { status: 404, code: "upload_missing" });
});

for (const replacement of ["missing", "directory"]) {
  test(`start and receipt replay reject a ${replacement} attached target`, async () => {
    const { staged } = staging();
    const args = { id: randomUUID(), attempt: randomUUID(), name: "receipt.bin", size: 0, type: "" };
    const sessionFile = join(scratch, "sessions", `${randomUUID()}.jsonl`);
    const sessionId = randomUUID();
    await staged.start(args);
    const attached = await staged.attach(args.id, sessionFile, sessionId);
    rmSync(attached.path);
    if (replacement === "directory") mkdirSync(attached.path);
    const missing = { status: 404, code: "upload_missing" };
    await assert.rejects(staged.start({ ...args, attempt: randomUUID() }), missing);
    await assert.rejects(staged.attach(args.id, sessionFile, sessionId), missing);
  });
}

test("failed receipt publication preserves metadata and part, removes only its target, and preserves the original error", async (t) => {
  const real = { ...await import("node:fs/promises") };
  const failure = Object.assign(new Error("receipt disk full"), { code: "ENOSPC" });
  let fail = true;
  await mockBuiltin(t, "node:fs/promises", {
    async writeFile(path, data, ...args) {
      if (fail && typeof data === "string" && data.includes('"attached"')) {
        await real.writeFile(path, "partial receipt");
        throw failure;
      }
      return real.writeFile(path, data, ...args);
    },
    async rm(path, options) {
      await real.rm(path, options);
      if (fail && String(path).endsWith(".tmp")) throw new Error("cleanup failed");
    },
  });
  const { StagedUploads: FreshStagedUploads, sessionLocalRoot } = await import(`./uploads.ts?fresh=receipt-failure`);
  const { dir, part, json } = staging();
  const staged = new FreshStagedUploads(() => {}, dir);
  const id = randomUUID();
  const sessionId = randomUUID();
  const sessionFile = join(scratch, "sessions", `${sessionId}.jsonl`);
  await staged.start({ id, attempt: randomUUID(), name: "original.bin", size: 3, type: "" });
  staged.write(id, new Uint8Array([1, 2, 3]));
  await until(() => !staged.open.has(id), "the completed write");
  const metadata = readFileSync(json(id), "utf8");
  const targetDir = join(sessionLocalRoot(sessionFile, sessionId), "uploads");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "existing.bin"), "untouched");
  try {
    await assert.rejects(staged.attach(id, sessionFile, sessionId), (error) => error === failure);
    assert.deepEqual(readdirSync(targetDir), ["existing.bin"], "no orphan or unrelated target removed");
    assert.equal(readFileSync(json(id), "utf8"), metadata, "original metadata is intact");
    assert.deepEqual([...readFileSync(part(id))], [1, 2, 3], "staged data is intact");
    assert.deepEqual(readdirSync(dir).sort(), [`${id}.json`, `${id}.part`].sort(), "no temporary receipt remains");
  } finally {
    fail = false;
  }
  const attached = await staged.attach(id, sessionFile, sessionId);
  assert.equal(attached.url, "local://uploads/original.bin", "retry reuses the original name");
  assert.deepEqual([...readFileSync(attached.path)], [1, 2, 3]);
});

test("abort waits for an active attach and sweep skips its busy staged files", async (t) => {
  const real = { ...await import("node:fs/promises") };
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const linked = new Promise((resolve) => { entered = resolve; });
  await mockBuiltin(t, "node:fs/promises", {
    async link(...args) {
      await real.link(...args);
      entered();
      await held;
    },
  });
  const { StagedUploads: FreshStagedUploads } = await import("./uploads.ts?fresh=abort-attach");
  const { dir, part, json } = staging();
  const staged = new FreshStagedUploads(() => {}, dir);
  const id = randomUUID();
  const sessionFile = join(scratch, "sessions", `${id}.jsonl`);
  const sessionId = randomUUID();
  await staged.start({ id, attempt: randomUUID(), name: "race.bin", size: 0, type: "" });
  const attaching = staged.attach(id, sessionFile, sessionId);
  await linked;
  let aborted = false;
  const aborting = staged.abort(id).then(() => { aborted = true; });
  try {
    await sleep(20);
    assert.equal(aborted, false, "abort cannot overtake attach");
    await staged.sweep(Date.now() + STAGED_MAX_AGE_MS + 1000);
    assert.equal(existsSync(part(id)), true, "sweep leaves an active attach alone");
    assert.equal(existsSync(json(id)), true);
    await staged.start({ id: randomUUID(), attempt: randomUUID(), name: "independent.bin", size: 0, type: "" });
  } finally {
    release();
    await attaching;
    await aborting;
  }
  assert.equal(existsSync(json(id)), false, "attach cannot recreate the aborted receipt");
  assert.equal(existsSync(part(id)), false);
  await assert.rejects(staged.attach(id, sessionFile, sessionId), { status: 404, code: "upload_missing" });
});

test("concurrent attaches of one id return one receipt and one target", async () => {
  const { staged } = staging();
  const id = randomUUID();
  const sessionId = randomUUID();
  const sessionFile = join(scratch, "sessions", `${id}.jsonl`);
  await staged.start({ id, attempt: randomUUID(), name: "single.bin", size: 0, type: "" });
  const [first, second] = await Promise.all([staged.attach(id, sessionFile, sessionId), staged.attach(id, sessionFile, sessionId)]);
  assert.deepEqual(second, first);
  assert.deepEqual(readdirSync(dirname(first.path)), ["single.bin"]);
});

test("sweep rechecks a staged id that becomes busy while its stat is pending", async (t) => {
  const real = { ...await import("node:fs/promises") };
  let releaseStat;
  let enterStat;
  let releaseLink;
  let enterLink;
  const statHeld = new Promise((resolve) => { releaseStat = resolve; });
  const statEntered = new Promise((resolve) => { enterStat = resolve; });
  const linkHeld = new Promise((resolve) => { releaseLink = resolve; });
  const linkEntered = new Promise((resolve) => { enterLink = resolve; });
  let holdStat = false;
  await mockBuiltin(t, "node:fs/promises", {
    async stat(path, ...args) {
      const value = await real.stat(path, ...args);
      if (holdStat) {
        holdStat = false;
        enterStat();
        await statHeld;
      }
      return value;
    },
    async link(...args) {
      await real.link(...args);
      enterLink();
      await linkHeld;
    },
  });
  const { StagedUploads: FreshStagedUploads } = await import("./uploads.ts?fresh=sweep-attach");
  const { dir, part, json } = staging();
  const staged = new FreshStagedUploads(() => {}, dir);
  const id = randomUUID();
  await staged.start({ id, attempt: randomUUID(), name: "busy.bin", size: 0, type: "" });
  holdStat = true;
  const sweeping = staged.sweep(Date.now() + STAGED_MAX_AGE_MS + 1000);
  await statEntered;
  const attaching = staged.attach(id, join(scratch, "sessions", `${id}.jsonl`), randomUUID());
  await linkEntered;
  releaseStat();
  try {
    await sweeping;
    assert.equal(existsSync(part(id)), true, "sweep must not remove an active attach's part");
    assert.equal(existsSync(json(id)), true, "sweep must not remove an active attach's metadata");
  } finally {
    releaseLink();
    await attaching;
  }
});

test("start requires a UUID attempt", async () => {
  const { staged } = staging();
  for (const attempt of [undefined, "", "not-a-uuid", 1]) {
    await assert.rejects(staged.start({ id: randomUUID(), attempt, name: "x", size: 0, type: "" }), { status: 400, code: "invalid_request" });
  }
});

test("resuming drains old writes and tags queued errors, progress and done with their originating attempt", async (t) => {
  const real = { ...await import("node:fs/promises") };
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const writing = new Promise((resolve) => { entered = resolve; });
  let fail = true;
  await mockBuiltin(t, "node:fs/promises", {
    async appendFile(...args) {
      if (fail) {
        entered();
        await held;
        throw new Error("old write failed");
      }
      return real.appendFile(...args);
    },
  });
  const { StagedUploads: FreshStagedUploads } = await import("./uploads.ts?fresh=attempt-identity");
  const { dir } = staging();
  const acks = [];
  const staged = new FreshStagedUploads((ack) => acks.push(ack), dir);
  const id = randomUUID();
  const oldAttempt = randomUUID();
  const newAttempt = randomUUID();
  const args = { id, name: "attempt.bin", size: 3, type: "" };
  await staged.start({ ...args, attempt: oldAttempt });
  staged.write(id, new Uint8Array(1));
  await writing;
  const resumed = staged.start({ ...args, attempt: newAttempt });
  release();
  assert.deepEqual(await resumed, { received: 0, done: false });
  assert.equal(acks.length, 1);
  assert.equal(acks[0].attempt, oldAttempt, "a queued old write failure retains its identity");
  assert.equal(acks[0].error.code, "upload_write_failed");
  fail = false;
  staged.write(id, new Uint8Array(1));
  await until(() => acks.length === 2, "progress ack");
  assert.equal(acks[1].attempt, newAttempt);
  assert.equal(acks[1].done, false);
  staged.write(id, new Uint8Array(2));
  await until(() => acks.length === 3, "done ack");
  assert.equal(acks[2].attempt, newAttempt);
  assert.equal(acks[2].done, true);
});

test("a resumed upload waits for the failed attempt's file cleanup", async (t) => {
  const real = { ...await import("node:fs/promises") };
  const { promise: cleaning, resolve: markCleaning } = Promise.withResolvers();
  const { promise: cleanup, resolve: finishCleanup } = Promise.withResolvers();
  let failWrite = true;
  await mockBuiltin(t, "node:fs/promises", {
    async appendFile(...args) {
      if (failWrite) throw new Error("old write failed");
      return real.appendFile(...args);
    },
    async rm(path, ...args) {
      if (failWrite && String(path).endsWith(".part")) {
        markCleaning();
        await cleanup;
      }
      return real.rm(path, ...args);
    },
  });
  const { StagedUploads: FreshStagedUploads } = await import("./uploads.ts?fresh=cleanup-order");
  const { dir } = staging();
  const acks = [];
  const staged = new FreshStagedUploads((ack) => acks.push(ack), dir);
  const id = randomUUID();
  const args = { id, name: "cleanup.bin", size: 1, type: "" };
  await staged.start({ ...args, attempt: randomUUID() });
  staged.write(id, new Uint8Array(1));
  await cleaning;
  const newAttempt = randomUUID();
  const resumed = staged.start({ ...args, attempt: newAttempt });
  try {
    assert.equal(await Promise.race([resumed.then(() => "resolved"), sleep(50).then(() => "pending")]), "pending");
  } finally {
    finishCleanup();
  }
  assert.deepEqual(await resumed, { received: 0, done: false });
  failWrite = false;
  const bytes = new Uint8Array([42]);
  staged.write(id, bytes);
  await until(() => acks.some((ack) => ack.attempt === newAttempt && ack.done), "the resumed file to finish");
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, `${id}.part`))), bytes);
});

test("resuming an open upload clears pending old progress before adopting its next attempt", async () => {
  const { staged, acks } = staging();
  const id = randomUUID();
  const oldAttempt = randomUUID();
  const newAttempt = randomUUID();
  const args = { id, name: "pending.bin", size: 3, type: "" };
  await staged.start({ ...args, attempt: oldAttempt });
  staged.write(id, new Uint8Array(1));
  await staged.open.get(id).chain;
  assert.deepEqual(await staged.start({ ...args, attempt: newAttempt }), { received: 1, done: false });
  await sleep(40);
  assert.deepEqual(acks, [], "old coalesced progress is cancelled, not relabelled as the new attempt");
  staged.write(id, new Uint8Array(2));
  await until(() => acks.length === 1, "the final ack");
  assert.equal(acks[0].attempt, newAttempt);
  assert.equal(acks[0].done, true);
});

test("sanitizeUploadName caps bytes, renames Windows device names, strips trailing dots, spaces and bidi controls", () => {
  const japanese = sanitizeUploadName(`${"あ".repeat(100)}.pdf`);
  assert.ok(Buffer.byteLength(japanese) <= 200, japanese);
  assert.ok(japanese.endsWith(".pdf"));
  assert.ok(japanese.startsWith("あ"));

  const emoji = sanitizeUploadName(`a${"😀".repeat(60)}.txt`);
  assert.ok(Buffer.byteLength(emoji) <= 200);
  assert.ok(emoji.isWellFormed(), "no lone surrogate at the cut");
  assert.ok(!emoji.includes("\ufffd"));
  assert.ok(emoji.endsWith("😀.txt"));
  assert.equal(sanitizeUploadName(`${"a".repeat(199)} ${"b".repeat(10)}`), "a".repeat(199), "no trailing space after the cut");

  for (const name of ["CON", "con.txt", "nul.tar.gz", "COM1.txt", "lpt9", "aux .txt"]) assert.equal(sanitizeUploadName(name), `_${name}`);
  assert.equal(sanitizeUploadName("CONSOLE.txt"), "CONSOLE.txt");
  assert.equal(sanitizeUploadName("com10"), "com10");

  assert.equal(sanitizeUploadName("name."), "name");
  assert.equal(sanitizeUploadName("a.b. "), "a.b");
  assert.equal(sanitizeUploadName("evil\u202Etxt.exe"), "eviltxt.exe");
  assert.equal(sanitizeUploadName("..."), "file");
  assert.equal(sanitizeUploadName(""), "file");
  assert.equal(sanitizeUploadName("a<b>:c|d?.txt"), "a_b__c_d_.txt");
});
