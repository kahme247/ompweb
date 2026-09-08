import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// useAgentSession is the chat state machine. These tests drive it through a
// controllable fake EventSource + fetch router mounted via react-test-renderer
// (TODO §5): connection, streaming, terminal events, late/duplicate frames,
// reconnect, and unmount — not source-string checks.

const require = createRequire(import.meta.url);
const React = require("react");
const { act } = React;
const TestRenderer = require("react-test-renderer");

// ---------------------------------------------------------------------------
// Browser-global stubs (installed once; the hook guards most DOM access).
// ---------------------------------------------------------------------------
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const kvStore = new Map();
globalThis.localStorage = {
  getItem: (k) => kvStore.get(k) ?? null,
  setItem: (k, v) => kvStore.set(k, String(v)),
  removeItem: (k) => kvStore.delete(k),
  clear: () => kvStore.clear(),
};
globalThis.sessionStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
// Listeners are capturable so tests can fire visibilitychange/online.
function makeEventTarget() {
  const map = new Map();
  return {
    addEventListener: (type, fn) => {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = map.get(type);
      if (list) map.set(type, list.filter((f) => f !== fn));
    },
    fire: (type) => {
      for (const fn of [...(map.get(type) ?? [])]) fn({ type });
    },
  };
}
const docTarget = makeEventTarget();
const winTarget = makeEventTarget();
globalThis.document = {
  // hidden: the message-update coalescer then flushes on a 50ms timer instead
  // of requestAnimationFrame, which is deterministic with real timers here.
  hidden: true,
  visibilityState: "visible",
  title: "",
  ...docTarget,
};
globalThis.window = {
  ...winTarget,
  open() {},
  matchMedia: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }),
};
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true, clipboard: undefined },
  configurable: true,
});
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

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
  }
  emit(event) {
    if (this.closedByCaller) return;
    this.onmessage?.({ data: JSON.stringify(event) });
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
globalThis.EventSource = FakeEventSource;

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
  holds: [], // { match(method, url), produce: () => Promise<{ status, value }> }
  sessions: new Map(), // sid -> { leafId, messages, entryIds }
  agents: new Map(), // sid -> { running, state }
  subagentSnapshots: new Map(), // sid -> SubagentSnapshotLike[]
};

