import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  getUsageReport,
  invalidateUsageCache,
  USAGE_REPORT_REFRESH_MS,
  USAGE_STALE_MAX_AGE_MS,
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
  try {
    await run(dir);
  } finally {
    closeUsageDatabase();
    invalidateUsageCache();
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

test("an explicit refresh rescans at once instead of answering from the cache", async () => {
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 1, 12 * 1024);
    const options = { range: "30d", granularity: "daily" };

    const first = await getUsageReport(options);
    assert.equal(first.stale, false);
    const firstCount = first.scanInfo.usageRecordsCount;

    // A usage record lands right after the scan that reported it.
    writeFileSync(join(dir, "sessions", "project", "session-0.jsonl"), `${JSON.stringify({
      type: "message",
      id: "late",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 9999, output: 0 } },
    })}\n`, { flag: "a" });

    // No wait: the refresh must not be swallowed by a cooldown, and it must
    // not answer with the report the previous scan produced.
    const refreshed = await getUsageReport({ ...options, forceRefresh: true });
    assert.equal(refreshed.stale, false);
    assert.ok(refreshed.scannedAt >= first.scannedAt);
    assert.ok(
      refreshed.scanInfo.usageRecordsCount > firstCount,
      `the refresh rescanned (${refreshed.scanInfo.usageRecordsCount} records, was ${firstCount})`,
    );
    assert.equal(refreshed.summary.inputTokens, first.summary.inputTokens + 9999);
  });
});

test("a refresh joins the scan already running for its query instead of starting a second one", async () => {
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 2, 16 * 1024);
    const options = { range: "30d", granularity: "daily" };
    const starts = join(dir, "worker-starts.txt");
    const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
    // A real scan, slowed down enough that the refresh arrives while it runs,
    // and counted: a second scan would leave a second line here.
    process.env.OMP_WEB_USAGE_WORKER = join(dir, "slow-worker.mjs");
    writeFileSync(process.env.OMP_WEB_USAGE_WORKER, `
import { appendFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
appendFileSync(${JSON.stringify(starts)}, "start\\n");
setTimeout(() => parentPort.postMessage({ ok: true, report: { scannedAt: Date.now(), stale: false, summary: { inputTokens: 5 } } }), 200);
`, "utf8");
    try {
      const [plain, refresh] = await Promise.all([
        getUsageReport(options),
        getUsageReport({ ...options, forceRefresh: true }),
      ]);
      assert.equal(plain, refresh, "the refresh shares the running scan's report");
      assert.equal(refresh.summary.inputTokens, 5);
      assert.equal(readFileSync(starts, "utf8").trim(), "start", "exactly one scan ran");
    } finally {
      if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
      else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    }
  });
});

test("a report older than the stale bound is not served stale, the request waits for the rescan", async (t) => {
  const realNow = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: realNow });
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 1, 12 * 1024);
    const options = { range: "30d", granularity: "daily" };

    const first = await getUsageReport(options);
    const firstCount = first.scanInfo.usageRecordsCount;

    writeFileSync(join(dir, "sessions", "project", "session-0.jsonl"), `${JSON.stringify({
      type: "message",
      id: "late",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 4242, output: 0 } },
    })}\n`, { flag: "a" });

    // Past USAGE_STALE_MAX_AGE_MS the cached report is no longer an acceptable
    // answer: the caller gets the rescan's result, never the old numbers.
    t.mock.timers.setTime(realNow + USAGE_STALE_MAX_AGE_MS + 1_000);
    const report = await getUsageReport(options);
    assert.equal(report.stale, false, "an over-age report is never served as a stale answer");
    assert.equal(report.summary.inputTokens, first.summary.inputTokens + 4242);
    assert.ok(report.scanInfo.usageRecordsCount > firstCount);
  });
});

test("a stale answer is served only inside the stale bound, and the rescan then replaces it", async () => {
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 1, 12 * 1024);
    const options = { range: "30d", granularity: "daily" };

    const first = await getUsageReport(options);
    const firstCount = first.scanInfo.usageRecordsCount;
    await sleep(USAGE_REPORT_REFRESH_MS + 100);

    writeFileSync(join(dir, "sessions", "project", "session-0.jsonl"), `${JSON.stringify({
      type: "message",
      id: "late",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 777, output: 0 } },
    })}\n`, { flag: "a" });

    const stale = await getUsageReport(options);
    assert.equal(stale.stale, true);
    assert.equal(stale.scannedAt, first.scannedAt);

    // What the Usage UI does with a stale answer: ask again until the scan lands.
    const deadline = Date.now() + 15_000;
    let current = stale;
    while (current.stale && Date.now() < deadline) {
      await sleep(50);
      current = await getUsageReport(options);
    }
    assert.equal(current.stale, false, "the background rescan lands within the deadline");
    assert.equal(current.summary.inputTokens, first.summary.inputTokens + 777);
    assert.ok(current.scanInfo.usageRecordsCount > firstCount);
  });
});

test("a failed forced refresh keeps the last cached report as a fallback", async () => {
  await withTempUsageDir(async (dir) => {
    writeUsageFixtures(dir, 1, 12 * 1024);
    const options = { range: "30d", granularity: "daily" };

    const first = await getUsageReport(options);
    assert.equal(first.stale, false);

    // The rescan fails (a missing worker module fails the scan itself).
    const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
    process.env.OMP_WEB_USAGE_WORKER = join(dir, "missing-worker.mjs");
    try {
      await assert.rejects(getUsageReport({ ...options, forceRefresh: true }));
    } finally {
      if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
      else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    }

    // The failure must not have thrown the last good report away: a later
    // request still answers from it instead of failing again. (It is still
    // inside USAGE_REPORT_REFRESH_MS, so it is served as current.)
    const afterFailure = await getUsageReport(options);
    assert.equal(afterFailure.scannedAt, first.scannedAt, "the last successful report is still the fallback");
    assert.equal(afterFailure.summary.inputTokens, first.summary.inputTokens);
    assert.equal(afterFailure.stale, false, "a young cached report is still served as current");

    // And a successful refresh still replaces it.
    const refreshed = await getUsageReport({ ...options, forceRefresh: true });
    assert.equal(refreshed.stale, false);
    assert.ok(refreshed.scannedAt >= first.scannedAt);
  });
});
