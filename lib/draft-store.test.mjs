import assert from "node:assert/strict";
import test from "node:test";
import { clearDraft, getDraft, getDraftSummary, setDraft } from "./draft-store.ts";

test("getDraftSummary returns text and attachment presence without deep cloning", () => {
  const key = "test-session-draft-1";
  clearDraft(key);

  const emptySummary = getDraftSummary(key);
  assert.equal(emptySummary.text, "");
  assert.equal(emptySummary.hasAttachments, false);

  setDraft(key, {
    value: "Hello world",
    images: [{ data: "data:image/png;base64,AAA...", mimeType: "image/png" }],
    files: [{ name: "test.txt", mimeType: "text/plain", content: "file data", size: 9 }],
  });

  const summary = getDraftSummary(key);
  assert.equal(summary.text, "Hello world");
  assert.equal(summary.hasAttachments, true);

  const full = getDraft(key);
  assert.ok(full);
  assert.equal(full.value, "Hello world");
  assert.equal(full.images.length, 1);
  assert.equal(full.files.length, 1);

  clearDraft(key);
  assert.equal(getDraft(key), null);
});

test("setDraft caps total stored drafts to prevent memory bloat", () => {
  for (let i = 0; i < 60; i++) {
    setDraft(`eviction-session-${i}`, {
      value: `Draft ${i}`,
      images: [],
      files: [],
    });
  }

  // Oldest drafts beyond the 50 cap should have been evicted
  assert.equal(getDraft("eviction-session-0"), null);
  assert.equal(getDraft("eviction-session-1"), null);

  // Newest drafts should be present
  const recent = getDraft("eviction-session-59");
  assert.ok(recent);
  assert.equal(recent.value, "Draft 59");
});
