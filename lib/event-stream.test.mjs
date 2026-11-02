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
    await new Promise((resolve) => setTimeout(resolve, 0));

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

/** Answers each fetch with the next reply (a Response, or an Error to throw), recording method and URL. */
function scriptedFetch(t, replies) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push(`${init.method ?? "GET"} ${url}`);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply ?? Response.json({ error: "unexpected request" }, { status: 500 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return requests;
}

test("over HTTP, a host offline and a dropped web server resume by themselves from the host's offset", async (t) => {
  port.onmessage({ data: { transport: "sse" } });
  const file = new File(["0123456789"], "data.bin");
  const requests = scriptedFetch(t, [
    Response.json({ error: "The host is offline", code: "host_offline", hostOffline: true }, { status: 503 }),
    Response.json({ received: 0 }),
    new TypeError("Failed to fetch"),
    Response.json({ received: 4 }),
    Response.json({ received: 10 }),
  ]);
  const progress = [];
  const reconnecting = [];
  const handle = uploadFile(file, "local", (received) => progress.push(received), "auto-http", (error) => reconnecting.push(error?.code ?? error?.name ?? null));
  await handle.promise;
  assert.deepEqual(requests, [
    "POST /api/uploads",
    "POST /api/uploads",
    "PUT /api/uploads/auto-http?offset=0",
    "POST /api/uploads",
    "PUT /api/uploads/auto-http?offset=4",
  ]);
  assert.deepEqual(progress, [0, 4, 10]);
  assert.deepEqual(reconnecting, ["host_offline", null, "TypeError", null], "the chip shows the wait, then clears it");
});

test("over the browser link, a stalled upload starts again by itself; a refusal and a removal do not", async (t) => {
  port.onmessage({ data: { transport: "ws" } });
  // The retry after the second stall goes out over HTTP: the transport changed while it waited.
  const requests = scriptedFetch(t, [Response.json({ received: 4 }), Response.json({ received: 10 })]);
  const file = new File(["0123456789"], "data.bin");
  const starts = () => posted.filter((message) => message.op === "upload" && message.id === "auto-ws").length;
  const handle = uploadFile(file, "local", () => {}, "auto-ws");
  assert.equal(starts(), 1);
  port.onmessage({ data: { up: "auto-ws", error: { status: 504, code: "upload_stalled", message: "stalled" } } });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(starts(), 2, "the same id starts again after the first back-off");
  port.onmessage({ data: { up: "auto-ws", error: { status: 504, code: "upload_stalled", message: "stalled" } } });
  port.onmessage({ data: { transport: "sse" } });
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  await handle.promise;
  assert.equal(starts(), 2, "no third start over the link");
  assert.deepEqual(requests.splice(0), ["POST /api/uploads", "PUT /api/uploads/auto-ws?offset=4"]);
  port.onmessage({ data: { transport: "ws" } });

  const refused = uploadFile(file, "local", () => {}, "auto-ws-refused");
  port.onmessage({ data: { up: "auto-ws-refused", error: { status: 409, code: "upload_id_conflict", message: "conflict" } } });
  await assert.rejects(refused.promise, (error) => error.code === "upload_id_conflict");

  const removed = uploadFile(file, "local", () => {}, "auto-ws-removed");
  const removedOutcome = removed.promise.catch((error) => error);
  port.onmessage({ data: { up: "auto-ws-removed", error: { status: 503, code: "host_offline", message: "offline" } } });
  removed.abort();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal((await removedOutcome).code, "host_offline", "a removal ends the wait (the chip ignores it)");
  assert.equal(posted.filter((message) => message.op === "upload" && message.id === "auto-ws-removed").length, 1, "a removed chip never starts again");
  assert.ok(posted.some((message) => message.op === "up_abort" && message.id === "auto-ws-removed"), "the host drops what it staged");
  assert.deepEqual(requests, []);
});

test("removing a chip that waits to resume after the transport switched to SSE deletes it over HTTP", async (t) => {
  port.onmessage({ data: { transport: "ws" } });
  const requests = scriptedFetch(t, [new Response(null, { status: 204 })]);
  const file = new File(["0123456789"], "data.bin");
  const handle = uploadFile(file, "local", () => {}, "abort-after-switch");
  const outcome = handle.promise.catch((error) => error);
  port.onmessage({ data: { up: "abort-after-switch", error: { status: 503, code: "host_offline", message: "offline" } } });
  // Another tab moves the worker to SSE while this upload waits: its link is gone, so an up_abort would be dropped.
  port.onmessage({ data: { transport: "sse" } });
  const before = posted.length;
  handle.abort();
  await outcome;
  assert.deepEqual(requests, ["DELETE /api/uploads/abort-after-switch"]);
  assert.equal(posted.slice(before).some((message) => message.op === "up_abort"), false);
  port.onmessage({ data: { transport: "ws" } });
});

test("a suspended reconnect back-off never starts another attempt after the outage deadline", async (t) => {
  port.onmessage({ data: { transport: "ws" } });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const handle = uploadFile(new File(["bytes"], "data.bin"), "local", () => {}, "expired-backoff");
  let failure;
  const outcome = handle.promise.catch((error) => { failure = error; });
  try {
    port.onmessage({ data: { up: handle.id, error: { status: 503, code: "host_offline", message: "offline" } } });
    await new Promise((resolve) => setImmediate(resolve));
    // The page slept through its timer and wakes at the deadline.
    t.mock.timers.tick(300_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posted.filter((message) => message.op === "upload" && message.id === handle.id).length, 1, "no start after the deadline");
    assert.equal(failure?.code, "host_offline", "the chip offers Retry instead of staying pending");
    await outcome;
  } finally {
    handle.abort();
  }
});

test("the back-off steps up per outage, restarts after new bytes, and ends at five minutes", async (t) => {
  port.onmessage({ data: { transport: "sse" } });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const file = new File(["0123456789"], "data.bin");
  const offline = () => Response.json({ error: "offline", code: "host_offline" }, { status: 503 });
  // POSTs answer `next` (offline unless set); a PUT waits for the test to release it, then reports 4 bytes.
  let next = null;
  let releasePut;
  const at = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    at.push(`${init.method} ${Date.now()}`);
    if (init.method === "PUT") {
      await new Promise((resolve) => { releasePut = resolve; });
      throw new TypeError("Failed to fetch");
    }
    const reply = next ?? offline();
    next = null;
    return reply;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const tickTo = async (ms) => {
    t.mock.timers.tick(ms - Date.now());
    await settle();
  };

  const handle = uploadFile(file, "local", () => {}, "backoff");
  let failure;
  const outcome = handle.promise.then(() => null, (error) => { failure = error; return error; });
  await settle();
  // Offline from the start: 1, 2, 5 s apart.
  for (const ms of [1_000, 3_000, 8_000]) await tickTo(ms);
  assert.deepEqual(at, ["POST 0", "POST 1000", "POST 3000", "POST 8000"]);

  // The host acknowledges real bytes; the next failure starts a fresh outage and back-off.
  next = Response.json({ received: 4 });
  await tickTo(18_000);
  assert.deepEqual(at.slice(4), ["POST 18000", "PUT 18000"]);
  releasePut();
  await settle();
  await tickTo(19_000);
  assert.equal(at.at(-1), "POST 19000", "back to the first step after acknowledged bytes advance");

  // An outage expires during back-off: it offers Retry at the deadline without dispatching a last request.
  const outageAt = 18_000;
  const deadline = outageAt + 300_000;
  while (Date.now() < deadline - 1) await tickTo(Math.min(Date.now() + 15_000, deadline - 1));
  assert.equal(failure, undefined, "resumes until the outage deadline");
  await tickTo(deadline);
  assert.equal(failure?.code, "host_offline", "settles at the deadline instead of leaving the chip reconnecting");
  await outcome;
  assert.ok(Number(at.at(-1).split(" ")[1]) < deadline, "no request starts at or beyond the deadline");
  const attempts = at.length;
  await tickTo(deadline + 60_000);
  assert.equal(at.length, attempts, "nothing after giving up");
});

for (const acknowledged of [null, "body", 0, 4]) {
  test(`an HTTP retry pending ${acknowledged === null ? "before headers" : acknowledged === "body" ? "inside the response body" : `after acknowledging ${acknowledged} bytes`} expires on its remaining deadline`, async (t) => {
    port.onmessage({ data: { transport: "sse" } });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const originalFetch = globalThis.fetch;
    const requests = [];
    let pendingSignal;
    let failure;
    globalThis.fetch = async (url, init) => {
      requests.push(`${init.method} ${url}`);
      if (requests.length === 1) return Response.json({ error: "offline", code: "host_offline" }, { status: 503 });
      if (acknowledged === "body") {
        pendingSignal = init.signal;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"received":'));
            init.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
          },
        }));
      }
      if (requests.length === 2 && acknowledged !== null) return Response.json({ received: acknowledged });
      pendingSignal = init.signal;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const handle = uploadFile(new File(["0123456789"], "data.bin"), "local", () => {}, `pending-${acknowledged}`);
    const outcome = handle.promise.catch((error) => { failure = error; });
    t.after(() => handle.abort());
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    await settle();
    t.mock.timers.tick(1_000);
    await settle();
    assert.ok(pendingSignal);
    // A zero offset is not new data; only an acknowledged byte advance resets the deadline.
    const deadline = acknowledged > 0 ? 301_000 : 300_000;
    t.mock.timers.tick(deadline - 1_001);
    await settle();
    assert.equal(failure, undefined);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(pendingSignal.aborted, true, "the timed-out HTTP request stops");
    assert.equal(failure?.code, "upload_stalled", "the composer gets a terminal failure and can offer Retry");
    await outcome;
    assert.equal(requests.some((request) => request.startsWith("DELETE")), false, "expiry keeps staged bytes");
  });
}

