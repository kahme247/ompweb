"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useHostRows } from "@/hooks/useHostRows";
import { useI18n } from "@/lib/i18n";
import { CopyField } from "./HostsConfig";
import { hostName, isLocalRow, localInstallCommand } from "./host-status";

export const LOCAL_DAEMON_BANNER_DISMISSED_KEY = "omp-web:local-daemon-banner-dismissed";
// Longer than the daemon's 60 s redial backoff cap, so a restarting daemon does not trip it.
export const LOCAL_DAEMON_GRACE_MS = 90_000;

/** One-time hint to install the ompweb-host service: this machine has not linked since this server started and 90 s have passed. */
export function LocalDaemonBanner() {
  const { t } = useI18n();
  const { hosts } = useHostRows();
  const local = hosts?.find(isLocalRow);
  const missing = local?.daemonManaged === true && local.status === "offline" && local.hostVersion === null;
  const [waited, setWaited] = useState(false);
  // Hidden until storage is read, so a dismissed banner never flashes.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(LOCAL_DAEMON_BANNER_DISMISSED_KEY) === "true");
    } catch {
      setDismissed(false);
    }
  }, []);

  useEffect(() => {
    if (!missing) return;
    const timer = setTimeout(() => setWaited(true), LOCAL_DAEMON_GRACE_MS);
    return () => {
      clearTimeout(timer);
      setWaited(false);
    };
  }, [missing]);

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(LOCAL_DAEMON_BANNER_DISMISSED_KEY, "true");
    } catch {
      // Dismissed for this page view only.
    }
  };
  // The live region stays mounted so screen readers announce the banner when it appears.
  return (
    <div role="status" style={{ position: "fixed", left: 12, bottom: 12, zIndex: 300, maxWidth: "min(92vw, 560px)" }}>
      {local && missing && waited && !dismissed && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "9px 12px", border: "1px solid color-mix(in srgb, var(--status-warning) 40%, var(--border))", borderRadius: "var(--radius-control)", background: "color-mix(in srgb, var(--status-warning) 8%, var(--bg))", color: "var(--text)", fontSize: 12, lineHeight: 1.45, overflowWrap: "anywhere" }}>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
            {t("hostsConfig.localDaemonBanner", { host: hostName(t, local) })}
            <CopyField label={t("hostsConfig.command")} value={localInstallCommand(local.serverPlatform)} />
          </div>
          <button type="button" className="ui-focus-ring" aria-label={t("hostsConfig.dismiss")} onClick={dismiss} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2, display: "inline-flex" }}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
