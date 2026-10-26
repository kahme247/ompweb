import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import registerSessionEdit, { SESSION_EDIT_COMMAND, SESSION_EDIT_RESPONSE_PREFIX } from "./session-edit-extension.mjs";

const jiti = createJiti(import.meta.url);
const { editSessionHistory } = await jiti.import("./session-edit.ts");
const { RpcCommandTimeoutError } = await jiti.import("./rpc-process.ts");

const immediate = () => new Promise((resolve) => setImmediate(resolve));
const editReply = (result) => ({
  type: "extension_ui_request", method: "notify", message: SESSION_EDIT_RESPONSE_PREFIX + JSON.stringify(result),
});

function editTransport() {
  const listeners = new Set();
  const commands = [];
  const requests = [];
  const transport = {
    commands,
    requests,
    catalog: { commands: [{ name: SESSION_EDIT_COMMAND, source: "extension" }] },
    onPrompt: () => undefined,
    get listenerCount() { return listeners.size; },
    onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(frame) { for (const listener of listeners) listener(frame); },
    async sendCommand(command, timeoutMs) {
      commands.push(command);
      assert.ok(timeoutMs > 0, "both catalog lookup and prompt acknowledgement must be bounded");
      if (command.type === "get_available_commands") return transport.catalog;
      assert.equal(command.type, "prompt");
      assert.ok(command.message.startsWith(`/${SESSION_EDIT_COMMAND} `));
      const request = JSON.parse(command.message.slice(SESSION_EDIT_COMMAND.length + 2));
      requests.push(request);
      return transport.onPrompt(request);
    },
  };
  return transport;
}

for (const commands of [[], [{ name: SESSION_EDIT_COMMAND, source: "builtin" }], [{ name: "other", source: "extension" }]]) {
  test(`an unavailable edit extension never falls through to a model prompt (${JSON.stringify(commands)})`, async () => {
    const proc = editTransport();
    proc.catalog = { commands };
    await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /edit extension is unavailable/);
    assert.deepEqual(proc.commands.map((command) => command.type), ["get_available_commands"]);
    assert.equal(proc.listenerCount, 0);
  });
}

test("edit replies are correlated across interleaved requests and listeners leave after completion", async () => {
  const proc = editTransport();
  let firstSettled = false;
  const first = editSessionHistory(proc, "u2", "same-session");
  const second = editSessionHistory(proc, "u3", "same-session");
  void first.then(() => { firstSettled = true; });
  await immediate();
  const [one, two] = proc.requests;
  assert.notEqual(one.requestId, two.requestId);
  assert.equal(proc.listenerCount, 2);
  proc.emit({ type: "extension_ui_request", method: "notify", message: `${SESSION_EDIT_RESPONSE_PREFIX}{` });
  proc.emit(editReply({ requestId: "unrelated", sessionId: "same-session", cancelled: false, leafId: "wrong" }));
  proc.emit(editReply({ requestId: two.requestId, sessionId: "same-session", cancelled: false, leafId: "marker-two" }));
  assert.deepEqual(await second, { sessionId: "same-session", cancelled: false, leafId: "marker-two" });
  assert.equal(firstSettled, false);
  assert.equal(proc.listenerCount, 1);
  proc.emit(editReply({ requestId: one.requestId, sessionId: "same-session", cancelled: true, leafId: "original-leaf" }));
  assert.deepEqual(await first, { sessionId: "same-session", cancelled: true, leafId: "original-leaf" });
  assert.equal(proc.listenerCount, 0);
  proc.emit(editReply({ requestId: two.requestId, error: "late duplicate" }));
});

