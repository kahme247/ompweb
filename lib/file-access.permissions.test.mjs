import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jitiPath, nodeBinary, repo } from "./hosts/update-fixture.test-helper.mjs";

// omp loads <config>/profiles/<name>/.env, but a profiles dir that is
// traversable yet unlistable (mode 0111) hides every profile from readdir.
// The denial must not depend on enumeration. Needs real Node + real EACCES, so
// the policy modules load under Node/jiti and, when root, the child drops to
// nobody AFTER importing them (the checkout is not traversable by nobody).
const CHILD = `
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const f = JSON.parse(process.env.FIXTURE);
const jiti = require(f.jiti).createJiti(path.join(f.repo, "lib", "file-access.permissions.test.mjs"), { tsconfigPaths: true });
(async () => {
  const access = await jiti.import(path.join(f.repo, "lib", "file-access.ts"));
  const authorization = await jiti.import(path.join(f.repo, "lib", "file-authorization.ts"));
  process.chdir(f.root);
  if (process.getuid() === 0) { process.setgroups([]); process.setgid(65534); process.setuid(65534); }
  // Fixture honesty: setup failures exit nonzero, distinct from policy answers.
  assert.notEqual(process.getuid(), 0, "SETUP: still root");
  if (f.unreadable) assert.throws(() => fs.readdirSync(f.profiles), { code: "EACCES" }, "SETUP: profiles must be unlistable");
  else fs.readdirSync(f.profiles);
  assert.equal(fs.readFileSync(f.profileEnv, "utf8"), "profile\\n", "SETUP: profile .env must stay readable");
  assert.equal(fs.realpathSync.native(f.profileLink), f.profileEnv, "SETUP: link must resolve to profile .env");
  assert.equal(fs.realpathSync.native(f.externalLink), f.externalEnv, "SETUP: off-tree profile alias must resolve");
  assert.equal(fs.readFileSync(f.independent[0], "utf8"), "independent\\n", "SETUP: independent .env must be readable");
  const roots = new Set([f.workspace, ...access.getConfigAgentRoots()]);
  const decide = async (file) => {
    try {
      const decision = await authorization.authorizeFileAccess(file.split("/").filter(Boolean), null, false, roots);
      return { secret: access.isOmpSecretFile(file), ok: decision.ok, status: decision.ok ? 200 : decision.status };
    } catch (error) {
      return { ok: false, status: error.status, code: error.code };
    }
  };
  const result = { direct: await decide(f.profileEnv), link: await decide(f.profileLink), external: await decide(f.externalLink), independent: [] };
  for (const file of f.independent) result.independent.push(await decide(file));
  console.log(JSON.stringify(result));
})().catch((error) => { console.error(error); process.exit(1); });
`;

