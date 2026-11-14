import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { fakeIndexedDB } from "../tests/fake-indexeddb.mjs";

// Runs public/sw.js against a fake worker scope. Messages are cloned as
// postMessage does, which also drops the vm realm.
function loadWorker(windows = [], globals = {}) {
  const listeners = {};
  const shown = [];
  const self = {
    addEventListener: (type, listener) => { listeners[type] = listener; },
    skipWaiting() {},
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: { claim: async () => {}, matchAll: async () => windows },
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    self, URL, setTimeout, clearTimeout, AbortController, ...globals,
  });
  return {
    shown,
    message: (event) => listeners.message(event),
    push: async (payload) => {
      let done;
      listeners.push({ data: payload === undefined ? null : { json: () => payload }, waitUntil: (promise) => { done = promise; } });
      await done;
    },
    sync: async () => {
      let pending;
      listeners.sync({ tag: "omp-outbox", waitUntil: (promise) => { pending = promise; } });
      await pending;
    },
  };
}

test("a shown push is reported to every open tab with its kind, text and session", async () => {
  const messages = [];
  const tab = (name) => ({ postMessage: (message) => messages.push([name, structuredClone(message)]) });
  const worker = loadWorker([tab("a"), tab("b")]);
  await worker.push({ type: "error", title: "Fix bug", body: "Run failed", tag: "s1:error", sessionId: "s1", url: "/?session=s1" });
  assert.equal(worker.shown[0].title, "Fix bug");
  const notification = { type: "error", title: "Fix bug", body: "Run failed", tag: "s1:error", sessionId: "s1" };
  assert.deepEqual(messages, [["a", { type: "omp-notification-shown", notification }], ["b", { type: "omp-notification-shown", notification }]]);
});

test("an unreadable push still shows a notification and reports it as info", async () => {
  const messages = [];
  const worker = loadWorker([{ postMessage: (message) => messages.push(structuredClone(message)) }]);
  await worker.push(undefined);
  assert.equal(worker.shown[0].title, "omp web");
  assert.deepEqual(messages[0].notification, { type: "info", title: "omp web", body: "", tag: "", sessionId: "" });
});

const outboxEntry = (id, sessionId = "session") => ({
  id, sessionId, scope: "original-installation", mode: "prompt",
  message: "Keep this message", state: "sending", createdAt: Date.now(),
});
const flush = () => new Promise((resolve) => setImmediate(resolve));
const accepted = { success: true, data: { entry: { id: "accepted", sessionId: "canonical", mode: "prompt", message: "Stored on server", state: "held", createdAt: 1 } } };

test("the active service worker explicitly reports its outbox capability", () => {
  const worker = loadWorker();
  const replies = [];
  worker.message({ data: { type: "omp-outbox-capability" }, ports: [{ postMessage: (reply) => replies.push(structuredClone(reply)) }] });
  assert.deepEqual(replies, [{ type: "omp-outbox-capability", version: 2 }]);
});

test("Background Sync accepts a matching delivered tombstone with an empty message", async () => {
  const indexedDB = fakeIndexedDB();
  indexedDB.entries.set("accepted", outboxEntry("accepted"));
  const tombstone = { success: true, data: { entry: { id: "accepted", sessionId: "canonical-session", mode: "prompt", message: "", state: "delivered", createdAt: 1, images: [], uploads: [], error: "", mayHaveBeenSent: false } } };
  const worker = loadWorker([], { indexedDB, fetch: async () => ({ status: 200, json: async () => tombstone }) });
  await worker.sync();
  assert.equal(indexedDB.entries.size, 0);
});

