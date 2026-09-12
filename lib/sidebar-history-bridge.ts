/**
 * Injected with `beforeInteractive` (see app/layout.tsx) so it runs before
 * hydration, and therefore before the App Router registers its own `popstate`
 * listener.
 *
 * The re-dispatch is synchronous and carries the original event as `detail`,
 * so the sidebar hook can call `stopImmediatePropagation()` on the native event
 * from inside this listener and preempt the router's traversal.
 */
export const SIDEBAR_HISTORY_BRIDGE_SCRIPT =
  `window.addEventListener("popstate",function(event){window.dispatchEvent(new CustomEvent("omp:sidebar-popstate",{detail:event}))});`;
