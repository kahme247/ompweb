import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { compileSearchQuery, scoreSearchFields, searchField, TITLE_WEIGHT, CONTENT_WEIGHT } = await jiti.import("./session-search.ts");
const { MAX_CONTENT_CACHE_ENTRIES, transcriptField } = await jiti.import("./session-content-search.ts");
const score = (query, title, content = "") =>
  scoreSearchFields([searchField(title, TITLE_WEIGHT), searchField(content, CONTENT_WEIGHT)], compileSearchQuery(query));

test("every word must match, in any order", () => {
  assert.notEqual(score("bug login", "Fix login bug"), null);
  assert.equal(score("login payments", "Fix login bug"), null);
});

test("typed order and exactness rank higher", () => {
  assert.ok(score("login bug", "fix login bug") > score("login bug", "bug in login"));
  assert.ok(score("login", "login page") > score("login", "logins page"));
});

test("typos still match, short words do not get typo tolerance", () => {
  assert.notEqual(score("sidebr", "Sidebar search"), null);
  assert.notEqual(score("kubernetis", "kubernetes cluster"), null);
  assert.equal(score("cat", "car"), null);
  assert.equal(score("node", "code mode"), null);
});

test("a word too far from every word does not match", () => {
  // 5–7 letter terms allow one typo; "too far" must never count as a typo.
  assert.equal(score("xyzzy", "Fix login bug"), null);
  assert.equal(score("rolling", "kubernetes cluster setup", "done"), null);
  assert.equal(score("sidebar", "Totally unrelated words here"), null);
});

test("combining marks stay inside their word, and NFC/NFD forms match each other", () => {
  assert.equal(score("हिन्दी", "ह न द"), null);
  assert.notEqual(score("résumé", "my re\u0301sume\u0301 draft"), null);
});

test("words may split across title and transcript; title matches outrank transcript matches", () => {
  assert.notEqual(score("sidebar ranking", "Sidebar work", "we discussed ranking"), null);
  assert.ok(score("ranking", "Ranking", "") > score("ranking", "Other", "ranking ranking"));
});

test("quoted phrases must appear verbatim", () => {
  assert.notEqual(score('"login bug"', "fix login  bug now"), null);
  assert.equal(score('"bug login"', "fix login bug"), null);
  assert.equal(score('"logn bug"', "fix login bug"), null);
  // Unclosed quote while typing is still a phrase, not loose words.
  assert.equal(score('"bug lo', "fix login bug"), null);
  assert.notEqual(score('"login b', "fix login bug"), null);
  // Typographic quotes from phone keyboards are phrases too.
  assert.equal(score("“bug login”", "fix login bug"), null);
  assert.notEqual(score("“login bug”", "fix login bug"), null);
});

test("empty query compiles to nothing", () => {
  assert.equal(compileSearchQuery('  "" '), null);
});

test("fuzzy scoring handles equal-length typos, prefix typos, and words exceeding initial scratch capacity", () => {
  assert.equal(score("sidebr", "sidebar"), 45);
  assert.equal(score("sidebr", "sidebaring"), 45);
  assert.equal(score("sidebar", "side"), null);
  assert.equal(score("kubernetis", "kubernetes"), 45);
  assert.equal(score("kubernetiz", "kubernetes"), 30);

  const longTerm = "a".repeat(70);
  const oneTypoLongWord = "a".repeat(69) + "b";
  assert.equal(score(longTerm, oneTypoLongWord), 45);
  assert.equal(score(longTerm, longTerm), 100);
});

test("transcriptField extracts user/assistant text and bounds cache with LRU eviction", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompweb-search-test-"));
  try {
    const fileA = path.join(tmpDir, "session-a.jsonl");
    const fileB = path.join(tmpDir, "session-b.jsonl");
    await fs.writeFile(
      fileA,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "alpha needle" } }),
        JSON.stringify({ type: "message", message: { role: "toolResult", content: "ignored_tool_output" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "beta reply" }] } }),
      ].join("\n") + "\n",
    );
    await fs.writeFile(
      fileB,
      JSON.stringify({ type: "message", message: { role: "user", content: "gamma query" } }) + "\n",
    );

    const cache = new Map();
    const fieldA = await transcriptField(fileA, cache);
    assert.ok(fieldA);
    assert.equal(fieldA.text.includes("alpha needle"), true);
    assert.equal(fieldA.text.includes("beta reply"), true);
    assert.equal(fieldA.text.includes("ignored_tool_output"), false);

    for (let i = 0; i < MAX_CONTENT_CACHE_ENTRIES - 1; i++) {
      cache.set(path.join(tmpDir, `filler-${i}.jsonl`), {
        version: `1:${i}`,
        field: Promise.resolve(searchField(`word${i}`, CONTENT_WEIGHT)),
      });
    }
    assert.equal(cache.size, MAX_CONTENT_CACHE_ENTRIES);

    // Touch fileA via a real cache-hit call so filler-0 becomes the oldest entry.
    await transcriptField(fileA, cache);
    // Adding fileB via transcriptField must evict filler-0 while retaining fileA.
    await transcriptField(fileB, cache);

    assert.equal(cache.size, MAX_CONTENT_CACHE_ENTRIES);
    assert.equal(cache.has(fileA), true);
    assert.equal(cache.has(fileB), true);
    assert.equal(cache.has(path.join(tmpDir, "filler-0.jsonl")), false);
    assert.equal(cache.has(path.join(tmpDir, "filler-1.jsonl")), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
