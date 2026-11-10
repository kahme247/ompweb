import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { linkLocalDaemon } from "./hosts/link-driver.test-helper.mjs";

const root = mkdtempSync(join(tmpdir(), "omp-project-route-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const project = join(root, "workspace");
mkdirSync(project);
const cwd = realpathSync(project);
const registryFile = join(process.env.PI_CODING_AGENT_DIR, "projects.json");
const route = await import("../app/api/projects/route.ts");
const hub = await import("./hosts/hub.ts");
const { localHost } = await import("./hosts/local-host.ts");
const agentRoute = await import("../app/api/agent/new/route.ts");
const send = (method, body) => route[method](new Request("http://localhost/api/projects", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));
after(() => {
  hub.closeHostLink("local");
  hub.flushLinkSamples();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

test("project API rejects invalid writes and permits explicit correction and clear", async () => {
  await linkLocalDaemon({ spawn: ({ cwd, recordedCwd, sessionFile, advisor, toolNames, spawnModel }) =>
    localHost.spawnRpc({ cwd, recordedCwd, sessionFile, advisor, toolNames, spawnModel }) });
  const original = { version: 1, projects: [{ path: cwd, addedAt: "2026-01-01", hidden: false, launchConfig: { profile: "nova insight", extraArgs: ["--profile", "work"] } }] };
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(registryFile, JSON.stringify(original));
  const before = readFileSync(registryFile, "utf8");
  for (const method of ["POST", "PATCH"]) {
    for (const [launchConfig, code] of [
      [{ profile: "nova insight" }, "invalid_profile"],
      [{ extraArgs: ["--profile", "work"] }, "invalid_extra_args"],
      [{ extraArgs: ["--profile=work"] }, "invalid_extra_args"],
      [{ extraArgs: ["rpc-ui"] }, "invalid_extra_args"],
    ]) {
      const response = await send(method, { cwd, launchConfig });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, code);
      assert.equal(readFileSync(registryFile, "utf8"), before);
    }
  }
  const unrelated = await send("PATCH", { cwd, alias: "Renamed" });
  assert.equal(unrelated.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(registryFile, "utf8")).projects[0].launchConfig, original.projects[0].launchConfig);
  const listed = await (await route.GET()).json();
  assert.deepEqual(listed.projects.find((entry) => entry.path === cwd).launchConfig, original.projects[0].launchConfig);
  const started = await agentRoute.POST(new Request("http://localhost/api/agent/new", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd, type: "ensure_session" }),
  }));
  assert.equal(started.status, 400);
  const failure = await started.json();
  assert.equal(failure.code, "stored_invalid_profile");
  assert.match(failure.error, /workspace launch configuration/i);
  const correction = await send("PATCH", { cwd, launchConfig: { profile: "work", extraArgs: ["--verbose"] } });
  assert.equal(correction.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(registryFile, "utf8")).projects[0].launchConfig, { profile: "work", extraArgs: ["--verbose"] });
  const clear = await send("PATCH", { cwd, launchConfig: null });
  assert.equal(clear.status, 200);
  assert.equal(JSON.parse(readFileSync(registryFile, "utf8")).projects[0].launchConfig, undefined);
});
