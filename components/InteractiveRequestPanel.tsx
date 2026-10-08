"use client";

import { useCallback, useLayoutEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { CHAT_COLUMN_MAX_WIDTH } from "@/lib/chat-layout";
import { ExtensionDialog, type ExtensionDialogRequest, type ExtensionDialogResponse } from "./ExtensionDialog";

interface Props {
  request: ExtensionDialogRequest | null;
  mobile: boolean;
  obscured?: boolean;
  onRespond: (request: ExtensionDialogRequest, response: ExtensionDialogResponse) => void;
  onMobileRequestChange?: (minimize: (() => void) | null) => void;
}

/** A request has its own visibility, independent of the composer and breakpoint. */
export function InteractiveRequestPanel({ request, mobile, obscured = false, onRespond, onMobileRequestChange }: Props) {
  const { t } = useI18n();
  const requestId = request?.id;
  const [visibility, setVisibility] = useState({ id: requestId, minimized: false });
  // Reset only for a different request identity, not a replayed SSE object.
  if (visibility.id !== requestId) {
    setVisibility({ id: requestId, minimized: false });
  }
  const minimized = visibility.id === requestId && visibility.minimized;
  const minimize = useCallback(() => {
    setVisibility((current) => current.id === requestId ? { ...current, minimized: true } : current);
  }, [requestId]);
  const reopen = () => setVisibility({ id: requestId, minimized: false });

  useLayoutEffect(() => {
    onMobileRequestChange?.(requestId && mobile && !minimized ? minimize : null);
    return () => onMobileRequestChange?.(null);
  }, [requestId, mobile, minimized, minimize, onMobileRequestChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flexShrink: mobile ? 0 : 1, padding: request && !mobile ? "0 16px" : undefined }}>
      {request && (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, width: "100%", maxWidth: CHAT_COLUMN_MAX_WIDTH, margin: "0 auto", minHeight: 0 }}>
          {minimized && (
            <div className="ui-compact-surface" style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flexShrink: 0, padding: "8px 12px", margin: "8px 16px", flexWrap: "wrap" }}>
              <span role="status" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", color: "var(--text-muted)", fontSize: 13 }}>{t("chatWindow.responsePending")}</span>
              <button
                type="button"
                data-extension-request-reopen
                data-extension-request-opener
                style={{ minHeight: 44, maxWidth: "100%", padding: "8px 12px", border: "1px solid var(--accent-strong)", borderRadius: 6, background: "var(--accent-strong)", color: "var(--on-accent)", cursor: "pointer", whiteSpace: "normal", fontFamily: "inherit" }}
                onClick={reopen}
              >
                {t("chatWindow.openRequest")}
              </button>
            </div>
          )}
          <ExtensionDialog
            request={request}
            onRespond={onRespond}
            attached={!mobile}
            mobile={mobile}
            obscured={obscured}
            minimized={minimized}
            onMinimize={minimize}
          />
        </div>
      )}
    </div>
  );
}
