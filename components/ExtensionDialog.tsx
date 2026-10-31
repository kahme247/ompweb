"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { ExtensionUiRequest } from "@/lib/types";
import type { RpcAskDialogAnswer } from "@/lib/pi-types";
import { useI18n } from "@/lib/i18n";
import { useModalDialog } from "@/hooks/useModalDialog";
import { useTouchTargets } from "@/hooks/useTouchTargets";
import { matchMobileViewport } from "@/hooks/useIsMobile";

export type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" }
>;

export type ExtensionDialogResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | { answers: RpcAskDialogAnswer[] };

// The Other text lives as long as the question: choosing a regular option only
// unchooses it, so the text is still in its row when Other is chosen again.
type AskDraft = { selected: string[]; other: string; otherChosen: boolean };
const EMPTY_ASK_DRAFT: AskDraft = { selected: [], other: "", otherChosen: false };
// Fields that raise the on-screen keyboard: every input but a radio/checkbox.
const TEXT_ENTRY = "input:not([type=radio]):not([type=checkbox]), textarea";

// Keyboard-aware panel height. The on-screen keyboard shrinks the visible
// area, so a panel sized against the layout viewport alone keeps its footer
// (Cancel / Submit) below the keyboard. `dvh` follows the layout viewport —
// the placeholder cap — which older mobile browsers shrink for the keyboard
// too, so this is a backstop rather than a duplicate.
const DEFAULT_PANEL_MAX_HEIGHT = "min(420px, 60dvh)";
// Room the browser chrome and the keyboard accessory bar need above the panel.
const VIEWPORT_BLEED = 12;
// How much shorter the visual viewport must be before we call it a keyboard.
const KEYBOARD_INSET = 120;
// Some mobile browsers open the keyboard without resizing anything we can
// observe; a slow re-check costs nothing while a question is on screen.
const KEYBOARD_POLL_MS = 400;

function readPanelMaxHeight(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const visual = window.visualViewport?.height;
  const height = typeof visual === "number" && visual > 0
    ? Math.min(visual, window.innerHeight)
    : window.innerHeight;
  return height > 0 ? Math.max(180, Math.round(height - VIEWPORT_BLEED)) : undefined;
}

