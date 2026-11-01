import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAMES,
  AgentToolGuard,
  executeAgentTool,
  formatAttributedMessage,
} = await jiti.import("./agent-tools.ts");

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
    async createSession(input) {
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
