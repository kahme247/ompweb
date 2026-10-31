import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const { archiveSessionFileWithArtifacts } = await import("./session-files.ts");

test("archives native JSONL and sibling artifacts with an exact gzip round trip", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-test-"));
  try {
    const sessionsRoot = join(root, "sessions");
    const archiveRoot = join(root, "archive", "sessions");
    const projectDir = join(sessionsRoot, "project");
    const source = join(projectDir, "2026_session.jsonl");
    const artifacts = join(projectDir, "2026_session");
    const original = Buffer.from('{"type":"session","version":3,"id":"abc"}\n{"type":"message"}\n', "utf8");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(source, original);
    writeFileSync(join(artifacts, "child.jsonl"), "child\n");

    const archived = archiveSessionFileWithArtifacts(source, { sessionsRoot, archiveRoot });

    assert.equal(archived, join(archiveRoot, "project", "2026_session.jsonl.gz"));
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(artifacts), false);
    assert.deepEqual(gunzipSync(readFileSync(archived)), original);
    assert.equal(readFileSync(join(archiveRoot, "project", "2026_session.jsonl", "child.jsonl"), "utf8"), "child\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects paths outside the active sessions root before creating an archive", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-test-"));
  try {
    const sessionsRoot = join(root, "sessions");
    const outside = join(root, "outside.jsonl");
    mkdirSync(sessionsRoot, { recursive: true });
    writeFileSync(outside, "not a session\n");
    assert.throws(
      () => archiveSessionFileWithArtifacts(outside, { sessionsRoot, archiveRoot: join(root, "archive") }),
      /outside the active OMP sessions directory/,
    );
    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
