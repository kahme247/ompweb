import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runUsageReportInWorker, UsageWorkerError, UsageWorkerTimeoutError, UsageWorkerBusyError, getUsageWorkerPath, resolveUsageWorkerPath } from "./usage-report-worker.ts";
import { getUsageReportFromDb, getUsageDatabase, closeUsageDatabase } from "./usage-db.ts";
import { invalidateUsageCache } from "./usage-service.ts";

/**
 * Throwaway agent dir: the usage database and the session tree both live here,
 * so a test never touches the real ~/.omp/agent.
 */
async function withTempAgentDir(run) {
  const dir = join(tmpdir(), `omp-test-usage-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function writeJsonl(file, lines) {
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

/**
 * Two sessions, one with a foreground subagent (`task` summary plus its own
 * transcript) and a summarised subagent without one, and a copy of the first
 * session's entries in a later branch — the shapes the uncounted-usage pass
 * has to decide, not just plain rows.
 */
function writeReportFixtures(dir) {
  const project = join(dir, "sessions", "project");
  const artifacts = join(project, "session-a");
  mkdirSync(artifacts, { recursive: true });
  const started = Date.now() - 86_400_000;
  const header = (id, cwd, timestamp) => ({ type: "session", id, cwd, timestamp: new Date(timestamp).toISOString() });
  const assistant = (id, timestamp, provider, model, usage) => ({
    type: "message",
    id,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "assistant", provider, model, usage },
  });
  const taskResult = (id, timestamp, results) => ({
    type: "message",
    id,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "toolResult", toolName: "task", details: { results } },
  });

  writeJsonl(join(project, "session-a.jsonl"), [
    header("session-a", "/home/user/alpha", started),
    assistant("e1", started + 1_000, "anthropic", "claude-opus-5-5", { input: 1_000, output: 100, cacheRead: 500 }),
    assistant("e2", started + 2_000, "openai", "gpt-6", { input: 2_000, output: 200, reasoning: 50 }),
    taskResult("e3", started + 3_000, [
      { id: "Sub1", resolvedModel: "anthropic/claude-sonnet-5", usage: { input: 500, output: 50 } },
      { id: "Gone1", resolvedModel: "anthropic/claude-haiku-5", usage: { input: 40, output: 4 } },
    ]),
  ]);
  // The foreground subagent's own transcript precedes the summary: counted
  // there, the summary is skipped.
  writeJsonl(join(artifacts, "Sub1.jsonl"), [
    header("sub-1", "/tmp/worktree", started + 2_500),
    assistant("s1", started + 2_500, "anthropic", "claude-sonnet-5", { input: 500, output: 50 }),
  ]);
  // A branch copies the entries with their ids and timestamps; only the
  // earliest-started session counts them.
  writeJsonl(join(project, "session-b.jsonl"), [
    header("session-b", "/home/user/beta", started + 60_000),
    assistant("e1", started + 1_000, "anthropic", "claude-opus-5-5", { input: 1_000, output: 100, cacheRead: 500 }),
    assistant("e2", started + 2_000, "openai", "gpt-6", { input: 2_000, output: 200, reasoning: 50 }),
  ]);
}

/** The two reports may differ only in when they were computed. */
function comparable(report) {
  const copy = structuredClone(report);
  delete copy.stale;
  delete copy.scannedAt;
  delete copy.scanInfo.durationSeconds;
  delete copy.scanInfo.scannedAt;
  return copy;
}

test("the worker returns the same report as the in-process implementation", async () => {
  await withTempAgentDir(async (dir) => {
    writeReportFixtures(dir);
    // Explicit bounds keep both runs on one window while they read the clock.
    const options = { from: 0, to: Date.now() + 60_000, granularity: "daily" };

    const fromWorker = await runUsageReportInWorker(options);
    const inProcess = await getUsageReportFromDb(options);

    assert.ok(fromWorker.scanInfo.usageRecordsCount > 0, "the fixtures were scanned");
    assert.equal(fromWorker.stale, false);
    assert.deepEqual(comparable(fromWorker), comparable(inProcess));
  });
});

test("a report on a large database leaves the event loop responsive", async () => {
  await withTempAgentDir(async (dir) => {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const db = getUsageDatabase();
    // Rows inserted directly: the scan itself has nothing to read, so the
    // measured work is the report pass over a big table — the correlated
    // uncounted-usage statement plus the six aggregate queries. Half of the
    // rows share an entry id with a copy, which is what makes that statement
    // do real work.
    const insert = db.prepare(`
      INSERT INTO usage_records (
        file_path, session_id, session_cwd, timestamp, provider, model,
        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, cost, cache_savings, cost_quality,
        entry_id, subagent_file, session_started
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = 60_000;
    const baseTimestamp = Date.now() - 30 * 86_400_000;
    db.exec("BEGIN;");
    for (let i = 0; i < rows; i++) {
      const copy = i % 2 === 1;
      const index = Math.floor(i / 2);
      insert.run(
        copy ? join(dir, "sessions", "project", "copy.jsonl") : join(dir, "sessions", "project", "main.jsonl"),
        copy ? "session-copy" : "session-main",
        copy ? "/home/user/copy" : "/home/user/main",
        baseTimestamp + index * 1_000,
        i % 3 === 0 ? "openai" : "anthropic",
        i % 5 === 0 ? "gpt-6" : "claude-opus-5-5",
        100,
        50,
        0,
        10,
        0,
        160,
        0.001,
        0.0002,
        "model_priced",
        `entry-${index}`,
        null,
        copy ? baseTimestamp + 60_000 : baseTimestamp,
      );
    }
    db.exec("COMMIT;");

    let settled = false;
    let maxGap = 0;
    let ticks = 0;
    let lastTick = performance.now();
    const startedAt = performance.now();
    const reportPromise = runUsageReportInWorker({ from: 0, to: Date.now(), granularity: "daily" })
      .finally(() => { settled = true; });
    const interval = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
      ticks++;
    }, 5);

    const report = await reportPromise;
    const elapsed = performance.now() - startedAt;
    clearInterval(interval);

    assert.ok(settled);
    assert.ok(report.scanInfo.usageRecordsCount > 0);
    // Half of the rows are copies of the other half.
    assert.equal(report.scanInfo.usageRecordsCount, rows / 2);
    assert.ok(elapsed > 100, `the report is long enough to matter (${elapsed.toFixed(0)} ms)`);
    assert.ok(ticks > 0, "the interval ran during the report");
    assert.ok(maxGap < 100, `max event-loop stall while reporting: ${maxGap.toFixed(1)} ms`);
  });
});

