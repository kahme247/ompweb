import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "omp-hub-v7-"));
process.env.PI_CODING_AGENT_DIR = dir;
const hub = await import("./hub.ts");
const { RpcProcess } = await import("../omp/rpc-process.ts");
const { HostOpError } = await import("./link-protocol.ts");
const { AgentSessionWrapper, getRpcSession, startRpcSession, subscribeRunningSessions } = await import("../rpc-manager.ts");
const { linkHost, ompChild, until } = await import("./link-driver.test-helper.mjs");
const { closeNotificationStore } = await import("../notification-store.ts");
const { closeOutboxStore } = await import("../message-outbox.ts");

test.after(() => {
  hub.flushLinkSamples();
  closeNotificationStore();
  closeOutboxStore();
  rmSync(dir, { recursive: true, force: true });
});

let serial = 0;
const sessionId = () => `11111111-2222-4333-8444-${String(++serial).padStart(12, "0")}`;
const launch = (id) => ({ cwd: "/w", recordedCwd: "/w", sessionFile: `/sessions/${id}.jsonl`, advisor: false });
const snapshot = (text = "before") => JSON.stringify({ type: "message_update", messageId: "m", message: { role: "assistant", content: [{ type: "text", text }] } });
const result = (ch, extras = {}) => ({ ch, joined: true, pending: [], streaming: null, cwd: "/w", fellBack: false, launchAdvisor: false, advisorSpawned: false, autoApproveExtension: false, ...extras });

async function sharedLink(t, id, { listed = false, pending = [], streaming = null, state = {}, fail = null, advisorSpawned = false, launchAdvisor = false, hostBusy = false, failReplace = false, leaseBusy = false } = {}) {
  let ch = `shared-${id}`;
  let actualAdvisor = advisorSpawned;
  let alive = true;
  let coldStarts = 0;
  const link = await linkHost(`Shared ${id}`, {
    hello: { v: 7, link: { id: "l1", notifier: true } },
    channels: listed ? [{ ch, sessionId: id, cwd: "/w", pending }] : [],
  });
  const messages = [];
  const opens = [];
  const closes = [];
  const leases = [];
  const child = ompChild(link, id, { state, fail });
  const serving = link.serve({
    async open(args) {
      opens.push(args);
      if (args.expectedChannel && (args.expectedChannel !== ch || !alive)) {
        throw new HostOpError(404, "session_not_running", "The advertised channel exited");
      }
      const desired = args.launch.advisor || launchAdvisor;
      if (!alive) { alive = true; coldStarts++; actualAdvisor = desired; }
      if (args.replaceAdvisor && !hostBusy && actualAdvisor !== desired) {
        await link.post({ type: "exit", ch, code: 0, signal: null });
        if (failReplace) throw new HostOpError(502, "host_process_exited", "omp exited during startup");
        ch = `${ch}-next`;
        actualAdvisor = desired;
      }
      return result(ch, { pending, streaming: typeof streaming === "function" ? streaming(opens.length) : streaming, advisorSpawned: actualAdvisor, launchAdvisor });
    },
    close({ ch }) { closes.push(ch); return {}; },
    editLease({ on }) {
      leases.push(on);
      if (on && leaseBusy) throw new HostOpError(409, "session_busy", "Another web app is editing this session's history; retry once it finishes");
      return {};
    },
    sessionFileExists() { return true; },
    invalidateSessionLists() { return null; },
    listSessions() { return [{ id, cwd: "/w", path: launch(id).sessionFile, created: "c", modified: "m", messageCount: 1, firstMessage: "hi" }]; },
  }, async (message) => {
    messages.push(message);
    if (message.type === "kill") { alive = false; await link.post({ type: "exit", ch, code: 0, signal: null }); }
    else await child(message);
  });
  t.after(async () => {
    await getRpcSession(id)?.destroyAndWait();
    hub.closeHostLink(link.id);
    await serving;
  });
  return { link, get ch() { return ch; }, get coldStarts() { return coldStarts; }, messages, opens, closes, leases,
    async exit() { alive = false; await link.post({ type: "exit", ch, code: 0, signal: null }); } };
}

