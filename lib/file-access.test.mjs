import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

async function loadSubject() {
  return import("./file-access.ts");
}

/** getAllowedFileRoots() caches on globalThis for 5s; tests must not inherit it. */
function clearAllowedRootsCache() {
  globalThis.__piAllowedRootsCache = undefined;
}

/** A temp dir registered as a browsable root, cleaned up with the test. */
function workspaceRoot(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-")));
  t.after(async () => {
    // Uploads open the outbox store under the agent dir a fixture puts here; Windows cannot remove an open SQLite file.
    (await import("./message-outbox.ts")).closeOutboxStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("resolves a bare relative request path inside an allowed root", async (t) => {
  const { resolveRequestedFilePath } = await loadSubject();
  const workspace = workspaceRoot(t);
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, "src", "foo.ts"), "export {};\n");
  const roots = new Set([workspace.replace(/\\/g, "/")]);

  // What MarkdownBody linkifies: no leading slash, no root.
  assert.equal(resolveRequestedFilePath("package.json", roots), `${workspace}/package.json`.replace(/\\/g, "/"));
  assert.equal(resolveRequestedFilePath("src/foo.ts", roots), `${workspace}/src/foo.ts`.replace(/\\/g, "/"));
  // Dot segments that stay inside the root are still the same file.
  assert.equal(resolveRequestedFilePath("./src/../package.json", roots), `${workspace}/package.json`.replace(/\\/g, "/"));
  // Nothing to serve: the file is not in any root.
  assert.equal(resolveRequestedFilePath("missing.txt", roots), null);
});

test("only resolves against the first root that actually has the file", async (t) => {
  const { resolveRequestedFilePath } = await loadSubject();
  const first = workspaceRoot(t);
  const second = workspaceRoot(t);
  fs.writeFileSync(path.join(second, "notes.md"), "second\n");
  fs.writeFileSync(path.join(second, "README.md"), "second\n");
  const roots = new Set([first.replace(/\\/g, "/"), second.replace(/\\/g, "/")]);

  // Set order decides, so a later root is reachable when the first lacks it.
  assert.equal(resolveRequestedFilePath("notes.md", roots), `${second}/notes.md`.replace(/\\/g, "/"));
  assert.equal(resolveRequestedFilePath("README.md", roots), `${second}/README.md`.replace(/\\/g, "/"));
  assert.equal(resolveRequestedFilePath("package.json", roots), null);
});

test("denies a relative request path that traverses out of its root", async (t) => {
  const { isFilePathAllowed, resolveRequestedFilePath } = await loadSubject();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(base, "secret.txt"), "secret");
  const roots = new Set([workspace.replace(/\\/g, "/")]);

  // The escape targets a real file, so only the root prefix check stands
  // between a `..` request and it.
  assert.equal(resolveRequestedFilePath("../secret.txt", roots), null);
  assert.equal(resolveRequestedFilePath("src/../../secret.txt", roots), null);
  assert.equal(resolveRequestedFilePath("../../etc/passwd", roots), null);
  // Same rule as for absolute requests: outside every root means denied.
  assert.equal(isFilePathAllowed(path.join(base, "secret.txt"), roots), false);
});

test("never resolves a relative path against a root it escapes back into", async (t) => {
  const { resolveRequestedFilePath } = await loadSubject();
  const workspace = workspaceRoot(t);
  fs.writeFileSync(path.join(workspace, "inside.txt"), "in\n");
  // `outside/../inside.txt` collapses to `inside.txt` — inside, so allowed —
  // while `outside/inside.txt` would land outside and must not be served.
  fs.mkdirSync(path.join(path.dirname(workspace), `${path.basename(workspace)}-sibling`));
  const roots = new Set([workspace.replace(/\\/g, "/")]);

  assert.equal(resolveRequestedFilePath("inside.txt", roots), `${workspace}/inside.txt`.replace(/\\/g, "/"));
  assert.equal(resolveRequestedFilePath("..", roots), null, "the parent dir is not the root");
});

test("leaves absolute requests to the caller's authorization", async (t) => {
  const { resolveRequestedFilePath } = await loadSubject();
  const workspace = workspaceRoot(t);
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  const roots = new Set([workspace.replace(/\\/g, "/")]);
  const inside = `${workspace}/package.json`.replace(/\\/g, "/");

  // posix root, Windows drive and UNC are all absolute; the resolver must not
  // reinterpret them as relative names to fan out over the roots.
  assert.equal(resolveRequestedFilePath(inside, roots), null);
  assert.equal(resolveRequestedFilePath("C:/Users/me/package.json", roots), null);
  assert.equal(resolveRequestedFilePath("//server/share/package.json", roots), null);
  assert.equal(resolveRequestedFilePath("", roots), null);
});

test("applies Windows traversal rules to a Windows-style root", async () => {
  const { isFilePathAllowed, resolveRequestedFilePath } = await loadSubject();
  // Pure string logic, so the shape can be checked on any platform; the
  // on-disk half of the same flow is the platform test below.
  const roots = new Set(["C:/Users/me/work"]);
  assert.equal(resolveRequestedFilePath("package.json", roots), null, "C:/workspace is not a relative request");
  assert.equal(
    isFilePathAllowed(path.win32.resolve("C:/Users/me/work", "../secret.txt"), roots),
    false,
    "Windows traversal escapes the drive root too",
  );
});

test("resolves a relative path on Windows for real", { skip: process.platform !== "win32" }, async (t) => {
  const { resolveRequestedFilePath } = await loadSubject();
  const workspace = workspaceRoot(t);
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  const roots = new Set([workspace.replace(/\\/g, "/")]);

  assert.equal(resolveRequestedFilePath("package.json", roots), `${workspace}/package.json`.replace(/\\/g, "/"));
  assert.equal(resolveRequestedFilePath("../escape.txt", roots), null);
});

