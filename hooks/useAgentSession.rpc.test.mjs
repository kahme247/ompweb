import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";

// useAgentSession is the chat state machine. These tests drive it through a
// controllable fake EventSource + fetch router mounted via React Testing Library:
// connection, streaming, terminal events, late/duplicate frames,
// reconnect, and unmount — not source-string checks.


// ---------------------------------------------------------------------------
// Fake EventSource + fetch router
// ---------------------------------------------------------------------------
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = String(url);
    this.readyState = FakeEventSource.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closedByCaller = false;
    world.esInstances.push(this);
  }
  open() {
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.({});
    const sid = this.url.match(/\/api\/agent\/([^/]+)/)?.[1];
    this.onmessage?.({ data: JSON.stringify({ type: "connected", web: world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 } }) });
  }
  emit(event, { persist = true } = {}) {
    if (this.closedByCaller) return;
    const sid = this.url.match(/\/api\/agent\/([^/]+)/)?.[1];
    const previous = world.streams.get(sid) ?? { streamId: `stream-${sid}`, sequence: 0 };
    const web = event.web ?? { ...previous, sequence: previous.sequence + 1 };
    world.streams.set(sid, web);
    if (event.type === "agent_start") this.running = true;
    this.onmessage?.({ data: JSON.stringify({ ...event, web }) });
    // Native message_end precedes appendMessage; make that persistence explicit.
    if (event.type === "message_end" && persist && this.running) appendEntry(sid, event.message);
    if (event.type === "agent_end" && event.isTerminal !== false) this.running = false;
  }
  failFatal() {
    // Browser-facing fatal error (404/500): readyState CLOSED + onerror.
    if (this.closedByCaller) return;
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.({});
  }
  close() {
    this.closedByCaller = true;
    this.readyState = FakeEventSource.CLOSED;
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
    if (wrapper) return jsonResponse(200, { running: wrapper.isAlive(), state: await wrapper.send({ type: "get_state" }) });
    const a = world.agents.get(decodeURIComponent(m[1])) ?? { running: false, state: {} };
    return jsonResponse(200, { running: a.running, state: a.state });
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
      sessionId: decodeURIComponent(m[1]), filePath: "/fixture/session.jsonl", tree: f.tree ?? [],
      leafId: f.leafId,
      context: { todoPhases: [], thinkingLevel: "off", model: null, ...f },
    });
  }
  if (/^\/api\/models/.test(u)) {
    return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  }
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
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
      if (body?.type === "get_subagents") {
        return jsonResponse(200, { success: true, data: { subagents: world.subagentSnapshots.get(sid) ?? [] } });
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
  [globalThis, "EventSource", { value: FakeEventSource }],
  [globalThis, "fetch", { value: fetchStub }],
  [document, "hidden", { get: () => visibilityState === "hidden" }],
  [document, "visibilityState", { get: () => visibilityState }],
  [window, "matchMedia", {
    value: (media) => Object.assign(new window.EventTarget(), { matches: false, media }),
  }],
].map(([target, key, replacement]) => ({
  target, key, replacement, original: Object.getOwnPropertyDescriptor(target, key),
}));

beforeEach(() => {
  visibilityState = "hidden";
  localStorage.clear();
  sessionStorage.clear();
  for (const { target, key, replacement } of overrides) {
    Object.defineProperty(target, key, { configurable: true, ...replacement });
  }
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    for (const { target, key, original } of overrides) {
      if (original) Object.defineProperty(target, key, original);
      else delete target[key];
    }
    localStorage.clear();
    sessionStorage.clear();
  }
});

