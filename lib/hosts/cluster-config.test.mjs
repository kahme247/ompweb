import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { parse } from "yaml";

const {
  CONFIG_LIMITS,
  ClusterConfigError,
  LOCAL_SETTINGS,
  MIRRORED,
  buildManifest,
  isManagedPath,
  mergeLocalSettings,
  stripLocalSettings,
} = await import("./cluster-config.ts");

let base;
let roots;
const extra = () => ({ agentEnv: { B: "2", A: "1" }, plugins: [{ kind: "npm", id: "p", version: "1.0.0", enabled: true }] });

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "omp-web-cluster-config-test-"));
  roots = { agent: join(base, "agent"), home: join(base, "home") };
  mkdirSync(roots.agent, { recursive: true });
  mkdirSync(roots.home, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function put(root, path, content = "x") {
  const file = join(roots[root], path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
const paths = (manifest) => manifest.files.map((f) => `${f.root}:${f.path}`);
function err(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ClusterConfigError, String(e));
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`expected ${code}`);
}

test("every mirrored entry is listed, sorted, with nested paths", () => {
  for (const e of MIRRORED) {
    if (e.kind === "file") put(e.root, e.path, e.path === "config.yml" ? "modelRoles: {}\n" : "x");
    else put(e.root, `${e.path}/x/SKILL.md`);
  }
  const { manifest } = buildManifest(roots, extra());
  const expected = MIRRORED.map((e) => (e.kind === "file" ? `${e.root}:${e.path}` : `${e.root}:${e.path}/x/SKILL.md`)).sort();
  assert.deepEqual(paths(manifest), expected);
  assert.ok(manifest.files.some((f) => f.path === "skills/x/SKILL.md"));
  assert.ok(manifest.files.some((f) => f.root === "home" && f.path === ".agents/skills/x/SKILL.md"));
  assert.deepEqual(Object.keys(manifest.agentEnv), ["A", "B"]);
});

test("missing entries are skipped", () => {
  assert.deepEqual(buildManifest(roots, extra()).manifest.files, []);
});

test("symbolic links to files and directories are followed; a cycle is skipped", () => {
  const elsewhere = join(base, "elsewhere");
  mkdirSync(join(elsewhere, "x"), { recursive: true });
  writeFileSync(join(elsewhere, "x", "SKILL.md"), "skill");
  writeFileSync(join(base, "real-mcp.json"), "{}");
  symlinkSync(elsewhere, join(roots.agent, "skills"));
  symlinkSync(join(base, "real-mcp.json"), join(roots.agent, "mcp.json"));
  symlinkSync(elsewhere, join(elsewhere, "x", "loop")); // points at an ancestor
  symlinkSync(join(base, "missing"), join(elsewhere, "broken"));
  const { manifest, content } = buildManifest(roots, extra());
  assert.deepEqual(paths(manifest), ["agent:mcp.json", "agent:skills/x/SKILL.md"]);
  const skill = manifest.files.find((f) => f.path === "skills/x/SKILL.md");
  assert.equal(Buffer.from(content(skill.hash)).toString(), "skill");
});

test("node_modules and .git directories are left out at any depth", () => {
  put("agent", "skills/x/SKILL.md");
  put("agent", "skills/x/node_modules/a/index.js");
  put("agent", "skills/x/.git/HEAD");
  put("agent", "extensions/node_modules/b.js");
  put("agent", "extensions/y/node_modules/c.js");
  put("agent", "extensions/y/.git/config");
  put("agent", "extensions/y/index.ts");
  assert.deepEqual(paths(buildManifest(roots, extra()).manifest), ["agent:extensions/y/index.ts", "agent:skills/x/SKILL.md"]);
});

test("size limits", () => {
  put("agent", "skills/big/SKILL.md", Buffer.alloc(CONFIG_LIMITS.fileBytes + 1));
  const e = err(() => buildManifest(roots, extra()), "file_too_large");
  assert.match(e.message, /skills\/big\/SKILL\.md/);
  rmSync(join(roots.agent, "skills"), { recursive: true });
  const chunk = Buffer.alloc(CONFIG_LIMITS.fileBytes);
  for (let i = 0; i < 11; i++) put("agent", `skills/s${i}/SKILL.md`, chunk);
  err(() => buildManifest(roots, extra()), "bundle_too_large");
});

test("an executable file has exec true", () => {
  chmodSync(put("agent", "hooks/run.sh", "#!/bin/sh\n"), 0o755);
  put("agent", "hooks/plain.txt");
  const { manifest } = buildManifest(roots, extra());
  assert.equal(manifest.files.find((f) => f.path === "hooks/run.sh").exec, true);
  assert.equal(manifest.files.find((f) => f.path === "hooks/plain.txt").exec, false);
});

test("config.yaml and models.yaml are listed under .yml only when no .yml exists", () => {
  put("agent", "config.yaml", "modelRoles: {}\n");
  put("agent", "models.yaml", "providers: {}\n");
  assert.deepEqual(paths(buildManifest(roots, extra()).manifest), ["agent:config.yml", "agent:models.yml"]);
  put("agent", "config.yml", "a: 1\n");
  const { manifest, content } = buildManifest(roots, extra());
  assert.equal(Buffer.from(content(manifest.files.find((f) => f.path === "config.yml").hash)).toString(), "a: 1\n");
});

test("config.yml is mirrored stripped; its hash and size are of that; a non-map is invalid", () => {
  put("agent", "config.yml", "shellPath: /bin/zsh\nmodelRoles:\n  default: m\n");
  const { manifest, content } = buildManifest(roots, extra());
  const f = manifest.files[0];
  const bytes = Buffer.from(content(f.hash));
  assert.equal(bytes.length, f.size);
  assert.deepEqual(parse(bytes.toString()), { modelRoles: { default: "m" } });
  put("agent", "config.yml", "- a\n- b\n");
  err(() => buildManifest(roots, extra()), "invalid_settings");
});

test("stripLocalSettings removes each LOCAL_SETTINGS path and nothing else", () => {
  assert.deepEqual(
    parse(stripLocalSettings("python:\n  interpreter: /x\n  other: 1\nbrowser:\n  headless: true\nmodelRoles:\n  default: m\n")),
    { python: { other: 1 }, modelRoles: { default: "m" } },
  );
  const all = {};
  for (const p of LOCAL_SETTINGS) {
    let node = all;
    p.forEach((k, i) => (node = node[k] ??= i === p.length - 1 ? "v" : {}));
  }
  all.keep = 1;
  const stripped = parse(stripLocalSettings(JSON.stringify(all)));
  assert.equal(stripped.keep, 1);
  // only emptied parent maps remain; no local key does
  assert.ok(Object.entries(stripped).every(([k, v]) => k === "keep" || (typeof v === "object" && Object.keys(v).length === 0)));
  assert.deepEqual(parse(stripLocalSettings("python: 3\nkeep: 1\n")), { python: 3, keep: 1 });
  err(() => stripLocalSettings("- a\n"), "invalid_settings");
  err(() => stripLocalSettings("a: [\n"), "invalid_settings");
});

test("mergeLocalSettings keeps the member's local keys and the master's everything else", () => {
  const master = "shellPath: /master\nmodelRoles:\n  default: master\npython:\n  other: 1\n";
  const own = "shellPath: /own\nbrowser:\n  headless: true\nmodelRoles:\n  default: own\nextra: 1\npython:\n  interpreter: /py\n  other: 2\n";
  assert.deepEqual(parse(mergeLocalSettings(master, own)), {
    modelRoles: { default: "master" },
    python: { other: 1, interpreter: "/py" },
    shellPath: "/own",
    browser: { headless: true },
  });
  assert.deepEqual(parse(mergeLocalSettings(master, null)), { modelRoles: { default: "master" }, python: { other: 1 } });
  assert.deepEqual(parse(mergeLocalSettings("python: 3\n", "python:\n  interpreter: /py\n")), { python: { interpreter: "/py" } });
});

test("version is stable and changes with content, exec, an agentEnv value, or a plugin's enabled", () => {
  const file = put("agent", "skills/x/SKILL.md", "one");
  const v = (e = extra()) => buildManifest(roots, e).manifest.version;
  const v0 = v();
  assert.match(v0, /^[0-9a-f]{64}$/);
  assert.equal(v(), v0);
  assert.equal(v({ agentEnv: { A: "1", B: "2" }, plugins: extra().plugins }), v0);
  assert.notEqual(v({ ...extra(), agentEnv: { A: "1", B: "3" } }), v0);
  assert.notEqual(v({ ...extra(), plugins: [{ ...extra().plugins[0], enabled: false }] }), v0);
  chmodSync(file, 0o755);
  const vExec = v();
  assert.notEqual(vExec, v0);
  writeFileSync(file, "two");
  assert.notEqual(v(), vExec);
});

test("content(hash) returns the bytes; an unknown hash is null", () => {
  put("agent", "AGENTS.md", "hello");
  const { manifest, content } = buildManifest(roots, extra());
  assert.equal(Buffer.from(content(manifest.files[0].hash)).toString(), "hello");
  assert.equal(content("0".repeat(64)), null);
});

test("isManagedPath is the member's trust boundary", () => {
  for (const ok of ["skills/a/b", "skills/a", "config.yml", "AGENTS.md"]) assert.equal(isManagedPath("agent", ok), true, ok);
  assert.equal(isManagedPath("home", ".agents/skills/a"), true);
  for (const bad of ["skills/../x", "/etc/passwd", "sessions/x", "skills//a", "", "skills", "skills/", "skills/./a", "skills\\a", "skillsx/a", "config.yml/a"]) {
    assert.equal(isManagedPath("agent", bad), false, bad);
  }
  assert.equal(isManagedPath("home", "skills/a"), false);
  assert.equal(isManagedPath("agent", ".agents/skills/a"), false);
});

test("an empty or comment-only master config.yml is mirrored as an empty map", () => {
  for (const text of ["", "# just a comment\n"]) {
    assert.deepEqual(parse(stripLocalSettings(text)), {});
    assert.deepEqual(parse(mergeLocalSettings(text, "shellPath: /own\n")), { shellPath: "/own" });
    put("agent", "config.yml", text);
    const { manifest, content } = buildManifest(roots, extra());
    assert.deepEqual(parse(Buffer.from(content(manifest.files[0].hash)).toString()), {});
  }
});

test("a master whose stripping leaves a dangling alias is invalid_settings, without its content", () => {
  const e = err(() => stripLocalSettings("tui: &t {a: 1}\nother: *t\n"), "invalid_settings");
  assert.doesNotMatch(e.message, /\*t|&t/);
  err(() => mergeLocalSettings("tui: &t {a: 1}\nother: *t\n", null), "invalid_settings");
});

test("mergeLocalSettings survives odd shapes on either side", () => {
  assert.deepEqual(parse(mergeLocalSettings("python: [1]\n", "python:\n  interpreter: /py\n")), { python: { interpreter: "/py" } });
  assert.deepEqual(parse(mergeLocalSettings("a: 1\n", "d: &d {x: 1}\nbrowser: *d\n")), { a: 1, browser: { x: 1 } });
  assert.deepEqual(parse(mergeLocalSettings("a: 1\n", "browser: *missing\n")), { a: 1 });
  assert.deepEqual(parse(mergeLocalSettings("a: 1\n", "- not a map\n")), { a: 1 });
});

test("a file whose name is not a safe relative path is invalid_path", () => {
  put("agent", "skills/a\\b.md");
  const e = err(() => buildManifest(roots, extra()), "invalid_path");
  assert.match(e.message, /skills\/a\\b\.md/);
});

test("an unreadable file is reported as unreadable, naming its manifest path", { skip: process.getuid?.() === 0 }, () => {
  const file = put("agent", "skills/x/SKILL.md", "secret-body");
  chmodSync(file, 0o000);
  try {
    const e = err(() => buildManifest(roots, extra()), "unreadable");
    assert.match(e.message, /skills\/x\/SKILL\.md/);
    assert.doesNotMatch(e.message, /secret-body/);
  } finally {
    chmodSync(file, 0o644);
  }
});

test("a .git file is left out too", () => {
  put("agent", "skills/x/SKILL.md");
  put("agent", "skills/x/.git", "gitdir: ../../elsewhere\n");
  assert.deepEqual(paths(buildManifest(roots, extra()).manifest), ["agent:skills/x/SKILL.md"]);
});

test("exec is the owner execute bit only", () => {
  chmodSync(put("agent", "hooks/group.sh"), 0o610);
  chmodSync(put("agent", "hooks/owner.sh"), 0o700);
  const { manifest } = buildManifest(roots, extra());
  assert.equal(manifest.files.find((f) => f.path === "hooks/group.sh").exec, false);
  assert.equal(manifest.files.find((f) => f.path === "hooks/owner.sh").exec, true);
});
