"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { AgentMessage, TextContent } from "@/lib/types";

interface Props {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

export interface NavNode {
  id: string;
  text: string;
  messageIndex: number;
  refIndex: number;
  isUser: boolean;
}

/**
 * Extracts a concise, clean single-line preview string suitable for the
 * floating context navigation pill (e.g. "move Explorer to right panel").
 */
export function extractPreviewText(msg: AgentMessage | Partial<AgentMessage>): string {
  let raw = "";

  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") {
      raw = content;
    } else if (Array.isArray(content)) {
      raw = content
        .filter((b): b is TextContent => Boolean(b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string"))
        .map((b) => b.text)
        .join(" ");
    }
  } else if (msg.role === "assistant") {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const text = blocks
      .filter((b): b is TextContent => Boolean(b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string"))
      .map((b) => b.text)
      .join(" ");
    if (text) {
      raw = text;
    } else {
      const toolNames = blocks
        .filter((b) => Boolean(b && typeof b === "object" && "type" in b && b.type === "toolCall"))
        .map((b) => (b && typeof b === "object" && "toolName" in b && typeof b.toolName === "string" ? b.toolName : ""));
      if (toolNames.length) raw = toolNames.filter(Boolean).join(", ");
    }
  }

  // Strip markdown headers, code blocks, formatting, and flatten whitespace
  let clean = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/[*_`~[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) {
    clean = raw.replace(/\s+/g, " ").trim();
  }

  if (clean.length > 60) {
    return clean.slice(0, 58) + "…";
  }
  return clean;
}

/**
 * Calculates a dynamic bar width to create the natural, organic minimap rhythm
 * seen in chat outlines (shorter bars for brief turns, longer for detailed prompts).
 */
export function getBarWidth(text: string, isActive: boolean, isHovered: boolean): number {
  if (isActive) return 24;
  if (isHovered) return 22;
  const len = text.length;
  if (len <= 15) return 10;
  if (len <= 30) return 14;
  if (len <= 50) return 18;
  return 20;
}

const ROW_HEIGHT = 18;

/**
 * Vertical center of a rail row's tooltip, in the unclipped outer
 * container's coordinates. The rail is a flex column whose rows used to
 * shrink below ROW_HEIGHT once the list exceeded the rail's max-height,
 * so a tooltip positioned purely from the index drifted below its row
 * and eventually out of view (#251). Rows are now non-shrinking (see the
 * row style below), so the rail scrolls instead of compressing; the only
 * correction left is the rail's own scroll offset, which is 0 while the
 * rail fits and otherwise moves the visible row up by exactly that much.
 */
export function getTooltipTopPx(displayIndex: number, railScrollTop = 0): number {
  return 6 + displayIndex * ROW_HEIGHT + ROW_HEIGHT / 2 - railScrollTop;
}

/**
 * Row index under a drag pointer, in a rail whose rows are fixed-height
 * and may be scrolled (#251 follow-up). The pointer's viewport offset
 * inside the rail plus the rail's scroll offset gives its position in
 * the rail's content, where row i starts at 6 + i * ROW_HEIGHT (6px
 * top padding). The old ratio-over-visible-height mapping only worked
 * while every row was visible at once, which fixed-height rows no
 * longer guarantee.
 */
/**
 * Whether the rail actually overflows, so the active row only gets
 * scrolled into view when it could sit outside the visible rail
 * (#251 follow-up). A row-count guard misses short viewports: 15
 * fixed-height rows already need 282px, more than a <376px viewport's
 * 75vh cap, so the rail can overflow with far fewer than 16 rows.
 */
export function railOverflows(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight;
}

export function railIndexForPointer(relY: number, railScrollTop: number, nodeCount: number): number {
  if (nodeCount <= 0) return 0;
  const contentY = railScrollTop + relY;
  const index = Math.floor((contentY - 6) / ROW_HEIGHT);
  return Math.max(0, Math.min(nodeCount - 1, index));
}

export const ChatMinimap = memo(function ChatMinimap({ messages, scrollContainer, messageRefs }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isRailHovered, setIsRailHovered] = useState(false);
  const [railScrollTop, setRailScrollTop] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);

  // Extract navigation nodes: user prompts first (as the chapters of context),
  // falling back to assistant messages if no user prompts exist yet.
  const nodes = useMemo(() => {
    const userNodes: NavNode[] = [];
    let refIndex = 0;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const currentRef = refIndex++;
      if (msg.role === "user") {
        const text = extractPreviewText(msg);
        if (text) {
          const id = msg && typeof msg === "object" && "id" in msg && typeof msg.id === "string" ? msg.id : `u-${i}`;
          userNodes.push({
            id,
            text,
            messageIndex: i,
            refIndex: currentRef,
            isUser: true,
          });
        }
      }
    }

    if (userNodes.length > 0) return userNodes;

    // Fallback: assistant messages
    const assistantNodes: NavNode[] = [];
    let aRef = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const currentRef = aRef++;
      if (msg.role === "assistant") {
        const text = extractPreviewText(msg);
        if (text) {
          const id = msg && typeof msg === "object" && "id" in msg && typeof msg.id === "string" ? msg.id : `a-${i}`;
          assistantNodes.push({
            id,
            text,
            messageIndex: i,
            refIndex: currentRef,
            isUser: false,
          });
        }
      }
    }
    return assistantNodes;
  }, [messages]);

  // Smoothly scroll to the target message with multi-strategy element resolution
  const reducedMotion = usePrefersReducedMotion();
  const scrollToNode = useCallback((node: NavNode, smooth = true) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    let targetEl = messageRefs.current?.[node.refIndex];
    if (!targetEl) {
      targetEl = scrollEl.querySelector(`[data-message-index="${node.messageIndex}"]`) as HTMLDivElement | null;
    }
    if (!targetEl && node.text) {
      const cards = scrollEl.querySelectorAll(".chat-message-card");
      const sample = node.text.slice(0, 20);
      for (const card of Array.from(cards)) {
        if (card.textContent?.includes(sample)) {
          targetEl = (card.closest("[data-message-index]") || card.parentElement || card) as HTMLDivElement;
          break;
        }
      }
    }

    const behavior: ScrollBehavior = smooth && !reducedMotion ? "smooth" : "auto";
    if (targetEl) {
      const containerRect = scrollEl.getBoundingClientRect();
      const elRect = targetEl.getBoundingClientRect();
      const targetScroll = Math.max(0, scrollEl.scrollTop + (elRect.top - containerRect.top) - 16);
      scrollEl.scrollTo({ top: targetScroll, behavior });
    } else {
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (maxScroll > 0) {
        const targetScroll = Math.max(0, (node.messageIndex / Math.max(1, messages.length - 1)) * maxScroll);
        scrollEl.scrollTo({ top: targetScroll, behavior });
      }
    }
  }, [scrollContainer, messageRefs, messages.length, reducedMotion]);

  const scrollToNodeRef = useRef(scrollToNode);
  scrollToNodeRef.current = scrollToNode;

  // Scroll-spy: identify which message node is currently in the viewport
  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl || nodes.length === 0) return;

    const { scrollTop, clientHeight, scrollHeight } = scrollEl;

    // Bottom reached -> last node active
    if (scrollTop + clientHeight >= scrollHeight - 30) {
      setActiveIndex(nodes.length - 1);
      return;
    }

    const containerRect = scrollEl.getBoundingClientRect();
    let bestIdx = 0;

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let el = messageRefs.current?.[node.refIndex];
      if (!el) {
        el = scrollEl.querySelector(`[data-message-index="${node.messageIndex}"]`) as HTMLDivElement | null;
      }
      if (!el) continue;
      const elRect = el.getBoundingClientRect();
      const relTop = elRect.top - containerRect.top;
      if (relTop <= 120) {
        bestIdx = i;
      } else {
        break;
      }
    }

    setActiveIndex(bestIdx);
  }, [scrollContainer, messageRefs, nodes]);

  const updateScrollRef = useRef(updateScroll);
  updateScrollRef.current = updateScroll;

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const handleScroll = () => {
      if (scrollRafRef.current === null) {
        scrollRafRef.current = requestAnimationFrame(() => {
          scrollRafRef.current = null;
          updateScrollRef.current();
        });
      }
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [scrollContainer]);

  // Observe resize to update visibility & active node
  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      updateScrollRef.current();
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    updateScrollRef.current();
    return () => ro.disconnect();
  }, [scrollContainer]);

  // Keep active row visible within the rail when the rail overflows
  useEffect(() => {
    if (railRef.current && railOverflows(railRef.current.scrollHeight, railRef.current.clientHeight)) {
      const activeRow = railRef.current.querySelector(`[data-index="${activeIndex}"]`) as HTMLElement | null;
      activeRow?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    }
  }, [activeIndex, nodes.length, reducedMotion]);

  // Drag scrubber interaction along the vertical rail
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (nodes.length === 0) return;
    draggingRef.current = true;

    const handlePointerY = (clientY: number) => {
      const railEl = railRef.current;
      if (!railEl) return;
      const rect = railEl.getBoundingClientRect();
      const relY = clientY - rect.top;
      const targetIdx = railIndexForPointer(relY, railEl.scrollTop, nodes.length);
      if (nodes[targetIdx]) {
        scrollToNodeRef.current(nodes[targetIdx], false);
        setActiveIndex(targetIdx);
        setHoveredIndex(targetIdx);
      }
    };

    handlePointerY(e.clientY);

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      handlePointerY(ev.clientY);
    };

    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [nodes]);

  // Interrupted drag cleanup on unmount
  useEffect(() => {
    return () => {
      draggingRef.current = false;
    };
  }, []);

  if (nodes.length === 0) {
    return null;
  }

  // Active or explicitly hovered tooltip target
  const displayTooltipIndex = hoveredIndex !== null ? hoveredIndex : (isRailHovered ? activeIndex : null);
  const tooltipNode = displayTooltipIndex !== null ? nodes[displayTooltipIndex] : null;
  // Calculate unclipped vertical center position for the tooltip
  const tooltipTopPx = displayTooltipIndex !== null ? getTooltipTopPx(displayTooltipIndex, railScrollTop) : 0;

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        pointerEvents: "auto",
        userSelect: "none",
        marginRight: 8,
      }}
    >
      {/* Floating Preview Tooltip - rendered in unclipped outer container! */}
      {tooltipNode && (
        <div
          role="tooltip"
          onClick={(e) => {
            e.stopPropagation();
            scrollToNode(tooltipNode);
          }}
          style={{
            position: "absolute",
            right: "calc(100% + 10px)",
            top: tooltipTopPx,
            transform: "translateY(-50%)",
            whiteSpace: "nowrap",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            padding: "6px 14px",
            boxShadow: "var(--shadow-pop)",
            color: "var(--text)",
            fontSize: 12,
            fontWeight: 500,
            lineHeight: 1.4,
            pointerEvents: "auto",
            zIndex: 60,
            maxWidth: 280,
            overflow: "hidden",
            textOverflow: "ellipsis",
            cursor: "pointer",
            transition: "top 120ms var(--ease-out-warm)",
          }}
        >
          {tooltipNode.text}
        </div>
      )}

      {/* The Rail Container */}
      <div
        ref={railRef}
        role="navigation"
        aria-label="Chat context navigation"
        onMouseEnter={() => setIsRailHovered(true)}
        onMouseLeave={() => {
          setIsRailHovered(false);
          setHoveredIndex(null);
        }}
        onScroll={(e) => setRailScrollTop(e.currentTarget.scrollTop)}
        onMouseDown={handleMouseDown}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          padding: "6px 6px 6px 8px",
          maxHeight: "min(75vh, 520px)",
          // Always scrollable: with fixed-height rows, even 25 or fewer
          // rows can exceed a short viewport's 75vh cap, and "visible"
          // would then spill them out of the rail with no way to reach
          // them (#251 follow-up). scrollbarWidth none keeps it clean.
          overflowY: "auto",
          scrollbarWidth: "none",
          cursor: "pointer",
        }}
      >
        {/* Subtle vertical hairline anchor on the left */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 8,
            top: 4,
            bottom: 4,
            width: 1,
            background: "color-mix(in srgb, var(--border) 60%, transparent)",
            borderRadius: 1,
            pointerEvents: "none",
          }}
        />

        {/* Navigation bars */}
        {nodes.map((node, i) => {
          const isActive = activeIndex === i;
          const isHovered = hoveredIndex === i;

          return (
            <div
              key={node.id}
              data-index={i}
              role="button"
              tabIndex={0}
              aria-label={`Jump to: ${node.text}`}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex((cur) => (cur === i ? null : cur))}
              onClick={(e) => {
                e.stopPropagation();
                scrollToNode(node);
                setActiveIndex(i);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  scrollToNode(node);
                  setActiveIndex(i);
                }
              }}
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                height: ROW_HEIGHT,
                // Rows must not shrink: with maxHeight + overflowY auto the
                // rail is meant to scroll past ~25 entries, but the flex
                // default (flexShrink 1) compressed every row to ~520/N
                // instead, which is what broke tooltip alignment (#251).
                flexShrink: 0,
                minHeight: ROW_HEIGHT,
                paddingLeft: 6,
                paddingRight: 8,
                cursor: "pointer",
              }}
            >
              {/* The Horizontal Pill Bar */}
              <div
                style={{
                  width: getBarWidth(node.text, isActive, isHovered),
                  height: isActive ? 4 : 3,
                  borderRadius: 9999,
                  background: isActive
                    ? "var(--text)"
                    : isHovered
                    ? "color-mix(in srgb, var(--text) 85%, transparent)"
                    : "color-mix(in srgb, var(--text-dim) 40%, transparent)",
                  boxShadow: isActive
                    ? "0 0 6px color-mix(in srgb, var(--text) 30%, transparent)"
                    : "none",
                  transition: "all 160ms var(--ease-out-warm)",
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const prevCount = useRef(0);
  if (prevCount.current !== count) {
    prevCount.current = count;
    refs.current = refs.current.slice(0, count);
  }
  return refs;
}
