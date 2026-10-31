import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Regression tests for bug hunt round 1 (security area): the generic file
// API must never serve omp-web's own auth material, and a symlink must not
// launder a denied file into a browsable one. Synthetic fixtures only.
const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../", import.meta.url).pathname },
});

async function setup(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-authz-")));
  const agentDir = path.join(base, "agent");
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "omp-web"), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = base;
  delete process.env.PI_CONFIG_DIR;
  delete process.env.XDG_DATA_HOME;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    globalThis.__piAllowedRootsCache = undefined;
    globalThis.__piSessionListCache = undefined;
    globalThis.__piSessionListPromise = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const fa = await jiti.import("./file-access.ts");
  const fz = await jiti.import("./file-authorization.ts");
  const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
  fa.allowFileRoot(ws);
  globalThis.__piAllowedRootsCache = undefined;
  invalidateSessionListCache();
  const segs = (p) => p.split("/").filter(Boolean);
  return { base, agentDir, ws, outside, fa, fz, segs, invalidateSessionListCache };
}

function writeSessionFile(dir, name, header, entries = []) {
  const lines = [JSON.stringify({ type: "session", version: 3, ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  fs.writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`);
}

test("denies direct reads of omp-web auth material under the agent dir", async (t) => {
  const { agentDir, fz, segs } = await setup(t);
  fs.writeFileSync(path.join(agentDir, "omp-web", "web-auth-secret.json"), JSON.stringify({ salt: "S", key: "K" }));
  fs.writeFileSync(path.join(agentDir, "web-service.env"), 'OMP_WEB_PASSWORD_HASH="scrypt$15$8$1$AAAA$BBBB"\n');
  fs.writeFileSync(path.join(agentDir, "omp-web", "notifications.db"), "SQLITE-FAKE");
  for (const p of [
    path.join(agentDir, "omp-web", "web-auth-secret.json"),
    path.join(agentDir, "web-service.env"),
    path.join(agentDir, "omp-web", "notifications.db"),
  ]) {
    const decision = await fz.authorizeFileAccess(segs(p), null, false);
    assert.equal(decision.ok, false, `${p} must be denied`);
    assert.equal(decision.status, 403);
  }
});

test("denies agent.db sidecars directly", async (t) => {
  const { agentDir, fz, segs } = await setup(t);
  for (const name of ["agent.db-wal", "agent.db-shm", "agent.db-journal"]) {
    fs.writeFileSync(path.join(agentDir, name), "WAL-CREDENTIAL-BYTES");
    const decision = await fz.authorizeFileAccess(segs(path.join(agentDir, name)), null, false);
    assert.equal(decision.ok, false, `${name} must be denied`);
    assert.equal(decision.status, 403);
  }
});

test("denies a denied file reached through a workspace symlink, and serves the realpath otherwise", async (t) => {
  const { agentDir, ws, fz, segs } = await setup(t);
  const agentDb = path.join(agentDir, "agent.db");
  const modelsYml = path.join(agentDir, "models.yml");
  fs.writeFileSync(agentDb, "SECRET-AGENT-DB");
  fs.writeFileSync(modelsYml, "apiKey: sk-SECRET\n");
  const linkDb = path.join(ws, "link.db");
  const linkYml = path.join(ws, "models-link.yml");
  fs.symlinkSync(agentDb, linkDb);
  fs.symlinkSync(modelsYml, linkYml);
  for (const link of [linkDb, linkYml]) {
    const decision = await fz.authorizeFileAccess(segs(link), null, false);
    assert.equal(decision.ok, false, `${link} must be denied`);
    assert.equal(decision.status, 403);
  }
  // A benign symlink still resolves, and the decision names the real file.
  const target = path.join(ws, "real.txt");
  fs.writeFileSync(target, "hello\n");
  const benignLink = path.join(ws, "alias.txt");
  fs.symlinkSync(target, benignLink);
  const allowed = await fz.authorizeFileAccess(segs(benignLink), null, false);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.filePath, target);
});

test("denies a denied file reached through a session-referenced symlink outside any root", async (t) => {
  const { agentDir, outside, ws, fz, segs, invalidateSessionListCache } = await setup(t);
  const agentDb = path.join(agentDir, "agent.db");
  fs.writeFileSync(agentDb, "SECRET-AGENT-DB");
  const link = path.join(outside, "ref.db");
  fs.symlinkSync(agentDb, link);
  // A session whose transcript mentions the link: without the denied check
  // running on the realpath first, the session-reference admission alone
  // would let this through (it skips the existing-path root check).
  // Session ids must be UUIDs for the reference check to run at all.
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";
  writeSessionFile(path.join(agentDir, "sessions", "-project"), "2026-01-01_ref.jsonl", {
    id: sessionId,
    cwd: ws,
    timestamp: "2026-01-01T00:00:00.000Z",
  }, [
    { type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: `please look at ${link}` }] } },
  ]);
  invalidateSessionListCache();
  const decision = await fz.authorizeFileAccess(segs(link), sessionId, true);
  assert.equal(decision.ok, false, "session-referenced symlink to agent.db must be denied");
  assert.equal(decision.status, 403);
});
