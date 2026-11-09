import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const search = await import("./session-message-search.ts");
// File I/O is slow on loaded Windows hosts; only the budget test relies on the clock.
const TEST_BUDGET_MS = 120_000;
const route = await import("../app/api/sessions/messages/search/route.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");
const sessionFiles = await import("./omp/session-files.ts");

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
  const filePath = join(dir, name);
  writeFileSync(filePath, body, "utf8");
  const seconds = mtimeMs / 1000;
  utimesSync(filePath, seconds, seconds);
  return filePath;
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
  search.invalidateSessionSearchListing();
  try {
    await run(projectDir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    search.invalidateSessionSearchListing();
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

test("the listing walk is charged to the budget and yields the event loop", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The walk is inside the budget now: a walk that consumes it must leave the
  // page partial with a cursor pointing at the first file, instead of the old
  // behaviour where a slow listing was free and the page then scanned 5 s more.
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
  assert.equal(page.partial, true);
  assert.ok(page.cursor, "an exhausted budget must still hand back a resumable cursor");
  assert.deepEqual(page.results, []);
  assert.equal(page.scannedFiles, 0, "no file may be scanned once the budget is gone");

  // The continuation is not stuck: it resolves the run's snapshot and makes
  // progress with a fresh budget, so the run terminates rather than looping on
  // an empty page forever.
  const seen = [];
  let cursor = page.cursor;
  for (let pages = 0; cursor && pages < 20; pages++) {
    const next = await search.searchSessionMessages({
      query: "needle",
      cursor,
      now: () => clock,
      budgetMs: TEST_BUDGET_MS,
    });
    seen.push(...next.results.map((hit) => hit.entryId));
    cursor = next.cursor;
  }
  assert.deepEqual(seen, ["a-user-2", "a-user-1", "b-assistant", "b-user"]);
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
  const filePath = writeSession(dir, "bad.jsonl", `${body}\n`, 1000);
  const files = [{ path: filePath, id: "s-bad", cwd: "/w", title: "", size: statSync(filePath).size, modifiedMs: 1000 }];

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
  const filePath = writeSession(dir, "uniform.jsonl", sessionFile("s-uniform", "/w", lines), 1000);
  const size = statSync(filePath).size;
  const files = [{ path: filePath, id: "s-uniform", cwd: "/w", title: "Uniform", size, modifiedMs: 1000 }];
  const raw = readFileSync(filePath);
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
      // The cursor names the session, never the server's file path.
      assert.equal(decoded.sessionId, "s-uniform");
      assert.equal(JSON.stringify(decoded).includes(filePath), false, "the cursor must not disclose the file path");
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
  const filePath = writeSession(dir, "long.jsonl", sessionFile("s-long", "/w", [
    message("short-1", "user", "needle first"),
    message("long-1", "user", longText),
    message("short-2", "user", "needle last"),
  ]), 1000);
  const files = [{ path: filePath, id: "s-long", cwd: "/w", title: "", size: statSync(filePath).size, modifiedMs: 1000 }];

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
  const filePath = writeSession(dir, "case.jsonl", sessionFile("s-case", "/w", [
    message("case-1", "user", "İstanbul ist schön, needle hier"),
  ]), 1000);
  const files = [{ path: filePath, id: "s-case", cwd: "/w", title: "", size: statSync(filePath).size, modifiedMs: 1000 }];

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

  // The tie is broken by session id, so s-a (one hit left after the page) comes first.
  const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS, sessions: files });
  assert.deepEqual(first.results.map((hit) => hit.entryId), ["a-2"]);
  assert.ok(first.cursor);

  rmSync(pathA);
  const resumed = await search.searchSessionMessages({
    query: "needle",
    cursor: first.cursor,
    sessions: [files[1]],
  });
  // a-1 was still unscanned but its session is gone; s-b has the same mtime
  // and sorts after it, so it must not be skipped.
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

test("route answers 429 while the scan slots are taken and recovers after release", { timeout: 30_000 }, async (t) => {
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

  // A real (but empty) agent dir: the probe must not scan this machine's multi-GB corpus.
  await withAgentDir(async () => {
    const done = await get("?q=whatever");
    assert.notEqual(done.status, 429);
  });
  // The successful request released its slot again.
  assert.equal(search.tryAcquireSearchSlot(), true);
  search.releaseSearchSlot();
});

test("an aborted scan stops and reports SearchAbortedError instead of finishing", async (t) => {
  const { dir, files } = fixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Already aborted: the scan must not even list.
  let listed = false;
  await assert.rejects(
    () => search.searchSessionMessages({
      query: "needle",
      signal: AbortSignal.abort(),
      listSessions: async () => { listed = true; return files; },
    }),
    (error) => error.name === "SearchAbortedError",
  );
  assert.equal(listed, false, "an aborted request must not start the listing");

  // Aborted while the listing runs: the check after it must stop the scan.
  const afterListing = new AbortController();
  await assert.rejects(
    () => search.searchSessionMessages({
      query: "needle",
      signal: afterListing.signal,
      listSessions: async () => { afterListing.abort(); return files; },
      budgetMs: TEST_BUDGET_MS,
    }),
    (error) => error.name === "SearchAbortedError",
  );

  // Aborted mid-file: the per-chunk check must stop the read loop. One large
  // file means no per-file check can rescue it, and the clock count proves the
  // scan stopped early instead of reading the rest of the file.
  const abortDir = mkdtempSync(join(tmpdir(), "omp-web-search-abort-"));
  t.after(() => rmSync(abortDir, { recursive: true, force: true }));
  const lines = [];
  for (let index = 0; index < 400; index++) lines.push(message(`ab-${index}`, "user", `needle abort filler ${index}`));
  const abortPath = writeSession(abortDir, "abort.jsonl", sessionFile("s-abort", "/w", lines), 1000);
  const abortFiles = [{ path: abortPath, id: "s-abort", cwd: "/w", title: "", size: statSync(abortPath).size, modifiedMs: 1000 }];
  assert.ok(abortFiles[0].size > 64 * 100, "the fixture must need many chunks");

  const midScan = new AbortController();
  let clockCalls = 0;
  await assert.rejects(
    () => search.searchSessionMessages({
      query: "needle",
      signal: midScan.signal,
      sessions: abortFiles,
      chunkBytes: 64,
      budgetMs: TEST_BUDGET_MS,
      now: () => {
        clockCalls++;
        if (clockCalls === 3) midScan.abort();
        return 0;
      },
    }),
    (error) => error.name === "SearchAbortedError",
  );
  assert.ok(clockCalls < 20, `the scan must stop at the abort, not read the whole file (${clockCalls} chunks)`);
});

test("the route releases its slot and answers 499 when the client aborted", async (t) => {
  t.after(() => {
    search.releaseSearchSlot();
    search.releaseSearchSlot();
  });
  const controller = new AbortController();
  controller.abort();
  const response = await route.GET(new Request("http://localhost/api/sessions/messages/search?q=needle", {
    signal: controller.signal,
  }));
  assert.equal(response.status, 499);
  assert.equal(response.headers.get("cache-control"), "no-store");
  // Both slots are free again: the aborted request released the one it took.
  assert.equal(search.tryAcquireSearchSlot(), true);
  assert.equal(search.tryAcquireSearchSlot(), true);
  assert.equal(search.tryAcquireSearchSlot(), false);
});

test("the route reports local scope and rejects non-decimal limits", async () => {
  const get = (query) => route.GET(new Request(`http://localhost/api/sessions/messages/search${query}`));
  for (const raw of ["0x10", "1e2", " 5", "5.0", "1000"]) {
    const response = await get(`?q=needle&limit=${encodeURIComponent(raw)}`);
    assert.equal(response.status, 400, `limit=${raw} must be rejected`);
    assert.equal((await response.json()).code, "invalid_limit");
  }

  await withAgentDir(async (projectDir) => {
    writeSession(projectDir, "scope.jsonl", sessionFile("scope-1", "/work/scope", [
      message("sc-1", "user", "scope needle"),
    ]), 1_000);
    const body = await (await get("?q=needle")).json();
    // Sessions of linked hosts are not searched; the answer says so.
    assert.equal(body.scope, "local");
  });
});

test("a pagination run resolves its own listing snapshot, not the shared directory", async () => {
  await withAgentDir(async (projectDir) => {
    writeSession(projectDir, "one.jsonl", sessionFile("cache-1", "/work/cache", [
      message("c-1", "user", "cache needle one"),
      message("c-2", "user", "cache needle two"),
    ]), 1_000);
    search.invalidateSessionSearchListing();

    const first = await search.startSessionSearchListing(Date.now);
    assert.deepEqual(first.files.map((file) => file.id), ["cache-1"]);

    // The same id resolves the identical snapshot object: no second walk.
    const second = search.resumeSessionSearchListing(first.id, Date.now);
    assert.equal(second, first.files, "a page must reuse its run's snapshot");

    // A new session changes the directory, but the run's snapshot does not move:
    // that is the point of binding the listing to the run.
    writeSession(projectDir, "two.jsonl", sessionFile("cache-2", "/work/cache", [
      message("c-3", "user", "cache needle three"),
    ]), 2_000);
    const root = join(projectDir, "..");
    const now = Date.now() / 1000;
    utimesSync(root, now, now);
    const third = search.resumeSessionSearchListing(first.id, Date.now);
    assert.equal(third, first.files, "another search's walk must not change this run's listing");

    // A *new* run does see the new session.
    const fresh = await search.startSessionSearchListing(Date.now);
    assert.notEqual(fresh.id, first.id);
    assert.deepEqual(fresh.files.map((file) => file.id).sort(), ["cache-1", "cache-2"]);
  });
});

/**
 * The sessions root's mtime is the only thing the pagination cache keys on, so
 * a session written into an existing project directory can leave it untouched
 * (Windows/NTFS, and any filesystem where a subdirectory write does not reach
 * the parent). Pin it, so these fixtures model exactly that case.
 */
function pinRootMtime(projectDir) {
  const root = join(projectDir, "..");
  const seconds = 1_000;
  utimesSync(root, seconds, seconds);
}

test("a fresh search establishes the listing its cursor pages continue from", async () => {
  await withAgentDir(async (projectDir) => {
    // An older pagination run warms the shared cache with a corpus that only
    // knows s-old; s-new then appears without the sessions root's mtime moving.
    writeSession(projectDir, "old.jsonl", sessionFile("s-old", "/work/old", [
      message("old-1", "user", "needle in the old session"),
      message("old-2", "user", "another needle in the old session"),
    ]), 1_000);
    pinRootMtime(projectDir);

    const warmFirst = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(warmFirst.results.map((hit) => hit.sessionId), ["s-old"]);
    assert.ok(warmFirst.cursor);
    // Page 2 of that run installs the s-old-only listing in the shared cache.
    const warmSecond = await search.searchSessionMessages({
      query: "needle",
      cursor: warmFirst.cursor,
      limit: 1,
      budgetMs: TEST_BUDGET_MS,
    });
    assert.deepEqual(warmSecond.results.map((hit) => hit.entryId), ["old-1"]);

    writeSession(projectDir, "new.jsonl", sessionFile("s-new", "/work/new", [
      message("new-1", "user", "needle in the new session"),
      message("new-2", "user", "second needle in the new session"),
    ]), 2_000);
    pinRootMtime(projectDir);
    // Session mutations invalidate the ordinary list cache, not the search one.
    invalidateSessionListCache();

    // A fresh search must page its OWN listing: page 1 finds s-new, so page 2
    // must continue inside s-new instead of falling back to the older corpus.
    const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(first.results.map((hit) => hit.entryId), ["new-2"]);
    assert.ok(first.cursor, "a limit=1 page over two hits must return a cursor");

    const seen = [...first.results.map((hit) => hit.entryId)];
    let cursor = first.cursor;
    for (let page = 0; cursor && page < 10; page++) {
      const next = await search.searchSessionMessages({
        query: "needle",
        cursor,
        limit: 1,
        budgetMs: TEST_BUDGET_MS,
      });
      seen.push(...next.results.map((hit) => hit.entryId));
      cursor = next.cursor;
    }
    assert.equal(cursor, null, "the run must terminate");
    // The whole corpus in newest-first order. The defect this guards against
    // skipped new-1: page 2 fell back to the older listing and answered
    // old-2, so the sequence was ["new-2", "old-2", "old-1"].
    assert.deepEqual(seen, ["new-2", "new-1", "old-2", "old-1"]);
  });
});

test("a pagination run walks the corpus once even when the cache starts empty", async () => {
  await withAgentDir(async (projectDir) => {
    const path = writeSession(projectDir, "one.jsonl", sessionFile("run-1", "/work/run", [
      message("r-1", "user", "run needle one"),
      message("r-2", "user", "run needle two"),
      message("r-3", "user", "run needle three"),
    ]), 1_000);
    pinRootMtime(projectDir);
    search.invalidateSessionSearchListing();

    // Count the real walks: a run must pay for exactly one, on its first page.
    let walks = 0;
    const countingWalk = async () => {
      walks++;
      return [{ path, id: "run-1", cwd: "/work/run", title: "", size: statSync(path).size, modifiedMs: 1_000 }];
    };

    const first = await search.searchSessionMessages({
      query: "needle",
      limit: 1,
      listSessions: countingWalk,
      budgetMs: TEST_BUDGET_MS,
    });
    assert.deepEqual(first.results.map((hit) => hit.entryId), ["r-3"]);
    assert.ok(first.cursor);
    assert.equal(walks, 1, "the fresh search walks once");

    const second = await search.searchSessionMessages({
      query: "needle",
      cursor: first.cursor,
      limit: 1,
      listSessions: countingWalk,
      budgetMs: TEST_BUDGET_MS,
    });
    // Page 2 resolves the run's snapshot: no second walk.
    assert.equal(walks, 1, "a continuation must not walk the corpus again");
    assert.deepEqual(second.results.map((hit) => hit.entryId), ["r-2"]);
  });
});

test("the session listing walk yields the event loop instead of blocking it", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-search-yield-"));
  const sessionsRoot = join(agentDir, "sessions");
  const projectDir = join(sessionsRoot, "-project");
  mkdirSync(projectDir, { recursive: true });
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));

  // A real corpus: the per-file scan is statSync + readSync + JSON.parse, so
  // this is the same synchronous work a production walk does. 1,000 files is
  // ~1.2 s cold here, i.e. far more than one slice on any machine.
  const FILE_COUNT = 1000;
  for (let index = 0; index < FILE_COUNT; index++) {
    writeFileSync(
      join(projectDir, `yield-${index}.jsonl`),
      sessionFile(`yield-${index}`, "/work/yield", [message(`y-${index}`, "user", `needle ${index}`)]),
      "utf8",
    );
  }

  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    sessionFiles.invalidateAllSessionScanCaches();
    sessionFiles.invalidateSessionFileListCache();

    let ticks = 0;
    let maxGapMs = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
      ticks++;
    }, 10);
    // A setImmediate chain runs once per loop turn: it counts the walk's
    // hand-backs exactly, independent of how fast the machine walks.
    let yields = 0;
    let walking = true;
    const countTurn = () => {
      if (!walking) return;
      yields++;
      setImmediate(countTurn);
    };
    setImmediate(countTurn);
    const started = performance.now();
    const infos = await sessionFiles.listAllSessionInfos();
    const durationMs = performance.now() - started;
    walking = false;
    clearInterval(timer);

    assert.equal(infos.length, FILE_COUNT);
    // Before the fix this walk held the loop for its whole duration: no loop
    // turn at all until it returned, and one stall as long as the walk. The
    // assertions are therefore about the loop turning at all and about the
    // worst single stall, not about a fraction of the walk: a walk that blocks
    // for half its length would pass a relative bound while still being the
    // stall this fix removes.
    //
    // Counting loop turns with a setImmediate chain is exact on any machine
    // speed (a timer-tick floor is not: a fast walk may legitimately see fewer
    // 10 ms ticks than a floor demands). The pre-fix walk turns the loop 0
    // times here on every platform.
    assert.ok(
      yields >= 1,
      `the walk must hand the loop back (${yields} turns, ${ticks} timer ticks in ${Math.round(durationMs)} ms)`,
    );
    // The absolute promise of the fix: no stretch of the walk holds the loop
    // for half a second. A 10 ms timer is coalesced by the OS, so this is a
    // stall bound, not a latency measurement.
    assert.ok(
      maxGapMs < 500,
      `no single stall may reach 500 ms (${Math.round(maxGapMs)} ms of ${Math.round(durationMs)} ms)`,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    sessionFiles.invalidateAllSessionScanCaches();
    sessionFiles.invalidateSessionFileListCache();
  }
});

