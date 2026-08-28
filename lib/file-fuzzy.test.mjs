import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./file-fuzzy.ts");
}

test("builds closed file mentions and quotes paths containing spaces", async () => {
  const { buildAtMentionText, buildFileAtMentionsText } = await loadSubject();

  assert.equal(buildAtMentionText("notes/todo.md", false), "@notes/todo.md ");
  assert.equal(buildAtMentionText("project files/design brief.md", false), "@\"project files/design brief.md\" ");
  assert.equal(
    buildFileAtMentionsText(["notes/todo.md", "project files/design brief.md"]),
    "@notes/todo.md @\"project files/design brief.md\" ",
  );
});

test("builds line-scoped file mentions", async () => {
  const { buildFileLineMentionText } = await loadSubject();

  assert.equal(buildFileLineMentionText("src/app.ts", 12, 12), "@src/app.ts:12 ");
  assert.equal(buildFileLineMentionText("src/app.ts", 18, 12), "@src/app.ts:12-18 ");
  assert.equal(
    buildFileLineMentionText("project files/app.ts", 3, 9),
    "@\"project files/app.ts\":3-9 ",
  );
  assert.equal(buildFileLineMentionText("src/app.ts", 0, 0), "@src/app.ts:1 ");
});

test("clamps client-supplied result limits", async () => {
  const { parseResultLimit, AT_RESULT_LIMIT, MAX_RESULT_LIMIT } = await loadSubject();

  // Absent or unusable values keep the @ menu's short list.
  assert.equal(parseResultLimit(null), AT_RESULT_LIMIT);
  assert.equal(parseResultLimit(""), AT_RESULT_LIMIT);
  assert.equal(parseResultLimit("abc"), AT_RESULT_LIMIT);
  assert.equal(parseResultLimit("0"), AT_RESULT_LIMIT);
  assert.equal(parseResultLimit("-5"), AT_RESULT_LIMIT);
  assert.equal(parseResultLimit("12.5"), AT_RESULT_LIMIT);

  assert.equal(parseResultLimit("50"), 50);
  assert.equal(parseResultLimit(String(MAX_RESULT_LIMIT)), MAX_RESULT_LIMIT);
  // A caller cannot ask the server to rank an unbounded slice.
  assert.equal(parseResultLimit("100000"), MAX_RESULT_LIMIT);
});

test("honors an explicit limit when filtering entries", async () => {
  const { buildEntriesFromFiles, filterFileEntries } = await loadSubject();

  const entries = buildEntriesFromFiles(
    Array.from({ length: 60 }, (_, i) => `app/api/thing${i}/route.ts`),
  );

  assert.equal(filterFileEntries(entries, "route").length, 20);
  assert.equal(filterFileEntries(entries, "route", 45).length, 45);
});