// A promise continuation is too late: the following stdout is applied in the same WebSocket frame.
test("v7 open installs the returned channel and snapshot before same-frame live output", async (t) => {
  const id = sessionId();
  const link = await linkHost("Atomic open", { hello: { v: 7, link: { id: "l1", notifier: true } } });
  t.after(() => hub.closeHostLink(link.id));
  const opening = hub.getHost(link.id).spawnRpc(launch(id), id);
  const req = await link.next();
  assert.equal(req.op, "open");
  assert.deepEqual(req.args, { sessionId: id, launch: launch(id) });
  const dialog = JSON.stringify({ type: "extension_ui_request", method: "ask", id: "ask", questions: [] });
  await link.post(
    { type: "channels_changed", channels: [{ ch: "canonical", sessionId: id, cwd: "/w", pending: [] }] },
    { type: "res", id: req.id, ok: true, result: result("canonical", { pending: [dialog], streaming: snapshot() }) },
    { type: "stdout", ch: "canonical", line: JSON.stringify({ type: "notice", message: "later" }) },
  );
  const spawned = await opening;
  const frames = [];
  const proc = new RpcProcess({ cwd: "/w", transport: spawned.transport, adopted: { protocolVersion: 2 }, onFrame: frame => frames.push(frame) });
  assert.equal(spawned.transport.hostOwnedLifecycle, true);
  assert.equal(spawned.transport.id, "canonical");
  proc.replay([...spawned.pending, spawned.streaming]);
  proc.release();
  assert.deepEqual(frames, [JSON.parse(dialog), JSON.parse(snapshot()), { type: "notice", message: "later" }]);
  spawned.transport.setInterest(true);
  spawned.transport.setPreparing(true);
  spawned.transport.setPreparing(false);
  const registration = spawned.transport.setHostTools([{ name: "open_url", description: "Open", parameters: { type: "object", properties: {} } }], [{ scheme: "browser", writable: false }]);
  await registration;
  await assert.rejects(spawned.transport.setHostTools([{ name: "broken", parameters: [] }], [{ scheme: "browser", writable: false }]), error => error.status === 400);
  spawned.transport.close();
  const sent = [];
  for (;;) {
    const message = await link.next();
    sent.push(message);
    if (message.type === "req" && message.op === "close") break;
  }
  assert.deepEqual(sent.filter(m => m.type === "interest").map(({ on, preparing }) => ({ on, preparing })), [
    { on: true, preparing: false }, { on: true, preparing: true }, { on: true, preparing: false },
  ]);
  assert.deepEqual(sent.find(m => m.type === "host_tools").schemes, [{ scheme: "browser", writable: false }]);
  assert.equal(sent.some(m => m.type === "kill"), false);
});

test("v7 joined wrappers skip child-global startup, report interest and preserve concurrent preparation", async (t) => {
  const id = sessionId();
  const { link, messages } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  const detach = session.onEvent(() => {});
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const first = session.withPendingCommand(() => gates[0].promise);
  const second = session.withPendingCommand(() => gates[1].promise);
  gates[0].resolve();
  await first;
  await until(() => messages.filter(m => m.type === "interest").at(-1)?.preparing === true, "preparation interest");
  assert.equal(messages.filter(m => m.type === "interest").at(-1).preparing, true);
  gates[1].resolve();
  await second;
  detach();
  await until(() => messages.filter(m => m.type === "interest").at(-1)?.on === false, "interest released");
  const startup = new Set(["negotiate_protocol", "set_event_filter", "set_subagent_subscription", "set_ask_dialog"]);
  assert.deepEqual(messages.filter(m => m.type === "stdin" && startup.has(JSON.parse(m.line).type)), []);
  await session.destroyAndWait();
  assert.equal(messages.some(m => m.type === "kill"), false);
});