test("allows omp's config and agent roots alongside workspaces", async (t) => {
  const { allowFileRoot, getAllowedFileRoots, getConfigAgentRoots, normalizeSlashes } = await loadSubject();
  const { getAgentDir, getConfigRoot } = await import("./omp/paths.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // An empty sessions dir keeps listAllSessions() out of the developer's real
  // session store; getSessionsDir() is re-read on every call.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(isolated, "agent");
  const workspace = workspaceRoot(t);
  allowFileRoot(workspace);
  clearAllowedRootsCache();

  const roots = await getAllowedFileRoots();
  // Global rule files omp loads itself: the config root, the agent state dir
  // (PI_CODING_AGENT_DIR here), and both ecosystem-standard provider dirs.
  assert.ok(roots.has(normalizeSlashes(getConfigRoot())), "config root is browsable");
  assert.ok(roots.has(normalizeSlashes(getAgentDir())), "agent dir is browsable");
  assert.ok(roots.has(normalizeSlashes(path.join(os.homedir(), ".agents"))), "~/.agents is browsable");
  assert.ok(roots.has(normalizeSlashes(path.join(os.homedir(), ".agent"))), "~/.agent is browsable");
  assert.ok(roots.has(normalizeSlashes(workspace)), "the workspace is still browsable");

  // Real workspaces must win a relative lookup, so they come first in the Set.
  const configRoot = getConfigAgentRoots();
  assert.deepEqual(
    [...roots].slice(roots.size - configRoot.length),
    configRoot,
    "config roots are appended last",
  );

  clearAllowedRootsCache();
});

test("this machine's session roots come from its daemon's session list", async (t) => {
  const { getAllowedFileRoots } = await loadSubject();
  const { closeHostLink } = await import("./hosts/hub.ts");
  const { linkLocalHost, listedSession } = await import("./hosts/link-driver.test-helper.mjs");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => {
    closeHostLink("local");
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
    globalThis.__ompHostLists = undefined;
    clearAllowedRootsCache();
  });
  process.env.PI_CODING_AGENT_DIR = isolated;
  globalThis.__ompHostLists = undefined;
  clearAllowedRootsCache();
  const daemon = await linkLocalHost();
  daemon.serve({ listSessions: () => [{ ...listedSession("11111111-2222-4333-8444-555555555555", "/srv/app/pkg"), projectRoot: "/srv/app" }] });

  const roots = await getAllowedFileRoots();
  assert.ok(roots.has("/srv/app/pkg"), "the session cwd is browsable");
  assert.ok(roots.has("/srv/app"), "its project root is browsable");
});

test("serves a bare workspace path through GET instead of 403-ing it", async (t) => {
  const { allowFileRoot } = await loadSubject();
  const { GET } = await import("../app/api/files/[...path]/route.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(isolated, "agent");
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon();
  t.after(() => daemon.drop());

  const workspace = workspaceRoot(t);
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# rules\n");
  allowFileRoot(workspace);
  await getHost("local").sessionOps.validateCwd(workspace);
  clearAllowedRootsCache();

  // The route reads the path from `params.path` (already decoded by the router), so the
// URL is built only so the request is well-formed.
const get = (segments, type = "read") => GET(
    new Request(`http://localhost/api/files/${segments.map((s) => encodeURIComponent(s)).join("/")}?type=${type}`),
    { params: Promise.resolve({ path: segments }), disableIdleTimeout() {} },
  );

  // #135: `package.json` meant "/package.json" — a path at the filesystem
  // root, in no allowed root, and a 403.
  const read = await get(["package.json"]);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), { content: "{}\n", language: "json", size: 3 });

  // Traversal out of the workspace is still a 403, not a resolved candidate.
  assert.equal((await get(["..", "package.json"])).status, 403);
  assert.equal((await get(["..", "..", "etc", "hosts"])).status, 403);
  // An absolute path that no root authorizes is untouched by the fan-out.
  const stranger = workspaceRoot(t);
  fs.writeFileSync(path.join(stranger, "package.json"), "{}\n");
  assert.equal((await get([stranger.replace(/\\/g, "/"), "package.json"])).status, 403);

  clearAllowedRootsCache();
});

test("keeps POST uploads on the absolute-only path", async (t) => {
  const { allowFileRoot } = await loadSubject();
  const { POST } = await import("../app/api/files/[...path]/route.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(isolated, "agent");
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon();
  t.after(() => daemon.drop());

  const workspace = workspaceRoot(t);
  const uploads = path.join(workspace, "uploads");
  fs.mkdirSync(uploads);
  allowFileRoot(workspace);
  await getHost("local").sessionOps.validateCwd(workspace);
  clearAllowedRootsCache();

  const post = (segments, type = "upload-check") => POST(
    new Request(`http://localhost/api/files/${segments}?type=${type}`, {
      method: "POST",
      body: JSON.stringify({ fileNames: ["a.txt"] }),
    }),
    { params: Promise.resolve({ path: segments.split("/") }) },
  );

  // A relative upload directory would fan out over every allowed root and turn
  // an upload into a write anywhere; it must not.
  assert.equal((await post("uploads")).status, 403);
  assert.equal((await post(uploads.replace(/\\/g, "/"))).status, 200);

  clearAllowedRootsCache();
});
test("only omp's own credential files are denied, not files of the same name elsewhere under its roots", async (t) => {
  const { authorizeFileAccess } = await import("./file-authorization.ts");
  const { getConfigRoot } = await import("./omp/paths.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-")));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(agentDir, { recursive: true, force: true });
    clearAllowedRootsCache();
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const uploads = path.join(agentDir, "sessions", "--p--", "s", "local", "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const files = {};
  for (const name of ["agent.db", "agent.db-wal", "agent.db.bak", "models.yml", "models.json"]) {
    files[name] = path.join(agentDir, name);
    fs.writeFileSync(files[name], "secret");
    fs.writeFileSync(path.join(uploads, name), "upload");
  }
  fs.symlinkSync(files["agent.db"], path.join(uploads, "innocent.txt"));
  globalThis.__piAllowedRootsCache = { roots: new Set([agentDir]), expiresAt: Date.now() + 60_000 };
  const read = async (file) => (await authorizeFileAccess(file.split(/[\\/]/).filter(Boolean), null, false, globalThis.__piAllowedRootsCache.roots)).ok;

  for (const file of Object.values(files)) assert.equal(await read(file), false, file);
  assert.equal(await read(path.join(uploads, "innocent.txt")), false, "a symlink to agent.db is denied too");
  for (const name of Object.keys(files)) assert.equal(await read(path.join(uploads, name)), true, `uploads/${name}`);
  // A profile's agent dir and the default one hold omp's files too, whatever PI_CODING_AGENT_DIR says.
  const { isOmpSecretFile } = await loadSubject();
  assert.equal(isOmpSecretFile(path.join(getConfigRoot(), "profiles", "work", "agent", "agent.db")), true);
  assert.equal(isOmpSecretFile(path.join(getConfigRoot(), "agent", "models.yml")), true);
  assert.equal(isOmpSecretFile(path.join(getConfigRoot(), "profiles", "work", "agent", "sessions", "agent.db")), false);
});

