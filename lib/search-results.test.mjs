import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./search-results.ts");
}

test("keeps the index ranking instead of sorting", async () => {
  const { buildSearchRows } = await loadSubject();
  // The order below is what /api/file-index returns for "agent": the exact-ish
  // name match first, path-only matches last. Re-sorting would bury AGENTS.md
  // under app/, which is what a directory tree does.
  const ranked = [
    "AGENTS.md",
    "components/AgentsConfig.tsx",
    "lib/omp/agents-service.ts",
    "app/api/agent/[id]/route.ts",
  ];

  assert.deepEqual(buildSearchRows(ranked).map((row) => row.path), ranked);
});

test("splits each match into a file name and its directory", async () => {
  const { buildSearchRows } = await loadSubject();
  const rows = buildSearchRows(["app/api/agent/[id]/bash-output/route.ts", "AGENTS.md"]);

  assert.deepEqual(rows[0], {
    path: "app/api/agent/[id]/bash-output/route.ts",
    name: "route.ts",
    directory: "app/api/agent/[id]/bash-output",
  });
  // A root-level file has no directory to show next to its name.
  assert.deepEqual(rows[1], { path: "AGENTS.md", name: "AGENTS.md", directory: "" });
});

test("drops empty and repeated paths", async () => {
  const { buildSearchRows } = await loadSubject();
  const rows = buildSearchRows(["lib/a.ts", "lib/a.ts", "", "lib/b.ts"]);

  assert.deepEqual(rows.map((row) => row.path), ["lib/a.ts", "lib/b.ts"]);
});
