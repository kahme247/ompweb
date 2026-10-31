import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

const { listArchivedSessions, restoreArchivedSession } = await import("./archive.ts");

function sessionBody(id = "archived-id") {
  return [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/workspace/project", timestamp: "2026-08-20T12:00:00.000Z", title: "Archived work" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-08-20T12:00:01.000Z", message: { role: "user", content: "Fix the archived issue" } }),
  ].join("\n") + "\n";
}

test("lists archive metadata and restores the session with artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-browser-"));
  try {
    const sessions = join(root, "sessions");
    const archive = join(root, "archive", "sessions");
    const archiveFile = join(archive, "project", "2026_session.jsonl.gz");
    mkdirSync(join(archive, "project", "2026_session.jsonl"), { recursive: true });
    mkdirSync(join(sessions, "project"), { recursive: true });
    writeFileSync(join(archive, "project", "2026_session.jsonl", "child.jsonl"), "child\n");
    writeFileSync(archiveFile, gzipSync(Buffer.from(sessionBody())));

    const listed = await listArchivedSessions(archive);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, "project/2026_session.jsonl.gz");
    assert.equal(listed[0].firstMessage, "Fix the archived issue");
    assert.equal(listed[0].messageCount, 1);

    const restoredId = restoreArchivedSession(listed[0].key, sessions, archive);
    assert.equal(restoredId, "archived-id");
    assert.equal(existsSync(join(sessions, "project", "2026_session.jsonl")), true);
    assert.equal(readFileSync(join(sessions, "project", "2026_session", "child.jsonl"), "utf8"), "child\n");
    assert.equal(existsSync(archiveFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects traversal archive keys", () => {
  assert.throws(
    () => restoreArchivedSession("../outside.jsonl.gz", "sessions", "archive"),
    /Invalid archive key/,
  );
});
