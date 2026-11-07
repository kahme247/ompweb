// open_file with a `local://` URL: the owning session's own file, resolved by the daemon of the host that holds it
// (GET /api/sessions/[id]/local-file -> WorkspaceOps.resolveLocalFile), then read, downloaded and watched through the one
// file gate (GET /api/files, the file channel) like any absolute path. These drive the real route handlers over a link to
// the real daemon workspace service; sessions are real JSONL files the daemon's own list and path cache know, and a
// daemon without the op is a hand-driven old link. The host-ownership proof over a separate Node daemon process is
// lib/hosts/session-local-files.integration.test.mjs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { linkHost, linkLocalDaemon, linkLocalHost } from "./hosts/link-driver.test-helper.mjs";

/** A directory link that needs no privilege on Windows, as in lib/file-access.test.mjs. */
const DIR_LINK = process.platform === "win32" ? "junction" : "dir";

const hub = await import("./hosts/hub.ts");
const { sessionOps } = await import("./hosts/session-ops.ts");
const { grantWorkspaceRoot, invalidateWorkspaceRoots } = await import("./hosts/workspace-roots.ts");
const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await import("./session-reader.ts");
const { encodeFilePathForApi, filePathApiSegments, getFileApiUrl } = await import("./file-paths.ts");
const { GET: filesRoute } = await import("../app/api/files/[...path]/route.ts");

const A = "11111111-2222-4333-8444-5555555555aa";
const B = "11111111-2222-4333-8444-5555555555bb";
const R = "11111111-2222-4333-8444-5555555555cc";
const UNKNOWN = "11111111-2222-4333-8444-5555555555dd";

