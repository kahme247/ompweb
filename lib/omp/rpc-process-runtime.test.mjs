import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

const { RpcProcess, RpcCommandTimeoutError } = await import("./rpc-process.ts");
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

/** Outbound v2 chunk records exactly as OMP emits them. */
function chunkRecords(frame, chunkId, payloadBytes = 256 * 1024) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / payloadBytes);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.byteLength,
    data: bytes.subarray(index * payloadBytes, (index + 1) * payloadBytes).toString("base64"),
  }));
}
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
  const commands = [];
  const spawnCalls = [];
  let partial = "";
  let onCommand = () => {};
  stdin.on("data", (chunk) => {
    partial += chunk.toString("utf8");
    const lines = partial.split("\n");
    partial = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const command = JSON.parse(line);
      commands.push(command);
      onCommand(command);
    }
  });
  stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
  queueMicrotask(() => {
    stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`);
  });

  return {
    commands,
    spawnCalls,
    child,
    set onCommand(callback) { onCommand = callback; },
    send(frame) { stdout.write(`${JSON.stringify(frame)}\n`); },
    sendFrames(frames) { for (const frame of frames) stdout.write(frame); },
    spawn(...args) { spawnCalls.push(args); return child; },
  };
}

function startProcess(transport) {
  return new RpcProcess({
    cwd: process.cwd(),
    dependencies: {
      resolveOmpBin: () => "fake-omp",
      spawn: transport.spawn,
    },
  });
}

test("RpcProcess negotiates v2 and correlates out-of-order command responses", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  assert.equal(await proc.negotiateProtocol(ready), 2);

  const first = proc.sendCommand({ type: "first" });
  const second = proc.sendCommand({ type: "second" });
  // Commands are serialized through a FIFO queue, so they land asynchronously.
  while (transport.commands.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [firstCommand, secondCommand] = transport.commands.slice(-2);
  transport.send({ type: "response", id: secondCommand.id, command: "second", success: true, data: "second" });
  transport.send({ type: "response", id: firstCommand.id, command: "first", success: true, data: "first" });

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  await proc.dispose(0);
});

test("RpcProcess does not create a separate Windows console", async () => {
  const transport = makeTransport();
  const proc = startProcess(transport);
  assert.equal(transport.spawnCalls[0][2].windowsHide, true);
  if (process.platform === "win32") assert.equal(transport.spawnCalls[0][2].detached, false);
  await proc.dispose(0);
});

test("RpcProcess reassembles v2 events and rejects pending commands when the child crashes", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  await proc.negotiateProtocol(ready);

  const frames = [];
  proc.onFrame((frame) => frames.push(frame));
  const expected = { type: "message_update", content: "x".repeat(1024 * 1024) };
  transport.sendFrames(chunkRecords(expected, "event-1").map((record) => `${JSON.stringify(record)}\n`));
  assert.deepEqual(frames, [expected]);

  const pending = proc.sendCommand({ type: "never_returns" });
  transport.child.emit("exit", 7, null);
  await assert.rejects(pending, /omp exited/);
});

test("RpcProcess times out commands with RpcCommandTimeoutError and ignores late responses", async () => {
  const transport = makeTransport();
  transport.onCommand = (command) => {
    if (command.type === "negotiate_protocol") {
      transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
    }
  };
  const proc = startProcess(transport);
  const ready = await proc.waitReady();
  await proc.negotiateProtocol(ready);

  const frameEvents = [];
  proc.onFrame((frame) => frameEvents.push(frame));

  const keepAlive = setInterval(() => {}, 10);
  try {
    const pending = proc.sendCommand({ type: "slow_command" }, 20);
    await assert.rejects(
      pending,
      (err) => {
        assert.ok(err instanceof RpcCommandTimeoutError || err.name === "RpcCommandTimeoutError");
        assert.equal(err.command, "slow_command");
        assert.equal(err.timeoutMs, 20);
        return true;
      },
    );
  } finally {
    clearInterval(keepAlive);
  }
  // Verify late response is routed to frame listener and does not re-settle or throw
  const slowCommand = transport.commands.find((c) => c.type === "slow_command");
  assert.ok(slowCommand);
  transport.send({ type: "response", id: slowCommand.id, command: "slow_command", success: true, data: "late" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(frameEvents.some((f) => f.type === "response" && f.command === "slow_command"));
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
      await new Promise((resolve) => setImmediate(resolve));
      const first = transport.commands.find((command) => command.type === type);
      assert.ok(first, "the child accepted the queue mutation but withheld its ACK");

      t.mock.timers.tick(5_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(mutationError?.name, "RpcCommandTimeoutError", "a hung queue mutation must reject within five seconds");
      assert.equal(mutationError.command, type);
      assert.equal(wrapper.isAlive(), true, "queue timeout must not kill unrelated work");
      assert.equal(loginSettled, false);

      let nextSettled = false;
      const next = wrapper.send({ type, messageId: "queued-next" });
      void next.then(() => { nextSettled = true; }, () => { nextSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      const mutations = transport.commands.filter((command) => command.type === type);
      assert.equal(mutations.length, 2, "the timed-out mutation must not be automatically replayed");
      const second = mutations[1];
      transport.send({ type: "response", id: first.id, command: type, success: true, data: { messageId: "queued-first" } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(nextSettled, false, "a late ACK must not settle a subsequent queue mutation");

      transport.send({ type: "response", id: second.id, command: type, success: true, data: { messageId: "queued-next" } });
      assert.deepEqual(await next, { messageId: "queued-next" });
      t.mock.timers.tick(60_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(loginSettled, false, "long unrelated commands retain their unlimited transport wait");
      const loginCommand = transport.commands.find((command) => command.type === "login");
      transport.send({ type: "response", id: loginCommand.id, command: "login", success: true, data: { loggedIn: true } });
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
        const data = command.type === "get_state" ? { isStreaming: false } : undefined;
        const response = { type: "response", id: command.id, command: command.type, success: true, data };
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
    for (const listener of listeners.line) listener(JSON.stringify({ type: "ready" }));
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

/** A child that was already running: it sends no `ready`, and `held` lines reach the first reader at once, as RemoteRpcTransport delivers them. */
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

test("an adopted RpcProcess needs no ready, skips a chunk tail, and holds live frames until the replay is released", async () => {
  const big = (type, id) => ({ type, id, content: "x".repeat(1024 * 1024) });
  // The web server restarted mid chunk sequence: its tail must not be a protocol error.
  const tail = chunkRecords(big("message_update", "lost"), "before-restart").slice(2);
  const transport = makeAdoptedTransport([...tail, { type: "agent_start" }].map((record) => JSON.stringify(record)));
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
  transport.answer = (command) => transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { protocolVersion: 2 } });
  assert.equal(await proc.negotiateProtocol(await proc.waitReady(1), 1_000), 2);

  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id ?? frame.type));
  const live = chunkRecords(big("message_update", "live"), "live");
  for (const record of live.slice(0, 2)) transport.send(record);
  assert.deepEqual(frames, [], "live frames wait for the replay");

  // The daemon's lines are older than anything live, and a half-read live sequence does not disturb them.
  proc.replay([
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "ask" }),
    ...chunkRecords(big("host_tool_call", "h1"), "pending").map((record) => JSON.stringify(record)),
  ]);
  assert.deepEqual(frames, ["q1", "h1"], "the replay is delivered at once; live frames are still held");
  proc.release();
  assert.deepEqual(frames, ["q1", "h1", "agent_start"]);
  for (const record of live.slice(2)) transport.send(record);
  assert.deepEqual(frames, ["q1", "h1", "agent_start", "live"]);
  assert.equal(transport.endInputCalls, 0, "no protocol error disposed the child");
  assert.equal(proc.isAlive, true);
  await proc.dispose(0);
});

test("an adopted RpcProcess delivers a request both replayed and held once", async () => {
  const requests = [
    { type: "extension_ui_request", id: "q1", method: "ask" },
    { type: "host_tool_call", id: "h1", toolName: "send_to_session" },
    { type: "host_uri_request", id: "u1", url: "x:1" },
  ];
  // Opened while the old server stopped: the daemon resends each unacked and lists it in its hello.
  const transport = makeAdoptedTransport([...requests, { type: "host_tool_call", id: "h2" }].map((record) => JSON.stringify(record)));
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
  const frames = [];
  proc.onFrame((frame) => frames.push(frame.id));
  proc.replay(requests.map((record) => JSON.stringify(record)));
  proc.release();
  assert.deepEqual(frames, ["q1", "h1", "u1", "h2"]);
  await proc.dispose(0);
});

test("a response naming another command does not settle a command with its id", async () => {
  const transport = makeAdoptedTransport([]);
  const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
  proc.release();
  const unsolicited = [];
  proc.onFrame((frame) => unsolicited.push(frame.command));
  transport.answer = (command) => {
    // An adopted RpcProcess numbers from w1 again: the old server's late answer to its own w1 arrives first.
    transport.send({ type: "response", id: command.id, command: "prompt", success: false, error: "stale" });
    transport.send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: "s" } });
  };
  assert.deepEqual(await proc.sendCommand({ type: "get_state" }, 1_000), { sessionId: "s" });
  assert.deepEqual(unsolicited, ["prompt"]);
  await proc.dispose(0);
});

test("an adopted RpcProcess whose output outgrows the hold cap fails its commands and its replay", async () => {
  const { LINK_LIMITS } = await import("../hosts/link-protocol.ts");
  const saved = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 1_000;
  try {
    const transport = makeAdoptedTransport([]);
    const proc = new RpcProcess({ cwd: process.cwd(), transport, adopted: { protocolVersion: 2 } });
    const frames = [];
    proc.onFrame((frame) => frames.push(frame));
    // The child holds this answer back while its output piles up.
    const pending = proc.sendCommand({ type: "get_state" });
    transport.send({ type: "message_update", text: "x".repeat(2_000) });
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
