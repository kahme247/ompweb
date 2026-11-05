import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { loadWebServerSettings, saveWebServerSettings } = await import("./web-settings.ts");

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
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: {}, browserTransport: "ws", uploadRetentionDays: 30 });
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
      assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: { OBSIDIAN_API_KEY: "secret" }, browserTransport: "ws", uploadRetentionDays: 30 });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

test("a patch leaves the other keys untouched", () => {
  withAgentDir(() => {
    saveWebServerSettings({ autoResumeSessions: true, agentEnv: { A: "1" } });
    saveWebServerSettings({ agentEnv: { B: "2" } });
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: true, agentToolsEnabled: false, agentEnv: { B: "2" }, browserTransport: "ws", uploadRetentionDays: 30 });
  });
});

test("corrupt files fall back to defaults instead of throwing", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), "{ not json", "utf8");
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: {}, browserTransport: "ws", uploadRetentionDays: 30 });
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
      assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: {}, browserTransport: "ws", uploadRetentionDays: 30 }, `${JSON.stringify(value)} reads as ws`);
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
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: { GOOD: "1" }, browserTransport: "ws", uploadRetentionDays: 30 });
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