/** Each test's own agent dir, workspace and custom session dir. The custom sessions live outside the agent dir, so no
 * allowed root covers their `local/` directories: only a session's own local-root admission can read them. */
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
    invalidateWorkspaceRoots();
    for (const id of [A, B, R, UNKNOWN]) invalidateSessionPathCache(id);
  };
  reset();
  // The workspace is a root the daemon's user selected, as the daemon's validateCwd records it.
  grantWorkspaceRoot(workspace);
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

  /** A session whose file `<dir>/<name>.jsonl` (a real header and first message) has omp's artifact directory
   * `<dir>/<name>/local/`. Under `<agent dir>/sessions` the daemon's own list finds it; anywhere else it is a session omp
   * resumed from a custom path, which the daemon knows only through its path cache and listing (`custom`). */
  const session = (id, { dir = join(base, "custom-sessions", "-proj"), name = `2026-01-01_${id.slice(-2)}` } = {}) => {
    const file = join(dir, `${name}.jsonl`);
    const local = join(dir, name, "local");
    mkdirSync(local, { recursive: true });
    writeFileSync(file, [
      { type: "session", version: 3, id, cwd: workspace, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hi" } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
    return {
      id,
      file,
      local,
      custom: !dir.startsWith(join(agentDir, "sessions")),
      entry: { path: file, id, cwd: workspace, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 1, firstMessage: "hi" },
    };
  };
  /** This machine's real daemon workspace service on the current agent dir. */
  const daemon = async (...sessions) => {
    const custom = sessions.filter((s) => s.custom);
    for (const s of custom) cacheSessionPath(s.id, s.file);
    const link = await linkLocalDaemon({ listSessions: async () => [...await sessionOps.listSessions(), ...custom.map((s) => s.entry)] });
    links.push(link);
    return link;
  };
  /** A daemon from before resolveLocalFile: it lists sessions and has no workspace ops. */
  const old = (link, sessions) => {
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
  /** A running omp wrapper for `id`, as main's registry holds it: its host and the session file it reported. */
  const live = (id, sessionFile, { sessionId = id, host = hub.getHost("local"), aliases = [] } = {}) => {
    globalThis.__ompSessions ??= new Map();
    const wrapper = { isAlive: () => true, host, sessionFile, sessionId };
    for (const key of [id, ...aliases]) {
      globalThis.__ompSessions.set(key, wrapper);
      t.after(() => globalThis.__ompSessions.delete(key));
    }
  };
  return {
    base,
    agentDir,
    workspace,
    session,
    resolveRoute,
    read,
    live,
    cleanups,
    local: daemon,
    oldLocal: async (...sessions) => old(await linkLocalHost(), sessions),
    remote: async (label, ...sessions) => old(await linkHost(label), sessions),
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
  // The answer is never cached: it names a file that can appear, vanish or move.
  assert.equal((await w.resolveRoute(A, "local://note.md")).headers.get("cache-control"), "no-store");

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

test("an absolute session artifact wins over a workspace file mirroring its pathname", { skip: process.platform === "win32" }, async (t) => {
  // Windows drive-qualified requests are never candidates for workspace-relative fallback.
  const w = world(t);
  const a = w.session(A);
  const artifact = join(a.local, "note.md");
  const decoy = join(w.workspace, ...filePathApiSegments(artifact));
  mkdirSync(dirname(decoy), { recursive: true });
  writeFileSync(artifact, "owning session artifact\n");
  writeFileSync(decoy, "wrong workspace file\n");
  await w.local(a);

  assert.equal(await resolved(await w.resolveRoute(A, "local://note.md")), artifact);
  assert.equal((await (await w.read(artifact, A)).json()).content, "owning session artifact\n");
  assert.equal(await (await w.read(artifact, A, "download")).text(), "owning session artifact\n");
  rmSync(artifact);
  await refused(await w.read(artifact, A), 404, "file_not_found");
});

test("a session's tab reads only its own local directory", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  writeFileSync(join(b.local, "note.md"), "bravo\n");
  await w.local(a, b);

  // B's absolute path under A's session id, or under none: denied by the daemon's own gate. A session no host has is
  // not found before any file is looked at.
  for (const [sessionId, status] of [[A, 403], [undefined, 403], [UNKNOWN, 404], ["not-a-session-id", 404]]) {
    assert.equal((await w.read(join(b.local, "note.md"), sessionId)).status, status, `session ${sessionId}`);
  }
  // The directory itself is not a listing target for a session id: it only authorizes reads.
  assert.equal((await w.read(a.local, A, "list")).status, 403);
  // Another session's root is not selectable by name from this one's `local://`.
  const selector = `local://../../${b.file.split("/").pop().replace(".jsonl", "")}/local/note.md`;
  await refused(await w.resolveRoute(A, selector), 400, "invalid_local_uri");
});

test("an absent artifact is an explicit not-found, never a workspace or another session's file", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(w.workspace, "absent.md"), "workspace copy\n");
  writeFileSync(join(b.local, "absent.md"), "bravo copy\n");
  await w.local(a, b);

  // The agent hears about it at resolve time, not only from the viewer tab it would have opened.
  const body = await refused(await w.resolveRoute(A, "local://absent.md"), 404, "file_not_found");
  assert.match(body.error, /not found/i);
  assert.equal(body.path, undefined, "no path is handed out for a file that is not there");
  await refused(await w.resolveRoute(A, "local://nested/absent.md"), 404, "file_not_found");
  // The absolute path still reads as the gate's own 404 for a tab that already exists.
  const missing = await w.read(join(a.local, "absent.md"), A);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "file_not_found");

  await refused(await w.resolveRoute(UNKNOWN, "local://absent.md"), 404, "session_not_found");
  await refused(await w.resolveRoute("not-a-session-id", "local://absent.md"), 404, "session_not_found");
});

test("a session that never wrote a local file has no local directory: not found, not forbidden", async (t) => {
  const w = world(t);
  const a = w.session(A);
  rmSync(a.local, { recursive: true });
  await w.local(a);
  await refused(await w.resolveRoute(A, "local://note.md"), 404, "file_not_found");
  await refused(await w.resolveRoute(A, "local://nested/note.md"), 404, "file_not_found");
});

test("a path through a file is not found, not forbidden", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  await w.local(a);
  await refused(await w.resolveRoute(A, "local://note.md/x"), 404, "file_not_found");
});

