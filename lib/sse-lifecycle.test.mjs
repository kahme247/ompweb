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
