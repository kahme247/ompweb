"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Monitor, Moon, Sparkles, Sun } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme, type ThemePreference } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";

const OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  labelKey: string;
  Icon: typeof Sun;
}> = [
  { value: "light", labelKey: "appShell.switchToLightMode", Icon: Sun },
  { value: "dark", labelKey: "appShell.switchToDarkMode", Icon: Moon },
  { value: "omp", labelKey: "appShell.switchToOmpTheme", Icon: Sparkles },
  { value: "system", labelKey: "appShell.switchToSystemTheme", Icon: Monitor },
];

/** Theme picker for the top bar. Shows the current mode icon and opens a
 * small menu to pick light / dark / omp midnight / system directly, with
 * full keyboard support:
 *   - Enter / Space / ↓ : open
 *   - Arrow Up / Down    : move selection
 *   - Home / End         : first / last item
 *   - Enter              : choose focused item
 *   - Escape             : close, return focus to trigger
 * Styled to match the adjacent language switcher. */
export function ThemeSwitcher() {
  const { isDark, preference, setTheme } = useTheme();
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();
  const menuId = `${baseId}-menu`;

  const index = Math.max(0, OPTIONS.findIndex((o) => o.value === preference));

  // Keep the highlighted item in sync with the chosen theme when closed.
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

  const choose = (value: ThemePreference) => {
    // Origin at the trigger center drives the circular theme wipe.
    const rect = triggerRef.current?.getBoundingClientRect();
    const origin = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined;
    setTheme(value, origin);
    close(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex(e.key === "ArrowUp" ? OPTIONS.length - 1 : index);
    }
  };

  const onItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i + 1) % OPTIONS.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i - 1 + OPTIONS.length) % OPTIONS.length);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(OPTIONS.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(OPTIONS[i].value);
        break;
      case "Escape":
        e.preventDefault();
        // Stop the window-level Esc listener (abort agent) from firing while
        // the theme menu is open.
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
        title={t("commandPalette.toggleTheme")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="shell-toolbar-btn ui-focus-ring"
        style={{
          background: open ? "var(--bg-selected)" : undefined,
          color: open ? "var(--text)" : undefined,
        }}
      >
        {isDark ? <Sun size={16} strokeWidth={1.8} aria-hidden="true" /> : <Moon size={16} strokeWidth={1.8} aria-hidden="true" />}
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
          id={menuId}
          role="menu"
          className="dropdown-surface animate-slide-down"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: isMobile ? undefined : 0,
            right: isMobile ? 0 : undefined,
            zIndex: 50,
            minWidth: 190,
            margin: 0,
            padding: 4,
            listStyle: "none",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            boxShadow: "var(--shadow-pop)",
          }}
        >
          {OPTIONS.map((o, i) => {
            const selected = o.value === preference;
            const OptionIcon = o.Icon;
            return (
              <li key={o.value} role="none">
                <button className="dropdown-item"
                  ref={(el) => { itemRefs.current[i] = el; }}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={selected}
                  onClick={() => choose(o.value)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "var(--bg-selected)" : "transparent"; }}
                  onKeyDown={(e) => onItemKeyDown(e, i)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
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
                  <OptionIcon size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{t(o.labelKey)}</span>
                  {selected && <Check size={12} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
