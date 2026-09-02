import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
async function loadSubject() {
  return jiti.import("./usage-db.ts");
}

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