function subscribeViewport(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const viewport = window.visualViewport;
  // Feature-detect the methods too: Safari 13 shipped a bare `visualViewport`.
  if (typeof viewport?.addEventListener !== "function") return () => {};
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/**
 * CSS length px cap for a panel in the composer: the height of the visible
 * area, so the footer stays on screen while the soft keyboard is up. Reads
 * `undefined` when there is no window (SSR, tests) — the CSS default then
 * applies unchanged.
 */
function useViewportMaxHeight(): number | undefined {
  return useSyncExternalStore(subscribeViewport, readPanelMaxHeight, () => undefined);
}

/** Height of the visible area, falling back to the layout viewport. */
function visibleHeight(): number {
  const visual = window.visualViewport?.height;
  return typeof visual === "number" && visual > 0 ? visual : window.innerHeight;
}

/**
 * Per-panel soft-keyboard tracking for a composer-attached request, active
 * only while a text field inside the panel has focus. A panel in the composer
 * is not a modal, so the browser is free to scroll the page when the keyboard
 * opens; this is what keeps the footer (Cancel / Submit) inside the visible
 * area (#236). A focused option or button raises no keyboard, so it must not
 * resize the panel either: that resize made the tap that focused it miss.
 *
 * Two signals, because neither alone is enough: `visualViewport` shrinking is
 * the real keyboard (fingerprint-free), and a coarse pointer means the tap
 * that focused a field will raise one even before the browser has repainted.
 * A slow re-check covers mobile browsers that resize nothing on focus.
 */
function useMobileInputOpen(panelRef: RefObject<HTMLDivElement | null>, attached: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!attached) {
      setOpen(false);
      return;
    }
    let focused = false;
    // Browsers cannot report the keyboard itself. It opens when the visible
    // area drops well below the tallest seen at this width, and closes when
    // the area grows well above its lowest since then. Comparing to
    // `innerHeight` cannot work: with `interactive-widget: resizes-content`
    // (app/layout.tsx) the keyboard shrinks the layout viewport too.
    let width = window.innerWidth;
    let fullHeight = Math.max(visibleHeight(), window.innerHeight);
    // Lowest visible height while the keyboard is up; null while it is down.
    let keyboardLow: number | null = null;
    // `pointerType` of the latest press anywhere: a hybrid laptop's primary
    // pointer is fine, yet a touch tap there still raises a soft keyboard.
    let lastPointer: string | null = null;
    const onPointerDown = (event: PointerEvent) => { lastPointer = event.pointerType; };
    const update = () => {
      const height = visibleHeight();
      const touch = lastPointer ? lastPointer !== "mouse" : touchPointer();
      if (window.innerWidth !== width) {
        // Rotation or a resized window: the old heights mean nothing at the
        // new size. An open keyboard stays open; its collapse is still a rise.
        width = window.innerWidth;
        fullHeight = height;
        if (keyboardLow !== null) keyboardLow = height;
      }
      fullHeight = Math.max(fullHeight, height);
      if (!touch) {
        // No soft keyboard: a window or docked dev tools resizing is not one.
        keyboardLow = null;
      } else if (keyboardLow === null) {
        if (height < fullHeight - KEYBOARD_INSET) keyboardLow = height;
      } else if (height > keyboardLow + KEYBOARD_INSET) {
        keyboardLow = null;
        // Collapsing the keyboard (back button, swipe) keeps the text field
        // focused, and the next tap anywhere would raise it again for a
        // moment. A closed keyboard means the user is done typing.
        if (focused && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      } else {
        keyboardLow = Math.min(keyboardLow, height);
      }
      // A keyboard over the page (no layout resize) shows on any device.
      const overlaid = height < window.innerHeight - KEYBOARD_INSET;
      const isOpen = focused && (touch || overlaid);
      setOpen((current) => (current === isOpen ? current : isOpen));
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      focused = target instanceof Element && target.matches(TEXT_ENTRY) && Boolean(panelRef.current?.contains(target));
      update();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      focused = next instanceof Element && next.matches(TEXT_ENTRY) && Boolean(panelRef.current?.contains(next));
      update();
    };
    update();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    const poll = setInterval(update, KEYBOARD_POLL_MS);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      clearInterval(poll);
    };
  }, [attached, panelRef]);
  return open;
}

/**
 * Whether a composer-attached request should leave focus alone. Touch input
 * means the browser would raise the on-screen keyboard and yank the panel the
 * user has not read yet into view, so the request waits for a tap. The mobile
 * breakpoint covers where pointer media queries do not answer (older mobile
 * browsers, jsdom, a desktop browser's touch emulation); a narrow *desktop*
 * window is deferred too, which is the deliberate trade for never raising a
 * phone keyboard. Exported for the regression tests (#235).
 */
export function shouldDeferAttachedFocus(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return touchPointer() || matchMobileViewport();
}

/** The primary pointer is a finger: `(pointer: fine)` is the repo's test for a
 * mouse/trackpad, the same one `lib/composer-prefs.ts` uses for word
 * completion, so an unanswerable media query never counts as touch. */
function touchPointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia("(pointer: fine)").matches;
}

const SENSITIVE_PATTERN = /\b(passwords?|passphrases?|secrets?|tokens?|api[_\s-]?keys?|access[_\s-]?tokens?|private[_\s-]?keys?|auth[_\s-]?tokens?|credentials?)\b/i;
const NON_SECRET_METADATA_PATTERN = /\b(token\s+(?:name|count|limit|budget|usage)|max\s+tokens)\b/i;

export function isSensitivePrompt(title?: string, placeholder?: string): boolean {
  const titleText = (title ?? "").trim();
  const placeholderText = (placeholder ?? "").trim();
  const fullText = `${titleText} ${placeholderText}`.trim();
  if (!fullText) return false;
  const strippedTitle = titleText.replace(NON_SECRET_METADATA_PATTERN, "");
  if (SENSITIVE_PATTERN.test(strippedTitle)) return true;
  const strippedFull = fullText.replace(NON_SECRET_METADATA_PATTERN, "");
  return SENSITIVE_PATTERN.test(strippedFull);
}

