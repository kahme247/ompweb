// Settings routes for a cluster member (spec K7). Requests without a cwd act on the user level only: omp runs in its
// agent directory, where no project lies, and project-scope entries are left out. MCP's live status of a member's
// session is read from its running process (`attach=1`), never from one started here.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

const scratch = realpathSync(mkdtempSync(join(os.tmpdir(), "omp-web-user-level-")));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir);
const log = join(scratch, "calls.log");
writeFileSync(join(scratch, "skills.json"), JSON.stringify({
  skills: [
    { name: "mine", description: "", filePath: join(agentDir, "skills", "mine", "SKILL.md"), source: "native:user", hide: false },
    { name: "theirs", description: "", filePath: join(scratch, "repo", ".omp", "skills", "theirs", "SKILL.md"), source: "native:project", hide: false },
  ],
  warnings: [],
}));
writeFileSync(join(scratch, "plugins.json"), JSON.stringify({
  npm: [{ name: "global-npm", version: "1.0.0", path: join(scratch, "missing"), enabled: true }],
  marketplace: [{ id: "here@market", scope: "project", entries: [{ scope: "project" }] }, { id: "mine@market", scope: "user", entries: [{ scope: "user" }] }],
}));
const bin = join(scratch, "omp");
writeFileSync(bin, `#!/bin/sh
echo "$(pwd) $*" >> '${log}'
case "$1 $2" in
  "skill list") cat '${join(scratch, "skills.json")}' ;;
  "plugin list") cat '${join(scratch, "plugins.json")}' ;;
  *) echo '{}' ;;
esac
`, { mode: 0o755 });

// Nothing of the real home is read: omp-web's own lookups (skill locks, MCP files) go under the scratch home. Bun's
// os.homedir() ignores a HOME set at run time, so it is replaced too.
const ENV_KEYS = ["OMP_WEB_OMP_BIN", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
const home = join(scratch, "home");
mkdirSync(home);
process.env.OMP_WEB_OMP_BIN = bin;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = process.env.USERPROFILE = home;
const scratchOs = { ...os, homedir: () => home };
mock.module("os", () => ({ ...scratchOs, default: scratchOs }));
mock.module("node:os", () => ({ ...scratchOs, default: scratchOs }));
// The live sessions: one running, one whose process ended. Seeded before rpc-manager makes its registry.
const MCP_LIST = "User level (mcp.json):\n  demo ● connected [stdio]\n";
let mcpLists = 0;
globalThis.__ompSessions = new Map([
  ["running-session", { isAlive: () => true, getMcpList: async () => { mcpLists++; return MCP_LIST; } }],
  ["ended-session", { isAlive: () => false, getMcpList: async () => { mcpLists++; return MCP_LIST; } }],
]);
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete globalThis.__ompSessions;
  rmSync(scratch, { recursive: true, force: true });
});

const skills = await import("../app/api/skills/route.ts");
const skillsCheck = await import("../app/api/skills/check/route.ts");
const skillsUpdate = await import("../app/api/skills/update/route.ts");
const plugins = await import("../app/api/plugins/route.ts");
const mcp = await import("../app/api/mcp/route.ts");

const calls = () => readFileSync(log, "utf8").trim().split("\n");
const post = (route, body) => route.POST(new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const skip = process.platform === "win32";

test("skills without a cwd: the user's only, listed by omp in its agent directory", { skip }, async () => {
  writeFileSync(log, "");
  const response = await skills.GET(new Request("http://localhost/api/skills"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).skills.map((skill) => skill.name), ["mine"]);
  assert.deepEqual(calls(), [`${agentDir} skill list --json`]);
});

test("a skill check or update without a cwd is for the user's own installs; a project one needs its cwd", { skip }, async () => {
  const checked = await post(skillsCheck, {});
  assert.equal(checked.status, 200);
  assert.deepEqual(await checked.json(), { updates: [] });
  assert.equal((await post(skillsCheck, { package: "o/r@x", scope: "project" })).status, 400);
  assert.equal((await post(skillsUpdate, { package: "o/r@x", scope: "global" })).status, 404, "past the cwd check: no such install");
  assert.equal((await post(skillsUpdate, { package: "o/r@x", scope: "project" })).status, 400);
});

test("plugins without a cwd: the user's only, and only global changes", { skip }, async () => {
  writeFileSync(log, "");
  const listed = await plugins.GET(new Request("http://localhost/api/plugins"));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).packages.map((pkg) => pkg.source), ["global-npm", "mine@market"]);

  const installed = await post(plugins, { action: "install", source: "npm:demo", scope: "global" });
  assert.equal(installed.status, 200);
  assert.deepEqual((await installed.json()).packages.map((pkg) => pkg.source), ["global-npm", "mine@market"]);
  assert.deepEqual(calls(), [`${agentDir} plugin list --json`, `${agentDir} plugin install npm:demo --json`, `${agentDir} plugin list --json`]);

  const project = await post(plugins, { action: "install", source: "npm:demo", scope: "project" });
  assert.equal(project.status, 400);
  assert.equal(calls().length, 3, "nothing ran");
});

test("a missing agent directory is created owner-only before omp runs there, not reported as a missing omp", { skip }, async (t) => {
  const fresh = join(scratch, "fresh", "agent");
  process.env.PI_CODING_AGENT_DIR = fresh;
  t.after(() => { process.env.PI_CODING_AGENT_DIR = agentDir; });
  writeFileSync(log, "");
  const listed = await plugins.GET(new Request("http://localhost/api/plugins"));
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual([body.packages.map((pkg) => pkg.source), body.diagnostics], [["global-npm", "mine@market"], []]);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
  assert.deepEqual(calls(), [`${fresh} plugin list --json`]);

  rmSync(join(scratch, "fresh"), { recursive: true });
  const installed = await post(plugins, { action: "install", source: "npm:demo", scope: "global" });
  assert.equal(installed.status, 200);
  rmSync(join(scratch, "fresh"), { recursive: true });
  const skillList = await skills.GET(new Request("http://localhost/api/skills"));
  assert.equal(skillList.status, 200);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
  assert.equal(calls().at(-1), `${fresh} skill list --json`);
});

const liveMcp = async (sessionId) => (await mcp.GET(new Request(`http://localhost/api/mcp?${new URLSearchParams({ sessionId, attach: "1", live: "1" })}`))).json();

test("MCP with attach=1 reads the live status of a running session", async () => {
  const before = mcpLists;
  const body = await liveMcp("running-session");
  assert.equal(mcpLists, before + 1);
  assert.equal(body.liveError, undefined);
  assert.deepEqual(body.liveServers.map(({ name, status }) => [name, status]), [["demo", "connected"]]);
});

for (const [label, sessionId] of [["whose process ended", "ended-session"], ["unknown here", "unknown-session"]]) {
  test(`MCP with attach=1 for a session ${label} only reports it, without starting one`, async () => {
    const before = mcpLists;
    const body = await liveMcp(sessionId);
    assert.equal(mcpLists, before);
    assert.deepEqual([body.liveServers, body.liveError], [undefined, "The session is not running"]);
    assert.equal(globalThis.__ompSessions.has(sessionId), sessionId === "ended-session", "nothing registered");
  });
}