test("v7 hello eagerly joins background runs and resync restores the daemon snapshot without changing filters", async (t) => {
  const id = sessionId();
  const dialog = JSON.stringify({ type: "extension_ui_request", method: "ask", id: "question", questions: [] });
  const { link, ch, messages, opens } = await sharedLink(t, id, { listed: true, pending: [dialog], streaming: snapshot("whole"), state: { isStreaming: true } });
  await until(() => getRpcSession(id)?.isAlive(), "background adoption");
  const wrapper = getRpcSession(id);
  assert.equal(wrapper.hasSubscribers(), false);
  assert.equal(wrapper.isRunning(), true);
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.content[0].text, "whole");
  assert.equal(opens.length, 1);
  await link.post({ type: "resync", ch });
  await until(() => opens.length === 2, "snapshot reopen");
  await until(() => messages.filter(m => m.type === "stdin" && JSON.parse(m.line).type === "get_state").length >= 2, "resync state");
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.content[0].text, "whole");
  await link.post({ type: "stdout", ch, line: JSON.stringify({ type: "message_update", messageId: "m", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " plus" } }) });
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.content[0].text, "whole plus");
  assert.equal(opens.length, 2, "a daemon snapshot is a valid delta base");
  assert.equal(messages.some(m => m.type === "stdin" && JSON.parse(m.line).type === "set_event_filter"), false);
  const events = [];
  const detach = wrapper.onEvent(event => events.push(event));
  assert.ok(events.some(event => event.type === "extension_ui_request" && event.id === "question"));
  detach();
});

test("v7 failed adoption and unidentifiable hello children close only membership", async (t) => {
  const id = sessionId();
  const { messages, closes, ch } = await sharedLink(t, id, { listed: true, fail: "get_state" });
  await until(() => closes.includes(ch), "failed adoption closes membership");
  await until(() => !getRpcSession(id), "failed wrapper removed");
  assert.equal(messages.some(m => m.type === "kill"), false);
  const link = await linkHost("Unknown shared child", { hello: { v: 7, link: { id: "l1", notifier: true } }, channels: [{ ch: "unknown", sessionId: null, cwd: "/w", pending: null }] });
  t.after(() => hub.closeHostLink(link.id));
  const close = await link.next();
  assert.equal(close.op, "close");
  assert.deepEqual(close.args, { ch: "unknown" });
});

test("v7 notifier handoff gates automatic publication only", async (t) => {
  const id = sessionId();
  const { link } = await sharedLink(t, id);
  assert.equal(hub.isNotifier(link.id), true);
  await link.post({ type: "notifier", on: false });
  assert.equal(hub.isNotifier(link.id), false);
  const { publishNotification, attachNotificationClient, reportPresence } = await import("../notification-hub.ts");
  const { saveDevice } = await import("../notification-store.ts");
  const delivered = [];
  saveDevice("v7-device", { enabled: true, types: { completed: true, input: true, error: true, modelSwitch: true }, whenActive: "toast", locale: "en" });
  reportPresence({ clientId: "v7-tab", deviceId: "v7-device", visible: false, sessionId: null, seq: 1 });
  t.after(attachNotificationClient("v7-tab", event => delivered.push(event)));
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: JSON.stringify({ type: "agent_start" }) });
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: JSON.stringify({ type: "session_settled" }) });
  assert.equal(delivered.length, 0, "non-notifier cannot publish an automatic completion");
  // Explicit test notifications have no host identity and must not be globally suppressed.
  publishNotification({ type: "completed", sessionId: id, sessionName: "Test" });
  assert.ok(delivered.length > 0);
  delivered.length = 0;
  await link.post({ type: "notifier", on: true });
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: JSON.stringify({ type: "agent_start" }) });
  await link.post({ type: "stdout", ch: session.proc.transport.id, line: JSON.stringify({ type: "session_settled" }) });
  assert.deepEqual(delivered.map(message => message.event.type), ["completed"]);
});