// The hook chain includes components/ui/toast.tsx, whose JSX jiti cannot parse
// in this environment and whose DOM toasts must never fire inside Node tests.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: {
    "@/components/ui/toast": fileURLToPath(new URL("./__fixtures__/toast-stub.mjs", import.meta.url)),
    "@/": fileURLToPath(new URL("../", import.meta.url)),
  },
});
const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");
const { selectSessionHistory } = await jiti.import("@/lib/session-sync");
const { publishSessionsChanged } = await jiti.import("@/lib/session-change-bus");
const { AgentSessionWrapper } = await jiti.import("@/lib/rpc-manager");

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
  const { result, unmount } = renderHook(() => useAgentSession({
    session, newSessionCwd: null, ...(onAgentEnd ? { onAgentEnd } : {}), ...options,
  }), { reactStrictMode: strictMode });
  await settle(); // hydration: loadSession + /state + models + subagents
  return {
    unmount,
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
  world.wrappers.clear();
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

/** Mount + hydrate, then send a prompt and open the stream. Returns the ES. */
async function startRun(sid, message, strictMode = false) {
  const w = await mountSession(sid, undefined, {}, strictMode);
  assert.equal(w.latest.loading, false, "hydration must complete");
  assert.equal(w.latest.agentRunning, false);

  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend(message);
    await sleep(30); // let the pre-connect get_state POST settle
  });
  const es = lastEs();
  assert.ok(es, "an EventSource must have been created");
  assert.match(es.url, /\/api\/agent\/.+\/events$/);
  await act(async () => {
    es.open(); // connect settles → prompt POST fires
    await sendPromise;
  });
  assert.equal(w.latest.agentRunning, true, "optimistic running state");
  assert.equal(callsTo("POST", "/api/agent/").some((c) => c.body?.type === "prompt" && c.body?.message === message), true, "prompt command must be sent");
  return { w, es };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
for (const queue of ["steering", "followUp"]) {
  test(`queued cancellation waits for acknowledgement and removes one ${queue} duplicate`, async () => {
    resetWorld();
    primeSession("cancellation", [userMsg("u0", "q")]);
    const w = await mountSession("cancellation", undefined, {}, true);
    await act(async () => {
      await w.latest.handleSteer("target");
      await w.latest.handleFollowUp("target");
      await w.latest.handleFollowUp("target");
    });
    const before = { steering: ["target"], followUp: ["target", "target"] };
    let release;
    const acknowledgement = new Promise((resolve) => { release = resolve; });
    world.holds.push({
      match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
      produce: () => acknowledgement,
    });
    let cancellation;
    await act(async () => { cancellation = w.latest.removeQueuedMessage("target", queue); });
    assert.deepEqual(w.latest.queuedMessages, before);
    const sent = world.calls.filter((call) => call.body?.type === "remove_queued_message");
    assert.deepEqual(sent.map((call) => call.body), [{ type: "remove_queued_message", message: "target", queue }]);
    await act(async () => {
      release({ value: { success: true, data: { removed: true } } });
      assert.equal(await cancellation, true);
    });
    assert.deepEqual(w.latest.queuedMessages, {
      ...before, [queue]: before[queue].slice(1),
    });
  });
}

test("queued cancellation preserves pending messages on refusal and unsupported runtimes", async (t) => {
  for (const response of [
    { value: { success: true, data: { removed: false } } },
    { status: 400, value: { error: "Unknown RPC command: remove_queued_message" } },
  ]) {
    await t.test(response.status ? "unsupported" : "not pending", async () => {
      resetWorld();
      primeSession("cancel-failure", [userMsg("u0", "q")]);
      const w = await mountSession("cancel-failure");
      await act(async () => { await w.latest.handleFollowUp("target"); });
      world.holds.push({
        match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
        produce: async () => response,
      });
      await act(async () => { assert.equal(await w.latest.removeQueuedMessage("target", "followUp"), false); });
      assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["target"] });
      assert.equal(w.latest.notices.length, 1);
    });
  }
});

test("successful cancellation after unmount still reports success for draft recovery", async () => {
  resetWorld();
  primeSession("cancel-old", [userMsg("u0", "q")]);
  primeSession("cancel-new", [userMsg("u1", "other")]);
  const old = await mountSession("cancel-old");
  await act(async () => { await old.latest.handleFollowUp("target"); });
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "remove_queued_message",
    produce: () => acknowledgement,
  });
  let cancellation;
  await act(async () => { cancellation = old.latest.removeQueuedMessage("target", "followUp"); });
  old.unmount();
  const current = await mountSession("cancel-new");
  await act(async () => { await current.latest.handleFollowUp("target"); });
  await act(async () => {
    release({ value: { success: true, data: { removed: true } } });
    assert.equal(await cancellation, true, "the caller must recover text already removed by native");
  });
  assert.deepEqual(current.latest.queuedMessages, { steering: [], followUp: ["target"] });
  assert.deepEqual(current.latest.notices, []);
});