for (const cancelled of [false, true]) {
  test(`a native no-data acknowledgement waits for its delayed correlated reply (cancelled=${cancelled})`, async () => {
    const proc = editTransport();
    let settled = false;
    const pending = editSessionHistory(proc, "u2", "same-session");
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await immediate();
    assert.equal(settled, false, "the acknowledgement alone cannot complete Edit");
    assert.equal(proc.listenerCount, 1);
    proc.emit(editReply({ requestId: "another-edit", sessionId: "same-session", cancelled, leafId: "wrong" }));
    await immediate();
    assert.equal(settled, false, "only this edit's correlated reply completes it");
    const result = { sessionId: "same-session", cancelled, leafId: cancelled ? "original-leaf" : "marker" };
    proc.emit(editReply({ requestId: proc.requests[0].requestId, ...result }));
    assert.deepEqual(await pending, result);
    assert.equal(proc.listenerCount, 0);
  });
}

test("an explicit extension failure rejects even when native prompt acknowledgement reports success", async () => {
  const proc = editTransport();
  proc.onPrompt = ({ requestId }) => {
    proc.emit(editReply({ requestId, error: "The edit target must be a user message" }));
    return { agentInvoked: false };
  };
  await assert.rejects(editSessionHistory(proc, "assistant-entry", "same-session"), /target must be a user message/);
  assert.equal(proc.listenerCount, 0);
});

for (const order of ["reply-before-ack", "ack-before-reply"]) {
  test(`a correlated error survives a no-data acknowledgement (${order})`, async () => {
    const proc = editTransport();
    const { promise: acknowledgement, resolve: acknowledge } = Promise.withResolvers();
    proc.onPrompt = () => acknowledgement;
    let settled = false;
    const pending = editSessionHistory(proc, "assistant-entry", "same-session");
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(pending, /navigation hook rejected/);
    await immediate();
    const fail = () => proc.emit(editReply({ requestId: proc.requests[0].requestId, error: "navigation hook rejected" }));
    if (order === "reply-before-ack") fail();
    else acknowledge();
    await immediate();
    assert.equal(settled, false, "both correlated outcome and prompt acknowledgement must settle");
    if (order === "reply-before-ack") acknowledge();
    else fail();
    await rejection;
    assert.equal(proc.listenerCount, 0);
  });
}

for (const invalid of [
  { sessionId: "", cancelled: false, leafId: "marker" },
  { sessionId: 42, cancelled: false, leafId: "marker" },
  { sessionId: "same-session", cancelled: "false", leafId: "marker" },
  { sessionId: "same-session", cancelled: false, leafId: 123 },
]) {
  test(`invalid native edit outcomes cannot look successful (${JSON.stringify(invalid)})`, async () => {
    const proc = editTransport();
    proc.onPrompt = ({ requestId }) => {
      proc.emit(editReply({ requestId, ...invalid }));
      return { agentInvoked: false };
    };
    await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /invalid history edit result/);
    assert.equal(proc.listenerCount, 0);
  });
}

test("a correlated relocation reply retains its new identity for authoritative wrapper confirmation", async () => {
  const proc = editTransport();
  proc.onPrompt = ({ requestId, sessionId }) => {
    assert.equal(sessionId, "same-session");
    proc.emit(editReply({ requestId, sessionId: "native-moved-session", cancelled: false, leafId: "moved-marker" }));
    return { agentInvoked: false };
  };
  assert.deepEqual(await editSessionHistory(proc, "u2", "same-session"), {
    sessionId: "native-moved-session", cancelled: false, leafId: "moved-marker",
  });
  assert.equal(proc.listenerCount, 0);
});

for (const order of ["error-reply-ack", "reply-error-ack", "ack-error-reply", "ack-reply-error"]) {
  test(`an observed native write error defeats nominal edit success (${order})`, async () => {
    const proc = editTransport();
    const error = { type: "notice", source: "session-persistence", level: "error", message: "append failed: read-only session file" };
    const acknowledge = Promise.withResolvers();
    proc.onPrompt = () => acknowledge.promise;
    const pending = editSessionHistory(proc, "u2", "same-session");
    const rejected = assert.rejects(pending, /append failed: read-only session file/);
    await immediate();
    for (const step of order.split("-")) {
      if (step === "ack") {
        acknowledge.resolve({ agentInvoked: false });
        await immediate();
      } else if (step === "error") proc.emit(error);
      else proc.emit(editReply({ requestId: proc.requests[0].requestId, sessionId: "same-session", cancelled: false, leafId: "marker" }));
    }
    await rejected;
    assert.equal(proc.listenerCount, 0);
  });
}

