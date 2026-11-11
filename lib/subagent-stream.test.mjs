import assert from "node:assert/strict";
import test from "node:test";

const { SubagentStreamLimiter, slimSubagentEvent, SUBAGENT_PROGRESS_INTERVAL_MS, SUBAGENT_NOISY_EVENT_INTERVAL_MS } = await import("./subagent-stream.ts");
const { parseSubagentActivityEvent } = await import("./subagent-types.ts");

const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(5000) }, { type: "text", text }], usage: { input: 1 }, ...extra });

/** What the browser derives from a frame, minus the timestamp. */
const activity = (frame) => {
  const parsed = parseSubagentActivityEvent(frame.payload);
  return parsed && { kind: parsed.kind, label: parsed.label };
};

const eventFrame = (id, event) => ({ type: "subagent_event", payload: { id, event }, web: { sequence: 1 } });
const progressFrame = (id, status = "running", tokens = 0) => ({ type: "subagent_progress", payload: { index: 0, progress: { id, status, tokens } } });
const lifecycleFrame = (id, status) => ({ type: "subagent_lifecycle", payload: { id, status, agent: "worker", index: 0 } });

/** A limiter on a manual clock; timers fire when `advance` passes them. */
function harness() {
  let clock = 0;
  let nextHandle = 1;
  const timers = new Map();
  const out = [];
  const limiter = new SubagentStreamLimiter((frame) => out.push(frame), {
    now: () => clock,
    setTimer: (run, ms) => {
      const handle = nextHandle++;
      timers.set(handle, { at: clock + ms, run });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle),
  });
  const advance = (ms) => {
    clock += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= clock && timers.delete(handle)) timer.run();
    }
  };
  return { limiter, out, advance, timers };
}

test("a slimmed child event yields the same activity label as the full one", () => {
  const events = [
    { type: "tool_execution_start", toolName: "write", intent: "Writing the report", args: { path: "/a", content: "y".repeat(9000) } },
    { type: "tool_execution_start", toolName: "grep", args: { pattern: "x", path: ".", glob: "*.ts", extra: 1 } },
    { type: "tool_execution_start", toolName: "bash" },
    { type: "message_end", message: assistant("  The answer is 42.  ") },
    { type: "message_end", message: assistant("z".repeat(500)) },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "ignored" }] } },
    { type: "message_end", message: { role: "assistant", content: "plain string content" } },
    { type: "notice", message: "n".repeat(300), level: "warning" },
    { type: "message_update", message: assistant("partial"), assistantMessageEvent: { type: "text_delta", partial: assistant("partial") } },
    { type: "turn_end", message: assistant("done"), toolResults: [{ role: "toolResult", content: [] }] },
  ];
  for (const event of events) {
    const full = eventFrame("Child", event);
    const slim = slimSubagentEvent(full);
    assert.deepEqual(activity(slim), activity(full), `activity of ${event.type}`);
    assert.equal(slim.payload.id, "Child");
    assert.equal(slim.payload.event.type, event.type);
    assert.deepEqual(slim.web, full.web, "the wrapper's sequence stamp survives");
  }
});

test("a slimmed message_update carries no message body", () => {
  const full = eventFrame("Child", { type: "message_update", message: assistant("x"), assistantMessageEvent: { type: "text_delta", delta: "x", partial: assistant("x") } });
  const slim = slimSubagentEvent(full);
  assert.deepEqual(slim.payload.event, { type: "message_update" });
  assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length / 10);
});

test("a malformed child event passes through untouched", () => {
  const noEvent = { type: "subagent_event", payload: { id: "Child" } };
  assert.equal(slimSubagentEvent(noEvent), noEvent);
  const noPayload = { type: "subagent_event" };
  assert.equal(slimSubagentEvent(noPayload), noPayload);
});