test("a worker that cannot start fails with a clear error", async () => {
  await withTempAgentDir(async () => {
    const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
    process.env.OMP_WEB_USAGE_WORKER = join(tmpdir(), "omp-missing-usage-worker.ts");
    try {
      await assert.rejects(
        runUsageReportInWorker({}),
        (error) => error instanceof UsageWorkerError && /usage report worker/i.test(error.message),
      );
    } finally {
      if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
      else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    }
  });
});

/** Write a throwaway worker module and point OMP_WEB_USAGE_WORKER at it. */
function withWorkerScript(source, run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-usage-worker-script-"));
  const file = join(dir, "worker.mjs");
  writeFileSync(file, source, "utf8");
  const previous = process.env.OMP_WEB_USAGE_WORKER;
  process.env.OMP_WEB_USAGE_WORKER = file;
  return Promise.resolve(run(file)).finally(() => {
    if (previous === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("a hung scan is terminated and reported as usage_timeout", { timeout: 10_000 }, async (t) => {
  const previousTimeout = process.env.OMP_WEB_USAGE_TIMEOUT_MS;
  process.env.OMP_WEB_USAGE_TIMEOUT_MS = "80";
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.OMP_WEB_USAGE_TIMEOUT_MS;
    else process.env.OMP_WEB_USAGE_TIMEOUT_MS = previousTimeout;
  });
  await withTempAgentDir(async () => {
    await withWorkerScript("setInterval(() => {}, 1000);\n", async () => {
      await assert.rejects(
        runUsageReportInWorker({}),
        (error) => error instanceof UsageWorkerTimeoutError && error.code === "usage_timeout",
      );
    });
  });
});

test("a third waiting scan is refused with usage_busy instead of joining an unbounded queue", { timeout: 10_000 }, async () => {
  await withTempAgentDir(async () => {
    await withWorkerScript(
      "import { parentPort } from \"node:worker_threads\";\nsetTimeout(() => parentPort.postMessage({ ok: true, report: { scannedAt: 1 } }), 120);\n",
      async () => {
        const first = runUsageReportInWorker({ range: "7d" });
        const second = runUsageReportInWorker({ range: "30d" });
        const third = runUsageReportInWorker({ range: "90d" });
        await assert.rejects(
          runUsageReportInWorker({ range: "month" }),
          (error) => error instanceof UsageWorkerBusyError && error.code === "usage_busy",
        );
        await Promise.all([first, second, third]);
      },
    );
  });
});

test("the worker path never comes from the process cwd", async (t) => {
  const hostile = mkdtempSync(join(tmpdir(), "omp-usage-hostile-cwd-"));
  mkdirSync(join(hostile, "lib"), { recursive: true });
  writeFileSync(join(hostile, "lib", "usage-worker.ts"), "throw new Error('hostile cwd worker');\n");
  const previousCwd = process.cwd();
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
  delete process.env.OMP_WEB_PACKAGE_DIR;
  delete process.env.OMP_WEB_USAGE_WORKER;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
    if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    rmSync(hostile, { recursive: true, force: true });
  });
  process.chdir(hostile);
  const resolved = getUsageWorkerPath();
  assert.notEqual(resolved, join(hostile, "lib", "usage-worker.ts"), "cwd must never choose the executed code");
  assert.ok(existsSync(resolved), `the module-relative worker exists (${resolved})`);
});

