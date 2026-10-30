import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { PushSubscription } from "web-push";
import { getAgentDir } from "./omp/paths";
import {
  isValidNotificationId,
  parseNotificationPrefs,
  type NotificationEvent,
  type NotificationHistoryEntry,
  type NotificationPrefs,
} from "./notification-events";
import { isRecord } from "./type-guards";

/**
 * Server-only persistent notification state in omp-web's data directory:
 * VAPID keys, devices (prefs + push subscription), and the notification
 * history. Every omp-web instance sharing the agent directory shares it;
 * SQLite serializes their writes.
 */

const MAX_DEVICES = 50;
const MAX_HISTORY = 100;

export interface NotificationDevice {
  deviceId: string;
  prefs: NotificationPrefs;
  subscription?: PushSubscription;
  updatedAt: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// p256dh is an uncompressed P-256 point (65 bytes), auth a 16-byte secret; both base64url.
const P256DH_PATTERN = /^[A-Za-z0-9_-]{86,88}={0,2}$/;
const AUTH_PATTERN = /^[A-Za-z0-9_-]{21,24}={0,2}$/;

/** Validate an untrusted PushSubscription JSON; only HTTPS push endpoints are accepted. */
export function parsePushSubscription(value: unknown): PushSubscription | null {
  if (!isRecord(value) || !isRecord(value.keys)) return null;
  const { endpoint } = value;
  const { p256dh, auth } = value.keys;
  if (typeof endpoint !== "string" || endpoint.length > 2048) return null;
  if (typeof p256dh !== "string" || !P256DH_PATTERN.test(p256dh) || typeof auth !== "string" || !AUTH_PATTERN.test(auth)) return null;
  try {
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { endpoint, keys: { p256dh, auth } };
}

declare global {
  var __ompNotificationStore: { path: string; db: Database } | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vapid (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, prefs TEXT NOT NULL, subscription TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, event TEXT NOT NULL, at INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0);
`;

function transaction<T>(db: Database, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // SQLite has already rolled back after some errors (a full disk, an I/O error); the original error is what matters.
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

const parseJson = (text: unknown): unknown => {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Imports the pre-SQLite notifications.json once, into an empty store. Runs inside the schema transaction. */
function importLegacy(db: Database, file: string): boolean {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const parsed = parseJson(text);
  if (!isRecord(parsed)) {
    console.warn(`[notifications] ignoring unreadable ${file}`);
    return false;
  }
  const empty = !db.prepare("SELECT 1 FROM vapid").get() && !db.prepare("SELECT 1 FROM devices").get();
  if (!empty) return false;
  const { vapid } = parsed;
  if (isRecord(vapid) && typeof vapid.publicKey === "string" && typeof vapid.privateKey === "string") {
    db.prepare("INSERT INTO vapid (id, public_key, private_key) VALUES (1, ?, ?)").run(vapid.publicKey, vapid.privateKey);
  }
  const insert = db.prepare("INSERT OR IGNORE INTO devices (device_id, prefs, subscription, updated_at) VALUES (?, ?, ?, ?)");
  for (const device of Array.isArray(parsed.devices) ? parsed.devices : []) {
    if (!isRecord(device) || !isValidNotificationId(device.deviceId)) continue;
    const subscription = parsePushSubscription(device.subscription);
    insert.run(device.deviceId, JSON.stringify(parseNotificationPrefs(device.prefs)), subscription ? JSON.stringify(subscription) : null, Number(device.updatedAt) || 0);
  }
  return true;
}

/** The store for the current agent directory; reopened when PI_CODING_AGENT_DIR changes. */
function db(): Database {
  const dir = join(getAgentDir(), "omp-web");
  const path = join(dir, "notifications.db");
  const cached = globalThis.__ompNotificationStore;
  if (cached?.path === path) return cached.db;
  const database = open(dir, path);
  // Only a working store replaces the cached one; a failed open leaves it usable.
  cached?.db.close();
  globalThis.__ompNotificationStore = { path, db: database };
  return database;
}

function open(dir: string, path: string): Database {
  mkdirSync(dir, { recursive: true });
  // Owner-only before SQLite opens it: it holds the VAPID private key. SQLite gives its -wal/-shm files the same mode.
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const database = new Database(path);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    // Switching a new database to WAL takes an exclusive lock that ignores busy_timeout; another omp-web may hold it.
    for (let attempt = 0; ; attempt++) {
      try {
        database.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (!isRecord(error) || error.errno !== 5 || attempt >= 250) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    // NORMAL is the documented safe pairing with WAL: no corruption, only the last commits can be lost on power failure.
    database.exec("PRAGMA synchronous = NORMAL");
    const legacy = join(dir, "notifications.json");
    const imported = transaction(database, () => {
      database.exec(SCHEMA);
      return importLegacy(database, legacy);
    });
    if (imported) {
      // Make the import durable before its source goes: losing the VAPID keys breaks every push subscription.
      database.exec("PRAGMA wal_checkpoint(FULL)");
      rmSync(legacy, { force: true });
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

// ---------------------------------------------------------------- VAPID keys

/** The installation's VAPID key pair, generated on first use. */
export function getVapidKeys(generate: () => VapidKeys): VapidKeys {
  const database = db();
  const read = () => database.prepare("SELECT public_key, private_key FROM vapid WHERE id = 1").get() as { public_key: string; private_key: string } | null;
  const row = read() ?? transaction(database, () => {
    // Re-read under the write lock: another instance may have generated them meanwhile.
    if (!read()) {
      const fresh = generate();
      database.prepare("INSERT INTO vapid (id, public_key, private_key) VALUES (1, ?, ?)").run(fresh.publicKey, fresh.privateKey);
    }
    return read()!;
  });
  return { publicKey: row.public_key, privateKey: row.private_key };
}

// ---------------------------------------------------------------- devices

type DeviceRow = { device_id: string; prefs: string; subscription: string | null; updated_at: number };

function toDevice(row: DeviceRow): NotificationDevice | undefined {
  if (!isValidNotificationId(row.device_id)) return undefined;
  const subscription = row.subscription === null ? undefined : parsePushSubscription(parseJson(row.subscription)) ?? undefined;
  return { deviceId: row.device_id, prefs: parseNotificationPrefs(parseJson(row.prefs)), subscription, updatedAt: Number(row.updated_at) };
}

export function listDevices(): NotificationDevice[] {
  const rows = db().prepare("SELECT device_id, prefs, subscription, updated_at FROM devices ORDER BY updated_at DESC").all() as DeviceRow[];
  return rows.flatMap((row) => toDevice(row) ?? []);
}

export function getDevice(deviceId: string): NotificationDevice | undefined {
  const row = db().prepare("SELECT device_id, prefs, subscription, updated_at FROM devices WHERE device_id = ?").get(deviceId) as DeviceRow | null;
  return row ? toDevice(row) : undefined;
}

/** Store a device's prefs, and its push subscription when given (otherwise the stored one is kept). */
export function saveDevice(deviceId: string, prefs: NotificationPrefs, subscription?: PushSubscription): NotificationDevice {
  const database = db();
  return transaction(database, () => {
    const device: NotificationDevice = { deviceId, prefs, subscription: subscription ?? getDevice(deviceId)?.subscription, updatedAt: Date.now() };
    // A push endpoint belongs to one browser; drop it from any other device id.
    if (device.subscription) {
      for (const other of listDevices()) {
        if (other.deviceId !== deviceId && other.subscription?.endpoint === device.subscription.endpoint) database.prepare("DELETE FROM devices WHERE device_id = ?").run(other.deviceId);
      }
    }
    database.prepare(`INSERT INTO devices (device_id, prefs, subscription, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (device_id) DO UPDATE SET prefs = excluded.prefs, subscription = excluded.subscription, updated_at = excluded.updated_at`)
      .run(deviceId, JSON.stringify(prefs), device.subscription ? JSON.stringify(device.subscription) : null, device.updatedAt);
    // Over the cap, forget devices that would never be notified before ones that would.
    const useful = (entry: NotificationDevice) => (entry.prefs.enabled || entry.subscription ? 1 : 0);
    const ranked = listDevices().sort((a, b) => useful(b) - useful(a) || b.updatedAt - a.updatedAt);
    for (const extra of ranked.slice(MAX_DEVICES)) database.prepare("DELETE FROM devices WHERE device_id = ?").run(extra.deviceId);
    return device;
  });
}

/** Forget a subscription the push service no longer accepts, unless the device has since saved a new one. */
export function dropDeviceSubscription(deviceId: string, endpoint: string): void {
  const device = getDevice(deviceId);
  if (device?.subscription?.endpoint !== endpoint) return;
  db().prepare("UPDATE devices SET subscription = NULL WHERE device_id = ? AND subscription = ?").run(deviceId, JSON.stringify(device.subscription));
}

// ---------------------------------------------------------------- history

type HistoryRow = { id: string; event: string; at: number; read: number };

/** Newest first. */
export function listHistory(): NotificationHistoryEntry[] {
  const rows = db().prepare("SELECT id, event, at, read FROM history ORDER BY at DESC, rowid DESC").all() as HistoryRow[];
  return rows.flatMap((row) => {
    const event = parseJson(row.event);
    return isRecord(event) ? [{ id: row.id, event: event as unknown as NotificationEvent, at: Number(row.at), read: row.read === 1 }] : [];
  });
}

/** A reused id (`<sessionId>:<type>`) replaces its entry: it is a new notification, unread unless `read` says it was seen. */
export function recordHistory(event: NotificationEvent, { at = Date.now(), read = false }: { at?: number; read?: boolean } = {}): NotificationHistoryEntry {
  const database = db();
  const id = `${event.sessionId}:${event.type}`;
  transaction(database, () => {
    database.prepare("DELETE FROM history WHERE id = ?").run(id);
    database.prepare("INSERT INTO history (id, event, at, read) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(event), at, read ? 1 : 0);
    database.prepare("DELETE FROM history WHERE rowid NOT IN (SELECT rowid FROM history ORDER BY at DESC, rowid DESC LIMIT ?)").run(MAX_HISTORY);
  });
  return { id, event, at, read };
}

export function markHistoryRead(ids: string[]): void {
  const database = db();
  const mark = database.prepare("UPDATE history SET read = 1 WHERE id = ?");
  transaction(database, () => {
    for (const id of ids) mark.run(id);
  });
}

export function removeHistory(id: string): void {
  db().prepare("DELETE FROM history WHERE id = ?").run(id);
}

export function clearHistory(): void {
  db().prepare("DELETE FROM history").run();
}
