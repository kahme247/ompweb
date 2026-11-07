import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import test from "node:test";

const { listArchivedSessions, restoreArchivedSession, restoreFailureStatus, MAX_ARCHIVE_COMPRESSED_BYTES, MAX_ARCHIVE_EXPANDED_BYTES } = await import("./archive.ts");
const SESSION_ID = "12345678-1234-4234-8234-123456789abc";

function sessionBody(id = SESSION_ID) {
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

    const restoredId = await restoreArchivedSession(listed[0].key, sessions, archive);
    assert.equal(restoredId, SESSION_ID);
    assert.equal(existsSync(join(sessions, "project", "2026_session.jsonl")), true);
    assert.equal(readFileSync(join(sessions, "project", "2026_session", "child.jsonl"), "utf8"), "child\n");
    assert.equal(existsSync(archiveFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects traversal archive keys", async () => {
  await assert.rejects(
    () => restoreArchivedSession("../outside.jsonl.gz", "sessions", "archive"),
    /Invalid archive key/,
  );
});

for (const escape of ["source ancestor", "destination ancestor", "source artifacts", "destination artifacts"]) {
  test(`rejects escaping symlink at ${escape} without changing archive or outside data`, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-escape-"));
    try {
      const sessions = join(root, "sessions");
      const archive = join(root, "archive");
      const outside = join(root, "outside");
      mkdirSync(join(archive, "project"), { recursive: true });
      mkdirSync(join(sessions, "project"), { recursive: true });
      mkdirSync(outside);
      const compressed = gzipSync(Buffer.from(sessionBody()));
      const archiveFile = join(escape === "source ancestor" ? outside : join(archive, "project"), "session.jsonl.gz");
      writeFileSync(archiveFile, compressed);
      writeFileSync(join(outside, "sentinel"), "unchanged");
      if (escape.endsWith("ancestor")) {
        const project = join(escape === "source ancestor" ? archive : sessions, "project");
        rmSync(project, { recursive: true });
        symlinkSync(outside, project);
      } else {
        symlinkSync(outside, escape === "source artifacts"
          ? join(archive, "project", "session.jsonl")
          : join(sessions, "project", "session"));
      }

      await assert.rejects(() => restoreArchivedSession("project/session.jsonl.gz", sessions, archive), /Invalid archive key/);
      assert.deepEqual(readFileSync(archiveFile), compressed);
      assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "unchanged");
      assert.equal(existsSync(join(outside, "session.jsonl")), false);
      assert.equal(existsSync(join(sessions, "project", "session.jsonl")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("restores byte-identical transcript and artifacts into a missing project parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-missing-parent-"));
  try {
    const sessions = join(root, "sessions");
    const archive = join(root, "archive");
    const source = join(archive, "project", "session.jsonl.gz");
    const body = Buffer.from(sessionBody() + "\n");
    const artifact = Buffer.from([0, 255, 13, 10]);
    mkdirSync(join(archive, "project", "session.jsonl"), { recursive: true });
    writeFileSync(source, gzipSync(body));
    writeFileSync(join(archive, "project", "session.jsonl", "artifact"), artifact);

    assert.equal(await restoreArchivedSession("project/session.jsonl.gz", sessions, archive), SESSION_ID);
    assert.deepEqual(readFileSync(join(sessions, "project", "session.jsonl")), body);
    assert.deepEqual(readFileSync(join(sessions, "project", "session", "artifact")), artifact);
    assert.equal(existsSync(source), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported archived IDs before publishing or moving artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-invalid-id-"));
  try {
    const archive = join(root, "archive");
    const sessions = join(root, "sessions");
    mkdirSync(join(archive, "session.jsonl"), { recursive: true });
    const source = join(archive, "session.jsonl.gz");
    const compressed = gzipSync(sessionBody("legacy-id"));
    writeFileSync(source, compressed);
    writeFileSync(join(archive, "session.jsonl", "artifact"), "retained");
    assert.equal((await listArchivedSessions(archive))[0].id, "legacy-id");
    await assert.rejects(() => restoreArchivedSession("session.jsonl.gz", sessions, archive), /Invalid archived session ID/);
    assert.equal(restoreFailureStatus("Invalid archived session ID"), 400);
    assert.deepEqual(readFileSync(source), compressed);
    assert.equal(readFileSync(join(archive, "session.jsonl", "artifact"), "utf8"), "retained");
    assert.equal(existsSync(join(sessions, "session.jsonl")), false);
    assert.equal(existsSync(join(sessions, "session")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const limit of ["compressed", "expanded"]) {
  test(`rejects archives exceeding the ${limit} limit without consuming data`, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-limit-"));
    try {
      const archive = join(root, "archive");
      const sessions = join(root, "sessions");
      mkdirSync(join(archive, "session.jsonl"), { recursive: true });
      const source = join(archive, "session.jsonl.gz");
      writeFileSync(join(archive, "session.jsonl", "artifact"), "retained");
      if (limit === "compressed") {
        writeFileSync(source, gzipSync(sessionBody()));
        truncateSync(source, MAX_ARCHIVE_COMPRESSED_BYTES + 1);
      } else {
        const chunk = Buffer.alloc(1024 * 1024, " ");
        await pipeline(Readable.from((function* () {
          yield sessionBody();
          for (let written = 0; written <= MAX_ARCHIVE_EXPANDED_BYTES; written += chunk.length) yield chunk;
        })()), createGzip(), createWriteStream(source));
      }
      const compressed = limit === "expanded" ? readFileSync(source) : null;
      const sourceSize = statSync(source).size;
      await assert.rejects(() => restoreArchivedSession("session.jsonl.gz", sessions, archive), new RegExp(`Archived session ${limit} size exceeds 256 MiB limit`));
      assert.equal(statSync(source).size, sourceSize);
      if (compressed) assert.deepEqual(readFileSync(source), compressed);
      assert.equal(readFileSync(join(archive, "session.jsonl", "artifact"), "utf8"), "retained");
      assert.equal(existsSync(join(sessions, "session.jsonl")), false);
      assert.equal(existsSync(join(sessions, "session")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("restore yields to the event loop before completing streamed I/O", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-async-"));
  try {
    const archive = join(root, "archive");
    mkdirSync(archive);
    writeFileSync(join(archive, "session.jsonl.gz"), gzipSync(sessionBody()));
    let completed = false;
    const restoring = restoreArchivedSession("session.jsonl.gz", join(root, "sessions"), archive);
    assert.ok(restoring instanceof Promise);
    const tracked = restoring.then((id) => { completed = true; return id; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(await tracked, SESSION_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["destination", "artifacts", "corrupt gzip"]) {
  test(`preserves source on ${failure} failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-rollback-"));
    try {
      const archive = join(root, "archive");
      const sessions = join(root, "sessions");
      mkdirSync(archive);
      mkdirSync(sessions);
      const source = join(archive, "session.jsonl.gz");
      const compressed = failure === "corrupt gzip" ? Buffer.from("not gzip") : gzipSync(sessionBody());
      writeFileSync(source, compressed);
      if (failure === "destination") writeFileSync(join(sessions, "session.jsonl"), "existing");
      if (failure === "artifacts") writeFileSync(join(archive, "session.jsonl"), "invalid artifacts");
      await assert.rejects(() => restoreArchivedSession("session.jsonl.gz", sessions, archive));
      assert.deepEqual(readFileSync(source), compressed);
      if (failure === "destination") assert.equal(readFileSync(join(sessions, "session.jsonl"), "utf8"), "existing");
      else assert.equal(existsSync(join(sessions, "session.jsonl")), false);
      if (failure === "artifacts") assert.equal(readFileSync(join(archive, "session.jsonl"), "utf8"), "invalid artifacts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("restores a native title-slot-prefixed header byte-for-byte", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-title-slot-"));
  try {
    const archive = join(root, "archive");
    const sessions = join(root, "sessions");
    mkdirSync(archive);
    const body = JSON.stringify({ type: "title", v: 1, title: "Slot title", updatedAt: "2026-08-20T12:00:00.000Z", pad: "" }) + "\n" + sessionBody();
    writeFileSync(join(archive, "session.jsonl.gz"), gzipSync(body));
    assert.equal(await restoreArchivedSession("session.jsonl.gz", sessions, archive), SESSION_ID);
    assert.equal(readFileSync(join(sessions, "session.jsonl"), "utf8"), body);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