for (const remaining of ["other", "target"]) {
  test(`cancellation acknowledgement updates a remounted session without removing its ${remaining} remainder`, async () => {
    resetWorld();
    const sid = `cancel-remount-${remaining}`;
    primeSession(sid, [userMsg("u0", "q")]);
    primeSession("cancel-unrelated", [userMsg("u1", "other session")]);
    const old = await mountSession(sid);
    await act(async () => {
      await old.latest.handleFollowUp("target");
      await old.latest.handleFollowUp(remaining);
    });
    world.agents.set(sid, { running: true, state: { queuedMessageCount: 2, isStreaming: true } });
    let release;
    const acknowledgement = new Promise((resolve) => { release = resolve; });
    world.holds.push({
      match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "remove_queued_message",
      produce: () => acknowledgement,
    });
    let cancellation;
    await act(async () => { cancellation = old.latest.removeQueuedMessage("target", "followUp"); });
    old.unmount();

    const current = await mountSession(sid, undefined, {}, true);
    await act(() => lastEs().open());
    const observer = await mountSession(sid);
    await act(() => lastEs().open());
    const unrelated = await mountSession("cancel-unrelated");
    await act(async () => { await unrelated.latest.handleFollowUp("target"); });
    assert.deepEqual(current.latest.queuedMessages, { steering: [], followUp: ["target", remaining] });
    assert.deepEqual(observer.latest.queuedMessages, current.latest.queuedMessages);
    await act(async () => {
      // Native still has one pending item, so count-only reconciliation cannot
      // discover which text was cancelled.
      world.agents.set(sid, { running: true, state: { queuedMessageCount: 1, isStreaming: true } });
      release({ value: { success: true, data: { removed: true } } });
      assert.equal(await cancellation, true);
    });
    const after = { steering: [], followUp: [remaining] };
    assert.deepEqual(current.latest.queuedMessages, after);
    assert.deepEqual(observer.latest.queuedMessages, after, "subscribers adopt one removal, not one each");
    assert.deepEqual(JSON.parse(sessionStorage.getItem(`omp-queue-${sid}`)), after);
    assert.deepEqual(unrelated.latest.queuedMessages, { steering: [], followUp: ["target"] });
    assert.deepEqual(JSON.parse(sessionStorage.getItem("omp-queue-cancel-unrelated")), unrelated.latest.queuedMessages);
  });
}

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


test("queued promotion waits for native acknowledgement and moves only the first matching follow-up", async () => {
  resetWorld();
  primeSession("promotion", [userMsg("u0", "q")]);
  const w = await mountSession("promotion", undefined, {}, true);
  await act(async () => {
    await w.latest.handleSteer("existing steer");
    await w.latest.handleFollowUp("other");
    await w.latest.handleFollowUp("target");
    await w.latest.handleFollowUp("target");
  });
  const before = { steering: ["existing steer"], followUp: ["other", "target", "target"] };
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === "/api/agent/promotion" && body?.type === "promote_queued_message",
    produce: () => acknowledgement,
  });
  const callsBefore = world.calls.length;
  let promotion;
  await act(async () => { promotion = w.latest.promoteQueuedToSteer("target"); });
  assert.deepEqual(w.latest.queuedMessages, before, "pending RPC must not relabel the chip");
  assert.deepEqual(world.calls.slice(callsBefore), [{
    method: "POST", url: "/api/agent/promotion", body: { type: "promote_queued_message", message: "target" },
  }], "promotion must not enqueue a separate steer or follow-up");
  await act(async () => {
    release({ value: { success: true, data: { promoted: true } } });
    await promotion;
  });
  assert.deepEqual(w.latest.queuedMessages, {
    steering: ["existing steer", "target"], followUp: ["other", "target"],
  });
  assert.deepEqual(w.latest.notices, []);
});

