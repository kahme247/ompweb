import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { localHost, buildSessionSpawnArgs } = await import("./local-host.ts");

test("the owning host refuses legacy configuration before starting omp", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-launch-profile-"));
  const agentDir = join(root, "agent");
  const cwd = realpathSync(root);
  mkdirSync(agentDir);
  const marker = join(root, "spawned");
  const bin = join(root, process.platform === "win32" ? "omp.cmd" : "omp");
  if (process.platform === "win32") writeFileSync(bin, `@echo spawned > "${marker}"\r\n`);
  else writeFileSync(bin, `#!/bin/sh\necho spawned > '${marker}'\n`, { mode: 0o755 });
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldBin = process.env.OMP_WEB_OMP_BIN;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OMP_WEB_OMP_BIN = bin;
  t.after(() => {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldBin === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = oldBin;
    rmSync(root, { recursive: true, force: true });
  });
  for (const [launchConfig, code] of [
    [{ profile: "nova insight" }, "stored_invalid_profile"],
    [{ profile: "--evil" }, "stored_invalid_profile"],
    [{ profile: "" }, "stored_invalid_profile"],
    [{ extraArgs: ["--profile", "work"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["--profile=work"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["--cwd", "/elsewhere"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["--resume=/tmp/other"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["--mode", "rpc-ui"] }, "stored_reserved_launch_arg"],
    [{ extraArgs: ["rpc-ui"] }, "stored_reserved_launch_arg"],
  ]) {
    writeFileSync(join(agentDir, "projects.json"), JSON.stringify({ version: 1, projects: [{ path: cwd, addedAt: "2026-01-01", hidden: false, launchConfig }] }));
    await assert.rejects(localHost.spawnRpc({ cwd, recordedCwd: cwd, sessionFile: "", advisor: false }), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, code);
      assert.match(error.message, /workspace launch configuration/i);
      return true;
    });
    assert.equal(existsSync(marker), false);
  }
  assert.deepEqual(buildSessionSpawnArgs("", undefined, false, { profile: "work", extraArgs: ["--verbose"] }), ["--profile", "work", "--verbose"]);
});
