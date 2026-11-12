import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { linkLocalHost, listedSession, ompChild, until } from "./hosts/link-driver.test-helper.mjs";

const SESSION = "01a0e6b0-d916-7610-8343-f4a766ba0052";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-outbox-handoff-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { runAgentCommand } = await import("./agent-command.ts");
const { getRpcSession } = await import("./rpc-manager.ts");
const hub = await import("./hosts/hub.ts");
const { closeOutboxStore, outboxEntries } = await import("./message-outbox.ts");
const { closeNotificationStore } = await import("./notification-store.ts");
const { invalidateHostSessionList } = await import("./hosts/session-index.ts");

// The session is listed on a linked host, so any attempt to start or resume omp for it shows up as a `spawn`.
const spawns = [];
const daemon = await linkLocalHost();
const daemonOps = {
  async spawn(args) {
    spawns.push(args);
    await daemon.post({ type: "stdout", ch: args.ch, line: JSON.stringify({ t: "hello", proto: 1, pid: 1, sessionId: SESSION, sessionFile: args.sessionFile, cwd: args.cwd }) });
    return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
  },
  listSessions: () => [listedSession(SESSION)],
  validateCwd: ({ path }) => ({ ok: true, value: { cwd: path, projectRoot: path } }),
  sessionFileExists: () => true,
  invalidateSessionLists: () => null,
};
daemon.serve(daemonOps);

const originalSessions = globalThis.__ompSessions;
const originalLocks = globalThis.__ompStartLocks;

after(() => {
  globalThis.__ompSessions = originalSessions;
  globalThis.__ompStartLocks = originalLocks;
  hub.closeHostLink("local");
  closeNotificationStore();
  closeOutboxStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

/** A fresh wrapper registry holding at most `wrapper`; the file's `after` restores the original. */
function setRegistry(wrapper) {
  spawns.length = 0;
  invalidateHostSessionList("local");
  globalThis.__ompSessions = new Map(wrapper ? [[SESSION, wrapper]] : []);
  globalThis.__ompStartLocks = new Map();
}

/** A live wrapper whose native reply is `send(command, wrapper)`. */
function live(send) {
  const self = {
    sessionId: SESSION,
    alive: true,
    sent: [],
    isAlive: () => self.alive,
    async send(command) {
      self.sent.push(command);
      return send(command, self);
    },
  };
  return self;
}

const ASKED = ["accepted", "skill", "queued", "withdrawn", "unknown"];
const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: 1_730_000_000_000 });
const skillMessage = { role: "custom", customType: "skill-prompt", content: "expanded skill", display: true, timestamp: 1_730_000_000_001 };

/** `get_client_message_status` data as omp's RpcClient hands it over, including its `liveSteered` queue field. */
function nativeReply(overrides = {}) {
  return {
    messages: [
      { clientMessageId: "accepted", message: userMessage("long request") },
      { clientMessageId: "skill", message: skillMessage },
    ],
    queuedMessages: {
      steering: ["same text"], followUp: ["later", "legacy"], liveSteered: 0,
      clientMessageIds: { steering: ["queued"], followUp: [null, null] },
    },
    resolvedClientMessageIds: ["withdrawn"],
    persistedClientMessageIds: ["accepted"],
    unresolvedClientMessageIds: ["unknown"],
    ...overrides,
  };
}

async function ask(id = SESSION, clientMessageIds = ASKED) {
  const response = await runAgentCommand(id, { type: "get_client_message_status", clientMessageIds }, false);
  return { status: response.status, body: await response.json() };
}

test("a live wrapper's native status passes through, keeping the queue and native's own unresolved list", async () => {
  const wrapper = live(() => nativeReply());
  setRegistry(wrapper);
  const { status, body } = await ask();
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(wrapper.sent, [{ type: "get_client_message_status", clientMessageIds: ASKED }]);
  assert.deepEqual(body.data, {
    messages: [
      { clientMessageId: "accepted", message: userMessage("long request") },
      { clientMessageId: "skill", message: skillMessage },
    ],
    queuedMessages: {
      steering: ["same text"], followUp: ["later", "legacy"],
      clientMessageIds: { steering: ["queued"], followUp: [null, null] },
    },
    resolvedClientMessageIds: ["withdrawn"],
    persistedClientMessageIds: ["accepted"],
    unresolvedClientMessageIds: ["unknown"],
  });
  assert.equal(spawns.length, 0);
});

