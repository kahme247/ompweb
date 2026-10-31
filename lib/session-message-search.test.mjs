import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const search = await jiti.import("./session-message-search.ts");
// File I/O is slow on loaded Windows hosts; only the budget test relies on the clock.
const TEST_BUDGET_MS = 120_000;
const route = await jiti.import("../app/api/sessions/messages/search/route.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

function message(id, role, text, timestamp = "2026-01-01T00:00:00.000Z") {
  const content = role === "toolResult"
    ? [{ type: "text", text }]
    : [{ type: "text", text }];
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role, content, ...(role === "toolResult" ? { toolCallId: `call-${id}` } : {}) },
  });
}

function sessionFile(id, cwd, lines) {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
  });
  return `${header}\n${lines.join("\n")}\n`;
}

function writeSession(dir, name, body, mtimeMs) {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

const newestLines = [
  message("a-user-1", "user", "Alpha needle here"),
  message("a-assistant", "assistant", "nothing to see"),
  message("a-thinking", "assistant", "visible answer"),
  message("a-user-2", "user", "second needle at the end"),
  message("a-tool", "toolResult", "needle inside a tool result"),
];
// The thinking block is not searchable; the visible text is.
newestLines[2] = JSON.stringify({
  type: "message",
  id: "a-thinking",
  parentId: null,
  timestamp: "2026-01-01T00:00:05.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "needle in reasoning" },
      { type: "text", text: "visible answer" },
    ],
  },
});

const olderLines = [
  message("b-user", "user", "NEEDLE case insensitive", "2026-01-01T00:00:10.000Z"),
  message("b-assistant", "assistant", "a needle reply", "2026-01-01T00:00:11.000Z"),
  message("b-tool", "toolResult", "needle tool", "2026-01-01T00:00:12.000Z"),
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-search-"));
  const newestPath = writeSession(dir, "newest.jsonl", sessionFile("s-new", "/work/new", newestLines), 3_000);
  const olderPath = writeSession(dir, "older.jsonl", sessionFile("s-old", "/work/old", olderLines), 2_000);
  const files = [
    { path: newestPath, id: "s-new", cwd: "/work/new", title: "Newest", size: statSync(newestPath).size, modifiedMs: 3000 },
    { path: olderPath, id: "s-old", cwd: "/work/old", title: "Older", size: statSync(olderPath).size, modifiedMs: 2000 },
  ];
  return { dir, files };
}

