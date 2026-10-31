import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const { MAX_SESSION_PINS, parseSessionPins, partitionPinnedSessions, restoreSessionPin, withSessionPinned } = await jiti.import("./session-pins.ts");
const listRoute = await jiti.import("../app/api/sessions/route.ts");
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const archiveRoute = await jiti.import("../app/api/sessions/[id]/archive/route.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");

test("parseSessionPins keeps valid ids in order and ignores everything else", () => {
  assert.deepEqual(parseSessionPins(JSON.stringify({ version: 1, pins: ["b", 7, " a ", "", "b", null, "c"] })), ["b", "a", "c"]);
  assert.deepEqual(parseSessionPins("not json"), []);
  assert.deepEqual(parseSessionPins(JSON.stringify(["a"])), []);
  assert.deepEqual(parseSessionPins(JSON.stringify({ pins: "a" })), []);
  const many = Array.from({ length: MAX_SESSION_PINS + 5 }, (_, index) => `s${index}`);
  assert.equal(parseSessionPins(JSON.stringify({ pins: many })).length, MAX_SESSION_PINS);
});

test("withSessionPinned appends new pins, keeps existing positions, and removes unpinned ids", () => {
  const pins = ["a", "b"];
  assert.deepEqual(withSessionPinned(pins, "c", true), ["a", "b", "c"]);
  assert.equal(withSessionPinned(pins, "a", true), pins, "re-pinning keeps the same list (no write)");
  assert.deepEqual(withSessionPinned(pins, "a", false), ["b"]);
  assert.equal(withSessionPinned(pins, "zzz", false), pins, "unpinning an unknown id is a no-op");
});

test("restoreSessionPin undoes one failed toggle and keeps toggles made meanwhile", () => {
  const before = ["a", "b", "c"];
  // A failed unpin returns the session to its old place, not the end.
  assert.deepEqual(restoreSessionPin(["a", "c"], before, "b"), ["a", "b", "c"]);
  assert.deepEqual(restoreSessionPin(["b", "c"], before, "a"), ["a", "b", "c"]);
  // Another session was unpinned and one pinned while the request was out.
  assert.deepEqual(restoreSessionPin(["c", "d"], before, "b"), ["b", "c", "d"]);
  assert.deepEqual(restoreSessionPin(["a", "c", "d"], before, "b"), ["a", "b", "c", "d"]);
  // A failed pin drops just that session.
  assert.deepEqual(restoreSessionPin(["a", "d", "x"], ["a"], "x"), ["a", "d"]);
  const unchanged = ["a", "b"];
  assert.equal(restoreSessionPin(unchanged, ["a", "b"], "b"), unchanged, "a pin that is already back stays put");
});

test("partitionPinnedSessions lists pinned sessions in pin order and leaves the rest in place", () => {
  const sessions = ["s1", "s2", "s3", "s4"].map((id) => ({ id }));
  const { pinned, rest } = partitionPinnedSessions(sessions, ["s3", "gone", "s1"]);
  assert.deepEqual(pinned.map((session) => session.id), ["s3", "s1"]);
  assert.deepEqual(rest.map((session) => session.id), ["s2", "s4"]);
  assert.deepEqual(partitionPinnedSessions(sessions, []).rest.map((session) => session.id), ["s1", "s2", "s3", "s4"]);
});

