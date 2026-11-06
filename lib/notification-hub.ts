import webpush from "web-push";
import en from "./i18n/locales/en.json";
import ja from "./i18n/locales/ja.json";
import zhCN from "./i18n/locales/zh-CN.json";
import {
  renderNotification,
  type NotificationEvent,
  type RenderedNotification,
} from "./notification-events";
import { dropDeviceSubscription, getDevice, getVapidKeys, listDevices, recordHistory, type NotificationDevice } from "./notification-store";

/**
 * Server side of notifications: presence of open tabs, per-device preferences
 * and Web Push subscriptions, and routing each event to an in-app toast, an
 * in-page system notification, or a push.
 */

/** A tab counts as present this long after its last presence report. */
export const PRESENCE_TTL_MS = 60_000;
const PUSH_TTL_SECONDS = 3600;
const PUSH_TIMEOUT_MS = 10_000;
/** Waits before each retry of a push the push service never answered or answered 429/5xx. Well inside the TTL. */
export const PUSH_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
/**
 * How long a retraction keeps suppressing further delivery attempts of the
 * same `input` push: one retry cycle is its backoff waits plus the time a
 * single attempt may hang, and no retry can outlive that.
 */
export const PUSH_RETRACTION_TTL_MS = PUSH_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
  + (PUSH_RETRY_DELAYS_MS.length + 1) * PUSH_TIMEOUT_MS;
/** Default spacing of the repeats of an unanswered `input` notification. */
export const INPUT_REMINDER_MS = 2 * 60 * 60 * 1000;
/** A dialog is repeated at most this often before it stays quiet until it settles. */
export const MAX_INPUT_REMINDERS = 12;

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

export type NotificationMessage = { kind: "toast" | "os"; event: NotificationEvent };

type Send = (message: NotificationMessage) => void;

export type Delivery =
  | { kind: "toast" | "os"; clientId: string }
  | { kind: "push"; deviceId: string };

interface HubState {
  presence: Map<string, NotificationPresence>;
  /** Open SSE streams per tab. Independent of presence: streams reconnect, overlap, and close while the tab stays put. */
  streams: Map<string, Set<Send>>;
  /** The notification device each tab declared with its stream. Absent for tabs that predate the field: those keep the pre-device behaviour (no stream-only delivery). */
  streamDevices: Map<string, string>;
}

declare global {
  var __ompNotificationHub: HubState | undefined;
}

function hub(): HubState {
  const state = (globalThis.__ompNotificationHub ??= { presence: new Map(), streams: new Map(), streamDevices: new Map() });
  // `bun --hot` keeps this object across a re-evaluation: a state created by
  // the previous module instance may predate a field added here.
  state.streamDevices ??= new Map();
  return state;
}

