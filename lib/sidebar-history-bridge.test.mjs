import test from "node:test";
import assert from "node:assert/strict";

async function loadScript() {
  const { SIDEBAR_HISTORY_BRIDGE_SCRIPT } = await import("./sidebar-history-bridge.ts");
  return SIDEBAR_HISTORY_BRIDGE_SCRIPT;
}

/** Evaluate the exact script the server injects, against a stand-in window. */
function installBridge(script) {
  const target = new EventTarget();
  new Function("window", "CustomEvent", script)(target, CustomEvent);
  return target;
}

// The script is injected with `beforeInteractive`, so its listener must be the
// first to see a popstate. That ordering is what lets the sidebar hook call
// stopImmediatePropagation() on the native event from inside the bridge and
// preempt the App Router's own traversal.
test("sidebar history bridge forwards the native popstate event", async () => {
  const window = installBridge(await loadScript());
  const seen = [];
  window.addEventListener("omp:sidebar-popstate", (event) => seen.push(event.detail));

  const native = new Event("popstate");
  window.dispatchEvent(native);

  assert.equal(seen.length, 1);
  assert.equal(seen[0], native);
});

test("sidebar history bridge runs before later popstate listeners", async () => {
  const window = installBridge(await loadScript());
  let routerSawPopState = false;
  window.addEventListener("popstate", () => { routerSawPopState = true; });
  // What useSidebarHistory does for the entries it owns.
  window.addEventListener("omp:sidebar-popstate", (event) => event.detail.stopImmediatePropagation());

  window.dispatchEvent(new Event("popstate"));

  assert.equal(routerSawPopState, false);
});
