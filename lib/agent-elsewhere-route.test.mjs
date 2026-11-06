import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkLocalDaemon } from "./hosts/link-driver.test-helper.mjs";

const route = await import("../app/api/agent/[id]/route.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");
const { closeHostLink } = await import("./hosts/hub.ts");
const { resetOmpProcessCache, setOmpProcessScanRunner } = await import("./omp-processes.ts");
const { resetElsewhereSessions } = await import("./session-owner.ts");

/** A session tree this machine's linked daemon serves; `spawn` only counts. */
async function withLocalSession(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-agent-elsewhere-"));
  const sessionsDir = join(agentDir, "sessions", "-project");
  mkdirSync(sessionsDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  globalThis.__ompHostLists = undefined;
  const counts = { spawns: 0 };
  await linkLocalDaemon({
    spawn: () => {
      counts.spawns += 1;
      throw new Error("must not spawn a second writer");
    },
  });
  try {
    await run(sessionsDir, counts);
  } finally {
    closeHostLink("local");
    setOmpProcessScanRunner(null);
    resetOmpProcessCache();
    resetElsewhereSessions();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function writeSessionFile(dir, id) {
  const filePath = join(dir, `${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, cwd: dir, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    // Closed transcript: only the process signal can make the session foreign.
    { type: "custom", customType: "session_exit", id: "x1", parentId: null, data: { reason: "dispose" } },
  ];
  writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return filePath;
}

function processOutput(entries) {
  return process.platform === "win32"
    ? JSON.stringify(entries.map(({ pid, ppid, commandLine }) => ({ ProcessId: pid, ParentProcessId: ppid, CommandLine: commandLine })))
    : `${entries.map(({ pid, ppid, commandLine }) => `${pid} ${ppid ?? 1} 1000 ${commandLine}`).join("\n")}\n`;
}

const post = (id, query = "") => route.POST(
  new Request(`http://localhost/api/agent/${id}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "hello again" }),
  }),
  { params: Promise.resolve({ id }) },
);

const get = (id) => route.GET(
  new Request(`http://localhost/api/agent/${id}`),
  { params: Promise.resolve({ id }) },
);

test("a send to a session a foreign omp owns answers 409 and spawns nothing", async () => {
  await withLocalSession(async (dir, counts) => {
    const id = "0a000000-0000-4000-8000-000000000201";
    const filePath = writeSessionFile(dir, id);
    setOmpProcessScanRunner(async () => processOutput([{ pid: 7171, commandLine: `omp.exe --mode rpc-ui --resume "${filePath}"` }]));

    const response = await post(id);
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.code, "session_running_elsewhere");
    assert.equal(body.elsewhere.source, "process");
    assert.equal(body.elsewhere.kind, "terminal");
    assert.equal(body.elsewhere.active, true);
    assert.equal(counts.spawns, 0, "a foreign run must never be duplicated");
  });
});

test("?force=1 takes the session over anyway", async () => {
  await withLocalSession(async (dir, counts) => {
    const id = "0a000000-0000-4000-8000-000000000202";
    const filePath = writeSessionFile(dir, id);
    setOmpProcessScanRunner(async () => processOutput([{ pid: 7172, commandLine: `omp.exe --resume "${filePath}"` }]));

    const response = await post(id, "?force=1");
    // The fake spawn fails on purpose; reaching it proves the gate was skipped.
    assert.notEqual(response.status, 409);
    assert.equal((await response.json()).code === "session_running_elsewhere", false);
    assert.equal(counts.spawns, 1, "force is the explicit override");
  });
});

test("the agent GET reports the foreign owner instead of a bare not-running", async () => {
  await withLocalSession(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000203";
    const filePath = writeSessionFile(dir, id);
    setOmpProcessScanRunner(async () => processOutput([{ pid: 7173, commandLine: `omp.exe --resume "${filePath}"` }]));

    const response = await get(id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.running, false);
    assert.equal(body.alive, false);
    assert.equal(body.elsewhere?.source, "process");
    assert.ok(Number.isInteger(body.elsewhere?.lastActivityAt ?? 0) || body.elsewhere?.lastActivityAt === undefined);
  });
});

test("the agent GET answers elsewhere: null for an idle session nobody owns", async () => {
  await withLocalSession(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000204";
    writeSessionFile(dir, id);
    setOmpProcessScanRunner(async () => processOutput([]));

    const response = await get(id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.running, false);
    assert.equal(body.elsewhere, null);
  });
});
