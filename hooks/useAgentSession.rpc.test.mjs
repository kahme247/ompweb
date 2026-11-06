import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { existsSync, readFileSync } from "node:fs";
import { mock } from "bun:test";
const { act, cleanup, fireEvent, render, renderHook, within } = await import("@testing-library/react/pure.js");

// useAgentSession is the chat state machine. These tests drive it through a
// controllable fake shared-worker event stream + fetch router mounted via React
// Testing Library: connection, streaming, terminal events, late/duplicate
// frames, reconnect, and unmount — not source-string checks.


// ---------------------------------------------------------------------------
// Fake shared-worker event streams + fetch router
// ---------------------------------------------------------------------------
/** One stream the hook opened through lib/event-stream.ts, as the worker sees it. */
class FakeStream {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(port, id, channel) {
    this.port = port;
    this.id = id;
    this.channel = channel;
    this.readyState = FakeStream.CONNECTING;
    this.closedByCaller = false;
    // The hook's `running` subscription is not a session observer: tests count those.
    (channel.kind === "running" ? world.runningStreams : world.esInstances).push(this);
  }
  deliver(message) {
    this.port.onmessage?.({ data: { id: this.id, ...message } });
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeStream.OPEN;
    this.deliver({ type: "open" });
    const sid = this.channel.sessionId;
    this.deliver({ type: "message", data: JSON.stringify({ type: "connected", web: world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 } }) });
    void dispatchOutbox();
  }
  emit(event, { persist = true } = {}) {
    if (this.closedByCaller) return;
    const sid = this.channel.sessionId;
    const previous = world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 };
    const web = event.web ?? { ...previous, sequence: previous.sequence + 1 };
    world.streams.set(sid, web);
    if (event.type === "agent_start") this.running = true;
    this.deliver({ type: "message", data: JSON.stringify({ ...event, web }) });
    // Native message_end precedes appendMessage; make that persistence explicit.
    if (event.type === "message_end" && persist && this.running) appendEntry(sid, event.message);
    if (event.type === "agent_end" && event.isTerminal !== false) this.running = false;
  }
  failFatal() {
    // Fatal subscription error (409 unmanaged wrapper): CLOSED + onerror.
    if (this.closedByCaller) return;
    this.readyState = FakeStream.CLOSED;
    this.deliver({ type: "error", readyState: FakeStream.CLOSED });
  }
  dropRecoverably() {
    // The connection drops and will reconnect: the server already lost this subscription.
    if (this.closedByCaller) return;
    this.readyState = FakeStream.CONNECTING;
    this.deliver({ type: "error", readyState: FakeStream.CONNECTING });
  }
}

/** The port of the worker the tab's transport started; tests flip its transport. */
let workerPort = null;

/** Speaks the tab<->worker protocol of lib/event-stream-worker.ts. */
class FakeSharedWorker {
  constructor() {
    const streams = new Map();
    this.port = {
      onmessage: null,
      start() {},
      postMessage: (message) => {
        if (message.op === "open") {
          streams.set(message.id, new FakeStream(this.port, message.id, message.channel));
        } else if (message.op === "close") {
          const stream = streams.get(message.id);
          if (!stream) return;
          stream.closedByCaller = true;
          stream.readyState = FakeStream.CLOSED;
        } else if (message.op === "cmd") {
          void answerCommand(this.port, message);
        } else if (message.op === "outbox_add") {
          // The worker's IndexedDB commit, then the server's dispatcher (lib/message-outbox.ts) once omp is observed.
          world.lastOutboxAdd = message;
          const commit = () => {
            world.outbox.push(message.entry);
            this.port.onmessage?.({ data: { outbox: world.outbox.map((entry) => ({ ...entry, state: "sending" })) } });
            this.port.onmessage?.({ data: { outboxAdded: message.n } });
            void dispatchOutbox();
          };
          if (world.outboxCommit) world.outboxCommit(commit);
          else commit();
        } else if (message.op === "outbox_drop") {
          const commit = (error) => {
            if (!error) {
              world.outbox = world.outbox.filter((entry) => entry.id !== message.id);
              this.port.onmessage?.({ data: { outbox: world.outbox.map((entry) => ({ ...entry, state: entry.state ?? "sending" })) } });
            }
            this.port.onmessage?.({ data: { outboxDropped: message.n, ...(error ? { error } : {}) } });
          };
          if (world.outboxDrop) world.outboxDrop(commit);
          else commit();
        }
      },
    };
    workerPort = this.port;
  }
}

/** A command over the session socket: `world.socketAnswer` may answer it as the worker would (e.g. transport_lost), else the agent route does. */
async function answerCommand(port, { n, sessionId, advisor, body }) {
  let answer = await world.socketAnswer?.(JSON.parse(body));
  if (!answer) {
    const res = await fetchStub(`/api/agent/${encodeURIComponent(sessionId)}${advisor ? "?advisor=1" : ""}`, { method: "POST", body });
    answer = { status: res.status, body: await res.json() };
  }
  port.onmessage?.({ data: { cmd: n, recvAt: null, repliedAt: null, attempts: 1, deduped: false, behindBytes: 0, ...answer } });
}

/** The web server's dispatcher, as the hook sees it: each held entry goes, oldest first, as the omp command its mode
 * maps to once the session's stream is open (`world.outboxHold` keeps them held). */
async function dispatchOutbox(withoutTab = false) {
  while (!world.outboxHold) {
    const stream = (sid) => world.esInstances.findLast((es) => es.channel.sessionId === sid && es.readyState === FakeStream.OPEN && !es.closedByCaller);
    const entry = world.outbox.find((held) => withoutTab || stream(held.sessionId));
    if (!entry) return;
    world.outbox.splice(world.outbox.indexOf(entry), 1);
    workerPort?.onmessage?.({ data: { outbox: world.outbox.map((held) => ({ ...held, state: "sending" })) } });
    const running = stream(entry.sessionId)?.running;
    const slash = running && entry.message.startsWith("/");
    const type = slash || (entry.mode === "prompt" && !running) ? "prompt" : entry.mode === "steer" && running ? "steer" : "follow_up";
    const body = {
      type,
      message: entry.message,
      ...(slash ? { streamingBehavior: entry.mode === "steer" ? "steer" : "followUp" } : {}),
      ...(entry.images ? { images: entry.images } : {}),
      ...(entry.uploads ? { uploads: entry.uploads } : {}),
    };
    await fetchStub(`/api/agent/${encodeURIComponent(entry.sessionId)}`, { method: "POST", body: JSON.stringify(body) });
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

// Backend snapshot the router serves. Tests mutate these between phases.
const world = {
  esInstances: [],
  runningStreams: [],
  calls: [],
  holds: [], // { match(method, url, body), produce: () => Promise<{ status, value }> }
  sessions: new Map(), // sid -> { leafId, messages, entryIds }
  agents: new Map(), // sid -> { running, state }
  subagentSnapshots: new Map(), // sid -> SubagentSnapshotLike[]
  streams: new Map(),
  live: new Map(),
  views: new Map(),
  contextUnavailable: false,
  wrappers: new Map(),
  nativeHistories: new Map(), // isolated, parent-linked native history fixtures
  btwHistory: new Map(), // sid -> BtwRecord[] served by get_btw_history
  outbox: [], // held entries the fake dispatcher has not sent yet
  outboxHold: false,
  outboxCommit: null, // a test may hold the worker's durable-commit acknowledgement
  outboxDrop: null,
};

async function fetchStub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  const body = typeof init.body === "string" ? safeParse(init.body) : null;
  world.calls.push({ method, url: u, body });

  for (let i = 0; i < world.holds.length; i++) {
    if (world.holds[i].match(method, u, body)) {
      const h = world.holds.splice(i, 1)[0];
      const { status = 200, value } = await h.produce();
      return jsonResponse(status, value);
    }
  }

  let m;
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/state/))) {
    const wrapper = world.wrappers.get(decodeURIComponent(m[1]));
    if (wrapper) return jsonResponse(200, { running: wrapper.isAlive(), state: await wrapper.send({ type: "get_state" }), outboxScope: "test-scope" });
    const a = world.agents.get(decodeURIComponent(m[1])) ?? { running: false, state: {} };
    return jsonResponse(200, { running: a.running, state: a.state, outboxScope: "test-scope" });
  }
  if (/\/api\/sessions\/[^/?#]+\/subagents/.test(u)) {
    return jsonResponse(200, { subagents: [] });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/context/)) && method === "GET") {
    const sid = decodeURIComponent(m[1]);
    if (world.contextUnavailable) return jsonResponse(503, {});
    const params = new URL(u, "http://localhost").searchParams;
    const f = world.views.get(`${sid}:${params.get("leafId") ?? ""}:${params.has("includePreCompaction")}`)
      ?? world.sessions.get(sid);
    if (!f) return jsonResponse(404, {});
    if (params.get("boundary") === "1") return jsonResponse(200, { entryIds: [...f.entryIds] });
    const context = { todoPhases: [], thinkingLevel: "off", model: null, ...f };
    if (!params.has("sync")) return jsonResponse(200, { context });
    return jsonResponse(200, {
      ...selectSessionHistory(context, params.has("cursor") ? JSON.parse(params.get("cursor")) : null),
      sessionId: sid,
      leafId: params.get("leafId") ?? f.leafId,
      live: params.has("leafId") ? null : structuredClone(world.wrappers.get(sid)?.getStreamSnapshot() ?? world.live.get(sid) ?? null),
    });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/)) && method === "GET") {
    if (world.contextUnavailable) return jsonResponse(503, {});
    const f = world.sessions.get(decodeURIComponent(m[1]));
    if (!f) return jsonResponse(404, {});
    return jsonResponse(200, {
      sessionId: decodeURIComponent(m[1]), filePath: f.filePath ?? "/fixture/session.jsonl", tree: f.tree ?? [],
      leafId: f.leafId,
      context: { todoPhases: [], thinkingLevel: "off", model: null, ...f },
    });
  }
  if (/^\/api\/models/.test(u)) {
    return jsonResponse(200, world.models ?? { models: {}, modelList: [], defaultModel: null });
  }
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    if (method === "POST" && body?.type === "outbox_scope") return jsonResponse(200, { success: true, data: { scope: "test-scope" } });
    const sid = decodeURIComponent(m[1]);
    const wrapper = world.wrappers.get(sid);
    if (wrapper) {
      if (method === "GET") return jsonResponse(200, { running: wrapper.isAlive(), state: await wrapper.send({ type: "get_state" }) });
      if (method === "POST") return jsonResponse(200, { success: true, data: await wrapper.send(safeParse(init.body)) });
    }
    if (method === "GET") {
      const a = world.agents.get(sid) ?? { running: false, state: {} };
      return jsonResponse(200, { running: a.running, state: a.state });
    }
    if (method === "POST") {
      const nativeHistory = world.nativeHistories.get(sid);
      if (nativeHistory && ["edit_message", "prompt"].includes(body?.type)) return nativeHistory.command(body);
      if (body?.type === "get_subagents") {
        return jsonResponse(200, { success: true, data: { subagents: world.subagentSnapshots.get(sid) ?? [] } });
      }
      if (body?.type === "get_btw_history") {
        return jsonResponse(200, { success: true, data: { records: world.btwHistory.get(sid) ?? [] } });
      }
      // omp before abort_and_restore_queue rejects it (its real wording), which keeps the
      // per-entry withdrawal tests on their fallback path; tests of the atomic
      // path set what omp hands back.
      if (body?.type === "abort_and_restore_queue") {
        return world.abortRestoreQueue
          ? jsonResponse(200, { success: true, data: world.abortRestoreQueue })
          : jsonResponse(400, { error: "Unknown command: abort_and_restore_queue", code: "rpc_command_failed" });
      }
      return jsonResponse(200, { success: true, data: {} });
    }
  }
  return jsonResponse(404, {});
}

// Keep real DOM event targets and storage; only browser state and network
// boundaries need doubles. Hidden tabs use the coalescer's 50ms timer.
let visibilityState = "hidden";
const overrides = [
  [globalThis, "SharedWorker", { value: FakeSharedWorker }],
  [globalThis, "fetch", { value: fetchStub }],
  [globalThis, "ResizeObserver", { value: class { observe() {} disconnect() {} } }],
  [window.HTMLElement.prototype, "scrollIntoView", { value() {} }],
  [document, "hidden", { get: () => visibilityState === "hidden" }],
  [document, "visibilityState", { get: () => visibilityState }],
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: false, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

// Track both the render handle and its committed React lifetime. Clearing a
// handle registry alone cannot prove that every actual root was unmounted.
const mountedOwners = new Set();
const mountedRoots = new Set();

function TestRoot({ children }) {
  const owner = React.useRef(null);
  React.useLayoutEffect(() => {
    mountedRoots.add(owner);
    return () => { mountedRoots.delete(owner); };
  }, []);
  return children;
}

function ownRoot(view) {
  const unmount = view.unmount;
  view.unmount = () => {
    if (!mountedOwners.delete(view.unmount)) return;
    unmount();
  };
  mountedOwners.add(view.unmount);
  return view;
}

beforeEach(() => {
  visibilityState = "hidden";
  localStorage.clear();
  sessionStorage.clear();
  for (const { target, key, replacement } of overrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
});

afterEach(async () => {
  try {
    await act(async () => {
      try {
        for (const unmount of mountedOwners) unmount();
      } finally {
        mountedOwners.clear();
        cleanup();
      }
    });
    assert.equal(mountedRoots.size, 0, "every committed React root must unmount before restoring the browser doubles");
    assert.equal(world.esInstances.some((stream) => !stream.closedByCaller && stream.readyState !== FakeStream.CLOSED), false,
      "no hook-owned observer may remain live at teardown, including unopened connections");
  } finally {
    for (const { target, key, original } of overrides) {
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
    localStorage.clear();
    sessionStorage.clear();
  }
});

// The hook chain includes components/ui/toast.tsx, whose DOM toasts must never fire in tests.
mock.module("@/components/ui/toast", () => import("./__fixtures__/toast-stub.mjs"));
const { useAgentSession } = await import("../hooks/useAgentSession.ts");
const { selectSessionHistory } = await import("@/lib/session-sync");
const { publishSessionsChanged } = await import("@/lib/session-change-bus");
const { AgentSessionWrapper } = await import("@/lib/rpc-manager");
// Wrappers built directly need an online host: this machine's, as its daemon answers, minus spawning.
const onlineHost = {
  id: "local",
  label: "This machine",
  sessionOps: {},
  status: () => "online",
  onStatus: () => () => {},
  spawnRpc: async () => { throw new Error("this test never spawns"); },
  sessionFileExists: async (path) => existsSync(path),
  invalidateSessionLists() {},
  autoApproveExtension: () => false,
};
const { isUnknownSlashCommand, slashCommandName, runHostTool } = await import("@/hooks/useAgentSession-stream");
const { toastCalls } = await import("@/components/ui/toast");
const { MessageView } = await import("@/components/MessageView");
const { translate } = await import("@/lib/i18n");
const { ChatWindow } = await import("@/components/ChatWindow");
const { SESSION_EDIT_COMMAND, SESSION_EDIT_RESPONSE_PREFIX } = await import("@/lib/omp/session-edit-extension.mjs");
// Edit only opens a confirm dialog; the edit starts from its confirm button.
async function confirmEdit(view, button) {
  await act(async () => { fireEvent.click(button); });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: translate("messageView.editFromHere") })); });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run pending timers/microtasks inside act so state updates are flushed. */
async function settle(ms = 120) {
  await act(async () => {
    await sleep(ms);
  });
}

function sessionInfo(sid) {
  return {
    id: sid,
    path: "",
    cwd: "/workspace",
    name: `session ${sid}`,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "loaded question",
  };
}

async function mountSession(sid, onAgentEnd, options = {}, strictMode = false) {
  const session = sid === null ? null : sessionInfo(sid);
  let changeLeaf;
  const onBranchDataChange = (tree, leaf, handler) => {
    changeLeaf = handler;
    options.onBranchDataChange?.(tree, leaf, handler);
  };
  const { result, unmount } = ownRoot(renderHook(() => useAgentSession({
    session, newSessionCwd: null, ...(onAgentEnd ? { onAgentEnd } : {}), ...options,
    onBranchDataChange,
  }), { reactStrictMode: strictMode, wrapper: TestRoot }));
  await settle(); // hydration: loadSession + /state + models + subagents
  return {
    unmount,
    changeLeaf: (leafId) => changeLeaf(leafId),
    get latest() {
      return result.current;
    },
  };
}

function lastEs() {
  return world.esInstances[world.esInstances.length - 1];
}

function callsTo(method, urlPart) {
  return world.calls.filter((c) => c.method === method && c.url.includes(urlPart));
}

function resetWorld() {
  world.esInstances.length = 0;
  world.runningStreams.length = 0;
  world.calls.length = 0;
  world.holds.length = 0;
  world.sessions.clear();
  world.agents.clear();
  world.subagentSnapshots.clear();
  sessionStorage.clear();
  world.streams.clear();
  world.live.clear();
  world.views.clear();
  world.contextUnavailable = false;
  world.models = undefined;
  world.wrappers.clear();
  world.nativeHistories.clear();
  world.btwHistory.clear();
  world.abortRestoreQueue = null;
  world.outbox.length = 0;
  world.outboxHold = false;
  world.outboxCommit = null;
  world.outboxDrop = null;
  workerPort?.onmessage?.({ data: { outbox: [] } });
}

function primeSession(sid, messages) {
  world.sessions.set(sid, {
    leafId: String(messages.length),
    messages,
    entryIds: messages.map((_, i) => `e${i}`),
  });
  world.agents.set(sid, { running: false, state: {} });
}

function saveSession(sid, messages, entryIds = messages.map((_, i) => `e${i}`)) {
  world.sessions.set(sid, { leafId: entryIds.at(-1) ?? null, messages, entryIds });
}

function appendEntry(sid, message) {
  const previous = world.sessions.get(sid);
  saveSession(sid, [...previous.messages, message], [...previous.entryIds, `e${previous.entryIds.length}`]);
}

const userMsg = (id, text) => ({ role: "user", id, content: text, timestamp: 1 });
const assistantMsg = (id, text) => ({
  role: "assistant",
  id,
  provider: "test",
  model: "test-model",
  content: [{ type: "text", text }],
});

/** Mount + hydrate, then send a prompt and open the stream: the outbox dispatches it and omp starts the turn. */
async function startRun(sid, message, strictMode = false, options = {}) {
  const w = await mountSession(sid, undefined, options, strictMode);
  assert.equal(w.latest.loading, false, "hydration must complete");
  assert.equal(w.latest.agentRunning, false);

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend(message);
    await sleep(30);
  });
  const es = lastEs();
  assert.ok(es, "an event stream must have been opened");
  assert.deepEqual(es.channel, { kind: "session", sessionId: sid });
  await act(async () => {
    es.open(); // the dispatcher sees the session observed → prompt POST fires
    assert.deepEqual(await sendPromise, { status: "accepted" });
    await sleep(10);
  });
  assert.equal(callsTo("POST", "/api/agent/").some((c) => c.body?.type === "prompt" && c.body?.message === message), true, "prompt command must be sent");
  await act(async () => {
    es.emit({ type: "agent_start" });
    await Promise.resolve();
  });
  assert.equal(w.latest.agentRunning, true, "omp's agent_start starts the run");
  return { w, es };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// omp owns the queue. The panel shows its snapshot — on load (get_state, so a
// reload or another device sees the same chips) and live via queue_update —
// never a local guess about what the RPC did.
test("the queue panel shows omp's snapshot on load and follows queue_update, not local sends", async () => {
  resetWorld();
  primeSession("queue-snapshot", [userMsg("u0", "q")]);
  world.agents.set("queue-snapshot", { running: true, state: { queuedMessages: { steering: ["from another device"], followUp: [] } } });
  const { w, es } = await startRun("queue-snapshot", "run");
  assert.deepEqual(w.latest.queuedMessages, { steering: ["from another device"], followUp: [] });
  await act(async () => { await w.latest.handleFollowUp("later"); });
  assert.deepEqual(w.latest.queuedMessages, { steering: ["from another device"], followUp: [] }, "an acknowledged send is not a queue entry yet");
  await act(() => es.emit({ type: "queue_update", steering: ["from another device"], followUp: ["later"] }));
  assert.deepEqual(w.latest.queuedMessages, { steering: ["from another device"], followUp: ["later"] });
  await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["later"] }));
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["later"] });
});

test("upload ids ride the prompt and follow-up bodies; a files-only prompt is sent", async () => {
  resetWorld();
  primeSession("uploads", [userMsg("u0", "q")]);
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const w = await mountSession("uploads");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("", undefined, [id]);
    await sleep(30);
  });
  await act(async () => {
    lastEs().open();
    await sending;
  });
  const prompt = callsTo("POST", "/api/agent/").find((call) => call.body?.type === "prompt");
  assert.deepEqual(prompt?.body.uploads, [id]);
  await act(async () => { await w.latest.handleFollowUp("and this", undefined, [id]); });
  assert.deepEqual(callsTo("POST", "/api/agent/").find((call) => call.body?.type === "follow_up")?.body.uploads, [id]);
});

test("upload continuity: an uploaded file reaches held outbox intent after a real ChatWindow remount", async (t) => {
  resetWorld();
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "proof-upload-remount";
  t.after(() => clearDraft(sid));
  primeSession(sid, [userMsg("u0", "before")]);
  world.outboxHold = true;
  world.holds.push(
    { match: (method, url) => method === "POST" && url === "/api/uploads", produce: async () => ({ value: { received: 0 } }) },
    { match: (method, url) => method === "PUT" && url.startsWith("/api/uploads/"), produce: async () => ({ value: { received: 8, done: true, proof: "accepted-completion-proof" } }) },
  );
  const chatInputRef = React.createRef();
  const mount = async () => {
    const view = ownRoot(render(React.createElement(ChatWindow, {
      session: sessionInfo(sid), newSessionCwd: null, chatInputRef,
    }), { wrapper: TestRoot }));
    await settle();
    return view;
  };
  const first = await mount();
  await act(async () => {
    chatInputRef.current.addFiles([new File([new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])], "proof.zip", { type: "application/zip" })]);
  });
  await until(() => getDraft(sid)?.uploads?.length === 1, "the completed file must reach the draft");
  const id = getDraft(sid).uploads[0].id;
  await act(() => first.unmount());
  const second = await mount();
  assert.ok(second.getByText("proof.zip"), "the remounted real composer owns the completed attachment");
  await act(async () => { fireEvent.keyDown(second.getByRole("textbox"), { key: "Enter" }); });
  await until(() => world.outbox.length === 1, "Send must commit the file-only message to the worker");
  assert.deepEqual(world.outbox[0].uploads, [id]);
  assert.deepEqual(world.outbox[0].uploadProofs, { [id]: "accepted-completion-proof" }, "the durable intent retains completion authority, not just the chip");
  assert.equal(getDraft(sid), null, "the stored intent consumes the unchanged draft");
  await act(() => second.unmount());
  await mount();
  assert.deepEqual(world.outbox[0].uploadProofs, { [id]: "accepted-completion-proof" }, "a new hook lifetime cannot strip the held intent");
});

for (const [preference, mode] of [["steer", "steer"], ["followup", "followUp"]]) {
  test(`upload continuity: real composer ${mode} preserves completed proof in held intent`, async (t) => {
    resetWorld();
    const { setDraft, getDraft, clearDraft } = await import("@/lib/draft-store");
    const sid = `proof-queue-${mode}`;
    t.after(() => clearDraft(sid));
    primeSession(sid, [userMsg("u0", "before")]);
    world.agents.set(sid, { running: true, state: { isStreaming: true, isPromptRunning: true } });
    world.outboxHold = true;
    localStorage.setItem("omp-web:submit-during-run", preference);
    setDraft(sid, { value: "with my file", images: [], files: [], uploads: [{ id: "queue-upload", name: "queued.zip", size: 8, hostId: "local", proof: "queue-completion-proof" }] });
    const view = ownRoot(render(React.createElement(ChatWindow, { session: sessionInfo(sid), newSessionCwd: null }), { wrapper: TestRoot }));
    await settle();
    await act(async () => { lastEs()?.open(); });
    await settle();
    await act(async () => { fireEvent.keyDown(view.getByRole("textbox"), { key: "Enter" }); });
    await until(() => world.outbox.length === 1, "queue submission must reach worker storage");
    assert.equal(world.outbox[0].mode, mode);
    assert.deepEqual(world.outbox[0].uploadProofs, { "queue-upload": "queue-completion-proof" });
    assert.equal(getDraft(sid), null, "the real composer clears only after its intent is stored");
  });
}

test("a shell-queued outbox prompt and steer use queue_update without a phantom turn or reply notice", async () => {
  resetWorld();
  primeSession("bash-queue", [userMsg("u0", "q")]);
  // The agent route answers a prompt/steer with this while a `!!` shell command
  // owns the session (see lib/rpc-manager.ts).
  const queuedReply = { success: true, data: { queued: true, queue: "followUp", reason: "shellRunning" } };
  const holdReply = () => world.holds.push({
    match: (method, _url, body) => method === "POST" && (body?.type === "prompt" || body?.type === "steer"),
    produce: () => Promise.resolve({ value: queuedReply }),
  });
  holdReply();
  holdReply();
  const w = await mountSession("bash-queue");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("after the shell finishes");
    await sleep(30);
  });
  await act(async () => { lastEs()?.open(); await sending; });
  assert.equal((await sending).status, "accepted");
  assert.equal(w.latest.agentRunning, false, "no turn started behind the shell command");
  assert.deepEqual(
    w.latest.messages.filter((message) => message.role === "user").map((message) => message.content),
    ["q"],
    "the text lives in omp's queue, not in an optimistic bubble",
  );
  assert.deepEqual(w.latest.notices, [], "the dispatcher reply never creates a tab-owned queue notice");
  await act(async () => { await w.latest.handleSteer("steer instead"); });
  await act(() => lastEs().emit({ type: "queue_update", steering: [], followUp: ["after the shell finishes", "steer instead"] }));
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["after the shell finishes", "steer instead"] });
  assert.deepEqual(w.latest.notices, []);
});

test("queued cancellation reports omp's answer and leaves the chip to the snapshot", async (t) => {
  for (const outcome of [
    {
      name: "removed",
      response: { value: { success: true, data: { removed: true, images: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { bogus: true }] } } },
      result: [{ data: "AAAA", mimeType: "image/png" }],
      notices: [],
    },
    { name: "not pending", response: { value: { success: true, data: { removed: false } } }, result: false, notices: ["warning"] },
    { name: "unsupported", response: { status: 400, value: { error: "Unknown RPC command: remove_queued_message" } }, result: false, notices: ["error"] },
  ]) {
    await t.test(outcome.name, async () => {
      resetWorld();
      const sid = `cancel-${outcome.name.replace(" ", "-")}`;
      primeSession(sid, [userMsg("u0", "q")]);
      const { w, es } = await startRun(sid, "run");
      await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["target", "target"] }));
      let release;
      world.holds.push({
        match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
        produce: () => new Promise((resolve) => { release = resolve; }),
      });
      let first;
      let second;
      await act(async () => {
        first = w.latest.removeQueuedMessage("target", "followUp");
        second = w.latest.removeQueuedMessage("target", "followUp");
      });
      assert.equal(await second, false, "an overlapping click cannot cancel the duplicate");
      assert.deepEqual(world.calls.filter((c) => c.body?.type === "remove_queued_message").map((c) => c.body), [
        { type: "remove_queued_message", message: "target", queue: "followUp" },
      ]);
      await act(async () => {
        release(outcome.response);
        assert.deepEqual(await first, outcome.result);
      });
      assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["target", "target"] });
      assert.deepEqual(w.latest.notices.map((n) => n.type), outcome.notices);
    });
  }
});

test("Steer promotes through omp once and reports a refusal", async (t) => {
  for (const outcome of [
    { name: "promoted", response: { value: { success: true, data: { promoted: true } } }, notices: [] },
    { name: "not pending", response: { value: { success: true, data: { promoted: false } } }, notices: ["warning"] },
  ]) {
    await t.test(outcome.name, async () => {
      resetWorld();
      const sid = `promote-${outcome.name.replace(" ", "-")}`;
      primeSession(sid, [userMsg("u0", "q")]);
      const { w, es } = await startRun(sid, "run");
      await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["target", "target"] }));
      let release;
      world.holds.push({
        match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
        produce: () => new Promise((resolve) => { release = resolve; }),
      });
      const callsBefore = world.calls.length;
      let first;
      await act(async () => {
        first = w.latest.promoteQueuedToSteer("target");
        await w.latest.promoteQueuedToSteer("target");
      });
      assert.deepEqual(world.calls.slice(callsBefore).map((c) => c.body), [{ type: "promote_queued_message", message: "target" }],
        "one promotion, never a separate steer");
      await act(async () => {
        release(outcome.response);
        await first;
      });
      assert.deepEqual(w.latest.notices.map((n) => n.type), outcome.notices);
    });
  }
});

test("a promotion answered after navigation does not notify the new session", async () => {
  resetWorld();
  primeSession("old-promotion", [userMsg("u0", "old")]);
  primeSession("new-promotion", [userMsg("u1", "new")]);
  const { w: old, es } = await startRun("old-promotion", "run");
  await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["target"] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  let promotion;
  await act(async () => { promotion = old.latest.promoteQueuedToSteer("target"); });
  old.unmount();
  const current = await mountSession("new-promotion");
  await act(async () => {
    release({ status: 400, value: { error: "Native promotion failed" } });
    await promotion;
  });
  assert.deepEqual(current.latest.notices, []);
});

// Stop must neither lose a queued message nor let omp run it: omp starts a
// queued steer as soon as an abort lands (#130 saw follow-ups replay after the
// next reply). Withdraw first, like the TUI's Esc, and hand the text back.
test("Stop withdraws pending queued messages into the session draft before aborting", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-withdraw");
  primeSession("abort-withdraw", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-withdraw", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["my steer", "already taken"], followUp: ["my follow-up"] }));
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message" && body.message === "already taken",
    produce: async () => ({ value: { success: true, data: { removed: false } } }),
  });
  for (const message of ["my steer", "my follow-up"]) {
    world.holds.push({
      match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message" && body.message === message,
      produce: async () => ({ value: { success: true, data: { removed: true } } }),
    });
  }
  await act(async () => { await w.latest.handleAbort(); });
  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.ok(commands.lastIndexOf("remove_queued_message") < commands.indexOf("abort"), "the queue is withdrawn before the abort lands");
  assert.equal(getDraft("abort-withdraw")?.value, "my steer\n\nmy follow-up", "a message the model already took stays out of the draft");
  assert.deepEqual(w.latest.notices, []);
  clearDraft("abort-withdraw");
});

test("a slow withdrawal does not hold Stop, and its late answer still recovers the text", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-slow");
  primeSession("abort-slow", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-slow", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["slow steer"], followUp: [] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await sleep(1700);
  assert.equal(world.calls.some((c) => c.body?.type === "abort"), true, "abort goes out while the removal is still pending");
  await act(async () => {
    release({ value: { success: true, data: { removed: true } } });
    await stop;
  });
  assert.equal(getDraft("abort-slow")?.value, "slow steer");
  clearDraft("abort-slow");
});

test("Stop saves confirmed text early and still restores the queue in order", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-mixed");
  primeSession("abort-mixed", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-mixed", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["first", "second"], followUp: [] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message" && body.message === "first",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message" && body.message === "second",
    produce: async () => ({ value: { success: true, data: { removed: true } } }),
  });
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await sleep(1700);
  assert.equal(getDraft("abort-mixed")?.value, "second", "confirmed text is saved before the stalled request settles");
  await act(async () => {
    release({ value: { success: true, data: { removed: true } } });
    await stop;
  });
  assert.equal(getDraft("abort-mixed")?.value, "first\n\nsecond", "a late confirmation keeps queue order");
  clearDraft("abort-mixed");
});

test("Stop withdraws a follow-up that a concurrent promotion already moved to steering", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-promoted");
  primeSession("abort-promoted", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-promoted", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["promoted"] }));
  for (const [queue, removed] of [["followUp", false], ["steering", true]]) {
    world.holds.push({
      match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message" && body.queue === queue,
      produce: async () => ({ value: { success: true, data: { removed } } }),
    });
  }
  await act(async () => { await w.latest.handleAbort(); });
  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.ok(commands.lastIndexOf("remove_queued_message") < commands.indexOf("abort"));
  assert.equal(getDraft("abort-promoted")?.value, "promoted");
  assert.deepEqual(world.calls.filter((c) => c.body?.type === "remove_queued_message").map((c) => c.body.queue), ["followUp", "steering"]);
  clearDraft("abort-promoted");
});

test("a steering message the model already took is not looked for among follow-ups", async () => {
  resetWorld();
  primeSession("abort-taken", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-taken", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["taken"], followUp: [] }));
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: async () => ({ value: { success: true, data: { removed: false } } }),
  });
  await act(async () => { await w.latest.handleAbort(); });
  assert.deepEqual(world.calls.filter((c) => c.body?.type === "remove_queued_message").map((c) => c.body.queue), ["steering"]);
});

test("a cancellation omp confirms after unmount still reports success so Edit can recover the text", async () => {
  resetWorld();
  primeSession("cancel-unmount", [userMsg("u0", "q")]);
  const { w, es } = await startRun("cancel-unmount", "run");
  await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["target"] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  let cancellation;
  await act(async () => { cancellation = w.latest.removeQueuedMessage("target", "followUp"); });
  w.unmount();
  release({ value: { success: true, data: { removed: true } } });
  assert.deepEqual(await cancellation, [], "an omp that returns no images still confirms the removal");
});

test("a Stop whose run ended during the withdrawal does not abort the next prompt", async () => {
  resetWorld();
  primeSession("abort-fenced", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-fenced", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["late steer"], followUp: [] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  let sending;
  await act(async () => { sending = w.latest.handleSend("next prompt"); await sleep(30); });
  await act(async () => { lastEs().open(); await sending; });
  await act(async () => {
    release({ value: { success: true, data: { removed: true } } });
    await stop;
  });
  assert.equal(world.calls.some((c) => c.body?.type === "prompt" && c.body?.message === "next prompt"), true);
  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false, "the new prompt keeps running");
});

test("a delayed Stop does not abort a run another device started after the targeted run ended", async () => {
  resetWorld();
  primeSession("abort-remote", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-remote", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["late steer"], followUp: [] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  await act(async () => { es.emit({ type: "agent_start" }); }); // another device's prompt
  await settle();
  await act(async () => {
    release({ value: { success: true, data: { removed: true } } });
    await stop;
  });
  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false, "the other device's run keeps going");
});