test("a symlinked agent dir does not let its credential files through under their real path", async (t) => {
  const { authorizeFileAccess } = await import("./file-authorization.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-")));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(base, { recursive: true, force: true });
    clearAllowedRootsCache();
  });
  // `agent` -> `state`: the files live in `state`, and `state/` is what a request can name.
  const state = path.join(base, "state");
  fs.mkdirSync(path.join(state, "sessions", "p", "s", "local", "uploads"), { recursive: true });
  fs.symlinkSync(state, path.join(base, "agent"), process.platform === "win32" ? "junction" : "dir");
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  for (const name of ["agent.db", "models.yml"]) {
    fs.writeFileSync(path.join(state, name), "secret");
    fs.writeFileSync(path.join(state, "sessions", "p", "s", "local", "uploads", name), "upload");
  }
  globalThis.__piAllowedRootsCache = { roots: new Set([base]), expiresAt: Date.now() + 60_000 };
  const read = async (file) => (await authorizeFileAccess(file.split(/[\\/]/).filter(Boolean), null, false, globalThis.__piAllowedRootsCache.roots)).ok;

  for (const name of ["agent.db", "models.yml"]) {
    assert.equal(await read(path.join(state, name)), false, `state/${name}`);
    assert.equal(await read(path.join(base, "agent", name)), false, `agent/${name}`);
    assert.equal(await read(path.join(state, "sessions", "p", "s", "local", "uploads", name)), true, `uploaded ${name}`);
  }
});

test("individual credential symlinks protect their real targets without blocking uploaded copies", async (t) => {
  const { authorizeFileAccess } = await import("./file-authorization.ts");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-")));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agent = path.join(base, "agent");
  const state = path.join(base, "state");
  const uploads = path.join(agent, "sessions", "p", "s", "local", "uploads");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(base, { recursive: true, force: true });
    clearAllowedRootsCache();
  });
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(state);
  process.env.PI_CODING_AGENT_DIR = agent;
  const credentials = [
    ["agent.db", "credentials.sqlite"],
    ["models.yml", "provider-config.txt"],
    ["models.yaml", "models.yaml"],
    ["models.json", "models.json"],
    ["agent.db-wal", "credential-wal.bin"],
    ["agent.db.bak", "credential-backup.bin"],
  ];
  for (const [name, target] of credentials) {
    fs.writeFileSync(path.join(state, target), "secret");
    fs.symlinkSync(path.join(state, target), path.join(agent, name));
    fs.writeFileSync(path.join(uploads, name), "upload");
    fs.writeFileSync(path.join(uploads, target), "upload");
  }
  fs.symlinkSync(path.join(state, "credentials.sqlite"), path.join(uploads, "alias.txt"));
  globalThis.__piAllowedRootsCache = { roots: new Set([base]), expiresAt: Date.now() + 60_000 };
  const read = (file) => authorizeFileAccess(file.split(/[\\/]/).filter(Boolean), null, false, globalThis.__piAllowedRootsCache.roots);

  // Do not test only the aliases: they already have a protected basename and parent.
  for (const [name, target] of credentials) {
    for (const file of [path.join(state, target), path.join(agent, name)]) {
      const result = await read(file);
      assert.equal(result.ok, false, file);
      assert.equal(result.code, "access_denied", file);
    }
    assert.equal((await read(path.join(uploads, name))).ok, true, `uploaded ${name}`);
    assert.equal((await read(path.join(uploads, target))).ok, true, `uploaded ${target}`);
  }
  assert.equal((await read(path.join(uploads, "alias.txt"))).ok, false, "an alias to the real credential target stays denied");
  for (const suffix of ["-wal", "-shm", "-journal", ".bak"]) {
    const sidecar = path.join(state, `credentials.sqlite${suffix}`);
    fs.writeFileSync(sidecar, "secret");
    assert.equal((await read(sidecar)).ok, false, `real database target${suffix}`);
  }
  const unrelated = path.join(state, "credentials.sqlite.project", "readme.md");
  fs.mkdirSync(path.dirname(unrelated));
  fs.writeFileSync(unrelated, "not a database backup");
  assert.equal((await read(unrelated)).ok, true, "backup suffixes must not match a directory's descendants");

  for (const suffix of ["-wal", ".bak"]) {
    const sidecar = path.join(state, `credentials.sqlite${suffix}`);
    const target = path.join(state, `relocated${suffix}.bin`);
    fs.unlinkSync(sidecar);
    fs.writeFileSync(target, "secret");
    fs.symlinkSync(target, sidecar);
    assert.equal((await read(sidecar)).ok, false, `symlinked database target${suffix}`);
    assert.equal((await read(target)).ok, false, `relocated database target${suffix}`);
  }
});