test("a run keeps paging its own listing when another search re-walks the corpus", async () => {
  await withAgentDir(async (projectDir) => {
    // Corpus, newest first: a-1, b-2, b-1, c-1.
    const aPath = writeSession(projectDir, "a.jsonl", sessionFile("s-a", "/w/a", [
      message("a-1", "user", "needle a one"),
    ]), 4_000);
    const bPath = writeSession(projectDir, "b.jsonl", sessionFile("s-b", "/w/b", [
      message("b-1", "user", "needle b one"),
      message("b-2", "user", "needle b two"),
    ]), 3_000);
    const cPath = writeSession(projectDir, "c.jsonl", sessionFile("s-c", "/w/c", [
      message("c-1", "user", "needle c one"),
    ]), 2_000);
    pinRootMtime(projectDir);
    search.invalidateSessionSearchListing();

    const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(first.results.map((hit) => hit.entryId), ["a-1"]);
    assert.ok(first.cursor);

    // Another client's fresh search re-walks the shared directory while an
    // older session (s-b) receives a message, so s-b now sorts *above* the
    // cursor session. A page that re-resolved an index in that new listing
    // would start at s-b's new position and skip b-2/b-1 entirely.
    writeSession(projectDir, "b.jsonl", sessionFile("s-b", "/w/b", [
      message("b-1", "user", "needle b one"),
      message("b-2", "user", "needle b two"),
      message("b-3", "user", "needle b three"),
    ]), 5_000);
    pinRootMtime(projectDir);
    invalidateSessionListCache();
    const other = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(other.results.map((hit) => hit.entryId), ["b-3"], "the other search sees the new order");

    const seen = [...first.results.map((hit) => hit.entryId)];
    let cursor = first.cursor;
    for (let page = 0; cursor && page < 20; page++) {
      const next = await search.searchSessionMessages({
        query: "needle",
        cursor,
        limit: 1,
        budgetMs: TEST_BUDGET_MS,
      });
      seen.push(...next.results.map((hit) => hit.entryId));
      cursor = next.cursor;
    }
    assert.equal(cursor, null, "the run must terminate");
    // Exactly the run's own snapshot, in its own order: b-2 and b-1 are not
    // skipped, and nothing is returned twice. The defect this guards against
    // answered ["a-1", "c-1"] and reported the run complete.
    assert.deepEqual(seen, ["a-1", "b-2", "b-1", "c-1"]);

    // The paths exist so the fixture above is a real corpus, not just stubs.
    for (const path of [aPath, bPath, cPath]) assert.ok(statSync(path).size > 0);
  });
});

