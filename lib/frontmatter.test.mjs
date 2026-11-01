import assert from "node:assert/strict";
import test from "node:test";

const { formatFrontmatterValue, parseFrontmatter } = await import("./frontmatter.ts");

test("parses valid yaml frontmatter and separates it from markdown body", () => {
  const content = "---\ntitle: Example Document\nauthor: Alice\ntags:\n  - test\n  - doc\n---\n# Header\n\nBody text";
  const { data, rest } = parseFrontmatter(content);
  assert.deepEqual(data, {
    title: "Example Document",
    author: "Alice",
    tags: ["test", "doc"],
  });
  assert.equal(rest, "# Header\n\nBody text");
});

test("parses frontmatter with CRLF and BOM", () => {
  const content = "\uFEFF---\r\ntitle: Windows Doc\r\n---\r\n# Content";
  const { data, rest } = parseFrontmatter(content);
  assert.deepEqual(data, { title: "Windows Doc" });
  assert.equal(rest, "# Content");
});

test("returns null data and original text when no frontmatter exists", () => {
  const content = "# Just Markdown\n\nSome text\n---";
  const { data, rest } = parseFrontmatter(content);
  assert.equal(data, null);
  assert.equal(rest, content);
});

test("handles unclosed frontmatter gracefully", () => {
  const content = "---\ntitle: Unclosed\n# Header";
  const { data, rest } = parseFrontmatter(content);
  assert.equal(data, null);
  assert.equal(rest, content);
});

test("formats frontmatter values correctly", () => {
  assert.equal(formatFrontmatterValue(null), "");
  assert.equal(formatFrontmatterValue(undefined), "");
  assert.equal(formatFrontmatterValue("hello"), "hello");
  assert.equal(formatFrontmatterValue(123), "123");
  assert.equal(formatFrontmatterValue(true), "true");
  assert.equal(formatFrontmatterValue(["a", "b", "c"]), "a, b, c");
  assert.equal(formatFrontmatterValue({ key: "val" }), '{"key":"val"}');
});