test("v7 sessions_changed invalidates host list cache and broadcasts refresh", async (t) => {
  const link = await linkHost("Changed lists", { hello: { v: 7, link: { id: "l1", notifier: true } } });
  t.after(() => hub.closeHostLink(link.id));
  let lists = 0;
  const serving = link.serve({ listSessions: () => { lists++; return []; } });
  const { hostSessions } = await import("./session-index.ts");
  await hostSessions(link.id);
  const updates = [];
  t.after(subscribeRunningSessions(update => updates.push(update)));
  await link.post({ type: "sessions_changed" });
  await until(() => updates.some(update => update.refreshSessionList), "list refresh broadcast");
  await hostSessions(link.id);
  assert.equal(lists, 2);
  hub.closeHostLink(link.id);
  await serving;
});

test("shared RpcProcess disposal closes membership; explicit disposal still kills", async () => {
  for (const explicit of [false, true]) {
    let exited;
    const calls = [];
    const transport = {
      hostOwnedLifecycle: true,
      onLine() {}, onStderr() {}, onExit(listener) { exited = listener; },
      write(_line, done) { done(); },
      close() { calls.push("close"); exited(null, null); },
      endInput() { calls.push("end"); exited(0, null); },
      killTree() { calls.push("kill"); exited(0, null); },
    };
    const proc = new RpcProcess({ cwd: "/w", transport });
    await proc.dispose(5, explicit);
    assert.deepEqual(calls, explicit ? ["kill"] : ["close"]);
  }
});

test("v7 wrappers leave both stop timers to the daemon and keep ordinary tool results", async (t) => {
  const events = [];
  const interest = [];
  let feed;
  let closes = 0;
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    transport: { hostOwnedLifecycle: true, setInterest(on) { interest.push(on); } },
    onFrame(listener) { feed = listener; return () => {}; },
    dispose: async () => { closes++; },
  }, "/w", null, false, sessionId(), 1, { id: "fake", status: () => "online", onStatus: () => () => {} });
  wrapper.start();
  const detach = wrapper.onEvent(event => events.push(event));
  feed({ type: "tool_execution_end", toolCallId: "native-once", result: { content: [{ type: "text", text: "shared result" }] } });
  detach();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(wrapper.isAlive(), true);
  assert.equal(closes, 0);
  assert.deepEqual(interest, [false, true, false]);
  assert.ok(events.some(event => event.type === "tool_execution_end" && event.toolCallId === "native-once"));
  await wrapper.destroyAndWait();
});

test("resume manifests retain legacy hosts but exclude v7 hosts", async (t) => {
  const id = sessionId();
  const { link } = await sharedLink(t, id);
  const { saveWebServerSettings } = await import("../web-settings.ts");
  const { recordRunningSessions, resumeOnHostLink } = await import("../session-resume.ts");
  const tracker = globalThis.__ompResumeTracker;
  globalThis.__ompResumeTracker = undefined;
  t.after(() => { globalThis.__ompResumeTracker = tracker; });
  saveWebServerSettings({ autoResumeSessions: true });
  const legacy = { id: sessionId(), hostId: "legacy-offline", advisor: false };
  const shared = { id, hostId: link.id, advisor: false };
  recordRunningSessions([shared, legacy], () => true);
  const manifest = join(dir, `omp-web-interrupted-sessions-${process.pid}.json`);
  assert.equal(existsSync(manifest), true);
  assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")).sessions, [legacy]);
  const resumed = [];
  resumeOnHostLink([shared], async entry => resumed.push(entry));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resumed, []);
});

test("shared callback snapshots cannot execute a browser action twice", async (t) => {
  const id = sessionId();
  const pending = [];
  const { link, ch, opens } = await sharedLink(t, id, { pending });
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  const events = [];
  const detach = session.onEvent(event => events.push(event));
  t.after(detach);
  const call = { type: "host_tool_call", id: "one-action", toolName: "open_url", arguments: { url: "https://example.test" } };
  await link.post({ type: "stdout", ch, line: JSON.stringify(call) });
  pending.push(JSON.stringify(call));
  await link.post({ type: "resync", ch });
  await until(() => opens.length === 2, "callback resync");
  assert.equal(events.filter(event => event.type === "host_tool_call").length, 1);
});