test("unlistable profile metadata refuses unknown aliases until it becomes readable", { skip: process.platform === "win32" && "POSIX mode bits are not enforced on Windows" }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-profile-env-")));
  const home = path.join(root, "home");
  const config = path.join(home, ".omp");
  const profiles = path.join(config, "profiles");
  const workspace = path.join(root, "workspace");
  const profileEnv = path.join(profiles, "work", ".env");
  const profileLink = path.join(workspace, "linked-profile.env");
  const independent = [path.join(workspace, ".env"), path.join(workspace, "profiles", "work", ".env")];
  const external = path.join(workspace, "off-tree-profile");
  const externalEnv = path.join(external, ".env");
  const externalLink = path.join(workspace, "linked-off-tree.env");
  t.after(() => {
    // Restore traversal/listing so a non-root parent can remove the fixture.
    if (fs.existsSync(profiles)) fs.chmodSync(profiles, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of [root, home, config, path.join(config, "agent"), path.join(profiles, "work"), workspace, path.dirname(independent[1]), external]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
  }
  fs.writeFileSync(profileEnv, "profile\n", { mode: 0o644 });
  for (const file of independent) fs.writeFileSync(file, "independent\n", { mode: 0o644 });
  fs.symlinkSync(profileEnv, profileLink);
  fs.writeFileSync(externalEnv, "external profile\n", { mode: 0o644 });
  fs.symlinkSync(external, path.join(profiles, "linked"), "dir");
  fs.symlinkSync(externalEnv, externalLink);
  fs.chmodSync(profiles, 0o111);

  const decide = (unreadable) => {
    const child = spawnSync(nodeBinary(), ["-e", CHILD], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CONFIG_DIR: ".omp",
        PI_CODING_AGENT_DIR: path.join(config, "agent"),
        XDG_DATA_HOME: "",
        FIXTURE: JSON.stringify({ jiti: jitiPath, repo, root, profiles, profileEnv, profileLink, workspace, independent, externalEnv, externalLink, unreadable }),
      },
    });
    assert.equal(child.status, 0, `child exited ${child.status} signal ${child.signal}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    return JSON.parse(child.stdout.trim().split("\n").pop());
  };
  const unavailable = { ok: false, status: 503, code: "credential_policy_unavailable" };
  const blocked = decide(true);
  assert.deepEqual(blocked.direct, { secret: true, ok: false, status: 403 }, "direct profile .env");
  assert.deepEqual(blocked.link, { secret: true, ok: false, status: 403 }, "workspace symlink to profile .env");
  assert.deepEqual(blocked.external, unavailable, "unknown off-tree profile aliases cannot be declared safe");
  assert.deepEqual(blocked.independent, independent.map(() => unavailable), "unknown ownership is unavailable, not an invented file restriction");
  fs.chmodSync(profiles, 0o755);
  const readable = decide(false);
  assert.deepEqual(readable.external, { secret: true, ok: false, status: 403 }, "listed off-tree profile aliases remain private");
  assert.deepEqual(readable.independent, independent.map(() => ({ secret: false, ok: true, status: 200 })), "independent .env files work once metadata is readable");
  assert.equal(fs.readFileSync(profileEnv, "utf8"), "profile\n");
});

// omp's credential store may be a symlink into a directory this process cannot
// traverse. A hardlink to the same inode in an allowed workspace stays readable,
// but realpath of the configured agent.db throws EACCES, so the policy cannot
// learn the canonical credential target. That is "unknown", never "safe".
const VAULT_CHILD = `
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const f = JSON.parse(process.env.FIXTURE);
const jiti = require(f.jiti).createJiti(path.join(f.repo, "lib", "file-access.permissions.test.mjs"), { tsconfigPaths: true });
(async () => {
  const access = await jiti.import(path.join(f.repo, "lib", "file-access.ts"));
  const authorization = await jiti.import(path.join(f.repo, "lib", "file-authorization.ts"));
  process.chdir(f.root);
  if (process.getuid() === 0) { process.setgroups([]); process.setgid(65534); process.setuid(65534); }
  // Fixture honesty: setup failures exit nonzero, distinct from policy answers.
  assert.notEqual(process.getuid(), 0, "SETUP: still root");
  assert.deepEqual(fs.readdirSync(f.profiles), ["work"], "SETUP: profile metadata must be readable");
  assert.ok(fs.readdirSync(f.agentDir).includes("agent.db"), "SETUP: active agent dir must be readable");
  assert.equal(fs.readFileSync(f.alias, "utf8"), f.keys, "SETUP: workspace hardlink must stay readable");
  assert.equal(fs.statSync(f.alias).nlink, 2, "SETUP: alias must be a hardlink to the vault file");
  assert.equal(fs.readFileSync(f.independent, "utf8"), "independent\\n", "SETUP: independent file must be readable");
  if (f.locked) {
    assert.throws(() => fs.realpathSync.native(f.agentDb), { code: "EACCES" }, "SETUP: configured agent.db realpath must fail with EACCES");
    assert.throws(() => fs.statSync(f.agentDb), { code: "EACCES" }, "SETUP: configured agent.db must be unreachable by path");
  } else {
    assert.equal(fs.realpathSync.native(f.agentDb), f.vault, "SETUP: configured agent.db must resolve once restored");
  }
  const roots = new Set([f.workspace, ...access.getConfigAgentRoots()]);
  const decide = async (file) => {
    try {
      const decision = await authorization.authorizeFileAccess(file.split("/").filter(Boolean), null, false, roots);
      return { secret: access.isOmpSecretFile(file), ok: decision.ok, status: decision.ok ? 200 : decision.status };
    } catch (error) {
      return { ok: false, status: error.status, code: error.code };
    }
  };
  console.log(JSON.stringify({ alias: await decide(f.alias), independent: await decide(f.independent) }));
})().catch((error) => { console.error(error); process.exit(1); });
`;

test("an agent.db symlink into an untraversable directory fails closed instead of leaking a hardlink alias", { skip: process.platform === "win32" && "POSIX mode bits are not enforced on Windows" }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-locked-vault-")));
  const home = path.join(root, "home");
  const config = path.join(home, ".omp");
  const profiles = path.join(config, "profiles");
  const agentDir = path.join(config, "agent");
  const agentDb = path.join(agentDir, "agent.db");
  const workspace = path.join(root, "workspace");
  const lockedVault = path.join(root, "locked-vault");
  const vault = path.join(lockedVault, "vault.sqlite");
  const alias = path.join(workspace, "vault-alias.sqlite");
  const independent = path.join(workspace, "notes.txt");
  const keys = "fixture-key-aaaa\nfixture-key-bbbb\n";
  t.after(() => {
    // Restore traversal so a non-root parent can remove the fixture.
    if (fs.existsSync(lockedVault)) fs.chmodSync(lockedVault, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of [root, home, config, agentDir, path.join(profiles, "work"), workspace, lockedVault]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
  }
  fs.writeFileSync(vault, keys, { mode: 0o644 });
  fs.linkSync(vault, alias);
  fs.writeFileSync(independent, "independent\n", { mode: 0o644 });
  fs.symlinkSync(vault, agentDb);
  fs.chmodSync(lockedVault, 0o000);

  const decide = (locked) => {
    const child = spawnSync(nodeBinary(), ["-e", VAULT_CHILD], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PI_CONFIG_DIR: ".omp",
        PI_CODING_AGENT_DIR: agentDir,
        XDG_DATA_HOME: "",
        FIXTURE: JSON.stringify({ jiti: jitiPath, repo, root, profiles, agentDir, agentDb, workspace, vault, alias, independent, keys, locked }),
      },
    });
    assert.equal(child.status, 0, `child exited ${child.status} signal ${child.signal}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
    return JSON.parse(child.stdout.trim().split("\n").pop());
  };
  const unavailable = { ok: false, status: 503, code: "credential_policy_unavailable" };
  const blocked = decide(true);
  assert.deepEqual(blocked.alias, unavailable, "hardlink alias of a credential target that cannot be canonicalized");
  assert.deepEqual(blocked.independent, unavailable, "unknown ordinary request while credential metadata is opaque");
  fs.chmodSync(lockedVault, 0o755);
  const readable = decide(false);
  assert.deepEqual(readable.alias, { secret: true, ok: false, status: 403 }, "hardlink alias once the target is canonical");
  assert.deepEqual(readable.independent, { secret: false, ok: true, status: 200 }, "independent file once metadata is readable");
  assert.equal(fs.readFileSync(vault, "utf8"), keys);
});