test("promotion acknowledgement updates remounted observers and Delete cancels steering only", async () => {
  resetWorld();
  const sid = "promotion-remount";
  primeSession(sid, [userMsg("u0", "q")]);
  primeSession("promotion-unrelated", [userMsg("u1", "other session")]);
  const old = await mountSession(sid);
  await act(async () => {
    await old.latest.handleFollowUp("target");
    await old.latest.handleFollowUp("target");
  });
  world.agents.set(sid, { running: true, state: { queuedMessageCount: 2, isStreaming: true } });
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "promote_queued_message",
    produce: () => acknowledgement,
  });
  let promotion;
  await act(async () => { promotion = old.latest.promoteQueuedToSteer("target"); });
  old.unmount();

  const current = await mountSession(sid, undefined, {}, true);
  await act(() => lastEs().open());
  const observer = await mountSession(sid);
  await act(() => lastEs().open());
  const unrelated = await mountSession("promotion-unrelated");
  await act(async () => { await unrelated.latest.handleFollowUp("target"); });
  assert.deepEqual(current.latest.queuedMessages, { steering: [], followUp: ["target", "target"] });
  await act(async () => {
    release({ value: { success: true, data: { promoted: true } } });
    await promotion;
  });
  const promoted = { steering: ["target"], followUp: ["target"] };
  assert.deepEqual(current.latest.queuedMessages, promoted);
  assert.deepEqual(observer.latest.queuedMessages, promoted, "observers adopt one promotion, not one each");
  assert.deepEqual(JSON.parse(sessionStorage.getItem(`omp-queue-${sid}`)), promoted);
  assert.deepEqual(unrelated.latest.queuedMessages, { steering: [], followUp: ["target"] });
  assert.deepEqual(JSON.parse(sessionStorage.getItem("omp-queue-promotion-unrelated")), unrelated.latest.queuedMessages);
  assert.deepEqual(unrelated.latest.notices, []);

  world.holds.push({
    match: (method, url, body) => method === "POST" && url === `/api/agent/${sid}` && body?.type === "remove_queued_message" && body?.queue === "steering",
    produce: async () => ({ value: { success: true, data: { removed: true } } }),
  });
  await act(async () => {
    assert.equal(await current.latest.removeQueuedMessage("target", "steering"), true);
  });
  assert.deepEqual(world.calls.filter((call) => call.body?.type === "remove_queued_message").map((call) => call.body), [
    { type: "remove_queued_message", message: "target", queue: "steering" },
  ]);
  const remaining = { steering: [], followUp: ["target"] };
  assert.deepEqual(current.latest.queuedMessages, remaining);
  assert.deepEqual(observer.latest.queuedMessages, remaining);
  assert.deepEqual(JSON.parse(sessionStorage.getItem(`omp-queue-${sid}`)), remaining);
});

test("remounted delivery before promotion acknowledgement preserves the next duplicate and pending guard", async () => {
  resetWorld();
  const sid = "promotion-remount-delivery";
  primeSession(sid, [userMsg("u0", "q")]);
  const old = await mountSession(sid);
  await act(async () => {
    await old.latest.handleFollowUp("target");
    await old.latest.handleFollowUp("target");
  });
  world.agents.set(sid, { running: true, state: { queuedMessageCount: 2, isStreaming: true } });
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
    produce: () => acknowledgement,
  });
  let promotion;
  await act(async () => { promotion = old.latest.promoteQueuedToSteer("target"); });
  old.unmount();
  const current = await mountSession(sid, undefined, {}, true);
  const es = lastEs();
  await act(() => es.open());
  await act(async () => {
    await current.latest.promoteQueuedToSteer("target");
    assert.equal(await current.latest.removeQueuedMessage("target", "followUp"), false);
    es.emit({ type: "message_end", message: userMsg("delivered", "target") }, { persist: false });
    release({ value: { success: true, data: { promoted: true } } });
    await promotion;
  });
  const remaining = { steering: [], followUp: ["target"] };
  assert.deepEqual(current.latest.queuedMessages, remaining);
  assert.deepEqual(JSON.parse(sessionStorage.getItem(`omp-queue-${sid}`)), remaining);
  assert.equal(current.latest.messages.some((message) => message.role === "user" && message.content === "target"), false);
  await act(async () => {
    appendEntry(sid, userMsg("delivered", "target"));
    publishSessionsChanged([sid]);
  });
  await settle();
  assert.equal(current.latest.messages.filter((message) => message.role === "user" && message.content === "target").length, 1);
  assert.equal(world.calls.filter((call) => call.body?.type === "promote_queued_message").length, 1);
  assert.equal(world.calls.some((call) => call.body?.type === "remove_queued_message"), false);
  assert.deepEqual(current.latest.notices, []);
});

