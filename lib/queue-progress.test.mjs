import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  QueueProgressLedger,
  alignQueue,
  buildQueuePanelItems,
  queuedTextOfUserMessage,
  readQueueProgressSnapshot,
  runOutcomeOfAgentEnd,
} = await jiti.import("./queue-progress.ts");

function ledger() {
  let next = 0;
  return new QueueProgressLedger({ epoch: "epoch-1", createId: () => `q${++next}` });
}
const queue = (followUp = [], steering = []) => ({ steering, followUp });
const view = (l) => l.snapshot().items.map(({ id, text, queue: name, status }) => ({ id, text, queue: name, status }));
const statuses = (l) => l.snapshot().items.map((item) => `${item.text}:${item.status}`);

test("one-at-a-time follow-ups run queued → running → done in order (omp's frame order)", () => {
  const l = ledger();
  // While the first prompt runs, three follow-ups are queued.
  l.observeQueue(queue(["two"]), 10);
  l.observeQueue(queue(["two", "three"]), 11);
  l.observeQueue(queue(["two", "three", "four"]), 12);
  assert.deepEqual(statuses(l), ["two:queued", "three:queued", "four:queued"]);

  // omp drops the head from the snapshot, then starts a turn with it.
  l.observeQueue(queue(["three", "four"]), 20);
  l.observeTurnStart();
  l.observeUserMessage("two", 21);
  assert.deepEqual(statuses(l), ["two:running", "three:queued", "four:queued"]);

  l.observeQueue(queue(["four"]), 30);
  l.observeTurnStart();
  l.observeUserMessage("three", 31);
  assert.deepEqual(statuses(l), ["two:done", "three:running", "four:queued"]);
  const two = l.snapshot().items[0];
  assert.equal(two.startedAt, 21);
  assert.equal(two.finishedAt, 31);

  l.observeQueue(queue([]), 40);
  l.observeTurnStart();
  l.observeUserMessage("four", 41);
  l.observeRunEnd("completed", 50);
  assert.deepEqual(statuses(l), ["two:done", "three:done", "four:done"]);
  assert.deepEqual(l.snapshot().items.map((item) => [item.startedAt, item.finishedAt]), [[21, 31], [31, 41], [41, 50]]);
});

test('"all" mode starts every delivered follow-up together and finishes them with the run', () => {
  const l = ledger();
  l.observeQueue(queue(["a", "b"]), 1);
  l.observeQueue(queue([]), 2);
  l.observeTurnStart();
  l.observeUserMessage("a", 3);
  l.observeUserMessage("b", 3);
  assert.deepEqual(statuses(l), ["a:running", "b:running"], "a second delivery in the same turn does not finish the first");
  l.observeRunEnd("completed", 9);
  assert.deepEqual(statuses(l), ["a:done", "b:done"]);
});

test("identical texts are told apart deterministically by order", () => {
  const l = ledger();
  l.observeQueue(queue(["same"]), 1);
  l.observeQueue(queue(["same", "same"]), 2);
  const [first, second] = view(l);
  assert.notEqual(first.id, second.id);

  // Delivery takes the head: the earlier item runs, the later stays queued.
  l.observeQueue(queue(["same"]), 3);
  l.observeTurnStart();
  l.observeUserMessage("same", 4);
  assert.deepEqual(view(l), [{ ...first, status: "running" }, { ...second, status: "queued" }]);

  l.observeQueue(queue([]), 5);
  l.observeTurnStart();
  l.observeUserMessage("same", 6);
  assert.deepEqual(view(l), [{ ...first, status: "done" }, { ...second, status: "running" }]);
  assert.deepEqual(alignQueue(["x", "x"], ["x"]), [-1, 0], "the earliest duplicate is the one that left");
});