test("credential checks follow native symlink parent traversal instead of a lexical decoy", { skip: process.platform === "win32" }, async (t) => {
  const { authorizeFileAccess } = await import("./file-authorization.ts");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-")));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agent = path.join(base, "agent");
  const workspace = path.join(base, "workspace");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(base, { recursive: true, force: true });
    clearAllowedRootsCache();
  });
  fs.mkdirSync(path.join(agent, "child"), { recursive: true });
  fs.mkdirSync(workspace);
  process.env.PI_CODING_AGENT_DIR = agent;
  fs.writeFileSync(path.join(agent, "agent.db"), "secret");
  fs.writeFileSync(path.join(workspace, "agent.db"), "independent workspace file");
  fs.symlinkSync(path.join(agent, "child"), path.join(workspace, "redirect"));
  const spelled = `${workspace}/redirect/../agent.db`;
  assert.equal(fs.readFileSync(spelled, "utf8"), "secret", "the OS follows the link before processing its parent traversal");
  globalThis.__piAllowedRootsCache = { roots: new Set([base]), expiresAt: Date.now() + 60_000 };
  const result = await authorizeFileAccess([spelled], null, false, globalThis.__piAllowedRootsCache.roots);
  assert.equal(result.ok, false);
  assert.equal(result.code, "access_denied");
  assert.equal((await authorizeFileAccess([path.join(workspace, "agent.db")], null, false, globalThis.__piAllowedRootsCache.roots)).ok, true);
});

let secretUploads;

async function secretFileFixture(t) {
  const root = workspaceRoot(t);
  const previous = { PI_CONFIG_DIR: process.env.PI_CONFIG_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const config = path.join(root, "config");
  const agent = path.join(root, "node_modules", "omp", "agent");
  const profile = path.join(config, "profiles", "work", "agent");
  const workspace = path.join(root, "workspace");
  for (const dir of [config, agent, profile, workspace]) fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CONFIG_DIR = path.relative(os.homedir(), config);
  process.env.PI_CODING_AGENT_DIR = agent;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon();
  secretUploads = daemon.uploads;
  t.after(() => daemon.drop());
  await getHost("local").sessionOps.validateCwd(root);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    clearAllowedRootsCache();
  });
  const put = (dir, name, content = "fixture\n") => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { root, config, agent, profile, workspace, put };
}

async function secretFileRoute(file, type = "read") {
  const { encodeFilePathForApi, filePathApiSegments } = await import("./file-paths.ts");
  const { GET } = await import("../app/api/files/[...path]/route.ts");
  return GET(
    new Request(`http://localhost/api/files/${encodeFilePathForApi(file)}?type=${type}`),
    { params: Promise.resolve({ path: filePathApiSegments(file) }), disableIdleTimeout() {} },
  );
}