test("a directory is not a file to open: refused when the path is resolved, before any tab", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const outside = join(w.base, "outside");
  mkdirSync(outside);
  mkdirSync(join(a.local, "nested"));
  writeFileSync(join(a.local, "nested", "n.md"), "nested\n");
  symlinkSync(join(a.local, "nested"), join(a.local, "dir-in"), DIR_LINK);
  symlinkSync(outside, join(a.local, "dir-out"), DIR_LINK);
  await w.local(a);

  for (const uri of ["local://nested", "local://nested/", "local://.", "local://dir-in"]) {
    const body = await refused(await w.resolveRoute(A, uri), 400, "not_a_file");
    assert.match(body.error, /not a file/i, uri);
    assert.equal(body.path, undefined, `${uri} hands out no path`);
  }
  // Permission is decided first: a directory link out of the root is refused like a file link out of it.
  await refused(await w.resolveRoute(A, "local://dir-out"), 403, "access_denied");
  // The files inside still open.
  assert.equal(await resolved(await w.resolveRoute(A, "local://nested/n.md")), join(a.local, "nested", "n.md"));
  assert.equal(await resolved(await w.resolveRoute(A, "local://dir-in/n.md")), join(a.local, "dir-in", "n.md"));
});

test("the file panel's Download link carries the tab's session id, so a local:// artifact downloads", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const b = w.session(B);
  writeFileSync(join(a.local, "note.md"), "# alpha note\n");
  await w.local(a, b);
  const path = await resolved(await w.resolveRoute(A, "local://note.md"));
  const download = (url) => filesRoute(
    new Request(`http://localhost${url}`),
    { params: Promise.resolve({ path: filePathApiSegments(path) }), disableIdleTimeout() {} },
  );

  const own = await download(getFileApiUrl(path, "download", "local", A));
  assert.equal(own.status, 200);
  assert.equal(await own.text(), "# alpha note\n");
  // Without the id, or with another session's, the artifact lies outside every root that session may read.
  assert.equal((await download(getFileApiUrl(path, "download", "local", undefined))).status, 403);
  assert.equal((await download(getFileApiUrl(path, "download", "local", B))).status, 403);
});

test("with this machine's daemon unreachable, nothing is answered from main's disk", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  // No daemon is linked: the session's host is unknown, so its files cannot be named, resolved or read.
  await refused(await w.resolveRoute(A, "local://note.md"), 503, "host_offline");
  await refused(await w.read(join(a.local, "note.md"), A), 503, "host_offline");
  await refused(await w.read(join(a.local, "note.md"), undefined), 503, "host_offline");
  // A URL that is no local:// file is refused before any host is asked.
  await refused(await w.resolveRoute(A, "/etc/passwd"), 400, "invalid_local_uri");
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
    "local://..%5Csibling.md",
    "local://a\\..\\..\\sibling.md",
    "local://%2Fetc%2Fpasswd",
    "local:///%2Fetc/passwd",
    "local://%5Cserver%5Cshare%5Cf",
    "local://x%00.md",
  ]) {
    await refused(await w.resolveRoute(A, uri), 400, "invalid_local_uri");
  }
  // A drive letter is an absolute suffix only where Windows would resolve it as one.
  await asPlatform("win32", async () => {
    for (const uri of ["local://C:%5CWindows%5Cwin.ini", "local://C:/Windows/win.ini", "local://c:win.ini"]) {
      await refused(await w.resolveRoute(A, uri), 400, "invalid_local_uri");
    }
  });
  // A double-encoded dot segment is a literal directory name, as in omp 18.15: it stays inside the root.
  mkdirSync(join(a.local, "%2e%2e"));
  writeFileSync(join(a.local, "%2e%2e", "sibling.md"), "inside a literal directory\n");
  const literal = await resolved(await w.resolveRoute(A, "local://%252e%252e/sibling.md"));
  assert.equal(literal, join(a.local, "%2e%2e", "sibling.md"));
  assert.equal((await (await w.read(literal, A)).json()).content, "inside a literal directory\n");
  // omp's `local:///etc/passwd` names `etc/passwd` under the root, not the system file.
  await refused(await w.resolveRoute(A, "local:///etc/passwd"), 404, "file_not_found");
  mkdirSync(join(a.local, "etc"));
  writeFileSync(join(a.local, "etc", "passwd"), "not the system file\n");
  const inRoot = await resolved(await w.resolveRoute(A, "local:///etc/passwd"));
  assert.equal(inRoot, join(a.local, "etc", "passwd"));
  assert.equal((await (await w.read(inRoot, A)).json()).content, "not the system file\n");
  // A percent in the name is a percent (omp 18.3.1+), not a second decoding.
  writeFileSync(join(a.local, "100%.md"), "a hundred percent\n");
  writeFileSync(join(a.local, "100%25.md"), "the other file\n");
  assert.equal(await resolved(await w.resolveRoute(A, "local://100%25.md")), join(a.local, "100%.md"));
  assert.equal(await resolved(await w.resolveRoute(A, "local://100%2525.md")), join(a.local, "100%25.md"));
  // A colon is an ordinary character in a POSIX file name (NTFS cannot hold one, and Windows reads `a:` as a drive).
  if (process.platform !== "win32") {
    writeFileSync(join(a.local, "a:1.md"), "colon\n");
    assert.equal(await resolved(await w.resolveRoute(A, "local://a:1.md")), join(a.local, "a:1.md"));
  }
  // A query or fragment after a nested path is not part of the name.
  mkdirSync(join(a.local, "dir"));
  writeFileSync(join(a.local, "dir", "n.md"), "nested\n");
  assert.equal(await resolved(await w.resolveRoute(A, "local://dir/n.md?x=1")), join(a.local, "dir", "n.md"));
});

