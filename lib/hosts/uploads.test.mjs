// The daemon's staging (StagedUploads) against a temp dir, and sanitizeUploadName; no hub or daemon needed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

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
  await staged.start({ id: idle, name: "idle.bin", size: 10, type: "" });
  staged.write(idle, new Uint8Array(2));
  await until(() => statSync(part(idle)).size === 2, "the write");
  const fresh = randomUUID();
  await staged.start({ id: fresh, name: "fresh.bin", size: 10, type: "" });
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

test("a write keeps an open upload alive for another STAGED_MAX_AGE_MS", async () => {
  const { staged, part } = staging();
  const id = randomUUID();
  const realNow = Date.now;
  const started = realNow();
  try {
    await staged.start({ id, name: "slow.bin", size: 10, type: "" });
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
  assert.deepEqual(await staged.start({ id, name: "x", size: 5, type: "" }), { received: 0, done: false });
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
  const args = { id, name: "x.bin", size: 10, type: "" };
  assert.deepEqual(await Promise.all([staged.start(args), staged.start(args)]), [{ received: 0, done: false }, { received: 0, done: false }]);
  assert.equal(metaReads, 1, "only the first start installed the upload");
  assert.equal(statSync(part(id)).size, 0);
});

test("a start for an open id with another name, type or size fails 409 upload_id_conflict", async () => {
  const { staged } = staging();
  const id = randomUUID();
  await staged.start({ id, name: "x.bin", size: 10, type: "a/b" });
  const conflict = { status: 409, code: "upload_id_conflict" };
  for (const other of [{ name: "y.bin" }, { type: "a/c" }, { size: 11 }]) {
    await assert.rejects(staged.start({ id, name: "x.bin", size: 10, type: "a/b", ...other }), conflict);
  }
  assert.deepEqual(await staged.start({ id, name: "x.bin", size: 10, type: "a/b" }), { received: 0, done: false }, "the same file resumes");
});

test("a closed partial of another name or type is reset, the same file resumes", async () => {
  const { dir, part, json } = staging();
  const id = randomUUID();
  writeFileSync(json(id), JSON.stringify({ name: "x.bin", size: 5, type: "a/b", created: Date.now() }));
  writeFileSync(part(id), new Uint8Array(3));
  assert.deepEqual(await new StagedUploads(() => {}, dir).start({ id, name: "x.bin", size: 5, type: "a/b" }), { received: 3, done: false });
  for (const other of [{ name: "y.bin" }, { type: "a/c" }]) {
    writeFileSync(part(id), new Uint8Array(3));
    assert.deepEqual(await new StagedUploads(() => {}, dir).start({ id, name: "x.bin", size: 5, type: "a/b", ...other }), { received: 0, done: false });
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
  await staged.start({ id: open, name: "open", size: 5, type: "" });
  appendFileSync(part(open), new Uint8Array(5));
  await assert.rejects(staged.attach(open, sessionFile, sessionId), incomplete);
});

test("an attach retried after a lost reply returns its receipt: one file, same path; another session file gets 404", async () => {
  const { dir, staged, acks, part, json } = staging();
  const sessionFile = join(scratch, "sessions", "r.jsonl");
  const sessionId = randomUUID();
  const id = randomUUID();
  await staged.start({ id, name: "r.bin", size: 3, type: "a/b" });
  staged.write(id, new Uint8Array(3));
  await until(() => acks.some((ack) => ack.id === id && ack.done), "the done ack");
  const first = await staged.attach(id, sessionFile, sessionId);
  assert.equal(existsSync(part(id)), false, "the part is gone");
  assert.equal(existsSync(json(id)), true, "the receipt stays");
  assert.deepEqual(await staged.attach(id, sessionFile, sessionId), first);
  assert.deepEqual(await new StagedUploads(() => {}, dir).attach(id, sessionFile, sessionId), first, "the receipt survives a daemon restart");
  assert.deepEqual(readdirSync(dirname(first.path)), ["r.bin"], "exactly one attached file");
  await assert.rejects(staged.attach(id, join(scratch, "sessions", "other.jsonl"), sessionId), { status: 404, code: "upload_missing" });
  assert.deepEqual(await staged.start({ id, name: "r.bin", size: 3, type: "a/b" }), { received: 3, done: true }, "a start for it reports it done");
  for (const other of [{ name: "different.bin" }, { type: "a/c" }, { size: 4 }]) {
    await assert.rejects(staged.start({ id, name: "r.bin", size: 3, type: "a/b", ...other }), { status: 409, code: "upload_id_conflict" });
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
  await staged.start({ id, name: "removed.bin", size: 0, type: "" });
  const attached = await staged.attach(id, sessionFile, sessionId);
  rmSync(attached.path);
  await assert.rejects(staged.attach(id, sessionFile, sessionId), { status: 404, code: "upload_missing" });
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
