import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { linkLocalDaemon } from "./hosts/link-driver.test-helper.mjs";

const autoNameRoute = await import("../app/api/sessions/[id]/auto-name/route.ts");
const { invalidateSessionListCache } = await import("./session-reader.ts");
const { closeHostLink } = await import("./hosts/hub.ts");
const { resetOmpProcessCache, setOmpProcessScanRunner } = await import("./omp-processes.ts");
const { resetElsewhereSessions } = await import("./session-owner.ts");

/** A session tree this machine's linked daemon serves, with a spawn op that only counts. */
async function withLocalSession(run) {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-auto-name-elsewhere-"));
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
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Preserve this conversation" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    // The writer closed the file: the transcript alone must not read as a live
    // foreign run, so only the process signal can make this session elsewhere.
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

const post = (id) => autoNameRoute.POST(
  new Request(`http://localhost/api/sessions/${id}/auto-name`, { method: "POST" }),
  { params: Promise.resolve({ id }) },
);

test("auto-name never spawns for a session another omp process owns", async () => {
  await withLocalSession(async (dir, counts) => {
    const id = "0a000000-0000-4000-8000-000000000101";
    const filePath = writeSessionFile(dir, id);
    const original = readFileSync(filePath);
    // A terminal `omp --resume <file>` holds the writer lease.
    setOmpProcessScanRunner(async () => processOutput([{ pid: 6161, commandLine: `omp.exe --resume "${filePath}"` }]));

    const response = await post(id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { title: null, generated: false, usage: null });
    assert.equal(counts.spawns, 0, "a cosmetic title must not spawn the second writer");
    assert.deepEqual(readFileSync(filePath), original, "a foreign file is never written");
  });
});

test("auto-name still spawns when no other process owns the session", async () => {
  await withLocalSession(async (dir, counts) => {
    const id = "0a000000-0000-4000-8000-000000000102";
    writeSessionFile(dir, id);
    setOmpProcessScanRunner(async () => processOutput([]));

    const response = await post(id);
    // The spawn fails here on purpose; the endpoint degrades to the fallback
    // title, which is enough to prove the ownership gate let it through.
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.generated, false);
    assert.equal(body.title, "Preserve this conversation");
    assert.equal(counts.spawns, 1, "the title generator may start the session");
  });
});