test("a delayed Stop spares another device's run even when the targeted run ended with no visible answer", async () => {
  resetWorld();
  primeSession("abort-remote-empty", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-remote-empty", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["late steer"], followUp: [] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  // The empty-completion recovery reload stalls, so the hook never renders idle.
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith("/api/sessions/abort-remote-empty"),
    produce: () => new Promise(() => {}),
  });
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await act(async () => {
    es.emit({ type: "agent_end", isTerminal: true });
    es.emit({ type: "agent_start" }); // another device's prompt
  });
  await act(async () => {
    release({ value: { success: true, data: { removed: true } } });
    await stop;
  });
  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false, "the other device's run keeps going");
});

test("the agent_end snapshot clears a stale queue even when the wrapper reports no model", async () => {
  resetWorld();
  primeSession("end-no-model", [userMsg("u0", "q")]);
  const { w, es } = await startRun("end-no-model", "run");
  await act(() => es.emit({ type: "queue_update", steering: ["missed delivery"], followUp: [] }));
  // Keep the transcript reload's own state read out of the picture.
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/sessions/end-no-model/state",
    produce: () => new Promise(() => {}),
  });
  world.agents.set("end-no-model", { running: false, state: { queuedMessages: { steering: [], followUp: [] } } });
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: [] });
});

test("an older state response cannot overwrite a newer snapshot that arrived first", async () => {
  resetWorld();
  primeSession("queue-seq", [userMsg("u0", "q")]);
  const { w, es } = await startRun("queue-seq", "run");
  let releaseOlder;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/queue-seq",
    produce: () => new Promise((resolve) => { releaseOlder = resolve; }),
  });
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/queue-seq",
    produce: async () => ({ value: { running: true, state: { queuedMessages: { steering: ["pending"], followUp: [] } } } }),
  });
  await act(() => es.open()); // older snapshot request, held
  await act(() => es.open()); // newer reconnect snapshot, answers first
  await settle();
  assert.deepEqual(w.latest.queuedMessages, { steering: ["pending"], followUp: [] });
  await act(async () => {
    releaseOlder({ value: { running: true, state: { queuedMessages: { steering: [], followUp: [] } } } });
    await sleep(20);
  });
  assert.deepEqual(w.latest.queuedMessages, { steering: ["pending"], followUp: [] }, "the older response must not clear the chip");
});

test("overlapping Stops share one withdrawal and one abort", async () => {
  resetWorld();
  primeSession("abort-twice", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-twice", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["A", "B"], followUp: [] }));
  await act(async () => { await Promise.all([w.latest.handleAbort(), w.latest.handleAbort()]); });
  assert.deepEqual(world.calls.filter((c) => c.body?.type === "remove_queued_message").map((c) => c.body.message), ["A", "B"]);
  assert.equal(world.calls.filter((c) => c.body?.type === "abort").length, 1);
});

test("a stalled withdrawal from an earlier Stop does not swallow the next run's Stop", async () => {
  resetWorld();
  primeSession("abort-next", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-next", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: ["stalled"], followUp: [] }));
  let release;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  let first;
  await act(async () => { first = w.latest.handleAbort(); });
  await sleep(1700); // deadline passed, first abort sent, removal still pending
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
    es.emit({ type: "queue_update", steering: [], followUp: [] });
  });
  await settle();
  let sending;
  await act(async () => { sending = w.latest.handleSend("next prompt"); await sleep(30); });
  await act(async () => { lastEs().open(); await sending; });
  await act(async () => { await w.latest.handleAbort(); });
  assert.equal(world.calls.filter((c) => c.body?.type === "abort").length, 2, "the new run's Stop sends its own abort");
  await act(async () => {
    release({ value: { success: true, data: { removed: true } } });
    await first;
  });
});

test("a late follow-up refusal does not remove a same-text steer from a newer run", async () => {
  resetWorld();
  primeSession("abort-late-refusal", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-late-refusal", "hello agent");
  await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["same"] }));
  let refuse;
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message" && body.queue === "followUp",
    produce: () => new Promise((resolve) => { refuse = resolve; }),
  });
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await sleep(1700);
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
    es.emit({ type: "agent_start" }); // new run that queues its own "same" steer
  });
  await act(async () => {
    refuse({ value: { success: true, data: { removed: false } } });
    await stop;
  });
  assert.equal(world.calls.some((c) => c.body?.type === "remove_queued_message" && c.body.queue === "steering"), false);
});

test("a state snapshot older than a queue_update is dropped, and opening the stream re-reads the queue", async () => {
  resetWorld();
  primeSession("queue-order", [userMsg("u0", "q")]);
  const { w, es } = await startRun("queue-order", "run");
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/queue-order",
    produce: () => new Promise((resolve) => { release = resolve; }),
  });
  await act(() => es.open()); // reconnect: subscribe, then snapshot
  await act(() => es.emit({ type: "queue_update", steering: ["newer"], followUp: [] }));
  await act(async () => {
    release({ value: { running: true, state: { queuedMessages: { steering: [], followUp: [] } } } });
    await sleep(20);
  });
  assert.deepEqual(w.latest.queuedMessages, { steering: ["newer"], followUp: [] }, "the stale snapshot must not erase a newer chip");

  world.agents.set("queue-order", { running: true, state: { queuedMessages: { steering: ["queued while disconnected"], followUp: [] } } });
  await act(() => es.open());
  await settle();
  assert.deepEqual(w.latest.queuedMessages, { steering: ["queued while disconnected"], followUp: [] });
});

test("a settled cancellation releases the guard for the next one", async () => {
  resetWorld();
  primeSession("cancel-twice", [userMsg("u0", "q")]);
  const { w, es } = await startRun("cancel-twice", "run");
  await act(() => es.emit({ type: "queue_update", steering: [], followUp: ["one", "two"] }));
  await act(async () => {
    await w.latest.removeQueuedMessage("one", "followUp");
    await w.latest.removeQueuedMessage("two", "followUp");
  });
  assert.deepEqual(world.calls.filter((c) => c.body?.type === "remove_queued_message").map((c) => c.body.message), ["one", "two"]);
});

test("Stop with an empty queue sends no removal; a failed withdrawal still stops and warns", async () => {
  resetWorld();
  primeSession("abort-empty", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-empty", "hello agent");
  await act(async () => { await w.latest.handleAbort(); });
  assert.equal(world.calls.some((c) => c.body?.type === "remove_queued_message"), false);
  assert.deepEqual(w.latest.notices, []);

  await act(() => es.emit({ type: "queue_update", steering: ["my steer"], followUp: [] }));
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: async () => ({ status: 400, value: { error: "Unknown RPC command: remove_queued_message" } }),
  });
  await act(async () => { await w.latest.handleAbort(); });
  assert.equal(world.calls.filter((c) => c.body?.type === "abort").length, 2);
  assert.deepEqual(w.latest.notices.map((n) => n.type), ["warning"]);
});

test("an answered dialog handoff cannot clear the next unanswered request", async () => {
  resetWorld();
  primeSession("dialog-handoff", [userMsg("u0", "q")]);
  const { w, es } = await startRun("dialog-handoff", "ask me");
  const first = { type: "extension_ui_request", id: "first", method: "editor", title: "First question" };
  const next = { ...first, id: "next", title: "Next question" };
  await act(() => es.emit(first));
  await settle(300);
  assert.equal(w.latest.extensionDialog?.id, first.id, "unanswered requests have no clear timer");

  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "extension_ui_response",
    produce: () => acknowledgement,
  });
  let response;
  await act(async () => { response = w.latest.respondToExtensionUi(first, { value: "My answer" }); });
  await act(() => es.emit(next));
  await act(async () => {
    release({ value: { success: true, data: {} } });
    await response;
  });
  await settle(300);
  assert.equal(w.latest.extensionDialog?.id, next.id, "a delayed response timer only clears its own request");
});

for (const failure of ["HTTP rejection", "connection failure"]) {
  test(`a failed question response preserves the pending question for retry: ${failure}`, async () => {
    resetWorld();
    const sid = `answer-failure-${failure}`;
    primeSession(sid, [userMsg("u0", "q")]);
    const { w, es } = await startRun(sid, "ask");
    const request = { type: "extension_ui_request", id: "retry-answer", method: "editor", title: "Answer" };
    await act(() => es.emit(request));
    world.holds.push({
      match: (method, _url, body) => method === "POST" && body?.type === "extension_ui_response",
      produce: async () => {
        if (failure === "connection failure") throw new Error("connection lost");
        return { status: 500, value: { error: "answer delivery failed" } };
      },
    });
    await act(async () => { await w.latest.respondToExtensionUi(request, { value: "my retained answer" }); });
    await settle(300);
    assert.equal(w.latest.extensionDialog?.id, request.id, "failure must not unmount and erase the answer");
    assert.equal(w.latest.notices.at(-1)?.type, "error");
    await act(() => es.emit({ ...request }));
    assert.equal(w.latest.extensionDialog?.id, request.id);
    await act(async () => { await w.latest.respondToExtensionUi(request, { value: "my retained answer" }); });
    await settle(300);
    assert.equal(w.latest.extensionDialog, null, "a successful retry closes the answered question");
  });
}

test("a stale local queue action reports that its target is unavailable", async () => {
  resetWorld();
  primeSession("missing-local-target", [userMsg("u0", "q")]);
  const w = await mountSession("missing-local-target");
  await act(async () => {
    assert.equal(await w.latest.removeQueuedMessage("already delivered", "followUp"), false);
  });
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: [] });
  assert.equal(w.latest.notices.at(-1)?.type, "warning");
});

// ISSUE #167: omp reports 47 runnable builtins over RPC; `/guided-goal`,
// `/vibe`, `/budget` and `/goal` are TUI-only and absent from that list, so the
// client has to name them instead of letting them land as silent prompt text.
test("ISSUE #167 a command missing from omp's roster is reported, not run silently", () => {
  const known = ["add-dir", "compact", "model", "todo", "mcp", "session"];
  assert.equal(isUnknownSlashCommand("/guided-goal", known), true);
  assert.equal(isUnknownSlashCommand("/guided-goal ship the thing", known), true);
  assert.equal(isUnknownSlashCommand("/Goal", known), true, "matching is case-insensitive both ways");
  assert.equal(isUnknownSlashCommand("/todo", known), false);
  assert.equal(isUnknownSlashCommand("/compact now", known), false);
  // Builtins are hidden from the palette but still executed by omp.
  assert.equal(isUnknownSlashCommand("/shake", [...known, "shake"]), false);
  // No roster yet (or a failed fetch) is not evidence that anything is unknown.
  assert.equal(isUnknownSlashCommand("/guided-goal", []), false);
  // Not command-shaped, so never a false alarm on a path, URL or plain prose.
  for (const text of ["explain /guided-goal", "//host/path", "/1st thing", "plain text", ""]) {
    assert.equal(isUnknownSlashCommand(text, known), false, text);
    assert.equal(slashCommandName(text), null, text);
  }
  assert.equal(slashCommandName("  /guided-goal ship it  "), "guided-goal");
  assert.equal(slashCommandName("/todo"), "todo");
});

test("ISSUE #167 sending a TUI-only command warns once and still delivers the text", async () => {
  resetWorld();
  primeSession("tui-only", [userMsg("u0", "loaded question")]);
  const w = await mountSession("tui-only");
  // The roster arrives from omp; `/todo` is in it, `/guided-goal` is not.
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "get_commands",
    produce: () => ({ value: { success: true, data: { commands: [{ name: "todo", description: "todos", source: "builtin" }] } } }),
  });
  await act(async () => { await w.latest.loadSlashCommands(); });
  assert.deepEqual(w.latest.notices, [], "loading the roster is not itself a warning");

  const send = async (text) => {
    let pending;
    await act(async () => {
      pending = w.latest.handleSend(text);
      await sleep(30); // let the pre-connect get_state POST settle
    });
    const es = lastEs();
    await act(async () => { es.open(); await pending; });
    return es;
  };

  let es = await send("/guided-goal ship it");
  assert.deepEqual(
    w.latest.notices.map((n) => [n.type, n.message]),
    [["warning", "/guided-goal is not a command this session can run — it was sent as plain text. TUI-only commands (for example /guided-goal) only work in the omp terminal."]],
  );
  assert.equal(callsTo("POST", "/api/agent/").some((c) => c.body?.type === "prompt" && c.body?.message === "/guided-goal ship it"), true, "the text is not blocked");

  es.emit({ type: "agent_end", isTerminal: true });
  await settle();
  es = await send("/guided-goal again");
  assert.equal(w.latest.notices.length, 1, "the same name is not repeated");
  w.unmount();
});

test("full run over fake SSE: optimistic bubble, coalesced streaming, terminal reload", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("s1", "hello agent");

  // Run starts.
  await act(async () => {
    es.emit({ type: "agent_start" });
    await Promise.resolve();
  });
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.streamState.isStreaming, true);

  // omp echoes the prompt as a user message_end: it must REPLACE the
  // optimistic bubble, not duplicate it.
  await act(async () => {
    es.emit({ type: "message_end", message: userMsg("u1", "hello agent") });
    await Promise.resolve();
  });
  assert.equal(w.latest.messages.length, 2, "optimistic bubble replaced, not duplicated");

  // Two partial updates arrive above display rate; the coalescer must deliver
  // only the LATEST one (full-message frames, latest-wins).
  await act(async () => {
    es.emit({ type: "message_update", message: assistantMsg("a1", "hel") });
    es.emit({ type: "message_update", message: assistantMsg("a1", "hello world") });
    await Promise.resolve();
  });
  await settle(90); // > coalescer flush timer
  assert.equal(w.latest.streamState.isStreaming, true);
  assert.equal(w.latest.streamState.streamingMessage?.content?.[0]?.text, "hello world");

  // message_end commits the final message and resets the bubble.
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "hello world") });
    await Promise.resolve();
  });
  assert.equal(w.latest.streamState.isStreaming, false);
  assert.equal(w.latest.messages.length, 3, "assistant message appended");
  assert.equal(w.latest.messages[2]?.content?.[0]?.text, "hello world");

  // agent_end terminates the run and triggers the terminal reload.
  saveSession("s1", [
    userMsg("u0", "loaded question"),
    userMsg("u1", "hello agent"),
    assistantMsg("a1", "hello world"),
  ]);
  await act(async () => {
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  assert.equal(w.latest.agentRunning, false, "run must end");
  assert.equal(w.latest.streamState.isStreaming, false);
  assert.ok(
    callsTo("GET", "/api/sessions/s1").length >= 2,
    "agent_end must reload the transcript from the session file",
  );
});

test("a finished reply stays on screen until its saved copy replaces it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("s1", "hello agent");
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  const reply = { ...assistantMsg("a1", "hello world"), timestamp: 42 };
  await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
  await act(async () => { es.emit({ type: "message_update", message: reply }); await Promise.resolve(); });
  await settle(90);
  const shown = () => w.latest.streamState.streamingMessage?.content?.[0]?.text === "hello world";
  const saved = () => w.latest.messages.filter((m) => m.timestamp === 42).length;
  // The first read after message_end races omp's write: the reply is not
  // saved yet, and the server's live state has no message any more.
  saveSession("s1", [userMsg("u0", "loaded question"), userMsg("u1", "hello agent")]);
  const releaseSync = holdNextSync("s1", syncSnapshot("s1", liveSnapshot("s1", 99, null)));
  await act(async () => { es.emit({ type: "message_end", message: reply }); await Promise.resolve(); });
  // Dropping the reply before its saved copy arrives empties that space: the
  // chat jumps up to where the reply started, then back down.
  assert.ok(shown(), "the reply stays while the save is read");
  await act(async () => { releaseSync(); });
  await settle();
  assert.ok(shown(), "a read without the saved reply keeps it on screen");
  assert.equal(saved(), 0);
  world.agents.set("s1", { running: false, state: { isStreaming: false } });
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.ok(shown(), "the end of the run keeps it too");
  // The save lands; the next read hands the reply over to its saved copy.
  saveSession("s1", [userMsg("u0", "loaded question"), userMsg("u1", "hello agent"), reply]);
  await act(async () => { es.emit({ type: "message_end", message: userMsg("u2", "unrelated") }); });
  await settle();
  assert.equal(saved(), 1, "the saved copy is shown once");
  assert.equal(w.latest.streamState.streamingMessage, null, "the held reply gives way to its saved copy");
});

test("provider error on the assistant message is shown instead of ending silently", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");

  const providerError = "The provider rejected the request (HTTP 429)";
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({
      type: "message_end",
      message: {
        ...assistantMsg("a1", ""),
        content: [],
        stopReason: "error",
        errorMessage: providerError,
      },
    });
    es.emit({ type: "agent_end", isTerminal: true });
    await Promise.resolve();
  });
  await settle();

  assert.equal(w.latest.agentRunning, false);
  assert.ok(w.latest.notices.some((notice) => notice.message === providerError), "the provider error must be visible");
});

test("a silent idle transition shows a fallback error instead of disappearing", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startRun("s1", "q1");

  // Simulate the SSE terminal frame being lost while the server has already
  // gone idle. The online recovery path must still explain the empty stop.
  world.agents.set("s1", { running: false, state: {} });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await sleep(60);
  });
  await settle();

  assert.equal(w.latest.agentRunning, false);
  assert.ok(w.latest.notices.some((notice) => /stopped without returning a response/i.test(notice.message)));
});

for (const completion of ["visibilitychange", "agent_end"]) {
  test(`a saved response missed by SSE is recovered on ${completion} without a failure notice`, async () => {
    resetWorld();
    primeSession("s1", [userMsg("u0", "old question")]);
    const { w, es } = await startRun("s1", "new question");
    primeSession("s1", [
      userMsg("u0", "old question"),
      userMsg("u1", "new question"),
      assistantMsg("a1", "Completed while away"),
    ]);
    await act(async () => {
      if (completion === "agent_end") es.emit({ type: "agent_end", isTerminal: true });
      else {
        visibilityState = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
      }
      await sleep(60);
    });
    await settle();

    assert.equal(w.latest.agentRunning, false);
    assert.ok(w.latest.messages.some((m) => m.role === "assistant" && m.content[0]?.text === "Completed while away"));
    assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);
  });
}

test("an older answer does not hide a current run with only tool activity", async () => {
  resetWorld();
  const history = [userMsg("u0", "question"), assistantMsg("a0", "Old answer")];
  primeSession("s1", history);
  const { w } = await startRun("s1", "question");
  primeSession("s1", [...history, userMsg("u1", "question"), {
    ...assistantMsg("a1", ""),
    content: [{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: {} }],
  }]);
  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.notices.filter((n) => n.type === "error").length, 1);
});

test("a repeated prompt cannot reuse an old saved answer when the new prompt was not persisted", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "question"), assistantMsg("a0", "Old answer")]);
  const { w } = await startRun("s1", "question");
  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.notices.filter((n) => n.type === "error").length, 1);
});

test("recovery preserves a saved provider failure even after partial response content", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "old question")]);
  const { w } = await startRun("s1", "new question");
  const providerError = "Provider disconnected during generation";
  primeSession("s1", [
    userMsg("u0", "old question"),
    userMsg("u1", "new question"),
    { ...assistantMsg("a1", "Partial answer"), stopReason: "error", errorMessage: providerError },
  ]);
  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(w.latest.notices.filter((n) => n.type === "error").map((n) => n.message), [providerError]);
});

test("a failed transcript reload is retried instead of being classified as an empty response", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "old question")]);
  const { w } = await startRun("s1", "new question");
  primeSession("s1", [userMsg("u0", "old question"), userMsg("u1", "new question"), assistantMsg("a1", "Saved answer")]);
  world.contextUnavailable = true;
  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, true, "unknown completion must remain recoverable");
  assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);

  world.contextUnavailable = false;
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.ok(w.latest.messages.some((m) => m.role === "assistant" && m.content[0]?.text === "Saved answer"));
  assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);
});

for (const recovered of ["answer", "empty", "absent wrapper"]) {
  test(`a failed state read stays retryable until recovery confirms ${recovered}`, async () => {
    resetWorld();
    primeSession("s1", [userMsg("u0", "old question")]);
    const { w } = await startRun("s1", "new question");
    world.holds.push({
      match: (method, url) => method === "GET" && url === "/api/sessions/s1/state",
      produce: async () => ({ status: 503, value: {} }),
    });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    assert.equal(w.latest.agentRunning, true, "readable history does not prove the provider finished without a response");
    assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);

    if (recovered === "answer") {
      saveSession("s1", [userMsg("u0", "old question"), userMsg("u1", "new question"), assistantMsg("a1", "Recovered answer")]);
    } else if (recovered === "absent wrapper") {
      world.agents.set("s1", { running: false });
    }
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    assert.equal(w.latest.agentRunning, false);
    if (recovered === "answer") {
      assert.equal(w.latest.messages.at(-1).content[0].text, "Recovered answer");
      assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);
    } else {
      assert.equal(w.latest.notices.filter((n) => n.type === "error").length, 1);
    }
  });
}

for (const result of ["visible answer", "provider failure"]) {
  test(`${result} still settles when the state request fails`, async () => {
    resetWorld();
    primeSession("s1", [userMsg("u0", "old question")]);
    const { w } = await startRun("s1", "new question");
    const answer = assistantMsg("a1", "Visible response");
    if (result === "provider failure") Object.assign(answer, { stopReason: "error", errorMessage: "Provider rejected the request" });
    saveSession("s1", [userMsg("u0", "old question"), userMsg("u1", "new question"), answer]);
    world.holds.push({
      match: (method, url) => method === "GET" && url === "/api/sessions/s1/state",
      produce: async () => ({ status: 503, value: {} }),
    });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle();
    assert.equal(w.latest.agentRunning, false);
    assert.equal(w.latest.messages.at(-1).content[0].text, "Visible response");
    assert.deepEqual(w.latest.notices.filter((n) => n.type === "error").map((n) => n.message),
      result === "provider failure" ? ["Provider rejected the request"] : []);
  });
}

test("interrupt captures saved entries newer than the last rendered transcript", async () => {
    resetWorld();
    primeSession("s1", [userMsg("u0", "old question")]);
    const { w } = await startRun("s1", "question");
    primeSession("s1", [userMsg("u0", "old question"), userMsg("u1", "question"), assistantMsg("a1", "Previous answer")]);
    const fullReads = () => world.calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/sessions/s1?")).length;
    const promptCommands = () => world.calls.filter((c) => c.method === "POST" && ["prompt", "abort_and_prompt"].includes(c.body?.type)).length;
    const readsBefore = fullReads();
    const promptsBefore = promptCommands();
    let releaseBoundary;
    world.holds.push({
      match: (method, url) => method === "GET" && url === "/api/sessions/s1/context?boundary=1",
      produce: () => new Promise((resolve) => {
        const entryIds = [...world.sessions.get("s1").entryIds];
        releaseBoundary = () => resolve({ value: { entryIds } });
      }),
    });
    let submission;
    await act(async () => {
      submission = w.latest.handleInterruptAndReply("question");
      await sleep(30);
    });
    const replacement = lastEs();
    await act(async () => {
      replacement.open();
      await sleep(20);
      assert.ok(releaseBoundary, "the persisted-ID boundary must be read immediately before dispatch");
      assert.equal(promptCommands(), promptsBefore, "dispatch waits for the boundary, including interrupt-and-reply");
      assert.equal(fullReads(), readsBefore, "pre-prompt boundary capture must not request transcript bodies");
      releaseBoundary();
      await submission;
      replacement.emit({ type: "agent_end", isTerminal: true });
      replacement.emit({ type: "agent_start" });
      await Promise.resolve();
    });
    // The replacement never persisted a new user entry or answer.
    await act(async () => {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await sleep(60);
    });
    await settle();
    assert.equal(w.latest.agentRunning, false);
    assert.equal(w.latest.notices.filter((n) => n.type === "error").length, 1, "previous answer must not count as replacement success");
});

test("tool activity and turn_end errors do not count as a successful answer", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");

  const toolOnlyAssistant = {
    ...assistantMsg("a1", ""),
    content: [{ type: "toolCall", toolCallId: "tc1", toolName: "read", input: { path: "missing.txt" } }],
  };
  const providerError = "The provider failed while finishing the turn";
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: toolOnlyAssistant });
    es.emit({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read" });
    es.emit({ type: "turn_end", error: { message: providerError } });
    es.emit({ type: "agent_end", isTerminal: true });
    await Promise.resolve();
  });
  await settle();

  assert.ok(w.latest.notices.some((notice) => notice.message === providerError), "turn_end errors must be visible");
  assert.equal(w.latest.agentRunning, false);
});

test("tool output streams live before the toolResult message lands", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");

  const toolCallAssistant = {
    ...assistantMsg("a1", ""),
    content: [{ type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "long-job" } }],
  };
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: userMsg("u1", "q1") });
    es.emit({ type: "message_end", message: toolCallAssistant });
    await Promise.resolve();
  });
  assert.equal(w.latest.liveToolResults.size, 0, "nothing is live before the tool starts");

  // The tool starts: its row must go live immediately, with no output yet.
  await act(async () => {
    es.emit({ type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { command: "long-job" } });
    await Promise.resolve();
  });
  const started = w.latest.liveToolResults.get("tc1");
  assert.equal(started?.partial, true, "a running tool is a partial result");
  assert.equal(started?.toolName, "bash");
  assert.deepEqual(started?.content, []);

  // omp sends the FULL accumulated output per chunk; only the latest survives
  // a display frame.
  await act(async () => {
    es.emit({ type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", partialResult: { content: [{ type: "text", text: "line-1\n" }] } });
    es.emit({ type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", partialResult: { content: [{ type: "text", text: "line-1\nline-2\n" }] } });
    await Promise.resolve();
  });
  await settle(90);
  const streamed = w.latest.liveToolResults.get("tc1");
  assert.equal(streamed?.partial, true);
  assert.equal(streamed?.content?.[0]?.text, "line-1\nline-2\n", "latest accumulated snapshot wins");

  // The tool finishes, then omp commits the toolResult message. The committed
  // result supersedes the live snapshot.
  await act(async () => {
    es.emit({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: { content: [{ type: "text", text: "line-1\nline-2\n" }] } });
    await Promise.resolve();
  });
  assert.equal(w.latest.liveToolResults.get("tc1")?.partial, undefined, "a finished tool is no longer partial");
  await act(async () => {
    es.emit({
      type: "message_end",
      message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "line-1\nline-2\n" }] },
    });
    await Promise.resolve();
  });
  assert.equal(w.latest.liveToolResults.size, 0, "the committed result replaces the live entry");
  assert.equal(w.latest.messages.at(-1)?.role, "toolResult");

  // Terminal frames clear anything still in flight.
  await act(async () => {
    es.emit({ type: "tool_execution_start", toolCallId: "tc2", toolName: "bash" });
    await Promise.resolve();
  });
  assert.equal(w.latest.liveToolResults.size, 1);
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), toolCallAssistant]);
  await act(async () => {
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  assert.equal(w.latest.liveToolResults.size, 0, "a finished run leaves no live tool state");
});

test("late frames after the run finished are ignored (no ghost bubble, no double completion)", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: userMsg("u1", "q1") });
    es.emit({ type: "message_end", message: assistantMsg("a1", "done") });
    // Disk snapshot in sync BEFORE agent_end: the terminal reload replaces
    // in-memory messages with the session file's content.
    saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "done")]);
    es.emit({ type: "agent_end", isTerminal: true });
    await Promise.resolve();
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.messages.length, 3);

  // Frames buffered while the tab was frozen, flushed after reconcile:
  // message_update / message_end / a SECOND agent_end must change nothing.
  await act(async () => {
    es.emit({ type: "message_update", message: assistantMsg("a1", "late partial") });
    es.emit({ type: "message_end", message: assistantMsg("a1", "late full") });
    es.emit({ type: "agent_end", isTerminal: true });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, false, "late agent_end must not re-enter completion");
  assert.equal(w.latest.streamState.isStreaming, false, "late updates must not resurrect a streaming bubble");
  assert.equal(w.latest.streamState.streamingMessage, null);
  assert.equal(w.latest.messages.length, 3, "late message_end must not duplicate the message");
});

test("agent_end with isTerminal=false is an async delivery pause, not a completion", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "partial") });
    await Promise.resolve();
  });
  await settle(90);

  await act(async () => {
    es.emit({ type: "agent_end", isTerminal: false });
    await Promise.resolve();
  });
  await settle();
  assert.equal(w.latest.agentRunning, true, "async delivery must keep the run alive");
  assert.equal(w.latest.streamState.isStreaming, true);
});

test("abort_and_prompt: the aborted run's terminal agent_end is consumed, the new run keeps streaming", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "old run streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true);

  let interruptPromise;
  await act(async () => {
    interruptPromise = w.latest.handleInterruptAndReply("replacement prompt");
    await sleep(30);
  });
  // ensureEventsConnected replaces the stream: open the new one so the
  // connect promise settles and abort_and_prompt fires.
  const esRun = lastEs();
  await act(async () => {
    esRun.open();
    await interruptPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/").some((c) => c.body?.type === "abort_and_prompt"),
    true,
    "abort_and_prompt command must be sent",
  );

  // The aborted run's terminal agent_end arrives over the CURRENT stream
  // (abort settles): consumed by the pending-interrupt guard.
  await act(async () => {
    esRun.emit({ type: "agent_end", isTerminal: true });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true, "the replacement run must still be running");

  // The NEW run streams on.
  await act(async () => {
    esRun.emit({ type: "agent_start" });
    esRun.emit({ type: "message_update", message: assistantMsg("a2", "new run streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.streamState.streamingMessage?.content?.[0]?.text, "new run streaming");
});

test("send tolerates a missing session file (local-only slash commands) and still dispatches", async () => {
  resetWorld();
  // A session whose only prompts were local slash commands never started an
  // agent run, so omp wrote no session file: every /api/sessions/<id> read
  // 404s while the live RPC wrapper answers /api/agent/<id> normally.
  world.agents.set("fileless", { running: false, state: {} });
  const w = await mountSession("fileless");
  assert.equal(w.latest.loading, false, "hydration completes without a file");
  assert.equal(w.latest.agentRunning, false);

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("hello after skill");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/fileless").some((c) => c.body?.type === "prompt" && c.body?.message === "hello after skill"),
    true,
    "prompt must be dispatched despite the boundary 404",
  );
  assert.equal(w.latest.agentRunning, false, "the outbox does not start a turn before agent_start");
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
});

test("a reconcile response that straddles a run boundary is dropped by the run-id fence", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);

  // todo_reminder triggers the mid-run reconcile poll; hold its response.
  let releaseReconcile;
  const reconcileDone = new Promise((resolve) => {
    releaseReconcile = () => resolve({ status: 200, value: { running: false, state: { systemPrompt: "STALE-RUN" } } });
  });
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/agent/s1"),
    produce: () => reconcileDone,
  });
  await act(async () => {
    es.emit({ type: "todo_reminder" });
    await sleep(30);
  });
  assert.ok(callsTo("GET", "/api/agent/s1").length > 0, "reconcile poll must be in flight");

  // The user interrupts-and-replies while the poll is in flight: the run id
  // advances, so the stale response must be discarded entirely.
  let interruptPromise;
  await act(async () => {
    interruptPromise = w.latest.handleInterruptAndReply("next run");
    await sleep(30);
  });
  const esRun = lastEs();
  await act(async () => {
    esRun.open();
    await interruptPromise;
  });
  await act(async () => {
    releaseReconcile();
    await sleep(30);
  });
  await settle();
  assert.equal(w.latest.agentRunning, true, "stale reconcile must not finish the new run");
  assert.notEqual(w.latest.systemPrompt, "STALE-RUN", "stale reconcile must not apply its snapshot");

  // The replacement run completes normally afterwards: the next terminal
  // agent_end (no pending interrupt) ends the turn.
  await act(async () => {
    esRun.emit({ type: "agent_end", isTerminal: true }); // consumed: pending interrupt from abort_and_prompt
    esRun.emit({ type: "agent_start" }); // the replacement run actually starts
    esRun.emit({ type: "agent_end", isTerminal: true }); // ...and finishes
    await Promise.resolve();
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
});

test("ISSUE #187 the context ring fills mid-run while the agent is still streaming", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.ok(!w.latest.contextUsage, "a continued conversation starts with no live usage");

  // The server has real usage while the run is genuinely busy — it used to be
  // dropped, so the ring stayed blank until the run ended.
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/agent/s1"),
    produce: () => ({
      status: 200,
      value: { running: true, state: { isStreaming: true, contextUsage: { percent: 42, contextWindow: 200000, tokens: 84000 } } },
    }),
  });
  await act(async () => {
    es.emit({ type: "todo_reminder" }); // triggers the mid-run reconcile poll
    await sleep(30);
  });
  await settle();
  assert.deepEqual(w.latest.contextUsage, { percent: 42, contextWindow: 200000, tokens: 84000 });
  assert.equal(w.latest.agentRunning, true, "applying usage must not finish a busy run");
});

test("fatal SSE error mid-run reconnects after 1s and the new stream delivers events", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es: es1 } = await startRun("s1", "q1");
  await act(async () => {
    es1.emit({ type: "agent_start" });
    await Promise.resolve();
  });
  assert.equal(w.latest.agentRunning, true);
  const instanceCount = world.esInstances.length;

  es1.failFatal();
  assert.equal(es1.readyState, FakeStream.CLOSED);
  await settle(1500); // > reconnect backoff
  assert.equal(world.esInstances.length, instanceCount + 1, "a replacement stream must be created");

  const es2 = lastEs();
  await act(async () => {
    es2.open();
    es2.emit({ type: "agent_end", isTerminal: true });
    await Promise.resolve();
  });
  await settle();
  assert.equal(w.latest.agentRunning, false, "events must flow through the replacement stream");
});

test("a chat with no stream attaches when the running channel reports its session", async () => {
  resetWorld();
  primeSession("started-elsewhere", [userMsg("u0", "q")]);
  const w = await mountSession("started-elsewhere");
  assert.equal(world.esInstances.length, 0, "an idle chat has no observer");
  const running = world.runningStreams.at(-1);
  assert.ok(running, "the chat watches the running channel");
  // Another chat instance (the user switched away and back) or device started the run after this one loaded,
  // with a model and thinking level the chat has not seen.
  assert.notEqual(w.latest.thinkingLevel, "high");
  assert.notEqual(w.latest.displayModel?.modelId, "live-model");
  world.agents.set("started-elsewhere", {
    running: true,
    state: { isStreaming: true, isPromptRunning: true, model: { provider: "test", id: "live-model" }, thinkingLevel: "high" },
  });
  await act(async () => {
    running.deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["other"] }) });
    await settle();
  });
  assert.equal(world.esInstances.length, 0, "another session's run is not this chat's");
  await act(async () => {
    running.deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["started-elsewhere"] }) });
    await settle();
  });
  assert.equal(world.esInstances.length, 1, "the chat attaches its observer");
  assert.equal(lastEs().channel.sessionId, "started-elsewhere");
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.thinkingLevel, "high", "the composer shows the run's thinking level");
  assert.equal(w.latest.displayModel.modelId, "live-model", "the composer shows the run's model");
});

