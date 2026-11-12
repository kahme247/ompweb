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

test("interactive login waits for the runner's hello before sending the login command", async () => {
  const route = await readFile(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url), "utf8");
  const waitReady = route.indexOf("await child.waitReady(READY_TIMEOUT_MS)");
  const login = route.indexOf('await child.sendCommand({ type: "login"');

  assert.ok(waitReady >= 0);
  assert.ok(login > waitReady);
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

async function pooledNewRouteFixture(t, onCommand = async () => undefined) {
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const dir = mkdtempSync(join(tmpdir(), "omp-pooled-new-api-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const { savePools } = await import("./hosts/pools.ts");
  const { POST } = await import("../app/api/agent/new/route.ts");
  const { getRpcSession } = await import("./rpc-manager.ts");
  const link = await linkHost("Pooled API worker", { hello: { v: 8 } });
  const sessionId = randomUUID();
  const commands = [];
  const spawns = [];
  const project = { id: "project", name: "Project", origin: "https://example.invalid/project.git", clonePaths: {}, addedAt: "2026-01-01T00:00:00.000Z", hidden: false };
  const pool = { id: `api-${randomUUID()}`, label: "Pool", enabled: true, members: [{ hostId: link.id, projectsRoot: "/worker", provisioned: true, draining: false }], projects: [project] };
  // The first pool is the cluster, whose members share credentials and so need a shared v9 link; this v8 worker sits in the second.
  const savePoolsAfterCluster = (pools) => savePools([{ id: "no-cluster", label: "No cluster", enabled: true, members: [], projects: [] }, ...pools]);
  savePoolsAfterCluster([pool]);
  link.serve({
    preparePoolProject: ({ input }) => ({ ok: true, value: { cwd: `/worker/.project_worktrees/session/${input.creationId}`, projectRoot: "/worker/project", baseCommit: "a".repeat(40) } }),
    addProject: () => ({ ok: true, value: {} }),
    updateProject: () => ({ ok: true, value: { projects: [], newRoots: [] } }),
    validateCwd: ({ path }) => ({ ok: true, value: { cwd: path, projectRoot: "/worker/project" } }),
    async spawn(args) {
      spawns.push(args);
      await link.post({ type: "stdout", ch: args.ch, line: JSON.stringify({ t: "hello", proto: 1, pid: 1, sessionId, sessionFile: `/remote/sessions/${sessionId}.jsonl`, cwd: args.cwd }) });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    sessionFileExists: () => false,
    invalidateSessionLists: () => null,
    listSessions: () => [],
  }, async (message) => {
    if (message.type === "kill") return link.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" });
    if (message.type !== "stdin") return;
    const frame = JSON.parse(message.line);
    if (frame.t !== "cmd") return;
    const command = { type: frame.op, id: frame.id, ...frame.args };
    commands.push(command);
    if (await onCommand(command, { link, sessionId, dir }) === "hold") return;
    const data = command.type === "get_state" ? { sessionId, sessionFile: `/remote/sessions/${sessionId}.jsonl`, isStreaming: false, isCompacting: false }
      : command.type === "set_model" ? { provider: command.provider, id: command.modelId, name: command.modelId, reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {};
    await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ t: "res", id: command.id, ok: true, data }) });
  });
  await link.post({ type: "capacity", sample: { effectiveCpus: 4, load1: 0, busyFraction: 0, stealFraction: 0, availableMemoryBytes: 16 * 1024 ** 3, activeSessions: 0 } });
  t.after(async () => {
    hub.closeHostLink(link.id);
    await getRpcSession(sessionId)?.destroyAndWait();
    hub.flushLinkSamples();
    (await import("./notification-store.ts")).closeNotificationStore();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const post = (body) => POST(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify(body) }));
  const request = { creationId: `creation-${randomUUID()}`, poolId: pool.id, projectId: project.id, type: "prompt", message: "one initial prompt", provider: "test", modelId: "model-a", thinkingLevel: "high", toolNames: ["read"], advisor: false };
  return { post, request, pool, savePools: savePoolsAfterCluster, sessionId, commands, spawns, link, journal: () => readFileSync(join(dir, "omp-web", "pool-starts.json"), "utf8") };
}

test("pooled new-session API admits once through model, thinking and initial prompt then conflicts on changed payload", async (t) => {
  const reachedPrompt = Promise.withResolvers();
  const releasePrompt = Promise.withResolvers();
  let fixture;
  fixture = await pooledNewRouteFixture(t, async (command) => {
    if (command.type !== "prompt") return;
    assert.ok(fixture.journal().includes(fixture.sessionId), "real identity is durable before the first prompt");
    reachedPrompt.resolve();
    await releasePrompt.promise;
  });
  fixture.request.intentHash = "untrusted-browser-hash";
  const first = fixture.post(fixture.request);
  await Promise.race([reachedPrompt.promise, first.then((response) => assert.fail(`creation returned ${response.status} before initialization`))]);
  const duplicate = fixture.post({ ...fixture.request });
  let finished = false;
  void duplicate.then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, false);
  releasePrompt.resolve();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal((await one.json()).sessionId, fixture.sessionId);
  assert.equal((await two.json()).sessionId, fixture.sessionId);
  assert.equal(fixture.spawns.length, 1);
  assert.equal(fixture.spawns[0].creationId, fixture.request.creationId);
  assert.deepEqual(fixture.commands.filter((command) => ["set_model", "set_thinking_level", "prompt"].includes(command.type)).map((command) => command.type), ["set_model", "set_thinking_level", "prompt"]);
  for (const changes of [{ modelId: "other" }, { message: "another prompt" }, { futureCommandOption: true }]) {
    const changed = await fixture.post({ ...fixture.request, ...changes, intentHash: "untrusted-browser-hash" });
    assert.equal(changed.status, 409);
  }
  assert.equal(fixture.commands.filter((command) => command.type === "prompt").length, 1);
});

