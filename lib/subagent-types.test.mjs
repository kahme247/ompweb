import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

const {
  mergeSubagentRoster,
  parseSubagentProgress,
  parseSubagentSnapshot,
  parseSubagentActivityEvent,
} = await jiti.import("./subagent-types.ts");

/** `index` restarts per `task` call, so every batch numbers its own children. */
const batch = (call, agents, status = "started") =>
  agents.map((agent, index) => ({
    id: `${call}_${agent}${index}`, agent, status, index, parentToolCallId: call, source: "live",
  }));

/** The same batch as the session file reports it, carrying the call's ordinal. */
const fromFile = (call, batchSeq, agents, status = "completed") =>
  batch(call, agents, status).map((entry) => ({ ...entry, source: "history", batchSeq }));

const ids = (roster) => roster.map((entry) => entry.id);

test("roster orders batches by the file's call ordinal, not by index", () => {
  const first = mergeSubagentRoster([], fromFile("callA", 0, ["scout", "scout"]));
  const roster = mergeSubagentRoster(first, fromFile("callB", 1, ["worker", "worker"]));

  // Ordering by `index` alone would interleave these as A0, B0, A1, B1.
  assert.deepEqual(ids(roster), ["callA_scout0", "callA_scout1", "callB_worker0", "callB_worker1"]);
});

test("the file's call order wins over the order a snapshot arrives in", () => {
  // get_subagents sorts by `index` then SUBAGENT id, so the batch that arrives
  // first is whichever happens to own the alphabetically smaller child. Here
  // "Alpha" belongs to the call that was issued second.
  const snapshot = [
    { id: "Alpha", agent: "worker", status: "started", index: 0, parentToolCallId: "call_second", source: "live" },
    { id: "Zebra", agent: "scout", status: "started", index: 0, parentToolCallId: "call_first", source: "live" },
  ];
  const reconnected = mergeSubagentRoster([], snapshot);

  // Both calls land on disk. Their real order must take over, even though the
  // live entries stay in place because they beat the history ones.
  const corrected = mergeSubagentRoster(reconnected, [
    { id: "Zebra", agent: "scout", status: "completed", index: 0, parentToolCallId: "call_first", source: "history", batchSeq: 0 },
    { id: "Alpha", agent: "worker", status: "completed", index: 0, parentToolCallId: "call_second", source: "history", batchSeq: 1 },
  ]);

  assert.deepEqual(ids(corrected), ["Zebra", "Alpha"]);
  assert.deepEqual(corrected.map((entry) => entry.source), ["live", "live"]);
});

test("history arriving in pieces still orders by call, not by what landed first", () => {
  // Parallel calls: the second one finishes and reaches the file first, so the
  // client sees it before the call that was actually issued first exists on disk.
  const fast = mergeSubagentRoster([], fromFile("call_fast", 1, ["sonic"]));
  const both = mergeSubagentRoster(fast, fromFile("call_slow", 0, ["worker"]));

  assert.deepEqual(ids(both), ["call_slow_worker0", "call_fast_sonic0"]);
});

test("a batch still missing from disk sits after the calls the file knows", () => {
  const onDisk = mergeSubagentRoster([], fromFile("call_first", 0, ["scout"]));
  const running = mergeSubagentRoster(onDisk, batch("call_running", ["worker"]));

  assert.deepEqual(ids(running), ["call_first_scout0", "call_running_worker0"]);
  assert.equal(running[1].batchSeq, undefined);
});

test("a terminal frame without an ordinal leaves the card where it was", () => {
  const roster = mergeSubagentRoster(
    mergeSubagentRoster([], fromFile("callA", 0, ["scout"])),
    fromFile("callB", 1, ["worker", "sonic"]),
  );

  // A lifecycle frame is parsed fresh and carries no ordinal, so the slot has
  // to survive on the merge side rather than ride in on the payload.
  const settled = mergeSubagentRoster(roster, [
    { id: "callB_worker0", agent: "worker", status: "completed", index: 0, parentToolCallId: "callB", source: "live" },
  ]);

  assert.deepEqual(ids(settled), ids(roster));
  assert.equal(settled[1].status, "completed");
  assert.equal(settled[1].batchSeq, 1);
});

