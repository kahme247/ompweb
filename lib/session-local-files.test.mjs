// open_file with a `local://` URL: the owning session's own file, resolved on the machine that holds it
// (GET /api/sessions/[id]/local-file), then read, downloaded and watched through the one file gate (GET /api/files,
// the file channel) like any absolute path. These drive the real route handlers over a hand-driven daemon link.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkHost, linkLocalHost } from "./hosts/link-driver.test-helper.mjs";

const hub = await import("./hosts/hub.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");
const { encodeFilePathForApi, filePathApiSegments } = await import("./file-paths.ts");
const { GET: filesRoute } = await import("../app/api/files/[...path]/route.ts");

const A = "11111111-2222-4333-8444-5555555555aa";
const B = "11111111-2222-4333-8444-5555555555bb";
const R = "11111111-2222-4333-8444-5555555555cc";
const UNKNOWN = "11111111-2222-4333-8444-5555555555dd";

/** Each test's own agent dir, workspace and custom session dir. The sessions live outside the agent dir, so no allowed
 * root covers their `local/` directories: only a session's own local-root admission can read them. */
function world(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "omp-web-local-uri-")));
  const agentDir = join(base, "agent");
  const workspace = join(base, "workspace");
  mkdirSync(agentDir);
  mkdirSync(workspace);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const reset = () => {
    globalThis.__ompHostLists = undefined;
    globalThis.__piAllowedRootsCache = undefined;
    invalidateSessionListCache();
  };
  reset();
  const links = [];
  const cleanups = [];
  t.after(() => {
    for (const link of links) hub.closeHostLink(link.id);
    hub.flushLinkSamples();
    for (const cleanup of cleanups) cleanup();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    reset();
    rmSync(base, { recursive: true, force: true });
  });

  /** A session whose file `<dir>/<name>.jsonl` has omp's artifact directory `<dir>/<name>/local/`. */
  const session = (id, { dir = join(base, "custom-sessions", "-proj"), name = `2026-01-01_${id.slice(-2)}` } = {}) => {
    const file = join(dir, `${name}.jsonl`);
    const local = join(dir, name, "local");
    mkdirSync(local, { recursive: true });
    return {
      id,
      file,
      local,
      entry: { path: file, id, cwd: workspace, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "hi" },
    };
  };
  const serve = async (link, sessions) => {
    links.push(link);
    link.serve({ listSessions: () => sessions.map((s) => s.entry) });
    return link;
  };
  const resolveRoute = async (id, uri) => {
    const { GET } = await import("../app/api/sessions/[id]/local-file/route.ts");
    const query = uri === undefined ? "" : `?uri=${encodeURIComponent(uri)}`;
    return GET(new Request(`http://localhost/api/sessions/${id}/local-file${query}`), { params: Promise.resolve({ id }) });
  };
  /** The viewer's request for an absolute path: what its tab does with the resolved path. */
  const read = (path, sessionId, type = "read") =>
    filesRoute(
      new Request(`http://localhost/api/files/${encodeFilePathForApi(path)}?type=${type}${sessionId ? `&sessionId=${sessionId}` : ""}`),
      { params: Promise.resolve({ path: filePathApiSegments(path) }), disableIdleTimeout() {} },
    );
  return {
    base,
    agentDir,
    workspace,
    session,
    resolveRoute,
    read,
    cleanups,
    local: async (...sessions) => serve(await linkLocalHost(), sessions),
    remote: async (label, ...sessions) => serve(await linkHost(label), sessions),
  };
}

