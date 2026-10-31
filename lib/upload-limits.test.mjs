import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const limits = await jiti.import("./upload-limits.ts");

const MiB = 1024 * 1024;

test("one request fits the pre-auth body buffer; a selection does not", () => {
  assert.equal(limits.MAX_UPLOAD_FILE_BYTES, 25 * MiB);
  assert.equal(limits.MAX_UPLOAD_REQUEST_FILE_BYTES, 25 * MiB);
  assert.equal(limits.MAX_UPLOAD_TOTAL_BYTES, 100 * MiB);
  assert.equal(
    limits.MAX_UPLOAD_REQUEST_BYTES,
    limits.MAX_UPLOAD_REQUEST_FILE_BYTES + limits.MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES,
  );
  // A full per-file upload plus multipart framing must reach the route intact.
  assert.ok(limits.MAX_UPLOAD_REQUEST_BYTES >= limits.MAX_UPLOAD_FILE_BYTES + limits.MAX_UPLOAD_MULTIPART_OVERHEAD_BYTES);
  // The buffer must stay far below a whole selection: Next reads it before auth.
  assert.ok(limits.MAX_UPLOAD_REQUEST_BYTES <= limits.MAX_UPLOAD_TOTAL_BYTES / 3);
});

test("a 60 MB selection is sent as three bounded requests", () => {
  const files = [{ size: 20 * MiB }, { size: 20 * MiB }, { size: 20 * MiB }];
  assert.deepEqual(limits.batchUploadFiles(files).map((batch) => batch.length), [1, 1, 1]);
});

test("batching keeps every file, in order, and never exceeds the per-request cap", () => {
  const files = [
    { size: 10 * MiB },
    { size: 10 * MiB },
    { size: 6 * MiB },
    { size: 30 * MiB },
    { size: 1 },
  ];
  const batches = limits.batchUploadFiles(files);
  assert.deepEqual(batches.map((batch) => batch.map((file) => file.size)), [
    [10 * MiB, 10 * MiB],
    [6 * MiB],
    // A single file above the cap keeps its own request: the server answers its
    // per-file 413 instead of the batch silently dropping it.
    [30 * MiB],
    [1],
  ]);
  assert.deepEqual(batches.flat(), files);
  for (const batch of batches) {
    const total = batch.reduce((sum, file) => sum + file.size, 0);
    assert.ok(batch.length === 1 || total <= limits.MAX_UPLOAD_REQUEST_FILE_BYTES, `batch of ${total} bytes`);
  }
});

test("empty and empty-file selections produce no request", () => {
  assert.deepEqual(limits.batchUploadFiles([]), []);
  assert.deepEqual(limits.batchUploadFiles([{ size: 0 }, { size: 0 }]).map((batch) => batch.length), [2]);
});
