import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./usage-service.ts");
}

async function withTempSessionDir(run) {
  const dir = join(tmpdir(), `omp-test-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;

  const { closeUsageDatabase } = await import("./usage-db.ts");

  try {
    await run(dir);
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

test("parseSessionUsage extracts assistant message usage with rate resolution", async () => {
  const { parseSessionUsage } = await loadSubject();

  withTempSessionDir((dir) => {
    const sessionFile = join(dir, "session-1.jsonl");
    const now = Date.now();

    const lines = [
      JSON.stringify({ type: "session", id: "sess-1", cwd: "/test/project-a", timestamp: new Date(now).toISOString() }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: new Date(now - 1000).toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-3-7-sonnet",
          usage: {
            input: 10000,
            output: 2000,
            cacheRead: 5000,
            cacheWrite: 1000,
            reasoning: 500,
          },
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: new Date(now).toISOString(),
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-4o",
          usage: {
            input: 4000,
            output: 1000,
            cacheRead: 2000,
            cacheWrite: 0,
          },
        },
      }),
    ];

    writeFileSync(sessionFile, lines.join("\n"), "utf8");

    const records = parseSessionUsage(sessionFile);
    assert.equal(records.length, 2);

    // Record 1: Anthropic Claude 3.7 Sonnet
    const r1 = records[0];
    assert.equal(r1.sessionId, "sess-1");
    assert.equal(r1.sessionCwd, "/test/project-a");
    assert.equal(r1.provider, "anthropic");
    assert.equal(r1.model, "claude-3-7-sonnet");
    assert.equal(r1.input, 10000);
    assert.equal(r1.output, 2000);
    assert.equal(r1.cacheRead, 5000);
    assert.equal(r1.cacheWrite, 1000);
    assert.equal(r1.reasoning, 500);
    assert.equal(r1.totalTokens, 18000);
    assert.equal(r1.costQuality, "model_priced");
    assert.ok(r1.cost > 0);
    assert.ok(r1.cacheSavings > 0);

    // Record 2: OpenAI GPT-4o
    const r2 = records[1];
    assert.equal(r2.provider, "openai");
    assert.equal(r2.model, "gpt-4o");
    assert.equal(r2.input, 4000);
    assert.equal(r2.output, 1000);
    assert.equal(r2.totalTokens, 7000);
    assert.ok(r2.cost > 0);
  });
});

test("parseSessionUsage extracts subagent task usage results", async () => {
  const { parseSessionUsage } = await loadSubject();

  withTempSessionDir((dir) => {
    const sessionFile = join(dir, "session-task.jsonl");
    const now = Date.now();

    const lines = [
      JSON.stringify({ type: "session", id: "sess-task", cwd: "/test/repo", timestamp: new Date(now).toISOString() }),
      JSON.stringify({
        type: "message",
        id: "msg-tool",
        parentId: null,
        message: {
          role: "toolResult",
          toolName: "task",
          details: {
            results: [
              {
                agent: "scout",
                resolvedModel: "google/gemini-2.5-flash",
                usage: {
                  input: 8000,
                  output: 500,
                  cacheRead: 4000,
                  cacheWrite: 0,
                },
              },
            ],
          },
        },
      }),
    ];

    writeFileSync(sessionFile, lines.join("\n"), "utf8");

    const records = parseSessionUsage(sessionFile);
    assert.equal(records.length, 1);
    assert.equal(records[0].provider, "google");
    assert.equal(records[0].model, "google/gemini-2.5-flash");
    assert.equal(records[0].input, 8000);
    assert.equal(records[0].output, 500);
    assert.equal(records[0].cacheRead, 4000);
  });
});

test("getUsageReport generates complete aggregated report across sessions", async () => {
  const { getUsageReport } = await loadSubject();

  withTempSessionDir(async (dir) => {
    const sessionsDir = join(dir, "sessions", "test-project");
    mkdirSync(sessionsDir, { recursive: true });

    const now = Date.now();
    const session1 = join(sessionsDir, "session-a.jsonl");
    const session2 = join(sessionsDir, "session-b.jsonl");

    writeFileSync(
      session1,
      [
        JSON.stringify({ type: "session", id: "sess-a", cwd: "/home/user/project-alpha", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-3-7-sonnet",
            usage: { input: 20000, output: 4000, cacheRead: 10000, cacheWrite: 0, reasoning: 1000 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      session2,
      [
        JSON.stringify({ type: "session", id: "sess-b", cwd: "/home/user/project-beta", timestamp: new Date(now).toISOString() }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 10000, output: 2000, cacheRead: 0, cacheWrite: 0 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const report = await getUsageReport({ range: "30d", forceRefresh: true });

    assert.equal(report.timeRange, "30d");
    assert.equal(report.granularity, "daily");

    // Summary checks
    assert.ok(report.summary.totalCost > 0);
    assert.equal(report.summary.inputTokens, 30000);
    assert.equal(report.summary.outputTokens, 6000);
    assert.equal(report.summary.cacheReadTokens, 10000);
    assert.equal(report.summary.reasoningTokens, 1000);
    assert.equal(report.summary.totalTokens, 46000);
    assert.ok(report.summary.activeDays >= 1);
    assert.ok(report.summary.cachePercentage > 0);

    // Providers checks
    assert.equal(report.providers.length, 2);
    const anthropicProvider = report.providers.find((p) => p.provider === "anthropic");
    const openaiProvider = report.providers.find((p) => p.provider === "openai");
    assert.ok(anthropicProvider);
    assert.ok(openaiProvider);
    assert.equal(anthropicProvider.name, "Anthropic");
    assert.equal(openaiProvider.name, "OpenAI");

    // Model breakdown checks
    assert.equal(report.modelBreakdown.length, 2);
    assert.ok(report.modelBreakdown.some((m) => m.model === "claude-3-7-sonnet"));
    assert.ok(report.modelBreakdown.some((m) => m.model === "gpt-4o"));

    // Project breakdown checks
    assert.equal(report.projectBreakdown.length, 2);
    assert.ok(report.projectBreakdown.some((p) => p.projectName === "project-alpha"));
    assert.ok(report.projectBreakdown.some((p) => p.projectName === "project-beta"));

    // Time series checks: continuous buckets
    assert.ok(report.timeSeries.length >= 1);
    const lastPoint = report.timeSeries[report.timeSeries.length - 1];
    assert.ok(lastPoint.date);
    assert.ok(lastPoint.label);

    // Scan info
    assert.equal(report.scanInfo.transcriptsScanned, 2);
    assert.equal(report.scanInfo.usageRecordsCount, 2);
    assert.ok(report.scanInfo.durationSeconds >= 0);
  });
});

// Transcript line helpers for the artifact-transcript tests.
const sessionHeader = (id, cwd, at = Date.now()) => JSON.stringify({ type: "session", id, cwd, timestamp: new Date(at).toISOString() });
const assistantEntry = (id, at, model, input, cost = 0) => JSON.stringify({
  type: "message",
  id,
  timestamp: new Date(at).toISOString(),
  message: { role: "assistant", provider: "anthropic", model, usage: { input, output: 0, cost: { total: cost } } },
});
const taskResultEntry = (id, at, results) => JSON.stringify({
  type: "message",
  id,
  timestamp: new Date(at).toISOString(),
  message: { role: "toolResult", toolName: "task", details: { results } },
});

test("getUsageReport counts every helper transcript once, under the session that owns it", async () => {
  const { getUsageReport } = await loadSubject();

  await withTempSessionDir(async (dir) => {
    const project = join(dir, "sessions", "test-project");
    const artifacts = join(project, "2026_parent");
    const t = Date.now() - 60_000;
    mkdirSync(join(artifacts, "Bg1"), { recursive: true });
    mkdirSync(join(artifacts, "SubAgent"), { recursive: true });
    mkdirSync(join(artifacts, "local"), { recursive: true });
    const write = (file, lines) => writeFileSync(file, lines.join("\n"), "utf8");

    write(join(project, "2026_parent.jsonl"), [
      sessionHeader("sess-parent", "/home/user/project-alpha"),
      assistantEntry("p1", t, "claude-opus-5-5", 1000),
      taskResultEntry("p2", t + 1, [
        // Foreground subagent: a summary AND its own transcript (counted once, from the transcript).
        { id: "Sync1", resolvedModel: "anthropic/claude-sonnet-5", usage: { input: 500, output: 0 } },
        // Subagent without a transcript: only the summary knows its usage.
        { id: "Gone1", resolvedModel: "anthropic/claude-sonnet-4-5", usage: { input: 40, output: 0 } },
      ]),
    ]);
    // Subagents run in isolated worktrees and helpers carry their own headers; all of it is project-alpha's.
    // A subagent's turns precede the `task` result that summarizes them.
    write(join(artifacts, "Sync1.jsonl"), [sessionHeader("sub-sync", "/tmp/wt/sync"), assistantEntry("s1", t - 1, "claude-sonnet-5", 500)]);
    // Background subagent with a nested subagent in omp's real layout: `<Parent>/<Parent>.<Child>.jsonl`.
    write(join(artifacts, "Bg1.jsonl"), [
      sessionHeader("sub-bg", "/tmp/wt/bg"),
      assistantEntry("b1", t + 3, "claude-haiku-5", 300),
      taskResultEntry("b2", t + 4, [{ id: "Bg1.Nested", resolvedModel: "anthropic/claude-haiku-5", usage: { input: 70, output: 0 } }]),
    ]);
    write(join(artifacts, "Bg1", "Bg1.Nested.jsonl"), [sessionHeader("sub-nested", "/tmp/wt/nested"), assistantEntry("n1", t + 2, "claude-haiku-5", 70)]);
    write(join(artifacts, "__advisor.jsonl"), [sessionHeader("advisor", "/home/user/project-alpha"), assistantEntry("a1", t + 6, "gpt-6-astra", 20)]);
    write(join(artifacts, "__planloop.fable.jsonl"), [sessionHeader("fable", "/home/user/project-alpha"), assistantEntry("f1", t + 7, "claude-fable-5-1", 4)]);
    // A subagent's advisor whose `SubAgent.jsonl` is missing still belongs to this session.
    write(join(artifacts, "SubAgent", "__advisor.jsonl"), [sessionHeader("sub-advisor", join(artifacts, "SubAgent")), assistantEntry("x1", t + 8, "gpt-6-astra", 7)]);
    // `local://` scratch space is not a transcript folder.
    write(join(artifacts, "local", "notes.jsonl"), [sessionHeader("scratch", "/home/user/project-alpha"), assistantEntry("l1", t + 9, "claude-opus-5-5", 9999)]);
    writeFileSync(join(artifacts, "Sync1.md"), "final output, not a transcript", "utf8");

    const report = await getUsageReport({ range: "30d", forceRefresh: true });

    assert.equal(report.summary.inputTokens, 1000 + 500 + 40 + 300 + 70 + 20 + 4 + 7, "each request counted exactly once");
    assert.equal(report.projectBreakdown.length, 1);
    assert.equal(report.projectBreakdown[0].projectName, "project-alpha");
    assert.equal(report.projectBreakdown[0].sessionsCount, 1, "helper transcripts are not separate sessions");
    assert.equal(report.scanInfo.transcriptsScanned, 7, "local/ is not scanned");
  });
});

