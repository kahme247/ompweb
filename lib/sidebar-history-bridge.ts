/**
 * Injected by app/boot.ts before the app's modules evaluate, so it registers
 * before any other `popstate` listener (lib/navigation.ts included).
 *
 * The re-dispatch is synchronous and carries the original event as `detail`,
 * so the sidebar hook can call `stopImmediatePropagation()` on the native event
 * from inside this listener and preempt the router's traversal.
 */
export const SIDEBAR_HISTORY_BRIDGE_SCRIPT =
  `window.addEventListener("popstate",function(event){window.dispatchEvent(new CustomEvent("omp:sidebar-popstate",{detail:event}))});`;