test("an HTTP response-body network failure resumes from the host offset instead of failing with HTTP 200", async (t) => {
  port.onmessage({ data: { transport: "sse" } });
  const brokenBody = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"received":'));
      controller.error(new TypeError("Connection closed while reading the body"));
    },
  }));
  const requests = scriptedFetch(t, [
    Response.json({ received: 0 }),
    brokenBody,
    Response.json({ received: 4 }),
    Response.json({ received: 10 }),
  ]);
  const progress = [];
  await uploadFile(new File(["0123456789"], "data.bin"), "local", (received) => progress.push(received), "broken-body").promise;
  assert.deepEqual(requests, [
    "POST /api/uploads", "PUT /api/uploads/broken-body?offset=0",
    "POST /api/uploads", "PUT /api/uploads/broken-body?offset=4",
  ]);
  assert.deepEqual(progress, [0, 4, 10]);
});

test("a WebSocket retry expires without deleting its staged bytes, and manual Retry can finish", async (t) => {
  port.onmessage({ data: { transport: "ws" } });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const progress = [];
  const file = new File(["012345"], "data.bin");
  const handle = uploadFile(file, "local", (received) => progress.push(received), "pending-ws");
  let failure;
  const outcome = handle.promise.catch((error) => { failure = error; });
  port.onmessage({ data: { up: handle.id, error: { status: 503, code: "host_offline", message: "offline" } } });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1_000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(299_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure?.code, "upload_stalled");
  await outcome;
  assert.ok(posted.some((message) => message.op === "up_pause" && message.id === handle.id));
  assert.equal(posted.some((message) => message.op === "up_abort" && message.id === handle.id), false);
  port.onmessage({ data: { up: handle.id, received: 3, done: false } });
  assert.deepEqual(progress, [], "a late ack cannot revive the expired attempt");
  const retry = uploadFile(file, "local", (received) => progress.push(received), handle.id);
  port.onmessage({ data: { up: retry.id, received: 3, done: false } });
  port.onmessage({ data: { up: retry.id, received: 6, done: true } });
  await retry.promise;
  assert.deepEqual(progress, [3, 6]);
});

test("a suspended tab's silence before its first failure does not consume the outage budget", async (t) => {
  port.onmessage({ data: { transport: "sse" } });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const originalFetch = globalThis.fetch;
  let failFirst;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) return new Promise((resolve, reject) => { failFirst = reject; });
    return Response.json({ received: 10 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const progress = [];
  const handle = uploadFile(new File(["0123456789"], "data.bin"), "local", (received) => progress.push(received), "sleep-before-failure");
  t.mock.timers.tick(600_000);
  failFirst(new TypeError("Connection dropped on wake"));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1_000);
  await handle.promise;
  assert.equal(requests, 2);
  assert.deepEqual(progress, [10]);
});
