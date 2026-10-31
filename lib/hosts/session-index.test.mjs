import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkHost, linkLocalHost, until } from "./link-driver.test-helper.mjs";

const hub = await import("./hub.ts");
const index = await import("./session-index.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");

const SHARED = "11111111-2222-4333-8444-555555555555";
const OTHER = "11111111-2222-4333-8444-666666666666";
const defaultTimings = { ...hub.linkTimings };

/** Own agent dir (so only this test's hosts are registered), optionally with one session file on this machine's disk. */
function setup(t, { localSessionId } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-index-"));
  if (localSessionId) {
    const projectDir = join(agentDir, "sessions", "-project");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      { type: "session", version: 3, id: localSessionId, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
    ];
    writeFileSync(join(projectDir, "2026-01-01_local.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__ompHostLists = undefined;
  invalidateSessionListCache();
  const links = [];
  t.after(() => {
    for (const link of links) hub.closeHostLink(link.id);
    Object.assign(hub.linkTimings, defaultTimings);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  });
  /** Link a host that answers ops from `ops`; a null label links this machine's daemon. */
  return async (label, ops) => {
    const link = label === null ? await linkLocalHost() : await linkHost(label);
    links.push(link);
    link.serve(ops);
    return link;
  };
}

/** A session-list entry as a daemon sends it. */
const entry = (id, extra = {}) => ({
  path: `/remote/sessions/${id}.jsonl`,
  id,
  cwd: "/remote/project",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  firstMessage: "hi",
  ...extra,
});

test("an id on this machine and a remote host is listed once, as local", async (t) => {
  const link = setup(t);
  await link(null, { listSessions: () => [entry(SHARED)] });
  const remote = await link("Remote", { listSessions: () => [entry(SHARED), entry(OTHER)] });
  const sessions = await index.listSessionsAllHosts();
  assert.deepEqual(sessions.map((s) => [s.id, s.hostId]), [[SHARED, "local"], [OTHER, remote.id]]);
  assert.equal((await index.hostForSessionId(SHARED)).id, "local");
  assert.equal((await index.hostForSessionId(OTHER)).id, remote.id);
});

test("this machine's sessions come from its daemon only, never from the files on disk", async (t) => {
  const link = setup(t, { localSessionId: SHARED });
  assert.deepEqual(await index.listSessionsAllHosts(), [], "no daemon linked: nothing is read here");
  // Unknown is not gone: a 404 would make the client drop the session.
  await assert.rejects(index.hostForSessionId(SHARED), (error) => error.status === 503 && error.code === "host_offline" && error.message === "This machine is offline");

  await link(null, { listSessions: () => [entry(SHARED, { cwd: "/srv/app" })] });
  index.invalidateHostSessionList("local");
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => [s.id, s.hostId, s.path]), [[SHARED, "local", `/remote/sessions/${SHARED}.jsonl`]]);
  const host = await index.hostForSessionId(SHARED);
  assert.equal(host, hub.getHost("local"));
  assert.deepEqual(await index.sessionSpawnTarget(SHARED, host), { sessionFile: `/remote/sessions/${SHARED}.jsonl`, cwd: "/srv/app", recordedCwd: "/srv/app" });
});

test("an id no host lists is gone only once this machine's daemon has answered a list", async (t) => {
  const link = setup(t);
  let failing = true;
  await link(null, {
    listSessions: () => {
      if (failing) throw new Error("sessions dir unreadable");
      return [entry(OTHER)];
    },
  });
  await assert.rejects(index.hostForSessionId(SHARED), (error) => error.status === 503, "linked, but its list never arrived");
  failing = false;
  assert.equal(await index.hostForSessionId(SHARED), null);
  assert.equal(await index.hostForSessionId("not-a-session-id"), null, "a malformed id is never anyone's");
});

test("the hand-driven daemon answers a failed op as ompweb host does", async (t) => {
  const link = setup(t);
  const { ProjectPathError } = await import("../project-registry.ts");
  const { HostOpError } = await import("./link-protocol.ts");
  const thrown = { bad: new ProjectPathError("invalid_path", "Not a directory"), gone: new HostOpError(410, "gone", "Gone"), broken: new Error("disk on fire") };
  const remote = await link("Strict", { validateCwd: ({ path }) => { throw thrown[path]; } });
  const { sessionOps } = hub.getHost(remote.id);
  const failure = async (path) => sessionOps.validateCwd(path).then(() => assert.fail("resolved"), ({ status, code, message }) => ({ status, code, message }));
  // Main prefixes the host's label.
  assert.deepEqual(await failure("bad"), { status: 400, code: "invalid_path", message: "Strict: Not a directory" });
  assert.deepEqual(await failure("gone"), { status: 410, code: "gone", message: "Strict: Gone" });
  assert.deepEqual(await failure("broken"), { status: 500, code: "host_op_failed", message: "Strict: disk on fire" });
});

test("a change on this machine's disk drops its list on the daemon and here", async (t) => {
  const link = setup(t);
  let listed = [entry(SHARED)];
  const invalidated = [];
  await link(null, { listSessions: () => listed, invalidateSessionLists: ({ path }) => { invalidated.push(path); return null; } });
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => s.id), [SHARED]);
  listed = [entry(SHARED), entry(OTHER)];
  index.invalidateLocalSessionLists("/s/new.jsonl");
  await until(() => invalidated.length === 1, "the daemon's invalidation");
  assert.deepEqual(invalidated, ["/s/new.jsonl"]);
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => s.id), [SHARED, OTHER]);
});

