import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// The actual RPC consumer below writes registries, notifications and the start journal.
const agentScratch = realpathSync(mkdtempSync(join(tmpdir(), "omp-agent-placement-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentScratch;
const journalPath = join(agentScratch, "omp-web", "pool-starts.json");
const worktreeRoot = fileURLToPath(new URL("../", import.meta.url));
test.after(async () => {
  (await import("./hosts/hub.ts")).flushLinkSamples();
  (await import("./notification-store.ts")).closeNotificationStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentScratch, { recursive: true, force: true });
});

const {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAMES,
  AgentToolGuard,
  executeAgentTool,
  formatAttributedMessage,
} = await import("./agent-tools.ts");

function fakeOps(overrides = {}) {
  const calls = { list: 0, create: [], deliver: [], hostLookups: [] };
  return {
    calls,
    async listSessions() {
      calls.list += 1;
      return [{ id: "target-1", name: "Release", cwd: "/tmp/release", running: false, hostId: "local" }];
    },
    listHosts() {
      return [
        { id: "local", label: "This machine", online: true, allowAgentStart: true },
        { id: "h-build", label: "build-box", online: true, allowAgentStart: false },
        { id: "h-gpu", label: "gpu-box", online: false, allowAgentStart: true },
        { id: "h-ci", label: "ci-box", online: true, allowAgentStart: true },
      ];
    },
    async createSession(input, authorize) {
      const host = this.listHosts().find((candidate) => candidate.id === input.hostId);
      if (!(await authorize(host))) throw new Error(`The user declined to start a session on ${host.label}.`);
      calls.create.push(input);
      return { sessionId: "new-1" };
    },
    async deliver(input) {
      calls.deliver.push(input);
      return { accepted: true, targetSessionId: input.sessionId, delivery: input.delivery, waited: false, responseText: null };
    },
    async sessionHostId(sessionId) {
      calls.hostLookups.push(sessionId);
      return { "target-1": "local", "ci-target": "h-ci", "build-target": "h-build" }[sessionId] ?? null;
    },
    ...overrides,
  };
}

const ctx = (overrides = {}) => ({
  sourceSessionId: "source-1",
  sourceRequestId: "native-request-1",
  sourceCwd: "/tmp/source",
  sourceHostId: "local",
  enabled: true,
  guard: new AgentToolGuard(),
  confirm: async () => { throw new Error("no confirm expected"); },
  ...overrides,
});

test("agent tool definitions cover the three cross-session tools (#275)", () => {
  assert.deepEqual([...AGENT_TOOL_NAMES].sort(), ["list_sessions", "new_session", "send_to_session"]);
  assert.deepEqual(AGENT_TOOL_DEFINITIONS.map((t) => t.name).sort(), ["list_sessions", "new_session", "send_to_session"]);
  const send = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "send_to_session");
  const create = AGENT_TOOL_DEFINITIONS.find((t) => t.name === "new_session");
  assert.equal(create.parameters.properties.host.type, "string");
  assert.deepEqual(send.parameters.required, ["sessionId", "message"]);
  assert.deepEqual(send.parameters.properties.delivery.enum, ["prompt", "steer", "followUp"]);
});

test("agent tools refuse every call while the Settings gate is off (#275)", async () => {
  const off = ctx({ enabled: false });
  await assert.rejects(() => executeAgentTool("list_sessions", {}, fakeOps(), off), /disabled/);
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, fakeOps(), off),
    /disabled/,
  );
});

test("list_sessions names each session's host by label", async () => {
  const ops = fakeOps({
    async listSessions() {
      return [
        { id: "target-1", name: "Release", cwd: "/tmp/release", running: false, hostId: "local" },
        { id: "remote-1", cwd: "/srv/app", running: true, hostId: "h-build" },
      ];
    },
  });
  const result = await executeAgentTool("list_sessions", {}, ops, ctx());
  assert.deepEqual(result, {
    sessions: [
      { id: "target-1", name: "Release", cwd: "/tmp/release", running: false, host: "This machine" },
      { id: "remote-1", cwd: "/srv/app", running: true, host: "build-box" },
    ],
  });
});

