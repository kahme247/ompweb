"use client";

import { useEffect } from "react";

const SWIPE_DISTANCE = 32;
const DIRECTION_SLOP = 12;

type Options = {
  enabled: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  onLeftOpenChange: (open: boolean) => void;
  onRightOpenChange: (open: boolean) => void;
};

/** Intentional horizontal swipes reuse drawer state without taking over native gestures. */
export function useMobileSidebarGestures({ enabled, leftOpen, rightOpen, onLeftOpenChange, onRightOpenChange }: Options) {
  useEffect(() => {
    if (!enabled) return;
    let gesture: { id: number; x: number; y: number; target: Element; claimed: boolean } | null = null;
    let overlayAtPointerDown = false;
    const cancel = () => { gesture = null; overlayAtPointerDown = false; };
    const hasBlockingOverlay = () => {
      const owner = rightOpen ? "workspace-file-panel" : leftOpen ? "workspace-sidebar" : null;
      const ownerElement = owner ? document.getElementById(owner) : null;
      for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open], [data-top-panel], [data-branch-panel]')) {
        // A toast is a non-modal role="dialog"; it must not freeze drawer swipes while shown.
        if (dialog.id === owner || dialog.closest('[inert], [hidden], [aria-hidden="true"], [data-swipe-dismiss]')) continue;
        if (dialog.getAttribute("role") === "listbox" && ownerElement?.contains(dialog)) continue;
        const style = getComputedStyle(dialog);
        if (style.display !== "none" && style.visibility !== "hidden") return true;
      }
      return false;
    };
    const pointerStart = (event: PointerEvent) => {
      if (event.pointerType === "touch") overlayAtPointerDown = hasBlockingOverlay();
    };
    const start = (event: TouchEvent) => {
      const blockedBeforeTouch = overlayAtPointerDown;
      cancel();
      if (event.touches.length !== 1 || !(event.target instanceof Element)) return;
      // [data-swipe-dismiss]: notifications own their sideways swipes.
      if (event.target.closest('input, textarea, select, .themed-select-trigger, [contenteditable]:not([contenteditable="false"]), .shell-topbar-overflow[open], [data-top-panel], [data-swipe-dismiss]')) return;
      if (window.getSelection()?.isCollapsed === false) return;
      // Pointerdown precedes touchstart; outside handlers may already have dismissed it.
      if (blockedBeforeTouch || hasBlockingOverlay()) return;
      const touch = event.touches[0];
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, target: event.target, claimed: false };
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== gesture.id || window.getSelection()?.isCollapsed === false) {
        cancel();
        return;
      }
      const dx = event.touches[0].clientX - gesture.x;
      const dy = Math.abs(event.touches[0].clientY - gesture.y);
      if (!gesture.claimed) {
        // Do not seize a near-diagonal wobble before there is enough travel to navigate.
        if (Math.abs(dx) < SWIPE_DISTANCE) return;
        // Like mature swipe recognizers, stay pending through thumb drift and
        // classify net displacement by its dominant axis, not a straight-line cone.
        if (Math.abs(dx) <= dy) return;
        if ((rightOpen && dx < 0) || (!rightOpen && leftOpen && dx > 0)) return;
        // Let code blocks, tab strips and other horizontal scrollers keep their pans.
        for (let element: Element | null = gesture.target; element; element = element.parentElement) {
          if (element.scrollWidth <= element.clientWidth + 1) continue;
          const overflow = getComputedStyle(element).overflowX;
          if (overflow === "auto" || overflow === "scroll") {
            cancel();
            return;
          }
        }
        if (hasBlockingOverlay()) {
          cancel();
          return;
        }
        gesture.claimed = true;
      }
      // Browser panning can make later moves non-cancelable; keep tracking the
      // overall gesture, but never try to prevent a default the browser owns.
      if (event.cancelable) event.preventDefault();
    };
    const end = (event: TouchEvent) => {
      const current = gesture;
      cancel();
      if (!current || window.getSelection()?.isCollapsed === false) return;
      const touch = event.changedTouches[0];
      if (event.touches.length || !touch || touch.identifier !== current.id) return;
      const dx = touch.clientX - current.x;
      const dy = Math.abs(touch.clientY - current.y);
      const allowedDirection = rightOpen ? dx > 0 : leftOpen ? dx < 0 : true;
      const horizontal = Math.abs(dx) > dy;
      // A partial drag should not turn into a compatibility click, but remains
      // unclaimed so ordinary vertical panning is still available.
      if (allowedDirection && (current.claimed || (horizontal && Math.abs(dx) >= DIRECTION_SLOP)) && event.cancelable) event.preventDefault();
      if (!current.claimed) return;
      if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= dy) return;
      // Use overall release direction, allowing a small initial correction.
      if (rightOpen) {
        if (dx > 0) onRightOpenChange(false);
      } else if (leftOpen) {
        if (dx < 0) onLeftOpenChange(false);
      } else if (dx > 0) onLeftOpenChange(true);
      else onRightOpenChange(true);
    };
    window.addEventListener("pointerdown", pointerStart, true);
    document.addEventListener("touchstart", start, { capture: true, passive: true });
    document.addEventListener("touchmove", move, { capture: true, passive: false });
    document.addEventListener("touchend", end, { capture: true, passive: false });
    document.addEventListener("touchcancel", cancel, true);
    return () => {
      window.removeEventListener("pointerdown", pointerStart, true);
      document.removeEventListener("touchstart", start, true);
      document.removeEventListener("touchmove", move, true);
      document.removeEventListener("touchend", end, true);
      document.removeEventListener("touchcancel", cancel, true);
    };
  }, [enabled, leftOpen, rightOpen, onLeftOpenChange, onRightOpenChange]);
}
