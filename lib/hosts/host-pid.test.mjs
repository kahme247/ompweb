import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-host-pid-test-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
});

const { HOST_PID_FRESH_MS, clearHostPid, readHostPid, writeHostPid } = await import("./host-pid.ts");

const pidFile = join(agentDir, "omp-web", "host.pid");
const URL = "http://127.0.0.1:30177";
// This test process stands in for the daemon: its pid is live, which is what the record requires.
const livePid = process.pid;

test("a written record is read back for its own url, and the file is owner-only", () => {
  writeHostPid(livePid, `${URL}/`);
  assert.deepEqual(JSON.parse(readFileSync(pidFile, "utf8")), { pid: livePid, url: URL, at: JSON.parse(readFileSync(pidFile, "utf8")).at });
  if (process.platform !== "win32") assert.equal(statSync(pidFile).mode & 0o777, 0o600);
  assert.equal(readHostPid(URL), livePid);
  // A trailing slash is the same server.
  assert.equal(readHostPid(`${URL}/`), livePid);
});

test("a record of another server, a dead pid or a stale record is no daemon of ours", () => {
  writeHostPid(livePid, URL);
  assert.equal(readHostPid("http://127.0.0.1:30178"), null, "a dev server beside the production daemon must not adopt its children");
  // A pid that is gone (a daemon that died without clearing its record).
  writeHostPid(2 ** 22 + 12345, URL);
  assert.equal(readHostPid(URL), null);
  // A record no daemon refreshed: its pid may belong to another process by now.
  writeHostPid(livePid, URL);
  const saved = JSON.parse(readFileSync(pidFile, "utf8"));
  writeFileSync(pidFile, JSON.stringify({ ...saved, at: Date.now() - HOST_PID_FRESH_MS - 1 }));
  assert.equal(readHostPid(URL), null);
  // Garbage is not a record either.
  writeFileSync(pidFile, "not json");
  assert.equal(readHostPid(URL), null);
});

test("clearing removes only this daemon's record", () => {
  writeHostPid(livePid, URL);
  clearHostPid(livePid + 1);
  assert.equal(readHostPid(URL), livePid, "a newer daemon's record stays");
  clearHostPid(livePid);
  assert.equal(readHostPid(URL), null);
  // Clearing twice is harmless.
  clearHostPid(livePid);
});
