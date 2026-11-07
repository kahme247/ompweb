import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

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
async function liveSession(sessionId, { fresh = false } = {}) {
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
      queue: { steering: [], followUp: [] },
      emit(event) {
        if (event.type === "agent_start") transport.streaming = true;
        else if (event.type === "agent_end" && event.isTerminal !== false) transport.streaming = false;
        else if (event.type === "queue_update") transport.queue = { steering: event.steering, followUp: event.followUp };
        transport.line(JSON.stringify(event));
      },
      answer(command, data = {}) { transport.emit({ type: "response", id: command.id, command: command.type, success: true, data }); },
      write(line, callback) {
        const command = JSON.parse(line);
        transport.commands.push(command);
        if (["prompt", "follow_up", "steer", "abort_and_prompt"].includes(command.type)) transport.pendingMessages.push(command);
        else queueMicrotask(() => transport.answer(command, command.type === "get_state" ? {
          sessionId: transport.sessionId, sessionFile: `/nonexistent/${transport.sessionId}.jsonl`, isStreaming: transport.streaming, isCompacting: false,
          sessionName: "Review fixture",
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
    };
    transports.push(transport);
    return transport;
  };
  const host = {
    id: "review-fixture-host", label: "Review fixture", status: () => "online", onStatus: () => () => {},
    spawnRpc: async (request) => ({ transport: createTransport(), cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => !fresh, invalidateSessionLists() {}, autoApproveExtension: () => false,
    sessionOps: { readContext: async () => ({ ok: true, value: { entryIds: ["before"] } }) },
  };
  const { session } = await startRpcSession(sessionId, fresh ? "" : `/nonexistent/${sessionId}.jsonl`, root, undefined, false, null, undefined, host);
  wrappers.push(session);
  return { session, transport: transports[0], host, transports };
}

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

async function ambiguousSession(sid) {
  const fixture = await liveSession(sid);
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
  transport.emit({ type: "queue_update", steering: [], followUp: ["later"] });
  await until(() => outbox.outboxSettledIds(sid).includes("browser-held"), "native queue handoff");
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
        transport.emit({ type: "queue_update", steering: [], followUp: [], [key]: [text] });
        await until(() => outbox.outboxSettledIds(sid).includes(id) || outbox.outboxEntries(sid)[0]?.state === "failed", "persisted handoff outcome");
        assert.deepEqual(outbox.outboxEntries(sid), [], `${mode}/${failure} retires only the genuinely queued held row`);
        assert.ok(outbox.outboxSettledIds(sid).includes(id));
        assert.deepEqual((await session.send({ type: "get_state" })).queuedMessages, { steering: [], followUp: [], [key]: [text] });
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
      assert.equal(outbox.outboxSettledIds(sid).includes(sid), false);
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
  assert.deepEqual(outbox.outboxEntries(oldId), []);
  const replay = await (await add(oldId, "move-held", "held for host", "followUp")).json();
  assert.equal(replay.data.entry.sessionId, newId, "the original source-ID replay finds its canonical receipt after restart");
});

test("a later idle message renews a settled ambiguous native child only after its actual exit, without replaying uncertain rows", async () => {
  const sid = "idle-renewal";
  const { session, transport, transports } = await ambiguousSession(sid);
  transport.settled = true;
  transport.endInput = () => { transport.endInputs += 1; };
  await add(sid, "after-idle-renewal", "new message");
  try {
    await until(() => transport.endInputs === 1, "old child teardown");
    assert.equal(transports.length, 1, "a replacement cannot spawn before the old child exits");
    assert.equal(transport.pendingMessages.length, 2, "the new message is never written to the old child");
    assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state]), [[`${sid}-uncertain`, "failed"], ["after-idle-renewal", "held"]]);
  } finally {
    transport.exit(0, null);
  }
  await until(() => transports.length === 2 && transports[1].pendingMessages.length === 1, "fresh child's new message");
  const fresh = transports[1];
  assert.equal(fresh.pendingMessages[0].message, "new message");
  transport.emit({ type: "message_end", message: { role: "user", content: "new message" } });
  await sleep(10);
  assert.equal(outbox.outboxEntries(sid).find((entry) => entry.id === "after-idle-renewal").state, "delivering", "old frames cannot retire the new message");
  fresh.emit({ type: "message_end", message: { role: "user", content: "new message" } });
  fresh.answer(fresh.pendingMessages[0]);
  await until(() => outbox.outboxSettledIds(sid).includes("after-idle-renewal"), "new message handoff");
  assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state, entry.mayHaveBeenSent]), [[`${sid}-uncertain`, "failed", true]]);
  assert.equal(session.hasPendingMessageCommands(), false);
  assert.deepEqual(transports.flatMap((child) => child.pendingMessages.map((command) => command.message)), ["same", "same", "new message"]);
});

