import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

const { notificationHistory } = await import("./notification-history.ts");

const event = (sessionId, type = "completed") => ({ type, sessionId, sessionName: sessionId });
const entry = (sessionId, read = false) => ({ id: `${sessionId}:completed`, event: event(sessionId), at: 1, read });

/** Answers every request with `respond(request)`; records method + parsed body. */
let requests;
function serve(respond) {
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return respond(init.method ?? "GET");
  };
}
const ok = (body = { ok: true }) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const ids = () => notificationHistory.get().map((e) => [e.id, e.read]);

beforeEach(async () => {
  requests = [];
  serve(() => ok({ entries: [] }));
  await notificationHistory.load();
  requests = [];
});

test("load replaces the whole list with the server's", async () => {
  notificationHistory.add(event("local"));
  serve(() => ok({ entries: [entry("s2", true), entry("s1")] }));
  await notificationHistory.load();
  assert.deepEqual(ids(), [["s2:completed", true], ["s1:completed", false]]);
});

test("load ignores malformed entries and keeps the list when the request fails", async () => {
  serve(() => ok({ entries: [entry("s1"), { id: 7 }, { id: "x", event: null, at: 1, read: false }] }));
  await notificationHistory.load();
  assert.deepEqual(ids(), [["s1:completed", false]]);
  serve(() => new Response("nope", { status: 500 }));
  await notificationHistory.load();
  assert.deepEqual(ids(), [["s1:completed", false]]);
});

test("add puts the event first and unread, replacing an entry with the same id, capped at 100", () => {
  notificationHistory.add(event("s1"));
  notificationHistory.markRead("s1:completed");
  notificationHistory.add(event("s2"));
  notificationHistory.add(event("s1"));
  assert.deepEqual(ids(), [["s1:completed", false], ["s2:completed", false]]);
  for (let i = 0; i < 105; i++) notificationHistory.add(event(`n${i}`));
  assert.equal(notificationHistory.get().length, 100);
  assert.equal(notificationHistory.get()[0].id, "n104:completed");
});

test("read, remove and clear change the list at once and tell the server", async () => {
  serve(() => ok());
  for (const id of ["s1", "s2", "s3"]) notificationHistory.add(event(id));
  notificationHistory.markRead("s1:completed");
  assert.deepEqual(ids()[2], ["s1:completed", true]);
  notificationHistory.markAllRead();
  assert.ok(notificationHistory.get().every((e) => e.read));
  notificationHistory.remove("s2:completed");
  assert.deepEqual(ids().map(([id]) => id), ["s3:completed", "s1:completed"]);
  notificationHistory.clear();
  assert.deepEqual(ids(), []);
  await flush();
  assert.deepEqual(requests.map((r) => [r.method, r.url, r.body]), [
    ["PATCH", "/api/notifications/history", { ids: ["s1:completed"] }],
    ["PATCH", "/api/notifications/history", { ids: ["s3:completed", "s2:completed"] }],
    ["DELETE", "/api/notifications/history?id=s2%3Acompleted", undefined],
    ["DELETE", "/api/notifications/history?all=1", undefined],
  ]);
});

test("marking an already-read entry read sends nothing", async () => {
  serve(() => ok({ entries: [entry("s1", true)] }));
  await notificationHistory.load();
  requests = [];
  notificationHistory.markRead("s1:completed");
  notificationHistory.markAllRead();
  await flush();
  assert.deepEqual(requests, []);
});

test("a failed request reloads the list from the server", async () => {
  notificationHistory.add(event("s1"));
  serve((method) => (method === "GET" ? ok({ entries: [entry("s1"), entry("s0")] }) : new Response("no", { status: 500 })));
  notificationHistory.remove("s1:completed");
  assert.deepEqual(ids(), []);
  await flush();
  await flush();
  assert.deepEqual(ids(), [["s1:completed", false], ["s0:completed", false]]);
});

/** Requests wait until the test answers them, so responses can arrive in any order. */
function deferred() {
  const pending = [];
  globalThis.fetch = (url, init = {}) => new Promise((resolve) => {
    pending.push({ method: init.method ?? "GET", url: String(url), resolve });
  });
  return pending;
}
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };

test("a load answered after a removal does not bring the removed entry back", async () => {
  serve(() => ok({ entries: [entry("s1"), entry("s0")] }));
  await notificationHistory.load();
  const pending = deferred();
  const loading = notificationHistory.load();
  notificationHistory.remove("s1:completed");
  pending[0].resolve(ok({ entries: [entry("s1"), entry("s0")] })); // snapshot taken before the DELETE
  await loading;
  assert.deepEqual(ids(), [["s0:completed", false]]);
  pending[1].resolve(ok()); // the DELETE; the list is then reloaded once
  await settle();
  pending.at(-1).resolve(ok({ entries: [entry("s0")] }));
  await settle();
  assert.deepEqual(ids(), [["s0:completed", false]]);
});

test("a load answered after an SSE delivery keeps the delivered entry", async () => {
  const pending = deferred();
  const loading = notificationHistory.load();
  notificationHistory.add(event("fresh"));
  pending[0].resolve(ok({ entries: [entry("s0")] })); // taken before the server recorded "fresh"
  await loading;
  assert.ok(ids().some(([id]) => id === "fresh:completed"));
  await settle();
  pending.at(-1).resolve(ok({ entries: [entry("fresh"), entry("s0")] }));
  await settle();
  assert.deepEqual(ids(), [["fresh:completed", false], ["s0:completed", false]]);
});

test("overlapping loads: the newest request wins even when it answers first", async () => {
  const pending = deferred();
  const older = notificationHistory.load();
  const newer = notificationHistory.load();
  pending[1].resolve(ok({ entries: [entry("new")] }));
  await newer;
  pending[0].resolve(ok({ entries: [entry("old")] }));
  await older;
  assert.deepEqual(ids(), [["new:completed", false]]);
});

test("marking all read while a load is in flight keeps them read", async () => {
  serve(() => ok({ entries: [entry("s1"), entry("s0")] }));
  await notificationHistory.load();
  const pending = deferred();
  const loading = notificationHistory.load();
  notificationHistory.markAllRead();
  pending[0].resolve(ok({ entries: [entry("s1"), entry("s0")] }));
  await loading;
  assert.ok(notificationHistory.get().every((e) => e.read));
  pending[1].resolve(ok()); // the PATCH; the list is then reloaded from the server, which has them read
  await settle();
  pending.at(-1).resolve(ok({ entries: [entry("s1", true), entry("s0", true)] }));
  await settle();
  assert.ok(notificationHistory.get().every((e) => e.read));
});

test("an offline load keeps the list", async () => {
  notificationHistory.add(event("s1"));
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await notificationHistory.load();
  assert.deepEqual(ids(), [["s1:completed", false]]);
});
