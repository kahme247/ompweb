import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test from "node:test";

/** What the tab posts to the shared worker, and the port the worker answers on. */
const posted = [];
const port = { onmessage: null, start() {}, postMessage: (message) => posted.push(message) };
globalThis.SharedWorker = function SharedWorker() {
  return { port };
};

const { openEventStream, sendSessionCommand, uploadFile, UploadFailedError } = await import("./event-stream.ts");

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

test("bfcache pagehide rejects pending WS uploads; pageshow restores streams and permits Retry without HTTP fallback", async () => {
  const stream = openEventStream({ kind: "session", sessionId: "bfcache" });
  const subscription = posted.at(-1);
  port.onmessage({ data: { transport: "ws" } });
  port.onmessage({ data: { id: subscription.id, type: "open" } });
  const messages = [];
  stream.onmessage = ({ data }) => messages.push(data);
  const file = new File(["upload bytes"], "data.zip", { type: "application/zip" });
  const progress = [];
  const outcomes = [];
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    requests.push(args);
    return Response.json({ received: file.size });
  };
  const handles = [];
  try {
    for (const id of ["bfcache-a", "bfcache-b"]) {
      const handle = uploadFile(file, "local", (received) => progress.push(received), id);
      handles.push(handle);
      handle.promise.then(() => outcomes.push(null), (error) => outcomes.push(error));
    }
    port.onmessage({ data: { up: handles[0].id, received: 3, done: false } });
    assert.deepEqual(progress, [3]);

    window.dispatchEvent(new window.PageTransitionEvent("pagehide", { persisted: true }));
    assert.deepEqual(posted.at(-1), { op: "bye" }, "the worker still cleans up this tab");
    window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
    await Promise.resolve();

    assert.equal(outcomes.length, 2, "every retained upload promise must settle, not hang");
    for (const error of outcomes) {
      assert.ok(error instanceof UploadFailedError);
      assert.equal(error.code, "upload_failed");
      assert.match(error.message, /retry/i, "the chip must offer an actionable error");
    }
    assert.deepEqual(requests, [], "pagehide must not start a background HTTP upload");
    assert.deepEqual(posted.at(-1), subscription, "pageshow reopens the retained stream");
    assert.equal(stream.readyState, 0);
    port.onmessage({ data: { id: subscription.id, type: "open" } });
    port.onmessage({ data: { id: subscription.id, type: "message", data: "restored" } });
    assert.equal(stream.readyState, 1);
    assert.deepEqual(messages, ["restored"]);

    port.onmessage({ data: { up: handles[0].id, received: file.size, done: true } });
    assert.deepEqual(progress, [3], "the interrupted upload listener was forgotten");
    const retry = uploadFile(file, "local", (received) => progress.push(received), handles[0].id);
    assert.equal(posted.at(-1).op, "upload", "Retry still uses the retained WS transport");
    port.onmessage({ data: { up: retry.id, received: file.size, done: true } });
    await retry.promise;
    assert.deepEqual(progress, [3, file.size]);
    assert.deepEqual(requests, []);
  } finally {
    for (const handle of handles) handle.abort();
    stream.close();
    globalThis.fetch = originalFetch;
  }
});
