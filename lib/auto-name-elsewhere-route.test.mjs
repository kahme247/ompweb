import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST /api/sessions/[id]/auto-name against a saved session that ANOTHER
// live omp-web instance lists as running. Generating a title starts an omp
// child (and its dispose writes a copy of a foreign conversation), so the route
// must answer from the file instead: a stored title, or 200 without one — the
// client treats that as a silent no-op. The omp binary is a launcher stub, so a
// launch record is the observable proof that nothing was spawned.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const autoNameRoute = await jiti.import("../app/api/sessions/[id]/auto-name/route.ts");
const { setSessionTitle } = await jiti.import("../lib/omp/session-files.ts");
const { invalidateSessionListCache, invalidateSessionCaches } = await jiti.import("../lib/session-reader.ts");
const { resetElsewhereSessions } = await jiti.import("../lib/session-owner.ts");
const { resetOmpProcessCache, setOmpProcessScanRunner } = await jiti.import("../lib/omp-processes.ts");

// The gate under test is the foreign-instance list; keep the OS process scan
// out of the test (and fast) by injecting an empty table.
setOmpProcessScanRunner(async () => (process.platform === "win32" ? "[]" : ""));

const TITLED_ID = "9f1c0a11-2b3c-4d5e-8f60-7a8b9c0d1e2f";
const UNTITLED_ID = "5c2d8f31-7a49-4b0e-9d18-3f6a2b1c0d77";
const OWNERLESS_ID = "0b8e6d42-91c7-4f3a-8d55-1e2f3a4b5c6d";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-auto-name-"));
const projectDir = join(agentDir, "sessions", "-project");
mkdirSync(projectDir, { recursive: true });

function writeSession(id, { exit = false } = {}) {
  const path = join(projectDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, cwd: tmpdir(), timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
    { type: "message", id: "a1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
  ];
  if (exit) {
    // Closed by its writer: the tail heuristic invents no owner.
    lines.push({ type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal", recordedAt: "2026-01-01T00:00:01.000Z" } });
  }
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

const titledFile = writeSession(TITLED_ID, { exit: true });
// omp's own title slot (the fixed-width first line) via the same writer the
// route uses, so `scanSessionInfo` reads what the sidebar would show.
setSessionTitle(titledFile, "Stored title", "auto");
const untitledFile = writeSession(UNTITLED_ID, { exit: true });
const ownerlessFile = writeSession(OWNERLESS_ID, { exit: true });

// A live pid that is not this test process: the "other omp-web instance".
const foreignOwner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
writeFileSync(
  join(agentDir, `omp-web-interrupted-sessions-${foreignOwner.pid}.json`),
  `${JSON.stringify({ sessions: [{ id: TITLED_ID, advisor: false }, { id: UNTITLED_ID, advisor: false }] }, null, 2)}\n`,
);

const launchLog = join(agentDir, "omp-launches.log");
const fakeOmp = join(agentDir, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
function writeFakeOmp() {
  writeFileSync(
    fakeOmp,
    process.platform === "win32"
      ? `@echo off\r\necho launched>> "${launchLog}"\r\nexit /b 1\r\n`
      : `#!/bin/sh\necho launched >> '${launchLog}'\nexit 1\n`,
    { mode: 0o755 },
  );
}
writeFakeOmp();

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
  writeFakeOmp();
};
/** Session-looking files in the project dir (a fork/copy would add one). */
const sessionFiles = () => readdirSync(projectDir).filter((name) => name.endsWith(".jsonl")).sort();

const autoName = (id) => autoNameRoute.POST(
  new Request(`http://localhost/api/sessions/${id}/auto-name`, { method: "POST" }),
  { params: Promise.resolve({ id }) },
);

test("auto-name answers from the file for a foreign-owned session and spawns nothing", async () => {
  resetLaunches();
  const before = sessionFiles();
  const bytesBefore = readFileSync(titledFile, "utf8");

  const response = await autoName(TITLED_ID);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.title, "Stored title", "the stored title comes back");
  assert.equal(body.generated, false);
  assert.equal(body.elsewhere, undefined, "no owner report in the title answer");
  assert.equal(launches(), 0, "no omp child was started");
  assert.deepEqual(sessionFiles(), before, "no copy/fork file was created");
  assert.equal(readFileSync(titledFile, "utf8"), bytesBefore, "the foreign file was not written");
});

test("a foreign-owned session without a title answers 200 without one (silent no-op)", async () => {
  resetLaunches();
  const before = sessionFiles();
  const bytesBefore = readFileSync(untitledFile, "utf8");

  const response = await autoName(UNTITLED_ID);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.title, null, "no title invented for someone else's chat");
  assert.equal(body.generated, false);
  assert.equal(body.error, undefined, "no title is not an error");
  assert.equal(launches(), 0);
  assert.deepEqual(sessionFiles(), before, "the fallback title was not written to a foreign file");
  assert.equal(readFileSync(untitledFile, "utf8"), bytesBefore, "the foreign file was not written");
});

test("an unowned session still gets a name (the gate answers only for owners)", async () => {
  resetLaunches();
  invalidateSessionCaches(ownerlessFile);
  invalidateSessionListCache();
  // The stub omp exits at once, so the route falls back to the first user
  // message — the launch record is what proves the gate let it through.
  const response = await autoName(OWNERLESS_ID);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(launches(), 1, "the unowned session was allowed to spawn");
  assert.equal(body.generated, false);
  assert.equal(body.title, "hello");
});
