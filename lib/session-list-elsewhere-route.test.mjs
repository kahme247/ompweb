import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkLocalDaemon } from "./hosts/link-driver.test-helper.mjs";

const listRoute = await import("../app/api/sessions/route.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");
const { closeHostLink } = await import("./hosts/hub.ts");
const { resetOmpProcessCache, setOmpProcessScanRunner } = await import("./omp-processes.ts");
const { resetElsewhereSessions } = await import("./session-owner.ts");

async function withLocalSessions(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-list-elsewhere-"));
  const sessionsDir = join(agentDir, "sessions", "-project");
  mkdirSync(sessionsDir, { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  invalidateSessionListCache();
  globalThis.__ompHostLists = undefined;
  await linkLocalDaemon();
  try {
    await run(sessionsDir);
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

const list = (headers = {}) => listRoute.GET(new Request("http://localhost/api/sessions", { headers }));

test("the session list carries the sessions a foreign omp owns", async () => {
  await withLocalSessions(async (dir) => {
    const owned = "0a000000-0000-4000-8000-000000000301";
    const idle = "0a000000-0000-4000-8000-000000000302";
    const ownedFile = writeSessionFile(dir, owned);
    writeSessionFile(dir, idle);
    setOmpProcessScanRunner(async () => processOutput([{ pid: 8181, commandLine: `omp.exe --resume "${ownedFile}"` }]));

    const response = await list();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.elsewhereSessions), "elsewhereSessions is always an array");
    assert.deepEqual(body.elsewhereSessions.map((entry) => entry.id), [owned]);
    assert.equal(body.elsewhereSessions[0].kind, "terminal");
    assert.equal(body.elsewhereSessions[0].source, "process");
    assert.equal(body.elsewhereSessions[0].active, true);
    // The unread/notification logic keys off runs this instance started.
    assert.deepEqual(body.runningSessionIds, []);
  });
});

test("the ETag covers elsewhereSessions, so a cleared owner invalidates the 304", async () => {
  await withLocalSessions(async (dir) => {
    const id = "0a000000-0000-4000-8000-000000000303";
    const filePath = writeSessionFile(dir, id);
    let owned = true;
    setOmpProcessScanRunner(async () => processOutput(owned ? [{ pid: 8182, commandLine: `omp.exe --resume "${filePath}"` }] : []));

    const first = await list();
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "the list answers an ETag");
    assert.equal((await first.json()).elsewhereSessions.length, 1);

    // The foreign process ended; a stale badge would survive a 304 if the ETag
    // ignored the field.
    owned = false;
    resetOmpProcessCache();
    resetElsewhereSessions();
    const second = await list({ "if-none-match": etag });
    assert.equal(second.status, 200, "the changed ownership must not answer 304");
    assert.deepEqual((await second.json()).elsewhereSessions, []);
  });
});
