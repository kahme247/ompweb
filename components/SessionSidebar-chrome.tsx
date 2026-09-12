"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import OmpWebLogo from "./OmpWebLogo";
/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}
const SIDEBAR_BUTTON_TRANSITION = "background var(--dur-fast) var(--ease-out-warm), color var(--dur-fast) var(--ease-out-warm), border-color var(--dur-fast) var(--ease-out-warm)";

/** Quiet square icon button used across the sidebar chrome (header, section
 *  headers, footer). Stays visually subdued; the accent appears on hover and
 *  when active (e.g. an applied filter). */
function SidebarIconButton({
  label,
  title,
  onClick,
  active = false,
  disabled = false,
  children,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, flexShrink: 0, lineHeight: 0,
        background: active || hovered ? "var(--bg-hover)" : "none",
        border: "none",
        borderRadius: "var(--radius-control)",
        color: active ? "var(--accent)" : hovered ? "var(--accent)" : "var(--text-dim)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: SIDEBAR_BUTTON_TRANSITION,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  );
}
const MENU_MARGIN = 5;
const MENU_VIEWPORT_PAD = 8;

/**
 * Overflow menu rendered through a portal to document.body so it always
 * floats above every sidebar row: it is never clipped by the workspace list's
 * overflow and never covered by sibling stacking contexts (each workspace
 * section isolates its own context). Positioned from the anchor button's
 * viewport rect, flips to the other side of the anchor when there is no room,
 * follows the anchor while the sidebar scrolls, and closes on outside press
 * or Escape.
 */
function SidebarPortalMenu({
  anchor,
  open,
  onClose,
  placement = "below",
  align = "end",
  minWidth = 136,
  style,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: "below" | "above";
  /** "end" right-aligns to the anchor, "start" left-aligns to it. */
  align?: "start" | "end";
  minWidth?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Refs are passed as arguments so the callback stays dependency-clean
  // (no ref.current access inside) for the React Compiler.
  const computePos = useCallback((el: HTMLElement | null, menu: HTMLDivElement | null) => {
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    // --ui-scale / zoom makes getBoundingClientRect() scaled while offsetWidth is unscaled.
    // Convert the anchor rect to unscaled CSS pixels so the fixed menu (also zoomed) lands correctly.
    let scale = 1;
    if (typeof document !== "undefined") {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--ui-scale");
      const v = parseFloat(raw);
      if (Number.isFinite(v) && v > 0) scale = v;
    }
    const ru = scale !== 1 ? { top: r.top / scale, right: r.right / scale, bottom: r.bottom / scale, left: r.left / scale } : r;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top: number;
    if (placement === "above") {
      top = ru.top - height - MENU_MARGIN;
      if (top < MENU_VIEWPORT_PAD) {
        top = Math.min(ru.bottom + MENU_MARGIN, vh - height - MENU_VIEWPORT_PAD);
      }
    } else {
      top = ru.bottom + MENU_MARGIN;
      if (top + height > vh - MENU_VIEWPORT_PAD) {
        top = ru.top - height - MENU_MARGIN;
      }
    }
    if (top < MENU_VIEWPORT_PAD) top = MENU_VIEWPORT_PAD;
    const left = align === "start"
      ? Math.max(MENU_VIEWPORT_PAD, Math.min(ru.left, vw - width - MENU_VIEWPORT_PAD))
      : Math.max(MENU_VIEWPORT_PAD, Math.min(ru.right - width, vw - width - MENU_VIEWPORT_PAD));
    setPos({ top, left });
  }, [placement, align]);

  // Measure on open: the portal is mounted during commit, so the menu's own
  // size is available synchronously in the layout effect.
  useLayoutEffect(() => {
    if (!open) return;
    computePos(anchor.current, menuRef.current);
  }, [open, computePos, anchor]);

  // Reposition while open — the sidebar is resizable and the list scrolls.
  useEffect(() => {
    if (!open) return;
    const update = () => computePos(anchor.current, menuRef.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, computePos, anchor]);

  // Close on outside press / Escape and handle keyboard arrow navigation.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      const firstBtn = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
      firstBtn?.focus();
    }, 0);
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (anchor.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        anchor.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
        if (buttons.length === 0) return;
        const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const nextIndex = e.key === "ArrowDown"
          ? (currentIndex + 1) % buttons.length
          : (currentIndex - 1 + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, anchor]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        position: "fixed",
        top: pos ? pos.top : -9999,
        left: pos ? pos.left : -9999,
        visibility: pos ? "visible" : "hidden",
        zIndex: 1000,
        minWidth,
        padding: 4,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: "var(--bg-panel)",
        boxShadow: "var(--shadow-pop)",
        ...style,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean, reducedMotion: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running || reducedMotion) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running, reducedMotion]);

  return display;
}
function OmpWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrambleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const target = showVersion ? `v${process.env.NEXT_PUBLIC_OMP_WEB_VERSION ?? "0.0.0"}` : "omp web";
  const display = useScramble(target, scrambling, reducedMotion);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
    if (reducedMotion) return;
    setScrambling(true);
    scrambleTimerRef.current = setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, [reducedMotion]);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    if (scrambleTimerRef.current) clearTimeout(scrambleTimerRef.current);
  }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "pointer",
        fontWeight: 700, fontSize: 14, letterSpacing: "-0.01em",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
      }}
      title={showVersion ? "Show ompweb name" : "Show ompweb version"}
    >
      <OmpWebLogo size={20} />
      {!scrambling && !showVersion ? (
        <span>
          <span style={{ color: "var(--accent)" }}>omp</span>
          <span style={{ color: "var(--text)" }}>web</span>
        </span>
      ) : (
        <span style={{ color: showVersion ? "var(--accent)" : "var(--text)" }}>{display}</span>
      )}
    </button>
  );
}
function RunningSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <span
      title={t("sessionSidebar.agentRunning")}
      aria-label={t("sessionSidebar.agentRunningAria")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <span
        aria-hidden="true"
        className="sidebar-running-spinner"
        data-reduced-motion={reducedMotion ? "true" : "false"}
        style={{ width: size - 2, height: size - 2 }}
      />
    </span>
  );
}
function UnreadSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <span
      title={t("sessionSidebar.newActivity")}
      aria-label={t("sessionSidebar.newSessionActivity")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        {!reducedMotion && (
          <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
            <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
    </span>
  );
}
export {
  OmpWebTitle,
  PathLabel,
  RunningSessionIndicator,
  SIDEBAR_BUTTON_TRANSITION,
  SidebarIconButton,
  SidebarPortalMenu,
  UnreadSessionIndicator,
  useScramble,
};
