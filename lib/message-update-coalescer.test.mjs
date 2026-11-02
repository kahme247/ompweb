import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./message-update-coalescer.ts");
}

/** Manual scheduler: collects flush callbacks so tests control flush timing. */
function manualScheduler() {
  const scheduled = [];
  let cancelled = 0;
  const schedule = (flush) => {
    const entry = { flush, cancelled: false };
    scheduled.push(entry);
    return () => {
      entry.cancelled = true;
      cancelled += 1;
    };
  };
  const fire = () => {
    for (const entry of scheduled.splice(0)) {
      if (!entry.cancelled) entry.flush();
    }
  };
  return { schedule, fire, get cancelledCount() { return cancelled; } };
}

test("buffers message_update and dispatches only the latest on flush", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "message_update", seq: 1 });
  coalescer.push({ type: "message_update", seq: 2 });
  coalescer.push({ type: "message_update", seq: 3 });
  assert.equal(dispatched.length, 0);

  scheduler.fire();
  assert.deepEqual(dispatched, [{ type: "message_update", seq: 3 }]);
});

test("flushes the pending update before any other event type", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "message_update", seq: 1 });
  coalescer.push({ type: "tool_execution_start", toolCallId: "t1" });
  assert.deepEqual(dispatched.map((e) => e.type), ["message_update", "tool_execution_start"]);
  assert.equal(dispatched[0].seq, 1);

  // The already-scheduled flush must not re-dispatch the flushed update.
  scheduler.fire();
  assert.equal(dispatched.length, 2);
});

test("message_end supersedes the pending update", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "message_update", seq: 1 });
  coalescer.push({ type: "message_end", seq: 2 });
  assert.deepEqual(dispatched.map((e) => e.type), ["message_end"]);

  scheduler.fire();
  assert.equal(dispatched.length, 1);
});

test("continues coalescing after a flush", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "message_update", seq: 1 });
  scheduler.fire();
  coalescer.push({ type: "message_update", seq: 2 });
  scheduler.fire();
  assert.deepEqual(dispatched.map((e) => e.seq), [1, 2]);
});

test("non-update events pass through immediately when nothing is pending", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "agent_start" });
  coalescer.push({ type: "notice", message: "hi" });
  assert.deepEqual(dispatched.map((e) => e.type), ["agent_start", "notice"]);
});

test("reset drops the pending update and cancels the scheduled flush", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "message_update", seq: 1 });
  coalescer.reset();
  scheduler.fire();
  assert.equal(dispatched.length, 0);
  assert.equal(scheduler.cancelledCount, 1);
});

test("coalesces tool_execution_update per tool call and keeps each tool's latest", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "tool_execution_update", toolCallId: "a", chunk: 1 });
  coalescer.push({ type: "tool_execution_update", toolCallId: "b", chunk: 1 });
  coalescer.push({ type: "tool_execution_update", toolCallId: "a", chunk: 2 });
  assert.equal(dispatched.length, 0);

  scheduler.fire();
  assert.deepEqual(dispatched, [
    { type: "tool_execution_update", toolCallId: "a", chunk: 2 },
    { type: "tool_execution_update", toolCallId: "b", chunk: 1 },
  ]);
});

test("flushes buffered tool updates before the next event", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "tool_execution_update", toolCallId: "a", chunk: 1 });
  coalescer.push({ type: "tool_execution_end", toolCallId: "a" });
  assert.deepEqual(dispatched.map((e) => e.type), ["tool_execution_update", "tool_execution_end"]);

  scheduler.fire();
  assert.equal(dispatched.length, 2);
});

test("message_end does not drop a buffered tool update", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  // The committed assistant message supersedes the partial text, but the tool
  // it announced is still executing — its buffered update must survive.
  coalescer.push({ type: "message_update", seq: 1 });
  coalescer.push({ type: "tool_execution_update", toolCallId: "a", chunk: 1 });
  coalescer.push({ type: "message_end", seq: 2 });
  assert.deepEqual(dispatched.map((e) => e.type), ["message_end"]);

  scheduler.fire();
  assert.deepEqual(dispatched.map((e) => e.type), ["message_end", "tool_execution_update"]);
});

test("a tool update without an id is dispatched immediately", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "tool_execution_update", chunk: 1 });
  assert.deepEqual(dispatched.map((e) => e.type), ["tool_execution_update"]);
});