const resolved = async (response) => {
  assert.equal(response.status, 200, `resolve answered ${response.status}: ${JSON.stringify(await response.clone().json())}`);
  return (await response.json()).path;
};
const refused = async (response, status, code) => {
  const body = await response.json();
  assert.deepEqual([response.status, body.code], [status, code], JSON.stringify(body));
  assert.equal(typeof body.error, "string");
  return body;
};
async function asPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("opens each session's own local:// bytes, including a nested name with spaces", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  mkdirSync(join(a.local, "nested"));
  writeFileSync(join(a.local, "note.md"), "# alpha note\n");
  writeFileSync(join(a.local, "nested", "name with spaces.md"), "spaces in alpha\n");
  writeFileSync(join(b.local, "note.md"), "# bravo note\n");
  await w.local(a, b);

  const alphaNote = await resolved(await w.resolveRoute(A, "local://note.md"));
  assert.equal(alphaNote, join(a.local, "note.md"));
  const spaced = await resolved(await w.resolveRoute(A, "local://nested/name with spaces.md"));
  assert.equal(spaced, join(a.local, "nested", "name with spaces.md"));
  assert.equal(await resolved(await w.resolveRoute(A, "local://nested/name%20with%20spaces.md")), spaced);

  // The viewer's reads of that tab: text, meta and download all carry the file's real bytes.
  const text = await w.read(alphaNote, A);
  assert.equal(text.status, 200);
  assert.deepEqual(await text.json(), { content: "# alpha note\n", language: "markdown", size: 13 });
  assert.equal((await (await w.read(spaced, A)).json()).content, "spaces in alpha\n");
  const meta = await w.read(alphaNote, A, "meta");
  assert.equal((await meta.json()).size, 13);
  const download = await w.read(alphaNote, A, "download");
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "# alpha note\n");

  // Another session's `note.md` is its own file: the session decides the root, never the tab being viewed.
  const bravoNote = await resolved(await w.resolveRoute(B, "local://note.md"));
  assert.equal(bravoNote, join(b.local, "note.md"));
  assert.equal((await (await w.read(bravoNote, B)).json()).content, "# bravo note\n");
});

test("a session's tab reads only its own local directory", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  writeFileSync(join(b.local, "note.md"), "bravo\n");
  await w.local(a, b);

  // B's absolute path under A's session id, under no session id, under a session that does not exist: all denied.
  for (const sessionId of [A, undefined, UNKNOWN, "not-a-session-id"]) {
    assert.equal((await w.read(join(b.local, "note.md"), sessionId)).status, 403, `session ${sessionId}`);
  }
  // The directory itself is not a listing target for a session id: it only authorizes reads.
  assert.equal((await w.read(a.local, A, "list")).status, 403);
  // Another session's root is not selectable by name from this one's `local://`.
  const selector = `local://../../${b.file.split("/").pop().replace(".jsonl", "")}/local/note.md`;
  await refused(await w.resolveRoute(A, selector), 400, "invalid_local_uri");
});

test("an absent artifact is a not-found, never a workspace or another session's file", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(w.workspace, "absent.md"), "workspace copy\n");
  writeFileSync(join(b.local, "absent.md"), "bravo copy\n");
  await w.local(a, b);

  // Resolving needs no artifact on disk; the viewer's own read says what is missing.
  const path = await resolved(await w.resolveRoute(A, "local://absent.md"));
  assert.equal(path, join(a.local, "absent.md"));
  const missing = await w.read(path, A);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Not found", code: "file_not_found" });

  await refused(await w.resolveRoute(UNKNOWN, "local://absent.md"), 404, "session_not_found");
  await refused(await w.resolveRoute("not-a-session-id", "local://absent.md"), 404, "session_not_found");
});

test("refuses malformed requests and every URL that is not a local:// file", async (t) => {
  const w = world(t);
  const a = w.session(A);
  await w.local(a);
  await refused(await w.resolveRoute(A, undefined), 400, "invalid_local_uri");
  for (const uri of ["skill://x/SKILL.md", "/etc/passwd", "note.md", "file:///etc/passwd", "local://", "local://%E0%A4%A"]) {
    await refused(await w.resolveRoute(A, uri), 400, "invalid_local_uri");
  }
});

test("traversal, absolute suffixes and encoded escapes never leave the session's local root", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(a.local, "..", "sibling.md"), "outside the local root\n");
  writeFileSync(join(a.local, "inside.md"), "inside\n");
  await w.local(a);

  for (const uri of [
    "local://../sibling.md",
    "local://a/../../sibling.md",
    "local://%2e%2e/sibling.md",
    "local://..%2fsibling.md",
    "local://%252e%252e/sibling.md",
    "local://..%5Csibling.md",
    "local://a\\..\\..\\sibling.md",
    "local://%2Fetc%2Fpasswd",
    "local:///%2Fetc/passwd",
    "local://C:%5CWindows%5Cwin.ini",
    "local://C:/Windows/win.ini",
    "local://%5Cserver%5Cshare%5Cf",
    "local://x%00.md",
  ]) {
    await refused(await w.resolveRoute(A, uri), 400, "invalid_local_uri");
  }
  // omp's `local:///etc/passwd` names `etc/passwd` under the root, not the system file.
  const inRoot = await resolved(await w.resolveRoute(A, "local:///etc/passwd"));
  assert.equal(inRoot, join(a.local, "etc", "passwd"));
  assert.equal((await w.read(inRoot, A)).status, 404);
});

