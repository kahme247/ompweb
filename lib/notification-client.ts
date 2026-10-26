/**
 * Browser side of notifications: device identity, per-device preferences,
 * service worker registration, Web Push subscription, and system notifications.
 * Server routing lives in lib/notification-hub.ts.
 */
import {
  DEFAULT_NOTIFICATION_PREFS,
  isValidNotificationId,
  parseNotificationPrefs,
  type NotificationPrefs,
  type RenderedNotification,
} from "./notification-events";

const DEVICE_KEY = "omp-notify-device";
const PREFS_KEY = "omp-notify-prefs";

/** crypto.randomUUID exists only in secure contexts; plain-HTTP LAN origins still need ids. */
function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `id${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** One id per page load: a duplicated tab copies sessionStorage, so it cannot hold this. */
export const notificationClientId = randomId();

let deviceId: string | null = null;

/** Stable per browser profile: shared by all tabs of this browser. */
export function getNotificationDeviceId(): string {
  if (deviceId) return deviceId;
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    deviceId = isValidNotificationId(stored) ? stored : randomId();
    if (deviceId !== stored) localStorage.setItem(DEVICE_KEY, deviceId);
  } catch {
    deviceId ??= randomId();
  }
  return deviceId;
}

// ---------------------------------------------------------------- prefs store

const listeners = new Set<() => void>();
let prefs: NotificationPrefs | null = null;

export function getNotificationPrefs(): NotificationPrefs {
  if (prefs) return prefs;
  try {
    const stored = localStorage.getItem(PREFS_KEY);
    prefs = stored ? parseNotificationPrefs(JSON.parse(stored)) : DEFAULT_NOTIFICATION_PREFS;
  } catch {
    prefs = DEFAULT_NOTIFICATION_PREFS;
  }
  return prefs;
}

/** Whether this browser ever saved notification settings (never-enabled browsers stay off the server). */
export function hasStoredNotificationPrefs(): boolean {
  try {
    return localStorage.getItem(PREFS_KEY) !== null;
  } catch {
    return false;
  }
}

export function subscribeNotificationPrefs(listener: () => void): () => void {
  // Another tab of this browser changed the prefs: drop the cached copy.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PREFS_KEY) return;
    prefs = null;
    listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Save locally, then mirror to the server (which routes pushes while no tab is open). */
export async function updateNotificationPrefs(patch: Partial<NotificationPrefs>): Promise<void> {
  prefs = null; // merge into the latest stored copy, not a stale one from before another tab's change
  prefs = { ...getNotificationPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // storage unavailable: prefs still apply for this page and on the server
  }
  listeners.forEach((listener) => listener());
  await syncNotificationDevice();
}

let syncQueue: Promise<unknown> = Promise.resolve();

/**
 * Send prefs (and optionally a new push subscription) to the server.
 * Returns whether the server holds a push subscription for this device.
 * Requests run one at a time and read the prefs when they start, so a slow
 * older request can never land after a newer one with stale prefs.
 */
export function syncNotificationDevice(subscription?: PushSubscriptionJSON): Promise<boolean> {
  const request = syncQueue.catch(() => {}).then(async () => {
    const response = await fetch("/api/notifications/devices", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: getNotificationDeviceId(), prefs: getNotificationPrefs(), subscription }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && "subscribed" in body && body.subscribed === true;
  });
  syncQueue = request;
  return request;
}

// ---------------------------------------------------------------- support

export type NotificationSupport = "unsupported" | "insecure" | "ios-install" | "denied" | "no-push" | "push";

function isIosBrowserTab(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches || ("standalone" in navigator && navigator.standalone === true);
  return ios && !standalone;
}

/** What this browser can do for system notifications. In-app toasts work everywhere. */
export function getNotificationSupport(): NotificationSupport {
  if (!window.isSecureContext) return "insecure";
  if (isIosBrowserTab()) return "ios-install";
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "PushManager" in window ? "push" : "no-push";
}

// ---------------------------------------------------------------- service worker + push

/** Registers the worker and resolves once one is active (subscribing needs an active worker). */
export async function registerNotificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function sameKey(key: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!key) return false;
  const actual = new Uint8Array(key);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

let ensuring: Promise<boolean> | null = null;

/**
 * Make sure this device has a working push subscription for the server's
 * VAPID key and the server knows it. Needs notification permission already
 * granted. Returns whether push is active. Single-flight: two overlapping runs
 * would each replace the other's subscription and store a dead one.
 */
export function ensurePushSubscription(): Promise<boolean> {
  ensuring ??= subscribeForPush().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

async function subscribeForPush(): Promise<boolean> {
  if (getNotificationSupport() !== "push" || Notification.permission !== "granted") return false;
  const registration = await registerNotificationWorker();
  if (!registration) return false;
  const response = await fetch(`/api/notifications/devices?deviceId=${encodeURIComponent(getNotificationDeviceId())}`);
  if (!response.ok) return false;
  const { publicKey, subscribed }: { publicKey: string; subscribed: boolean } = await response.json();
  const applicationServerKey = base64UrlToBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // Replace a subscription signed for other server keys, or one the server
  // dropped after the push service reported it gone (re-sending it would loop).
  if (subscription && (!sameKey(subscription.options.applicationServerKey, applicationServerKey) || !subscribed)) {
    await subscription.unsubscribe().catch(() => false);
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  return syncNotificationDevice(subscription.toJSON());
}

/** Window event (detail: session id) asking the app to open a notification's session. */
export const OPEN_SESSION_EVENT = "omp-open-session";

/**
 * Show a system notification the same way the service worker shows pushes.
 * Returns false when the browser does not allow it, so the caller can fall back.
 */
export async function showSystemNotification(notification: RenderedNotification): Promise<boolean> {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const options: NotificationOptions = {
    body: notification.body,
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    tag: notification.tag,
    data: { url: notification.url, sessionId: notification.sessionId },
  };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration) {
      await registration.showNotification(notification.title, options);
      return true;
    }
    // No worker: Chrome on Android throws here, desktop browsers show it.
    const fallback = new Notification(notification.title, options);
    fallback.onclick = () => {
      fallback.close();
      window.focus();
      window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: notification.sessionId }));
    };
    return true;
  } catch {
    return false;
  }
}
