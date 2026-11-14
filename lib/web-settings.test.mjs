import assert from "node:assert/strict";
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { loadWebServerSettings, readAgentToolsEnabledFromDisk, readGithubWritesUnaskedFromDisk, saveWebServerSettings } = await import("./web-settings.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-web-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults apply when no settings file exists yet", () => {
  withAgentDir(() => {
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, githubWritesUnasked: false, agentEnv: {}, browserTransport: "ws", uploadRetentionDays: 30 });
  });
});

test("agentEnv round-trips through the settings file", () => {
  withAgentDir((dir) => {
    saveWebServerSettings({ agentEnv: { OBSIDIAN_API_KEY: "secret" } });
    const written = JSON.parse(readFileSync(join(dir, "omp-web-settings.json"), "utf8"));
    assert.deepEqual(written.agentEnv, { OBSIDIAN_API_KEY: "secret" });

    // Re-read from disk (the cache is keyed by path, so a fresh dir proves the read path).
    const fresh = mkdtempSync(join(tmpdir(), "omp-web-web-settings-"));
    writeFileSync(join(fresh, "omp-web-settings.json"), JSON.stringify(written), "utf8");
    delete globalThis.__ompWebSettingsCache;
    process.env.PI_CODING_AGENT_DIR = fresh;
    try {
      assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, githubWritesUnasked: false, agentEnv: { OBSIDIAN_API_KEY: "secret" }, browserTransport: "ws", uploadRetentionDays: 30 });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

test("the settings file, which holds agentEnv, is readable by its user only, even where it was wider before", { skip: process.platform === "win32" }, () => {
  withAgentDir((dir) => {
    const file = join(dir, "omp-web-settings.json");
    writeFileSync(file, "{}\n");
    chmodSync(file, 0o644);
    saveWebServerSettings({ agentEnv: { OBSIDIAN_API_KEY: "secret" } });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

test("a patch leaves the other keys untouched", () => {
  withAgentDir(() => {
    saveWebServerSettings({ autoResumeSessions: true, agentEnv: { A: "1" } });
    saveWebServerSettings({ agentEnv: { B: "2" } });
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: true, agentToolsEnabled: false, githubWritesUnasked: false, agentEnv: { B: "2" }, browserTransport: "ws", uploadRetentionDays: 30 });
  });
});

test("saving merges the peer's disk settings and preserves a corrupt existing file", () => {
  withAgentDir((dir) => {
    const file = join(dir, "omp-web-settings.json");
    saveWebServerSettings({ agentToolsEnabled: true, githubWritesUnasked: true, uploadRetentionDays: 7 });
    writeFileSync(file, JSON.stringify({ ...loadWebServerSettings(), githubWritesUnasked: false, uploadRetentionDays: 9 }), "utf8");

    const saved = saveWebServerSettings({ autoResumeSessions: true });
    assert.equal(saved.autoResumeSessions, true);
    assert.equal(saved.agentToolsEnabled, true);
    assert.equal(saved.githubWritesUnasked, false);
    assert.equal(saved.uploadRetentionDays, 9);
    assert.equal(readGithubWritesUnaskedFromDisk(), false);

    writeFileSync(file, "{ not json", "utf8");
    assert.throws(() => saveWebServerSettings({ autoResumeSessions: false }));
    assert.equal(readFileSync(file, "utf8"), "{ not json");
  });
});

test("settings GET reports peer permission changes and refuses unreadable values", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-permission-read-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  });
  saveWebServerSettings({ githubWritesUnasked: false });
  const file = join(dir, "omp-web-settings.json");
  writeFileSync(file, JSON.stringify({ ...loadWebServerSettings(), githubWritesUnasked: true }), "utf8");
  const { GET } = await import("../app/api/web-settings/route.ts");
  assert.equal((await (await GET()).json()).githubWritesUnasked, true, "the UI must not show a stale off value for an enabled permission");
  writeFileSync(file, "{ not json", "utf8");
  const unreadable = await GET();
  assert.equal(unreadable.status, 503);
  assert.equal((await unreadable.json()).code, "settings_unavailable");
});

test("corrupt files fall back to defaults instead of throwing", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), "{ not json", "utf8");
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, githubWritesUnasked: false, agentEnv: {}, browserTransport: "ws", uploadRetentionDays: 30 });
  });
});

