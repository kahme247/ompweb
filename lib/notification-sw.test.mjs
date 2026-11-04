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

test("a late Background Sync refusal does not recreate a row accepted by another sender", async () => {
  const indexedDB = fakeIndexedDB();
  const entry = outboxEntry("already-accepted");
  indexedDB.entries.set(entry.id, entry);
  const worker = loadWorker([], {
    indexedDB,
    fetch: async () => {
      indexedDB.entries.delete(entry.id);
      return { status: 409, json: async () => ({ error: "Installation scope changed" }) };
    },
  });
  await worker.sync();
  assert.equal(indexedDB.entries.has(entry.id), false);
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
      return { status: id === first.id ? 401 : 200, json: async () => ({}) };
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
