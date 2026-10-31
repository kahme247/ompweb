import { useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { translate } from "@/lib/i18n";
import { openEventStream } from "@/lib/event-stream";
import { DEFAULT_NOTIFICATION_PREFS, renderNotification, type NotificationEvent, type RenderedNotification } from "@/lib/notification-events";
import { notificationHistory } from "@/lib/notification-history";
import { isRecord } from "@/lib/type-guards";
import {
  ensurePushSubscription,
  getNotificationDeviceId,
  getNotificationPrefs,
  hasStoredNotificationPrefs,
  notificationClientId,
  OPEN_SESSION_EVENT,
  showSystemNotification,
  subscribeNotificationPrefs,
  syncNotificationDevice,
  updateNotificationPrefs,
} from "@/lib/notification-client";

const PRESENCE_INTERVAL_MS = 30_000;
/** Without input for this long a visible tab no longer counts as the user being there. */
const IDLE_AFTER_MS = 3 * 60_000;
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "focus"] as const;
/** Orders this page's presence reports; it outlives effect re-runs, so a session switch never restarts it. */
let presenceSeq = 0;

/** Current per-device notification prefs (re-renders on change). */
export function useNotificationPrefs() {
  return useSyncExternalStore(subscribeNotificationPrefs, getNotificationPrefs, () => DEFAULT_NOTIFICATION_PREFS);
}

/**
 * App-level notification wiring, mounted once in AppShell:
 * - tells the server which session this tab shows and whether the user is here;
 * - shows toasts / system notifications the server routes to this tab;
 * - opens the session when a notification is clicked;
 * - keeps the server's copy of this device's prefs and push subscription current.
 *
 * `sessionId` is the session whose chat is on screen (null while Settings or
 * another view covers it).
 */
