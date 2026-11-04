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
const { startRpcSession } = await import("./rpc-manager.ts");
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
          sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: transport.streaming, isCompacting: false,
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
