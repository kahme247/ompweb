"use client";

import { Popover } from "@base-ui/react/popover";
import { Bell } from "lucide-react";
import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { OPEN_SESSION_EVENT } from "@/lib/notification-client";
import { useUnreadNotificationCount } from "@/lib/notification-history";
import { NotificationActions, NotificationList } from "./NotificationList";

/** Desktop top-bar bell: the notification history in a floating, scrollable panel. Mobile uses the right panel's tab. */
export function NotificationBell({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const unread = useUnreadNotificationCount();
  // Opening a session from a row (or a toast) leaves the panel.
  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    window.addEventListener(OPEN_SESSION_EVENT, close);
    return () => window.removeEventListener(OPEN_SESSION_EVENT, close);
  }, [open, onOpenChange]);
  const label = unread > 0 ? t("appShell.notificationsUnreadCount", { count: unread }) : t("appShell.notifications");
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        className="shell-toolbar-btn shell-notification-bell ui-focus-ring"
        title={label}
        aria-label={label}
      >
        <Bell size={16} strokeWidth={1.8} aria-hidden="true" />
        {unread > 0 && (
          <span aria-hidden="true" className="panel-opener-badge">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} collisionPadding={8} style={{ zIndex: 220 }}>
          <Popover.Popup
            className="picker-panel ui-focus-ring"
            style={{
              display: "flex",
              flexDirection: "column",
              width: 380,
              // Viewport units and base-ui's --available-height are painted pixels; the UI scale zooms CSS ones.
              // Under zoom base-ui also drops the collision padding from --available-height, hence the 8px.
              maxWidth: "calc((100vw - 16px) / var(--ui-scale))",
              maxHeight: "min(480px, calc(var(--available-height) / var(--ui-scale) - 8px))",
              outline: "none",
            }}
          >
            <div className="picker-panel-header" style={{ justifyContent: "space-between", paddingRight: 4, flexShrink: 0 }}>
              <Popover.Title className="picker-panel-title" style={{ margin: 0 }}>{t("appShell.notifications")}</Popover.Title>
              <NotificationActions />
            </div>
            <NotificationList />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