test("agentToolsEnabled round-trips, and a non-boolean value falls back to false (#275)", () => {
  withAgentDir(() => {
    saveWebServerSettings({ agentToolsEnabled: true });
    assert.equal(loadWebServerSettings().agentToolsEnabled, true);
  });
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ agentToolsEnabled: "yes" }), "utf8");
    assert.equal(loadWebServerSettings().agentToolsEnabled, false);
  });
});

test("watcher and write gates read peer permissions without changing cached settings", () => {
  withAgentDir((dir) => {
    const file = join(dir, "omp-web-settings.json");
    saveWebServerSettings({ agentToolsEnabled: true, githubWritesUnasked: true });
    assert.equal(loadWebServerSettings().agentToolsEnabled, true);
    assert.equal(loadWebServerSettings().githubWritesUnasked, true);

    writeFileSync(file, JSON.stringify({ agentToolsEnabled: false, githubWritesUnasked: false }), "utf8");
    assert.equal(readAgentToolsEnabledFromDisk(), false);
    assert.equal(readGithubWritesUnaskedFromDisk(), false);
    assert.equal(loadWebServerSettings().agentToolsEnabled, true);
    assert.equal(loadWebServerSettings().githubWritesUnasked, true);

    writeFileSync(file, "{ not json", "utf8");
    assert.equal(readAgentToolsEnabledFromDisk(), false);
    assert.equal(readGithubWritesUnaskedFromDisk(), false);
    rmSync(file);
    assert.equal(readAgentToolsEnabledFromDisk(), false);
    assert.equal(readGithubWritesUnaskedFromDisk(), false);
    assert.equal(loadWebServerSettings().agentToolsEnabled, true);
    assert.equal(loadWebServerSettings().githubWritesUnasked, true);
  });
});

test("githubWritesUnasked round-trips, and a non-boolean value falls back to false", () => {
  withAgentDir(() => {
    saveWebServerSettings({ githubWritesUnasked: true });
    assert.equal(loadWebServerSettings().githubWritesUnasked, true);
  });
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ githubWritesUnasked: "yes" }), "utf8");
    assert.equal(loadWebServerSettings().githubWritesUnasked, false);
  });
});

test("a missing browserTransport reads as ws, sse and ws round-trip, and unknown values (the experiment's ws-* included) read as ws with the pool numbers dropped", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ autoResumeSessions: true }), "utf8");
    assert.equal(loadWebServerSettings().browserTransport, "ws");
  });
  for (const transport of ["sse", "ws"]) {
    withAgentDir(() => {
      saveWebServerSettings({ browserTransport: transport });
      assert.equal(loadWebServerSettings().browserTransport, transport);
    });
  }
  for (const value of ["ws-client", "ws-client-split", "ws-session", "ws-pool", "websocket", true]) {
    withAgentDir((dir) => {
      writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ browserTransport: value, browserTransportPerSocket: 8, browserTransportMaxSockets: 3 }), "utf8");
      assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, githubWritesUnasked: false, agentEnv: {}, browserTransport: "ws", uploadRetentionDays: 30 }, `${JSON.stringify(value)} reads as ws`);
    });
  }
});

test("only string-valued agentEnv entries are kept", () => {
  withAgentDir((dir) => {
    writeFileSync(
      join(dir, "omp-web-settings.json"),
      JSON.stringify({ autoResumeSessions: "yes", agentEnv: { GOOD: "1", BAD: 2, WORSE: null, NESTED: { a: 1 } } }),
      "utf8",
    );
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, githubWritesUnasked: false, agentEnv: { GOOD: "1" }, browserTransport: "ws", uploadRetentionDays: 30 });
  });
});

test("uploadRetentionDays defaults to 30, null and 1..3650 round-trip, and anything else stored reads as 30", () => {
  withAgentDir((dir) => {
    for (const days of [null, 1, 7, 90, 3650]) {
      saveWebServerSettings({ uploadRetentionDays: days });
      delete globalThis.__ompWebSettingsCache;
      assert.equal(loadWebServerSettings().uploadRetentionDays, days, `${days} round-trips through the file`);
    }
    for (const stored of [0, -5, 3651, 1.5, "7", true, {}, [7], undefined]) {
      writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ uploadRetentionDays: stored }), "utf8");
      delete globalThis.__ompWebSettingsCache;
      assert.equal(loadWebServerSettings().uploadRetentionDays, 30, `${JSON.stringify(stored)} reads as 30`);
    }
  });
});

