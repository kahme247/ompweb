// The explorer's "Show hidden items" toggle: GET /api/files/…?type=list hides
// the IGNORED_NAMES/IGNORED_SUFFIXES skip-list, and ?hidden=1 lists it too.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** getAllowedFileRoots() caches on globalThis for 5s; tests must not inherit it. */
function clearAllowedRootsCache() {
  globalThis.__piAllowedRootsCache = undefined;
}

test("type=list skips the ignore-list, and hidden=1 lists it too", async (t) => {
  const { allowFileRoot } = await import("./file-access.ts");
  const { GET } = await import("../app/api/files/[...path]/route.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolated = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-list-hidden-")));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
    clearAllowedRootsCache();
  });
  process.env.PI_CODING_AGENT_DIR = path.join(isolated, "agent");

  fs.mkdirSync(path.join(isolated, "src"));
  fs.mkdirSync(path.join(isolated, "build"));
  fs.mkdirSync(path.join(isolated, ".git"));
  fs.writeFileSync(path.join(isolated, "README.md"), "hi\n");
  fs.writeFileSync(path.join(isolated, "module.pyc"), "bytecode\n");
  allowFileRoot(isolated);
  clearAllowedRootsCache();

  const list = (hidden) => GET(
    new Request(`http://localhost/api/files/${encodeURIComponent(isolated)}?type=list${hidden ? "&hidden=1" : ""}`),
    { params: Promise.resolve({ path: [isolated] }), disableIdleTimeout() {} },
  );
  const entries = async (hidden) => {
    const res = await list(hidden);
    assert.equal(res.status, 200);
    return (await res.json()).entries;
  };

  // Default: the skip-list stays hidden, everything else is listed.
  const shown = await entries(false);
  const shownNames = shown.map((entry) => entry.name);
  assert.ok(shownNames.includes("src") && shownNames.includes("README.md"), "normal entries are listed");
  assert.ok(!shownNames.includes("build"), "build/ stays hidden");
  assert.ok(!shownNames.includes(".git"), ".git stays hidden");
  assert.ok(!shownNames.includes("module.pyc"), ".pyc files stay hidden");

  // hidden=1: every entry is listed, with directories still flagged.
  const all = await entries(true);
  const byName = new Map(all.map((entry) => [entry.name, entry]));
  for (const name of ["src", "README.md", "build", ".git", "module.pyc"]) {
    assert.ok(byName.has(name), `${name} is listed`);
  }
  assert.equal(byName.get("build").isDir, true);
  assert.equal(byName.get("module.pyc").isDir, false);
});
