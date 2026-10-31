import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, promises as fsPromises, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The store and routes run against a throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-attachments-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const store = await jiti.import("./attachment-store.ts");
const { MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BATCH_FILES } = await jiti.import("./chat-attachments.ts");
const createRoute = await jiti.import("../app/api/attachments/route.ts");
const batchRoute = await jiti.import("../app/api/attachments/[batchId]/route.ts");

const attachmentsDir = join(agentDir, "omp-web", "attachments");
const bytes = (text) => new TextEncoder().encode(text);
const DAY = 24 * 60 * 60 * 1000;

function rejectsWith(fn, status, code) {
  return assert.rejects(fn, (error) => {
    assert.ok(error instanceof store.AttachmentError, `expected AttachmentError, got ${error}`);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

function throwsWith(fn, status, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof store.AttachmentError, `expected AttachmentError, got ${error}`);
    assert.equal(error.status, status);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("stores batches under <agent dir>/omp-web/attachments", () => {
  assert.equal(store.getAttachmentsDir(), attachmentsDir);
});

test("relative paths reject traversal, absolute paths, NUL and empty segments", () => {
  const { validateAttachmentPath } = store;
  assert.equal(validateAttachmentPath("dataset/sub/a b.csv"), null);
  assert.equal(validateAttachmentPath("report.pdf"), null);
  for (const bad of [
    "",
    "..",
    ".",
    "a/../b",
    "../outside",
    "a/./b",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "c:relative",
    "a\\..\\b",
    "a\0b",
    "a\nb",
    "a//b",
    "a/",
    `${"x".repeat(256)}/a`,
    "y".repeat(1025),
  ]) {
    assert.notEqual(validateAttachmentPath(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
  assert.notEqual(validateAttachmentPath(42), null);
  // Windows-only reserved characters and trailing dots/spaces.
  assert.equal(validateAttachmentPath("notes: draft.txt", "darwin"), null);
  assert.notEqual(validateAttachmentPath("notes: draft.txt", "win32"), null);
  assert.notEqual(validateAttachmentPath("folder./a", "win32"), null);
  // Windows device names, in every directory and with any extension.
  for (const reserved of ["CON", "nul.txt", "data/Aux.tar.gz", "COM1", "lpt9.log", "COM¹", "LPT³.txt", "PRN .txt"]) {
    assert.notEqual(validateAttachmentPath(reserved, "win32"), null, `${reserved} must be rejected on win32`);
    assert.equal(validateAttachmentPath(reserved, "darwin"), null, `${reserved} is an ordinary name elsewhere`);
  }
  for (const ordinary of ["COM0", "LPT0.txt", "CONSOLE.txt", "nullable", "com10", "my.con"]) {
    assert.equal(validateAttachmentPath(ordinary, "win32"), null, `${ordinary} is not reserved`);
  }
});

test("path sets reject duplicates (case-folded where the filesystem is) and file/folder clashes", () => {
  const { validateAttachmentPaths } = store;
  assert.equal(validateAttachmentPaths(["d/a.txt", "d/b/c.txt"], { caseInsensitive: true }), null);
  assert.match(validateAttachmentPaths([]), /No files/);
  assert.match(validateAttachmentPaths(["d/a.txt", "d/a.txt"], { caseInsensitive: false }), /Duplicate/);
  assert.match(validateAttachmentPaths(["d/A.txt", "d/a.txt"], { caseInsensitive: true }), /Duplicate/);
  assert.equal(validateAttachmentPaths(["d/A.txt", "d/a.txt"], { caseInsensitive: false }), null);
  assert.match(validateAttachmentPaths(["d/a", "d/a/b.txt"], { caseInsensitive: false }), /both a file and a folder/);
  assert.match(validateAttachmentPaths(["d/Sub/b.txt", "d/sub"], { caseInsensitive: true }), /both a file and a folder/);
  assert.match(validateAttachmentPaths(["d/ok.txt", "d/../x"], { caseInsensitive: false }), /\.\./);
});

test("path sets treat NFC and NFD spellings as one path where the filesystem does", () => {
  const { validateAttachmentPaths } = store;
  const composed = "d/caf\u00e9.txt";
  const decomposed = "d/cafe\u0301.txt";
  assert.match(validateAttachmentPaths([composed, decomposed], { caseInsensitive: false, normalizationInsensitive: true }), /Duplicate/);
  assert.equal(validateAttachmentPaths([composed, decomposed], { caseInsensitive: false, normalizationInsensitive: false }), null);
  assert.match(validateAttachmentPaths(["d/CAF\u00c9.txt", decomposed], { caseInsensitive: true, normalizationInsensitive: true }), /Duplicate/);
  assert.match(
    validateAttachmentPaths(["d/re\u0301sume\u0301", "d/r\u00e9sum\u00e9/a.txt"], { caseInsensitive: false, normalizationInsensitive: true }),
    /both a file and a folder/,
  );
});

test("batch requests enforce shape, file and byte caps, and the root name", () => {
  const { parseAttachmentBatchRequest } = store;
  const folder = parseAttachmentBatchRequest({ kind: "folder", name: "data", files: [{ path: "data/a.csv", size: 3 }] });
  assert.deepEqual(folder, { kind: "folder", name: "data", files: [{ path: "data/a.csv", size: 3 }] });

  throwsWith(() => parseAttachmentBatchRequest(null), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "link", name: "x", files: [{ path: "x", size: 1 }] }), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "file", name: "../x", files: [{ path: "../x", size: 1 }] }), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "file", name: "a/b", files: [{ path: "a/b", size: 1 }] }), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "file", name: "x", files: [] }), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "file", name: "x", files: [{ path: "x", size: -1 }] }), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "file", name: "x", files: [{ path: "x", size: 1.5 }] }), 400);
  // A file batch is exactly the named file; a folder batch stays under its name.
  throwsWith(() => parseAttachmentBatchRequest({ kind: "file", name: "x", files: [{ path: "y", size: 1 }] }), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "folder", name: "data", files: [{ path: "other/a", size: 1 }] }), 400);
  throwsWith(() => parseAttachmentBatchRequest({ kind: "folder", name: "data", files: [{ path: "data/../../a", size: 1 }] }), 400, "invalid_attachment_path");
  // The root name must not land on the batch's own manifest file.
  throwsWith(
    () => parseAttachmentBatchRequest({ kind: "file", name: ".omp-web-attachment.json", files: [{ path: ".omp-web-attachment.json", size: 1 }] }),
    400,
    "invalid_attachment_path",
  );
  throwsWith(
    () => parseAttachmentBatchRequest({ kind: "folder", name: ".omp-web-attachment.json", files: [{ path: ".omp-web-attachment.json/a", size: 1 }] }),
    400,
    "invalid_attachment_path",
  );
  assert.equal(parseAttachmentBatchRequest({ kind: "folder", name: "d", files: [{ path: "d/.omp-web-attachment.json", size: 1 }] }).name, "d");

  const tooMany = Array.from({ length: MAX_ATTACHMENT_BATCH_FILES + 1 }, (_, i) => ({ path: `data/${i}.txt`, size: 1 }));
  throwsWith(() => parseAttachmentBatchRequest({ kind: "folder", name: "data", files: tooMany }), 413, "attachment_too_many_files");
  const atCap = tooMany.slice(0, MAX_ATTACHMENT_BATCH_FILES);
  assert.equal(parseAttachmentBatchRequest({ kind: "folder", name: "data", files: atCap }).files.length, MAX_ATTACHMENT_BATCH_FILES);
  throwsWith(
    () => parseAttachmentBatchRequest({ kind: "file", name: "big.bin", files: [{ path: "big.bin", size: MAX_ATTACHMENT_BATCH_BYTES + 1 }] }),
    413,
    "attachment_batch_too_large",
  );
});