test("a message body past the response budget is left out without being reported unresolved", async () => {
  const huge = { role: "user", content: "x".repeat(17 * 1024 * 1024), timestamp: 1 };
  setRegistry(live(() => nativeReply({
    messages: [{ clientMessageId: "accepted", message: huge }, { clientMessageId: "skill", message: skillMessage }],
    persistedClientMessageIds: [],
  })));
  const { status, body } = await ask();
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.data.messages.map((item) => item.clientMessageId), ["skill"]);
  assert.deepEqual(body.data.unresolvedClientMessageIds, ["unknown"], "an omitted body is no evidence of absence: the browser asks again");
});

test("a queue past the response budget is left out without reporting its message IDs unresolved", async () => {
  const big = "x".repeat(9 * 1024 * 1024);
  setRegistry(live(() => nativeReply({
    messages: [], resolvedClientMessageIds: [], persistedClientMessageIds: [], unresolvedClientMessageIds: [],
    queuedMessages: { steering: [], followUp: [big, big], clientMessageIds: { steering: [], followUp: ["accepted", null] } },
  })));
  const { status, body } = await ask(SESSION, ["accepted"]);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.queuedMessages, null);
  assert.deepEqual(body.data.unresolvedClientMessageIds, []);
});

const OLD_SESSION = "01a0e6b0-d916-7610-8343-f4a766ba0051";

/** An outbox row that a native identity move re-homed: first under `source`, now owned by `canonical`. */
function movedEntry(id, source, canonical) {
  outboxEntries(source); // opens the store
  const now = Date.now();
  globalThis.__ompOutboxStore.db.prepare(
    "INSERT INTO entries (id, session_id, source_session_id, mode, message, owner, advisor, state, created_at, done_at) VALUES (?, ?, ?, 'prompt', '', 'owner', 0, 'delivered', ?, ?)",
  ).run(id, canonical, source, now, now);
}

test("a browser still on a session whose entry moved is answered by the child that owns the entry now", async () => {
  movedEntry("moved-live", OLD_SESSION, SESSION);
  const wrapper = live(() => nativeReply({ messages: [], resolvedClientMessageIds: [], persistedClientMessageIds: ["moved-live"], unresolvedClientMessageIds: [] }));
  setRegistry(wrapper);
  const { status, body } = await ask(OLD_SESSION, ["moved-live"]);
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(wrapper.sent, [{ type: "get_client_message_status", clientMessageIds: ["moved-live"] }]);
  assert.deepEqual(body.data.persistedClientMessageIds, ["moved-live"]);
});

test("an owner whose child cannot be proven gone keeps a moved entry's answer retryable, never 409", async () => {
  movedEntry("moved-offline", OLD_SESSION, SESSION);
  const disposed = live(() => nativeReply());
  disposed.alive = false;
  disposed.host = { status: () => "offline", label: "X" };
  setRegistry(disposed);
  const { status, body } = await ask(OLD_SESSION, ["moved-offline"]);
  assert.equal(status, 503, JSON.stringify(body));
  assert.equal(body.code, "host_offline");
});

test("a moved entry whose old and new sessions both lack a child answers 409 handoff_child_unavailable", async () => {
  movedEntry("moved-gone", OLD_SESSION, SESSION);
  setRegistry(undefined);
  const { status, body } = await ask(OLD_SESSION, ["moved-gone"]);
  assert.equal(status, 409, JSON.stringify(body));
  assert.equal(body.code, "handoff_child_unavailable");
  assert.equal(spawns.length, 0);
});

