import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Runs public/sw.js against a fake worker scope: the push handler is the only
// way a subscribed browser learns about a notification, so it must tell open tabs.
// Messages are cloned as postMessage does, which also drops the vm realm.
function loadWorker(windows, { notifications = [] } = {}) {
  const listeners = {};
  const shown = [];
  const self = {
    addEventListener: (type, listener) => { listeners[type] = listener; },
    skipWaiting() {},
    registration: {
      showNotification: async (title, options) => { shown.push({ title, options }); },
      getNotifications: async ({ tag } = {}) => notifications.filter((notification) => tag === undefined || notification.tag === tag),
    },
    clients: { claim: async () => {}, matchAll: async () => windows },
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL });
  return {
    shown,
    push: async (payload) => {
      let done;
      listeners.push({ data: payload === undefined ? null : { json: () => payload }, waitUntil: (promise) => { done = promise; } });
      await done;
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

test("a dismiss push closes the notification with its tag and displays nothing", async () => {
  const messages = [];
  const closed = [];
  const existing = [
    { tag: "s1:input", data: { requestId: "req-1" }, close: () => closed.push("s1:input") },
    { tag: "s2:input", data: { requestId: "req-2" }, close: () => closed.push("s2:input") },
  ];
  const worker = loadWorker([{ postMessage: (message) => messages.push(structuredClone(message)) }], { notifications: existing });
  await worker.push({ type: "dismiss", tag: "s1:input", sessionId: "s1", requestId: "req-1" });
  assert.deepEqual(worker.shown, []);
  assert.deepEqual(messages, []);
  assert.deepEqual(closed, ["s1:input"]);
});

test("a late dismiss for an older request leaves the current notification alone", async () => {
  const closed = [];
  const existing = [{ tag: "s1:input", data: { requestId: "req-2" }, close: () => closed.push("s1:input") }];
  const worker = loadWorker([], { notifications: existing });
  await worker.push({ type: "dismiss", tag: "s1:input", sessionId: "s1", requestId: "req-1" });
  assert.deepEqual(worker.shown, []);
  assert.deepEqual(closed, [], "unrelated request ids must not close the notification");
});

test("a shown push keeps its dialog request id for a later dismiss", async () => {
  const worker = loadWorker([]);
  await worker.push({
    type: "input",
    title: "Deploy?",
    body: "Waiting",
    tag: "s1:input",
    sessionId: "s1",
    requestId: "req-1",
    dialog: { requestId: "req-1", method: "confirm" },
  });
  assert.deepEqual(structuredClone(worker.shown[0].options.data), { url: "/", sessionId: "s1", requestId: "req-1" });
});

test("a dismiss without a tag is a no-op instead of closing every notification", async () => {
  const closed = [];
  const worker = loadWorker([], { notifications: [{ tag: "s1:input", close: () => closed.push("s1:input") }] });
  await worker.push({ type: "dismiss", sessionId: "s1", requestId: "req-1" });
  assert.deepEqual(worker.shown, []);
  assert.deepEqual(closed, []);
});
