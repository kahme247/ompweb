import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

test("UNC directory authorization and Git diff preserve the share rather than the current-drive spelling", async (t) => {
  if (process.platform === "win32") { t.skip("This POSIX filesystem shim models UNC identity; a live UNC share is a separate platform check"); return; }
  const root = mkdtempSync(join(tmpdir(), "omp-unc-native-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  const git = (...args) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q"); git("config", "user.name", "UNC fixture"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "report.txt"), "before\n"); git("add", "report.txt"); git("commit", "-qm", "fixture");
  writeFileSync(join(root, "report.txt"), "share-owned bytes\n");
  const unc = `/${root}`;
  const fs = { ...await import("node:fs") }, paths = { ...await import("node:path") };
  // POSIX can open //tmp/... too; preserve the native UNC canonical identity at the OS boundary.
  const canonical = (path, ...args) => {
    const result = fs.realpathSync(path, ...args);
    return String(path).startsWith(unc) ? `/${result}` : result;
  };
  canonical.native = canonical;
  await mockBuiltin(t, "node:fs", { realpathSync: canonical });
  await mockBuiltin(t, "node:path", { resolve: (...args) => {
    const result = paths.resolve(...args);
    return args.some((arg) => arg.startsWith(unc)) ? `/${result}` : result;
  } });
  const { grantWorkspaceRoot, authorizeWorkspaceDirectory } = await import("./workspace-roots.ts");
  grantWorkspaceRoot(unc);
  assert.equal(await authorizeWorkspaceDirectory(unc), unc);
  const { createWorkspaceService } = await import("./workspace-ops.ts");
  const { StagedUploads } = await import("./uploads.ts");
  const service = createWorkspaceService(new StagedUploads(() => {}), () => {});
  t.after(() => service.stop());
  const diff = await service.ops.gitDiff(unc, `${unc}/report.txt`);
  assert.equal(diff.ok, true);
  assert.equal(diff.value.supported, true);
  assert.match(diff.value.patch, /\+share-owned bytes/);
});