test("ambiguity renewal never replaces active, queued, async, unsupported, missing-file or offline native work", async () => {
  for (const shape of ["active", "queued", "async", "unsupported", "missing-file", "offline"]) {
    const sid = `renew-no-${shape}`;
    const { transport, transports, host } = await ambiguousSession(sid);
    transport.settled = shape === "unsupported" ? undefined : true;
    if (shape === "active") transport.emit({ type: "agent_start" });
    if (shape === "queued") transport.emit({ type: "queue_update", steering: [], followUp: ["pending"] });
    if (shape === "async") transport.asyncWork = true;
    if (shape === "offline") host.status = () => "offline";
    if (shape === "missing-file") host.sessionFileExists = async () => false;
    const id = `${sid}-later`;
    await add(sid, id, "later", shape === "active" ? "steer" : "prompt");
    if (shape === "offline") {
      await until(() => outbox.outboxEntries(sid).find((entry) => entry.id === id)?.state === "waiting_host", "offline held message");
    } else if (shape === "missing-file") {
      await until(() => transport.commands.filter((command) => command.type === "get_state").length >= 4, "renewal native preflight");
      await sleep(10);
      assert.equal(outbox.outboxEntries(sid).find((entry) => entry.id === id).state, "held");
      assert.equal(transport.pendingMessages.length, 2);
    } else {
      await until(() => transport.pendingMessages.length === 3, "unfenced later native admission");
      if (shape === "active") {
        assert.equal(transport.pendingMessages[2].type, "steer");
        assert.equal((await runAgentCommand(sid, { type: "abort" }, false, "owner")).status, 200, "Stop never waits for the run or replacement proof");
      }
      transport.answer(transport.pendingMessages[2]);
      await until(() => outbox.outboxEntries(sid).find((entry) => entry.id === id)?.state === "failed", "conservative current outcome");
    }
    assert.equal(transport.endInputs, 0, shape);
    assert.equal(transports.length, 1, shape);
    assert.equal(outbox.outboxEntries(sid).find((entry) => entry.id === `${sid}-uncertain`).state, "failed");
  }
});

test("native work starting during idle-renewal preflight prevents teardown", async () => {
  const sid = "renew-raced-run";
  const { transport, transports, host } = await ambiguousSession(sid);
  transport.settled = true;
  let releaseFileCheck;
  let checkingFile = false;
  host.sessionFileExists = () => checkingFile ? Promise.resolve(true) : new Promise((resolve) => { checkingFile = true; releaseFileCheck = resolve; });
  await add(sid, "after-raced-renewal", "later");
  await until(() => checkingFile, "idle renewal session-file check");
  transport.emit({ type: "agent_start" });
  releaseFileCheck(true);
  await sleep(10);
  assert.equal(transport.endInputs, 0);
  assert.equal(transports.length, 1);
  assert.equal(transport.pendingMessages.length, 2, "a predispatch renewal refusal never sends the new message");
  const stop = await runAgentCommand(sid, { type: "abort" }, false, "owner");
  assert.equal(stop.status, 200, JSON.stringify(await stop.json()));
  assert.equal(outbox.outboxEntries(sid).find((entry) => entry.id === "after-raced-renewal").state, "held");
});