test("new_session defaults cwd, attributes the prompt, and splits provider/model (#275)", async () => {
  const ops = fakeOps();
  const result = await executeAgentTool(
    "new_session",
    { prompt: "Do the release checklist", model: "anthropic/claude-sonnet-4-5", name: "Release worker" },
    ops,
    ctx(),
  );
  assert.deepEqual(result, { sessionId: "new-1" });
  assert.equal(ops.calls.create.length, 1);
  const input = ops.calls.create[0];
  assert.equal(input.cwd, "/tmp/source");
  assert.equal(input.hostId, "local");
  assert.equal(input.prompt, "[From session source-1 via omp-web agent tools]: Do the release checklist");
  assert.equal(input.provider, "anthropic");
  assert.equal(input.modelId, "claude-sonnet-4-5");
  assert.equal(input.name, "Release worker");
});

test("new_session without a prompt creates an idle session, and bad models are rejected (#275)", async () => {
  const ops = fakeOps();
  await executeAgentTool("new_session", { cwd: "/tmp/other" }, ops, ctx());
  assert.equal(ops.calls.create[0].prompt, null);
  assert.equal(ops.calls.create[0].cwd, "/tmp/other");
  await assert.rejects(() => executeAgentTool("new_session", { model: "no-slash" }, fakeOps(), ctx()), /provider\/modelId/);
  await assert.rejects(
    () => executeAgentTool("new_session", { provider: "anthropic" }, fakeOps(), ctx()),
    /together/,
  );
  await assert.rejects(() => executeAgentTool("new_session", {}, fakeOps(), ctx({ sourceCwd: "" })), /cwd/);
});

test("send_to_session attributes, defaults to prompt, and passes wait through (#275)", async () => {
  const ops = fakeOps();
  const result = await executeAgentTool(
    "send_to_session",
    { sessionId: "target-1", message: "The build passed", wait: true, waitTimeoutMs: 5000 },
    ops,
    ctx(),
  );
  assert.equal(ops.calls.deliver.length, 1);
  const input = ops.calls.deliver[0];
  assert.equal(input.message, "[From session source-1 via omp-web agent tools]: The build passed");
  assert.equal(input.delivery, "prompt");
  assert.equal(input.wait, true);
  assert.equal(input.waitTimeoutMs, 5000);
  assert.equal(result.targetSessionId, "target-1");
});

test("send_to_session rejects self-targets, bad deliveries, and bad waits (#275)", async () => {
  const base = ctx();
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "source-1", message: "hi" }, fakeOps(), base),
    /itself/,
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi", delivery: "shout" }, fakeOps(), ctx()),
    /delivery/,
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi", wait: "yes" }, fakeOps(), ctx()),
    /wait/,
  );
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t" }, fakeOps(), ctx()),
    /message/,
  );
});

test("send_to_session wait timeout defaults and caps (#275)", async () => {
  const ops = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, ops, ctx());
  assert.equal(ops.calls.deliver[0].wait, false);
  assert.equal(ops.calls.deliver[0].waitTimeoutMs, 120000);
  const capped = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "t", message: "hi", waitTimeoutMs: 9999999 }, capped, ctx());
  assert.equal(capped.calls.deliver[0].waitTimeoutMs, 300000);
});

test("attribution format keeps the full source ID for sidebar lookup (#275)", () => {
  assert.equal(
    formatAttributedMessage("019c625b-b900-7000-8000-000000000277", "hello"),
    "[From session 019c625b-b900-7000-8000-000000000277 via omp-web agent tools]: hello",
  );
});

test("chain depth stops a loop and a failed delivery does not advance it (#275)", async () => {
  const guard = new AgentToolGuard();
  guard.setDepth("source-1", 5);
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, fakeOps(), ctx({ guard })),
    /chain depth/,
  );

  const failing = fakeOps({
    async deliver() {
      throw new Error("target vanished");
    },
  });
  const guard2 = new AgentToolGuard();
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, failing, ctx({ guard: guard2 })),
    /target vanished/,
  );
  assert.equal(guard2.depthFor("t"), 0);

  const ok = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "t", message: "hi" }, ok, ctx({ guard: guard2 }));
  assert.equal(guard2.depthFor("t"), 1);
});

test("rate limit caps a source at 20 agent tool calls per minute (#275)", async () => {
  const guard = new AgentToolGuard();
  const ops = fakeOps();
  for (let i = 0; i < 20; i++) {
    await executeAgentTool("list_sessions", {}, ops, ctx({ guard }));
  }
  await assert.rejects(() => executeAgentTool("list_sessions", {}, ops, ctx({ guard })), /rate limit/);
});