test("a symlink out of the local root is refused at resolve time and on every read", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const outside = join(w.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  writeFileSync(join(a.local, "real.md"), "real\n");
  symlinkSync(join(outside, "secret.txt"), join(a.local, "link-out.md"));
  symlinkSync(outside, join(a.local, "linkdir"));
  symlinkSync(join(a.local, "real.md"), join(a.local, "link-in.md"));
  symlinkSync(join(outside, "later.txt"), join(a.local, "dangling.md"));
  await w.local(a);

  await refused(await w.resolveRoute(A, "local://link-out.md"), 403, "access_denied");
  await refused(await w.resolveRoute(A, "local://linkdir/secret.txt"), 403, "access_denied");
  // A link that stays inside the root is just another file.
  const inner = await resolved(await w.resolveRoute(A, "local://link-in.md"));
  assert.equal((await (await w.read(inner, A)).json()).content, "real\n");

  // The gate confines the tab's own reads too: knowing the absolute path of a link is not enough.
  assert.equal((await w.read(join(a.local, "link-out.md"), A)).status, 403);
  assert.equal((await w.read(join(a.local, "linkdir", "secret.txt"), A, "download")).status, 403);
  // A dangling link resolves (nothing is stat'ed) and reads as not found, until its target appears outside the root.
  const dangling = await resolved(await w.resolveRoute(A, "local://dangling.md"));
  assert.equal((await w.read(dangling, A)).status, 404);
  writeFileSync(join(outside, "later.txt"), "appeared later\n");
  assert.equal((await w.read(dangling, A)).status, 403);
});

test("omp's credential files stay unreadable even in a local directory under the agent dir", async (t) => {
  const w = world(t);
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  writeFileSync(join(a.local, "agent.db"), "api keys\n");
  writeFileSync(join(a.local, "plain.md"), "plain\n");
  await w.local(a);

  const credentials = await resolved(await w.resolveRoute(A, "local://agent.db"));
  assert.equal((await w.read(credentials, A)).status, 403);
  assert.equal((await w.read(credentials, A, "download")).status, 403);
  // The same directory still opens ordinary artifacts.
  assert.equal((await (await w.read(await resolved(await w.resolveRoute(A, "local://plain.md")), A)).json()).content, "plain\n");
});

test("a session on a remote host is refused, never answered from this machine's disk", async (t) => {
  const w = world(t);
  const r = w.session(R);
  // The path happens to exist here: it must still not be read, because the session's files are on its own host.
  writeFileSync(join(r.local, "note.md"), "this machine's namesake\n");
  await w.local();
  await w.remote("Build box", r);

  const body = await refused(await w.resolveRoute(R, "local://note.md"), 501, "remote_host_unsupported");
  assert.match(body.error, /Build box/);
  assert.equal((await w.read(join(r.local, "note.md"), R)).status, 403);
});

test("the session file's own platform rules decide the local root, Windows temp fallback included", async (t) => {
  const w = world(t);
  const id = randomUUID();
  // A root of 180 characters or more is moved to <tmp>/omp-local/<session id> on Windows, as omp does.
  const long = w.session(id, { name: `2026-01-01_${"x".repeat(160)}` });
  const fallback = join(tmpdir(), "omp-local", id);
  mkdirSync(fallback, { recursive: true });
  w.cleanups.push(() => rmSync(fallback, { recursive: true, force: true }));
  writeFileSync(join(fallback, "note.md"), "from the short root\n");
  writeFileSync(join(long.local, "note.md"), "from the long root\n");
  await w.local(long);

  const onWindows = await asPlatform("win32", async () => {
    const path = await resolved(await w.resolveRoute(id, "local://note.md"));
    return { path, body: await (await w.read(path, id)).json() };
  });
  assert.equal(onWindows.path, join(fallback, "note.md"));
  assert.equal(onWindows.body.content, "from the short root\n");
  // Anywhere else the artifact directory beside the session file is the root.
  const onLinux = await resolved(await w.resolveRoute(id, "local://note.md"));
  assert.equal(onLinux, join(long.local, "note.md"));
});