test("adopted shared web callbacks report unknown outcome instead of blindly repeating an action", async (t) => {
  const id = sessionId();
  const call = JSON.stringify({ type: "host_tool_call", id: "before-restart", toolName: "open_url", arguments: { url: "https://example.test" } });
  const { messages } = await sharedLink(t, id, { listed: true, pending: [call] });
  await until(() => getRpcSession(id)?.isAlive(), "adopted callback owner");
  await until(() => messages.some(message => message.type === "stdin" && JSON.parse(message.line).type === "host_tool_result"), "ambiguous callback result");
  const reply = messages.filter(message => message.type === "stdin").map(message => JSON.parse(message.line)).find(frame => frame.type === "host_tool_result");
  assert.equal(reply.id, "before-restart");
  assert.equal(reply.isError, true);
  assert.match(reply.result.content[0].text, /outcome is unknown/);
  const events = [];
  const detach = getRpcSession(id).onEvent(event => events.push(event));
  detach();
  assert.equal(events.some(event => event.type === "host_tool_call"), false);
});

test("v7 channels_changed observes a newly created run without any tab", async (t) => {
  const id = sessionId();
  const { link, ch, opens } = await sharedLink(t, id, { state: { isStreaming: true } });
  assert.equal(getRpcSession(id), undefined);
  await link.post({ type: "channels_changed", channels: [{ ch, sessionId: id, cwd: "/w", pending: [] }] });
  await until(() => getRpcSession(id)?.isAlive(), "new background channel adoption");
  assert.equal(getRpcSession(id).hasSubscribers(), false);
  assert.equal(getRpcSession(id).isRunning(), true);
  assert.equal(opens.length, 1);
});

test("explicit v7 reload kills once, restores registrations and leaves startup settings to the daemon", async (t) => {
  const id = sessionId();
  const { link, messages, opens } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  await session.send({ type: "set_host_uri_schemes", schemes: [{ scheme: "browser", writable: true }] });
  await session.send({ type: "reload" });
  assert.equal(opens.length, 2);
  assert.deepEqual(messages.filter(message => message.type === "kill").map(message => message.force), [false]);
  await until(() => messages.filter(message => message.type === "host_tools").length >= 3, "restored tool registration");
  assert.deepEqual(messages.filter(message => message.type === "host_tools").at(-1).schemes, [{ scheme: "browser", writable: true }]);
  const forbidden = new Set(["negotiate_protocol", "set_event_filter", "set_subagent_subscription", "set_ask_dialog", "set_host_tools", "set_host_uri_schemes"]);
  assert.deepEqual(messages.filter(message => message.type === "stdin" && forbidden.has(JSON.parse(message.line).type)), []);
});

test("joined and eagerly adopted shared wrappers retain the actual native advisor mode", async (t) => {
  for (const listed of [false, true]) {
    const id = sessionId();
    const { link } = await sharedLink(t, id, { listed, advisorSpawned: true });
    if (listed) await until(() => getRpcSession(id)?.isAlive(), "advisor-aware eager adoption");
    const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, undefined, "/w", undefined, hub.getHost(link.id));
    assert.equal(session.advisorSpawned, true, "another server's off/default join cannot change the recorded spawn flag");
    assert.equal(session.launchAdvisor, false);
  }
});