export function useNotifications({ sessionId, locale, onOpenSession }: { sessionId: string | null; locale: string; onOpenSession: (sessionId: string) => void }) {
  const openRef = useRef(onOpenSession);
  useEffect(() => {
    openRef.current = onOpenSession;
  }, [onOpenSession]);

  // Presence: visible and recently used. Reported on every change, plus a keep-alive.
  useEffect(() => {
    let lastInput = Date.now();
    let reported: boolean | null = null;
    const present = () => document.visibilityState === "visible" && Date.now() - lastInput < IDLE_AFTER_MS;
    const report = (visible = present()) => {
      reported = visible;
      presenceSeq += 1;
      const body = JSON.stringify({ clientId: notificationClientId, deviceId: getNotificationDeviceId(), visible, sessionId, seq: presenceSeq });
      if (!visible && navigator.sendBeacon) {
        navigator.sendBeacon("/api/notifications/presence", new Blob([body], { type: "application/json" }));
        return;
      }
      void fetch("/api/notifications/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
    };
    const onActivity = () => {
      lastInput = Date.now();
      if (reported === false && present()) report();
    };
    const onVisibility = () => report();
    const onPageHide = () => report(false);
    report();
    const timer = setInterval(() => {
      // Keep-alive while present; one report when the user goes idle.
      if (present() || reported) report();
    }, PRESENCE_INTERVAL_MS);
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, onActivity, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(timer);
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [sessionId]);

  // Pushes are written in the device's language.
  useEffect(() => {
    const prefs = getNotificationPrefs();
    if (prefs.enabled && prefs.locale !== locale) void updateNotificationPrefs({ locale }).catch(() => {});
  }, [locale]);

  // Startup sync for any browser with saved settings: the server may have lost
  // its store, missed a save (including turning notifications off), or the
  // browser its subscription. Browsers that never opened the setting stay off
  // the server's device list.
  useEffect(() => {
    if (!hasStoredNotificationPrefs()) return;
    void (async () => {
      const pushActive = getNotificationPrefs().enabled && (await ensurePushSubscription().catch(() => false));
      if (!pushActive) await syncNotificationDevice();
    })().catch(() => {});
  }, []);

  // The persisted Notifications list: loaded now and whenever the tab comes back, which brings read marks and removals from other devices.
  useEffect(() => {
    void notificationHistory.load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void notificationHistory.load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Delivery to this tab and notification clicks. Every open goes through
  // OPEN_SESSION_EVENT, so listeners such as the bell popover see each one.
  useEffect(() => {
    const openSession = (sessionId: string) => window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: sessionId }));
    // Request id of the toast each tag currently shows. A retraction names the
    // request it closes, so a toast replaced by the next dialog of that tag stays.
    const toastRequests = new Map<string, string | undefined>();
    const showToast = (rendered: RenderedNotification, type: NotificationEvent["type"], requestId?: string) => {
      const show = type === "error" ? toast.error : toast.info;
      const target = rendered.sessionId;
      toastRequests.set(rendered.tag, requestId);
      // The whole card opens the session (click, tap, or Enter on the focused card); following it is reading it.
      show(rendered.title, rendered.body, {
        id: rendered.tag,
        onClick: target ? () => {
          notificationHistory.markRead(rendered.tag);
          openSession(target);
        } : undefined,
      });
    };
    const deliver = (kind: "toast" | "os", event: NotificationEvent) => {
      // The server has already recorded it.
      notificationHistory.add(event);
      const rendered = renderNotification(event, translate);
      if (kind === "toast") {
        showToast(rendered, event.type, event.requestId);
        return;
      }
      // Permission withdrawn or never granted: the toast is the only way left to tell the user.
      void showSystemNotification(rendered, event.requestId).then((shown) => {
        if (!shown) showToast(rendered, event.type, event.requestId);
      });
    };
    // The dialog was answered, cancelled or expired elsewhere. Close only the
    // notification of that request id: a buffered push can arrive after the
    // next dialog for the same tag is already shown, and that one stays.
    const dismiss = async (tag: string, requestId: string) => {
      if (toastRequests.get(tag) === requestId) {
        toastRequests.delete(tag);
        toast.close(tag);
      }
      try {
        const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
        const shown = await registration?.getNotifications({ tag }) ?? [];
        for (const notification of shown) {
          const data: unknown = notification.data;
          if (isRecord(data) && data.requestId === requestId) notification.close();
        }
      } catch {
        // A closing registration must not break the toast path.
      }
    };
    const onOpen = (raw: Event) => {
      if (raw instanceof CustomEvent && typeof raw.detail === "string" && raw.detail) openRef.current(raw.detail);
    };
    const onWorkerMessage = (message: MessageEvent) => {
      const data: unknown = message.data;
      if (!isRecord(data)) return;
      if (data.type === "omp-open-session" && typeof data.sessionId === "string") {
        openSession(data.sessionId);
        return;
      }
      // A push the service worker showed while this tab was open: the server recorded it; fetch the list.
      if (data.type === "omp-notification-shown") void notificationHistory.load();
    };
    // This tab's own channel: the server delivers here while it is open, on any
    // view (the chat, Settings, ...), and counts the tab as reachable. A settled
    // input dialog arrives as a dismiss frame and retracts only its own request.
    const stream = openEventStream({ kind: "notifications", clientId: notificationClientId });
    stream.onmessage = ({ data }) => {
      try {
        const frame: unknown = JSON.parse(data);
        if (!isRecord(frame)) return;
        if (frame.type === "notification-dismiss") {
          if (typeof frame.tag === "string" && frame.tag && typeof frame.requestId === "string" && frame.requestId) {
            void dismiss(frame.tag, frame.requestId);
          }
          return;
        }
        if (frame.type !== "notification" || (frame.kind !== "toast" && frame.kind !== "os") || !isRecord(frame.event)) return;
        // Built by our own server's notification hub from a NotificationEvent.
        const event = frame.event as unknown as NotificationEvent;
        deliver(frame.kind, event);
      } catch {
        // ignore malformed frames
      }
    };
    window.addEventListener(OPEN_SESSION_EVENT, onOpen);
    navigator.serviceWorker?.addEventListener("message", onWorkerMessage);
    return () => {
      stream.close();
      window.removeEventListener(OPEN_SESSION_EVENT, onOpen);
      navigator.serviceWorker?.removeEventListener("message", onWorkerMessage);
    };
  }, []);
}
