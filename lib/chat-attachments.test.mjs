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
  const { composeMessageWithTextAttachments } = await loadSubject();

  assert.equal(composeMessageWithTextAttachments("hello", []), "hello");

  const result = composeMessageWithTextAttachments("  ", [
    { name: "notes.txt", mimeType: "text/plain", content: "line one", size: 8 },
  ]);
  assert.equal(
    result,
    "Attached file: notes.txt\n```text\nline one\n```",
  );

  // Content containing ``` must not break the code fence — the fence grows.
  const backticks = composeMessageWithTextAttachments("", [
    { name: "README.md", mimeType: "text/markdown", content: "```js\ncode\n```", size: 15 },
  ]);
  assert.equal(
    backticks,
    "Attached file: README.md\n````markdown\n```js\ncode\n```\n````",
  );
});

test("keeps message text above attachment blocks", async () => {
  const { composeMessageWithTextAttachments } = await loadSubject();

  const result = composeMessageWithTextAttachments("Review this", [
    { name: "a.md", mimeType: "text/markdown", content: "A", size: 1 },
    { name: "b.txt", mimeType: "text/plain", content: "B", size: 1 },
  ]);

  assert.ok(result.startsWith("Review this\n\nAttached file: a.md"));
  assert.ok(result.includes("Attached file: b.md") === false);
  assert.ok(result.includes("Attached file: b.txt"));
});

test("selects attachments under the per-file and aggregate budgets", async () => {
  const { selectTextAttachments, MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES } = await loadSubject();
  const file = (name, size) => ({ name, size });

  // A lone file may fill the whole budget, and 8x the old 256 KB cap fits.
  const large = selectTextAttachments([file("big.log", 2 * 1024 * 1024)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(large.accepted.map((f) => f.name), ["big.log"]);
  assert.equal(large.tooLarge, 0);
  assert.equal(large.overBudget, 0);
  assert.equal(MAX_ATTACHED_TEXT_BYTES, MAX_TOTAL_ATTACHED_TEXT_BYTES);

  // Past the per-file cap the file is refused for its own size, not the budget.
  const oversized = selectTextAttachments([file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)], { usedBytes: 0, usedSlots: 0 });
  assert.deepEqual(oversized.accepted, []);
  assert.equal(oversized.tooLarge, 1);
  assert.equal(oversized.overBudget, 0);

  // The aggregate budget counts what the composer already holds, and files
  // that no longer fit are reported separately from oversized ones.
  const partial = selectTextAttachments(
    [file("fits.txt", 1024 * 1024), file("over.txt", 2 * 1024 * 1024), file("huge.log", MAX_ATTACHED_TEXT_BYTES + 1)],
    { usedBytes: 3 * 1024 * 1024, usedSlots: 1 },
  );
  assert.deepEqual(partial.accepted.map((f) => f.name), ["fits.txt"]);
  assert.equal(partial.tooLarge, 1);
  assert.equal(partial.overBudget, 1);

  // Remaining file slots cap the batch even when every file fits.
  const slots = selectTextAttachments([file("a.txt", 1), file("b.txt", 1)], { usedBytes: 0, usedSlots: 9 });
  assert.deepEqual(slots.accepted.map((f) => f.name), ["a.txt"]);
  assert.equal(slots.tooLarge, 0);
  assert.equal(slots.overBudget, 0);
});

test("skip banners name the limit the batch actually hit", async () => {
  const { describeTextAttachmentSkip, formatAttachmentBytes } = await loadSubject();

  assert.equal(formatAttachmentBytes(512 * 1024), "512 KB");
  assert.equal(formatAttachmentBytes(4 * 1024 * 1024), "4 MB");
  assert.equal(describeTextAttachmentSkip({ tooLarge: 0, overBudget: 0 }), null);
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 2, overBudget: 1 }),
    "2 file(s) skipped: files up to 4 MB are supported.",
  );
  assert.equal(
    describeTextAttachmentSkip({ tooLarge: 0, overBudget: 3 }),
    "3 file(s) skipped: attachments are limited to 4 MB per message.",
  );
});