async function fetchStub(url, init = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const u = String(url);
  world.calls.push({ method, url: u, body: typeof init.body === "string" ? safeParse(init.body) : null });

  for (let i = 0; i < world.holds.length; i++) {
    if (world.holds[i].match(method, u)) {
      const h = world.holds.splice(i, 1)[0];
      const { status = 200, value } = await h.produce();
      return jsonResponse(status, value);
    }
  }

  let m;
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)\/state/))) {
    const a = world.agents.get(decodeURIComponent(m[1])) ?? { running: false, state: {} };
    return jsonResponse(200, { running: a.running, state: a.state });
  }
  if (/\/api\/sessions\/[^/?#]+\/subagents/.test(u)) {
    return jsonResponse(200, { subagents: [] });
  }
  if ((m = u.match(/\/api\/sessions\/([^/?#]+)/)) && method === "GET") {
    const f = world.sessions.get(decodeURIComponent(m[1]));
    if (!f) return jsonResponse(404, {});
    return jsonResponse(200, {
      leafId: f.leafId,
      context: { messages: f.messages, entryIds: f.entryIds, todoPhases: [] },
    });
  }
  if (/^\/api\/models/.test(u)) {
    return jsonResponse(200, { models: {}, modelList: [], defaultModel: null });
  }
  if ((m = u.match(/\/api\/agent\/([^/?#]+)/))) {
    const sid = decodeURIComponent(m[1]);
    if (method === "GET") {
      const a = world.agents.get(sid) ?? { running: false, state: {} };
      return jsonResponse(200, { running: a.running, state: a.state });
    }
    if (method === "POST") {
      const body = typeof init.body === "string" ? safeParse(init.body) : null;
      if (body?.type === "get_subagents") {
        return jsonResponse(200, { success: true, data: { subagents: world.subagentSnapshots.get(sid) ?? [] } });
      }
      return jsonResponse(200, { success: true, data: {} });
    }
  }
  return jsonResponse(404, {});
}

globalThis.fetch = fetchStub;

// The hook chain includes components/ui/toast.tsx, whose JSX jiti cannot parse
// in this environment and whose DOM toasts must never fire inside Node tests.
const jiti = createJiti(import.meta.url, {
  alias: {
    "@/components/ui/toast": fileURLToPath(new URL("./__fixtures__/toast-stub.mjs", import.meta.url)),
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const { useAgentSession } = await jiti.import("../hooks/useAgentSession.ts");

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

async function mountSession(sid, onAgentEnd) {
  let latest = null;
  function Chat({ session }) {
    latest = useAgentSession({ session, newSessionCwd: null, ...(onAgentEnd ? { onAgentEnd } : {}) });
    return null;
  }
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Chat, { session: sessionInfo(sid) }));
  });
  await settle(); // hydration: loadSession + /state + models + subagents
  activeRenderers.add(renderer);
  return {
    renderer,
    get latest() {
      return latest;
    },
  };
}
// Unmounted renderers must not leak intervals/timers that keep the test
// process alive.
const activeRenderers = new Set();
function unmountAll() {
  for (const r of [...activeRenderers]) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted
    }
  }
  activeRenderers.clear();
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
}

function primeSession(sid, messages) {
  world.sessions.set(sid, {
    leafId: String(messages.length),
    messages,
    entryIds: messages.map((_, i) => `e${i}`),
  });
  world.agents.set(sid, { running: false, state: {} });
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
async function startRun(t, sid, message) {
  const w = await mountSession(sid);
  if (t) t.after(unmountAll);
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
  return { w, es, renderer: w.renderer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("full run over fake SSE: optimistic bubble, coalesced streaming, terminal reload", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "loaded question")]);
  const { w, es } = await startRun(t, "s1", "hello agent");

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
  world.sessions.get("s1").messages = [
    userMsg("u0", "loaded question"),
    userMsg("u1", "hello agent"),
    assistantMsg("a1", "hello world"),
  ];
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

test("provider error on the assistant message is shown instead of ending silently", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun(t, "s1", "q1");

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

test("a silent idle transition shows a fallback error instead of disappearing", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startRun(t, "s1", "q1");

  // Simulate the SSE terminal frame being lost while the server has already
  // gone idle. The online recovery path must still explain the empty stop.
  world.agents.set("s1", { running: false, state: {} });
  await act(async () => {
    winTarget.fire("online");
    await sleep(60);
  });
  await settle();

  assert.equal(w.latest.agentRunning, false);
  assert.ok(w.latest.notices.some((notice) => /stopped without returning a response/i.test(notice.message)));
});

test("tool activity and turn_end errors do not count as a successful answer", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun(t, "s1", "q1");

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

test("late frames after the run finished are ignored (no ghost bubble, no double completion)", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun(t, "s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_end", message: userMsg("u1", "q1") });
    es.emit({ type: "message_end", message: assistantMsg("a1", "done") });
    // Disk snapshot in sync BEFORE agent_end: the terminal reload replaces
    // in-memory messages with the session file's content.
    world.sessions.get("s1").messages = [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "done")];
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

test("agent_end with isTerminal=false is an async delivery pause, not a completion", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun(t, "s1", "q1");
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

test("abort_and_prompt: the aborted run's terminal agent_end is consumed, the new run keeps streaming", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun(t, "s1", "q1");
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

test("a reconcile response that straddles a run boundary is dropped by the run-id fence", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es } = await startRun(t, "s1", "q1");
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

test("fatal SSE error mid-run reconnects after 1s and the new stream delivers events", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es: es1 } = await startRun(t, "s1", "q1");
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

test("unmount mid-run closes the stream and late frames cannot resurrect state", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es, renderer } = await startRun(t, "s1", "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    await Promise.resolve();
  });

  await act(async () => {
    renderer.unmount();
  });
  activeRenderers.delete(renderer);
  assert.equal(es.closedByCaller, true, "unmount must close the EventSource");

  // Frames arriving over the (closed) stream after unmount must be no-ops.
  es.emit({ type: "message_update", message: assistantMsg("a1", "late") });
  es.emit({ type: "agent_end", isTerminal: true });
  await settle();
  assert.equal(w.latest.agentRunning, true, "unmounted state must stay frozen");
});

// ---------------------------------------------------------------------------
// Recovery nets: visibilitychange / online reconcile + subagent roster
// restoration (TODO §5 leftovers).
// ---------------------------------------------------------------------------

/** Mid-run baseline used by the recovery tests. */
async function startStreamingRun(t, sid) {
  const { w, es } = await startRun(t, sid, "q1");
  await act(async () => {
    es.emit({ type: "agent_start" });
    es.emit({ type: "message_update", message: assistantMsg("a1", "streaming") });
    await Promise.resolve();
  });
  await settle(90);
  assert.equal(w.latest.agentRunning, true);
  return { w, es };
}

test("tab returns to foreground: visibilitychange fires a mid-run reconcile poll", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun(t, "s1");

  const before = callsTo("GET", "/api/agent/s1").length;
  // Server still mid-run: the poll must observe busy and NOT finish the run.
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  await act(async () => {
    docTarget.fire("visibilitychange");
    await sleep(30);
  });
  assert.ok(
    callsTo("GET", "/api/agent/s1").length > before,
    "visibilitychange must trigger the recovery-net reconcile",
  );
  // Server still busy (running + isStreaming): the poll must NOT finish the run.
  assert.equal(w.latest.agentRunning, true);
});

test("network returns while agent_end was missed: the online reconcile recovers the UI", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w } = await startStreamingRun(t, "s1");

  // Half-open SSE: no agent_end frame ever arrived, but omp already finished.
  world.sessions.get("s1").messages = [userMsg("u0", "q"), userMsg("u1", "q1"), assistantMsg("a1", "streaming")];
  world.agents.set("s1", { running: false, state: {} });

  await act(async () => {
    winTarget.fire("online");
    await sleep(60);
  });
  await settle();
  assert.equal(w.latest.agentRunning, false, "the online reconcile must finish the stale run");
  assert.equal(w.latest.streamState.isStreaming, false);
  assert.equal(w.latest.messages.length, 3, "transcript reloaded from the session file");
});

test("subagent roster is restored from the get_subagents snapshot after reconnect", async (t) => {
  t.after(unmountAll);
  resetWorld();
  primeSession("s1", [userMsg("u0", "q")]);
  const { w, es: es1 } = await startStreamingRun(t, "s1");

  // Trigger a mid-run roster refresh: visibilitychange → reconcile (still
  // busy server-side) → refreshSubagentRoster against the configured snapshot.
  world.agents.set("s1", { running: true, state: { isStreaming: true } });
  world.subagentSnapshots.set("s1", [
    { id: "sub-1", agent: "explore", status: "started", index: 0, task: "search the codebase" },
  ]);
  await act(async () => {
    docTarget.fire("visibilitychange");
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
