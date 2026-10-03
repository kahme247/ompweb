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
  btwHistory: new Map(), // sid -> BtwRecord[] served by get_btw_history
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
      if (body?.type === "get_btw_history") {
        return jsonResponse(200, { success: true, data: { records: world.btwHistory.get(sid) ?? [] } });
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
const { isUnknownSlashCommand, slashCommandName } = await jiti.import("@/hooks/useAgentSession-stream");
const { toastCalls } = await jiti.import("@/components/ui/toast");

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
  world.btwHistory.clear();
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
async function startRun(sid, message, strictMode = false, options = {}) {
  const w = await mountSession(sid, undefined, options, strictMode);
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

test("queued cancellation reports omp's answer and leaves the chip to the snapshot", async (t) => {
  for (const outcome of [
    { name: "removed", response: { value: { success: true, data: { removed: true } } }, result: true, notices: [] },
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
        assert.equal(await first, outcome.result);
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
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
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
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
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
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
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
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
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
  assert.equal(await cancellation, true);
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
  es.close();
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
  assert.equal(w.latest.agentRunning, true, "run starts optimistically");
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
  const { sendAgentCommand } = await jiti.import("@/lib/agent-client");
  await sendAgentCommand("advisor-child", { type: "get_state" });
  assert.ok(world.calls.some((call) => call.url === "/api/agent/advisor-child?advisor=1"));
});

test("an edit-and-resend fork puts the branched prompt into the child's composer", async () => {
  const { getDraft, clearDraft } = await jiti.import("@/lib/draft-store");
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

// ---------------------------------------------------------------------------
// PR #183 review: what the 404-on-boundary fallback actually covers
// ---------------------------------------------------------------------------

test("REVIEW #165: a fileless LIVE session already gets an empty boundary, so main dispatches", async () => {
  resetWorld();
  // Model the merged server exactly: /api/sessions/<id>/context?boundary=1
  // answers 200 { entryIds: [] } while a live wrapper owns the session and no
  // .jsonl exists (aa617860, app/api/sessions/[id]/context/route.ts:72-75).
  // This is the only state a "prompts were all local slash commands" session is
  // in while the user is still chatting (the wrapper lives 10 min idle,
  // IDLE_DESTROY_MS in lib/rpc-manager.ts:54).
  world.agents.set("fileless-live", { running: true, state: { isStreaming: false, isPromptRunning: false } });
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/sessions/fileless-live/context?boundary=1",
    produce: async () => ({ status: 200, value: { entryIds: [] } }),
  });
  const w = await mountSession("fileless-live");
  assert.equal(w.latest.loading, false);

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
    callsTo("POST", "/api/agent/fileless-live").some((c) => c.body?.type === "prompt" && c.body?.message === "hello after skill"),
    true,
    "unfixed main already dispatches when the live wrapper answers the boundary",
  );
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
  assert.equal(w.latest.agentRunning, true);
});

test("REVIEW a vanished session with no wrapper still fails loudly (real failure not swallowed)", async () => {
  resetWorld();
  // The real agent route resolves the id against the on-disk file whenever no
  // wrapper is alive (app/api/agent/[id]/route.ts:64-65), so this 404 is what a
  // genuinely missing session produces — before the boundary read is reached.
  world.holds.push({
    match: (method, url) => method === "POST" && url.includes("/api/agent/gone"),
    produce: async () => ({ status: 404, value: { error: "Session not found", code: "session_not_found" } }),
  });
  const w = await mountSession("gone");
  let ok;
  await act(async () => {
    ok = await w.latest.handleSend("anyone there?");
    await sleep(30);
  });
  assert.equal(ok, false, "the send must not report success");
  assert.equal(w.latest.agentRunning, false, "the optimistic run state is rolled back");
  assert.equal(w.latest.notices.length, 1, "the failure is surfaced, not swallowed");
  assert.equal(w.latest.notices[0].type, "error");
  assert.equal(
    callsTo("POST", "/api/agent/gone").some((c) => c.body?.type === "prompt"),
    false,
    "no prompt is dispatched into a vanished session",
  );
});

test("REVIEW a 404 boundary on a live session (unreadable file / wrapper died) still dispatches", async (t) => {
  resetWorld();
  // This is what #183 genuinely buys: #165 deliberately keeps 404 for an
  // EXISTING but unresolvable file, and a wrapper that dies between the
  // pre-prompt get_state and the boundary read 404s too. The prompt POST
  // succeeds in both, so aborting the send here loses the message.
  world.agents.set("corrupt", { running: true, state: { isStreaming: false, isPromptRunning: false } });
  world.holds.push({
    match: (method, url) => method === "GET" && url === "/api/sessions/corrupt/context?boundary=1",
    produce: async () => ({ status: 404, value: { error: "Session file is missing or malformed", code: "session_file_malformed" } }),
  });
  const w = await mountSession("corrupt");
  let sendPromise;
  await act(async () => {
    sendPromise = w.latest.handleSend("keep talking");
    await sleep(30);
  });
  const es = lastEs();
  await act(async () => {
    es.open();
    await sendPromise;
  });
  assert.equal(
    callsTo("POST", "/api/agent/corrupt").some((c) => c.body?.type === "prompt" && c.body?.message === "keep talking"),
    true,
    "the prompt must be dispatched despite the boundary 404",
  );
  assert.equal(w.latest.notices.length, 0, "no failed-send notice");
  t.diagnostic("boundary 404 tolerated on a live session");
});