async function secretUploadRoute(directory, names, check) {
  const { encodeFilePathForApi, filePathApiSegments } = await import("./file-paths.ts");
  const { POST } = await import("../app/api/files/[...path]/route.ts");
  const { startUpload, abortUpload } = await import("./uploads.ts");
  const uploads = [];
  if (!check) {
    for (const name of names) {
      const id = randomUUID(), bytes = Buffer.from("replacement\n");
      let finish, fail;
      const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      await startUpload({ id, hostId: "local", owner: "open", name, size: bytes.length, type: "application/octet-stream",
        sink: { ack(_received, done) { if (done) finish(); }, error(_status, _code, message) { fail(new Error(message)); } } });
      secretUploads.write(id, bytes);
      await completed;
      uploads.push({ id, name });
    }
  }
  try {
    return await POST(new Request(`http://localhost/api/files/${encodeFilePathForApi(directory)}?type=${check ? "upload-check" : "upload"}&conflict=overwrite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(check ? { fileNames: names } : { uploads }),
    }), { params: Promise.resolve({ path: filePathApiSegments(directory) }) });
  } finally {
    for (const { id } of uploads) await abortUpload(id, "open", "local");
  }
}

test("secret copies are denied only directly in owned agent dirs, not independent uploads or package assets", async (t) => {
  const { config, agent, profile, workspace, put } = await secretFileFixture(t);
  const copies = [
    "agent.db", "agent.db-wal", "agent.db-shm", "agent.db-journal", "AGENT.DB-WAL",
    "agent.db.bak", "agent.db.bak.1", "agent.db.1.gz", "agent.db~", ".agent.db.swp",
    "models.yml", "models.yaml", "models.json", "MODELS.YAML", "MODELS.JSON.BAK",
    "models.yml.bak", "models.yml.tmp", "models.yml.2026-11-04", "models.yaml.bak",
    "models.json.bak", "models.json.tmp", "models.yml~", ".models.yml.swp",
    "models.yml-backup", "models.yaml-bak", "models.json-old", "MODELS.YML-BACKUP",
    ".models.yml-bak", "models.yml-old-notes", "models.yaml-backup.1", "models.json-bak~",
  ];
  const uploads = path.join(agent, "sessions", "p", "s", "local", "uploads");
  const packageDir = path.join(agent, "plugins", "node_modules", "@oh-my-pi", "pi-catalog", "src");
  for (const name of copies) {
    for (const dir of [agent, path.join(config, "agent"), profile]) {
      const file = put(dir, name);
      for (const type of ["read", "download", "meta"]) {
        assert.equal((await secretFileRoute(file, type)).status, 403, `${file} ${type}`);
      }
    }
    for (const dir of [uploads, packageDir, workspace, config, path.join(agent, "plugins", "NODE_MODULES", "pkg")]) {
      const file = put(dir, name);
      assert.equal((await secretFileRoute(file)).status, 200, `independent ${file}`);
    }
  }
  for (const name of ["AGENTS.md", "agent.dbx", "my-agent.db-wal", "agent-db-wal", "models.yml-notes.md",
    "models.json-notes.md", "models.ymlx", "models.jsonl", "my-models.json", "models.yml-oldest", "models.yml-bakery.md"]) {
    assert.equal((await secretFileRoute(put(agent, name))).status, 200, name);
  }
});

test(".env family is denied only at genuine default/profile config roots and agent dirs", async (t) => {
  const { config, agent, profile, workspace, put } = await secretFileFixture(t);
  for (const name of [".env", ".env.local", ".env.production", ".env.example", ".ENV"]) {
    for (const dir of [config, agent, path.join(config, "agent"), path.dirname(profile), profile]) {
      const file = put(dir, name);
      for (const type of ["read", "download", "meta"]) {
        assert.equal((await secretFileRoute(file, type)).status, 403, `${file} ${type}`);
      }
    }
    for (const dir of [workspace, path.join(agent, "sessions", "p", "s", "local", "uploads"),
      path.join(agent, "plugins", "node_modules", "pkg"), path.join(config, "sessions")]) {
      const file = put(dir, name);
      assert.equal((await secretFileRoute(file)).status, 200, `independent ${file}`);
    }
  }
  for (const name of [".envrc", "env.md", "my.env", "dotenv"]) {
    assert.equal((await secretFileRoute(put(agent, name))).status, 200, name);
  }
});

test("secret-copy and env symlinks protect arbitrary real targets without denying unrelated descendants", async (t) => {
  const { root, config, agent, profile, workspace, put } = await secretFileFixture(t);
  for (const [dir, name] of [[agent, ".agent.db.swp"], [profile, "models.yml-backup"], [agent, ".env.local"], [config, ".env"], [path.dirname(profile), ".env"]]) {
    const target = put(workspace, `target-${path.basename(dir)}-${name}.txt`);
    fs.symlinkSync(target, path.join(dir, name));
    const alias = path.join(workspace, `alias-${path.basename(dir)}-${name}.txt`);
    fs.symlinkSync(target, alias);
    for (const file of [target, alias, path.join(dir, name)]) {
      for (const type of ["read", "download", "meta"]) {
        assert.equal((await secretFileRoute(file, type)).status, 403, `${file} ${type}`);
      }
    }
    const child = put(root, path.relative(root, `${target}.project/readme.md`));
    assert.equal((await secretFileRoute(child)).status, 200, "exact-file comparisons never deny directory children");
  }
});

test("traversal and package symlinks cannot disguise actual credential copies", async (t) => {
  const { isOmpSecretFile } = await loadSubject();
  const { agent, workspace, put } = await secretFileFixture(t);
  const pkg = path.join(agent, "plugins", "node_modules", "pkg");
  const credential = put(agent, "models.yml-backup");
  put(pkg, "models.json");
  const traversal = `${pkg}/../../../models.yml-backup`;
  assert.equal(isOmpSecretFile(traversal), true, "resolve .. before judging ownership");
  assert.equal(isOmpSecretFile(`${pkg}/../pkg/models.json`), false, "an independent package file");
  assert.equal(isOmpSecretFile(path.join(workspace, "models.yml-backup")), false, "an independent missing file");
  fs.symlinkSync(credential, path.join(pkg, "innocent.txt"));
  fs.symlinkSync(agent, path.join(pkg, "whole"), process.platform === "win32" ? "junction" : "dir");
  for (const file of [path.join(pkg, "innocent.txt"), path.join(pkg, "whole", "models.yml-backup")]) {
    for (const type of ["read", "download", "meta"]) {
      assert.equal((await secretFileRoute(file, type)).status, 403, `${file} ${type}`);
    }
  }
  const { encodeFilePathForApi } = await import("./file-paths.ts");
  const { GET } = await import("../app/api/files/[...path]/route.ts");
  for (const type of ["read", "download", "meta"]) {
    const url = `http://localhost/api/files/${encodeFilePathForApi(path.join(agent, "plugins"))}/node_modules%2F..%2F..%2Fmodels.yml-backup?type=${type}`;
    const segments = new URL(url).pathname.split("/").slice(3).filter(Boolean).map(decodeURIComponent);
    assert.equal((await GET(new Request(url), { params: Promise.resolve({ path: segments }), disableIdleTimeout() {} })).status, 403, type);
  }
});

test("linked config and profile dirs deny missing direct secrets but not missing independent files", async (t) => {
  const { root, config, agent, profile, workspace, put } = await secretFileFixture(t);
  const { isOmpSecretFile } = await loadSubject();
  for (const dir of [config, agent, path.dirname(profile), profile]) {
    const real = path.join(root, `real-${path.basename(dir)}-${path.basename(path.dirname(dir))}`);
    fs.renameSync(dir, real);
    fs.symlinkSync(real, dir, process.platform === "win32" ? "junction" : "dir");
    for (const name of [config, path.dirname(profile)].includes(dir) ? [".env.local"] : [".agent.db.swp", "models.yml-backup", ".env.local"]) {
      for (const file of [path.join(dir, name), path.join(real, name)]) {
        assert.equal(isOmpSecretFile(file), true, `missing direct ${file}`);
        assert.equal((await secretFileRoute(file)).status, 403, `missing direct ${file}`);
      }
    }
    const ordinary = put(real, "node_modules/pkg/models.json");
    assert.equal((await secretFileRoute(ordinary)).status, 200, "linked-root package asset");
  }
  for (const file of [path.join(workspace, "agent.db"), path.join(agent, "plugins", "node_modules", "missing", "agent.db")]) {
    assert.equal((await secretFileRoute(file)).status, 404, "unowned missing files retain 404");
  }
});

test("native canonical directory case follows the filesystem, not a global lowercase policy", async (t) => {
  const { root, agent, put } = await secretFileFixture(t);
  const probe = put(root, "case-probe");
  const caseInsensitive = fs.existsSync(probe.toUpperCase());
  const file = put(agent, "models.yml-backup");
  if (caseInsensitive) {
    assert.equal((await secretFileRoute(file.toUpperCase())).status, 403, "alternate case still names the protected file");
    const asset = put(agent, "plugins/node_modules/pkg/models.json");
    assert.equal((await secretFileRoute(asset.replace("node_modules", "Node_Modules"))).status, 200);
  } else {
    const sibling = put(path.join(path.dirname(agent), "AGENT"), "models.yml-backup");
    assert.equal((await secretFileRoute(sibling)).status, 200, "a differently cased directory is independent");
  }
});

test("upload-check and overwrite refuse actual secret targets and aliases without touching their bytes", async (t) => {
  const { config, agent, profile, workspace, put } = await secretFileFixture(t);
  const target = put(workspace, "renamed-credentials.bin", "original\n");
  fs.symlinkSync(target, path.join(agent, "agent.db"));
  fs.symlinkSync(target, path.join(workspace, "innocent.txt"));
  for (const [dir, name] of [[agent, "agent.db"], [agent, ".agent.db.swp"], [agent, "models.yml-backup"],
    [config, ".env"], [path.dirname(profile), ".env.local"], [profile, "models.yaml-bak"],
    [workspace, "renamed-credentials.bin"], [workspace, "innocent.txt"]]) {
    for (const check of [true, false]) {
      const response = await secretUploadRoute(dir, [name], check);
      assert.equal(response.status, 403, `${dir}/${name} ${check ? "check" : "overwrite"}`);
      assert.equal((await response.json()).code, "access_denied");
      assert.equal(fs.readFileSync(target, "utf8"), "original\n", "the actual credential store is untouched");
    }
  }
  for (const dir of [workspace, path.join(agent, "sessions", "p", "s", "local", "uploads"),
    path.join(agent, "plugins", "node_modules", "pkg")]) {
    for (const name of ["agent.db", "models.yml-backup", ".env"]) {
      const file = put(dir, name, "independent\n");
      assert.equal((await secretUploadRoute(dir, [name], true)).status, 200, `independent preflight ${file}`);
      assert.equal((await secretUploadRoute(dir, [name], false)).status, 200, `independent overwrite ${file}`);
      assert.equal(fs.readFileSync(file, "utf8"), "replacement\n");
    }
  }
});

test("hard-linked credential aliases stay denied while independent copies remain usable", async (t) => {
  const { config, agent, profile, workspace, put } = await secretFileFixture(t);
  const uploads = path.join(agent, "sessions", "p", "s", "local", "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const secrets = [
    [agent, "agent.db"], [agent, "agent.db-wal"], [agent, "models.yml-backup"],
    [config, ".env.local"], [profile, "models.yaml"], [path.dirname(profile), ".env"],
  ];
  for (const [index, [dir, name]] of secrets.entries()) {
    const original = put(dir, name, "protected fixture\n");
    const alias = path.join(index === 0 ? uploads : workspace, index === 0 ? "agent.db" : `alias-${index}.txt`);
    fs.linkSync(original, alias);
    assert.notEqual(fs.realpathSync(alias), fs.realpathSync(original), "a hard link is not a canonical-path alias");
    for (const type of ["read", "download", "meta"]) {
      const response = await secretFileRoute(alias, type);
      assert.equal(response.status, 403, `${name} hard link ${type}`);
      assert.equal((await response.json()).code, "access_denied");
    }
    for (const check of [true, false]) {
      const response = await secretUploadRoute(path.dirname(alias), [path.basename(alias)], check);
      assert.equal(response.status, 403, `${name} hard link ${check ? "preflight" : "overwrite"}`);
      assert.equal(fs.readFileSync(original, "utf8"), "protected fixture\n", "refused overwrite cannot alter the original");
    }
    const independent = path.join(uploads, `copy-${index}`, name);
    fs.mkdirSync(path.dirname(independent), { recursive: true });
    fs.copyFileSync(original, independent);
    assert.equal((await secretFileRoute(independent, "download")).status, 200, "equal bytes are not equal file identity");
  }
  const ordinary = put(workspace, "ordinary.txt", "ordinary linked file\n");
  const ordinaryAlias = path.join(uploads, "models.yml");
  fs.linkSync(ordinary, ordinaryAlias);
  assert.equal(await (await secretFileRoute(ordinaryAlias, "download")).text(), "ordinary linked file\n");
  assert.equal((await secretUploadRoute(uploads, ["models.yml"], false)).status, 200, "hard links unrelated to credentials remain writable");
});

async function asWindows(fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try { return await fn(); }
  finally { Object.defineProperty(process, "platform", original); }
}

test("Windows credential streams are denied before creation and through the default data stream", async (t) => {
  const { config, agent, profile, put } = await secretFileFixture(t);
  const secrets = [[agent, "agent.db"], [agent, "models.yml"], [agent, "models.yaml"],
    [config, ".env"], [profile, "models.json"], [path.dirname(profile), ".env"]];
  for (const [dir, name] of secrets) put(dir, name, "protected base\n");
  await asWindows(async () => {
    for (const [dir, name] of secrets) {
      for (const suffix of [":notes", "::$DATA"]) {
        for (const type of ["read", "download", "meta"]) {
          assert.equal((await secretFileRoute(path.join(dir, name + suffix), type)).status, 403, `${name}${suffix} ${type}`);
        }
        for (const check of [true, false]) {
          assert.equal((await secretUploadRoute(dir, [name + suffix], check)).status, 403, `${name}${suffix} ${check ? "preflight" : "overwrite"}`);
          assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), "protected base\n");
        }
      }
    }
  });
});

