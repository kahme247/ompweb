"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Monitor, Moon, Sparkles, Sun } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  DARK_THEMES,
  LIGHT_THEMES,
  type ThemePreference,
  useTheme,
} from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";

type ThemeOption = {
  value: ThemePreference;
  name: string;
  bg: string;
  accent: string;
  category: "light" | "dark" | "system";
};

const ALL_OPTIONS: ReadonlyArray<ThemeOption> = [
  ...LIGHT_THEMES.map((t) => ({ value: t.id, name: t.name, bg: t.bg, accent: t.accent, category: "light" as const })),
  ...DARK_THEMES.map((t) => ({ value: t.id, name: t.name, bg: t.bg, accent: t.accent, category: "dark" as const })),
  { value: "system", name: "System", bg: "transparent", accent: "var(--accent)", category: "system" as const },
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

  const index = Math.max(0, ALL_OPTIONS.findIndex((o) => o.value === preference));
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
      setActiveIndex(e.key === "ArrowUp" ? ALL_OPTIONS.length - 1 : index);
    }
  };

  const onItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i + 1) % ALL_OPTIONS.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i - 1 + ALL_OPTIONS.length) % ALL_OPTIONS.length);
        break;
      case "ArrowRight":
        e.preventDefault();
        // If in light column (0..3), jump to dark column
        if (i < LIGHT_THEMES.length) {
          setActiveIndex(Math.min(ALL_OPTIONS.length - 2, i + LIGHT_THEMES.length));
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        // If in dark column (4..13), jump to light column
        if (i >= LIGHT_THEMES.length && i < ALL_OPTIONS.length - 1) {
          setActiveIndex(Math.min(LIGHT_THEMES.length - 1, i - LIGHT_THEMES.length));
        }
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(ALL_OPTIONS.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(ALL_OPTIONS[i].value);
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
        {preference === "system" ? (
          <Monitor size={16} strokeWidth={1.8} aria-hidden="true" />
        ) : preference === "omp" ? (
          <Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />
        ) : isDark ? (
          <Moon size={16} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <Sun size={16} strokeWidth={1.8} aria-hidden="true" />
        )}
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
        <div
          id={menuId}
          role="menu"
          className="dropdown-surface animate-slide-down"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            minWidth: isMobile ? 220 : 350,
            maxWidth: "92vw",
            margin: 0,
            padding: 6,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            boxShadow: "var(--shadow-pop)",
          }}
        >
          <div
            style={{
              display: isMobile ? "flex" : "grid",
              flexDirection: isMobile ? "column" : undefined,
              gridTemplateColumns: isMobile ? undefined : "1fr 1fr",
              gap: isMobile ? 4 : 8,
              maxHeight: isMobile ? 380 : undefined,
              overflowY: isMobile ? "auto" : undefined,
            }}
          >
            {/* Light column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <div
                style={{
                  padding: "4px 8px 2px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-dim)",
                }}
              >
                {t("appShell.lightThemes") || "Light"}
              </div>
              {LIGHT_THEMES.map((theme, localIdx) => {
                const globalIdx = localIdx;
                const selected = theme.id === preference;
                return (
                  <button
                    key={theme.id}
                    className="dropdown-item"
                    ref={(el) => { itemRefs.current[globalIdx] = el; }}
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={selected}
                    onClick={() => choose(theme.id)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "var(--bg-selected)" : "transparent"; }}
                    onKeyDown={(e) => onItemKeyDown(e, globalIdx)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
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
                    <span
                      style={{
                        width: 13,
                        height: 13,
                        borderRadius: "50%",
                        backgroundColor: theme.bg,
                        border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: theme.accent }} />
                    </span>
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{theme.name}</span>
                    {selected && <Check size={12} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />}
                  </button>
                );
              })}

              <div style={{ borderTop: "1px solid var(--border)", margin: "6px 4px 4px" }} />

              <div
                style={{
                  padding: "4px 8px 2px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-dim)",
                }}
              >
                {t("appShell.system") || "System"}
              </div>
              {(() => {
                const systemIdx = ALL_OPTIONS.length - 1;
                const selected = preference === "system";
                return (
                  <button
                    key="system"
                    className="dropdown-item"
                    ref={(el) => { itemRefs.current[systemIdx] = el; }}
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={selected}
                    onClick={() => choose("system")}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "var(--bg-selected)" : "transparent"; }}
                    onKeyDown={(e) => onItemKeyDown(e, systemIdx)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
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
                    <Monitor size={13} strokeWidth={1.8} aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-muted)" }} />
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t("appShell.themeSystem") || "System"}
                    </span>
                    {selected && <Check size={12} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />}
                  </button>
                );
              })()}
            </div>

            {/* Dark column */}
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <div
                style={{
                  padding: "4px 8px 2px",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "var(--text-dim)",
                }}
              >
                {t("appShell.darkThemes") || "Dark"}
              </div>
              {DARK_THEMES.map((theme, localIdx) => {
                const globalIdx = LIGHT_THEMES.length + localIdx;
                const selected = theme.id === preference;
                return (
                  <button
                    key={theme.id}
                    className="dropdown-item"
                    ref={(el) => { itemRefs.current[globalIdx] = el; }}
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={selected}
                    onClick={() => choose(theme.id)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = selected ? "var(--bg-selected)" : "transparent"; }}
                    onKeyDown={(e) => onItemKeyDown(e, globalIdx)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 8px",
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
                    <span
                      style={{
                        width: 13,
                        height: 13,
                        backgroundColor: theme.bg,
                        border: theme.id === "omp" ? "1.5px solid #7DD7E8" : "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: theme.accent }} />
                    </span>
                    <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "inline-flex", alignItems: "center", gap: 5 }}>
                      {theme.name}
                      {theme.id === "omp" && <Sparkles size={11} strokeWidth={2} style={{ color: "var(--accent)", flexShrink: 0 }} aria-hidden="true" />}
                    </span>
                    {selected && <Check size={12} strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0, color: "var(--accent)" }} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
