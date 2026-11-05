import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jitiPath, nodeBinary, repo } from "./hosts/update-fixture.test-helper.mjs";

// Run real Node: string realpaths and directory entries can lose POSIX byte names.
const CHILD = `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const f = JSON.parse(process.env.FIXTURE);
const agent = path.join(f.root, "agent");
const workspace = path.join(f.root, "workspace");
fs.mkdirSync(agent); fs.mkdirSync(workspace);
const byteName = Buffer.concat([Buffer.from(f.backup ? agent + "/agent.db.bak-" : workspace + "/vault-"), Buffer.from([0xff]), Buffer.from(".sqlite")]);
const target = f.dangling ? Buffer.concat([byteName, Buffer.from("/link")]) : byteName;
try {
  if (f.dangling) { fs.mkdirSync(byteName); fs.symlinkSync(path.join(workspace, "ordinary.sqlite"), target); }
  else fs.writeFileSync(target, "private fixture bytes\\n");
}
catch (error) {
  if (error.code === "EILSEQ" || error.code === "EINVAL") { console.log(JSON.stringify({ unsupported: error.code })); process.exit(0); }
  throw error;
}
const configured = path.join(agent, "agent.db");
const alias = path.join(workspace, "ordinary.sqlite");
if (!f.backup) fs.symlinkSync(target, configured);
if (!f.dangling) {
  fs.linkSync(target, alias);
  assert.equal(fs.statSync(f.backup ? target : configured).ino, fs.statSync(alias).ino);
  assert.equal(fs.readFileSync(f.backup ? target : configured, "utf8"), "private fixture bytes\\n");
}
const jiti = require(f.jiti).createJiti(path.join(f.repo, "package.json"), { tsconfigPaths: true });
(async () => {
  const { isOmpSecretFile } = await jiti.import(path.join(f.repo, "lib/file-access.ts"));
  const { authorizeFileAccess } = await jiti.import(path.join(f.repo, "lib/file-authorization.ts"));
  const measure = async file => {
    try {
      const decision = await authorizeFileAccess([file], null, false, new Set([workspace]));
      return { secret: isOmpSecretFile(file), ok: decision.ok, status: decision.ok ? 200 : decision.status };
    } catch (error) {
      if (typeof error.status !== "number" || typeof error.code !== "string") throw error;
      return { ok: false, status: error.status, code: error.code };
    }
  };
  if (!f.backup) { console.log(JSON.stringify(await measure(alias))); return; }
  const unrelated = Buffer.concat([Buffer.from(agent + "/asset-"), Buffer.from([0xff]), Buffer.from(".bin")]);
  const control = path.join(workspace, "asset-link.bin");
  fs.writeFileSync(unrelated, "independent bytes\\n"); fs.linkSync(unrelated, control);
  const before = await measure(alias);
  fs.renameSync(target, path.join(agent, "agent.db.bak-saved"));
  console.log(JSON.stringify({ before, after: await measure(alias), control: await measure(control) }));
})().catch(error => { console.error(error); process.exit(1); });
`;

function probe(t, backup = false, dangling = false) {
  const root = mkdtempSync(join(tmpdir(), "omp-native-credential-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(nodeBinary(), ["-e", CHILD], {
    cwd: repo, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: root, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: join(root, "agent"), XDG_DATA_HOME: "",
      FIXTURE: JSON.stringify({ root, jiti: jitiPath, repo, backup, dangling }) },
  });
  assert.equal(child.status, 0, `Node exited ${child.status}: ${child.stderr}\n${child.stdout}`);
  const result = JSON.parse(child.stdout.trim().split("\n").pop());
  if (result.unsupported) { t.skip(`Filesystem rejects non-UTF-8 filenames (${result.unsupported})`); return null; }
  return result;
}

test("a credential target's byte filename cannot hide its readable hardlink identity", { skip: process.platform !== "linux" }, (t) => {
  const result = probe(t);
  if (result) assert.deepEqual(result, { secret: true, ok: false, status: 403 });
});

test("undecodable owned copies fail closed without banning unrelated byte filenames", { skip: process.platform !== "linux" }, (t) => {
  const result = probe(t, true);
  if (!result) return;
  assert.deepEqual(result.before, { ok: false, status: 503, code: "credential_policy_unavailable" });
  assert.deepEqual(result.after, { secret: true, ok: false, status: 403 });
  assert.deepEqual(result.control, { secret: false, ok: true, status: 200 });
});

test("undecodable dangling symlink hops cannot hide a prospective credential target", { skip: process.platform !== "linux" }, (t) => {
  const result = probe(t, false, true);
  if (result) assert.deepEqual(result, { ok: false, status: 503, code: "credential_policy_unavailable" });
});

