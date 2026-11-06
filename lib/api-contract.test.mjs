import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("new-session route rejects malformed commands", async () => {
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.match(newRoute, /command_type_required/);
  assert.match(newRoute, /newSessionErrorResponse/);
});

test("web-settings route validates the agent environment and keeps the keys optional", async () => {
  const route = await readFile(new URL("../app/api/web-settings/route.ts", import.meta.url), "utf8");
  // Reserved/invalid names come back as per-line errors instead of being persisted.
  assert.match(route, /parsed\.errors\.length > 0/);
  assert.match(route, /invalid_agent_env/);
  assert.match(route, /parseAgentEnvText/);
  assert.match(route, /sanitizeAgentEnvValues/);
  // Both settings are optional so one can be saved without clobbering the other.
  assert.match(route, /payload\.autoResumeSessions !== undefined/);
  assert.match(route, /payload\.agentEnv !== undefined/);
  // An agentEnv-only save must not re-sync live sessions.
  assert.match(route, /if \(resumeProvided\) syncInterruptibleSessions\(\)/);
});

test("interactive login negotiates RPC v2 before sending the login command", async () => {
  const route = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");
  const waitReady = route.indexOf("await child.waitReady(READY_TIMEOUT_MS)");
  const negotiate = route.indexOf("await child.negotiateProtocol(ready)");
  const login = route.indexOf('await child.sendCommand({ type: "login"');

  assert.ok(waitReady >= 0);
  assert.ok(negotiate > waitReady);
  assert.ok(login > negotiate);
});

test("session archive route stops live children and maps missing sessions", async () => {
  const route = await readFile(new URL("../app/api/sessions/[id]/archive/route.ts", import.meta.url), "utf8");
  const utils = await readFile(new URL("../lib/api-utils.ts", import.meta.url), "utf8");
  assert.match(route, /destroyAndWait/);
  assert.match(route, /sessionOps\.archiveSession/);
  // Missing-session responses now come from the shared helper.
  assert.match(route, /resolveSessionHostOr404/);
  assert.match(utils, /session_not_found/);
  assert.match(route, /session_archive_failed/);
  assert.match(route, /session_has_children/);
});

test("session archive remains keyboard-discoverable with an ARIA label", async () => {
  const source = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
  const rows = await readFile(new URL("../components/SessionSidebar-rows.tsx", import.meta.url), "utf8");
  assert.match(rows, /api\/sessions\/\$\{encodeURIComponent\(session\.id\)\}\/archive/);
  assert.match(rows, /sessionSidebar\.archiveLeafOnly/);
  assert.match(source, /onOpenArchive/);
});

test("prompt controls preserve abort, steer, and follow-up RPC commands", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /case "abort":/);
  assert.match(source, /case "steer":/);
  assert.match(source, /case "follow_up":/);
  assert.match(source, /streamingBehavior/);
});

test("worktree discovery filters prunable entries and identifies the main checkout", async () => {
  const source = await readFile(new URL("./worktree.ts", import.meta.url), "utf8");
  assert.match(source, /current\.prunable/);
  assert.match(source, /isMain:\s*samePath\(worktreePath,\s*repoRoot\)/);
  assert.match(source, /"worktree", "list", "--porcelain"/);
});


test("model endpoint invalidates cached runtime models after external config edits", async () => {
  const route = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");
  assert.match(route, /statSync/);
  assert.match(route, /__ompModelsConfigFingerprint/);
  assert.match(route, /invalidateModelsCache\(\)/);
  assert.match(route, /disposeUtilityRpc\(\)/);
});

test("agent project discovery requires an explicit workspace", async () => {
  const route = await readFile(new URL("../app/api/agents/route.ts", import.meta.url), "utf8");
  assert.match(route, /scope === "project" && !cwdParam/);
  assert.match(route, /cwd is required for project scope/);
});

test("agent mutations bound JSON input before parsing", async () => {
  const route = await readFile(new URL("../app/api/agents/route.ts", import.meta.url), "utf8");
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(route, /MAX_AGENT_REQUEST_BYTES/);
  assert.match(route, /RequestBodyTooLargeError/);
  assert.match(route, /status: 413/);
  assert.doesNotMatch(route, /request\.json\(\)/);
});

test("mutating agent and MCP routes bound JSON input", async () => {
  const newAgent = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const mcp = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  for (const route of [newAgent, agent, mcp]) assert.match(route, /parseJsonWithinLimit/);
  for (const route of [newAgent, mcp]) assert.match(route, /RequestBodyTooLargeError/);
  assert.match(newAgent, /status: 413/);
  assert.match(mcp, /\? 413 : 400/);
});

