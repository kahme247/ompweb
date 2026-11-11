import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import { mock } from "bun:test";
import { parse } from "yaml";

// Fault injection: every renameSync passes `renameHook` first, and while `dead` (a crash) every write to the disk fails.
// Bun patches the live namespace in place, so the wrapper calls a copy of the real module; "fs" (web-settings) and
// "node:fs" are separate mock keys.
const realFs = { ...(await import("node:fs")) };
let renameHook = null;
let dead = false;
const alive = () => {
  if (dead) throw Object.assign(new Error("injected crash"), { code: "EIO" });
};
const mockedFs = () => ({
  ...realFs,
  renameSync(from, to) {
    alive();
    renameHook?.(String(from), String(to));
    return realFs.renameSync(from, to);
  },
  ...Object.fromEntries(
    ["rmSync", "rmdirSync", "mkdirSync", "writeFileSync", "chmodSync"].map((name) => [
      name,
      (...args) => {
        alive();
        return realFs[name](...args);
      },
    ]),
  ),
});
for (const name of ["fs", "node:fs"]) mock.module(name, mockedFs);

const { buildManifest } = await import("./cluster-config.ts");
const { createClusterConfig } = await import("./daemon-cluster-config.ts");
const { loadWebServerSettings, saveWebServerSettings } = await import("../web-settings.ts");

