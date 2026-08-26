"use client";

import { useState, useCallback, useMemo, memo, useRef, useEffect } from "react";
import { GitBranch } from "lucide-react";
import { translate, useI18n } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { BranchPreview, SessionEntry, SessionTreeNode } from "@/lib/types";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
}

// Find the visible entry IDs on the path from root to activeLeafId.
function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  const target = targetId;
  function search(nodes: SessionTreeNode[], path: string[]): string[] | null {
    for (const node of nodes) {
      const next = [...path, node.entry.id];
      if (node.entry.id === target || node.compressedEntryIds?.includes(target)) {
        return next;
      }
      const found = search(node.children, next);
      if (found) return found;
    }
    return null;
  }
  return new Set(search(nodes, []) ?? []);
}

// Compress a visible linear chain into the first branching/leaf node.
// Server-side compressed IDs also count as skipped nodes.
function isMessageEntry(entry: SessionEntry): entry is SessionEntry & { message: { role: string; content: unknown } } {
  return entry.type === "message" && "message" in entry;
}

function messagePreview(entry: SessionEntry): BranchPreview | undefined {
  if (!isMessageEntry(entry)) return undefined;
  const content = entry.message.content;
  let text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((block): block is { type: "text"; text: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string").map((block) => block.text).join(" ")
      : "";
  text = text.replace(/\s+/g, " " ).trim();
  if (text.length > 40) text = `${text.slice(0, 40)}…`;
  if (!text) text = entry.message.role === "assistant" ? translate("branchNavigator.assistantLabel") : "message";
  const role = entry.message.role === "user" || entry.message.role === "assistant" ? entry.message.role : undefined;
  return { ...(role ? { role } : {}), text };
}

function compress(node: SessionTreeNode): { node: SessionTreeNode; skipped: number; branchPreview?: BranchPreview; labelEntry: SessionEntry } {
  let current = node;
  let branchPreview = current.branchPreview;
  let labelEntry: SessionEntry = current.entry;
  if (isMessageEntry(current.entry)) {
    branchPreview ??= messagePreview(current.entry);
    labelEntry = current.entry;
  }
  let skipped = current.compressedEntryIds?.length ?? 0;
  while (current.children.length === 1) {
    current = current.children[0];
    branchPreview ??= current.branchPreview ?? messagePreview(current.entry);
    if (!isMessageEntry(labelEntry) && isMessageEntry(current.entry)) labelEntry = current.entry;
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }
  return { node: current, skipped, branchPreview, labelEntry };
}

function getLabel(entry: SessionEntry): string {
  return messagePreview(entry)?.text ?? entry.type;
}

// Does the tree have any branching at all?
function hasBranch(nodes: SessionTreeNode[]): boolean {
  if (nodes.length > 1) return true;
  for (const node of nodes) {
    if (node.children.length > 1) return true;
    if (hasBranch(node.children)) return true;
  }
  return false;
}

interface TreeNodeProps {
  node: SessionTreeNode;
  activePathIds: Set<string>;
  depth: number;
  isLast: boolean;
  parentLines: boolean[]; // whether ancestor at each depth has more siblings after
  onSelect: (id: string) => void;
}

const TreeNodeView = memo(function TreeNodeView({ node, activePathIds, depth, isLast, parentLines, onSelect }: TreeNodeProps) {
  const { t } = useI18n();
  const { node: rep, skipped, branchPreview, labelEntry } = useMemo(() => compress(node), [node]);
  const repId = rep.entry.id;
  const nodeId = node.entry.id;
  const isActive = activePathIds.has(repId);
  const isOnPath = activePathIds.has(nodeId) || activePathIds.has(repId);
  const label = useMemo(() => branchPreview?.text ?? getLabel(labelEntry), [branchPreview, labelEntry]);
  const role = useMemo(() => branchPreview?.role ?? (labelEntry.type === "message" && "message" in labelEntry
    ? (labelEntry.message as { role: string }).role
    : null), [branchPreview, labelEntry]);

  return (
    <div>
      {/* This node row */}
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        style={{
          display: "flex",
          alignItems: "center",
          height: 24,
          cursor: "pointer",
        }}
        onClick={() => onSelect(rep.entry.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(rep.entry.id);
          }
        }}
      >
        {/* Indent guide lines */}
        {parentLines.map((hasLine, i) => (
          <div key={i} style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
            {hasLine && (
              <div style={{
                position: "absolute",
                left: 7,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--border)",
              }} />
            )}
          </div>
        ))}

        {/* Branch connector */}
        <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
          {/* vertical line up (to parent) */}
          <div style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: isLast ? "50%" : 0,
            width: 1,
            background: "var(--border)",
          }} />
          {/* horizontal line to node */}
          <div style={{
            position: "absolute",
            left: 7,
            top: "50%",
            width: 9,
            height: 1,
            background: "var(--border)",
          }} />
        </div>

        {/* Node dot */}
        <div style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flexShrink: 0,
          background: isActive ? "var(--accent)" : isOnPath ? "var(--text-muted)" : "var(--border)",
          border: isActive ? "none" : "1px solid var(--text-dim)",
          marginRight: 6,
          transition: "background var(--dur-fast) var(--ease-out-warm)",
        }} />

        {/* Role badge */}
        {role && (
          <span style={{
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            color: role === "user" ? "var(--accent)" : "var(--text-dim)",
            background: role === "user" ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "var(--bg-hover)",
            border: `1px solid ${role === "user" ? "color-mix(in srgb, var(--accent) 20%, transparent)" : "var(--border)"}`,
            borderRadius: 3,
            padding: "0 4px",
            marginRight: 5,
            flexShrink: 0,
            lineHeight: "16px",
          }}>
            {role === "user" ? t("branchNavigator.roleUser") : t("branchNavigator.roleAssistant")}
          </span>
        )}

        {/* Skipped indicator */}
        {skipped > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>
            +{skipped}
          </span>
        )}

        {/* Label */}
        <span style={{
          fontSize: 11,
          color: isActive ? "var(--text)" : isOnPath ? "var(--text-muted)" : "var(--text-dim)",
          fontWeight: isActive ? 500 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}>
          {label}
        </span>
      </div>

      {/* Children */}
      {rep.children.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activePathIds={activePathIds}
          depth={depth + 1}
          isLast={idx === rep.children.length - 1}
          parentLines={[...parentLines, !isLast]}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}, (prev, next) => {
  // Re-render only when this node, its compressed representative, or its
  // active-path membership changed. parentLines/depth/isLast are positional
  // and stable for a given node so they're intentionally ignored.
  if (prev.node !== next.node) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.activePathIds === next.activePathIds) return true;
  // node is unchanged here, so the compressed representative id is stable —
  // compute it once and check membership against both Set identities.
  const id = next.node.entry.id;
  const repId = compress(next.node).node.entry.id;
  if (prev.activePathIds.has(repId) !== next.activePathIds.has(repId)) return false;
  if (prev.activePathIds.has(id) !== next.activePathIds.has(id)) return false;
  return true;
});

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, containerRef, open: openProp, onToggle, hasSession }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!open || !inline) return;
    const anchor = containerRef?.current ?? btnRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      if (isMobile) {
        const height = Math.min(260, window.innerHeight - rect.bottom - 8);
        setDropdownPos({ top: rect.bottom, left: 8, width: window.innerWidth - 16, height: Math.max(60, height) });
        return;
      }
      const width = rect.width;
      const height = Math.min(260, window.innerHeight - rect.bottom - 8);
      setDropdownPos({ top: rect.bottom, left: Math.max(0, Math.min(rect.left, window.innerWidth - width)), width, height: Math.max(60, height) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, inline, containerRef, isMobile]);

  // Close the inline dropdown on outside click or Escape.
  useEffect(() => {
    if (!open || !inline) return;
    const closeDropdown = () => {
      if (onToggle) onToggle();
      else setOpenInternal(false);
    };
    const close = (event: MouseEvent) => {
      // Only the branch button itself (and the panel) keep the dropdown open;
      // other top-bar controls must close it rather than being swallowed.
      const anchor = btnRef.current;
      if (anchor && anchor.contains(event.target as Node)) return;
      if (event.target instanceof Element && event.target.closest("[data-branch-panel]")) return;
      closeDropdown();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Closing the branch menu must not also reach the window-level Esc
      // listener, which would abort a running agent.
      event.stopPropagation();
      closeDropdown();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, inline, containerRef, onToggle]);

  const activePathIds = useMemo(
    () => buildActivePath(tree, activeLeafId),
    [tree, activeLeafId]
  );

  const handleSelect = useCallback((id: string) => {
    onLeafChange(id);
    if (openProp === undefined) setOpenInternal(false);
  }, [onLeafChange, openProp]);

  const noBranchReason = useMemo(() => !hasSession
    ? t("branchNavigator.noActiveSession")
    : !hasBranch(tree)
      ? t("branchNavigator.noBranches")
      : null, [hasSession, tree, t]);

  // Find first meaningful node (skip pure linear prefix)
  const firstNode = useMemo(() => {
    const compressed = tree.length > 0 ? compress(tree[0]) : null;
    return compressed?.node ?? null;
  }, [tree]);
  const topLevelBranches = useMemo(() => {
    if (tree.length > 1) return tree;
    return firstNode && firstNode.children.length > 1 ? firstNode.children : [];
  }, [firstNode, tree]);
  const hasContent = !noBranchReason && topLevelBranches.length > 0;

  const branchIcon = (
    <GitBranch size={16} strokeWidth={1.8} aria-hidden="true" style={{ color: hasContent ? "var(--accent)" : undefined, flexShrink: 0 }} />
  );

  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform var(--dur-fast) var(--ease-out-warm)" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );


  if (inline) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center" }}>
        <button
          ref={btnRef}
          onClick={() => onToggle ? onToggle() : setOpenInternal((v) => !v)}
          className="shell-toolbar-btn ui-focus-ring"
          style={{
            background: open ? "var(--bg-selected)" : undefined,
            color: open ? "var(--text)" : undefined,
          }}
          title={t("branchNavigator.branches")}
          aria-label={t("branchNavigator.branches")}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          {branchIcon}
        </button>
        {open && dropdownPos && (
          <div data-branch-panel className="dropdown-surface" style={{
            position: "fixed",
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            maxHeight: dropdownPos.height,
            overflowY: "auto",
            zIndex: 600,
          }}>
            {hasContent ? (
              <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
                {topLevelBranches.map((child, idx) => (
                  <TreeNodeView
                    key={child.entry.id}
                    node={child}
                    activePathIds={activePathIds}
                    depth={0}
                    isLast={idx === topLevelBranches.length - 1}
                    parentLines={[]}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            ) : (
              <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                {noBranchReason}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}>
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        {branchIcon}
        <span style={{ color: "var(--text-muted)" }}>{t("branchNavigator.branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "var(--shadow-pop)",
          zIndex: 100,
        }}>
          {hasContent ? (
            <div style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
              {topLevelBranches.map((child, idx) => (
                <TreeNodeView
                  key={child.entry.id}
                  node={child}
                  activePathIds={activePathIds}
                  depth={0}
                  isLast={idx === topLevelBranches.length - 1}
                  parentLines={[]}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          ) : (
            <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              {noBranchReason ?? t("branchNavigator.noBranches")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