test("Windows stream ownership follows symlink and hard-link credential aliases without blocking independent streams", async (t) => {
  const { agent, workspace, put } = await secretFileFixture(t);
  const target = put(workspace, "private.sqlite", "protected base\n");
  fs.symlinkSync(target, path.join(agent, "agent.db"));
  const hardLink = path.join(workspace, "ordinary-name.txt");
  fs.linkSync(target, hardLink);
  fs.writeFileSync(`${target}:notes`, "protected stream\n");
  const streamBase = put(workspace, "single-link-models.bin", "protected model base\n");
  fs.symlinkSync(streamBase, path.join(agent, "models.yml"));
  fs.writeFileSync(`${streamBase}:notes`, "protected model stream\n");
  const streamLink = path.join(workspace, "linked-stream.txt");
  fs.symlinkSync(`${streamBase}:notes`, streamLink);
  assert.equal(fs.statSync(streamBase).nlink, 1, "the stream symlink must be protected without a hard-link identity fallback");
  const candidateBase = put(workspace, "stream-config.bin", "owned stream base\n");
  fs.writeFileSync(`${candidateBase}:secrets`, "owned model configuration\n");
  fs.writeFileSync(`${candidateBase}:notes`, "other stream of the same owned file\n");
  fs.symlinkSync(`${candidateBase}:secrets`, path.join(agent, "models.yaml"));
  const independent = put(path.join(agent, "sessions", "p", "s", "local", "uploads"), "agent.db", "independent base\n");
  fs.writeFileSync(`${independent}:notes`, "independent stream\n");
  await asWindows(async () => {
    for (const file of [`${target}:notes`, `${hardLink}:notes`, streamLink, candidateBase, `${candidateBase}:notes`]) {
      assert.equal((await secretFileRoute(file, "download")).status, 403, file);
      assert.equal((await secretUploadRoute(path.dirname(file), [path.basename(file)], true)).status, 403, `${file} preflight`);
    }
    const response = await secretFileRoute(`${independent}:notes`, "download");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "independent stream\n");
    assert.equal((await secretUploadRoute(path.dirname(independent), ["agent.db:notes"], true)).status, 200);
  });
});

