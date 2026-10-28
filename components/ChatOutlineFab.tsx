"use client";

import { memo, useEffect, useRef, useState, useCallback, type RefObject } from "react";
import { ListTree, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useChatOutline, type NavNode } from "@/hooks/useChatOutline";
import type { AgentMessage } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  nearBottom: boolean;
  isMobile: boolean;
  onEnsureVisible?: (messageIndex: number) => void;
}

export const ChatOutlineFab = memo(function ChatOutlineFab({
  messages,
  scrollContainer,
  messageRefs,
  nearBottom,
  isMobile,
  onEnsureVisible,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { nodes, activeIndex, scrollToNode } = useChatOutline({
    messages,
    scrollContainer,
    messageRefs,
    onEnsureVisible,
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (
        popupRef.current &&
        !popupRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("touchstart", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("touchstart", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Scroll active item into view inside popup when opened
  useEffect(() => {
    if (open && popupRef.current) {
      const activeEl = popupRef.current.querySelector(`[data-outline-index="${activeIndex}"]`) as HTMLElement | null;
      activeEl?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [open, activeIndex]);

  // If no turns exist yet, do not render FAB
  if (nodes.length === 0) {
    return null;
  }

  // Dynamic bottom positioning: sits above jump-to-bottom FAB (height 36 + gap 8 = 44px higher) when !nearBottom
  const fabBottomPx = nearBottom ? 16 : 60;
  const popupBottomPx = nearBottom ? 58 : 102;
  const rightPx = isMobile ? 16 : 48;

  const toggleLabel = t("chatOutline.toggleTitle") || "Conversation outline";

  return (
    <>
      {/* Floating Action Button - matching chat-scroll-bottom shape and style */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title={toggleLabel}
        aria-label={toggleLabel}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="chat-outline-fab ui-focus-ring"
        style={{
          position: "absolute",
          right: rightPx,
          bottom: fabBottomPx,
          zIndex: 35,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          padding: 0,
          border: open ? "1px solid var(--accent)" : "1px solid var(--border)",
          borderRadius: "var(--radius-control)",
          background: "var(--bg-panel)",
          color: open ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer",
          boxShadow: "var(--shadow-pop)",
          transition: "bottom var(--dur-med) var(--ease-out-warm), color var(--dur-fast), border-color var(--dur-fast)",
        }}
      >
        <ListTree size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {/* Floating Outline Popup Panel */}
      {open && (
        <div
          ref={popupRef}
          role="dialog"
          aria-label={t("chatOutline.title") || "Outline"}
          style={{
            position: "absolute",
            right: rightPx,
            bottom: popupBottomPx,
            zIndex: 40,
            width: isMobile ? "min(340px, calc(100vw - 32px))" : 320,
            maxHeight: isMobile ? "min(55vh, 400px)" : "min(65vh, 460px)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-modal)",
            boxShadow: "var(--shadow-pop)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            animation: "ui-scale-in var(--dur-med) var(--ease-out-warm)",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <ListTree size={14} strokeWidth={2} style={{ color: "var(--accent)" }} aria-hidden="true" />
              <span style={{ fontSize: 13, fontWeight: 650, color: "var(--text)" }}>
                {t("chatOutline.title") || "Outline"}
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  padding: "1px 6px",
                  borderRadius: 9999,
                  background: "color-mix(in srgb, var(--border) 60%, transparent)",
                  color: "var(--text-muted)",
                }}
              >
                {nodes.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("chatOutline.close") || "Close outline"}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                padding: 0,
                border: "none",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
                borderRadius: "var(--radius-control)",
              }}
            >
              <X size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>

          {/* List of prompt chapters */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "6px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {nodes.map((node, i) => {
              const isActive = activeIndex === i;
              return (
                <div
                  key={node.id}
                  data-outline-index={i}
                  role="button"
                  tabIndex={0}
                  aria-label={`Jump to: ${node.text}`}
                  onClick={() => {
                    scrollToNode(node);
                    setOpen(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      scrollToNode(node);
                      setOpen(false);
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: "var(--radius-control)",
                    background: isActive
                      ? "color-mix(in srgb, var(--accent) 15%, transparent)"
                      : "transparent",
                    border: isActive
                      ? "1px solid color-mix(in srgb, var(--accent) 30%, transparent)"
                      : "1px solid transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background var(--dur-fast), border-color var(--dur-fast)",
                  }}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                      fontWeight: 600,
                      color: isActive ? "var(--accent)" : "var(--text-dim)",
                      marginTop: 2,
                      minWidth: 18,
                    }}
                  >
                    #{i + 1}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      lineHeight: 1.4,
                      color: isActive ? "var(--text)" : "var(--text-muted)",
                      fontWeight: isActive ? 600 : 400,
                      wordBreak: "break-word",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {node.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
});
