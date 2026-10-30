import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

// Real /api/notifications/history against a throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-history-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  globalThis.__ompNotificationStore?.db.close();
  globalThis.__ompNotificationStore = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const route = await import("../app/api/notifications/history/route.ts");
const store = await import("./notification-store.ts");

const URL_ = "http://localhost/api/notifications/history";
const patch = (body) => route.PATCH(new Request(URL_, { method: "PATCH", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
// DELETE carries no body: proxies may drop one, which must never turn a dismiss into a clear.
const del = (query, body) => route.DELETE(new Request(`${URL_}${query}`, { method: "DELETE", body }));
const ids = () => store.listHistory().map((entry) => [entry.id, entry.read]);

beforeEach(() => {
  store.clearHistory();
  for (const [i, sessionId] of ["s1", "s2", "s3"].entries()) store.recordHistory({ type: "completed", sessionId, sessionName: sessionId }, { at: i });
});

test("GET lists the history newest first", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  const { entries } = await response.json();
  assert.deepEqual(entries.map((entry) => entry.id), ["s3:completed", "s2:completed", "s1:completed"]);
  assert.deepEqual(entries[0].event, { type: "completed", sessionId: "s3", sessionName: "s3" });
});

test("PATCH with ids marks only those entries read", async () => {
  assert.equal((await patch({ ids: ["s1:completed"] })).status, 200);
  assert.deepEqual(ids(), [["s3:completed", false], ["s2:completed", false], ["s1:completed", true]]);
});

test("DELETE ?id= removes that entry", async () => {
  assert.equal((await del(`?id=${encodeURIComponent("s2:completed")}`)).status, 200);
  assert.deepEqual(ids().map(([id]) => id), ["s3:completed", "s1:completed"]);
});

test("DELETE ?all=1 clears the history", async () => {
  assert.equal((await del("?all=1")).status, 200);
  assert.deepEqual(ids(), []);
});

test("a DELETE without ?id or ?all changes nothing, even with a body", async () => {
  for (const [query, body] of [["", undefined], ["", JSON.stringify({ id: "s1:completed" })], ["?id=", undefined], [`?id=${"x".repeat(257)}`, undefined], ["?all=0", undefined]]) {
    const response = await del(query, body);
    assert.equal(response.status, 400, `${query} ${body ?? ""}`);
    assert.equal((await response.json()).code, "invalid_history_request");
  }
  assert.equal(ids().length, 3);
});

test("an oversized PATCH is refused with 413 before it is parsed", async () => {
  const response = await patch({ ids: ["s1:completed"], pad: "y".repeat(40_000) });
  assert.equal(response.status, 413);
  assert.deepEqual(ids().filter(([, read]) => read), []);
});

test("invalid PATCH bodies return 400 and change nothing", async () => {
  const before = ids();
  const invalid = ["{not json", { ids: "s1:completed" }, { ids: Array.from({ length: 101 }, (_, i) => `s${i}:completed`) }, { ids: ["x".repeat(257)] }, { ids: [42] }, { all: true }, {}];
  for (const body of invalid) {
    const response = await patch(body);
    assert.equal(response.status, 400, typeof body === "string" ? body : JSON.stringify(body).slice(0, 60));
    assert.equal((await response.json()).code, "invalid_history_request");
  }
  assert.deepEqual(ids(), before);
});