test("projects list this machine's daemon first, then linked hosts", async (t) => {
  const link = setup(t);
  const remote = await link("Remote", { listProjects: () => [], listSessions: () => [entry(OTHER)] });
  await link(null, { listProjects: () => [{ path: tmpdir(), addedAt: "2026-01-01T00:00:00.000Z", hidden: false }], listSessions: () => [] });
  assert.deepEqual((await index.listProjectsAllHosts()).map((p) => [p.path, p.hostId]), [[tmpdir(), "local"], ["/remote/project", remote.id]]);
});

test("an id on two remote hosts only is listed under the first host by label", async (t) => {
  const link = setup(t);
  await link("b-mac", { listSessions: () => [entry(SHARED)] });
  const aVm = await link("A-vm", { listSessions: () => [entry(SHARED)] });
  const sessions = await index.listSessionsAllHosts();
  assert.deepEqual(sessions.map((s) => [s.id, s.hostId]), [[SHARED, aVm.id]]);
  assert.equal((await index.hostForSessionId(SHARED)).id, aVm.id);
});

test("an offline host keeps its last list", async (t) => {
  hub.linkTimings.offlineMs = 30;
  const link = setup(t);
  const remote = await link("Laptop", { listSessions: () => [entry(OTHER)] });
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => s.id), [OTHER]);
  await remote.drop();
  await until(() => hub.getHost(remote.id).status() === "offline", "the host to go offline");
  index.invalidateHostSessionList(remote.id);
  assert.deepEqual((await index.listSessionsAllHosts()).map((s) => [s.id, s.hostId]), [[OTHER, remote.id]]);
});

test("malformed remote entries are dropped and keep only known fields", async (t) => {
  const link = setup(t);
  const remote = await link("Sloppy", {
    listSessions: () => [entry(OTHER, { hostId: "local", extra: "x" }), entry("../../etc"), { ...entry(SHARED), messageCount: "1" }, null],
  });
  const sessions = await index.listSessionsAllHosts();
  // As the sessions route serializes them.
  assert.deepEqual(JSON.parse(JSON.stringify(sessions)), [{ ...entry(OTHER), hostId: remote.id }]);
});

test("fetchMediaFromHosts skips a host whose bytes do not hash to the requested hash", async (t) => {
  const link = setup(t);
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const hash = createHash("sha256").update(image).digest("hex");
  await link("Liar", { readMedia: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]) });
  assert.equal(await index.fetchMediaFromHosts(hash), null);
  await link("Honest", { readMedia: ({ hash: asked }) => (asked === hash ? image : new Uint8Array()) });
  assert.deepEqual([...await index.fetchMediaFromHosts(hash)], [...image]);
});

test("a route given an unknown hostId answers 404, a host that is not linked 503", async (t) => {
  setup(t);
  const { POST } = await import("../../app/api/cwd/validate/route.ts");
  const { createHost } = await import("./registry.ts");
  const validate = (hostId) => POST(new Request("http://main.test/api/cwd/validate", { method: "POST", body: JSON.stringify({ cwd: "/w", hostId }) }));
  const unknown = await validate("no-such-host");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "host_not_found");
  const { host } = createHost("Asleep");
  const offline = await validate(host.id);
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: "Asleep is offline", code: "host_offline", hostOffline: true, delivery: "refused" });
  // No hostId is this machine: offline like any host until its daemon links.
  const local = await validate(undefined);
  assert.equal(local.status, 503);
  assert.equal((await local.json()).error, "This machine is offline");
  // A command whose link dropped after it was sent may still run there.
  const { apiErrorResponse } = await import("../../lib/api-utils.ts");
  const { WebRpcError } = await import("../../lib/rpc-manager.ts");
  assert.equal((await apiErrorResponse(new WebRpcError("Asleep is offline", "host_offline", "unknown")).json()).delivery, "unknown");
});

test("a remote host's session export is always an attachment, even with inline=1", async (t) => {
  const link = setup(t);
  // Daemon output is untrusted: inline, this HTML would run on main's origin.
  const html = "<script>fetch(\"/api/projects\")</script>";
  await link("Hostile", { listSessions: () => [entry(OTHER)], exportSession: () => ({ ok: true, value: { html, fileName: "x.html" } }) });
  const { GET } = await import("../../app/api/sessions/[id]/export/route.ts");
  const response = await GET(new Request(`http://main.test/api/sessions/${OTHER}/export?inline=1`), { params: Promise.resolve({ id: OTHER }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await response.text(), html);
});
