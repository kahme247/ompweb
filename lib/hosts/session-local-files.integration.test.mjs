// local:// artifacts across real processes: each daemon is a separate Node child with its own home and agent dir, and
// the file is resolved, read and downloaded on the host that owns the session, through the real HTTP routes. Main's own
// agent dir holds a lookalike of every session, so an answer built from main's disk cannot pass for the daemon's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { before, after } from "node:test";
import { workspaceHarness } from "./workspace-test-helper.mjs";

let h, local, owner, other;
before(async () => {
  h = await workspaceHarness();
  local = await h.startHost(true);
  owner = await h.startHost();
  other = await h.startHost();
});
after(async () => h?.close());

/** A session (its real JSONL under `agentDir`'s sessions dir) and its artifact directory with `files`. */
function session(agentDir, cwd, id, files = {}, name = `2026-11-03_${id}`) {
  const dir = join(agentDir, "sessions", "-proj");
  const local = join(dir, name, "local");
  mkdirSync(local, { recursive: true });
  writeFileSync(join(dir, `${name}.jsonl`), [
    { type: "session", version: 3, id, cwd, timestamp: "2026-11-03T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-03T00:00:01.000Z", message: { role: "user", content: "hi" } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  for (const [file, bytes] of Object.entries(files)) writeFileSync(join(local, file), bytes);
  return { id, local };
}
const mainAgentDir = () => join(h.root, "main-agent");
/** The same session id on main's own disk, with a different `note.md`. */
const lookalike = (id) => session(mainAgentDir(), h.root, id, { "note.md": "main's lookalike bytes\n" });
const resolve = (id, uri) => fetch(`${h.url}/api/sessions/${id}/local-file?uri=${encodeURIComponent(uri)}`);
const json = async (response) => ({ status: response.status, ...await response.json() });

test("a local:// file is resolved and read on the host that owns the session, not from main's disk", async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "note.md": "owner bytes\n" });
  const decoy = lookalike(id);
  await owner.host.invalidateSessionLists();

  const answer = await json(await resolve(id, "local://note.md"));
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal(answer.path, join(mine.local, "note.md"));
  assert.notEqual(answer.path, join(decoy.local, "note.md"));

  // The tab's reads follow the session to the same host, named or not.
  const read = await h.file(owner.id, answer.path, "read", { sessionId: id });
  assert.deepEqual(await read.json(), { content: "owner bytes\n", language: "markdown", size: 12 });
  assert.equal(await (await h.file(owner.id, answer.path, "download", { sessionId: id })).text(), "owner bytes\n");
  assert.equal((await (await h.file(owner.id, answer.path, "meta", { sessionId: id })).json()).size, 12);
  const unnamed = await fetch(`${h.url}/api/files/${encodeURIComponent(answer.path)}?type=read&sessionId=${id}`);
  assert.equal((await unnamed.json()).content, "owner bytes\n");
  // Another host is not the session's: it never answers for it.
  assert.equal((await h.file(other.id, answer.path, "read", { sessionId: id })).status, 409);
});

test("two sessions of one host name only their own files", async () => {
  const x = randomUUID();
  const y = randomUUID();
  const sx = session(owner.agentDir, owner.project, x, { "note.md": "x bytes\n" });
  const sy = session(owner.agentDir, owner.project, y, { "note.md": "y bytes\n" });
  await owner.host.invalidateSessionLists();

  const px = (await json(await resolve(x, "local://note.md"))).path;
  const py = (await json(await resolve(y, "local://note.md"))).path;
  assert.deepEqual([px, py], [join(sx.local, "note.md"), join(sy.local, "note.md")]);
  assert.equal((await (await h.file(owner.id, py, "read", { sessionId: y })).json()).content, "y bytes\n");
  assert.equal((await h.file(owner.id, px, "download", { sessionId: x })).status, 200);
  // Another session's root is not selectable by name from this one's local://.
  assert.equal((await json(await resolve(x, "local://../note.md"))).code, "invalid_local_uri");
});

test("this machine's own session is resolved by its daemon process too", async () => {
  const id = randomUUID();
  const mine = session(local.agentDir, local.project, id, { "note.md": "local daemon bytes\n" });
  const decoy = lookalike(id);
  await local.host.invalidateSessionLists();

  const answer = await json(await resolve(id, "local://note.md"));
  assert.equal(answer.status, 200, JSON.stringify(answer));
  assert.equal(answer.path, join(mine.local, "note.md"));
  assert.notEqual(answer.path, join(decoy.local, "note.md"));
  assert.equal((await (await h.file(local.id, answer.path, "read", { sessionId: id })).json()).content, "local daemon bytes\n");
});

