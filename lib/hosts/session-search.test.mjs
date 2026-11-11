import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkHost, linkLocalHost, until } from "./link-driver.test-helper.mjs";

const hub = await import("./hub.ts");
const index = await import("./session-index.ts");
const { HostOpError } = await import("./link-protocol.ts");
const { sessionOps } = await import("./session-ops.ts");
const { invalidateSessionListCache } = await import("../session-reader.ts");
const { searchSessionsAllHosts } = await import("./session-search.ts");
const { GET } = await import("../../app/api/sessions/search/route.ts");

const QUERY = '"meteor quartz"';
const sessionId = (n) => `11111111-2222-4333-8444-${String(n).padStart(12, "0")}`;
const defaultTimings = { ...hub.linkTimings };

async function setup(t, count = 6) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-host-search-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const lines = [
      { type: "session", version: 3, id: sessionId(i), cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: `${"ordinary reply ".repeat(1500)}${i === count ? "meteor quartz" : "finished"}` }] } },
    ];
    writeFileSync(join(projectDir, `2026-01-01_${i}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__ompHostLists = undefined;
  invalidateSessionListCache();
  const links = [];
  const calls = [];
  const discovery = [];
  t.after(() => {
    for (const link of links) hub.closeHostLink(link.id);
    hub.flushLinkSamples();
    Object.assign(hub.linkTimings, defaultTimings);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    globalThis.__ompHostLists = undefined;
    invalidateSessionListCache();
    globalThis.__ompSessionContentSearchCache?.clear();
    rmSync(agentDir, { recursive: true, force: true });
  });
  const sessions = (await sessionOps.listSessions()).sort((a, b) => a.id.localeCompare(b.id)).map((session) => ({
    ...session,
    // Only the daemon can resolve these IDs: their listed paths are not main-side files.
    path: `/remote-only/sessions/${session.id}.jsonl`,
  }));
  const link = async (label, listed = sessions, search = (query, ids) => sessionOps.searchSessionBatch(query, ids)) => {
    const remote = label === null ? await linkLocalHost() : await linkHost(label);
    links.push(remote);
    remote.serve({
      listSessions: () => { discovery.push(remote.id); return listed; },
      searchSessionBatch: ({ query, ids }) => {
        calls.push({ hostId: remote.id, query, ids });
        return search(query, ids);
      },
    });
    return remote;
  };
  return { sessions, calls, discovery, link };
}

test("the endpoint scores a remote later-body hit using canonical ownership and four-ID batches", async (t) => {
  const { sessions, calls, link } = await setup(t);
  await link(null, sessions.slice(0, 1));
  const remote = await link("A remote");
  await link("Z duplicate", sessions.slice(-1), () => { throw new Error("duplicate owner searched"); });
  let idleDisabled = false;
  const response = await GET(new Request(`http://main.test/api/sessions/search?q=${encodeURIComponent(QUERY)}`), {
    disableIdleTimeout: () => { idleDisabled = true; },
  });
  const batches = (await response.text()).trim().split("\n").map((line) => JSON.parse(line).scores);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
  assert.equal(idleDisabled, true);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.slice(0, 2), [{}, {}]);
  assert.deepEqual(Object.keys(batches[2]), [sessionId(6)]);
  assert.ok(batches[2][sessionId(6)] > 0);
  assert.deepEqual(calls, [
    { hostId: "local", query: QUERY, ids: [sessionId(1)] },
    { hostId: remote.id, query: QUERY, ids: [sessionId(2), sessionId(3), sessionId(4), sessionId(5)] },
    { hostId: remote.id, query: QUERY, ids: [sessionId(6)] },
  ]);
});

test("a failed batch stops only its host and reports the first error after healthy batches", async (t) => {
  const { sessions, calls, link } = await setup(t, 5);
  const failedSessions = sessions.map((session, i) => ({ ...session, id: sessionId(100 + i) }));
  const failing = await link("A broken", failedSessions, () => ({ ok: false, status: 503, code: "search_unavailable", error: "First host failed" }));
  const old = await link("B old", [{ ...sessions[0], id: sessionId(200) }], () => {
    throw new HostOpError(501, "op_unsupported", "Upgrade daemon");
  });
  const healthy = await link("Z healthy");
  const batches = searchSessionsAllHosts(QUERY);
  assert.deepEqual(await batches.next(), { done: false, value: {} });
  const hit = await batches.next();
  assert.equal(hit.done, false);
  assert.deepEqual(Object.keys(hit.value), [sessionId(5)]);
  assert.ok(hit.value[sessionId(5)] > 0);
  await assert.rejects(batches.next(), (error) => error.code === "search_unavailable" && error.message === "First host failed");
  assert.deepEqual(calls.map(({ hostId, ids }) => [hostId, ids.length]), [
    [failing.id, 4], [old.id, 1], [healthy.id, 4], [healthy.id, 1],
  ]);
});

test("cached sessions on an offline host cannot hide healthy hits or claim a complete scan", async (t) => {
  const { sessions, link } = await setup(t, 1);
  hub.linkTimings.offlineMs = 30;
  const offline = await link("A offline", [{ ...sessions[0], id: sessionId(100) }]);
  await index.listSessionsAllHosts();
  Object.assign(hub.linkTimings, defaultTimings);
  offline.drop();
  await until(() => hub.getHost(offline.id).status() === "offline", "host to go offline");
  await link("Z healthy");
  const batches = searchSessionsAllHosts(QUERY);
  const hit = await batches.next();
  assert.equal(hit.done, false);
  assert.ok(hit.value[sessionId(1)] > 0);
  await assert.rejects(batches.next(), (error) => error.status === 503 && error.code === "host_offline");
});

for (const pending of [false, true]) {
  test(`return stops later batches and hosts${pending ? " while a batch is pending" : " after an empty batch"}`, async (t) => {
    const { sessions, calls, link } = await setup(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await link("A first", sessions.slice(0, 5), async (query, ids) => {
      if (pending) await gate;
      return sessionOps.searchSessionBatch(query, ids);
    });
    await link("Z later", sessions.slice(-1));
    const batches = searchSessionsAllHosts(QUERY);
    const next = batches.next();
    if (pending) await until(() => calls.length === 1, "first search batch to start");
    else assert.deepEqual(await next, { done: false, value: {} });
    const stopped = batches.return(undefined);
    release();
    if (pending) assert.deepEqual(await next, { done: false, value: {} });
    assert.deepEqual(await stopped, { done: true, value: undefined });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ids.length, 4);
  });
}

test("empty compiled queries finish before discovering any hosts", async (t) => {
  const { calls, discovery, link } = await setup(t, 1);
  await link("Remote");
  for (const query of ["", " \t\n", "...", '""', "“”"]) {
    assert.deepEqual(await searchSessionsAllHosts(query).next(), { done: true, value: undefined });
  }
  assert.deepEqual(discovery, []);
  assert.deepEqual(calls, []);
});

test("the endpoint rejects an oversized query without starting discovery", async (t) => {
  const { calls, discovery, link } = await setup(t, 1);
  await link("Remote");
  const response = await GET(new Request(`http://main.test/api/sessions/search?q=${"a".repeat(501)}`), {
    disableIdleTimeout: () => assert.fail("invalid query started a stream"),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "query_too_long");
  assert.deepEqual(discovery, []);
  assert.deepEqual(calls, []);
});