test("new_session on a remote host that disallows agent starts asks the user first", async () => {
  const ops = fakeOps();
  const titles = [];
  const result = await executeAgentTool(
    "new_session",
    { host: "Build-Box", cwd: "/srv/app" },
    ops,
    ctx({ confirm: async (title) => { titles.push(title); return true; } }),
  );
  assert.deepEqual(result, { sessionId: "new-1" });
  assert.deepEqual(titles, ["Start a session on build-box in /srv/app?"]);
  assert.equal(ops.calls.create[0].hostId, "h-build");
  assert.equal(ops.calls.create[0].cwd, "/srv/app");
});

test("new_session declined by the user creates nothing", async () => {
  const ops = fakeOps();
  await assert.rejects(
    () => executeAgentTool("new_session", { host: "h-build", cwd: "/srv/app" }, ops, ctx({ confirm: async () => false })),
    /declined/,
  );
  assert.equal(ops.calls.create.length, 0);
});

test("new_session on a remote host that allows agent starts asks nothing", async () => {
  const ops = fakeOps();
  await executeAgentTool("new_session", { host: "ci-box", cwd: "/srv/app" }, ops, ctx());
  assert.equal(ops.calls.create[0].hostId, "h-ci");
});

test("new_session refuses unknown and offline hosts", async () => {
  const ops = fakeOps();
  await assert.rejects(
    () => executeAgentTool("new_session", { host: "nowhere" }, ops, ctx()),
    /Known hosts: This machine, build-box, gpu-box, ci-box/,
  );
  await assert.rejects(() => executeAgentTool("new_session", { host: "GPU-box" }, ops, ctx()), { message: /^gpu-box is offline/ });
  assert.equal(ops.calls.create.length, 0);
});

test("new_session refuses a label two hosts share and names their ids; an id still resolves", async () => {
  const hosts = [
    { id: "local", label: "This machine", online: true, allowAgentStart: true },
    { id: "h-a", label: "laptop", online: true, allowAgentStart: true },
    { id: "h-b", label: "Laptop", online: true, allowAgentStart: true },
  ];
  const ops = fakeOps({ listHosts: () => hosts });
  await assert.rejects(
    () => executeAgentTool("new_session", { host: "laptop", cwd: "/srv/app" }, ops, ctx()),
    { message: /"laptop" matches more than one host \(ids: h-a, h-b\)/ },
  );
  assert.equal(ops.calls.create.length, 0);
  await executeAgentTool("new_session", { host: "h-b", cwd: "/srv/app" }, ops, ctx());
  assert.equal(ops.calls.create[0].hostId, "h-b");
});

test("new_session without a host, or with local / This machine, starts here without asking", async () => {
  const ops = fakeOps();
  await executeAgentTool("new_session", {}, ops, ctx());
  await executeAgentTool("new_session", { host: "local" }, ops, ctx());
  await executeAgentTool("new_session", { host: "this machine" }, ops, ctx());
  assert.deepEqual(ops.calls.create.map((input) => input.hostId), ["local", "local", "local"]);
});

test("a renamed this machine resolves by its custom label, `local` and \"This machine\", and list_sessions names it", async () => {
  const listHosts = () => [
    { id: "local", label: "Desk", online: true, allowAgentStart: true },
    { id: "h-ci", label: "ci-box", online: true, allowAgentStart: true },
  ];
  const ops = fakeOps({ listHosts });
  for (const host of ["Desk", "local", "This machine"]) await executeAgentTool("new_session", { host }, ops, ctx());
  assert.deepEqual(ops.calls.create.map((input) => input.hostId), ["local", "local", "local"]);
  assert.deepEqual((await executeAgentTool("list_sessions", {}, ops, ctx())).sessions.map((s) => s.host), ["Desk"]);
  await assert.rejects(() => executeAgentTool("new_session", { host: "nowhere" }, ops, ctx()), /Known hosts: Desk, ci-box/);
});

/** A confirm that records each title and answers `answer`. */
const asking = (titles, answer = true) => async (title) => {
  titles.push(title);
  return answer;
};