test("POSIX colons remain literal independent filenames, not Windows streams", { skip: process.platform === "win32" }, async (t) => {
  const { config, agent, put } = await secretFileFixture(t);
  for (const [dir, name] of [[agent, "agent.db:notes"], [agent, "models.yml::$DATA"], [config, ".env:notes"]]) {
    const file = put(dir, name, "literal colon filename\n");
    const response = await secretFileRoute(file, "download");
    assert.equal(response.status, 200, file);
    assert.equal(await response.text(), "literal colon filename\n");
    assert.equal((await secretUploadRoute(dir, [name], false)).status, 200, "literal POSIX names remain writable");
  }
});

test("native file identity protects literal POSIX backslash aliases and encoded symlink-parent traversal", { skip: process.platform === "win32" }, async (t) => {
  const { isOmpSecretFile } = await loadSubject();
  const { agent, workspace, put } = await secretFileFixture(t);
  const secret = put(agent, "models.yml-backup", "actual credential\n");
  const alias = path.join(workspace, "innocent\\name.txt");
  fs.symlinkSync(secret, alias);
  const pkg = path.join(workspace, "node_modules", "pkg");
  put(pkg, "models.yml-backup", "independent lexical decoy\n");
  fs.mkdirSync(path.join(agent, "child"));
  fs.symlinkSync(path.join(agent, "child"), path.join(pkg, "redirect"), "dir");
  const traversal = `${pkg}/redirect/../models.yml-backup`;
  const { GET } = await import("../app/api/files/[...path]/route.ts");
  for (const file of [alias, traversal]) {
    assert.equal(isOmpSecretFile(file), true, `native identity ${file}`);
    for (const type of ["read", "download", "meta"]) {
      const url = `http://localhost/api/files/${encodeURIComponent(file)}?type=${type}`;
      const segments = new URL(url).pathname.split("/").slice(3).filter(Boolean).map(decodeURIComponent);
      assert.equal((await GET(new Request(url), { params: Promise.resolve({ path: segments }), disableIdleTimeout() {} })).status, 403, `${file} ${type}`);
    }
  }
});

test("renamed canonical database copies and editor files stay denied, including aliases, but not descendants", async (t) => {
  const { agent, workspace, put } = await secretFileFixture(t);
  const database = put(agent, "private.sqlite", "original database\n");
  fs.symlinkSync(database, path.join(agent, "agent.db"));
  for (const name of ["private.sqlite.bak", "private.sqlite~", "private.sqlite-backup", "private.sqlite-bak",
    "private.sqlite-old-notes", ".private.sqlite.swp"]) {
    const copy = put(agent, name, "original copy\n");
    const aliasName = `alias-${name}.txt`;
    fs.symlinkSync(copy, path.join(workspace, aliasName));
    for (const file of [copy, path.join(workspace, aliasName)]) {
      for (const type of ["read", "download", "meta"]) {
        assert.equal((await secretFileRoute(file, type)).status, 403, `${file} ${type}`);
      }
    }
    for (const [dir, uploadName] of [[agent, name], [workspace, aliasName]]) {
      for (const check of [true, false]) {
        assert.equal((await secretUploadRoute(dir, [uploadName], check)).status, 403, `${uploadName} ${check}`);
        assert.equal(fs.readFileSync(copy, "utf8"), "original copy\n");
      }
    }
    const independent = put(workspace, name);
    assert.equal((await secretFileRoute(independent)).status, 200, "independent same-named copy");
    const child = put(agent, `${name}.project/readme.md`);
    assert.equal((await secretFileRoute(child)).status, 200, "exact-file comparison, not a backup path prefix");
  }
});

