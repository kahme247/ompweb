"use client";

import { BellOff, CheckCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { OPEN_SESSION_EVENT } from "@/lib/notification-client";
import { renderNotification, type NotificationHistoryEntry } from "@/lib/notification-events";
import { notificationHistory, useNotificationHistory, useUnreadNotificationCount } from "@/lib/notification-history";
import { ClampedDescription, createSwipeTracker, descriptionBaseStyle, dismissButtonStyle, DRAG_SLOP_PX, KindIcon, useDragClickGuard, type SwipeTracker } from "./ui/toast";

/** Sideways travel that dismisses on release, the same distance as base-ui's toast swipe. */
const SWIPE_DISMISS_PX = 40;
/** Outlasts the 150ms exit transition; a timer, because a hidden panel cancels transitionend. */
const EXIT_MS = 200;

const actionButtonStyle = { display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-dim)" } as const;

/** Mark-all-read and clear: the toolbar of the Notifications tab and of the bell popover. */
export function NotificationActions() {
  const { t } = useI18n();
  const unread = useUnreadNotificationCount();
  return (
    <div style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "0 2px" }} role="toolbar" aria-label={t("appShell.notifications")}>
      {/* aria-disabled (not disabled) keeps the button focusable after use. */}
      <button
        type="button"
        onClick={notificationHistory.markAllRead}
        aria-disabled={unread === 0}
        title={t("appShell.notificationsMarkRead")}
        aria-label={t("appShell.notificationsMarkRead")}
        className="ui-focus-ring"
        style={{ ...actionButtonStyle, cursor: unread === 0 ? "default" : "pointer", opacity: unread === 0 ? 0.5 : 1 }}
        onMouseEnter={(e) => { if (unread === 0) return; e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
      >
        <CheckCheck size={13} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={notificationHistory.clear}
        title={t("appShell.notificationsClear")}
        aria-label={t("appShell.notificationsClear")}
        className="ui-focus-ring"
        style={{ ...actionButtonStyle, cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
      >
        <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The persisted notification history, newest first: the mobile Notifications tab and the desktop bell popover. */
export function NotificationList() {
  const { t } = useI18n();
  const entries = useNotificationHistory();
  if (entries.length === 0) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, textAlign: "center" }}>
        <BellOff size={26} strokeWidth={1.5} aria-hidden="true" style={{ color: "var(--text-dim)" }} />
        <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 600 }}>{t("appShell.notificationsEmpty")}</div>
      </div>
    );
  }
  return (
    // overflowX hidden: a row swiped away must not flash a horizontal scrollbar.
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
      <ul style={{ listStyle: "none", margin: 0, padding: 4 }}>
        {entries.map((entry) => <NotificationRow key={entry.id} entry={entry} />)}
      </ul>
    </div>
  );
}

/**
 * One notification. A touch or pen swipe sideways dismisses it, like Android;
 * a mouse drag keeps selecting text. The swipe can start anywhere on the row
 * except its buttons and links.
 */