export function getVapidPublicKey(): string {
  return getVapidKeys(webpush.generateVAPIDKeys).publicKey;
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

/** Attach a tab's SSE stream. `deviceId` is the notification device this tab
 *  belongs to (the app's NotificationCenter id / the web tab's stored device
 *  id); a stream without one is reachable but never receives stream-only
 *  deliveries, exactly like before device routing existed. Returns the detach
 *  callback. */
export function attachNotificationClient(clientId: string, send: Send, deviceId?: string): () => void {
  const state = hub();
  const own = state.streams.get(clientId) ?? new Set();
  own.add(send);
  state.streams.set(clientId, own);
  if (deviceId) state.streamDevices.set(clientId, deviceId);
  return () => {
    own.delete(send);
    if (own.size === 0 && state.streams.get(clientId) === own) {
      state.streams.delete(clientId);
      state.streamDevices.delete(clientId);
    }
  };
}

/** Reachable tabs with the device each one declared (`undefined` when it did
 *  not declare one). The map doubles as the reachability set. */
function reachableTabs(): Map<string, string | undefined> {
  const state = hub();
  const reachable = new Map<string, string | undefined>();
  for (const clientId of state.streams.keys()) reachable.set(clientId, state.streamDevices.get(clientId));
  return reachable;
}

// ---------------------------------------------------------------- routing

/** A visible tab is showing the event's conversation (under any of its ids). */
function isOnScreen(event: NotificationEvent, presence: NotificationPresence[]): boolean {
  const viewedAs = new Set([event.sessionId, ...(event.aliases ?? [])]);
  return presence.some((tab) => tab.visible && tab.sessionId !== null && viewedAs.has(tab.sessionId));
}

/**
 * Decide where one event goes. `reachable` maps each tab with an open stream
 * to the notification device it declared (`undefined` when it declared none).
 * 1. A visible tab is showing the session: nothing, for every device.
 * 2. The user is active in some reachable tab and the device prefers toasts:
 *    toast to that device's active tabs only (other devices stay quiet).
 * 3. Otherwise a system notification: push when the device has a
 *    subscription, else in-page on each of its reachable tabs.
 *
 * A stream without a live presence entry is reachable but **not visible**.
 * Native clients (no push subscription) keep their `notifications` stream open
 * without presence reports, so rule 3 also delivers to stream-only tabs — but
 * only through the device the tab declared: that device's own preferences
 * decide, and a device a push already covers gets no frame. A stream that
 * declared no device keeps the pre-device behaviour (no stream-only delivery).
 * Presence keeps its kill-switch: rule 1 still suppresses everything while a
 * visible tab shows the session.
 */
export function routeNotification(event: NotificationEvent, presence: NotificationPresence[], reachable: ReadonlyMap<string, string | undefined>, devices: NotificationDevice[]): Delivery[] {
  if (event.type === "test") return [];
  if (isOnScreen(event, presence)) return [];
  const presenceById = new Map(presence.map((tab) => [tab.clientId, tab]));
  // Stream-only tabs grouped by the device that owns them.
  const streamOnlyByDevice = new Map<string, string[]>();
  for (const [clientId, deviceId] of reachable) {
    if (!deviceId || presenceById.has(clientId)) continue;
    const owned = streamOnlyByDevice.get(deviceId) ?? [];
    owned.push(clientId);
    streamOnlyByDevice.set(deviceId, owned);
  }
  const active = presence.filter((tab) => tab.visible && reachable.has(tab.clientId));
  const deliveries: Delivery[] = [];
  const seen = new Set<string>();
  const deliver = (delivery: Delivery) => {
    const key = delivery.kind === "push" ? `push:${delivery.deviceId}` : `${delivery.kind}:${delivery.clientId}`;
    if (seen.has(key)) return;
    seen.add(key);
    deliveries.push(delivery);
  };
  for (const device of devices) {
    if (!device.prefs.enabled || !device.prefs.types[event.type]) continue;
    if (active.length > 0 && device.prefs.whenActive === "toast") {
      for (const tab of active) if (tab.deviceId === device.deviceId) deliver({ kind: "toast", clientId: tab.clientId });
    } else if (device.subscription) {
      deliver({ kind: "push", deviceId: device.deviceId });
    } else {
      for (const tab of presence) if (tab.deviceId === device.deviceId && reachable.has(tab.clientId)) deliver({ kind: "os", clientId: tab.clientId });
      for (const clientId of streamOnlyByDevice.get(device.deviceId) ?? []) deliver({ kind: "os", clientId });
    }
  }
  return deliveries;
}

/**
 * German notification text. The web UI ships no German locale, but a native
 * client may report a German device locale; the server renders only these
 * strings, so a small overlay is enough and unknown keys fall back to English.
 */
const de: Record<string, string> = {
  "notifications.completedBody": "Aufgabe abgeschlossen.",
  "notifications.inputBody": "Warte auf deine Antwort: {detail}",
  "notifications.inputBodyNoDetail": "Warte auf deine Antwort.",
  "notifications.reminderTitle": "Erinnerung: {title}",
  "notifications.reminderBody": "Warte seit {since} auf deine Antwort: {detail}",
  "notifications.reminderBodyNoDetail": "Warte seit {since} auf deine Antwort.",
  "notifications.errorBody": "Lauf fehlgeschlagen: {detail}",
  "notifications.errorBodyNoDetail": "Lauf fehlgeschlagen.",
  "notifications.modelSwitchBody": "Gewechselt {from} → {to}: {detail}",
  "notifications.modelSwitchBodyNoDetail": "Gewechselt {from} → {to}.",
  "notifications.testBody": "Benachrichtigungen funktionieren.",
  "notifications.untitledSession": "omp-Sitzung",
};

const dictionaries: Record<string, Record<string, string>> = { en, ja, "zh-CN": zhCN, de };

function renderFor(event: NotificationEvent, locale: string): RenderedNotification {
  // "de-DE" uses the German text, "en-US" English, and an exact ship locale wins.
  const base = locale.split("-")[0];
  const dictionary = Object.hasOwn(dictionaries, locale)
    ? dictionaries[locale]
    : Object.hasOwn(dictionaries, base) ? dictionaries[base] : dictionaries.en;
  return renderNotification(event, (key, vars) => {
    const template = dictionary[key] ?? dictionaries.en[key] ?? key;
    return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template;
  });
}

/** `String()` of Node's multi-address connect failure is just "AggregateError"; name each address's cause instead. */
function describePushError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) return error.errors.map(describePushError).join("; ");
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** The device still wants pushes at this endpoint; false when the store cannot tell. */
function stillSubscribed(deviceId: string, endpoint: string): boolean {
  try {
    const device = getDevice(deviceId);
    return device?.prefs.enabled === true && device.subscription?.endpoint === endpoint;
  } catch {
    return false;
  }
}