test("missing configured credential targets respect native filesystem case aliases", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-native-case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(nodeBinary(), ["-e", `
    const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
    const f = JSON.parse(process.env.FIXTURE);
    const agent = path.join(f.root, "agent"), workspace = path.join(f.root, "workspace");
    fs.mkdirSync(agent); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "CaseProbe"), "fixture");
    const insensitive = fs.existsSync(path.join(workspace, "caseprobe"));
    const target = path.join(workspace, "Vault.SQLITE");
    fs.symlinkSync(target, path.join(agent, "agent.db"));
    const jiti = require(f.jiti).createJiti(path.join(f.repo, "package.json"), { tsconfigPaths: true });
    (async () => {
      const { isOmpSecretFile } = await jiti.import(path.join(f.repo, "lib/file-access.ts"));
      if (process.platform === "linux") Object.defineProperty(process, "platform", { value: "darwin" });
      assert.equal(isOmpSecretFile(target), true);
      assert.equal(isOmpSecretFile(path.join(workspace, "vault.sqlite")), insensitive);
      assert.equal(isOmpSecretFile(path.join(workspace, "independent.sqlite")), false);
      assert.equal(fs.existsSync(target), false, "classification must not create the credential");
      const calibration = path.join(workspace, "calibration");
      fs.mkdirSync(calibration);
      for (const [owned, alias] of [["Straße", "STRASSE"], ["STRAẞE", "STRASSE"], ["ϴ", "θ"], ["Σ", "ς"], ["Café", "Cafe\\u0301"]]) {
        fs.writeFileSync(path.join(calibration, owned), "independent fixture");
        const nativeAlias = fs.existsSync(path.join(calibration, alias));
        fs.unlinkSync(path.join(agent, "agent.db"));
        const missing = path.join(workspace, owned);
        fs.symlinkSync(missing, path.join(agent, "agent.db"));
        const denied = isOmpSecretFile(path.join(workspace, alias));
        if (nativeAlias || owned === "Café") assert.equal(denied, true, owned);
        assert.equal(fs.existsSync(missing), false);
      }
      console.log(JSON.stringify({ insensitive }));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], {
    cwd: repo, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, HOME: root, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: join(root, "agent"), XDG_DATA_HOME: "",
      FIXTURE: JSON.stringify({ root, jiti: jitiPath, repo }) },
  });
  assert.equal(child.status, 0, `Node exited ${child.status}: ${child.stderr}\n${child.stdout}`);
});

for (const kind of ["resolution", "identity"]) {
  test(`a transient request ${kind} failure cannot authorize credential bytes on a later successful lookup`,
    { skip: kind === "resolution" && process.platform === "win32" }, (t) => {
      const root = mkdtempSync(join(tmpdir(), "omp-request-metadata-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const child = spawnSync(nodeBinary(), ["-e", `
        const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
        const { syncBuiltinESMExports } = require("node:module");
        const f = JSON.parse(process.env.FIXTURE);
        const agent = path.join(f.root, "agent"), workspace = path.join(f.root, "workspace");
        fs.mkdirSync(agent); fs.mkdirSync(workspace);
        const secret = path.join(agent, "agent.db"), alias = path.join(workspace, "ordinary.bin");
        fs.writeFileSync(secret, "private fixture bytes");
        if (f.kind === "resolution") fs.symlinkSync(secret, alias);
        else fs.linkSync(secret, alias);
        const jiti = require(f.jiti).createJiti(path.join(f.repo, "package.json"), { tsconfigPaths: true });
        (async () => {
          const { authorizeFileAccess } = await jiti.import(path.join(f.repo, "lib/file-authorization.ts"));
          const native = fs.realpathSync.native, stat = fs.statSync;
          let injected = false;
          const aliasKey = path.normalize(alias);
          const fault = (file) => {
            // The read gate also uses forward slashes on Windows.
            if (typeof file !== "string" || path.normalize(file) !== aliasKey || injected) return;
            injected = true;
            throw Object.assign(new Error("transient metadata failure"), { code: "EIO" });
          };
          if (f.kind === "resolution") fs.realpathSync.native = (file, ...args) => { fault(file); return native(file, ...args); };
          else fs.statSync = (file, ...args) => { fault(file); return stat(file, ...args); };
          syncBuiltinESMExports();
          let result;
          try {
            const decision = await authorizeFileAccess([alias], null, false, new Set([workspace, agent]));
            result = decision.ok ? { status: 200, bytes: fs.readFileSync(decision.filePath, "utf8") } : { status: decision.status, code: decision.code };
          } catch (error) {
            if (typeof error.status !== "number" || typeof error.code !== "string") throw error;
            result = { status: error.status, code: error.code };
          } finally {
            fs.realpathSync.native = native; fs.statSync = stat; syncBuiltinESMExports();
          }
          assert.equal(injected, true, "the request metadata failure must be exercised");
          const recovered = await authorizeFileAccess([alias], null, false, new Set([workspace, agent]));
          assert.equal(recovered.ok, false, "a later healthy lookup must still deny the credential");
          console.log(JSON.stringify({ failed: result, recovered: recovered.status }));
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `], {
        cwd: repo, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, HOME: root, PI_CONFIG_DIR: ".omp", PI_CODING_AGENT_DIR: join(root, "agent"), XDG_DATA_HOME: "",
          FIXTURE: JSON.stringify({ root, jiti: jitiPath, repo, kind }) },
      });
      assert.equal(child.status, 0, `Node exited ${child.status}: ${child.stderr}\n${child.stdout}`);
      assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").pop()), { failed: { status: 404, code: "file_not_found" }, recovered: 403 });
    });
}
