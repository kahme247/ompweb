import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { sessionOps } = await import("./session-ops.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

/** Throwaway agent dir holding one fixture session (as in session-reader.test.mjs). */
function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-ops-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    { type: "session", version: 3, id: SESSION_ID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", provider: "test", model: "m", content: [{ type: "text", text: "hi" }] } },
  ];
  writeFileSync(join(projectDir, "2026-01-01_fixture.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  return Promise.resolve(run()).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
}

const options = { deferThinking: false, deferMedia: false };

test("readSession returns the session's info and context", () => withAgentDir(async () => {
  const result = await sessionOps.readSession(SESSION_ID, options);
  assert.equal(result.ok, true);
  assert.equal(result.value.info.id, SESSION_ID);
  assert.ok(result.value.context.messages.length > 0);
}));

test("readSession of an unknown id is a 404", () => withAgentDir(async () => {
  const result = await sessionOps.readSession("missing", options);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "session_not_found");
}));

test("readMedia rejects a hash that is not 64 lowercase hex chars", () => withAgentDir(async () => {
  const result = await sessionOps.readMedia("x");
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
}));

test("readMedia returns stored bytes and 404s a missing blob", () => withAgentDir(async () => {
  const hash = "a".repeat(64);
  assert.equal((await sessionOps.readMedia(hash)).status, 404);
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "blobs"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "blobs", hash), "bytes");
  const result = await sessionOps.readMedia(hash);
  assert.equal(result.ok, true);
  assert.ok(result.value instanceof Uint8Array);
  assert.equal(Buffer.from(result.value).toString(), "bytes");
}));

test("renameSessionFile renames the session in listSessions", () => withAgentDir(async () => {
  assert.deepEqual(await sessionOps.renameSessionFile(SESSION_ID, "Renamed"), { ok: true, value: null });
  const session = (await sessionOps.listSessions()).find((s) => s.id === SESSION_ID);
  assert.equal(session?.name, "Renamed");
  assert.equal((await sessionOps.renameSessionFile("missing", "x")).status, 404);
}));

test("preparePoolProject rejects malformed authenticated inputs without a launchable cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-pool-op-input-"));
  const valid = {
    projectId: "registered-project", creationId: "creation-1",
    origin: "https://fixture.invalid/repo.git", cloneRoot: join(root, "checkout"),
  };
  try {
    for (const input of [
      undefined, null, [], "project", {},
      ...["projectId", "creationId", "origin", "cloneRoot"].flatMap((key) =>
        [undefined, null, 1, {}, []].map((value) => ({ ...valid, [key]: value }))),
      { ...valid, projectId: "../outside" },
      { ...valid, creationId: "two words" },
      { ...valid, creationId: "x".repeat(129) },
      { ...valid, origin: "file:///outside.git" },
      { ...valid, origin: "https://user:secret@fixture.invalid/repo.git" },
      { ...valid, cloneRoot: "relative/checkout" },
      { ...valid, cloneRoot: `${root}/child/../checkout` },
      ...[null, 1, [], {}].map((ref) => ({ ...valid, ref })),
    ]) {
      const result = await sessionOps.preparePoolProject(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.equal(typeof result.code, "string");
      assert.equal(typeof result.error, "string");
      assert.equal(result.value, undefined, "invalid input cannot supply a launchable cwd");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