test("idle renewal preserves another pending native control reply, then safely renews after that reply completes", async () => {
  for (const phase of ["before", "preflight"]) {
    const sid = `renew-control-${phase}`;
    const { transport, transports } = await ambiguousSession(sid);
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
      await until(() => heldState !== undefined, "renewal native state preflight");
      control = runAgentCommand(sid, { type: "get_commands" }, false, "owner");
      await until(() => heldControl !== undefined, "control admitted during native preflight");
      transport.answer(heldState, {
        sessionId: sid, sessionFile: `/nonexistent/${sid}.jsonl`, sessionName: "Review fixture",
        isStreaming: false, isCompacting: false, isSettled: true, hasPendingAsyncWork: false,
        queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [] },
      });
    }
    let controlResponse;
    try {
      await until(() => transport.endInputs > 0 || transport.pendingMessages.length === 3, "later message preparation outcome");
      assert.equal(transport.endInputs, 0, "automatic renewal must not dispose a child that owes another command reply");
      assert.equal(transports.length, 1);
      transport.answer(transport.pendingMessages[2]);
      await until(() => outbox.outboxEntries(sid).find((entry) => entry.id === `${sid}-later`)?.state === "failed", "conservative later outcome");
    } finally {
      transport.answer(heldControl, { commands: [] });
      controlResponse = await control;
    }
    assert.equal(controlResponse.status, 200, "the original native control still receives its own successful reply");
    assert.equal(transport.endInputs, 0, "completing a control reply alone never confirms or discards the uncertain rows");
    transport.emit({ type: "agent_end", isTerminal: true });
    const nextId = `${sid}-after-control`;
    await add(sid, nextId, "after control");
    await until(() => transports.length === 2 && transports[1].pendingMessages.length === 1, "renewal after control completion");
    assert.equal(transport.endInputs, 1);
    assert.equal(transport.pendingMessages.length, 3, "none of the old uncertain native messages is replayed");
    const fresh = transports[1];
    assert.equal(fresh.pendingMessages[0].message, "after control");
    fresh.emit({ type: "message_end", message: { role: "user", content: "after control" } });
    fresh.answer(fresh.pendingMessages[0]);
    await until(() => outbox.outboxSettledIds(sid).includes(nextId), "fresh message handoff after control completion");
    assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state]), [[`${sid}-uncertain`, "failed"], [`${sid}-later`, "failed"]]);
  }
});

test("idle renewal rechecks unrelated pending server preparation after the awaited session-file check", async () => {
  const sid = "renew-pending-preparation";
  const { session, transport, transports, host } = await ambiguousSession(sid);
  transport.settled = true;
  let releaseFileCheck;
  let checkingFile = false;
  host.sessionFileExists = () => checkingFile ? Promise.resolve(true) : new Promise((resolve) => { checkingFile = true; releaseFileCheck = resolve; });
  await add(sid, "after-pending-preparation", "later");
  await until(() => checkingFile, "renewal session-file check");
  let releaseRead;
  let holdRead = true;
  host.sessionOps.readContext = () => holdRead ? new Promise((resolve) => { releaseRead = resolve; }) : Promise.resolve({ ok: true, value: { entryIds: ["before"] } });
  const preparation = session.withPendingCommand(() => host.sessionOps.readContext(sid));
  try {
    releaseFileCheck(true);
    await sleep(10);
    assert.equal(transport.endInputs, 0, "the renewal's own pending slot cannot conceal another preparation owner");
    assert.equal(transports.length, 1);
    assert.equal(transport.pendingMessages.length, 2);
    assert.equal(outbox.outboxEntries(sid).find((entry) => entry.id === "after-pending-preparation").state, "held");
  } finally {
    holdRead = false;
    releaseRead({ ok: true, value: { entryIds: ["before"] } });
    await preparation;
  }
  outbox.pumpOutbox(sid);
  await until(() => transports.length === 2 && transports[1].pendingMessages.length === 1, "renewal after preparation completion");
  const fresh = transports[1];
  fresh.emit({ type: "message_end", message: { role: "user", content: "later" } });
  fresh.answer(fresh.pendingMessages[0]);
  await until(() => outbox.outboxSettledIds(sid).includes("after-pending-preparation"), "later native handoff");
  assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state]), [[`${sid}-uncertain`, "failed"]]);
});