test("agent routes bound requests with the shared attachment budget", async () => {
  const newAgent = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  const agent = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const budget = await readFile(new URL("./image-attachments.ts", import.meta.url), "utf8");

  // One source of truth: the composer preflights against the same constant, so
  // a per-route literal would let the client send bodies the route rejects.
  for (const route of [newAgent, agent]) {
    assert.match(route, /import \{ MAX_AGENT_COMMAND_REQUEST_BYTES \} from "@\/lib\/image-attachments"/);
    assert.match(route, /parseJsonWithinLimit<[^>]*>\(req, MAX_AGENT_COMMAND_REQUEST_BYTES\)/);
    assert.doesNotMatch(route, /REQUEST_BYTES = /);
  }
  // Below Next's 10 MB proxy buffering boundary, with base64 headroom for the
  // aggregate image cap.
  assert.match(budget, /MAX_AGENT_COMMAND_REQUEST_BYTES = 8 \* 1024 \* 1024/);
  assert.match(budget, /MAX_TOTAL_ATTACHED_IMAGE_BYTES = 5 \* 1024 \* 1024/);
});

test("MCP route redacts project server credentials", async () => {
  const route = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  assert.match(route, /redactMcpServer\(config\)/);
  assert.doesNotMatch(route, /config }\)\), user: safeUser/);
});

test("agent command route reads the advisor choice from the query string", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  assert.match(route, /searchParams\.get\("advisor"\) === "1"/);
});

test("mcp listing carries the advisor opinion into fresh spawns only", async () => {
  const route = await readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8");
  assert.match(route, /params\.get\("advisor"\) === "1"/);
  assert.match(route, /startRpcSession\(sessionId, target\.sessionFile, target\.cwd, undefined, advisor/);
  // An alive child is always reused for listing; the opinion must never
  // trigger a flag-mismatch replace of a live session.
  assert.match(route, /getRpcSession\(sessionId\)/);
});

test("new-session route never forwards a session id into the child RPC", async () => {
  const route = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
  assert.match(route, /delete promptCommand\.sessionId/);
});

test("PUT /api/web-settings validates the transport and tells open streams only when it changed", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "omp-web-settings-route-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete globalThis.__ompWebSettingsCache;
  const { PUT, GET } = await import("../app/api/web-settings/route.ts");
  const { EventStreamConnection } = await import("./event-stream-hub.ts");
  const put = (body) => PUT(new Request("http://localhost/api/web-settings", { method: "PUT", body: JSON.stringify(body) }));
  const connection = new EventStreamConnection();
  const reader = connection.stream.getReader();
  const decoder = new TextDecoder();
  const read = async () => {
    let watchdog;
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("read stalled: the expected frame never arrived")), 2000);
      }),
    ]).finally(() => clearTimeout(watchdog));
    return decoder.decode(chunk.value);
  };
  try {
    assert.match(await read(), /"type":"hello"/);

    // The experiment's modes are gone: only sse and ws.
    for (const value of ["websocket", "ws-pool", "ws-client"]) {
      const invalid = await put({ browserTransport: value });
      assert.equal(invalid.status, 400);
      const answer = await invalid.json();
      assert.equal(answer.code, "invalid_settings");
      assert.match(answer.error, /browserTransport must be one of "sse", "ws"/);
    }

    // The default is ws, so the first change is to sse.
    const ok = await put({ browserTransport: "sse" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).browserTransport, "sse");
    assert.match(await read(), /^event: mux\n.*\ndata: \{"type":"transport","transport":"sse"\}\n\n$/s);
    assert.equal((await (await GET()).json()).browserTransport, "sse");

    // Saves that do not change the state broadcast nothing: the next frame is the one we trigger ourselves.
    for (const unchanged of [{ autoResumeSessions: false }, { browserTransport: "sse" }]) {
      assert.equal((await put(unchanged)).status, 200);
      connection.control({ type: "open", sub: "s1" });
      assert.match(await read(), /"type":"open"/);
    }

    assert.equal((await put({ browserTransport: "ws" })).status, 200);
    assert.match(await read(), /"type":"transport","transport":"ws"/);
  } finally {
    connection.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    delete globalThis.__ompWebSettingsCache;
    rmSync(dir, { recursive: true, force: true });
  }
});