test("a steer joins the running turn; the next follow-up finishes both", () => {
  const l = ledger();
  l.observeQueue(queue(["later"]), 1);
  l.observeQueue(queue(["later"], ["steer now"]), 2);
  l.observeQueue(queue(["later"]), 3);
  l.observeTurnStart();
  l.observeUserMessage("steer now", 4);
  assert.deepEqual(statuses(l), ["steer now:running", "later:queued"]);

  // Steering never completes earlier work: the agent is still on it.
  l.observeQueue(queue(["later"], ["more"]), 5);
  l.observeQueue(queue(["later"]), 6);
  l.observeTurnStart();
  l.observeUserMessage("more", 7);
  assert.deepEqual(statuses(l), ["steer now:running", "more:running", "later:queued"]);

  l.observeQueue(queue([]), 8);
  l.observeTurnStart();
  l.observeUserMessage("later", 9);
  assert.deepEqual(statuses(l), ["steer now:done", "more:done", "later:running"]);
});

test("live steering recorded before its snapshot still matches the queued item", () => {
  const l = ledger();
  l.observeQueue(queue([], ["now"]), 1);
  l.observeUserMessage("now", 2);
  l.observeQueue(queue([]), 3);
  assert.deepEqual(statuses(l), ["now:running"]);
});

test("an aborted or failed run marks its items failed and drops what it took unrecorded", () => {
  const aborted = ledger();
  aborted.observeQueue(queue(["a", "b", "c"]), 1);
  aborted.observeQueue(queue(["b", "c"]), 2);
  aborted.observeTurnStart();
  aborted.observeUserMessage("a", 3);
  aborted.observeQueue(queue(["c"]), 4); // taken for the next call, never recorded
  aborted.observeRunEnd(runOutcomeOfAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }), 5);
  assert.deepEqual(statuses(aborted), ["a:failed", "c:queued", "b:cancelled"], "a plain abort keeps omp's pending queue");

  const failed = ledger();
  failed.observeQueue(queue(["a"]), 1);
  failed.observeQueue(queue([]), 2);
  failed.observeTurnStart();
  failed.observeUserMessage("a", 3);
  failed.observeRunEnd(runOutcomeOfAgentEnd({ messages: [{ role: "assistant", stopReason: "error" }, { role: "toolResult" }] }), 4);
  assert.deepEqual(statuses(failed), ["a:failed"]);
  assert.equal(runOutcomeOfAgentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }), "completed");
  assert.equal(runOutcomeOfAgentEnd({ messages: [] }), "completed");
});

test("remove_queued_message marks the removed item cancelled, before or after its snapshot", () => {
  // omp's order: the snapshot drops it, then the reply confirms.
  const l = ledger();
  l.observeQueue(queue(["dup", "dup"]), 1);
  const [first, second] = view(l);
  l.observeQueue(queue(["dup"]), 2);
  assert.equal(l.observeRemoval("dup", "followUp", 3), true);
  assert.deepEqual(view(l), [{ ...second, status: "queued" }, { ...first, status: "cancelled" }], "omp removes the first match");

  // A reply that overtakes the snapshot still cancels exactly one.
  const early = ledger();
  early.observeQueue(queue(["x", "y"]), 1);
  early.observeRemoval("y", "followUp", 2);
  early.observeQueue(queue(["x"]), 3);
  assert.deepEqual(statuses(early), ["x:queued", "y:cancelled"]);
  assert.equal(early.observeRemoval("missing", "followUp", 4), false);
});

test("a removal confirmed after a later delivery or the run's end still cancels the removed item", () => {
  // The later prompt's user message is handled before the removal reply
  // (one stdout read): the removed item is first inferred to run with it.
  const l = ledger();
  l.observeQueue(queue(["removed", "next"]), 1);
  l.observeQueue(queue(["next"]), 2); // omp removed it
  l.observeQueue(queue([]), 3); // omp took "next"
  l.observeTurnStart();
  l.observeUserMessage("next", 4);
  assert.deepEqual(statuses(l), ["removed:running", "next:running"]);
  assert.equal(l.observeRemoval("removed", "followUp", 5), true);
  assert.deepEqual(statuses(l), ["next:running", "removed:cancelled"]);
  assert.equal(l.snapshot().items[1].startedAt, undefined, "it never started");
  l.observeRunEnd("completed", 6);
  assert.deepEqual(statuses(l), ["next:done", "removed:cancelled"]);

  // The run ended before the reply: the run's outcome was only inferred.
  const ended = ledger();
  ended.observeQueue(queue(["removed"]), 1);
  ended.observeQueue(queue([]), 2);
  ended.observeRunEnd("completed", 3);
  assert.deepEqual(statuses(ended), ["removed:done"]);
  assert.equal(ended.observeRemoval("removed", "followUp", 4), true);
  assert.deepEqual(statuses(ended), ["removed:cancelled"]);

  // An item that ran under its own transcript message is never undone.
  const ran = ledger();
  ran.observeQueue(queue(["x"]), 1);
  ran.observeQueue(queue([]), 2);
  ran.observeTurnStart();
  ran.observeUserMessage("x", 3);
  assert.equal(ran.observeRemoval("x", "followUp", 4), false);
  assert.deepEqual(statuses(ran), ["x:running"]);
});

