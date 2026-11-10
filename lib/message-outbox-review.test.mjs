import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Database } from "bun:sqlite";

const root = mkdtempSync(join(tmpdir(), "omp-outbox-review-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const outbox = await import("./message-outbox.ts");
const { runAgentCommand } = await import("./agent-command.ts");
const { startRpcSession, subscribeHostToolCalls } = await import("./rpc-manager.ts");
const { EventStreamConnection } = await import("./event-stream-hub.ts");
const { until } = await import("./hosts/link-driver.test-helper.mjs");
const { saveWebServerSettings } = await import("./web-settings.ts");
const { closeNotificationStore } = await import("./notification-store.ts");
const wrappers = [];
let fixture = 0;

beforeEach(() => {
  outbox.closeOutboxStore();
  process.env.PI_CODING_AGENT_DIR = join(root, String(++fixture));
});
afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) await wrapper.destroyAndWait();
  closeNotificationStore();
  outbox.closeOutboxStore();
});
after(async () => {
  (await import("./hosts/hub.ts")).flushLinkSamples();
  closeNotificationStore();
  outbox.closeOutboxStore();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

async function add(sessionId, id, message = "held", mode = "prompt") {
  return outbox.runOutboxCommand(sessionId, { type: "outbox_add", scope: outbox.outboxScope(), id, message, mode }, false, "owner");
}

// Only the external child is simulated: registry, wrapper admission, RpcProcess writes and SQLite are real.
async function liveSession(sessionId, { fresh = false, supportsClientMessageIds = true, hostOwned = false } = {}) {
  const transports = [];
  const createTransport = () => {
    const transport = {
      commands: [],
      sessionId,
      pendingMessages: [],
      streaming: false,
      settled: undefined,
      asyncWork: false,
      endInputs: 0,
      replies: {},
      queue: { steering: [], followUp: [] },
      supportsClientMessageIds,
      emit(event) {
        if (event.type === "agent_start") transport.streaming = true;
        else if (event.type === "agent_end" && event.isTerminal !== false) transport.streaming = false;
        else if (event.type === "queue_update") transport.queue = { steering: event.steering, followUp: event.followUp, ...(event.clientMessageIds ? { clientMessageIds: event.clientMessageIds } : {}) };
        transport.line(JSON.stringify(event));
      },
      emitFor(command, event, key = command.type === "steer" || command.streamingBehavior === "steer" ? "steering" : "followUp") {
        assert.ok(command, "the native event must name its command");
        if (!command.clientMessageId) return transport.emit(event);
        if (event.type !== "queue_update") return transport.emit({ ...event, clientMessageId: command.clientMessageId });
        const clientMessageIds = Object.fromEntries(["steering", "followUp"].map((lane) =>
          [lane, event[lane].map((_text, index) => transport.queue.clientMessageIds?.[lane]?.[index] ?? null)]));
        clientMessageIds[key][event[key].length - 1] = command.clientMessageId;
        transport.emit({ ...event, clientMessageIds });
      },
      answer(command, data = {}) { transport.emit({ type: "response", id: command.id, command: command.type, success: true, data }); },
      write(line, callback) {
        const command = JSON.parse(line);
        transport.commands.push(command);
        if (["prompt", "follow_up", "steer", "abort_and_prompt"].includes(command.type)) transport.pendingMessages.push(command);
        else queueMicrotask(() => transport.answer(command, command.type in transport.replies ? transport.replies[command.type] : command.type === "get_state" ? {
          sessionId: transport.sessionId, sessionFile: `/nonexistent/${transport.sessionId}.jsonl`, isStreaming: transport.streaming, isCompacting: false,
          sessionName: "Review fixture",
          supportsClientMessageIds: transport.supportsClientMessageIds,
          ...(transport.settled === undefined ? {} : { isSettled: transport.settled }),
          hasPendingAsyncWork: transport.asyncWork,
          queuedMessageCount: transport.queue.steering.length + transport.queue.followUp.length,
          queuedMessages: transport.queue,
        } : {}));
        callback(null);
      },
      onLine(listener) { transport.line = listener; queueMicrotask(() => transport.emit({ type: "ready" })); },
      onStderr() {},
      onExit(listener) { transport.exit = listener; },
      onResync(listener) { transport.resync = listener; },
      endInput() { transport.endInputs += 1; queueMicrotask(() => transport.exit?.(0, null)); },
      killTree() { queueMicrotask(() => transport.exit?.(null, "SIGTERM")); },
      // A shared daemon channel: this server only leaves it.
      ...(hostOwned ? { hostOwnedLifecycle: true, close() { queueMicrotask(() => transport.exit?.(null, null)); } } : {}),
    };
    transports.push(transport);
    return transport;
  };
  const host = {
    id: "review-fixture-host", label: "Review fixture", status: () => "online", onStatus: () => () => {},
    spawnRpc: async (request) => ({ transport: createTransport(), cwd: request.cwd, fellBack: false, launchAdvisor: false, ...(hostOwned ? { advisorSpawned: false, joined: false } : {}) }),
    sessionFileExists: async () => !fresh, invalidateSessionLists() {}, autoApproveExtension: () => false,
    sessionOps: { readContext: async () => ({ ok: true, value: { entryIds: ["before"] } }) },
  };
  const { session } = await startRpcSession(sessionId, fresh ? "" : `/nonexistent/${sessionId}.jsonl`, root, undefined, false, null, undefined, host);
  wrappers.push(session);
  return { session, transport: transports[0], host, transports };
}

test("an OMP without client message IDs is sent the earlier uncorrelated way and settles as uncorrelated", { timeout: 15_000 }, async () => {
  for (const capability of ["missing", "false"]) {
    const sid = `unsupported-client-message-ids-${capability}`;
    const { transport } = await liveSession(sid);
    if (capability === "missing") delete transport.supportsClientMessageIds;
    else transport.supportsClientMessageIds = false;
    await add(sid, sid, "keep this intent");
    await until(() => transport.pendingMessages.length === 1, "uncorrelated native prompt");
    const sent = transport.pendingMessages[0];
    assert.equal("clientMessageId" in sent, false, "an older OMP is never sent an ID it cannot report back");
    transport.emit({ type: "message_end", message: { role: "user", content: "keep this intent" } });
    transport.answer(sent);
    await until(() => outbox.outboxEntries(sid).length === 0, "text-matched hand-off");
    assert.deepEqual(outbox.outboxSettlements(sid), { settledIds: [sid] }, "no native settlement for the browser to wait on");
  }
});

test("only the exact command ID settles a transformed native echo, never another or missing ID with the same text", async () => {
  const sid = "exact-id-transformed-echo";
  const { transport } = await liveSession(sid);
  await add(sid, "exact-echo-id", "original input");
  await until(() => transport.pendingMessages.length === 1, "correlated native prompt");
  const sent = transport.pendingMessages[0];
  assert.equal(sent.clientMessageId, "exact-echo-id");
  for (const metadata of [{}, { clientMessageId: "another-command" }]) {
    transport.emit({ type: "message_end", ...metadata, message: { role: "user", content: "original input" } });
    await sleep(10);
    assert.equal(outbox.outboxEntries(sid)[0]?.state, "delivering", "text equality cannot donate another command's echo");
    assert.deepEqual(outbox.outboxSettlements(sid).settledIds, []);
  }
  transport.emitFor(sent, { type: "message_end", message: { role: "user", content: "native input hook rewrote everything" } });
  transport.answer(sent);
  await until(() => outbox.outboxEntries(sid).length === 0, "exact ID native replacement");
  assert.deepEqual(outbox.outboxSettlements(sid).settledIds, ["exact-echo-id"]);
});

test("exact queue IDs disambiguate identical texts without donating uncorrelated queue growth", async () => {
  const sid = "exact-id-queue";
  const { transport } = await liveSession(sid);
  transport.emit({ type: "agent_start" });
  transport.emit({ type: "queue_update", steering: [], followUp: ["same"], clientMessageIds: { steering: [], followUp: ["older-command"] } });
  await add(sid, "exact-queue-id", "same", "followUp");
  await until(() => transport.pendingMessages.length === 1, "correlated queue command");
  const sent = transport.pendingMessages[0];
  assert.equal(sent.clientMessageId, "exact-queue-id");
  for (const metadata of [{}, { clientMessageIds: { steering: [], followUp: ["older-command", "another-command"] } }]) {
    transport.emit({ type: "queue_update", steering: [], followUp: ["same", "same"], ...metadata });
    await sleep(10);
    assert.equal(outbox.outboxEntries(sid)[0]?.state, "delivering");
    assert.deepEqual(outbox.outboxSettlements(sid).settledIds, []);
  }
  transport.emitFor(sent, { type: "queue_update", steering: [], followUp: ["same", "same"] });
  transport.answer(sent);
  await until(() => outbox.outboxEntries(sid).length === 0, "exact queue slot replacement");
  assert.deepEqual(outbox.outboxSettlements(sid).settledIds, ["exact-queue-id"]);
});

async function channel(sessionId) {
  const frames = [];
  const connection = new EventStreamConnection(undefined, {
    heartbeatMs: 60_000,
    write(name, _at, data) { if (name === "s1") frames.push(JSON.parse(data)); return true; },
    backpressured: () => false, heartbeat: () => true, close() {},
  });
  assert.deepEqual(await connection.subscribe("s1", { kind: "session", sessionId }), { ok: true });
  return { frames, close: () => connection.close() };
}

const uuid = (n) => `11111111-2222-4333-8444-${n.toString(16).padStart(12, "0")}`;

// Contention makes a row ambiguous only where its echo is matched by text: an exact client message ID needs no sole window.
async function ambiguousSession(sid, options = {}) {
  const fixture = await liveSession(sid, { supportsClientMessageIds: false, ...options });
  const { transport } = fixture;
  const direct = runAgentCommand(sid, { type: "prompt", message: "same" }, false, "another-client");
  await until(() => transport.pendingMessages.length === 1, "earlier native prompt");
  transport.answer(transport.pendingMessages[0]);
  assert.equal((await direct).status, 200);
  await add(sid, `${sid}-uncertain`, "same");
  await until(() => transport.pendingMessages.length === 2, "overlapping outbox native write");
  transport.emit({ type: "message_end", message: { role: "user", content: "same" } });
  transport.answer(transport.pendingMessages[1]);
  await until(() => outbox.outboxEntries(sid)[0]?.state === "failed", "retained ambiguous row");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
  transport.emit({ type: "agent_end", isTerminal: true });
  return fixture;
}

test("a held handoff observer leaves registered browser tools to another app tab", async (t) => {
  const sid = "handoff-browser-routing";
  const { session, transport } = await liveSession(sid);
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  transport.emit({ type: "agent_start" });
  await add(sid, "browser-held", "later", "followUp");
  await until(() => transport.pendingMessages.length === 1, "held follow-up dispatch");
  const calls = [];
  const leave = subscribeHostToolCalls((call) => calls.push(call));
  t.after(leave);
  transport.emit({ type: "host_tool_call", id: "browser-call", toolName: "open_url", arguments: { url: "https://example.test" } });
  assert.deepEqual(calls, [{ sessionId: sid, id: "browser-call", toolName: "open_url", arguments: { url: "https://example.test" }, cwd: root, hostId: "review-fixture-host" }]);
  const handled = await runAgentCommand(sid, { type: "host_tool_result", id: calls[0].id, result: { content: [{ type: "text", text: "opened" }] } }, false, "owner");
  assert.equal(handled.status, 200);
  transport.answer(transport.pendingMessages[0]);
  transport.emitFor(transport.pendingMessages[0], { type: "queue_update", steering: [], followUp: ["later"] });
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("browser-held"), "native queue handoff");
  assert.deepEqual(transport.commands.filter((command) => command.type === "host_tool_result"), [{
    type: "host_tool_result", id: "browser-call", result: { content: [{ type: "text", text: "opened" }] },
  }], "the browser result reaches omp once, without a disconnected rejection");
});

test("a registration applies when its reply is read, so a call in the same host-link batch is routed", async (t) => {
  const sid = "same-batch-registration";
  const { session, transport } = await liveSession(sid);
  const events = [];
  t.after(session.onEvent((event) => events.push(event)));
  const write = transport.write;
  // The child answers each registration and, in the same batch, immediately uses it.
  transport.write = (line, callback) => {
    const command = JSON.parse(line);
    if (command.type !== "set_host_tools" && command.type !== "set_host_uri_schemes") return write(line, callback);
    transport.commands.push(command);
    callback(null);
    queueMicrotask(() => {
      transport.answer(command);
      transport.emit(command.type === "set_host_tools"
        ? { type: "host_tool_call", id: "batched-tool", toolName: "open_url", arguments: { url: "https://example.test" } }
        : { type: "host_uri_request", id: "batched-uri", url: "browser:clipboard", operation: "read" });
    });
  };
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  await session.send({ type: "set_host_uri_schemes", schemes: [{ scheme: "browser", writable: false }] });
  assert.deepEqual(events.filter((event) => event.type === "host_tool_call" || event.type === "host_uri_request").map((event) => event.id), ["batched-tool", "batched-uri"]);
  assert.deepEqual(transport.commands.filter((command) => command.isError === true), [], "neither registered call was rejected");
});

test("a prior prompt's asynchronous error cannot mark a newly queued held message Not sent", async () => {
  for (const mode of ["followUp", "steer", "prompt"]) {
    for (const failure of ["response", "legacy-response", "prompt_result"]) {
      const sid = `prior-failure-${mode}-${failure}`;
      const { session, transport } = await liveSession(sid);
      const events = [];
      const detach = session.onEvent((event) => events.push(event), { internal: true });
      try {
        const initial = runAgentCommand(sid, { type: "prompt", message: "earlier" }, false, "owner");
        await until(() => transport.pendingMessages.length === 1, "initial prompt");
        const prior = transport.pendingMessages[0];
        transport.emit({ type: "message_end", message: { role: "user", content: "earlier" } });
        transport.answer(prior);
        assert.equal((await initial).status, 200);
        transport.emit({ type: "agent_start" });
        const text = mode === "prompt" ? "/review later" : "later";
        const id = `${sid}-held`;
        await add(sid, id, text, mode);
        await until(() => transport.pendingMessages.length === 2, "new held dispatch");
        const sent = transport.pendingMessages[1];
        if (failure === "prompt_result") transport.emit({ type: "prompt_result", status: "error", error: { message: "earlier run failed" } });
        else transport.emit({ type: "response", id: prior.id, ...(failure === "response" ? { command: "prompt" } : {}), success: false, error: "earlier run failed" });
        assert.equal(events.at(-1).type, failure === "prompt_result" ? "prompt_result" : "prompt_error", "the real run failure remains visible");
        transport.answer(sent);
        const key = mode === "steer" ? "steering" : "followUp";
        transport.emitFor(sent, { type: "queue_update", steering: [], followUp: [], [key]: [text] });
        await until(() => outbox.outboxSettlements(sid).settledIds.includes(id) || outbox.outboxEntries(sid)[0]?.state === "failed", "persisted handoff outcome");
        assert.deepEqual(outbox.outboxEntries(sid), [], `${mode}/${failure} retires only the genuinely queued held row`);
        assert.ok(outbox.outboxSettlements(sid).settledIds.includes(id));
        assert.deepEqual((await session.send({ type: "get_state" })).queuedMessages, {
          steering: [], followUp: [], [key]: [text],
          clientMessageIds: { steering: [], followUp: [], [key]: [id] },
        });
        assert.equal(transport.pendingMessages.filter((command) => command.message === text).length, 1);
      } finally {
        detach();
      }
    }
  }
});

test("a held message's own native rejection stays Not sent and child loss stays uncertain", async () => {
  for (const mode of ["prompt", "followUp", "steer"]) {
    for (const outcome of ["rejected", "child-exit"]) {
      const sid = `own-outcome-${mode}-${outcome}`;
      const { transport } = await liveSession(sid);
      if (mode !== "prompt") transport.emit({ type: "agent_start" });
      await add(sid, sid, "held", mode);
      await until(() => transport.pendingMessages.length === 1, "held native write");
      const sent = transport.pendingMessages[0];
      if (outcome === "rejected") transport.emit({ type: "response", id: sent.id, command: sent.type, success: false, error: "own native refusal" });
      else {
        transport.answer(sent);
        transport.exit(1, null);
      }
      await until(() => outbox.outboxEntries(sid)[0]?.state === "failed", "own failure retained");
      const entry = outbox.outboxEntries(sid)[0];
      assert.equal(entry.mayHaveBeenSent === true, outcome === "child-exit");
      if (outcome === "rejected") assert.equal(entry.error, "own native refusal");
      assert.equal(outbox.outboxSettlements(sid).settledIds.includes(sid), false);
      assert.equal(transport.pendingMessages.length, 1, "failed/uncertain deliveries never retry themselves");
    }
  }
});

test("a native ownership move persists held and failed routing before any further outbox publication", async () => {
  const oldId = "unpublished-native-old", newId = "unpublished-native-new";
  const { session, transport, host } = await liveSession(oldId);
  outbox.startOutbox();
  await add(oldId, "move-failed", "retained failure");
  await until(() => transport.pendingMessages.length === 1, "first native dispatch");
  const rejected = transport.pendingMessages[0];
  transport.emit({ type: "response", id: rejected.id, command: rejected.type, success: false, error: "Native refusal" });
  await until(() => outbox.outboxEntries(oldId)[0]?.state === "failed", "retained failed row");
  host.status = () => "offline";
  await add(oldId, "move-held", "held for host", "followUp");
  await until(() => outbox.outboxEntries(oldId).some((entry) => entry.id === "move-held" && entry.state === "waiting_host"), "held row before move");
  host.status = () => "online"; // Reachable again, without a hello/pump that could mask migration.
  transport.sessionId = newId;
  transport.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
  await until(() => session.sessionId === newId, "confirmed native identity");
  const rows = globalThis.__ompOutboxStore.db.prepare("SELECT id, session_id, source_session_id FROM entries ORDER BY rowid").all();
  assert.deepEqual(rows, [
    { id: "move-failed", session_id: newId, source_session_id: oldId },
    { id: "move-held", session_id: newId, source_session_id: oldId },
  ], "the identity lifecycle itself commits routing, without add/remove/pump publication");
  await session.destroyAndWait();
  outbox.closeOutboxStore();
  assert.deepEqual(outbox.outboxEntries(newId).map(({ id }) => id), ["move-failed", "move-held"], "canonical routing survives wrapper disposal and store reopening");
  const replay = await (await add(oldId, "move-held", "held for host", "followUp")).json();
  assert.equal(replay.data.entry.sessionId, newId, "the original source-ID replay finds its canonical receipt after restart");
});

const settledState = (sid) => ({
  sessionId: sid, sessionFile: `/nonexistent/${sid}.jsonl`, sessionName: "Review fixture",
  isStreaming: false, isCompacting: false, isSettled: true, hasPendingAsyncWork: false,
  queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] },
});