/** Point the omp agent dir at a throwaway location for the duration of `run`. */
async function withAgentDir(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-search-agent-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  try {
    await run(projectDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("search returns newest sessions first and newest messages first inside a session", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const page = await search.searchSessionMessages({ query: "needle", budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.equal(page.partial, false);
  assert.equal(page.cursor, null);
  assert.deepEqual(
    page.results.map((hit) => hit.entryId),
    ["a-user-2", "a-user-1", "b-assistant", "b-user"],
  );
  assert.deepEqual(
    page.results.map((hit) => hit.sessionId),
    ["s-new", "s-new", "s-old", "s-old"],
  );

  const first = page.results[0];
  assert.equal(first.title, "Newest");
  assert.equal(first.cwd, "/work/new");
  assert.equal(first.role, "user");
  assert.equal(first.timestamp, "2026-01-01T00:00:00.000Z");
  assert.equal(first.snippet.slice(first.matchStart, first.matchEnd).toLowerCase(), "needle");
  assert.match(first.snippet, /second/);

  // Thinking blocks are not transcript text, so the assistant entry above
  // (whose visible text has no match) must not appear.
  assert.ok(!page.results.some((hit) => hit.entryId === "a-thinking"));
});

test("matching is case-insensitive and supports plain substrings", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const page = await search.searchSessionMessages({ query: "NeEdLe", budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.equal(page.results.length, 4);
  const hit = page.results.find((result) => result.entryId === "b-user");
  assert.ok(hit);
  assert.equal(hit.snippet.slice(hit.matchStart, hit.matchEnd), "NEEDLE");

  const none = await search.searchSessionMessages({ query: "no-such-term", budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.deepEqual(none.results, []);
});

test("tool results and thinking blocks are not searchable", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const page = await search.searchSessionMessages({ query: "needle", budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.ok(!page.results.some((hit) => hit.entryId === "a-tool"));
  assert.ok(!page.results.some((hit) => hit.entryId === "b-tool"));
  assert.ok(!page.results.some((hit) => hit.role === "tool"));
});

test("cursor pagination neither skips nor duplicates lines, even across tiny chunk boundaries", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const complete = await search.searchSessionMessages({ query: "needle", budgetMs: TEST_BUDGET_MS, sessions: files });
  const expected = complete.results.map((hit) => hit.entryId);

  for (const chunkBytes of [64, 97, 1024]) {
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = await search.searchSessionMessages({
        query: "needle",
        limit: 1,
        ...(cursor ? { cursor } : {}),
        chunkBytes,
        budgetMs: TEST_BUDGET_MS,
        sessions: files,
      });
      seen.push(...page.results.map((hit) => hit.entryId));
      assert.ok(page.results.length <= 1);
      if (page.cursor) {
        assert.equal(page.partial, true);
        cursor = page.cursor;
      } else {
        assert.equal(page.partial, false);
        cursor = undefined;
      }
      pages++;
      assert.ok(pages < 50, "pagination must terminate");
    } while (cursor);
    assert.deepEqual(seen, expected, `chunk size ${chunkBytes}`);
  }
});

test("a time/size budget stops the scan with a resumable cursor", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const seen = [];
  let cursor;
  let partialPages = 0;
  let pages = 0;
  do {
    const page = await search.searchSessionMessages({
      query: "needle",
      ...(cursor ? { cursor } : {}),
      maxFileScanBytes: 40,
      chunkBytes: 16,
      sessions: files,
    });
    seen.push(...page.results.map((hit) => hit.entryId));
    if (page.partial) partialPages++;
    cursor = page.cursor ?? undefined;
    pages++;
    assert.ok(pages < 50, "budget pagination must terminate");
  } while (cursor);
  assert.ok(partialPages > 0, "byte cap must produce partial pages");
  assert.deepEqual(seen, ["a-user-2", "a-user-1", "b-assistant", "b-user"]);
});

test("the time budget starts after the session listing", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A slow directory listing must not eat the scan budget: otherwise the very
  // first page comes back empty with a cursor that never advances.
  let clock = 0;
  const page = await search.searchSessionMessages({
    query: "needle",
    now: () => clock,
    listSessions: async () => {
      clock += 10_000;
      return files;
    },
    budgetMs: 5_000,
  });
  assert.equal(page.partial, false);
  assert.equal(page.cursor, null);
  assert.deepEqual(page.results.map((hit) => hit.entryId), ["a-user-2", "a-user-1", "b-assistant", "b-user"]);
});

test("very large files are skipped", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const huge = { ...files[0], path: join(dir, "newest.jsonl"), size: search.SEARCH_LARGE_FILE_BYTES + 1 };

  const skipped = await search.searchSessionMessages({ query: "needle", budgetMs: TEST_BUDGET_MS, sessions: [huge, files[1]] });
  assert.equal(skipped.skippedFiles, 1);
  assert.deepEqual(skipped.results.map((hit) => hit.sessionId), ["s-old", "s-old"]);
});

test("cursors are bound to their query and survive a vanished file", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.ok(first.cursor);
  await assert.rejects(
    () => search.searchSessionMessages({ query: "other", cursor: first.cursor, sessions: files }),
    (error) => error.name === "SearchCursorError" && error.message === "cursor_query_mismatch",
  );

  // Drop the newest file: the cursor's fallback continues with older files.
  const withoutNewest = [files[1]];
  const resumed = await search.searchSessionMessages({
    query: "needle",
    cursor: first.cursor,
    sessions: withoutNewest,
  });
  assert.deepEqual(resumed.results.map((hit) => hit.entryId), ["b-assistant", "b-user"]);
  assert.equal(resumed.cursor, null);
});

test("malformed and non-message lines are ignored", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-search-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = [
    JSON.stringify({ type: "session", version: 3, id: "s-bad", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/w" }),
    "{not json",
    JSON.stringify({ type: "model_change", id: "m", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", model: "needle" }),
    message("bad-1", "user", "needle survives"),
    JSON.stringify({ type: "message", id: "", parentId: null, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "needle without id" } }),
  ].join("\n");
  const path = writeSession(dir, "bad.jsonl", `${body}\n`, 1000);
  const files = [{ path, id: "s-bad", cwd: "/w", title: "", size: statSync(path).size, modifiedMs: 1000 }];

  const page = await search.searchSessionMessages({ query: "needle", budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.deepEqual(page.results.map((hit) => hit.entryId), ["bad-1"]);
});

test("lines that start exactly at a chunk boundary are matched exactly once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-search-uniform-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Every line is 255 JSON bytes (2^8-1) + LF = 256 bytes, so any chunk size
  // that is a multiple of 256 puts every window edge on a line start.
  const LINE_BYTES = 255;
  const STRIDE = 256;
  const total = 2600;
  const lines = [];
  const expected = [];
  for (let index = 0; index < total; index++) {
    const entry = {
      type: "message",
      id: `u-${index}`,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "" }] },
    };
    const base = JSON.stringify(entry);
    const hit = index % 97 === 0 || index === total - 1;
    const body = hit ? "needle" : "filler";
    entry.message.content[0].text = body + "x".repeat(LINE_BYTES - base.length - body.length);
    const line = JSON.stringify(entry);
    assert.equal(Buffer.byteLength(line), LINE_BYTES, `line ${index} must stay uniform`);
    lines.push(line);
    if (hit) expected.push(`u-${index}`);
  }
  const path = writeSession(dir, "uniform.jsonl", sessionFile("s-uniform", "/w", lines), 1000);
  const size = statSync(path).size;
  const files = [{ path, id: "s-uniform", cwd: "/w", title: "Uniform", size, modifiedMs: 1000 }];
  const raw = readFileSync(path);
  const newestFirst = [...expected].reverse();

  for (const chunkBytes of [STRIDE * 32, STRIDE * 1024]) {
    const page = await search.searchSessionMessages({
      query: "needle",
      limit: 100,
      chunkBytes,
      budgetMs: TEST_BUDGET_MS,
      sessions: files,
    });
    assert.deepEqual(page.results.map((hit) => hit.entryId), newestFirst, `chunk size ${chunkBytes}`);
    assert.equal(page.partial, false);
  }

  // Same file, tiny pages: every hit exactly once and every cursor on a line start.
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await search.searchSessionMessages({
      query: "needle",
      limit: 3,
      ...(cursor ? { cursor } : {}),
      chunkBytes: STRIDE * 256,
      budgetMs: TEST_BUDGET_MS,
      sessions: files,
    });
    seen.push(...page.results.map((hit) => hit.entryId));
    cursor = page.cursor ?? undefined;
    if (cursor) {
      const decoded = search.decodeSearchCursor(cursor);
      assert.ok(decoded);
      assert.ok(decoded.offset === 0 || raw[decoded.offset - 1] === 0x0a, "cursor must point at a line start");
    }
    pages++;
    assert.ok(pages < 40, "pagination must terminate");
  } while (cursor);
  assert.deepEqual(seen, newestFirst);
});

test("a message line spanning several chunks is still found", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-search-long-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const longText = `needle ${"y".repeat(3000)}`;
  const path = writeSession(dir, "long.jsonl", sessionFile("s-long", "/w", [
    message("short-1", "user", "needle first"),
    message("long-1", "user", longText),
    message("short-2", "user", "needle last"),
  ]), 1000);
  const files = [{ path, id: "s-long", cwd: "/w", title: "", size: statSync(path).size, modifiedMs: 1000 }];

  for (const chunkBytes of [512, 1024, 4096]) {
    const page = await search.searchSessionMessages({ query: "needle", chunkBytes, budgetMs: TEST_BUDGET_MS, sessions: files });
    assert.deepEqual(
      page.results.map((hit) => hit.entryId),
      ["short-2", "long-1", "short-1"],
      `chunk size ${chunkBytes}`,
    );
  }
});