test("a stale snapshot cannot regress status but still hands over the ordinal", () => {
  const roster = mergeSubagentRoster([], [{ id: "a", agent: "scout", status: "completed", index: 0, source: "live", lastUpdate: 500 }]);

  const stale = mergeSubagentRoster(roster, [{ id: "a", agent: "scout", status: "started", index: 0, source: "history", batchSeq: 3 }], 400);

  assert.equal(stale[0].status, "completed");
  assert.equal(stale[0].batchSeq, 3);
});

test("live frames replace a history entry without moving it", () => {
  const history = mergeSubagentRoster([], fromFile("callA", 0, ["scout", "worker"]));

  const live = mergeSubagentRoster(history, [
    { id: "callA_worker1", agent: "worker", status: "started", index: 1, parentToolCallId: "callA", source: "live" },
  ]);

  assert.deepEqual(ids(live), ["callA_scout0", "callA_worker1"]);
  assert.equal(live[1].source, "live");
  assert.equal(live[1].batchSeq, 0);
});

test("parseSubagentProgress copies telemetry and retry state defensively", () => {
  const progress = parseSubagentProgress({
    index: 1,
    id: "Scout",
    agent: "scout",
    agentSource: "bundled",
    status: "running",
    currentTool: "read",
    lastIntent: "Inspect foo.ts",
    tokens: 1234,
    cost: 0.004,
    contextTokens: 8000,
    contextWindow: 32000,
    resolvedModel: "provider/gpt-x:high",
    resolvedModelIsFallback: true,
    retryState: { attempt: 2, maxAttempts: 5, delayMs: 1000, errorMessage: "429", startedAtMs: 1 },
  });
  assert.equal(progress?.currentTool, "read");
  assert.equal(progress?.lastIntent, "Inspect foo.ts");
  assert.equal(progress?.tokens, 1234);
  assert.equal(progress?.cost, 0.004);
  assert.equal(progress?.contextWindow, 32000);
  assert.equal(progress?.retryState?.attempt, 2);
  assert.equal(progress?.resolvedModelIsFallback, true);
  // Garbage fields are ignored, not fatal.
  assert.equal(parseSubagentProgress({ id: "x", tokens: "nope" })?.tokens, undefined);
  assert.equal(parseSubagentProgress(null), undefined);
  assert.equal(parseSubagentProgress({}), undefined);
});

test("parseSubagentSnapshot maps registry statuses and carries progress", () => {
  const snapshot = parseSubagentSnapshot({
    id: "Scout",
    index: 0,
    agent: "scout",
    agentSource: "user",
    status: "running",
    task: "Map",
    sessionFile: "C:\\work\\artifacts\\Scout.jsonl",
    lastUpdate: 123,
    progress: { id: "Scout", status: "running", tokens: 10 },
  });
  assert.equal(snapshot?.id, "Scout");
  assert.equal(snapshot?.status, "started");
  assert.equal(snapshot?.agentSource, "user");
  assert.equal(snapshot?.progress?.tokens, 10);
  assert.equal(snapshot?.sessionFile, "C:\\work\\artifacts\\Scout.jsonl");
  assert.equal(snapshot?.lastUpdate, 123);
  // Terminal registry statuses pass through.
  assert.equal(parseSubagentSnapshot({ id: "a", agent: "b", status: "completed" })?.status, "completed");
  assert.equal(parseSubagentSnapshot({ id: "a" }), undefined);
});

test("parseSubagentActivityEvent extracts tools, text, and notices", () => {
  const tool = parseSubagentActivityEvent({ id: "s", event: { type: "tool_execution_start", toolName: "read", intent: "Inspect foo.ts", args: { path: "foo.ts" } } });
  assert.equal(tool?.kind, "tool");
  assert.match(tool?.label ?? "", /read/);

  const text = parseSubagentActivityEvent({ id: "s", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done working" }] } } });
  assert.equal(text?.kind, "text");
  assert.match(text?.label ?? "", /done working/);

  const notice = parseSubagentActivityEvent({ id: "s", event: { type: "notice", message: "tool updated" } });
  assert.equal(notice?.kind, "notice");

  assert.equal(parseSubagentActivityEvent({ id: "s", event: { type: "message_update" } }), null);
  assert.equal(parseSubagentActivityEvent({}), null);
});