test("OMP_WEB_PACKAGE_DIR wins over the module-relative path", async (t) => {
  const fakePackage = mkdtempSync(join(tmpdir(), "omp-usage-package-"));
  mkdirSync(join(fakePackage, "lib"), { recursive: true });
  const worker = join(fakePackage, "lib", "usage-worker.ts");
  writeFileSync(worker, "// package worker\n");
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
  delete process.env.OMP_WEB_USAGE_WORKER;
  process.env.OMP_WEB_PACKAGE_DIR = fakePackage;
  t.after(() => {
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
    if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    rmSync(fakePackage, { recursive: true, force: true });
  });
  assert.equal(getUsageWorkerPath(), worker);
});

test("a package dir without the worker is skipped, never used as a directory guess", async (t) => {
  const emptyPackage = mkdtempSync(join(tmpdir(), "omp-usage-empty-package-"));
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
  delete process.env.OMP_WEB_USAGE_WORKER;
  process.env.OMP_WEB_PACKAGE_DIR = emptyPackage;
  t.after(() => {
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
    if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    rmSync(emptyPackage, { recursive: true, force: true });
  });
  const resolved = getUsageWorkerPath();
  assert.equal(resolved.startsWith(emptyPackage), false, "an incomplete package dir is not trusted");
  assert.ok(existsSync(resolved), `the module-relative path still finds the shipped worker (${resolved})`);
});

