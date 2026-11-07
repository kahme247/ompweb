import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
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
    assert.equal(statSync(join(dir, "omp-web")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "omp-web", "archive-restore-locks.sqlite")).mode & 0o777, 0o600);
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

test("restore lock reclaims only a proven dead PID and leaves live owners intact", async () => {
  await withDir(async (dir) => {
    await withArchiveRestoreLock("initialize", async () => {});
    const db = new Database(join(dir, "omp-web", "archive-restore-locks.sqlite"));
    try {
      db.prepare("INSERT INTO claims (session_id, owner, pid) VALUES (?, ?, ?)").run("dead", "old", 2147483647);
      assert.equal(await withArchiveRestoreLock("dead", async () => "reclaimed"), "reclaimed");
      db.prepare("INSERT INTO claims (session_id, owner, pid) VALUES (?, ?, ?)").run("live", "other", process.pid);
      await assert.rejects(withArchiveRestoreLock("live", async () => assert.fail("live claim entered")), (error) => error.code === "archive_restore_busy");
      assert.equal(db.prepare("SELECT owner FROM claims WHERE session_id = ?").get("live").owner, "other");
    } finally { db.close(true); }
  });
});