test("a non-object agentEnv is dropped", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ agentEnv: "A=1" }), "utf8");
    assert.deepEqual(loadWebServerSettings().agentEnv, {});
  });
});

test("separate settings writers serialize peer revocation with an unrelated patch", { timeout: 30_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-writers-"));
  const settingsFile = join(dir, "omp-web-settings.json");
  const lockFile = join(dir, "omp-web-settings.lock.sqlite");
  const readyFile = join(dir, "writer-a-ready");
  const proceedFile = join(dir, "writer-a-proceed");
  const probeFile = join(dir, "writer-b-probe");
  const settingsModule = new URL("./web-settings.ts", import.meta.url).href;
  const children = [];

  writeFileSync(settingsFile, JSON.stringify({
    autoResumeSessions: false,
    agentToolsEnabled: true,
    githubWritesUnasked: true,
    agentEnv: {},
    browserTransport: "ws",
    uploadRetentionDays: 30,
  }), { encoding: "utf8", mode: 0o600 });

  t.after(async () => {
    writeFileSync(proceedFile, "");
    for (const child of children) if (child.process.exitCode === null) child.process.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited.catch(() => {})));
    rmSync(dir, { recursive: true, force: true });
  });

  const launch = (script, env) => {
    const child = spawn(process.execPath, ["--eval", script], {
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, SETTINGS_MODULE: settingsModule, SETTINGS_FILE: settingsFile, LOCK_FILE: lockFile, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const record = { process: child, exited, get stderr() { return stderr; } };
    children.push(record);
    return record;
  };
  const waitForFile = async (path, child) => {
    const deadline = Date.now() + 15_000;
    while (!existsSync(path)) {
      if (child.process.exitCode !== null || child.process.signalCode !== null) {
        throw new Error(`writer exited before ${path}: ${child.stderr}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}: ${child.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  const writerA = launch(`
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const real = { ...fs };
    mock.module("fs", () => ({ ...real, writeFileSync(file, data, options) {
      if (String(file).startsWith(process.env.SETTINGS_FILE + ".tmp-" + process.pid + "-")) {
        real.writeFileSync(process.env.READY_FILE, "");
        const deadline = Date.now() + 15_000;
        while (!real.existsSync(process.env.PROCEED_FILE)) {
          if (Date.now() > deadline) throw new Error("settings writer barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return real.writeFileSync(file, data, options);
    }}));
    const { saveWebServerSettings } = await import(process.env.SETTINGS_MODULE);
    saveWebServerSettings({ autoResumeSessions: true });
  `, { READY_FILE: readyFile, PROCEED_FILE: proceedFile });
  try {
    await waitForFile(readyFile, writerA);
    assert.ok(existsSync(lockFile), "writer A holds the private lock database after reading settings");
    if (process.platform !== "win32") assert.equal(statSync(lockFile).mode & 0o777, 0o600);

    const writerB = launch(`
      import { Database } from "bun:sqlite";
      import { writeFileSync } from "node:fs";
      const probe = new Database(process.env.LOCK_FILE);
      probe.exec("PRAGMA busy_timeout = 0");
      let blocked = false;
      try {
        probe.exec("BEGIN IMMEDIATE");
        probe.exec("ROLLBACK");
      } catch (error) {
        blocked = error?.code === "SQLITE_BUSY" || /busy|locked/i.test(String(error));
      } finally {
        probe.close(true);
      }
      writeFileSync(process.env.PROBE_FILE, blocked ? "blocked" : "free");
      const { saveWebServerSettings } = await import(process.env.SETTINGS_MODULE);
      saveWebServerSettings({ githubWritesUnasked: false });
    `, { PROBE_FILE: probeFile });
    await waitForFile(probeFile, writerB);
    assert.equal(readFileSync(probeFile, "utf8"), "blocked", "writer B cannot enter while writer A is paused before its temp write");

    writeFileSync(proceedFile, "");
    const [a, b] = await Promise.all([writerA.exited, writerB.exited]);
    assert.deepEqual(a, { code: 0, signal: null }, writerA.stderr);
    assert.deepEqual(b, { code: 0, signal: null }, writerB.stderr);

    const saved = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(saved.autoResumeSessions, true);
    assert.equal(saved.githubWritesUnasked, false);
  } finally {
    writeFileSync(proceedFile, "");
  }
});