/** Leaves the (`skip` + 1)th later get_state unanswered: `hold.command` is it, answered by the test. */
function holdState(transport, skip = 0) {
  const write = transport.write;
  const hold = { command: undefined };
  transport.write = (line, callback) => {
    const command = JSON.parse(line);
    if (command.type !== "get_state" || hold.command || skip-- > 0) return write(line, callback);
    transport.commands.push(command);
    hold.command = command;
    callback(null);
  };
  return hold;
}

test("a later idle message lifts a settled child's taint and goes to the same child, without replaying uncertain rows", async () => {
  const sid = "idle-settle";
  const { session, transport, transports } = await ambiguousSession(sid);
  transport.settled = true;
  await add(sid, "after-idle-settle", "new message");
  await until(() => transport.pendingMessages.length === 3, "new message on the same child");
  assert.equal(transports.length, 1, "the settle read replaces no child");
  assert.equal(transport.endInputs, 0);
  const sent = transport.pendingMessages[2];
  assert.equal(sent.message, "new message");
  transport.emit({ type: "message_end", message: { role: "user", content: "new message" } });
  transport.answer(sent);
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("after-idle-settle")
    || outbox.outboxEntries(sid).some((entry) => entry.id === "after-idle-settle" && entry.state === "failed"), "new message handoff");
  assert.ok(outbox.outboxSettlements(sid).settledIds.includes("after-idle-settle"), "settled from its own echo");
  assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state, entry.mayHaveBeenSent]), [[`${sid}-uncertain`, "failed", true]]);
  assert.equal(session.hasPendingMessageCommands(), false);
  assert.deepEqual(transport.pendingMessages.map((command) => command.message), ["same", "same", "new message"]);
});

test("active, queued, async, unsupported or offline native work keeps the taint, even across a settlement event", async () => {
  for (const shape of ["active", "queued", "async", "unsupported", "offline"]) {
    const sid = `settle-no-${shape}`;
    const { session, transport, transports, host } = await ambiguousSession(sid);
    transport.settled = shape === "unsupported" ? undefined : true;
    if (shape === "active") transport.emit({ type: "agent_start" });
    if (shape === "queued") transport.emit({ type: "queue_update", steering: [], followUp: ["pending"] });
    if (shape === "async") transport.asyncWork = true;
    if (shape === "offline") host.status = () => "offline";
    const id = `${sid}-later`;
    await add(sid, id, "later", shape === "active" ? "steer" : "prompt");
    if (shape === "offline") {
      await until(() => outbox.outboxEntries(sid).find((entry) => entry.id === id)?.state === "waiting_host", "offline held message");
    } else {
      await until(() => transport.pendingMessages.length === 3, "unfenced later native admission");
      if (shape === "active") {
        assert.equal(transport.pendingMessages[2].type, "steer");
        assert.equal((await runAgentCommand(sid, { type: "abort" }, false, "owner")).status, 200, "Stop never waits for the run or replacement proof");
      }
      transport.answer(transport.pendingMessages[2]);
      await until(() => outbox.outboxEntries(sid).find((entry) => entry.id === id)?.state === "failed", "conservative current outcome");
    }
    if (shape !== "active") transport.emit({ type: "agent_end", isTerminal: true });
    transport.emit({ type: "session_settled" });
    await sleep(10);
    assert.equal(session.hasPendingMessageCommands(), true, shape);
    assert.equal(transport.endInputs, 0, shape);
    assert.equal(transports.length, 1, shape);
    assert.equal(outbox.outboxEntries(sid).find((entry) => entry.id === `${sid}-uncertain`).state, "failed");
  }
});

