import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { mock, test } from "bun:test";

// The daemon's real restore op; fs/promises only gains a hook that plays a concurrent directory swap.
let afterFs = null;
const realFs = { ...(await import("fs/promises")) };
const hooked = Object.fromEntries(["mkdir", "mkdtemp", "open", "rm"].map((name) => [name, async (...args) => {
  if (name === "rm") await afterFs?.(name, args);
  const result = await realFs[name](...args);
  if (name !== "rm") await afterFs?.(name, args, result);
  return result;
}]));
mock.module("fs/promises", () => ({ ...realFs, default: { ...realFs.default, ...hooked }, ...hooked }));
const { sessionOps } = await import("./session-ops.ts");

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
  // A claim is spent by its restore: a repeat of its request is refused.
  assert.deepEqual(notAdmitted(await sessionOps.restoreArchive(KEY, claim)), [false, 409, "archive_restore_not_admitted"]);
  const required = { ok: false, status: 400, code: "archive_claim_required", error: "Restore claim is required" };
  assert.deepEqual(await sessionOps.restoreReserve(""), required);
  assert.deepEqual(await sessionOps.restoreFence(""), required);
}));

test("the reservation cap drops the oldest claim, whose restore is then refused rather than run", () => withArchive(async ({ archiveFile }) => {
  // More than the cap, so whatever earlier tests left reserved is dropped too.
  for (let i = 0; i < 300; i++) await sessionOps.restoreReserve(`capped-${i}`);
  assert.equal((await sessionOps.restoreArchive(KEY, "capped-0")).code, "archive_restore_not_admitted");
  assert.equal(existsSync(archiveFile), true);
  assert.equal((await sessionOps.restoreArchive(KEY, "capped-299")).ok, true);
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
