import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";
import { Database } from "bun:sqlite";
import { withArchiveRestoreLock } from "./archive-restore-lock.ts";

async function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "archive-lock-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { await run(dir); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("restore lock releases a rejected callback and restricts store permissions", async () => {
  await withDir(async (dir) => {
    await assert.rejects(withArchiveRestoreLock("session", async () => { throw new Error("failed restore"); }), /failed restore/);
    assert.equal(await withArchiveRestoreLock("session", async () => "released"), "released");
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, "omp-web")).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, "omp-web", "archive-restore-locks.sqlite")).mode & 0o777, 0o600);
    }
  });
});

test("two Bun processes sharing an agent directory cannot claim the same session", async () => {
  await withDir(async () => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "archive-restore-lock.ts")).href;
    const source = `import { withArchiveRestoreLock } from ${JSON.stringify(moduleUrl)};
      await withArchiveRestoreLock("session", async () => {
        console.log("claimed");
        for await (const chunk of Bun.stdin.stream()) break;
      });`;
    const child = spawn(process.execPath, ["--eval", source], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock child exited ${code}`)));
    });
    const lines = createInterface({ input: child.stdout });
    try {
      const ready = await Promise.race([lines[Symbol.asyncIterator]().next(), exited.then(() => { throw new Error("child exited before claiming"); })]);
      assert.equal(ready.value, "claimed");
      await assert.rejects(withArchiveRestoreLock("session", async () => assert.fail("must not enter")), (error) => error.status === 409 && error.code === "archive_restore_busy");
      child.stdin.end("release\n");
      await exited;
      assert.equal(await withArchiveRestoreLock("session", async () => "released"), "released");
    } finally {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await exited.catch(() => {});
    }
  });
});

test("restore lock reclaims an expired lease whatever its owner, and leaves a fresh one busy", async () => {
  await withDir(async (dir) => {
    await withArchiveRestoreLock("initialize", async () => {});
    const db = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
    try {
      // A crashed holder whose PID now belongs to a live process: only the lease decides.
      db.prepare("INSERT INTO restore_claims (session_id, owner, renewed_at) VALUES (?, ?, ?)").run("stale", "crashed", Date.now() - 31_000);
      assert.equal(await withArchiveRestoreLock("stale", async () => "reclaimed"), "reclaimed");
      assert.equal(db.prepare("SELECT owner FROM restore_claims WHERE session_id = ?").get("stale"), null);
      // Written by a clock running an hour fast: it must lapse too.
      db.prepare("INSERT INTO restore_claims (session_id, owner, renewed_at) VALUES (?, ?, ?)").run("future", "fast-clock", Date.now() + 3_600_000);
      assert.equal(await withArchiveRestoreLock("future", async () => "reclaimed"), "reclaimed");
      assert.equal(db.prepare("SELECT owner FROM restore_claims WHERE session_id = ?").get("future"), null);
      db.prepare("INSERT INTO restore_claims (session_id, owner, renewed_at) VALUES (?, ?, ?)").run("fresh", "other", Date.now());
      await assert.rejects(withArchiveRestoreLock("fresh", async () => assert.fail("fresh lease entered")), (error) => error.status === 409 && error.code === "archive_restore_busy");
      assert.equal(db.prepare("SELECT owner FROM restore_claims WHERE session_id = ?").get("fresh").owner, "other");
    } finally { db.close(true); }
  });
});

test("a holder renews its lease, so a restore running past the lease stays claimed", async (t) => {
  await withDir(async (dir) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const holding = withArchiveRestoreLock("long", () => gate);
    const db = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
    try {
      // Another session's lease: renewal and release must touch only the holder's own row.
      const foreign = Date.now();
      db.prepare("INSERT INTO restore_claims (session_id, owner, renewed_at) VALUES (?, ?, ?)").run("other", "other-owner", foreign);
      for (let i = 0; i < 6; i++) t.mock.timers.tick(10_000);
      await assert.rejects(withArchiveRestoreLock("long", async () => assert.fail("renewed lease entered")), (error) => error.code === "archive_restore_busy");
      release("done");
      assert.equal(await holding, "done");
      assert.deepEqual({ ...db.prepare("SELECT owner, renewed_at FROM restore_claims WHERE session_id = ?").get("other") }, { owner: "other-owner", renewed_at: foreign });
      assert.equal(await withArchiveRestoreLock("long", async () => "released"), "released");
    } finally { db.close(true); }
  });
});

test("a held claim outlives its request and the lease clock, and ends only by its host's fence", async () => {
  await withDir(async (dir) => {
    let token;
    await withArchiveRestoreLock("held", async (claim) => { token = claim.token; claim.hold("host-a", "daemon-1"); });
    const db = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
    const held = () => db.prepare("SELECT owner, host_id, instance FROM restore_claims WHERE session_id = ?").get("held");
    try {
      assert.deepEqual({ ...held() }, { owner: token, host_id: "host-a", instance: "daemon-1" });
      // An hour without renewal: a plain lease would have lapsed long ago.
      db.prepare("UPDATE restore_claims SET renewed_at = ? WHERE session_id = ?").run(Date.now() - 3_600_000, "held");
      await assert.rejects(withArchiveRestoreLock("held", async () => assert.fail("a held claim was reclaimed by the clock")), (error) => error.status === 409 && error.code === "archive_restore_busy");
      // The host is asked about the dead request's own token; if it cannot confirm, the claim stays and its refusal reaches the caller.
      const refusal = new Error("still running");
      await assert.rejects(withArchiveRestoreLock("held", async () => assert.fail("entered unconfirmed"), async (asked) => {
        assert.deepEqual([asked.sessionId, asked.hostId, asked.claim, asked.instance], ["held", "host-a", token, "daemon-1"]);
        assert.equal(typeof asked.since, "number");
        throw refusal;
      }), (error) => error === refusal);
      assert.deepEqual({ ...held() }, { owner: token, host_id: "host-a", instance: "daemon-1" });
      // Fenced and stopped: the claim is taken over, and ends with its new holder.
      assert.equal(await withArchiveRestoreLock("held", async (claim) => claim.token !== token && "taken over", async () => {}), "taken over");
      assert.equal(held(), null);
    } finally { db.close(true); }
  });
});

test("a held claim whose request is still waiting is busy, and its host is not asked", async () => {
  await withDir(async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // Held on the way in, as before an op leaves for a host; renewing while it waits.
    const waiting = withArchiveRestoreLock("waiting", async (claim) => {
      claim.hold("host-a", "daemon-1");
      await gate;
      claim.release();
    });
    let asked = false;
    await assert.rejects(withArchiveRestoreLock("waiting", async () => assert.fail("entered"), async () => { asked = true; }), (error) => error.code === "archive_restore_busy");
    assert.equal(asked, false);
    release();
    await waiting;
    // The answer released it.
    assert.equal(await withArchiveRestoreLock("waiting", async () => "free"), "free");
  });
});

test("hold refuses a request whose lease another one already took over, before an op can leave", async () => {
  await withDir(async (dir) => {
    await assert.rejects(withArchiveRestoreLock("lost", async (claim) => {
      const db = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
      try { db.prepare("UPDATE restore_claims SET owner = ? WHERE session_id = ?").run("taker", "lost"); } finally { db.close(true); }
      claim.hold("host-a", "daemon-1");
    }), (error) => error.status === 409 && error.code === "archive_restore_busy");
    const db = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
    try {
      // The taker's claim is untouched, and nothing was held for the refused request.
      assert.deepEqual({ ...db.prepare("SELECT owner, host_id FROM restore_claims WHERE session_id = ?").get("lost") }, { owner: "taker", host_id: null });
    } finally { db.close(true); }
  });
});

test("publish holds the store's write lock across the publishing step, so nothing takes the session over mid-publish", async () => {
  await withDir(async (dir) => {
    let blocked = null;
    const result = await withArchiveRestoreLock("pub", async (claim) => claim.publish(() => {
      const other = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
      try {
        other.exec("PRAGMA busy_timeout = 0");
        try { other.exec("BEGIN IMMEDIATE"); blocked = false; } catch { blocked = true; }
      } finally { other.close(true); }
      return "published";
    }));
    assert.equal(result, "published");
    assert.equal(blocked, true);
    // Committed: the next request is free to claim the session.
    assert.equal(await withArchiveRestoreLock("pub", async () => "free"), "free");
  });
});

test("a publish step that throws rolls back and frees the store at once, and its error reaches the caller", async () => {
  await withDir(async (dir) => {
    await withArchiveRestoreLock("failing", async (claim) => {
      assert.throws(() => claim.publish(() => { throw new Error("destination exists"); }), /destination exists/);
      const other = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
      try {
        other.exec("PRAGMA busy_timeout = 0");
        other.exec("BEGIN IMMEDIATE");
        other.exec("ROLLBACK");
      } finally { other.close(true); }
      // Nothing was committed or lost: the claim is still this request's.
      assert.equal(claim.publish(() => "retried"), "retried");
    });
  });
});

test("a holder suspended past its lease publishes only if nobody took the session over meanwhile", async () => {
  await withDir(async (dir) => {
    const age = (session) => {
      const db = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
      try { db.prepare("UPDATE restore_claims SET renewed_at = ? WHERE session_id = ?").run(Date.now() - 60_000, session); } finally { db.close(true); }
    };
    // Suspended past the lease, and untaken: the claim is still its own, so it may publish.
    assert.equal(await withArchiveRestoreLock("slow", async (claim) => { age("slow"); return claim.publish(() => "published"); }), "published");
    // Suspended past the lease, and another request reclaimed the session and finished: the step never runs.
    let ran = false;
    let tookOver;
    await assert.rejects(withArchiveRestoreLock("taken", async (claim) => {
      age("taken");
      tookOver = await withArchiveRestoreLock("taken", async () => "took over");
      claim.publish(() => { ran = true; });
    }), (error) => error.status === 409 && error.code === "archive_restore_busy");
    assert.equal(tookOver, "took over");
    assert.equal(ran, false);
  });
});

test("a table from an earlier build of this branch moves into the claims table, keeping its claims, and the old name stops accepting writes", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, "omp-web"), { recursive: true });
    const path = join(dir, "omp-web", "archive-restore-locks.sqlite");
    const old = new Database(path);
    try {
      old.exec("CREATE TABLE restore_leases (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, renewed_at INTEGER NOT NULL)");
      old.prepare("INSERT INTO restore_leases (session_id, owner, renewed_at) VALUES (?, ?, ?)").run("live", "old-build", Date.now());
      old.prepare("INSERT INTO restore_leases (session_id, owner, renewed_at) VALUES (?, ?, ?)").run("lapsed", "old-build", Date.now() - 31_000);
    } finally { old.close(true); }
    // The live claim still blocks; the lapsed one lapses as it did; held claims work on the migrated table.
    await assert.rejects(withArchiveRestoreLock("live", async () => assert.fail("entered a live claim")), (error) => error.status === 409 && error.code === "archive_restore_busy");
    assert.equal(await withArchiveRestoreLock("lapsed", async (claim) => { claim.hold("host-a", "daemon-1"); return "held"; }), "held");
    // A second open finds the view and migrates nothing.
    assert.equal(await withArchiveRestoreLock("again", async () => "ok"), "ok");
    const db = new Database(path);
    try {
      assert.deepEqual({ ...db.prepare("SELECT owner, host_id FROM restore_claims WHERE session_id = ?").get("live") }, { owner: "old-build", host_id: null });
      assert.equal(db.prepare("SELECT host_id FROM restore_claims WHERE session_id = ?").get("lapsed").host_id, "host-a");
    } finally { db.close(true); }
    // An earlier build still running against this file: its reads work, but it cannot delete (lapse by its clock) a row or
    // claim past one, so it fails closed instead of lapsing a held claim.
    const oldBuild = new Database(path);
    try {
      // Its CREATE TABLE IF NOT EXISTS is a no-op on the view's name (or an error); either way it stops there or at its first write.
      try { oldBuild.exec("CREATE TABLE IF NOT EXISTS restore_leases (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, renewed_at INTEGER NOT NULL)"); } catch { /* also closed */ }
      assert.equal(oldBuild.prepare("SELECT owner FROM restore_leases WHERE session_id = ?").get("live").owner, "old-build");
      assert.throws(() => oldBuild.prepare("DELETE FROM restore_leases WHERE session_id = ?").run("lapsed"), /view/);
      assert.throws(() => oldBuild.prepare("INSERT INTO restore_leases (session_id, owner, renewed_at) VALUES (?, ?, ?)").run("new", "old-build", Date.now()), /view/);
    } finally { oldBuild.close(true); }
  });
});

test("a claims table made without the instance column gains it in place, keeps its held row, and that row names no process to confirm", async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, "omp-web"), { recursive: true });
    const path = join(dir, "omp-web", "archive-restore-locks.sqlite");
    const earlier = new Database(path);
    try {
      // The schema an earlier build of this branch left: the claims table and the legacy view, no `instance`, no user_version.
      earlier.exec("CREATE TABLE restore_claims (session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, renewed_at INTEGER NOT NULL, host_id TEXT)");
      earlier.exec("CREATE VIEW restore_leases AS SELECT session_id, owner, renewed_at FROM restore_claims");
      earlier.prepare("INSERT INTO restore_claims (session_id, owner, renewed_at, host_id) VALUES (?, ?, ?, ?)").run("pushed", "pushed-owner", Date.now() - 3_600_000, "host-a");
    } finally { earlier.close(true); }
    const refusal = new Error("cannot confirm");
    await assert.rejects(withArchiveRestoreLock("pushed", async () => assert.fail("entered a held claim"), async (asked) => {
      // A row with no recorded process is handed on as such: the route cannot match any answer to it, so it never confirms.
      assert.deepEqual([asked.hostId, asked.claim, asked.instance], ["host-a", "pushed-owner", null]);
      throw refusal;
    }), (error) => error === refusal);
    const db = new Database(path);
    try {
      assert.ok(db.prepare("PRAGMA table_info(restore_claims)").all().some((column) => column.name === "instance"));
      assert.deepEqual({ ...db.prepare("SELECT owner, host_id, instance FROM restore_claims WHERE session_id = ?").get("pushed") }, { owner: "pushed-owner", host_id: "host-a", instance: null });
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    } finally { db.close(true); }
  });
});
