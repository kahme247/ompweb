import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  const { NextRequest } = await import("next/server");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(isolated, "agent");

  const workspace = workspaceRoot(t);
  fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "# rules\n");
  allowFileRoot(workspace);
  clearAllowedRootsCache();

  // The route reads the path from `params.path` (already decoded by Next), so the
// URL is built only so the request is well-formed.
const get = (segments, type = "read") => GET(
    new NextRequest(`http://localhost/api/files/${segments.map((s) => encodeURIComponent(s)).join("/")}?type=${type}`),
    { params: Promise.resolve({ path: segments }) },
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
  const { NextRequest } = await import("next/server");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-access-"));
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(isolated, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(isolated, "agent");

  const workspace = workspaceRoot(t);
  const uploads = path.join(workspace, "uploads");
  fs.mkdirSync(uploads);
  allowFileRoot(workspace);
  clearAllowedRootsCache();

  const post = (segments, type = "upload-check") => POST(
    new NextRequest(`http://localhost/api/files/${segments}?type=${type}`, {
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