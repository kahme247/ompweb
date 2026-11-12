import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

const { RpcProcess, RpcCommandError, RpcCommandTimeoutError } = await import("./rpc-process.ts");
const { AgentSessionWrapper } = await import("../rpc-manager.ts");
// Wrappers built directly need an online host; this one never spawns or reads files.
const onlineHost = {
  id: "local",
  label: "This machine",
  sessionOps: {},
  status: () => "online",
  onStatus: () => () => {},
  spawnRpc: async () => { throw new Error("this test never spawns"); },
  sessionFileExists: async () => false,
  invalidateSessionLists() {},
  autoApproveExtension: () => false,
};

const HELLO = { t: "hello", proto: 1, pid: 4321, sessionId: "s1", sessionFile: "/s/s1.jsonl", cwd: "/w" };

/** A fake ompweb-omp child speaking the channel on its stdio: says hello, records each line it is sent. */
function makeTransport() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid: 4321,
    kill() {
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  const lines = [];
  const spawnCalls = [];
  let partial = "";
  let onLine = () => {};
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const split = partial.split("\n");
    partial = split.pop();
    for (const line of split) {
      if (!line) continue;
      const frame = JSON.parse(line);
      lines.push(frame);
      onLine(frame);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
  queueMicrotask(() => stdout.write(`${JSON.stringify(HELLO)}\n`));

  return {
    lines,
    get commands() { return lines.filter((frame) => frame.t === "cmd"); },
    spawnCalls,
    child,
    set onLine(callback) { onLine = callback; },
    send(frame) { stdout.write(`${JSON.stringify(frame)}\n`); },
    spawn(...args) { spawnCalls.push(args); return child; },
  };
}

function startProcess(transport) {
  return new RpcProcess({
    cwd: "/w",
    dependencies: { resolveOmpBin: () => "fake-omp", spawn: transport.spawn },
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  while (!predicate()) await tick();
}

test("RpcProcess spawns --headless, is ready on hello, and correlates out-of-order res frames", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.deepEqual(transport.spawnCalls[0][1], ["--headless", "--cwd", "/w"]);
  const ready = await proc.waitReady();
  assert.deepEqual(ready, { type: "ready", proto: 1, pid: 4321, sessionId: "s1", sessionFile: "/s/s1.jsonl", cwd: "/w", supportsBashExcludeFromContext: true });

  const replies = [];
  const first = proc.sendCommand({ type: "set_model", provider: "p", modelId: "m" }, undefined, (success, id) => replies.push([success, id]));
  const second = proc.sendCommand({ type: "get_state" });
  await until(() => transport.commands.length === 2);
  const [firstCommand, secondCommand] = transport.commands;
  assert.deepEqual(firstCommand, { t: "cmd", id: firstCommand.id, op: "set_model", args: { provider: "p", modelId: "m" } });
  assert.equal(typeof firstCommand.id, "number");
  transport.send({ t: "res", id: secondCommand.id, ok: true, data: "second" });
  transport.send({ t: "res", id: firstCommand.id, ok: true, data: "first" });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(replies, [[true, String(firstCommand.id)]]);
  await proc.dispose(0);
});

test("a failed res rejects with RpcCommandError carrying its code", async () => {
  const transport = makeTransport();
  transport.onLine = (frame) => frame.t === "cmd" && transport.send({ t: "res", id: frame.id, ok: false, error: "busy", code: "session_busy" });
  const proc = startProcess(transport);
  await proc.waitReady();
  await assert.rejects(proc.sendCommand({ type: "new_session" }), (error) => {
    assert.ok(error instanceof RpcCommandError);
    assert.equal(error.command, "new_session");
    assert.equal(error.message, "busy");
    assert.equal(error.code, "session_busy");
    return true;
  });
  await proc.dispose(0);
});

test("RpcProcess does not create a separate Windows console", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.equal(transport.spawnCalls[0][2].windowsHide, true);
  if (process.platform === "win32") assert.equal(transport.spawnCalls[0][2].detached, false);
  await proc.dispose(0);
});

test("event frames are delivered as the event they carry, other frames keyed by type; a crash rejects pending commands", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  transport.send({ t: "event", event: { type: "agent_start" } });
  transport.send({ t: "session", sessionId: "s2", sessionFile: "/s/s2.jsonl", cwd: "/w" });
  transport.send({ t: "host_tool_call", id: "123", toolCallId: "c", toolName: "notify", arguments: {} });
  transport.send({ t: "prompt_result", id: 7, agentInvoked: true });
  transport.send({ t: "login_input", id: 3, prompt: "Code", secret: false });
  transport.send({ t: "ui", method: "notify", message: "hi", notifyType: "info" });
  transport.send({ t: "ui", method: "custom", id: 4, lines: ["x"] });
  await until(() => frames.length === 7);
  assert.deepEqual(frames, [
    { type: "agent_start" },
    { type: "session", sessionId: "s2", sessionFile: "/s/s2.jsonl", cwd: "/w" },
    { type: "host_tool_call", id: "123", toolCallId: "c", toolName: "notify", arguments: {} },
    { type: "prompt_result", id: "7", agentInvoked: true },
    { type: "login_input", id: 3, prompt: "Code", secret: false },
    { type: "ui", method: "notify", message: "hi", notifyType: "info" },
    { type: "ui", method: "custom", id: 4, lines: ["x"] },
  ]);

  const pending = proc.sendCommand({ type: "never_returns" });
  transport.child.emit("exit", 7, null);
  await assert.rejects(pending, /omp exited/);
});