test("abort_and_restore_queue cancels everything still queued", () => {
  const l = ledger();
  l.observeQueue(queue(["a", "b"], ["s"]), 1);
  l.observeQueue(queue(["b"], ["s"]), 2);
  l.observeTurnStart();
  l.observeUserMessage("a", 3);
  // omp withdraws the queue, the run ends aborted, then the command answers.
  l.observeQueue(queue([]), 4);
  l.observeRunEnd("aborted", 5);
  l.observeAbort({ restoreQueue: true, boundary: l.boundary() }, 6);
  assert.deepEqual(statuses(l), ["a:failed", "s:cancelled", "b:cancelled"]);

  // While idle there is no agent_end: the reply alone settles the queue.
  const idle = ledger();
  idle.observeQueue(queue(["x"]), 1);
  idle.observeAbort({ restoreQueue: true, boundary: idle.boundary() }, 2);
  idle.observeQueue(queue([]), 3);
  assert.deepEqual(statuses(idle), ["x:cancelled"]);
});

test("an abort settles only what was queued before it was sent", () => {
  const l = ledger();
  l.observeQueue(queue(["old"]), 1);
  const boundary = l.boundary();
  // omp withdraws "old"; a prompt queued after the abort reaches the ledger
  // before omp-web handles the abort's reply.
  l.observeQueue(queue([]), 2);
  l.observeQueue(queue(["new"]), 3);
  l.observeAbort({ restoreQueue: true, boundary }, 4);
  assert.deepEqual(statuses(l), ["new:queued", "old:cancelled"]);
});

test("promotion moves a follow-up into steering without losing its identity", () => {
  const l = ledger();
  l.observeQueue(queue(["a", "b"]), 1);
  const [a, b] = view(l);
  l.observeQueue(queue(["a"], ["b"]), 2);
  assert.deepEqual(view(l), [{ ...b, queue: "steering" }, a], "steering drains first");
});

test("a rewritten delivery (slash command) still completes, and earlier departures run with the next match", () => {
  const l = ledger();
  l.observeQueue(queue(["/skill:x go", "plain"]), 1);
  l.observeQueue(queue(["plain"]), 2);
  l.observeTurnStart();
  l.observeUserMessage("expanded skill text", 3); // no match: stays pending
  assert.deepEqual(statuses(l), ["/skill:x go:queued", "plain:queued"]);
  l.observeRunEnd("completed", 4);
  assert.deepEqual(statuses(l), ["/skill:x go:done", "plain:queued"]);
});

test("a matched later prompt starts earlier departed items alongside it", () => {
  const l = ledger();
  l.observeQueue(queue(["/skill:x go", "plain"]), 1);
  l.observeQueue(queue([]), 2);
  l.observeTurnStart();
  l.observeUserMessage("plain", 3);
  assert.deepEqual(statuses(l), ["/skill:x go:running", "plain:running"]);
});

