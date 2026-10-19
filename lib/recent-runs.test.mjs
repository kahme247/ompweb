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

test("saveRecentRuns and loadRecentRuns round-trip via mock storage", async () => {
  const { saveRecentRuns, loadRecentRuns, RECENT_RUNS_STORAGE_KEY } = await loadSubject();
  const store = new Map();
  const mockStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
  };

  const runs = [
    { sessionId: "s1", completedAt: 100 },
    { sessionId: "s2", completedAt: 200 },
  ];
  saveRecentRuns(runs, mockStorage);
  assert.equal(store.has(RECENT_RUNS_STORAGE_KEY), true);

  const loaded = loadRecentRuns(mockStorage);
  assert.deepEqual(loaded, runs);
});

test("seedRecentRuns picks up to limit most recently modified sessions with messages", async () => {
  const { seedRecentRuns } = await loadSubject();
  const sessions = [
    { id: "s1", modified: "2026-10-18T10:00:00Z", messageCount: 5 },
    { id: "s2", modified: "2026-10-19T12:00:00Z", messageCount: 1 },
    { id: "s3", modified: "2026-10-19T15:00:00Z", messageCount: 0 }, // no messages
    { id: "s4", modified: "2026-10-17T08:00:00Z", messageCount: 10 },
  ];
  const seeded = seedRecentRuns(sessions, 2);
  assert.equal(seeded.length, 2);
  assert.equal(seeded[0].sessionId, "s2"); // newest with messageCount > 0
  assert.equal(seeded[1].sessionId, "s1");
});

test("recordCompletedRun respects dynamic maxLimit (15, 20, and custom 35)", async () => {
  const { recordCompletedRun } = await loadSubject();

  // Test limit 15
  let runs15 = [];
  for (let i = 1; i <= 20; i++) {
    runs15 = recordCompletedRun(runs15, `s-${i}`, i * 1000, 15);
  }
  assert.equal(runs15.length, 15);
  assert.equal(runs15[0].sessionId, "s-20");
  assert.equal(runs15[14].sessionId, "s-6");

  // Test limit 20
  let runs20 = [];
  for (let i = 1; i <= 25; i++) {
    runs20 = recordCompletedRun(runs20, `s-${i}`, i * 1000, 20);
  }
  assert.equal(runs20.length, 20);
  assert.equal(runs20[0].sessionId, "s-25");
  assert.equal(runs20[19].sessionId, "s-6");

  // Test custom limit 35
  let runs35 = [];
  for (let i = 1; i <= 50; i++) {
    runs35 = recordCompletedRun(runs35, `s-${i}`, i * 1000, 35);
  }
  assert.equal(runs35.length, 35);
  assert.equal(runs35[0].sessionId, "s-50");
  assert.equal(runs35[34].sessionId, "s-16");
});

test("saveRecentRuns and loadRecentRuns handle dynamic capacities (15, 20, and custom 35)", async () => {
  const { saveRecentRuns, loadRecentRuns } = await loadSubject();
  const store = new Map();
  const mockStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, val) => store.set(key, val),
  };

  const generateEntries = (count) =>
    Array.from({ length: count }, (_, i) => ({
      sessionId: `item-${i + 1}`,
      completedAt: (i + 1) * 1000,
    }));

  // Capacity 15
  saveRecentRuns(generateEntries(25), mockStorage, 15);
  let loaded = loadRecentRuns(mockStorage, 15);
  assert.equal(loaded.length, 15);

  // Capacity 20
  saveRecentRuns(generateEntries(30), mockStorage, 20);
  loaded = loadRecentRuns(mockStorage, 20);
  assert.equal(loaded.length, 20);

  // Capacity 35
  saveRecentRuns(generateEntries(50), mockStorage, 35);
  loaded = loadRecentRuns(mockStorage, 35);
  assert.equal(loaded.length, 35);
  assert.equal(loaded[0].sessionId, "item-1");
  assert.equal(loaded[34].sessionId, "item-35");
});

test("seedRecentRuns handles dynamic limits up to 35", async () => {
  const { seedRecentRuns } = await loadSubject();
  const sessions = Array.from({ length: 40 }, (_, i) => ({
    id: `sess-${i + 1}`,
    modified: new Date(1700000000000 + (i + 1) * 60000).toISOString(),
    messageCount: 2,
  }));

  const seeded15 = seedRecentRuns(sessions, 15);
  assert.equal(seeded15.length, 15);

  const seeded20 = seedRecentRuns(sessions, 20);
  assert.equal(seeded20.length, 20);

  const seeded35 = seedRecentRuns(sessions, 35);
  assert.equal(seeded35.length, 35);
  assert.equal(seeded35[0].sessionId, "sess-40");
  assert.equal(seeded35[34].sessionId, "sess-6");
});