test("a running attachment applies compaction before its observer opens", async () => {
  resetWorld();
  primeSession("compacting-elsewhere", [userMsg("u0", "q")]);
  const w = await mountSession("compacting-elsewhere");
  world.agents.set("compacting-elsewhere", { running: true, state: { isCompacting: true } });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["compacting-elsewhere"] }) });
    await settle();
  });
  assert.equal(lastEs().readyState, FakeStream.CONNECTING);
  assert.equal(w.latest.isCompacting, true, "the compaction control immediately reflects the attached run");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(world.calls.some((call) => call.body?.type === "compact"), false, "a second compaction cannot start");
});

test("compaction attached from another tab settles without replacing a historical view", async (t) => {
  resetWorld();
  const sid = "historical-compaction";
  primeSession(sid, [userMsg("live", "current branch")]);
  const w = await mountSession(sid);
  const branch = { leafId: "branch", messages: [userMsg("old", "selected branch")], entryIds: ["branch-entry"] };
  world.views.set(`${sid}:branch:false`, branch);
  await act(async () => { await w.changeLeaf("branch"); });
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  t.mock.timers.enable({ apis: ["setInterval"] });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
    await settle();
    lastEs().open();
    await settle();
  });
  assert.equal(w.latest.isCompacting, true);
  assert.equal(w.latest.agentRunning, false, "manual compaction is not a prompt run");
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [] }) });
    t.mock.timers.tick(15_000);
    await settle();
  });
  assert.equal(w.latest.isCompacting, false, "native idle state releases Stop compaction without a completion event");
  assert.equal(w.latest.activeLeafId, "branch");
  assert.deepEqual(w.latest.entryIds, branch.entryIds);
  assert.deepEqual(w.latest.messages, branch.messages);
});

test("a refused compact command cannot unlock compaction attached from another tab", async () => {
  resetWorld();
  const sid = "attached-compaction-owner";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
    await settle();
  });
  await act(async () => {
    const result = await w.latest.handleBuiltinSlashCommand("/compact");
    assert.ok(result.error, "a second compaction is refused");
  });
  assert.equal(w.latest.isCompacting, true, "the rejected command does not own the attached compaction");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(world.calls.some(call => call.body?.type === "compact"), false, "neither control can start a second compaction");
});

test("an idle chat reconciles auto-compaction when its completion event is lost", async () => {
  resetWorld();
  const sid = "auto-compaction-owner";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
    await settle();
    lastEs().open();
    await settle();
    lastEs().emit({ type: "auto_compaction_start" });
  });
  assert.equal(w.latest.isCompacting, true);
  assert.equal(w.latest.agentRunning, false);
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await settle();
  });
  assert.equal(w.latest.isCompacting, false, "the ref and rendered state share the same compaction lifecycle");
});

/** A catch-up snapshot of `sid` at `sequence` with no prompt running, only (maybe) a compaction. */
function compactionSnapshot(sid, sequence, isCompacting) {
  return { cursor: { streamId: `stream-${sid}`, sequence }, isStreaming: false, isPromptRunning: false, isCompacting, streamingMessage: null, toolEvents: [] };
}

test("a compaction-only catch-up snapshot is not a prompt run and does not fail when it ends", async () => {
  resetWorld();
  toastCalls.length = 0;
  const sid = "snapshot-compaction";
  primeSession(sid, [userMsg("u0", "q")]);
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  world.live.set(sid, compactionSnapshot(sid, 0, true));
  const w = await mountSession(sid);
  await act(async () => { lastEs().open(); await settle(); });
  assert.equal(w.latest.isCompacting, true);
  assert.equal(w.latest.agentRunning, false, "a compaction runs no prompt");
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  world.live.set(sid, compactionSnapshot(sid, 1, false));
  await act(async () => { window.dispatchEvent(new Event("online")); await settle(); });
  assert.equal(w.latest.isCompacting, false);
  assert.deepEqual(w.latest.notices.filter((notice) => notice.type === "error"), [], "a finished compaction is not an empty prompt reply");
});

test("matching running frames received during an idle lookup trigger one fresh lookup", async () => {
  resetWorld();
  primeSession("late-start", [userMsg("u0", "q")]);
  const w = await mountSession("late-start");
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/late-start",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { running: false, state: {} } }); }),
  });
  const running = world.runningStreams.at(-1);
  const frame = { type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["late-start"] }) };
  const gets = callsTo("GET", "/api/agent/late-start").length;
  await act(async () => {
    running.deliver(frame);
    await Promise.resolve();
  });
  assert.equal(typeof release, "function", "the first lookup is in flight");
  world.agents.set("late-start", { running: true, state: { isStreaming: true } });
  await act(async () => {
    running.deliver(frame);
    running.deliver(frame);
    release();
    await settle();
  });
  assert.equal(callsTo("GET", "/api/agent/late-start").length, gets + 2, "overlapping frames coalesce, but are not dropped");
  assert.equal(world.esInstances.length, 1);
  assert.equal(w.latest.agentRunning, true);
});

test("an idle running lookup without a newer matching frame is not retried", async () => {
  resetWorld();
  primeSession("still-idle", [userMsg("u0", "q")]);
  await mountSession("still-idle");
  const gets = callsTo("GET", "/api/agent/still-idle").length;
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["still-idle"] }) });
    await settle();
  });
  assert.equal(callsTo("GET", "/api/agent/still-idle").length, gets + 1);
  assert.equal(world.esInstances.length, 0);
});

test("a delayed running lookup cannot take ownership of a locally started shell", async () => {
  resetWorld();
  primeSession("late-own-shell", [userMsg("u0", "q")]);
  const w = await mountSession("late-own-shell");
  let releaseLookup;
  let releaseBash;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/late-own-shell",
    produce: () => new Promise((resolve) => { releaseLookup = () => resolve({ value: { running: true, state: { isBashRunning: true } } }); }),
  }, {
    match: (method, url, body) => method === "POST" && url === "/api/agent/late-own-shell" && body?.type === "bash",
    produce: () => new Promise((resolve) => { releaseBash = () => resolve({ value: { success: true, data: { output: "", exitCode: 0 } } }); }),
  });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["late-own-shell"] }) });
    await Promise.resolve();
  });
  let bash;
  await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
  assert.equal(w.latest.bashRunning, true);
  await act(async () => { releaseLookup(); await settle(); });
  assert.equal(world.esInstances.length, 0, "executeBash still exclusively owns the command's settlement");
  assert.equal(w.latest.bashRunning, true);
  await act(async () => { releaseBash(); await bash; });
  assert.equal(w.latest.bashRunning, false);
});

for (const stopped of [false, true]) {
  test(`a delayed running lookup cannot resurrect a ${stopped ? "stopped" : "completed"} local shell`, async () => {
    resetWorld();
    const sid = stopped ? "stopped-local-shell" : "completed-local-shell";
    primeSession(sid, [userMsg("u0", "q")]);
    const w = await mountSession(sid);
    let releaseLookup;
    let releaseBash;
    world.holds.push({
      match: (method, url) => method === "GET" && url === `/api/agent/${sid}`,
      produce: () => new Promise((resolve) => { releaseLookup = () => resolve({ value: { running: true, state: { isBashRunning: true } } }); }),
    }, {
      match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "bash",
      produce: () => new Promise((resolve) => { releaseBash = () => resolve({ value: { success: true, data: { output: "", exitCode: stopped ? 130 : 0, cancelled: stopped } } }); }),
    });
    await act(async () => {
      world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: [sid] }) });
      await Promise.resolve();
    });
    let bash;
    await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
    assert.equal(w.latest.bashRunning, true);
    if (stopped) {
      await act(async () => { await w.latest.handleAbort(); });
      assert.equal(world.calls.some((call) => call.body?.type === "abort_bash"), true);
    }
    await act(async () => { releaseBash(); await bash; });
    assert.equal(w.latest.bashRunning, false);
    const streams = world.esInstances.length;
    await act(async () => { releaseLookup(); await settle(); });
    assert.equal(w.latest.bashRunning, false, "an obsolete snapshot cannot restart the settled shell's spinner");
    assert.equal(world.esInstances.length, streams, "an obsolete shell lookup cannot acquire an observer");
  });
}

test("a delayed running lookup cannot attach after a newer send went to the outbox", async () => {
  resetWorld();
  primeSession("held-new-prompt", [userMsg("u0", "q")]);
  const w = await mountSession("held-new-prompt");
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/held-new-prompt",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { running: true, state: { isStreaming: true } } }); }),
  });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["held-new-prompt"] }) });
    await Promise.resolve();
  });
  world.outboxHold = true;
  await act(async () => {
    const receipt = await w.latest.handleSend("new prompt");
    assert.equal(receipt.status, "accepted");
  });
  assert.equal(world.esInstances.length, 1, "the held message opened the chat's stream");
  await act(async () => { release(); await settle(); });
  assert.equal(world.esInstances.length, 1, "a lookup from an older prompt generation cannot attach a second stream");
  assert.equal(w.latest.agentRunning, false);
});

test("a delayed running lookup cannot replace a side question's readiness wait", async () => {
  resetWorld();
  primeSession("late-btw", [userMsg("u0", "q")]);
  const w = await mountSession("late-btw");
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/late-btw",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { running: true, state: { isStreaming: true } } }); }),
  });
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["late-btw"] }) });
    await Promise.resolve();
  });
  let asking;
  await act(async () => { asking = w.latest.askBtw("side question"); await sleep(30); });
  const source = lastEs();
  assert.equal(source.readyState, FakeStream.CONNECTING);
  const gets = callsTo("GET", "/api/sessions/late-btw/state").length;
  await act(async () => { release(); await settle(); });
  assert.equal(world.esInstances.length, 1);
  assert.equal(source.closedByCaller, false);
  assert.equal(w.latest.agentRunning, false, "the stale lookup cannot manufacture a prompt run");
  assert.equal(callsTo("GET", "/api/sessions/late-btw/state").length, gets, "the stale lookup cannot refresh composer state");
  await act(async () => { source.open(); await asking; });
});

test("a running frame never touches a chat that already has its stream", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startRun("s1", "q1");
  const streams = world.esInstances.length;
  const gets = world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/s1").length;
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["s1"] }) });
    await settle();
  });
  assert.equal(world.esInstances.length, streams);
  assert.equal(world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/s1").length, gets);
  assert.equal(w.latest.agentRunning, true);
});

test("a running frame leaves a shell command this idle chat runs to the chat", async () => {
  resetWorld();
  primeSession("own-shell", [userMsg("u0", "q")]);
  const w = await mountSession("own-shell");
  assert.equal(world.esInstances.length, 0, "an idle chat has no observer");
  let release;
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === "/api/agent/own-shell" && body?.type === "bash",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { success: true, data: { output: "", exitCode: 0 } } }); }),
  });
  let bash;
  await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
  assert.equal(w.latest.bashRunning, true);
  // omp reports the session running while its shell runs; executeBash owns that command's settlement.
  world.agents.set("own-shell", { running: true, state: { isBashRunning: true } });
  const gets = world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/own-shell").length;
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ["own-shell"] }) });
    await settle();
  });
  assert.equal(world.calls.filter((call) => call.method === "GET" && call.url === "/api/agent/own-shell").length, gets);
  assert.equal(world.esInstances.length, 0);
  world.agents.set("own-shell", { running: false, state: {} });
  await act(async () => { release(); await bash; await settle(); });
  assert.equal(w.latest.bashRunning, false);
});

/** Delivers a `running` frame listing `ids` on the hook's running subscription. */
async function deliverRunning(ids) {
  await act(async () => {
    world.runningStreams.at(-1).deliver({ type: "message", data: JSON.stringify({ type: "running", runningSessionIds: ids }) });
    await Promise.resolve();
  });
}

/** Holds the next request `match` accepts; `release(value, status)` answers it. */
function holdNext(match) {
  const held = {};
  world.holds.push({ match, produce: () => new Promise((resolve) => { held.release = (value, status = 200) => resolve({ status, value }); }) });
  return held;
}

test("an idle snapshot cannot release a manual compaction this tab is still sending", async () => {
  resetWorld();
  const sid = "cold-compact";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const compact = holdNext((method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "compact");
  let compacting;
  await act(async () => { compacting = w.latest.handleCompact(); await sleep(30); });
  assert.equal(w.latest.isCompacting, true);
  // omp is still starting: the state poll answers before the command reaches it.
  await act(async () => { window.dispatchEvent(new Event("online")); await sleep(30); });
  assert.equal(w.latest.isCompacting, true, "the command's own settlement releases Stop compaction");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(callsTo("POST", `/api/agent/${sid}`).filter((call) => call.body?.type === "compact").length, 1, "no second compaction");
  await act(async () => { compact.release({ success: true, data: {} }); await compacting; });
  assert.equal(w.latest.isCompacting, false);
});

test("a late idle snapshot from an earlier compaction cannot release the next one", async () => {
  resetWorld();
  const sid = "two-compactions";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { lastEs().open(); await sleep(30); });
  await act(async () => { lastEs().emit({ type: "auto_compaction_start" }); });
  const poll = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await act(async () => { window.dispatchEvent(new Event("online")); await sleep(30); });
  assert.equal(typeof poll.release, "function", "the poll for the first compaction is in flight");
  await act(async () => {
    lastEs().emit({ type: "auto_compaction_end" });
    lastEs().emit({ type: "auto_compaction_start" });
  });
  await act(async () => { poll.release({ running: true, state: { isCompacting: false } }); await sleep(30); });
  assert.equal(w.latest.isCompacting, true, "the second compaction is still running");
});

test("a failed running lookup is retried", async () => {
  resetWorld();
  const sid = "lookup-retry";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.holds.push({ match: (method, url) => method === "GET" && url === `/api/agent/${sid}`, produce: async () => ({ status: 503, value: { error: "busy" } }) });
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  await deliverRunning([sid]);
  await settle();
  assert.equal(world.esInstances.length, 0, "the failed lookup attached nothing");
  await settle(1100);
  assert.equal(world.esInstances.length, 1, "the retry attaches the run");
  assert.equal(w.latest.agentRunning, true);
});

test("a running frame waits for the chat's first load, which it cannot invalidate", async () => {
  resetWorld();
  const sid = "hydrating";
  primeSession(sid, [userMsg("u0", "q")]);
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  const load = holdNext((method, url) => method === "GET" && url.startsWith(`/api/sessions/${sid}?`));
  const w = await mountSession(sid);
  assert.equal(typeof load.release, "function", "the first load is in flight");
  await deliverRunning([sid]);
  await settle();
  // On the old code the frame attached here, and the run's agent_start dropped the first load.
  if (lastEs()) await act(async () => { lastEs().open(); lastEs().emit({ type: "agent_start" }); });
  assert.equal(world.esInstances.length, 0, "no observer before the first load settles");
  const session = world.sessions.get(sid);
  await act(async () => {
    load.release({ sessionId: sid, filePath: "/fixture/session.jsonl", tree: [], leafId: session.leafId, context: { todoPhases: [], thinkingLevel: "off", model: null, ...session } });
    await settle();
  });
  assert.ok(w.latest.data, "the first load is kept");
  assert.equal(world.esInstances.length, 1, "then the run is attached");
  assert.equal(w.latest.agentRunning, true);
});

test("a running lookup from before an Edit cannot start a run during it", async () => {
  resetWorld();
  const sid = "lookup-edit";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  const edit = holdNext((method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message");
  await deliverRunning([sid]);
  let editing;
  await act(async () => { editing = w.latest.handleEdit("e0", "q"); await sleep(30); });
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0);
  assert.equal(w.latest.agentRunning, false);
  await act(async () => { edit.release({ success: true, data: { cancelled: true, leafId: null, sessionId: sid } }); await editing; });
});

test("a running lookup from before a completed Edit cannot attach its stale run", async () => {
  resetWorld();
  const sid = "lookup-edit-done";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await deliverRunning([sid]);
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message",
    produce: async () => ({ value: { success: true, data: { cancelled: true, leafId: null, sessionId: sid } } }),
  });
  await act(async () => { await w.latest.handleEdit("e0", "q"); });
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0, "the snapshot predates the Edit");
  assert.equal(w.latest.agentRunning, false);
});

test("a manual compaction settling during an auto-compaction leaves Stop to the auto-compaction", async () => {
  resetWorld();
  const sid = "manual-then-auto";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { lastEs().open(); await sleep(30); });
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "compact",
    produce: async () => ({ value: { success: true, data: {} } }),
  });
  const reload = holdNext((method, url) => method === "GET" && url.startsWith(`/api/sessions/${sid}?`));
  let compacting;
  await act(async () => { compacting = w.latest.handleCompact(); await sleep(30); });
  assert.equal(typeof reload.release, "function", "the manual compaction is reloading the transcript");
  await act(async () => { lastEs().emit({ type: "auto_compaction_start" }); });
  const session = world.sessions.get(sid);
  await act(async () => {
    reload.release({ sessionId: sid, filePath: "/fixture/session.jsonl", tree: [], leafId: session.leafId, context: { todoPhases: [], thinkingLevel: "off", model: null, ...session } });
    await compacting;
  });
  assert.equal(w.latest.isCompacting, true, "the auto-compaction is still running");
  await act(async () => { lastEs().emit({ type: "auto_compaction_end" }); });
  assert.equal(w.latest.isCompacting, false);
});

test("a run reported while a sent message waits in the outbox is adopted once its stream attaches", async () => {
  resetWorld();
  const sid = "held-then-remote";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.outboxHold = true;
  await act(async () => { assert.equal((await w.latest.handleSend("mine")).status, "accepted"); });
  assert.equal(world.outbox.length, 1, "the message waits in the outbox, not in a local startup");
  // Another tab's run starts while this held message's stream is still connecting.
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  await deliverRunning([sid]);
  await settle();
  assert.equal(world.esInstances.length, 1, "the held message's stream is the chat's only observer");
  assert.equal(w.latest.agentRunning, false, "nothing is adopted before the stream attaches");
  await act(async () => { lastEs().open(); lastEs().emit({ type: "connected" }); await settle(); });
  assert.equal(world.esInstances.length, 1, "the run is adopted on that stream, not a second one");
  assert.equal(w.latest.agentRunning, true);
});

test("an idle session's held-message stream adopts no run", async () => {
  resetWorld();
  const sid = "held-idle";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.outboxHold = true;
  await act(async () => { assert.equal((await w.latest.handleSend("mine")).status, "accepted"); });
  await act(async () => { lastEs().open(); lastEs().emit({ type: "connected" }); await settle(); });
  assert.equal(w.latest.agentRunning, false);
});

test("a chat promoted from a new chat attaches a run reported after its first send failed", async (t) => {
  resetWorld();
  const sid = "promoted-later";
  primeSession(sid, [userMsg("u0", "q")]);
  let promoted = null;
  const view = ownRoot(renderHook(({ session }) => useAgentSession({ session, newSessionCwd: session ? null : "/workspace", onSessionCreated: (created) => { promoted = created; } }), { initialProps: { session: null }, wrapper: TestRoot }));
  await settle(30);
  world.holds.push({ match: (method, url) => method === "POST" && url === "/api/agent/new", produce: async () => ({ value: { sessionId: sid } }) });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let sending;
  await act(async () => { sending = view.result.current.handleSend("first"); for (let i = 0; i < 30; i++) await Promise.resolve(); });
  assert.equal(promoted?.id, sid);
  // Promotion re-renders the same chat with its new session; no mount load runs for it.
  await act(async () => { view.rerender({ session: promoted }); for (let i = 0; i < 30; i++) await Promise.resolve(); });
  await act(async () => {
    t.mock.timers.tick(60_001);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal((await sending).status, "rejected");
  });
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  const gets = callsTo("GET", `/api/agent/${sid}`).length;
  await deliverRunning([sid]);
  assert.equal(callsTo("GET", `/api/agent/${sid}`).length, gets + 1, "no mount load to wait for");
  await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
  assert.equal(view.result.current.agentRunning, true);
});

test("a run reported while a side question's stream connects is attached once that stream times out", async (t) => {
  resetWorld();
  const sid = "btw-then-remote";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let asking;
  await act(async () => { asking = w.latest.askBtw("side question"); for (let i = 0; i < 30; i++) await Promise.resolve(); });
  const observer = lastEs();
  assert.equal(observer.readyState, FakeStream.CONNECTING);
  world.agents.set(sid, { running: true, state: { isStreaming: true } });
  await deliverRunning([sid]);
  await act(async () => {
    t.mock.timers.tick(60_001);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    assert.equal(await asking, false);
  });
  assert.equal(observer.closedByCaller, true, "the side question gave up its stream");
  assert.equal(world.esInstances.length, 2, "the held frame attaches the run without another frame");
  assert.equal(w.latest.agentRunning, true);
});

test("an auto-compaction whose end was missed cannot bring Stop back after a later manual compaction", async () => {
  resetWorld();
  const sid = "missed-auto-end";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: {} });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { lastEs().open(); await sleep(30); lastEs().emit({ type: "auto_compaction_start" }); });
  assert.equal(w.latest.isCompacting, true);
  // The end event is lost; the state poll settles it.
  world.agents.set(sid, { running: true, state: { isCompacting: false } });
  await act(async () => { window.dispatchEvent(new Event("online")); await sleep(30); });
  assert.equal(w.latest.isCompacting, false);
  await act(async () => { await w.latest.handleCompact(); await sleep(30); });
  assert.equal(w.latest.isCompacting, false, "the settled auto-compaction does not own Stop again");
});

test("a running lookup from before a manual compaction cannot release it", async () => {
  resetWorld();
  const sid = "lookup-compact";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  const compact = holdNext((method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "compact");
  await deliverRunning([sid]);
  let compacting;
  await act(async () => { compacting = w.latest.handleCompact(); await sleep(30); });
  await act(async () => { lookup.release({ running: true, state: { isCompacting: false } }); await settle(); });
  assert.equal(w.latest.isCompacting, true);
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(callsTo("POST", `/api/agent/${sid}`).filter((call) => call.body?.type === "compact").length, 1, "no second compaction");
  await act(async () => { compact.release({ success: true, data: {} }); await compacting; });
});

test("the first load's idle state cannot overwrite a compaction a later lookup found", async () => {
  resetWorld();
  const sid = "mount-vs-lookup";
  primeSession(sid, [userMsg("u0", "q")]);
  const state = holdNext((method, url) => method === "GET" && url === `/api/sessions/${sid}/state`);
  const w = await mountSession(sid);
  world.agents.set(sid, { running: true, state: { isCompacting: true } });
  await deliverRunning([sid]);
  await settle();
  await act(async () => { state.release({ running: false, state: { isCompacting: false } }); await settle(); });
  assert.equal(w.latest.isCompacting, true, "the newer lookup's compaction stands");
  await act(async () => { await w.latest.handleCompact(); });
  assert.equal(callsTo("POST", `/api/agent/${sid}`).some((call) => call.body?.type === "compact"), false, "and the guard agrees with the control");
});

test("a running lookup is dropped when the session left the running set meanwhile", async () => {
  resetWorld();
  const sid = "lookup-ended";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await deliverRunning([sid]);
  // The run ends (or its child exits) after the GET read its state, before the reply arrives.
  await deliverRunning([]);
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0, "the finished run is not attached");
  assert.equal(w.latest.agentRunning, false);
  assert.equal(world.calls.some((call) => call.body?.type === "set_host_tools"), false, "no registration that could spawn a replacement");
});

test("a running lookup is dropped when the chat's session identity moves meanwhile", async () => {
  resetWorld();
  const sid = "lookup-identity";
  primeSession(sid, [userMsg("u0", "q")]);
  const w = await mountSession(sid);
  const lookup = holdNext((method, url) => method === "GET" && url === `/api/agent/${sid}`);
  await deliverRunning([sid]);
  w.latest.sessionIdRef.current = "moved-identity";
  await act(async () => { lookup.release({ running: true, state: { isStreaming: true } }); await settle(); });
  assert.equal(world.esInstances.length, 0);
  assert.equal(w.latest.agentRunning, false);
});

test("unmount mid-run closes the stream and late frames cannot resurrect state", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    await Promise.resolve();
  });

  w.unmount();
  assert.equal(es.closedByCaller, true, "unmount must close the EventSource");

  // Frames arriving over the (closed) stream after unmount must be no-ops.
  es.emit({ type: "message_update", message: assistantMsg("a1", "late") });
  es.emit({ type: "agent_end", isTerminal: true });
  await settle();
  assert.equal(w.latest.agentRunning, true, "unmounted state must stay frozen");
});

test("an outbox message survives unmount and is dispatched without its tab", async () => {
  resetWorld();
  primeSession("connecting-unmount", [userMsg("u0", "q")]);
  const w = await mountSession("connecting-unmount");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("switched chats mid-send");
    await sleep(30);
  });
  const source = lastEs();
  assert.ok(source, "the held message opens an observer, but delivery does not wait for it");
  assert.equal(source.readyState, FakeStream.CONNECTING);
  let result;
  await act(async () => {
    w.unmount();
    result = await sending;
  });
  assert.equal(source.closedByCaller, true);
  assert.equal(result.status, "accepted");
  assert.equal(world.outbox[0]?.message, "switched chats mid-send", "the worker retains the message after its tab unmounts");
  await dispatchOutbox(true);
  assert.deepEqual(world.outbox, []);
  assert.equal(world.calls.filter((call) => call.body?.type === "prompt").length, 1);
  assert.equal(world.esInstances.length, 1, "no observer is opened for the unmounted chat");
  for (const type of ["set_host_tools", "set_host_uri_schemes", "get_subagents"]) {
    assert.equal(world.calls.some((call) => call.body?.type === type), false, `no ${type} for the unmounted chat`);
  }
});

test("a failed observer connection leaves the accepted message held in the outbox", async () => {
  resetWorld();
  primeSession("connecting-fails", [userMsg("u0", "q")]);
  const w = await mountSession("connecting-fails");
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("stays in the composer");
    await sleep(30);
  });
  let result;
  await act(async () => {
    lastEs().failFatal();
    result = await sending;
  });
  assert.equal(result.status, "accepted");
  assert.equal(world.outbox[0]?.message, "stays in the composer");
  assert.deepEqual(w.latest.notices, []);
  assert.equal(world.calls.some((call) => call.body?.type === "prompt"), false);
});

test("unmount during btw RPC startup cannot create an observer after teardown", async (t) => {
    resetWorld();
    const sid = "startup-unmount-btw";
    primeSession(sid, [userMsg("u0", "q")]);
    const w = await mountSession(sid);
    let release;
    t.after(() => release?.());
    world.holds.push({
      match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "get_state",
      produce: () => new Promise((resolve) => { release = () => resolve({ value: { success: true, data: {} } }); }),
    });
    let pending;
    await act(async () => {
      pending = w.latest.askBtw("must stay unasked");
      await sleep(20);
    });
    assert.equal(typeof release, "function", "the supported startup RPC must be awaiting its response");
    assert.equal(world.esInstances.length, 0, "startup has not yet acquired its observer");
    let result;
    await act(async () => {
      w.unmount();
      release();
      result = await pending;
    });
    assert.equal(mountedRoots.size, 0, "the real React root must already have completed its cleanup");
    assert.equal(world.esInstances.length, 0, "a late RPC response cannot create an observer its owner cannot close");
    assert.equal(result, false);
    assert.equal(world.calls.some((call) => call.body?.type === "btw"), false, "an abandoned side question has no UI left to answer into");
});

test("StrictMode final unmount owns the observer attached after its first cleanup", async () => {
  resetWorld();
  primeSession("strict-observer-unmount", [userMsg("u0", "q")]);
  world.agents.set("strict-observer-unmount", {
    running: true, state: { isStreaming: true, isPromptRunning: true },
  });
  const w = await mountSession("strict-observer-unmount", undefined, {}, true);
  const source = lastEs();
  assert.ok(source, "hydration must attach its observer after StrictMode's setup/cleanup replay");
  assert.equal(w.latest.agentRunning, true);
  await act(async () => { w.unmount(); });
  assert.equal(source.closedByCaller, true);
  const before = world.calls.length;
  await act(async () => {
    source.deliver({ type: "open" });
    window.dispatchEvent(new Event("online"));
  });
  assert.equal(world.calls.length, before, "a dead owner must not reconcile or restore registration");
});

// ---------------------------------------------------------------------------
// Recovery nets: visibilitychange / online reconcile + subagent roster
// restoration.
// ---------------------------------------------------------------------------

/** Mid-run baseline used by the recovery tests. */
async function startStreamingRun(sid) {
  const { w, es } = await startRun(sid, "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true);
  return { w, es };
}

test("tab returns to foreground: visibilitychange fires a mid-run reconcile poll", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun("s1");

  const before = callsTo("GET", "/api/agent/s1").length;
  // Server still mid-run: the poll must observe busy and NOT finish the run.
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(30);
  });
  assert.ok(
    callsTo("GET", "/api/agent/s1").length > before,
    "visibilitychange must trigger the recovery-net reconcile",
  );
  // Server still busy (running + isStreaming): the poll must NOT finish the run.
  assert.equal(w.latest.agentRunning, true);
});

test("network returns while agent_end was missed: the online reconcile recovers the UI", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun("s1");

  // Half-open SSE: no agent_end frame ever arrived, but omp already finished.
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "streaming")]);
  world.agents.set("s1", { running: false, state: {} });

  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, false, "the online reconcile must finish the stale run");
  assert.equal(w.latest.streamState.isStreaming, false);
  assert.equal(w.latest.messages.length, 3, "transcript reloaded from the session file");
});

test("subagent roster is restored from the get_subagents snapshot after reconnect", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es: es1 } = await startStreamingRun("s1");

  // Trigger a mid-run roster refresh: visibilitychange → reconcile (still
  // busy server-side) → refreshSubagentRoster against the configured snapshot.
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  world.subagentSnapshots.set("s1", [
    { id: "sub-1", agent: "explore", status: "started", index: 0, task: "search the codebase" },
  ]);
  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(60);
  });
  await settle();
  assert.equal(
    w.latest.subagents.filter((s) => s.id === "sub-1").length,
    1,
    "snapshot entry must be merged into the live roster",
  );
  assert.equal(w.latest.subagents.find((s) => s.id === "sub-1")?.status, "started");

  // SSE dies fatally; the reconnect re-registers roster recovery, and the
  // fresh snapshot now reports the child completed.
  es1.failFatal();
  world.subagentSnapshots.set("s1", [
    { id: "sub-1", agent: "explore", status: "completed", index: 0, task: "search the codebase" },
  ]);
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  await settle(1500); // > reconnect backoff
  const es2 = lastEs();
  assert.ok(es2 && es2 !== es1, "replacement stream created");
  await act(async () => {
    es2.open();
    await sleep(60); // reconnect actions: host tools + roster refresh
  });
  await settle();
  assert.equal(
    w.latest.subagents.find((s) => s.id === "sub-1")?.status,
    "completed",
    "reconnect must restore the roster from the fresh snapshot",
  );
});

/** Poll inside act until `check` holds (btw frames flush on a display-rate timer). */
async function until(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message);
    await settle(10);
  }
}

const btwRecord = (overrides = {}) => ({
  id: "b1", leafId: null, question: "what is 2+2", answer: "", status: "running", createdAt: 1, updatedAt: 1, ...overrides,
});

function holdBtwCommand(type, produce) {
  world.holds.push({ match: (method, _url, body) => method === "POST" && body?.type === type, produce });
}

function postedSince(index) {
  return world.calls.slice(index).filter((c) => c.method === "POST").map((c) => c.body);
}

test("/btw mid-run asks a side question, never a prompt, and streams its answer beside the run", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  holdBtwCommand("btw", async () => ({ value: { success: true, data: { record: btwRecord() } } }));
  const before = world.calls.length;
  let result;
  await act(async () => {
    result = await w.latest.handleBuiltinSlashCommand("/btw what is 2+2");
  });
  assert.deepEqual(result, { handled: true });
  const posted = postedSince(before);
  assert.deepEqual(posted.filter((b) => ["prompt", "steer", "follow_up", "abort_and_prompt"].includes(b?.type)), []);
  assert.deepEqual(posted.filter((b) => b?.type === "btw"), [{ type: "btw", question: "what is 2+2" }]);

  await act(async () => {
    es.emit({ type: "btw_delta", recordId: "b1", delta: "It is " });
    es.emit({ type: "btw_delta", recordId: "b1", delta: "4." });
  });
  await until(() => w.latest.btw.records[0]?.answer === "It is 4.", "deltas stream into the record");
  assert.equal(w.latest.btw.activeId, "b1", "the side question opens in the composer panel");

  await act(async () => {
    es.emit({ type: "btw_record", record: btwRecord({ answer: "It is 4.", status: "complete", updatedAt: 2 }) });
  });
  await until(() => w.latest.btw.records[0]?.status === "complete", "the terminal record settles it");
  assert.equal(w.latest.agentRunning, true, "the main run is untouched");
  assert.equal(w.latest.messages.some((m) => JSON.stringify(m.content).includes("2+2")), false, "never enters the transcript");
});

test("a btw follow-up asks in its topic; a refused ask keeps the composer text and says why", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun("s1");
  const followUp = { question: "and 3+3?", answer: "", status: "running", createdAt: 2, updatedAt: 2 };
  holdBtwCommand("btw", async () => ({ value: { success: true, data: { record: btwRecord({ answer: "4", status: "complete", followUps: [followUp] }) } } }));
  let before = world.calls.length;
  await act(async () => {
    assert.equal(await w.latest.askBtw("and 3+3?", "b1"), true);
  });
  assert.deepEqual(postedSince(before).filter((b) => b?.type === "btw"), [{ type: "btw", question: "and 3+3?", recordId: "b1" }]);

  toastCalls.length = 0;
  holdBtwCommand("btw", async () => ({ status: 400, value: { error: "A /btw question is still running; cancel it first", code: "rpc_command_failed" } }));
  let result;
  await act(async () => {
    result = await w.latest.handleBuiltinSlashCommand("/btw another one");
  });
  assert.deepEqual(result, { handled: true, retainInput: true });
  assert.deepEqual(toastCalls, [["error", "Side question failed", "A /btw question is still running; cancel it first"]]);

  // An omp without the commands gets an upgrade hint, not its raw error.
  toastCalls.length = 0;
  holdBtwCommand("btw", async () => ({ status: 400, value: { error: "Unknown command: btw", code: "rpc_command_failed" } }));
  await act(async () => {
    await w.latest.handleBuiltinSlashCommand("/btw old omp?");
  });
  assert.match(toastCalls[0]?.[1] ?? "", /requires a newer omp/);

  // Cancelling a btw that is still starting is the user's own doing, not a failure.
  toastCalls.length = 0;
  holdBtwCommand("btw", async () => ({ status: 400, value: { error: "The /btw question was cancelled before it started", code: "rpc_command_failed" } }));
  await act(async () => {
    result = await w.latest.handleBuiltinSlashCommand("/btw cancelled early");
  });
  assert.deepEqual(result, { handled: true });
  assert.deepEqual(toastCalls, []);
});