for (const outcome of [
  { sessionId: "same-session", cancelled: false, leafId: "marker" },
  { error: "navigation hook rejected after append failed" },
]) {
  test(`a persistence notice after a no-data acknowledgement waits for handler completion (${JSON.stringify(outcome)})`, async () => {
    const proc = editTransport();
    let settled = false;
    const pending = editSessionHistory(proc, "u2", "same-session");
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(pending, { message: "append failed while navigation was suspended" });
    await immediate();
    proc.emit({ type: "notice", source: "session-persistence", level: "error", message: "append failed while navigation was suspended" });
    proc.emit(editReply({ requestId: "another-edit", ...outcome }));
    await immediate();
    assert.equal(settled, false, "neither a persistence notice nor an unrelated reply completes the handler");
    assert.equal(proc.listenerCount, 1);
    proc.emit(editReply({ requestId: proc.requests[0].requestId, ...outcome }));
    await rejection;
    assert.equal(proc.listenerCount, 0);
  });
}

test("an input hook invoking the agent cannot masquerade as a completed edit", async () => {
  const proc = editTransport();
  proc.onPrompt = ({ requestId }) => {
    proc.emit(editReply({ requestId, sessionId: "same-session", cancelled: false, leafId: "marker" }));
    return { agentInvoked: true };
  };
  await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /input hook invoked the agent/);
  assert.equal(proc.listenerCount, 0);
});

test("observed agent execution defeats a reply even when its prompt acknowledgement claims no invocation", async () => {
  const proc = editTransport();
  proc.onPrompt = ({ requestId }) => {
    proc.emit(editReply({ requestId, sessionId: "same-session", cancelled: false, leafId: "marker" }));
    proc.emit({ type: "agent_start" });
    return { agentInvoked: false };
  };
  await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /input hook invoked the agent/);
  assert.equal(proc.listenerCount, 0);
});

test("a prompt transport failure removes its reply listener and does not poison the next edit", async () => {
  const proc = editTransport();
  proc.onPrompt = () => { throw new Error("pipe closed"); };
  await assert.rejects(editSessionHistory(proc, "u2", "same-session"), /pipe closed/);
  assert.equal(proc.listenerCount, 0);
  proc.onPrompt = ({ requestId }) => {
    proc.emit(editReply({ requestId, sessionId: "same-session", cancelled: false, leafId: null }));
    return { agentInvoked: false };
  };
  assert.deepEqual(await editSessionHistory(proc, "u1", "same-session"), {
    sessionId: "same-session", cancelled: false, leafId: null,
  });
  assert.equal(proc.listenerCount, 0);
});

test("a timed-out reply is cleaned up and a late outcome cannot settle the next edit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = editTransport();
  const expired = editSessionHistory(proc, "u2", "same-session");
  const rejection = assert.rejects(expired, (error) => {
    assert.ok(error instanceof RpcCommandTimeoutError);
    assert.equal(error.command, "edit_message");
    return true;
  });
  await immediate();
  const oldRequest = proc.requests[0];
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(proc.listenerCount, 0);

  let settled = false;
  const current = editSessionHistory(proc, "u3", "same-session");
  void current.then(() => { settled = true; });
  await immediate();
  proc.emit(editReply({ requestId: oldRequest.requestId, sessionId: "same-session", cancelled: false, leafId: "old-marker" }));
  await immediate();
  assert.equal(settled, false);
  proc.emit(editReply({ requestId: proc.requests[1].requestId, sessionId: "same-session", cancelled: false, leafId: "current-marker" }));
  assert.equal((await current).leafId, "current-marker");
  assert.equal(proc.listenerCount, 0);
  t.mock.timers.tick(15_000);
});