test("a remote caller's new_session defaults to its own host and follows that host's allowAgentStart", async () => {
  const ops = fakeOps();
  await executeAgentTool("new_session", {}, ops, ctx({ sourceHostId: "h-ci", sourceCwd: "/srv/ci" }));
  assert.deepEqual([ops.calls.create[0].hostId, ops.calls.create[0].cwd], ["h-ci", "/srv/ci"]);
  const titles = [];
  await executeAgentTool("new_session", {}, ops, ctx({ sourceHostId: "h-build", sourceCwd: "/srv/app", confirm: asking(titles) }));
  assert.deepEqual(titles, ["Start a session on build-box in /srv/app?"]);
  assert.equal(ops.calls.create[1].hostId, "h-build");
});

test("a remote caller starting a session on this machine is always asked", async () => {
  const ops = fakeOps();
  const titles = [];
  await assert.rejects(
    () => executeAgentTool("new_session", { host: "local", cwd: "/home/me" }, ops, ctx({ sourceHostId: "h-ci", confirm: asking(titles, false) })),
    /declined/,
  );
  assert.deepEqual(titles, ["Start a session on This machine in /home/me?"]);
  assert.equal(ops.calls.create.length, 0);
});

test("a remote caller reaching another host is asked unless that host allows agent starts", async () => {
  const ops = fakeOps();
  const titles = [];
  await executeAgentTool("new_session", { host: "build-box", cwd: "/srv/app" }, ops, ctx({ sourceHostId: "h-ci", confirm: asking(titles) }));
  assert.deepEqual(titles, ["Start a session on build-box in /srv/app?"]);
  await executeAgentTool("new_session", { host: "ci-box", cwd: "/srv/ci" }, ops, ctx({ sourceHostId: "h-build" }));
  assert.deepEqual(ops.calls.create.map((input) => input.hostId), ["h-build", "h-ci"]);
});

test("a remote caller's send_to_session to a session on this machine asks first", async () => {
  const ops = fakeOps();
  const titles = [];
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "target-1", message: "rm -rf ~" }, ops, ctx({ sourceHostId: "h-ci", confirm: asking(titles, false) })),
    /declined/,
  );
  assert.deepEqual(titles, ["Send a message from a session on ci-box to session target-1 on This machine?"]);
  assert.equal(ops.calls.deliver.length, 0);
  await executeAgentTool("send_to_session", { sessionId: "target-1", message: "hi" }, ops, ctx({ sourceHostId: "h-ci", confirm: asking([]) }));
  assert.equal(ops.calls.deliver.length, 1);
});

test("a remote caller's send_to_session on its own host, or to a host that allows agent starts, asks nothing", async () => {
  const ops = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "build-target", message: "hi" }, ops, ctx({ sourceHostId: "h-build" }));
  await executeAgentTool("send_to_session", { sessionId: "ci-target", message: "hi" }, ops, ctx({ sourceHostId: "h-build" }));
  assert.equal(ops.calls.deliver.length, 2);
  await assert.rejects(
    () => executeAgentTool("send_to_session", { sessionId: "nowhere", message: "hi" }, ops, ctx({ sourceHostId: "h-build" })),
    /Session not found/,
  );
});

test("a local caller's send_to_session neither looks up the target's host nor asks", async () => {
  const ops = fakeOps();
  await executeAgentTool("send_to_session", { sessionId: "build-target", message: "hi" }, ops, ctx());
  assert.deepEqual(ops.calls.hostLookups, []);
  assert.equal(ops.calls.deliver.length, 1);
});

test("unknown agent tools are rejected (#275)", async () => {
  await assert.rejects(() => executeAgentTool("delete_everything", {}, fakeOps(), ctx()), /Unknown agent tool/);
});

test("new_session rejects malformed shared-workspace intent before creating anything", async () => {
  for (const shareWorkspace of ["true", 1, null, {}, []]) {
    const ops = fakeOps();
    await assert.rejects(() => executeAgentTool("new_session", { shareWorkspace }, ops, ctx()), /shareWorkspace.*boolean/);
    assert.equal(ops.calls.create.length, 0);
  }
});

test("new_session preserves the enable, rate and chain-depth guards", async () => {
  const ops = fakeOps();
  await assert.rejects(() => executeAgentTool("new_session", {}, ops, ctx({ enabled: false })), /disabled/);
  const deep = new AgentToolGuard();
  deep.setDepth("source-1", 5);
  await assert.rejects(() => executeAgentTool("new_session", {}, ops, ctx({ guard: deep })), /chain depth/);
  const busy = new AgentToolGuard();
  for (let i = 0; i < 20; i++) busy.checkRate("source-1");
  await assert.rejects(() => executeAgentTool("new_session", {}, ops, ctx({ guard: busy })), /rate limit/);
  assert.equal(ops.calls.create.length, 0);
});