/** A throwaway agent dir holding the given sessions (id → file name). */
async function withSessions(ids, run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-pins-"));
  const projectDir = join(agentDir, "sessions", "-project");
  mkdirSync(projectDir, { recursive: true });
  const cwd = join(tmpdir(), "omp-web-missing-project");
  const files = {};
  for (const [index, id] of ids.entries()) {
    const timestamp = `2026-01-0${index + 1}T00:00:00.000Z`;
    files[id] = join(projectDir, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`);
    writeFileSync(files[id], [
      JSON.stringify({ type: "session", version: 3, id, cwd, timestamp }),
      JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: id } }),
    ].join("\n") + "\n");
  }
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  try {
    await run({ agentDir, files, pinsFile: join(agentDir, "omp-web", "session-pins.json") });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

const patch = (id, body) => sessionRoute.PATCH(
  new Request(`http://localhost/api/sessions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);
const listedPins = async () => (await (await listRoute.GET(new Request("http://localhost/api/sessions"))).json()).pinnedSessionIds;

test("PATCH { pinned } stores pins in pin order and the session list reports them", async () => {
  await withSessions(["alpha", "beta", "gamma"], async ({ pinsFile }) => {
    assert.deepEqual(await listedPins(), []);
    for (const id of ["gamma", "alpha"]) {
      const res = await patch(id, { pinned: true });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, pinned: true });
    }
    assert.deepEqual(await listedPins(), ["gamma", "alpha"]);
    assert.deepEqual(JSON.parse(readFileSync(pinsFile, "utf8")), { version: 1, pins: ["gamma", "alpha"] });

    assert.equal((await patch("gamma", { pinned: false })).status, 200);
    assert.deepEqual(await listedPins(), ["alpha"]);
  });
});

test("PATCH rejects bad pin requests without touching the pin file", async () => {
  await withSessions(["alpha"], async ({ pinsFile }) => {
    const missing = await patch("no-such-session", { pinned: true });
    assert.equal(missing.status, 404);
    const invalid = await patch("alpha", { pinned: "yes" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "invalid_session_pinned");
    const empty = await patch("alpha", {});
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, "session_name_required");
    assert.equal(existsSync(pinsFile), false);
    // Unpinning never needs the session: a stale pin must stay clearable.
    assert.equal((await patch("no-such-session", { pinned: false })).status, 200);
  });
});

test("deleting or archiving a pinned session drops its pin", async () => {
  await withSessions(["keep", "doomed", "shelved"], async ({ pinsFile }) => {
    for (const id of ["keep", "doomed", "shelved"]) await patch(id, { pinned: true });

    const deleted = await sessionRoute.DELETE(new Request("http://localhost/api/sessions/doomed"), { params: Promise.resolve({ id: "doomed" }) });
    assert.equal(deleted.status, 200);
    const archived = await archiveRoute.POST(new Request("http://localhost/api/sessions/shelved/archive", { method: "POST" }), { params: Promise.resolve({ id: "shelved" }) });
    assert.equal(archived.status, 200);

    assert.deepEqual(JSON.parse(readFileSync(pinsFile, "utf8")).pins, ["keep"]);
    assert.deepEqual(await listedPins(), ["keep"]);
  });
});

test("PATCH { name, pinned } renames and pins in one request", async () => {
  await withSessions(["alpha"], async () => {
    const res = await patch("alpha", { name: "Renamed", pinned: true });
    assert.equal(res.status, 200);
    const body = await (await listRoute.GET(new Request("http://localhost/api/sessions"))).json();
    assert.deepEqual(body.pinnedSessionIds, ["alpha"]);
    assert.equal(body.sessions.find((session) => session.id === "alpha")?.name, "Renamed");
  });
});

test("pins of sessions deleted elsewhere never block a new pin at the limit", async () => {
  await withSessions(["alpha"], async ({ pinsFile }) => {
    const stale = Array.from({ length: MAX_SESSION_PINS }, (_, index) => `deleted-by-cli-${index}`);
    mkdirSync(join(pinsFile, ".."), { recursive: true });
    writeFileSync(pinsFile, JSON.stringify({ version: 1, pins: stale }));
    const res = await patch("alpha", { pinned: true });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(pinsFile, "utf8")).pins, ["alpha"]);
  });
});

test("a live session pinned before its file exists stays listed as pinned", async (t) => {
  const previous = globalThis.__ompSessions;
  const id = "live-before-flush";
  globalThis.__ompSessions = new Map([[id, { sessionId: id, cwd: tmpdir(), isAlive: () => true, isRunning: () => true }]]);
  t.after(() => {
    globalThis.__ompSessions = previous;
  });
  await withSessions(["alpha"], async () => {
    assert.equal((await patch(id, { pinned: true })).status, 200);
    assert.deepEqual(await listedPins(), [id]);
  });
});
