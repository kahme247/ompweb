import assert from "node:assert/strict";
import test from "node:test";

const { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } =
  await import("./session-title.ts");

test("sanitizes titles to a single clean line", () => {
  assert.equal(sanitizeSessionTitle("Fix the race\nin SSE reconnect"), "Fix the race");
  assert.equal(sanitizeSessionTitle("tabs\tand\u0000controls"), "tabs and controls");
  assert.equal(sanitizeSessionTitle("  spaced   out  "), "spaced out");
  assert.equal(sanitizeSessionTitle(""), undefined);
  assert.equal(sanitizeSessionTitle("\u0001\u0002"), undefined);
  assert.equal(sanitizeSessionTitle(undefined), undefined);
});

test("derives a fallback title from the first user message", () => {
  assert.equal(
    deriveSessionTitleFromFirstMessage("Fix the running-session race in the sidebar"),
    "Fix the running-session race in the sidebar",
  );
  assert.equal(deriveSessionTitleFromFirstMessage("修复 SSE 重连问题"), "修复 SSE 重连问题");
});

test("keeps only the first line of a multi-line prompt", () => {
  assert.equal(
    deriveSessionTitleFromFirstMessage("Refactor the reader\n\nAlso do more things"),
    "Refactor the reader",
  );
});

test("truncates long derived titles to ~60 code points with an ellipsis", () => {
  const long = "a".repeat(80);
  const derived = deriveSessionTitleFromFirstMessage(long);
  assert.equal(derived.length, 61);
  assert.ok(derived.endsWith("…"));
  assert.equal(derived.slice(0, 60), "a".repeat(60));
});

test("rejects unusable first messages", () => {
  assert.equal(deriveSessionTitleFromFirstMessage(undefined), null);
  assert.equal(deriveSessionTitleFromFirstMessage(""), null);
  assert.equal(deriveSessionTitleFromFirstMessage("(no messages)"), null);
  assert.equal(deriveSessionTitleFromFirstMessage("---"), null);
});