test("queued promotion preserves the follow-up and reports native refusal or rejection", async (t) => {
  for (const outcome of [
    { name: "not-found", response: { value: { success: true, data: { promoted: false } } }, noticeType: "warning" },
    { name: "unsupported", response: { status: 400, value: { error: "Unknown RPC command: promote_queued_message" } }, noticeType: "error" },
  ]) {
    await t.test(outcome.name, async () => {
      resetWorld();
      primeSession(outcome.name, [userMsg("u0", "q")]);
      const w = await mountSession(outcome.name);
      await act(async () => { await w.latest.handleFollowUp("target"); });
      let release;
      const acknowledgement = new Promise((resolve) => { release = resolve; });
      world.holds.push({
        match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
        produce: () => acknowledgement,
      });
      let promotion;
      await act(async () => { promotion = w.latest.promoteQueuedToSteer("target"); });
      assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["target"] });
      await act(async () => {
        release(outcome.response);
        await promotion;
      });
      assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["target"] });
      assert.equal(w.latest.notices.length, 1);
      assert.equal(w.latest.notices[0].type, outcome.noticeType);
      if (outcome.response.value.error) {
        assert.equal(w.latest.notices[0].message, outcome.response.value.error);
      }

      // A settled failure releases the overlap guard so a deliberate retry works.
      world.holds.push({
        match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
        produce: async () => ({ value: { success: true, data: { promoted: true } } }),
      });
      await act(async () => { await w.latest.promoteQueuedToSteer("target"); });
      assert.deepEqual(w.latest.queuedMessages, { steering: ["target"], followUp: [] });
    });
  }
});

test("overlapping same-text promotion clicks send one command and promote one occurrence", async () => {
  resetWorld();
  primeSession("double-promotion", [userMsg("u0", "q")]);
  const w = await mountSession("double-promotion");
  await act(async () => {
    await w.latest.handleFollowUp("target");
    await w.latest.handleFollowUp("target");
  });
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
    produce: () => acknowledgement,
  });
  let first;
  let second;
  await act(async () => {
    first = w.latest.promoteQueuedToSteer("target");
    second = w.latest.promoteQueuedToSteer("target");
  });
  assert.equal(world.calls.filter((call) => call.body?.type === "promote_queued_message").length, 1);
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["target", "target"] });
  await act(async () => {
    release({ value: { success: true, data: { promoted: true } } });
    await Promise.all([first, second]);
  });
  assert.deepEqual(w.latest.queuedMessages, { steering: ["target"], followUp: ["target"] });
});

test("delivery before promotion acknowledgement does not relabel the next duplicate or resurrect the delivered chip", async () => {
  resetWorld();
  primeSession("delivered-promotion", [userMsg("u0", "q")]);
  const { w, es } = await startRun("delivered-promotion", "run", true);
  await act(async () => {
    es.emit({ type: "agent_start" });
    await w.latest.handleFollowUp("target");
    await w.latest.handleFollowUp("target");
  });
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
    produce: () => acknowledgement,
  });
  let promotion;
  await act(async () => { promotion = w.latest.promoteQueuedToSteer("target"); });
  await act(async () => { es.emit({ type: "message_end", message: userMsg("delivered", "target") }); });
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["target"] });
  assert.equal(w.latest.messages.filter((message) => message.role === "user" && message.content === "target").length, 1);
  await act(async () => {
    release({ value: { success: true, data: { promoted: true } } });
    await promotion;
  });
  assert.deepEqual(w.latest.queuedMessages, { steering: [], followUp: ["target"] });
});

test("cancellation cannot race a pending promotion and remove the next duplicate", async () => {
  resetWorld();
  primeSession("removed-promotion", [userMsg("u0", "q")]);
  const w = await mountSession("removed-promotion", undefined, {}, true);
  await act(async () => {
    await w.latest.handleFollowUp("target");
    await w.latest.handleFollowUp("target");
  });
  let release;
  const acknowledgement = new Promise((resolve) => { release = resolve; });
  world.holds.push({
    match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
    produce: () => acknowledgement,
  });
  let promotion;
  await act(async () => { promotion = w.latest.promoteQueuedToSteer("target"); });
  await act(async () => {
    assert.equal(await w.latest.removeQueuedMessage("target", "followUp"), false);
    release({ value: { success: true, data: { promoted: true } } });
    await promotion;
  });
  assert.deepEqual(w.latest.queuedMessages, { steering: ["target"], followUp: ["target"] });
  assert.equal(world.calls.some((call) => call.body?.type === "remove_queued_message"), false);
  assert.deepEqual(w.latest.notices, []);
});