test("getUsageReport counts history copied by /tan, /fork and branches once, and keeps it when the original is deleted", async () => {
  const { getUsageReport } = await loadSubject();

  await withTempSessionDir(async (dir) => {
    const project = join(dir, "sessions", "test-project");
    const original = join(project, "2026-01_original.jsonl");
    const originalArtifacts = join(project, "2026-01_original");
    const branch = join(project, "2026-02_branch.jsonl");
    const fork = join(project, "2026-03_fork.jsonl");
    const forkArtifacts = join(project, "2026-03_fork");
    mkdirSync(originalArtifacts, { recursive: true });
    mkdirSync(forkArtifacts, { recursive: true });
    const t = Date.now() - 60_000;
    const write = (file, lines) => writeFileSync(file, lines.join("\n"), "utf8");
    // Main-agent history, plus a foreground subagent's `task` summary whose transcript is Sub.jsonl.
    const history = [
      assistantEntry("e1", t, "claude-opus-5-5", 1000, 0.5),
      assistantEntry("e2", t + 1, "claude-opus-5-5", 2000, 1),
      taskResultEntry("r1", t + 2, [{ id: "Sub", resolvedModel: "anthropic/claude-sonnet-5", usage: { input: 300, output: 0, cost: { total: 0.3 } } }]),
    ];
    const subagent = [sessionHeader("sub", "/tmp/wt"), assistantEntry("s1", t + 2, "claude-sonnet-5", 300, 0.3)];

    write(original, [sessionHeader("sess-original", "/home/user/project-alpha", t - 3000), ...history]);
    write(join(originalArtifacts, "Sub.jsonl"), subagent);
    // /tan clones the parent's history into its artifacts dir (assistant cost zeroed, task summaries
    // kept as they are), then does its own work.
    write(join(originalArtifacts, "Tan-1.jsonl"), [
      sessionHeader("tan", "/home/user/project-alpha"),
      assistantEntry("e1", t, "claude-opus-5-5", 1000, 0),
      assistantEntry("e2", t + 1, "claude-opus-5-5", 2000, 0),
      history[2],
      assistantEntry("t1", t + 3, "claude-opus-5-5", 50, 0.05),
    ]);
    // A branch (omp-web's fork action) copies the history into a new session without the artifacts.
    write(branch, [sessionHeader("sess-branch", "/home/user/project-alpha", t - 2000), ...history]);
    // /fork copies the history into a new session and copies the artifacts folder with it.
    write(fork, [sessionHeader("sess-fork", "/home/user/project-alpha", t - 1000), ...history, assistantEntry("k1", t + 4, "claude-opus-5-5", 70, 0.07)]);
    write(join(forkArtifacts, "Sub.jsonl"), subagent);

    const report = await getUsageReport({ range: "30d", forceRefresh: true });
    assert.equal(report.summary.inputTokens, 1000 + 2000 + 300 + 50 + 70);
    assert.equal(report.summary.totalCost.toFixed(2), (0.5 + 1 + 0.3 + 0.05 + 0.07).toFixed(2), "copies are not re-priced");

    // Deleting the original (omp removes the file and its artifacts) leaves the copies to count:
    // the history once, and the subagent once, from the transcript the fork kept.
    rmSync(original);
    rmSync(originalArtifacts, { recursive: true, force: true });
    const afterDelete = await getUsageReport({ range: "30d" });
    assert.equal(afterDelete.summary.inputTokens, 1000 + 2000 + 300 + 70);
    assert.equal(afterDelete.projectBreakdown[0].sessionsCount, 2);
  });
});

