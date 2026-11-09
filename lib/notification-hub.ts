import webpush from "web-push";
import en from "./i18n/locales/en.json";
import ja from "./i18n/locales/ja.json";
import zhCN from "./i18n/locales/zh-CN.json";
import {
  renderNotification,
  type NotificationEvent,
  type RenderedNotification,
} from "./notification-events";
import { dropDeviceSubscription, getDevice, getVapidKeys, listDevices, markHistoryRead, recordHistory, type NotificationDevice } from "./notification-store";

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

/**
 * Reminder spacing for this process, read on every dialog so tests and a
 * changed environment need no restart. `OMP_WEB_INPUT_REMINDER_MS=0` disables
 * reminders; unset or malformed values keep the default. A value above
 * `2^31-1` is malformed too: it overflows `setTimeout`, which fires
 * immediately, and the cap would burn through in milliseconds.
 */
export function inputReminderIntervalMs(): number | null {
  const raw = process.env.OMP_WEB_INPUT_REMINDER_MS;
  if (raw === undefined || raw.trim() === "") return INPUT_REMINDER_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) return INPUT_REMINDER_MS;
  return value === 0 ? null : value;
}

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

/**
 * A toast/system notification, or the retraction of a session's `input`
 * notification once its dialog was answered, cancelled, expired or its omp
 * child went away. The retraction reaches a tab as `type: "notification-dismiss"`
 * (lib/event-stream-hub.ts wraps it); it is never pushed (see
 * `publishNotificationDismiss`).
 */
export type NotificationMessage =
  | { kind: "toast" | "os"; event: NotificationEvent }
  | { kind: "dismiss"; tag: string; sessionId: string; requestId: string };

type Send = (message: NotificationMessage) => void;

export type Delivery =
  | { kind: "toast" | "os"; clientId: string }
  | { kind: "push"; deviceId: string };

interface HubState {
  presence: Map<string, NotificationPresence>;
  /** Open SSE streams per tab. Independent of presence: streams reconnect, overlap, and close while the tab stays put. */
  streams: Map<string, Set<Send>>;
  /** `<sessionId>:<requestId>` → when it was retracted. A push retry of a settled dialog must deliver nothing (see `publishNotificationDismiss`). */
  retractions: Map<string, number>;
  /**
   * The same, for a settlement a replay may undo: a resync forgets a dialog
   * whose replayed frame can restore the very same request id. The retraction
   * still closes what is on screen and stops a sleeping retry, and publishing
   * that request id again lifts it (see `publishNotification`).
   */
  temporaryRetractions: Map<string, number>;
}

declare global {
  var __ompNotificationHub: HubState | undefined;
}

function hub(): HubState {
  const state = (globalThis.__ompNotificationHub ??= { presence: new Map(), streams: new Map(), retractions: new Map(), temporaryRetractions: new Map() });
  // `bun --hot` keeps this object across a re-evaluation: a state created by
  // the previous module instance may predate a field added here.
  state.retractions ??= new Map();
  state.temporaryRetractions ??= new Map();
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

/** A visible tab is showing the event's conversation (under any of its ids). */
function isOnScreen(event: NotificationEvent, presence: NotificationPresence[]): boolean {
  const viewedAs = new Set([event.sessionId, ...(event.aliases ?? [])]);
  return presence.some((tab) => tab.visible && tab.sessionId !== null && viewedAs.has(tab.sessionId));
}

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
  if (isOnScreen(event, presence)) return [];
  const active = presence.filter((tab) => tab.visible && reachable.has(tab.clientId));
  const deliveries: Delivery[] = [];
  for (const device of devices) {
    if (!device.prefs.enabled || !device.prefs.types[event.type]) continue;
    // The first `input` notification is unaffected; only its repeats are optional.
    if (event.reminder && device.prefs.inputReminder === false) continue;
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
  }, locale);
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

/**
 * True while this dialog's retraction still covers a push retry. Every path
 * that settles a dialog (answer, cancel, expiry, process exit) records one,
 * and `sendPush` asks before every attempt: a retry that wakes up after
 * another client answered must never re-deliver a question nobody can answer.
 * A temporary retraction (a resync that forgot the dialog) counts the same way
 * until the request is published again.
 */
function isRetracted(sessionId: string, requestId: string, now: number): boolean {
  const state = hub();
  const key = `${sessionId}:${requestId}`;
  const at = state.retractions.get(key) ?? state.temporaryRetractions.get(key);
  return at !== undefined && now - at <= PUSH_RETRACTION_TTL_MS;
}

