import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gzipSync } from "node:zlib";
import test from "node:test";
import { mockBuiltin } from "../../tests/mock-builtin.mjs";

// Captured before any test replaces the module: the interposed tests below call through to these.
const realFs = { ...(await import("fs")) };
const { listArchivedSessions, restoreArchivedSession, restoreFailureStatus, MAX_ARCHIVE_COMPRESSED_BYTES, MAX_ARCHIVE_EXPANDED_BYTES } = await import("./archive.ts");
const SESSION_ID = "12345678-1234-4234-8234-123456789abc";

function sessionBody(id = SESSION_ID) {
  return [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/workspace/project", timestamp: "2026-08-20T12:00:00.000Z", title: "Archived work" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-08-20T12:00:01.000Z", message: { role: "user", content: "Fix the archived issue" } }),
  ].join("\n") + "\n";
}

test("lists archive metadata and restores the session with artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-browser-"));
  try {
    const sessions = join(root, "sessions");
    const archive = join(root, "archive", "sessions");
    const archiveFile = join(archive, "project", "2026_session.jsonl.gz");
    mkdirSync(join(archive, "project", "2026_session.jsonl"), { recursive: true });
    mkdirSync(join(sessions, "project"), { recursive: true });
    writeFileSync(join(archive, "project", "2026_session.jsonl", "child.jsonl"), "child\n");
    writeFileSync(archiveFile, gzipSync(Buffer.from(sessionBody())));

    const listed = await listArchivedSessions(archive);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].key, "project/2026_session.jsonl.gz");
    assert.equal(listed[0].firstMessage, "Fix the archived issue");
    assert.equal(listed[0].messageCount, 1);

    const restoredId = await restoreArchivedSession(listed[0].key, sessions, archive);
    assert.equal(restoredId, SESSION_ID);
    assert.equal(existsSync(join(sessions, "project", "2026_session.jsonl")), true);
    assert.equal(readFileSync(join(sessions, "project", "2026_session", "child.jsonl"), "utf8"), "child\n");
    assert.equal(existsSync(archiveFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore runs its commit through the publish guard, and a refusing guard leaves archive and sessions untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-publish-"));
  try {
    const sessions = join(root, "sessions");
    const archive = join(root, "archive", "sessions");
    const archiveFile = join(archive, "project", "2026_session.jsonl.gz");
    const compressed = gzipSync(Buffer.from(sessionBody()));
    mkdirSync(join(archive, "project"), { recursive: true });
    mkdirSync(join(sessions, "project"), { recursive: true });
    writeFileSync(archiveFile, compressed);
    const refusal = new Error("claim lost");
    // Refused at the publish step: the transcript is staged but never made visible.
    await assert.rejects(() => restoreArchivedSession("project/2026_session.jsonl.gz", sessions, archive, () => { throw refusal; }), (error) => error === refusal);
    assert.deepEqual(readFileSync(archiveFile), compressed);
    assert.equal(existsSync(join(sessions, "project", "2026_session.jsonl")), false);
    let published = 0;
    // The step is synchronous: a caller holding a lock across it must never have to await.
    const id = await restoreArchivedSession("project/2026_session.jsonl.gz", sessions, archive, (run) => { published++; const result = run(); assert.equal(typeof result?.then, "undefined"); return result; });
    assert.equal(id, SESSION_ID);
    assert.equal(published, 1);
    assert.equal(existsSync(join(sessions, "project", "2026_session.jsonl")), true);
    assert.equal(existsSync(archiveFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** An archived session with artifacts (one of them an upload the transcript links as local://uploads/photo.txt) and an empty sessions root. */
function archivedWithArtifacts() {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-commit-"));
  const sessions = join(root, "sessions");
  const archive = join(root, "archive", "sessions");
  const archiveFile = join(archive, "project", "2026_session.jsonl.gz");
  const artifacts = join(archive, "project", "2026_session.jsonl");
  const compressed = gzipSync(Buffer.from(sessionBody()));
  mkdirSync(join(artifacts, "local", "uploads"), { recursive: true });
  mkdirSync(join(sessions, "project"), { recursive: true });
  writeFileSync(archiveFile, compressed);
  writeFileSync(join(artifacts, "local", "uploads", "photo.txt"), "archived");
  const restore = (publish) => restoreArchivedSession("project/2026_session.jsonl.gz", sessions, archive, publish);
  return {
    root, sessions, archive, archiveFile, artifacts, compressed, restore,
    key: "project/2026_session.jsonl.gz",
    transcript: join(sessions, "project", "2026_session.jsonl"),
    restoredArtifacts: join(sessions, "project", "2026_session"),
  };
}

test("the guarded step commits the artifacts, the transcript and the consumed archive together, so the session is never visible without its artifacts", async () => {
  const { root, archiveFile, artifacts, restore, transcript, restoredArtifacts } = archivedWithArtifacts();
  try {
    // Nothing has moved when the guard is entered: a guard that refuses leaves the archive whole (the test above).
    await restore((run) => {
      assert.equal(existsSync(restoredArtifacts), false);
      assert.equal(existsSync(transcript), false);
      const result = run();
      // Back from the one synchronous step, with no await in between for anything else to run: the transcript and its
      // artifacts are both in place, and the archive is gone.
      assert.equal(readFileSync(join(restoredArtifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
      assert.equal(existsSync(transcript), true);
      assert.equal(existsSync(artifacts), false);
      assert.equal(existsSync(archiveFile), false);
      return result;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [what, intrude] of [
  // Another restore, or a session of that name, wins the destination between the checks and the commit.
  ["a transcript appears at the destination", ({ transcript }) => writeFileSync(transcript, "someone else's")],
  // An active artifacts directory appears there (an attachment, say): never merged into, replaced or removed.
  ["an artifacts directory appears at the destination", ({ restoredArtifacts }) => {
    mkdirSync(join(restoredArtifacts, "local", "uploads"), { recursive: true });
    writeFileSync(join(restoredArtifacts, "local", "uploads", "other.txt"), "kept");
  }],
]) {
  test(`${what} before the commit: the restore is refused, and the archive, its artifacts and what appeared are untouched`, async () => {
    const scene = archivedWithArtifacts();
    try {
      await assert.rejects(scene.restore((run) => { intrude(scene); return run(); }), /already exists/);
      assert.equal(restoreFailureStatus("Active session destination already exists"), 409);
      assert.deepEqual(readFileSync(scene.archiveFile), scene.compressed);
      assert.equal(readFileSync(join(scene.artifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
      if (what.startsWith("a transcript")) {
        assert.equal(readFileSync(scene.transcript, "utf8"), "someone else's");
        assert.equal(existsSync(scene.restoredArtifacts), false);
      } else {
        assert.equal(readFileSync(join(scene.restoredArtifacts, "local", "uploads", "other.txt"), "utf8"), "kept");
        assert.equal(existsSync(scene.transcript), false);
      }
    } finally {
      rmSync(scene.root, { recursive: true, force: true });
    }
  });
}

test("an archive that cannot be consumed rolls the whole commit back: no transcript, the artifacts back where they were", async () => {
  const { root, archiveFile, artifacts, restore, transcript, restoredArtifacts } = archivedWithArtifacts();
  try {
    // The .gz turns into a directory just before the commit, so removing it fails after the artifacts moved and the transcript linked.
    await assert.rejects(restore((run) => {
      rmSync(archiveFile);
      mkdirSync(archiveFile);
      return run();
    }));
    assert.equal(statSync(archiveFile).isDirectory(), true);
    assert.equal(existsSync(transcript), false);
    assert.equal(existsSync(restoredArtifacts), false);
    assert.equal(readFileSync(join(artifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A restore whose `fs` is interposed, to land another process's action at an exact instant between two of the commit's steps
 * (what that process does is only a change to the file system, so playing it here is what it would see and do). */
async function restoreWithFs(t, label, scene, overrides) {
  await mockBuiltin(t, "fs", overrides);
  const { restoreArchivedSession: restore } = await import(`./archive.ts?fresh=${label}`);
  return (publish) => restore(scene.key, scene.sessions, scene.archive, publish);
}

// A POSIX rename(2) replaces an empty directory at its target, and Windows' never replaces a directory: the claim-then-rename
// these tests probe is the POSIX path.
const posix = { skip: process.platform === "win32" };

test("an empty directory another process creates at the destination after the pre-check is never replaced", posix, async (t) => {
  const scene = archivedWithArtifacts();
  try {
    let intruded = false;
    // The pre-check has found nothing there; an attachment's `mkdir -p` then creates the session's directory, empty so far.
    // That lands before the first thing the move does to the destination: its claim (`mkdir`), or, in a move that is a
    // plain `rename`, the rename itself. An earlier instant would be caught by the pre-check, which is not what this is about.
    const intrude = (file) => {
      if (file === scene.restoredArtifacts && !intruded) { intruded = true; realFs.mkdirSync(file); }
    };
    const restore = await restoreWithFs(t, "empty-dir-after-check", scene, {
      mkdirSync(file, ...args) { intrude(file); return realFs.mkdirSync(file, ...args); },
      renameSync(from, to) { intrude(to); return realFs.renameSync(from, to); },
    });
    await assert.rejects(restore(), /already exists/);
    assert.equal(intruded, true);
    // Not replaced: still the other process's empty directory, with nothing of ours in it, and nothing published or consumed.
    assert.deepEqual(readdirSync(scene.restoredArtifacts), []);
    assert.equal(existsSync(scene.transcript), false);
    assert.deepEqual(readFileSync(scene.archiveFile), scene.compressed);
    assert.equal(readFileSync(join(scene.artifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
  } finally {
    rmSync(scene.root, { recursive: true, force: true });
  }
});

test("content another process puts into the claimed destination is never replaced or removed", posix, async (t) => {
  const scene = archivedWithArtifacts();
  try {
    let intruded = false;
    const restore = await restoreWithFs(t, "content-in-claim", scene, {
      // Between taking the name and moving onto it, the other process writes into it.
      renameSync(from, to) {
        if (to === scene.restoredArtifacts && realFs.existsSync(to) && !intruded) {
          intruded = true;
          writeFileSync(join(to, "foreign.txt"), "theirs");
        }
        return realFs.renameSync(from, to);
      },
    });
    await assert.rejects(restore(), /already exists/);
    assert.equal(intruded, true, "the destination is claimed before it is moved onto");
    assert.equal(readFileSync(join(scene.restoredArtifacts, "foreign.txt"), "utf8"), "theirs");
    assert.deepEqual(readdirSync(scene.restoredArtifacts), ["foreign.txt"]);
    assert.equal(existsSync(scene.transcript), false);
    assert.deepEqual(readFileSync(scene.archiveFile), scene.compressed);
    assert.equal(readFileSync(join(scene.artifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
  } finally {
    rmSync(scene.root, { recursive: true, force: true });
  }
});

test("a rollback never replaces what appeared at the archive's artifacts path meanwhile: the artifacts stay put and the failure says so", posix, async (t) => {
  const scene = archivedWithArtifacts();
  try {
    let intruded = false;
    const restore = await restoreWithFs(t, "source-retaken", scene, {
      // The transcript link fails (another session of that name won the destination), and just before the rollback another
      // process creates an empty directory at the path the artifacts came from.
      linkSync(existing, target) {
        if (target === scene.transcript && !intruded) { intruded = true; mkdirSync(scene.artifacts); }
        return realFs.linkSync(existing, target);
      },
    });
    await assert.rejects(restore((run) => { writeFileSync(scene.transcript, "someone else's"); return run(); }), /already exists.*could not be undone/);
    assert.equal(intruded, true);
    // The other process's directory is untouched, and the artifacts it did not replace are still at the destination.
    assert.deepEqual(readdirSync(scene.artifacts), []);
    assert.equal(readFileSync(join(scene.restoredArtifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
    assert.equal(readFileSync(scene.transcript, "utf8"), "someone else's");
    assert.deepEqual(readFileSync(scene.archiveFile), scene.compressed);
  } finally {
    rmSync(scene.root, { recursive: true, force: true });
  }
});

test("a rollback never deletes a transcript it did not link: one another process swapped in is left in place, whole", async (t) => {
  const scene = archivedWithArtifacts();
  try {
    let swapped = false;
    const restore = await restoreWithFs(t, "transcript-swapped", scene, {
      // The archive cannot be consumed (it became a directory), which starts the rollback; first another process replaces the
      // transcript we linked with its own.
      unlinkSync(file) {
        if (file === scene.archiveFile && !swapped) {
          swapped = true;
          rmSync(scene.transcript);
          writeFileSync(scene.transcript, "theirs");
        }
        return realFs.unlinkSync(file);
      },
    });
    await assert.rejects(restore((run) => { rmSync(scene.archiveFile); mkdirSync(scene.archiveFile); return run(); }));
    assert.equal(swapped, true);
    assert.equal(readFileSync(scene.transcript, "utf8"), "theirs");
    // Nothing of the rollback is left beside it, and the artifacts did go back.
    assert.deepEqual(readdirSync(dirname(scene.transcript)).sort(), ["2026_session.jsonl"]);
    assert.equal(readFileSync(join(scene.artifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
  } finally {
    rmSync(scene.root, { recursive: true, force: true });
  }
});

// The checks before the commit are asynchronous, so a directory can be swapped for a link after the last of them: the commit
// repeats them synchronously, and what a restore would move or write through such a link is outside its roots.
for (const [what, swap] of [
  ["the archive's project directory", (scene, outside) => {
    const project = dirname(scene.archiveFile);
    renameSync(project, join(scene.root, "moved-archive"));
    symlinkSync(outside, project);
  }],
  ["the sessions project directory", (scene, outside) => {
    const project = dirname(scene.transcript);
    renameSync(project, join(scene.root, "moved-sessions"));
    symlinkSync(outside, project);
  }],
]) {
  test(`${what} turned into a link out of its root just before the commit is refused, and nothing outside is touched`, posix, async () => {
    const scene = archivedWithArtifacts();
    try {
      const outside = join(scene.root, "outside");
      // What a restore would move if it followed the link: a same-named artifacts directory out there.
      mkdirSync(join(outside, "2026_session.jsonl"), { recursive: true });
      writeFileSync(join(outside, "2026_session.jsonl", "secret.txt"), "outside");
      const before = readdirSync(outside, { recursive: true }).sort();
      await assert.rejects(scene.restore((run) => { swap(scene, outside); return run(); }), /Invalid archive key/);
      assert.deepEqual(readdirSync(outside, { recursive: true }).sort(), before);
      assert.equal(readFileSync(join(outside, "2026_session.jsonl", "secret.txt"), "utf8"), "outside");
    } finally {
      rmSync(scene.root, { recursive: true, force: true });
    }
  });
}

test("another process acting the instant the session becomes visible finds its archived artifacts already in place and attaches beside them", async () => {
  // A separate process that does what an upload's attach does, the moment the transcript exists: it records whether the
  // archived artifacts are already there, then creates the session's `local/uploads` directory. Linking the transcript first
  // and moving the artifacts after (several event-loop turns later) fails both: it sees none, and its directory then takes
  // the artifacts' path, so the restore is refused and rolled back.
  const script = `
    import { existsSync, mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const { TRANSCRIPT, ARCHIVED_FILE, ATTACH_DIR } = process.env;
    console.log("ready");
    const deadline = Date.now() + 20000;
    while (!existsSync(TRANSCRIPT)) {
      if (Date.now() > deadline) { console.log(JSON.stringify({ timedOut: true })); process.exit(0); }
    }
    const artifactsInPlace = existsSync(ARCHIVED_FILE);
    let attached = true;
    try {
      mkdirSync(ATTACH_DIR, { recursive: true });
      writeFileSync(join(ATTACH_DIR, "photo (1).txt"), "attached");
    } catch (error) {
      attached = error.message;
    }
    console.log(JSON.stringify({ artifactsInPlace, attached }));
  `;
  for (let round = 0; round < 5; round++) {
    const scene = archivedWithArtifacts();
    try {
      const uploads = join(scene.restoredArtifacts, "local", "uploads");
      const env = { ...process.env, TRANSCRIPT: scene.transcript, ARCHIVED_FILE: join(uploads, "photo.txt"), ATTACH_DIR: uploads };
      const child = spawn(process.execPath, ["--eval", script], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let polling;
      const ready = new Promise((resolve) => { polling = resolve; });
      child.stdout.on("data", (chunk) => { out += chunk; if (out.includes("ready")) polling(); });
      child.stderr.on("data", (chunk) => { err += chunk; });
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`observer exited ${code}: ${err}`)));
      });
      await ready;
      try {
        assert.deepEqual(await scene.restore(), SESSION_ID);
      } catch (error) {
        // The restore failed, so the observer may never see a session: end it, and let the failure be the one reported.
        child.kill();
        exited.catch(() => {});
        throw error;
      }
      await exited;
      const seen = JSON.parse(out.trim().split("\n").at(-1));
      assert.deepEqual(seen, { artifactsInPlace: true, attached: true });
      assert.equal(readFileSync(join(uploads, "photo.txt"), "utf8"), "archived");
      assert.equal(readFileSync(join(uploads, "photo (1).txt"), "utf8"), "attached");
      assert.equal(readFileSync(join(scene.restoredArtifacts, "..", "2026_session.jsonl"), "utf8"), sessionBody());
    } finally {
      rmSync(scene.root, { recursive: true, force: true });
    }
  }
});

test("restores of one archive racing in separate processes publish it exactly once and lose nothing", { timeout: 60_000 }, async () => {
  const archiveUrl = pathToFileURL(join(import.meta.dir, "archive.ts")).href;
  const script = `
    import { restoreArchivedSession } from ${JSON.stringify(archiveUrl)};
    const { SESSIONS, ARCHIVE, KEY, START_AT } = process.env;
    while (Date.now() < Number(START_AT)) { /* start together */ }
    try {
      await restoreArchivedSession(KEY, SESSIONS, ARCHIVE);
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
    }
  `;
  for (let round = 0; round < 3; round++) {
    const scene = archivedWithArtifacts();
    try {
      // Late starters only race less tightly: the invariants below hold for any interleaving.
      const startAt = Date.now() + 500;
      const results = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
        const env = { ...process.env, SESSIONS: scene.sessions, ARCHIVE: scene.archive, KEY: scene.key, START_AT: String(startAt) };
        const child = spawn(process.execPath, ["--eval", script], { env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err += chunk; });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve(JSON.parse(out.trim().split("\n").at(-1))) : reject(new Error(`restorer exited ${code}: ${err}`)));
      })));
      assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
      for (const result of results.filter((entry) => !entry.ok)) assert.match(result.error, /already exists|not found/);
      // One session, whole: its transcript, every artifact, no archive left, nothing staged or half-moved beside it.
      assert.deepEqual(readFileSync(scene.transcript), Buffer.from(sessionBody()));
      assert.equal(readFileSync(join(scene.restoredArtifacts, "local", "uploads", "photo.txt"), "utf8"), "archived");
      assert.equal(existsSync(scene.archiveFile), false);
      assert.equal(existsSync(scene.artifacts), false);
      assert.deepEqual(readdirSync(join(scene.sessions, "project")).sort(), ["2026_session", "2026_session.jsonl"]);
    } finally {
      rmSync(scene.root, { recursive: true, force: true });
    }
  }
});

test("rejects traversal archive keys", async () => {
  await assert.rejects(
    () => restoreArchivedSession("../outside.jsonl.gz", "sessions", "archive"),
    /Invalid archive key/,
  );
});

for (const escape of ["source ancestor", "destination ancestor", "source artifacts", "destination artifacts"]) {
  test(`rejects escaping symlink at ${escape} without changing archive or outside data`, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-escape-"));
    try {
      const sessions = join(root, "sessions");
      const archive = join(root, "archive");
      const outside = join(root, "outside");
      mkdirSync(join(archive, "project"), { recursive: true });
      mkdirSync(join(sessions, "project"), { recursive: true });
      mkdirSync(outside);
      const compressed = gzipSync(Buffer.from(sessionBody()));
      const archiveFile = join(escape === "source ancestor" ? outside : join(archive, "project"), "session.jsonl.gz");
      writeFileSync(archiveFile, compressed);
      writeFileSync(join(outside, "sentinel"), "unchanged");
      if (escape.endsWith("ancestor")) {
        const project = join(escape === "source ancestor" ? archive : sessions, "project");
        rmSync(project, { recursive: true });
        symlinkSync(outside, project);
      } else {
        symlinkSync(outside, escape === "source artifacts"
          ? join(archive, "project", "session.jsonl")
          : join(sessions, "project", "session"));
      }

      await assert.rejects(() => restoreArchivedSession("project/session.jsonl.gz", sessions, archive), /Invalid archive key/);
      assert.deepEqual(readFileSync(archiveFile), compressed);
      assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "unchanged");
      assert.equal(existsSync(join(outside, "session.jsonl")), false);
      assert.equal(existsSync(join(sessions, "project", "session.jsonl")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("restores byte-identical transcript and artifacts into a missing project parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-missing-parent-"));
  try {
    const sessions = join(root, "sessions");
    const archive = join(root, "archive");
    const source = join(archive, "project", "session.jsonl.gz");
    const body = Buffer.from(sessionBody() + "\n");
    const artifact = Buffer.from([0, 255, 13, 10]);
    mkdirSync(join(archive, "project", "session.jsonl"), { recursive: true });
    writeFileSync(source, gzipSync(body));
    writeFileSync(join(archive, "project", "session.jsonl", "artifact"), artifact);

    assert.equal(await restoreArchivedSession("project/session.jsonl.gz", sessions, archive), SESSION_ID);
    assert.deepEqual(readFileSync(join(sessions, "project", "session.jsonl")), body);
    assert.deepEqual(readFileSync(join(sessions, "project", "session", "artifact")), artifact);
    assert.equal(existsSync(source), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported archived IDs before publishing or moving artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-invalid-id-"));
  try {
    const archive = join(root, "archive");
    const sessions = join(root, "sessions");
    mkdirSync(join(archive, "session.jsonl"), { recursive: true });
    const source = join(archive, "session.jsonl.gz");
    const compressed = gzipSync(sessionBody("legacy-id"));
    writeFileSync(source, compressed);
    writeFileSync(join(archive, "session.jsonl", "artifact"), "retained");
    assert.equal((await listArchivedSessions(archive))[0].id, "legacy-id");
    await assert.rejects(() => restoreArchivedSession("session.jsonl.gz", sessions, archive), /Invalid archived session ID/);
    assert.equal(restoreFailureStatus("Invalid archived session ID"), 400);
    assert.deepEqual(readFileSync(source), compressed);
    assert.equal(readFileSync(join(archive, "session.jsonl", "artifact"), "utf8"), "retained");
    assert.equal(existsSync(join(sessions, "session.jsonl")), false);
    assert.equal(existsSync(join(sessions, "session")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const limit of ["compressed", "expanded"]) {
  test(`rejects archives exceeding the ${limit} limit without consuming data`, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-limit-"));
    try {
      const archive = join(root, "archive");
      const sessions = join(root, "sessions");
      mkdirSync(join(archive, "session.jsonl"), { recursive: true });
      const source = join(archive, "session.jsonl.gz");
      writeFileSync(join(archive, "session.jsonl", "artifact"), "retained");
      if (limit === "compressed") {
        writeFileSync(source, gzipSync(sessionBody()));
        truncateSync(source, MAX_ARCHIVE_COMPRESSED_BYTES + 1);
      } else {
        const chunk = Buffer.alloc(1024 * 1024, " ");
        await pipeline(Readable.from((function* () {
          yield sessionBody();
          for (let written = 0; written <= MAX_ARCHIVE_EXPANDED_BYTES; written += chunk.length) yield chunk;
        })()), createGzip(), createWriteStream(source));
      }
      const compressed = limit === "expanded" ? readFileSync(source) : null;
      const sourceSize = statSync(source).size;
      await assert.rejects(() => restoreArchivedSession("session.jsonl.gz", sessions, archive), new RegExp(`Archived session ${limit} size exceeds 256 MiB limit`));
      assert.equal(statSync(source).size, sourceSize);
      if (compressed) assert.deepEqual(readFileSync(source), compressed);
      assert.equal(readFileSync(join(archive, "session.jsonl", "artifact"), "utf8"), "retained");
      assert.equal(existsSync(join(sessions, "session.jsonl")), false);
      assert.equal(existsSync(join(sessions, "session")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("restore yields to the event loop before completing streamed I/O", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-async-"));
  try {
    const archive = join(root, "archive");
    mkdirSync(archive);
    writeFileSync(join(archive, "session.jsonl.gz"), gzipSync(sessionBody()));
    let completed = false;
    const restoring = restoreArchivedSession("session.jsonl.gz", join(root, "sessions"), archive);
    assert.ok(restoring instanceof Promise);
    const tracked = restoring.then((id) => { completed = true; return id; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(await tracked, SESSION_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const operation of ["lstat", "realpath"]) {
  test(`restore keeps the event loop responsive during delayed ${operation} metadata`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-metadata-"));
    const archive = join(root, "archive");
    const sessions = join(root, "sessions");
    const source = join(archive, "session.jsonl.gz");
    mkdirSync(archive);
    writeFileSync(source, gzipSync(sessionBody()));
    const real = { ...await import("fs/promises") };
    let entered;
    let release;
    const delayed = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    await mockBuiltin(t, "fs/promises", {
      async [operation](file, ...args) {
        if (file === archive) { entered(); await gate; }
        return real[operation](file, ...args);
      },
    });
    const { restoreArchivedSession: restore } = await import(`./archive.ts?fresh=metadata-${operation}`);
    let completed = false;
    const restoring = restore("session.jsonl.gz", sessions, archive).then((id) => {
      completed = true;
      return id;
    });
    try {
      await Promise.race([
        delayed,
        restoring.then(() => assert.fail(`restore completed without awaiting async ${operation} metadata`)),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(completed, false, "event-loop callback runs while path metadata is pending");
      assert.equal(existsSync(source), true, "pending path validation must not consume the archive");
      release();
      assert.equal(await restoring, SESSION_ID);
      assert.equal(readFileSync(join(sessions, "session.jsonl"), "utf8"), sessionBody());
    } finally {
      release();
      await restoring.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const code of ["EACCES", "EIO"]) {
  test(`restore propagates ${code} from the source existence check without consuming data`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-metadata-error-"));
    const archive = join(root, "archive");
    const sessions = join(root, "sessions");
    const source = join(archive, "session.jsonl.gz");
    mkdirSync(archive);
    const compressed = gzipSync(sessionBody());
    writeFileSync(source, compressed);
    const real = { ...await import("fs/promises") };
    const failure = Object.assign(new Error("metadata unavailable"), { code });
    let sourceChecks = 0;
    await mockBuiltin(t, "fs/promises", {
      async lstat(file, ...args) {
        if (file === source && ++sourceChecks === 2) throw failure;
        return real.lstat(file, ...args);
      },
    });
    const { restoreArchivedSession: restore } = await import(`./archive.ts?fresh=metadata-error-${code}`);
    try {
      await assert.rejects(() => restore("session.jsonl.gz", sessions, archive), (error) => error === failure);
      assert.deepEqual(readFileSync(source), compressed);
      assert.equal(existsSync(join(sessions, "session.jsonl")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const failure of ["destination", "artifacts", "corrupt gzip"]) {
  test(`preserves source on ${failure} failure`, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-web-archive-rollback-"));
    try {
      const archive = join(root, "archive");
      const sessions = join(root, "sessions");
      mkdirSync(archive);
      mkdirSync(sessions);
      const source = join(archive, "session.jsonl.gz");
      const compressed = failure === "corrupt gzip" ? Buffer.from("not gzip") : gzipSync(sessionBody());
      writeFileSync(source, compressed);
      if (failure === "destination") writeFileSync(join(sessions, "session.jsonl"), "existing");
      if (failure === "artifacts") writeFileSync(join(archive, "session.jsonl"), "invalid artifacts");
      await assert.rejects(() => restoreArchivedSession("session.jsonl.gz", sessions, archive));
      assert.deepEqual(readFileSync(source), compressed);
      if (failure === "destination") assert.equal(readFileSync(join(sessions, "session.jsonl"), "utf8"), "existing");
      else assert.equal(existsSync(join(sessions, "session.jsonl")), false);
      if (failure === "artifacts") assert.equal(readFileSync(join(archive, "session.jsonl"), "utf8"), "invalid artifacts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("restores a native title-slot-prefixed header byte-for-byte", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-web-archive-title-slot-"));
  try {
    const archive = join(root, "archive");
    const sessions = join(root, "sessions");
    mkdirSync(archive);
    const body = JSON.stringify({ type: "title", v: 1, title: "Slot title", updatedAt: "2026-08-20T12:00:00.000Z", pad: "" }) + "\n" + sessionBody();
    writeFileSync(join(archive, "session.jsonl.gz"), gzipSync(body));
    assert.equal(await restoreArchivedSession("session.jsonl.gz", sessions, archive), SESSION_ID);
    assert.equal(readFileSync(join(sessions, "session.jsonl"), "utf8"), body);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