const startsInJournal = () => existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")).starts : [];

/** Keep registry, admission, RpcProcess and link routing real; replace only daemon/OMP boundaries. */
async function placementFixture(t, { workerAllows = true, fallback = false, holdInitialization } = {}) {
  const rpc = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");
  const { updateHost } = await import("./hosts/registry.ts");
  const { savePools } = await import("./hosts/pools.ts");
  const sourceId = randomUUID();
  const poolId = `agent-${randomUUID()}`;
  const links = [await linkHost("Source owner", { hello: { v: 8 } }), await linkHost("Selected worker", { hello: { v: 8 } }), await linkHost("Standalone target", { hello: { v: 8 } })];
  const [source, worker, standalone] = links;
  for (const link of links) updateHost(link.id, { allowAgentStart: link !== worker || workerAllows });
  const spawns = [], preparations = [], commands = [], results = [], dialogs = [];
  const reachedInitialization = Promise.withResolvers();
  const identities = new Map();
  const sourceCwd = "/owner/.project_worktrees/session/unpublished-parent";
  const sourceRow = { id: sourceId, path: `/remote/sessions/${sourceId}.jsonl`, cwd: sourceCwd, projectRoot: "/owner/project", created: "c", modified: "m", messageCount: 1, firstMessage: "parent" };
  const pool = {
    id: poolId, label: "Agent pool", enabled: true,
    members: [{ hostId: worker.id, projectsRoot: "/selected", provisioned: true, draining: false },
      ...(fallback ? [{ hostId: standalone.id, projectsRoot: "/fallback", provisioned: true, draining: false }] : [])],
    projects: [{ id: "project", name: "Project", origin: "https://example.invalid/project.git", clonePaths: { [source.id]: "/owner/project" }, addedAt: "2026-01-01T00:00:00.000Z", hidden: false }],
  };
  // The first pool is the cluster, whose members share credentials and so need a shared v9 link; these v8 hosts sit in the second.
  savePools([{ id: "no-cluster", label: "No cluster", enabled: true, members: [], projects: [] }, pool]);
  globalThis.__ompWebSettingsCache = undefined;
  writeFileSync(join(agentScratch, "omp-web-settings.json"), JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  for (const link of links) {
    link.serve({
      listSessions: () => link === source ? [sourceRow] : [],
      validateCwd: ({ path }) => ({ ok: true, value: { cwd: path, projectRoot: link === source ? "/owner/project" : path } }),
      sessionFileExists: () => false,
      invalidateSessionLists: () => null,
      preparePoolProject: ({ input }) => {
        preparations.push({ hostId: link.id, ...input });
        // A simulated POSIX worker: its paths follow POSIX rules whatever OS runs this test.
        return { ok: true, value: { cwd: posix.join(posix.dirname(input.cloneRoot), `.${posix.basename(input.cloneRoot)}_worktrees`, "session", input.creationId), projectRoot: input.cloneRoot, baseCommit: "a".repeat(40) } };
      },
      addProject: () => ({ ok: true, value: {} }),
      updateProject: () => ({ ok: true, value: { projects: [], newRoots: [] } }),
      spawn: async (args) => {
        const id = args.sessionFile === sourceRow.path ? sourceId : randomUUID();
        identities.set(args.ch, id);
        spawns.push({ hostId: link.id, sessionId: id, ...args });
        await link.post({ type: "stdout", ch: args.ch, line: JSON.stringify({ t: "hello", proto: 1, pid: 1, sessionId: id, sessionFile: `/remote/sessions/${id}.jsonl`, cwd: args.cwd }) });
        return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
      },
    }, async (message) => {
      if (message.type === "kill") return link.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" });
      if (message.type !== "stdin") return;
      const frame = JSON.parse(message.line);
      const { t, op, args, ...rest } = frame;
      const command = t === "cmd" ? { type: op, id: frame.id, ...args } : { type: t, ...rest };
      commands.push({ hostId: link.id, ch: message.ch, ...command });
      if (command.type === "host_tool_result") { results.push(command); return; }
      if (t !== "cmd") return;
      if (link !== source && command.type === holdInitialization) {
        reachedInitialization.resolve();
        return;
      }
      const data = command.type === "get_state" ? { sessionId: identities.get(message.ch), sessionFile: `/remote/sessions/${identities.get(message.ch)}.jsonl`, isStreaming: false, isCompacting: false, isSettled: true, queuedMessageCount: 0 } : {};
      await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ t: "res", id: command.id, ok: true, data }) });
    });
  }
  const sample = { effectiveCpus: 4, load1: 0, busyFraction: 0, stealFraction: 0, availableMemoryBytes: 3 * 1024 ** 3, activeSessions: 0 };
  await worker.post({ type: "capacity", sample });
  if (fallback) await standalone.post({ type: "capacity", sample: { ...sample, load1: 2 } });
  const { session } = await rpc.startRpcSession(sourceId, sourceRow.path, sourceCwd, undefined, false, sourceCwd, undefined, hub.getHost(source.id));
  session.onEvent((event) => { if (event.type === "extension_ui_request" && event.method === "confirm") dialogs.push(event); });
  const sourceChannel = spawns.find((spawn) => spawn.sessionId === sourceId).ch;
  t.after(async () => {
    for (const spawn of spawns) await rpc.getRpcSession(spawn.sessionId)?.destroyAndWait();
    for (const link of links) hub.closeHostLink(link.id);
    globalThis.__ompWebSettingsCache = undefined;
  });
  async function call(args, requestId = randomUUID(), toolName = "new_session") {
    const before = results.length;
    await source.post({ type: "stdout", ch: sourceChannel, line: JSON.stringify({ t: "host_tool_call", id: requestId, toolName, arguments: args }) });
    await until(() => results.slice(before).some((result) => result.id === requestId), `${toolName} result`);
    return results.slice(before).find((result) => result.id === requestId);
  }
  return { rpc, hub, until, sourceId, sourceRow, sourceCwd, sourceChannel, source, worker, standalone, pool, spawns, preparations, commands, results, dialogs, session, call, reachedInitialization: reachedInitialization.promise };
}