function extensionContext({ idle = true, entry = { id: "u2", type: "message", message: { role: "user" } }, navigate } = {}) {
  let command;
  const replies = [];
  const appended = [];
  let navigations = 0;
  registerSessionEdit({
    registerCommand(name, definition) { assert.equal(name, SESSION_EDIT_COMMAND); command = definition; },
    appendEntry(...args) { appended.push(args); },
  });
  const ctx = {
    isIdle: () => idle,
    sessionManager: {
      getEntry: () => entry,
      getSessionId: () => "same-session",
      getLeafId: () => "original-leaf",
    },
    navigateTree: async (...args) => { navigations += 1; return navigate(...args); },
    ui: { notify(message) { replies.push(JSON.parse(message.slice(SESSION_EDIT_RESPONSE_PREFIX.length))); } },
  };
  return {
    run: () => command.handler(JSON.stringify({ requestId: "correlated-request", entryId: "u2", sessionId: "same-session" }), ctx),
    replies, appended, ctx, get navigations() { return navigations; },
  };
}

for (const entry of [undefined, { id: "a1", type: "message", message: { role: "assistant" } }, { id: "custom", type: "custom" }]) {
  test(`the bridge rejects non-user edit targets without navigating or appending (${JSON.stringify(entry)})`, async () => {
    const native = extensionContext({ entry: entry ?? null });
    await native.run();
    assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "The edit target must be a user message" }]);
    assert.equal(native.navigations, 0);
    assert.deepEqual(native.appended, []);
  });
}

test("the bridge refuses a busy native session before navigation", async () => {
  const native = extensionContext({ idle: false });
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "Cannot edit while the agent is running" }]);
  assert.equal(native.navigations, 0);
  assert.deepEqual(native.appended, []);
});

test("cancelled navigation explicitly replies but never persists a history marker", async () => {
  const native = extensionContext({ navigate: async () => ({ cancelled: true }) });
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", sessionId: "same-session", cancelled: true, leafId: "original-leaf" }]);
  assert.equal(native.navigations, 1);
  assert.deepEqual(native.appended, []);
});

test("navigation errors produce a correlated error reply rather than native's swallowed prompt success", async () => {
  const native = extensionContext({ navigate: async () => { throw new Error("navigation hook rejected"); } });
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "navigation hook rejected" }]);
  assert.deepEqual(native.appended, []);
});

test("a navigation hook cannot silently switch sessions before the durable edit marker", async () => {
  let changed = false;
  const native = extensionContext({ navigate: async () => { changed = true; return { cancelled: false }; } });
  native.ctx.sessionManager.getSessionId = () => changed ? "unexpected-session" : "same-session";
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "The session changed while editing history" }]);
  assert.deepEqual(native.appended, []);
});

test("a delayed command cannot navigate a different native conversation", async () => {
  const native = extensionContext({ navigate: async () => ({ cancelled: false }) });
  native.ctx.sessionManager.getSessionId = () => "unrelated-session";
  await native.run();
  assert.deepEqual(native.replies, [{ requestId: "correlated-request", error: "The session changed before editing history" }]);
  assert.equal(native.navigations, 0);
  assert.deepEqual(native.appended, []);
});