test("a symlink out of the local root is refused at resolve time and on every read", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const outside = join(w.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  writeFileSync(join(a.local, "real.md"), "real\n");
  symlinkSync(join(outside, "secret.txt"), join(a.local, "link-out.md"));
  symlinkSync(outside, join(a.local, "linkdir"), DIR_LINK);
  symlinkSync(join(a.local, "real.md"), join(a.local, "link-in.md"));
  symlinkSync(join(outside, "later.txt"), join(a.local, "dangling.md"));
  symlinkSync("loop-b", join(a.local, "loop-a"));
  symlinkSync("loop-a", join(a.local, "loop-b"));
  await w.local(a);

  await refused(await w.resolveRoute(A, "local://link-out.md"), 403, "access_denied");
  await refused(await w.resolveRoute(A, "local://linkdir/secret.txt"), 403, "access_denied");
  // A link that stays inside the root is just another file.
  const inner = await resolved(await w.resolveRoute(A, "local://link-in.md"));
  assert.equal((await (await w.read(inner, A)).json()).content, "real\n");

  // The gate confines the tab's own reads too: knowing the absolute path of a link is not enough.
  assert.equal((await w.read(join(a.local, "link-out.md"), A)).status, 403);
  assert.equal((await w.read(join(a.local, "linkdir", "secret.txt"), A, "download")).status, 403);
  // A dangling link is not found; once its target appears outside the root it is refused.
  await refused(await w.resolveRoute(A, "local://dangling.md"), 404, "file_not_found");
  assert.equal((await w.read(join(a.local, "dangling.md"), A)).status, 404);
  writeFileSync(join(outside, "later.txt"), "appeared later\n");
  await refused(await w.resolveRoute(A, "local://dangling.md"), 403, "access_denied");
  assert.equal((await w.read(join(a.local, "dangling.md"), A)).status, 403);
  // A link loop cannot be shown to stay inside the root.
  await refused(await w.resolveRoute(A, "local://loop-a"), 403, "access_denied");
});

test("a tab opened for a session keeps that session's confinement after a later move to a new id", async (t) => {
  const w = world(t);
  const dir = join(w.agentDir, "sessions", "-proj");
  const a = w.session(A, { dir });
  const b = w.session(B, { dir });
  // Under the agent directory, so the broad agent-root allow-list would admit it if confinement were skipped.
  writeFileSync(join(w.agentDir, "notes.md"), "elsewhere in the agent dir\n");
  writeFileSync(join(a.local, "real.md"), "real\n");
  symlinkSync(join(w.agentDir, "notes.md"), join(a.local, "link-out.md"));
  await w.local(a, b);
  // The tab was created for A; omp then moved the live conversation to B and kept A as an alias.
  w.live(B, b.file, { aliases: [A] });
  assert.equal((await (await w.read(join(a.local, "real.md"), A)).json()).content, "real\n");
  assert.equal((await w.read(join(a.local, "link-out.md"), A)).status, 403, "A's root still confines A's tab");
  assert.equal((await w.read(join(a.local, "link-out.md"), A, "download")).status, 403);
});