test("Background Sync flattens legacy retry chains and atomically retires same-session siblings", async () => {
  const indexedDB = fakeIndexedDB();
  const root = { ...outboxEntry("sw-root"), state: "failed", uploads: ["same-file"], uploadProofs: { "same-file": "same-proof" } };
  const refused = { ...outboxEntry("sw-refused"), state: "failed", replaces: root.id, uploads: root.uploads, uploadProofs: root.uploadProofs };
  const copy = { ...outboxEntry("sw-copy"), replaces: refused.id, uploads: root.uploads, uploadProofs: root.uploadProofs };
  const sibling = { ...outboxEntry("sw-sibling"), state: "failed", replaces: root.id, uploads: root.uploads, uploadProofs: root.uploadProofs };
  const otherSession = { ...outboxEntry("sw-other-session", "other"), state: "failed", replaces: root.id, uploads: ["other-file"], uploadProofs: { "other-file": "other-proof" } };
  const unrelated = { ...outboxEntry("sw-unrelated"), state: "failed", uploads: ["unrelated-file"], uploadProofs: { "unrelated-file": "unrelated-proof" } };
  for (const entry of [root, refused, copy, sibling, otherSession, unrelated]) indexedDB.entries.set(entry.id, entry);
  const bodies = [];
  const worker = loadWorker([], {
    indexedDB,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const stored = indexedDB.entries.get(body.id);
      return { status: 200, json: async () => ({ success: true, data: { entry: {
        id: body.id, sessionId: stored.sessionId, mode: body.mode, message: stored.message, state: "held", createdAt: stored.createdAt,
        ...(stored.uploads ? { uploads: stored.uploads } : {}), replaces: body.replaces,
      } } }) };
    },
  });
  await worker.sync();

  assert.deepEqual(bodies.map(({ id, replaces }) => [id, replaces]), [["sw-copy", "sw-root"]]);
  assert.deepEqual(bodies[0].uploadProofs, root.uploadProofs, "flattening does not strip or re-prove attachments");
  assert.deepEqual([...indexedDB.entries.keys()].sort(), ["sw-other-session", "sw-unrelated"]);
  assert.deepEqual(indexedDB.entries.get("sw-other-session").uploadProofs, { "other-file": "other-proof" });
  assert.deepEqual(indexedDB.entries.get("sw-unrelated").uploadProofs, { "unrelated-file": "unrelated-proof" });
});

test("Background Sync keeps missing and cross-session ancestors as independent server references", async () => {
  const indexedDB = fakeIndexedDB();
  const root = { ...outboxEntry("sw-cross-root"), state: "failed" };
  const crossSession = { ...outboxEntry("sw-cross-copy", "other"), replaces: root.id };
  const missing = { ...outboxEntry("sw-missing-copy", "third"), replaces: "server-only-root" };
  for (const entry of [root, crossSession, missing]) indexedDB.entries.set(entry.id, entry);
  const bodies = [];
  const worker = loadWorker([], {
    indexedDB,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      const stored = indexedDB.entries.get(body.id);
      return { status: 200, json: async () => ({ success: true, data: { entry: {
        id: body.id, sessionId: stored.sessionId, mode: body.mode, message: stored.message, state: "held", createdAt: stored.createdAt,
      } } }) };
    },
  });
  await worker.sync();

  assert.deepEqual(bodies.map(({ id, replaces }) => [id, replaces]), [
    ["sw-cross-copy", "sw-cross-root"],
    ["sw-missing-copy", "server-only-root"],
  ]);
  assert.deepEqual([...indexedDB.entries.keys()], ["sw-cross-root"], "unconfirmed roots are not deleted with independent copies");
});

test("Background Sync fails a persisted cyclic retry chain without sending it", async () => {
  const indexedDB = fakeIndexedDB();
  indexedDB.entries.set("sw-cycle-a", { ...outboxEntry("sw-cycle-a"), state: "failed", replaces: "sw-cycle-b" });
  indexedDB.entries.set("sw-cycle-b", { ...outboxEntry("sw-cycle-b"), replaces: "sw-cycle-a" });
  let requests = 0;
  const worker = loadWorker([], { indexedDB, fetch: async () => { requests++; return { status: 503, json: async () => ({}) }; } });
  await worker.sync();

  assert.equal(requests, 0);
  assert.equal(indexedDB.entries.get("sw-cycle-b").state, "failed");
  assert.match(indexedDB.entries.get("sw-cycle-b").error, /retry chain is invalid/);
});
test("upload continuity: restarted Background Sync authorizes persisted uploads without losing its unconfirmed head", async () => {
  const indexedDB = fakeIndexedDB();
  const proof = "background-completion-proof";
  indexedDB.entries.set("proof-first", {
    ...outboxEntry("proof-first"), enqueueOrder: 1,
    uploads: ["completed-upload"], uploadProofs: { "completed-upload": proof },
  });
  indexedDB.entries.set("proof-later", { ...outboxEntry("proof-later"), enqueueOrder: 2 });
  const firstRequests = [];
  const interrupted = loadWorker([], { indexedDB, fetch: async (_url, options) => {
    firstRequests.push(JSON.parse(options.body).id);
    return { status: 200, json: async () => ({ success: true }) };
  } });
  await assert.rejects(interrupted.sync(), /entries left to send/);
  assert.deepEqual(firstRequests, ["proof-first"], "an unconfirmed head still blocks later messages");
  assert.equal(indexedDB.entries.get("proof-first").uploadProofs["completed-upload"], proof);

  const requests = [];
  const restarted = loadWorker([], { indexedDB, fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body.id);
    if (body.id === "proof-first" && (body.uploads?.[0] !== "completed-upload" || body.uploadProofs?.["completed-upload"] !== proof)) {
      return { status: 403, json: async () => ({ error: "Upload belongs to the previous login" }) };
    }
    if (body.id === "proof-later") return { status: 503, json: async () => ({}) };
    return { status: 200, json: async () => ({
      success: true, data: { entry: { id: "proof-first", sessionId: "session", mode: "prompt", message: "Keep this message", uploads: ["completed-upload"], state: "held", createdAt: 1 } },
    }) };
  } });
  await assert.rejects(restarted.sync(), /entries left to send/);
  assert.deepEqual(requests, ["proof-first", "proof-later"]);
  assert.equal(indexedDB.entries.has("proof-first"), false, "the restarted sync command must carry authority for the completed file");
  assert.equal(indexedDB.entries.has("proof-later"), true);
});