test("a run or preparation starting while the settle read is in flight keeps the taint", async () => {
  for (const race of ["run", "preparation"]) {
    const sid = `settle-raced-${race}`;
    const { session, transport, transports } = await ambiguousSession(sid);
    transport.settled = true;
    const write = transport.write;
    let heldState;
    let stateReads = 0;
    transport.write = (line, callback) => {
      const command = JSON.parse(line);
      if (command.type === "get_state" && ++stateReads === 2) {
        transport.commands.push(command);
        heldState = command;
        callback(null);
      } else write(line, callback);
    };
    const id = `${sid}-later`;
    await add(sid, id, "later");
    await until(() => heldState !== undefined, "settle read in flight");
    let release;
    const preparation = race === "preparation" ? session.withPendingCommand(() => new Promise((resolve) => { release = resolve; })) : null;
    if (race === "run") transport.emit({ type: "agent_start" });
    transport.answer(heldState, settledState(sid));
    await until(() => transport.pendingMessages.length === 3, "conservative later dispatch");
    assert.equal(transport.pendingMessages[2].type, race === "run" ? "follow_up" : "prompt");
    assert.equal(session.hasPendingMessageCommands(), true, race);
    transport.answer(transport.pendingMessages[2]);
    await until(() => outbox.outboxEntries(sid).find((entry) => entry.id === id)?.state === "failed", "conservative later outcome");
    assert.equal(transport.endInputs, 0, race);
    assert.equal(transports.length, 1, race);
    if (race === "run") {
      const stop = await runAgentCommand(sid, { type: "abort" }, false, "owner");
      assert.equal(stop.status, 200, JSON.stringify(await stop.json()));
    } else {
      release();
      await preparation;
    }
    assert.equal(session.hasPendingMessageCommands(), true, race);
  }
});

test("another pending native control reply keeps the taint, and the settle read after that reply lifts it", async () => {
  for (const phase of ["before", "preflight"]) {
    const sid = `settle-control-${phase}`;
    const { session, transport, transports } = await ambiguousSession(sid);
    transport.settled = true;
    const write = transport.write;
    let heldControl;
    let heldState;
    let stateReads = 0;
    transport.write = (line, callback) => {
      const command = JSON.parse(line);
      if (command.type === "get_available_commands") {
        transport.commands.push(command);
        heldControl = command;
        callback(null);
      } else if (phase === "preflight" && command.type === "get_state" && ++stateReads === 2) {
        transport.commands.push(command);
        heldState = command;
        callback(null);
      } else write(line, callback);
    };
    let control;
    if (phase === "before") {
      control = runAgentCommand(sid, { type: "get_commands" }, false, "owner");
      await until(() => heldControl !== undefined, "earlier native control write");
    }
    await add(sid, `${sid}-later`, "later unique input");
    if (phase === "preflight") {
      await until(() => heldState !== undefined, "settle read in flight");
      control = runAgentCommand(sid, { type: "get_commands" }, false, "owner");
      await until(() => heldControl !== undefined, "control admitted during the settle read");
      transport.answer(heldState, settledState(sid));
    }
    let controlResponse;
    try {
      await until(() => transport.pendingMessages.length === 3, "later message dispatch");
      assert.equal(session.hasPendingMessageCommands(), true, "a child that owes another command reply stays tainted");
      transport.answer(transport.pendingMessages[2]);
      await until(() => outbox.outboxEntries(sid).find((entry) => entry.id === `${sid}-later`)?.state === "failed", "conservative later outcome");
    } finally {
      transport.answer(heldControl, { commands: [] });
      controlResponse = await control;
    }
    assert.equal(controlResponse.status, 200, "the original native control still receives its own successful reply");
    assert.equal(session.hasPendingMessageCommands(), true, "completing a control reply alone never lifts the taint");
    transport.emit({ type: "agent_end", isTerminal: true });
    const nextId = `${sid}-after-control`;
    await add(sid, nextId, "after control");
    await until(() => transport.pendingMessages.length === 4, "same child after control completion");
    assert.equal(transports.length, 1);
    assert.equal(transport.endInputs, 0);
    const sent = transport.pendingMessages[3];
    assert.equal(sent.message, "after control");
    transport.emit({ type: "message_end", message: { role: "user", content: "after control" } });
    transport.answer(sent);
    await until(() => outbox.outboxSettlements(sid).settledIds.includes(nextId), "message handoff after control completion");
    assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state]), [[`${sid}-uncertain`, "failed"], [`${sid}-later`, "failed"]]);
    assert.deepEqual(transport.pendingMessages.map((command) => command.message), ["same", "same", "later unique input", "after control"], "no uncertain native message is replayed");
  }
});

test("a message sent while a settlement's read is in flight joins that read and is delivered untainted", async () => {
  const sid = "settle-joined";
  const { session, transport, transports } = await ambiguousSession(sid);
  transport.settled = true;
  const hold = holdState(transport);
  transport.emit({ type: "session_settled" });
  await until(() => hold.command !== undefined, "settlement read in flight");
  const reads = transport.commands.filter((command) => command.type === "get_state").length;
  await add(sid, "during-settle-read", "new message");
  await until(() => transport.commands.filter((command) => command.type === "get_state").length > reads, "outbox start read");
  await sleep(20);
  assert.equal(transport.pendingMessages.length, 2, "the message waits for the read instead of going out tainted");
  transport.answer(hold.command, settledState(sid));
  await until(() => transport.pendingMessages.length === 3, "untainted dispatch");
  const sent = transport.pendingMessages[2];
  transport.emit({ type: "message_end", message: { role: "user", content: "new message" } });
  transport.answer(sent);
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("during-settle-read")
    || outbox.outboxEntries(sid).some((entry) => entry.id === "during-settle-read" && entry.state === "failed"), "joined message outcome");
  assert.ok(outbox.outboxSettlements(sid).settledIds.includes("during-settle-read"), "delivered, not failed");
  assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state, entry.mayHaveBeenSent]), [[`${sid}-uncertain`, "failed", true]]);
  assert.equal(session.hasPendingMessageCommands(), false);
  assert.equal(transports.length, 1);
});

test("a failed settle read leaves the unsent message held for a retry", async () => {
  const sid = "settle-read-failed";
  const { session, transport } = await ambiguousSession(sid);
  transport.settled = true;
  const hold = holdState(transport, 1);
  await add(sid, "after-failed-read", "new message");
  await until(() => hold.command !== undefined, "settle read in flight");
  transport.emit({ type: "response", id: hold.command.id, command: "get_state", success: false, error: "state unavailable" });
  await sleep(20);
  const entry = outbox.outboxEntries(sid).find((item) => item.id === "after-failed-read");
  assert.equal(entry.state, "held", "nothing was written, so the read's failure is no outcome");
  assert.equal(transport.pendingMessages.length, 2);
  assert.equal(session.hasPendingMessageCommands(), true);
  outbox.pumpOutbox(sid);
  await until(() => transport.pendingMessages.length === 3, "retried dispatch");
  transport.emit({ type: "message_end", message: { role: "user", content: "new message" } });
  transport.answer(transport.pendingMessages[2]);
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("after-failed-read"), "retried message handoff");
  assert.deepEqual(outbox.outboxEntries(sid).map((item) => [item.id, item.state]), [[`${sid}-uncertain`, "failed"]]);
});

test("a settle read keeps the taint for compaction, another session, a peer admission or an admission completed during it", async () => {
  for (const shape of ["compacting", "moved", "peer", "admission", "settled"]) {
    const sid = `settle-read-${shape}`;
    const { session, transport } = await ambiguousSession(sid);
    const hold = holdState(transport);
    const read = session.clearMessageProofTaintIfSettled();
    await until(() => hold.command !== undefined, "settle read in flight");
    if (shape === "peer") transport.emit({ type: "peer_message_command" });
    if (shape === "admission") {
      const builtin = session.send({ type: "prompt", message: "/model" });
      await until(() => transport.pendingMessages.length === 3, "admission during the read");
      transport.answer(transport.pendingMessages[2], { agentInvoked: false });
      await builtin;
    }
    transport.answer(hold.command, {
      ...settledState(sid),
      ...(shape === "compacting" ? { isCompacting: true } : {}),
      ...(shape === "moved" ? { sessionId: `${sid}-other` } : {}),
    });
    assert.equal(await read, shape === "settled", shape);
    assert.equal(session.hasPendingMessageCommands(), shape !== "settled", shape);
  }
});

test("overlapping direct prompts taint the child until a settled native read after the run, then run-time messages settle on the same child", { timeout: 15_000 }, async () => {
  const sid = "overlapping-direct-prompts";
  const { session, transport, transports } = await liveSession(sid, { supportsClientMessageIds: false });
  transport.settled = true;
  const first = runAgentCommand(sid, { type: "prompt", message: "PR update 1" }, false, "pr-watcher");
  await until(() => transport.pendingMessages.length === 1, "first direct prompt");
  transport.answer(transport.pendingMessages[0]);
  assert.equal((await first).status, 200);
  transport.emit({ type: "agent_start" });
  const second = runAgentCommand(sid, { type: "follow_up", message: "PR update 2" }, false, "pr-watcher");
  await until(() => transport.pendingMessages.length === 2, "second direct prompt while the first proof is open");
  transport.answer(transport.pendingMessages[1]);
  assert.equal((await second).status, 200);
  transport.emit({ type: "message_end", message: { role: "user", content: "PR update 1" } });
  assert.equal(session.hasPendingMessageCommands(), true, "the overlapping write leaves no contiguous proof");

  // The reproduction: while tainted, a message sent during the run cannot own its echo.
  await add(sid, "during-run", "user during run");
  await until(() => transport.pendingMessages.length === 3, "tainted run-time dispatch");
  transport.answer(transport.pendingMessages[2]);
  transport.emit({ type: "message_end", message: { role: "user", content: "user during run" } });
  await until(() => outbox.outboxEntries(sid)[0]?.state === "failed", "ambiguous run-time outcome");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);

  transport.emit({ type: "agent_end", isTerminal: true });
  transport.emit({ type: "session_settled" });
  await until(() => !session.hasPendingMessageCommands(), "settled native read after every reply");
  assert.equal(transports.length, 1, "the child is not replaced");
  assert.equal(transport.endInputs, 0);

  transport.emit({ type: "agent_start" });
  await add(sid, "after-settle", "user in next run");
  await until(() => transport.pendingMessages.length === 4, "next run-time dispatch");
  const sent = transport.pendingMessages[3];
  assert.equal(sent.type, "follow_up");
  transport.emitFor(sent, { type: "queue_update", steering: [], followUp: ["user in next run"] });
  transport.answer(sent);
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("after-settle")
    || outbox.outboxEntries(sid).some((entry) => entry.id === "after-settle" && entry.state === "failed"), "next run-time outcome");
  assert.ok(outbox.outboxSettlements(sid).settledIds.includes("after-settle"), "retired from its own echo");
  assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state, entry.mayHaveBeenSent]), [["during-run", "failed", true]], "the uncertain row stays uncertain");
  assert.deepEqual(transport.pendingMessages.map((command) => command.message), ["PR update 1", "PR update 2", "user during run", "user in next run"], "nothing is replayed");
});

test("a shared daemon child's taint lifts at settlement and the next message is retired from its echo", async () => {
  const sid = "shared-settle";
  const { session, transport, transports } = await ambiguousSession(sid, { hostOwned: true });
  assert.equal(session.hostOwnedLifecycle, true);
  transport.settled = true;
  transport.emit({ type: "session_settled" });
  await until(() => !session.hasPendingMessageCommands(), "shared child's settle read");
  transport.emit({ type: "agent_start" });
  await add(sid, "shared-after-settle", "user in next run", "followUp");
  await until(() => transport.pendingMessages.length === 3, "shared child dispatch");
  const sent = transport.pendingMessages[2];
  assert.equal(sent.type, "follow_up");
  transport.emitFor(sent, { type: "queue_update", steering: [], followUp: ["user in next run"] });
  transport.answer(sent);
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("shared-after-settle")
    || outbox.outboxEntries(sid).some((entry) => entry.id === "shared-after-settle" && entry.state === "failed"), "shared child outcome");
  assert.ok(outbox.outboxSettlements(sid).settledIds.includes("shared-after-settle"), "retired from its own echo");
  assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state, entry.mayHaveBeenSent]), [[`${sid}-uncertain`, "failed", true]]);
  assert.equal(transports.length, 1, "no restart");
  assert.equal(transport.endInputs, 0);
});