test("the notify host tool stays out of the Notifications tab, which lists only pushable notification types", async () => {
  toastCalls.length = 0;
  const result = await runHostTool("notify", { title: "Build done", message: "All green" }, { openUrl: () => "" });
  assert.deepEqual(result, { text: "Notification shown", isError: false });
  assert.deepEqual(toastCalls, []);
});

test("an open_file local:// call asks the server for the calling session's file and opens the absolute path it names", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: async () => ({ value: { path: "/sessions/s1/local/note.md" } }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (path, name, sessionId) => { opened.push([path, name, sessionId]); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "h1", toolCallId: "c1", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(60);
  });

  const lookups = callsTo("GET", "/api/sessions/s1/local-file");
  assert.equal(lookups.length, 1, "one lookup, for the session that asked");
  assert.equal(new URL(lookups[0].url, "http://localhost").searchParams.get("uri"), "local://note.md");
  assert.deepEqual(opened, [["/sessions/s1/local/note.md", "note.md", { sessionId: "s1", hostId: "local", cwd: "/workspace" }]]);
  const answer = callsTo("POST", "/api/agent/s1").find((call) => call.body?.type === "host_tool_result");
  assert.deepEqual([answer?.body.id, answer?.body.isError, answer?.body.result.content[0].text], ["h1", false, "Opened local://note.md"]);
});

test("an open_file local:// tab is owned by the session the server resolved, while the answer goes to the caller", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: async () => ({ value: { path: "/tmp/omp-local/s1-moved/note.md", sessionId: "s1-moved" } }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "owned", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(60);
  });
  assert.deepEqual(opened, [["/tmp/omp-local/s1-moved/note.md", "note.md", { sessionId: "s1-moved", hostId: "local", cwd: "/workspace" }]]);
  const answer = callsTo("POST", "/api/agent/s1").find((call) => call.body?.type === "host_tool_result");
  assert.deepEqual([answer?.body.id, answer?.body.isError], ["owned", false], "the caller still gets the answer");
});

test("a lookup pending when the chat's subscription drops is withdrawn, not answered or opened later", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: "/sessions/s1/local/note.md" } }); }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "dropped", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function", "the lookup is pending");
  // The server rejected the call when its only listener left; the cancel it emitted reached no one.
  await act(async () => { es.dropRecoverably(); });
  await act(async () => { release(); await settle(); });
  assert.deepEqual(opened, [], "no tab opens for a call the server already settled");
  const answer = callsTo("POST", "/api/agent/s1").find(call => call.body?.type === "host_tool_result" && call.body.id === "dropped");
  assert.equal(answer, undefined, "no late result for an already-rejected call");
});

test("an open_file local:// call whose lookup fails answers the agent with that error and opens nothing", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const lookupError = "File not found in this session's local:// directory";
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: async () => ({ status: 404, value: { error: lookupError, code: "file_not_found" } }),
  });
  const opened = [];
  const { es } = await startRun("s1", "q1", false, { onOpenFile: (path, name, sessionId) => { opened.push([path, name, sessionId]); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "h2", toolCallId: "c2", toolName: "open_file", arguments: { path: "local://absent.md" } });
    await sleep(60);
  });

  assert.deepEqual(opened, [], "no tab opens for a file that is not there");
  const answer = callsTo("POST", "/api/agent/s1").find((call) => call.body?.type === "host_tool_result");
  assert.deepEqual([answer?.body.id, answer?.body.isError, answer?.body.result.content[0].text], ["h2", true, lookupError]);
});

test("canceling a pending file open leaves other requests and a later run untouched", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: "/sessions/s1/local/canceled.md" } }); }),
  });
  const opened = [];
  const { w, es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "canceled-open", toolName: "open_file", arguments: { path: "local://canceled.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function");
  await act(async () => {
    es.emit({ type: "host_tool_cancel", targetId: "canceled-open" });
    es.emit({ type: "host_tool_call", id: "other-open", toolName: "open_file", arguments: { path: "/workspace/other.md" } });
    es.emit({ type: "agent_start" });
    release();
    await settle();
  });
  assert.deepEqual(opened, [["/workspace/other.md", "other.md", { sessionId: "s1", hostId: "local", cwd: "/workspace" }]]);
  assert.equal(w.latest.agentRunning, true);
  const answers = callsTo("POST", "/api/agent/s1").filter(call => call.body?.type === "host_tool_result");
  assert.ok(answers.some(call => call.body.id === "other-open" && !call.body.isError));
  assert.ok(!answers.some(call => call.body.id === "canceled-open"), "a withdrawn request is not answered later");
});

test("a delayed local-file lookup cannot open a tab after its chat unmounts", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  primeSession("s2", [userMsg("u0", "another chat")]);
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/local-file"),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: "/sessions/s1/local/note.md" } }); }),
  });
  const opened = [];
  const { w, es } = await startRun("s1", "q1", false, { onOpenFile: (...args) => { opened.push(args); } });
  await act(async () => {
    es.emit({ type: "host_tool_call", id: "late-open", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function", "the original session's lookup is pending");
  await act(async () => { w.unmount(); });
  await mountSession("s2");
  await act(async () => { release(); await settle(); });
  assert.deepEqual(opened, [], "the previous chat cannot take over the new view");
  const answer = callsTo("POST", "/api/agent/s1").find(call => call.body?.type === "host_tool_result");
  assert.equal(answer, undefined, "leaving the chat must not send a late callback that could restart its child");
});

test("a delayed local-file lookup survives a confirmed Edit identity move", async (t) => {
  resetWorld();
  const sid = "file-open-before-move";
  const target = `${sid}-owned`;
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const opened = [];
  const w = await mountMovableChat(sid, { onOpenFile: (...args) => { opened.push(args); } });
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes(`/api/sessions/${sid}/local-file`),
    produce: () => new Promise(resolve => { release = () => resolve({ value: { path: `/sessions/${target}/local/note.md` } }); }),
  });
  await act(async () => {
    lastEs().emit({ type: "host_tool_call", id: "moved-open", toolName: "open_file", arguments: { path: "local://note.md" } });
    await sleep(10);
  });
  assert.equal(typeof release, "function");
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the real Edit response confirms the new identity before the lookup completes");
  await act(async () => { release(); await settle(); });
  assert.deepEqual(opened, [[`/sessions/${target}/local/note.md`, "note.md", { sessionId: sid, hostId: "local", cwd: "/workspace" }]], "the same conversation retains the request's source alias and host");
  const answer = callsTo("POST", `/api/agent/${sid}`).find(call => call.body?.type === "host_tool_result");
  assert.equal(answer?.body.isError, false);
});

test("SSE open merges the btw history; a no-op cancel re-reads it and settles a record omp lost", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.btwHistory.set("s1", [btwRecord({ answer: "It is" })]);
  const { w } = await startStreamingRun("s1");
  assert.ok(world.calls.some((c) => c.body?.type === "get_btw_history"), "the stream open reads the history");
  await until(() => w.latest.btw.activeId === "b1", "a running topic found on connect opens the panel");
  assert.equal(w.latest.btw.records[0].answer, "It is");

  // The child no longer knows the record (failed checkpoint, replaced child).
  world.btwHistory.set("s1", []);
  holdBtwCommand("btw_cancel", async () => ({ value: { success: true, data: { cancelled: false } } }));
  const before = world.calls.length;
  await act(async () => {
    await w.latest.btw.cancel("b1");
  });
  assert.deepEqual(postedSince(before).map((b) => b?.type), ["btw_cancel", "get_btw_history"]);
  assert.deepEqual(postedSince(before)[0], { type: "btw_cancel", recordId: "b1" });
  await until(() => w.latest.btw.records[0]?.status === "interrupted", "the lost record stops spinning");
});

function liveSnapshot(sid, sequence, streamingMessage, toolEvents = []) {
  return {
    cursor: { streamId: `stream-${sid}`, sequence },
    isStreaming: true, isPromptRunning: true, isCompacting: false,
    streamingMessage, toolEvents,
  };
}

function syncSnapshot(sid, live = null, cursor = null) {
  const file = world.sessions.get(sid);
  return {
    ...selectSessionHistory({ todoPhases: [], thinkingLevel: "off", model: null, ...file }, cursor),
    sessionId: sid, leafId: file.leafId, live,
  };
}

function holdNextSync(sid, value) {
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${sid}/context?`) && url.includes("sync=1"),
    produce: () => new Promise((resolve) => { release = () => resolve({ value }); }),
  });
  return () => {
    assert.ok(release, "sync must be in flight");
    release();
  };
}

/** Real web wrapper, controllable native frames, independently delayed disk writes. */
function attachNativeWrapper(t, sid) {
  let frameListener;
  let delivering = true;
  let streaming = false;
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame(listener) { frameListener = listener; return () => {}; },
    async sendCommand(command) {
      if (command.type === "get_state") return { sessionId: sid, isStreaming: streaming, isCompacting: false };
      if (command.type === "prompt") return { agentInvoked: true };
      return {};
    },
    sendFrame() {},
    async dispose() {},
  }, process.cwd(), null, false, "", undefined, onlineHost);
  wrapper.start();
  world.wrappers.set(sid, wrapper);
  t.after(() => wrapper.destroyAndWait());
  wrapper.onEvent((event) => {
    world.streams.set(sid, event.web);
    world.live.set(sid, wrapper.getStreamSnapshot());
    if (delivering) lastEs()?.emit(event, { persist: false });
  });
  return {
    wrapper,
    emit(event, deliver = true) {
      delivering = deliver;
      if (event.type === "agent_start") streaming = true;
      if (event.type === "agent_end" && event.isTerminal !== false) streaming = false;
      frameListener(event);
      delivering = true;
    },
  };
}

test("wrapper-observed response missed by SSE survives terminal recovery before disk append", async (t) => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "old question")]);
  const { w } = await startRun("s1", "new question");
  const native = attachNativeWrapper(t, "s1");
  const answer = assistantMsg("a1", "Saved after agent_end");
  saveSession("s1", [userMsg("u0", "old question"), userMsg("u1", "new question")]);
  await act(async () => {
    native.emit({ type: "agent_start" });
    native.emit({ type: "message_end", message: answer }, false);
    native.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);
  assert.equal(w.latest.messages.filter((m) => m.role === "assistant").length, 0, "native observation is not a persisted entry");
  appendEntry("s1", answer);
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  assert.deepEqual(w.latest.messages.filter((m) => m.role === "assistant"), [answer]);
  assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2"]);
  assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);
});

test("a previous wrapper observation cannot hide a replacement run with no response", async (t) => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startRun("s1", "first");
  const native = attachNativeWrapper(t, "s1");
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "first")]);
  await act(async () => {
    native.emit({ type: "agent_start" });
    native.emit({ type: "message_end", message: assistantMsg("a1", "first answer") }, false);
    native.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);
  let sending;
  await act(async () => { sending = w.latest.handleSend("second"); await sleep(30); });
  await act(async () => { lastEs().open(); await sending; });
  // No new agent_start is required for a failed prompt: even pre-start failure
  // must not reuse either the wrapper's or the browser's prior observation.
  await act(async () => { native.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.notices.filter((n) => /stopped without returning a response/i.test(n.message)).length, 1);
});

test("terminal recovery respects a still-busy authoritative state instead of classifying readable history", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "new question");
  world.agents.set("s1", { running: true, state: { isStreaming: true, isPromptRunning: true } });
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.equal(w.latest.agentRunning, true);
  assert.deepEqual(w.latest.notices.filter((n) => n.type === "error"), []);
  world.agents.set("s1", { running: true, state: { isStreaming: false, isPromptRunning: false } });
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.notices.filter((n) => n.type === "error").length, 1);
});

test("busy foreground catch-up restores missing middle messages without overwriting newer queued tokens", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "old question")]);
  const { w, es } = await startStreamingRun("s1");
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  saveSession("s1", [
    userMsg("u0", "old question"), userMsg("u1", "q1"),
    assistantMsg("middle1", "first missed answer"),
    { role: "toolResult", toolCallId: "middle-tool", toolName: "read", content: [{ type: "text", text: "missed output" }] },
    assistantMsg("middle2", "second missed answer"),
  ]);
  const release = holdNextSync("s1", syncSnapshot("s1", liveSnapshot("s1", 2, assistantMsg("current", "old HTTP partial"))));
  await act(async () => {
    visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
    await sleep(20);
    es.emit({ type: "extension_ui_request", id: "question", method: "confirm", title: "Keep going?" });
    es.emit({ type: "message_update", message: assistantMsg("current", "newer tokens") });
    release();
  });
  await settle(90);
  assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2", "e3", "e4"]);
  assert.deepEqual(w.latest.messages.filter((m) => m.role === "assistant").map((m) => m.content[0].text), ["first missed answer", "second missed answer"]);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "newer tokens");
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.extensionDialog?.id, "question", "sync must not discard non-message events");
});

test("reopen hydrates a current partial and active tools even when no new token arrives", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  world.live.set("s1", liveSnapshot("s1", 10, assistantMsg("current", "recovered partial"), [{
    type: "tool_execution_update", toolCallId: "read-1", toolName: "read", args: { path: "x" },
    partialResult: { content: [{ type: "text", text: "recovered tool output" }] },
  }]));
  await act(async () => {
    // This token is still in the display coalescer when the newer HTTP state lands.
    es.open();
    es.emit({ type: "message_update", message: assistantMsg("current", "queued old partial") });
  });
  await settle(90);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "recovered partial");
  assert.equal(w.latest.liveToolResults.get("read-1")?.content[0].text, "recovered tool output");
  assert.deepEqual(w.latest.agentPhase?.tools, [{ id: "read-1", name: "read" }]);
  await act(async () => {
    es.emit({ type: "message_update", message: assistantMsg("current", "late pre-snapshot frame"), web: { streamId: "stream-s1", sequence: 9 } });
  });
  await settle(90);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "recovered partial");
});

test("a terminal event fences a held busy snapshot and does not revive streaming", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const release = holdNextSync("s1", syncSnapshot("s1", liveSnapshot("s1", 2, assistantMsg("current", "stale busy partial"))));
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "final answer")]);
    es.emit({ type: "agent_end", isTerminal: true });
    release();
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.streamState.streamingMessage, null);
  assert.equal(w.latest.messages.at(-1).content[0].text, "final answer");
});

test("a replacement prompt fences held history and keeps its optimistic user until disk confirms an ID", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun("s1");
  const release = holdNextSync("s1", syncSnapshot("s1", liveSnapshot("s1", 2, assistantMsg("a1", "old run"))));
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    const interrupt = w.latest.handleInterruptAndReply("new prompt");
    await sleep(20);
    const replacement = lastEs();
    replacement.open();
    await interrupt;
    replacement.emit({ type: "agent_end", isTerminal: true });
    replacement.emit({ type: "agent_start" });
    replacement.emit({ type: "message_update", message: assistantMsg("a2", "new run") });
    release();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "new run");
  assert.equal(w.latest.messages.at(-1).content, "new prompt");
  assert.deepEqual(w.latest.entryIds, ["e0"], "optimistic messages have no invented entry ID");
  await act(async () => {
    appendEntry("s1", userMsg("native", "new prompt (expanded by native)"));
    publishSessionsChanged(["s1"]);
  });
  await settle();
  assert.equal(w.latest.messages.at(-1).content, "new prompt (expanded by native)");
  assert.equal(w.latest.messages.length, 2);
});

test("branch navigation fences held catch-up and preserves the selected pre-compaction view", async () => {
  resetWorld();
  primeSession("s1", [userMsg("live", "live branch")]);
  const w = await mountSession("s1");
  const branch = { leafId: "branch", messages: [userMsg("b", "selected branch")], entryIds: ["branch-entry"] };
  const expanded = { leafId: "branch", messages: [userMsg("pre", "before compaction"), ...branch.messages], entryIds: ["pre-entry", "branch-entry"] };
  world.views.set("s1:branch:false", branch);
  world.views.set("s1:branch:true", expanded);
  const release = holdNextSync("s1", syncSnapshot("s1"));
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await sleep(20);
    await w.changeLeaf("branch");
    release();
  });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["branch-entry"]);
  assert.equal(w.latest.activeLeafId, "branch");
  await act(async () => {
    w.latest.togglePreCompactionHistory();
  });
  await settle();
  await act(async () => {
    publishSessionsChanged(["s1"]);
    window.dispatchEvent(new Event("online"));
  });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["pre-entry", "branch-entry"]);
  assert.equal(w.latest.showPreCompactionHistory, true);
  assert.equal(w.latest.activeLeafId, "branch");
  assert.deepEqual(callsTo("POST", "/api/agent/"), [], "reading a historical/file-only session must not start native");
});

test("file-only catch-up drains pages, deduplicates IDs, and keeps identical messages with distinct IDs", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const w = await mountSession("s1");
  const repeated = assistantMsg("not-a-persisted-id", "identical answer");
  const saved = [userMsg("u0", "q"), ...Array.from({ length: 205 }, () => repeated)];
  const ids = saved.map((_, i) => `e${i}`);
  saveSession("s1", [...saved, repeated], [...ids, "e205"]);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await settle();
  assert.deepEqual(w.latest.entryIds, ids);
  assert.equal(w.latest.messages.filter((m) => m.role === "assistant").length, 205);
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  assert.deepEqual(w.latest.entryIds, ids, "the same persisted ID cannot commit twice");
  assert.deepEqual(callsTo("POST", "/api/agent/"), []);
  // Compaction changed the context prefix and invalidates the old cursor.
  saveSession("s1", [assistantMsg("summary", "compacted history"), userMsg("tip", "new question")], ["summary", "new-tip"]);
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["summary", "new-tip"]);
  assert.equal(w.latest.messages[0].content[0].text, "compacted history");
});

test("failed idle catch-up preserves history and cursor for the next online trigger", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const w = await mountSession("s1");
  saveSession("s1", [userMsg("u0", "q"), assistantMsg("a1", "saved answer")]);
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/context?"),
    produce: async () => ({ status: 503, value: {} }),
  });
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["e0"]);
  assert.equal(w.latest.messages[0].content, "q");
  assert.equal(w.latest.error, null);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["e0", "e1"]);
  assert.equal(w.latest.messages[1].content[0].text, "saved answer");
});

test("file notification after delayed native persistence catches up even with SSE still attached", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  await act(async () => {
    es.emit({ type: "message_end", message: userMsg("u1", "q1") });
    es.emit({ type: "message_end", message: assistantMsg("a1", "saved later") }, { persist: false });
  });
  await settle();
  assert.equal(w.latest.messages.some((m) => m.role === "assistant"), false, "raw message_end has no durable identity");
  await act(async () => {
    appendEntry("s1", assistantMsg("a1", "saved later"));
    publishSessionsChanged(["s1"]);
  });
  await settle();
  assert.equal(es.closedByCaller, false);
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.messages.at(-1).content[0].text, "saved later");
  assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2"]);
});

test("wrapper epoch changes reject an old HTTP snapshot and hydrate the replacement stream", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const release = holdNextSync("s1", syncSnapshot("s1", liveSnapshot("s1", 20, assistantMsg("old", "old wrapper"))));
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    world.live.set("s1", { ...liveSnapshot("s1", 1, assistantMsg("new", "replacement wrapper")), cursor: { streamId: "replacement", sequence: 1 } });
    es.emit({ type: "connected", web: { streamId: "replacement", sequence: 0 } });
    release();
  });
  await settle();
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "replacement wrapper");
  assert.equal(w.latest.agentRunning, true);
});

test("an abandoned new-chat send delivers its prompt without promoting or attaching a stream", async () => {
  resetWorld();
  let release;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { sessionId: "created" } }); }),
  });
  const promoted = [];
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: (session) => promoted.push(session.id) });
  let send;
  await act(async () => {
    send = w.latest.handleSend("deliver after navigation");
    await sleep(20);
    w.unmount();
  });

  await act(async () => {
    release();
    assert.equal((await send).status, "accepted");
  });
  assert.deepEqual(promoted, []);
  assert.deepEqual(world.esInstances, []);
  assert.ok(world.calls.some((call) => call.url.startsWith("/api/agent/created") && call.body?.message === "deliver after navigation"));
});

test("a /btw that starts a fresh chat promotes it once omp accepts the question", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "created" } }),
  });
  holdBtwCommand("btw", async () => ({ value: { success: true, data: { record: btwRecord() } } }));
  const promoted = [];
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: (session) => promoted.push(session.id) });
  let asked;
  await act(async () => {
    asked = w.latest.handleBuiltinSlashCommand("/btw what is 2+2");
    await sleep(30); // spawn + pre-connect get_state
  });
  await act(async () => {
    lastEs().open();
    assert.deepEqual(await asked, { handled: true });
  });
  assert.ok(world.calls.some((call) => call.url.startsWith("/api/agent/created") && call.body?.type === "btw"));
  assert.deepEqual(promoted, ["created"], "the new-chat view becomes the session");
  w.unmount();
});

test("an abandoned new-chat /btw is still asked, but neither promotes, attaches a stream, nor reports success", async () => {
  resetWorld();
  let release;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { sessionId: "created" } }); }),
  });
  holdBtwCommand("btw", async () => ({ value: { success: true, data: { record: btwRecord() } } }));
  const promoted = [];
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: (session) => promoted.push(session.id) });
  let asked;
  await act(async () => {
    asked = w.latest.askBtw("asked before leaving");
    await sleep(20);
    w.unmount();
  });
  await act(async () => {
    release();
    // The stale composer must keep (not clear) a draft key the user moved on to.
    assert.equal(await asked, false);
  });
  assert.deepEqual(promoted, []);
  assert.deepEqual(world.esInstances, [], "an unmounted chat must not attach a stream its cleanup already ran for");
  assert.ok(world.calls.some((call) => call.url.startsWith("/api/agent/created") && call.body?.question === "asked before leaving"));
});

test("forking carries the advisor choice to the child's next native command", async () => {
  resetWorld();
  primeSession("advisor-parent", [userMsg("u0", "q")]);
  const forked = [];
  const w = await mountSession("advisor-parent", undefined, { onSessionForked: (id) => forked.push(id) });
  await act(async () => { w.latest.handleAdvisorChange(true); });
  world.holds.push({
    match: (method, url) => method === "POST" && url.startsWith("/api/agent/advisor-parent"),
    produce: async () => ({ value: { success: true, data: { newSessionId: "advisor-child" } } }),
  });
  await act(async () => { await w.latest.handleFork("e0", false); });
  assert.deepEqual(forked, ["advisor-child"]);
  assert.equal(localStorage.getItem("omp-advisor-enabled:advisor-child"), "true");
  const { sendAgentCommand } = await import("@/lib/agent-client");
  await sendAgentCommand("advisor-child", { type: "get_state" });
  assert.ok(world.calls.some((call) => call.url === "/api/agent/advisor-child?advisor=1"));
});

test("an edit-and-resend fork puts the branched prompt into the child's composer", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  for (const [editPrompt, child] of [[true, "edit-child"], [false, "keep-child"]]) {
    resetWorld();
    primeSession("fork-parent", [userMsg("u0", "q")]);
    const w = await mountSession("fork-parent", undefined, { onSessionForked: () => {} });
    world.holds.push({
      match: (method, url) => method === "POST" && url.startsWith("/api/agent/fork-parent"),
      produce: async () => ({ value: { success: true, data: { newSessionId: child, text: "retry this" } } }),
    });
    await act(async () => { await w.latest.handleFork("u0", editPrompt); });
    assert.equal(getDraft(child)?.value, editPrompt ? "retry this" : undefined);
    clearDraft(child);
    w.unmount();
  }
});

test("a second fork click while one is in flight sends no second fork command", async () => {
  resetWorld();
  primeSession("fork-busy", [userMsg("u0", "q")]);
  const w = await mountSession("fork-busy", undefined, { onSessionForked: () => {} });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, url) => method === "POST" && url.startsWith("/api/agent/fork-busy"),
    produce: async () => {
      await gate;
      return { value: { success: true, data: { newSessionId: "busy-child" } } };
    },
  });
  let first;
  await act(async () => { first = w.latest.handleFork("u0", false); await sleep(20); });
  await act(async () => { await w.latest.handleFork("u0", false); });
  release();
  await act(async () => { await first; });
  const forkCalls = world.calls.filter((c) => c.method === "POST" && c.url.startsWith("/api/agent/fork-busy"));
  assert.equal(forkCalls.length, 1);
  w.unmount();
});

// A native boundary, not an Edit callback double: active context follows parent
// links in the persisted JSONL, and prompts consume that context independently
// of what the hook happens to render. Metadata leaves never become model text.
function primeEditableHistory(originalSid, messages = [
  userMsg("u1", "U1"), assistantMsg("a1", "A1"),
  userMsg("u2", "U2-original"), assistantMsg("a2", "A2-original"),
  userMsg("u3", "U3-original"), assistantMsg("a3", "A3-original"),
]) {
  let sid = originalSid;
  let filePath = `/fixture/${sid}.jsonl`;
  const header = { type: "session", version: 3, id: sid, cwd: "/workspace", timestamp: "2026-01-01T00:00:00.000Z" };
  let entries = messages.map((message, index) => ({
    type: "message", id: `entry-${message.id}`,
    parentId: index === 0 ? null : `entry-${messages[index - 1].id}`,
    timestamp: header.timestamp, message: structuredClone(message),
  }));
  let jsonl;
  const persistedFiles = new Map();
  let editGate = Promise.resolve();
  let editReplyGate = Promise.resolve();
  let promptGate = Promise.resolve();

  function context(leafId = entries.at(-1)?.id ?? null) {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch = [];
    for (let entry = byId.get(leafId); entry; entry = byId.get(entry.parentId)) branch.push(entry);
    const messageEntries = branch.reverse().filter((entry) => entry.type === "message");
    return { leafId, entryIds: messageEntries.map((entry) => entry.id), messages: structuredClone(messageEntries.map((entry) => entry.message)) };
  }

  function persist() {
    jsonl = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    persistedFiles.set(filePath, jsonl);
    const nodes = new Map(entries.map((entry) => [entry.id, { entry: structuredClone(entry), children: [] }]));
    const roots = [];
    for (const entry of entries) {
      const parent = nodes.get(entry.parentId);
      (parent ? parent.children : roots).push(nodes.get(entry.id));
      world.views.set(`${sid}:${entry.id}:false`, context(entry.id));
    }
    world.sessions.set(sid, { ...context(), filePath, tree: roots });
  }

  const native = {
    get sessionId() { return sid; },
    get filePath() { return filePath; },
    edits: [], prompts: [], editOutcome: "success", moveTo: null, onMove: null,
    persistedFiles,
    get jsonl() { return jsonl; },
    get entries() { return structuredClone(entries); },
    get leafId() { return entries.at(-1)?.id ?? null; },
    holdEdit() {
      let release;
      editGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    holdEditReply() {
      let release;
      editReplyGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    holdPrompt() {
      let release;
      promptGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    reopen() {
      const [persistedHeader, ...persistedEntries] = jsonl.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(persistedHeader.id, sid, "reopening must retain the persisted session identity");
      entries = persistedEntries;
      persist();
      world.agents.set(sid, { running: false, state: {} });
    },
    async command(body) {
      if (body.type === "edit_message") {
        const target = entries.find((entry) => entry.id === body.entryId);
        assert.equal(target?.type, "message", "Edit must address a persisted entry, not message.id");
        assert.equal(target.message.role, "user", "native Edit only accepts user entries");
        native.edits.push(body.entryId);
        await editGate;
        let response;
        if (native.editOutcome === "error" || native.editOutcome === "persistence-error") {
          response = jsonResponse(400, { error: native.editOutcome === "persistence-error"
            ? "Could not append session file: disk full" : "Native history navigation failed" });
        } else if (native.editOutcome === "cancelled") {
          response = jsonResponse(200, {
            success: true, data: { cancelled: true, sessionId: sid, leafId: native.leafId },
          });
        } else {
          if (native.moveTo && native.moveTo !== sid) {
            const previousId = sid;
            sid = native.moveTo;
            filePath = `/fixture/${sid}.jsonl`;
            header.id = sid;
            world.nativeHistories.set(sid, native);
            world.agents.set(sid, world.agents.get(previousId));
            native.onMove?.(previousId, sid);
          }
          entries.push({
            type: "custom", customType: "omp-web-history-navigation", id: `edit-marker-${native.edits.length}`,
            parentId: target.parentId, timestamp: header.timestamp, data: { entryId: target.id },
          });
          persist();
          response = jsonResponse(200, { success: true, data: { cancelled: false, sessionId: sid, leafId: native.leafId } });
        }
        // The native change and its SSE can precede this client's HTTP reply.
        await editReplyGate;
        return response;
      }
      await promptGate;
      const number = native.prompts.length + 1;
      entries.push({
        type: "message", id: `entry-replacement-${number}`, parentId: native.leafId, timestamp: header.timestamp,
        message: userMsg(`replacement-${number}`, body.message),
      });
      persist();
      native.prompts.push({ sessionId: sid, filePath, ...context() });
      world.agents.set(sid, { running: true, state: { isStreaming: true, isPromptRunning: true } });
      return jsonResponse(200, { success: true, data: null });
    },
    completePrompt(stream) {
      assert.equal(stream.channel.sessionId, sid);
      const number = native.prompts.length;
      const message = assistantMsg(`revised-answer-${number}`, "A2-revised");
      entries.push({ type: "message", id: `entry-revised-answer-${number}`, parentId: native.leafId, timestamp: header.timestamp, message });
      persist();
      world.agents.set(sid, { running: false, state: { isStreaming: false, isPromptRunning: false } });
      stream.emit({ type: "agent_start" });
      stream.emit({ type: "message_end", message }, { persist: false });
      stream.emit({ type: "agent_end", isTerminal: true });
    },
  };
  persist();
  world.nativeHistories.set(sid, native);
  world.agents.set(sid, { running: false, state: {} });
  return native;
}

// Exercise the real server identity registry callback and Edit helper protocol.
// Only the native process/file boundary is controlled; history frames originate
// in AgentSessionWrapper, not from a second simulated edit implementation.
async function attachEditableWrapper(t, native, { holdHistory = false } = {}) {
  const listeners = new Set();
  const historyFrames = [];
  const identityChanges = [];
  const ready = { type: "ready", protocolVersion: 2 };
  let protocolNegotiated = false;
  const emitNative = (frame) => { for (const listener of [...listeners]) listener(frame); };
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    async waitReady() { return ready; },
    async negotiateProtocol(frame) {
      assert.equal(frame, ready, "the wrapper must negotiate the announced ready frame");
      protocolNegotiated = true;
    },
    onFrame(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async sendCommand(command) {
      assert.equal(protocolNegotiated, true, "commands must wait for readiness and protocol negotiation");
      if (command.type === "get_state") return {
        sessionId: native.sessionId, sessionFile: native.filePath,
        isStreaming: world.agents.get(native.sessionId)?.state?.isStreaming ?? false,
        isCompacting: false, isSettled: true, hasPendingAsyncWork: false, queuedMessageCount: 0,
      };
      if (command.type === "get_available_commands") return { commands: [{ name: SESSION_EDIT_COMMAND, source: "extension" }] };
      if (command.type === "prompt" && command.message.startsWith(`/${SESSION_EDIT_COMMAND} `)) {
        const request = JSON.parse(command.message.slice(SESSION_EDIT_COMMAND.length + 2));
        const response = await native.command({ type: "edit_message", entryId: request.entryId });
        const value = await response.json();
        if (native.editOutcome === "persistence-error") {
          emitNative({ type: "notice", source: "session-persistence", level: "error", message: value.error });
        }
        emitNative({ type: "extension_ui_request", method: "notify", message: SESSION_EDIT_RESPONSE_PREFIX + JSON.stringify({
          requestId: request.requestId, ...(response.ok ? value.data : { error: value.error }),
        }) });
        return { agentInvoked: false };
      }
      if (command.type === "prompt") { await native.command(command); return { agentInvoked: true }; }
      return {};
    },
    sendFrame() {},
    async dispose() { listeners.clear(); },
  }, process.cwd(), null, false, "", undefined, onlineHost);
  t.after(() => wrapper.destroyAndWait());
  native.onMove = () => emitNative({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a sibling file because another process owns the original" });
  wrapper.onIdentityChange((oldId, newId, options) => {
    identityChanges.push({ oldId, newId, keepOldId: options?.keepOldId });
    if (!options?.keepOldId) world.wrappers.delete(oldId);
    world.wrappers.set(newId, wrapper);
  });
  wrapper.onEvent((event) => {
    for (const [id, registered] of world.wrappers) {
      if (registered === wrapper) world.streams.set(id, event.web);
    }
    if (holdHistory && event.type === "session_history_changed") { historyFrames.push(event); return; }
    for (const stream of world.esInstances) {
      if (!stream.closedByCaller && world.wrappers.get(stream.channel.sessionId) === wrapper) stream.emit(event, { persist: false });
    }
  });
  wrapper.start();
  await wrapper.waitUntilReady();
  world.wrappers.set(native.sessionId, wrapper);
  return {
    wrapper, identityChanges, emitNative,
    completePrompt() { native.completePrompt({ channel: { sessionId: native.sessionId }, emit: emitNative }); },
    releaseHistory() {
      holdHistory = false;
      for (const event of historyFrames.splice(0)) {
        for (const stream of world.esInstances) {
          if (!stream.closedByCaller && world.wrappers.get(stream.channel.sessionId) === wrapper) stream.emit(event, { persist: false });
        }
      }
    },
  };
}

async function mountMovableChat(initialId, { onOpenFile } = {}) {
  const chatInputRef = React.createRef();
  let selectedId = initialId;
  let navigate;
  let changeLeaf;
  let activeLeaf;
  const onBranchDataChange = (_tree, leaf, handler) => { activeLeaf = leaf; changeLeaf = handler; };
  function Shell() {
    const [session, setSession] = React.useState(() => sessionInfo(initialId));
    const [navigationKey, setNavigationKey] = React.useState(0);
    navigate = (id) => {
      selectedId = id;
      setSession(sessionInfo(id));
      setNavigationKey((key) => key + 1);
      window.history.replaceState(null, "", `?session=${encodeURIComponent(id)}`);
    };
    return React.createElement(ChatWindow, {
      key: navigationKey, session, newSessionCwd: null, chatInputRef, onBranchDataChange, onOpenFile,
      onSessionMoved(oldId, newId) {
        if (selectedId !== oldId) return;
        selectedId = newId;
        setSession(sessionInfo(newId));
        window.history.replaceState(null, "", `?session=${encodeURIComponent(newId)}`);
      },
    });
  }
  window.history.replaceState(null, "", `?session=${encodeURIComponent(initialId)}`);
  const view = ownRoot(render(React.createElement(Shell), { wrapper: TestRoot }));
  await settle();
  await act(async () => { lastEs()?.open(); });
  await settle();
  return {
    view, chatInputRef, unmount: view.unmount,
    navigate: (id) => navigate(id), changeLeaf: (leaf) => changeLeaf(leaf),
    editButton: () => view.getAllByRole("button", { name: translate("messageView.editFromHereTitle") })[1],
    get selectedId() { return selectedId; }, get activeLeaf() { return activeLeaf; },
  };
}

async function mountEditableSession(sid, options = {}) {
  const { getDraft, setDraft } = await import("@/lib/draft-store");
  const session = sessionInfo(sid);
  const chatInputRef = options.chatInputRef ?? React.createRef();
  let latest;
  let sending;
  let changeLeaf;
  const onBranchDataChange = (_tree, _leaf, handler) => { changeLeaf = handler; };
  function Chat() {
    const [value, setValue] = React.useState(() => getDraft(sid)?.value ?? "");
    React.useImperativeHandle(chatInputRef, () => ({
      insertIfEmpty(text) { setValue((current) => current.trim() ? current : text); },
    }), []);
    React.useEffect(() => { setDraft(sid, { value, images: [], files: [] }); }, [value]);
    const hook = useAgentSession({ session, newSessionCwd: null, ...options, chatInputRef, onBranchDataChange });
    latest = hook;
    const historyBusy = hook.editingEntryId !== null || hook.forkingEntryId !== null;
    return React.createElement(React.Fragment, null,
      hook.messages.map((message, index) => message.role === "user"
        ? React.createElement("section", { key: hook.entryIds[index] ?? index, "data-testid": `message-${hook.entryIds[index]}` },
          React.createElement(MessageView, {
            message, entryId: hook.entryIds[index], onEdit: hook.handleEdit,
            editing: hook.editingEntryId === hook.entryIds[index], editDisabled: historyBusy,
            onFork: hook.handleFork, forking: hook.forkingEntryId === hook.entryIds[index], forkDisabled: historyBusy,
          })) : null),
      React.createElement("form", { onSubmit: (event) => {
        event.preventDefault();
        sending = hook.handleSend(value);
        void sending.then((sent) => { if (sent.status === "accepted") setValue((current) => current === value ? "" : current); });
      } },
      React.createElement("textarea", { "aria-label": "Test composer", value, onChange: (event) => setValue(event.target.value) }),
      React.createElement("button", { type: "submit" }, "Submit replacement")));
  }
  const view = ownRoot(render(React.createElement(Chat), { wrapper: TestRoot }));
  await settle();
  assert.equal(latest.loading, false, "the real hook must finish hydration");
  return {
    view, unmount: view.unmount, changeLeaf: (leafId) => changeLeaf(leafId),
    editButton: (entryId) => within(view.getByTestId(`message-${entryId}`)).getByRole("button", { name: translate("messageView.editFromHereTitle") }),
    get latest() { return latest; },
    get sending() { return sending; },
  };
}

// A live but idle wrapper supplies the observer connection without inventing
// an agent run just to deliver history notifications.
async function mountObservedEditableSession(sid, options = {}) {
  world.agents.set(sid, { running: true, state: { isStreaming: false, isPromptRunning: false } });
  const w = await mountEditableSession(sid, options);
  const stream = lastEs();
  assert.ok(stream, "the mounted hook must attach an idle history observer");
  assert.deepEqual(stream.channel, { kind: "session", sessionId: sid });
  await act(async () => { stream.open(); });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  return { w, stream };
}

for (const order of ["identity/history before HTTP", "HTTP before history delivery"]) {
  test(`native Edit relocation keeps the prefix, composer and resend (${order})`, async (t) => {
    resetWorld();
    const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
    const sid = `edit-move-${order.startsWith("identity") ? "early" : "late"}`;
    const target = `${sid}-owned`;
    for (const id of [sid, target]) clearDraft(id);
    t.after(() => { clearDraft(sid); clearDraft(target); });
    const images = [{ data: "AAAA", mimeType: "image/png" }];
    const files = [{ name: "context.txt", mimeType: "text/plain", content: "keep attached context", size: 21 }];
    setDraft(sid, { value: "", images, files });
    const native = primeEditableHistory(sid);
    native.moveTo = target;
    const original = structuredClone(world.sessions.get(sid));
    const originalEntries = native.entries;
    const originalJsonl = native.jsonl;
    const server = await attachEditableWrapper(t, native, { holdHistory: order.startsWith("HTTP") });
    const w = await mountMovableChat(sid);
    const composer = w.view.getByRole("textbox");
    let releaseReply;
    let replyReady = false;
    if (order.startsWith("identity")) {
      const replyGate = new Promise((resolve) => { releaseReply = resolve; });
      t.after(releaseReply);
      world.holds.push({
        match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message",
        produce: async () => {
          const result = await server.wrapper.send({ type: "edit_message", entryId: "entry-u2" });
          replyReady = true;
          await replyGate;
          return { value: { success: true, data: result } };
        },
      });
    }
    await confirmEdit(w.view, w.editButton());
    await until(() => server.identityChanges.length === 1, "native identity machinery must confirm the copy-on-write move");
    assert.deepEqual(server.identityChanges, [{ oldId: sid, newId: target, keepOldId: true }]);
    assert.equal(world.wrappers.get(sid), world.wrappers.get(target), "the existing alias registry retains the originating observer");
    if (releaseReply) {
      await until(() => replyReady, "the wrapper history event must precede the held HTTP response");
      assert.equal(w.selectedId, sid, "a native identity/history event alone cannot navigate the client");
      assert.equal(w.activeLeaf, original.leafId);
      assert.equal(composer.value, "");
      await act(async () => { releaseReply(); });
    }
    await until(() => w.selectedId === target && w.activeLeaf === native.leafId, "confirmed Edit must reload and select the moved conversation");
    await settle();
    assert.equal(w.view.getByRole("textbox"), composer, "ownership relocation preserves the live composer instance");
    assert.equal(w.view.getByRole("textbox").value, "U2-original");
    assert.equal(new URL(window.location.href).searchParams.get("session"), target);
    assert.deepEqual(getDraft(target), { value: "U2-original", images, files });
    assert.equal(getDraft(sid), null, "the draft moves rather than remaining on the abandoned branch");
    assert.deepEqual(world.sessions.get(sid), original, "the non-owned source file remains historical");
    assert.equal(native.persistedFiles.get(original.filePath), originalJsonl, "copy-on-write must never append the Edit marker to the source file");
    assert.deepEqual(native.entries.slice(0, originalEntries.length), originalEntries);
    assert.deepEqual(world.sessions.get(target).messages, original.messages.slice(0, 2));
    assert.equal(w.view.queryByText("U3-original"), null);

    // A held server frame is delivered during the replacement response. It must
    // not clear the optimistic prompt or reset streaming after the id changed.
    await act(async () => {
      fireEvent.change(w.view.getByRole("textbox"), { target: { value: "U2-modified" } });
      fireEvent.keyDown(w.view.getByRole("textbox"), { key: "Enter", code: "Enter" });
    });
    await until(() => lastEs()?.channel.sessionId === target, "resend must attach the confirmed native identity");
    await act(async () => { lastEs().open(); });
    await until(() => native.prompts.length === 1, "replacement prompt must reach native history");
    const partial = assistantMsg("moving-partial", "Moved response in progress");
    await act(async () => { server.emitNative({ type: "agent_start" }); server.emitNative({ type: "message_update", message: partial }); });
    await settle(90);
    await act(async () => { server.releaseHistory(); });
    await settle();
    assert.ok(w.view.getByText("Moved response in progress"), "a delayed history echo must not reset the new response");
    assert.equal(native.prompts[0].sessionId, target);
    assert.deepEqual(native.prompts[0].messages.slice(0, 2), original.messages.slice(0, 2));
    assert.match(native.prompts[0].messages.at(-1).content, /U2-modified/);
    assert.match(native.prompts[0].messages.at(-1).content, /keep attached context/);
    assert.equal(native.prompts[0].messages.some((message) => message.content === "U3-original"), false);
    const promptCall = world.calls.findLast((call) => call.body?.type === "prompt");
    assert.equal(promptCall.url, `/api/agent/${target}`);
    assert.deepEqual(promptCall.body.images.map(({ data, mimeType }) => ({ data, mimeType })), images);
    await act(async () => { server.completePrompt(); });
    await until(() => w.activeLeaf === native.leafId && w.view.queryByText("A2-revised") !== null, "the moved replacement must persist and hydrate");
    await act(async () => { await w.changeLeaf(original.leafId); });
    assert.ok(w.view.getByText("U3-original"), "the abandoned continuation remains browsable in the copied history");
    assert.deepEqual(world.sessions.get(sid), original);
    await act(async () => { await w.changeLeaf(null); });
    const revised = structuredClone(world.sessions.get(target));
    w.unmount();
    native.reopen();
    const reopened = await mountMovableChat(new URL(window.location.href).searchParams.get("session"));
    assert.equal(reopened.selectedId, target);
    assert.equal(reopened.activeLeaf, revised.leafId);
    assert.ok(reopened.view.getByText("A2-revised"), "reloading the selected URL keeps the revised conversation");
    assert.equal(reopened.view.queryByText("U3-original"), null);
  });
}

test("relocation merges existing target attachments and preserves typing added while reload awaits", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-new-typing", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const sourceImage = { data: "AAAA", mimeType: "image/png" };
  const targetImage = { data: "BBBB", mimeType: "image/webp" };
  const sourceFile = { name: "source.txt", mimeType: "text/plain", content: "source", size: 6 };
  const targetFile = { name: "target.txt", mimeType: "text/plain", content: "target", size: 6 };
  setDraft(sid, { value: "initial source draft", images: [sourceImage], files: [sourceFile] });
  setDraft(target, { value: "existing target draft", images: [targetImage], files: [targetFile] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  let release;
  t.after(() => release?.());
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${target}?`),
    produce: () => new Promise((resolve) => { release = () => resolve({ value: {
      sessionId: target, filePath: native.filePath, tree: world.sessions.get(target).tree,
      leafId: native.leafId, context: world.sessions.get(target),
    } }); }),
  });
  await confirmEdit(w.view, w.editButton());
  await until(() => release, "confirmed target history must be awaiting its load");
  await act(async () => {
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "new source typing" } });
    w.chatInputRef.current.addFiles([new File(["new file while waiting"], "new.txt", { type: "text/plain" })]);
  });
  await until(() => getDraft(sid)?.files.length === 2, "attachment reads completed during the reload must join the moved draft");
  await act(async () => { release(); });
  await until(() => w.selectedId === target, "the confirmed move must transition its composer");
  // Bun appends ";charset=utf-8" to a text File's type, so the type is pinned by its prefix.
  const mimeType = getDraft(target)?.files[1]?.mimeType ?? "";
  assert.ok(mimeType.startsWith("text/plain"), mimeType);
  assert.deepEqual(getDraft(target), {
    value: "new source typing\n\nexisting target draft", images: [sourceImage, targetImage],
    files: [sourceFile, { name: "new.txt", mimeType, content: "new file while waiting", size: 22 }, targetFile],
  });
  assert.equal(w.view.getByRole("textbox").value, "new source typing\n\nexisting target draft");
  assert.equal(getDraft(sid), null);
});

