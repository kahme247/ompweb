import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST/GET /api/agent/[id] against a real saved session whose id is listed
// as running by ANOTHER live omp-web instance (its per-pid resume list). The omp
// binary is a launcher stub, so a launch record is the observable proof that a
// child process was created — the gate must prevent exactly that.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const agentRoute = await jiti.import("../app/api/agent/[id]/route.ts");
const sessionsRoute = await jiti.import("../app/api/sessions/route.ts");
const sessionRoute = await jiti.import("../app/api/sessions/[id]/route.ts");
const mcpRoute = await jiti.import("../app/api/mcp/route.ts");
const { invalidateSessionListCache } = await jiti.import("../lib/session-reader.ts");
const { resetElsewhereSessions } = await jiti.import("../lib/session-owner.ts");
const { resetOmpProcessCache, setOmpProcessScanRunner } = await jiti.import("../lib/omp-processes.ts");

// The gate under test is the foreign-instance list; keep the OS process scan
// out of the test (and fast) by injecting an empty table.
setOmpProcessScanRunner(async () => (process.platform === "win32" ? "[]" : ""));

test("a busy live session answers 503 with its frame clock, never an idle run", async (t) => {
  // The route checks the class identity from the `@/` alias instance.
  const { WebRpcError } = await jiti.import("@/lib/rpc-manager");
  const id = "busy-live-session";
  const previous = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    // Two hours without a frame — the only report a blocked child produces.
    silentForMs: () => 7_200_000,
    send: async () => {
      throw new WebRpcError("omp is busy and did not answer in time; the session keeps running.", "session_slow");
    },
  }]]);
  t.after(() => {
    globalThis.__ompSessions = previous;
  });

  const response = await agentRoute.GET(
    new Request(`http://localhost/api/agent/${id}`),
    { params: Promise.resolve({ id }) },
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "session_slow");
  assert.equal(body.silentForMs, 7_200_000, "the busy answer carries how long omp has been silent");
  assert.equal(body.running, true, "the slow answer carries the wrapper's run state");
  assert.equal(body.alive, true, "the child exists");
});

const SAVED_ID = "9f1c0a11-2b3c-4d5e-8f60-7a8b9c0d1e2f";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-elsewhere-route-"));
const projectDir = join(agentDir, "sessions", "-project");
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(projectDir, `2026-01-01T00-00-00-000Z_${SAVED_ID}.jsonl`),
  `${[
    { type: "session", version: 3, id: SAVED_ID, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`,
);

// A second session nobody owns: its transcript ends with the `session_exit`
// omp flushes when the writer closes the file, so the tail heuristic does not
// invent an owner. It is the control for the ownership gates.
const OWNERLESS_ID = "5c2d8f31-7a49-4b0e-9d18-3f6a2b1c0d77";
writeFileSync(
  join(projectDir, `2026-01-02T00-00-00-000Z_${OWNERLESS_ID}.jsonl`),
  `${[
    { type: "session", version: 3, id: OWNERLESS_ID, cwd: tmpdir(), timestamp: "2026-01-02T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    { type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal", recordedAt: "2026-01-02T00:00:01.000Z" } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`,
);

// A live pid that is not this test process: the "other omp-web instance".
const foreignOwner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
const foreignListPath = join(agentDir, `omp-web-interrupted-sessions-${foreignOwner.pid}.json`);
writeFileSync(foreignListPath, `${JSON.stringify({ sessions: [{ id: SAVED_ID, advisor: false }] }, null, 2)}\n`);

const launchLog = join(agentDir, "omp-launches.log");
const fakeOmp = join(agentDir, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
writeFileSync(
  fakeOmp,
  process.platform === "win32"
    ? `@echo off\r\necho launched>> "${launchLog}"\r\nexit /b 1\r\n`
    : `#!/bin/sh\necho launched >> '${launchLog}'\nexit 1\n`,
  { mode: 0o755 },
);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousBin = process.env.OMP_WEB_OMP_BIN;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_WEB_OMP_BIN = fakeOmp;
after(async () => {
  foreignOwner.kill();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
  else process.env.OMP_WEB_OMP_BIN = previousBin;
  resetElsewhereSessions();
  setOmpProcessScanRunner(null);
  resetOmpProcessCache();
  invalidateSessionListCache();
  rmSync(agentDir, { recursive: true, force: true });
});

const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split(/\r?\n/).filter(Boolean).length : 0);
const resetLaunches = () => {
  rmSync(launchLog, { force: true });
  rmSync(fakeOmp, { force: true });
  writeFileSync(
    fakeOmp,
    process.platform === "win32"
      ? `@echo off\r\necho launched>> "${launchLog}"\r\nexit /b 1\r\n`
      : `#!/bin/sh\necho launched >> '${launchLog}'\nexit 1\n`,
    { mode: 0o755 },
  );
};