test("the worker never inherits the server's credentials", { timeout: 10_000 }, async () => {
  // The worker executes a file path with the server's privileges. It needs the
  // agent dir and OS plumbing, nothing else — above all not the password hash
  // or the STT key (`lib/project-command-env.ts` states the same rule for
  // child processes).
  const secrets = {
    OMP_WEB_PASSWORD_HASH: "hash",
    OMP_WEB_STT_KEY: "stt",
    OMP_WEB_TRUSTED_HEADER_SHA256: "trusted",
    OMP_WEB_PASSWORD: "plain",
  };
  const previous = Object.fromEntries(Object.keys(secrets).map((key) => [key, process.env[key]]));
  Object.assign(process.env, secrets);
  try {
    await withTempAgentDir(async (dir) => {
      await withWorkerScript(
        "import { parentPort } from \"node:worker_threads\";\n"
          + "parentPort.postMessage({ ok: true, report: { env: Object.keys(process.env), agentDir: process.env.PI_CODING_AGENT_DIR ?? null } });\n",
        async () => {
          const report = await runUsageReportInWorker({});
          const env = report.env;
          for (const name of Object.keys(secrets)) assert.equal(env.includes(name), false, `${name} must not reach the worker`);
          assert.equal(report.agentDir, dir, "the parent's resolved agent dir is pinned");
          assert.ok(env.includes("PATH"), "the OS plumbing a thread needs is kept");
        },
      );
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a relative OMP_WEB_USAGE_WORKER is ignored, never resolved against the cwd", async (t) => {
  const hostile = mkdtempSync(join(tmpdir(), "omp-usage-relative-worker-"));
  writeFileSync(join(hostile, "worker.mjs"), "throw new Error('relative override ran');\n");
  const previousCwd = process.cwd();
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
  delete process.env.OMP_WEB_PACKAGE_DIR;
  process.env.OMP_WEB_USAGE_WORKER = "worker.mjs";
  t.after(() => {
    process.chdir(previousCwd);
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
    if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    rmSync(hostile, { recursive: true, force: true });
  });
  process.chdir(hostile);
  const resolved = getUsageWorkerPath();
  assert.equal(resolved.startsWith(hostile), false, "a relative override must never pick the cwd's file");
  assert.ok(existsSync(resolved), `the module-relative worker is used (${resolved})`);
});

test("a missing worker rejects with a clear logged error instead of spawning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-usage-missing-worker-"));
  const missing = join(dir, "missing-worker.ts");
  const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
  const previousError = console.error;
  const logged = [];
  process.env.OMP_WEB_USAGE_WORKER = missing;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await assert.rejects(
      runUsageReportInWorker({ range: "7d" }),
      (error) => error instanceof UsageWorkerError && error.code === "usage_worker_failed" && error.message.includes(missing),
    );
  } finally {
    console.error = previousError;
    if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(logged.some((line) => line.startsWith("[usage]") && line.includes(missing)), "the resolved path is logged");
});

test("a release layout resolves the bundled worker beside the executable", async (t) => {
  const release = mkdtempSync(join(tmpdir(), "omp-usage-release-"));
  mkdirSync(join(release, "lib"), { recursive: true });
  // What scripts/build-binary.ts writes: one bundled file, no TypeScript.
  const bundled = join(release, "lib", "usage-worker.mjs");
  writeFileSync(bundled, "// bundled worker\n");
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
  delete process.env.OMP_WEB_USAGE_WORKER;
  process.env.OMP_WEB_PACKAGE_DIR = release;
  t.after(() => {
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
    if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    rmSync(release, { recursive: true, force: true });
  });
  // The binary sets OMP_WEB_PACKAGE_DIR to its own directory, so this is the
  // path a release actually takes; the bundle wins over any .ts.
  assert.equal(getUsageWorkerPath(), bundled);
  writeFileSync(join(release, "lib", "usage-worker.ts"), "// source\n");
  assert.equal(getUsageWorkerPath(), bundled, "the release bundle is preferred over source");
});

test("a checkout without a bundle runs the TypeScript worker", async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "omp-usage-checkout-"));
  mkdirSync(join(checkout, "lib"), { recursive: true });
  const source = join(checkout, "lib", "usage-worker.ts");
  writeFileSync(source, "// source worker\n");
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  const previousWorker = process.env.OMP_WEB_USAGE_WORKER;
  delete process.env.OMP_WEB_USAGE_WORKER;
  process.env.OMP_WEB_PACKAGE_DIR = checkout;
  t.after(() => {
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
    if (previousWorker === undefined) delete process.env.OMP_WEB_USAGE_WORKER;
    else process.env.OMP_WEB_USAGE_WORKER = previousWorker;
    rmSync(checkout, { recursive: true, force: true });
  });
  assert.equal(getUsageWorkerPath(), source);
});