test("relocation keeps the source and existing target finished uploads", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-uploads", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const sourceUpload = { id: "up-source", name: "source.bin", size: 10, hostId: "local" };
  const targetUpload = { id: "up-target", name: "target.bin", size: 20, hostId: "local" };
  setDraft(sid, { value: "", images: [], files: [], uploads: [sourceUpload] });
  setDraft(target, { value: "Existing target text", images: [], files: [], uploads: [targetUpload] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the confirmed target must become selected");
  await settle();
  // The composer re-persists the merged list in its own order.
  assert.deepEqual(getDraft(target)?.uploads?.map((upload) => upload.id).sort(), [sourceUpload.id, targetUpload.id]);
  assert.equal(getDraft(sid), null);
});

test("upload continuity: confirmed identity move retains proof through composer persistence and outbox submission", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "proof-edit-move", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const upload = { id: "moved-upload", name: "moved.zip", size: 8, hostId: "local", proof: "moved-completion-proof" };
  setDraft(sid, { value: "", images: [], files: [], uploads: [upload] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the confirmed target must own the composer");
  await settle();
  assert.deepEqual(getDraft(target)?.uploads, [upload], "the live composer must preserve proof when rewriting its moved draft");
  assert.equal(getDraft(sid), null);
  world.outboxHold = true;
  await act(async () => { fireEvent.keyDown(w.view.getByRole("textbox"), { key: "Enter" }); });
  await until(() => world.outbox.length === 1, "the moved composer must store its message");
  assert.equal(world.outbox[0].sessionId, target);
  assert.deepEqual(world.outbox[0].uploadProofs, { "moved-upload": "moved-completion-proof" });
});

test("relocation merges an upload both drafts hold once", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft, subscribeDrafts } = await import("@/lib/draft-store");
  const sid = "edit-move-shared-upload", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const shared = { id: "up-shared", name: "shared.bin", size: 10, hostId: "local" };
  const targetOnly = { id: "up-target", name: "target.bin", size: 20, hostId: "local" };
  setDraft(sid, { value: "", images: [], files: [], uploads: [shared] });
  setDraft(target, { value: "Existing target text", images: [], files: [], uploads: [{ ...shared, name: "target-shared.bin" }, targetOnly] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const persistedUploads = [];
  t.after(subscribeDrafts(() => {
    if (getDraft(sid) === null) persistedUploads.push(getDraft(target)?.uploads ?? []);
  }));
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the confirmed target must become selected");
  await settle();
  assert.deepEqual(getDraft(target)?.uploads?.map((upload) => upload.id).sort(), [shared.id, targetOnly.id]);
  assert.equal(getDraft(target)?.uploads?.find((upload) => upload.id === shared.id)?.name, shared.name, "the source occurrence wins");
  assert.ok(persistedUploads.length > 0);
  for (const saved of persistedUploads) {
    assert.equal(saved.filter((upload) => upload.id === shared.id).length, 1, "no persisted snapshot contains the shared id twice");
  }
  assert.equal(getDraft(sid), null);
});

test("relocation adopts existing target text without prefilling over it", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-target-text", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const sourceImage = { data: "AAAA", mimeType: "image/png" };
  const targetFile = { name: "target.txt", mimeType: "text/plain", content: "Target context", size: 14 };
  setDraft(sid, { value: "", images: [sourceImage], files: [] });
  setDraft(target, { value: "Existing target text", images: [], files: [targetFile] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const composer = w.view.getByRole("textbox");
  assert.equal(composer.value, "");
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "the confirmed target must become selected");
  await settle();
  assert.equal(w.view.getByRole("textbox"), composer, "the existing composer adopts its new draft identity");
  assert.equal(composer.value, "Existing target text", "Edit prefill must not replace existing target content");
  assert.deepEqual(getDraft(target), { value: "Existing target text", images: [sourceImage], files: [targetFile] });
  assert.equal(getDraft(sid), null);
});

test("relocation at draft capacity preserves every unrelated draft and its attachments", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-full-drafts", target = `${sid}-owned`;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const unrelated = Array.from({ length: 49 }, (_, index) => {
    const id = `${sid}-unrelated-${index}`;
    return [id, {
      value: `Unsent conversation ${index}`,
      images: [{ data: png, mimeType: "image/png" }],
      files: [{ name: `context-${index}.txt`, mimeType: "text/plain", content: `Context ${index}`, size: 10 }],
    }];
  });
  clearDraft(target);
  t.after(() => { for (const id of [sid, target, ...unrelated.map(([id]) => id)]) clearDraft(id); });
  // Fill all 50 slots with the source newer than every unrelated draft.
  // This also removes any in-memory drafts left by earlier tests.
  for (const [id, draft] of unrelated) setDraft(id, draft);
  const source = {
    value: "",
    images: [{ data: png, mimeType: "image/png" }],
    files: [{ name: "source.txt", mimeType: "text/plain", content: "Source context", size: 14 }],
  };
  setDraft(sid, source);
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const composer = w.view.getByRole("textbox");
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "Edit must move the selected conversation at full draft capacity");
  await settle();
  assert.equal(w.view.getByRole("textbox"), composer);
  assert.equal(composer.value, "U2-original");
  assert.deepEqual(getDraft(target), { ...source, value: "U2-original" });
  assert.equal(getDraft(sid), null);
  for (const [id, draft] of unrelated) {
    assert.deepEqual(getDraft(id), draft, `relocation must preserve ${id}, including its attachments`);
  }
  const [oldestId, oldestDraft] = unrelated[0];
  primeEditableHistory(oldestId);
  await act(async () => { w.navigate(oldestId); });
  await settle();
  assert.equal(w.view.getByRole("textbox").value, oldestDraft.value, "the oldest unrelated conversation still restores its unsent text");
  assert.deepEqual(getDraft(oldestId), oldestDraft, "restoring the oldest composer keeps both attachment payloads");
});

for (const phase of ["HTTP response", "target reload"]) {
test(`navigation during a moved Edit's ${phase} is not hijacked or prefilled`, async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = `edit-move-leave-${phase.startsWith("HTTP") ? "http" : "reload"}`, target = `${sid}-owned`, other = `${sid}-other`;
  t.after(() => { for (const id of [sid, target, other]) clearDraft(id); });
  setDraft(sid, { value: "origin draft", images: [], files: [] });
  setDraft(other, { value: "other user's navigation draft", images: [], files: [] });
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  primeEditableHistory(other);
  const server = await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  let release;
  t.after(() => release?.());
  if (phase === "HTTP response") {
    world.holds.push({
      match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "edit_message",
      produce: async () => {
        const result = await server.wrapper.send({ type: "edit_message", entryId: "entry-u2" });
        await new Promise((resolve) => { release = resolve; });
        return { value: { success: true, data: result } };
      },
    });
  } else {
    world.holds.push({
      match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${target}?`),
      produce: () => new Promise((resolve) => { release = () => resolve({ value: {
        sessionId: target, leafId: native.leafId, tree: [], context: world.sessions.get(target),
      } }); }),
    });
  }
  await confirmEdit(w.view, w.editButton());
  await until(() => release, "the old instance must await the moved Edit");
  await act(async () => { w.navigate(other); });
  await settle();
  const selectedComposer = w.view.getByRole("textbox");
  await act(async () => { release(); });
  await settle();
  assert.equal(w.selectedId, other);
  assert.equal(new URL(window.location.href).searchParams.get("session"), other);
  assert.equal(selectedComposer.value, "other user's navigation draft");
  assert.equal(getDraft(other)?.value, "other user's navigation draft");
  assert.equal(getDraft(sid)?.value, "origin draft");
  assert.equal(getDraft(target), null);
});
}

test("a moved conversation whose reload fails preserves attachments without prefilling and reports failure", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-move-load-failed", target = `${sid}-owned`;
  t.after(() => { clearDraft(sid); clearDraft(target); });
  const draft = { value: "", images: [{ data: "AAAA", mimeType: "image/png" }],
    files: [{ name: "keep.txt", mimeType: "text/plain", content: "retained file", size: 13 }] };
  setDraft(sid, draft);
  const native = primeEditableHistory(sid);
  native.moveTo = target;
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${target}?`),
    produce: async () => ({ status: 503, value: {} }),
  });
  await confirmEdit(w.view, w.editButton());
  await until(() => w.selectedId === target, "authoritative identity must survive a failed read of the moved history");
  await settle();
  assert.equal(new URL(window.location.href).searchParams.get("session"), target);
  assert.equal(w.view.getByRole("textbox").value, "", "an unconfirmed history load must not prefill the original prompt");
  assert.deepEqual(getDraft(target), draft);
  assert.ok(w.view.getByText(translate("agentSession.commandFailed")));
});

test("observed edit-time persistence errors preserve the real composer and complete draft", async (t) => {
  resetWorld();
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-native-disk-error";
  t.after(() => clearDraft(sid));
  const draft = { value: "keep unsent text", images: [{ data: "AAAA", mimeType: "image/png" }],
    files: [{ name: "keep.txt", mimeType: "text/plain", content: "retained file", size: 13 }] };
  setDraft(sid, draft);
  const native = primeEditableHistory(sid);
  native.editOutcome = "persistence-error";
  const original = structuredClone(world.sessions.get(sid));
  await attachEditableWrapper(t, native);
  const w = await mountMovableChat(sid);
  const composer = w.view.getByRole("textbox");
  await confirmEdit(w.view, w.editButton());
  await until(() => w.view.queryAllByText(/Could not append session file: disk full/).length > 0, "native persistence failure must be displayed");
  await settle();
  assert.equal(w.selectedId, sid);
  assert.equal(w.view.getByRole("textbox"), composer);
  assert.equal(composer.value, draft.value);
  assert.deepEqual(getDraft(sid), draft);
  assert.deepEqual(world.sessions.get(sid), original);
  assert.equal(w.editButton().disabled, false, "failure releases the mutation gate without discarding draft state");
});

test("Edit rewinds and resends in the same persisted session while retaining the old branch", async (t) => {
  resetWorld();
  const { clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-same-session";
  clearDraft(sid);
  t.after(() => clearDraft(sid));
  const native = primeEditableHistory(sid);
  const originalEntries = native.entries;
  const original = world.sessions.get(sid);
  const forked = [];
  const options = { onSessionForked: (id) => forked.push(id) };
  const w = await mountEditableSession(sid, options);
  assert.equal(w.latest.data.filePath, native.filePath);
  const release = native.holdEdit();
  t.after(release);
  const edit = w.editButton("entry-u2");
  await confirmEdit(w.view, edit);
  await until(() => native.edits.length === 1, "the actual Edit button must reach native history navigation");
  assert.equal(w.latest.editingEntryId, "entry-u2");
  assert.equal(edit.disabled, true);
  await act(async () => {
    fireEvent.click(edit);
    assert.equal(await w.latest.handleEdit("entry-u2", "U2-original"), false, "the hook also refuses overlapping Edits");
    await w.latest.handleFork("entry-u2", true);
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "must not reach the old runtime" } });
  });
  await act(async () => {
    fireEvent.click(w.view.getByRole("button", { name: "Submit replacement" }));
    assert.equal((await w.sending).status, "rejected", "a nonempty send is refused while Edit is pending");
  });
  assert.deepEqual(native.edits, ["entry-u2"]);
  assert.deepEqual(native.prompts, []);
  assert.deepEqual(world.sessions.get(sid).messages, original.messages);
  await act(async () => {
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "" } });
    release();
  });
  await until(() => w.latest.editingEntryId === null && w.latest.entryIds.length === 2, "Edit must reload the real active prefix");
  assert.equal(w.latest.sessionIdRef.current, sid);
  assert.deepEqual(w.latest.messages, original.messages.slice(0, 2));
  assert.deepEqual(w.latest.entryIds, ["entry-u1", "entry-a1"]);
  assert.equal(w.latest.activeLeafId, "edit-marker-1", "the durable leaf is metadata, not the last visible message");
  assert.equal(w.view.getByRole("textbox").value, "U2-original");
  assert.deepEqual(native.entries.slice(0, originalEntries.length), originalEntries, "navigation must not remove the original continuation");
  assert.equal(native.entries.at(-1).parentId, "entry-a1");

  await act(async () => {
    fireEvent.change(w.view.getByRole("textbox"), { target: { value: "U2-modified" } });
  });
  await act(async () => { fireEvent.click(w.view.getByRole("button", { name: "Submit replacement" })); });
  await until(() => world.esInstances.some((stream) => stream.channel.sessionId === sid), "resend must connect to the same session");
  const stream = lastEs();
  await act(async () => { stream.open(); assert.equal((await w.sending).status, "accepted"); });
  assert.equal(native.prompts.length, 1);
  assert.equal(native.prompts[0].sessionId, sid);
  assert.equal(native.prompts[0].filePath, native.filePath);
  assert.deepEqual(native.prompts[0].messages, [original.messages[0], original.messages[1], userMsg("replacement-1", "U2-modified")],
    "the effective model context must exclude U2-original and every message after it");
  assert.equal(world.calls.findLast((call) => call.body?.type === "prompt").url, `/api/agent/${sid}`);
  await act(async () => { native.completePrompt(stream); });
  await until(() => !w.latest.agentRunning && w.latest.entryIds.at(-1) === "entry-revised-answer-1", "the revised branch must persist and hydrate");
  const revised = structuredClone(world.sessions.get(sid));
  const persisted = native.jsonl;
  w.unmount();
  world.sessions.delete(sid);
  native.reopen();
  const reopened = await mountEditableSession(sid, options);
  assert.equal(reopened.latest.sessionIdRef.current, sid);
  assert.equal(reopened.latest.data.filePath, native.filePath);
  assert.deepEqual(reopened.latest.entryIds, revised.entryIds);
  assert.deepEqual(reopened.latest.messages, revised.messages, "a cold reopen must select the persisted revised branch");
  assert.equal(reopened.latest.activeLeafId, revised.leafId);
  const branchReadsStart = world.calls.length;
  await act(async () => { await reopened.changeLeaf(original.leafId); });
  assert.deepEqual(reopened.latest.entryIds, original.entryIds);
  assert.deepEqual(reopened.latest.messages, original.messages, "the prior continuation remains reachable through read-only browsing");
  assert.deepEqual(world.sessions.get(sid).messages, revised.messages, "browsing must not move the native branch");
  await act(async () => { await reopened.changeLeaf(null); });
  assert.deepEqual(reopened.latest.messages, revised.messages);
  assert.equal(native.jsonl, persisted, "neither reopen nor read-only browsing rewrites the session file");
  assert.ok(world.calls.slice(branchReadsStart).every((call) => call.method === "GET"));
  assert.deepEqual([...world.sessions.keys()], [sid], "Edit never creates another session");
  assert.equal(world.calls.some((call) => call.body?.type === "fork" || call.url === "/api/agent/new" || call.body?.type === "new_session"), false);
  assert.deepEqual(forked, []);
});

for (const order of ["HTTP first", "SSE first"]) {
  test(`a handled Edit echo preserves a later historical selection (${order})`, async (t) => {
    resetWorld();
    const { clearDraft } = await import("@/lib/draft-store");
    const sid = `edit-echo-branch-${order === "HTTP first" ? "http" : "sse"}`;
    clearDraft(sid);
    t.after(() => clearDraft(sid));
    const native = primeEditableHistory(sid);
    const original = structuredClone(world.sessions.get(sid));
    const { w, stream } = await mountObservedEditableSession(sid);
    const releaseReply = order === "SSE first" ? native.holdEditReply() : null;
    if (releaseReply) t.after(releaseReply);
    await confirmEdit(w.view, w.editButton("entry-u2"));
    await until(() => native.leafId === "edit-marker-1", "the real native history must persist the Edit marker");
    const ownLeafId = native.leafId;
    if (releaseReply) {
      await act(async () => { stream.emit({ type: "session_history_changed", leafId: ownLeafId }); });
      assert.equal(w.latest.editingEntryId, "entry-u2", "the SSE must not complete the pending HTTP Edit");
      assert.deepEqual(w.latest.messages, original.messages);
      await act(async () => { releaseReply(); });
    }
    await until(() => w.latest.editingEntryId === null && w.latest.activeLeafId === ownLeafId, "the successful HTTP Edit must finish its own reload");
    await settle();
    assert.deepEqual(w.latest.entryIds, original.entryIds.slice(0, 2));
    assert.deepEqual(w.latest.messages, original.messages.slice(0, 2));

    // This is the public callback exported to the branch selector, not a
    // setter for hook internals. The native active branch stays rewound.
    await act(async () => { await w.changeLeaf(original.leafId); });
    assert.equal(w.latest.activeLeafId, original.leafId);
    assert.deepEqual(w.latest.entryIds, original.entryIds);
    assert.deepEqual(w.latest.messages, original.messages);
    const persisted = native.jsonl;
    await act(async () => { stream.emit({ type: "session_history_changed", leafId: ownLeafId }); });
    await settle();
    assert.equal(w.latest.activeLeafId, original.leafId, "a delayed own echo must not leave the selected historical branch");
    assert.deepEqual(w.latest.entryIds, original.entryIds);
    assert.deepEqual(w.latest.messages, original.messages);
    assert.equal(native.jsonl, persisted);
    assert.equal(world.sessions.get(sid).leafId, ownLeafId);
    // A subsequent normal refresh must retain the same catch-up selection.
    await act(async () => { publishSessionsChanged([sid]); });
    await settle();
    assert.equal(w.latest.activeLeafId, original.leafId);
    assert.deepEqual(w.latest.entryIds, original.entryIds);
    assert.deepEqual(w.latest.messages, original.messages);

    // Another client's Edit has a different durable marker and must still
    // leave the historical view and follow its newly selected native prefix.
    const externalReply = await native.command({ type: "edit_message", entryId: "entry-u3" });
    const { data: externalEdit } = await externalReply.json();
    assert.notEqual(externalEdit.leafId, ownLeafId);
    const external = structuredClone(world.sessions.get(sid));
    await act(async () => { stream.emit({ type: "session_history_changed", leafId: externalEdit.leafId }); });
    await until(() => w.latest.activeLeafId === externalEdit.leafId, "a distinct external marker must reload active history");
    await settle();
    assert.deepEqual(w.latest.entryIds, external.entryIds);
    assert.deepEqual(w.latest.messages, original.messages.slice(0, 4));
    assert.deepEqual(w.latest.messages, external.messages);
    assert.equal(w.latest.agentRunning, false);
    assert.deepEqual(native.prompts, []);
  });
}

test("an HTTP-first Edit echo cannot reset the next replacement prompt", async (t) => {
  const { clearDraft } = await import("@/lib/draft-store");
  for (const phase of ["dispatch pending", "streaming"]) {
    await t.test(phase, async (t) => {
      resetWorld();
      const sid = `edit-echo-send-${phase === "streaming" ? "live" : "pending"}`;
      clearDraft(sid);
      t.after(() => clearDraft(sid));
      const native = primeEditableHistory(sid);
      const original = structuredClone(world.sessions.get(sid));
      const { w, stream: observer } = await mountObservedEditableSession(sid);
      await confirmEdit(w.view, w.editButton("entry-u2"));
      await until(() => w.latest.editingEntryId === null && w.latest.activeLeafId === "edit-marker-1", "HTTP success and its reload must precede the next send");
      await settle();
      const ownLeafId = native.leafId;
      assert.deepEqual(w.latest.messages, original.messages.slice(0, 2));
      const releasePrompt = native.holdPrompt();
      t.after(releasePrompt);
      await act(async () => {
        fireEvent.change(w.view.getByRole("textbox"), { target: { value: "U2-modified" } });
      });
      await act(async () => { fireEvent.click(w.view.getByRole("button", { name: "Submit replacement" })); });
      const stream = lastEs();
      assert.equal(stream, observer, "outbox sends keep the existing observer");
      await act(async () => { stream.open(); });
      await until(() => world.calls.some((call) => call.body?.type === "prompt" && call.url === `/api/agent/${sid}`), "the replacement must reach the native dispatch boundary");
      assert.deepEqual(native.prompts, [], "native persistence is held independently of the outbox");
      assert.deepEqual(w.latest.entryIds, original.entryIds.slice(0, 2));
      assert.deepEqual(w.latest.messages, original.messages.slice(0, 2));
      assert.equal(w.latest.agentRunning, false, "holding a message does not start a turn");
      if (phase === "streaming") {
        await act(async () => { releasePrompt(); assert.equal((await w.sending).status, "accepted"); });
        const partial = assistantMsg("replacement-partial", "Revised answer in progress");
        await act(async () => {
          stream.emit({ type: "agent_start" });
          stream.emit({ type: "message_update", message: partial });
        });
        await settle(90);
        assert.deepEqual(w.latest.streamState.streamingMessage?.content, partial.content);
        assert.equal(w.latest.streamState.isStreaming, true);
      }
      const beforeEcho = {
        messages: structuredClone(w.latest.messages), entryIds: [...w.latest.entryIds],
        leafId: w.latest.activeLeafId, streamState: structuredClone(w.latest.streamState),
        agentPhase: structuredClone(w.latest.agentPhase), persisted: native.jsonl,
      };
      await act(async () => { stream.emit({ type: "session_history_changed", leafId: ownLeafId }); });
      await settle();
      assert.deepEqual(w.latest.messages, beforeEcho.messages, "the old Edit echo must not replace the new transcript");
      assert.deepEqual(w.latest.entryIds, beforeEcho.entryIds);
      assert.equal(w.latest.activeLeafId, beforeEcho.leafId);
      assert.deepEqual(w.latest.streamState, beforeEcho.streamState, "the old Edit echo must not reset the new live response");
      assert.deepEqual(w.latest.agentPhase, beforeEcho.agentPhase);
      assert.equal(w.latest.agentRunning, phase === "streaming");
      assert.equal(native.jsonl, beforeEcho.persisted);
      if (phase === "dispatch pending") {
        await act(async () => { releasePrompt(); assert.equal((await w.sending).status, "accepted"); });
      }
      await until(() => native.prompts.length === 1, "the dispatcher completes its held native prompt");
      assert.equal(native.prompts.length, 1);
      assert.deepEqual(native.prompts[0].messages, [
        ...original.messages.slice(0, 2), userMsg("replacement-1", "U2-modified"),
      ], "the replacement model context must remain on the edited prefix");
      await act(async () => { native.completePrompt(stream); });
      await until(() => !w.latest.agentRunning && w.latest.entryIds.at(-1) === "entry-revised-answer-1", "the replacement must still complete and hydrate normally");
      assert.deepEqual(w.latest.messages, world.sessions.get(sid).messages);
      assert.deepEqual(w.latest.notices, []);
      w.unmount();
    });
  }
});