test("a folder batch preserves its structure, takes ordered chunks, and completes once whole", async () => {
  const request = store.parseAttachmentBatchRequest({
    kind: "folder",
    name: "dataset",
    files: [
      { path: "dataset/a.txt", size: 5 },
      { path: "dataset/nested/deep/b.bin", size: 4 },
      { path: "dataset/empty.txt", size: 0 },
    ],
  });
  const { batchId } = await store.createAttachmentBatch(request);
  const root = join(attachmentsDir, batchId, "dataset");
  assert.ok(existsSync(join(root, "nested", "deep", "b.bin")), "every declared file exists from the start");

  await rejectsWith(() => store.completeAttachmentBatch(batchId), 409, "attachment_incomplete");
  await store.writeAttachmentChunks(batchId, [
    { path: "dataset/a.txt", offset: 0, data: bytes("hel") },
    { path: "dataset/nested/deep/b.bin", offset: 0, data: Uint8Array.of(0, 1, 2, 255) },
  ]);
  // A retried or reordered chunk is refused instead of corrupting the file.
  await rejectsWith(() => store.writeAttachmentChunks(batchId, [{ path: "dataset/a.txt", offset: 0, data: bytes("he") }]), 409, "attachment_offset_mismatch");
  await rejectsWith(() => store.writeAttachmentChunks(batchId, [{ path: "dataset/a.txt", offset: 3, data: bytes("lo!") }]), 400, "attachment_chunk_overflow");
  await rejectsWith(() => store.writeAttachmentChunks(batchId, [{ path: "dataset/other.txt", offset: 0, data: bytes("x") }]), 400, "attachment_unknown_path");
  await store.writeAttachmentChunks(batchId, [{ path: "dataset/a.txt", offset: 3, data: bytes("lo") }]);

  const reference = await store.completeAttachmentBatch(batchId);
  assert.deepEqual(reference, { batchId, kind: "folder", name: "dataset", path: root, size: 9, fileCount: 3 });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "hello");
  assert.deepEqual([...readFileSync(join(root, "nested", "deep", "b.bin"))], [0, 1, 2, 255]);
  assert.deepEqual(readdirSync(root).sort(), ["a.txt", "empty.txt", "nested"]);
  await rejectsWith(() => store.writeAttachmentChunks(batchId, [{ path: "dataset/a.txt", offset: 5, data: bytes("") }]), 409, "attachment_completed");
});

