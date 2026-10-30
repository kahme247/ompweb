import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const store = await import("./notification-store.ts");
const { DEFAULT_NOTIFICATION_PREFS } = await import("./notification-events.ts");

const prefs = (patch = {}) => ({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true, ...patch });
const subscription = (id = "abc") => ({ endpoint: `https://push.example/${id}`, keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) } });
const event = (sessionId, type = "completed") => ({ type, sessionId, sessionName: `Session ${sessionId}` });
const keys = { publicKey: "pub", privateKey: "priv" };

/** A fresh agent dir; `reopen()` drops the cached handle, as a restart or a second omp-web instance would. */
function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-notify-store-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const reopen = () => {
    globalThis.__ompNotificationStore?.db.close();
    globalThis.__ompNotificationStore = undefined;
  };
  reopen();
  t.after(() => {
    reopen();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, reopen };
}

test("VAPID keys are generated once and survive a restart", (t) => {
  const { reopen } = isolated(t);
  let generated = 0;
  const generate = () => (generated++, keys);
  assert.deepEqual(store.getVapidKeys(generate), keys);
  reopen();
  assert.deepEqual(store.getVapidKeys(generate), keys);
  assert.equal(generated, 1);
});

test("the database is owner-only", (t) => {
  const { dir } = isolated(t);
  store.getVapidKeys(() => keys);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "omp-web", "notifications.db")).mode & 0o077, 0);
});

test("saving a device without a subscription keeps the stored one", (t) => {
  isolated(t);
  store.saveDevice("phone-0001", prefs(), subscription());
  const saved = store.saveDevice("phone-0001", prefs({ locale: "ja" }));
  assert.deepEqual(saved.subscription, subscription());
  assert.equal(store.getDevice("phone-0001").prefs.locale, "ja");
});

test("a push endpoint moves to the device that saved it last", (t) => {
  isolated(t);
  store.saveDevice("old-device", prefs(), subscription());
  store.saveDevice("new-device", prefs(), subscription());
  assert.equal(store.getDevice("old-device"), undefined);
  assert.deepEqual(store.getDevice("new-device").subscription, subscription());
});

test("over 50 devices, idle ones are dropped before enabled or subscribed ones, then the oldest", (t) => {
  isolated(t);
  store.saveDevice("idle-0001", prefs({ enabled: false }));
  store.saveDevice("subscribed", prefs({ enabled: false }), subscription());
  for (let i = 0; i < 49; i++) store.saveDevice(`enabled-${String(i).padStart(4, "0")}`, prefs());
  const ids = store.listDevices().map((device) => device.deviceId);
  assert.equal(ids.length, 50);
  assert.ok(!ids.includes("idle-0001"));
  assert.ok(ids.includes("subscribed"));
});

test("devices and keys written by one instance are seen by another", (t) => {
  const { reopen } = isolated(t);
  store.saveDevice("desk-0001", prefs());
  reopen();
  assert.equal(store.getDevice("desk-0001").prefs.enabled, true);
});

test("changing PI_CODING_AGENT_DIR moves the cached handle to the new location and back", (t) => {
  const { dir: first } = isolated(t);
  store.saveDevice("desk-0001", prefs());
  const second = mkdtempSync(join(tmpdir(), "omp-notify-store-"));
  t.after(() => rmSync(second, { recursive: true, force: true }));
  // No reopen(): the cached handle itself must follow the directory.
  process.env.PI_CODING_AGENT_DIR = second;
  assert.equal(store.getDevice("desk-0001"), undefined);
  assert.ok(existsSync(join(second, "omp-web", "notifications.db")));
  process.env.PI_CODING_AGENT_DIR = first;
  assert.equal(store.getDevice("desk-0001").deviceId, "desk-0001");
});

test("a location that cannot be opened does not break the store once it is valid again", (t) => {
  const { dir: good } = isolated(t);
  store.saveDevice("desk-0001", prefs());
  const bad = mkdtempSync(join(tmpdir(), "omp-notify-store-"));
  t.after(() => rmSync(bad, { recursive: true, force: true }));
  writeFileSync(join(bad, "omp-web"), "");
  process.env.PI_CODING_AGENT_DIR = bad;
  assert.throws(() => store.getDevice("desk-0001"));
  process.env.PI_CODING_AGENT_DIR = good;
  assert.equal(store.getDevice("desk-0001").deviceId, "desk-0001");
});

