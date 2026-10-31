import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";

/** What the tab posts to the shared worker, and the port the worker answers on. */
const posted = [];
const port = { onmessage: null, start() {}, postMessage: (message) => posted.push(message) };
globalThis.SharedWorker = function SharedWorker() {
  return { port };
};

const { openEventStream, sendSessionCommand, transportMode } = await import("./event-stream.ts");

test("the tab wakes the worker with a stored client id and follows the worker's transport", () => {
  assert.equal(transportMode(), "sse", "SSE before any transport exists");
  openEventStream({ kind: "running" });

  const clientId = localStorage.getItem("omp-web:transport-client-id");
  assert.match(clientId, /^[a-z0-9]{8,}$/);
  assert.deepEqual(posted[0], { op: "wake", reason: "init", visible: true, clientId });

  window.dispatchEvent(new Event("online"));
  assert.deepEqual(posted.at(-1), { op: "wake", reason: "online", visible: true, clientId }, "the same id every time");

  assert.equal(transportMode(), "sse", "SSE until the worker says otherwise");
  port.onmessage({ data: { transport: "ws-pool" } });
  assert.equal(transportMode(), "ws-pool");
  port.onmessage({ data: { transport: "sse" } });
  assert.equal(transportMode(), "sse");
});

test("each ws-* mode routes commands through the worker; sse leaves them to fetch", () => {
  for (const mode of ["ws-client", "ws-session", "ws-pool"]) {
    port.onmessage({ data: { transport: mode } });
    assert.ok(sendSessionCommand("s1", `r-${mode}`, "{\"type\":\"get_state\"}", false) instanceof Promise, mode);
    assert.deepEqual(posted.at(-1), { op: "cmd", n: posted.at(-1).n, req: `r-${mode}`, sessionId: "s1", advisor: false, body: "{\"type\":\"get_state\"}" });
  }
  port.onmessage({ data: { transport: "sse" } });
  const asked = posted.length;
  assert.equal(sendSessionCommand("s1", "r-sse", "{}", false), null, "the caller POSTs it");
  assert.equal(posted.length, asked);
});
