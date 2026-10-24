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

test("filterFileEntries orders by score, depth, and path tie-breaking across repeated queries", async () => {
  const { buildEntriesFromFiles, filterFileEntries } = await loadSubject();

  // Setup files with different match tiers, depths, and alphabetical paths:
  // query: "test"
  // 1. exact basename match:
  //    - "a/test": depth 1, score 100
  //    - "b/test": depth 1, score 100 -> ties broken by path
  //    - "x/y/test": depth 2, score 100 -> deeper than a/test
  // 2. prefix basename match:
  //    - "testing.ts": depth 0, score 80
  // 3. substring basename match:
  //    - "my-test.ts": depth 0, score 50
  // 4. path substring match (query doesn't have slash, basename doesn't match):
  //    - "test/other.ts": depth 1, score 30
  // 5. directory boost:
  //    - dir "test": depth 0, isDir true, exact basename score 100 + 10 = 110
  const files = [
    "test/other.ts",
    "b/test",
    "a/test",
    "x/y/test",
    "testing.ts",
    "my-test.ts",
  ];
  const entries = buildEntriesFromFiles(files);

  // First query invocation
  const res1 = filterFileEntries(entries, "test", 20);
  const paths1 = res1.map((e) => e.path);

  assert.deepEqual(paths1, [
    "test",          // dir exact basename: score 110, depth 0
    "a/test",        // exact basename: score 100, depth 1, path "a/test"
    "b/test",        // exact basename: score 100, depth 1, path "b/test" (tie break)
    "x/y/test",      // exact basename: score 100, depth 2
    "testing.ts",    // prefix basename: score 80, depth 0
    "my-test.ts",    // substring basename: score 50, depth 0
    "test/other.ts", // path substring: score 30, depth 1
  ]);

  // Repeated query invocation reuses cached metadata and yields identical stable ordering
  const res2 = filterFileEntries(entries, "test", 20);
  const paths2 = res2.map((e) => e.path);
  assert.deepEqual(paths2, paths1);

  // Needle longer than haystack returns no match immediately via subsequence / length guard
  const noMatch = filterFileEntries(entries, "a-very-long-needle-that-exceeds-all-paths-in-entries");
  assert.equal(noMatch.length, 0);
});
