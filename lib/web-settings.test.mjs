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
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("defaults apply when no settings file exists yet", () => {
  withAgentDir(() => {
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: {}, browserTransport: "sse" });
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
      assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: { OBSIDIAN_API_KEY: "secret" }, browserTransport: "sse" });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

test("a patch leaves the other keys untouched", () => {
  withAgentDir(() => {
    saveWebServerSettings({ autoResumeSessions: true, agentEnv: { A: "1" } });
    saveWebServerSettings({ agentEnv: { B: "2" } });
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: true, agentToolsEnabled: false, agentEnv: { B: "2" }, browserTransport: "sse" });
  });
});

test("corrupt files fall back to defaults instead of throwing", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), "{ not json", "utf8");
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: {}, browserTransport: "sse" });
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

test("browserTransport round-trips and anything but websocket reads as sse", () => {
  withAgentDir(() => {
    saveWebServerSettings({ browserTransport: "websocket" });
    assert.equal(loadWebServerSettings().browserTransport, "websocket");
  });
  for (const stored of ["ws", true]) {
    withAgentDir((dir) => {
      writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ browserTransport: stored }), "utf8");
      assert.equal(loadWebServerSettings().browserTransport, "sse");
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
    assert.deepEqual(loadWebServerSettings(), { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: { GOOD: "1" }, browserTransport: "sse" });
  });
});

test("a non-object agentEnv is dropped", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "omp-web-settings.json"), JSON.stringify({ agentEnv: "A=1" }), "utf8");
    assert.deepEqual(loadWebServerSettings().agentEnv, {});
  });
});