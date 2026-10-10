import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import webpush, { type PushSubscription } from "web-push";
import en from "./i18n/locales/en.json";
import ja from "./i18n/locales/ja.json";
import zhCN from "./i18n/locales/zh-CN.json";
import { getAgentDir } from "./omp/paths";
import {
  isValidNotificationId,
  parseNotificationPrefs,
  renderNotification,
  type NotificationEvent,
  type NotificationPrefs,
  type RenderedNotification,
} from "./notification-events";
import { isRecord } from "./type-guards";

/**
 * Server side of notifications: presence of open tabs, per-device preferences
 * and Web Push subscriptions, and routing each event to an in-app toast, an
 * in-page system notification, or a push.
 */

/** A tab counts as present this long after its last presence report. */
export const PRESENCE_TTL_MS = 60_000;
const MAX_DEVICES = 50;
const PUSH_TTL_SECONDS = 3600;
const PUSH_TIMEOUT_MS = 10_000;
// Apple's push service rejects VAPID subjects it cannot resolve (e.g. localhost mail).
const VAPID_SUBJECT = "https://github.com/kahme247/ompweb";

/** What a tab last reported. Written only by presence reports, pruned by TTL. */
export interface NotificationPresence {
  clientId: string;
  deviceId: string;
  visible: boolean;
  sessionId: string | null;
  /** Per-tab report counter: requests can arrive out of order, and only the newest counts. */
  seq: number;
  lastSeen: number;
}

export interface NotificationDevice {
  deviceId: string;
  prefs: NotificationPrefs;
  subscription?: PushSubscription;
  updatedAt: number;
}

export type NotificationMessage = { kind: "toast" | "os"; event: NotificationEvent };

type Send = (message: NotificationMessage) => void;

export type Delivery =
  | { kind: "toast" | "os"; clientId: string }
  | { kind: "push"; deviceId: string };

interface StoreFile {
  vapid?: { publicKey: string; privateKey: string };
  devices: NotificationDevice[];
}

interface HubState {
  presence: Map<string, NotificationPresence>;
  /** Open SSE streams per tab. Independent of presence: streams reconnect, overlap, and close while the tab stays put. */
  streams: Map<string, Set<Send>>;
}

declare global {
  var __ompNotificationHub: HubState | undefined;
}

function hub(): HubState {
  return (globalThis.__ompNotificationHub ??= { presence: new Map(), streams: new Map() });
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

// ---------------------------------------------------------------- store

function storePath(): string {
  return resolve(getAgentDir(), "omp-web", "notifications.json");
}

/**
 * Read from disk on every use, never cached: an installed server and a dev
 * server can share the agent directory, and each must see the other's devices
 * and keys. ponytail: read-modify-write without a lock; two instances saving in
 * the same millisecond can lose one update (the tab re-syncs on its next load).
 */
function loadStore(): StoreFile {
  let store: StoreFile = { devices: [] };
  try {
    if (existsSync(storePath())) {
      const parsed: unknown = JSON.parse(readFileSync(storePath(), "utf8"));
      if (isRecord(parsed)) {
        const { vapid } = parsed;
        store = {
          vapid: isRecord(vapid) && typeof vapid.publicKey === "string" && typeof vapid.privateKey === "string" ? { publicKey: vapid.publicKey, privateKey: vapid.privateKey } : undefined,
          devices: (Array.isArray(parsed.devices) ? parsed.devices : []).flatMap((device: unknown) => {
            if (!isRecord(device) || !isValidNotificationId(device.deviceId)) return [];
            const subscription = parsePushSubscription(device.subscription) ?? undefined;
            return [{ deviceId: device.deviceId, prefs: parseNotificationPrefs(device.prefs), subscription, updatedAt: Number(device.updatedAt) || 0 }];
          }),
        };
      }
    }
  } catch {
    // A corrupt file only loses device prefs; tabs re-register on load.
  }
  return store;
}

/** Atomic write (temp file + rename), owner-only: the file holds the VAPID private key. */
function saveStore(store: StoreFile): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) rmSync(temp);
    } catch {
      // ignore cleanup failures
    }
  }
}

function vapidKeys(): { publicKey: string; privateKey: string } {
  const store = loadStore();
  if (!store.vapid) {
    store.vapid = webpush.generateVAPIDKeys();
    saveStore(store);
  }
  return store.vapid;
}

export function getVapidPublicKey(): string {
  return vapidKeys().publicKey;
}

export function getNotificationDevice(deviceId: string): NotificationDevice | undefined {
  return loadStore().devices.find((device) => device.deviceId === deviceId);
}

/** Store a device's prefs, and its push subscription when given (otherwise the stored one is kept). */
export function saveNotificationDevice(deviceId: string, prefs: NotificationPrefs, subscription?: PushSubscription): NotificationDevice {
  const store = loadStore();
  const existing = store.devices.find((device) => device.deviceId === deviceId);
  const device: NotificationDevice = { deviceId, prefs, subscription: subscription ?? existing?.subscription, updatedAt: Date.now() };
  // A push endpoint belongs to one browser; drop it from any other device id.
  const others = store.devices.filter((entry) => entry.deviceId !== deviceId && !(device.subscription && entry.subscription?.endpoint === device.subscription.endpoint));
  // Over the cap, forget devices that would never be notified before ones that would.
  const useful = (entry: NotificationDevice) => (entry.prefs.enabled || entry.subscription ? 1 : 0);
  store.devices = [device, ...others].sort((a, b) => useful(b) - useful(a) || b.updatedAt - a.updatedAt).slice(0, MAX_DEVICES);
  saveStore(store);
  return device;
}

