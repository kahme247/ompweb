import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture(t) {
  const { WorkspaceReads } = await import("./workspace-reads.ts");
  const dir = mkdtempSync(join(tmpdir(), "omp-read-handles-"));
  const path = join(dir, "source.txt");
  writeFileSync(path, "original bytes");
  const reads = new WorkspaceReads();
  const handle = await open(path, "r");
  const ticket = reads.add(handle, { path, name: "source.txt", size: 14, mtimeMs: 0, isDirectory: false, language: "text", mime: "text/plain", previewKind: null });
  t.after(async () => { await reads.closeAll(); rmSync(dir, { recursive: true, force: true }); });
  return { reads, ticket, path, dir };
}

test("a read handle stays on the opened file when its pathname is replaced", async (t) => {
  const { reads, ticket, path } = await fixture(t);
  assert.equal(Buffer.from(await reads.read(ticket.id, 0, 8)).toString(), "original");
  renameSync(path, `${path}.old`);
  writeFileSync(path, "replacement!!!");
  assert.equal(Buffer.from(await reads.read(ticket.id, 8, 6)).toString(), " bytes");
});

test("read handles reject invalid ranges and cannot be used after close", async (t) => {
  const { reads, ticket } = await fixture(t);
  for (const [offset, length] of [[-1, 1], [0, 0], [0, 262145], [0.5, 1], [14, 1]]) {
    await assert.rejects(reads.read(ticket.id, offset, length), (error) => error.status === 400);
  }
  await reads.close(ticket.id);
  await reads.close(ticket.id);
  await assert.rejects(reads.read(ticket.id, 0, 1), (error) => error.status === 404);
});

test("truncated files fail rather than quietly completing an incomplete download", async (t) => {
  const { reads, ticket, path } = await fixture(t);
  writeFileSync(path, "short");
  await assert.rejects(reads.read(ticket.id, 0, 14), (error) => error.code === "file_changed");
});
