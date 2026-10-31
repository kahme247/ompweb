import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./chat-attachments.ts");
}

function textFile(name, type = "") {
  return { name, type };
}

test("recognizes text and markdown attachments by mime or extension", async () => {
  const { isTextAttachmentFile } = await loadSubject();

  assert.equal(isTextAttachmentFile(textFile("notes.txt", "text/plain")), true);
  assert.equal(isTextAttachmentFile(textFile("README.md", "text/markdown")), true);
  assert.equal(isTextAttachmentFile(textFile("README.MD")), true);
  assert.equal(isTextAttachmentFile(textFile("doc.markdown")), true);
  assert.equal(isTextAttachmentFile(textFile("page.mdx")), true);
  assert.equal(isTextAttachmentFile(textFile("data.json", "application/json")), false);
  assert.equal(isTextAttachmentFile(textFile("image.png", "image/png")), false);
  assert.equal(isTextAttachmentFile(textFile("noextension")), false);
});

test("composes message with attachment blocks and escapes triple backticks", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  assert.equal(composeMessageWithAttachments("hello", []), "hello");
  assert.equal(composeMessageWithAttachments("hello", [], []), "hello");

  const result = composeMessageWithAttachments("  ", [
    { name: "notes.txt", mimeType: "text/plain", content: "line one", size: 8 },
  ]);
  assert.equal(
    result,
    "Attached file: notes.txt\n```text\nline one\n```",
  );

  // Content containing ``` must not break the code fence — the fence grows.
  const backticks = composeMessageWithAttachments("", [
    { name: "README.md", mimeType: "text/markdown", content: "```js\ncode\n```", size: 15 },
  ]);
  assert.equal(
    backticks,
    "Attached file: README.md\n````markdown\n```js\ncode\n```\n````",
  );
});

test("keeps message text above attachment blocks", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  const result = composeMessageWithAttachments("Review this", [
    { name: "a.md", mimeType: "text/markdown", content: "A", size: 1 },
    { name: "b.txt", mimeType: "text/plain", content: "B", size: 1 },
  ]);

  assert.ok(result.startsWith("Review this\n\nAttached file: a.md"));
  assert.ok(result.includes("Attached file: b.md") === false);
  assert.ok(result.includes("Attached file: b.txt"));
});

const pdf = {
  batchId: "11111111-1111-4111-8111-111111111111",
  kind: "file",
  name: "report.pdf",
  path: "/home/u/.omp/agent/omp-web/attachments/11111111-1111-4111-8111-111111111111/report.pdf",
  size: Math.round(1.2 * 1024 * 1024),
  fileCount: 1,
};
const dataset = {
  batchId: "22222222-2222-4222-8222-222222222222",
  kind: "folder",
  name: "dataset",
  path: "/home/u/.omp/agent/omp-web/attachments/22222222-2222-4222-8222-222222222222/dataset",
  size: Math.round(4.1 * 1024 * 1024),
  fileCount: 37,
};

test("lists uploaded paths in one block after the text and inlined files", async () => {
  const { composeMessageWithAttachments } = await loadSubject();

  const result = composeMessageWithAttachments("Summarize these", [
    { name: "notes.txt", mimeType: "text/plain", content: "N", size: 1 },
  ], [pdf, dataset]);
  assert.equal(result, [
    "Summarize these",
    "Attached file: notes.txt\n```text\nN\n```",
    [
      "Attached paths (uploaded by the user; read them with your tools as needed):",
      `- ${pdf.path} (file, 1.2 MB)`,
      `- ${dataset.path}/ (folder, 37 files, 4.1 MB)`,
    ].join("\n"),
  ].join("\n\n"));

  // References alone still produce the block; a one-file folder is singular
  // and a path that already ends in "/" is not doubled.
  const only = composeMessageWithAttachments("", [], [{ ...dataset, path: `${dataset.path}/`, fileCount: 1, size: 37 }]);
  assert.equal(
    only,
    `Attached paths (uploaded by the user; read them with your tools as needed):\n- ${dataset.path}/ (folder, 1 file, 37 B)`,
  );

  // A Windows server path ends with its own separator, not a mixed "/".
  const windowsPath = "C:\\Users\\u\\.omp\\agent\\omp-web\\attachments\\22222222-2222-4222-8222-222222222222\\dataset";
  assert.ok(
    composeMessageWithAttachments("", [], [{ ...dataset, path: windowsPath }]).endsWith(`- ${windowsPath}\\ (folder, 37 files, 4.1 MB)`),
  );
});