test("workspace-forced advisor is preserved on a shared toggle-off request", async (t) => {
  const id = sessionId();
  const { link, messages, opens } = await sharedLink(t, id, { listed: true, advisorSpawned: true, launchAdvisor: true });
  await until(() => getRpcSession(id)?.isAlive(), "workspace advisor adoption");
  const prior = getRpcSession(id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  assert.equal(session, prior);
  assert.equal(session.advisorSpawned, true);
  assert.equal(session.launchAdvisor, true);
  assert.equal(opens.length, 1);
  assert.equal(messages.some(message => message.type === "kill"), false);
});

for (const desired of [true, false]) {
  test(`an idle shared advisor toggle to ${desired} replaces before the prompt`, async (t) => {
    const id = sessionId();
    const { opens, messages } = await sharedLink(t, id, { listed: true, advisorSpawned: !desired });
    await until(() => getRpcSession(id)?.isAlive(), "initial shared adoption");
    const before = getRpcSession(id);
    const { runAgentCommand } = await import("../agent-command.ts");
    const reply = await runAgentCommand(id, { type: "prompt", message: "change advisor" }, desired, "advisor-owner");
    assert.equal(reply.status, 200, await reply.text());
    const after = getRpcSession(id);
    assert.notEqual(after, before);
    assert.equal(before.isAlive(), false);
    assert.equal(after.advisorSpawned, desired);
    assert.equal(opens.at(-1).replaceAdvisor, true);
    assert.equal(opens.at(-1).preparing, true);
    assert.equal(opens.at(-1).launch.advisor, desired);
    await until(() => messages.some(message => message.type === "stdin" && JSON.parse(message.line).type === "prompt"), "prompt on the renewed channel");
    assert.equal(messages.filter(message => message.type === "stdin" && JSON.parse(message.line).type === "prompt").length, 1);
    assert.equal(messages.some(message => message.type === "kill"), false, "replacement is guarded on the daemon");
  });
}

test("a first joining server can request advisor without silently inheriting the other server's mode", async (t) => {
  const id = sessionId();
  const { link, opens } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, true, "/w", undefined, hub.getHost(link.id));
  assert.equal(session.advisorSpawned, true);
  assert.equal(opens[0].replaceAdvisor, true);
});

test("a host-side busy race retains the current shared wrapper and never sends a kill", async (t) => {
  const id = sessionId();
  const { link, messages, opens } = await sharedLink(t, id, { listed: true, hostBusy: true, streaming: count => count === 1 ? null : snapshot("peer raced") });
  await until(() => getRpcSession(id)?.isAlive(), "host-busy shared adoption");
  const before = getRpcSession(id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, true, "/w", undefined, hub.getHost(link.id));
  assert.equal(session, before);
  assert.equal(session.isAlive(), true);
  assert.equal(session.advisorSpawned, false);
  assert.equal(opens.at(-1).replaceAdvisor, true, "the daemon, not a stale local idle view, decides");
  assert.equal(session.getStreamSnapshot().streamingMessage.content[0].text, "peer raced", "declining replacement still replays the open snapshot");
  assert.equal(messages.some(message => message.type === "kill"), false);
});

test("terminal-but-unsettled shared work defers an advisor toggle until settlement", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { listed: true });
  await until(() => getRpcSession(id)?.isAlive(), "unsettled shared adoption");
  const before = getRpcSession(id);
  await fixture.link.post(
    { type: "stdout", ch: fixture.ch, line: JSON.stringify({ type: "agent_start" }) },
    { type: "stdout", ch: fixture.ch, line: JSON.stringify({ type: "agent_end", isTerminal: true }) },
  );
  const busy = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, true, "/w", undefined, hub.getHost(fixture.link.id));
  assert.equal(busy.session, before);
  assert.equal(fixture.opens.length, 1);
  await fixture.link.post({ type: "stdout", ch: fixture.ch, line: JSON.stringify({ type: "session_settled" }) });
  await until(() => before.canReplaceAdvisor(), "local control work settled");
  const ready = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, true, "/w", undefined, hub.getHost(fixture.link.id));
  assert.notEqual(ready.session, before);
  assert.equal(ready.session.advisorSpawned, true);
});

test("a stale channel announcement cannot exit a channel opened after that snapshot", async (t) => {
  const id = sessionId();
  const { link } = await sharedLink(t, id);
  const { transport } = await hub.getHost(link.id).spawnRpc(launch(id), id);
  let exited = false;
  transport.onExit(() => { exited = true; });
  await link.post({ type: "channels_changed", channels: [] }, { type: "notifier", on: false });
  await until(() => !hub.isNotifier(link.id), "same-frame ordering marker");
  assert.equal(exited, false);
  assert.equal(transport.lost, false);
  transport.close();
});

