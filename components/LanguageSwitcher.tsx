"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { LOCALES, useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";

/** Language toggle for the top bar. Renders the current language and opens a
 * small menu to pick any locale directly, with full keyboard support:
 *   - Enter / Space / ↓ : open
 *   - Arrow Up / Down    : move selection
 *   - Home / End         : first / last item
 *   - Enter              : choose focused item
 *   - Escape             : close, return focus to trigger
 * Styled to match the adjacent theme toggle button. */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const index = Math.max(0, LOCALES.findIndex((l) => l.value === locale));
  const current = LOCALES[index];

  // Keep the highlighted item in sync with the chosen locale when closed.
  useEffect(() => {
    if (!open) setActiveIndex(index);
  }, [index, open]);

  // Focus the active item whenever the menu opens or the highlight moves.
  useEffect(() => {
    if (open) itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  // Close on outside click / Escape is handled in onKeyDown below; also close
  // when the trigger loses focus to something outside the component.
  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  const choose = (value: typeof locale) => {
    setLocale(value);
    close(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(e.key === "ArrowUp" ? LOCALES.length - 1 : index);
    }
  };

  const onItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i + 1) % LOCALES.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i - 1 + LOCALES.length) % LOCALES.length);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(LOCALES.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(LOCALES[i].value);
        break;
      case "Escape":
        e.preventDefault();
        // Stop the window-level Esc listener (abort agent) from firing while
        // the language menu is open.
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  return (
    <div
      style={{ position: "relative", flexShrink: 0 }}
      onBlur={(e) => {
        // Close when focus leaves the whole switcher.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        title={t("languageSwitcher.switchTo", { language: current.label })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className="shell-toolbar-btn ui-focus-ring"
        style={{
          width: "auto",
          minWidth: isMobile ? 44 : 36,
          padding: "0 8px",
          gap: 4,
          background: open ? "var(--bg-selected)" : undefined,
          color: open ? "var(--text)" : undefined,
          fontSize: 11,
          whiteSpace: "nowrap",
        }}
      >
        {current.label}
        <ChevronDown
          size={10}
          strokeWidth={2}
          aria-hidden="true"
          style={{
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--dur-fast) var(--ease-out-warm)",
          }}
        />
      </button>

      {open && (
        <ul
          id={listboxId}
          role="menu"
          className="dropdown-surface animate-slide-down"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            minWidth: 120,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            boxShadow: "var(--shadow-pop)",
          }}
        >
          {LOCALES.map((l, i) => {
            const selected = l.value === locale;
            return (
              <li key={l.value} role="none">
                <button className="dropdown-item"
                  ref={(el) => { itemRefs.current[i] = el; }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  aria-current={selected || undefined}
                  onClick={() => choose(l.value)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "var(--bg-selected)" : "transparent"; }}
                  onKeyDown={(e) => onItemKeyDown(e, i)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "7px 10px",
                    border: 0,
                    borderRadius: 5,
                    background: selected ? "var(--bg-selected)" : "transparent",
                    color: selected ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 12,
                    textAlign: "left",
                    transition: "background-color var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm)",
                  }}
                >
                  <span>{l.label}</span>
                  {selected && (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m3 8 3.5 3.5L13 5" />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
