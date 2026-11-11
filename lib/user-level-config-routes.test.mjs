// Requests without a cwd act on the user level only (spec K7: a cluster member's settings act on this machine's own):
// omp runs in its agent directory, where no project lies, and project-scope entries are left out.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-user-level-")));
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

const saved = { bin: process.env.OMP_WEB_OMP_BIN, agentDir: process.env.PI_CODING_AGENT_DIR };
process.env.OMP_WEB_OMP_BIN = bin;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  for (const [key, value] of [["OMP_WEB_OMP_BIN", saved.bin], ["PI_CODING_AGENT_DIR", saved.agentDir]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const skills = await import("../app/api/skills/route.ts");
const skillsCheck = await import("../app/api/skills/check/route.ts");
const skillsUpdate = await import("../app/api/skills/update/route.ts");
const plugins = await import("../app/api/plugins/route.ts");

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
