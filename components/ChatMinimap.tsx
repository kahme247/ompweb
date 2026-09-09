"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
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

export const ChatMinimap = memo(function ChatMinimap({ messages, scrollContainer, messageRefs }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isRailHovered, setIsRailHovered] = useState(false);
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
  const scrollToNode = useCallback((node: NavNode) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    // 1. Check messageRefs first
    let targetEl = messageRefs.current?.[node.refIndex];

    // 2. Fallback to data-message-index query selector
    if (!targetEl) {
      targetEl = scrollEl.querySelector(`[data-message-index="${node.messageIndex}"]`) as HTMLDivElement | null;
    }

    // 3. Fallback to matching chat message card text
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

    if (targetEl) {
      const containerRect = scrollEl.getBoundingClientRect();
      const elRect = targetEl.getBoundingClientRect();
      const targetScroll = Math.max(0, scrollEl.scrollTop + (elRect.top - containerRect.top) - 16);
      scrollEl.scrollTop = targetScroll;
      scrollEl.scrollTo({
        top: targetScroll,
        behavior: "smooth",
      });
    } else {
      // 4. Proportional scroll fallback if element is outside rendered window
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (maxScroll > 0) {
        const targetScroll = Math.max(0, (node.messageIndex / Math.max(1, messages.length - 1)) * maxScroll);
        scrollEl.scrollTop = targetScroll;
        scrollEl.scrollTo({
          top: targetScroll,
          behavior: "smooth",
        });
      }
    }
  }, [scrollContainer, messageRefs, messages.length]);

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

  // Keep active row visible within the rail when node count overflows
  useEffect(() => {
    if (railRef.current && nodes.length > 15) {
      const activeRow = railRef.current.querySelector(`[data-index="${activeIndex}"]`) as HTMLElement | null;
      activeRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeIndex, nodes.length]);

  // Drag scrubber interaction along the vertical rail
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (nodes.length === 0) return;
    draggingRef.current = true;

    const handlePointerY = (clientY: number) => {
      const railEl = railRef.current;
      if (!railEl) return;
      const rect = railEl.getBoundingClientRect();
      const relY = clientY - rect.top;
      const ratio = Math.max(0, Math.min(1, relY / rect.height));
      const targetIdx = Math.min(nodes.length - 1, Math.floor(ratio * nodes.length));
      if (nodes[targetIdx]) {
        scrollToNodeRef.current(nodes[targetIdx]);
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
  const tooltipTopPx = displayTooltipIndex !== null ? 6 + displayTooltipIndex * ROW_HEIGHT + ROW_HEIGHT / 2 : 0;

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
        onMouseDown={handleMouseDown}
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          padding: "6px 6px 6px 8px",
          maxHeight: "min(75vh, 520px)",
          overflowY: nodes.length > 25 ? "auto" : "visible",
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