test("pooled new-session API returns the real session and unknown delivery without retrying a lost prompt ack", async (t) => {
  const reachedPrompt = Promise.withResolvers();
  const fixture = await pooledNewRouteFixture(t, async (command) => {
    if (command.type === "prompt") { reachedPrompt.resolve(); return "hold"; }
  });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const first = fixture.post(fixture.request);
    await Promise.race([reachedPrompt.promise, first.then((response) => assert.fail(`creation returned ${response.status} before prompt dispatch`))]);
    t.mock.timers.tick(30_000);
    const response = await first;
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.sessionId, fixture.sessionId);
    assert.equal(body.delivery, "unknown");
    const replay = await fixture.post(fixture.request);
    assert.equal(replay.status, 503);
    const replayBody = await replay.json();
    assert.equal(replayBody.sessionId, fixture.sessionId);
    assert.equal(replayBody.delivery, "unknown");
    assert.equal(fixture.spawns.length, 1);
    assert.equal(fixture.commands.filter((command) => command.type === "prompt").length, 1);
  } finally { t.mock.timers.reset(); }
});

test("new-session API rejects contradictory pool and standalone targets without creating a runtime", async (t) => {
  const fixture = await pooledNewRouteFixture(t);
  for (const target of [{ hostId: fixture.link.id }, { hostId: "local" }, { cwd: "/unregistered/path" }, { projectId: undefined }, { creationId: undefined }, { provider: 1 }, { modelId: [] }, { thinkingLevel: {} }, { toolNames: [123] }, { advisor: "yes" }]) {
    const response = await fixture.post({ ...fixture.request, ...target });
    assert.equal(response.status, 400);
  }
  fixture.pool.members[0].draining = true;
  fixture.savePools([fixture.pool]);
  const unavailable = await fixture.post(fixture.request);
  assert.equal(unavailable.status, 503);
  assert.equal(fixture.spawns.length, 0, "neither invalid nor exhausted pool requests may fall back locally");
});

for (const heldType of ["set_model", "set_thinking_level", "set_session_name"]) {
  test(`pooled initialization bounds a lost ${heldType} ack without sending later commands`, async (t) => {
    const reached = Promise.withResolvers();
    const fixture = await pooledNewRouteFixture(t, async (command) => {
      if (command.type === heldType) { reached.resolve(); return "hold"; }
    });
    fixture.request.name = "Named session";
    const { getRpcSession } = await import("./rpc-manager.ts");
    const hub = await import("./hosts/hub.ts");
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      const first = fixture.post(fixture.request);
      let settled = false;
      void first.then(() => { settled = true; });
      await Promise.race([reached.promise, first.then((response) => assert.fail(`creation returned ${response.status} before ${heldType}`))]);
      // Keep the daemon linked throughout the deadline: this is not host-offline recovery.
      for (let step = 0; step < 6; step++) {
        t.mock.timers.tick(5_000);
        await fixture.link.post({ type: "pong" });
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(hub.getHost(fixture.link.id).status(), "online");
      assert.equal(settled, true, `${heldType} initialization must have a finite acknowledgement deadline`);
      const response = await first;
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.sessionId, fixture.sessionId);
      assert.equal(body.delivery, "unknown");
      const retry = await fixture.post(fixture.request);
      assert.equal(retry.status, 503);
      const repeated = await retry.json();
      assert.equal(repeated.sessionId, fixture.sessionId);
      assert.equal(repeated.delivery, "unknown");
      assert.equal(getRpcSession(fixture.sessionId).isAlive(), true);
      assert.equal(fixture.spawns.length, 1);
      const initialization = fixture.commands.filter((command) => ["set_model", "set_thinking_level", "set_session_name", "prompt"].includes(command.type));
      const order = ["set_model", "set_thinking_level", "set_session_name"];
      assert.deepEqual(initialization.map((command) => command.type), order.slice(0, order.indexOf(heldType) + 1));
    } finally { t.mock.timers.reset(); }
  });
}