test("match offsets stay on the original text when lowercasing would change its length", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-search-case-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // "İ".toLowerCase() is two code units, so a lowercase index would slice the
  // wrong part of the original string.
  const path = writeSession(dir, "case.jsonl", sessionFile("s-case", "/w", [
    message("case-1", "user", "İstanbul ist schön, needle hier"),
  ]), 1000);
  const files = [{ path, id: "s-case", cwd: "/w", title: "", size: statSync(path).size, modifiedMs: 1000 }];

  const page = await search.searchSessionMessages({ query: "needle", budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.equal(page.results.length, 1);
  const hit = page.results[0];
  assert.equal(hit.snippet.slice(hit.matchStart, hit.matchEnd), "needle");
});

test("a cursor survives deleting one of two files with the same mtime", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-search-tie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const pathA = writeSession(dir, "a.jsonl", sessionFile("s-a", "/w/a", [
    message("a-1", "user", "needle a one"),
    message("a-2", "user", "needle a two"),
  ]), 1000);
  const pathB = writeSession(dir, "b.jsonl", sessionFile("s-b", "/w/b", [
    message("b-1", "user", "needle b one"),
  ]), 1000);
  const files = [
    { path: pathA, id: "s-a", cwd: "/w/a", title: "", size: statSync(pathA).size, modifiedMs: 1000 },
    { path: pathB, id: "s-b", cwd: "/w/b", title: "", size: statSync(pathB).size, modifiedMs: 1000 },
  ];

  // The tie is broken by path, so a.jsonl (one hit left after the page) comes first.
  const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.deepEqual(first.results.map((hit) => hit.entryId), ["a-2"]);
  assert.ok(first.cursor);

  rmSync(pathA);
  const resumed = await search.searchSessionMessages({
    query: "needle",
    cursor: first.cursor,
    sessions: [files[1]],
  });
  // a-1 was still unscanned but its file is gone; b.jsonl has the same mtime
  // and comes after it, so it must not be skipped.
  assert.deepEqual(resumed.results.map((hit) => hit.entryId), ["b-1"]);
});