async function sendPush(device: NotificationDevice, event: NotificationEvent, retryDelaysMs: readonly number[] = []): Promise<{ ok: true } | { ok: false; error: string }> {
  const subscription = device.subscription;
  if (!subscription) return { ok: false, error: "no push subscription" };
  for (let attempt = 0; ; attempt++) {
    // A retry can wake long after the dialog was answered, cancelled, expired
    // or its omp child died: delivering now would show a dead question.
    if (event.type === "input" && event.requestId && isRetracted(event.sessionId, event.requestId, Date.now())) {
      return { ok: false, error: "dialog settled" };
    }
    try {
      const { publicKey, privateKey } = getVapidKeys(webpush.generateVAPIDKeys);
      // `type` lets the service worker tell open tabs which kind of entry to list;
      // `requestId`/`dialog` let the app answer without opening the session.
      await webpush.sendNotification(subscription, JSON.stringify({
        ...renderFor(event, device.prefs.locale),
        type: event.type,
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.dialog ? { dialog: event.dialog } : {}),
        ...(event.reminder ? { reminder: true } : {}),
        ...(event.pendingSince ? { pendingSince: event.pendingSince } : {}),
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

/** Never throws: callers publish from the RPC frame path, and a store failure must not cost them the frame. */
export function publishNotification(event: NotificationEvent): void {
  const state = hub();
  // A replayed dialog (resync after a lost link) restores a request a resync
  // had temporarily retracted: it is pending again, so its notification and
  // its pushes must go out as for any other question.
  if (event.type === "input" && event.requestId) state.temporaryRetractions.delete(`${event.sessionId}:${event.requestId}`);
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
    device.prefs.enabled && device.prefs.types[type] && !(event.reminder && device.prefs.inputReminder === false))) {
    try {
      recordHistory(event, { read: isOnScreen(event, presence) });
    } catch (error) {
      console.warn("[notifications] history write failed:", error);
    }
  }
  const reachable = new Set(state.streams.keys());
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

/**
 * Retract a session's `input` notification: its dialog was answered by any
 * client, cancelled, expired, or its omp child went away. Every reachable tab
 * gets the retraction on its stream, and the history entry becomes read
 * because the question is settled.
 *
 * No push goes out: a push that displays nothing counts as a silent push, and
 * Chromium and Firefox answer one with a browser-substituted card ("This site
 * has been updated in the background") and eventually mute the origin, exactly
 * as iOS revokes the permission. A device that is not reachable keeps the stale
 * card until the next `input` push replaces it by tag or the app syncs.
 *
 * Never throws: callers run on the RPC frame path.
 */
export function publishNotificationDismiss(sessionId: string, requestId: string): void {
  retract(sessionId, requestId, "permanent");
}

/**
 * Retract a dialog this server only *forgot*: a resync dropped the pending
 * request, and the replayed frames may restore the very same request id.
 * Everything a retraction does happens (open tabs close it, a sleeping push
 * retry stops, the history entry becomes read), but the record is temporary:
 * publishing that request id again lifts it, so a replayed question is
 * announced and pushed like a new one instead of being suppressed for the
 * retraction TTL. A dialog that is really gone is never replayed, and its
 * notification stays closed.
 */
export function publishNotificationForgotten(sessionId: string, requestId: string): void {
  retract(sessionId, requestId, "temporary");
}

function retract(sessionId: string, requestId: string, kind: "permanent" | "temporary"): void {
  const tag = `${sessionId}:input`;
  const state = hub();
  const now = Date.now();
  // Recorded first: a retry of that `input` push may be sleeping right now.
  for (const [key, at] of state.retractions) {
    if (now - at > PUSH_RETRACTION_TTL_MS) state.retractions.delete(key);
  }
  for (const [key, at] of state.temporaryRetractions) {
    if (now - at > PUSH_RETRACTION_TTL_MS) state.temporaryRetractions.delete(key);
  }
  const key = `${sessionId}:${requestId}`;
  if (kind === "permanent") {
    state.temporaryRetractions.delete(key);
    state.retractions.set(key, now);
  } else if (!state.retractions.has(key)) {
    // A permanent settlement of the same request wins: a replay of an answered
    // dialog must not reopen its notification.
    state.temporaryRetractions.set(key, now);
  }
  // Only the entry of this request is read: a newer dialog of the same tag
  // replaced it in the history, and that one is still waiting for an answer.
  try {
    markHistoryRead([tag], requestId);
  } catch (error) {
    console.warn("[notifications] history read mark failed:", error);
  }
  // Every reachable tab hears it: one that never showed this notification
  // closes nothing, and the frame names the request so a later dialog of the
  // same tag stays. A tab whose stream died keeps nothing to clear.
  for (const sends of state.streams.values()) {
    for (const send of sends) {
      try {
        send({ kind: "dismiss", tag, sessionId, requestId });
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