test("an uncontended direct message completed during transcript preparation refreshes the current queue, mode and saved boundary", async () => {
  const sid = "refresh-preparation";
  const { session, transport, host } = await liveSession(sid);
  let releaseBoundary;
  let readingBoundary = false;
  host.sessionOps.readContext = () => new Promise((resolve) => { readingBoundary = true; releaseBoundary = resolve; });
  await add(sid, "prepared-current", "current");
  await until(() => readingBoundary, "current transcript preparation");
  const direct = runAgentCommand(sid, { type: "prompt", message: "external" }, false, "another-client");
  await until(() => transport.pendingMessages.length === 1, "direct native write during preparation");
  transport.emit({ type: "agent_start" });
  transport.emit({ type: "message_end", message: { role: "user", content: "external" } });
  transport.answer(transport.pendingMessages[0]);
  assert.equal((await direct).status, 200);
  await until(() => !session.hasPendingMessageCommands(), "proven direct replacement");
  releaseBoundary({ ok: true, value: { entryIds: ["stale-before-external"] } });
  await until(() => transport.pendingMessages.length === 2, "current native write after fresh preparation");
  assert.equal(transport.pendingMessages[1].type, "follow_up", "the completed direct prompt's active run changes native delivery mode");
  assert.equal(outbox.outboxEntries(sid).find((entry) => entry.id === "prepared-current").previousEntryIds, undefined, "the stale transcript boundary is discarded");
  transport.emitFor(transport.pendingMessages[1], { type: "queue_update", steering: [], followUp: ["current"] });
  transport.answer(transport.pendingMessages[1]);
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("prepared-current") || outbox.outboxEntries(sid)[0]?.state === "failed", "refreshed handoff");
  assert.deepEqual(outbox.outboxEntries(sid), []);
  assert.deepEqual(transport.pendingMessages.map((command) => [command.type, command.message]), [["prompt", "external"], ["follow_up", "current"]]);
});

test("a held observer attaches on explicit idle wrapper startup and rebinds without an outbox publication", async () => {
  const sid = uuid(1);
  assert.equal((await add(sid, "observer")).status, 200);
  await until(() => outbox.outboxEntries(sid)[0]?.state === "waiting_host", "offline held row");
  const watch = await channel(sid);
  try {
    assert.equal(watch.frames.some((frame) => frame.type === "connected"), false);
    const first = await liveSession(sid);
    assert.equal((await runAgentCommand(sid, { type: "get_state" }, false, "owner")).status, 200);
    assert.equal(watch.frames.filter((frame) => frame.type === "connected").length, 1);
    first.transport.emit({ type: "message_end", message: { role: "user", content: "first" } });
    assert.equal(watch.frames.at(-1).message.content, "first");
    await first.session.destroyAndWait();
    const second = await liveSession(sid);
    assert.equal(watch.frames.filter((frame) => frame.type === "connected").length, 2);
    second.transport.emit({ type: "message_end", message: { role: "user", content: "replacement" } });
    assert.equal(watch.frames.at(-1).message.content, "replacement");
    assert.equal(outbox.outboxEntries(sid)[0].state, "waiting_host", "observing never dispatches the held row");
  } finally { watch.close(); }
});

test("a competing API write cannot donate its identical echo or queue occurrence to a text-matched outbox reply", async () => {
  for (const eventType of ["echo", "queue", "echo-before-competing-write"]) {
    const sid = `overlap-${eventType}`;
    const { transport } = await liveSession(sid, { supportsClientMessageIds: false });
    await add(sid, `entry-${eventType}`, "same");
    await until(() => transport.pendingMessages.length === 1, "outbox native write");
    const own = transport.pendingMessages[0];
    if (eventType === "echo-before-competing-write") transport.emit({ type: "message_end", message: { role: "user", content: "same" } });
    const competing = runAgentCommand(sid, { type: "follow_up", message: "same" }, false, "another-client");
    await until(() => transport.pendingMessages.length === 2, "competing native write");
    if (eventType === "queue") transport.emit({ type: "queue_update", steering: [], followUp: ["same"] });
    else transport.emit({ type: "message_end", message: { role: "user", content: "same" } });
    transport.answer(transport.pendingMessages[1]);
    await competing;
    transport.answer(own);
    await until(() => outbox.outboxEntries(sid)[0]?.state === "failed" || outbox.outboxEntries(sid).length === 0, "correlation outcome");
    assert.equal(outbox.outboxEntries(sid)[0]?.state, "failed", eventType);
    assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
    assert.deepEqual(outbox.outboxSettlements(sid).settledIds, []);
    assert.equal((await runAgentCommand(sid, { type: "abort" }, false, "owner")).status, 200, "Stop is never fenced behind replacement inference");
  }
});

test("an exact client message ID settles its outbox row while another command is admitted; nothing else does", async () => {
  for (const evidence of ["echo", "queue"]) {
    const sid = `exact-contended-${evidence}`;
    const id = `exact-contended-row-${evidence}`;
    const { transport } = await liveSession(sid);
    if (evidence === "queue") transport.emit({ type: "agent_start" });
    await add(sid, id, "same", evidence === "queue" ? "followUp" : "prompt");
    await until(() => transport.pendingMessages.length === 1, "outbox native write");
    const own = transport.pendingMessages[0];
    assert.equal(own.clientMessageId, id);
    const competing = runAgentCommand(sid, { type: "follow_up", message: "same" }, false, "another-client");
    await until(() => transport.pendingMessages.length === 2, "competing native write");
    transport.emit({ type: "message_end", message: { role: "user", content: "same" } });
    await sleep(10);
    assert.equal(outbox.outboxEntries(sid)[0]?.state, "delivering", `${evidence}: the competing echo carries no ID and neither settles nor ends the wait`);
    transport.answer(transport.pendingMessages[1]);
    await competing;
    transport.emitFor(own, evidence === "echo" ? { type: "message_end", message: { role: "user", content: "same" } }
      : { type: "queue_update", steering: [], followUp: ["same"] }, "followUp");
    transport.answer(own);
    await until(() => outbox.outboxEntries(sid).length === 0 || outbox.outboxEntries(sid)[0]?.state === "failed", `${evidence}: exact receipt outcome`);
    assert.deepEqual(outbox.outboxEntries(sid), [], evidence);
    assert.deepEqual(outbox.outboxSettlements(sid).settledIds, [id], evidence);
  }
});

test("a displayed native custom message with the exact ID settles its row without user attribution; a hidden or foreign one does not", async () => {
  const sid = "exact-custom-echo";
  const { transport } = await liveSession(sid);
  await add(sid, "exact-custom", "/skill:demo do it");
  await until(() => transport.pendingMessages.length === 1, "correlated native prompt");
  const sent = transport.pendingMessages[0];
  transport.emitFor(sent, { type: "message_end", message: { role: "custom", customType: "skill-prompt", content: "hidden", display: false } });
  transport.emit({ type: "message_end", clientMessageId: "another-command", message: { role: "custom", customType: "skill-prompt", content: "foreign", display: true } });
  await sleep(10);
  assert.equal(outbox.outboxEntries(sid)[0]?.state, "delivering");
  transport.emitFor(sent, { type: "message_end", message: { role: "custom", customType: "skill-prompt", content: "expanded native skill", display: true } });
  transport.answer(sent);
  await until(() => outbox.outboxEntries(sid).length === 0 || outbox.outboxEntries(sid)[0]?.state === "failed", "exact custom receipt outcome");
  assert.deepEqual(outbox.outboxEntries(sid), []);
  assert.deepEqual(outbox.outboxSettlements(sid).settledIds, ["exact-custom"]);
});

test("a hidden native custom message with the exact ID never settles its row, even when attributed to the user", async () => {
  const sid = "exact-hidden-user-echo";
  const { transport } = await liveSession(sid);
  await add(sid, "exact-hidden-user", "/skill:demo do it");
  await until(() => transport.pendingMessages.length === 1, "correlated native prompt");
  const sent = transport.pendingMessages[0];
  // The browser never shows a hidden message, so it cannot replace the pending row there.
  transport.emitFor(sent, { type: "message_end", message: { role: "custom", customType: "skill-prompt", content: "hidden", display: false, attribution: "user" } });
  transport.answer(sent);
  await sleep(50);
  assert.equal(outbox.outboxEntries(sid)[0]?.state, "delivering", "a hidden message is no replacement");
  assert.deepEqual(outbox.outboxSettlements(sid).settledIds, []);
});

test("a real server agent-tool steer also invalidates an overlapping identical text-matched outbox echo", async () => {
  saveWebServerSettings({ agentToolsEnabled: true });
  const sid = "overlap-agent-target";
  const sourceId = "overlap-agent-source";
  const message = `[From session ${sourceId} via omp-web agent tools]: same`;
  const target = await liveSession(sid, { supportsClientMessageIds: false });
  const source = await liveSession(sourceId);
  await add(sid, "agent-overlap", message);
  await until(() => target.transport.pendingMessages.length === 1, "outbox native prompt");
  source.transport.emit({ type: "host_tool_call", id: "relay", toolName: "send_to_session", arguments: { sessionId: sid, message: "same", delivery: "steer" } });
  await until(() => target.transport.pendingMessages.length === 2, "agent-tool native steer");
  assert.equal(target.transport.pendingMessages[1].message, message);
  target.transport.emit({ type: "message_end", message: { role: "user", content: message } });
  target.transport.answer(target.transport.pendingMessages[1]);
  target.transport.answer(target.transport.pendingMessages[0]);
  await until(() => outbox.outboxEntries(sid)[0]?.state === "failed" || outbox.outboxEntries(sid).length === 0, "agent-tool overlap outcome");
  assert.equal(outbox.outboxEntries(sid)[0]?.state, "failed");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
});
test("a message pending before the baseline cannot donate its delayed identical echo", async () => {
  const sid = "prior-message-overlap";
  const { session, transport } = await liveSession(sid, { supportsClientMessageIds: false });
  const prior = session.send({ type: "prompt", message: "same" });
  await until(() => transport.pendingMessages.length === 1, "earlier native prompt");
  await add(sid, "prior-overlap", "same");
  await until(() => transport.pendingMessages.length === 2, "outbox native message");
  transport.emit({ type: "message_end", message: { role: "user", content: "same" } });
  transport.answer(transport.pendingMessages[1]);
  transport.answer(transport.pendingMessages[0]);
  await prior;
  await until(() => outbox.outboxEntries(sid)[0]?.state === "failed" || outbox.outboxEntries(sid).length === 0, "prior-message outcome");
  assert.equal(outbox.outboxEntries(sid)[0]?.state, "failed");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
});