test("a shared resync immediately rejects orphan chunk tails without disposing the session", async (t) => {
  const id = sessionId();
  const { link, ch, opens, closes } = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  const data = Buffer.from(JSON.stringify({ type: "notice", level: "info", message: "large event", pad: "x".repeat(1_300_000) }));
  const count = Math.ceil(data.length / 262144);
  const tails = Array.from({ length: count - 3 }, (_, i) => {
    const index = i + 3;
    return { type: "stdout", ch, line: JSON.stringify({ type: "rpc_chunk", chunkId: "overflowed", index, count, byteLength: data.length,
      data: data.subarray(index * 262144, (index + 1) * 262144).toString("base64") }) };
  });
  await link.post({ type: "resync", ch }, ...tails);
  await until(() => opens.length >= 2 || closes.length > 0, "snapshot re-open");
  await session.send({ type: "get_state" });
  assert.equal(session.isAlive(), true);
  assert.deepEqual(closes, []);
});

test("rejoining reasserts the transport's existing interest and preparation without wrapper traffic", async (t) => {
  const id = sessionId();
  const { link, messages } = await sharedLink(t, id);
  const { transport } = await hub.getHost(link.id).spawnRpc(launch(id), id);
  transport.setInterest(true);
  transport.setPreparing(true);
  await until(() => messages.filter(message => message.type === "interest").at(-1)?.preparing === true, "initial transport lease");
  const before = messages.filter(message => message.type === "interest").length;
  await transport.resync();
  await until(() => messages.filter(message => message.type === "interest").length > before, "reasserted transport lease");
  const latest = messages.filter(message => message.type === "interest").at(-1);
  assert.equal(latest.on, true);
  assert.equal(latest.preparing, true);
  transport.close();
});

test("the open-to-command preparation handoff has no false gap and is never reused by resync", async (t) => {
  const id = sessionId();
  const { link, messages, opens } = await sharedLink(t, id);
  const { transport } = await hub.getHost(link.id).spawnRpc(launch(id), id, { replaceAdvisor: true, preparing: true });
  await until(() => messages.some(message => message.type === "interest" && message.preparing), "handoff lease");
  // An unrelated command never inherits (and so never ends) the open's lease.
  transport.setPreparing(true);
  transport.setPreparing(false);
  assert.equal(messages.filter(message => message.type === "interest").at(-1)?.preparing, true);
  transport.setPreparing(true, true);
  await transport.resync();
  assert.equal(opens.at(-1).replaceAdvisor, undefined);
  assert.equal(opens.at(-1).preparing, undefined);
  assert.equal(opens.at(-1).expectedChannel, transport.id);
  assert.equal(messages.filter(message => message.type === "interest").every(message => message.preparing), true);
  transport.setPreparing(false);
  await until(() => messages.filter(message => message.type === "interest").at(-1)?.preparing === false, "command releases preparation");
  transport.close();
});

test("a stale passive announcement after native exit cannot cold-start the saved session", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { listed: true });
  await until(() => getRpcSession(id)?.isAlive(), "initial passive adoption");
  const ch = fixture.ch;
  await fixture.exit();
  await until(() => !getRpcSession(id), "exited wrapper removed");
  await fixture.link.post({ type: "channels_changed", channels: [{ ch, sessionId: id, cwd: "/w", pending: [] }] });
  await until(() => fixture.opens.length === 2, "stale conditional join");
  await until(() => fixture.closes.includes(ch), "stale join refused and local placeholder closed");
  assert.equal(fixture.opens.at(-1).expectedChannel, ch);
  assert.equal(fixture.coldStarts, 0);
  assert.equal(getRpcSession(id), undefined);
});

test("failed shared startup closes an unclaimed preparation handoff", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { fail: "get_state" });
  await assert.rejects(startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(fixture.link.id), true), /get_state failed/);
  await until(() => fixture.closes.includes(fixture.ch), "failed startup closes its leased membership");
  assert.equal(getRpcSession(id), undefined);
});

