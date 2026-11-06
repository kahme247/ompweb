import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "omp-hub-v7-"));
process.env.PI_CODING_AGENT_DIR = dir;
const hub = await import("./hub.ts");
const { RpcProcess } = await import("../omp/rpc-process.ts");
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
const result = (ch, extras = {}) => ({ ch, joined: true, pending: [], streaming: null, cwd: "/w", fellBack: false, launchAdvisor: false, autoApproveExtension: false, ...extras });

async function sharedLink(t, id, { listed = false, pending = [], streaming = null, state = {}, fail = null } = {}) {
  const ch = `shared-${id}`;
  const link = await linkHost(`Shared ${id}`, {
    hello: { v: 7, link: { id: "l1", notifier: true } },
    channels: listed ? [{ ch, sessionId: id, cwd: "/w", pending }] : [],
  });
  const messages = [];
  const opens = [];
  const closes = [];
  const child = ompChild(link, id, { state, fail });
  const serving = link.serve({
    open(args) { opens.push(args); return result(ch, { pending, streaming }); },
    close({ ch }) { closes.push(ch); return {}; },
    sessionFileExists() { return true; },
    invalidateSessionLists() { return null; },
  }, async (message) => {
    messages.push(message);
    if (message.type === "kill") await link.post({ type: "exit", ch, code: 0, signal: null });
    else await child(message);
  });
  t.after(async () => {
    await getRpcSession(id)?.destroyAndWait();
    hub.closeHostLink(link.id);
    await serving;
  });
  return { link, ch, messages, opens, closes };
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
  const registration = spawned.transport.setHostTools([{ name: "open_url", description: "Open", parameters: { type: "object", properties: {} } }], ["browser"]);
  await registration;
  await assert.rejects(spawned.transport.setHostTools([{ name: "broken", parameters: [] }], ["browser"]), error => error.status === 400);
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
  assert.deepEqual(sent.find(m => m.type === "host_tools").schemes, ["browser"]);
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
  assert.deepEqual(messages.filter(message => message.type === "host_tools").at(-1).schemes, ["browser"]);
  const forbidden = new Set(["negotiate_protocol", "set_event_filter", "set_subagent_subscription", "set_ask_dialog", "set_host_tools", "set_host_uri_schemes"]);
  assert.deepEqual(messages.filter(message => message.type === "stdin" && forbidden.has(JSON.parse(message.line).type)), []);
});