test("a prompt omp ends before showing it settles at its prompt_result, and the next message goes to the same child", async () => {
  const run = [{ type: "agent_start" }, { type: "message_end", message: { role: "custom", customType: "hook", content: "injected" } }];
  const cases = [
    // Stop during setup: omp ran no turn (the production case: a hook's message persisted, the user's did not).
    { name: "setup-stop", frames: [], result: { agentInvoked: false, status: "completed" }, dropped: true, error: "Stopped before omp showed it" },
    { name: "aborted-run", frames: run, result: { agentInvoked: true, status: "aborted" }, dropped: true, error: "Stopped before omp showed it" },
    { name: "failed-run", frames: run, result: { agentInvoked: true, status: "error", error: { message: "quota exceeded" } }, dropped: true, error: "quota exceeded" },
    // An empty native error must not read as a successful hand-off.
    { name: "failed-run-empty-error", frames: run, result: { agentInvoked: true, status: "error", error: { message: "" } }, dropped: true, error: "Stopped before omp showed it" },
    { name: "resync-empty-error", frames: run, gap: true, result: { agentInvoked: true, status: "error", error: { message: "" } }, dropped: false, error: "omp finished this message without showing it" },
    // An input hook may have rewritten the text: the opened user message can be in the transcript.
    { name: "rewritten", frames: [...run, { type: "message_start", messageId: "u1", message: { role: "user", content: "rewritten" } }], result: { agentInvoked: true, status: "aborted" }, dropped: false },
    // The daemon dropped this child's backlog (`resync`): the lost frames may have held the echo.
    { name: "resync", frames: run, gap: true, result: { agentInvoked: true, status: "aborted" }, dropped: false },
    // A slash template's expanded message appeared, but its context check found nothing to confirm it.
    { name: "template-unconfirmed", message: "/tmpl go", frames: [...run, { type: "message_start", messageId: "u1", message: { role: "user", content: "expanded" } }, { type: "message_end", messageId: "u1", message: { role: "user", content: "expanded" } }], result: { agentInvoked: true, status: "completed" }, dropped: false, error: "omp finished this message without showing it" },
  ];
  for (const { name, message = "try again", frames, gap, result, dropped, error } of cases) {
    const sid = `ended-before-echo-${name}`;
    const { transport, transports } = await liveSession(sid);
    transport.settled = true;
    await add(sid, `${sid}-first`, message);
    await until(() => transport.pendingMessages.length === 1, "first native prompt");
    const first = transport.pendingMessages[0];
    transport.answer(first);
    await add(sid, `${sid}-second`, "Try again");
    for (const frame of frames) {
      if (name === "rewritten" && frame.type === "message_start") transport.emitFor(first, frame);
      else transport.emit(frame);
    }
    if (gap) transport.resync();
    if (frames.length) transport.emit({ type: "agent_end", isTerminal: true });
    transport.emit({ type: "prompt_result", id: `${first.id}-other`, ...result, sessionSettled: true });
    await sleep(50);
    assert.equal(outbox.outboxEntries(sid)[0].state, "delivering", `${name}: another command's result proves nothing`);
    transport.emit({ type: "prompt_result", id: first.id, ...result, sessionSettled: true });
    await until(() => outbox.outboxEntries(sid)[0]?.state === "failed", `${name}: settles without the fallback`);
    const entry = outbox.outboxEntries(sid)[0];
    assert.equal(entry.mayHaveBeenSent === true, !dropped, name);
    if (error) assert.equal(entry.error, error, name);
    if (!dropped) continue;
    await until(() => transport.pendingMessages.length === 2, `${name}: the next held message is dispatched`);
    assert.equal(transport.pendingMessages[1].message, "Try again");
    assert.equal(transports.length, 1, `${name}: a dropped message does not taint the child`);
  }
});

test("an already-acknowledged direct prompt cannot donate its delayed identical echo; settlement alone cannot erase uncertainty", async () => {
  const sid = "acked-before-baseline";
  const { session, transport } = await liveSession(sid, { supportsClientMessageIds: false });
  const prior = runAgentCommand(sid, { type: "prompt", message: "same" }, false, "another-client");
  await until(() => transport.pendingMessages.length === 1, "earlier native prompt");
  transport.answer(transport.pendingMessages[0]);
  assert.equal((await prior).status, 200, "the earlier native ACK predates the outbox baseline");
  await add(sid, "acked-prior-overlap", "same");
  await until(() => transport.pendingMessages.length === 2, "outbox native message after its transcript boundary");
  transport.emit({ type: "message_end", message: { role: "user", content: "same" } });
  transport.answer(transport.pendingMessages[1]);
  await until(() => outbox.outboxEntries(sid)[0]?.state === "failed" || outbox.outboxEntries(sid).length === 0, "acknowledged-prior outcome");
  assert.equal(outbox.outboxEntries(sid)[0]?.state, "failed");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
  assert.deepEqual(outbox.outboxSettlements(sid).settledIds, []);

  transport.emit({ type: "agent_end", isTerminal: true });
  assert.equal(session.hasPendingMessageCommands(), true, "agent_end alone is not a quiescent native boundary");
  transport.emit({ type: "session_settled" });
  await sleep(10);
  assert.equal(session.hasPendingMessageCommands(), true, "a settlement event without native isSettled support cannot lift the taint");
  await session.destroyAndWait();
  const fresh = await liveSession(sid);
  await add(sid, "after-native-replacement", "uncontended");
  await until(() => fresh.transport.pendingMessages.length === 1, "fresh child's native message");
  fresh.transport.emitFor(fresh.transport.pendingMessages[0], { type: "message_end", message: { role: "user", content: "uncontended" } });
  fresh.transport.answer(fresh.transport.pendingMessages[0]);
  await until(() => outbox.outboxSettlements(sid).settledIds.includes("after-native-replacement")
    || outbox.outboxEntries(sid).some((entry) => entry.id === "after-native-replacement" && entry.state === "failed"), "fresh child's uncontended handoff");
  assert.deepEqual(outbox.outboxEntries(sid).map((entry) => entry.id), ["acked-prior-overlap"]);
  assert.equal(fresh.session.hasPendingMessageCommands(), false, "a proven outbox replacement confirms its own admission");
});

test("uncontended real wrapper handoffs preserve native queue, skill, template and no-echo builtin semantics", async () => {
  for (const kind of ["queue", "skill", "template", "builtin"]) {
    const sid = `native-${kind}`;
    const { transport, host } = await liveSession(sid);
    const message = kind === "skill" ? "/skill:demo do it" : kind === "template" ? "/review inspect" : kind === "builtin" ? "/model" : "later";
    host.sessionOps.readContext = async (_id, _leaf, options) => ({ ok: true, value: options.boundary
      ? { entryIds: ["before"] }
      : { entryIds: ["before", "after"], messages: [{ role: "assistant", content: "before" }, { role: "user", content: "native template expansion" }] } });
    await add(sid, `native-${kind}`, message, kind === "queue" ? "followUp" : "prompt");
    await until(() => transport.pendingMessages.length === 1, `${kind} native write`);
    const sent = transport.pendingMessages[0];
    assert.equal(sent.message, message, "native input is not replaced by markers or server expansion");
    if (kind === "queue") transport.emitFor(sent, { type: "queue_update", steering: [], followUp: ["later"] });
    if (kind === "skill") transport.emitFor(sent, { type: "message_end", message: { role: "custom", customType: "skill-prompt", attribution: "user", details: { name: "demo", args: "do it", prompt: message }, content: "expanded native skill" } });
    if (kind === "template") {
      transport.emitFor(sent, { type: "message_start", messageId: "native-template", message: { role: "user", content: "native template expansion" } });
      transport.emitFor(sent, { type: "message_end", messageId: "native-template", message: { role: "user", content: "native template expansion" } });
    }
    transport.answer(sent, kind === "builtin" ? { agentInvoked: false } : {});
    await until(() => outbox.outboxEntries(sid).length === 0 || outbox.outboxEntries(sid)[0]?.state === "failed", `${kind} handoff`);
    assert.deepEqual(outbox.outboxEntries(sid), [], kind);
    assert.deepEqual(outbox.outboxSettlements(sid).settledIds, [`native-${kind}`]);
    const replay = await add(sid, `native-${kind}`, message, kind === "queue" ? "followUp" : "prompt");
    assert.equal((await replay.json()).data.entry.settlement, kind === "builtin" ? "none" : "native");
  }
});

test("uncontended outbox admissions preserve prompt-time followups, steers and unfenced Stop on one native child", async () => {
  const sid = "native-running-admissions";
  const { session, transport } = await liveSession(sid);
  await add(sid, "running-prompt", "start");
  await until(() => transport.pendingMessages.length === 1, "initial native prompt");
  transport.emit({ type: "agent_start" });
  transport.emitFor(transport.pendingMessages[0], { type: "message_end", message: { role: "user", content: "start" } });
  transport.answer(transport.pendingMessages[0]);
  await until(() => outbox.outboxEntries(sid).length === 0, "initial prompt handoff");
  assert.equal(session.isRunning(), true);
  for (const [mode, nativeType, key, text] of [["followUp", "follow_up", "followUp", "later"], ["steer", "steer", "steering", "steer now"]]) {
    await add(sid, `running-${mode}`, text, mode);
    await until(() => transport.pendingMessages.length === (mode === "followUp" ? 2 : 3), `${mode} native admission`);
    const sent = transport.pendingMessages.at(-1);
    assert.equal(sent.type, nativeType);
    transport.emitFor(sent, { type: "queue_update", ...transport.queue, [key]: [...transport.queue[key], text] });
    transport.answer(sent);
    await until(() => outbox.outboxEntries(sid).length === 0 || outbox.outboxEntries(sid)[0]?.state === "failed", `${mode} handoff`);
    assert.deepEqual(outbox.outboxEntries(sid), []);
    assert.equal(session.hasPendingMessageCommands(), false);
  }
  assert.equal((await runAgentCommand(sid, { type: "abort" }, false, "owner")).status, 200);
});

test("a direct first prompt's uncontended native replacement permits later ordinary outbox traffic", async () => {
  for (const kind of ["plain", "skill", "template", "builtin"]) {
    const sid = `direct-first-${kind}`;
    const { session, transport, host } = await liveSession(sid, { fresh: true });
    const message = kind === "plain" ? "first" : kind === "skill" ? "/skill:demo do it" : kind === "template" ? "/review inspect" : "/model";
    host.sessionOps.readContext = async (_id, _leaf, options) => ({ ok: true, value: options.boundary
      ? { entryIds: ["first-user"] }
      : { entryIds: ["first-user"], messages: [{ role: "user", content: "expanded first template" }] } });
    const direct = runAgentCommand(sid, { type: "prompt", message }, false, "owner");
    await until(() => transport.pendingMessages.length === 1, "direct first native write");
    transport.answer(transport.pendingMessages[0], kind === "builtin" ? { agentInvoked: false } : {});
    assert.equal((await direct).status, 200, "the direct ACK never waits for a replacement frame");
    if (kind !== "builtin") assert.equal(session.hasPendingMessageCommands(), true, "ACK alone does not confirm a prompt");
    if (kind === "plain") transport.emit({ type: "message_end", message: { role: "user", content: message } });
    if (kind === "skill") transport.emit({ type: "message_end", message: { role: "custom", customType: "skill-prompt", attribution: "user", details: { prompt: message, name: "demo", args: "do it" }, content: "expanded first skill" } });
    if (kind === "template") {
      transport.emit({ type: "message_start", messageId: "first-template", message: { role: "user", content: "expanded first template" } });
      transport.emit({ type: "message_end", messageId: "first-template", message: { role: "user", content: "expanded first template" } });
    }
    await until(() => !session.hasPendingMessageCommands(), "uncontended direct receipt proof");
    if (kind === "skill" || kind === "template") transport.emit({ type: "agent_start" });
    else transport.emit({ type: "agent_end", isTerminal: true });
    const mode = kind === "skill" || kind === "template" ? "followUp" : "prompt";
    await add(sid, `after-direct-${kind}`, "later", mode);
    await until(() => transport.pendingMessages.length === 2, "later outbox native write");
    assert.equal(transport.pendingMessages[1].type, mode === "followUp" ? "follow_up" : "prompt");
    if (mode === "followUp") transport.emitFor(transport.pendingMessages[1], { type: "queue_update", steering: [], followUp: ["later"] });
    else transport.emitFor(transport.pendingMessages[1], { type: "message_end", message: { role: "user", content: "later" } });
    transport.answer(transport.pendingMessages[1]);
    await until(() => outbox.outboxEntries(sid).length === 0 || outbox.outboxEntries(sid)[0]?.state === "failed", "later outbox handoff");
    assert.deepEqual(outbox.outboxEntries(sid), [], kind);
  }
});