test("production listing finds sessions through the omp agent dir", async () => {
  await withAgentDir(async (projectDir) => {
    writeSession(projectDir, "one.jsonl", sessionFile("prod-1", "/work/prod", [
      message("p-1", "user", "production needle one"),
      message("p-2", "assistant", "production needle two"),
    ]), 1_000);
    const page = await search.searchSessionMessages({ query: "production needle", budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(page.results.map((hit) => hit.entryId), ["p-2", "p-1"]);
    assert.equal(page.results[0].sessionId, "prod-1");
    assert.equal(page.results[0].cwd, "/work/prod");
  });
});

test("route rejects missing/oversized input and reports search pages", async () => {
  const get = (query) => route.GET(new Request(`http://localhost/api/sessions/messages/search${query}`));

  let response = await get("");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "query_required");

  response = await get("?q=needle&limit=0");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_limit");

  response = await get("?q=needle&limit=101");
  assert.equal(response.status, 400);

  response = await get("?q=needle&cursor=not-a-cursor");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_cursor");

  await withAgentDir(async (projectDir) => {
    writeSession(projectDir, "route.jsonl", sessionFile("route-1", "/work/route", [
      message("r-1", "user", "route needle first"),
      message("r-2", "toolResult", "route needle tool"),
      message("r-3", "assistant", "route needle last"),
    ]), 1_000);

    response = await get("?q=needle&limit=5");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    let body = await response.json();
    // Tool results are not searchable, even though the fixture has one.
    assert.deepEqual(body.results.map((hit) => hit.entryId), ["r-3", "r-1"]);
    assert.equal(body.partial, false);
    assert.equal(body.cursor, null);

    body = await (await get("?q=needle&limit=1")).json();
    assert.deepEqual(body.results.map((hit) => hit.entryId), ["r-3"]);
    assert.equal(body.partial, true);
    assert.ok(body.cursor);
    const firstCursor = body.cursor;

    response = await get(`?q=needle&limit=1&cursor=${encodeURIComponent(firstCursor)}`);
    body = await response.json();
    assert.deepEqual(body.results.map((hit) => hit.entryId), ["r-1"]);
    assert.ok(body.cursor);
    // The last page only proves the corpus is exhausted.
    response = await get(`?q=needle&limit=1&cursor=${encodeURIComponent(body.cursor)}`);
    body = await response.json();
    assert.deepEqual(body.results, []);
    assert.equal(body.cursor, null);

    response = await get(`?q=other&cursor=${encodeURIComponent(firstCursor)}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "cursor_query_mismatch");
  });
});

test("route answers 429 while the scan slots are taken and recovers after release", async (t) => {
  const get = (query) => route.GET(new Request(`http://localhost/api/sessions/messages/search${query}`));
  t.after(() => {
    // Never leak slots into another test if an assertion above throws.
    search.releaseSearchSlot();
    search.releaseSearchSlot();
  });

  assert.equal(search.tryAcquireSearchSlot(), true);
  assert.equal(search.tryAcquireSearchSlot(), true);
  assert.equal(search.tryAcquireSearchSlot(), false);

  const busy = await get("?q=whatever");
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get("retry-after"), "1");
  assert.equal(busy.headers.get("cache-control"), "no-store");
  assert.equal((await busy.json()).code, "search_busy");

  search.releaseSearchSlot();
  search.releaseSearchSlot();

  const done = await get("?q=whatever");
  assert.notEqual(done.status, 429);
  // The successful request released its slot again.
  assert.equal(search.tryAcquireSearchSlot(), true);
  search.releaseSearchSlot();
});