test("a session that moves below the cursor is never returned twice", async () => {
  await withAgentDir(async (projectDir) => {
    // Corpus, newest first: x-1, y-2, y-1.
    writeSession(projectDir, "x.jsonl", sessionFile("s-x", "/w/x", [
      message("x-1", "user", "needle x one"),
    ]), 3_000);
    writeSession(projectDir, "y.jsonl", sessionFile("s-y", "/w/y", [
      message("y-1", "user", "needle y one"),
      message("y-2", "user", "needle y two"),
    ]), 2_000);
    pinRootMtime(projectDir);
    search.invalidateSessionSearchListing();

    const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(first.results.map((hit) => hit.entryId), ["x-1"]);
    assert.ok(first.cursor);

    // s-x's mtime drops below the cursor session: in a re-walked listing the
    // already-scanned s-x would sort after the cursor and be scanned again.
    writeSession(projectDir, "x.jsonl", sessionFile("s-x", "/w/x", [
      message("x-1", "user", "needle x one"),
    ]), 1_000);
    pinRootMtime(projectDir);
    invalidateSessionListCache();
    await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });

    const seen = [...first.results.map((hit) => hit.entryId)];
    let cursor = first.cursor;
    for (let page = 0; cursor && page < 20; page++) {
      const next = await search.searchSessionMessages({
        query: "needle",
        cursor,
        limit: 1,
        budgetMs: TEST_BUDGET_MS,
      });
      seen.push(...next.results.map((hit) => hit.entryId));
      cursor = next.cursor;
    }
    assert.deepEqual(seen, ["x-1", "y-2", "y-1"], "x-1 must not appear twice");
  });
});