test("history notifications received during an unsuccessful Edit remain effective", async (t) => {
  const { clearDraft } = await import("@/lib/draft-store");
  for (const outcome of ["cancelled", "error", "wrong-session"]) {
    await t.test(outcome, async (t) => {
      resetWorld();
      const sid = `edit-external-during-${outcome}`;
      clearDraft(sid);
      t.after(() => clearDraft(sid));
      const native = primeEditableHistory(sid);
      const original = structuredClone(world.sessions.get(sid));
      const { w, stream } = await mountObservedEditableSession(sid);
      native.editOutcome = outcome === "wrong-session" ? "success" : outcome;
      let releaseReply;
      const replyGate = new Promise((resolve) => { releaseReply = resolve; });
      t.after(releaseReply);
      let editCommand;
      let replyReady = false;
      world.holds.push({
        match: (method, url, body) => {
          if (method !== "POST" || url !== `/api/agent/${sid}` || body?.type !== "edit_message") return false;
          editCommand = body;
          return true;
        },
        produce: async () => {
          const response = await native.command(editCommand);
          const value = await response.json();
          if (outcome === "wrong-session") {
            // The backend, not a browser-side id equality check, rejects an
            // unrelated native conversation switch.
            replyReady = true;
            await replyGate;
            return { status: 409, value: { error: "The session changed during the history edit", code: "session_changed" } };
          }
          replyReady = true;
          await replyGate;
          return { status: response.status, value };
        },
      });
      await confirmEdit(w.view, w.editButton("entry-u2"));
      await until(() => replyReady, "the native Edit must settle before its HTTP reply is released");
      if (outcome !== "wrong-session") {
        // A separate client successfully navigates while this client's
        // cancellation/error reply is still in transit.
        native.editOutcome = "success";
        await native.command({ type: "edit_message", entryId: "entry-u3" });
      }
      const external = structuredClone(world.sessions.get(sid));
      assert.notEqual(external.leafId, original.leafId);
      await act(async () => { stream.emit({ type: "session_history_changed", leafId: external.leafId }); });
      await settle();
      assert.equal(w.latest.editingEntryId, "entry-u2");
      assert.equal(w.latest.activeLeafId, original.leafId);
      assert.deepEqual(w.latest.messages, original.messages);
      await act(async () => { releaseReply(); });
      await until(() => w.latest.editingEntryId === null && w.latest.activeLeafId === external.leafId, "an unacknowledged history marker must refresh after the Edit guard releases");
      await settle();
      assert.deepEqual(w.latest.entryIds, external.entryIds);
      assert.deepEqual(w.latest.messages, external.messages);
      assert.deepEqual(w.latest.messages, original.messages.slice(0, outcome === "wrong-session" ? 2 : 4));
      assert.equal(w.latest.sessionIdRef.current, sid);
      assert.equal(w.latest.data.filePath, native.filePath);
      assert.equal(w.view.getByRole("textbox").value, "", "an unsuccessful local Edit must not insert its draft");
      assert.deepEqual(w.latest.notices.map((notice) => notice.type), outcome === "cancelled" ? [] : ["error"]);
      assert.deepEqual(native.prompts, []);
      w.unmount();
    });
  }
});

test("cancelled and failed Edits preserve history selection and draft, then release the guard", async (t) => {
  const { getDraft, setDraft, clearDraft } = await import("@/lib/draft-store");
  for (const outcome of ["cancelled", "error"]) {
    await t.test(outcome, async (t) => {
      resetWorld();
      const sid = `edit-${outcome}`;
      setDraft(sid, { value: "keep my draft", images: [], files: [] });
      t.after(() => clearDraft(sid));
      const native = primeEditableHistory(sid);
      native.editOutcome = outcome;
      const original = structuredClone(world.sessions.get(sid));
      const persisted = native.jsonl;
      const forked = [];
      const w = await mountEditableSession(sid, { onSessionForked: (id) => forked.push(id) });
      await act(async () => { await w.changeLeaf("entry-a2"); });
      const selectedIds = [...w.latest.entryIds];
      const selectedMessages = structuredClone(w.latest.messages);
      await confirmEdit(w.view, w.editButton("entry-u2"));
      await until(() => native.edits.length === 1 && w.latest.editingEntryId === null, "the unsuccessful Edit must settle");
      assert.equal(w.latest.sessionIdRef.current, sid);
      assert.equal(w.latest.activeLeafId, "entry-a2");
      assert.deepEqual(w.latest.entryIds, selectedIds);
      assert.deepEqual(w.latest.messages, selectedMessages);
      assert.deepEqual(world.sessions.get(sid), original);
      assert.equal(native.jsonl, persisted);
      assert.equal(w.view.getByRole("textbox").value, "keep my draft");
      assert.equal(getDraft(sid)?.value, "keep my draft");
      assert.deepEqual(w.latest.notices.map((notice) => notice.type), outcome === "error" ? ["error"] : []);

      native.editOutcome = "success";
      await confirmEdit(w.view, w.editButton("entry-u2"));
      await until(() => native.edits.length === 2 && w.latest.editingEntryId === null, "a settled refusal must allow another Edit");
      assert.deepEqual(world.sessions.get(sid).entryIds, ["entry-u1", "entry-a1"]);
      assert.deepEqual(w.latest.entryIds, ["entry-u1", "entry-a1"]);
      assert.equal(w.view.getByRole("textbox").value, "keep my draft", "successful insertIfEmpty must not overwrite existing text");
      assert.equal(getDraft(sid)?.value, "keep my draft");
      assert.deepEqual([...world.sessions.keys()], [sid]);
      assert.equal(world.calls.some((call) => call.body?.type === "fork" || call.url === "/api/agent/new"), false);
      assert.deepEqual(forked, []);
      w.unmount();
    });
  }
});

test("an Edit completed after unmount cannot fill the current composer or change its view", async (t) => {
  resetWorld();
  const { clearDraft } = await import("@/lib/draft-store");
  const sid = "edit-abandoned";
  const currentSid = "edit-current-view";
  for (const id of [sid, currentSid]) clearDraft(id);
  t.after(() => { clearDraft(sid); clearDraft(currentSid); });
  const native = primeEditableHistory(sid);
  const currentNative = primeEditableHistory(currentSid, [userMsg("current-user", "Current question"), assistantMsg("current-answer", "Current answer")]);
  const sharedComposerRef = React.createRef();
  const forked = [];
  const options = { chatInputRef: sharedComposerRef, onSessionForked: (id) => forked.push(id) };
  const old = await mountEditableSession(sid, options);
  const release = native.holdEdit();
  t.after(release);
  await confirmEdit(old.view, old.editButton("entry-u2"));
  await until(() => native.edits.length === 1, "Edit must be waiting on native before leaving");
  old.unmount();
  const current = await mountEditableSession(currentSid, options);
  const currentHistory = structuredClone(current.latest.messages);
  const currentLeaf = current.latest.activeLeafId;
  const currentFile = currentNative.jsonl;
  await act(async () => { release(); });
  await until(() => native.leafId === "edit-marker-1", "native navigation may still finish in the abandoned session");
  await settle();
  assert.deepEqual(world.sessions.get(sid).entryIds, ["entry-u1", "entry-a1"], "this is a real successful native Edit, not a dropped response");
  assert.equal(current.latest.sessionIdRef.current, currentSid);
  assert.equal(current.latest.activeLeafId, currentLeaf);
  assert.deepEqual(current.latest.messages, currentHistory);
  assert.equal(current.latest.data.filePath, currentNative.filePath);
  assert.equal(currentNative.jsonl, currentFile);
  assert.equal(current.view.getByRole("textbox").value, "", "the shared composer ref now belongs to the new view");
  assert.deepEqual(current.latest.notices, []);
  assert.deepEqual(forked, []);
  assert.deepEqual([...world.sessions.keys()], [sid, currentSid]);
  assert.equal(world.calls.some((call) => call.body?.type === "fork" || call.url === "/api/agent/new"), false);
});

test("catch-up metadata cannot overwrite a newer live todo snapshot during a run", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const newerTodos = [{ id: "current", title: "Current plan", tasks: [] }];
  world.agents.set("s1", { running: true, state: { isStreaming: true, todoPhases: newerTodos } });
  const response = syncSnapshot("s1", liveSnapshot("s1", 10, assistantMsg("current", "current partial")));
  response.context.todoPhases = [{ id: "old", title: "Old disk plan", tasks: [] }];
  const release = holdNextSync("s1", response);
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    es.emit({ type: "todo_reminder" });
    await sleep(20);
    release();
  });
  await settle();
  assert.deepEqual(w.latest.todoPhases, newerTodos);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "current partial");
});

test("a late full branch context cannot replace a newer incremental history commit", async () => {
  // The full response is older than the completed catch-up, not merely page one.

  resetWorld();
  primeSession("s1", [userMsg("live", "live branch")]);
  const w = await mountSession("s1");
  const branch = { leafId: "branch", messages: [userMsg("b", "branch question")], entryIds: ["b1"] };
  world.views.set("s1:branch:false", branch);
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.includes("/api/sessions/s1/context?") && !url.includes("sync=1"),
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { context: branch } }); }),
  });
  let navigation;
  await act(async () => {
    navigation = w.changeLeaf("branch");
    await sleep(20);
    world.views.set("s1:branch:false", { ...branch, messages: [...branch.messages, assistantMsg("new", "new branch answer")], entryIds: ["b1", "b2"] });
    publishSessionsChanged(["s1"]);
  });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["b1", "b2"]);
  await act(async () => {
    release();
    await navigation;
  });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["b1", "b2"]);
  assert.equal(w.latest.messages.at(-1).content[0].text, "new branch answer");
});

for (const selected of ["active", "branch", "pre-compaction"]) {
  for (const order of ["full first", "pages first", "page two fails"]) {
    test(`${selected} history stays complete when ${order} races the full response`, async () => {
      resetWorld();
      primeSession("s1", [userMsg("u0", "existing view")]);
      const w = await mountSession("s1");
      if (selected === "pre-compaction") {
        world.views.set("s1:branch:false", { messages: [userMsg("b0", "selected branch")], entryIds: ["b0"], leafId: "branch" });
        await act(async () => { await w.changeLeaf("branch"); });
        await settle();
      }
      const previousIds = [...w.latest.entryIds];
      const saved = {
        messages: Array.from({ length: 205 }, (_, i) => assistantMsg(`m${i}`, `saved ${i}`)),
        entryIds: Array.from({ length: 205 }, (_, i) => `saved-${i}`),
        leafId: selected === "active" ? "saved-204" : "branch",
        todoPhases: [], thinkingLevel: "off", model: null,
      };
      if (selected === "active") world.sessions.set("s1", saved);
      else world.views.set(`s1:branch:${selected === "pre-compaction"}`, saved);
      let releaseFull;
      world.holds.push({
        match: (method, url) => method === "GET" && (selected === "active"
          ? url.startsWith("/api/sessions/s1?")
          : url.startsWith("/api/sessions/s1/context?") && !url.includes("sync=1")),
        produce: () => new Promise((resolve) => {
          releaseFull = () => resolve({ value: { sessionId: "s1", tree: [], leafId: saved.leafId, context: saved } });
        }),
      });
      let releasePage;
      world.holds.push({
        match: (method, url) => method === "GET" && url.includes("sync=1")
          && JSON.parse(new URL(url, "http://localhost").searchParams.get("cursor") ?? "null")?.lastEntryId === "saved-199",
        produce: () => new Promise((resolve) => {
          releasePage = () => resolve(order === "page two fails" ? { status: 503, value: {} } : {
            value: { ...selectSessionHistory(saved, { firstEntryId: "saved-0", lastEntryId: "saved-199" }), sessionId: "s1", leafId: saved.leafId, live: null },
          });
        }),
      });
      let fullLoad;
      await act(async () => {
        fullLoad = selected === "active" ? w.latest.handleHandoff()
          : selected === "branch" ? w.changeLeaf("branch") : w.latest.togglePreCompactionHistory();
        await sleep(20);
        publishSessionsChanged(["s1"]);
      });
      await settle();
      assert.ok(releaseFull && releasePage, "both reads must be held");
      assert.deepEqual(w.latest.entryIds, previousIds, "page one cannot truncate the selected view");

      if (order === "full first") {
        await act(async () => { releaseFull(); await fullLoad; });
        assert.deepEqual(w.latest.entryIds, saved.entryIds, "the full history is visible while page two is stalled");
      } else if (order === "page two fails") {
        await act(async () => { releasePage(); });
        await settle();
        assert.deepEqual(w.latest.entryIds, previousIds, "a failed later page must leave the complete old view intact");
        await act(async () => { releaseFull(); await fullLoad; });
        await settle();
        assert.deepEqual(w.latest.entryIds, saved.entryIds);
      }
      const newer = { ...saved, messages: [...saved.messages, assistantMsg("new", "arrived during fetch")], entryIds: [...saved.entryIds, "saved-new"], leafId: selected === "active" ? "saved-new" : "branch" };
      if (selected === "active") world.sessions.set("s1", newer);
      else world.views.set(`s1:branch:${selected === "pre-compaction"}`, newer);
      await act(async () => {
        publishSessionsChanged(["s1"]);
        if (order !== "page two fails") releasePage();
      });
      await settle();
      assert.deepEqual(w.latest.entryIds, newer.entryIds);
      if (order === "pages first") {
        await act(async () => { releaseFull(); await fullLoad; });
        await settle();
      }
      assert.deepEqual(w.latest.entryIds, newer.entryIds, "an older complete response cannot remove a newer confirmed suffix");
      assert.deepEqual(w.latest.messages, newer.messages, "history remains ordered and duplicate-free");
      assert.equal(w.latest.activeLeafId, newer.leafId);
      assert.equal(w.latest.showPreCompactionHistory, selected === "pre-compaction");
    });
  }
}

test("a late full load cannot overwrite a newly selected branch", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "old active branch")]);
  const w = await mountSession("s1");
  const old = structuredClone(world.sessions.get("s1"));
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith("/api/sessions/s1?"),
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { sessionId: "s1", tree: [], leafId: old.leafId, context: old } }); }),
  });
  let refresh;
  await act(async () => { refresh = w.latest.handleHandoff(); await sleep(20); });
  const branch = { messages: [userMsg("b0", "new selected branch")], entryIds: ["branch-entry"], leafId: "branch" };
  world.views.set("s1:branch:false", branch);
  await act(async () => { await w.changeLeaf("branch"); });
  await settle();
  await act(async () => { release(); await refresh; });
  assert.deepEqual(w.latest.entryIds, branch.entryIds);
  assert.deepEqual(w.latest.messages, branch.messages);
  assert.equal(w.latest.activeLeafId, "branch");
});

test("a late full load cannot overwrite a newly started run", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "old question")]);
  const w = await mountSession("s1");
  const old = structuredClone(world.sessions.get("s1"));
  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith("/api/sessions/s1?"),
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { sessionId: "s1", tree: [], leafId: old.leafId, context: old } }); }),
  });
  let refresh;
  await act(async () => { refresh = w.latest.handleHandoff(); await sleep(20); });
  let sending;
  await act(async () => { sending = w.latest.handleSend("new question"); await sleep(30); });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sending;
    world.agents.set("s1", { running: true, state: { isStreaming: true } });
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: userMsg("u1", "new question") });
    es.emit({ type: "message_update", message: assistantMsg("a1", "new run partial") });
  });
  await settle();
  await act(async () => { release(); await refresh; });
  assert.deepEqual(w.latest.entryIds, ["e0", "e1"]);
  assert.deepEqual(w.latest.messages.map((message) => message.content), ["old question", "new question"]);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "new run partial");
  assert.equal(w.latest.agentRunning, true);
});

test("a same-text queued delivery shows live and commits only when its distinct ID is saved", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "same");
  const delivered = userMsg("raw-without-persisted-identity", "same");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: delivered });
  });
  await settle();
  await act(async () => {
    es.emit({ type: "message_end", message: delivered }, { persist: false });
  });
  await settle();
  assert.deepEqual(w.latest.messages.map((message) => message.content), ["q", "same"]);
  await act(async () => {
    appendEntry("s1", delivered);
    publishSessionsChanged(["s1"]);
  });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2"]);
  assert.deepEqual(w.latest.messages.map((message) => message.content), ["q", "same", "same"]);
});

test("an orphaned tail cursor resets history even when the branch prefix still matches", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q"), assistantMsg("old", "orphaned answer")]);
  const w = await mountSession("s1");
  saveSession("s1", [userMsg("u0", "q"), assistantMsg("new", "replacement branch")], ["e0", "branch-tail"]);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["e0", "branch-tail"]);
  assert.equal(w.latest.messages[1].content[0].text, "replacement branch");
});

test("file triggers coalesce while a sync is held and rerun to recover later persistence", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun("s1");
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "first saved answer")]);
  const release = holdNextSync("s1", syncSnapshot("s1"));
  const before = callsTo("GET", "/api/sessions/s1/context?").length;
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    appendEntry("s1", assistantMsg("a2", "later saved answer"));
    publishSessionsChanged(["s1"]);
    publishSessionsChanged(["s1"]);
    release();
  });
  await settle();
  assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2", "e3"]);
  assert.deepEqual(w.latest.messages.filter((message) => message.role === "assistant").map((message) => message.content[0].text), ["first saved answer", "later saved answer"]);
  assert.equal(callsTo("GET", "/api/sessions/s1/context?").length - before, 2, "one in-flight read plus one coalesced reread");
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "streaming");
});

for (const persistBeforeReply of [true, false]) {
  test(`a concurrent completed message is fetched once when persistence is ${persistBeforeReply ? "before" : "after"} the held reply`, async () => {
    resetWorld();
    primeSession("s1", [userMsg("u0", "q")]);
    const { w, es } = await startStreamingRun("s1");
    world.agents.set("s1", { running: true, state: { isStreaming: true } });
    saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "first saved answer")]);
    await act(async () => { publishSessionsChanged(["s1"]); });
    await settle();
    assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2"]);

    appendEntry("s1", assistantMsg("a2", "repeated saved answer"));
    const release = holdNextSync("s1", syncSnapshot("s1", null, { firstEntryId: "e0", lastEntryId: "e2" }));
    const before = callsTo("GET", "/api/sessions/s1/context?").length;
    const concurrent = assistantMsg("a3", "repeated saved answer");
    await act(async () => {
      visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
      await sleep(20);
      es.emit({ type: "message_end", message: concurrent }, { persist: persistBeforeReply });
      es.emit({ type: "message_update", message: assistantMsg("a4", "new partial after completion") });
      release();
    });
    await settle();
    const reads = callsTo("GET", "/api/sessions/s1/context?").slice(before);
    assert.equal(reads.length, 2, "one in-flight fetch plus one completion-triggered reread");
    assert.equal(JSON.parse(new URL(reads[1].url, "http://localhost").searchParams.get("cursor")).lastEntryId, "e3", "the reread starts after the returned cursor");

    if (!persistBeforeReply) {
      assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2", "e3"], "an unpersisted event cannot advance the durable cursor");
      await act(async () => {
        appendEntry("s1", concurrent);
        publishSessionsChanged(["s1"]);
      });
      await settle();
    }
    assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2", "e3", "e4"]);
    assert.deepEqual(w.latest.messages.filter((message) => message.role === "assistant").map((message) => message.content[0].text), [
      "first saved answer", "repeated saved answer", "repeated saved answer",
    ]);
    assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "new partial after completion");
    assert.equal(w.latest.agentRunning, true);
  });
}

test("a saved provider failure still surfaces when its SSE completion arrives behind a newer snapshot", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const providerError = "Provider rejected the resumed request";
  const failed = { ...assistantMsg("failed", ""), stopReason: "error", errorMessage: providerError };
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), failed]);
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  world.live.set("s1", liveSnapshot("s1", 50, null));
  await act(async () => { visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  await settle();
  await act(async () => {
    es.emit({ type: "message_end", message: failed, web: { streamId: "stream-s1", sequence: 40 } }, { persist: false });
    world.agents.set("s1", { running: false, state: {} });
    world.live.set("s1", { ...liveSnapshot("s1", 51, null), isStreaming: false, isPromptRunning: false });
    window.dispatchEvent(new Event("online"));
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.ok(w.latest.notices.some((notice) => notice.type === "error" && notice.message === providerError));
  assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2"]);
  assert.equal(w.latest.messages.filter((message) => message.role === "assistant" && message.errorMessage === providerError).length, 1);
});

test("terminal full refresh updates branch metadata as well as cursor-owned history", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const tree = [{ id: "new-branch", children: [] }];
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "finished")]);
  world.sessions.get("s1").tree = tree;
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.deepEqual(w.latest.data.tree, tree);
  assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2"]);
  assert.equal(w.latest.activeLeafId, "e2");
  assert.equal(w.latest.agentRunning, false);
});

test("an unrelated newer notice does not prevent recovering a held partial and tool snapshot", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const snapshot = liveSnapshot("s1", 10, assistantMsg("missed", "recovered without another token"), [{
    type: "tool_execution_update", toolCallId: "missed-tool", toolName: "read",
    partialResult: { content: [{ type: "text", text: "recovered tool output" }] },
  }]);
  world.streams.set("s1", snapshot.cursor);
  const release = holdNextSync("s1", syncSnapshot("s1", snapshot));
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    es.emit({ type: "notice", level: "info", message: "A newer unrelated notice" });
    release();
  });
  await settle();
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "recovered without another token");
  assert.equal(w.latest.liveToolResults.get("missed-tool")?.content[0].text, "recovered tool output");
  assert.ok(w.latest.notices.some((notice) => notice.message === "A newer unrelated notice"));
});

test("selective hydration preserves newer queued tokens and per-tool progress while recovering another tool", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const snapshot = liveSnapshot("s1", 10, assistantMsg("old", "stale snapshot tokens"), [
    { type: "tool_execution_update", toolCallId: "newer-tool", toolName: "bash", partialResult: { content: [{ type: "text", text: "stale tool output" }] } },
    { type: "tool_execution_update", toolCallId: "missed-tool", toolName: "read", partialResult: { content: [{ type: "text", text: "recovered missed output" }] } },
  ]);
  world.streams.set("s1", snapshot.cursor);
  const release = holdNextSync("s1", syncSnapshot("s1", snapshot));
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    es.emit({ type: "tool_execution_start", toolCallId: "newer-tool", toolName: "bash" });
    es.emit({ type: "tool_execution_update", toolCallId: "newer-tool", toolName: "bash", partialResult: { content: [{ type: "text", text: "newer queued tool output" }] } });
    es.emit({ type: "message_update", message: assistantMsg("new", "newer queued tokens") });
    release();
  });
  await settle(90);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "newer queued tokens");
  assert.equal(w.latest.liveToolResults.get("newer-tool")?.content[0].text, "newer queued tool output");
  assert.equal(w.latest.liveToolResults.get("missed-tool")?.content[0].text, "recovered missed output");
});

const SLOW_MODEL = { provider: "anthropic", id: "claude-test" };
const SLOW_STATE = { stage: "low_priority", resetsAtSec: 1770000000, allowanceLeftPercent: 62 };

test("opening a session past its Claude usage limit shows the badge, and an idle /slow off clears it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { model: SLOW_MODEL, usageLimit: SLOW_STATE } });
  const w = await mountSession("s1");
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE);

  world.agents.set("s1", { running: true, state: { model: SLOW_MODEL } });
  await act(async () => { lastEs().emit({ type: "prompt_result", agentInvoked: false }); });
  await settle();
  assert.equal(w.latest.usageLimit, undefined);
});

test("the usage-limit badge appears mid-run and clears when the run ends without it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  world.agents.set("s1", { running: true, state: { isStreaming: true, model: SLOW_MODEL, usageLimit: SLOW_STATE } });
  // The in-run sample ticks every 2s; wait for it rather than a fixed sleep.
  for (let waited = 0; w.latest.usageLimit !== SLOW_STATE && waited < 5000; waited += 250) await settle(250);
  assert.deepEqual(w.latest.usageLimit, SLOW_STATE);

  saveSession("s1", [userMsg("u0", "q"), assistantMsg("a1", "done")]);
  world.agents.set("s1", { running: false, state: { model: SLOW_MODEL } });
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.equal(w.latest.usageLimit, undefined);
});

test("the Slow toggle follows omp's per-model state and is cleared by a switch to an unsupported model", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: true } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeSupported, true);
  assert.equal(w.latest.slowModeEnabled, true);

  // A model without /slow reports supported:false and omits enabled; the
  // persisted Claude setting may still be on, but it must not show as pressed.
  world.agents.set("s1", { running: true, state: { model: { provider: "openrouter", id: "other" }, slowModeSupported: false } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeSupported, false);
  assert.equal(w.latest.slowModeEnabled, false);
});

/** Mounts s1 with Slow at `enabled`, answers the next set_slow_mode with `answer`, and parks the follow-up state refresh so only the command's answer can move the toggle. */
async function mountSlowToggle(enabled, answer) {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: enabled, slowModeScope: "global" } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeEnabled, enabled);
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "set_slow_mode",
    produce: async () => answer,
  });
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/sessions/s1/state",
    produce: () => new Promise(() => {}),
  });
  return w;
}

for (const enabled of [false, true]) {
  test(`turning Slow ${enabled ? "on" : "off"} sends set_slow_mode and applies omp's answer`, async () => {
    const w = await mountSlowToggle(!enabled, { value: { success: true, data: { enabled } } });
    const posted = world.calls.length;
    await act(async () => { await w.latest.handleSlowModeChange(enabled); });
    const command = world.calls.slice(posted).find((call) => call.body?.type === "set_slow_mode");
    assert.deepEqual(command?.body, { type: "set_slow_mode", enabled });
    assert.equal(w.latest.slowModeEnabled, enabled);
    assert.deepEqual(w.latest.notices, []);
  });
}

test("a refused set_slow_mode leaves the toggle as it was and shows omp's error", async () => {
  const refusal = "Slow mode is unavailable for the current model.";
  const w = await mountSlowToggle(false, { status: 400, value: { error: refusal } });
  await act(async () => { await w.latest.handleSlowModeChange(true); });
  assert.equal(w.latest.slowModeEnabled, false);
  assert.deepEqual(w.latest.notices.map((n) => [n.type, n.message]), [["error", refusal]]);
});

test("before omp runs, Slow comes from the catalog and the Claude setting; live state then wins", async () => {
  resetWorld();
  world.models = {
    models: {}, defaultModel: null, anthropicSlowMode: true,
    modelList: [{ id: SLOW_MODEL.id, name: "Claude", provider: SLOW_MODEL.provider, supportsSlowMode: true }],
  };
  primeSession("s1", [userMsg("u0", "q")]);
  world.sessions.get("s1").model = { provider: SLOW_MODEL.provider, modelId: SLOW_MODEL.id };
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeSupported, true);
  assert.equal(w.latest.slowModeEnabled, true);
  assert.equal(w.latest.slowModeScope, "global");

  // Clicking spawns omp; one that reports no support for the model hides it.
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "set_slow_mode",
    produce: async () => { world.agents.set("s1", { running: true, state: { model: SLOW_MODEL, slowModeSupported: false } }); return { value: { success: true, data: { enabled: false } } }; },
  });
  await act(async () => { await w.latest.handleSlowModeChange(false); });
  await settle();
  assert.equal(w.latest.slowModeSupported, false);
  assert.equal(w.latest.slowModeEnabled, false);
});

test("the Slow scope follows omp's state and clears with support", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: { model: SLOW_MODEL, slowModeSupported: true, slowModeEnabled: false, slowModeScope: "global" } });
  const w = await mountSession("s1");
  assert.equal(w.latest.slowModeScope, "global");

  world.agents.set("s1", { running: true, state: { model: { provider: "openai", id: "gpt-test" }, slowModeSupported: true, slowModeEnabled: false, slowModeScope: "session" } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeScope, "session");

  world.agents.set("s1", { running: true, state: { model: { provider: "openrouter", id: "other" }, slowModeSupported: false } });
  await act(async () => { lastEs().emit({ type: "model_changed" }); });
  await settle();
  assert.equal(w.latest.slowModeScope, undefined);
});

test("HTTP discovery of a new wrapper replaces an old still-open stream before hydrating it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const snapshot = { ...liveSnapshot("s1", 1, assistantMsg("new", "new wrapper partial")), cursor: { streamId: "new-wrapper", sequence: 1 } };
  world.live.set("s1", snapshot);
  world.streams.set("s1", snapshot.cursor);
  const registrationsBefore = world.calls.length;
  world.subagentSnapshots.set("s1", [{ id: "new-child", agent: "explore", status: "started", index: 0, task: "recover roster" }]);
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  const replacement = lastEs();
  assert.notEqual(replacement, es);
  assert.equal(es.closedByCaller, true, "an old heartbeat-only connection must be replaced");
  await act(async () => { replacement.open(); });
  await settle();
  const restored = world.calls.slice(registrationsBefore).filter((c) => c.method === "POST").map((c) => c.body.type);
  assert.equal(restored.includes("set_host_tools"), true);
  assert.equal(restored.includes("set_host_uri_schemes"), true);
  assert.equal(w.latest.subagents.find((s) => s.id === "new-child")?.status, "started");
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "new wrapper partial");
  await act(async () => { replacement.emit({ type: "message_update", message: assistantMsg("new", "new wrapper live-only tokens") }); });
  await settle(90);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "new wrapper live-only tokens");
});

test("foreground catch-up replaces an idle CLOSED source and resumes later live-only updates", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("done", "finished")]);
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  await act(() => es.failFatal());
  const cursor = { streamId: "stream-s1", sequence: 10 };
  world.streams.set("s1", cursor);
  world.live.set("s1", { ...liveSnapshot("s1", 10, assistantMsg("resumed", "busy snapshot")), cursor });
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  const registrationsBefore = world.calls.length;
  world.subagentSnapshots.set("s1", [{ id: "resumed-child", agent: "explore", status: "started", index: 0, task: "quiet child" }]);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await settle();
  const replacement = lastEs();
  assert.notEqual(replacement, es);
  await act(async () => { replacement.open(); });
  await settle();
  const restored = world.calls.slice(registrationsBefore).filter((c) => c.method === "POST").map((c) => c.body.type);
  assert.equal(restored.includes("set_host_tools"), true);
  assert.equal(restored.includes("set_host_uri_schemes"), true);
  assert.equal(w.latest.subagents.find((s) => s.id === "resumed-child")?.status, "started");
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "busy snapshot");
  await act(async () => { replacement.emit({ type: "message_update", message: assistantMsg("resumed", "live-only continuation") }); });
  await settle(90);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "live-only continuation");
});

test("newer tool progress does not block hydration of a missed assistant partial", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  const snapshot = liveSnapshot("s1", 10, assistantMsg("missed", "missed assistant partial"), [{
    type: "tool_execution_update", toolCallId: "tool", toolName: "bash",
    partialResult: { content: [{ type: "text", text: "old tool result" }] },
  }]);
  world.streams.set("s1", snapshot.cursor);
  const release = holdNextSync("s1", syncSnapshot("s1", snapshot));
  await act(async () => {
    publishSessionsChanged(["s1"]);
    await sleep(20);
    es.emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash" });
    es.emit({ type: "tool_execution_update", toolCallId: "tool", toolName: "bash", partialResult: { content: [{ type: "text", text: "newer tool result" }] } });
    release();
  });
  await settle(90);
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "missed assistant partial");
  assert.equal(w.latest.liveToolResults.get("tool")?.content[0].text, "newer tool result");
});

test("idle closed streams retain capped backoff and a healthy replacement cancels pending retry", async (t) => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  saveSession("s1", [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "finished")]);
  await act(async () => { es.emit({ type: "agent_end", isTerminal: true }); });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });

  let source = es;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = world.esInstances.length;
    await act(async () => {
      source.failFatal();
      t.mock.timers.tick(delay - 1);
    });
    assert.equal(world.esInstances.length, before);
    await act(async () => { t.mock.timers.tick(1); });
    assert.equal(world.esInstances.length, before + 1);
    source = lastEs();
  }

  await act(async () => { source.open(); });
  const beforeReset = world.esInstances.length;
  await act(async () => {
    source.failFatal();
    t.mock.timers.tick(999);
  });
  assert.equal(world.esInstances.length, beforeReset);
  await act(async () => { t.mock.timers.tick(1); });
  assert.equal(world.esInstances.length, beforeReset + 1, "successful open resets the retry delay");

  source = lastEs();
  await act(async () => { source.open(); source.failFatal(); });
  world.live.set("s1", { ...liveSnapshot("s1", 100, null), isStreaming: false, isPromptRunning: false });
  await act(async () => { window.dispatchEvent(new Event("online")); });
  const healthy = lastEs();
  assert.notEqual(healthy, source, "foreground recovery replaces the closed source before its timer");
  await act(async () => {
    healthy.open();
    t.mock.timers.tick(30000);
  });
  assert.equal(lastEs(), healthy, "an orphaned backoff timer must not replace the healthy stream");
  assert.equal(healthy.closedByCaller, false);
});

test("idle file-only catch-up updates persisted model, thinking and data context without RPC startup", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  Object.assign(world.sessions.get("s1"), { model: { provider: "test", modelId: "old-model" }, thinkingLevel: "high" });
  const w = await mountSession("s1");
  assert.equal(w.latest.displayModel.modelId, "old-model");
  assert.equal(w.latest.thinkingLevel, "high");
  const context = world.sessions.get("s1");
  Object.assign(context, { model: { provider: "test", modelId: "external-model" }, thinkingLevel: "off" });
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  assert.equal(w.latest.displayModel.modelId, "external-model");
  assert.equal(w.latest.thinkingLevel, "off");
  assert.deepEqual(w.latest.data.context.model, context.model);
  assert.equal(w.latest.data.context.thinkingLevel, "off");
  assert.deepEqual(w.latest.data.context.entryIds, w.latest.entryIds);
  assert.equal(callsTo("POST", "/api/agent/").length, 0, "reading idle metadata must never spawn a process");
  assert.equal(world.esInstances.length, 0);
});

test("file metadata refresh preserves an active RPC model and thinking choice", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  world.agents.set("s1", { running: true, state: {
    isStreaming: true, model: { provider: "test", id: "live-model" }, thinkingLevel: "high",
  } });
  const w = await mountSession("s1");
  await act(async () => { lastEs().open(); });
  Object.assign(world.sessions.get("s1"), { model: { provider: "test", modelId: "persisted-model" }, thinkingLevel: "low" });
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  assert.equal(w.latest.agentRunning, true);
  assert.equal(w.latest.displayModel.modelId, "live-model");
  assert.equal(w.latest.thinkingLevel, "high");
  assert.equal(w.latest.data.context.model.modelId, "persisted-model", "data context still reflects confirmed disk metadata");
});

test("a held file snapshot cannot roll back a newer RPC model choice", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  Object.assign(world.sessions.get("s1"), { model: { provider: "test", modelId: "old-model" }, thinkingLevel: "low" });
  const w = await mountSession("s1");
  const release = holdNextSync("s1", syncSnapshot("s1"));
  await act(async () => { publishSessionsChanged(["s1"]); await sleep(20); });
  world.agents.set("s1", { running: true, state: { model: { provider: "test", id: "chosen-model" }, thinkingLevel: "high" } });
  await act(async () => { await w.latest.handleModelChange("test", "chosen-model"); });
  await act(async () => { release(); });
  await settle();
  assert.equal(w.latest.displayModel.modelId, "chosen-model");
  assert.equal(w.latest.thinkingLevel, "high");
});

test("a failed model switch is shown as a notice instead of failing silently (#277)", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  Object.assign(world.sessions.get("s1"), { model: { provider: "test", modelId: "old-model" }, thinkingLevel: "low" });
  const w = await mountSession("s1");
  assert.equal(w.latest.displayModel.modelId, "old-model");
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "set_model",
    produce: async () => ({
      status: 500,
      value: { error: "omp exited (code 1, signal none): error: Could not restore model test/old-model" },
    }),
  });
  await act(async () => { await w.latest.handleModelChange("test", "chosen-model"); });
  await settle();
  assert.equal(w.latest.displayModel.modelId, "old-model", "a failed switch must not claim the new model");
  assert.equal(w.latest.notices.at(-1)?.type, "error");
  assert.match(w.latest.notices.at(-1)?.message ?? "", /Could not restore model/);
});