test("startup recovery and pruning faults retry autonomously without duplicate hooks", { timeout: 15_000 }, async () => {
  const sid = uuid(2);
  await add(sid, "startup-retry");
  await until(() => outbox.outboxEntries(sid)[0]?.state === "waiting_host", "initial waiting state");
  const database = globalThis.__ompOutboxStore.db;
  database.prepare("UPDATE entries SET state = 'delivering', dispatch_pid = ? WHERE id = 'startup-retry'").run(process.pid);
  database.exec("PRAGMA query_only = ON");
  const exitHooks = process.listenerCount("exit");
  const frameHooks = globalThis.__ompFrameTaps?.size ?? 0;
  assert.doesNotThrow(() => outbox.startOutbox());
  assert.equal(globalThis.__ompOutbox.started, false);
  assert.equal(process.listenerCount("exit"), exitHooks);
  assert.equal(globalThis.__ompFrameTaps?.size ?? 0, frameHooks);
  database.exec("PRAGMA query_only = OFF");
  await sleep(outbox.RETRY_MS + 100);
  await until(() => globalThis.__ompOutbox.started, "autonomous recovery startup");
  assert.equal(outbox.outboxEntries(sid)[0].state, "failed");
  assert.equal(outbox.outboxEntries(sid)[0].mayHaveBeenSent, true);
  const maintenance = globalThis.__ompOutbox.maintenance;
  outbox.startOutbox();
  outbox.startOutbox();
  assert.equal(globalThis.__ompOutbox.maintenance, maintenance);
  assert.equal(process.listenerCount("exit"), exitHooks + 1);
  assert.equal(globalThis.__ompFrameTaps.size, frameHooks + 1);
  outbox.closeOutboxStore();
  assert.equal(process.listenerCount("exit"), exitHooks);
  assert.equal(globalThis.__ompFrameTaps.size, frameHooks);

  // This open succeeds, but its pruning write fails before any hook can be installed.
  outbox.outboxEntries(sid);
  globalThis.__ompOutboxStore.db.exec("PRAGMA query_only = ON");
  assert.doesNotThrow(() => outbox.startOutbox());
  assert.equal(globalThis.__ompOutbox.started, false);
  globalThis.__ompOutboxStore.db.exec("PRAGMA query_only = OFF");
  await sleep(outbox.RETRY_MS + 100);
  await until(() => globalThis.__ompOutbox.started, "autonomous pruning retry");
  assert.equal(process.listenerCount("exit"), exitHooks + 1);
  assert.equal(globalThis.__ompFrameTaps.size, frameHooks + 1);
});

test("a startup retry keeps this process's live delivery claim, so its acknowledged echo still retires it", { timeout: 15_000 }, async () => {
  const sid = uuid(3);
  const { transport } = await liveSession(sid);
  outbox.outboxEntries(sid);
  const database = globalThis.__ompOutboxStore.db;
  database.exec("PRAGMA query_only = ON");
  outbox.startOutbox();
  assert.equal(globalThis.__ompOutbox.started, false);
  database.exec("PRAGMA query_only = OFF");
  // Storage is back before the retry: an add dispatches at once.
  assert.equal((await add(sid, "live-claim", "start")).status, 200);
  await until(() => transport.pendingMessages.length === 1, "native prompt before the startup retry");
  await sleep(outbox.RETRY_MS + 100);
  await until(() => globalThis.__ompOutbox.started, "startup retry");
  assert.equal(outbox.outboxEntries(sid)[0]?.state, "delivering", "the retry must not fail this process's in-flight claim");
  transport.emit({ type: "agent_start" });
  transport.emitFor(transport.pendingMessages[0], { type: "message_end", message: { role: "user", content: "start" } });
  transport.answer(transport.pendingMessages[0]);
  await until(() => outbox.outboxEntries(sid).length === 0, "acknowledged and echoed handoff");
  assert.ok(outbox.outboxSettlements(sid).settledIds.includes("live-claim"));
});

test("a connection migrated by previous hot-reloaded code is reopened with the current schema", async () => {
  const sid = uuid(60);
  outbox.outboxEntries(sid);
  const previous = globalThis.__ompOutboxStore;
  // The code before this reload had no change log; its connection is still cached.
  previous.db.exec("DROP TRIGGER outbox_insert_change; DROP TRIGGER outbox_update_change; DROP TRIGGER outbox_delete_change; DROP TABLE session_changes");
  previous.schema = "previous code";
  const response = await add(sid, "after-reload");
  assert.equal(response.status, 200, await response.clone().text());
  assert.notEqual(globalThis.__ompOutboxStore.db, previous.db, "the stale connection is replaced");
  assert.ok(globalThis.__ompOutboxStore.db.prepare("SELECT revision FROM session_changes WHERE session_id = ?").get(sid), "the change log is installed again");
});

test("the peer observer keeps working after a hot reload replaces the store connection", { timeout: 10_000 }, async () => {
  const sid = uuid(61);
  await add(sid, "peer-after-reopen");
  await until(() => outbox.outboxEntries(sid)[0]?.state === "waiting_host", "held before reload");
  outbox.startOutbox();
  assert.equal(globalThis.__ompOutbox.started, true);
  const view = await channel(sid);
  // New code after a reload: the next db() call replaces (and finalizes) the connection the observer started on.
  const previous = globalThis.__ompOutboxStore;
  previous.schema = "previous code";
  outbox.outboxEntries(sid);
  assert.notEqual(globalThis.__ompOutboxStore.db, previous.db);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    peer.prepare("UPDATE entries SET state = 'delivered', done_at = ? WHERE id = ?").run(Date.now(), "peer-after-reopen");
    await until(() => view.frames.some((frame) => frame.type === "outbox_update"
      && frame.entries.length === 0 && frame.settledIds.includes("peer-after-reopen")), "peer delivery seen through the new connection");
  } finally {
    peer.close(true);
    view.close();
  }
});

test("a replaced store connection whose data_version equals the old one still reports a peer change made between them", { timeout: 10_000 }, async () => {
  const sid = uuid(62);
  await add(sid, "peer-before-reopen");
  await until(() => outbox.outboxEntries(sid)[0]?.state === "waiting_host", "held before reload");
  outbox.startOutbox();
  const view = await channel(sid);
  await sleep(600); // the observer ticks at 250ms: it has read the old connection's baseline
  const previous = globalThis.__ompOutboxStore;
  const baseline = previous.db.query("PRAGMA data_version").get().data_version;
  const peer = new Database(previous.path);
  try {
    // The peer commits after the observer's last read and before the new code replaces the connection.
    peer.prepare("UPDATE entries SET state = 'delivered', done_at = ? WHERE id = ?").run(Date.now(), "peer-before-reopen");
    previous.schema = "previous code";
    view.frames.length = 0;
    outbox.outboxEntries(sid);
    assert.notEqual(globalThis.__ompOutboxStore.db, previous.db);
    assert.equal(globalThis.__ompOutboxStore.db.query("PRAGMA data_version").get().data_version, baseline,
      "per-connection counters coincide, so the version alone cannot reveal the peer change");
    await until(() => view.frames.some((frame) => frame.type === "outbox_update"
      && frame.entries.length === 0 && frame.settledIds.includes("peer-before-reopen")), "peer delivery seen despite the equal data_version");
  } finally {
    peer.close(true);
    view.close();
  }
});

test("closing a failed startup cancels retry instead of recreating a removed agent directory", { timeout: 8_000 }, async () => {
  const blocked = join(root, "not-a-directory");
  writeFileSync(blocked, "blocked");
  process.env.PI_CODING_AGENT_DIR = join(blocked, "agent");
  assert.doesNotThrow(() => outbox.startOutbox());
  outbox.closeOutboxStore();
  rmSync(blocked);
  await sleep(outbox.RETRY_MS + 100);
  assert.equal(existsSync(blocked), false);
});

test("starting the peer observer after a startup failure resyncs already-subscribed chats", { timeout: 10_000 }, async () => {
  const sid = uuid(40);
  await add(sid, "peer-during-startup");
  await until(() => outbox.outboxEntries(sid)[0]?.state === "waiting_host", "held before startup");
  const database = globalThis.__ompOutboxStore.db;
  database.exec("PRAGMA query_only = ON");
  outbox.startOutbox();
  assert.equal(globalThis.__ompOutbox.started, false);
  const view = await channel(sid);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    assert.equal(view.frames.at(-1).entries[0].id, "peer-during-startup");
    peer.prepare("UPDATE entries SET state = 'delivered', done_at = ? WHERE id = ?").run(Date.now(), "peer-during-startup");
    database.exec("PRAGMA query_only = OFF");
    outbox.startOutbox();
    await until(() => view.frames.some((frame) => frame.type === "outbox_update"
      && frame.entries.length === 0 && frame.settledIds.includes("peer-during-startup")), "startup resync retires the peer delivery");
  } finally {
    database.exec("PRAGMA query_only = OFF");
    peer.close(true);
    view.close();
  }
});

test("one failed peer notification cannot block other chats and retries without republishing healthy snapshots", { timeout: 15_000 }, async () => {
  const first = uuid(41), second = uuid(42);
  await add(first, "peer-first");
  await add(second, "peer-second");
  await until(() => [first, second].every((sid) => outbox.outboxEntries(sid)[0]?.state === "waiting_host"), "held messages");
  outbox.startOutbox();
  let fail = false;
  let firstEntries;
  const detach = outbox.onOutboxChange(first, (entries) => {
    if (fail) throw new Error("Transient snapshot failure");
    firstEntries = entries;
  });
  const view = await channel(second);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    peer.exec("UPDATE entries SET state = 'failed', error = 'peer refusal'");
    await until(() => firstEntries?.[0]?.state === "failed"
      && view.frames.some((frame) => frame.entries?.[0]?.state === "failed"), "first peer snapshot");
    fail = true;
    peer.prepare("UPDATE entries SET state = 'delivered', done_at = ?").run(Date.now());
    await until(() => view.frames.some((frame) => frame.type === "outbox_update"
      && frame.entries.length === 0 && frame.settledIds.includes("peer-second")), "later chat still receives delivery");
    fail = false;
    await sleep(outbox.RETRY_MS);
    await until(() => firstEntries?.length === 0, "failed chat retries without another database change");
    assert.equal(view.frames.filter((frame) => frame.type === "outbox_update"
      && frame.entries.length === 0 && frame.settledIds.includes("peer-second")).length, 1, "a failing peer cannot amplify healthy chat traffic");
  } finally {
    detach();
    peer.close(true);
    view.close();
  }
});