test("outbound frames: generic type→t", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  proc.sendFrame({ type: "host_tool_result", id: "123", result: { content: [] }, isError: false });
  proc.sendFrame({ type: "login_input_response", id: 3, value: "code" });
  proc.sendFrame({ type: "ui_input", id: 4, data: "\r" });
  proc.sendFrame({ type: "ui_response", id: 1, value: { kind: "submit", results: [] } });
  proc.sendFrame({ type: "ui_response", id: 2 });
  await until(() => transport.lines.length === 5);
  assert.deepEqual(transport.lines, [
    { t: "host_tool_result", id: "123", result: { content: [] }, isError: false },
    { t: "login_input_response", id: 3, value: "code" },
    { t: "ui_input", id: 4, data: "\r" },
    { t: "ui_response", id: 1, value: { kind: "submit", results: [] } },
    { t: "ui_response", id: 2 },
  ]);
  await proc.dispose(0);
});

test("ui_request and ui_end pass through as the runner sent them", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  transport.send({ t: "ui_request", id: 9, method: "select", args: ["Choose", ["a"], { timeout: 5000 }] });
  transport.send({ t: "ui_end", id: 9 });
  await until(() => frames.length === 2);
  assert.deepEqual(frames, [
    { type: "ui_request", id: 9, method: "select", args: ["Choose", ["a"], { timeout: 5000 }] },
    { type: "ui_end", id: 9 },
  ]);
  await proc.dispose(0);
});

test("RpcProcess times out commands with RpcCommandTimeoutError and drops late res frames", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  await proc.waitReady();
  const frames = [];
  proc.onFrame((frame) => frames.push(frame));

  const keepAlive = setInterval(() => {}, 10);
  try {
    await assert.rejects(proc.sendCommand({ type: "slow_command" }, 20), (err) => {
      assert.ok(err instanceof RpcCommandTimeoutError);
      assert.equal(err.command, "slow_command");
      assert.equal(err.timeoutMs, 20);
      return true;
    });
  } finally {
    clearInterval(keepAlive);
  }
  const slow = transport.commands.find((command) => command.op === "slow_command");
  transport.send({ t: "res", id: slow.id, ok: true, data: "late" });
  await tick();
  assert.deepEqual(frames, []);
  await proc.dispose(0);
});