test("copied history stays with the session it came from when the copy lives in another project folder", async () => {
  const { getUsageReport } = await loadSubject();

  await withTempSessionDir(async (dir) => {
    // `omp --fork` writes the copy into the launch directory's folder, which may sort before the original's.
    const zeta = join(dir, "sessions", "--work-zeta--");
    const alpha = join(dir, "sessions", "--work-alpha--");
    mkdirSync(zeta, { recursive: true });
    mkdirSync(alpha, { recursive: true });
    const t = Date.now() - 60_000;
    const history = [assistantEntry("e1", t, "claude-opus-5-5", 1000), assistantEntry("e2", t + 1, "claude-opus-5-5", 2000)];
    writeFileSync(join(zeta, "2026-01_original.jsonl"), [sessionHeader("original", "/work/zeta", t - 2000), ...history].join("\n"), "utf8");
    writeFileSync(
      join(alpha, "2026-02_fork.jsonl"),
      [sessionHeader("fork", "/work/alpha", t - 1000), ...history, assistantEntry("k1", t + 2, "claude-opus-5-5", 7)].join("\n"),
      "utf8",
    );

    const report = await getUsageReport({ range: "30d", forceRefresh: true });
    assert.deepEqual(Object.fromEntries(report.projectBreakdown.map((p) => [p.projectName, p.tokens])), { zeta: 3000, alpha: 7 });
  });
});