function NotificationRow({ entry }: { entry: NotificationHistoryEntry }) {
  const { t, locale } = useI18n();
  const { title, body } = renderNotification(entry.event, t);
  const { sessionId } = entry.event;
  // Following a notification is reading it.
  const open = sessionId ? () => {
    notificationHistory.markRead(entry.id);
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: sessionId }));
  } : undefined;
  const clickGuard = useDragClickGuard();
  const drag = useRef<{ id: number; x: number; y: number; claimed: boolean; tracker: SwipeTracker } | null>(null);
  const [offset, setOffset] = useState(0);
  const [leaving, setLeaving] = useState<-1 | 1 | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => notificationHistory.remove(entry.id), EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving, entry.id]);
  return (
    <li
      data-swipe-dismiss
      // With an action the row is the only way to run it (there is no Open link), so keyboard users can focus it.
      tabIndex={open ? 0 : undefined}
      className={open ? "ui-focus-ring" : undefined}
      onKeyDown={open ? (event) => {
        if ((event.key !== "Enter" && event.key !== " ") || event.target !== event.currentTarget) return;
        event.preventDefault();
        open();
      } : undefined}
      onPointerDown={(event) => {
        clickGuard.onPointerDown(event);
        // A second finger never takes over a swipe in progress; any other
        // leftover (a pen lifted outside the row) is simply replaced.
        if (drag.current?.claimed || leaving || event.pointerType === "mouse" || event.button !== 0) return;
        drag.current = null;
        // The expandable description is text, not a control: a swipe starting
        // on it dismisses the row exactly as it did when it was a span. Only
        // real controls (e.g. the dismiss button) opt out of starting a drag.
        if (event.target instanceof Element && event.target.closest("button:not([aria-expanded]), a, input, textarea, select")) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, claimed: false, tracker: createSwipeTracker(event.clientX) };
      }}
      onPointerMove={(event) => {
        clickGuard.onPointerMove(event);
        const current = drag.current;
        if (!current || event.pointerId !== current.id) return;
        const dx = current.tracker.track(event.clientX);
        if (!current.claimed) {
          // Claim only a clearly sideways drag. A vertical one is the list
          // scrolling: touch-action pan-y hands it to the browser, which
          // then cancels this pointer.
          if (Math.abs(dx) < DRAG_SLOP_PX || Math.abs(dx) <= Math.abs(event.clientY - current.y)) return;
          current.claimed = true;
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        setOffset(dx);
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.id) return;
        drag.current = null;
        setDragging(false);
        const dx = event.clientX - current.x;
        // Judge the whole movement, not its path: a curved thumb stroke still
        // counts, but turning back toward the start puts the row back.
        if (current.claimed && Math.abs(dx) >= SWIPE_DISMISS_PX && Math.abs(dx) > Math.abs(event.clientY - current.y) && !current.tracker.pulledBack(event.clientX)) {
          setLeaving(dx > 0 ? 1 : -1);
        } else {
          setOffset(0);
        }
      }}
      onPointerCancel={(event) => {
        if (event.pointerId !== drag.current?.id) return;
        drag.current = null;
        setDragging(false);
        setOffset(0);
      }}
      onClickCapture={clickGuard.onClickCapture}
      // Like the toast card: a click anywhere but the controls and expandable text opens it.
      onClick={open ? (event) => {
        if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select, [aria-expanded]")) return;
        if (window.getSelection()?.isCollapsed === false) return;
        open();
      } : undefined}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: 8,
        borderRadius: "var(--radius-control)",
        background: entry.read ? undefined : "var(--bg-subtle)",
        cursor: open ? "pointer" : undefined,
        touchAction: "pan-y",
        transform: leaving ? `translateX(${leaving * 110}%)` : offset ? `translateX(${offset}px)` : undefined,
        opacity: leaving ? 0 : 1 - Math.min(Math.abs(offset) / 400, 0.5),
        transition: dragging ? "none" : "transform var(--dur-fast) var(--ease-out-warm), opacity var(--dur-fast) var(--ease-out-warm)",
      }}
    >
      {/* Unread marker in a fixed leading slot, so read and unread rows keep their text aligned. */}
      <span style={{ width: 8, flexShrink: 0, display: "flex", justifyContent: "center", paddingTop: 6 }}>
        {!entry.read && <span role="img" aria-label={t("appShell.notificationUnread")} style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--accent)" }} />}
      </span>
      <KindIcon kind={entry.event.type === "error" ? "error" : "info"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span className="display-serif" style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4, overflowWrap: "anywhere", color: entry.read ? "var(--text-muted)" : "var(--text)", fontWeight: entry.read ? 400 : 600 }}>{title}</span>
          <time dateTime={new Date(entry.at).toISOString()} style={{ fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
            {new Date(entry.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
        <div style={{ ...descriptionBaseStyle, overflowWrap: "anywhere" }}>
          <ClampedDescription>{body}</ClampedDescription>
        </div>
      </div>
      <button
        type="button"
        onClick={(event) => {
          // Dismissing unmounts this button (and the list, if it was the
          // last entry); keep keyboard focus in the tab panel or bell popover.
          const panel = event.currentTarget.closest<HTMLElement>('[role="tabpanel"], [role="dialog"]');
          notificationHistory.remove(entry.id);
          panel?.focus();
        }}
        aria-label={t("appShell.notificationDismiss")}
        title={t("appShell.notificationDismiss")}
        className="toast-close-button ui-focus-ring"
        style={dismissButtonStyle}
      >
        <X size={12} strokeWidth={2} aria-hidden />
      </button>
    </li>
  );
}
