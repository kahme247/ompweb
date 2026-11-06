import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const f = fixture(t), evil = join(dirname(f.path), "evil.jsonl");
  writeFileSync(evil, JSON.stringify({ type: "session", id: f.entry.sessionId }) + "\n"); // an existing file outside the root; a missing one is merely skipped
  for (const raw of ["{bad", JSON.stringify([{ ...f.entry, launch: { ...f.entry.launch, sessionFile: evil } }])]) {
    writeFileSync(f.path, raw); const tracker = new HostResumeTracker(f);
    const evidence = () => assert.equal(readFileSync(f.path, "utf8"), raw);
    assert.throws(() => tracker.takeRunning()); evidence(); assert.throws(() => tracker.recordRunning([])); evidence(); tracker.dispose();
  }
});

test("a deleted session is skipped without invalidating the rest of the manifest", t => {
  const f = fixture(t), gone = { ...f.entry, sessionId: "22222222-2222-4222-8222-222222222222", launch: { ...f.entry.launch, sessionFile: join(f.sessionsRoot, "gone.jsonl") } };
  writeFileSync(f.path, JSON.stringify([gone, f.entry])); const tracker = new HostResumeTracker(f);
  assert.deepEqual(tracker.takeRunning(), [f.entry]); tracker.recordRunning([f.entry]);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), [f.entry]); tracker.dispose();
});

test("the claim survives until retired and a dead daemon's claim is recovered once", async t => {
  const f = fixture(t), claims = () => readdirSync(dirname(f.path)).filter(name => name.includes(".claimed-"));
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  const leftover = `${f.path}.claimed-${child.pid}-x`, live = `${f.path}.claimed-${process.pid}-x`;
  writeFileSync(leftover, JSON.stringify([f.entry])); writeFileSync(live, JSON.stringify([f.entry]));
  writeFileSync(f.path, JSON.stringify([f.entry]));
  const tracker = new HostResumeTracker(f);
  assert.deepEqual(tracker.takeRunning(), [f.entry], "main and leftover manifests are deduplicated by session id");
  assert.equal(existsSync(leftover), false); assert.equal(existsSync(live), true, "a live pid's claim is never taken");
  assert.equal(claims().length, 3, "both recovered claims are kept until retired");
  assert.deepEqual(new HostResumeTracker(f).takeRunning(), []);
  tracker.retireClaim([f.entry]);
  assert.deepEqual(claims(), [`host-running.json.claimed-${process.pid}-x`]);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), [f.entry]); tracker.dispose();
});

test("a frozen tracker leaves its claim for the next start", t => {
  const f = fixture(t); writeFileSync(f.path, JSON.stringify([f.entry]));
  const tracker = new HostResumeTracker(f); tracker.takeRunning(); tracker.freeze(); tracker.retireClaim([]);
  assert.equal(readdirSync(dirname(f.path)).filter(name => name.includes(".claimed-")).length, 1); tracker.dispose();
});

test("the first running transition is immediate even after an empty startup snapshot", t => {
  const f = fixture(t), tracker = new HostResumeTracker(f);
  tracker.recordRunning([]); tracker.recordRunning([f.entry]);
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), [f.entry]); tracker.dispose();
});

test("sessions whose resume failed stay claimed alone; the next start takes them once this daemon is gone", t => {
  const f = fixture(t), other = { ...f.entry, sessionId: "22222222-2222-4222-8222-222222222222", launch: { ...f.entry.launch, sessionFile: join(f.sessionsRoot, "two.jsonl") } };
  writeFileSync(other.launch.sessionFile, JSON.stringify({ type: "session", id: other.sessionId }) + "\n");
  writeFileSync(f.path, JSON.stringify([f.entry, other]));
  const tracker = new HostResumeTracker(f); tracker.takeRunning();
  tracker.retireClaim([f.entry], [other]);
  const claims = readdirSync(dirname(f.path)).filter(name => name.includes(".claimed-"));
  assert.equal(claims.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(f.path), claims[0]), "utf8")), [other], "only the failed resume stays claimed");
  assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), [f.entry]); tracker.dispose();
});
