"use client";

import { useEffect, useRef, useState } from "react";
import type { ExtensionUiRequest } from "@/lib/types";
import type { RpcAskDialogAnswer } from "@/lib/pi-types";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";

export type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" }
>;

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | { answers: RpcAskDialogAnswer[] };

type AskDraft = { selected: string[]; other: string };
const EMPTY_ASK_DRAFT: AskDraft = { selected: [], other: "" };

/** Single-select questions start on their recommended option. */
function initialAskDrafts(request: ExtensionDialogRequest): AskDraft[] {
  if (request.method !== "ask") return [];
  return request.questions.map((question) => {
    const recommended = question.multi || question.recommended === undefined ? undefined : question.options[question.recommended];
    return { selected: recommended ? [recommended.label] : [], other: "" };
  });
}

/**
 * Overlay dialog for `select` / `confirm` / `input` / `editor` / `ask` extension UI
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
  const requestIdRef = useRef(request.id);
  const [askDrafts, setAskDrafts] = useState(() => initialAskDrafts(request));

  useEffect(() => {
    // SSE reconnects replay the same request as a fresh object, not a new question.
    if (requestIdRef.current === request.id) return;
    requestIdRef.current = request.id;
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setSelectedOption(null);
    setAskDrafts(initialAskDrafts(request));
  }, [request]);

  const askDraftAt = (index: number) => askDrafts[index] ?? EMPTY_ASK_DRAFT;
  // Multi-select may stay empty; single-select needs a choice or an answer.
  const canSubmit = request.method === "ask"
    ? request.questions.every((question, index) =>
      question.multi || askDraftAt(index).selected.length > 0 || askDraftAt(index).other.trim() !== "")
    : request.method !== "select" || selectedOption !== null;
  const title = request.method === "ask" ? t("chatWindow.askTitle") : request.title;

  const cancel = () => onRespond(request, { cancelled: true });

  // useModalDialog gives us: focus-in on open, focus-restore on close,
  // document-level Escape (top-of-stack), and Tab wrapping inside the panel.
  const panelRef = useModalDialog<HTMLDivElement>({
    onClose: cancel,
    // A composer-attached request is a regular in-flow panel, not a modal.
    active: !attached,
  });
  useEffect(() => {
    if (!attached) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = panel.querySelector<HTMLElement>("input, textarea, button:not([disabled])");
      (target ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attached, panelRef, request.id]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else if (request.method === "select") {
      if (selectedOption) onRespond(request, { value: selectedOption });
    } else if (request.method === "ask") {
      if (!canSubmit) return;
      onRespond(request, {
        answers: request.questions.map((question, index) => {
          const draft = askDraftAt(index);
          const customInput = draft.other.trim();
          return {
            id: question.id,
            selectedOptions: question.options.map((option) => option.label).filter((label) => draft.selected.includes(label)),
            ...(customInput ? { customInput } : {}),
          };
        }),
      });
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
        aria-label={title}
        tabIndex={-1}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(560px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: attached ? "var(--radius-card)" : "var(--radius-modal)",
          background: "var(--bg)",
          boxShadow: attached ? "var(--shadow-card)" : "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
          maxHeight: attached ? "min(420px, 60dvh)" : "100%",
        }}
      >
        <div style={{ minHeight: 0, overflowY: "auto", overflowWrap: "anywhere" }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650, whiteSpace: "pre-wrap" }}>{title}</div>
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
                      padding: "7px 10px",
                      borderRadius: 6,
                      border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                      background: selected ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))" : "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 12.5,
                      fontFamily: "inherit",
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
                padding: "7px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 12,
                fontFamily: "inherit",
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
                height: "min(220px, 30dvh)",
                minHeight: 80,
                padding: 10,
                borderRadius: 7,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: request.promptStyle ? "var(--chat-font-size)" : 13,
                lineHeight: 1.55,
                fontFamily: request.promptStyle ? "inherit" : "var(--font-mono)",
              }}
            />
          )}
          {request.method === "ask" && (
            <div style={{ display: "grid", gap: 16 }}>
              {request.questions.map((question, index) => {
                const draft = askDraftAt(index);
                return (
                  <fieldset key={question.id} style={{ margin: 0, padding: 0, border: "none", minWidth: 0, display: "grid", gap: 8 }}>
                    <legend style={{ padding: 0, marginBottom: 8, color: "var(--text)", fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>
                      {question.header && (
                        <span style={{ display: "inline-block", marginRight: 6, padding: "0 7px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: 11, fontWeight: 500 }}>
                          {question.header}
                        </span>
                      )}
                      <span style={{ whiteSpace: "pre-wrap" }}>{question.question}</span>
                    </legend>
                    {question.options.map((option, optionIndex) => {
                      const checked = draft.selected.includes(option.label);
                      return (
                        <label
                          key={option.label}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 8,
                            padding: "8px 10px",
                            borderRadius: 7,
                            border: `1px solid ${checked ? "var(--accent)" : "var(--border)"}`,
                            background: checked ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))" : "var(--bg-panel)",
                            color: "var(--text)",
                            cursor: "pointer",
                            fontSize: 13,
                          }}
                        >
                          <input
                            type={question.multi ? "checkbox" : "radio"}
                            name={`ask-${request.id}-${index}`}
                            checked={checked}
                            onChange={() => setAskDrafts((drafts) => drafts.map((current, i) => i !== index ? current : question.multi
                              ? { ...current, selected: current.selected.includes(option.label) ? current.selected.filter((label) => label !== option.label) : [...current.selected, option.label] }
                              : { selected: [option.label], other: "" }))}
                            style={{ margin: "2px 0 0", accentColor: "var(--accent-strong)" }}
                          />
                          <span style={{ minWidth: 0 }}>
                            {option.label}
                            {optionIndex === question.recommended && (
                              <span style={{ marginLeft: 6, color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>{t("chatWindow.askRecommended")}</span>
                            )}
                            {option.description && (
                              <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{option.description}</span>
                            )}
                            {option.preview && (
                              <span style={{ display: "block", marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--tool-bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre", overflowX: "auto" }}>{option.preview}</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    <textarea
                      aria-label={t("chatWindow.askOther")}
                      placeholder={t("chatWindow.askOther")}
                      value={draft.other}
                      rows={2}
                      onChange={(e) => {
                        const other = e.target.value;
                        setAskDrafts((drafts) => drafts.map((current, i) => i === index ? { selected: question.multi ? current.selected : [], other } : current));
                      }}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
                      }}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        borderRadius: 7,
                        border: "1px solid var(--border)",
                        background: "var(--bg-panel)",
                        color: "var(--text)",
                        outline: "none",
                        resize: "vertical",
                        fontSize: "var(--chat-font-size)",
                        lineHeight: 1.55,
                        fontFamily: "inherit",
                      }}
                    />
                  </fieldset>
                );
              })}
            </div>
          )}
        </div>
        </div>

        <div style={{ display: "flex", flexShrink: 0, justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
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
          ) : (request.method === "select" && attached) || request.method === "ask" ? (
            <button
              onClick={submitValue}
              disabled={!canSubmit}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent-strong)",
                background: canSubmit ? "var(--accent-strong)" : "var(--bg-subtle)",
                color: canSubmit ? "var(--on-accent)" : "var(--text-dim)",
                cursor: canSubmit ? "pointer" : "not-allowed",
                opacity: canSubmit ? 1 : 0.65,
              }}
            >
              {request.method === "ask" ? t("chatWindow.submit") : t("chatWindow.next")}
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