test("an old-ID chat receives the tombstone of a message moved and delivered by a peer", { timeout: 10_000 }, async () => {
  const sid = uuid(43), target = uuid(44);
  await add(sid, "peer-moved");
  await until(() => outbox.outboxEntries(sid)[0]?.state === "waiting_host", "held before peer move");
  outbox.startOutbox();
  const view = await channel(sid);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    peer.prepare("UPDATE entries SET session_id = ?, state = 'delivered', done_at = ? WHERE id = ?").run(target, Date.now(), "peer-moved");
    await until(() => view.frames.some((frame) => frame.type === "outbox_update"
      && frame.entries.length === 0 && frame.settledIds.includes("peer-moved")), "source identity receives peer tombstone without local aliases");
  } finally {
    peer.close(true);
    view.close();
  }
});

test("moved-source tombstones cannot displace the original session's delivery confirmations", async () => {
  const sid = uuid(45), target = uuid(46);
  outbox.outboxEntries(sid);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    const insert = peer.prepare("INSERT INTO entries (id, session_id, source_session_id, mode, message, owner, advisor, state, created_at, done_at) VALUES (?, ?, ?, 'prompt', '', 'owner', 0, 'delivered', ?, ?)");
    const now = Date.now();
    peer.transaction(() => {
      insert.run("original-session-delivery", sid, sid, now - 1000, now - 1000);
      for (let n = 0; n < 257; n++) insert.run(`moved-source-${n}`, target, sid, now + n, now + n);
    })();
    const settled = outbox.outboxSettlements(sid).settledIds;
    assert.ok(settled.includes("original-session-delivery"), "newer moved-source history cannot evict an original-session receipt");
    assert.ok(settled.includes("moved-source-256"), "the submitting identity still covers recent moved receipts");
    assert.equal(settled.includes("moved-source-0"), false, "moved receipts retain their own bounded recent window");
  } finally {
    peer.close(true);
  }
});

test("peer-moved unresolved messages remain visible and deletable through either session identity", { timeout: 10_000 }, async () => {
  const sid = uuid(47), target = uuid(48);
  await add(sid, "peer-uncertain", "uncertain message");
  await add(sid, "peer-waiting", "waiting message");
  await until(() => outbox.outboxEntries(sid).every((entry) => entry.state === "waiting_host"), "held before peer move");
  outbox.startOutbox();
  const view = await channel(sid);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    const before = view.frames.length;
    peer.transaction(() => {
      peer.prepare("UPDATE entries SET session_id = ?").run(target);
      peer.exec("UPDATE entries SET state = 'failed', may_have_been_sent = 1, error = 'Uncertain delivery' WHERE id = 'peer-uncertain'");
    })();
    await until(() => view.frames.length > before && view.frames.at(-1).entries?.length === 2
      && view.frames.at(-1).entries[0].mayHaveBeenSent === true, "source chat retains unresolved peer-moved messages");
    assert.deepEqual(view.frames.at(-1).entries.map(({ id, sessionId, state, error }) => ({ id, sessionId, state, error })), [
      { id: "peer-uncertain", sessionId: sid, state: "failed", error: "Uncertain delivery" },
      { id: "peer-waiting", sessionId: sid, state: "waiting_host", error: undefined },
    ]);
    const canonicalDelete = await outbox.runOutboxCommand(target, { type: "outbox_remove", id: "peer-uncertain" }, false, "owner");
    assert.equal((await canonicalDelete.json()).data.removed, true);
    await until(() => view.frames.at(-1).entries?.length === 1
      && view.frames.at(-1).entries[0].id === "peer-waiting", "canonical removal updates the source subscription too");
    const sourceDelete = await outbox.runOutboxCommand(sid, { type: "outbox_remove", id: "peer-waiting" }, false, "owner");
    assert.equal((await sourceDelete.json()).data.removed, true, "the original chat keeps a working Delete action");
    assert.deepEqual(view.frames.at(-1).entries, []);
    assert.deepEqual(new Set(view.frames.at(-1).settledIds), new Set(["peer-uncertain", "peer-waiting"]));
  } finally {
    peer.close(true);
    view.close();
  }
});

test("a moved unresolved row still consumes the original session's outbox budget", async () => {
  const sid = uuid(49), target = uuid(50);
  await add(sid, "peer-budget", "retained message");
  await until(() => outbox.outboxEntries(sid)[0]?.state === "waiting_host", "held before peer move");
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    peer.prepare("UPDATE entries SET session_id = ?, state = 'failed', payload_bytes = ? WHERE id = ?")
      .run(target, outbox.MAX_OUTBOX_BYTES - 64 * 1024, "peer-budget");
    const response = await add(sid, "would-exceed-source-budget", "new message");
    assert.equal(response.status, 429, "source snapshots must remain inside the existing per-session payload budget");
    assert.equal((await response.json()).code, "outbox_full");
  } finally {
    peer.close(true);
  }
});

test("an intermediate native identity retains a peer-moved uncertain row and can delete it without registry aliases", { timeout: 10_000 }, async () => {
  const source = uuid(51), intermediate = uuid(52), canonical = uuid(53);
  await add(source, "peer-intermediate", "retained through two moves");
  await until(() => outbox.outboxEntries(source)[0]?.state === "waiting_host", "held before native moves");
  outbox.startOutbox();
  const peer = new Database(globalThis.__ompOutboxStore.path);
  let view;
  try {
    peer.prepare("UPDATE entries SET session_id = ? WHERE id = ?").run(intermediate, "peer-intermediate");
    view = await channel(intermediate);
    assert.equal(view.frames.at(-1).entries[0].id, "peer-intermediate", "subscribe while the intermediate identity owns the row");
    const before = view.frames.length;
    peer.prepare("UPDATE entries SET session_id = ?, state = 'failed', may_have_been_sent = 1, error = 'Uncertain delivery' WHERE id = ?")
      .run(canonical, "peer-intermediate");
    await until(() => view.frames.slice(before).some((frame) => frame.type === "outbox_update"
      && frame.entries?.[0]?.id === "peer-intermediate" && frame.entries[0].mayHaveBeenSent === true), "intermediate chat retains the uncertain row");
    assert.deepEqual(view.frames.at(-1).entries.map(({ id, sessionId, state, error }) => ({ id, sessionId, state, error })), [
      { id: "peer-intermediate", sessionId: intermediate, state: "failed", error: "Uncertain delivery" },
    ]);
    const removed = await outbox.runOutboxCommand(intermediate, { type: "outbox_remove", id: "peer-intermediate" }, false, "owner");
    assert.equal((await removed.json()).data.removed, true, "Delete uses the durable intermediate identity");
    await until(() => view.frames.at(-1).entries?.length === 0
      && view.frames.at(-1).settledIds?.includes("peer-intermediate"), "intermediate chat receives the removal receipt");
    assert.deepEqual(outbox.outboxEntries(canonical), []);
  } finally {
    peer.close(true);
    view?.close();
  }
});

test("a throwing local source observer cannot stop the next held prompt reaching the moved native session", { timeout: 10_000 }, async () => {
  const source = "throwing-source-old", canonical = "throwing-source-new";
  const { session, transport, host } = await liveSession(source);
  host.status = () => "offline";
  outbox.startOutbox();
  await add(source, "throwing-first", "first held prompt");
  await add(source, "throwing-second", "second held prompt");
  await until(() => outbox.outboxEntries(source).length === 2
    && outbox.outboxEntries(source).every((entry) => entry.state === "waiting_host"), "both prompts held before move");
  host.status = () => "online"; // Reachable without a hello/pump before the identity notice.
  transport.sessionId = canonical;
  transport.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
  await until(() => session.sessionId === canonical, "native move confirmed");
  outbox.pumpOutbox(canonical);
  await until(() => transport.pendingMessages.length === 1, "first moved native dispatch");
  let healthyEntries;
  const detachThrowing = outbox.onOutboxChange(source, () => { throw new Error("Local source observer failed"); });
  const detachHealthy = outbox.onOutboxChange(source, (entries) => { healthyEntries = entries; });
  const view = await channel(canonical);
  try {
    transport.emitFor(transport.pendingMessages[0], { type: "message_end", message: { role: "user", content: "first held prompt" } });
    transport.answer(transport.pendingMessages[0]);
    await until(() => transport.pendingMessages.length === 2, "second held prompt reaches native transport despite source observer failure");
    assert.deepEqual(transport.pendingMessages.map(({ message }) => message), ["first held prompt", "second held prompt"]);
    await until(() => healthyEntries?.length === 1 && healthyEntries[0].id === "throwing-second"
      && healthyEntries[0].state === "delivering", "healthy source observer receives the current delivery");
    await until(() => view.frames.some((frame) => frame.type === "outbox_update"
      && frame.entries?.length === 1 && frame.entries[0].id === "throwing-second"
      && frame.entries[0].state === "delivering" && frame.settledIds.includes("throwing-first")), "canonical observer receives the next delivery and first receipt");
    transport.emitFor(transport.pendingMessages[1], { type: "message_end", message: { role: "user", content: "second held prompt" } });
    transport.answer(transport.pendingMessages[1]);
    await until(() => outbox.outboxSettlements(canonical).settledIds.includes("throwing-second"), "second native echo settles");
  } finally {
    detachThrowing();
    detachHealthy();
    view.close();
  }
});

test("a moved row consumes the budget of every local registry alias of its source", async () => {
  const source = "registry-budget-source", alias = "registry-budget-alias", canonical = "registry-budget-canonical";
  const { session, host } = await liveSession(source);
  host.status = () => "offline";
  await add(source, "registry-budget-row", "retained source message");
  await until(() => outbox.outboxEntries(source)[0]?.state === "waiting_host", "source row held");
  globalThis.__ompSessions.set(alias, session);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  try {
    peer.prepare("UPDATE entries SET session_id = ?, state = 'failed', payload_bytes = ? WHERE id = ?")
      .run(canonical, outbox.MAX_OUTBOX_BYTES - 64 * 1024, "registry-budget-row");
    const response = await add(alias, "registry-budget-overflow", "new alias message");
    assert.equal(response.status, 429, "the source alias group must include moved rows in its byte budget");
    assert.equal((await response.json()).code, "outbox_full");
    assert.equal(peer.prepare("SELECT COUNT(*) AS count FROM entries WHERE id = ?").get("registry-budget-overflow").count, 0, "quota refusal stores no new payload");
  } finally {
    globalThis.__ompSessions.delete(alias);
    peer.close(true);
  }
});

test("peer commits publish only changed session outbox snapshots, not unrelated upload changes", { timeout: 10_000 }, async () => {
  const first = uuid(54), second = uuid(55);
  await add(first, "revision-first");
  await add(second, "revision-second");
  await until(() => [first, second].every((sid) => outbox.outboxEntries(sid)[0]?.state === "waiting_host"), "both sessions have stored entries");
  outbox.startOutbox();
  const firstView = await channel(first), secondView = await channel(second);
  const peer = new Database(globalThis.__ompOutboxStore.path);
  const snapshots = (view) => view.frames.filter((frame) => frame.type === "outbox_update").length;
  try {
    await sleep(600); // Allow the initial peer poll to establish both subscriptions' revisions.
    const secondBefore = snapshots(secondView);
    peer.prepare("UPDATE entries SET state = 'failed', error = ? WHERE id = ?").run("Only first changed", "revision-first");
    await until(() => firstView.frames.some((frame) => frame.type === "outbox_update"
      && frame.entries?.[0]?.error === "Only first changed"), "first session receives its actual peer change");
    await sleep(600);
    assert.equal(snapshots(secondView), secondBefore, "changing A cannot republish B's full outbox payload");
    const firstBeforeUpload = snapshots(firstView), secondBeforeUpload = snapshots(secondView);
    peer.prepare("INSERT INTO completed_uploads (id, owner, receipt, at) VALUES (?, ?, ?, ?)")
      .run(uuid(56), "owner", JSON.stringify({ id: uuid(56), hostId: "upload-only", name: "file.bin", size: 1, type: "", attached: null }), Date.now());
    await sleep(600); // Absence of frames requires observing more than one 250 ms peer poll.
    assert.equal(snapshots(firstView), firstBeforeUpload, "an upload-only commit cannot republish A's unchanged full payload");
    assert.equal(snapshots(secondView), secondBeforeUpload, "an upload-only commit cannot republish B's unchanged full payload");
  } finally {
    peer.close(true);
    firstView.close();
    secondView.close();
  }
});

