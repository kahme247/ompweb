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
  /** Best-effort native-menu selection scoping; keyboard scoping is independent. */
  scopeNativeSelectAll?: boolean;
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
  const { onNewSession, activeCwd, scopeNativeSelectAll = false } = options;

  useEffect(() => {
    let interactionTarget: Element | null = null;
    let nativeScope: HTMLElement | null = null;
    let pointerDown = false;
    let composing = false;
    const scopeFor = (node: Node | null): HTMLElement | null =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-selection-scope]") ?? null;
    const trackInteraction = (event: Event) => {
      interactionTarget = event.target instanceof Element ? event.target : null;
      if (scopeNativeSelectAll) {
        if (event instanceof PointerEvent) pointerDown = event.type === "pointerdown" && event.button === 0;
        nativeScope = scopeFor(interactionTarget);
        if (event.type === "contextmenu") rememberSelectionScope();
      }
    };
    const selectContents = (scope: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(scope);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    const textSelectable = (element: HTMLElement) => {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) return false;
      for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.userSelect === "none") return false;
        // Closed sidebars stay mounted at zero width; checkVisibility alone
        // does not account for their clipping.
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          const rect = parent.getBoundingClientRect();
          if ((style.overflowX !== "visible" && rect.width === 0)
            || (style.overflowY !== "visible" && rect.height === 0)) return false;
        }
      }
      return true;
    };
    const scopeAvailable = (scope: HTMLElement | null): scope is HTMLElement =>
      !!scope?.isConnected && textSelectable(scope)
      && !scope.closest("[inert], [aria-hidden='true']");
    const editorFocused = () => {
      const element = document.activeElement;
      return !!element?.matches("input, textarea, select, iframe")
        || (element instanceof HTMLElement && element.isContentEditable);
    };
    const rememberSelectionScope = () => {
      const activeScope = scopeFor(interactionTarget ?? document.activeElement);
      const selection = window.getSelection();
      const selectedScope = selection?.rangeCount === 1
        ? scopeFor(selection.getRangeAt(0).commonAncestorContainer) : null;
      nativeScope = activeScope && selectedScope?.contains(activeScope) ? selectedScope : activeScope;
    };
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount !== 1) {
        rememberSelectionScope();
        return;
      }
      // Native selections crossing shadow roots can appear collapsed through
      // getRangeAt(), even while the entire page is visibly selected.
      let range = selection.getRangeAt(0);
      const composed = selection.getComposedRanges?.()[0];
      if (composed) {
        range = document.createRange();
        range.setStart(composed.startContainer, composed.startOffset);
        range.setEnd(composed.endContainer, composed.endOffset);
      }
      if (range.collapsed || scopeFor(range.commonAncestorContainer)) {
        rememberSelectionScope();
        return;
      }
      if (pointerDown || composing || editorFocused() || !scopeAvailable(nativeScope)) return;
      // Only correct a range covering both ends of the page's selectable text.
      // Ordinary partial/cross-pane selections never reach the replacement below.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const element = node.parentElement;
          if (!node.textContent?.trim() || !element || element.closest("script, style, noscript, input, textarea")
            || !textSelectable(element)) return NodeFilter.FILTER_REJECT;
          const textRange = document.createRange();
          textRange.selectNodeContents(node);
          return textRange.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      const first = walker.nextNode();
      walker.currentNode = document.body;
      const last = walker.lastChild();
      if (first && last && range.comparePoint(first, 0) === 0
        && range.comparePoint(last, last.textContent?.length ?? 0) === 0) {
        // No native Select All intent event exists: a deliberate whole-page
        // selection is indistinguishable. This is why the fallback is opt-in.
        selectContents(nativeScope);
      }
    };
    const onPointerEnd = () => { pointerDown = false; };
    const onCompositionStart = () => { composing = true; };
    const onCompositionEnd = () => { composing = false; };
    const selectAll = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.key.toLowerCase() !== "a"
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
        // A retained child selection must not override newer enclosing-pane focus.
        if (selectedScope && (!activeScope || selectedScope.contains(activeScope))) {
          scope = selectedScope;
        }
      }
      if (!scopeAvailable(scope)) return;
      event.preventDefault();
      selectContents(scope);
    };
    document.addEventListener("pointerdown", trackInteraction, true);
    document.addEventListener("focusin", trackInteraction, true);
    window.addEventListener("keydown", selectAll);
    if (scopeNativeSelectAll) {
      document.addEventListener("contextmenu", trackInteraction, true);
      document.addEventListener("pointerup", onPointerEnd, true);
      document.addEventListener("pointercancel", onPointerEnd, true);
      document.addEventListener("compositionstart", onCompositionStart, true);
      document.addEventListener("compositionend", onCompositionEnd, true);
      document.addEventListener("selectionchange", onSelectionChange);
    }
    return () => {
      document.removeEventListener("pointerdown", trackInteraction, true);
      document.removeEventListener("focusin", trackInteraction, true);
      window.removeEventListener("keydown", selectAll);
      if (scopeNativeSelectAll) {
        document.removeEventListener("contextmenu", trackInteraction, true);
        document.removeEventListener("pointerup", onPointerEnd, true);
        document.removeEventListener("pointercancel", onPointerEnd, true);
        document.removeEventListener("compositionstart", onCompositionStart, true);
        document.removeEventListener("compositionend", onCompositionEnd, true);
        document.removeEventListener("selectionchange", onSelectionChange);
      }
    };
  }, [scopeNativeSelectAll]);

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
