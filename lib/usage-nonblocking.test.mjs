import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  getUsageReport,
  invalidateUsageCache,
  invalidateUsageReportCache,
  USAGE_REPORT_REFRESH_MS,
} from "./usage-service.ts";
import { closeUsageDatabase, getUsageDatabase } from "./usage-db.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Throwaway agent dir: getSessionsDir() resolves to <dir>/sessions, the usage
 * database to <dir>/usage.db.
 */
async function withTempUsageDir(run) {
  const dir = join(tmpdir(), `omp-test-usage-nonblocking-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "sessions", "project"), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateUsageCache();
  invalidateUsageReportCache();
  try {
    await run(dir);
  } finally {
    closeUsageDatabase();
    invalidateUsageCache();
    invalidateUsageReportCache();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write `files` transcripts of about `bytesPerFile` bytes. The bulk is ordinary
 * conversation text, like a real transcript that grows through tool output and
 * long user messages; only every 500th line is an assistant message with usage,
 * so the scan does real read/parse work while the report stays small.
 */
function writeUsageFixtures(dir, files, bytesPerFile) {
  const line = (index, withUsage) => JSON.stringify({
    type: "message",
    id: `e${index}`,
    parentId: null,
    timestamp: new Date(Date.now() - 60_000 + index).toISOString(),
    message: withUsage
      ? {
        role: "assistant",
        provider: "anthropic",
        model: "claude-opus-5-5",
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.001 } },
      }
      : { role: "user", content: `message ${index} ${"x".repeat(240)}` },
  });
  const perFile = Math.max(1, Math.round(bytesPerFile / 340));
  for (let file = 0; file < files; file++) {
    const header = JSON.stringify({
      type: "session",
      id: `session-${file}`,
      cwd: "/home/user/project",
      timestamp: new Date(Date.now() - 120_000).toISOString(),
    });
    const body = [header];
    for (let i = 0; i < perFile; i++) body.push(line(i, i % 500 === 0));
    writeFileSync(join(dir, "sessions", "project", `session-${file}.jsonl`), `${body.join("\n")}\n`, "utf8");
  }
}

test("a large transcript scan leaves the event loop responsive", async () => {
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 6, 4 * 1024 * 1024);
    // Opening and migrating a fresh usage.db is a one-time startup cost, not
    // part of a scan; keep it out of the measured window.
    getUsageDatabase();

    let scanSettled = false;
    let timerDuringScan = false;
    let timerDelay = Infinity;
    let maxGap = 0;
    let ticks = 0;
    let lastTick = performance.now();
    const startedAt = performance.now();

    const scan = getUsageReport({ range: "30d", granularity: "daily" }).then((report) => {
      scanSettled = true;
      return report;
    });

    // Scheduled right after the scan starts: it must run while the scan is
    // still reading, i.e. the scan never blocks this thread.
    const scheduledAt = performance.now();
    setTimeout(() => {
      timerDuringScan = !scanSettled;
      timerDelay = performance.now() - scheduledAt;
    }, 0);
    const interval = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
      ticks++;
    }, 5);

    const report = await scan;
    const elapsed = performance.now() - startedAt;
    clearInterval(interval);

    assert.equal(report.stale, false);
    assert.ok(report.scanInfo.usageRecordsCount > 0, "the fixture records were scanned");
    assert.ok(elapsed > 100, `fixture scan is long enough to matter (${elapsed.toFixed(0)} ms)`);
    assert.ok(timerDuringScan, "a 0 ms timer fired before the scan finished");
    assert.ok(timerDelay < 100, `0 ms timer fired after ${timerDelay.toFixed(1)} ms`);
    assert.ok(ticks > 0, "the interval ran during the scan");
    assert.ok(maxGap < 100, `max event-loop stall while scanning: ${maxGap.toFixed(1)} ms`);
  });
});

test("a served report is cached, then served stale while one background rescan runs", async () => {
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 1, 12 * 1024);

    const first = await getUsageReport({ range: "30d", granularity: "daily" });
    assert.equal(first.stale, false);
    const firstCount = first.scanInfo.usageRecordsCount;
    assert.ok(firstCount > 0);

    // Cached and fresh: served immediately without a rescan.
    const cached = await getUsageReport({ range: "30d", granularity: "daily" });
    assert.equal(cached.stale, false);
    assert.equal(cached.scannedAt, first.scannedAt);

    // After the refresh window, new transcript activity is not on the request
    // path: the cached report answers, marked stale, and one refresh runs.
    await sleep(USAGE_REPORT_REFRESH_MS + 100);
    const fixture = join(dir, "sessions", "project", "session-0.jsonl");
    writeFileSync(fixture, `${JSON.stringify({
      type: "message",
      id: "late",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 9999, output: 0 } },
    })}\n`, { flag: "a" });

    const stale = await getUsageReport({ range: "30d", granularity: "daily" });
    assert.equal(stale.stale, true, "the cached report is served while the rescan runs");
    assert.equal(stale.scannedAt, first.scannedAt);
    assert.equal(stale.scanInfo.usageRecordsCount, firstCount, "the stale answer is the cached one");

    // The background rescan lands and the next request reports it as current.
    let refreshed;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await sleep(50);
      const report = await getUsageReport({ range: "30d", granularity: "daily" });
      if (!report.stale && report.scanInfo.usageRecordsCount > firstCount) {
        refreshed = report;
        break;
      }
    }
    assert.ok(refreshed, "background rescan updated the cached report");
    assert.ok(refreshed.scannedAt > first.scannedAt);
  });
});

test("concurrent requests for one query share a single scan", async () => {
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 2, 16 * 1024);
    const options = { range: "30d", granularity: "daily" };

    const [a, b, c] = await Promise.all([
      getUsageReport(options),
      getUsageReport(options),
      getUsageReport(options),
    ]);

    assert.equal(a, b, "joined requests resolve the same report object");
    assert.equal(b, c);
    assert.equal(a.stale, false);
    assert.ok(a.scanInfo.usageRecordsCount > 0);
  });
});