test("recording a reused id moves it to the top and makes it unread again", (t) => {
  isolated(t);
  store.recordHistory(event("s1"), { at: 1 });
  store.recordHistory(event("s2"), { at: 2 });
  store.markHistoryRead(["s1:completed", "s2:completed"]);
  const entry = store.recordHistory({ ...event("s1"), sessionName: "renamed" }, { at: 3 });
  assert.deepEqual(entry, { id: "s1:completed", event: { ...event("s1"), sessionName: "renamed" }, at: 3, read: false });
  assert.deepEqual(store.listHistory().map((e) => [e.id, e.read]), [["s1:completed", false], ["s2:completed", true]]);
});

test("history keeps the newest 100 entries", (t) => {
  isolated(t);
  for (let i = 0; i < 105; i++) store.recordHistory(event(`s${i}`), { at: i });
  const entries = store.listHistory();
  assert.equal(entries.length, 100);
  assert.equal(entries[0].id, "s104:completed");
  assert.equal(entries.at(-1).id, "s5:completed");
});

test("a write that fails because the disk is full reports that error, and the store keeps working", (t) => {
  isolated(t);
  store.recordHistory(event("s1"));
  // SQLite rolls a full database's transaction back on its own.
  const { db } = globalThis.__ompNotificationStore;
  const pages = db.prepare("PRAGMA page_count").get().page_count;
  db.exec(`PRAGMA max_page_count = ${pages}`);
  assert.throws(() => store.recordHistory({ ...event("s2"), detail: "x".repeat(200_000) }), /full/);
  db.exec("PRAGMA max_page_count = 1073741823");
  store.recordHistory(event("s3"));
  assert.deepEqual(store.listHistory().map((e) => e.id).sort(), ["s1:completed", "s3:completed"]);
});

test("mark read by ids, remove one, clear", (t) => {
  isolated(t);
  for (const id of ["s1", "s2", "s3"]) store.recordHistory(event(id));
  store.markHistoryRead(["s1:completed", "unknown"]);
  assert.deepEqual(store.listHistory().filter((e) => e.read).map((e) => e.id), ["s1:completed"]);
  store.removeHistory("s2:completed");
  assert.deepEqual(store.listHistory().map((e) => e.id).sort(), ["s1:completed", "s3:completed"]);
  store.clearHistory();
  assert.deepEqual(store.listHistory(), []);
});

function writeLegacy(dir, content) {
  mkdirSync(join(dir, "omp-web"), { recursive: true });
  const file = join(dir, "omp-web", "notifications.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

test("keys and devices are imported from notifications.json, which is then removed", (t) => {
  const { dir } = isolated(t);
  const file = writeLegacy(dir, {
    vapid: keys,
    devices: [
      { deviceId: "phone-0001", prefs: prefs({ locale: "ja" }), subscription: subscription(), updatedAt: 5 },
      { deviceId: "bad id!", prefs: prefs(), updatedAt: 1 },
    ],
  });
  assert.deepEqual(store.getVapidKeys(() => assert.fail("must reuse the imported keys")), keys);
  assert.deepEqual(store.listDevices().map((d) => [d.deviceId, d.prefs.locale, d.updatedAt]), [["phone-0001", "ja", 5]]);
  assert.ok(!existsSync(file));
});

test("a leftover notifications.json does not overwrite an existing store", (t) => {
  const { dir, reopen } = isolated(t);
  store.getVapidKeys(() => keys);
  reopen();
  writeLegacy(dir, { vapid: { publicKey: "other", privateKey: "other" }, devices: [] });
  assert.deepEqual(store.getVapidKeys(() => assert.fail("keys exist")), keys);
});

test("a corrupt notifications.json stays in place and the store starts empty", (t) => {
  const { dir } = isolated(t);
  const file = writeLegacy(dir, "{not json");
  assert.deepEqual(store.listDevices(), []);
  assert.ok(existsSync(file));
});

// An installed omp-web and `npm run dev` can open a fresh agent dir at the same moment.
test("processes racing to open a fresh store all succeed and share one key pair", async () => {
  const opener = `const store = await import(${JSON.stringify(new URL("./notification-store.ts", import.meta.url).href)});
    const at = Number(process.argv[1]);
    while (Date.now() < at);
    process.stdout.write(store.getVapidKeys(() => ({ publicKey: "pub-" + process.pid, privateKey: "x" })).publicKey);`;
  for (let round = 0; round < 10; round++) {
    const dir = mkdtempSync(join(tmpdir(), "omp-notify-race-"));
    try {
      const at = String(Date.now() + 1500);
      const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
        run(process.execPath, ["-e", opener, at], { env: { ...process.env, PI_CODING_AGENT_DIR: dir } })));
      for (const result of results) assert.equal(result.status, "fulfilled", `round ${round}: ${result.reason?.stderr ?? ""}`);
      assert.equal(new Set(results.map((result) => result.value.stdout)).size, 1, `round ${round}: one key pair`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