test("overlapping chunk writes and completions of one batch are serialized", async () => {
  const request = store.parseAttachmentBatchRequest({ kind: "file", name: "race.bin", files: [{ path: "race.bin", size: 6 }] });
  const { batchId } = await store.createAttachmentBatch(request);
  const results = await Promise.allSettled([
    store.writeAttachmentChunks(batchId, [{ path: "race.bin", offset: 0, data: bytes("aaa") }]),
    store.writeAttachmentChunks(batchId, [{ path: "race.bin", offset: 0, data: bytes("bbb") }]),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"], "only the first write at an offset lands");
  assert.equal(results[1].reason.code, "attachment_offset_mismatch");
  await store.writeAttachmentChunks(batchId, [{ path: "race.bin", offset: 3, data: bytes("ccc") }]);
  // Two completions at once both succeed and agree.
  const [first, second] = await Promise.all([store.completeAttachmentBatch(batchId), store.completeAttachmentBatch(batchId)]);
  assert.deepEqual(first, second);
  assert.equal(readFileSync(first.path, "utf8"), "aaaccc");
  assert.deepEqual(readdirSync(join(attachmentsDir, batchId)).sort(), [".omp-web-attachment.json", "race.bin"], "no temporary manifest is left behind");
});

test("a short write is continued until the whole chunk lands", async (t) => {
  const request = store.parseAttachmentBatchRequest({ kind: "file", name: "short.bin", files: [{ path: "short.bin", size: 11 }] });
  const { batchId } = await store.createAttachmentBatch(request);
  const realOpen = fsPromises.open;
  t.after(() => { fsPromises.open = realOpen; });
  let maxBytesPerWrite = 2;
  fsPromises.open = async (...args) => {
    const handle = await realOpen(...args);
    const realWrite = handle.write.bind(handle);
    handle.write = async (buffer, offset, length, position) => (
      maxBytesPerWrite === 0 ? { bytesWritten: 0, buffer } : realWrite(buffer, offset, Math.min(length, maxBytesPerWrite), position)
    );
    return handle;
  };
  await store.writeAttachmentChunks(batchId, [{ path: "short.bin", offset: 0, data: bytes("hello") }]);
  assert.equal(readFileSync(join(attachmentsDir, batchId, "short.bin"), "utf8"), "hello");
  maxBytesPerWrite = 0;
  await rejectsWith(
    () => store.writeAttachmentChunks(batchId, [{ path: "short.bin", offset: 5, data: bytes(" world") }]),
    500,
    "attachment_write_failed",
  );
});

test("unknown or malformed batch ids are not found", async () => {
  await rejectsWith(() => store.completeAttachmentBatch("../../etc"), 404, "attachment_not_found");
  await rejectsWith(() => store.completeAttachmentBatch("00000000-0000-4000-8000-000000000000"), 404, "attachment_not_found");
});

test("pruning removes batches older than the retention window only", async () => {
  const now = Date.now();
  const file = (name) => store.parseAttachmentBatchRequest({ kind: "file", name, files: [{ path: name, size: 0 }] });
  const old = await store.createAttachmentBatch(file("old.pdf"), { now: now - 31 * DAY });
  const recent = await store.createAttachmentBatch(file("recent.pdf"), { now: now - 29 * DAY });
  // A batch without a readable manifest ages by its directory mtime.
  const orphan = join(attachmentsDir, "33333333-3333-4333-8333-333333333333");
  mkdirSync(orphan, { recursive: true });
  const stale = (now - 40 * DAY) / 1000;
  utimesSync(orphan, stale, stale);
  // Anything that is not a batch directory is left alone.
  const unrelated = join(attachmentsDir, "keep-me");
  mkdirSync(unrelated, { recursive: true });
  utimesSync(unrelated, stale, stale);

  assert.equal(await store.pruneAttachmentBatches({ now }), 2);
  assert.equal(existsSync(join(attachmentsDir, old.batchId)), false);
  assert.equal(existsSync(orphan), false);
  assert.equal(existsSync(join(attachmentsDir, recent.batchId)), true);
  assert.equal(existsSync(unrelated), true);
  assert.equal(store.ATTACHMENT_RETENTION_MS, 30 * DAY);
});

test("routes create, fill and complete a file batch", async () => {
  const created = await createRoute.POST(new Request("http://localhost/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "file", name: "report.pdf", files: [{ path: "report.pdf", size: 8 }] }),
  }));
  assert.equal(created.status, 201);
  const { batchId } = await created.json();
  const params = { params: Promise.resolve({ batchId }) };

  const form = new FormData();
  form.append("path", "report.pdf");
  form.append("offset", "0");
  form.append("data", new Blob([bytes("%PDF-1.7")]), "chunk");
  const put = await batchRoute.PUT(new Request(`http://localhost/api/attachments/${batchId}`, { method: "PUT", body: form }), params);
  assert.equal(put.status, 200);

  const complete = await batchRoute.POST(new Request(`http://localhost/api/attachments/${batchId}`, { method: "POST" }), params);
  assert.equal(complete.status, 200);
  const reference = await complete.json();
  assert.equal(reference.kind, "file");
  assert.equal(reference.path, join(attachmentsDir, batchId, "report.pdf"));
  assert.equal(readFileSync(reference.path, "utf8"), "%PDF-1.7");
});

test("routes report caps and bad chunks with stable codes", async () => {
  const tooMany = await createRoute.POST(new Request("http://localhost/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "folder",
      name: "d",
      files: Array.from({ length: MAX_ATTACHMENT_BATCH_FILES + 1 }, (_, i) => ({ path: `d/${i}`, size: 0 })),
    }),
  }));
  assert.equal(tooMany.status, 413);
  assert.equal((await tooMany.json()).code, "attachment_too_many_files");

  const traversal = await createRoute.POST(new Request("http://localhost/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "folder", name: "d", files: [{ path: "d/../../escape", size: 0 }] }),
  }));
  assert.equal(traversal.status, 400);

  const form = new FormData();
  form.append("path", "x");
  const malformed = await batchRoute.PUT(
    new Request("http://localhost/api/attachments/00000000-0000-4000-8000-000000000000", { method: "PUT", body: form }),
    { params: Promise.resolve({ batchId: "00000000-0000-4000-8000-000000000000" }) },
  );
  assert.equal(malformed.status, 400);
});