test("a local root that cannot be canonicalized refuses the lookup instead of skipping confinement", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const outside = join(w.base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  symlinkSync(join(outside, "secret.txt"), join(a.local, "link-out.md"));
  await w.local(a);
  const { mockBuiltin } = await import("../tests/mock-builtin.mjs");
  // Captured before mocking: the module namespace would hand back the fake.
  const realRealpath = realpathSync;
  const realNative = realpathSync.native;
  const root = realRealpath(a.local);
  let injected = 0;
  await mockBuiltin(t, "node:fs", {
    realpathSync: Object.assign((file, ...args) => {
      // One transient failure on the root itself; every other path resolves normally.
      if ((file === a.local || file === root) && injected++ === 0) throw Object.assign(new Error("transient"), { code: "EIO" });
      return realRealpath(file, ...args);
    }, { native: realNative }),
  });
  const { resolveSessionLocalFile } = await import("./session-local-files.ts?fresh=root-eio");
  const result = await resolveSessionLocalFile(A, "link-out.md", null);
  assert.equal(injected > 0, true, "the root failure must be exercised");
  assert.deepEqual(result.ok ? { ok: true } : { ok: false, status: result.status }, { ok: false, status: 503 });
  // A missing root still means there is nothing to escape: absence is not a failure.
  const gone = await resolveSessionLocalFile(A, "missing.md", null);
  assert.equal(gone.ok, false);
});

test("a default-layout artifact remains confined after a completed symlink replacement", async (t) => {
  const w = world(t);
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  const artifact = join(a.local, "draft.md");
  const outside = join(w.agentDir, "outside.md");
  writeFileSync(artifact, "session draft\n");
  writeFileSync(outside, "outside session local root\n");
  await w.local(a);
  assert.equal(await resolved(await w.resolveRoute(A, "local://draft.md")), artifact);
  assert.equal(await (await w.read(artifact, A, "download")).text(), "session draft\n");

  rmSync(artifact);
  symlinkSync(outside, artifact);
  await refused(await w.resolveRoute(A, "local://draft.md"), 403, "access_denied");
  for (const type of ["read", "download", "meta"]) {
    await refused(await w.read(artifact, A, type), 403, "access_denied");
  }
});

test("a credential-named session artifact is not omp's own credential store", async (t) => {
  const w = world(t);
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  writeFileSync(join(a.local, "agent.db"), "artifact bytes\n");
  writeFileSync(join(a.local, "plain.md"), "plain\n");
  await w.local(a);

  const artifact = await resolved(await w.resolveRoute(A, "local://agent.db"));
  assert.equal((await w.read(artifact, A)).status, 200);
  assert.equal(await (await w.read(artifact, A, "download")).text(), "artifact bytes\n");
  // The same directory still opens ordinary artifacts.
  assert.equal((await (await w.read(await resolved(await w.resolveRoute(A, "local://plain.md")), A)).json()).content, "plain\n");
});

test("a local directory that links to the agent dir still cannot hand out credentials", async (t) => {
  const w = world(t);
  const a = w.session(A);
  rmSync(a.local, { recursive: true });
  symlinkSync(w.agentDir, a.local, DIR_LINK);
  writeFileSync(join(w.agentDir, "agent.db"), "api keys\n");
  writeFileSync(join(w.agentDir, "models.yml"), "apiKey: secret\n");
  writeFileSync(join(w.agentDir, "notes.md"), "plain agent note\n");
  // The same hole with no local directory involved: a workspace file that is a link to a credential file.
  symlinkSync(join(w.agentDir, "agent.db"), join(w.workspace, "innocent.txt"));
  await w.local(a);

  for (const name of ["agent.db", "models.yml"]) {
    await refused(await w.resolveRoute(A, `local://${name}`), 403, "access_denied");
    const path = join(a.local, name);
    assert.equal((await w.read(path, A)).status, 403, `${name} read`);
    assert.equal((await w.read(path, A, "download")).status, 403, `${name} download`);
  }
  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A)).status, 403);
  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A, "download")).status, 403);
  // The directory is not blanket-denied: an ordinary artifact there still opens.
  const notes = await resolved(await w.resolveRoute(A, "local://notes.md"));
  assert.equal((await (await w.read(notes, A)).json()).content, "plain agent note\n");
});