for (const reply of [
  null, { ok: true }, { success: true }, "login HTML",
  { success: true, data: { entry: { id: "unconfirmed", state: "held" } } },
  ...[
    { id: "wrong-id" }, { state: "unknown" }, { sessionId: "" }, { mode: "unknown" }, { message: null }, { createdAt: NaN },
    { images: {} }, { images: [{ type: "image", data: "abc" }] }, { uploads: "not-an-array" }, { uploads: [17] },
    { error: {} }, { mayHaveBeenSent: "yes" },
  ].map((invalid) => ({ success: true, data: { entry: { ...accepted.data.entry, id: "unconfirmed", ...invalid } } })),
]) {
  test(`Background Sync preserves an unconfirmed 200 and blocks only its own session (${JSON.stringify(reply)})`, async () => {
    const indexedDB = fakeIndexedDB();
    const entries = [
      { ...outboxEntry("unconfirmed"), enqueueOrder: 1 },
      { ...outboxEntry("later"), enqueueOrder: 2 },
      { ...outboxEntry("accepted", "other-session"), enqueueOrder: 3 },
    ];
    for (const entry of entries) indexedDB.entries.set(entry.id, entry);
    const requests = [];
    const worker = loadWorker([], { indexedDB, fetch: async (_url, options) => {
      const { id } = JSON.parse(options.body);
      requests.push(id);
      return { status: 200, json: async () => {
        if (id === "accepted") return accepted;
        if (typeof reply === "string") throw new SyntaxError("HTML is not JSON");
        return reply;
      } };
    } });
    await assert.rejects(worker.sync(), /entries left to send/);
    assert.deepEqual(requests, ["unconfirmed", "accepted"]);
    assert.deepEqual([...indexedDB.entries.keys()], ["unconfirmed", "later"]);
  });
}

test("Background Sync uses durable enqueue order rather than primary-key or timestamp order", async () => {
  const indexedDB = fakeIndexedDB();
  const first = { ...outboxEntry("z-first"), enqueueOrder: 1 };
  const second = { ...outboxEntry("a-second"), enqueueOrder: 2 };
  for (const entry of [second, first]) indexedDB.entries.set(entry.id, entry);
  const requests = [];
  const worker = loadWorker([], { indexedDB, fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body).id);
    return { status: 503, json: async () => ({}) };
  } });
  await assert.rejects(worker.sync());
  assert.deepEqual(requests, ["z-first"]);
});

for (const [label, stale] of [
  ["expired", { createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }],
  ["unscoped", { scope: undefined }],
]) test(`Background Sync marks an ${label} head not sent and still delivers the session's later entry`, async () => {
  const indexedDB = fakeIndexedDB();
  const head = { ...outboxEntry("stale-head"), ...stale, enqueueOrder: 1 };
  const later = { ...outboxEntry("accepted"), enqueueOrder: 2 };
  for (const entry of [head, later]) indexedDB.entries.set(entry.id, entry);
  const requests = [];
  const worker = loadWorker([], { indexedDB, fetch: async (_url, options) => {
    requests.push(JSON.parse(options.body).id);
    return { status: 200, json: async () => accepted };
  } });
  await worker.sync();
  assert.deepEqual(requests, ["accepted"], "the stale head is never sent, and it no longer blocks the next one");
  assert.equal(indexedDB.entries.has("accepted"), false);
  const saved = indexedDB.entries.get("stale-head");
  assert.equal(saved.state, "failed");
  assert.equal(saved.scope, head.scope, "a stale row is never rebound to the current scope");
});