test("mixed secret upload batches are denied atomically in either order before preflight or overwrite", async (t) => {
  const { agent, put } = await secretFileFixture(t);
  const ordinary = put(agent, "ordinary.txt", "original ordinary\n");
  const secret = put(agent, "agent.db", "original credential\n");
  for (const names of [["ordinary.txt", "agent.db", "new-file.txt"], ["agent.db", "ordinary.txt", "new-file.txt"]]) {
    for (const check of [true, false]) {
      const response = await secretUploadRoute(agent, names, check);
      assert.equal(response.status, 403, `${names.join(",")} ${check ? "preflight" : "overwrite"}`);
      assert.equal((await response.json()).code, "access_denied");
      assert.equal(fs.readFileSync(ordinary, "utf8"), "original ordinary\n");
      assert.equal(fs.readFileSync(secret, "utf8"), "original credential\n");
      assert.equal(fs.existsSync(path.join(agent, "new-file.txt")), false, "no member of a denied batch is created");
    }
  }
});

test("lists every entry, shows link targets, and keeps the tree inside the explorer root", async (t) => {
  const { allowFileRoot } = await loadSubject();
  const { GET } = await import("../app/api/files/[...path]/route.ts");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
    clearAllowedRootsCache();
  });
  process.env.PI_CODING_AGENT_DIR = path.join(isolated, "agent");
  const { linkLocalDaemon } = await import("./hosts/link-driver.test-helper.mjs");
  const { getHost } = await import("./hosts/hub.ts");
  const daemon = await linkLocalDaemon();
  t.after(() => daemon.drop());

  const win = process.platform === "win32";
  const link = (target, at) => fs.symlinkSync(target, at, win ? "junction" : "dir");
  const workspace = workspaceRoot(t);
  // Allowed too: the allow-list alone would let a link into it through.
  const sibling = workspaceRoot(t);
  for (const dir of ["build", ".git", "node_modules/pkg", "real/sub"]) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  for (const file of ["x.pyc", ".DS_Store", "build/out.js"]) fs.writeFileSync(path.join(workspace, file), "x\n");
  fs.writeFileSync(path.join(sibling, "secret.txt"), "x\n");
  link(win ? path.join(workspace, "real") : "real", path.join(workspace, "inside"));
  link(sibling, path.join(workspace, "out"));
  if (!win) fs.symlinkSync("missing", path.join(workspace, "dangling"));
  allowFileRoot(workspace);
  allowFileRoot(sibling);
  await getHost("local").sessionOps.validateCwd(workspace);
  await getHost("local").sessionOps.validateCwd(sibling);
  clearAllowedRootsCache();

  const list = (dir, root) => GET(
    new Request(`http://localhost/api/files/x?type=list${root === undefined ? "" : `&root=${encodeURIComponent(root)}`}`),
    { params: Promise.resolve({ path: [dir.replace(/\\/g, "/")] }), disableIdleTimeout() {} },
  );
  const entriesOf = async (res) => Object.fromEntries((await res.json()).entries.map((e) => [e.name, e]));

  // Nothing is hidden by name, with or without a root.
  for (const root of [undefined, workspace]) {
    const res = await list(workspace, root);
    assert.equal(res.status, 200);
    const entries = await entriesOf(res);
    for (const name of ["build", ".git", "node_modules", "x.pyc", ".DS_Store"]) assert.ok(name in entries, `${name} is listed`);
    assert.equal("linkTarget" in entries.build, false, "a plain entry has no link target");
    assert.equal("outsideRoot" in entries.build, false);
    assert.equal(entries.inside.isDir, true);
    assert.equal(typeof entries.out.linkTarget, "string");
    // Windows readlink spells junction targets its own way.
    if (!win) {
      assert.equal(entries.inside.linkTarget, "real");
      assert.equal(entries.out.linkTarget, sibling);
      assert.deepEqual([entries.dangling.isDir, entries.dangling.linkTarget], [false, "missing"]);
    }
  }

  // With a root, a link that leaves it (or leads nowhere) is flagged; one that stays inside is not.
  const rooted = await entriesOf(await list(workspace, workspace));
  assert.equal(rooted.out.outsideRoot, true);
  assert.equal(rooted.inside.outsideRoot, undefined);
  if (!win) assert.equal(rooted.dangling.outsideRoot, true);
  assert.equal((await entriesOf(await list(workspace))).out.outsideRoot, undefined, "no root, no flag");

  // Listing through a link is held to the root as well.
  const through = await list(path.join(workspace, "out"), workspace);
  assert.equal(through.status, 403);
  assert.equal((await through.json()).code, "outside_root");
  const inside = await list(path.join(workspace, "inside"), workspace);
  assert.equal(inside.status, 200);
  assert.ok("sub" in await entriesOf(inside));

  // A sibling whose name only starts with the root's is not inside it.
  const lookalike = `${workspace}-x`;
  fs.mkdirSync(lookalike);
  t.after(() => fs.rmSync(lookalike, { recursive: true, force: true }));
  allowFileRoot(lookalike);
  await getHost("local").sessionOps.validateCwd(lookalike);
  clearAllowedRootsCache();
  const near = await list(lookalike, workspace);
  assert.equal(near.status, 403);
  assert.equal((await near.json()).code, "outside_root");

  // A root that is unrelated, or not a real absolute path, narrows everything away.
  for (const root of [workspaceRoot(t), "relative/root", ""]) {
    const res = await list(workspace, root);
    assert.equal(res.status, 403, root);
    assert.equal((await res.json()).code, "outside_root", root);
  }
  // A relative root is refused even where it would resolve: against the server's cwd, above a listed dir.
  const underCwd = fs.mkdtempSync(path.join(process.cwd(), ".omp-web-root-test-"));
  t.after(() => fs.rmSync(underCwd, { recursive: true, force: true }));
  allowFileRoot(underCwd);
  await getHost("local").sessionOps.validateCwd(underCwd);
  clearAllowedRootsCache();
  for (const root of ["", ".", "..", path.basename(underCwd)]) {
    const res = await list(underCwd, root);
    assert.equal(res.status, 403, JSON.stringify(root));
    assert.equal((await res.json()).code, "outside_root", JSON.stringify(root));
  }
});
