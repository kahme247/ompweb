"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { AgentMessage, TextContent } from "@/lib/types";

export interface NavNode {
  id: string;
  text: string;
  messageIndex: number;
  refIndex: number;
  isUser: boolean;
}

/**
 * Extracts a concise, clean single-line preview string suitable for the
 * floating context navigation pill or outline list item.
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

    // Strip injected XML wrappers such as <donna-context>, <system-notice>, etc.
    raw = raw.replace(/<[a-zA-Z0-9_-]+[^>]*>[\s\S]*?<\/[a-zA-Z0-9_-]+>/g, "");

    // Strip [IMPORTANT: ...] skill instruction blocks
    raw = raw.replace(/\[IMPORTANT:[\s\S]*?\]/gi, "");

    // If an explicit "User: <text>" is present after system context, extract the actual prompt
    const userMatch = raw.match(/(?:^|\n)\s*User:\s*([\s\S]+)$/i);
    if (userMatch && userMatch[1]?.trim()) {
      raw = userMatch[1];
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
 * Extracts navigation nodes representing chapters of the conversation,
 * tracks the currently active message in the viewport (scroll-spy),
 * and provides smooth navigation to any node.
 */
export function useChatOutline({
  messages,
  scrollContainer,
  messageRefs,
  onEnsureVisible,
}: {
  messages: AgentMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  onEnsureVisible?: (messageIndex: number) => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
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

    // Prioritize direct DOM lookup by exact data-message-index:
    let targetEl = scrollEl.querySelector(`[data-message-index="${node.messageIndex}"]`) as HTMLDivElement | null;
    if (!targetEl || !targetEl.isConnected) {
      const refEl = messageRefs.current?.[node.refIndex];
      if (refEl && refEl.isConnected) targetEl = refEl;
    }
    if (!targetEl && onEnsureVisible) {
      onEnsureVisible(node.messageIndex);
      return;
    }
    if (!targetEl && node.text) {
      const cards = scrollEl.querySelectorAll(".chat-message-card");
      const sample = node.text.slice(0, 20);
      for (const card of Array.from(cards)) {
        if (card.textContent?.includes(sample)) {
          const candidate = (card.closest("[data-message-index]") || card.parentElement || card) as HTMLDivElement;
          const candidateIdx = candidate.getAttribute("data-message-index");
          if (candidateIdx === null || candidateIdx === String(node.messageIndex)) {
            targetEl = candidate;
            break;
          }
        }
      }
    }

    const behavior: ScrollBehavior = smooth && !reducedMotion ? "smooth" : "auto";
    if (targetEl && targetEl.isConnected) {
      const containerRect = scrollEl.getBoundingClientRect();
      const elRect = targetEl.getBoundingClientRect();
      const targetScroll = Math.max(0, scrollEl.scrollTop + (elRect.top - containerRect.top) - 16);
      scrollEl.scrollTo({ top: targetScroll, behavior });
    } else if (onEnsureVisible) {
      onEnsureVisible(node.messageIndex);
    } else {
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (maxScroll > 0) {
        const targetScroll = Math.max(0, (node.messageIndex / Math.max(1, messages.length - 1)) * maxScroll);
        scrollEl.scrollTo({ top: targetScroll, behavior });
      }
    }
  }, [scrollContainer, messageRefs, messages.length, reducedMotion, onEnsureVisible]);

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

  return {
    nodes,
    activeIndex,
    setActiveIndex,
    scrollToNode,
  };
}