test("promotion acknowledgements after navigation cannot change the newly mounted session", async (t) => {
  for (const response of [
    { value: { success: true, data: { promoted: true } } },
    { status: 400, value: { error: "Native promotion failed" } },
  ]) {
    await t.test(response.status ? "error" : "success", async () => {
      resetWorld();
      primeSession("old-promotion", [userMsg("u0", "old")]);
      primeSession("new-promotion", [userMsg("u1", "new")]);
      const old = await mountSession("old-promotion");
      await act(async () => { await old.latest.handleFollowUp("target"); });
      let release;
      const acknowledgement = new Promise((resolve) => { release = resolve; });
      world.holds.push({
        match: (method, _url, body) => method === "POST" && body?.type === "promote_queued_message",
        produce: () => acknowledgement,
      });
      let promotion;
      await act(async () => { promotion = old.latest.promoteQueuedToSteer("target"); });
      old.unmount();
      const current = await mountSession("new-promotion");
      await act(async () => { await current.latest.handleFollowUp("target"); });
      await act(async () => {
        release(response);
        await promotion;
      });
      assert.deepEqual(current.latest.queuedMessages, { steering: [], followUp: ["target"] });
      assert.deepEqual(current.latest.notices, []);
      assert.equal(world.calls.some((call) => call.url === "/api/agent/new-promotion" && call.body?.type === "promote_queued_message"), false);
      assert.deepEqual(JSON.parse(sessionStorage.getItem("omp-queue-old-promotion")), response.status
        ? { steering: [], followUp: ["target"] }
        : { steering: ["target"], followUp: [] }, "an unobserved session still records the native result");
    });
  }
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

for (const nextRun of ["send", "interrupt"]) {
  test(`${nextRun} captures saved entries newer than the last rendered transcript`, async () => {
    resetWorld();
    primeSession("s1", [userMsg("u0", "old question")]);
    const { w, es } = await startRun("s1", "question");
    primeSession("s1", [userMsg("u0", "old question"), userMsg("u1", "question"), assistantMsg("a1", "Previous answer")]);
    let releaseTerminalReload;
    if (nextRun === "send") {
      world.holds.push({
        match: (method, url) => method === "GET" && url.startsWith("/api/sessions/s1?"),
        produce: () => new Promise((resolve) => {
          const file = world.sessions.get("s1");
          const snapshot = { sessionId: "s1", leafId: file.leafId, tree: [], context: { ...file, todoPhases: [] } };
          releaseTerminalReload = () => resolve({ value: snapshot });
        }),
      });
      await act(async () => {
        es.emit({ type: "message_update", message: assistantMsg("a1", "Previous answer") });
        es.emit({ type: "agent_end", isTerminal: true });
        await Promise.resolve();
      });
      assert.equal(w.latest.agentRunning, false);
    }
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
      submission = nextRun === "send" ? w.latest.handleSend("question") : w.latest.handleInterruptAndReply("question");
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
      releaseTerminalReload?.();
      if (nextRun === "interrupt") replacement.emit({ type: "agent_end", isTerminal: true });
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
}

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
  assert.equal(es1.readyState, FakeEventSource.CLOSED);
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
  }, process.cwd());
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
    await w.latest.handleNavigate("branch");
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
    assert.equal(await send, true);
  });
  assert.deepEqual(promoted, []);
  assert.deepEqual(world.esInstances, []);
  assert.ok(world.calls.some((call) => call.url.startsWith("/api/agent/created") && call.body?.message === "deliver after navigation"));
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
  await act(async () => { await w.latest.handleFork("e0"); });
  assert.deepEqual(forked, ["advisor-child"]);
  assert.equal(localStorage.getItem("omp-advisor-enabled:advisor-child"), "true");
  const { sendAgentCommand } = await jiti.import("@/lib/agent-client");
  await sendAgentCommand("advisor-child", { type: "get_state" });
  assert.ok(world.calls.some((call) => call.url === "/api/agent/advisor-child?advisor=1"));
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
    navigation = w.latest.handleNavigate("branch");
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
        await act(async () => { await w.latest.handleNavigate("branch"); });
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
          : selected === "branch" ? w.latest.handleNavigate("branch") : w.latest.togglePreCompactionHistory();
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
  await act(async () => { await w.latest.handleNavigate("branch"); });
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

test("same-text queued delivery is consumed live and committed only when its distinct ID is saved", async () => {
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun("s1", "same");
  const delivered = userMsg("raw-without-persisted-identity", "same");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: delivered });
  });
  await settle();
  await act(async () => { await w.latest.handleFollowUp("same"); });
  assert.deepEqual(w.latest.queuedMessages.followUp, ["same"]);
  await act(async () => {
    es.emit({ type: "message_end", message: delivered }, { persist: false });
  });
  await settle();
  assert.deepEqual(w.latest.queuedMessages.followUp, []);
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
  es.failFatal();
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
  const lateOpen = replacement.onopen;
  await act(async () => { w.unmount(); });
  const before = world.calls.length;
  await act(async () => { lateOpen({}); });
  assert.equal(world.calls.slice(before).some((c) => c.method === "POST"), false);
});