test("a credential file is refused by its real path when the agent dir itself is a link", async (t) => {
  const w = world(t);
  const a = w.session(A);
  // omp's agent dir is reached through a link, as `~/.omp/agent` is on a machine that keeps its settings elsewhere.
  const realAgent = join(w.base, "real-agent");
  mkdirSync(realAgent);
  symlinkSync(realAgent, join(w.base, "agent-link"), DIR_LINK);
  process.env.PI_CODING_AGENT_DIR = join(w.base, "agent-link"); // world() restores the previous value
  globalThis.__piAllowedRootsCache = undefined;
  invalidateWorkspaceRoots();
  writeFileSync(join(realAgent, "agent.db"), "api keys\n");
  writeFileSync(join(realAgent, "AGENTS.md"), "plain rule file\n");
  // Workspace files that lead to the REAL files: their real paths lie under no config root as named.
  symlinkSync(join(realAgent, "agent.db"), join(w.workspace, "innocent.txt"));
  symlinkSync(join(realAgent, "AGENTS.md"), join(w.workspace, "rules.md"));
  await w.local(a);

  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A)).status, 403);
  assert.equal((await w.read(join(w.workspace, "innocent.txt"), A, "download")).status, 403);
  assert.equal((await w.read(join(w.base, "agent-link", "agent.db"), A)).status, 403);
  // A link to an ordinary file in the same directory still opens.
  assert.equal((await (await w.read(join(w.workspace, "rules.md"), A)).json()).content, "plain rule file\n");
});

test("a daemon without resolveLocalFile is refused, never answered from this machine's disk", async (t) => {
  const w = world(t);
  const a = w.session(A);
  const r = w.session(R);
  // These paths exist on main's disk: they must still not be read, because a session's files belong to its own host.
  writeFileSync(join(a.local, "note.md"), "main's namesake of the local session\n");
  writeFileSync(join(r.local, "note.md"), "main's namesake of the remote session\n");
  await w.oldLocal(a);
  await w.remote("Build box", r);

  await refused(await w.resolveRoute(A, "local://note.md"), 501, "workspace_unsupported");
  const body = await refused(await w.resolveRoute(R, "local://note.md"), 501, "workspace_unsupported");
  assert.match(body.error, /Build box/);
  for (const [path, sessionId] of [[join(a.local, "note.md"), A], [join(r.local, "note.md"), R]]) {
    for (const type of ["read", "download", "meta"]) await refused(await w.read(path, sessionId, type), 501, "workspace_unsupported");
  }
});