test("ordinary absolute and workspace-relative opens behave as before", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(w.workspace, "README.md"), "workspace readme\n");
  await w.local(a);

  // Inside an allowed root: with or without a session id.
  for (const sessionId of [undefined, A]) {
    const absolute = await w.read(join(w.workspace, "README.md"), sessionId);
    assert.equal(absolute.status, 200);
    assert.equal((await absolute.json()).content, "workspace readme\n");
  }
  // A bare workspace path still fans out over the allowed roots.
  const relative = await filesRoute(
    new Request(`http://localhost/api/files/README.md?type=read&sessionId=${A}`),
    { params: Promise.resolve({ path: ["README.md"] }), disableIdleTimeout() {} },
  );
  assert.equal((await relative.json()).content, "workspace readme\n");
  // Outside every root, and no session's local directory: still a 403.
  assert.equal((await w.read(join(w.base, "agent-less-file.txt"), A)).status, 403);
  assert.equal((await w.read("/etc/passwd", A)).status, 403);
  // `local:` is no scheme the generic file API knows: its mangled form never selects a file.
  const mangled = await filesRoute(
    new Request(`http://localhost/api/files/local%3A/note.md?type=read&sessionId=${A}`),
    { params: Promise.resolve({ path: ["local:", "note.md"] }), disableIdleTimeout() {} },
  );
  assert.equal(mangled.status, 403);
});

test("the host tool resolves a local:// file for the session that asked, whichever session is viewed", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  const r = w.session(R);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  writeFileSync(join(b.local, "note.md"), "bravo\n");
  await w.local(a, b);
  await w.remote("Build box", r);
  const { runHostTool } = await import("../hooks/useAgentSession-stream.ts");

  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push(String(input));
    const url = new URL(String(input), "http://localhost");
    const [, , , id] = url.pathname.split("/");
    const { GET } = await import("../app/api/sessions/[id]/local-file/route.ts");
    return GET(new Request(url, init), { params: Promise.resolve({ id }) });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const opened = [];
  const handlers = { openUrl: () => "", openFile: (path, name) => { opened.push([path, name]); } };
  const ask = (sessionId, path) => runHostTool("open_file", { path }, handlers, sessionId);

  // The originating session's id travels with the request: B asks while A may be the one on screen.
  assert.deepEqual(await ask(B, "local://note.md"), { text: "Opened local://note.md", isError: false });
  assert.deepEqual(await ask(A, "local://note.md"), { text: "Opened local://note.md", isError: false });
  assert.deepEqual(opened, [[join(b.local, "note.md"), "note.md"], [join(a.local, "note.md"), "note.md"]]);
  assert.deepEqual(requests.map((url) => url.split("/")[3]), [B, A]);

  // Every failure reaches the agent as an error result and opens no tab.
  opened.length = 0;
  for (const [sessionId, path, message] of [
    [UNKNOWN, "local://note.md", /session/i],
    [R, "local://note.md", /Build box/],
    [A, "local://../note.md", /traversal|\.\./i],
    [undefined, "local://note.md", /session/i],
  ]) {
    const result = await ask(sessionId, path);
    assert.equal(result.isError, true, `${sessionId} ${path}`);
    assert.match(result.text, message);
  }
  assert.deepEqual(opened, []);

  // Anything else goes to the handler untouched, with no lookup.
  requests.length = 0;
  assert.equal((await ask(A, "/abs/path/readme.md")).isError, false);
  assert.equal((await ask(A, "docs/readme.md")).isError, false);
  assert.equal((await ask(A, "skill://x/SKILL.md")).isError, false);
  assert.deepEqual(opened.map(([path]) => path), ["/abs/path/readme.md", "docs/readme.md", "skill://x/SKILL.md"]);
  assert.deepEqual(requests, []);
});

test("a live session names its local directory from its own session file, before any daemon list has it", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(a.local, "draft.md"), "live draft\n");
  await w.local();
  const local = hub.getHost("local");
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(A, { isAlive: () => true, host: local, sessionFile: a.file, sessionId: A });
  t.after(() => globalThis.__ompSessions.delete(A));

  const path = await resolved(await w.resolveRoute(A, "local://draft.md"));
  assert.equal(path, join(a.local, "draft.md"));
  assert.equal((await (await w.read(path, A)).json()).content, "live draft\n");
  // A live session of another host is still that host's, wherever the list is silent.
  globalThis.__ompSessions.set(R, { isAlive: () => true, host: { id: "remote-1", label: "Build box" }, sessionFile: a.file, sessionId: R });
  t.after(() => globalThis.__ompSessions.delete(R));
  await refused(await w.resolveRoute(R, "local://draft.md"), 501, "remote_host_unsupported");
});