const hostile = {
  "a reply that is not an object": () => null,
  "messages that are not an array": () => nativeReply({ messages: { accepted: userMessage("x") } }),
  "a missing queue snapshot": () => nativeReply({ queuedMessages: null }),
  "a duplicate message ID": () => nativeReply({
    messages: [{ clientMessageId: "accepted", message: userMessage("a") }, { clientMessageId: "accepted", message: userMessage("b") }],
  }),
  "a message ID that was not requested": () => nativeReply({ messages: [{ clientMessageId: "intruder", message: userMessage("x") }] }),
  "an envelope without its message": () => nativeReply({ messages: [{ clientMessageId: "accepted" }] }),
  "a message without a role": () => nativeReply({ messages: [{ clientMessageId: "accepted", message: { content: "x" } }] }),
  "a message with an unknown role": () => nativeReply({ messages: [{ clientMessageId: "accepted", message: { role: "assistant", content: "x" } }] }),
  "a message without content": () => nativeReply({ messages: [{ clientMessageId: "accepted", message: { role: "user" } }] }),
  "content blocks that are not typed records": () => nativeReply({ messages: [{ clientMessageId: "accepted", message: { role: "user", content: ["x"] } }] }),
  "a custom message without its type": () => nativeReply({ messages: [{ clientMessageId: "skill", message: { role: "custom", content: "x", display: true } }] }),
  "a custom message without display": () => nativeReply({ messages: [{ clientMessageId: "skill", message: { role: "custom", customType: "skill-prompt", content: "x" } }] }),
  "resolved IDs that are not an array": () => nativeReply({ resolvedClientMessageIds: "withdrawn" }),
  "persisted IDs that were not requested": () => nativeReply({ persistedClientMessageIds: ["intruder"] }),
  "unresolved IDs that were not requested": () => nativeReply({ unresolvedClientMessageIds: ["intruder"] }),
  "more resolved IDs than were requested": () => nativeReply({ resolvedClientMessageIds: Array(ASKED.length + 1).fill("withdrawn") }),
};
for (const [name, reply] of Object.entries(hostile)) {
  test(`${name} answers 502 invalid_client_message_status`, async () => {
    setRegistry(live(reply));
    const { status, body } = await ask();
    assert.equal(status, 502, JSON.stringify(body));
    assert.equal(body.code, "invalid_client_message_status");
  });
}

test("a session change between the request and the reply answers 409 handoff_context_changed", async () => {
  for (const change of [
    (wrapper) => { wrapper.sessionId = "01a0e6b0-d916-7610-8343-f4a766ba0099"; },
    (wrapper) => { wrapper.alive = false; },
  ]) {
    setRegistry(live((_command, wrapper) => { change(wrapper); return nativeReply(); }));
    const { status, body } = await ask();
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, "handoff_context_changed");
  }
});

test("a session with no live wrapper answers 409 handoff_child_unavailable and starts nothing", async () => {
  const exited = live(() => nativeReply());
  exited.alive = false;
  exited.host = { status: () => "online", label: "X" };
  for (const wrapper of [undefined, exited]) {
    setRegistry(wrapper);
    const { status, body } = await ask();
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, "handoff_child_unavailable");
    assert.equal(spawns.length, 0, "the stopped child is neither started nor replaced");
    assert.deepEqual(exited.sent, [], "an exited wrapper is not asked");
  }
});

test("a wrapper disposed during its host's link drop is a retryable 503, never 'the child is gone'", async () => {
  const disposed = live(() => nativeReply());
  disposed.alive = false;
  disposed.host = { status: () => "offline", label: "X" };
  setRegistry(disposed);
  const { status, body } = await ask();
  assert.equal(status, 503, JSON.stringify(body));
  assert.equal(body.code, "host_offline");
  assert.deepEqual(disposed.sent, [], "an exited wrapper is not asked");
  assert.equal(spawns.length, 0);
});

