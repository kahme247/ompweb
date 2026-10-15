import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./slash-autocomplete.ts");
}

test("detects leading slash commands at start of line", async () => {
  const { extractSlashQuery } = await loadSubject();

  assert.deepEqual(extractSlashQuery("/"), {
    mode: "leading",
    start: 0,
    query: "",
  });

  assert.deepEqual(extractSlashQuery("/com"), {
    mode: "leading",
    start: 0,
    query: "com",
  });

  assert.deepEqual(extractSlashQuery("  /model"), {
    mode: "leading",
    start: 2,
    query: "model",
  });
});

test("detects mid-prompt slash skill lookup preceded by text and whitespace", async () => {
  const { extractSlashQuery } = await loadSubject();

  assert.deepEqual(extractSlashQuery("tolong cek jadwal kuliah /"), {
    mode: "mid-prompt",
    start: 25,
    query: "",
  });

  assert.deepEqual(extractSlashQuery("tolong cek jadwal kuliah /gws"), {
    mode: "mid-prompt",
    start: 25,
    query: "gws",
  });

  assert.deepEqual(extractSlashQuery("check the calendar\n/gws-cal"), {
    mode: "mid-prompt",
    start: 19,
    query: "gws-cal",
  });
});

test("ignores non-command slash patterns like URLs and completed commands", async () => {
  const { extractSlashQuery } = await loadSubject();

  // Space after slash closes the query
  assert.equal(extractSlashQuery("/compact "), null);
  assert.equal(extractSlashQuery("tolong cek /gws "), null);

  // URLs should not trigger
  assert.equal(extractSlashQuery("https://example.com/api"), null);
  assert.equal(extractSlashQuery("src/components/ChatInput.tsx"), null);

  // Empty string
  assert.equal(extractSlashQuery(""), null);
  assert.equal(extractSlashQuery("just plain text without slash"), null);
});

test("builds slash insert text correctly for both modes", async () => {
  const { buildSlashInsertText } = await loadSubject();

  // Leading mode
  assert.equal(buildSlashInsertText("compact", "leading"), "/compact ");
  assert.equal(buildSlashInsertText("skill:gws-calendar", "leading"), "/skill:gws-calendar ");

  // Mid-prompt mode (normalizes to /skill:<name> )
  assert.equal(buildSlashInsertText("gws-calendar", "mid-prompt"), "/skill:gws-calendar ");
  assert.equal(buildSlashInsertText("skill:gws-calendar", "mid-prompt"), "/skill:gws-calendar ");
});