test("independent pooled agent creation reserves a real owner and initializes one child for a native request", async (t) => {
  const f = await placementFixture(t);
  const requestId = `native/request:Ω/${"x".repeat(300)}`;
  const args = { prompt: "Build the release", model: "test/model-a", name: "Release worker" };
  const first = await f.call(args, requestId);
  assert.equal(first.isError, false, first.result.content[0].text);
  const created = JSON.parse(first.result.content[0].text);
  assert.equal(globalThis.__ompAgentToolGuard.depthFor(created.sessionId), 1);
  const children = f.spawns.filter((spawn) => spawn.sessionId !== f.sourceId);
  assert.equal(children.length, 1);
  assert.equal(children[0].hostId, f.worker.id, "independent work must not inherit the parent's physical owner");
  assert.notEqual(children[0].cwd, f.sourceCwd);
  const entry = startsInJournal().find((start) => start.sessionId === created.sessionId);
  assert.ok(entry, "the actual consumer must use durable admission, not just a pool-shaped argument");
  assert.equal(entry.hostId, f.worker.id);
  assert.equal(entry.poolId, f.pool.id);
  assert.match(entry.creationId, /^[A-Za-z0-9_-]{1,128}$/);
  assert.equal(children[0].creationId, entry.creationId);
  assert.equal(f.preparations.length, 1);
  const initial = f.commands.filter((command) => command.ch === children[0].ch && ["set_model", "set_session_name", "prompt"].includes(command.type));
  assert.deepEqual(initial.map(({ type, provider, modelId, name, message }) => ({ type, provider, modelId, name, message })), [
    { type: "set_model", provider: "test", modelId: "model-a", name: undefined, message: undefined },
    { type: "set_session_name", provider: undefined, modelId: undefined, name: "Release worker", message: undefined },
    { type: "prompt", provider: undefined, modelId: undefined, name: undefined, message: `[From session ${f.sourceId} via omp-web agent tools]: Build the release` },
  ]);
  const duplicate = await f.call(args, requestId);
  assert.deepEqual(JSON.parse(duplicate.result.content[0].text), created);
  assert.equal(f.spawns.length, 2);
  assert.equal(f.commands.filter((command) => command.type === "prompt").length, 1);
  const changed = await f.call({ ...args, prompt: "Different work" }, requestId);
  assert.equal(changed.isError, true);
  assert.equal(f.spawns.length, 2);
  assert.equal(f.dialogs.length, 0, "an allowAgentStart selected member needs no confirmation");

  // A separate API process has no wrappers, guard or admission promise map.
  const script = `
    const assert = (await import("node:assert/strict")).default;
    const {LinkDriver,until} = await import("./lib/hosts/link-driver.test-helper.mjs");
    const hub = await import("./lib/hosts/hub.ts");
    const {adoptRpcSession} = await import("./lib/rpc-manager.ts");
    const source = new LinkDriver(${JSON.stringify(f.source.id)}, ${JSON.stringify(f.source.token)});
    await source.dial();
    source.serve({listSessions:()=>[${JSON.stringify(f.sourceRow)}]}, message => {
      if(message.type==="req") throw new Error("journal replay attempted host work: "+message.op);
    });
    const frames=[];
    const transport={
      write(line,callback){
        const frame=JSON.parse(line); frames.push(frame); callback(null);
        if(frame.t!=="cmd")return;
        const data=frame.op==="get_state"?{sessionId:${JSON.stringify(f.sourceId)},sessionFile:${JSON.stringify(f.sourceRow.path)},isStreaming:false,isCompacting:false}:{};
        queueMicrotask(()=>transport.emit(JSON.stringify({t:"res",id:frame.id,ok:true,data})));
      },
      onLine(listener){transport.emit=listener},onStderr(){},onExit(listener){transport.exit=listener},
      endInput(){queueMicrotask(()=>transport.exit?.(0,null))},killTree(){queueMicrotask(()=>transport.exit?.(null,"SIGTERM"))}
    };
    const calls=[
      {t:"host_tool_call",id:${JSON.stringify(requestId)},toolName:"new_session",arguments:${JSON.stringify(args)}},
      {t:"host_tool_call",id:"other-mutating-tool",toolName:"send_to_session",arguments:{sessionId:"other",message:"do not replay"}}
    ];
    const session=await adoptRpcSession({host:hub.getHost(source.id),transport,sessionId:${JSON.stringify(f.sourceId)},cwd:${JSON.stringify(f.sourceCwd)},replay:calls.map(call=>JSON.stringify(call))});
    await until(()=>frames.filter(frame=>frame.t==="host_tool_result").length===2,"native request replay");
    const answers=frames.filter(frame=>frame.t==="host_tool_result");
    const creation=answers.find(frame=>frame.id===${JSON.stringify(requestId)});
    assert.equal(creation.isError,false,creation.result.content[0].text);
    assert.deepEqual(JSON.parse(creation.result.content[0].text),${JSON.stringify(created)});
    const other=answers.find(frame=>frame.id==="other-mutating-tool");
    assert.equal(other.isError,true);
    assert.match(other.result.content[0].text,/outcome is unknown/);
    await session.destroyAndWait();hub.closeHostLink(source.id);hub.flushLinkSamples();
    (await import("./lib/notification-store.ts")).closeNotificationStore();
    console.log("journal-native-replay-ok");
  `;
  const output = execFileSync(process.execPath, ["--eval", script], { cwd: worktreeRoot, env: { ...process.env }, encoding: "utf8", timeout: 10_000 });
  assert.match(output, /journal-native-replay-ok/);
  assert.equal(f.commands.filter((command) => command.type === "prompt").length, 1);
});

