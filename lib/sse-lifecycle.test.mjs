import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const singleSessionRoute = await jiti.import("../app/api/agent/[id]/events/route.ts");
const runningRoute = await jiti.import("../app/api/agent/running/events/route.ts");

/** One decoded SSE chunk, with a watchdog so a missing flush fails fast
 * instead of hanging the test runner. */
async function readChunk(reader, dec) {
  const r = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("read stalled: stream never delivered the expected chunk")), 2000)),
  ]);
  if (r.done) throw new Error("stream ended before all expected chunks were read");
  return dec.decode(r.value);
}

test("single-session SSE route cleans up and unsubscribes exactly once on abort / cancel", async () => {
  if (!globalThis.__ompSessions) globalThis.__ompSessions = new Map();

  let unsubscribeCount = 0;

  const mockSession = {
    isAlive: () => true,
    onEvent: () => {
      return () => {
        unsubscribeCount += 1;
      };
    },
  };

  globalThis.__ompSessions.set("test-sess-lifecycle", mockSession);

  try {
    const ac = new AbortController();
    const req = new Request("http://localhost/api/agent/test-sess-lifecycle/events", {
      signal: ac.signal,
    });

    const res = await singleSessionRoute.GET(req, {
      params: Promise.resolve({ id: "test-sess-lifecycle" }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.body);

    const reader = res.body.getReader();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    const text = new TextDecoder().decode(firstChunk.value);
    assert.ok(text.includes('"type":"connected"'));

    // Abort controller
    ac.abort();
    // And cancel reader (as browser would on navigation/close)
    await reader.cancel();

    assert.equal(unsubscribeCount, 1, "RPC event listener must be unsubscribed exactly once");
  } finally {
    globalThis.__ompSessions.delete("test-sess-lifecycle");
  }
});

test("running-sessions SSE route returns listener count to baseline after abort / cancel", async () => {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  const baselineListeners = globalThis.__ompRunningListeners.size;

  const ac = new AbortController();
  const req = new Request("http://localhost/api/agent/running/events", {
    signal: ac.signal,
  });

  const res = await runningRoute.GET(req);
  assert.equal(res.status, 200);
  assert.ok(res.body);

  const reader = res.body.getReader();
  const firstChunk = await reader.read();
  assert.equal(firstChunk.done, false);
  const text = new TextDecoder().decode(firstChunk.value);
  assert.ok(text.includes('"type":"running"'));

  // Inside the stream, listener was registered
  assert.equal(globalThis.__ompRunningListeners.size, baselineListeners + 1);

  // Abort and cancel
  ac.abort();
  await reader.cancel();

  assert.equal(
    globalThis.__ompRunningListeners.size,
    baselineListeners,
    "Running session listeners must return to baseline without leaks",
  );
});

test("source contract: SSE routes invoke unified cleanup on enqueue errors and separate closed from cleaned", async () => {
  const singleSrc = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const runningSrc = await readFile(new URL("../app/api/agent/running/events/route.ts", import.meta.url), "utf8");

  // Single-session SSE contract
  assert.ok(singleSrc.includes("let closed = false;"), "must track closed state");
  assert.ok(singleSrc.includes("let cleaned = false;"), "must track cleaned state");
  assert.ok(singleSrc.includes("if (cleaned) return;"), "cleanup guard must check cleaned, not closed");
  assert.ok(!singleSrc.includes("catch {\n          closed = true;\n        }"), "write catch must not merely set closed=true without cleanup");

  // Running SSE contract
  assert.ok(runningSrc.includes("let closed = false;"), "must track closed state");
  assert.ok(runningSrc.includes("let cleaned = false;"), "must track cleaned state");
  assert.ok(runningSrc.includes("if (cleaned) return;"), "cleanup guard must check cleaned, not closed");
  assert.ok(runningSrc.includes("const encoder = new TextEncoder();"), "must reuse TextEncoder instance");
});

test("slow consumer receives coalesced message_update on resume without a new event or heartbeat", { timeout: 5000 }, async () => {
  if (!globalThis.__ompSessions) globalThis.__ompSessions = new Map();

  let emitter;
  globalThis.__ompSessions.set("test-sess-resume", {
    isAlive: () => true,
    onEvent: (fn) => {
      emitter = fn;
      return () => {};
    },
  });

  try {
    const req = new Request("http://localhost/api/agent/test-sess-resume/events");
    const res = await singleSessionRoute.GET(req, {
      params: Promise.resolve({ id: "test-sess-resume" }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.ok(dec.decode(first.value).includes('"type":"connected"'));

      // Consumer is now stalled (no pending read). Emit three message_update
      // frames: the first two fill the internal queue (desiredSize drops below
      // zero), the third is coalesced into pendingUpdate. Nothing but a
      // resumed pull() can deliver it — no heartbeat yet, no new event.
      emitter({ type: "message_update", message: { id: "m1", content: "v1" } });
      emitter({ type: "message_update", message: { id: "m1", content: "v2" } });
      emitter({ type: "message_update", message: { id: "m1", content: "v3" } });

      // Resume reading. Reads 1-2 drain the queued v1/v2; reading v2 empties
      // the queue, desiredSize becomes positive, pull() runs and must flush
      // the pending v3 into the queue for read 3.
      const chunks = [];
      for (let i = 0; i < 3; i++) {
        const r = await Promise.race([
          reader.read(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("read stalled: pending update never flushed by pull()")), 2000),
          ),
        ]);
        if (r.done) break;
        chunks.push(dec.decode(r.value));
      }
      const received = chunks.join("");
      assert.ok(received.includes('"content":"v1"'), "first snapshot queued before backpressure");
      assert.ok(received.includes('"content":"v3"'), "latest snapshot must be flushed on resume");
      assert.equal(
        received.match(/"content":"v3"/g)?.length ?? 0,
        1,
        "pull() flush must not duplicate the snapshot",
      );
    } finally {
      await reader.cancel();
    }
  } finally {
    globalThis.__ompSessions.delete("test-sess-resume");
  }
});

test("multiple coalesced updates collapse to the latest snapshot (latest-wins)", { timeout: 5000 }, async () => {
  if (!globalThis.__ompSessions) globalThis.__ompSessions = new Map();

  let emitter;
  globalThis.__ompSessions.set("test-sess-latest", {
    isAlive: () => true,
    onEvent: (fn) => {
      emitter = fn;
      return () => {};
    },
  });

  try {
    const req = new Request("http://localhost/api/agent/test-sess-latest/events");
    const res = await singleSessionRoute.GET(req, {
      params: Promise.resolve({ id: "test-sess-latest" }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      await readChunk(reader, dec); // "connected"

      // v1/v2 fill the internal queue; v3 lands in the pending slot; v4
      // REPLACES v3 there. The consumer must see the latest snapshot only —
      // the superseded one must never be delivered.
      emitter({ type: "message_update", message: { id: "m3", content: "v1" } });
      emitter({ type: "message_update", message: { id: "m3", content: "v2" } });
      emitter({ type: "message_update", message: { id: "m3", content: "v3" } });
      emitter({ type: "message_update", message: { id: "m3", content: "v4" } });

      const chunks = [];
      for (let i = 0; i < 3; i++) chunks.push(await readChunk(reader, dec));
      const received = chunks.join("");
      assert.ok(received.includes('"content":"v1"'), "first snapshot queued before backpressure");
      assert.ok(received.includes('"content":"v2"'), "second snapshot queued before backpressure");
      assert.ok(received.includes('"content":"v4"'), "latest snapshot must win the pending slot");
      assert.equal(
        received.includes('"content":"v3"'),
        false,
        "superseded snapshot must never reach the consumer",
      );
    } finally {
      await reader.cancel();
    }
  } finally {
    globalThis.__ompSessions.delete("test-sess-latest");
  }
});

test("terminal event flushes the buffered update first and arrives last, in order", { timeout: 5000 }, async () => {
  if (!globalThis.__ompSessions) globalThis.__ompSessions = new Map();

  let emitter;
  globalThis.__ompSessions.set("test-sess-terminal", {
    isAlive: () => true,
    onEvent: (fn) => {
      emitter = fn;
      return () => {};
    },
  });

  try {
    const req = new Request("http://localhost/api/agent/test-sess-terminal/events");
    const res = await singleSessionRoute.GET(req, {
      params: Promise.resolve({ id: "test-sess-terminal" }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    try {
      await readChunk(reader, dec); // "connected"

      // Backpressured: v1/v2 queue up, v3 sits in the pending slot. The
      // terminal event must flush v3 BEFORE itself so the client applies the
      // final message snapshot before the run is marked complete.
      emitter({ type: "message_update", message: { id: "m4", content: "v1" } });
      emitter({ type: "message_update", message: { id: "m4", content: "v2" } });
      emitter({ type: "message_update", message: { id: "m4", content: "v3" } });
      emitter({ type: "agent_end", isTerminal: true });

      const order = [];
      for (let i = 0; i < 4; i++) {
        const text = await readChunk(reader, dec);
        for (const m of text.matchAll(/"type":"(message_update|agent_end)"/g)) order.push(m[1]);
      }
      assert.deepEqual(
        order,
        ["message_update", "message_update", "message_update", "agent_end"],
        "buffered snapshot must precede the terminal event, never the reverse",
      );
    } finally {
      await reader.cancel();
    }
  } finally {
    globalThis.__ompSessions.delete("test-sess-terminal");
  }
});

test("backpressured disconnect during pending update cleans up and drops nothing after cancel", async () => {
  if (!globalThis.__ompSessions) globalThis.__ompSessions = new Map();

  let emitter;
  let unsubscribeCount = 0;
  globalThis.__ompSessions.set("test-sess-disconnect", {
    isAlive: () => true,
    onEvent: (fn) => {
      emitter = fn;
      return () => {
        unsubscribeCount += 1;
      };
    },
  });

  try {
    const ac = new AbortController();
    const req = new Request("http://localhost/api/agent/test-sess-disconnect/events", {
      signal: ac.signal,
    });
    const res = await singleSessionRoute.GET(req, {
      params: Promise.resolve({ id: "test-sess-disconnect" }),
    });
    const reader = res.body.getReader();
    try {
      await reader.read(); // consume "connected"

      // Stall, emit updates so one lands in pendingUpdate, then abort mid-buffer.
      emitter({ type: "message_update", message: { id: "m2", content: "v1" } });
      emitter({ type: "message_update", message: { id: "m2", content: "v2" } });
      emitter({ type: "message_update", message: { id: "m2", content: "v3" } });
      ac.abort();
    } finally {
      await reader.cancel();
    }

    // Cleanup must be idempotent: abort path and cancel path both ran.
    assert.equal(unsubscribeCount, 1, "unsubscribe must fire exactly once across abort+cancel");
  } finally {
    globalThis.__ompSessions.delete("test-sess-disconnect");
  }
});
