import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const hub = await jiti.import("./notification-hub.ts");
const { DEFAULT_NOTIFICATION_PREFS } = await jiti.import("./notification-events.ts");
const webpush = (await jiti.import("web-push")).default;

const event = { type: "completed", sessionId: "s1", sessionName: "Session" };
const prefs = (patch = {}) => ({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true, ...patch });
const tab = (clientId, deviceId, patch = {}) => ({ clientId, deviceId, visible: false, sessionId: null, lastSeen: 0, ...patch });
const device = (deviceId, patch = {}) => ({ deviceId, prefs: prefs(), updatedAt: 0, ...patch });
const subscription = { endpoint: "https://push.example/abc", keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) } };
const all = (...ids) => new Set(ids);

test("nothing is sent anywhere while a visible tab shows the session, even while its stream reconnects", () => {
  const presence = [tab("viewer", "desk", { visible: true, sessionId: "s1" }), tab("phone-tab", "phone")];
  const devices = [device("desk"), device("phone", { prefs: prefs({ whenActive: "system" }), subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all("phone-tab"), devices), []);
});

test("active in another session: toast on the active tab only, toast-mode devices elsewhere stay quiet", () => {
  const presence = [tab("desk-active", "desk", { visible: true, sessionId: "other" }), tab("desk-hidden", "desk"), tab("laptop-tab", "laptop")];
  const devices = [device("desk"), device("laptop")];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-active", "desk-hidden", "laptop-tab"), devices), [{ kind: "toast", clientId: "desk-active" }]);
});

test("a visible tab that cannot receive toasts (stream closed) does not silence other devices", () => {
  const presence = [tab("settings-open", "desk", { visible: true })];
  const devices = [device("desk"), device("phone", { subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all(), devices), [{ kind: "push", deviceId: "phone" }]);
});

test("'always send a system notification' devices still get one while the user is active elsewhere", () => {
  const presence = [tab("desk-active", "desk", { visible: true, sessionId: "other" })];
  const devices = [device("desk", { prefs: prefs({ whenActive: "system" }) }), device("phone", { prefs: prefs({ whenActive: "system" }), subscription })];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-active"), devices), [
    { kind: "os", clientId: "desk-active" },
    { kind: "push", deviceId: "phone" },
  ]);
});

test("nobody active: push to subscribed devices, in-page to reachable tabs of unsubscribed ones", () => {
  const presence = [tab("desk-tab", "desk"), tab("phone-tab", "phone"), tab("beacon-only", "laptop")];
  const devices = [device("desk"), device("phone", { subscription }), device("laptop")];
  assert.deepEqual(hub.routeNotification(event, presence, all("desk-tab", "phone-tab"), devices), [
    { kind: "os", clientId: "desk-tab" },
    { kind: "push", deviceId: "phone" },
  ]);
});

test("a tab still showing a moved session's old id counts as viewing it", () => {
  const presence = [tab("viewer", "desk", { visible: true, sessionId: "old-id" })];
  const moved = { ...event, sessionId: "new-id", aliases: ["old-id"] };
  assert.deepEqual(hub.routeNotification(moved, presence, all("viewer"), [device("desk", { subscription })]), []);
});

test("disabled devices and disabled types get nothing", () => {
  const presence = [tab("tab", "desk")];
  assert.deepEqual(hub.routeNotification(event, presence, all("tab"), [device("desk", { prefs: prefs({ enabled: false }) })]), []);
  assert.deepEqual(hub.routeNotification(event, presence, all("tab"), [device("desk", { prefs: prefs({ types: { ...DEFAULT_NOTIFICATION_PREFS.types, completed: false } }) })]), []);
});

test("push subscriptions must use an HTTPS endpoint and real key sizes", () => {
  assert.equal(hub.parsePushSubscription({ ...subscription, endpoint: "http://127.0.0.1:8080/x" }), null);
  assert.equal(hub.parsePushSubscription({ ...subscription, keys: { p256dh: "not-a-real-key", auth: "x" } }), null);
  assert.deepEqual(hub.parsePushSubscription(subscription), subscription);
});

function isolatedStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-notify-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousSend = webpush.sendNotification;
  const previousHub = globalThis.__ompNotificationHub;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__ompNotificationHub = undefined;
  t.after(() => {
    webpush.sendNotification = previousSend;
    globalThis.__ompNotificationHub = previousHub;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("another omp-web instance sharing the agent dir sees the same keys and devices; the store is owner-only", (t) => {
  const dir = isolatedStore(t);
  const file = join(dir, "omp-web", "notifications.json");
  hub.saveNotificationDevice("phone-device", prefs({ locale: "ja" }), subscription);
  const publicKey = hub.getVapidPublicKey();
  // Windows has no POSIX permission bits to check.
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0);

  // The other instance registers a device by rewriting the shared file.
  const shared = JSON.parse(readFileSync(file, "utf8"));
  shared.devices.push({ deviceId: "laptop-device", prefs: prefs(), updatedAt: 1 });
  writeFileSync(file, JSON.stringify(shared));

  assert.equal(hub.getVapidPublicKey(), publicKey);
  assert.equal(hub.getNotificationDevice("laptop-device").prefs.enabled, true);
  hub.saveNotificationDevice("phone-device", prefs({ locale: "en" }));
  assert.ok(hub.getNotificationDevice("laptop-device"), "saving one device keeps the other instance's devices");
  assert.deepEqual(hub.getNotificationDevice("phone-device").subscription, subscription);
});

test("a tab stays reachable when a stale stream of the same tab attaches late and then closes", (t) => {
  isolatedStore(t);
  hub.saveNotificationDevice("desk-0001", prefs());
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, seq: 1 });

  // React strict mode / reconnects: the cancelled request reaches the server
  // after the live one, then its abort fires.
  const received = [];
  const detachLive = hub.attachNotificationClient("tab-0001", () => received.push("live"));
  const detachStale = hub.attachNotificationClient("tab-0001", () => received.push("stale"));
  detachStale();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);

  detachLive();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);
});

test("a presence report that arrives after a newer one from the same tab is ignored", (t) => {
  isolatedStore(t);
  hub.saveNotificationDevice("desk-0001", prefs({ whenActive: "system" }));
  const received = [];
  hub.attachNotificationClient("tab-0001", () => received.push("tab"));
  // The tab moved from s1 to s2, but the s1 report lands last.
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s2", seq: 2 });
  hub.reportPresence({ clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "s1", seq: 1 });
  hub.publishNotification(event);
  assert.deepEqual(received, ["tab"], "s1 is no longer on screen, so its notification goes out");
});

test("pushes are written in the device's language with urgency by type", async (t) => {
  isolatedStore(t);
  const sent = [];
  webpush.sendNotification = async (_subscription, payload, options) => {
    sent.push({ payload: JSON.parse(payload), urgency: options.urgency, ttl: options.TTL });
  };
  hub.saveNotificationDevice("phone-device", prefs({ locale: "ja" }), subscription);
  hub.publishNotification(event);
  hub.publishNotification({ type: "input", sessionId: "s2", sessionName: "Deploy", detail: "Ship it?" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent.map(({ payload, urgency, ttl }) => [payload.body, payload.url, payload.type, urgency, ttl]), [
    ["タスクが完了しました。", "/?session=s1", "completed", "normal", 3600],
    ["回答を待っています: Ship it?", "/?session=s2", "input", "high", 3600],
  ]);
});

for (const status of [404, 410]) {
  test(`a push service ${status} removes the subscription but keeps the device prefs`, async (t) => {
    isolatedStore(t);
    webpush.sendNotification = async () => {
      throw new webpush.WebPushError("Gone", status, {}, "", subscription.endpoint);
    };
    hub.saveNotificationDevice("phone-device", prefs(), subscription);
    assert.deepEqual(await hub.sendTestPush("phone-device"), { ok: false, error: `push service answered ${status}` });

    const stored = hub.getNotificationDevice("phone-device");
    assert.equal(stored.subscription, undefined);
    assert.equal(stored.prefs.enabled, true);
  });
}