test("a new batch clears finished items; dismiss clears them on demand", () => {
  const l = ledger();
  l.observeQueue(queue(["a"]), 1);
  l.observeQueue(queue([]), 2);
  l.observeTurnStart();
  l.observeUserMessage("a", 3);
  l.observeRunEnd("completed", 4);
  assert.deepEqual(statuses(l), ["a:done"]);
  l.observeQueue(queue(["b"]), 5);
  assert.deepEqual(statuses(l), ["b:queued"], "the previous batch was finished");

  const revision = l.snapshot().revision;
  assert.equal(l.dismissFinished(), false, "nothing finished to dismiss");
  assert.equal(l.snapshot().revision, revision, "no-op changes keep the revision");
  l.observeQueue(queue([]), 6);
  l.observeTurnStart();
  l.observeUserMessage("b", 7);
  l.observeRunEnd("completed", 8);
  assert.equal(l.dismissFinished(), true);
  assert.deepEqual(l.snapshot().items, []);
  assert.ok(l.snapshot().revision > revision);
  assert.equal(l.reset(), false);
});

test("an unrelated user prompt never touches the ledger", () => {
  const l = ledger();
  l.observeQueue(queue(["queued"]), 1);
  assert.equal(l.observeUserMessage("something else", 2), false);
  assert.deepEqual(statuses(l), ["queued:queued"]);
});

test("user message text mirrors omp's queue-chip text", () => {
  assert.equal(queuedTextOfUserMessage({ role: "user", content: "hi" }), "hi");
  assert.equal(queuedTextOfUserMessage({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(queuedTextOfUserMessage({ role: "user", content: [{ type: "image" }] }), "[Image]");
  assert.equal(queuedTextOfUserMessage({ role: "user", attribution: "agent", content: "handoff" }), null);
  assert.equal(queuedTextOfUserMessage({ role: "assistant", content: "x" }), null);
  assert.equal(queuedTextOfUserMessage({ role: "custom", content: "notice" }), null);
});

test("panel items: omp's snapshot decides what is editable and fills in chips the ledger has not reported", () => {
  const l = ledger();
  l.observeQueue(queue(["a", "b"]), 1);
  l.observeQueue(queue(["b"]), 2); // a left the queue, not yet in the transcript
  const items = buildQueuePanelItems(l.snapshot(), queue(["b", "c"]));
  assert.deepEqual(items.map((item) => [item.text, item.status, item.actionable]), [
    ["a", "queued", false],
    ["b", "queued", true],
    ["c", "queued", true],
  ]);
  assert.deepEqual(buildQueuePanelItems(null, null), []);
});

test("panel items: only the first of identical pending items is actionable, and a departed one claims no chip", () => {
  // omp acts on the first match: with [A, X, A] only the first A may be edited.
  const l = ledger();
  l.observeQueue(queue(["A", "X", "A"]), 1);
  assert.deepEqual(buildQueuePanelItems(l.snapshot(), queue(["A", "X", "A"])).map((item) => [item.text, item.actionable]), [
    ["A", true],
    ["X", true],
    ["A", false],
  ]);
  // Chips the ledger has not reported follow the same rule.
  assert.deepEqual(buildQueuePanelItems(null, queue(["B", "B"])).map((item) => [item.text, item.actionable]), [["B", true], ["B", false]]);

  // omp took the first of two identical follow-ups; its transcript message has not arrived.
  const taken = ledger();
  taken.observeQueue(queue(["dup", "dup"]), 1);
  taken.observeQueue(queue(["dup"]), 2);
  const snapshot = taken.snapshot();
  assert.deepEqual(snapshot.items.map((item) => item.departed), [true, undefined]);
  assert.deepEqual(readQueueProgressSnapshot(snapshot), snapshot, "the departed flag survives the wire");
  assert.deepEqual(buildQueuePanelItems(snapshot, queue(["dup"])).map((item) => [item.id, item.actionable]), [
    [snapshot.items[0].id, false],
    [snapshot.items[1].id, true],
  ]);
});

test("snapshots parse defensively", () => {
  const l = ledger();
  l.observeQueue(queue(["a"]), 1);
  assert.deepEqual(readQueueProgressSnapshot({ type: "queue_progress", ...l.snapshot() }), l.snapshot());
  assert.equal(readQueueProgressSnapshot(null), null);
  assert.equal(readQueueProgressSnapshot({ epoch: "e", revision: "1", items: [] }), null);
  assert.deepEqual(readQueueProgressSnapshot({ epoch: "e", revision: 1, items: [{ id: "x", text: "t", queue: "nope", status: "done", queuedAt: 1 }] }).items, []);
});
