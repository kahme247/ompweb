import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, openSync, closeSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const { deleteMcpServer, parseMcpListOutput, readMcpConfig, readUserMcpConfig, redactMcpServer, validateMcpServer, writeMcpServer } = await import("./mcp-config.ts");

function withWorkspace(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-mcp-config-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writes, renames, and removes a native project MCP server", () => {
  withWorkspace((cwd) => {
    writeMcpServer(cwd, "filesystem", { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] });
    let file = readMcpConfig(cwd);
    assert.match(file.path.replace(/\\/g, "/"), /\.omp\/mcp\.json$/);
    assert.equal(file.config.mcpServers.filesystem.command, "npx");

    writeMcpServer(cwd, "project-files", { type: "stdio", command: "npx", args: [] }, "filesystem");
    file = readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers), ["project-files"]);

    deleteMcpServer(cwd, "project-files");
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, {});
  });
});

test("redacts project MCP credentials and preserves them on edits and renames", () => {
  withWorkspace((cwd) => {
    writeMcpServer(cwd, "private", { type: "stdio", command: "node", env: { API_KEY: "secret" }, headers: { Authorization: "Bearer secret" } });
    const stored = readMcpConfig(cwd).config.mcpServers.private;
    assert.deepEqual(redactMcpServer(stored), { type: "stdio", command: "node" });
    writeMcpServer(cwd, "private", { type: "stdio", command: "node", args: ["server.js"] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers.private.env, { API_KEY: "secret" });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers.private.headers, { Authorization: "Bearer secret" });
    writeMcpServer(cwd, "renamed", { type: "stdio", command: "node", args: ["renamed.js"] }, "private");
    const renamed = readMcpConfig(cwd).config.mcpServers;
    assert.equal(renamed.private, undefined);
    assert.deepEqual(renamed.renamed.env, { API_KEY: "secret" });
    assert.deepEqual(renamed.renamed.headers, { Authorization: "Bearer secret" });
  });
});

test("rejects malformed MCP transports before writing", () => {
  assert.throws(() => validateMcpServer("bad server", { command: "npx" }), /Server name/);
  assert.throws(() => validateMcpServer("bad", { type: "http", command: "npx" }), /requires a URL/);
  assert.throws(() => validateMcpServer("bad", { command: "npx", url: "https://example.com/mcp" }), /exactly one/);
  assert.throws(() => validateMcpServer("bad", { type: "sse", url: "file:///tmp/mcp" }), /http or https/);
});

test("reads OMP user MCP servers and disabled entries", () => {
  withWorkspace((cwd) => {
    const userPath = join(cwd, "user-mcp.json");
    writeFileSync(userPath, JSON.stringify({
      mcpServers: { ida: { command: "python", args: ["server.py"] } },
      disabledServers: ["node_repl"],
    }));

    const config = readUserMcpConfig(userPath);
    assert.deepEqual(config.servers.map(({ name }) => name), ["ida"]);
    assert.deepEqual(config.disabledServers, ["node_repl"]);
  });
});

test("parses every source and connection state from OMP's MCP list", () => {
  const servers = parseMcpListOutput(`\nConfigured MCP Servers\n\nUser level (~/.omp/agent/mcp.json):\n  ida ● connected [stdio]\n  frida ○ not connected [stdio]\n\nProject level (.omp/mcp.json):\n  docs ◌ connecting [http]\n\nClaude Code (~/.claude.json):\n  ida-reverse-engineering ● connected\n\nDisabled (discovered servers):\n  node_repl ◌ disabled\n`);
  assert.deepEqual(servers, [
    { name: "ida", source: "User level", status: "connected", type: "stdio" },
    { name: "frida", source: "User level", status: "not_connected", type: "stdio" },
    { name: "docs", source: "Project level", status: "connecting", type: "http" },
    { name: "ida-reverse-engineering", source: "Claude Code", status: "connected", type: undefined },
    { name: "node_repl", source: "Disabled", status: "disabled", type: undefined },
  ]);
});

test("parses rpc-ui's compact MCP list without claiming configured servers are connected", () => {
  assert.deepEqual(parseMcpListOutput("ida | stdio | enabled | python [user]\nfrida | stdio | disabled | frida serve [project]"), [
    { name: "ida", source: "User level", status: "configured", type: "stdio" },
    { name: "frida", source: "Project level", status: "disabled", type: "stdio" },
  ]);
});

test("serializes concurrent mutations through the config lock (no lost updates)", () => {
  withWorkspace((cwd) => {
    // Simulate two writers racing: each read-modify-write must re-read inside
    // the lock, so the second mutation preserves the first's server.
    writeMcpServer(cwd, "alpha", { type: "stdio", command: "python", args: ["a.py"] });
    writeMcpServer(cwd, "beta", { type: "stdio", command: "python", args: ["b.py"] });
    const file = readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers).sort(), ["alpha", "beta"]);
    // Lock files must not leak after successful writes.
    assert.equal(existsSync(`${file.path}.lock`), false);
    assert.equal(existsSync(`${file.path}.tmp-${process.pid}-`), false);
  });
});

test("breaks a stale config lock from a crashed writer", () => {
  withWorkspace((cwd) => {
    const { path } = readMcpConfig(cwd);
    const lockPath = `${path}.lock`;
    // A lock file left behind by a crashed process, aged past the stale window.
    mkdirSync(join(dirname(lockPath)), { recursive: true });
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    writeMcpServer(cwd, "recovered", { type: "stdio", command: "python", args: ["r.py"] });
    const file = readMcpConfig(cwd);
    assert.equal(file.config.mcpServers.recovered.command, "python");
    assert.equal(existsSync(lockPath), false);
  });
});