for (const [label, args, target] of [
  ["shared workspace", { shareWorkspace: true }, "source"],
  ["explicit standalone host", { host: "Standalone target", cwd: "/standalone/project" }, "standalone"],
  ["unregistered directory", { cwd: "/arbitrary/unregistered" }, "source"],
]) {
  test(`agent creation keeps ${label} owner-bound without pool preparation`, async (t) => {
    const f = await placementFixture(t);
    const result = await f.call(args.host ? { ...args, host: f[target].id } : args);
    assert.equal(result.isError, false, result.result.content[0].text);
    const child = f.spawns.find((spawn) => spawn.sessionId !== f.sourceId);
    assert.equal(child.hostId, f[target].id);
    assert.equal(child.cwd, args.cwd ?? f.sourceCwd);
    assert.equal(f.preparations.length, 0);
    assert.equal(startsInJournal().filter((start) => start.poolId === f.pool.id).length, 0);
  });
}

test("selected-member denial happens after durable admission and before preparation, releases its slot and never falls back", async (t) => {
  const f = await placementFixture(t, { workerAllows: false, fallback: true });
  const pending = f.call({ prompt: "Needs approval" }, "denied-native-request");
  await Promise.race([
    f.until(() => f.dialogs.length === 1, "selected worker confirmation"),
    pending.then((result) => assert.fail(`creation finished without selected-member approval: ${result.result.content[0].text}`)),
  ]);
  const [dialog] = f.dialogs;
  assert.match(dialog.title, /Selected worker/);
  const reservation = startsInJournal().find((start) => start.poolId === f.pool.id);
  assert.ok(reservation, "reservation must be persisted before asking the user");
  assert.equal(reservation.hostId, f.worker.id);
  assert.equal(reservation.reserved, true);
  assert.equal(f.preparations.length, 0, "confirmation after preparation is too late");
  assert.equal(f.spawns.length, 1, "only the existing source child may exist");
  await f.session.send({ type: "extension_ui_response", id: dialog.id, confirmed: false });
  const refused = await pending;
  assert.equal(refused.isError, true);
  assert.equal(startsInJournal().find((start) => start.creationId === reservation.creationId).reserved, false);
  assert.equal(f.preparations.length, 0);
  assert.equal(f.spawns.length, 1, "a permissive alternate host must not bypass a denied selected member");
  const { updateHost } = await import("./hosts/registry.ts");
  updateHost(f.worker.id, { allowAgentStart: true });
  const accepted = await f.call({}, "after-denial-native-request");
  assert.equal(accepted.isError, false, accepted.result.content[0].text);
  assert.equal(f.spawns.at(-1).hostId, f.worker.id, "a definite denial must release the last slot");
});

