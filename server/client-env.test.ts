import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clientEnv } from "./client-env";

test("build identity follows HEAD and disappears only at an exact tag", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-web-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  writeFileSync(path.join(root, "package.json"), '{"version":"1.2.3"}');
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("add", "package.json");
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-03T20:00:00-05:00", GIT_COMMITTER_DATE: "2026-11-04T01:00:00Z" },
  });
  const first = git("rev-parse", "HEAD");
  let env = clientEnv(root, "worker");
  assert.equal(env.OMP_WEB_PUBLIC_APP_VERSION, "1.2.3");
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_HASH, first);
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_DATE, "2026-11-04");
  const archive = path.join(root, "source-archive");
  mkdirSync(archive);
  writeFileSync(path.join(archive, "package.json"), '{"version":"1.2.3"}');
  assert.equal(clientEnv(archive, "worker").OMP_WEB_PUBLIC_COMMIT_HASH, "");
  const redirectedConfig = path.join(root, "redirected-config");
  writeFileSync(redirectedConfig, `[core]\n\tworktree = ${JSON.stringify(archive)}\n`);
  const redirected = JSON.parse(execFileSync(process.execPath, ["-e", `
    import { clientEnv } from ${JSON.stringify(path.join(import.meta.dir, "client-env.ts"))};
    console.log(JSON.stringify(clientEnv(${JSON.stringify(archive)}, "worker")));
  `], {
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: path.join(root, ".git"), GIT_WORK_TREE: archive, GIT_CONFIG_GLOBAL: redirectedConfig },
  }));
  assert.equal(redirected.OMP_WEB_PUBLIC_APP_VERSION, "1.2.3");
  assert.equal(redirected.OMP_WEB_PUBLIC_COMMIT_HASH, "");
  assert.equal(redirected.OMP_WEB_PUBLIC_COMMIT_DATE, "");

  git("tag", "v1.2.3");
  env = clientEnv(root, "worker");
  assert.equal(env.OMP_WEB_PUBLIC_APP_VERSION, "1.2.3");
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_HASH, "");
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_DATE, "");

  git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "after release");
  env = clientEnv(root, "worker");
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_HASH, git("rev-parse", "HEAD"));
  assert.notEqual(env.OMP_WEB_PUBLIC_COMMIT_HASH, first);
  assert.match(env.OMP_WEB_PUBLIC_COMMIT_DATE, /^\d{4}-\d{2}-\d{2}$/);
});

test("source archives without Git metadata still build with their package version", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-web-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "package.json"), '{"version":"1.2.3"}');
  const env = clientEnv(root, "worker");
  assert.equal(env.OMP_WEB_PUBLIC_APP_VERSION, "1.2.3");
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_HASH, "");
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_DATE, "");
});

test("signature display cannot replace the commit hash or date", { skip: !Bun.which("ssh-keygen") }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-web-signed-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const key = path.join(root, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const signers = path.join(root, "allowed-signers");
  writeFileSync(signers, `test@example.invalid ${readFileSync(`${key}.pub`, "utf8")}`);
  writeFileSync(path.join(root, "package.json"), '{"version":"1.2.3"}');
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "gpg.format", "ssh");
  git("config", "user.signingkey", key);
  git("config", "gpg.ssh.allowedSignersFile", signers);
  git("config", "log.showSignature", "true");
  git("add", "package.json");
  execFileSync("git", ["-C", root, "commit", "-S", "-m", "signed"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-03T20:00:00-05:00", GIT_COMMITTER_DATE: "2026-11-04T01:00:00Z" },
  });
  const env = clientEnv(root, "worker");
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_HASH, git("rev-parse", "HEAD"));
  assert.equal(env.OMP_WEB_PUBLIC_COMMIT_DATE, "2026-11-04");
});

test("shared checkouts retain explicit safe.directory trust", { skip: process.getuid?.() !== 0 }, (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "omp-web-shared-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  writeFileSync(path.join(root, "package.json"), '{"version":"1.2.3"}');
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", "package.json");
  execFileSync("git", ["-C", root, "commit", "-m", "shared"], {
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-11-04T01:00:00Z", GIT_COMMITTER_DATE: "2026-11-04T01:00:00Z" },
  });
  const hash = git("rev-parse", "HEAD");
  const globalConfig = path.join(root, "global-config");
  writeFileSync(globalConfig, `[safe]\n\tdirectory =\n\tdirectory = ${root}\n`);
  const untrustedConfig = path.join(root, "untrusted-config");
  writeFileSync(untrustedConfig, "[safe]\n\tdirectory =\n");
  try {
    chownSync(root, 65534, 65534);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    t.skip("Changing fixture ownership is not permitted");
    return;
  }
  const inspect = (overrides: NodeJS.ProcessEnv) => JSON.parse(execFileSync(process.execPath, ["-e", `
    import { clientEnv } from ${JSON.stringify(path.join(import.meta.dir, "client-env.ts"))};
    console.log(JSON.stringify(clientEnv(${JSON.stringify(root)}, "worker")));
  `], { encoding: "utf8", env: { ...process.env, ...overrides } }));
  assert.equal(inspect({ GIT_CONFIG_GLOBAL: untrustedConfig }).OMP_WEB_PUBLIC_COMMIT_HASH, "", "foreign ownership must not be trusted automatically");
  assert.equal(inspect({
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "",
  }).OMP_WEB_PUBLIC_COMMIT_HASH, "", "an explicit trust reset must remain effective");
  assert.equal(inspect({
    GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: globalConfig, GIT_CONFIG_NOSYSTEM: "1",
  }).OMP_WEB_PUBLIC_COMMIT_HASH, "", "disabled system trust must stay disabled");
  for (const overrides of [
    { GIT_CONFIG_GLOBAL: globalConfig },
    { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: globalConfig },
    {
      GIT_CONFIG_GLOBAL: untrustedConfig,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: path.join(root, "missing"),
      GIT_CONFIG_KEY_1: "safe.directory", GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "safe.directory", GIT_CONFIG_VALUE_2: root,
    },
  ]) {
    const env = inspect(overrides);
    assert.equal(env.OMP_WEB_PUBLIC_COMMIT_HASH, hash);
    assert.equal(env.OMP_WEB_PUBLIC_COMMIT_DATE, "2026-11-04");
  }
});