test("a Windows main leaves POSIX colon filenames to the owning daemon", { skip: process.platform === "win32" }, async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "a:1.md": "POSIX filename bytes\n" });
  await owner.host.invalidateSessionLists();
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const answer = await json(await resolve(id, "local://a%3A1.md"));
    assert.equal(answer.status, 200, JSON.stringify(answer));
    assert.equal(answer.path, join(mine.local, "a:1.md"));
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("the daemon's answers for a missing file, a directory, a bad URL and an unknown session", async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "note.md": "owner bytes\n" });
  mkdirSync(join(mine.local, "nested"));
  await owner.host.invalidateSessionLists();

  const code = async (id, uri) => { const body = await json(await resolve(id, uri)); return [body.status, body.code]; };
  assert.deepEqual(await code(id, "local://absent.md"), [404, "file_not_found"]);
  assert.deepEqual(await code(id, "local://nested"), [400, "not_a_file"]);
  assert.deepEqual(await code(id, "local://../note.md"), [400, "invalid_local_uri"]);
  assert.deepEqual(await code(id, "/etc/passwd"), [400, "invalid_local_uri"]);
  assert.deepEqual(await code(randomUUID(), "local://note.md"), [404, "session_not_found"]);
  assert.deepEqual(await code("not-a-session-id", "local://note.md"), [404, "session_not_found"]);
  // A bad URL is refused before any host is asked, even for a session nobody has.
  assert.deepEqual(await code(randomUUID(), "/etc/passwd"), [400, "invalid_local_uri"]);
});

test("a link out of the artifact directory and a link to the credential store are refused on the daemon", async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "note.md": "owner bytes\n" });
  // Inside the agent dir, an allowed root: only the artifact directory's own confinement refuses the link.
  const outside = join(owner.agentDir, "outside.md");
  writeFileSync(outside, "outside the local root\n");
  symlinkSync(outside, join(mine.local, "link-out.md"));
  await owner.host.invalidateSessionLists();

  const escaped = await json(await resolve(id, "local://link-out.md"));
  assert.deepEqual([escaped.status, escaped.code], [403, "access_denied"]);
  assert.equal((await h.file(owner.id, join(mine.local, "link-out.md"), "read", { sessionId: id })).status, 403);

  // The whole artifact directory linked to the agent dir still hands out no credential.
  const linked = session(owner.agentDir, owner.project, randomUUID());
  rmSync(linked.local, { recursive: true });
  symlinkSync(owner.agentDir, linked.local, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(owner.agentDir, "agent.db"), "api keys\n");
  await owner.host.invalidateSessionLists();
  const secret = await json(await resolve(linked.id, "local://agent.db"));
  assert.deepEqual([secret.status, secret.code], [403, "access_denied"]);
  assert.equal((await h.file(owner.id, join(linked.local, "agent.db"), "download", { sessionId: linked.id })).status, 403);
});

test("a daemon without resolveLocalFile is refused, never answered from main's lookalike", async () => {
  const { linkHost, listedSession } = await import("./link-driver.test-helper.mjs");
  const id = randomUUID();
  lookalike(id);
  const older = await linkHost("Old daemon");
  older.serve({ listSessions: () => [listedSession(id)] });
  try {
    const answer = await json(await resolve(id, "local://note.md"));
    assert.deepEqual([answer.status, answer.code], [501, "workspace_unsupported"]);
    assert.equal(answer.path, undefined);
    const read = await h.file(older.id, join(mainAgentDir(), "sessions", "-proj", `2026-11-03_${id}`, "local", "note.md"), "read", { sessionId: id });
    assert.equal(read.status, 501);
  } finally { older.drop(); }
});

test("artifact confinement distinguishes a POSIX backslash root from its slash-spelled namesake", { skip: process.platform === "win32" }, async () => {
  const id = randomUUID();
  const mine = session(owner.agentDir, owner.project, id, { "note.md": "own bytes\n" }, `2026-11-05_${id}\\branch`);
  const outside = mine.local.replace(/\\/g, "/");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "private.md"), "outside bytes\n");
  symlinkSync(join(outside, "private.md"), join(mine.local, "escape.md"));
  await owner.host.invalidateSessionLists();
  const escaped = await json(await resolve(id, "local://escape.md"));
  assert.deepEqual([escaped.status, escaped.code], [403, "access_denied"]);
  const own = await json(await resolve(id, "local://note.md"));
  assert.equal(own.path, join(mine.local, "note.md"));
  assert.equal((await (await h.file(owner.id, own.path, "read", { sessionId: id })).json()).content, "own bytes\n");
});

test("an unknown file hint cannot imitate the sessions root using a literal POSIX backslash", { skip: process.platform === "win32" }, async () => {
  const id = randomUUID();
  const directory = join(`${owner.agentDir}\\sessions`, "project");
  const hint = join(directory, `${id}.jsonl`);
  const artifact = join(directory, id, "local");
  mkdirSync(artifact, { recursive: true });
  writeFileSync(hint, JSON.stringify({ type: "session", version: 3, id, cwd: owner.project }) + "\n");
  writeFileSync(join(artifact, "note.md"), "unowned hint bytes\n");
  const answer = await owner.host.workspaceOps.resolveLocalFile(id, "local://note.md", hint);
  assert.deepEqual([answer.ok, answer.status, answer.code], [false, 404, "session_not_found"]);
});

test("an untrusted daemon cannot resolve an artifact to a relative workspace filename", async () => {
  const { linkHost, listedSession } = await import("./link-driver.test-helper.mjs");
  const id = randomUUID();
  const daemon = await linkHost("Malformed artifact daemon", { hello: { workspaceOps: ["resolveLocalFile"] } });
  void daemon.serve({
    listSessions: () => [listedSession(id)],
    resolveLocalFile: () => ({ ok: true, value: { path: "relative.md" } }),
  });
  try {
    const response = await json(await resolve(id, "local://note.md"));
    assert.deepEqual([response.status, response.code], [502, "host_bad_result"]);
    assert.equal(response.path, undefined);
  } finally { daemon.drop(); }
});