function dropSubscription(deviceId: string, endpoint: string): void {
  const store = loadStore();
  const device = store.devices.find((entry) => entry.deviceId === deviceId);
  if (!device?.subscription || device.subscription.endpoint !== endpoint) return;
  device.subscription = undefined;
  saveStore(store);
}

// ---------------------------------------------------------------- presence and streams

function livePresence(now: number): NotificationPresence[] {
  const { presence } = hub();
  for (const [id, entry] of presence) {
    if (now - entry.lastSeen > PRESENCE_TTL_MS) presence.delete(id);
  }
  return [...presence.values()];
}

export function reportPresence(report: Omit<NotificationPresence, "lastSeen">): void {
  const { presence } = hub();
  const current = presence.get(report.clientId);
  if (current && current.seq > report.seq) return;
  presence.set(report.clientId, { ...report, lastSeen: Date.now() });
}

/** Attach a tab's SSE stream. Returns the detach callback. */
export function attachNotificationClient(clientId: string, send: Send): () => void {
  const { streams } = hub();
  const own = streams.get(clientId) ?? new Set();
  own.add(send);
  streams.set(clientId, own);
  return () => {
    own.delete(send);
    if (own.size === 0 && streams.get(clientId) === own) streams.delete(clientId);
  };
}

// ---------------------------------------------------------------- routing

/**
 * Decide where one event goes. `reachable` holds the tabs with an open stream.
 * 1. A visible tab is showing the session: nothing, for every device.
 * 2. The user is active in some reachable tab and the device prefers toasts:
 *    toast to that device's active tabs only (other devices stay quiet).
 * 3. Otherwise a system notification: push when the device has a
 *    subscription, else in-page on each of its reachable tabs.
 */
export function routeNotification(event: NotificationEvent, presence: NotificationPresence[], reachable: ReadonlySet<string>, devices: NotificationDevice[]): Delivery[] {
  if (event.type === "test") return [];
  const viewedAs = new Set([event.sessionId, ...(event.aliases ?? [])]);
  if (presence.some((tab) => tab.visible && tab.sessionId !== null && viewedAs.has(tab.sessionId))) return [];
  const active = presence.filter((tab) => tab.visible && reachable.has(tab.clientId));
  const deliveries: Delivery[] = [];
  for (const device of devices) {
    if (!device.prefs.enabled || !device.prefs.types[event.type]) continue;
    if (active.length > 0 && device.prefs.whenActive === "toast") {
      for (const tab of active) if (tab.deviceId === device.deviceId) deliveries.push({ kind: "toast", clientId: tab.clientId });
    } else if (device.subscription) {
      deliveries.push({ kind: "push", deviceId: device.deviceId });
    } else {
      for (const tab of presence) if (tab.deviceId === device.deviceId && reachable.has(tab.clientId)) deliveries.push({ kind: "os", clientId: tab.clientId });
    }
  }
  return deliveries;
}

const dictionaries: Record<string, Record<string, string>> = { en, ja, "zh-CN": zhCN };

function renderFor(event: NotificationEvent, locale: string): RenderedNotification {
  const dictionary = Object.hasOwn(dictionaries, locale) ? dictionaries[locale] : dictionaries.en;
  return renderNotification(event, (key, vars) => {
    const template = dictionary[key] ?? dictionaries.en[key] ?? key;
    return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template;
  });
}

/** Never throws: a failed push must not break delivery to anyone else. */
async function sendPush(device: NotificationDevice, event: NotificationEvent): Promise<{ ok: true } | { ok: false; error: string }> {
  const subscription = device.subscription;
  if (!subscription) return { ok: false, error: "no push subscription" };
  try {
    const { publicKey, privateKey } = vapidKeys();
    // `type` lets the service worker tell open tabs which kind of entry to list.
    await webpush.sendNotification(subscription, JSON.stringify({ ...renderFor(event, device.prefs.locale), type: event.type }), {
      TTL: PUSH_TTL_SECONDS,
      urgency: event.type === "input" || event.type === "error" ? "high" : "normal",
      timeout: PUSH_TIMEOUT_MS,
      vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
    });
    return { ok: true };
  } catch (error) {
    const status = error instanceof webpush.WebPushError ? error.statusCode : undefined;
    try {
      // 404/410: the browser unsubscribed or the subscription expired.
      if (status === 404 || status === 410) dropSubscription(device.deviceId, subscription.endpoint);
    } catch {
      // A store write failure only delays the cleanup to the next push.
    }
    const message = status ? `push service answered ${status}` : String(error);
    console.warn("[notifications] push failed:", message);
    return { ok: false, error: message };
  }
}

export function publishNotification(event: NotificationEvent): void {
  const state = hub();
  const devices = loadStore().devices;
  const reachable = new Set(state.streams.keys());
  for (const delivery of routeNotification(event, livePresence(Date.now()), reachable, devices)) {
    if (delivery.kind === "push") {
      const device = devices.find((entry) => entry.deviceId === delivery.deviceId);
      if (device) void sendPush(device, event);
      continue;
    }
    for (const send of state.streams.get(delivery.clientId) ?? []) {
      try {
        send({ kind: delivery.kind, event });
      } catch {
        // A closing stream must not break delivery to the others.
      }
    }
  }
}

/** Settings "Send test notification" for a device with push: reports whether the push service accepted it. */
export async function sendTestPush(deviceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const device = getNotificationDevice(deviceId);
  if (!device) return { ok: false, error: "unknown device" };
  return sendPush(device, { type: "test", sessionId: "", sessionName: "omp web" });
}
