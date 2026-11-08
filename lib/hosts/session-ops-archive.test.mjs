import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { mock, test } from "bun:test";

// The daemon's real restore op; fs/promises only gains a hook that plays a concurrent directory swap.
let afterFs = null;
const realFs = { ...(await import("fs/promises")) };
const hooked = Object.fromEntries(["mkdir", "mkdtemp", "open", "rm", "lstat", "realpath", "rename", "unlink"].map((name) => [name, async (...args) => {
  if (name === "rm") await afterFs?.(name, args);
  const result = await realFs[name](...args);
  if (name !== "rm") await afterFs?.(name, args, result);
  return result;
}]));
mock.module("fs/promises", () => ({ ...realFs, default: { ...realFs.default, ...hooked }, ...hooked }));
const { sessionOps } = await import("./session-ops.ts");
const { StagedUploads } = await import("./uploads.ts");

const SESSION_ID = "21111111-2222-4333-8444-555555555555";
const KEY = "-project/2026_restored.jsonl.gz";
const BODY = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: SESSION_ID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" })}\n`);

async function withArchive(run) {
  const root = mkdtempSync(join(tmpdir(), "omp-web-session-ops-archive-"));
  const agent = join(root, "agent");
  const archived = join(agent, "archive", "sessions", "-project");
  mkdirSync(join(archived, "2026_restored.jsonl"), { recursive: true });
  const compressed = gzipSync(BODY);
  writeFileSync(join(archived, "2026_restored.jsonl.gz"), compressed);
  writeFileSync(join(archived, "2026_restored.jsonl", "child.jsonl"), "child\n");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await run({ root, archiveFile: join(archived, "2026_restored.jsonl.gz"), compressed, project: join(agent, "sessions", "-project") });
  } finally {
    afterFs = null;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

let claims = 0;
/** Reserve a fresh claim token on the daemon, as main does before it sends a restore. */
async function admit() {
  const claim = `claim-${++claims}`;
  assert.equal((await sessionOps.restoreReserve(claim)).ok, true);
  return claim;
}

test("restoreArchive round-trips an archived transcript and its artifacts", () => withArchive(async ({ archiveFile, project }) => {
  assert.deepEqual((await sessionOps.listArchives()).map((entry) => entry.key), [KEY]);
  assert.deepEqual(await sessionOps.restoreArchive(KEY, await admit()), { ok: true, value: { sessionId: SESSION_ID } });
  assert.deepEqual(readFileSync(join(project, "2026_restored.jsonl")), BODY);
  assert.equal(readFileSync(join(project, "2026_restored", "child.jsonl"), "utf8"), "child\n");
  assert.equal(existsSync(archiveFile), false);
  assert.deepEqual(await sessionOps.listArchives(), []);
}));

test("a staged restore cannot consume a newer archive of the same session after another restore and re-archive", () => withArchive(async ({ archiveFile, project }) => {
  let staged;
  let release;
  const reached = new Promise((resolve) => { staged = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  afterFs = async (name, [file]) => {
    if (name !== "open" || !String(file).includes(".omp-web-restore-")) return;
    afterFs = null;
    staged();
    await gate;
  };
  const delayed = sessionOps.restoreArchive(KEY, await admit());
  try {
    await reached;
    assert.equal((await sessionOps.restoreArchive(KEY, await admit())).ok, true);
    const transcript = join(project, "2026_restored.jsonl");
    const newer = Buffer.concat([BODY, Buffer.from(`${JSON.stringify({ type: "message", id: "new-entry", message: { role: "user", content: [{ type: "text", text: "new work must survive" }] } })}\n`)]);
    writeFileSync(transcript, newer);
    writeFileSync(join(project, "2026_restored", "new-artifact"), "new work");
    assert.equal((await sessionOps.archiveSession(SESSION_ID)).ok, true);
    const compressed = readFileSync(archiveFile);
    release();
    const result = await delayed;
    assert.deepEqual([result.ok, result.status, result.code], [false, 409, "archive_restore_failed"]);
    assert.match(result.error, /generation changed/);
    assert.deepEqual(readFileSync(archiveFile), compressed);
    assert.equal(readFileSync(join(archiveFile.slice(0, -3), "new-artifact"), "utf8"), "new work");
    assert.equal(existsSync(transcript), false);
    // A fresh restore consumes the new generation, including the appended entry and new artifact.
    assert.equal((await sessionOps.restoreArchive(KEY, await admit())).ok, true);
    assert.deepEqual(readFileSync(transcript), newer);
    assert.equal(readFileSync(join(project, "2026_restored", "new-artifact"), "utf8"), "new work");
  } finally {
    release();
    await delayed;
  }
}));

test("concurrent restores of one key publish it once and refuse the rest without losing it", () => withArchive(async ({ archiveFile, project }) => {
  // Every restore has passed its checks and staged its copy before any of them publishes.
  let staged = 0;
  let publish;
  const allStaged = new Promise((resolve) => { publish = resolve; });
  afterFs = async (name, [path]) => {
    if (name !== "open" || !String(path).includes(".omp-web-restore-")) return;
    if (++staged === 4) publish();
    await allStaged;
  };
  const results = await Promise.all(Array.from({ length: 4 }, async () => sessionOps.restoreArchive(KEY, await admit())));
  assert.equal(staged, 4);
  assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
  for (const result of results.filter((entry) => !entry.ok)) {
    assert.deepEqual([result.status, result.code], [409, "archive_restore_failed"]);
    assert.match(result.error, /already exists/);
  }
  assert.deepEqual(readFileSync(join(project, "2026_restored.jsonl")), BODY);
  assert.equal(readFileSync(join(project, "2026_restored", "child.jsonl"), "utf8"), "child\n");
  assert.equal(existsSync(archiveFile), false);
  assert.deepEqual(readdirSync(project).sort(), ["2026_restored", "2026_restored.jsonl"], "no staging directory is left behind");
}));

test("a restore starts only under a reserved claim, and a fence revokes it and reports a running restore", () => withArchive(async ({ archiveFile, project }) => {
  const fence = async (claim) => (await sessionOps.restoreFence(claim)).value.running;
  const notAdmitted = (result) => [result.ok, result.status, result.code];
  assert.deepEqual(notAdmitted(await sessionOps.restoreArchive(KEY, "never-reserved")), [false, 409, "archive_restore_not_admitted"]);
  // The sender was suspended between its hold and its send: once another request fenced its claim, its restore is refused
  // however late it arrives, and nothing is consumed.
  await sessionOps.restoreReserve("suspended");
  assert.equal(await fence("suspended"), false);
  assert.deepEqual(notAdmitted(await sessionOps.restoreArchive(KEY, "suspended")), [false, 409, "archive_restore_not_admitted"]);
  assert.equal(existsSync(archiveFile), true);
  // The restore has staged its copy but not published it: the state a remote daemon is in when main's 30 s deadline lapses.
  let staged;
  const reached = new Promise((resolve) => { staged = resolve; });
  let proceed;
  const gate = new Promise((resolve) => { proceed = resolve; });
  afterFs = async (name, [path]) => {
    if (name !== "open" || !String(path).includes(".omp-web-restore-")) return;
    staged();
    await gate;
  };
  const claim = await admit();
  const restoring = sessionOps.restoreArchive(KEY, claim);
  // Running before the restore's first await: a fence right behind it on the link already sees it.
  assert.equal(await fence(claim), true);
  await reached;
  assert.equal(await fence(claim), true);
  assert.equal(await fence("another claim"), false);
  proceed();
  assert.equal((await restoring).ok, true);
  assert.equal(await fence(claim), false);
  assert.deepEqual(readFileSync(join(project, "2026_restored.jsonl")), BODY);
  const required = { ok: false, status: 400, code: "archive_claim_required", error: "Restore claim is required" };
  assert.deepEqual(await sessionOps.restoreReserve(""), required);
  assert.deepEqual(await sessionOps.restoreFence(""), required);
}));

test("a claim is spent by the restore it admitted, with no fence ever issued: a repeat of that request is refused, not attempted", () => withArchive(async () => {
  const notAdmitted = (result) => [result.ok, result.status, result.code];
  // No `restoreFence` is called on any claim here, so only spending can refuse a repeat. The refusal also precedes any attempt:
  // the archive is gone after the first restore, so an attempt would answer 404 `archive_restore_failed`, not 409 not-admitted.
  const done = await admit();
  assert.equal((await sessionOps.restoreArchive(KEY, done)).ok, true);
  assert.deepEqual(notAdmitted(await sessionOps.restoreArchive(KEY, done)), [false, 409, "archive_restore_not_admitted"]);
  // A restore that fails spends its claim as well: the repeat is refused rather than attempted again.
  const failed = await admit();
  const attempt = await sessionOps.restoreArchive(KEY, failed);
  assert.deepEqual([attempt.ok, attempt.status, attempt.code], [false, 404, "archive_restore_failed"]);
  assert.deepEqual(notAdmitted(await sessionOps.restoreArchive(KEY, failed)), [false, 409, "archive_restore_not_admitted"]);
}));

test("the reservation cap drops the oldest claim, whose restore is then refused rather than run", () => withArchive(async ({ archiveFile }) => {
  // More than the cap, so whatever earlier tests left reserved is dropped too.
  for (let i = 0; i < 300; i++) await sessionOps.restoreReserve(`capped-${i}`);
  assert.equal((await sessionOps.restoreArchive(KEY, "capped-0")).code, "archive_restore_not_admitted");
  assert.equal(existsSync(archiveFile), true);
  assert.equal((await sessionOps.restoreArchive(KEY, "capped-299")).ok, true);
}));

test("a second daemon process names itself, cannot revoke or spend a token the first reserved, and leaves the first's restore admitted", () => withArchive(async ({ archiveFile, project }) => {
  // A replacement daemon: another copy of the module, so another instance and other token sets, as a replaced or restarted
  // daemon process has. The first copy stands for the daemon that may still be running its admitted restore.
  const { sessionOps: replacement } = await import("./session-ops.ts?replacement-daemon");
  const first = (await sessionOps.restoreReserve("shared-claim")).value.instance;
  assert.equal(typeof first, "string");
  assert.notEqual(first, "");
  // The same for the process's whole life, in both ops.
  assert.equal((await sessionOps.restoreReserve("another-claim")).value.instance, first);
  assert.equal((await sessionOps.restoreFence("another-claim")).value.instance, first);
  // The replacement answers a fence for that claim as itself, running nothing: its "not running" is about its own process, which
  // main compares with the instance that reserved the claim and so does not take as the first's.
  const answer = (await replacement.restoreFence("shared-claim")).value;
  assert.notEqual(answer.instance, first);
  assert.equal(answer.running, false);
  // That fence revoked nothing in the first process, and the replacement refuses the request it never saw reserved.
  assert.equal((await replacement.restoreArchive(KEY, "shared-claim")).code, "archive_restore_not_admitted");
  assert.equal(existsSync(archiveFile), true);
  assert.equal((await sessionOps.restoreArchive(KEY, "shared-claim")).ok, true);
  assert.deepEqual(readFileSync(join(project, "2026_restored.jsonl")), BODY);
}));

test("an attachment accepted the moment the restored session is visible lands beside its archived artifacts, and the restore still succeeds", () => withArchive(async ({ archiveFile, project }) => {
  // The archive holds a file the transcript refers to as local://uploads/photo.txt.
  const archivedArtifacts = archiveFile.slice(0, -3);
  mkdirSync(join(archivedArtifacts, "local", "uploads"), { recursive: true });
  writeFileSync(join(archivedArtifacts, "local", "uploads", "photo.txt"), "archived");
  const transcript = join(project, "2026_restored.jsonl");
  const stem = join(project, "2026_restored");
  // Another tab's real staged upload, finished and waiting for a session to attach to: the same name as the archived file.
  const staged = new StagedUploads(() => {});
  const uploadId = randomUUID();
  await staged.start({ id: uploadId, attempt: randomUUID(), name: "photo.txt", size: 0, type: "" });
  // The first chance anything else gets after the session becomes visible: that tab's attach runs to completion right there,
  // as it can between the restore's own steps, before the restore goes on.
  let started = false;
  let artifactsInPlace = null;
  let attaching = null;
  afterFs = async () => {
    if (started || !existsSync(transcript)) return;
    started = true;
    artifactsInPlace = existsSync(join(stem, "local", "uploads", "photo.txt"));
    attaching = staged.attach(uploadId, transcript, SESSION_ID);
    await attaching;
  };
  const restored = await sessionOps.restoreArchive(KEY, await admit());
  assert.deepEqual(restored, { ok: true, value: { sessionId: SESSION_ID } }, "the attachment must not fail the restore");
  assert.ok(attaching, "the attachment ran once the session was visible");
  const receipt = await attaching;
  // The session was never visible without its archived artifacts, so the attach saw the archived name and took another.
  assert.equal(artifactsInPlace, true);
  assert.equal(receipt.url, "local://uploads/photo (1).txt");
  assert.equal(readFileSync(join(stem, "local", "uploads", "photo.txt"), "utf8"), "archived");
  assert.equal(readFileSync(receipt.path, "utf8"), "");
  assert.equal(readFileSync(join(stem, "child.jsonl"), "utf8"), "child\n");
  assert.deepEqual(readFileSync(transcript), BODY);
  assert.equal(existsSync(archiveFile), false);
  assert.equal(existsSync(archivedArtifacts), false);
}));

// Each point is checked by its own revalidation: the swap lands after the creation that precedes it.
for (const [point, matches] of [
  ["the project directory is created", (name, [path]) => name === "mkdir" && path.endsWith("-project")],
  ["the staging directory is created", (name) => name === "mkdtemp"],
  ["the staged transcript is written", (name, [path]) => name === "open" && String(path).includes(".omp-web-restore-")],
]) {
  // Windows cannot rename a directory holding an open file, and symlinks there need privileges.
  test.skipIf(process.platform === "win32")(`restoreArchive writes nothing outside the sessions root when the project turns into a symlink after ${point}`, () => withArchive(async ({ root, archiveFile, compressed, project }) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    const tree = () => readdirSync(outside, { recursive: true }).sort();
    let before = null;
    const seen = new Set();
    afterFs = async (name, args) => {
      if (before) {
        if (name === "rm") for (const entry of tree()) seen.add(entry);
        return;
      }
      if (!matches(name, args)) return;
      renameSync(project, join(outside, "moved"));
      symlinkSync(join(outside, "moved"), project);
      before = tree();
    };
    const result = await sessionOps.restoreArchive(KEY, await admit());
    assert.deepEqual([result.ok, result.status, result.error], [false, 400, "Invalid archive key"]);
    assert.ok(before, "the swap ran");
    for (const entry of tree()) seen.add(entry);
    assert.deepEqual([...seen].filter((entry) => !before.includes(entry)), [], "created outside the sessions root");
    assert.deepEqual(readFileSync(archiveFile), compressed);
  }));
}
