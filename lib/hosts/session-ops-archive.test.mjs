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

test("restoreArchive round-trips an archived transcript and its artifacts", () => withArchive(async ({ archiveFile, project }) => {
  assert.deepEqual((await sessionOps.listArchives()).map((entry) => entry.key), [KEY]);
  assert.deepEqual(await sessionOps.restoreArchive(KEY), { ok: true, value: { sessionId: SESSION_ID } });
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
  const results = await Promise.all(Array.from({ length: 4 }, () => sessionOps.restoreArchive(KEY)));
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
    const result = await sessionOps.restoreArchive(KEY);
    assert.deepEqual([result.ok, result.status, result.error], [false, 400, "Invalid archive key"]);
    assert.ok(before, "the swap ran");
    for (const entry of tree()) seen.add(entry);
    assert.deepEqual([...seen].filter((entry) => !before.includes(entry)), [], "created outside the sessions root");
    assert.deepEqual(readFileSync(archiveFile), compressed);
  }));
}