test("a continuation whose snapshot expired is refused instead of re-walking", async () => {
  await withAgentDir(async (projectDir) => {
    writeSession(projectDir, "one.jsonl", sessionFile("exp-1", "/w/exp", [
      message("e-1", "user", "needle expired one"),
      message("e-2", "user", "needle expired two"),
    ]), 1_000);
    pinRootMtime(projectDir);
    search.invalidateSessionSearchListing();

    const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.ok(first.cursor);

    // Explicit invalidation models the TTL/LRU eviction: the run's listing is
    // gone, and paging a fresh corpus could skip or repeat hits.
    search.invalidateSessionSearchListing();
    await assert.rejects(
      () => search.searchSessionMessages({ query: "needle", cursor: first.cursor, budgetMs: TEST_BUDGET_MS }),
      (error) => error.name === "SearchCursorError" && error.message === "cursor_expired",
    );

    // The route reports it as a restart instruction, not as a broken cursor.
    const response = await route.GET(new Request(
      `http://localhost/api/sessions/messages/search?q=needle&cursor=${encodeURIComponent(first.cursor)}`,
    ));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "cursor_expired");
  });
});

test("a run's snapshot expires after five idle minutes and is evicted by newer runs", async () => {
  await withAgentDir(async (projectDir) => {
    writeSession(projectDir, "one.jsonl", sessionFile("ttl-1", "/w/ttl", [
      message("t-1", "user", "needle ttl one"),
    ]), 1_000);
    pinRootMtime(projectDir);
    search.invalidateSessionSearchListing();

    // A fake clock makes the TTL deterministic: five minutes is a real wait.
    let clock = 1_000_000;
    const first = await search.searchSessionMessages({
      query: "needle",
      limit: 1,
      now: () => clock,
      listSessions: async () => [{
        path: join(projectDir, "one.jsonl"),
        id: "ttl-1",
        cwd: "/w/ttl",
        title: "",
        size: statSync(join(projectDir, "one.jsonl")).size,
        modifiedMs: 1_000,
      }],
      budgetMs: TEST_BUDGET_MS,
    });
    assert.ok(first.cursor);

    // The TTL is sliding, not absolute: a run that keeps paginating every four
    // minutes stays alive for far longer than five minutes in total.
    const listingId = search.decodeSearchCursor(first.cursor).l;
    for (let page = 0; page < 5; page++) {
      clock += 4 * 60_000;
      assert.ok(
        search.resumeSessionSearchListing(listingId, () => clock),
        `page ${page + 1} of an active run must not expire (${(page + 1) * 4} minutes after page 1)`,
      );
    }

    // Five idle minutes after the last use: gone.
    clock += 5 * 60_000;
    assert.equal(search.resumeSessionSearchListing(listingId, () => clock), undefined);

    // Eviction: five live runs, the oldest is dropped.
    search.invalidateSessionSearchListing();
    const ids = [];
    for (let index = 0; index < 5; index++) {
      const installed = search.installSessionSearchListing(() => clock, []);
      ids.push(installed.id);
    }
    assert.equal(search.resumeSessionSearchListing(ids[0], () => clock), undefined, "the oldest run is evicted");
    for (const id of ids.slice(1)) {
      assert.ok(search.resumeSessionSearchListing(id, () => clock), `${id} stays addressable`);
    }
  });
});