/** The dialog a retraction is about. */
/**
 * True while this dialog's retraction still covers a push retry. Every path
 * that settles a dialog (answer, cancel, expiry, process exit) records one,
 * and `sendPush` asks before every attempt: a retry that wakes up after
 * another client answered must never re-deliver a question nobody can answer.
 */
async function sendPush(device: NotificationDevice, event: NotificationEvent, retryDelaysMs: readonly number[] = []): Promise<{ ok: true } | { ok: false; error: string }> {
  const subscription = device.subscription;
  if (!subscription) return { ok: false, error: "no push subscription" };
  for (let attempt = 0; ; attempt++) {
    try {
      const { publicKey, privateKey } = getVapidKeys(webpush.generateVAPIDKeys);
      await webpush.sendNotification(subscription, JSON.stringify({
        ...renderFor(event, device.prefs.locale),
        type: event.type,
      }), {
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
        if (status === 404 || status === 410) dropDeviceSubscription(device.deviceId, subscription.endpoint);
      } catch {
        // A store write failure only delays the cleanup to the next push.
      }
      const message = status ? `push service answered ${status}` : describePushError(error);
      // No answer (offline, DNS, timeout) or a busy push service: the next attempt may get through.
      const delay = status === undefined || status === 429 || status >= 500 ? retryDelaysMs[attempt] : undefined;
      if (delay === undefined) {
        console.warn("[notifications] push failed:", message);
        return { ok: false, error: message };
      }
      console.warn(`[notifications] push failed, retrying in ${delay / 1000}s:`, message);
      await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
      if (!stillSubscribed(device.deviceId, subscription.endpoint)) return { ok: false, error: message };
    }
  }
}

/**
 * Apple's push service is the one endpoint where a push that displays nothing
 * costs the permission itself: iOS revokes Web Push for the site. Dismiss
 * pushes therefore never go there; the app clears the notification when its
 * own answer reaches the server, or the stale one is replaced by the next
 * `input` push of the same tag.
 */
export function isApplePushEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === "web.push.apple.com" || host.endsWith(".push.apple.com");
  } catch {
    return false;
  }
}

/** Never throws: callers publish from the RPC frame path, and a store failure must not cost them the frame. */
export function publishNotification(event: NotificationEvent): void {
  const state = hub();
  let devices: NotificationDevice[] = [];
  try {
    devices = listDevices();
  } catch (error) {
    console.warn("[notifications] store unavailable:", error);
  }
  const presence = livePresence(Date.now());
  // The Notifications tab lists what a device asked for, received or not; one the user watched happen is already read.
  const { type } = event;
  if (type !== "test" && devices.some((device) =>
    device.prefs.enabled && device.prefs.types[type])) {
    try {
      recordHistory(event, { read: isOnScreen(event, presence) });
    } catch (error) {
      console.warn("[notifications] history write failed:", error);
    }
  }
  const reachable = reachableTabs();
  for (const delivery of routeNotification(event, presence, reachable, devices)) {
    if (delivery.kind === "push") {
      const device = devices.find((entry) => entry.deviceId === delivery.deviceId);
      if (device) void sendPush(device, event, PUSH_RETRY_DELAYS_MS);
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

/** Settings "Send test notification" for a device with push: reports whether the push service accepted it.
 * One attempt, so the button answers at once. */
export async function sendTestPush(deviceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const device = getDevice(deviceId);
  if (!device) return { ok: false, error: "unknown device" };
  return sendPush(device, { type: "test", sessionId: "", sessionName: "omp web" });
}
