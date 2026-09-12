"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *   Ctrl/Cmd+A   – select the active message, transcript, or file contents
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component.
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, activeCwd } = options;

  useEffect(() => {
    let interactionTarget: Element | null = null;
    const scopeFor = (node: Node | null): HTMLElement | null =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-selection-scope]") ?? null;
    const trackInteraction = (event: Event) => {
      interactionTarget = event.target instanceof Element ? event.target : null;
    };
    const selectAll = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key.toLowerCase() !== "a"
        || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;

      const target = event.target;
      if (target instanceof Element && (
        target.closest("input, textarea, select, iframe")
        || (target instanceof HTMLElement && target.isContentEditable)
      )) return;

      const activeScope = scopeFor(interactionTarget ?? document.activeElement);
      // Moving outside a content region must not revive an old text selection.
      if (interactionTarget && !activeScope) return;
      const selection = window.getSelection();
      if (!selection) return;
      let scope = activeScope;
      if (selection.rangeCount && !selection.isCollapsed) {
        const selectedScope = scopeFor(selection.getRangeAt(0).commonAncestorContainer);
        // A range spanning messages belongs to their enclosing transcript.
        // A stale range in another pane must not override the latest interaction.
        if (selectedScope && (!activeScope || selectedScope.contains(activeScope) || activeScope.contains(selectedScope))) {
          scope = selectedScope;
        }
      }
      if (!scope?.isConnected || !scope.checkVisibility({ checkVisibilityCSS: true })
        || scope.closest("[inert], [aria-hidden='true']")) return;

      const range = document.createRange();
      range.selectNodeContents(scope);
      event.preventDefault();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    document.addEventListener("pointerdown", trackInteraction, true);
    document.addEventListener("focusin", trackInteraction, true);
    window.addEventListener("keydown", selectAll);
    return () => {
      document.removeEventListener("pointerdown", trackInteraction, true);
      document.removeEventListener("focusin", trackInteraction, true);
      window.removeEventListener("keydown", selectAll);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        if (!globalAbortHandler) return;

        const tag = (e.target as HTMLElement)?.tagName;
        // Let textarea/input handle Esc internally (ChatInput menus / stop).
        if (tag === "TEXTAREA" || tag === "INPUT") return;

        e.preventDefault();
        globalAbortHandler();
        return;
      }

      // ---- Ctrl+Alt+N: new session ----
      if (e.key === "n" && e.ctrlKey && e.altKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession]);
}