test("progress is sent at once for a quiet child, then newest-only once per interval", () => {
  const { limiter, out, advance } = harness();
  limiter.push(progressFrame("A", "running", 1));
  assert.equal(out.length, 1);
  limiter.push(progressFrame("A", "running", 2));
  limiter.push(progressFrame("A", "running", 3));
  limiter.push(progressFrame("A", "running", 4));
  assert.equal(out.length, 1, "held back inside the interval");
  advance(SUBAGENT_PROGRESS_INTERVAL_MS - 1);
  assert.equal(out.length, 1);
  advance(1);
  assert.equal(out.length, 2);
  assert.equal(out[1].payload.progress.tokens, 4, "the newest snapshot wins");
});

test("children are throttled independently", () => {
  const { limiter, out } = harness();
  limiter.push(progressFrame("A"));
  limiter.push(progressFrame("B"));
  assert.deepEqual(out.map((frame) => frame.payload.progress.id), ["A", "B"]);
});

test("a terminal progress goes out at once and cancels the held one", () => {
  const { limiter, out, advance, timers } = harness();
  limiter.push(progressFrame("A", "running", 1));
  limiter.push(progressFrame("A", "running", 2));
  limiter.push(progressFrame("A", "completed", 3));
  assert.deepEqual(out.map((frame) => frame.payload.progress.tokens), [1, 3]);
  assert.equal(timers.size, 0);
  advance(5000);
  assert.equal(out.length, 2, "the cancelled snapshot never lands after the terminal one");
});

test("a lifecycle frame lands after the progress it supersedes, never before", () => {
  const { limiter, out } = harness();
  limiter.push(progressFrame("A", "running", 1));
  limiter.push(progressFrame("A", "running", 2));
  limiter.push(lifecycleFrame("A", "completed"));
  assert.deepEqual(out.map((frame) => frame.type), ["subagent_progress", "subagent_progress", "subagent_lifecycle"]);
  assert.equal(out[1].payload.progress.tokens, 2);
});

test("a progress frame that names no child is passed through unchanged", () => {
  const { limiter, out } = harness();
  const frame = { type: "subagent_progress", payload: { index: 2, task: "t" } };
  limiter.push(frame);
  limiter.push(frame);
  assert.deepEqual(out, [frame, frame]);
});

test("streaming child events tick a revision at most once per interval; labelled ones always pass", () => {
  const { limiter, out, advance } = harness();
  const update = () => eventFrame("A", { type: "message_update", message: assistant("x") });
  for (let i = 0; i < 50; i += 1) limiter.push(update());
  assert.equal(out.length, 1);
  limiter.push(eventFrame("A", { type: "tool_execution_start", toolName: "bash" }));
  limiter.push(eventFrame("A", { type: "message_end", message: assistant("done") }));
  assert.equal(out.length, 3, "events the activity line is built from are never dropped");
  limiter.push(eventFrame("B", { type: "message_update", message: assistant("x") }));
  assert.equal(out.length, 4, "another child has its own budget");
  advance(SUBAGENT_NOISY_EVENT_INTERVAL_MS);
  limiter.push(update());
  assert.equal(out.length, 5);
});

test("flushAll emits what is held back; dispose drops it", () => {
  const first = harness();
  first.limiter.push(progressFrame("A", "running", 1));
  first.limiter.push(progressFrame("A", "running", 2));
  first.limiter.flushAll();
  assert.equal(first.out.length, 2);
  first.advance(5000);
  assert.equal(first.out.length, 2, "nothing is sent twice");

  const second = harness();
  second.limiter.push(progressFrame("A", "running", 1));
  second.limiter.push(progressFrame("A", "running", 2));
  second.limiter.dispose();
  second.advance(5000);
  assert.equal(second.out.length, 1);
  assert.equal(second.timers.size, 0);
});

test("other frame types are not claimed", () => {
  const { limiter, out } = harness();
  assert.equal(limiter.push({ type: "message_update" }), false);
  assert.equal(limiter.push({ type: "agent_end" }), false);
  assert.equal(out.length, 0);
});