for (const abort of [false, true]) test(`Background Sync awaits deletion commit${abort ? " and rejects an aborted commit" : ""}`, async () => {
  const indexedDB = fakeIndexedDB();
  const entry = outboxEntry("accepted");
  indexedDB.entries.set(entry.id, entry);
  const worker = loadWorker([], { indexedDB, fetch: async () => {
    indexedDB.hold = true;
    return { status: 200, json: async () => accepted };
  } });
  let settled = false;
  const syncing = worker.sync().then(() => { settled = true; });
  const result = abort ? assert.rejects(syncing) : syncing;
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(indexedDB.entries.get(entry.id), entry);
  indexedDB.failWrites = abort;
  indexedDB.hold = false;
  indexedDB.release();
  await result;
  assert.equal(indexedDB.entries.has(entry.id), abort);
});

test("Background Sync commits a permanent refusal as failed without rebinding its scope", async () => {
  const indexedDB = fakeIndexedDB();
  const entry = outboxEntry("scope-changed");
  indexedDB.entries.set(entry.id, entry);
  const worker = loadWorker([], {
    indexedDB,
    fetch: async () => {
      indexedDB.hold = true;
      return { status: 409, json: async () => ({ error: "Installation scope changed", code: "outbox_scope_changed" }) };
    },
  });
  let settled = false;
  const syncing = worker.sync().then(() => { settled = true; });
  await flush();
  assert.equal(settled, false, "the sync waits for its durable failure transition");
  assert.deepEqual(indexedDB.entries.get(entry.id), entry, "no change before commit");
  indexedDB.hold = false;
  indexedDB.release();
  await syncing;
  const saved = indexedDB.entries.get(entry.id);
  assert.equal(saved.state, "failed");
  assert.equal(saved.scope, entry.scope, "a refusal never binds old data to new credentials");
  assert.equal(saved.message, entry.message);
});

test("a late Background Sync refusal cannot recreate a locally retired retry lineage", async () => {
  const indexedDB = fakeIndexedDB();
  const root = { ...outboxEntry("already-accepted-root"), state: "failed" };
  const sibling = { ...outboxEntry("already-accepted-sibling"), state: "failed", replaces: root.id };
  const entry = { ...outboxEntry("already-accepted"), replaces: root.id };
  for (const saved of [root, sibling, entry]) indexedDB.entries.set(saved.id, saved);
  const worker = loadWorker([], {
    indexedDB,
    fetch: async () => {
      for (const saved of [root, sibling, entry]) indexedDB.entries.delete(saved.id);
      return { status: 409, json: async () => ({ error: "The sibling was already accepted" }) };
    },
  });
  await worker.sync();
  assert.equal(indexedDB.entries.size, 0);
});

test("Background Sync retries authentication failures without overtaking that session's head", async () => {
  const indexedDB = fakeIndexedDB();
  const first = outboxEntry("first");
  const later = { ...outboxEntry("later"), createdAt: first.createdAt + 1 };
  const other = { ...outboxEntry("other", "other-session"), createdAt: first.createdAt + 2 };
  for (const entry of [first, later, other]) indexedDB.entries.set(entry.id, entry);
  const requested = [];
  const worker = loadWorker([], {
    indexedDB,
    fetch: async (_url, options) => {
      const { id } = JSON.parse(options.body);
      requested.push(id);
      return { status: id === first.id ? 401 : 200, json: async () => ({ success: true, data: { entry: { id: "other", sessionId: "other-session", mode: "prompt", message: "Stored", state: "held", createdAt: 1 } } }) };
    },
  });
  await assert.rejects(worker.sync());
  assert.deepEqual(requested, [first.id, other.id], "another chat can progress, but the same chat cannot overtake");
  assert.deepEqual(indexedDB.entries.get(first.id), first);
  assert.deepEqual(indexedDB.entries.get(later.id), later);
  assert.equal(indexedDB.entries.has(other.id), false);
});

test("a failure to persist Background Sync's refusal leaves the original message for another sync", async () => {
  const indexedDB = fakeIndexedDB();
  const entry = outboxEntry("failed-write");
  indexedDB.entries.set(entry.id, entry);
  indexedDB.failWrites = true;
  const worker = loadWorker([], {
    indexedDB,
    fetch: async () => ({ status: 413, json: async () => ({ error: "Message too large" }) }),
  });
  await assert.rejects(worker.sync());
  assert.deepEqual(indexedDB.entries.get(entry.id), entry);
});