test("automatic idle renewal restores accepted tools and URI payloads before input under the current server-tools policy", async () => {
  for (const policy of ["enabled", "disabled", "enabled-later", "server-only"]) {
    saveWebServerSettings({ agentToolsEnabled: policy !== "enabled-later" });
    const sid = `renew-capabilities-${policy}`;
    const { transport, transports } = await ambiguousSession(sid);
    const browserTool = { name: "browser_lookup", description: "Look up page text", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
    if (policy !== "server-only") {
      assert.equal((await runAgentCommand(sid, { type: "set_host_tools", tools: [browserTool] }, false, "owner")).status, 200);
    }
    const originalTools = transport.commands.filter((command) => command.type === "set_host_tools").at(-1);
    if (policy !== "enabled-later") assert.ok(originalTools.tools.some((tool) => tool.name === "send_to_session"), "original child accepted server agent tools");
    if (policy !== "server-only") assert.deepEqual(originalTools.tools.find((tool) => tool.name === "browser_lookup"), browserTool);
    const schemes = [{ scheme: "pi-web", writable: false }, { scheme: "notes", writable: true }];
    assert.equal((await runAgentCommand(sid, { type: "set_host_uri_schemes", schemes }, false, "owner")).status, 200);
    assert.deepEqual(transport.commands.filter((command) => command.type === "set_host_uri_schemes").at(-1).schemes, schemes);

    // A rejected replacement must not overwrite the last registration the old native child actually accepted.
    const write = transport.write;
    transport.write = (line, callback) => {
      const command = JSON.parse(line);
      if ((command.type === "set_host_tools" && command.tools.some((tool) => tool.name === "rejected"))
        || (command.type === "set_host_uri_schemes" && command.schemes.some((entry) => entry.scheme === "rejected"))) {
        transport.commands.push(command);
        queueMicrotask(() => transport.emit({ type: "response", id: command.id, command: command.type, success: false, error: "Registration rejected" }));
        callback(null);
      } else write(line, callback);
    };
    assert.equal((await runAgentCommand(sid, { type: "set_host_tools", tools: [{ name: "rejected", description: "Rejected tool", parameters: {} }] }, false, "owner")).status, 400);
    assert.equal((await runAgentCommand(sid, { type: "set_host_uri_schemes", schemes: [{ scheme: "rejected", writable: true }] }, false, "owner")).status, 400);
    saveWebServerSettings({ agentToolsEnabled: policy !== "disabled" });
    transport.settled = true;
    const id = `${sid}-new`;
    await add(sid, id, "new input with existing capabilities");
    await until(() => transports.length === 2 && transports[1].pendingMessages.length === 1, "replacement native input");
    const fresh = transports[1];
    const prefix = fresh.commands.slice(0, fresh.commands.indexOf(fresh.pendingMessages[0]));
    const restoredTools = prefix.find((command) => command.type === "set_host_tools");
    assert.ok(restoredTools, "native host tools must be restored before input, without waiting for a browser");
    const expectedNames = policy === "server-only" ? ["list_sessions", "new_session", "send_to_session"]
      : policy === "disabled" ? ["browser_lookup"] : ["browser_lookup", "list_sessions", "new_session", "send_to_session"];
    assert.deepEqual(restoredTools.tools.map((tool) => tool.name).sort(), expectedNames);
    if (policy !== "server-only") assert.deepEqual(restoredTools.tools.find((tool) => tool.name === "browser_lookup"), browserTool);
    assert.deepEqual(prefix.find((command) => command.type === "set_host_uri_schemes")?.schemes, schemes);
    fresh.emit({ type: "message_end", message: { role: "user", content: "new input with existing capabilities" } });
    fresh.answer(fresh.pendingMessages[0]);
    await until(() => outbox.outboxSettledIds(sid).includes(id), "capability-preserving handoff");
    assert.deepEqual(outbox.outboxEntries(sid).map((entry) => [entry.id, entry.state]), [[`${sid}-uncertain`, "failed"]]);
  }
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
  transport.emit({ type: "queue_update", steering: [], followUp: ["current"] });
  transport.answer(transport.pendingMessages[1]);
  await until(() => outbox.outboxSettledIds(sid).includes("prepared-current") || outbox.outboxEntries(sid)[0]?.state === "failed", "refreshed handoff");
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

test("a competing API write cannot donate its identical echo or queue occurrence to an outbox reply", async () => {
  for (const eventType of ["echo", "queue", "echo-before-competing-write"]) {
    const sid = `overlap-${eventType}`;
    const { transport } = await liveSession(sid);
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
    assert.deepEqual(outbox.outboxSettledIds(sid), []);
    assert.equal((await runAgentCommand(sid, { type: "abort" }, false, "owner")).status, 200, "Stop is never fenced behind replacement inference");
  }
});

test("a real server agent-tool steer also invalidates an overlapping identical outbox echo", async () => {
  saveWebServerSettings({ agentToolsEnabled: true });
  const sid = "overlap-agent-target";
  const sourceId = "overlap-agent-source";
  const message = `[From session ${sourceId} via omp-web agent tools]: same`;
  const target = await liveSession(sid);
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
  const { session, transport } = await liveSession(sid);
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
    for (const frame of frames) transport.emit(frame);
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
  const { session, transport } = await liveSession(sid);
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
  assert.deepEqual(outbox.outboxSettledIds(sid), []);

  transport.emit({ type: "agent_end", isTerminal: true });
  assert.equal(session.hasPendingMessageCommands(), true, "agent_end alone is not a quiescent native boundary");
  transport.emit({ type: "session_settled" });
  assert.equal(session.hasPendingMessageCommands(), true, "settlement is not a command-specific replacement receipt");
  await session.destroyAndWait();
  const fresh = await liveSession(sid);
  await add(sid, "after-native-replacement", "uncontended");
  await until(() => fresh.transport.pendingMessages.length === 1, "fresh child's native message");
  fresh.transport.emit({ type: "message_end", message: { role: "user", content: "uncontended" } });
  fresh.transport.answer(fresh.transport.pendingMessages[0]);
  await until(() => outbox.outboxSettledIds(sid).includes("after-native-replacement")
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
    if (kind === "queue") transport.emit({ type: "queue_update", steering: [], followUp: ["later"] });
    if (kind === "skill") transport.emit({ type: "message_end", message: { role: "custom", customType: "skill-prompt", attribution: "user", details: { name: "demo", args: "do it", prompt: message }, content: "expanded native skill" } });
    if (kind === "template") {
      transport.emit({ type: "message_start", messageId: "native-template", message: { role: "user", content: "native template expansion" } });
      transport.emit({ type: "message_end", messageId: "native-template", message: { role: "user", content: "native template expansion" } });
    }
    transport.answer(sent, kind === "builtin" ? { agentInvoked: false } : {});
    await until(() => outbox.outboxEntries(sid).length === 0 || outbox.outboxEntries(sid)[0]?.state === "failed", `${kind} handoff`);
    assert.deepEqual(outbox.outboxEntries(sid), [], kind);
    assert.deepEqual(outbox.outboxSettledIds(sid), [`native-${kind}`]);
  }
});

test("uncontended outbox admissions preserve prompt-time followups, steers and unfenced Stop on one native child", async () => {
  const sid = "native-running-admissions";
  const { session, transport } = await liveSession(sid);
  await add(sid, "running-prompt", "start");
  await until(() => transport.pendingMessages.length === 1, "initial native prompt");
  transport.emit({ type: "agent_start" });
  transport.emit({ type: "message_end", message: { role: "user", content: "start" } });
  transport.answer(transport.pendingMessages[0]);
  await until(() => outbox.outboxEntries(sid).length === 0, "initial prompt handoff");
  assert.equal(session.isRunning(), true);
  for (const [mode, nativeType, key, text] of [["followUp", "follow_up", "followUp", "later"], ["steer", "steer", "steering", "steer now"]]) {
    await add(sid, `running-${mode}`, text, mode);
    await until(() => transport.pendingMessages.length === (mode === "followUp" ? 2 : 3), `${mode} native admission`);
    const sent = transport.pendingMessages.at(-1);
    assert.equal(sent.type, nativeType);
    transport.emit({ type: "queue_update", ...transport.queue, [key]: [...transport.queue[key], text] });
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
    if (mode === "followUp") transport.emit({ type: "queue_update", steering: [], followUp: ["later"] });
    else transport.emit({ type: "message_end", message: { role: "user", content: "later" } });
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
  transport.emit({ type: "message_end", message: { role: "user", content: "start" } });
  transport.answer(transport.pendingMessages[0]);
  await until(() => outbox.outboxEntries(sid).length === 0, "acknowledged and echoed handoff");
  assert.ok(outbox.outboxSettledIds(sid).includes("live-claim"));
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