test("idle catch-up cannot overwrite a pending thinking command", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  Object.assign(world.sessions.get("s1"), { thinkingLevel: "low" });
  const w = await mountSession("s1");
  let releaseCommand;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/s1",
    produce: () => new Promise((resolve) => { releaseCommand = () => resolve({ value: { success: true, data: {} } }); }),
  });
  let command;
  await act(async () => { command = w.latest.handleThinkingLevelChange("high"); await sleep(20); });
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  assert.equal(w.latest.thinkingLevel, "high");
  world.agents.set("s1", { running: true, state: { thinkingLevel: "high" } });
  await act(async () => { releaseCommand(); await command; });
  assert.equal(w.latest.thinkingLevel, "high");
});

test("failed cold-read reconnects never issue process-starting registrations", async (t) => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const w = await mountSession("s1");
  world.live.set("s1", { ...liveSnapshot("s1", 1, null), isStreaming: false, isPromptRunning: false });
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  const source = lastEs();
  world.live.delete("s1"); // wrapper vanished before the observer subscription
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await act(async () => { source.failFatal(); t.mock.timers.tick(1000); });
  await act(async () => { lastEs().failFatal(); t.mock.timers.tick(2000); });
  assert.equal(w.latest.agentRunning, false);
  assert.equal(callsTo("POST", "/api/agent/").length, 0);
});

test("unmount before replacement open cannot restore stale wrapper registrations", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun("s1");
  world.live.set("s1", { ...liveSnapshot("s1", 1, null), cursor: { streamId: "replacement", sequence: 1 } });
  await act(async () => { publishSessionsChanged(["s1"]); });
  await settle();
  const replacement = lastEs();
  await act(async () => { w.unmount(); });
  const before = world.calls.length;
  // The worker's open for the replacement lands after unmount closed it.
  await act(async () => { replacement.deliver({ type: "open" }); });
  assert.equal(world.calls.slice(before).some((c) => c.method === "POST"), false);
});

test("the answering tab keeps its dialog mounted during a synchronized cancel hand-off", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startStreamingRun("s1");
  await act(async () => {
    es.emit({ type: "extension_ui_request", id: "question", method: "confirm", title: "Keep going?" });
  });
  assert.equal(w.latest.extensionDialog?.id, "question");
  await act(async () => {
    const response = w.latest.respondToExtensionUi(w.latest.extensionDialog, { confirmed: true });
    es.emit({ type: "extension_ui_request", id: "cancel:question", method: "cancel", targetId: "question" });
    await response;
  });
  assert.equal(w.latest.extensionDialog?.id, "question", "the local hand-off window must survive its own synchronized cancel");
  await settle(300);
  assert.equal(w.latest.extensionDialog, null);
});

test("a vanished session's permanent outbox refusal remains a failed held bubble, not a recovered composer draft", async () => {
  resetWorld();
  const sid = "gone";
  const w = await mountSession(sid);
  await act(async () => { assert.deepEqual(await w.latest.handleSend("anyone there?"), { status: "accepted" }); });
  const entry = world.outbox[0];
  await act(() => workerPort.onmessage({ data: { outbox: [{ ...entry, state: "failed", error: "Session not found" }] } }));
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.heldMessages[0].state, "failed");
  assert.equal(w.latest.heldMessages[0].error, "Session not found");
  assert.deepEqual(w.latest.notices, [], "the held bubble owns permanent delivery errors");
});

// The incident behind abort_and_restore_queue: a promoted steer was still in
// omp when Stop landed but missing from this client's snapshot, so nothing
// withdrew it and omp ran it as a new turn after the abort. omp's atomic Esc
// takes back everything it holds, listed here or not.
test("Stop takes queued input back through omp in one step, including a steer the snapshot missed", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic");
  primeSession("abort-atomic", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic", "hello agent");
  world.abortRestoreQueue = {
    steering: [{ text: "steer the snapshot missed" }, { text: "[Image]" }],
    followUp: [
      { text: "later follow-up", images: [{ type: "image", data: "x", mimeType: "image/png" }] },
      { text: "[Image]", images: [{ type: "image", data: "y", mimeType: "image/webp" }] },
    ],
  };

  await act(async () => { await w.latest.handleAbort(); });

  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.equal(commands.filter((type) => type === "abort_and_restore_queue").length, 1);
  assert.equal(commands.includes("abort"), false, "omp's own abort already stopped the run");
  assert.equal(commands.includes("remove_queued_message"), false);
  assert.equal(getDraft("abort-atomic")?.value, "steer the snapshot missed\n\n[Image]\n\nlater follow-up", "only an image-only message's label is dropped");
  assert.deepEqual(getDraft("abort-atomic")?.images, [{ data: "x", mimeType: "image/png" }, { data: "y", mimeType: "image/webp" }]);
  assert.deepEqual(w.latest.notices, []);
  clearDraft("abort-atomic");
});

const isAtomicStop = (method, _url, body) => method === "POST" && body?.type === "abort_and_restore_queue";

test("a failed atomic Stop is retried once and restores what omp still held", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic-retry");
  primeSession("abort-atomic-retry", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-retry", "hello agent");
  world.holds.push({ match: isAtomicStop, produce: async () => ({ status: 502, value: { error: "Bad Gateway" } }) });
  world.abortRestoreQueue = { steering: [{ text: "retry me" }], followUp: [] };

  await act(async () => { await w.latest.handleAbort(); });

  const commands = world.calls.map((c) => c.body?.type).filter(Boolean);
  assert.equal(commands.filter((type) => type === "abort_and_restore_queue").length, 2);
  assert.equal(commands.includes("abort"), false, "a failure is not mistaken for an omp without the command");
  assert.equal(commands.includes("remove_queued_message"), false);
  assert.equal(getDraft("abort-atomic-retry")?.value, "retry me");
  assert.deepEqual(w.latest.notices, []);
  clearDraft("abort-atomic-retry");
});

test("an atomic Stop whose texts were lost with a failed response warns", async () => {
  resetWorld();
  primeSession("abort-atomic-lost", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-lost", "hello agent");
  // omp withdrew and aborted, but the answer never arrived; the queue is empty now.
  world.holds.push({ match: isAtomicStop, produce: async () => ({ status: 502, value: { error: "Bad Gateway" } }) });
  world.abortRestoreQueue = { steering: [], followUp: [] };

  await act(async () => { await w.latest.handleAbort(); });

  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false);
  assert.deepEqual(w.latest.notices.map((n) => n.type), ["warning"]);
});

test("a failed atomic Stop never retries into a run started after the click", async () => {
  resetWorld();
  primeSession("abort-atomic-fenced", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun("abort-atomic-fenced", "hello agent");
  let release;
  world.holds.push({ match: isAtomicStop, produce: () => new Promise((resolve) => { release = resolve; }) });
  world.abortRestoreQueue = { steering: [], followUp: [] };
  let stop;
  await act(async () => { stop = w.latest.handleAbort(); });
  await act(async () => {
    es.emit({ type: "message_end", message: assistantMsg("a1", "answer") });
    es.emit({ type: "agent_end", isTerminal: true });
  });
  await settle();
  let sending;
  await act(async () => { sending = w.latest.handleSend("next prompt"); await sleep(30); });
  await act(async () => { lastEs().open(); await sending; });
  await act(async () => {
    release({ status: 502, value: { error: "Bad Gateway" } });
    await stop;
  });

  assert.equal(world.calls.some((c) => c.body?.type === "prompt" && c.body?.message === "next prompt"), true);
  assert.equal(world.calls.filter((c) => c.body?.type === "abort_and_restore_queue").length, 1, "no retry into the new run");
  assert.equal(world.calls.some((c) => c.body?.type === "abort"), false, "nor a fallback abort");
});

test("overlapping Stops share one atomic withdrawal; an image-only entry does not come back as text", async () => {
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  resetWorld();
  clearDraft("abort-atomic-twice");
  primeSession("abort-atomic-twice", [userMsg("u0", "loaded question")]);
  const { w } = await startRun("abort-atomic-twice", "hello agent");
  world.abortRestoreQueue = {
    steering: [{ text: "[Image]", images: [{ type: "image", data: "x", mimeType: "image/png" }] }],
    followUp: [{ text: "words" }],
  };

  await act(async () => { await Promise.all([w.latest.handleAbort(), w.latest.handleAbort()]); });

  assert.equal(world.calls.filter((c) => c.body?.type === "abort_and_restore_queue").length, 1);
  assert.equal(getDraft("abort-atomic-twice")?.value, "words");
  clearDraft("abort-atomic-twice");
});

function skillDiagnosticsSnapshot(showStartupDiagnostics, name = "review") {
  return {
    cwd: "/workspace",
    showStartupDiagnostics,
    diagnostics: [{
      name,
      reason: "source-order",
      skills: [
        { name, filePath: `/workspace/.agents/skills/${name}/SKILL.md`, source: "project" },
        { name, filePath: `/home/me/.agents/skills/${name}/SKILL.md`, source: "user", pluginName: "shared" },
      ],
      duplicates: [{
        skill: { name, filePath: `/mirror/.agents/skills/${name}/SKILL.md`, source: "custom" },
        retained: { name, filePath: `/workspace/.agents/skills/${name}/SKILL.md`, source: "project" },
      }],
    }],
  };
}

test("skill diagnostics hydrate from state and follow defensive live updates", async () => {
  resetWorld();
  primeSession("skill-state", [userMsg("u0", "q")]);
  const initial = skillDiagnosticsSnapshot(true);
  world.agents.set("skill-state", {
    running: true,
    state: {
      skillDiagnostics: {
        ...initial,
        diagnostics: [{
          ...initial.diagnostics[0],
          skills: initial.diagnostics[0].skills.map((skill) => ({ ...skill, body: "private" })),
          privateDiagnostic: true,
        }],
        privateSnapshot: true,
      },
    },
  });

  const w = await mountSession("skill-state");
  assert.deepEqual(w.latest.skillDiagnostics, initial, "get_state hydration recovers a startup frame emitted before SSE attached");

  const updated = skillDiagnosticsSnapshot(false, "deploy");
  await act(() => lastEs().emit({
    type: "skill_diagnostics_update",
    data: { ...updated, containRoot: "/private" },
  }));
  assert.deepEqual(w.latest.skillDiagnostics, updated);

  await act(() => lastEs().emit({
    type: "skill_diagnostics_update",
    data: { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "none" },
  }));
  assert.equal(w.latest.skillDiagnostics, null, "malformed data is unsupported, not a fabricated clean result");

  const recovered = skillDiagnosticsSnapshot(true, "recovered");
  world.agents.set("skill-state", { running: true, state: { skillDiagnostics: recovered } });
  await act(async () => {
    lastEs().open();
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, recovered, "stream attachment reconciles an update emitted before SSE attached");
});

/** Start the startup-diagnostics setter with its POST held. `respond` answers the held POST; `saving` is the hook's promise. */
async function startHeldSkillSetter(w, sid, enabled) {
  let respond;
  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes(`/api/agent/${sid}`) && body?.type === "set_skill_startup_diagnostics",
    produce: () => new Promise((resolve) => { respond = (data) => resolve({ value: { success: true, data } }); }),
  });
  let saving;
  await act(async () => {
    saving = w.latest.setSkillStartupDiagnostics(enabled);
    await sleep(20);
  });
  // The test awaits `saving` itself; this only keeps a failed assertion from leaving an unhandled rejection behind.
  saving.catch(() => {});
  return { saving, respond: (data) => respond(data) };
}

test("the startup diagnostics setter publishes OMP's effective snapshot and rejects unsupported replies", async () => {
  resetWorld();
  primeSession("skill-actions", [userMsg("u0", "q")]);
  const on = skillDiagnosticsSnapshot(true);
  const off = skillDiagnosticsSnapshot(false);
  world.agents.set("skill-actions", { running: false, state: { skillDiagnostics: on } });
  const w = await mountSession("skill-actions");
  assert.deepEqual(w.latest.skillDiagnostics, on);

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: off } }),
  });
  let disabled;
  await act(async () => {
    disabled = await w.latest.setSkillStartupDiagnostics(false);
  });
  assert.deepEqual(disabled, off);
  assert.deepEqual(w.latest.skillDiagnostics, off, "the effective snapshot replaces the previous one");

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: off } }),
  });
  let overridden;
  await act(async () => {
    overridden = await w.latest.setSkillStartupDiagnostics(true);
  });
  assert.deepEqual(overridden, off, "an override that keeps the setting off is returned as the effective value, not the requested one");
  assert.deepEqual(w.latest.skillDiagnostics, off);

  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes("/api/agent/skill-actions") && body?.type === "set_skill_startup_diagnostics",
    produce: async () => ({ value: { success: true, data: { cwd: "/workspace", showStartupDiagnostics: false, diagnostics: null } } }),
  });
  await assert.rejects(() => w.latest.setSkillStartupDiagnostics(false), /skill diagnostics/i);
  assert.deepEqual(w.latest.skillDiagnostics, off, "a malformed response cannot erase the last supported snapshot");
  await assert.rejects(() => w.latest.setSkillStartupDiagnostics("false"), /boolean/i);
});

test("the startup diagnostics setter does not start an empty chat and rejects stale session responses", async () => {
  resetWorld();
  const empty = await mountSession(null);
  const callsBefore = world.calls.length;
  await assert.rejects(() => empty.latest.setSkillStartupDiagnostics(false), /active session/i);
  assert.equal(world.calls.length, callsBefore, "no active session means no lazy child-start request");

  primeSession("old-skills", [userMsg("u0", "old")]);
  const old = await mountSession("old-skills");
  const held = await startHeldSkillSetter(old, "old-skills", false);
  old.unmount();

  primeSession("current-skills", [userMsg("u0", "current")]);
  const current = await mountSession("current-skills");
  held.respond(skillDiagnosticsSnapshot(false, "stale"));
  await assert.rejects(held.saving, /stale/i);
  assert.equal(current.latest.skillDiagnostics, null, "the previous chat cannot update the selected chat");
});

test("a saved setting whose own update frame beats the HTTP response resolves to the saved snapshot", async () => {
  resetWorld();
  primeSession("skill-own-frame", [userMsg("u0", "q")]);
  const enabled = skillDiagnosticsSnapshot(true, "own-frame");
  world.agents.set("skill-own-frame", { running: true, state: { skillDiagnostics: enabled } });
  const w = await mountSession("skill-own-frame");
  assert.deepEqual(w.latest.skillDiagnostics, enabled);

  const { saving, respond } = await startHeldSkillSetter(w, "skill-own-frame", false);
  const saved = skillDiagnosticsSnapshot(false, "own-frame");
  try {
    // OMP emits the update frame before it answers the command.
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: saved }));
    assert.deepEqual(w.latest.skillDiagnostics, saved);
  } finally {
    respond(saved);
  }
  let result;
  await act(async () => {
    result = await saving;
  });
  assert.deepEqual(result, saved, "the control reports the saved setting instead of a stale failure");
  assert.deepEqual(w.latest.skillDiagnostics, saved);
});

test("a setter response overtaken by a newer update returns the current snapshot without rolling it back", async () => {
  resetWorld();
  primeSession("skill-newer-frame", [userMsg("u0", "q")]);
  world.agents.set("skill-newer-frame", { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "before") } });
  const w = await mountSession("skill-newer-frame");

  const { saving, respond } = await startHeldSkillSetter(w, "skill-newer-frame", false);
  const newer = skillDiagnosticsSnapshot(false, "after-reload");
  try {
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: newer }));
  } finally {
    respond(skillDiagnosticsSnapshot(false, "answered-before-reload"));
  }
  let result;
  await act(async () => {
    result = await saving;
  });
  assert.deepEqual(result, newer);
  assert.deepEqual(w.latest.skillDiagnostics, newer, "the older response never replaces a newer update");
});

test("a state snapshot requested before a newer skill update cannot overwrite it when it resolves late", async () => {
  resetWorld();
  primeSession("skill-order", [userMsg("u0", "q")]);
  world.agents.set("skill-order", { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "startup") } });
  const w = await mountSession("skill-order");

  let release;
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/agent/skill-order",
    produce: () => new Promise((resolve) => {
      release = () => resolve({ value: { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "stale-state") } } });
    }),
  });
  const newer = skillDiagnosticsSnapshot(false, "newer-update");
  try {
    await act(async () => {
      lastEs().open(); // stream attachment requests an authoritative state snapshot
      await sleep(20);
    });
    assert.ok(release, "precondition: the snapshot request is still in flight");
    await act(() => lastEs().emit({ type: "skill_diagnostics_update", data: newer }));
    assert.deepEqual(w.latest.skillDiagnostics, newer);
  } finally {
    release?.();
  }
  await act(async () => {
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, newer, "the late older snapshot is dropped");
});

test("a fresh chat hydrates and follows skill diagnostics after slash discovery creates its runtime", async () => {
  resetWorld();
  const startup = skillDiagnosticsSnapshot(true, "fresh-startup");
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-skills" } }),
  });
  world.agents.set("fresh-skills", { running: true, state: { skillDiagnostics: startup } });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  assert.equal(w.latest.skillDiagnostics, null, "an empty new-chat page has no runtime or diagnostics");
  assert.deepEqual(world.esInstances, [], "mounting an empty new chat must not attach a stream");

  await act(async () => { await w.latest.loadSlashCommands(); });
  const es = lastEs();
  assert.deepEqual(es?.channel, { kind: "session", sessionId: "fresh-skills" }, "the created runtime must be observed before its first prompt");
  await act(async () => {
    es.open();
    await sleep(30);
  });
  assert.deepEqual(w.latest.skillDiagnostics, startup, "the startup frame emitted before attachment is recovered from state");

  const updated = skillDiagnosticsSnapshot(false, "fresh-updated");
  await act(() => es.emit({ type: "skill_diagnostics_update", data: updated }));
  assert.deepEqual(w.latest.skillDiagnostics, updated, "live diagnostics follow the created runtime");
  assert.equal(callsTo("POST", "/api/agent/fresh-skills").some((call) => call.body?.type === "prompt"), false, "discovery never starts a model run");
  w.unmount();
});

test("a fresh chat runtime created after unmount cannot attach or apply skill diagnostics", async () => {
  resetWorld();
  let release;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: () => new Promise((resolve) => { release = () => resolve({ value: { sessionId: "stale-fresh" } }); }),
  });
  world.agents.set("stale-fresh", { running: true, state: { skillDiagnostics: skillDiagnosticsSnapshot(true, "stale-fresh") } });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  let discovery;
  await act(async () => {
    discovery = w.latest.loadSlashCommands();
    await sleep(20);
    w.unmount();
  });
  await act(async () => {
    release();
    await discovery;
    await sleep(30);
  });
  assert.deepEqual(world.esInstances, [], "a stale create must not leak an event stream");
  assert.equal(callsTo("GET", "/api/agent/stale-fresh").length, 0, "a stale create must not request diagnostics for a switched chat");
  assert.equal(w.latest.skillDiagnostics, null);
});

test("a fresh chat's first prompt attaches one event stream instead of an observer plus its own", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-send" } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: () => {} });
  let sent;
  await act(async () => {
    sent = w.latest.handleSend("first prompt");
    await sleep(30); // create the runtime and attach the prompt's stream
  });
  const streamsBeforeOpen = world.esInstances.length;
  let delivered;
  // Settle the send before asserting, so a failed assertion leaves no run behind.
  await act(async () => {
    lastEs().open();
    delivered = await sent;
  });
  w.unmount();
  assert.equal(delivered.status, "accepted");
  assert.equal(streamsBeforeOpen, 1, "the prompt owns the only stream");
  assert.equal(world.esInstances.length, 1);
  assert.equal(callsTo("POST", "/api/agent/fresh-send").some((call) => call.body?.type === "prompt"), true);
});

test("upload continuity: a fresh chat sends completion proof only with its direct prompt", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "proof-fresh" } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated() {} });
  let sending;
  await act(async () => {
    sending = w.latest.handleSend("first file", undefined, ["fresh-upload"], { "fresh-upload": "fresh-completion-proof" });
    await sleep(30);
  });
  let receipt;
  await act(async () => { lastEs().open(); receipt = await sending; });
  assert.equal(receipt.status, "accepted");
  assert.equal("uploadProofs" in callsTo("POST", "/api/agent/new")[0].body, false, "runtime creation has no attachment authority");
  const prompt = callsTo("POST", "/api/agent/proof-fresh").find((call) => call.body?.type === "prompt");
  assert.deepEqual(prompt?.body.uploads, ["fresh-upload"]);
  assert.deepEqual(prompt?.body.uploadProofs, { "fresh-upload": "fresh-completion-proof" });
});

test("a fresh chat's /btw question attaches one event stream instead of an observer plus its own", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: "fresh-btw" } }),
  });
  holdBtwCommand("btw", async () => ({ value: { success: true, data: { record: btwRecord() } } }));
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: () => {} });
  let asked;
  await act(async () => {
    asked = w.latest.handleBuiltinSlashCommand("/btw what is 2+2");
    await sleep(30); // create the runtime and attach the question's stream
  });
  const streamsBeforeOpen = world.esInstances.length;
  let result;
  // Settle the question before asserting, so a failed assertion leaves no request behind.
  await act(async () => {
    lastEs().open();
    result = await asked;
  });
  w.unmount();
  assert.deepEqual(result, { handled: true });
  assert.equal(streamsBeforeOpen, 1, "the question owns the only stream");
  assert.equal(world.esInstances.length, 1);
});

test("a first prompt rejected after promotion identifies the real-session recovery draft", async () => {
  resetWorld();
  const sid = "promoted-rejected-send";
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ value: { sessionId: sid } }),
  });
  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes(`/api/agent/${sid}`) && body?.type === "prompt",
    produce: async () => ({ status: 400, value: { error: "Wait for the history edit to finish", code: "session_busy" } }),
  });
  const promoted = [];
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace", onSessionCreated: (session) => promoted.push(session.id) });
  let sending;
  await act(async () => { sending = w.latest.handleSend("first question"); await sleep(30); });
  let receipt;
  await act(async () => { lastEs().open(); receipt = await sending; });
  assert.deepEqual(promoted, [sid]);
  assert.deepEqual(receipt, { status: "rejected", recoveryKey: sid });
  assert.equal(w.latest.agentRunning, false);
});

test("a late dispatcher failure cannot reject a stored send or reset a newer frame-owned run", async (t) => {
  resetWorld();
  const sid = "superseded-http-send";
  primeSession(sid, [userMsg("retained-u", "retained question")]);
  let release;
  t.after(() => release?.());
  world.holds.push({
    match: (method, url, body) => method === "POST" && url.includes(`/api/agent/${sid}`) && body?.type === "prompt" && body.message === "first prompt",
    produce: () => new Promise((resolve) => { release = () => resolve({ status: 502, value: { error: "late failed response" } }); }),
  });
  const w = await mountSession(sid);
  let first;
  await act(async () => { first = w.latest.handleSend("first prompt"); await sleep(30); });
  const es = lastEs();
  await act(async () => { es.open(); await sleep(30); });
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: userMsg("completed-u", "first prompt") });
    es.emit({ type: "message_end", message: assistantMsg("completed-a", "first answer") });
    es.emit({ type: "agent_end", isTerminal: true, messages: [] });
    await sleep(30);
  });
  let second;
  await act(async () => { second = w.latest.handleSend("second prompt"); await sleep(30); });
  if (lastEs() !== es) await act(async () => { lastEs().open(); });
  await act(async () => { await second; lastEs().emit({ type: "agent_start" }); });
  let receipt;
  await act(async () => { release(); receipt = await first; });
  assert.deepEqual(receipt, { status: "accepted" }, "the tab receipt is independent of the dispatcher's reply");
  assert.equal(w.latest.agentRunning, true, "the stale response cannot reset the newer run");
  assert.equal(w.latest.notices.some((notice) => notice.message.includes("late failed response")), false);
});

test("host_status frames report the session's host going offline and coming back", async () => {
  resetWorld();
  primeSession("remote-link", [userMsg("u0", "q")]);
  const { w, es } = await startRun("remote-link", "hello");
  assert.equal(w.latest.hostStatus, null, "no change reported yet");
  await act(() => es.emit({ type: "host_status", hostId: "h1", status: "offline" }));
  assert.equal(w.latest.hostStatus, "offline");
  assert.equal(w.latest.agentRunning, true, "the run continues on the host while its link is down");
  await act(() => es.emit({ type: "host_status", hostId: "h1", status: "online" }));
  assert.equal(w.latest.hostStatus, "online");
});

test("a send to an offline host is accepted and held without a toast or recovered draft", async () => {
  resetWorld();
  toastCalls.length = 0;
  world.outboxHold = true;
  const w = await mountSession("remote-off");
  await act(async () => { assert.deepEqual(await w.latest.handleSend("keep me"), { status: "accepted" }); });
  assert.equal(w.latest.heldMessages[0].message, "keep me");
  assert.equal(w.latest.heldMessages[0].state, "sending");
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(toastCalls, []);
  assert.deepEqual(w.latest.notices, []);
  assert.deepEqual(callsTo("POST", "/api/agent/"), []);
});

test("a fresh chat on a remote host creates its session there and toasts when that host is offline", async () => {
  resetWorld();
  toastCalls.length = 0;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ status: 503, value: { error: "Build box is offline", code: "host_offline", hostOffline: true } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/remote/work", newSessionHostId: "h1" });
  let receipt;
  await act(async () => { receipt = await w.latest.handleSend("first"); await sleep(30); });
  // Drafts for one path on two hosts must not share a composer key.
  assert.deepEqual(receipt, { status: "rejected", recoveryKey: "new:h1:/remote/work" });
  assert.deepEqual(callsTo("POST", "/api/agent/new").map((call) => [call.body.cwd, call.body.hostId]), [["/remote/work", "h1"]]);
  assert.equal(toastCalls[0]?.[0], "error");
  assert.equal(w.latest.notices.length, 0);
});

test("a fresh chat whose host drops after the spawn adopts the kept session, so a retry starts no second one", async () => {
  resetWorld();
  toastCalls.length = 0;
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ status: 503, value: { error: "Build box is offline", code: "host_offline", hostOffline: true, delivery: "refused", sessionId: "kept-remote" } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/remote/work", newSessionHostId: "h1", onSessionCreated: () => {} });
  let first;
  await act(async () => { first = await w.latest.handleSend("first"); await sleep(30); });
  assert.equal(first.status, "rejected");
  assert.equal(toastCalls[0]?.[0], "error");
  let retry;
  await act(async () => { retry = w.latest.handleSend("first"); await sleep(30); });
  await act(async () => { lastEs()?.open(); retry = await retry; });
  w.unmount();
  assert.equal(retry.status, "accepted");
  assert.equal(callsTo("POST", "/api/agent/new").length, 1, "the retry reuses the kept session");
  assert.equal(callsTo("POST", "/api/agent/kept-remote").some((call) => call.body?.type === "prompt"), true);
});

test("a fresh local chat sends no host id and keeps the pre-hosts draft key", async () => {
  resetWorld();
  world.holds.push({
    match: (method, url) => method === "POST" && url === "/api/agent/new",
    produce: async () => ({ status: 500, value: { error: "stop here" } }),
  });
  const w = await mountSession(null, undefined, { newSessionCwd: "/workspace" });
  let receipt;
  await act(async () => { receipt = await w.latest.handleSend("first"); await sleep(30); });
  assert.equal("hostId" in callsTo("POST", "/api/agent/new")[0].body, false);
  assert.deepEqual(receipt, { status: "rejected", recoveryKey: "new:/workspace" });
});

for (const [name, method, mode, message] of [
  ["steer", "handleSteer", "steer", "queued text"],
  ["follow-up", "handleFollowUp", "followUp", "queued text"],
  ["slash follow-up", "handleFollowUp", "followUp", "/skill queued text"],
]) {
  test(`a ${name} to an offline host is accepted into the outbox without a toast`, async () => {
    resetWorld();
    toastCalls.length = 0;
    world.outboxHold = true;
    const sid = `remote-queue-${name}`;
    primeSession(sid, [userMsg("u0", "q")]);
    const w = await mountSession(sid);
    await act(async () => { assert.equal(await w.latest[method](message), true); });
    assert.equal(w.latest.heldMessages[0].message, message);
    assert.equal(w.latest.heldMessages[0].mode, mode);
    assert.equal(w.latest.heldMessages[0].state, "sending");
    assert.deepEqual(toastCalls, []);
    assert.deepEqual(w.latest.notices, []);
    assert.deepEqual(callsTo("POST", "/api/agent/"), []);
  });
}

test("an unknown delivery outcome stays in the server outbox as failed and never returns to the composer", async (t) => {
  resetWorld();
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "remote-maybe";
  clearDraft(sid);
  t.after(() => clearDraft(sid));
  toastCalls.length = 0;
  world.outboxHold = true;
  const w = await mountSession(sid);
  await act(async () => { assert.deepEqual(await w.latest.handleSend("maybe sent"), { status: "accepted" }); });
  const entry = world.outbox[0];
  await act(() => lastEs().emit({ type: "outbox_update", entries: [{ ...entry, state: "failed", error: "Build box is offline", mayHaveBeenSent: true }] }));
  assert.equal(w.latest.heldMessages[0].state, "failed");
  assert.equal(w.latest.heldMessages[0].mayHaveBeenSent, true);
  assert.equal(w.latest.agentRunning, false);
  assert.equal(getDraft(sid), null);
  assert.deepEqual(toastCalls, []);
  assert.deepEqual(w.latest.notices, []);
});

test("a slash command held during a run dispatches as a prompt with its streaming behavior", async () => {
  resetWorld();
  primeSession("slash-outbox", [userMsg("u0", "q")]);
  const { w } = await startRun("slash-outbox", "run");
  await act(async () => { assert.equal(await w.latest.handleFollowUp("/skill queued text"), true); });
  const command = callsTo("POST", "/api/agent/slash-outbox").find((call) => call.body?.message === "/skill queued text");
  assert.deepEqual(command?.body, { type: "prompt", message: "/skill queued text", streamingBehavior: "followUp" });
});

// What the worker answers when the session socket dropped after sending a command (spec D5).
const SOCKET_LOST = { error: "The connection to omp-web dropped before the answer arrived; the command may have run.", code: "transport_lost" };

/** Runs a test with the worker in WebSocket mode, so agent commands go to it instead of fetch. */
async function inWebSocketMode(run) {
  const { openEventStream } = await import("@/lib/event-stream");
  openEventStream({ kind: "running" }).close(); // the tab's transport exists before the hook mounts
  workerPort.onmessage({ data: { transport: "ws" } });
  try {
    await run();
  } finally {
    workerPort.onmessage({ data: { transport: "sse" } });
    world.socketAnswer = null;
  }
}

test("a prompt is stored in the outbox even when the session socket cannot answer commands", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    world.outboxHold = true;
    world.socketAnswer = () => ({ status: 503, body: SOCKET_LOST });
    const w = await mountSession("socket-lost");
    await act(async () => { assert.deepEqual(await w.latest.handleSend("maybe sent"), { status: "accepted" }); });
    assert.equal(w.latest.heldMessages[0].message, "maybe sent");
    assert.equal(w.latest.agentRunning, false);
    assert.deepEqual(toastCalls, []);
    assert.deepEqual(w.latest.notices, []);
    assert.deepEqual(callsTo("POST", "/api/agent/socket-lost"), [], "the tab stores, not dispatches");
  });
});

test("a `!` command whose session socket dropped before the answer toasts that it may have run and stays out of the composer", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-bash", [userMsg("u0", "q")]);
    const offered = [];
    const w = await mountSession("socket-lost-bash", undefined, { chatInputRef: { current: { insertIfEmpty: (text) => offered.push(text) } } });
    world.socketAnswer = (command) => command.type === "bash" ? { status: 503, body: SOCKET_LOST } : null;
    await act(async () => { await w.latest.handleSend("!touch /tmp/once"); await sleep(30); });
    assert.deepEqual(offered, [], "the composer must not bring the command back: it may run twice");
    assert.deepEqual(toastCalls, [["info", translate("agentSession.transportLostMaybeSent")]]);
    assert.equal(w.latest.notices.length, 0);
  });
});

test("a `!` command the route refused is offered back to the composer with an error notice", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-refused-bash", [userMsg("u0", "q")]);
    const offered = [];
    const w = await mountSession("socket-refused-bash", undefined, { chatInputRef: { current: { insertIfEmpty: (text) => offered.push(text) } } });
    world.socketAnswer = (command) => command.type === "bash" ? { status: 400, body: { error: "Shell is busy" } } : null;
    await act(async () => { await w.latest.handleSend("!touch /tmp/once"); await sleep(30); });
    assert.deepEqual(offered, ["!touch /tmp/once"], "it never ran, so the composer gets it back");
    assert.deepEqual(toastCalls, []);
    assert.deepEqual(w.latest.notices.map((notice) => notice.type), ["error"]);
  });
});

test("a `!` command during a run runs at once and its held-back output shows until the transcript has it", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    const run = (timestamp) => ({ role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, timestamp });
    primeSession("midrun-bash", [userMsg("u0", "q")]);
    const { w, es } = await startRun("midrun-bash", "q1");
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    const result = { output: "hi\n", exitCode: 0, cancelled: false, truncated: false, deferred: true };
    world.socketAnswer = (command) => command.type === "bash" ? { status: 200, body: { success: true, data: result } } : null;
    let receipt;
    await act(async () => { receipt = await w.latest.handleSend("!echo hi"); await sleep(30); });
    assert.deepEqual(receipt, { status: "accepted" });
    assert.equal(w.latest.agentRunning, true, "the turn keeps running");
    assert.deepEqual(
      w.latest.deferredBash.map(({ command, output, exitCode }) => ({ command, output, exitCode })),
      [{ command: "echo hi", output: "hi\n", exitCode: 0 }],
    );

    await act(async () => { es.emit({ type: "agent_end", isTerminal: true, messages: [] }); await sleep(30); });
    await settle();
    assert.equal(w.latest.deferredBash.length, 1, "omp still holds it after the turn");

    // An older run of the same command comes into view (e.g. pre-compaction history): it is not this one.
    const before = world.sessions.get("midrun-bash").messages;
    saveSession("midrun-bash", [...before, run(1)]);
    await act(async () => { publishSessionsChanged(["midrun-bash"]); });
    await settle();
    assert.equal(w.latest.messages.filter((message) => message.role === "bashExecution").length, 1);
    assert.equal(w.latest.deferredBash.length, 1, "an older run does not count as this one");

    // omp writes it when a later prompt starts, stamped after everything before it.
    saveSession("midrun-bash", [...before, run(1), run(5)]);
    await act(async () => { publishSessionsChanged(["midrun-bash"]); });
    await settle();
    assert.deepEqual(w.latest.deferredBash, []);

    // Compaction drops it from the context: the shown output must not come back.
    saveSession("midrun-bash", [userMsg("u0", "q")]);
    await act(async () => { publishSessionsChanged(["midrun-bash"]); });
    await settle();
    assert.equal(w.latest.messages.some((message) => message.role === "bashExecution"), false);
    assert.deepEqual(w.latest.deferredBash, []);
  });
});