test("a later subagent that reuses an id does not hide an inherited task summary", async () => {
  const { getUsageReport } = await loadSubject();

  await withTempSessionDir(async (dir) => {
    // A branch keeps the parent's `task` summary for `Reviewer` but not its transcript (the
    // parent is gone), then runs a new subagent that is also named `Reviewer`.
    const project = join(dir, "sessions", "test-project");
    mkdirSync(join(project, "2026_branch"), { recursive: true });
    const t = Date.now() - 60_000;
    writeFileSync(join(project, "2026_branch.jsonl"), [
      sessionHeader("branch", "/home/user/project-alpha", t - 1000),
      taskResultEntry("r1", t, [{ id: "Reviewer", resolvedModel: "anthropic/claude-sonnet-5", usage: { input: 300, output: 0 } }]),
    ].join("\n"), "utf8");
    writeFileSync(
      join(project, "2026_branch", "Reviewer.jsonl"),
      [sessionHeader("reviewer-2", "/tmp/wt"), assistantEntry("v1", t + 5000, "claude-sonnet-5", 50)].join("\n"),
      "utf8",
    );

    const report = await getUsageReport({ range: "30d", forceRefresh: true });
    assert.equal(report.summary.inputTokens, 300 + 50);
  });
});

test("time range bounds compute valid intervals", async () => {
  const { computeTimeRangeBounds } = await loadSubject();

  const now = 1756700000000;
  const t7d = computeTimeRangeBounds("7d", now);
  assert.equal(t7d.endMs, now);
  assert.equal(t7d.startMs, now - 7 * 86400 * 1000);

  const tAll = computeTimeRangeBounds("all", now);
  assert.equal(tAll.startMs, 0);
  assert.equal(tAll.endMs, now);
});