test("a peer's deliberate identity switch refreshes the joined server's registry", async (t) => {
  const id = sessionId(), next = sessionId(), state = {};
  const { link, ch } = await sharedLink(t, id, { state });
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, undefined, "/w", undefined, hub.getHost(link.id));
  t.after(() => session.destroyAndWait());
  state.sessionId = next;
  state.sessionFile = launch(next).sessionFile;
  await link.post({ type: "channels_changed", channels: [{ ch, sessionId: next, cwd: "/w", pending: [] }] });
  await until(() => getRpcSession(next) === session, "peer switched identity");
  assert.equal(getRpcSession(id), undefined);
  assert.equal(session.isAlive(), true);
});

test("a peer server's identical echo never confirms this server's own message admission", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(fixture.link.id));
  const echo = (n) => ["message_start", "message_end"].map(type => ({ type: "stdout", ch: fixture.ch, line: JSON.stringify({ type, messageId: `u${n}`, message: { role: "user", content: "same" } }) }));
  const watch = () => session.watchMessageReplacement({ type: "prompt", message: "same" }, { steering: [], followUp: [] }, session.getMessageCommandGeneration() - 1, false);
  const own = watch(), owned = own.handOff();
  await fixture.link.post(...echo(1));
  assert.deepEqual(await owned, {}, "an uncontended echo proves the admission");
  own.stop();
  const contended = watch(), outcome = contended.handOff();
  await fixture.link.post({ type: "stdout", ch: fixture.ch, line: JSON.stringify({ type: "peer_message_command" }) }, ...echo(2));
  assert.equal((await outcome).mayHaveBeenSent, true, "a peer's admission makes the echo ambiguous");
  contended.stop();
});

test("a failed advisor replacement after the old child exited reports the exit and drops the dead wrapper", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { failReplace: true });
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(fixture.link.id));
  const events = [];
  const off = session.onEvent(event => events.push(event.type));
  await assert.rejects(startRpcSession(id, launch(id).sessionFile, "/w", undefined, true, "/w", undefined, hub.getHost(fixture.link.id)), /omp exited during startup/);
  off();
  assert.ok(events.includes("process_exit"));
  await until(() => getRpcSession(id) === undefined, "dead wrapper removed");
});

test("an edit another web app holds the lease for fails session_busy before any preflight read", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id, { leaseBusy: true });
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(fixture.link.id));
  const reads = () => fixture.messages.filter(message => message.type === "stdin" && JSON.parse(message.line).type === "get_state").length;
  const before = reads();
  await assert.rejects(session.send({ type: "edit_message", entryId: "u1" }), { code: "session_busy" });
  assert.equal(reads(), before, "no preflight ran without the lease");
  assert.deepEqual(fixture.leases, [true], "a lease it never got is not released");
  assert.equal(session.isEditingHistory(), false);
});

test("a pre-release v7 daemon without editLease still lets the edit run", async (t) => {
  const id = sessionId();
  const fixture = await sharedLink(t, id);
  const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(fixture.link.id));
  session.proc.transport.setEditing = async () => { throw new HostOpError(501, "unknown_op", "Unknown host op: editLease"); };
  const editing = session.send({ type: "edit_message", entryId: "u1" });
  await until(() => fixture.messages.some(message => message.type === "stdin" && JSON.parse(message.line).type === "get_state" && session.isEditingHistory()), "preflight ran");
  await editing.catch(() => {});
});

test("a host's planned stop closes the wrapper quietly; a crash is still reported", async (t) => {
  const { getExitedRpcSession } = await import("../rpc-manager.ts");
  for (const [reason, reported] of [["abandoned", false], [undefined, true]]) {
    const id = sessionId();
    const fixture = await sharedLink(t, id);
    const { session } = await startRpcSession(id, launch(id).sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(fixture.link.id));
    const notices = [];
    const off = session.onEvent(event => { if (event.type === "notice" && event.level === "error") notices.push(event); });
    await fixture.link.post({ type: "exit", ch: fixture.ch, code: 143, signal: null, ...(reason ? { reason } : {}) });
    await until(() => getRpcSession(id) === undefined, "wrapper closed");
    off();
    assert.equal(Boolean(getExitedRpcSession(id)), reported);
    assert.equal(notices.length > 0, reported);
  }
});