test("formats reference sizes with one decimal", async () => {
  const { formatReferenceBytes } = await loadSubject();

  assert.equal(formatReferenceBytes(0), "0 B");
  assert.equal(formatReferenceBytes(1023), "1023 B");
  assert.equal(formatReferenceBytes(1024), "1 KB");
  assert.equal(formatReferenceBytes(1536), "1.5 KB");
  assert.equal(formatReferenceBytes(512 * 1024), "512 KB");
  assert.equal(formatReferenceBytes(200 * 1024 * 1024), "200 MB");
  assert.equal(formatReferenceBytes(3 * 1024 ** 3), "3 GB");
});

test("selects attachments under the per-file and aggregate budgets; the rest overflow to references", async () => {
  const { selectTextAttachments, MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES } = await loadSubject();
  const file = (name, size) => ({ name, size });
  const names = (files) => files.map((f) => f.name);

  // A lone file may fill the whole budget.
  const large = selectTextAttachments([file("big.log", 2 * 1024 * 1024)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(names(large.accepted), ["big.log"]);
  assert.deepEqual(large.overflow, []);
  assert.equal(MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES);

  // Past the per-file cap the file cannot be inlined: it becomes a reference.
  const oversized = selectTextAttachments([file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(oversized.accepted, []);
  assert.deepEqual(names(oversized.overflow), ["huge.log"]);

  // The aggregate budget counts what the composer already holds.
  const partial = selectTextAttachments(
    [file("fits.txt", 1024 * 1024), file("over.txt", 2 * 1024 * 1024), file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)],
    { usedBytes: 3 * 1024 * 1024, usedSlots: 1 },
  );
  assert.deepEqual(names(partial.accepted), ["fits.txt"]);
  assert.deepEqual(names(partial.overflow), ["over.txt", "huge.log"]);

  // Files past the remaining slots overflow too, even when they would fit.
  const slots = selectTextAttachments([file("a.txt", 1), file("b.txt", 1)], { usedBytes: 0, usedSlots: 9 });
  assert.deepEqual(names(slots.accepted), ["a.txt"]);
  assert.deepEqual(names(slots.overflow), ["b.txt"]);
});

test("decoded binary is recognized so it is uploaded instead of inlined", async () => {
  const { isBinaryText } = await loadSubject();

  assert.equal(isBinaryText("plain text\n"), false);
  assert.equal(isBinaryText("%PDF-1.7\u0000\u0001"), true);
  assert.equal(isBinaryText("PK\u0003\u0004\uFFFD"), true);
});

test("batch caps are checked before an upload starts", async () => {
  const { exceededAttachmentBatchLimit, MAX_ATTACHMENT_BATCH_FILES, MAX_ATTACHMENT_BATCH_BYTES } = await loadSubject();

  assert.equal(MAX_ATTACHMENT_BATCH_FILES, 2000);
  assert.equal(MAX_ATTACHMENT_BATCH_BYTES, 200 * 1024 * 1024);
  assert.equal(exceededAttachmentBatchLimit(MAX_ATTACHMENT_BATCH_FILES, MAX_ATTACHMENT_BATCH_BYTES), null);
  assert.deepEqual(exceededAttachmentBatchLimit(MAX_ATTACHMENT_BATCH_FILES + 1, 1), { code: "attachment_too_many_files", limit: 2000 });
  assert.deepEqual(
    exceededAttachmentBatchLimit(1, MAX_ATTACHMENT_BATCH_BYTES + 1),
    { code: "attachment_batch_too_large", limit: MAX_ATTACHMENT_BATCH_BYTES },
  );
});

test("reference data is validated before a draft restores it", async () => {
  const { isAttachmentReferenceData } = await loadSubject();

  assert.equal(isAttachmentReferenceData(pdf), true);
  assert.equal(isAttachmentReferenceData(dataset), true);
  assert.equal(isAttachmentReferenceData({ ...pdf, kind: "symlink" }), false);
  assert.equal(isAttachmentReferenceData({ ...pdf, path: "" }), false);
  assert.equal(isAttachmentReferenceData({ ...pdf, size: -1 }), false);
  assert.equal(isAttachmentReferenceData(null), false);
});