test("two held runs of the same `!` command each wait for their own recorded run", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    const run = (timestamp) => ({ role: "bashExecution", command: "git status", output: "clean\n", exitCode: 0, timestamp });
    primeSession("midrun-twice", [userMsg("u0", "q")]);
    const { w, es } = await startRun("midrun-twice", "q1");
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    const result = { output: "clean\n", exitCode: 0, cancelled: false, truncated: false, deferred: true };
    world.socketAnswer = (command) => command.type === "bash" ? { status: 200, body: { success: true, data: result } } : null;
    for (let i = 0; i < 2; i++) await act(async () => { await w.latest.handleSend("!git status"); await sleep(30); });
    assert.equal(w.latest.deferredBash.length, 2);

    const before = world.sessions.get("midrun-twice").messages;
    saveSession("midrun-twice", [...before, run(5)]);
    await act(async () => { publishSessionsChanged(["midrun-twice"]); });
    await settle();
    assert.equal(w.latest.deferredBash.length, 1, "one recorded run settles one held run");

    saveSession("midrun-twice", [...before, run(5), run(6)]);
    await act(async () => { publishSessionsChanged(["midrun-twice"]); });
    await settle();
    assert.deepEqual(w.latest.deferredBash, []);
  });
});

test("Stop during a run with a `!` command beside it stops the turn, not the command", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    primeSession("midrun-stop", [userMsg("u0", "q")]);
    const { w, es } = await startRun("midrun-stop", "q1");
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    const sent = [];
    let finishBash;
    world.socketAnswer = (command) => {
      sent.push(command.type);
      if (command.type !== "bash") return null;
      return new Promise((resolve) => { finishBash = () => resolve({ status: 200, body: { success: true, data: { output: "", exitCode: 0, cancelled: false, truncated: false, deferred: true } } }); });
    };
    let bash;
    await act(async () => { bash = w.latest.handleSend("!sleep 5"); await sleep(30); });
    assert.equal(w.latest.bashRunning, true);
    await act(async () => { void w.latest.handleAbort(); await sleep(30); });
    assert.equal(sent.includes("abort_bash"), false, "the shell command keeps running");
    assert.ok(sent.some((type) => type === "abort_and_restore_queue" || type === "abort"), "the turn is stopped");
    await act(async () => { finishBash(); await bash; });
  });
});

test("a steer is stored without consulting the session socket", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-steer", [userMsg("u0", "q")]);
    const w = await mountSession("socket-lost-steer");
    world.socketAnswer = (command) => command.type === "steer" ? { status: 503, body: SOCKET_LOST } : null;
    let accepted;
    await act(async () => { accepted = await w.latest.handleSteer("steer text"); await sleep(30); });
    assert.equal(accepted, true, "the composer drops the text: it may run");
    assert.deepEqual(toastCalls, []);
    assert.equal(w.latest.heldMessages[0].mode, "steer");
    assert.equal(w.latest.heldMessages[0].message, "steer text");
    assert.equal(w.latest.notices.length, 0);
  });
});

test("an existing-session send never waits for a pre-prompt get_state reply", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-state", [userMsg("u0", "q")]);
    const w = await mountSession("socket-lost-state");
    world.socketAnswer = (command) => command.type === "get_state" ? { status: 503, body: SOCKET_LOST } : null;
    let receipt;
    await act(async () => { receipt = await w.latest.handleSend("never sent"); await sleep(30); });
    assert.deepEqual(receipt, { status: "accepted" });
    assert.deepEqual(toastCalls, []);
    assert.deepEqual(w.latest.notices, []);
    assert.equal(w.latest.heldMessages[0].message, "never sent");
    assert.equal(w.latest.agentRunning, false);
    assert.equal(callsTo("POST", "/api/agent/socket-lost-state").some((call) => call.body?.type === "prompt"), false);
  });
});

test("an interrupt-and-reply whose abort_and_prompt reply was lost is reported as taken and the text is not offered again", async () => {
  await inWebSocketMode(async () => {
    resetWorld();
    toastCalls.length = 0;
    primeSession("socket-lost-interrupt", [userMsg("u0", "q")]);
    const offered = [];
    const { w, es } = await startRun("socket-lost-interrupt", "q1", false, { chatInputRef: { current: { insertIfEmpty: (text) => offered.push(text) } } });
    await act(async () => { es.emit({ type: "agent_start" }); await Promise.resolve(); });
    world.socketAnswer = (command) => command.type === "abort_and_prompt" ? { status: 503, body: SOCKET_LOST } : null;
    let interrupt;
    await act(async () => { interrupt = w.latest.handleInterruptAndReply("replacement"); await sleep(30); });
    let accepted;
    await act(async () => { lastEs().open(); accepted = await interrupt; });
    assert.equal(accepted, true, "the replacement may be running: the composer drops the text");
    assert.deepEqual(offered, [], "a resend would interrupt the replacement turn");
    assert.deepEqual(toastCalls, [["info", translate("agentSession.transportLostMaybeSent")]]);
  });
});

test("the hosts channel decides the offline banner; a frame only speaks before its first snapshot", async () => {
  resetWorld();
  primeSession("remote-banner", [userMsg("u0", "q")]);
  world.agents.set("remote-banner", { running: true, state: {} }); // a running chat attaches its stream on load
  const bannerText = translate("hosts.offlineBanner", { host: "Build box" });
  const mount = async (hostStatus) => {
    const view = ownRoot(render(React.createElement(ChatWindow, {
      session: { ...sessionInfo("remote-banner"), hostId: "h1" }, newSessionCwd: null, hostLabel: "Build box", ...(hostStatus ? { hostStatus } : {}),
    }), { wrapper: TestRoot }));
    await settle();
    await act(async () => { lastEs()?.open(); });
    await settle();
    return view;
  };
  const withChannel = await mount("online");
  await act(async () => { lastEs().emit({ type: "host_status", hostId: "h1", status: "offline" }); });
  assert.equal(withChannel.queryByText(bannerText), null, "a frame cannot override the channel's online status");
  withChannel.unmount();

  resetWorld();
  primeSession("remote-banner", [userMsg("u0", "q")]);
  world.agents.set("remote-banner", { running: true, state: {} }); // a running chat attaches its stream on load
  const beforeSnapshot = await mount(undefined);
  await act(async () => { lastEs().emit({ type: "host_status", hostId: "h1", status: "offline" }); });
  assert.ok(beforeSnapshot.queryByText(bannerText), "without a channel snapshot the frame shows the banner");
  beforeSnapshot.unmount();

  resetWorld();
  primeSession("remote-banner", [userMsg("u0", "q")]);
  world.agents.set("remote-banner", { running: true, state: {} }); // a running chat attaches its stream on load
  const offlineChannel = await mount("offline");
  assert.ok(offlineChannel.queryByText(bannerText), "a chat opened during an outage shows the banner from the channel");
});

// omp's delta message updates (lib/message-delta.ts, lib/message-update-coalescer.ts).
const recordedFrames = readFileSync(new URL("../tests/fixtures/omp-delta-stream.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line)).filter((frame) => frame.type !== "response");

/** What omp's full mode sends for the same run, at each block end: the message as streamed so far. */
function fullFramesOf(frames) {
  const open = new Map();
  const out = [];
  for (const frame of frames) {
    if (frame.type === "message_start") open.set(frame.messageId, structuredClone(frame.message));
    if (frame.type !== "message_update") {
      out.push(frame);
      continue;
    }
    const message = open.get(frame.messageId);
    const event = frame.assistantMessageEvent;
    if (event.type === "text_end") message.content[event.contentIndex] = { ...event.block, text: event.content };
    else if (event.type === "thinking_end") message.content[event.contentIndex] = { ...event.block, thinking: event.content };
    else if (event.type === "toolcall_end") message.content[event.contentIndex] = event.toolCall;
    else continue;
    out.push({ type: "message_update", messageId: frame.messageId, message: structuredClone(message), assistantMessageEvent: { ...event, partial: message } });
  }
  return out;
}

async function streamRecorded(frames) {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", recordedFrames[0].message.content[0].text);
  await act(async () => { es.emit({ type: "agent_start" }); });
  const shown = [];
  let toolArguments;
  for (const frame of frames) {
    if (frame.type === "message_end" && frame.message.role === "assistant") {
      await settle(90);
      shown.push(structuredClone(w.latest.streamState.streamingMessage?.content));
    }
    await act(async () => { es.emit(frame); await Promise.resolve(); });
    if (frame.assistantMessageEvent?.type === "toolcall_delta" && toolArguments === undefined) {
      await settle(90);
      toolArguments = structuredClone(w.latest.streamState.streamingMessage?.content[2]);
    }
  }
  await settle(90);
  return { shown, toolArguments, messages: structuredClone(w.latest.messages) };
}

test("a run streamed as omp's delta updates renders exactly what its full updates render", async () => {
  const deltas = await streamRecorded(recordedFrames);
  const full = await streamRecorded(fullFramesOf(recordedFrames));
  assert.equal(deltas.shown.length, 2);
  assert.deepEqual(deltas.shown, full.shown, "each reply as it stood before message_end");
  assert.deepEqual(deltas.messages, full.messages, "the committed transcript");
  assert.deepEqual(deltas.shown[0].map((block) => block.type), ["thinking", "text", "toolCall"]);
  assert.equal(deltas.toolArguments.toolName, "read", "a streaming tool call shows its name from its first delta");
  assert.deepEqual(deltas.toolArguments.input, { path: "note.txt" }, "and the arguments streamed so far");
});

test("deltas that reach a tab without their message wait for the server's snapshot, then apply on top of it", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "go");
  await act(async () => { es.emit({ type: "agent_start" }); });
  await settle(90);
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  const sequence = world.streams.get("s1").sequence;
  world.live.set("s1", { ...liveSnapshot("s1", sequence, { role: "assistant", content: [{ type: "text", text: "hello" }] }), streamingMessageId: "msg-2" });
  const syncs = callsTo("GET", "/api/sessions/s1/context").length;
  const delta = (text) => ({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
  await act(async () => {
    es.emit(delta(" there"));
    es.emit(delta("!"));
  });
  await settle(150);
  assert.ok(callsTo("GET", "/api/sessions/s1/context").length > syncs, "a delta without its message asks for the snapshot");
  assert.equal(w.latest.streamState.streamingMessage?.content[0].text, "hello there!");
});

test("an outbox prompt moves from browser sending to waiting_host and hands off to its echo without a gap", async () => {
  resetWorld();
  const sid = "outbox-handoff";
  primeSession(sid, [userMsg("u0", "before")]);
  world.outboxHold = true;
  const w = await mountSession(sid);
  await act(async () => { assert.deepEqual(await w.latest.handleSend("held message"), { status: "accepted" }); });
  assert.equal(w.latest.agentRunning, false);
  assert.deepEqual(w.latest.messages.map((message) => message.content), ["before"]);
  assert.equal(w.latest.heldMessages.length, 1);
  const held = w.latest.heldMessages[0];
  assert.equal(held.state, "sending");
  assert.equal(held.local, true);
  assert.equal(world.outbox[0].scope, "test-scope", "the worker entry stays bound to the server-issued authorization scope");
  const es = lastEs();
  await act(() => es.emit({ type: "outbox_update", entries: [{ ...world.outbox[0], state: "waiting_host" }] }));
  assert.equal(w.latest.heldMessages.length, 1, "server and browser copies merge by id");
  assert.equal(w.latest.heldMessages[0].id, held.id);
  assert.equal(w.latest.heldMessages[0].state, "waiting_host");
  assert.equal(w.latest.heldMessages[0].local, false);
  const echo = userMsg("echo", "held message");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: echo }, { persist: false });
    es.emit({ type: "outbox_update", entries: [] });
  });
  assert.deepEqual(w.latest.heldMessages, []);
  assert.deepEqual(w.latest.messages.at(-1), echo, "omp's echo bridges the not-yet-saved transcript");
  appendEntry(sid, echo);
  await act(() => es.emit({ type: "session_history_changed", leafId: world.sessions.get(sid).leafId }));
  await settle();
  assert.equal(w.latest.messages.filter((message) => message.content === "held message").length, 1, "the saved copy replaces rather than duplicates the echo");
});

test("a 409 deleting a dispatched outbox message shows a notice and keeps the bubble", async (t) => {
  resetWorld();
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "outbox-remove-race";
  clearDraft(sid);
  t.after(() => clearDraft(sid));
  primeSession(sid, [userMsg("u0", "before")]);
  const w = await mountSession(sid);
  await act(async () => { await w.latest.handleSend("open channel"); });
  const entry = { id: "already-dispatched", sessionId: sid, mode: "prompt", message: "must not resend", state: "held", createdAt: 1 };
  await act(() => lastEs().emit({ type: "outbox_update", entries: [entry] }));
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "outbox_remove",
    produce: async () => ({ status: 409, value: { error: "outbox_dispatched" } }),
  });
  await act(async () => { await w.latest.deleteHeldMessage(entry.id); });
  assert.equal(getDraft(sid), null);
  assert.equal(w.latest.notices.length, 1);
  assert.equal(w.latest.notices[0].type, "error");
  assert.match(w.latest.notices[0].message, /outbox_dispatched/);
  assert.equal(w.latest.heldMessages.some((held) => held.id === entry.id), true);
});

test("mounting a session with an outbox snapshot subscribes without starting omp and shows its held messages", async () => {
  resetWorld();
  const sid = "outbox-mount";
  primeSession(sid, [userMsg("u0", "before")]);
  const entry = { id: "waiting-on-mount", sessionId: sid, mode: "steer", message: "waiting", state: "waiting_host", createdAt: 1 };
  world.holds.push({
    match: (method, url) => method === "GET" && url === `/api/sessions/${sid}/state`,
    produce: async () => ({ value: { running: false, outbox: [entry], outboxScope: "test-scope" } }),
  });
  const w = await mountSession(sid);
  assert.deepEqual(lastEs()?.channel, { kind: "session", sessionId: sid });
  assert.deepEqual(w.latest.heldMessages, [{ ...entry, local: false }]);
  await act(() => lastEs().deliver({ type: "open" }));
  assert.deepEqual(callsTo("POST", "/api/agent/"), [], "an outbox-only stream must wait for connected before talking to omp");
  assert.equal(w.latest.agentRunning, false);
});

test("an outbox stored ACK survives an older empty channel snapshot until its id is listed or settled", async () => {
  resetWorld();
  const sid = "outbox-ack-before-snapshot";
  primeSession(sid, [userMsg("u0", "before")]);
  const w = await mountSession(sid);
  const entry = { id: "ack-first", sessionId: sid, mode: "prompt", message: "still held", state: "held", createdAt: 1 };
  await act(() => workerPort.onmessage({ data: { outboxStored: entry } }));
  assert.deepEqual(w.latest.heldMessages, [{ ...entry, local: false }]);
  const es = lastEs();
  await act(() => es.emit({ type: "outbox_update", entries: [], settledIds: [] }));
  assert.deepEqual(w.latest.heldMessages, [{ ...entry, local: false }], "an empty snapshot that never saw this id cannot retire its ACK bridge");
  await act(() => es.emit({ type: "outbox_update", entries: [{ ...entry, state: "delivering" }], settledIds: [] }));
  assert.equal(w.latest.heldMessages.length, 1);
  assert.equal(w.latest.heldMessages[0].state, "delivering", "the channel snapshot supersedes the ACK bridge");
  await act(() => es.emit({ type: "outbox_update", entries: [], settledIds: [entry.id] }));
  assert.deepEqual(w.latest.heldMessages, []);
});

test("a stored ACK arriving after delivering and removal snapshots cannot resurrect a delivered outbox message", async () => {
  resetWorld();
  const sid = "outbox-late-ack";
  primeSession(sid, [userMsg("u0", "before")]);
  const entry = { id: "already-delivered", sessionId: sid, mode: "prompt", message: "done", state: "held", createdAt: 1 };
  world.holds.push({
    match: (method, url) => method === "GET" && url === `/api/sessions/${sid}/state`,
    produce: async () => ({ value: { running: false, outbox: [entry], outboxScope: "test-scope" } }),
  });
  const w = await mountSession(sid);
  const es = lastEs();
  await act(() => es.emit({ type: "outbox_update", entries: [{ ...entry, state: "delivering" }], settledIds: [] }));
  assert.equal(w.latest.heldMessages[0].state, "delivering");
  await act(() => es.emit({ type: "outbox_update", entries: [], settledIds: [entry.id] }));
  assert.deepEqual(w.latest.heldMessages, []);
  await act(() => {
    workerPort.onmessage({ data: { outbox: [{ ...entry, scope: "test-scope", state: "sending" }] } });
    workerPort.onmessage({ data: { outboxStored: entry } });
  });
  assert.deepEqual(w.latest.heldMessages, [], "neither the browser copy nor a late stored ACK can undo the removal");
});

for (const source of ["state", "channel"]) {
  test(`a cold empty outbox ${source} snapshot suppresses settled ids in later browser entries and ACKs`, async () => {
    resetWorld();
    const sid = `outbox-cold-settled-${source}`;
    primeSession(sid, [userMsg("u0", "before")]);
    const entry = { id: "settled-before-subscribe", sessionId: sid, mode: "followUp", message: "already handed off", state: "held", createdAt: 1 };
    if (source === "state") {
      world.holds.push({
        match: (method, url) => method === "GET" && url === `/api/sessions/${sid}/state`,
        produce: async () => ({ value: { running: false, outbox: [], outboxSettledIds: [entry.id], outboxScope: "test-scope" } }),
      });
    } else {
      world.agents.set(sid, { running: true, state: {} });
    }
    const w = await mountSession(sid);
    if (source === "channel") {
      await act(() => lastEs().emit({ type: "outbox_update", entries: [], settledIds: [entry.id] }));
    }
    await act(() => workerPort.onmessage({ data: { outbox: [{ ...entry, scope: "test-scope", state: "sending" }] } }));
    assert.deepEqual(w.latest.heldMessages, [], "the settled browser copy must never appear");
    await act(() => workerPort.onmessage({ data: { outboxStored: entry } }));
    assert.deepEqual(w.latest.heldMessages, [], "the settled ACK must never appear");
  });
}

test("an existing-session ChatWindow clears only after worker commit and remounts one held bubble without starting a run", async (t) => {
  resetWorld();
  const sid = "outbox-chat-remount";
  const message = "held across the real ChatWindow remount";
  primeSession(sid, [userMsg("u0", "before")]);
  world.outboxHold = true;
  let commit;
  world.outboxCommit = (complete) => { commit = complete; };
  t.after(async () => { await act(async () => { commit?.(); }); });
  const mountChat = async () => {
    const view = ownRoot(render(React.createElement(ChatWindow, {
      session: sessionInfo(sid), newSessionCwd: null,
    }), { wrapper: TestRoot }));
    await settle();
    return view;
  };
  const first = await mountChat();
  const composer = first.getByRole("textbox");
  await act(() => fireEvent.change(composer, { target: { value: message } }));
  await act(async () => {
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    await sleep(20);
  });
  assert.equal(typeof commit, "function");
  assert.equal(composer.value, message, "the draft remains until the worker commits");
  assert.equal(first.container.querySelectorAll("[data-held-message]").length, 0);
  await act(async () => { const complete = commit; commit = null; complete(); await sleep(20); });
  assert.equal(composer.value, "", "the committed receipt clears the submitted composer");
  assert.equal(first.container.querySelectorAll('[data-held-message="sending"]').length, 1);
  assert.equal(first.getAllByText(message).length, 1);
  assert.equal(first.queryByRole("button", { name: translate("chatInput.stop") }), null, "holding a message does not start a turn");
  const held = [...world.outbox];
  await act(() => first.unmount());
  const second = await mountChat();
  await act(() => workerPort.onmessage({ data: { outbox: held.map((entry) => ({ ...entry, state: "sending" })) } }));
  assert.equal(second.getByRole("textbox").value, "", "the already-submitted text does not return as a draft");
  assert.equal(second.container.querySelectorAll('[data-held-message="sending"]').length, 1);
  assert.equal(second.getAllByText(message).length, 1, "worker replay and cached state do not duplicate the bubble");
  assert.equal(second.queryByRole("button", { name: translate("chatInput.stop") }), null);
  assert.equal(callsTo("POST", `/api/agent/${sid}`).some((call) => call.body?.type === "prompt"), false, "the tab still has no delivery or run to invent");
});

test("offline history and state 503s still hydrate held messages and scope while ChatWindow keeps its composer and retry", async () => {
  resetWorld();
  const sid = "outbox-offline-history";
  primeSession(sid, [userMsg("u0", "saved history")]);
  world.contextUnavailable = true;
  world.outboxHold = true;
  const entry = { id: "offline-server-held", sessionId: sid, mode: "followUp", message: "waiting on the offline host", state: "waiting_host", createdAt: 1 };
  world.holds.push({
    match: (method, url) => method === "GET" && url === `/api/sessions/${sid}/state`,
    produce: async () => ({ status: 503, value: { running: false, hostOffline: true, error: "Build box is offline", outbox: [entry], outboxScope: "offline-scope" } }),
  });
  const view = ownRoot(render(React.createElement(ChatWindow, {
    session: { ...sessionInfo(sid), hostId: "h1" }, newSessionCwd: null, hostStatus: "offline", hostLabel: "Build box",
  }), { wrapper: TestRoot }));
  await settle();
  assert.equal(callsTo("GET", `/api/sessions/${sid}/state`).length, 1, "outbox hydration is independent of failed history");
  assert.equal(view.container.querySelectorAll('[data-held-message="waiting_host"]').length, 1);
  assert.ok(view.getByText(entry.message));
  assert.match(view.getByRole("alert").textContent, /HTTP 503/, "the history error remains visible instead of being swallowed");
  const composer = view.getByRole("textbox");
  await act(() => fireEvent.change(composer, { target: { value: "send while offline" } }));
  await act(async () => { fireEvent.keyDown(composer, { key: "Enter", code: "Enter" }); await sleep(20); });
  assert.equal(composer.value, "");
  assert.equal(world.outbox[0]?.scope, "offline-scope", "the failing state response still supplies authorization scope");
  assert.equal(view.container.querySelectorAll("[data-held-message]").length, 2);
  assert.equal(callsTo("POST", `/api/agent/${sid}`).some((call) => call.body?.type === "prompt"), false);
  world.contextUnavailable = false;
  world.holds.push({
    match: (method, url) => method === "GET" && url === `/api/sessions/${sid}/state`,
    produce: async () => ({ value: { running: false, outbox: [entry], outboxScope: "offline-scope" } }),
  });
  await act(() => fireEvent.click(view.getByRole("button", { name: translate("chatWindow.retry") })));
  await settle();
  assert.equal(view.queryByRole("alert"), null);
  assert.ok(view.getByText("saved history"));
  assert.equal(view.container.querySelectorAll("[data-held-message]").length, 2);
});

test("a history failure without held messages or an offline host keeps the existing blocking error screen", async () => {
  resetWorld();
  const sid = "outbox-unavailable-history";
  primeSession(sid, [userMsg("u0", "saved history")]);
  world.contextUnavailable = true;
  const view = ownRoot(render(React.createElement(ChatWindow, {
    session: sessionInfo(sid), newSessionCwd: null, hostStatus: "online",
  }), { wrapper: TestRoot }));
  await settle();
  assert.match(view.getByText(/HTTP 503/).textContent, /HTTP 503/);
  assert.equal(view.queryByRole("textbox"), null);
  assert.ok(view.getByRole("button", { name: translate("chatWindow.retry") }));
});

for (const changed of [false, true]) {
  test(`an outbox commit after ChatWindow remount ${changed ? "preserves newer typing and attachments" : "clears the unchanged submitted draft"}`, async (t) => {
    resetWorld();
    const { getDraft, clearDraft } = await import("@/lib/draft-store");
    const sid = `outbox-pending-remount-${changed ? "changed" : "unchanged"}`;
    clearDraft(sid);
    t.after(() => clearDraft(sid));
    primeSession(sid, [userMsg("u0", "before")]);
    world.outboxHold = true;
    let commit;
    world.outboxCommit = (complete) => { commit = complete; };
    t.after(async () => { await act(async () => { commit?.(); }); });
    const chatInputRef = React.createRef();
    const mountChat = async () => {
      const view = ownRoot(render(React.createElement(ChatWindow, {
        session: sessionInfo(sid), newSessionCwd: null, chatInputRef,
      }), { wrapper: TestRoot }));
      await settle();
      return view;
    };
    const first = await mountChat();
    await act(() => fireEvent.change(first.getByRole("textbox"), { target: { value: "submitted before unmount" } }));
    await act(async () => { fireEvent.keyDown(first.getByRole("textbox"), { key: "Enter", code: "Enter" }); await sleep(20); });
    assert.equal(typeof commit, "function");
    await act(() => first.unmount());
    const second = await mountChat();
    assert.equal(second.getByRole("textbox").value, "submitted before unmount", "the uncommitted submission remains recoverable");
    if (changed) {
      await act(() => {
        fireEvent.change(second.getByRole("textbox"), { target: { value: "newer unsent draft" } });
        chatInputRef.current.addFiles([new File(["new context"], "new-context.txt", { type: "text/plain" })]);
      });
      await until(() => getDraft(sid)?.files.length === 1, "the remounted composer's new attachment must finish reading");
    }
    await act(async () => { const complete = commit; commit = null; complete(); await sleep(20); });
    assert.equal(within(second.getByRole("log")).getAllByText("submitted before unmount").length, 1, "the stored message is represented once by its held bubble");
    assert.equal(second.container.querySelectorAll('[data-held-message="sending"]').length, 1);
    assert.equal(second.getByRole("textbox").value, changed ? "newer unsent draft" : "", "a committed submission must not look unsent or erase a newer draft");
    if (changed) {
      assert.equal(getDraft(sid)?.value, "newer unsent draft");
      assert.equal(getDraft(sid)?.files[0]?.name, "new-context.txt");
      assert.ok(second.getByText("new-context.txt"));
    } else {
      assert.equal(getDraft(sid), null);
    }
  });
}

test("deleting a server-held message sends one plain outbox_remove per click burst and creates no draft", async (t) => {
  resetWorld();
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "outbox-delete-upload";
  clearDraft(sid);
  t.after(() => clearDraft(sid));
  primeSession(sid, [userMsg("u0", "before")]);
  const entry = { id: "delete-with-upload", sessionId: sid, mode: "prompt", message: "delete me", uploads: ["staged-upload"], state: "held", createdAt: 1 };
  world.holds.push({
    match: (method, url) => method === "GET" && url === `/api/sessions/${sid}/state`,
    produce: async () => ({ value: { running: false, outbox: [entry], outboxScope: "test-scope" } }),
  });
  const w = await mountSession(sid);
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "outbox_remove",
    produce: async () => ({ value: { success: true, data: { removed: true, entry } } }),
  });
  await act(async () => { await Promise.all([w.latest.deleteHeldMessage(entry.id), w.latest.deleteHeldMessage(entry.id)]); });
  assert.deepEqual(callsTo("POST", `/api/agent/${sid}`).filter((call) => call.body?.type === "outbox_remove").map((call) => call.body), [{ type: "outbox_remove", id: entry.id }]);
  assert.equal(getDraft(sid), null);
  assert.deepEqual(w.latest.notices, []);
});

test("send captures saved entries newer than the last rendered transcript through the authoritative outbox dispatch frame", async (t) => {
  resetWorld();
  const sid = "outbox-stale-render-boundary";
  primeSession(sid, [userMsg("u0", "old question")]);
  const { w, es } = await startRun(sid, "question");
  primeSession(sid, [userMsg("u0", "old question"), userMsg("u1", "question"), assistantMsg("a1", "Previous answer")]);
  let release;
  t.after(() => release?.());
  world.holds.push({
    match: (method, url) => method === "GET" && url.startsWith(`/api/sessions/${sid}?`),
    produce: () => new Promise((resolve) => {
      const file = structuredClone(world.sessions.get(sid));
      release = () => resolve({ value: { sessionId: sid, leafId: file.leafId, tree: [], context: { ...file, todoPhases: [] } } });
    }),
  });
  await act(() => {
    es.emit({ type: "message_update", message: assistantMsg("a1", "Previous answer") });
    es.emit({ type: "agent_end", isTerminal: true });
  });
  assert.equal(w.latest.agentRunning, false);
  assert.equal(typeof release, "function");
  assert.deepEqual(w.latest.entryIds, ["e0"], "the terminal transcript refresh is still held");
  world.outboxHold = true;
  await act(async () => { assert.deepEqual(await w.latest.handleSend("question"), { status: "accepted" }); });
  const entry = world.outbox[0];
  assert.equal(w.latest.agentRunning, false, "holding the next send does not start its run");
  const previousEntryIds = [...world.sessions.get(sid).entryIds];
  await act(async () => {
    es.emit({ type: "outbox_update", entries: [{ ...entry, state: "delivering", previousEntryIds }], settledIds: [] });
    world.outboxHold = false;
    await dispatchOutbox();
    es.emit({ type: "agent_start" });
    es.emit({ type: "outbox_update", entries: [], settledIds: [entry.id] });
    release();
  });
  assert.equal(callsTo("GET", `/api/sessions/${sid}/context?boundary=1`).length, 0, "the tab never fetches a late pre-send boundary");
  // This new run saves neither a user message nor an answer.
  await act(async () => {
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, false);
  assert.equal(w.latest.notices.filter((notice) => notice.type === "error").length, 1, "previous answer must not count as replacement success");
});

for (const outcome of ["failed", "delivered"]) {
  test(`an outbox attempt ${outcome} before agent_start cannot lend its history boundary to a later turn`, async () => {
    resetWorld();
    const sid = `outbox-ended-boundary-${outcome}`;
    primeSession(sid, [userMsg("u0", "old question")]);
    world.agents.set(sid, { running: true, state: { isStreaming: false } });
    const w = await mountSession(sid);
    const es = lastEs();
    await act(() => es.open());
    const entry = {
      id: "no-run-attempt", sessionId: sid, mode: "prompt", message: "/local-command",
      state: "delivering", previousEntryIds: ["e0"], createdAt: 1,
    };
    await act(() => {
      es.emit({ type: "outbox_update", entries: [entry], settledIds: [] });
      es.emit({
        type: "outbox_update",
        entries: outcome === "failed" ? [{ ...entry, state: "failed", error: "Refused" }] : [],
        settledIds: outcome === "delivered" ? [entry.id] : [],
      });
    });
    // Saved work from elsewhere arrives after the attempt, but before a separate new turn.
    saveSession(sid, [userMsg("u0", "old question"), userMsg("u1", "intervening question"), assistantMsg("a1", "Earlier answer")]);
    await act(() => es.emit({ type: "message_end", message: userMsg("u1", "intervening question") }, { persist: false }));
    await settle();
    assert.deepEqual(w.latest.entryIds, ["e0", "e1", "e2"]);
    await act(() => {
      es.emit({ type: "agent_start" });
      es.emit({ type: "agent_end", isTerminal: true });
    });
    await settle();
    assert.equal(w.latest.agentRunning, false);
    assert.equal(w.latest.notices.filter((notice) => notice.type === "error").length, 1, "the intervening saved answer is not a response to the empty new turn");
  });
}

test("deleting a failed browser-held message removes it only after the durable IndexedDB delete commits", async (t) => {
  resetWorld();
  const sid = "outbox-local-delete";
  primeSession(sid, [userMsg("u0", "before")]);
  world.outboxHold = true;
  const w = await mountSession(sid);
  await act(async () => { await w.latest.handleSend("locally held"); });
  const entry = { ...world.outbox[0], state: "failed", error: "Upload refused" };
  world.outbox[0] = entry;
  await act(() => workerPort.onmessage({ data: { outbox: [entry] } }));
  let commit;
  t.after(async () => { await act(async () => { commit?.(); }); });
  world.outboxDrop = (complete) => { commit = complete; };
  let deleting;
  await act(async () => { deleting = w.latest.deleteHeldMessage(entry.id); await Promise.resolve(); });
  assert.equal(w.latest.heldMessages[0].id, entry.id, "the bubble stays until IndexedDB commits the delete");
  await act(async () => { const complete = commit; commit = null; complete(); await deleting; });
  assert.deepEqual(w.latest.heldMessages, []);
  assert.deepEqual(w.latest.notices, []);
});

test("a failed durable browser deletion keeps the held message and shows a notice", async (t) => {
  resetWorld();
  const { getDraft, clearDraft } = await import("@/lib/draft-store");
  const sid = "outbox-local-delete-fails";
  clearDraft(sid);
  t.after(() => clearDraft(sid));
  primeSession(sid, [userMsg("u0", "before")]);
  const w = await mountSession(sid);
  const entry = { id: "local-delete-fails", sessionId: sid, scope: "test-scope", mode: "prompt", message: "still held", state: "failed", createdAt: 1 };
  world.outbox.push(entry);
  await act(() => workerPort.onmessage({ data: { outbox: [entry] } }));
  world.outboxDrop = (complete) => complete("IndexedDB deletion failed");
  await act(async () => { await w.latest.deleteHeldMessage(entry.id); });
  assert.equal(getDraft(sid), null);
  assert.equal(w.latest.heldMessages[0].id, entry.id);
  assert.equal(w.latest.notices[0].type, "error");
  assert.match(w.latest.notices[0].message, /IndexedDB deletion failed/);
});

test("an offline send follows its held bubble when the worker list arrives before the commit ACK", async () => {
  resetWorld();
  const sid = "held-scroll";
  primeSession(sid, [userMsg("before", "before")]);
  world.outboxHold = true;
  const w = await mountSession(sid);
  const container = document.createElement("div");
  const end = document.createElement("div");
  let followed = 0;
  Object.defineProperty(end, "scrollIntoView", { value: () => { followed++; }, configurable: true });
  w.latest.scrollContainerRef.current = container;
  w.latest.messagesEndRef.current = end;
  w.latest.holdScrollPosition();
  world.outboxCommit = () => {};
  let send;
  await act(async () => { send = w.latest.handleSend("held while scrolled up"); await sleep(20); });
  const { n, entry } = world.lastOutboxAdd;
  await act(() => workerPort.onmessage({ data: { outbox: [{ ...entry, state: "sending" }] } }));
  assert.equal(w.latest.heldMessages.length, 1);
  assert.equal(followed, 0, "manual scroll remains respected before the submission is accepted");
  await act(async () => { workerPort.onmessage({ data: { outboxAdded: n } }); await send; await sleep(40); });
  assert.ok(followed > 0, "a committed Send follows the held bubble without waiting for another server frame");
});

