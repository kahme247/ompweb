import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./recent-runs.ts");
}

test("recordCompletedRun prepends newest entry and preserves timestamp", async () => {
  const { recordCompletedRun } = await loadSubject();
  const initial = [];
  const timestamp = 1700000000000;
  const result = recordCompletedRun(initial, "session-1", timestamp);
  assert.deepEqual(result, [
    { sessionId: "session-1", completedAt: timestamp },
  ]);

  const timestamp2 = 1700000001000;
  const result2 = recordCompletedRun(result, "session-2", timestamp2);
  assert.deepEqual(result2, [
    { sessionId: "session-2", completedAt: timestamp2 },
    { sessionId: "session-1", completedAt: timestamp },
  ]);
});

test("recordCompletedRun deduplicates existing sessionId and moves to front", async () => {
  const { recordCompletedRun } = await loadSubject();
  const t1 = 1000;
  const t2 = 2000;
  const t3 = 3000;

  let runs = recordCompletedRun([], "session-1", t1);
  runs = recordCompletedRun(runs, "session-2", t2);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].sessionId, "session-2");

  runs = recordCompletedRun(runs, "session-1", t3);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs, [
    { sessionId: "session-1", completedAt: t3 },
    { sessionId: "session-2", completedAt: t2 },
  ]);
});

test("recordCompletedRun enforces max capacity of 10 items (overflow drops oldest)", async () => {
  const { recordCompletedRun, MAX_RECENT_COMPLETED_RUNS } = await loadSubject();
  assert.equal(MAX_RECENT_COMPLETED_RUNS, 10);

  let runs = [];
  for (let i = 1; i <= 15; i++) {
    runs = recordCompletedRun(runs, `session-${i}`, i * 1000);
  }

  assert.equal(runs.length, 10);
  assert.equal(runs[0].sessionId, "session-15");
  assert.equal(runs[0].completedAt, 15000);
  assert.equal(runs[9].sessionId, "session-6");
  assert.equal(runs[9].completedAt, 6000);

  const ids = runs.map((e) => e.sessionId);
  for (let i = 1; i <= 5; i++) {
    assert.ok(!ids.includes(`session-${i}`));
  }
});

test("removeActiveFromCompleted removes any re-running session IDs", async () => {
  const { removeActiveFromCompleted } = await loadSubject();
  const runs = [
    { sessionId: "session-1", completedAt: 1000 },
    { sessionId: "session-2", completedAt: 2000 },
    { sessionId: "session-3", completedAt: 3000 },
  ];

  const activeRunning = new Set(["session-2"]);
  const filtered = removeActiveFromCompleted(runs, activeRunning);

  assert.deepEqual(filtered, [
    { sessionId: "session-1", completedAt: 1000 },
    { sessionId: "session-3", completedAt: 3000 },
  ]);

  const allActive = new Set(["session-1", "session-3"]);
  const empty = removeActiveFromCompleted(filtered, allActive);
  assert.deepEqual(empty, []);
});

test("extractRecentCompletedSet and isRecentlyCompleted", async () => {
  const { extractRecentCompletedSet, isRecentlyCompleted } = await loadSubject();
  const runs = [
    { sessionId: "session-1", completedAt: 1000 },
    { sessionId: "session-2", completedAt: 2000 },
  ];

  const idSet = extractRecentCompletedSet(runs);
  assert.ok(idSet instanceof Set);
  assert.equal(idSet.size, 2);
  assert.ok(idSet.has("session-1"));
  assert.ok(idSet.has("session-2"));
  assert.ok(!idSet.has("session-3"));

  assert.equal(isRecentlyCompleted(runs, "session-1"), true);
  assert.equal(isRecentlyCompleted(runs, "session-2"), true);
  assert.equal(isRecentlyCompleted(runs, "session-3"), false);
});