test("a compiled binary reads the worker from its own directory, never from the embedded filesystem", (t) => {
  // The layout scripts/build-binary.ts produces: ompweb.exe and lib/usage-worker.mjs.
  const release = mkdtempSync(join(tmpdir(), "omp-usage-compiled-"));
  mkdirSync(join(release, "lib"), { recursive: true });
  const bundled = join(release, "lib", "usage-worker.mjs");
  writeFileSync(bundled, "// bundled worker\n");
  t.after(() => rmSync(release, { recursive: true, force: true }));

  // Bun mounts the binary's modules under a virtual prefix; nothing there can
  // be started as a worker.
  for (const moduleDir of ["B:\\~BUN\\root\\", "/$bunfs/root/"]) {
    assert.equal(
      resolveUsageWorkerPath({ moduleDir, execDir: release }),
      bundled,
      `${moduleDir} must fall back to the executable's own directory`,
    );
  }
  // Without the bundle the resolver names the path the error message reports,
  // instead of handing the virtual path to `new Worker`.
  const empty = mkdtempSync(join(tmpdir(), "omp-usage-compiled-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const resolved = resolveUsageWorkerPath({ moduleDir: "B:\\~BUN\\root\\", execDir: empty });
  assert.equal(resolved, join(empty, "lib", "usage-worker.mjs"));
  assert.equal(existsSync(resolved), false);
});

test("a release package dir wins, and a relative override is refused, in the resolver itself", (t) => {
  const release = mkdtempSync(join(tmpdir(), "omp-usage-resolver-"));
  mkdirSync(join(release, "lib"), { recursive: true });
  const bundled = join(release, "lib", "usage-worker.mjs");
  writeFileSync(bundled, "// bundled worker\n");
  t.after(() => rmSync(release, { recursive: true, force: true }));

  // The binary sets OMP_WEB_PACKAGE_DIR to its own directory; that is the path
  // a release takes, and the bundle wins over a stray .ts beside it.
  assert.equal(resolveUsageWorkerPath({ packageDir: release, moduleDir: "B:\\~BUN\\root\\", execDir: release }), bundled);
  writeFileSync(join(release, "lib", "usage-worker.ts"), "// source\n");
  assert.equal(resolveUsageWorkerPath({ packageDir: release, moduleDir: "B:\\~BUN\\root\\", execDir: release }), bundled);

  // A relative override never resolves against a cwd: the embedded module dir
  // is still not a code source, so the executable's directory answers.
  assert.equal(
    resolveUsageWorkerPath({ override: "worker.mjs", moduleDir: "B:\\~BUN\\root\\", execDir: release }),
    bundled,
  );
});

test("an absolute OMP_WEB_USAGE_WORKER wins over the packaged worker in every layout", (t) => {
  // The two layouts a packaged server really runs in: a release directory with
  // the bundled worker, and a checkout with the TypeScript one.
  const release = mkdtempSync(join(tmpdir(), "omp-usage-override-release-"));
  mkdirSync(join(release, "lib"), { recursive: true });
  const bundled = join(release, "lib", "usage-worker.mjs");
  writeFileSync(bundled, "// bundled worker\n");
  const checkout = mkdtempSync(join(tmpdir(), "omp-usage-override-checkout-"));
  mkdirSync(join(checkout, "lib"), { recursive: true });
  const source = join(checkout, "lib", "usage-worker.ts");
  writeFileSync(source, "// source worker\n");
  const custom = join(release, "custom-worker.mjs");
  writeFileSync(custom, "// custom worker\n");
  t.after(() => {
    rmSync(release, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  });

  // The compiled binary sets OMP_WEB_PACKAGE_DIR to a directory holding the
  // bundle; the npm launcher sets it to the checkout with the TypeScript
  // worker. The override is documented as the escape hatch for both, and a
  // packaged worker that won there made the variable dead exactly where a
  // release user reaches for it.
  assert.equal(
    resolveUsageWorkerPath({ packageDir: release, override: custom, moduleDir: release, execDir: release }),
    custom,
    "the override must beat the packaged bundle",
  );
  assert.equal(
    resolveUsageWorkerPath({ packageDir: checkout, override: custom, moduleDir: checkout, execDir: checkout }),
    custom,
    "the override must beat the packaged TypeScript worker",
  );
  assert.equal(
    resolveUsageWorkerPath({ packageDir: release, override: custom, moduleDir: "B:\\~BUN\\root\\", execDir: release }),
    custom,
    "the override must beat the binary's own bundle",
  );

  // An override that does not exist is still the answer: the resolver reports
  // the path the worker error names instead of silently falling back.
  const missing = join(release, "not-there.mjs");
  assert.equal(resolveUsageWorkerPath({ packageDir: release, override: missing, moduleDir: release, execDir: release }), missing);

  // A relative value is not an override at all: it is ignored, and the
  // packaged worker answers as if the variable were unset.
  assert.equal(
    resolveUsageWorkerPath({ packageDir: release, override: "custom-worker.mjs", moduleDir: release, execDir: release }),
    bundled,
  );
});