test("reset drops buffered tool updates", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduler = manualScheduler();
  const coalescer = createMessageUpdateCoalescer((e) => dispatched.push(e), scheduler.schedule);

  coalescer.push({ type: "tool_execution_update", toolCallId: "a", chunk: 1 });
  coalescer.reset();
  scheduler.fire();
  assert.equal(dispatched.length, 0);
});

test("explicit flush preserves queued message and tool output before snapshot hydration", async () => {
  const { createMessageUpdateCoalescer } = await loadSubject();
  const dispatched = [];
  const scheduled = [];
  const coalescer = createMessageUpdateCoalescer((event) => dispatched.push(event), (flush) => {
    const job = { flush, cancelled: false };
    scheduled.push(job);
    return () => { job.cancelled = true; };
  });
  coalescer.push({ type: "message_update", text: "old" });
  coalescer.push({ type: "tool_execution_update", toolCallId: "a", text: "tool progress" });
  coalescer.push({ type: "message_update", text: "new" });
  coalescer.flush();
  assert.deepEqual(dispatched.map((event) => event.text), ["new", "tool progress"]);

  coalescer.push({ type: "message_update", text: "after snapshot" });
  const oldJob = scheduled.shift();
  if (!oldJob.cancelled) oldJob.flush();
  assert.deepEqual(dispatched.map((event) => event.text), ["new", "tool progress"]);
  const nextJob = scheduled.shift();
  if (!nextJob.cancelled) nextJob.flush();
  assert.deepEqual(dispatched.map((event) => event.text), ["new", "tool progress", "after snapshot"]);
});

// omp's delta updates (lib/message-delta.ts): the coalescer keeps the message they apply to.
const web = (sequence) => ({ streamId: "s", sequence });
const start = (sequence, content = []) => ({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content }, web: web(sequence) });
const delta = (sequence, assistantMessageEvent, messageId = "msg-2") => ({ type: "message_update", messageId, message: { role: "assistant" }, assistantMessageEvent, web: web(sequence) });
const text = (sequence, chunk) => delta(sequence, { type: "text_delta", contentIndex: 0, delta: chunk });

function deltaCoalescer() {
  const dispatched = [];
  const scheduler = manualScheduler();
  let missing = 0;
  return import("./message-update-coalescer.ts").then(({ createMessageUpdateCoalescer }) => ({
    coalescer: createMessageUpdateCoalescer((event) => dispatched.push(event), scheduler.schedule, () => { missing += 1; }),
    dispatched,
    fire: scheduler.fire,
    missing: () => missing,
  }));
}

test("applies every delta and dispatches the whole message once per display frame", async () => {
  const { coalescer, dispatched, fire } = await deltaCoalescer();
  coalescer.push(start(1));
  coalescer.push(delta(2, { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }));
  coalescer.push(text(3, "hel"));
  coalescer.push(text(4, "lo"));
  fire();
  coalescer.push(delta(5, { type: "toolcall_start", contentIndex: 1, block: { type: "toolCall", id: "c", name: "read", arguments: {} } }));
  coalescer.push(delta(6, { type: "toolcall_delta", contentIndex: 1, delta: '{"path": "no' }));
  fire();
  const updates = dispatched.filter((event) => event.type === "message_update");
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0].message.content, [{ type: "text", text: "hello" }]);
  assert.equal(updates[0].web.sequence, 4, "the dispatched frame is the latest one");
  assert.deepEqual(updates[1].message.content[1].arguments, { path: "no" }, "streamed tool arguments are parsed for display");
});

test("a whole message re-bases the deltas after it; message_end drops the base", async () => {
  const { coalescer, dispatched, fire, missing } = await deltaCoalescer();
  coalescer.push({ type: "message_update", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "snap" }] }, web: web(7) });
  coalescer.push(text(8, "shot"));
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "snapshot");
  coalescer.push({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "snapshot" }] }, web: web(9) });
  coalescer.push(text(10, "late"));
  fire();
  assert.equal(dispatched.at(-1).type, "message_end");
  assert.equal(missing(), 1, "a delta after its message ended has no base");
});

