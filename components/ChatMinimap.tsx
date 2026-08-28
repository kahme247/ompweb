"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, RefObject } from "react";
import type { AgentMessage, AssistantMessage, TextContent } from "@/lib/types";
import { MINIMAP_WIDTH } from "@/lib/chat-layout";

interface Props {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}


function getMessagePreview(msg: AgentMessage | Partial<AgentMessage>): string {
  if (msg.role === "user") {
    const content = msg.content;
    if (typeof content === "string") return content.slice(0, 200);
    if (Array.isArray(content)) {
      return (content as { type: string; text?: string }[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n")
        .slice(0, 200);
    }
    return "";
  }
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    const text = blocks
      .filter((b): b is TextContent => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    if (text) return text.slice(0, 200);
    const toolNames = blocks
      .filter((b) => b.type === "toolCall")
      .map((b) => (b as { type: string; toolName: string }).toolName);
    if (toolNames.length) return toolNames.join(", ");
    return "";
  }
  return "";
}

function getNodeColor(msg: AgentMessage | Partial<AgentMessage>): { bg: string; border: string } {
  if (msg.role === "user") {
    return { bg: "color-mix(in srgb, var(--accent) 18%, transparent)", border: "color-mix(in srgb, var(--accent) 70%, transparent)" };
  }
  return { bg: "color-mix(in srgb, var(--text-dim) 12%, transparent)", border: "color-mix(in srgb, var(--text-dim) 50%, transparent)" };
}

function hasTextContent(msg: AgentMessage | Partial<AgentMessage>): boolean {
  if (msg.role === "user") return true;
  if (msg.role === "assistant") {
    const blocks = (msg as Partial<AssistantMessage>).content ?? [];
    return blocks.some((b) => b.type === "text");
  }
  return false;
}

interface NodeInfo {
  topRatio: number;   // 0–1 within total scroll height
  heightRatio: number;
  msg: AgentMessage | Partial<AgentMessage>;
  index: number;
}

export const ChatMinimap = memo(function ChatMinimap({ messages, scrollContainer, messageRefs }: Props) {
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [visible, setVisible] = useState(false);
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const [hoveredTooltipIndex, setHoveredTooltipIndex] = useState<number | null>(null);
  const draggingRef = useRef(false);
  const dragListenersRef = useRef<{ onMove: (ev: MouseEvent) => void; onUp: () => void } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overflowPanelRef = useRef<HTMLDivElement>(null);
  // RAF gate for mousemove so a pixel-level pointer event doesn't re-render
  // the whole minimap (every node + tooltip) on every frame.
  const mouseMoveRafRef = useRef<number | null>(null);
  const pendingMouseYRef = useRef<number | null>(null);

  // Historical nodes only: the live streaming bubble is rendered outside the
  // ref'd message list, so it has no DOM entry to measure — excluding it here
  // also keeps the minimap from re-rendering on every token frame.
  const allMessages = messages as (AgentMessage | Partial<AgentMessage>)[];
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  // --- 仅更新视口比例，不读取 DOM ---
  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const totalH = scrollEl.scrollHeight;
    const clientH = scrollEl.clientHeight;
    const scrollable = totalH - clientH;
    setVisible(scrollable > 20);
    if (scrollable <= 0) {
      setScrollRatio(0);
      setViewportRatio(1);
    } else {
      setScrollRatio(scrollEl.scrollTop / scrollable);
      setViewportRatio(clientH / totalH);
    }
  }, [scrollContainer]);

  // --- 节流 DOM 测量（仅消息变化/尺寸变化时触发，最多 150ms 一次）---
  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureNodes = useCallback(() => {
    // 节流：150ms 内忽略重复调用
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      if (!scrollEl) return;
      const totalH = scrollEl.scrollHeight;
      if (totalH <= 0) return;

      const refs = messageRefs.current;
      const newNodes: NodeInfo[] = [];
      let refIndex = 0;
      const allMessages = allMessagesRef.current;
      // Same scroll container for every node — read its geometry once instead
      // of per message (the loop scales with transcript length).
      const containerRect = scrollEl.getBoundingClientRect();

      for (let i = 0; i < allMessages.length; i++) {
        const msg = allMessages[i];
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        const el = refs?.[refIndex];
        refIndex++;
        if (!hasTextContent(msg)) continue;
        if (el) {
          const elRect = el.getBoundingClientRect();
          const top = elRect.top - containerRect.top + scrollEl.scrollTop;
          const h = elRect.height;
          newNodes.push({
            topRatio: top / totalH,
            heightRatio: h / totalH,
            msg,
            index: newNodes.length,
          });
        }
      }
      setNodes(newNodes);
    }, 150);
  }, [scrollContainer, messageRefs]);

  // scroll 事件 → 只更新视口，不碰 DOM。rAF-coalesce like the mousemove
  // handler: writing three state values on every scroll event re-renders all
  // nodes + tooltips dozens of times per second.
  const scrollRafRef = useRef<number | null>(null);
  const flushScroll = useCallback(() => {
    scrollRafRef.current = null;
    updateScroll();
  }, [updateScroll]);
  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const onScroll = () => {
      if (scrollRafRef.current === null) {
        scrollRafRef.current = requestAnimationFrame(flushScroll);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [scrollContainer, flushScroll]);

  // Keep both node positions and viewport ratios in sync with layout changes.
  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      updateScroll();
      measureNodes();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    // Also observe the scroll content for height changes
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [scrollContainer, measureNodes, updateScroll]);

  // Wait briefly for new message DOM before syncing layout.
  useEffect(() => {
    const t = setTimeout(() => {
      updateScroll();
      measureNodes();
    }, 50);
    return () => clearTimeout(t);
  }, [messages.length, measureNodes, updateScroll]);

  // Cancel any pending mousemove flush when the component unmounts.
  useEffect(() => {
    return () => {
      if (mouseMoveRafRef.current !== null) {
        cancelAnimationFrame(mouseMoveRafRef.current);
        mouseMoveRafRef.current = null;
      }
    };
  }, []);

  const scrollToMinimapRatio = useCallback((viewportTopRatio: number) => {
    const el = scrollContainer.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;
    const clamped = Math.max(0, Math.min(1 - viewportRatio, viewportTopRatio));
    el.scrollTop = (clamped / (1 - viewportRatio)) * scrollable;
  }, [scrollContainer, viewportRatio]);

  // Coalesce mousemove updates to one per animation frame: writing state on
  // every pointermove event re-renders all nodes + tooltips dozens of times
  // per second while the cursor is inside the minimap.
  const flushMouseMove = useCallback(() => {
    mouseMoveRafRef.current = null;
    if (pendingMouseYRef.current !== null) {
      setMouseYRatio(pendingMouseYRef.current);
      pendingMouseYRef.current = null;
    }
  }, []);
  const handleMinimapMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    pendingMouseYRef.current = (e.clientY - rect.top) / rect.height;
    if (mouseMoveRafRef.current === null) {
      mouseMoveRafRef.current = requestAnimationFrame(flushMouseMove);
    }
  }, [flushMouseMove]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!visible) return;

    draggingRef.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickRatio = (e.clientY - rect.top) / rect.height;
    const grabOffset = clickRatio - scrollRatio * (1 - viewportRatio);
    const insideBox = grabOffset >= 0 && grabOffset <= viewportRatio;
    const offset = insideBox ? grabOffset : viewportRatio / 2;

    scrollToMinimapRatio(clickRatio - offset);

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const r = (ev.clientY - rect.top) / rect.height;
      scrollToMinimapRatio(r - offset);
    };
    const onUp = () => {
      draggingRef.current = false;
      dragListenersRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    dragListenersRef.current = { onMove, onUp };
  }, [visible, viewportRatio, scrollRatio, scrollToMinimapRatio]);

  // An interrupted drag (unmount before mouseup) must not leak the window
  // listeners.
  useEffect(() => () => {
    const listeners = dragListenersRef.current;
    if (listeners) {
      window.removeEventListener("mousemove", listeners.onMove);
      window.removeEventListener("mouseup", listeners.onUp);
      dragListenersRef.current = null;
    }
    draggingRef.current = false;
  }, []);



  // Compute collision-free tooltip positions for all nodes
  const TOOLTIP_HEIGHT = 22;
  const TOOLTIP_GAP = 2;
  const minimapHeightPx = containerRef.current?.clientHeight ?? 600;
  const tooltipListOverflows = nodes.length * (TOOLTIP_HEIGHT + TOOLTIP_GAP) > minimapHeightPx;

  // Per-node colors and previews are pure functions of each node's message;
  // memoize so they aren't recomputed on every scroll/mousemove re-render.
  const nodeColors = useMemo(() => nodes.map((node) => getNodeColor(node.msg)), [nodes]);
  const nodePreviews = useMemo(() => nodes.map((node) => getMessagePreview(node.msg)), [nodes]);

  const tooltipPositions = useMemo(() => {
    if (!minimapHovered || nodes.length === 0 || tooltipListOverflows) return [];
    // Initial positions: centered on the dot
    const positions = nodes.map((node) =>
      Math.round(node.topRatio * minimapHeightPx - TOOLTIP_HEIGHT / 2)
    );
    // Iterative push-apart to resolve overlaps (top-to-bottom pass, then bottom-to-top)
    for (let pass = 0; pass < 10; pass++) {
      for (let i = 1; i < positions.length; i++) {
        const minTop = positions[i - 1] + TOOLTIP_HEIGHT + TOOLTIP_GAP;
        if (positions[i] < minTop) positions[i] = minTop;
      }
      for (let i = positions.length - 2; i >= 0; i--) {
        const maxTop = positions[i + 1] - TOOLTIP_HEIGHT - TOOLTIP_GAP;
        if (positions[i] > maxTop) positions[i] = maxTop;
      }
    }
    // Clamp all to minimap bounds
    for (let i = 0; i < positions.length; i++) {
      positions[i] = Math.max(0, Math.min(minimapHeightPx - TOOLTIP_HEIGHT, positions[i]));
    }
    return positions;
  }, [minimapHovered, nodes, minimapHeightPx, tooltipListOverflows]);

  // Find the node closest to the current mouse position; direct tooltip
  // hover takes precedence (collision-free layout shifts tooltip positions
  // away from their node's scroll ratio, so Y-distance is wrong there).
  const computedNearest = mouseYRatio !== null && nodes.length > 0
    ? nodes.reduce((best, node) => {
        return Math.abs(node.topRatio - mouseYRatio) < Math.abs(nodes[best].topRatio - mouseYRatio) ? node.index : best;
      }, 0)
    : null;
  const nearestIndex = hoveredTooltipIndex ?? computedNearest;

  // Auto-scroll the overflow tooltip panel to keep the minimap-driven
  // selection visible. Skipped when the user is directly hovering over the
  // panel (hoveredTooltipIndex !== null) to avoid fighting manual scrolling.
  useEffect(() => {
    if (computedNearest === null || hoveredTooltipIndex !== null) return;
    const panel = overflowPanelRef.current;
    if (!panel) return;
    const row = panel.querySelector(`[data-node-index="${computedNearest}"]`) as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }, [computedNearest, hoveredTooltipIndex]);

  if (!visible) return null;

  const viewportBoxTop = scrollRatio * (1 - viewportRatio) * 100;
  const viewportBoxHeight = viewportRatio * 100;

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseEnter={() => setMinimapHovered(true)}
      onMouseLeave={() => { setMinimapHovered(false); setMouseYRatio(null); setHoveredTooltipIndex(null); }}
      onMouseMove={handleMinimapMouseMove}
      style={{
        width: MINIMAP_WIDTH,
        flexShrink: 0,
        position: "relative",
        cursor: "default",
        userSelect: "none",
        borderLeft: "1px solid var(--border)",
        background: "var(--bg-panel)",
        overflow: "visible",
      }}
    >
      {/* Viewport indicator */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${viewportBoxTop}%`,
          height: `${viewportBoxHeight}%`,
          background: "color-mix(in srgb, var(--text-dim) 10%, transparent)",
          borderTop: "1px solid color-mix(in srgb, var(--text-dim) 20%, transparent)",
          borderBottom: "1px solid color-mix(in srgb, var(--text-dim) 20%, transparent)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      {/* Message nodes */}
      {nodes.map((node) => {
        const color = nodeColors[node.index] ?? getNodeColor(node.msg);
        const isNearest = minimapHovered && nearestIndex === node.index;
        const isUser = node.msg.role === "user";
        const dotTop = node.topRatio * 100;

        return (
          <div
            key={node.index}

            style={{
              position: "absolute",
              top: `${dotTop}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 2,
            }}
          >
            {/* Dot */}
            <div
              style={{
                width: isUser ? 8 : 6,
                height: isUser ? 8 : 6,
                borderRadius: isUser ? 2 : "50%",
                background: color.bg,
                border: `1.5px solid ${color.border}`,
                flexShrink: 0,
                transition: "transform var(--dur-fast) var(--ease-out-warm)",
                transform: isNearest ? "scale(1.6)" : "scale(1)",
              }}
            />


          </div>
        );
      })}

      {/* Center line */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 0,
          bottom: 0,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />
      {/* Tooltip panel: scrollable list when overflowing, absolute-positioned when fits */}
      {minimapHovered && nodes.length > 0 && tooltipListOverflows && (
        <div
          ref={overflowPanelRef}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: "100%",
            width: 206,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            boxShadow: "var(--shadow-pop)",
            zIndex: 99,
            pointerEvents: "auto",
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          {nodes.map((node) => {
            const preview = nodePreviews[node.index] ?? getMessagePreview(node.msg);
            const color = nodeColors[node.index] ?? getNodeColor(node.msg);
            const isNearest = nearestIndex === node.index;
            if (!preview) return null;
            return (
              <div
                key={node.index}
                data-node-index={node.index}
                onMouseEnter={() => setHoveredTooltipIndex(node.index)}
                onMouseLeave={() => setHoveredTooltipIndex(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  const el = scrollContainer.current;
                  if (!el) return;
                  el.scrollTop = node.topRatio * el.scrollHeight;
                }}
                style={{
                  padding: "2px 7px",
                  borderLeft: `2px solid ${color.border}`,
                  background: isNearest ? "var(--bg-hover)" : "transparent",
                  cursor: "pointer",
                  transition: "background var(--dur-fast) var(--ease-out-warm)",
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: isNearest ? "var(--text)" : "var(--text-muted)",
                    lineHeight: 1.4,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {preview}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {minimapHovered && tooltipPositions.length > 0 && (() => {
        // Opaque backdrop spanning first to last tooltip; width includes the
        // 6px gutter so the mouse can't fall through the gap between the
        // minimap strip and the tooltip panel.
        const firstTop = tooltipPositions[0];
        const lastBottom = tooltipPositions[tooltipPositions.length - 1] + TOOLTIP_HEIGHT;
        return (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              top: firstTop - 4,
              right: "100%",
              width: 206,
              height: lastBottom - firstTop + 8,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-control)",
              boxShadow: "var(--shadow-pop)",
              zIndex: 99,
              pointerEvents: "auto",
            }}
          />
        );
      })()}
      {minimapHovered && !tooltipListOverflows && nodes.map((node, i) => {
        const preview = nodePreviews[i] ?? getMessagePreview(node.msg);
        const color = nodeColors[i] ?? getNodeColor(node.msg);
        const isNearest = nearestIndex === node.index;
        if (!preview || tooltipPositions.length === 0) return null;
        return (
          <div
            key={node.index}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={() => setHoveredTooltipIndex(node.index)}
            onMouseLeave={() => setHoveredTooltipIndex(null)}
            onClick={(e) => {
              e.stopPropagation();
              const el = scrollContainer.current;
              if (!el) return;
              el.scrollTop = node.topRatio * el.scrollHeight;
            }}
            style={{
              position: "absolute",
              top: tooltipPositions[i],
              right: "100%",
              marginRight: 3,
              background: isNearest ? "var(--bg-hover)" : "var(--bg-panel)",
              borderLeft: `2px solid ${color.border}`,
              borderRadius: 2,
              padding: "2px 7px",
              width: 200,
              zIndex: 100,
              cursor: "pointer",
              transition: "top var(--dur-fast) var(--ease-out-warm), background var(--dur-fast) var(--ease-out-warm)",
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: isNearest ? "var(--text)" : "var(--text-muted)",
                lineHeight: 1.4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {preview}
            </div>
          </div>
        );
      })}
    </div>
  );
});

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  // Reuse the same array object while the count is unchanged: ChatWindow
  // renders (incl. every streaming token batch) otherwise allocate a fresh
  // Array per render even though no slot changes.
  const prevCount = useRef(0);
  if (prevCount.current !== count) {
    prevCount.current = count;
    const next = Array(count);
    for (let i = 0; i < count; i += 1) next[i] = refs.current[i] ?? null;
    refs.current = next;
  }
  return refs;
}