test("a cursor from before a restart is refused instead of paging the new run's listing", async () => {
  await withAgentDir(async (projectDir) => {
    // Corpus, newest first: a-1, b-1, c-1.
    writeSession(projectDir, "a.jsonl", sessionFile("s-a", "/w/a", [
      message("a-1", "user", "needle a one"),
    ]), 4_000);
    writeSession(projectDir, "b.jsonl", sessionFile("s-b", "/w/b", [
      message("b-1", "user", "needle b one"),
    ]), 3_000);
    writeSession(projectDir, "c.jsonl", sessionFile("s-c", "/w/c", [
      message("c-1", "user", "needle c one"),
    ]), 2_000);
    pinRootMtime(projectDir);

    // The run must be the first one in its process, or its id would be a
    // number a restarted process never mints and the collision below could not
    // happen. Resetting the counter models exactly that: a server that has
    // just started.
    delete globalThis.__ompSessionSearchListingIds;
    const first = await search.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(first.results.map((hit) => hit.entryId), ["a-1"]);
    assert.ok(first.cursor);
    const oldListing = search.decodeSearchCursor(first.cursor).l;

    // A restart: the snapshot map and the id counter died with the old
    // process, and the code answering the next request is a fresh module
    // instance — a new nonce, a counter that starts at 0 again.
    delete globalThis.__ompSessionSearchListings;
    delete globalThis.__ompSessionSearchListingIds;
    const restarted = await import("./session-message-search.ts?restart=1");

    // s-b receives a message and sorts above the old cursor's session, so the
    // new process's first page is a different corpus under the same numbering.
    writeSession(projectDir, "b.jsonl", sessionFile("s-b", "/w/b", [
      message("b-1", "user", "needle b one"),
      message("b-2", "user", "needle b two"),
    ]), 5_000);
    pinRootMtime(projectDir);
    invalidateSessionListCache();

    const fresh = await restarted.searchSessionMessages({ query: "needle", limit: 1, budgetMs: TEST_BUDGET_MS });
    assert.deepEqual(fresh.results.map((hit) => hit.entryId), ["b-2"], "the new process sees the new order");
    assert.ok(fresh.cursor);
    const newListing = restarted.decodeSearchCursor(fresh.cursor).l;

    // The old cursor is refused, so the client restarts instead of receiving
    // a page from a corpus it never saw. Without the nonce this resolves the
    // new run's snapshot instead, and the continuation silently pages a
    // corpus its first page never scanned — answering a-1, c-1 and skipping
    // b-2/b-1 while reporting the run complete.
    await assert.rejects(
      () => restarted.searchSessionMessages({ query: "needle", cursor: first.cursor, budgetMs: TEST_BUDGET_MS }),
      (error) => error.name === "SearchCursorError" && error.message === "cursor_expired",
    );

    // Why it is refused: listing ids are process-scoped, so the new run never
    // claims the number the old cursor still names.
    assert.notEqual(newListing, oldListing, "a restarted process must not reuse a listing id");

    // The new run's own cursor still pages its own snapshot: the nonce
    // separates processes, it does not break pagination inside one.
    const second = await restarted.searchSessionMessages({
      query: "needle",
      cursor: fresh.cursor,
      limit: 1,
      budgetMs: TEST_BUDGET_MS,
    });
    assert.deepEqual(second.results.map((hit) => hit.entryId), ["b-1"]);
  });
});