const post = (id, body, query = "") => agentRoute.POST(
  new Request(`http://localhost/api/agent/${id}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) },
);

test("sending to a session another live instance runs is refused with 409 and never spawns", async () => {
  resetLaunches();
  const response = await post(SAVED_ID, { type: "prompt", message: "hello again" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "session_running_elsewhere");
  assert.equal(typeof body.error, "string");
  assert.equal(body.elsewhere.kind, "omp-web");
  assert.equal(body.elsewhere.source, "instance-list");
  assert.equal(body.elsewhere.running, true);
  assert.equal(body.elsewhere.active, true);
  assert.equal(body.elsewhere.pid, undefined, "the owning pid is not disclosed");
  assert.equal(launches(), 0, "no omp child was started");
});

test("read-only commands that would spawn are gated as well", async () => {
  resetLaunches();
  const response = await post(SAVED_ID, { type: "get_state" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "session_running_elsewhere");
  assert.equal(launches(), 0);
});

test("?force=1 is the explicit override and proceeds to spawn a copy", async () => {
  resetLaunches();
  const response = await post(SAVED_ID, { type: "prompt", message: "into the copy" }, "?force=1");
  // The stub omp exits at once, so the spawn fails — the point is that the
  // spawn HAPPENED: the gate did not answer 409 for the forced request.
  assert.notEqual(response.status, 409);
  const body = await response.json();
  assert.notEqual(body.code, "session_running_elsewhere");
  assert.equal(launches(), 1, "the forced request spawned the child");
});

test("GET reports the foreign owner without spawning", async () => {
  resetLaunches();
  const response = await agentRoute.GET(new Request(`http://localhost/api/agent/${SAVED_ID}`), {
    params: Promise.resolve({ id: SAVED_ID }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.running, false);
  assert.equal(body.elsewhere.kind, "omp-web");
  assert.equal(body.elsewhere.pid, undefined);
  assert.equal(launches(), 0);
});

test("the session list and the session detail carry the owner in `elsewhereSessions`", async () => {
  invalidateSessionListCache();
  const listResponse = await sessionsRoute.GET(new Request("http://localhost/api/sessions"));
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  const entry = (list.elsewhereSessions ?? []).find((item) => item.id === SAVED_ID);
  assert.ok(entry, `missing elsewhere entry: ${JSON.stringify(list.elsewhereSessions)}`);
  assert.equal(entry.kind, "omp-web");
  assert.equal(entry.source, "instance-list");
  assert.equal(entry.pid, undefined, "no owner pid on the wire");
  assert.equal(entry.cwd, undefined, "no cwd on the wire");
  // Foreign ownership must never be mixed into the local running set.
  assert.equal((list.runningSessionIds ?? []).includes(SAVED_ID), false);

  const detail = await sessionRoute.GET(new Request(`http://localhost/api/sessions/${SAVED_ID}?includeState=1`), {
    params: Promise.resolve({ id: SAVED_ID }),
  });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.agent.running, false);
  assert.equal(detailBody.agent.elsewhere.kind, "omp-web");
});

test("GET /api/mcp does not spawn a second writer for a foreign-owned session", async () => {
  resetLaunches();
  invalidateSessionListCache();
  // The live server list of a session detail view reads MCP states through an
  // omp child. For a session another process owns that spawn IS the silent
  // fork (the child's `dispose` writes its `session_exit` into a copy), so the
  // route must answer from the ownership report instead.
  const response = await mcpRoute.GET(new Request(`http://localhost/api/mcp?sessionId=${SAVED_ID}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(launches(), 0, "no omp child was started");
  // The client falls back to the configured inventory; the ownership message
  // is what explains why the live block is missing (an empty list used to read
  // as "no MCP servers configured").
  assert.equal(body.liveServers, undefined, "no live list without a child");
  assert.equal(typeof body.liveError, "string");
  assert.match(body.liveError, /another omp process/);
  assert.equal(body.liveElsewhere, undefined);
});

test("GET /api/mcp still starts omp for a session nobody owns", async () => {
  resetLaunches();
  invalidateSessionListCache();
  // The control: the gate answers only for an owner. A closed transcript of an
  // idle session must still get its live MCP list (the stub omp exits at once,
  // so the launch record is the observable).
  const response = await mcpRoute.GET(new Request(`http://localhost/api/mcp?sessionId=${OWNERLESS_ID}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(launches(), 1, "the session without an owner spawned its child");
  assert.equal(body.liveElsewhere, undefined);
});