for (const type of ["remove_queued_message", "promote_queued_message"]) {
  test(`${type} times out without replaying, misrouting late ACKs, or interrupting long commands`, async (t) => {
    const transport = makeTransport();
    const proc = startProcess(transport);
    await proc.waitReady();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const wrapper = new AgentSessionWrapper(proc, process.cwd(), null, false, "", undefined, onlineHost);
    wrapper.start();

    try {
      let loginSettled = false;
      const login = wrapper.send({ type: "login", provider: "test" });
      void login.then(() => { loginSettled = true; }, () => { loginSettled = true; });
      let mutationError;
      const mutation = wrapper.send({ type, messageId: "queued-first" });
      void mutation.catch((error) => { mutationError = error; });
      await tick();
      const first = transport.commands.find((command) => command.op === type);
      assert.ok(first, "the child accepted the queue mutation but withheld its ACK");

      t.mock.timers.tick(5_000);
      await tick();
      assert.equal(mutationError?.name, "RpcCommandTimeoutError", "a hung queue mutation must reject within five seconds");
      assert.equal(mutationError.command, type);
      assert.equal(wrapper.isAlive(), true, "queue timeout must not kill unrelated work");
      assert.equal(loginSettled, false);

      let nextSettled = false;
      const next = wrapper.send({ type, messageId: "queued-next" });
      void next.then(() => { nextSettled = true; }, () => { nextSettled = true; });
      await tick();
      const mutations = transport.commands.filter((command) => command.op === type);
      assert.equal(mutations.length, 2, "the timed-out mutation must not be automatically replayed");
      const second = mutations[1];
      transport.send({ t: "res", id: first.id, ok: true, data: { messageId: "queued-first" } });
      await tick();
      assert.equal(nextSettled, false, "a late ACK must not settle a subsequent queue mutation");

      transport.send({ t: "res", id: second.id, ok: true, data: { messageId: "queued-next" } });
      assert.deepEqual(await next, { messageId: "queued-next" });
      t.mock.timers.tick(60_000);
      await tick();
      assert.equal(loginSettled, false, "long unrelated commands retain their unlimited transport wait");
      const loginCommand = transport.commands.find((command) => command.op === "login");
      transport.send({ t: "res", id: loginCommand.id, ok: true, data: { loggedIn: true } });
      assert.deepEqual(await login, { loggedIn: true });
    } finally {
      await wrapper.destroyAndWait();
    }
  });
}

function makeInjectedTransport() {
  const listeners = { line: [], stderr: [], exit: [] };
  const transport = {
    endInputCalls: 0,
    write(line, callback) {
      const command = JSON.parse(line);
      callback(null);
      queueMicrotask(() => {
        const response = { t: "res", id: command.id, ok: true, data: command.op === "get_state" ? { isStreaming: false } : undefined };
        for (const listener of listeners.line) listener(JSON.stringify(response));
      });
    },
    onLine(listener) { listeners.line.push(listener); },
    onStderr(listener) { listeners.stderr.push(listener); },
    onExit(listener) { listeners.exit.push(listener); },
    endInput() {
      transport.endInputCalls += 1;
      queueMicrotask(() => { for (const listener of listeners.exit) listener(0, null); });
    },
    killTree() {},
  };
  queueMicrotask(() => {
    for (const listener of listeners.line) listener(JSON.stringify(HELLO));
  });
  return transport;
}

test("RpcProcess runs over an injected transport", async () => {
  const transport = makeInjectedTransport();
  const proc = new RpcProcess({ cwd: process.cwd(), transport });
  await proc.waitReady();
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }), { isStreaming: false });
  await proc.dispose(0);
  assert.equal(transport.endInputCalls, 1);
  assert.equal(proc.isAlive, false);
  assert.equal(proc.exitDetails?.code, 0);
});