test("the navigation marker may move the native file after selecting the parent branch", async () => {
  let command;
  let sessionId = "original-session";
  let leafId = "a2";
  const entries = new Map([
    ["u1", { id: "u1", parentId: null, type: "message", message: { role: "user", content: "retained" } }],
    ["a1", { id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: "retained answer" } }],
    ["u2", { id: "u2", parentId: "a1", type: "message", message: { role: "user", content: "edit me" } }],
    ["a2", { id: "a2", parentId: "u2", type: "message", message: { role: "assistant", content: "old answer" } }],
  ]);
  const original = structuredClone([...entries]);
  const replies = [];
  registerSessionEdit({
    registerCommand(_name, definition) { command = definition; },
    appendEntry(type, data) {
      assert.equal(leafId, "a1", "navigation happens before the edited user entry");
      assert.equal(type, "omp-web-history-navigation");
      assert.deepEqual(data, { entryId: "u2" });
      sessionId = "native-moved-session";
      entries.set("marker", { id: "marker", parentId: leafId, type: "custom" });
      leafId = "marker";
    },
  });
  await command.handler(JSON.stringify({ requestId: "move", entryId: "u2", sessionId }), {
    isIdle: () => true,
    sessionManager: { getEntry: (id) => entries.get(id), getSessionId: () => sessionId, getLeafId: () => leafId },
    navigateTree: async (id, options) => {
      assert.deepEqual(options, { summarize: false });
      leafId = entries.get(id).parentId;
      return { cancelled: false };
    },
    ui: { notify(message) { replies.push(JSON.parse(message.slice(SESSION_EDIT_RESPONSE_PREFIX.length))); } },
  });
  assert.deepEqual(replies, [{ requestId: "move", sessionId: "native-moved-session", cancelled: false, leafId: "marker" }]);
  assert.deepEqual([...entries].filter(([id]) => id !== "marker"), original, "the original branch is preserved");
  const context = [];
  for (let entry = entries.get(leafId); entry; entry = entries.get(entry.parentId)) {
    if (entry.type === "message") context.unshift(entry.message.content);
  }
  assert.deepEqual(context, ["retained", "retained answer"]);
});

test("an unacknowledged edit prompt is bounded and removes its correlated listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = editTransport();
  proc.onPrompt = () => new Promise((_, reject) => {
    setTimeout(() => reject(new RpcCommandTimeoutError("prompt", 15_000)), 15_000);
  });
  const pending = editSessionHistory(proc, "u2", "same-session");
  const rejection = assert.rejects(pending, (error) => {
    assert.ok(error instanceof RpcCommandTimeoutError);
    assert.equal(error.command, "prompt");
    return true;
  });
  await immediate();
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(proc.listenerCount, 0);
});

test("a latched persistence error cannot hide a later prompt acknowledgement timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = editTransport();
  const timeout = new RpcCommandTimeoutError("prompt", 15_000);
  proc.onPrompt = () => {
    proc.emit({ type: "notice", source: "session-persistence", level: "error", message: "append failed" });
    return new Promise((_, reject) => {
      setTimeout(() => reject(timeout), 15_000);
    });
  };
  const pending = editSessionHistory(proc, "u2", "same-session");
  const rejection = assert.rejects(pending, (error) => {
    assert.ok(error instanceof RpcCommandTimeoutError, "the wrapper must recognize uncertain native completion");
    assert.equal(error, timeout, "the original acknowledgement timeout must reach teardown unchanged");
    assert.equal(error.command, "prompt");
    return true;
  });
  await immediate();
  assert.equal(proc.listenerCount, 1);
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(proc.listenerCount, 0);
});

test("a latched persistence error cannot hide a stalled correlated handler result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const proc = editTransport();
  let settled = false;
  const pending = editSessionHistory(proc, "u2", "same-session");
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(pending, (error) => {
    assert.ok(error instanceof RpcCommandTimeoutError, "the wrapper must stop the child before surfacing its persistence error");
    assert.equal(error.command, "edit_message");
    return true;
  });
  await immediate();
  proc.emit({ type: "notice", source: "session-persistence", level: "error", message: "append failed after prompt ack" });
  await immediate();
  assert.equal(settled, false, "the no-data acknowledgement and write error do not confirm handler completion");
  assert.equal(proc.listenerCount, 1);
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(proc.listenerCount, 0);
});
