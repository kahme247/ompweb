import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";

/** What the tab posts to the shared worker, and the port the worker answers on. */
const posted = [];
const port = { onmessage: null, start() {}, postMessage: (message) => posted.push(message) };
globalThis.SharedWorker = function SharedWorker() {
  return { port };
};

const { openEventStream, sendSessionCommand } = await import("./event-stream.ts");

test("the tab wakes the worker with a stored client id and follows the worker's transport", () => {
  assert.equal(sendSessionCommand("s1", "unused", "{}", false, ""), null, "SSE before any transport exists");
  openEventStream({ kind: "running" });

  const clientId = localStorage.getItem("omp-web:transport-client-id");
  assert.match(clientId, /^[a-z0-9]{8,}$/);
  assert.deepEqual(posted[0], { op: "wake", reason: "init", visible: true, clientId });

  window.dispatchEvent(new Event("online"));
  assert.deepEqual(posted.at(-1), { op: "wake", reason: "online", visible: true, clientId }, "the same id every time");

  assert.equal(sendSessionCommand("s1", "unused", "{}", false, ""), null, "SSE until the worker says otherwise");
});

test("ws routes commands through the worker; sse, or a mode this tab does not know, leaves them to fetch", () => {
  port.onmessage({ data: { transport: "ws" } });
  assert.ok(sendSessionCommand("s1", "r-ws", "{\"type\":\"get_state\"}", false, "get_state") instanceof Promise);
  assert.deepEqual(posted.at(-1), { op: "cmd", n: posted.at(-1).n, req: "r-ws", sessionId: "s1", advisor: false, body: "{\"type\":\"get_state\"}", type: "get_state" });
  port.onmessage({ data: { transport: "ws-pool" } });
  assert.equal(sendSessionCommand("s1", "r-old", "{}", false, ""), null);
  port.onmessage({ data: { transport: "sse" } });
  const asked = posted.length;
  assert.equal(sendSessionCommand("s1", "r-sse", "{}", false, ""), null, "the caller POSTs it");
  assert.equal(posted.length, asked);
});
