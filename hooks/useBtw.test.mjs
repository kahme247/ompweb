import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
const { act, cleanup, renderHook } = await import("@testing-library/react/pure.js");

// hooks/useBtw.ts had no test at all: lib/btw.test.mjs covers the pure merges,
// but the ordering decisions the hook itself makes live only here. The one that
// matters most is when queued SSE frames are applied relative to a history
// snapshot — get it wrong and streamed text is applied twice.

const { useBtw } = await import("./useBtw.ts");

const T0 = 1_700_000_000_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A record in `status` with `answer`; deltas only append to a running turn. */
function record(answer, status = "running", updatedAt = T0) {
  return { id: "r1", leafId: null, question: "2+2?", answer, status, createdAt: T0, updatedAt };
}

let historyReply;
let commands;

beforeEach(() => {
  historyReply = { records: [] };
  commands = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    commands.push(body.type);
    assert.equal(url, "/api/agent/s1");
    return {
      ok: true,
      json: async () => ({ success: true, data: body.type === "get_btw_history" ? historyReply : null }),
    };
  };
});

afterEach(() => {
  cleanup();
  delete globalThis.fetch;
});

/** Mount the hook and return its live view plus the session ref it reads. */
function mount() {
  const sessionIdRef = { current: "s1" };
  return renderHook(() => useBtw(sessionIdRef)).result;
}

/** Apply frames and let the display-rate flush run (rAF or its 50ms fallback). */
async function applyFrames(view, frames) {
  act(() => {
    for (const frame of frames) view.current.applyEvent(frame);
  });
  await act(async () => {
    await sleep(120);
  });
}

test("a history snapshot never re-applies frames the queue is still holding", async () => {
  const view = mount();
  // Frames arrive and queue; the display-rate flush has not fired yet.
  act(() => {
    view.current.applyEvent({ type: "btw_record", record: record("") });
    view.current.applyEvent({ type: "btw_delta", recordId: "r1", delta: "Hel" });
  });
  // omp is further ahead than the queued delta: its snapshot already holds it.
  historyReply = { records: [record("Hello world", "running", T0 + 50)] };

  await act(async () => {
    await view.current.refreshHistory("s1");
  });
  assert.equal(view.current.records[0].answer, "Hello world", "snapshot wins over older text");

  // Now let any queued flush fire. If the snapshot were merged BEFORE the queue
  // was drained, the delta would append onto the snapshot's text instead of
  // being superseded by it — "Hello worldHel", with the answer shown twice.
  await act(async () => {
    await sleep(120);
  });
  assert.equal(view.current.records[0].answer, "Hello world", "queued delta was applied twice");
  assert.equal(view.current.records.length, 1);
});

test("deltas stream into a running record and stop once it settles", async () => {
  const view = mount();
  await applyFrames(view, [
    { type: "btw_record", record: record("") },
    { type: "btw_delta", recordId: "r1", delta: "4" },
  ]);
  assert.equal(view.current.records[0].answer, "4");

  // A settled turn is history, not a live stream: a late frame must not keep
  // appending to an answer the user has already read.
  await applyFrames(view, [
    { type: "btw_record", record: record("4", "complete", T0 + 10) },
    { type: "btw_delta", recordId: "r1", delta: " more" },
  ]);
  assert.equal(view.current.records[0].answer, "4", "a delta appended past a settled answer");
});

test("asking opens the panel and a follow-up answers in its own turn", async () => {
  const view = mount();
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    commands.push(body.type);
    if (body.type === "btw") return { ok: true, json: async () => ({ success: true, data: { record: record("4", "complete") } }) };
    return { ok: true, json: async () => ({ success: true, data: { records: [] } }) };
  };
  await act(async () => {
    assert.equal(await view.current.ask("s1", "2+2?", undefined), true);
  });
  assert.equal(view.current.activeId, "r1", "asking a new topic opens its panel");
  assert.equal(view.current.records[0].answer, "4");

  await applyFrames(view, [{
    type: "btw_record",
    record: {
      ...record("4", "complete", T0 + 10),
      followUps: [{ question: "and 3+3?", answer: "6", status: "complete", createdAt: T0 + 10, updatedAt: T0 + 10 }],
    },
  }]);
  const latest = view.current.records[0].followUps.at(-1);
  assert.equal(latest.answer, "6", "a follow-up answers in its own turn");
  assert.equal(view.current.records[0].answer, "4", "the first answer stays intact");
});

// LAST: `unsupportedUntil` is module-global by design (one old omp must not be
// re-asked by every other session in the tab), so this test poisons the rest.
test("a background history refresh pauses on an omp without btw", async () => {
  const view = mount();
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 400, json: async () => ({ error: "Unknown command: get_btw_history" }) };
  };
  await act(async () => {
    await view.current.refreshHistory("s1");
    await view.current.refreshHistory("s1");
  });
  // Once, then the UNSUPPORTED_RETRY_MS pause: every SSE connect fires this.
  assert.equal(calls, 1, "an old omp must not be re-asked on every reconnect");
});