import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { linkHost, until } from "./link-driver.test-helper.mjs";

const jiti = createJiti(import.meta.url);
const hub = await jiti.import("./hub.ts");
const index = await jiti.import("./session-index.ts");
const { invalidateSessionListCache } = await jiti.import("../session-reader.ts");

const SHARED = "11111111-2222-4333-8444-555555555555";
const OTHER = "11111111-2222-4333-8444-666666666666";
const defaultTimings = { ...hub.linkTimings };

/** Own agent dir (so only this test's hosts are registered), optionally with one local session. */
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
  /** Link a host that answers ops from `ops`. */
  return async (label, ops) => {
    const link = await linkHost(label);
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
  const link = setup(t, { localSessionId: SHARED });
  const remote = await link("Remote", { listSessions: () => [entry(SHARED), entry(OTHER)] });
  const sessions = await index.listSessionsAllHosts();
  assert.deepEqual(sessions.map((s) => [s.id, s.hostId]), [[SHARED, "local"], [OTHER, remote.id]]);
  assert.equal((await index.hostForSessionId(SHARED)).id, "local");
  assert.equal((await index.hostForSessionId(OTHER)).id, remote.id);
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
  const routeJiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": fileURLToPath(new URL("../../", import.meta.url)) } });
  const { POST } = await routeJiti.import("../../app/api/cwd/validate/route.ts");
  const { createHost } = await jiti.import("./registry.ts");
  const validate = (hostId) => POST(new Request("http://main.test/api/cwd/validate", { method: "POST", body: JSON.stringify({ cwd: "/w", hostId }) }));
  const unknown = await validate("no-such-host");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, "host_not_found");
  const { host } = createHost("Asleep");
  const offline = await validate(host.id);
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: "Asleep is offline", code: "host_offline", hostOffline: true, delivery: "refused" });
  // A command whose link dropped after it was sent may still run there.
  const { apiErrorResponse } = await routeJiti.import("../../lib/api-utils.ts");
  const { WebRpcError } = await routeJiti.import("../../lib/rpc-manager.ts");
  assert.equal((await apiErrorResponse(new WebRpcError("Asleep is offline", "host_offline", "unknown")).json()).delivery, "unknown");
});

test("a remote host's session export is always an attachment, even with inline=1", async (t) => {
  const link = setup(t);
  // Daemon output is untrusted: inline, this HTML would run on main's origin.
  const html = "<script>fetch(\"/api/projects\")</script>";
  await link("Hostile", { listSessions: () => [entry(OTHER)], exportSession: () => ({ ok: true, value: { html, fileName: "x.html" } }) });
  const routeJiti = createJiti(import.meta.url, { tryNative: false, alias: { "@/": fileURLToPath(new URL("../../", import.meta.url)) } });
  const { GET } = await routeJiti.import("../../app/api/sessions/[id]/export/route.ts");
  const response = await GET(new Request(`http://main.test/api/sessions/${OTHER}/export?inline=1`), { params: Promise.resolve({ id: OTHER }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await response.text(), html);
});