test("the daemon validates the wire arguments itself, whatever main sent", async (t) => {
  const w = world(t);
  const a = w.session(A);
  writeFileSync(join(a.local, "note.md"), "alpha\n");
  await w.local(a);
  const { resolveLocalFile } = hub.getHost("local").workspaceOps;
  const failed = (result, status, code) => assert.deepEqual([result.ok, result.status, result.code], [false, status, code]);

  // The URI is parsed again where the file is: main's parse is not the boundary.
  for (const uri of ["local://../note.md", "local://%2e%2e/note.md", "/etc/passwd", "file:///etc/passwd", "local://", "local://x%00.md"]) {
    failed(await resolveLocalFile(A, uri, null), 400, "invalid_local_uri");
  }
  failed(await resolveLocalFile(A, 7, null), 400, "invalid_request");
  failed(await resolveLocalFile(7, "local://note.md", null), 400, "invalid_request");
  failed(await resolveLocalFile(A, "local://note.md", 7), 400, "invalid_request");
  failed(await resolveLocalFile(A, "local://note.md", undefined), 400, "invalid_request");
  failed(await resolveLocalFile("not-a-session-id", "local://note.md", null), 404, "session_not_found");
  failed(await resolveLocalFile(UNKNOWN, "local://note.md", null), 404, "session_not_found");
  // The same call with sound arguments names the file and reads none of it.
  assert.deepEqual(await resolveLocalFile(A, "local://note.md", null), { ok: true, value: { path: join(a.local, "note.md") } });
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
  // Anywhere else the artifact directory beside the session file is the root. (On Windows itself a root this long
  // always takes the temp fallback, so there is no such directory to compare.)
  if (process.platform !== "win32") {
    assert.equal(await resolved(await w.resolveRoute(id, "local://note.md")), join(long.local, "note.md"));
  }
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
    [A, "local://absent.md", /not found/i],
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

test("a live session names its local directory from its own session file, before the daemon's list has it", async (t) => {
  const w = world(t);
  await w.local();
  await sessionOps.listSessions(); // the daemon's list is now cached without the session below
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  writeFileSync(join(a.local, "draft.md"), "live draft\n");
  assert.equal(await sessionOps.listSessions().then((list) => list.some((s) => s.id === A)), false, "the list lags the new file");
  w.live(A, a.file);

  const path = await resolved(await w.resolveRoute(A, "local://draft.md"));
  assert.equal(path, join(a.local, "draft.md"));
  assert.equal((await (await w.read(path, A)).json()).content, "live draft\n");
  assert.equal(await (await w.read(path, A, "download")).text(), "live draft\n");
});

test("a live session's file hint is only a hint: the daemon trusts it only for a file it can vouch for", async (t) => {
  const w = world(t);
  const a = w.session(A, { dir: join(w.agentDir, "sessions", "-proj") });
  const b = w.session(B);
  // C is a custom session the daemon knows, outside every allowed root: only its own id can reach its directory.
  const c = w.session(R);
  for (const s of [a, b, c]) writeFileSync(join(s.local, "note.md"), `${s.id.slice(-2)} artifact\n`);
  await w.local(c);

  // A custom-directory file the daemon has never heard of is not a root source, however the live session names it.
  w.live(B, b.file);
  await refused(await w.resolveRoute(B, "local://note.md"), 404, "session_not_found");
  assert.equal((await w.read(join(b.local, "note.md"), B)).status, 403);
  // Once the daemon knows that file (omp resumed it), the same hint is the file.
  cacheSessionPath(B, b.file);
  assert.equal(await resolved(await w.resolveRoute(B, "local://note.md")), join(b.local, "note.md"));
  assert.equal((await (await w.read(join(b.local, "note.md"), B)).json()).content, "bb artifact\n");

  // A hint that is another session's file (its header names another id) never selects that session's directory.
  w.live(A, c.file);
  const own = await resolved(await w.resolveRoute(A, "local://note.md"));
  assert.equal(own, join(a.local, "note.md"), "the daemon falls back to the file it knows for the id");
  assert.equal((await w.read(join(c.local, "note.md"), A)).status, 403);
  // A hint outside every session file the daemon holds, even one with a matching header, cannot widen the root.
  const elsewhere = join(w.base, "elsewhere", "2026-01-01_aa.jsonl");
  mkdirSync(join(w.base, "elsewhere", "2026-01-01_aa", "local"), { recursive: true });
  writeFileSync(elsewhere, `${JSON.stringify({ type: "session", version: 3, id: A, cwd: w.workspace, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  writeFileSync(join(w.base, "elsewhere", "2026-01-01_aa", "local", "note.md"), "decoy\n");
  w.live(A, elsewhere);
  assert.equal(await resolved(await w.resolveRoute(A, "local://note.md")), join(a.local, "note.md"));
  assert.equal((await w.read(join(w.base, "elsewhere", "2026-01-01_aa", "local", "note.md"), A)).status, 403);
});

test("a live alias resolves Windows temporary artifacts using the current session identity", async (t) => {
  const w = world(t);
  const oldId = randomUUID();
  const newId = randomUUID();
  const live = w.session(newId, { dir: join(w.agentDir, "sessions", "-proj"), name: `2026-01-01_${"x".repeat(160)}` });
  const oldRoot = join(tmpdir(), "omp-local", oldId);
  const newRoot = join(tmpdir(), "omp-local", newId);
  for (const root of [oldRoot, newRoot]) {
    mkdirSync(root, { recursive: true });
    w.cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  }
  writeFileSync(join(oldRoot, "note.md"), "stale source artifact\n");
  writeFileSync(join(newRoot, "note.md"), "current conversation artifact\n");
  await w.local(live);
  w.live(newId, live.file, { aliases: [oldId] });
  await asPlatform("win32", async () => {
    const response = await w.resolveRoute(oldId, "local://note.md");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, join(newRoot, "note.md"), "an old routable ID follows the live conversation's temporary root");
    assert.equal(body.sessionId, newId, "the tab must own the file as the live conversation, not the alias it asked through");
    // The wrapper ends and takes its aliases with it: only the canonical owner still authorizes the tab's reads.
    for (const key of [newId, oldId]) globalThis.__ompSessions.delete(key);
    assert.equal(await (await w.read(body.path, body.sessionId, "download")).text(), "current conversation artifact\n");
  });
});
