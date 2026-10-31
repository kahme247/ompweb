import assert from "node:assert/strict";
import test from "node:test";

const { applyBtwEvent, latestBtwTurn, mergeBtwHistory, upsertBtwRecord } = await import("./btw.ts");

const record = (overrides = {}) => ({
  id: "r1", leafId: null, question: "what is 2+2", answer: "", status: "running", createdAt: 1, updatedAt: 1, ...overrides,
});
const delta = (text, recordId = "r1") => ({ type: "btw_delta", recordId, delta: text });

test("deltas stream into a running record and stop once it settles", () => {
  let records = applyBtwEvent([], { type: "btw_record", record: record() });
  records = applyBtwEvent(records, delta("It is "));
  records = applyBtwEvent(records, delta("4."));
  assert.equal(records[0].answer, "It is 4.");

  records = applyBtwEvent(records, { type: "btw_record", record: record({ answer: "It is 4.", status: "complete", updatedAt: 2 }) });
  records = applyBtwEvent(records, delta(" late"));
  assert.equal(records[0].answer, "It is 4.");
  assert.equal(records[0].status, "complete");
});

test("a late btw response never wipes streamed text or resurrects a finished answer", () => {
  // SSE can beat the HTTP response: deltas land before the `btw` command's running snapshot.
  let records = applyBtwEvent([], { type: "btw_record", record: record() });
  records = applyBtwEvent(records, delta("It is 4."));
  records = upsertBtwRecord(records, record());
  assert.equal(records[0].answer, "It is 4.");

  records = applyBtwEvent(records, { type: "btw_record", record: record({ answer: "It is 4.", status: "complete" }) });
  records = upsertBtwRecord(records, record({ answer: "It is" }));
  assert.equal(records[0].status, "complete");
});

test("follow-up deltas extend the latest turn, not the original answer", () => {
  const first = record({ answer: "4", status: "complete" });
  const followUp = { question: "and 3+3?", answer: "", status: "running", createdAt: 3, updatedAt: 3 };
  let records = upsertBtwRecord([first], { ...first, followUps: [followUp] });
  records = applyBtwEvent(records, delta("6"));
  assert.equal(records[0].answer, "4");
  assert.equal(latestBtwTurn(records[0]).answer, "6");
  // A snapshot from before the follow-up started is stale.
  assert.equal(upsertBtwRecord(records, first), records);
});

test("a new topic goes first, ahead of older ones", () => {
  let records = applyBtwEvent([], { type: "btw_record", record: record({ status: "complete" }) });
  records = applyBtwEvent(records, { type: "btw_record", record: record({ id: "r2", question: "next", createdAt: 5, updatedAt: 5 }) });
  assert.deepEqual(records.map((r) => r.id), ["r2", "r1"]);
});

test("an authoritative snapshot heals streamed text that diverged from omp's", () => {
  // Deltas applied twice (e.g. replayed after a snapshot that already held them).
  const records = [record({ answer: "abcdcd" })];
  const merged = upsertBtwRecord(records, record({ answer: "abcde" }));
  assert.equal(merged[0].answer, "abcde");
  assert.equal(upsertBtwRecord(records, record({ answer: "abcdcd!", status: "complete" }))[0].answer, "abcdcd!");
});

test("malformed frames leave the records untouched", () => {
  const records = [record({ answer: "4" })];
  for (const frame of [
    { type: "btw_record", record: { ...record({ id: "r9" }), updatedAt: undefined } },
    { type: "btw_record", record: record({ id: "r9", status: "finished" }) },
    { type: "btw_record", record: { ...record({ id: "r9" }), followUps: [{ question: "q" }] } },
    // Finite but outside the Date range: the history dialog's toISOString would throw.
    { type: "btw_record", record: record({ id: "r9", updatedAt: 1e20 }) },
    { type: "btw_record", record: record({ id: "r9", createdAt: -1 }) },
    { type: "btw_record" },
    { type: "btw_delta", recordId: "r1", delta: 4 },
    { type: "btw_delta", delta: "x" },
    { type: "btw_delta", recordId: "unknown", delta: "x" },
  ]) {
    assert.equal(applyBtwEvent(records, frame), records, JSON.stringify(frame));
  }
});

test("history snapshots keep newer local state and merge newest first", () => {
  const streaming = record({ answer: "It is 4", createdAt: 2 });
  const local = [record({ id: "r2", question: "new", createdAt: 3, updatedAt: 3 }), streaming];
  const merged = mergeBtwHistory(local, [record({ answer: "It", createdAt: 2 }), record({ id: "r0", status: "complete", answer: "old", createdAt: 9 })], new Set(["r1"]));
  assert.deepEqual(merged.map((r) => r.id), ["r0", "r2", "r1"]);
  assert.equal(merged.find((r) => r.id === "r1").answer, "It is 4");
  assert.equal(merged.find((r) => r.id === "r2").status, "running", "started after the request: the snapshot predates it");
});

test("a running record omp no longer knows becomes interrupted, not a spinner forever", () => {
  const followUp = { question: "and 3+3?", answer: "6", status: "running", createdAt: 3, updatedAt: 3 };
  const local = [record({ answer: "4", status: "complete", followUps: [followUp] }), record({ id: "r0", status: "complete", createdAt: 0 })];
  const merged = mergeBtwHistory(local, [], new Set(["r1", "r0"]));
  assert.equal(latestBtwTurn(merged[0]).status, "interrupted");
  assert.equal(merged[0].status, "complete", "earlier turns keep their status");
  assert.equal(latestBtwTurn(merged[0]).answer, "6", "the partial answer stays readable");
  assert.equal(merged[1], local[1], "finished records the snapshot lacks are kept as they are");
});