test("deltas without a base are held, ask for a snapshot, and apply on top of it", async () => {
  const { coalescer, dispatched, fire, missing } = await deltaCoalescer();
  coalescer.push(start(1, []));
  coalescer.reset();
  coalescer.push(text(5, "lo"));
  coalescer.push(text(6, " there"));
  fire();
  assert.equal(dispatched.filter((event) => event.type === "message_update").length, 0, "nothing rendered from a guess");
  assert.equal(missing(), 2);
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "hello" }] }, 5, false);
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "hello there", "only the held delta newer than the snapshot applies");
});

test("a held delta is never applied to a snapshot of another message or one older than the gap", async () => {
  const { coalescer, dispatched, fire } = await deltaCoalescer();
  coalescer.push(start(3, [{ type: "text", text: "" }]));
  coalescer.reset();
  coalescer.push({ type: "tool_execution_start", toolCallId: "t", web: web(8) });
  coalescer.push(text(9, "x"));
  coalescer.seed("msg-1", { role: "assistant", content: [{ type: "text", text: "other" }] }, 9, false);
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "old" }] }, 7, false);
  fire();
  assert.equal(dispatched.filter((event) => event.type === "message_update").length, 0);
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "now" }] }, 8, false);
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "nowx");
});

test("an applied snapshot replaces the base even when the coalescer had one", async () => {
  const { coalescer, dispatched, fire } = await deltaCoalescer();
  coalescer.push(start(1, [{ type: "text", text: "" }]));
  coalescer.push(text(2, "a"));
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "abc" }] }, 4, true);
  coalescer.push(text(5, "d"));
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "abcd");
});

// A frame the server merged under backpressure spans sequences `web.first`..`web.sequence`.
const spanning = (first, sequence, chunk) => ({ ...text(sequence, chunk), web: { streamId: "s", sequence, first } });

test("a held merged delta that a snapshot holds only part of is not replayed on it: the next snapshot is asked for", async () => {
  const { coalescer, dispatched, fire, missing } = await deltaCoalescer();
  coalescer.push(spanning(5, 6, "cd"));
  assert.equal(missing(), 1);
  // The snapshot at 5 already has "c".
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "abc" }] }, 5, false);
  fire();
  assert.equal(dispatched.filter((event) => event.type === "message_update").length, 0, "never abccd");
  assert.equal(missing(), 2);
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "abcd" }] }, 6, true);
  coalescer.push(text(7, "e"));
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "abcde");
});

test("a merged delta reaching a base it partly overlaps waits for the next snapshot", async () => {
  const { coalescer, dispatched, fire, missing } = await deltaCoalescer();
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "abc" }] }, 5, true);
  coalescer.push(spanning(5, 6, "cd"));
  fire();
  assert.equal(dispatched.filter((event) => event.type === "message_update").length, 0, "never abccd");
  assert.equal(missing(), 1);
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "abcd" }] }, 6, false);
  coalescer.push(spanning(7, 8, "ef"));
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "abcdef", "a merged frame wholly after the base applies");
});

test("held deltas are bounded: a snapshot older than the dropped ones no longer completes the rest", async () => {
  const { HELD_DELTA_LIMIT } = await import("./message-update-coalescer.ts");
  const { coalescer, dispatched, fire, missing } = await deltaCoalescer();
  for (let sequence = 1; sequence <= HELD_DELTA_LIMIT + 1; sequence += 1) coalescer.push(text(sequence, "x"));
  assert.equal(missing(), HELD_DELTA_LIMIT + 1);
  // Replaying 6.. on a snapshot at 5 would skip the dropped deltas.
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "old" }] }, 5, false);
  fire();
  assert.equal(dispatched.filter((event) => event.type === "message_update").length, 0);
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "base" }] }, HELD_DELTA_LIMIT, false);
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "basex", "the snapshot that covers the dropped deltas takes the kept one");
});

test("a delta frame that arrives twice is applied once: the second asks for a snapshot", async () => {
  const { coalescer, dispatched, fire, missing } = await deltaCoalescer();
  coalescer.seed("msg-2", { role: "assistant", content: [{ type: "text", text: "a" }] }, 4, true);
  coalescer.push(text(5, "b"));
  coalescer.push(text(5, "b"));
  fire();
  assert.equal(dispatched.at(-1).message.content[0].text, "ab");
  assert.equal(missing(), 1);
});
