import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { linkLocalHost, listedSession } from "./hosts/link-driver.test-helper.mjs";

const SESSION = "01a0e6b0-d916-7610-8343-f4a766ba0052";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-outbox-handoff-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { runAgentCommand } = await import("./agent-command.ts");
const hub = await import("./hosts/hub.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");
const { closeNotificationStore } = await import("./notification-store.ts");
const { invalidateHostSessionList } = await import("./hosts/session-index.ts");

// The session is listed on a linked host, so any attempt to start or resume omp for it shows up as a `spawn`.
const spawns = [];
const daemon = await linkLocalHost();
daemon.serve({
  async spawn(args) {
    spawns.push(args);
    await daemon.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
    return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
  },
  listSessions: () => [listedSession(SESSION)],
  validateCwd: ({ path }) => ({ ok: true, value: { cwd: path, projectRoot: path } }),
  sessionFileExists: () => true,
  invalidateSessionLists: () => null,
});

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

test("a live wrapper's native status passes through, keeping the queue and recomputing what is unresolved", async () => {
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

test("a message body past the response budget is left out and its ID stays unresolved", async () => {
  const huge = { role: "user", content: "x".repeat(17 * 1024 * 1024), timestamp: 1 };
  setRegistry(live(() => nativeReply({
    messages: [{ clientMessageId: "accepted", message: huge }, { clientMessageId: "skill", message: skillMessage }],
    persistedClientMessageIds: [],
  })));
  const { status, body } = await ask();
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.data.messages.map((item) => item.clientMessageId), ["skill"]);
  assert.deepEqual(body.data.unresolvedClientMessageIds, ["accepted", "unknown"]);
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
  for (const wrapper of [undefined, exited]) {
    setRegistry(wrapper);
    const { status, body } = await ask();
    assert.equal(status, 409, JSON.stringify(body));
    assert.equal(body.code, "handoff_child_unavailable");
    assert.equal(spawns.length, 0, "the stopped child is neither started nor replaced");
    assert.deepEqual(exited.sent, [], "an exited wrapper is not asked");
  }
});