async function parallelAdds(workers, perWorker, bytes) {
  const moduleUrl = new URL("./message-outbox.ts", import.meta.url).href;
  return Promise.all(Array.from({ length: workers }, async (_, worker) => {
    const script = `
      const o = await import(${JSON.stringify(moduleUrl)});
      const scope = o.outboxScope();
      const statuses = [];
      for (let n = 0; n < ${perWorker}; n++) {
        const number = ${worker} * ${perWorker} + n;
        const sid = '11111111-2222-4333-8444-' + number.toString(16).padStart(12, '0');
        const response = await o.runOutboxCommand(sid, {type:'outbox_add', scope, id:'quota-'+number, mode:'prompt', message:'x'.repeat(${bytes})}, false, 'owner');
        const body = await response.json();
        statuses.push([response.status, body.code]);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      o.closeOutboxStore();
      console.log(JSON.stringify(statuses));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(exitCode, 0, stderr);
    return JSON.parse(stdout);
  })).then((results) => results.flat());
}

test("concurrent processes share the 1000-row active pool across arbitrary UUIDs and known ids still receipt", { timeout: 30_000 }, async () => {
  outbox.outboxEntries(uuid(0)); // initialize the shared real SQLite store before parallel writers
  outbox.outboxScope();
  const results = await parallelAdds(6, 180, 1);
  assert.equal(results.filter(([status]) => status === 200).length, 1000);
  assert.equal(results.filter(([status, code]) => status === 429 && code === "outbox_full").length, 80);
  const database = globalThis.__ompOutboxStore.db;
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries WHERE state != 'delivered'").get().count, 1000);
  const known = database.prepare("SELECT id, session_id FROM entries LIMIT 1").get();
  assert.equal((await add(known.session_id, known.id, "different replay")).status, 200);
  assert.equal((await outbox.runOutboxCommand(known.session_id, { type: "outbox_remove", id: known.id }, false, "owner")).status, 200);
  assert.equal((await add(uuid(5000), "freed-row")).status, 200);
  const tombstone = await add(known.session_id, known.id);
  assert.equal(tombstone.status, 200);
  assert.equal((await tombstone.json()).data.entry.state, "delivered");
});

test("concurrent processes share the 256 MiB byte pool even below the row cap", { timeout: 60_000 }, async () => {
  outbox.outboxEntries(uuid(0));
  outbox.outboxScope();
  const message = "x".repeat(4 * 1024 * 1024);
  for (let n = 0; n < 62; n++) assert.equal((await add(uuid(10000 + n), `byte-seed-${n}`, message)).status, 200);
  // Compete for the last fitting payload, rather than measuring sustained SQLite writer throughput.
  const results = await parallelAdds(4, 1, 4 * 1024 * 1024);
  assert.equal(results.filter(([status]) => status === 200).length, 1);
  assert.equal(results.filter(([status, code]) => status === 429 && code === "outbox_full").length, 3);
  const database = globalThis.__ompOutboxStore.db;
  const total = database.prepare("SELECT SUM(payload_bytes) AS bytes, COUNT(*) AS count FROM entries WHERE state != 'delivered'").get();
  assert.equal(total.count, 63);
  assert.ok(total.bytes <= 256 * 1024 * 1024);
  const known = database.prepare("SELECT id, session_id FROM entries LIMIT 1").get();
  assert.equal((await add(known.session_id, known.id)).status, 200);
});

test("upload continuity: concurrent store upgrades preserve one completion proof", async () => {
  const { Database } = await import("bun:sqlite");
  const { mkdirSync } = await import("node:fs");
  const dir = join(process.env.PI_CODING_AGENT_DIR, "omp-web");
  const barrier = join(process.env.PI_CODING_AGENT_DIR, "upgrade-readers");
  mkdirSync(dir, { recursive: true });
  mkdirSync(barrier);
  const old = new Database(join(dir, "outbox.db"));
  old.exec("CREATE TABLE completed_uploads (id TEXT PRIMARY KEY, owner TEXT NOT NULL, receipt TEXT NOT NULL, at INTEGER NOT NULL)");
  old.close(true);
  outbox.outboxScope();
  const results = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
    const script = `
      import { Database } from "bun:sqlite";
      import { readdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const prepare = Database.prototype.prepare;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      Database.prototype.prepare = function (sql, ...args) {
        const statement = prepare.call(this, sql, ...args);
        if (sql === "PRAGMA table_info(completed_uploads)") {
          const all = statement.all.bind(statement);
          const database = this;
          statement.all = (...args) => {
            const rows = all(...args);
            // Widen the real read/ALTER race only when no write transaction protects the schema snapshot.
            if (!database.inTransaction) {
              writeFileSync(join(${JSON.stringify(barrier)}, ${JSON.stringify(String(index))}), "");
              const deadline = Date.now() + 10000;
              while (readdirSync(${JSON.stringify(barrier)}).length < 4 && Date.now() < deadline) Atomics.wait(pause, 0, 0, 10);
            }
            return rows;
          };
        }
        return statement;
      };
      const store = await import(${JSON.stringify(new URL("./message-outbox.ts", import.meta.url).href)});
      try {
        const proof = store.saveCompletedUpload("original-owner", { id: "11111111-2222-4333-8444-555555555555", hostId: "host", name: "file.bin", size: 1, type: "", attached: null });
        process.stdout.write(JSON.stringify({ proof }));
      } finally { store.closeOutboxStore(); }
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  }));
  for (const result of results) assert.equal(result.exitCode, 0, result.stderr);
  const proofs = results.map(({ stdout }) => JSON.parse(stdout).proof);
  assert.equal(new Set(proofs).size, 1, "every successful opener must return the same durable authority");
  assert.match(proofs[0], /^[A-Za-z0-9_-]{43}$/);
});

test("upload continuity: stale receipt retirement cannot revoke a newer completion proof", async () => {
  const { snapshotOutboxUploads } = await import("./uploads.ts");
  const id = crypto.randomUUID();
  const receipt = { id, hostId: "proof-host", name: "file.bin", size: 1, type: "", attached: null };
  const oldProof = outbox.saveCompletedUpload("old-owner", receipt);
  const oldReceipt = outbox.completedUpload(id);
  outbox.forgetCompletedUpload(id);
  const newProof = outbox.saveCompletedUpload("new-owner", receipt);
  outbox.forgetCompletedUpload(id, oldReceipt);
  const authorized = snapshotOutboxUploads([id], "renewed-cookie", { [id]: newProof });
  assert.equal(authorized[0].owner, "new-owner", "retiring old authority must leave the new grant usable");
  assert.throws(() => snapshotOutboxUploads([id], "renewed-cookie", { [id]: oldProof }), (error) => error.code === "upload_missing");
});

test("closing one web wrapper preserves another live server's native delivery claim", async () => {
  const sid = "foreign-live-delivery";
  const { session, transport } = await liveSession(sid);
  outbox.outboxEntries(sid);
  const database = globalThis.__ompOutboxStore.db;
  database.prepare(`INSERT INTO entries
    (id, session_id, source_session_id, mode, message, owner, advisor, state, created_at, dispatch_pid)
    VALUES (?, ?, ?, 'prompt', 'peer is delivering', 'owner', 0, 'delivering', ?, ?)`)
    .run("foreign-claim", sid, sid, Date.now(), process.ppid);
  outbox.startOutbox();
  assert.equal(outbox.outboxEntries(sid)[0].state, "delivering");
  transport.exit(0, null);
  await until(() => !session.isAlive(), "local wrapper closed");
  const entry = outbox.outboxEntries(sid).find(entry => entry.id === "foreign-claim");
  assert.equal(entry.state, "delivering", "only the dispatch owner may settle its in-flight command");
  assert.equal(entry.error, undefined);
});

test("a handoff status read reaches the live child through the real wrapper and returns its reply", async () => {
  const sid = "handoff-status-passthrough";
  const { session, transport } = await liveSession(sid);
  const reply = {
    messages: [{ clientMessageId: "seen", message: { role: "user", content: "typed text" } }],
    queuedMessages: { steering: [], followUp: ["queued text"], clientMessageIds: { steering: [], followUp: ["queued"] } },
    resolvedClientMessageIds: [], persistedClientMessageIds: [], unresolvedClientMessageIds: ["missing"],
  };
  transport.replies.get_client_message_status = reply;
  const writes = transport.commands.length;
  const response = await runAgentCommand(sid, { type: "get_client_message_status", clientMessageIds: ["seen", "queued", "missing"] }, false, "owner");
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const sent = transport.commands.slice(writes);
  assert.deepEqual(sent.map((command) => [command.type, command.clientMessageIds]),
    [["get_client_message_status", ["seen", "queued", "missing"]]], "the read is forwarded verbatim, once");
  const { data } = await response.json();
  assert.deepEqual(data.messages, reply.messages);
  assert.deepEqual(data.queuedMessages.clientMessageIds, reply.queuedMessages.clientMessageIds);
  assert.deepEqual(data.unresolvedClientMessageIds, ["missing"], "native's own unresolved list passes through");
  assert.equal(session.hasPendingMessageCommands(), false, "a status read is no message command");
  assert.equal(session.getMessageCommandGeneration(), 0);
});

test("an entry and its receipt are read in one snapshot, so a peer retiring the row between them cannot split them", async () => {
  const sid = uuid(63);
  await add(sid, "snapshot-row");
  const peer = new Database(globalThis.__ompOutboxStore.path);
  const original = globalThis.__ompSessions;
  const registry = new Map();
  let lookups = 0;
  // Each read looks the session up in the registry before its query: the peer's commit lands after the first read
  // began and before the second one runs.
  registry.get = (key) => {
    if (++lookups > 2) peer.prepare("UPDATE entries SET state = 'delivered', message = '', done_at = ?, settlement = 'native' WHERE id = ? AND state != 'delivered'").run(Date.now(), "snapshot-row");
    return Map.prototype.get.call(registry, key);
  };
  globalThis.__ompSessions = registry;
  try {
    const snapshot = outbox.outboxSnapshot(sid);
    assert.deepEqual(snapshot.entries.map((entry) => entry.id), ["snapshot-row"], "the row is pending in this snapshot");
    assert.deepEqual(snapshot.settledIds, [], "so its peer-made receipt is not part of it");
    assert.ok(lookups > 2, "the peer retired the row between the two reads");
    const next = outbox.outboxSnapshot(sid);
    assert.deepEqual([next.entries, next.settledIds, next.nativeSettledIds], [[], ["snapshot-row"], ["snapshot-row"]], "the next snapshot has the receipt instead");
  } finally {
    globalThis.__ompSessions = original;
    peer.close(true);
  }
});