test("native pooled creation exposes its retained identity and unknown delivery after a lost initialization ack", async (t) => {
  const f = await placementFixture(t, { holdInitialization: "set_model" });
  const args = { model: "test/model-a", name: "Not yet named", prompt: "Must not be sent" };
  const requestId = "uncertain-native-creation";
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    await f.source.post({ type: "stdout", ch: f.sourceChannel, line: JSON.stringify({ t: "host_tool_call", id: requestId, toolName: "new_session", arguments: args }) });
    await f.reachedInitialization;
    // Keep both source and selected worker online; only the native acknowledgement is missing.
    for (let step = 0; step < 6; step++) {
      t.mock.timers.tick(5_000);
      await f.source.post({ type: "pong" });
      await f.worker.post({ type: "pong" });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(f.hub.getHost(f.worker.id).status(), "online");
  } finally { t.mock.timers.reset(); }
  await f.until(() => f.results.some((result) => result.id === requestId), "uncertain native creation result");
  const first = f.results.find((result) => result.id === requestId);
  const retry = await f.call(args, requestId);
  const children = f.spawns.filter((spawn) => spawn.sessionId !== f.sourceId);
  assert.equal(children.length, 1, "uncertainty must retain the original child, not replace it");
  const [child] = children;
  for (const result of [first, retry]) {
    assert.equal(result.isError, true);
    const text = result.result.content[0].text;
    assert.ok(text.length < 4096, "native errors expose only bounded recovery metadata");
    let body;
    try { body = JSON.parse(text); }
    catch { assert.fail(`Expected structured native creation recovery metadata; received: ${text}`); }
    assert.deepEqual(Object.keys(body).sort(), ["code", "cwd", "delivery", "error", "hostId", "sessionId"]);
    assert.equal(body.code, "pool_start_unknown");
    assert.equal(typeof body.error, "string");
    assert.equal(body.sessionId, child.sessionId);
    assert.equal(body.hostId, f.worker.id);
    assert.equal(body.cwd, child.cwd);
    assert.equal(body.delivery, "unknown");
  }
  assert.equal(f.rpc.getRpcSession(child.sessionId).isAlive(), true);
  assert.equal(f.preparations.length, 1);
  const initialization = f.commands.filter((command) => command.ch === child.ch && ["set_model", "set_session_name", "prompt"].includes(command.type));
  assert.deepEqual(initialization.map((command) => command.type), ["set_model"], "identical retry must neither repeat initialization nor advance past the missing acknowledgement");
});
