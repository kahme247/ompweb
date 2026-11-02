import assert from "node:assert/strict";
import test from "node:test";

const { createSessionCatchUp, MISSING_BASE_RETRY_MS } = await import("./useAgentSession-sync.ts");

test("a newer user delivery cannot block recovery of an unrelated assistant partial", async (t) => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor));
  const context = { messages: [], entryIds: [], thinkingLevel: "off", model: null, todoPhases: [] };
  let displayed = "visible before the gap";
  let release;
  let started;
  const requested = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", () => new Promise((resolve) => {
    release = () => resolve({ ok: true, json: async () => ({
      sessionId: "s1", mode: "append", baseEntryId: null, context,
      cursor: { firstEntryId: null, lastEntryId: null }, hasMore: false, leafId: null,
      live: {
        cursor: { streamId: "stream", sequence: 2 }, isStreaming: true, isPromptRunning: true, isCompacting: false,
        streamingMessage: { role: "assistant", content: [{ type: "text", text: "recovered partial" }] }, toolEvents: [],
      },
    }) });
    started();
  }));
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-run", history() {}, subscribe: () => false,
    live(snapshot, fields) { if (fields.message) displayed = snapshot.streamingMessage.content[0].text; },
  });
  catchUp.seed(context);
  catchUp.observe({ type: "connected", web: { streamId: "stream", sequence: 1 } });
  const pending = catchUp.request();
  await requested;
  catchUp.observe({ type: "message_end", message: { role: "user", content: "steering" }, web: { streamId: "stream", sequence: 3 } });
  release();
  await pending;
  assert.equal(displayed, "recovered partial");
});

test("a held full response cannot resurrect truncated entries and fresh catch-up recovers later appends", async (t) => {
  let displayed;
  let requests = 0;
  let release;
  let started;
  const following = new Promise((resolve) => { started = resolve; });
  const context = (ids) => ({
    messages: ids.map((id) => ({ role: "user", content: id })),
    entryIds: ids, thinkingLevel: "off", model: null, todoPhases: [],
  });
  t.mock.method(globalThis, "fetch", (url) => {
    requests += 1;
    const page = (ids, mode, baseEntryId) => ({ ok: true, json: async () => ({
      sessionId: "s1", mode, baseEntryId, context: context(ids),
      cursor: { firstEntryId: "a", lastEntryId: ids.at(-1) },
      hasMore: false, leafId: ids.at(-1), live: null,
    }) });
    if (requests === 1) return Promise.resolve(page(["a", "b"], "replace", null));
    assert.equal(JSON.parse(new URL(url, "http://localhost").searchParams.get("cursor")).lastEntryId, "b");
    return new Promise((resolve) => {
      release = () => resolve(page(["d"], "append", "b"));
      started();
    });
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "same-view",
    history(next) { displayed = next; }, live() {}, subscribe: () => false,
  });
  catchUp.seed(context(["a", "b", "c"]));
  const fullReadPosition = catchUp.position();
  await catchUp.request();
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  catchUp.seed(context(["a", "b", "c"]), fullReadPosition);
  assert.deepEqual(displayed.entryIds, ["a", "b"]);
  await following;
  release();
  await new Promise(setImmediate);
  assert.deepEqual(displayed.entryIds, ["a", "b", "d"]);
  assert.equal(requests, 2);
});

// omp's delta updates through catch-up and the coalescer, wired as useAgentSession wires them.
const { createMessageUpdateCoalescer } = await import("../lib/message-update-coalescer.ts");

function deltaPipeline(t) {
  const shown = [];
  const liveCalls = [];
  let page;
  let scheduled = [];
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => page }));
  const dispatch = (event) => { if (event.type === "message_update") shown.push(event.message.content[0]?.text); };
  const coalescer = createMessageUpdateCoalescer(dispatch, (flush) => {
    scheduled.push(flush);
    return () => { scheduled = scheduled.filter((job) => job !== flush); };
  });
  const catchUp = createSessionCatchUp({
    sessionId: () => "s1", scope: () => "run", history() {}, subscribe: () => false,
    live(snapshot, fields) {
      liveCalls.push(fields);
      coalescer.flush();
      if (fields.message) dispatch({ type: "message_update", message: snapshot.streamingMessage });
      coalescer.seed(snapshot.streamingMessageId ?? null, snapshot.streamingMessage, snapshot.cursor.sequence, fields.message);
    },
  });
  const web = (sequence) => ({ streamId: "s", sequence });
  return {
    shown,
    liveCalls,
    web,
    feed(event) { if (catchUp.observe(event) !== "stale") coalescer.push(event); },
    fire() { for (const flush of scheduled.splice(0)) flush(); },
    delta: (sequence, assistantMessageEvent) => ({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent, web: web(sequence) }),
    async snapshot(sequence, text, { busy = true } = {}) {
      page = {
        sessionId: "s1", mode: "replace", baseEntryId: null, context: { messages: [], entryIds: [] },
        cursor: { firstEntryId: null, lastEntryId: null }, hasMore: false, leafId: null,
        live: {
          cursor: { streamId: "s", sequence }, isStreaming: busy, isPromptRunning: busy, isCompacting: false,
          streamingMessage: { role: "assistant", content: [{ type: "text", text }] }, streamingMessageId: "m1", toolEvents: [],
        },
      };
      await catchUp.request();
    },
  };
}

