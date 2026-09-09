import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";



test("top bar renders 3-zone layout with center breadcrumb and segmented metric pills", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /className="shell-topbar-breadcrumb"/);
  assert.match(source, /className="shell-metric-pill/);
  assert.match(source, /position:\s*"absolute",\s*top:\s*"calc\(100% \+ 4px\)"/);
});

test("sidebar drag scales pointer deltas by the interface zoom", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  // clientX is viewport pixels while --sidebar-width is zoomed layout pixels;
  // without the correction the edge overshoots at 110/120% scale.
  assert.match(source, /--ui-scale/);
  assert.match(source, /\(ev\.clientX - startX\) \/ uiScale/);
});
