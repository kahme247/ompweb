import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./usage-db.ts");
}

// Descriptors this process holds on `file` or its -wal/-shm (Linux): Windows cannot remove a file that stays open.
const openHandles = (file) => readdirSync("/proc/self/fd").filter((fd) => {
  try {
    return readlinkSync(join("/proc/self/fd", fd)).startsWith(file);
  } catch {
    return false;
  }
}).length;

test("a usage database it moved away from or closed no longer holds its file open", { skip: !existsSync("/proc/self/fd") && "needs /proc/self/fd" }, async (t) => {
  const { closeUsageDatabase, getUsageDatabase } = await loadSubject();
  const dir = mkdtempSync(join(tmpdir(), "omp-test-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = join(dir, "first.db");
  const second = join(dir, "second.db");
  getUsageDatabase(first).prepare("SELECT COUNT(*) FROM usage_records").get();
  assert.ok(openHandles(first) > 0);
  getUsageDatabase(second);
  assert.equal(openHandles(first), 0);
  closeUsageDatabase();
  assert.equal(openHandles(second), 0);
});

async function withTempDbDir(run) {
  const dir = join(tmpdir(), `omp-test-db-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  const { closeUsageDatabase, getUsageDatabase } = await loadSubject();

  try {
    const db = getUsageDatabase(join(dir, "test-usage.db"));
    await run(dir, db);
  } finally {
    closeUsageDatabase();
    if (prevAgentDir !== undefined) {
      process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("usage database creates tables and indexes on initialization", async () => {
  await withTempDbDir(async (_dir, db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
      .all()
      .map((row) => row.name);

    assert.ok(tables.includes("synced_files"));
    assert.ok(tables.includes("usage_records"));

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;")
      .all()
      .map((row) => row.name);

    assert.ok(indexes.includes("idx_usage_records_timestamp"));
    assert.ok(indexes.includes("idx_usage_records_file_path"));
    assert.ok(indexes.includes("idx_usage_records_provider"));
    assert.ok(indexes.includes("idx_usage_records_session_cwd"));
  });
});

test("syncSessionFilesToDb performs incremental synchronization", async () => {
  const { syncSessionFilesToDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const sessionsDir = join(dir, "sessions", "my-project");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionFile1 = join(sessionsDir, "sess-1.jsonl");
    const sessionFile2 = join(sessionsDir, "sess-2.jsonl");
    const now = Date.now();

    writeFileSync(
      sessionFile1,
      [
        JSON.stringify({ type: "session", id: "sess-1", cwd: "/home/user/my-project", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            usage: { input: 10000, output: 2000, cacheRead: 5000, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      sessionFile2,
      [
        JSON.stringify({ type: "session", id: "sess-2", cwd: "/home/user/my-project", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 4000, output: 1000, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    // 1. Initial sync
    const stats1 = syncSessionFilesToDb([sessionFile1, sessionFile2], { providers: {} }, db);
    assert.equal(stats1.filesScanned, 2);
    assert.equal(stats1.filesUpdated, 2);
    assert.equal(stats1.recordsInserted, 2);

    // Verify row counts in SQLite
    const countRow1 = db.prepare("SELECT COUNT(*) as c FROM usage_records;").get();
    assert.equal(countRow1.c, 2);

    // 2. Second sync with no file changes (should be 0 updates)
    const stats2 = syncSessionFilesToDb([sessionFile1, sessionFile2], { providers: {} }, db);
    assert.equal(stats2.filesUpdated, 0);
    assert.equal(stats2.recordsInserted, 0);

    // 3. Delete one file from the list
    const stats3 = syncSessionFilesToDb([sessionFile1], { providers: {} }, db);
    assert.equal(stats3.filesDeleted, 1);

    const countRow3 = db.prepare("SELECT COUNT(*) as c FROM usage_records;").get();
    assert.equal(countRow3.c, 1);

    // 4. Truncate sessionFile1 to 0 bytes (should purge its records on next sync)
    writeFileSync(sessionFile1, "", "utf8");
    const stats4 = syncSessionFilesToDb([sessionFile1], { providers: {} }, db);
    assert.equal(stats4.filesDeleted, 1);

    const countRow4 = db.prepare("SELECT COUNT(*) as c FROM usage_records;").get();
    assert.equal(countRow4.c, 0);
  });
});

test("getUsageReportFromDb executes fast SQL aggregations", async () => {
  const { syncSessionFilesToDb, getUsageReportFromDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const sessionsDir = join(dir, "sessions", "alpha");
    mkdirSync(sessionsDir, { recursive: true });

    const now = Date.now();
    const sessionFile = join(sessionsDir, "alpha-session.jsonl");

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "alpha-1", cwd: "/workspace/alpha", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            usage: { input: 20000, output: 4000, cacheRead: 10000, cacheWrite: 0, reasoning: 1500 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    syncSessionFilesToDb([sessionFile], { providers: {} }, db);

    const report = await getUsageReportFromDb({ range: "30d" }, db);

    assert.equal(report.timeRange, "30d");
    assert.equal(report.granularity, "daily");

    // Summary validation
    assert.ok(report.summary.totalCost > 0);
    assert.equal(report.summary.inputTokens, 20000);
    assert.equal(report.summary.outputTokens, 4000);
    assert.equal(report.summary.cacheReadTokens, 10000);
    assert.equal(report.summary.reasoningTokens, 1500);
    assert.equal(report.summary.totalTokens, 34000);
    assert.equal(report.summary.activeDays, 1);

    // Providers validation
    assert.equal(report.providers.length, 1);
    assert.equal(report.providers[0].provider, "anthropic");
    assert.equal(report.providers[0].name, "Anthropic");

    // Model breakdown validation
    assert.equal(report.modelBreakdown.length, 1);
    assert.equal(report.modelBreakdown[0].model, "claude-3-7-sonnet");

    // Project breakdown validation
    assert.equal(report.projectBreakdown.length, 1);
    assert.equal(report.projectBreakdown[0].projectName, "alpha");
  });
});

/** One session file with a single assistant request of `input` tokens. */
function writeSession(dir, name, input) {
  const sessionsDir = join(dir, "sessions", "proj");
  mkdirSync(sessionsDir, { recursive: true });
  const file = join(sessionsDir, name);
  writeFileSync(file, [
    JSON.stringify({ type: "session", id: name, cwd: "/home/user/proj", timestamp: new Date().toISOString() }),
    JSON.stringify({ type: "message", id: "e1", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input, output: 0 } } }),
  ].join("\n"), "utf8");
  return file;
}

const inputTokens = (db) => db.prepare("SELECT COALESCE(SUM(input_tokens), 0) AS t FROM usage_records").get().t;

/** The table layout of released builds: no entry/summary/parser columns, one leftover row. */
const PREVIOUS_LAYOUT = `
  CREATE TABLE synced_files (file_path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, file_size INTEGER NOT NULL,
    records_count INTEGER NOT NULL, synced_at INTEGER NOT NULL);
  CREATE TABLE usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, session_id TEXT NOT NULL,
    session_cwd TEXT NOT NULL, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
    cost REAL NOT NULL, cache_savings REAL NOT NULL, cost_quality TEXT NOT NULL);
  INSERT INTO usage_records (file_path, session_id, session_cwd, timestamp, provider, model, input_tokens, output_tokens,
    reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, cache_savings, cost_quality)
    VALUES ('/gone.jsonl', 's', '/p', 1, 'anthropic', 'm', 999999, 0, 0, 0, 0, 999999, 0, 0, 'model_priced');
`;

test("a usage.db written with the previous table layout is rebuilt and syncs", async () => {
  const { closeUsageDatabase, getUsageDatabase, syncSessionFilesToDb } = await loadSubject();

  // Released builds never set user_version (0); a pre-release build of this change set 2 on the same layout.
  for (const userVersion of [0, 2]) {
    await withTempDbDir(async (dir) => {
      closeUsageDatabase();
      const path = join(dir, "old-layout.db");
      const old = new Database(path);
      old.exec(`${PREVIOUS_LAYOUT} PRAGMA user_version = ${userVersion};`);
      old.close();

      const db = getUsageDatabase(path);
      syncSessionFilesToDb([writeSession(dir, "a.jsonl", 100)], { providers: {} }, db);
      assert.equal(inputTokens(db), 100, `user_version ${userVersion}: old rows are discarded and the new layout accepts writes`);
    });
  }
});

test("a migration that fails is rolled back and leaves the old database untouched", async () => {
  const { closeUsageDatabase, getUsageDatabase } = await loadSubject();

  await withTempDbDir(async (dir) => {
    closeUsageDatabase();
    const path = join(dir, "blocked.db");
    const old = new Database(path);
    // A view named synced_files: DROP TABLE usage_records succeeds, then DROP TABLE synced_files fails.
    old.exec(`${PREVIOUS_LAYOUT.replace("CREATE TABLE synced_files (", "CREATE TABLE unrelated (")} CREATE VIEW synced_files AS SELECT 1 AS file_path;`);
    old.close();

    assert.throws(() => getUsageDatabase(path));

    const after = new Database(path);
    assert.equal(inputTokens(after), 999999, "the rebuild was rolled back: the old rows are still there");
    assert.equal(after.inTransaction, false);
    after.close(true);
  });
});

test("a connection the previous build left open on the old layout is migrated before it is reused", async () => {
  const { closeUsageDatabase, getUsageDatabase, syncSessionFilesToDb } = await loadSubject();

  await withTempDbDir(async (dir) => {
    closeUsageDatabase();
    const path = join(dir, "hot-reload.db");
    // Before a dev hot reload, the previous module opened usage.db and left the connection on globalThis.
    const previous = new Database(path);
    previous.exec(PREVIOUS_LAYOUT);
    globalThis.__ompUsageDatabase = previous;
    globalThis.__ompUsageDatabasePath = path;

    const db = getUsageDatabase(path);
    syncSessionFilesToDb([writeSession(dir, "a.jsonl", 100)], { providers: {} }, db);
    assert.equal(inputTokens(db), 100);
  });
});

test("records the previous parser left in the in-memory cache are parsed again", async () => {
  const { syncSessionFilesToDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const file = writeSession(dir, "a.jsonl", 100);
    const { mtimeMs, size } = statSync(file);
    // Before a dev hot reload, the previous parser cached this unchanged file: no parser version, old record shape.
    globalThis.__ompUsageCache ??= new Map();
    globalThis.__ompUsageCache.set(file, {
      mtimeMs,
      size,
      sessionTimestamp: mtimeMs,
      records: [{
        timestamp: 1, sessionId: "a.jsonl", sessionCwd: "/home/user/proj", provider: "anthropic", model: "summary",
        input: 5000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5000, cost: 0, cacheSavings: 0,
        costQuality: "model_priced",
      }],
    });

    syncSessionFilesToDb([file], { providers: {} }, db);
    assert.equal(inputTokens(db), 100);
  });
});

test("files last synced by another omp-web build are re-parsed; files synced by this one are not", async () => {
  const { syncSessionFilesToDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const file = writeSession(dir, "a.jsonl", 100);
    syncSessionFilesToDb([file], { providers: {} }, db);

    // An older build sharing usage.db re-syncs the unchanged file by its own rules:
    // it rewrites the synced row without a parser version and stores different records.
    const { mtimeMs, size } = statSync(file);
    db.prepare("INSERT OR REPLACE INTO synced_files (file_path, mtime_ms, file_size, records_count, synced_at) VALUES (?, ?, ?, 1, 0)")
      .run(file, mtimeMs, size);
    db.prepare(`INSERT INTO usage_records (file_path, session_id, session_cwd, timestamp, provider, model, input_tokens, output_tokens,
      reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, cache_savings, cost_quality)
      VALUES (?, 'a.jsonl', '/home/user/proj', 1, 'anthropic', 'summary', 5000, 0, 0, 0, 0, 5000, 0, 0, 'model_priced')`).run(file);
    assert.equal(inputTokens(db), 5100, "precondition: the other build's row is counted until re-parsed");

    const resync = syncSessionFilesToDb([file], { providers: {} }, db);
    assert.equal(resync.filesUpdated, 1);
    assert.equal(inputTokens(db), 100);
    assert.equal(syncSessionFilesToDb([file], { providers: {} }, db).filesUpdated, 0);
  });
});

/** The v3 layout: no `host_id`, `synced_files` keyed by path alone, one leftover row. */
const V3_LAYOUT = `
  CREATE TABLE synced_files (file_path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, file_size INTEGER NOT NULL,
    records_count INTEGER NOT NULL, synced_at INTEGER NOT NULL, parser_version INTEGER);
  CREATE TABLE usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, session_id TEXT NOT NULL,
    session_cwd TEXT NOT NULL, timestamp INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
    cost REAL NOT NULL, cache_savings REAL NOT NULL, cost_quality TEXT NOT NULL, entry_id TEXT, subagent_file TEXT,
    session_started INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX idx_usage_records_file_path ON usage_records(file_path);
  INSERT INTO usage_records (file_path, session_id, session_cwd, timestamp, provider, model, input_tokens, output_tokens,
    reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost, cache_savings, cost_quality)
    VALUES ('/gone.jsonl', 's', '/p', 1, 'anthropic', 'm', 999999, 0, 0, 0, 0, 999999, 0, 0, 'model_priced');
  PRAGMA user_version = 3;
`;

test("a v3 usage.db is rebuilt with host ids and host sync times", async () => {
  const { closeUsageDatabase, getUsageDatabase, syncSessionFilesToDb } = await loadSubject();

  await withTempDbDir(async (dir) => {
    closeUsageDatabase();
    const path = join(dir, "v3.db");
    const old = new Database(path);
    old.exec(V3_LAYOUT);
    old.close();

    const db = getUsageDatabase(path);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(inputTokens(db), 0, "the v3 rows are discarded");
    assert.deepEqual(db.prepare("SELECT * FROM synced_hosts").all(), []);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
    assert.ok(indexes.includes("idx_usage_records_host"));
    assert.ok(indexes.includes("idx_usage_records_file_path"));

    syncSessionFilesToDb([writeSession(dir, "a.jsonl", 100)], { providers: {} }, db);
    assert.deepEqual(db.prepare("SELECT DISTINCT host_id FROM usage_records").all(), [{ host_id: "local" }]);
  });
});

/** One linked-host transcript at `path` with a single request of `input` tokens in project `cwd`. */
function hostTranscript(path, input, { cwd = "/home/u/remote-proj", session = "remote-session", entryId = `${path}#e1` } = {}) {
  return {
    path,
    mtimeMs: 1,
    size: 10,
    records: [{
      timestamp: Date.now(), sessionId: session, sessionCwd: cwd, provider: "anthropic", model: "claude-opus-5-5",
      input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: input / 1000, cacheSavings: 0,
      costQuality: "model_priced", entryId, sessionStarted: 1,
    }],
  };
}

const hostTokens = (db, hostId) => db.prepare("SELECT COALESCE(SUM(input_tokens), 0) AS t FROM usage_records WHERE host_id = ?").get(hostId).t;

test("syncing and force-refreshing this machine's usage leave linked hosts' rows alone", async () => {
  const { getUsageReportFromDb, storeHostUsage, syncSessionFilesToDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    const local = writeSession(dir, "a.jsonl", 100);
    // The same path on another machine is a different transcript.
    storeHostUsage(db, "laptop", 1, [hostTranscript(local, 7), hostTranscript("/home/u/.omp/s/b.jsonl", 30)], []);

    syncSessionFilesToDb([local], { providers: {} }, db);
    assert.equal(hostTokens(db, "laptop"), 37);
    syncSessionFilesToDb([], { providers: {} }, db);
    assert.equal(hostTokens(db, "local"), 0, "the local transcript is purged");
    assert.equal(hostTokens(db, "laptop"), 37, "the purge kept the host's rows, the one sharing the path too");

    const linked = [
      { hostId: "laptop", label: "Laptop", state: "current", syncedAt: 5 },
      { hostId: "idle", label: "Idle", state: "offline", syncedAt: null },
    ];
    const before = Date.now();
    const report = await getUsageReportFromDb({ range: "30d", forceRefresh: true }, db, linked);
    assert.equal(hostTokens(db, "laptop"), 37, "forceRefresh rebuilt only this machine's rows");
    assert.equal(report.summary.inputTokens, 137);
    assert.deepEqual(report.hostBreakdown.map(({ hostId, label, state, tokens, sessionsCount }) => ({ hostId, label, state, tokens, sessionsCount })), [
      { hostId: "local", label: "", state: "current", tokens: 100, sessionsCount: 1 },
      { hostId: "laptop", label: "Laptop", state: "current", tokens: 37, sessionsCount: 1 },
      { hostId: "idle", label: "Idle", state: "offline", tokens: 0, sessionsCount: 0 },
    ]);
    const [ownSyncedAt, ...linkedSyncedAt] = report.hostBreakdown.map((host) => host.syncedAt);
    assert.ok(ownSyncedAt >= before, "this machine was synced for this report");
    assert.deepEqual(linkedSyncedAt, [5, null]);
    const laptopProject = report.projectBreakdown.find((row) => row.hostId === "laptop");
    assert.deepEqual([laptopProject.project, laptopProject.projectName, laptopProject.hostLabel], ["/home/u/remote-proj", "remote-proj", "Laptop"]);
    assert.equal(report.projectBreakdown.find((row) => row.hostId === "local").hostLabel, "");
  });
});

test("a force refresh prices this machine's unchanged transcripts with the current models.yml", async () => {
  const { getUsageReportFromDb } = await loadSubject();

  await withTempDbDir(async (dir, db) => {
    writeSession(dir, "a.jsonl", 1_000_000);
    const price = (input) => writeFileSync(join(dir, "models.yml"), JSON.stringify({
      providers: { anthropic: { models: [{ id: "claude-opus-5-5", cost: { input, output: 0, cacheRead: 0, cacheWrite: 0 } }] } },
    }));
    const cost = async (forceRefresh) => (await getUsageReportFromDb({ range: "30d", forceRefresh }, db)).summary.totalCost;

    price(2);
    assert.equal(await cost(true), 2);
    price(5);
    assert.equal(await cost(false), 2, "an unchanged transcript is not read again");
    assert.equal(await cost(true), 5);
  });
});

test("linked hosts' rows are replaced per transcript, dropped when gone, and pruned with their host", async () => {
  const { getUsageReportFromDb, hostSyncTimes, markHostSynced, pruneHostUsage, storedStamps, storeHostUsage } = await loadSubject();

  await withTempDbDir(async (_dir, db) => {
    assert.throws(() => storeHostUsage(db, "local", 1, [hostTranscript("/x.jsonl", 1)], []));

    storeHostUsage(db, "win", 1, [hostTranscript("C:\\s\\a.jsonl", 10, { cwd: "C:\\Users\\u\\proj" }), hostTranscript("C:\\s\\b.jsonl", 20)], []);
    storeHostUsage(db, "win", 2, [{ ...hostTranscript("C:\\s\\a.jsonl", 15, { cwd: "C:\\Users\\u\\proj" }), mtimeMs: 9, size: 11 }], ["C:\\s\\b.jsonl"]);
    markHostSynced(db, "win", 111);
    assert.equal(hostTokens(db, "win"), 15);
    assert.deepEqual([...storedStamps(db, "win")], [["C:\\s\\a.jsonl", { mtimeMs: 9, size: 11, parserVersion: 2 }]]);

    const report = await getUsageReportFromDb({ range: "30d" }, db);
    const row = report.projectBreakdown.find((project) => project.hostId === "win");
    assert.deepEqual([row.projectName, row.hostLabel], ["proj", "win"], "Windows paths name their folder; an unnamed host goes by its id");

    storeHostUsage(db, "kept", 1, [hostTranscript("/k.jsonl", 5)], []);
    markHostSynced(db, "kept", 222);
    markHostSynced(db, "kept", 333);
    pruneHostUsage(db, ["kept"]);
    assert.equal(hostTokens(db, "win"), 0);
    assert.equal(storedStamps(db, "win").size, 0);
    assert.equal(hostTokens(db, "kept"), 5);
    assert.deepEqual([...hostSyncTimes(db)], [["kept", 333]]);
  });
});
