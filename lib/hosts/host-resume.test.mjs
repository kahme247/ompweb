import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostResumeTracker } from "./host-resume.ts";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "host-resume-")), sessionsRoot = join(dir, "sessions"), path = join(dir, "host-running.json");
  mkdirSync(sessionsRoot); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = { sessionId: "11111111-1111-4111-8111-111111111111", launch: { cwd: dir, recordedCwd: null, sessionFile: join(sessionsRoot, "one.jsonl"), advisor: false } };
  writeFileSync(entry.launch.sessionFile, JSON.stringify({ type: "session", id: entry.sessionId }) + "\n");
  return { path, sessionsRoot, entry, enabled: true };
}

test("run starts write immediately and freeze flushes changes before child exits", t => {
  const f = fixture(t), tracker = new HostResumeTracker(f);
  tracker.recordRunning([f.entry]); assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), [f.entry]);
  if (process.platform !== "win32") assert.equal(statSync(f.path).mode & 0o777, 0o600);
  tracker.recordRunning([]); tracker.freeze(); assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), []);
  tracker.recordRunning([f.entry]); assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), []); tracker.dispose();
});

test("only one atomic claim recovers the manifest and disabled recovery discards stale work", t => {
  const f = fixture(t); writeFileSync(f.path, JSON.stringify([f.entry]));
  const a = new HostResumeTracker(f), b = new HostResumeTracker(f);
  assert.deepEqual(a.takeRunning(), [f.entry]); assert.deepEqual(b.takeRunning(), []); a.dispose(); b.dispose();
  writeFileSync(f.path, JSON.stringify([f.entry])); const off = new HostResumeTracker({ ...f, enabled: false });
  assert.deepEqual(off.takeRunning(), []); off.dispose(); assert.deepEqual(new HostResumeTracker(f).takeRunning(), []);
});

test("malformed or outside-root recovery is rejected without overwriting the evidence", t => {
  const f = fixture(t);
  for (const raw of ["{bad", JSON.stringify([{ ...f.entry, launch: { ...f.entry.launch, sessionFile: "/tmp/evil.jsonl" } }])]) {
    writeFileSync(f.path, raw); const tracker = new HostResumeTracker(f);
    assert.throws(() => tracker.takeRunning()); assert.throws(() => tracker.recordRunning([])); tracker.dispose();
  }
});

test("the first running transition is immediate even after an empty startup snapshot", t => {
  const f = fixture(t), tracker = new HostResumeTracker(f);
  tracker.recordRunning([]); tracker.recordRunning([f.entry]);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), [f.entry]); tracker.dispose();
});