/** A child that was already running: it sends no `hello`, and `held` lines reach the first reader at once, as RemoteRpcTransport delivers them. */
function makeAdoptedTransport(held) {
  const readers = [];
  const transport = {
    endInputCalls: 0,
    answer: () => {},
    write(line, callback) {
      callback(null);
      queueMicrotask(() => transport.answer(JSON.parse(line)));
    },
    onLine(listener) {
      readers.push(listener);
      for (const line of held) listener(line);
    },
    onStderr() {},
    onExit(listener) { transport.exit = listener; },
    endInput() {
      transport.endInputCalls += 1;
      queueMicrotask(() => transport.exit?.(0, null));
    },
    killTree() {},
    send(record) { for (const reader of readers) reader(JSON.stringify(record)); },
  };
  return transport;
}

test("an adopted RpcProcess needs no hello and holds live frames until the replay is released", async () => {
  const transport = makeAdoptedTransport([JSON.stringify({ t: "event", event: { type: "agent_start" } })]);
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: true });
  assert.deepEqual(await proc.waitReady(1), { type: "ready", supportsBashExcludeFromContext: true });
  transport.answer = (command) => transport.send({ t: "res", id: command.id, ok: true, data: { sessionId: "s" } });
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }, 1_000), { sessionId: "s" }, "commands work while frames are held");

  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id ?? frame.type));
  transport.send({ t: "event", event: { type: "message_update", id: "live" } });
  assert.deepEqual(frames, [], "live frames wait for the replay");

  // The daemon's lines are older than anything live.
  proc.replay([
    JSON.stringify({ t: "ui_request", id: 1, method: "askDialog", args: [[]] }),
    JSON.stringify({ t: "host_tool_call", id: "h1", toolName: "notify" }),
  ]);
  assert.deepEqual(frames, [1, "h1"], "the replay is delivered at once; live frames are still held");
  proc.release();
  assert.deepEqual(frames, [1, "h1", "agent_start", "live"]);
  assert.equal(proc.isAlive, true);
  await proc.dispose(0);
});

test("an adopted RpcProcess delivers a request both replayed and held once", async () => {
  const requests = [
    { t: "ui_request", id: 1, method: "confirm", args: ["t", "m"] },
    { t: "host_tool_call", id: "h1", toolName: "send_to_session" },
    { t: "host_uri_request", id: "u1", url: "x:1" },
  ];
  // Opened while the old server stopped: the daemon resends each unacked and lists it in its hello.
  const transport = makeAdoptedTransport([...requests, { t: "host_tool_call", id: "h2" }].map((record) => JSON.stringify(record)));
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: true });
  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id));
  proc.replay(requests.map((record) => JSON.stringify(record)));
  proc.release();
  assert.deepEqual(frames, [1, "h1", "u1", "h2"]);
  await proc.dispose(0);
});

test("an adopted RpcProcess whose output outgrows the hold cap fails its commands and its replay", async () => {
  const { LINK_LIMITS } = await import("../hosts/link-protocol.ts");
  const saved = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 1_000;
  try {
    const transport = makeAdoptedTransport([]);
    const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: true });
    const frames = [];
    proc.onFrame((frame) => frames.push(frame));
    // The child holds this answer back while its output piles up.
    const pending = proc.sendCommand({ type: "get_state" });
    transport.send({ t: "event", event: { type: "message_update", text: "x".repeat(2_000) } });
    await assert.rejects(pending, /exceeded 1000 bytes/);
    await assert.rejects(proc.sendCommand({ type: "get_state" }), /exceeded 1000 bytes/);
    assert.throws(() => proc.replay([]), /exceeded 1000 bytes/);
    assert.throws(() => proc.release(), /exceeded 1000 bytes/);
    assert.deepEqual(frames, [], "nothing held reaches the session");
    await proc.dispose(0);
  } finally {
    LINK_LIMITS.channelBufferBytes = saved;
  }
});