test("getUsageReport respects explicit from=0 timestamp without falling back to 30d", async () => {
  const { getUsageReport } = await loadSubject();

  withTempSessionDir(async (dir) => {
    const sessionsDir = join(dir, "sessions", "test-project");
    mkdirSync(sessionsDir, { recursive: true });

    // An old session 100 days ago
    const oldTimestamp = Date.now() - 100 * 86400 * 1000;
    const sessionFile = join(sessionsDir, "old-session.jsonl");

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "sess-old", cwd: "/test/old", timestamp: new Date(oldTimestamp).toISOString() }),
        JSON.stringify({
          type: "message",
          timestamp: new Date(oldTimestamp).toISOString(),
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-4o",
            usage: { input: 5000, output: 1000 },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    // Querying with from: 0 explicitly must find the 100-day old record
    const report = await getUsageReport({ from: 0, to: Date.now(), forceRefresh: true });
    assert.equal(report.summary.inputTokens, 5000);
    assert.equal(report.scanInfo.usageRecordsCount, 1);
  });
});

test("usage cache evicts oldest entries when exceeding MAX_USAGE_CACHE_ENTRIES", async () => {
  const { parseSessionUsage, MAX_USAGE_CACHE_ENTRIES } = await loadSubject();

  withTempSessionDir((dir) => {
    // Create 10 dummy session files
    for (let i = 0; i < 10; i++) {
      const f = join(dir, `s-${i}.jsonl`);
      writeFileSync(f, JSON.stringify({ type: "session", id: `s-${i}`, cwd: "/p" }), "utf8");
      parseSessionUsage(f);
    }
    assert.ok(MAX_USAGE_CACHE_ENTRIES > 0);
  });
});