test("a delta already in a catch-up snapshot is not applied again when its frame arrives after it", async (t) => {
  const pipe = deltaPipeline(t);
  pipe.feed({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [] }, web: pipe.web(1) });
  pipe.feed(pipe.delta(2, { type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }));
  // The snapshot is taken at sequence 3, so it holds "ab"; frame 3 is still on its way.
  await pipe.snapshot(3, "ab");
  pipe.feed(pipe.delta(3, { type: "text_delta", contentIndex: 0, delta: "ab" }));
  pipe.feed(pipe.delta(4, { type: "text_delta", contentIndex: 0, delta: "c" }));
  pipe.fire();
  assert.equal(pipe.shown.at(-1), "abc");
});

test("a snapshot no field takes still completes deltas that arrived without their message", async (t) => {
  const pipe = deltaPipeline(t);
  pipe.feed({ type: "connected", web: pipe.web(4) });
  // No base: both deltas are held.
  pipe.feed(pipe.delta(5, { type: "text_delta", contentIndex: 0, delta: "c" }));
  pipe.feed({ type: "auto_compaction_start", web: pipe.web(6) });
  pipe.feed(pipe.delta(7, { type: "text_delta", contentIndex: 0, delta: "d" }));
  // Older than the lifecycle frame and the last delta: no field applies, yet it holds delta 5.
  await pipe.snapshot(5, "abc", { busy: false });
  assert.deepEqual(pipe.liveCalls.at(-1), { message: false, lifecycle: false, tools: null });
  pipe.fire();
  assert.equal(pipe.shown.at(-1), "abcd");
});

// Base-less deltas through the coalescer into catch-up, reads failing at once, on a clock the test moves (performance.now and timers).
function missingBasePipeline(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let clock = 10_000;
  t.mock.method(performance, "now", () => clock);
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    throw new TypeError("Failed to fetch");
  });
  const catchUp = createSessionCatchUp({ sessionId: () => "s1", scope: () => "run", history() {}, subscribe: () => false, live() {} });
  const coalescer = createMessageUpdateCoalescer(() => {}, () => () => {}, () => catchUp.requestMissingBase());
  let sequence = 0;
  const settle = () => new Promise((resolve) => setImmediate(resolve)); // the failed read ends
  return {
    requests,
    catchUp,
    async delta() {
      sequence += 1;
      coalescer.push({ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" }, web: { streamId: "s", sequence } });
      await settle();
    },
    async wait(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
      await settle();
    },
  };
}

test("deltas without a message while reads fail fast send one context request per window", async (t) => {
  const pipe = missingBasePipeline(t);
  for (let i = 0; i < 20; i += 1) await pipe.delta();
  assert.equal(pipe.requests.length, 1, "twenty base-less deltas, one request");
  await pipe.wait(MISSING_BASE_RETRY_MS);
  assert.equal(pipe.requests.length, 2, "the window's end sends the one request the dropped deltas were owed");
  await pipe.wait(MISSING_BASE_RETRY_MS);
  assert.equal(pipe.requests.length, 2, "nothing more without another delta");
  await pipe.delta();
  assert.equal(pipe.requests.length, 3, "a delta after a quiet window asks at once");
});

test("a base-less delta dropped inside the window still gets a request when it ends, though no delta follows", async (t) => {
  const pipe = missingBasePipeline(t);
  await pipe.delta();
  await pipe.delta();
  assert.equal(pipe.requests.length, 1);
  await pipe.wait(MISSING_BASE_RETRY_MS - 1);
  assert.equal(pipe.requests.length, 1, "not before the window ends");
  await pipe.wait(1);
  assert.equal(pipe.requests.length, 2, "the trailing request, with the stream quiet");
});

test("invalidate (select, disconnect) starts a fresh window and drops the trailing request", async (t) => {
  const pipe = missingBasePipeline(t);
  await pipe.delta();
  await pipe.delta();
  pipe.catchUp.disconnect();
  await pipe.wait(MISSING_BASE_RETRY_MS);
  assert.equal(pipe.requests.length, 1, "the pending trailing request was cancelled");
  await pipe.delta();
  assert.equal(pipe.requests.length, 2, "and the window was reset: this delta asks at once");
});