test("a wrapper whose child is still shutting down is a retryable 503 until the child's exit is observed, then 409", async (t) => {
  t.mock.method(console, "info", () => {});
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");
  let exit;
  const proc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => ({}),
    sendFrame: () => {},
    dispose: () => new Promise((resolve) => { exit = resolve; }),
  };
  const wrapper = new AgentSessionWrapper(proc, process.cwd(), null, false, SESSION);
  setRegistry(wrapper);
  // As registerSession does: the registry drops the wrapper once the child has really exited.
  wrapper.onDestroy(() => globalThis.__ompSessions.delete(SESSION));
  const disposing = wrapper.destroyAndWait("test");
  assert.equal(wrapper.isAlive(), false);
  let { status, body } = await ask();
  assert.equal(status, 503, JSON.stringify(body));
  assert.equal(body.code, "handoff_child_pending", "the child may still be flushing the history the browser would read");
  proc.isAlive = false;
  exit();
  await disposing;
  ({ status, body } = await ask());
  assert.equal(status, 409, JSON.stringify(body));
  assert.equal(body.code, "handoff_child_unavailable", "once the exit is observed the child is gone");
  assert.equal(spawns.length, 0);
});

test("a registry miss while the session's host is offline is a retryable 503, never 'the child is gone'", async (t) => {
  setRegistry(undefined);
  const { offlineMs } = hub.linkTimings;
  hub.linkTimings.offlineMs = 30;
  t.after(async () => {
    hub.linkTimings.offlineMs = offlineMs;
    await daemon.dial();
    daemon.serve(daemonOps);
  });
  // The offline timer is armed by uplink traffic: one frame at the short deadline, then silence.
  await daemon.post({ type: "ping" });
  await until(() => hub.getHost("local").status() === "offline", "the local host going offline");
  const { status, body } = await ask();
  assert.equal(status, 503, JSON.stringify(body));
  assert.equal(body.code, "host_offline");
  assert.equal(spawns.length, 0);
});

test("a child another server started is awaited while this server adopts it, then asked", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  setRegistry(undefined);
  const omp = ompChild(daemon, SESSION);
  const asked = [];
  let release;
  const adopting = new Promise((resolve) => { release = resolve; });
  await daemon.dial({ channels: [{ ch: "peer-child", sessionId: SESSION, cwd: "/w", pending: [] }] });
  daemon.serve(daemonOps, async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    if (command.op === "get_state") await adopting;
    if (command.op !== "get_client_message_status") return omp(message);
    asked.push(command);
    await daemon.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ t: "res", id: command.id, ok: true, data: nativeReply() }) });
  });
  t.after(async () => {
    const disposing = getRpcSession(SESSION)?.destroyAndWait();
    await daemon.post({ type: "exit", ch: "peer-child", code: 0, signal: null });
    await disposing;
  });
  let settled = false;
  const answer = ask().finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false, "the child is still being adopted: nothing is concluded yet");
  release();
  const { status, body } = await answer;
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.data.persistedClientMessageIds, ["accepted"]);
  assert.equal(asked.length, 1);
});

test("a shared child the host still runs after this server failed to join it is a retryable 503, never 'the child is gone'", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "info", () => {});
  setRegistry(undefined);
  // A v7 host lists a child another server runs; this server's join fails, and the host keeps it running.
  await daemon.dial({ hello: { v: 7, link: { id: "l1", notifier: true } }, channels: [{ ch: "unjoined-child", sessionId: SESSION, cwd: "/w", pending: [] }] });
  daemon.serve({ ...daemonOps, open: () => { throw new Error("join refused"); } });
  t.after(async () => {
    await daemon.dial();
    daemon.serve(daemonOps);
  });
  assert.equal(await hub.adoptedChild("local", SESSION), false, "the join failed");
  assert.equal(getRpcSession(SESSION), undefined);
  const { status, body } = await ask();
  assert.equal(status, 503, JSON.stringify(body));
  assert.equal(body.code, "handoff_child_pending");
  assert.equal(spawns.length, 0);
});

test("a v7 link kept across a hot reload without its listing is unknown: a retryable 503, never an error", async (t) => {
  setRegistry(undefined);
  await daemon.dial({ hello: { v: 7, link: { id: "l2", notifier: true } }, channels: [] });
  daemon.serve(daemonOps);
  t.after(async () => {
    await daemon.dial();
    daemon.serve(daemonOps);
  });
  // `listedSessions` did not exist when the older code built this link object.
  delete globalThis.__ompHostHub.links.get("local").listedSessions;
  const { status, body } = await ask();
  assert.equal(status, 503, JSON.stringify(body));
  assert.equal(body.code, "handoff_child_pending");
  assert.equal(spawns.length, 0);
});