/** Single-select questions start on their recommended option. */
function initialAskDrafts(request: ExtensionDialogRequest): AskDraft[] {
  if (request.method !== "ask") return [];
  return request.questions.map((question) => {
    const recommended = question.multi || question.recommended === undefined ? undefined : question.options[question.recommended];
    return { selected: recommended ? [recommended.label] : [], other: "", otherChosen: false };
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
  const [showPassword, setShowPassword] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const requestIdRef = useRef(request.id);
  // `pointerType` of the latest press: the pointer media query only describes
  // the primary pointer, not the one pressing now.
  const pressPointerRef = useRef<string | null>(null);
  const [askDrafts, setAskDrafts] = useState(() => initialAskDrafts(request));
  const viewportMaxHeight = useViewportMaxHeight();
  const { touchTargets } = useTouchTargets();

  useEffect(() => {
    // SSE reconnects replay the same request as a fresh object, not a new question.
    if (requestIdRef.current === request.id) return;
    requestIdRef.current = request.id;
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setShowPassword(false);
    setSelectedOption(null);
    setAskDrafts(initialAskDrafts(request));
  }, [request]);

  const askDraftAt = (index: number) => askDrafts[index] ?? EMPTY_ASK_DRAFT;
  const updateAskDraft = (index: number, update: (draft: AskDraft) => AskDraft) =>
    setAskDrafts((drafts) => drafts.map((draft, i) => i === index ? update(draft) : draft));
  // A chosen Other counts only with text. Multi-select may stay empty;
  // single-select needs a choice or an answer.
  const canSubmit = request.method === "ask"
    ? request.questions.every((question, index) => {
      const { selected, other, otherChosen } = askDraftAt(index);
      return question.multi || selected.length > 0 || (otherChosen && other.trim() !== "");
    })
    : request.method !== "select" || selectedOption !== null;
  const title = request.method === "ask" ? t("chatWindow.askTitle") : request.title;

  // Answering removes the panel. Release its text field first, in the same
  // task, so the phone keyboard closes once instead of flashing as the
  // focused field disappears from under it.
  const respond = (response: ExtensionDialogResponse) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && panelRef.current?.contains(active)) active.blur();
    onRespond(request, response);
  };
  const cancel = () => respond({ cancelled: true });

  // useModalDialog gives us: focus-in on open, focus-restore on close,
  // document-level Escape (top-of-stack), and Tab wrapping inside the panel.
  const panelRef = useModalDialog<HTMLDivElement>({
    onClose: cancel,
    // A composer-attached request is a regular in-flow panel, not a modal.
    active: !attached,
  });
  const keyboardOpen = useMobileInputOpen(panelRef, attached);
  // While the keyboard is up the panel fills the visible area instead of the
  // taller layout-viewport cap, so the footer with Cancel / Submit stays in
  // reach (#236).
  const attachedMaxHeight = keyboardOpen && viewportMaxHeight !== undefined
    ? `${viewportMaxHeight}px`
    : DEFAULT_PANEL_MAX_HEIGHT;

  useEffect(() => {
    if (!attached) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      // A tap on the composer, not a programmatic focus, opens the keyboard:
      // the request waits to be read on touch devices (#235).
      if (shouldDeferAttachedFocus()) return;
      // The frame runs after paint, by which time the user may already have
      // focused something inside the panel. Never yank focus back.
      if (panel.contains(document.activeElement)) return;
      // Never land on a radio or checkbox: a stray Space on a focused radio
      // selects that option, which silently overwrites what the user typed in
      // "Other". Prefer the first text entry, then any button.
      const target = panel.querySelector<HTMLElement>(
        `${TEXT_ENTRY}, button:not([disabled])`,
      );
      (target ?? panel).focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [attached, panelRef, request.id]);

  const submitValue = () => {
    if (request.method === "confirm") {
      respond({ confirmed: true });
    } else if (request.method === "select") {
      if (selectedOption) respond({ value: selectedOption });
    } else if (request.method === "ask") {
      if (!canSubmit) return;
      respond({
        answers: request.questions.map((question, index) => {
          const draft = askDraftAt(index);
          const customInput = draft.otherChosen ? draft.other.trim() : "";
          return {
            id: question.id,
            selectedOptions: question.options.map((option) => option.label).filter((label) => draft.selected.includes(label)),
            ...(customInput ? { customInput } : {}),
          };
        }),
      });
    } else {
      respond({ value });
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
        // While a text box in the panel has focus, a tap elsewhere in it (an
        // option, Cancel, Submit) must not move focus on press: the phone
        // keyboard would close and the panel resize before the click, so the
        // tap misses its target. A tapped option label still focuses its radio
        // once the click lands, so the keyboard closes after the choice.
        // Touch and pen only, judged per press (a hybrid laptop has both): a
        // mouse keeps text selection and radio arrow keys.
        onPointerDown={(event) => { pressPointerRef.current = event.pointerType; }}
        onMouseDown={(event) => {
          const target = event.target as Element;
          const pointer = pressPointerRef.current;
          if (pointer && pointer !== "mouse" && document.activeElement?.matches(TEXT_ENTRY) && event.currentTarget.contains(document.activeElement) && !target.closest(TEXT_ENTRY)) {
            event.preventDefault();
          }
        }}
        className={attached ? undefined : "animate-scale-in"}
        style={{
          width: attached ? "100%" : "min(560px, 100%)",
          boxSizing: "border-box",
          // Grid/flex children below must be able to shrink: a min-content
          // question or option is wider than a phone, and without this the
          // panel grows past its composer column and gets clipped (#234).
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: attached ? "var(--radius-card)" : "var(--radius-modal)",
          background: "var(--bg)",
          boxShadow: attached ? "var(--shadow-card)" : "var(--shadow-modal)",
          overflow: "hidden",
          outline: "none",
          maxHeight: attached ? attachedMaxHeight : "100%",
        }}
      >
        <div className="extension-dialog-content" style={{ minWidth: 0, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowWrap: "anywhere" }}>
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
                    onClick={() => attached ? setSelectedOption(option) : respond({ value: option })}
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
          {request.method === "input" && (() => {
            const isSensitive = Boolean(request.secret || request.password) ||
              (request.secret !== false && request.password !== false && isSensitivePrompt(request.title, request.placeholder));
            return (
              <div style={{ position: "relative", width: "100%" }}>
                <input
                  autoFocus
                  type={isSensitive && !showPassword ? "password" : "text"}
                  autoComplete={isSensitive ? "off" : undefined}
                  autoCorrect={isSensitive ? "off" : undefined}
                  autoCapitalize={isSensitive ? "off" : undefined}
                  spellCheck={isSensitive ? false : undefined}
                  data-1p-ignore={isSensitive ? "true" : undefined}
                  aria-label={request.title || request.placeholder || "Input value"}
                  value={value}
                  placeholder={request.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitValue();
                  }}
                  style={{
                    width: "100%",
                    padding: isSensitive ? "7px 34px 7px 10px" : "7px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    outline: "none",
                    fontSize: 12,
                    fontFamily: "inherit",
                  }}
                />
                {isSensitive && (
                  <button
                    type="button"
                    aria-label={showPassword ? t("chatWindow.hidePassword") : t("chatWindow.showPassword")}
                    title={showPassword ? t("chatWindow.hidePassword") : t("chatWindow.showPassword")}
                    onClick={() => setShowPassword((prev) => !prev)}
                    style={{
                      position: "absolute",
                      right: 6,
                      top: "50%",
                      transform: "translateY(-50%)",
                      width: 24,
                      height: 24,
                      padding: 0,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: 4,
                    }}
                  >
                    {showPassword ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  </button>
                )}
              </div>
            );
          })()}
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
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16 }}>
              {request.questions.map((question, index) => {
                const draft = askDraftAt(index);
                const chooseKeptOther = () => {
                  if (draft.otherChosen || !draft.other.trim()) return;
                  updateAskDraft(index, (current) => ({ ...current, selected: question.multi ? current.selected : [], otherChosen: true }));
                };
                return (
                  <fieldset key={question.id} style={{ margin: 0, padding: 0, border: "none", minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
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
                            minWidth: 0,
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
                            onChange={(event) => {
                              // A tap on the radio itself, unlike one on its label, does
                              // not focus it once the press keeps focus in Other. Focus it
                              // so the keyboard closes and further typing cannot pick Other.
                              event.currentTarget.focus();
                              updateAskDraft(index, (current) => question.multi
                                ? { ...current, selected: current.selected.includes(option.label) ? current.selected.filter((label) => label !== option.label) : [...current.selected, option.label] }
                                : { ...current, selected: [option.label], otherChosen: false });
                            }}
                            style={{ margin: "2px 0 0", accentColor: "var(--accent-strong)" }}
                          />
                          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                            {option.label}
                            {optionIndex === question.recommended && (
                              <span style={{ marginLeft: 6, color: "var(--accent)", fontSize: 11, fontWeight: 600 }}>{t("chatWindow.askRecommended")}</span>
                            )}
                            {option.description && (
                              <span style={{ display: "block", marginTop: 2, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{option.description}</span>
                            )}
                            {option.preview && (
                              <span style={{ display: "block", marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--tool-bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{option.preview}</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    {/* The Other option: its text box is the option, so what was
                        typed stays in place while another option is chosen. */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        minWidth: 0,
                        padding: "8px 10px",
                        borderRadius: 7,
                        border: `1px solid ${draft.otherChosen ? "var(--accent)" : "var(--border)"}`,
                        background: draft.otherChosen ? "color-mix(in srgb, var(--accent) 10%, var(--bg-panel))" : "var(--bg-panel)",
                      }}
                    >
                      <input
                        type={question.multi ? "checkbox" : "radio"}
                        name={`ask-${request.id}-${index}`}
                        aria-label={t("chatWindow.askOther")}
                        checked={draft.otherChosen}
                        onChange={(e) => {
                          const chosen = e.target.checked;
                          updateAskDraft(index, (current) => ({ ...current, selected: chosen && !question.multi ? [] : current.selected, otherChosen: chosen }));
                          if (chosen) document.getElementById(`ask-${request.id}-${index}-other`)?.focus();
                        }}
                        style={{ margin: "4px 0 0", accentColor: "var(--accent-strong)", cursor: "pointer" }}
                      />
                      <textarea
                        id={`ask-${request.id}-${index}-other`}
                        aria-label={t("chatWindow.askOther")}
                        placeholder={t("chatWindow.askOther")}
                        value={draft.other}
                        // Going back into kept text means answering with it again.
                        // A tap counts too: unticking Other by touch keeps focus in
                        // this box, so tapping back into it fires no focus event.
                        onFocus={chooseKeptOther}
                        onClick={chooseKeptOther}
                        rows={1}
                        onChange={(e) => {
                          const other = e.target.value;
                          // Typing chooses Other (replacing a single-select choice);
                          // clearing it unchooses, so a blank answer never blocks Submit.
                          updateAskDraft(index, (current) => other.trim()
                            ? { selected: question.multi ? current.selected : [], other, otherChosen: true }
                            : { ...current, other, otherChosen: false });
                        }}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: 0,
                          border: "none",
                          background: "none",
                          color: draft.otherChosen ? "var(--text)" : "var(--text-muted)",
                          outline: "none",
                          resize: "none",
                          fontSize: "var(--chat-font-size)",
                          lineHeight: 1.55,
                          fontFamily: "inherit",
                          fieldSizing: "content",
                          minHeight: "1.55em",
                          maxHeight: 200,
                        }}
                      />
                    </div>
                  </fieldset>
                );
              })}
            </div>
          )}
        </div>
        </div>

        <div className="extension-dialog-footer" style={{ display: "flex", flexShrink: 0, justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            onClick={cancel}
            style={{
              padding: "6px 10px",
              minHeight: touchTargets === "accessible" ? 44 : undefined,
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
                minHeight: touchTargets === "accessible" ? 44 : undefined,
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
                minHeight: touchTargets === "accessible" ? 44 : undefined,
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
                minHeight: touchTargets === "accessible" ? 44 : undefined,
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