const MASTER = "https://master.test";
const MANIFEST = "/api/hosts/cluster-config/manifest";
const FILE = "/api/hosts/cluster-config/file/";
const EMPTY = { version: null, files: "none", plugins: "none", error: null, missingCommands: [] };
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
after(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

let base;
let roots;
let master;
let stateDir;
let own;
beforeEach(() => {
  dead = false;
  base = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-member-config-test-")));
  roots = { agent: join(base, "member", "agent"), home: join(base, "member", "home") };
  master = { agent: join(base, "master", "agent"), home: join(base, "master", "home") };
  for (const dir of [...Object.values(roots), ...Object.values(master)]) mkdirSync(dir, { recursive: true });
  stateDir = join(roots.agent, "omp-web");
  own = join(stateDir, "own-config");
  // web-settings resolves omp-web-settings.json in the agent directory.
  process.env.PI_CODING_AGENT_DIR = roots.agent;
  renameHook = null;
});
afterEach(() => {
  dead = false;
  renameHook = null;
  rmSync(base, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = (path) => lstatSync(path).mode & 0o777;
const read = (path) => readFileSync(path, "utf8");

function put(root, path, content = "x", fileMode = 0o644) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, fileMode);
  return file;
}

/** Every entry under both member roots (omp-web's own state excluded): type, mode, bytes or link target. */
function tree() {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === roots.agent && name === "omp-web") continue;
      const path = join(dir, name);
      const key = `${rel}/${name}`;
      const stat = lstatSync(path);
      const bits = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`;
      else if (stat.isDirectory()) {
        out[key] = `dir ${bits}`;
        walk(path, key);
      } else out[key] = `file ${bits} ${readFileSync(path).toString("base64")}`;
    }
  };
  walk(roots.agent, "agent");
  walk(roots.home, "home");
  return out;
}

function memberSetup() {
  put(roots.agent, "config.yml", "shellPath: /member/bash\nmodelRoles:\n  default: member-model\n", 0o640);
  put(roots.agent, "models.yml", "providers:\n  member: {}\n", 0o600);
  put(roots.agent, "mcp.json", '{"mcpServers":{}}\n');
  put(roots.agent, "AGENTS.md", "member rules\n", 0o640);
  put(roots.agent, "skills/mine/SKILL.md", "member skill\n");
  chmodSync(join(roots.agent, "skills"), 0o755);
  put(roots.agent, "sessions/s.jsonl", "{}\n");
  put(roots.home, ".agents/skills/home-skill/SKILL.md", "home skill\n");
  saveWebServerSettings({ agentEnv: { MEMBER_ONLY: "1" } });
}

function masterBuild({ rules = "master rules\n", agentEnv = { CLUSTER_KEY: "c" }, plugins = [] } = {}) {
  put(master.agent, "config.yml", "shellPath: /master/zsh\nmodelRoles:\n  default: master-model\n");
  put(master.agent, "models.yml", "providers: {}\n");
  put(master.agent, "mcp.json", JSON.stringify({ mcpServers: { tool: { command: "present-cmd" }, other: { command: "absent-cmd" }, web: { url: "https://x.test" } } }));
  put(master.agent, "AGENTS.md", rules);
  put(master.agent, "skills/shared/SKILL.md", "shared skill\n");
  put(master.agent, "skills/shared/scripts/deep/run.sh", "#!/bin/sh\necho hi\n", 0o755);
  put(master.home, ".agents/skills/remote/SKILL.md", "remote skill\n");
  return buildManifest(master, { agentEnv, plugins });
}

/** The master's two routes; `current` is the bundle served, `gate` holds the manifest answer back. */
function serve(build) {
  const srv = { current: build, calls: [], gate: null, onFile: null };
  srv.fetch = async (serverUrl, path) => {
    assert.equal(serverUrl, MASTER);
    srv.calls.push(path);
    if (path === MANIFEST) {
      if (srv.gate) await srv.gate;
      return Response.json(srv.current.manifest);
    }
    assert.ok(path.startsWith(FILE), path);
    const hash = path.slice(FILE.length);
    const special = srv.onFile?.(hash);
    if (special) return special;
    const bytes = srv.current.content(hash);
    return bytes ? new Response(bytes) : Response.json({ error: "Not found" }, { status: 404 });
  };
  return srv;
}

/** A stateful `omp plugin`: list prints the installed set; every other action is logged in `commands`. Every call waits for `gate`. */
function fakeOmp(plugins = [], { fail = new Set(), marketplace = new Set() } = {}) {
  const omp = { installed: new Map(plugins.map((plugin) => [plugin.id, { ...plugin }])), commands: [], gate: null };
  omp.run = async (args) => {
    await sleep(1);
    if (omp.gate) await omp.gate;
    assert.equal(args[0], "plugin");
    const [, action, spec] = args;
    if (action === "list") {
      const all = [...omp.installed.values()];
      return JSON.stringify({
        npm: all.filter((p) => p.kind === "npm").map((p) => ({ name: p.id, version: p.version, enabled: p.enabled })),
        marketplace: all.filter((p) => p.kind === "marketplace").map((p) => ({ id: p.id, entries: [{ scope: "user", version: p.version ?? undefined, enabled: p.enabled }] })),
      });
    }
    omp.commands.push(`${action} ${spec}`);
    if (fail.has(spec)) throw new Error(`Installing ${spec}\nerror: ${spec} could not be resolved`);
    if (action === "install") {
      if (marketplace.has(spec)) omp.installed.set(spec, { kind: "marketplace", id: spec, version: null, enabled: true });
      else {
        const at = spec.lastIndexOf("@");
        const id = at > 0 ? spec.slice(0, at) : spec;
        omp.installed.set(id, { kind: "npm", id, version: at > 0 ? spec.slice(at + 1) : "0.0.0", enabled: true });
      }
    } else if (action === "uninstall") omp.installed.delete(spec);
    else omp.installed.get(spec).enabled = action === "enable";
    return "";
  };
  return omp;
}

function member(srv, omp = fakeOmp(), available = new Set(["present-cmd"])) {
  const logs = [];
  const states = [];
  const config = createClusterConfig({
    roots: () => roots,
    stateDir: () => stateDir,
    fetch: srv.fetch,
    runOmp: (args, timeoutMs) => {
      assert.ok(timeoutMs > 0);
      return omp.run(args);
    },
    commandExists: async (command) => available.has(command),
    onState: (state) => states.push(state),
    log: (message) => logs.push(message),
  });
  return { config, logs, states, omp };
}

async function pluginsSettled(config) {
  for (let i = 0; i < 400 && config.state().plugins === "pending"; i++) await sleep(5);
  assert.notEqual(config.state().plugins, "pending");
}

const rejectsConfig = (promise, pattern) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.name, "HostOpError");
    assert.equal(error.status, 409);
    assert.equal(error.code, "cluster_config_failed");
    if (pattern) assert.match(error.message, pattern);
    return true;
  });

/** Fails the `n`-th move of a staged entry into the live tree. */
function failAtSwap(n) {
  const stage = join(stateDir, "cluster-config", "stage");
  let count = 0;
  renameHook = (from, to) => {
    if (from.startsWith(`${stage}/`) && !to.startsWith(`${stateDir}/`) && ++count === n) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
  };
}

/** The process dies at the `n`-th move of a staged entry into the live tree: from there on nothing reaches the disk. */
function crashAtSwap(n) {
  const stage = join(stateDir, "cluster-config", "stage");
  let count = 0;
  renameHook = (from, to) => {
    if (from.startsWith(`${stage}/`) && !to.startsWith(`${stateDir}/`) && ++count === n) {
      dead = true;
      alive();
    }
  };
}

/** A gate for `omp`, opened by the returned function. */
function hold(omp) {
  let release;
  omp.gate = new Promise((resolve) => (release = resolve));
  return release;
}

async function firstApply(options) {
  memberSetup();
  const build = masterBuild(options);
  const srv = serve(build);
  const m = member(srv);
  await m.config.ensure(build.manifest.version, MASTER);
  return { ...m, build, srv };
}

test("first apply writes the master's files privately, creates nested directories and backs up the member's own", async () => {
  memberSetup();
  const original = fakeOmp([{ kind: "npm", id: "own", version: "1.0.0", enabled: true }]);
  const build = masterBuild();
  const { config } = member(serve(build), original);
  await config.ensure(build.manifest.version, MASTER);

  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  assert.equal(mode(join(roots.agent, "AGENTS.md")), 0o600);
  assert.equal(mode(join(roots.agent, "skills/shared/scripts/deep/run.sh")), 0o700);
  assert.equal(mode(join(roots.agent, "skills/shared/scripts/deep")), 0o700);
  assert.equal(read(join(roots.home, ".agents/skills/remote/SKILL.md")), "remote skill\n");
  assert.equal(read(join(roots.agent, "sessions/s.jsonl")), "{}\n", "an entry that is not mirrored is left alone");

  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(mode(join(own, "agent/AGENTS.md")), 0o640);
  assert.equal(read(join(own, "home/.agents/skills/home-skill/SKILL.md")), "home skill\n");
  assert.deepEqual(JSON.parse(read(join(own, "agent-env.json"))), { MEMBER_ONLY: "1" });
  assert.deepEqual(JSON.parse(read(join(own, "plugins.json"))), [{ kind: "npm", id: "own", version: "1.0.0", enabled: true }]);

  const state = config.state();
  assert.equal(state.version, build.manifest.version);
  assert.equal(state.files, "current");
  assert.equal(state.error, null);
});

test("a member file inside a mirrored directory the master lacks leaves the live tree for the backup", async () => {
  await firstApply();
  assert.equal(existsSync(join(roots.agent, "skills/mine")), false);
  assert.equal(existsSync(join(roots.home, ".agents/skills/home-skill")), false);
  assert.equal(read(join(own, "agent/skills/mine/SKILL.md")), "member skill\n");
});

test("config.yml keeps the member's shellPath and takes the master's other keys", async () => {
  await firstApply();
  const settings = parse(read(join(roots.agent, "config.yml")));
  assert.equal(settings.shellPath, "/member/bash");
  assert.equal(settings.modelRoles.default, "master-model");
});

test("agentEnv in the member's omp-web-settings.json equals the manifest's", async () => {
  const { build } = await firstApply();
  assert.deepEqual(JSON.parse(read(join(roots.agent, "omp-web-settings.json"))).agentEnv, build.manifest.agentEnv);
  assert.deepEqual(loadWebServerSettings().agentEnv, build.manifest.agentEnv);
});

test("ensure with the applied version fetches nothing", async () => {
  const { config, build, srv } = await firstApply();
  const calls = srv.calls.length;
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(srv.calls.length, calls);
});

test("two concurrent ensure calls share one apply", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = serve(build);
  const { config } = member(srv);
  await Promise.all([config.ensure(build.manifest.version, MASTER), config.ensure(build.manifest.version, MASTER)]);
  assert.equal(srv.calls.filter((path) => path === MANIFEST).length, 1);
  assert.equal(config.state().files, "current");
});

test("a manifest path outside the mirrored entries rejects the version before anything is written", async () => {
  memberSetup();
  const build = masterBuild();
  const before = tree();
  for (const bad of [
    { root: "agent", path: "../x" },
    { root: "agent", path: "sessions/a" },
  ]) {
    const file = build.manifest.files[0];
    const srv = serve({ manifest: { ...build.manifest, files: [...build.manifest.files, { ...file, ...bad }] }, content: build.content });
    const { config } = member(srv);
    await rejectsConfig(config.ensure(build.manifest.version, MASTER));
    assert.deepEqual(srv.calls, [MANIFEST], "no file is downloaded");
    assert.deepEqual(tree(), before);
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(join(stateDir, "cluster-config", "objects")), false);
    assert.equal(config.state().files, "failed");
  }
});

test("a downloaded file whose hash does not match is rejected and never stored", async () => {
  memberSetup();
  const build = masterBuild();
  const agents = build.manifest.files.find((file) => file.path === "AGENTS.md");
  const srv = serve(build);
  srv.onFile = (hash) => (hash === agents.hash ? new Response("master rulez\n") : null);
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /AGENTS\.md/);
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(join(stateDir, "cluster-config", "objects", agents.hash)), false);
  assert.equal(existsSync(own), false);
});

test("a body longer than the manifest's size is refused", async () => {
  memberSetup();
  const build = masterBuild();
  const agents = build.manifest.files.find((file) => file.path === "AGENTS.md");
  const srv = serve(build);
  srv.onFile = (hash) => (hash === agents.hash ? new Response(`master rules\n${"y".repeat(100_000)}`) : null);
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /longer/);
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(join(stateDir, "cluster-config", "objects", agents.hash)), false);
});

test("a 404 for a file fetches the manifest again and applies the new version", async () => {
  memberSetup();
  const v1 = masterBuild();
  const v2 = masterBuild({ rules: "master rules v2\n" });
  const srv = serve(v1);
  srv.onFile = () => {
    srv.onFile = null;
    srv.current = v2;
    return Response.json({ error: "Not found" }, { status: 404 });
  };
  const { config } = member(srv);
  await config.ensure(v1.manifest.version, MASTER);
  assert.equal(srv.calls.filter((path) => path === MANIFEST).length, 2);
  assert.equal(config.state().version, v2.manifest.version);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules v2\n");
});

test("a failure at the third swap of a later version leaves the live tree as it was", async () => {
  const { config, build: v1, srv } = await firstApply();
  srv.current = masterBuild({ rules: "master rules v2\n", agentEnv: { CLUSTER_KEY: "v2" } });
  const before = tree();
  failAtSwap(3);
  await rejectsConfig(config.ensure(srv.current.manifest.version, MASTER), /injected/);
  renameHook = null;
  assert.deepEqual(tree(), before);
  assert.deepEqual(loadWebServerSettings().agentEnv, v1.manifest.agentEnv);
  const state = config.state();
  assert.equal(state.files, "failed");
  assert.match(state.error, /injected/);
  assert.equal(state.version, v1.manifest.version);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n", "the backup is untouched");
  const restarted = member(srv);
  assert.equal(restarted.config.state().version, v1.manifest.version, "state.json is back");
  await pluginsSettled(restarted.config);
});

test("a failure at the third swap of the first apply leaves the live tree as it was, without a backup", async () => {
  memberSetup();
  const build = masterBuild();
  const { config } = member(serve(build));
  const before = tree();
  failAtSwap(3);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /injected/);
  renameHook = null;
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(own), false);
  assert.equal(config.state().files, "failed");
  assert.equal(config.state().version, null);

  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n", "the retry backs up the member's own files");
  assert.equal(config.state().files, "current");
  assert.equal(config.state().error, null);
});

test("a failure writing state.json undoes the swaps and the agent environment", async () => {
  memberSetup();
  const build = masterBuild();
  const { config } = member(serve(build));
  const before = tree();
  renameHook = (from, to) => {
    if (to === join(stateDir, "cluster-config", "state.json")) throw Object.assign(new Error("injected state failure"), { code: "EIO" });
  };
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /injected/);
  renameHook = null;
  assert.deepEqual(tree(), before);
  assert.deepEqual(loadWebServerSettings().agentEnv, { MEMBER_ONLY: "1" });
  assert.equal(existsSync(own), false);
});

test("a second version keeps the first backup", async () => {
  const { config, srv } = await firstApply();
  srv.current = masterBuild({ rules: "master rules v2\n" });
  await config.ensure(srv.current.manifest.version, MASTER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules v2\n");
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/skills/mine/SKILL.md")), "member skill\n");
  assert.equal(parse(read(join(roots.agent, "config.yml"))).shellPath, "/member/bash");
  assert.equal(existsSync(join(stateDir, "cluster-config", "trash")), false);
});

test("symbolic links at managed paths move to the backup as links and nothing is written through them", async () => {
  memberSetup();
  const outside = join(base, "outside");
  put(outside, "target.md", "outside\n");
  put(outside, "skills/x/SKILL.md", "outside skill\n");
  rmSync(join(roots.agent, "AGENTS.md"));
  symlinkSync(join(outside, "target.md"), join(roots.agent, "AGENTS.md"));
  rmSync(join(roots.agent, "skills"), { recursive: true });
  symlinkSync(join(outside, "skills"), join(roots.agent, "skills"));
  put(roots.agent, "rules/own.md", "own rule\n");
  symlinkSync(join(outside, "target.md"), join(roots.agent, "rules/link.md"));
  const original = tree();

  const build = masterBuild();
  const { config } = member(serve(build));
  await config.ensure(build.manifest.version, MASTER);

  assert.equal(read(join(outside, "target.md")), "outside\n");
  assert.deepEqual(readdirSync(join(outside, "skills")), ["x"]);
  assert.equal(read(join(outside, "skills/x/SKILL.md")), "outside skill\n");
  assert.ok(lstatSync(join(roots.agent, "AGENTS.md")).isFile());
  assert.ok(lstatSync(join(roots.agent, "skills")).isDirectory());
  assert.equal(readlinkSync(join(own, "agent/AGENTS.md")), join(outside, "target.md"));
  assert.equal(readlinkSync(join(own, "agent/skills")), join(outside, "skills"));
  assert.equal(readlinkSync(join(own, "agent/rules/link.md")), join(outside, "target.md"));
  assert.equal(existsSync(join(roots.agent, "rules")), false);

  await config.restore();
  assert.deepEqual(tree(), original);
  assert.equal(read(join(outside, "target.md")), "outside\n");
});

test("plugins: install, then uninstall, then disable, after ensure resolved", async () => {
  memberSetup();
  const omp = fakeOmp(
    [
      { kind: "npm", id: "keep", version: "1.0.0", enabled: true },
      { kind: "npm", id: "old", version: "1.0.0", enabled: true },
    ],
    { marketplace: new Set(["market@mp"]) },
  );
  const build = masterBuild({
    plugins: [
      { kind: "npm", id: "keep", version: "1.0.0", enabled: false },
      { kind: "npm", id: "new", version: "2.0.0", enabled: true },
      { kind: "marketplace", id: "market@mp", version: null, enabled: true },
    ],
  });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  assert.deepEqual(omp.commands, [], "ensure does not wait for the plugins");
  assert.equal(config.state().plugins, "pending");
  await pluginsSettled(config);
  assert.deepEqual(omp.commands, ["install market@mp", "install new@2.0.0", "uninstall old", "disable keep"]);
  assert.equal(config.state().plugins, "current");
  assert.equal(config.state().error, null);
});

test("a failing plugin install reports plugins failed with omp's last line, files still current", async () => {
  memberSetup();
  const omp = fakeOmp([], { fail: new Set(["new@2.0.0"]) });
  const build = masterBuild({ plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }] });
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  const state = config.state();
  assert.equal(state.plugins, "failed");
  assert.equal(state.error, "error: new@2.0.0 could not be resolved");
  assert.equal(state.files, "current");
});

test("after a restart the applied version counts and its plugin job runs again", async () => {
  memberSetup();
  const build = masterBuild({ plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }] });
  const srv = serve(build);
  const before = member(srv);
  await before.config.ensure(build.manifest.version, MASTER);
  await before.config.stop();

  const omp = fakeOmp();
  const { config } = member(srv, omp);
  assert.equal(config.state().version, build.manifest.version);
  assert.equal(config.state().files, "current");
  await pluginsSettled(config);
  assert.deepEqual(omp.commands, ["install new@2.0.0"]);
  assert.equal(config.state().plugins, "current");
  const calls = srv.calls.length;
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(srv.calls.length, calls);
});

test("missingCommands lists the MCP command the member lacks", async () => {
  const { config } = await firstApply();
  await pluginsSettled(config);
  assert.deepEqual(config.state().missingCommands, ["absent-cmd"]);
});

test("restore puts the member's own configuration back byte for byte, modes included", async () => {
  memberSetup();
  put(roots.agent, "rules/strict.md", "strict\n", 0o400);
  chmodSync(join(roots.agent, "rules"), 0o750);
  const original = tree();
  const omp = fakeOmp([{ kind: "npm", id: "old", version: "1.0.0", enabled: true }]);
  const build = masterBuild({ plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }] });
  const { config, states } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);

  await config.restore();
  assert.deepEqual(tree(), original);
  assert.deepEqual(loadWebServerSettings().agentEnv, { MEMBER_ONLY: "1" });
  assert.deepEqual([...omp.installed.values()], [{ kind: "npm", id: "old", version: "1.0.0", enabled: true }]);
  assert.deepEqual(config.state(), EMPTY);
  assert.deepEqual(states.at(-1), EMPTY);
  assert.equal(existsSync(own), false);
  assert.equal(existsSync(join(stateDir, "cluster-config")), false);

  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n", "a later ensure makes a fresh backup");
  await pluginsSettled(config);
  await config.restore();
  await config.restore();
  assert.deepEqual(tree(), original);
  assert.deepEqual(config.state(), EMPTY);
});

test("restore without a backup does nothing", async () => {
  memberSetup();
  const before = tree();
  const { config, states } = member(serve(masterBuild()));
  await config.restore();
  assert.deepEqual(tree(), before);
  assert.deepEqual(states, []);
});

test("restore waits for an in-flight apply and its plugin job", async () => {
  memberSetup();
  const original = tree();
  const omp = fakeOmp([{ kind: "npm", id: "own", version: "1.0.0", enabled: true }]);
  const v1 = masterBuild();
  const srv = serve(v1);
  const { config } = member(srv, omp);
  await config.ensure(v1.manifest.version, MASTER);
  await pluginsSettled(config);

  srv.current = masterBuild({ rules: "master rules v2\n", plugins: [{ kind: "npm", id: "late", version: "3.0.0", enabled: true }] });
  let release;
  srv.gate = new Promise((resolve) => (release = resolve));
  const applying = config.ensure(srv.current.manifest.version, MASTER);
  let restored = false;
  const restoring = config.restore().then(() => (restored = true));
  await sleep(30);
  assert.equal(restored, false);
  release();
  await applying;
  await restoring;

  assert.deepEqual(tree(), original);
  assert.deepEqual(omp.commands, ["uninstall own", "install late@3.0.0", "install own@1.0.0", "uninstall late"]);
  assert.deepEqual([...omp.installed.keys()], ["own"]);
  assert.deepEqual(config.state(), EMPTY);
});

test("a member's config.yaml is backed up under its own name, its shellPath kept, and restored exactly", async () => {
  put(roots.agent, "config.yaml", "shellPath: /member/yaml-bash\ntheme: dark\n", 0o640);
  saveWebServerSettings({ agentEnv: {} });
  const original = tree();
  const build = masterBuild();
  const srv = serve(build);
  const { config } = member(srv);
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(existsSync(join(roots.agent, "config.yaml")), false);
  assert.equal(parse(read(join(roots.agent, "config.yml"))).shellPath, "/member/yaml-bash");
  assert.equal(read(join(own, "agent/config.yaml")), "shellPath: /member/yaml-bash\ntheme: dark\n");

  srv.current = masterBuild({ rules: "master rules v2\n" });
  await config.ensure(srv.current.manifest.version, MASTER);
  assert.equal(parse(read(join(roots.agent, "config.yml"))).shellPath, "/member/yaml-bash", "later versions merge from the backed-up config.yaml");

  await config.restore();
  assert.deepEqual(tree(), original);
});

test("an unparsable member config.yml keeps nothing of it and logs its path only", async () => {
  put(roots.agent, "config.yml", "shellPath: [unclosed\n");
  const build = masterBuild();
  const { config, logs } = member(serve(build));
  await config.ensure(build.manifest.version, MASTER);
  const settings = parse(read(join(roots.agent, "config.yml")));
  assert.equal(settings.shellPath, undefined);
  assert.equal(settings.modelRoles.default, "master-model");
  const lines = logs.filter((line) => line.includes("config.yml"));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(join(own, "agent", "config.yml")) || lines[0].includes(join(roots.agent, "config.yml")));
  assert.ok(!lines[0].includes("unclosed"));
});

test("a first apply whose rollback could not put files back is finished before the next apply", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  failAtSwap(3);
  const swap = renameHook;
  renameHook = (from, to) => {
    if (from.startsWith(`${own}/`) && !to.startsWith(`${stateDir}/`)) throw Object.assign(new Error("injected undo failure"), { code: "EIO" });
    swap(from, to);
  };
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /injected rename failure/);
  renameHook = null;
  assert.notDeepEqual(tree(), original, "the rollback left files in the backup");

  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/mcp.json")), '{"mcpServers":{}}\n');
  assert.equal(read(join(own, "agent/skills/mine/SKILL.md")), "member skill\n");
  assert.equal(parse(read(join(roots.agent, "config.yml"))).shellPath, "/member/bash");
  await pluginsSettled(config);
  await config.restore();
  assert.deepEqual(tree(), original);
});

test("a restore that failed half-way is finished before the next version is applied", async () => {
  memberSetup();
  const original = tree();
  const v1 = masterBuild();
  const srv = serve(v1);
  const { config } = member(srv);
  await config.ensure(v1.manifest.version, MASTER);
  await pluginsSettled(config);
  let count = 0;
  renameHook = (from) => {
    if (from.startsWith(`${own}/agent/`) && ++count === 3) throw Object.assign(new Error("injected restore failure"), { code: "EIO" });
  };
  await rejectsConfig(config.restore(), /injected restore failure/);
  renameHook = null;
  assert.equal(config.state().version, null);

  srv.current = masterBuild({ rules: "master rules v2\n" });
  await config.ensure(srv.current.manifest.version, MASTER);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules v2\n");
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/models.yml")), "providers:\n  member: {}\n");
  assert.equal(parse(read(join(roots.agent, "config.yml"))).shellPath, "/member/bash");
  await pluginsSettled(config);
  await config.restore();
  assert.deepEqual(tree(), original);
});

test("a crash in the middle of the first apply is put back after the restart, and the next apply backs up the original", async () => {
  memberSetup();
  const original = tree();
  const build = masterBuild();
  const srv = serve(build);
  crashAtSwap(3);
  await rejectsConfig(member(srv).config.ensure(build.manifest.version, MASTER), /injected crash/);
  dead = false;
  renameHook = null;
  assert.notDeepEqual(tree(), original, "the crash left a mixed tree");

  const { config } = member(srv);
  await config.ensure(build.manifest.version, MASTER);
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(read(join(own, "agent/models.yml")), "providers:\n  member: {}\n");
  assert.equal(parse(read(join(roots.agent, "config.yml"))).shellPath, "/member/bash");
  await pluginsSettled(config);
  await config.restore();
  assert.deepEqual(tree(), original);
});

test("a stop during the restore's plugins keeps the backup's plugin list, and the next start finishes it", async () => {
  memberSetup();
  const original = tree();
  const omp = fakeOmp([{ kind: "npm", id: "old", version: "1.0.0", enabled: true }]);
  const build = masterBuild({ plugins: [{ kind: "npm", id: "new", version: "2.0.0", enabled: true }] });
  const srv = serve(build);
  const { config } = member(srv, omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);
  omp.commands.length = 0;

  const release = hold(omp);
  const restoring = config.restore();
  await sleep(20);
  const stopping = config.stop();
  release();
  await rejectsConfig(restoring, /stopped/);
  await stopping;
  assert.deepEqual(omp.commands, []);
  assert.ok(existsSync(join(own, "plugins.json")));
  assert.equal(existsSync(join(stateDir, "cluster-config", "state.json")), false);
  assert.deepEqual(tree(), original);
  assert.deepEqual(config.state(), { ...EMPTY, plugins: "pending" });

  const restarted = member(srv, omp);
  assert.equal(restarted.config.state().version, null);
  await pluginsSettled(restarted.config);
  assert.deepEqual(omp.commands, ["install old@1.0.0", "uninstall new"]);
  assert.equal(existsSync(own), false);
  assert.deepEqual(restarted.config.state(), EMPTY);
  assert.deepEqual(tree(), original);
});

test("an ensure called while a restore is pending waits for it, then applies again", async () => {
  memberSetup();
  const omp = fakeOmp();
  const build = masterBuild();
  const { config } = member(serve(build), omp);
  await config.ensure(build.manifest.version, MASTER);
  await pluginsSettled(config);

  const release = hold(omp);
  let restored = false;
  let ensured = false;
  const restoring = config.restore().then(() => (restored = true));
  const ensuring = config.ensure(build.manifest.version, MASTER).then(() => (ensured = true));
  await sleep(20);
  assert.equal(ensured, false, "a pending restore: the applied version no longer counts");
  release();
  await Promise.all([restoring, ensuring]);
  assert.equal(restored, true);
  assert.equal(read(join(roots.agent, "AGENTS.md")), "master rules\n");
  assert.equal(read(join(own, "agent/AGENTS.md")), "member rules\n");
  assert.equal(config.state().files, "current");
  await pluginsSettled(config);
});

test("a linked directory above a mirrored entry refuses the apply before anything moves", async () => {
  memberSetup();
  const outside = join(base, "outside-agents");
  put(outside, "skills/linked/SKILL.md", "linked\n");
  rmSync(join(roots.home, ".agents"), { recursive: true });
  symlinkSync(outside, join(roots.home, ".agents"));
  const before = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /real directory/);
  assert.ok(config.state().error.includes(join(roots.home, ".agents")));
  assert.deepEqual(tree(), before);
  assert.deepEqual(readdirSync(join(outside, "skills")), ["linked"]);
  assert.equal(existsSync(own), false);
});

test("an entry on another filesystem than the state directory names both directories", async () => {
  memberSetup();
  const before = tree();
  const build = masterBuild();
  const { config } = member(serve(build));
  renameHook = (from) => {
    if (from === join(roots.home, ".agents/skills")) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  };
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /different filesystems; cluster configuration needs them on one filesystem/);
  renameHook = null;
  assert.ok(config.state().error.includes(`${join(roots.home, ".agents")} and ${join(own, "home", ".agents")}`));
  assert.deepEqual(tree(), before);
  assert.equal(existsSync(own), false);
});

test("a manifest longer than 5 MiB is refused before anything is downloaded", async () => {
  memberSetup();
  const build = masterBuild();
  const srv = serve({ manifest: { ...build.manifest, agentEnv: { BIG: "x".repeat(5_300_000) } }, content: build.content });
  const before = tree();
  const { config } = member(srv);
  await rejectsConfig(config.ensure(build.manifest.version, MASTER), /manifest is longer/);
  assert.deepEqual(srv.calls, [MANIFEST]);
  assert.deepEqual(tree(), before);
});
