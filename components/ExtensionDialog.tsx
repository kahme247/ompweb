"use client";

import { useEffect, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";

export type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };

/**
 * Overlay dialog for `select` / `confirm` / `input` / `editor` extension UI
 * requests. Polished UX:
 *   - entrance animation (fade backdrop + scale-in panel)
 *   - focus trap: focus moves into the dialog on open and is returned to the
 *     opener on close; Tab/Shift-Tab wrap inside (via useModalDialog)
 *   - Escape closes as "cancelled" (document-level, top-of-stack only)
 *   - backdrop click closes as "cancelled"
 * Logic and i18n keys are unchanged from the in-ChatWindow original.
 */
export function ExtensionDialog({
  request,
  onRespond,
  attached = false,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: ExtensionDialogResponse) => void;
  /** Render as a composer panel instead of a full-chat overlay. */
  attached?: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [selectedOption, setSelectedOption] = useState<string | null>(null);

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setSelectedOption(null);
  }, [request]);

  const cancel = () => onRespond(request, { cancelled: true });

  // useModalDialog gives us: focus-in on open, focus-restore on close,
  // document-level Escape (top-of-stack), and Tab wrapping inside the panel.
  const panelRef = useModalDialog<HTMLDivElement>({
    onClose: cancel,
    // A composer-attached request is a regular in-flow panel, not a modal.
    active: !attached,
  });

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else if (request.method === "select") {
      if (selectedOption) onRespond(request, { value: selectedOption });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      className={attached ? undefined : "animate-fade-in"}
      onMouseDown={attached ? undefined : (event) => {
        // Close when the pointer goes down on the backdrop itself (not when
        // the press starts inside the panel and is dragged out).
        if (event.target === event.currentTarget) cancel();
      }}
      style={attached ? { width: "100%", flexShrink: 0 } : {
        position: "absolute",
        inset: 0,
        zIndex: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--overlay-backdrop)",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={attached ? undefined : "true"}
        aria-label={request.title}
        tabIndex={-1}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(560px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: attached ? "var(--radius-card)" : "var(--radius-modal)",
          background: "var(--bg)",
          boxShadow: attached ? "var(--shadow-card)" : "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
          maxHeight: attached ? "min(420px, 60vh)" : undefined,
        }}
      >
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{t("chatWindow.extensionRequest")}</div>
        </div>

        <div style={{ padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => {
                const selected = selectedOption === option;
                return (
                  <button
                    key={option}
                    onClick={() => attached ? setSelectedOption(option) : onRespond(request, { value: option })}
                    aria-pressed={attached ? selected : undefined}
                    style={{
                      width: "100%",
                      padding: "9px 10px",
                      borderRadius: 7,
                      border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                      background: selected ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))" : "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 13,
                      transition: attached ? undefined : "background-color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)",
                    }}
                    onMouseEnter={attached ? undefined : (e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={attached ? undefined : (e) => { e.currentTarget.style.background = "var(--bg-panel)"; }}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              aria-label={request.title || request.placeholder || "Input value"}
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              aria-label={request.title || "Input value"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={cancel}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
              transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "var(--bg)"; e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {t("chatWindow.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent-strong)",
                background: "var(--accent-strong)",
                color: "var(--on-accent)",
                cursor: "pointer",
                transition: "background-color var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.12)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
            >
              {t("chatWindow.confirm")}
            </button>
          ) : request.method === "select" && attached ? (
            <button
              onClick={submitValue}
              disabled={!selectedOption}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent-strong)",
                background: selectedOption ? "var(--accent-strong)" : "var(--bg-subtle)",
                color: selectedOption ? "var(--on-accent)" : "var(--text-dim)",
                cursor: selectedOption ? "pointer" : "not-allowed",
                opacity: selectedOption ? 1 : 0.65,
              }}
            >
              {t("chatWindow.next")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent-strong)",
                background: "var(--accent-strong)",
                color: "var(--on-accent)",
                cursor: "pointer",
                transition: "background-color var(--dur-fast) var(--ease-out-warm)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.12)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
            >
              {t("chatWindow.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
