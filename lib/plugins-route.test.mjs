import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Real /api/plugins POST against a throwaway cwd. Bug hunt round 1: a
// source starting with "-" was passed straight to `omp plugin …`, so it
// was parsed as CLI options instead of a plugin name (same class of bug the
// skills-install route already rejects).
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": new URL("../", import.meta.url).pathname },
});

const route = await jiti.import("../app/api/plugins/route.ts");
const fa = await jiti.import("./file-access.ts");

async function setup(t) {
  const base = mkdtempSync(join(tmpdir(), "omp-web-plugins-route-"));
  const agentDir = join(base, "agent");
  const cwd = join(base, "ws");
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousXdg = process.env.XDG_DATA_HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  globalThis.__piAllowedRootsCache = undefined;
  fa.allowFileRoot(cwd);
  globalThis.__piAllowedRootsCache = undefined;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdg;
    globalThis.__piAllowedRootsCache = undefined;
    rmSync(base, { recursive: true, force: true });
  });
  const post = (body) => route.POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { cwd, post };
}

test("rejects a plugin source starting with a dash for every source-taking action", async (t) => {
  const { cwd, post } = await setup(t);
  for (const action of ["install", "remove", "enable", "disable", "update"]) {
    const res = await post({ action, source: "--force", cwd });
    assert.equal(res.status, 400, `${action} with --force source must be 400`);
    const body = await res.json();
    assert.equal(body.code, "plugin_source_invalid");
  }
  // A bare "-" is equally an option position, not a name.
  const res = await post({ action: "install", source: "-", cwd });
  assert.equal(res.status, 400);
});
