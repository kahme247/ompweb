import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { mockBuiltin } from "../tests/mock-builtin.mjs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
let isolatedFresh = 0;

/** A line ompweb wrote to a fake omp, read back in RPC's shape: `cmd {id, op, args}` → `{...args, id, type: op}`, any other `{t, ...}` → `{type: t, ...}`. */
function readCommand(line) {
  const { t, op, args, ...rest } = JSON.parse(line);
  return t === "cmd" ? { ...args, ...rest, type: op } : { ...rest, type: t };
}

/** An RPC-shaped frame as ompweb's omp writes it: `ready` → `hello`, `response` → `res`, anything else an `event`. */
function ompLine(frame) {
  if (frame.type === "ready") return JSON.stringify({ t: "hello", proto: 1 });
  if (frame.type === "response") {
    return JSON.stringify(frame.success === false
      ? { t: "res", id: frame.id, ok: false, error: frame.error }
      : { t: "res", id: frame.id, ok: true, data: frame.data });
  }
  return JSON.stringify({ t: "event", event: frame });
}

// Wrappers publish notifications, which the notification store records: never in the real agent dir.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "omp-rpc-manager-test-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
const { closeNotificationStore } = await import("./notification-store.ts");
const { closeOutboxStore } = await import("./message-outbox.ts");
test.after(async () => {
  // The hub's held link samples go to this file's agent dir, before it is gone.
  (await import("./hosts/hub.ts")).flushLinkSamples();
  closeNotificationStore();
  closeOutboxStore();
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const { AgentSessionWrapper: SnapshotWrapper, subscribeHostToolCalls } = await import("./rpc-manager.ts");
// Wrappers built directly need an online host; the daemon's machine host is one.
const { localHost } = await import("./hosts/local-host.ts");

function snapshotSession(t, sendCommand = async () => ({}), Wrapper = SnapshotWrapper, sessionId = "", disconnectDestroyMs, host = localHost) {
  const frameListeners = new Set();
  const sentFrames = [];
  const wrapper = new Wrapper({
    isAlive: true,
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    // As RpcProcess: onReply runs when the reply is read, told whether the command succeeded.
    async sendCommand(command, timeoutMs, onReply) {
      let result;
      try {
        result = await sendCommand(command, timeoutMs);
      } catch (error) {
        onReply?.(false);
        throw error;
      }
      onReply?.(true);
      return result;
    },
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, sessionId, disconnectDestroyMs, host);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, get listenerCount() { return frameListeners.size; }, emit: (event) => { for (const listener of frameListeners) listener(event); } };
}

function fakeGhCli(t, { blockLogin = false, blockQuery = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omp-rpc-gh-"));
  const paths = {
    calls: join(dir, "calls"),
    started: join(dir, "started"),
    gate: join(dir, "gate"),
  };
  const env = {
    OMP_RPC_GH_LOG: paths.calls,
    OMP_RPC_GH_STARTED: paths.started,
    OMP_RPC_GH_GATE: paths.gate,
    OMP_RPC_GH_BLOCK: blockLogin ? "1" : "",
    OMP_RPC_GH_BLOCK_QUERY: blockQuery ? "1" : "",
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  const previousPath = process.env.PATH;
  process.env.PATH = [dir, previousPath].filter(Boolean).join(delimiter);
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.OMP_RPC_GH_LOG, JSON.stringify(args) + "\\n");
const apiArgs = args[1] === "--hostname" ? args.slice(3) : args.slice(1);
const wait = new Int32Array(new SharedArrayBuffer(4));
if (args[0] === "api" && apiArgs[0] === "user") {
  if (process.env.OMP_RPC_GH_BLOCK === "1") {
    fs.writeFileSync(process.env.OMP_RPC_GH_STARTED, "");
    while (!fs.existsSync(process.env.OMP_RPC_GH_GATE)) Atomics.wait(wait, 0, 0, 5);
  }
  process.stdout.write("octocat\\n");
} else if (args[0] === "api" && apiArgs[0] === "graphql") {
  if (process.env.OMP_RPC_GH_BLOCK_QUERY === "1") {
    fs.writeFileSync(process.env.OMP_RPC_GH_STARTED, "");
    while (!fs.existsSync(process.env.OMP_RPC_GH_GATE)) Atomics.wait(wait, 0, 0, 5);
  }
  process.stdout.write(JSON.stringify({ data: { repository: { issueOrPullRequest: {
    __typename: "PullRequest",
    url: "https://github.com/acme/widgets/pull/9",
    state: "OPEN",
    comments: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
    reviews: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
    reviewThreads: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
    commits: { nodes: [] },
  } } } }) + "\\n");
} else process.stdout.write("{}\\n");
`);
  chmodSync(gh, 0o755);
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return paths;
}

async function serverToolSession(t, sessionId, hostId, sessionFileExists = async () => false, onCommand = () => {}) {
  const { startRpcSession } = await import("./rpc-manager.ts");

  const state = { sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: false, isCompacting: false };
  const transports = [];
  const host = {
    id: hostId,
    label: hostId === "local" ? "This machine" : "Laptop",
    status: () => "online",
    onStatus: () => () => {},
    async spawnRpc(request) {
      const listeners = new Set();
      const transport = {
        frames: [],
        write(line, callback) {
          const raw = JSON.parse(line);
          if (raw.t === "event") this.frames.push(raw.event);
          else if (raw.t !== "cmd") this.frames.push(readCommand(line));
          else {
            const command = readCommand(line);
            onCommand(command, state);
            const data = command.type === "get_state" ? state : {};
            queueMicrotask(() => {
              for (const listener of listeners) listener(ompLine({ type: "response", id: command.id, command: command.type, success: true, data }));
            });
          }
          callback(null);
        },
        onLine(listener) {
          listeners.add(listener);
          queueMicrotask(() => listener(ompLine({ type: "ready" })));
        },
        onStderr() {},
        onExit(listener) { this.exit = listener; },
        endInput() { queueMicrotask(() => this.exit?.(0, null)); },
        killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
        emitFrame(frame) {
          for (const listener of listeners) listener(ompLine(frame));
        },
      };
      transports.push(transport);
      return { transport, cwd: request.cwd, fellBack: false, launchAdvisor: false };
    },
    sessionFileExists,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession(sessionId, "", "/w", undefined, false, null, undefined, host);
  return { session, transports, state, host };
}

async function cancelToolOnConfirmation(session, transport, events, id, toolName, args) {
  const dialogCount = events.filter((event) => event.type === "ui_request" && event.method === "confirm").length;
  transport.emitFrame({ type: "host_tool_call", id, toolName, arguments: args });
  const signal = session.serverToolCalls.get(id)?.signal;
  assert.ok(signal, "the server tool call owns an abort signal");
  await waitUntil(() => events.filter((event) => event.type === "ui_request" && event.method === "confirm").length > dialogCount);
  const dialog = events.filter((event) => event.type === "ui_request" && event.method === "confirm").at(-1);
  transport.emitFrame({ type: "host_tool_cancel", targetId: id });
  await waitUntil(() => hostToolResults(transport).some((frame) => frame.id === id));
  assert.ok(events.some((event) => event.type === "ui_end" && event.id === dialog.id), "the cancelled dialog closes");
  assert.equal(getEventListeners(signal, "abort").length, 0, "the confirmation removes its abort listener");
}

test("host tools for a session no tab watches go to other open tabs, then settle when they leave", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t, undefined, SnapshotWrapper, "cross-session");
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set("cross-session", wrapper);
  t.after(() => globalThis.__ompSessions.delete("cross-session"));
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });

  // No tab anywhere: rejected immediately so the agent cannot hang.
  emit({ type: "host_tool_call", id: "alone", toolName: "open_url", arguments: { url: "https://a.test" } });
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["alone", true]]);

  // Another tab is open: it receives the call with the owning session id.
  const calls = [];
  const leave = subscribeHostToolCalls((call) => calls.push(call));
  t.after(leave);
  emit({ type: "host_tool_call", id: "routed", toolName: "open_url", arguments: { url: "https://b.test" } });
  assert.deepEqual(calls, [{ sessionId: "cross-session", hostId: "local", cwd: process.cwd(), id: "routed", toolName: "open_url", arguments: { url: "https://b.test" } }]);
  assert.equal(sentFrames.length, 1);

  // A tab watching the session itself takes precedence over other tabs.
  const own = [];
  const detach = wrapper.onEvent((event) => own.push(event));
  emit({ type: "host_tool_call", id: "own", toolName: "open_url", arguments: {} });
  assert.equal(own.at(-1).id, "own");
  assert.equal(calls.length, 1);

  // That tab leaving settles only its own call; the other tabs still own "routed".
  detach();
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["alone", true], ["own", true]]);

  // The last other tab leaving settles the call routed to it.
  leave();
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["alone", true], ["own", true], ["routed", true]]);
});

test("internal observers cannot receive browser URI requests or keep departed browser calls pending", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  await wrapper.send({ type: "set_host_uri_schemes", schemes: [{ scheme: "browser", writable: true }] });
  const observed = [];
  const stopObserver = wrapper.onEvent((event) => observed.push(event), { internal: true });
  t.after(stopObserver);
  emit({ type: "host_uri_request", id: "no-browser", url: "browser:clipboard", operation: "read" });
  assert.deepEqual(sentFrames.map((frame) => [frame.type, frame.id, frame.isError]), [["host_uri_result", "no-browser", true]]);
  assert.equal(observed.some((event) => event.type === "host_uri_request"), false);

  const browserEvents = [];
  const detachBrowser = wrapper.onEvent((event) => browserEvents.push(event));
  emit({ type: "host_tool_call", id: "own-tool", toolName: "open_url", arguments: {} });
  emit({ type: "host_uri_request", id: "own-uri", url: "browser:clipboard", operation: "read" });
  assert.deepEqual(browserEvents.map((event) => [event.type, event.id]), [["host_tool_call", "own-tool"], ["host_uri_request", "own-uri"]]);
  detachBrowser();
  assert.deepEqual(sentFrames.map((frame) => [frame.type, frame.id, frame.isError]), [
    ["host_uri_result", "no-browser", true],
    ["host_tool_result", "own-tool", true],
    ["host_uri_result", "own-uri", true],
  ], "the last browser leaving rejects its own calls even while the internal observer remains");
  stopObserver();
  assert.equal(sentFrames.length, 3, "internal observer departure cannot answer or reject calls again");
});

test("cross-session tool cancellation retains the source alias and isolates identical request ids", async (t) => {
  let state = { sessionId: "cancel-source", sessionFile: "/s/cancel-source.jsonl", isStreaming: false };
  const first = snapshotSession(t, async () => ({ ...state }), SnapshotWrapper, "cancel-source");
  const second = snapshotSession(t, undefined, SnapshotWrapper, "other-source");
  await first.wrapper.send({ type: "get_state" });
  for (const session of [first, second]) {
    await session.wrapper.send({ type: "set_host_tools", tools: [{ name: "open_file" }] });
  }
  const events = [];
  const leave = subscribeHostToolCalls(event => events.push(event));
  t.after(leave);
  const call = { type: "host_tool_call", id: "same-id", toolName: "open_file", arguments: { path: "local://note.md" } };
  first.emit({ ...call, webCrossSession: true, webSourceSessionId: "spoofed" });
  second.emit(call);
  state = { sessionId: "cancel-moved", sessionFile: "/s/cancel-moved.jsonl", isStreaming: false };
  first.emit({ type: "notice", level: "warning", source: "session-persistence", message: "moved" });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(first.wrapper.sessionId, "cancel-moved");
  first.emit({ type: "host_tool_cancel", targetId: "same-id" });
  assert.deepEqual(events.filter(event => event.type === "host_tool_cancel"), [
    { type: "host_tool_cancel", sessionId: "cancel-source", targetId: "same-id" },
  ]);
  assert.equal(first.sentFrames.length, 0, "native cancellation needs no browser response");
  assert.equal(second.wrapper.isRunning(), true, "the other child still owns its request");
  await second.wrapper.destroyAndWait();
  assert.deepEqual(events.at(-1), { type: "host_tool_cancel", sessionId: "other-source", targetId: "same-id" });
});

// Process-boundary fixtures exercise the real wrapper without invoking the user's installed agent.

test("host tool and URI replies preserve their correlation IDs", async (t) => {
  const commands = [];
  const { wrapper, sentFrames } = snapshotSession(t, async (command) => {
    commands.push({ ...command, id: `w${commands.length + 1}` });
    return {};
  });
  const toolResult = {
    type: "host_tool_result",
    id: "tool-42",
    result: { content: [{ type: "text", text: "opened" }] },
  };
  const uriResult = {
    type: "host_uri_result",
    id: "uri-42",
    result: { content: [{ type: "text", text: "clipboard" }] },
  };

  await wrapper.send(toolResult);
  await wrapper.send(uriResult);

  assert.deepEqual(sentFrames, [toolResult, uriResult]);
  assert.deepEqual(commands, []);
});











test("terminal completion retains response evidence without retaining the unpersisted message", async (t) => {
  const { wrapper, emit } = snapshotSession(t, async () => ({
    sessionId: "observed-response", isStreaming: false, isCompacting: false,
  }));
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } });
  emit({ type: "agent_end", isTerminal: false });
  assert.equal(wrapper.getStreamSnapshot().isPromptRunning, true);
  assert.equal(wrapper.getStreamSnapshot().responseObserved, true);
  emit({ type: "agent_end", isTerminal: true });
  const terminal = wrapper.getStreamSnapshot();
  assert.equal(terminal.isPromptRunning, false);
  assert.equal(terminal.streamingMessage, null);
  assert.equal(terminal.responseObserved, true);
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isPromptRunning, false);
  assert.equal(state.responseObserved, true, "an idle state read cannot erase native response evidence");
});

test("malformed exclusion flags cannot execute a command with shared output", async (t) => {
  const commands = [];
  const { wrapper } = snapshotSession(t, async (command) => { commands.push(command); return {}; });
  for (const excludeFromContext of ["true", null, 1]) {
    await assert.rejects(
      wrapper.send({ type: "bash", command: "printf secret", excludeFromContext }),
      /excludeFromContext must be a boolean/,
    );
  }
  assert.deepEqual(commands, []);
});

test("a prompt or steer during a `!!` shell command degrades into the follow-up queue", async (t) => {
  const commands = [];
  let releaseBash;
  const bashGate = new Promise((resolve) => { releaseBash = resolve; });
  const { wrapper } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "bash") await bashGate;
    return {};
  });

  const bash = wrapper.send({ type: "bash", command: "npm run build" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands.map((command) => command.type), ["bash"]);
  assert.equal(wrapper.isRunning(), true, "the shell command owns the session");

  // Neither frame may reject or abort the shell command: both join omp's own
  // follow-up queue and the reply says where the message went.
  const queuedReply = { queued: true, queue: "followUp", reason: "shellRunning" };
  const image = { type: "image", data: "QUJD", mimeType: "image/png" };
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "run the tests after" }), queuedReply);
  assert.deepEqual(await wrapper.send({ type: "prompt", message: "steer me", streamingBehavior: "steer" }), queuedReply);
  assert.deepEqual(await wrapper.send({ type: "steer", message: "and this", images: [image] }), queuedReply);
  assert.deepEqual(commands.map((command) => command.type), ["bash", "follow_up", "follow_up", "follow_up"]);
  assert.deepEqual(
    commands.slice(1).map(({ type, message, images }) => ({ type, message, images })),
    [
      { type: "follow_up", message: "run the tests after", images: undefined },
      { type: "follow_up", message: "steer me", images: undefined },
      { type: "follow_up", message: "and this", images: [image] },
    ],
  );

  // An invalid attachment still fails before anything reaches omp.
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "bad image", images: [{ type: "text", text: "nope" }] }),
    /Each attachment must be an image/,
  );
  assert.equal(commands.length, 4);
  // Degrading is not a run: nothing was marked as a prompt in flight.
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);

  releaseBash();
  await bash;
  assert.equal(wrapper.isRunning(), false, "the shell command released the session");

  // Back to normal once the shell command is done.
  await wrapper.send({ type: "prompt", message: "now really" });
  assert.equal(commands.at(-1).type, "prompt");
});

test("a `!` shell command runs beside a running turn, which keeps its steers and queued prompts", async (t) => {
  const commands = [];
  let releaseBash;
  const bashGate = new Promise((resolve) => { releaseBash = resolve; });
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "bash") await bashGate;
    return command.type === "bash" ? { output: "ok", exitCode: 0, cancelled: false, truncated: false } : {};
  });
  emit({ type: "agent_start" });

  // omp's terminal runs `!cmd` mid-turn and records it when the next prompt starts.
  const bash = wrapper.send({ type: "bash", command: "git status" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(commands.map((command) => command.type), ["bash"]);
  await assert.rejects(wrapper.send({ type: "bash", command: "ls" }), /already running/);

  // The turn is live, so a steer still steers it and a queued prompt keeps its behavior.
  assert.equal(await wrapper.send({ type: "steer", message: "look here" }), null);
  const queued = await wrapper.send({ type: "prompt", message: "then this", streamingBehavior: "followUp" });
  assert.notEqual(queued?.reason, "shellRunning");
  assert.deepEqual(commands.map((command) => command.type), ["bash", "steer", "prompt"]);

  releaseBash();
  assert.equal((await bash).deferred, true, "omp held the result back for the next prompt");

  emit({ type: "agent_end", isTerminal: true });
  assert.equal((await wrapper.send({ type: "bash", command: "pwd" })).deferred, false, "idle: omp recorded it at once");
});




test("resolveSpawnCwd uses the recorded directory when it exists, falls back otherwise", async () => {
  const { resolveSpawnCwd, resolveSpawnCwdResult } = await import("./hosts/local-host.ts");
  const { existsSync } = await import("node:fs");

  // A live recorded cwd is used verbatim — no fallback.
  const live = process.cwd();
  assert.equal(resolveSpawnCwd(live), live);
  assert.deepEqual(resolveSpawnCwdResult(live), { cwd: live, fellBack: false });

  // A missing recorded cwd falls back to a live directory and reports it.
  const missing = "/nonexistent/path/that/should/not/exist";
  const result = resolveSpawnCwdResult(missing);
  assert.equal(result.fellBack, true);
  assert.ok(existsSync(result.cwd), "fallback cwd must exist on disk");

  // The second-tier fallback is process.cwd() (which exists in normal environments);
  // resolveSpawnCwd (string return) matches the result's cwd.
  assert.equal(result.cwd, process.cwd());
  assert.equal(resolveSpawnCwd(missing), process.cwd());

  // undefined/empty also falls back.
  assert.equal(resolveSpawnCwdResult(undefined).fellBack, true);
  assert.equal(resolveSpawnCwd(undefined), process.cwd());

  // A recorded path that is a file, not a directory, cannot be a cwd either.
  const file = new URL(import.meta.url).pathname;
  assert.deepEqual(resolveSpawnCwdResult(file), { cwd: process.cwd(), fellBack: true });
});

test("missing terminal agent_end clears isPromptRunning on raw idle get_state", async () => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");

  let frameListener = null;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      frameListener = listener;
      return () => { frameListener = null; };
    },
    sendCommand: async (command) => {
      if (command.type === "prompt") return { agentInvoked: true };
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-1",
          sessionFile: "/tmp/session.jsonl",
          isStreaming: false,
          isCompacting: false,
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "Hello" });
  frameListener({ type: "agent_start" });
  assert.equal(wrapper.isRunning(), true);

  // Missing agent_end frame — get_state reports raw idle
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isPromptRunning, false);
  assert.equal(wrapper.isRunning(), false);
  await wrapper.destroyAndWait();
});

test("prompt ack pending does not let raw idle get_state clear promptRunning", async () => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");

  let resolvePromptAck;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async (command) => {
      if (command.type === "prompt") {
        return new Promise((resolve) => { resolvePromptAck = resolve; });
      }
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-2",
          isStreaming: false,
          isCompacting: false,
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  const promptPromise = wrapper.send({ type: "prompt", message: "Hello" });
  assert.equal(wrapper.isRunning(), true);

  // While prompt ack is still pending, get_state must not clear isPromptRunning
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isPromptRunning, true);
  assert.equal(wrapper.isRunning(), true);

  resolvePromptAck({ agentInvoked: true });
  await promptPromise;
  await wrapper.destroyAndWait();
});

test("isTerminal:false respects 2-second grace period before raw idle can clear prompt", async () => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");

  let frameListener = null;
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      frameListener = listener;
      return () => { frameListener = null; };
    },
    sendCommand: async (command) => {
      if (command.type === "prompt") return { agentInvoked: true };
      if (command.type === "get_state") {
        return {
          sessionId: "test-session-3",
          isStreaming: false,
          isCompacting: false,
        };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await wrapper.send({ type: "prompt", message: "Hello" });
  frameListener({ type: "agent_start" });
  frameListener({ type: "agent_end", isTerminal: false });

  // Within the grace period, raw idle does not clear promptRunning
  const stateDuringGrace = await wrapper.send({ type: "get_state" });
  assert.equal(stateDuringGrace.isPromptRunning, true);

  // After grace period expires, raw idle clears promptRunning
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 3000;
    const stateAfterGrace = await wrapper.send({ type: "get_state" });
    assert.equal(stateAfterGrace.isPromptRunning, false);
    assert.equal(wrapper.isRunning(), false);
  } finally {
    Date.now = realNow;
  }
  await wrapper.destroyAndWait();
});

test("abort_and_prompt images go through the same server-side validation as prompt", async () => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");

  let forwarded = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => { forwarded = true; return {}; },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "abort_and_prompt", message: "Hi", images: [{ type: "text", text: "nope" }] }),
    /Each attachment must be an image/,
  );
  assert.equal(forwarded, false, "an invalid attachment must never reach omp");
  await wrapper.destroyAndWait();
});

test("get_state timeout preserves the process and reports a transient status error", async () => {
  const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");

  let disposed = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async (command, timeoutMs) => {
      if (command.type === "get_state") {
        assert.equal(timeoutMs, 5000);
        throw new RpcCommandTimeoutError("get_state", 5000);
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "get_state" }),
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_state_timeout");
      return true;
    },
  );

  assert.equal(disposed, false);
  assert.equal(wrapper.isAlive(), true);
  await wrapper.destroyAndWait();
});

test("a running task survives a slow status query and later state reads recover", async (t) => {
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");
  let reads = 0;
  let running = true;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "get_state" && ++reads === 1) throw new RpcCommandTimeoutError("get_state", 5000);
    return { sessionId: "live", sessionFile: "", isStreaming: running, isCompacting: false };
  });
  let disposed = false;
  const dispose = wrapper.proc.dispose;
  wrapper.proc.dispose = async () => { disposed = true; return dispose(); };
  emit({ type: "agent_start" });
  await assert.rejects(wrapper.send({ type: "get_state" }), { code: "session_state_timeout" });
  assert.equal(disposed, false, "a read-only poll must never stop generation");
  assert.equal(wrapper.isRunning(), true);
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isStreaming, true);
  running = false;
  emit({ type: "agent_end", isTerminal: true });
  assert.equal((await wrapper.send({ type: "get_state" })).isStreaming, false);
  assert.equal(wrapper.isAlive(), true);
});

test("prompt ack timeout recycles a child that accepts the frame but withholds its response", async (t) => {
  const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let acceptedPrompt = null;
  let disposed = false;
  let removedFromRegistry = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: (command, timeoutMs) => {
      if (command.type !== "prompt") return Promise.resolve({});
      acceptedPrompt = command;
      // Model execution is not timed here. This promise represents only the
      // transport response to the accepted prompt frame.
      assert.equal(timeoutMs, 30000);
      return new Promise((_, reject) => {
        setTimeout(() => reject(new RpcCommandTimeoutError("prompt", timeoutMs)), timeoutMs);
      });
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.onDestroy(() => { removedFromRegistry = true; });
  wrapper.start();

  const pending = wrapper.send({ type: "prompt", message: "Hello" });
  await Promise.resolve();
  assert.deepEqual(acceptedPrompt, { type: "prompt", message: "Hello" });
  t.mock.timers.tick(30000);

  await assert.rejects(
    pending,
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_unresponsive");
      return true;
    },
  );

  assert.equal(disposed, true);
  assert.equal(removedFromRegistry, true);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
});

test("getRunningRpcSessions and getRunningRpcSessionIds export running sessions with their originating cwd", async () => {
  const { getRunningRpcSessions, getRunningRpcSessionIds } = await import("./rpc-manager.ts");

  assert.equal(typeof getRunningRpcSessions, "function");
  assert.equal(typeof getRunningRpcSessionIds, "function");
  const running = getRunningRpcSessions();
  const runningIds = getRunningRpcSessionIds();
  assert.ok(Array.isArray(running));
  assert.ok(Array.isArray(runningIds));
  assert.deepEqual(runningIds, running.map((r) => r.id));
});

test("unexpected child exit is retained until a replacement session clears it", async (t) => {
  const {
    AgentSessionWrapper,
    clearExitedRpcSession,
    getExitedRpcSession,
  } = await import("./rpc-manager.ts");
  globalThis.__ompExitedSessions = new Map();
  t.after(() => { delete globalThis.__ompExitedSessions; });

  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    onFrame: () => () => {},
    sendCommand: async (command) => command.type === "get_state"
      ? {
          sessionId: "crashed-session",
          sessionFile: "/tmp/crashed-session.jsonl",
          isStreaming: false,
          isCompacting: false,
        }
      : {},
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  await wrapper.waitUntilReady();
  wrapper.expectedExitProc = fakeProc;
  wrapper.handleProcessExit({ code: 0, signal: null, stderrTail: "" }, fakeProc);
  assert.equal(getExitedRpcSession("crashed-session"), undefined, "deliberate disposal must not look like a crash");

  wrapper.restarting = true;
  const startedAt = Date.now();
  wrapper.handleProcessExit(
    { code: null, signal: "SIGKILL", stderrTail: `${"x".repeat(600)}fatal detail` },
    {},
  );

  const recorded = getExitedRpcSession("crashed-session");
  assert.ok(recorded.at >= startedAt && recorded.at <= Date.now());
  assert.deepEqual({ ...recorded, at: 0 }, {
    id: "crashed-session",
    cwd: process.cwd(),
    at: 0,
    code: null,
    signal: "SIGKILL",
    detail: `${"x".repeat(488)}fatal detail`,
  });
  assert.equal(clearExitedRpcSession("crashed-session"), true);
  assert.equal(getExitedRpcSession("crashed-session"), undefined);
  await wrapper.destroyAndWait();
});

test("a resumed session crash is retained before its initial handshake", async (t) => {
  const { AgentSessionWrapper, getExitedRpcSession } = await import("./rpc-manager.ts");
  globalThis.__ompExitedSessions = new Map();
  t.after(() => { delete globalThis.__ompExitedSessions; });

  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "resume-before-ready", undefined, localHost);
  wrapper.start();
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "startup failed" });

  assert.equal(getExitedRpcSession("resume-before-ready").detail, "startup failed");
  await wrapper.destroyAndWait();
});

/** One reachable (hidden) tab in an isolated notification hub; `restore()` tears it down. */
async function reachableTab() {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveDevice } = await import("./notification-store.ts");
  const previousHub = globalThis.__ompNotificationHub;
  const previousExited = globalThis.__ompExitedSessions;
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "omp-notify-rpc-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  saveDevice("desk-0001", { enabled: true, types: { completed: true, input: true, error: true, modelSwitch: true }, whenActive: "toast", locale: "en" });
  globalThis.__ompExitedSessions = new Map();
  const delivered = [];
  globalThis.__ompNotificationHub = {
    presence: new Map([["tab-0001", { clientId: "tab-0001", deviceId: "desk-0001", visible: false, sessionId: null, lastSeen: Date.now() }]]),
    streams: new Map([["tab-0001", new Set([(message) => delivered.push([message.event.type, message.event.detail])])]]),
  };
  const restore = () => {
    globalThis.__ompNotificationHub = previousHub;
    globalThis.__ompExitedSessions = previousExited;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    // Windows cannot delete the directory while the store's database is open.
    closeNotificationStore();
    rmSync(dir, { recursive: true, force: true });
  };
  return { delivered, restore };
}

/** A wrapper whose omp frames the test drives, with one reachable tab collecting notifications. */
async function notifyingSession(t) {
  const { delivered, restore } = await reachableTab();
  let feed;
  /** What omp's get_state answers; tests change it to simulate session moves and switches. */
  const ompState = { sessionId: "notify-session", sessionFile: "/tmp/notify-session.jsonl", isStreaming: false, isCompacting: false };
  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    onFrame: (handler) => { feed = handler; return () => {}; },
    sendCommand: async (command) => command.type === "get_state" ? { ...ompState } : {},
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  await wrapper.waitUntilReady();
  t.after(async () => {
    await wrapper.destroyAndWait();
    restore();
  });
  return { wrapper, feed, delivered, ompState };
}

test("after a moved session switches to another conversation, a tab left on the old id no longer silences it", async (t) => {
  const { wrapper, feed, delivered, ompState } = await notifyingSession(t);
  // omp moves the conversation to a new file (session-persistence notice).
  Object.assign(ompState, { sessionId: "moved-session", sessionFile: "/tmp/moved-session.jsonl" });
  feed({ type: "notice", level: "warning", source: "session-persistence", message: "moved" });
  await new Promise((resolve) => setImmediate(resolve));
  // Then the user switches the wrapper to an unrelated session.
  Object.assign(ompState, { sessionId: "other-session", sessionFile: "/tmp/other-session.jsonl" });
  await wrapper.refreshIdentityAfterSessionChange();

  globalThis.__ompNotificationHub.presence.set("tab-0001", {
    clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: "notify-session", seq: 1, lastSeen: Date.now(),
  });
  feed({ type: "agent_start" });
  feed({ type: "session_settled" });
  assert.deepEqual(delivered.filter(([type]) => type === "completed"), [["completed", undefined]]);
});

test("omp frames reach the user as notifications: settled run, pending question", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  feed({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: true });
  assert.deepEqual(delivered, [], "completion waits for session_settled");
  feed({ type: "session_settled" });
  feed({ type: "ui_request", id: 1, method: "confirm", args: ["Delete the branch?", ""] });
  assert.deepEqual(delivered, [["completed", undefined], ["input", "Delete the branch?"]]);
});

test("a crash during a run notifies the user once", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "out of memory" });
  assert.deepEqual(delivered, [["error", "out of memory"]]);
});

test("a crash after the turn ended but before background work settled still notifies", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  feed({ type: "prompt_result", agentInvoked: true, status: "completed", sessionSettled: false });
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "killed" });
  assert.deepEqual(delivered, [["error", "killed"]]);
});

test("an asynchronous prompt failure (prompt_error) notifies the user", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "prompt_error", id: "p1", command: "prompt", error: "No API key for provider" });
  assert.deepEqual(delivered, [["error", "No API key for provider"]]);
});

test("a peer server's failed prompt suppresses completion and notifies its failure", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "agent_start" });
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  feed({ type: "peer_prompt_outcome", outcome: { t: "prompt_result", agentInvoked: true, status: "error", error: { message: "boom" } } });
  feed({ type: "session_settled" });
  feed({ type: "peer_prompt_outcome", outcome: { t: "prompt_error", command: "prompt", error: "No API key" } });
  assert.deepEqual(delivered, [["error", "boom"], ["error", "No API key"]]);
});

test("a crash of an idle session does not notify", async (t) => {
  const { wrapper, delivered } = await notifyingSession(t);
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "out of memory" });
  assert.deepEqual(delivered, []);
});

test("buildSessionSpawnArgs maps tool presets to spawn flags", async () => {
  const { buildSessionSpawnArgs } = await import("./hosts/local-host.ts");

  // "full" must omit --tools entirely so omp keeps its complete default
  // toolset (task/hub included); any other list becomes an explicit --tools
  // restriction; an empty list disables tools; resume never re-applies tools.
  assert.deepEqual(buildSessionSpawnArgs("", ["bash", "read", "edit", "write", "grep", "find", "ls"]), []);
  assert.deepEqual(buildSessionSpawnArgs("", ["read", "bash", "edit", "write"]), ["--tools", "read,bash,edit,write"]);
  assert.deepEqual(buildSessionSpawnArgs("", []), ["--no-tools"]);
  assert.deepEqual(buildSessionSpawnArgs("", undefined), []);
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", ["read", "bash", "edit", "write"]),
    ["--resume", "/tmp/session.jsonl"],
  );
});
test("buildSessionSpawnArgs applies workspace launch config safely", async () => {
  const { buildSessionSpawnArgs } = await import("./hosts/local-host.ts");

  assert.deepEqual(
    buildSessionSpawnArgs("", undefined, false, { profile: "work", advisor: true, extraArgs: ["--verbose"] }),
    ["--advisor", "--profile", "work", "--verbose"],
  );
  // An explicit per-call advisor wins without changing valid extra arguments.
  assert.deepEqual(
    buildSessionSpawnArgs("", undefined, true, { advisor: false, extraArgs: ["--verbose"] }),
    ["--advisor", "--verbose"],
  );
  assert.throws(() => buildSessionSpawnArgs("", undefined, false, { profile: "--evil" }), (error) => error.code === "stored_invalid_profile");
  assert.throws(() => buildSessionSpawnArgs("", undefined, false, { extraArgs: ["--resume", "/tmp/x", "--verbose"] }), (error) => error.code === "stored_reserved_launch_arg");
});

test("buildSessionSpawnArgs binds an explicit model on resume only (#277)", async () => {
  const { buildSessionSpawnArgs } = await import("./hosts/local-host.ts");

  // A cold set_model must reach omp before the saved model is restored, so
  // the spawn carries --model alongside --resume.
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", undefined, false, undefined, "october/gpt-6.1-sol"),
    ["--resume", "/tmp/session.jsonl", "--model", "october/gpt-6.1-sol"],
  );
  // New sessions apply their model over RPC after spawn, not at spawn time.
  assert.deepEqual(buildSessionSpawnArgs("", undefined, false, undefined, "october/gpt-6.1-sol"), []);
  // Flag-smuggled / whitespace values never become a flag slot.
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", undefined, false, undefined, "--evil"),
    ["--resume", "/tmp/session.jsonl"],
  );
  assert.deepEqual(
    buildSessionSpawnArgs("/tmp/session.jsonl", undefined, false, undefined, "october/gpt 6"),
    ["--resume", "/tmp/session.jsonl"],
  );
});








test("mcp list ack timeout recycles a child that accepts the frame but withholds its response", async (t) => {
  const { AgentSessionWrapper, WebRpcError } = await import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let acceptedFrame = null;
  let disposed = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: (command, timeoutMs) => {
      if (command.type !== "prompt") return Promise.resolve({});
      acceptedFrame = command;
      // The transport ack of the accepted /mcp list frame — the child takes
      // the frame and never answers.
      assert.equal(timeoutMs, 30000);
      return new Promise((_, reject) => {
        setTimeout(() => reject(new RpcCommandTimeoutError("prompt", timeoutMs)), timeoutMs);
      });
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  const pending = wrapper.getMcpList();
  await Promise.resolve();
  assert.deepEqual(acceptedFrame, { type: "prompt", message: "/mcp list" });
  t.mock.timers.tick(30000);

  await assert.rejects(
    pending,
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_unresponsive");
      return true;
    },
  );

  assert.equal(disposed, true);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
});

test("mcp list ack timeout clears the waiter so a retry is not blocked as busy", async (t) => {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: (command, timeoutMs) =>
      command.type === "prompt"
        ? new Promise((_, reject) => {
            setTimeout(() => reject(new RpcCommandTimeoutError("prompt", timeoutMs)), timeoutMs);
          })
        : Promise.resolve({}),
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();

  const first = wrapper.getMcpList();
  await Promise.resolve();
  t.mock.timers.tick(30000);
  await assert.rejects(first, { code: "session_unresponsive" });

  // The wedged wrapper must not report itself busy: without the bounded ack
  // the finally block never ran and this second call failed with session_busy.
  await assert.rejects(
    () => wrapper.getMcpList(),
    (err) => {
      assert.equal(err.message, "Session is no longer running");
      return true;
    },
  );
});

test("live snapshots restore quiet partial messages and tools, with ordered event metadata", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => {
    events.push(event);
    assert.deepEqual(wrapper.getStreamSnapshot().cursor, event.web, "state is updated before subscribers run");
  });
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "assistant", content: [] } });
  const first = { role: "assistant", content: [{ type: "text", text: "partial" }] };
  emit({ type: "message_update", message: first });
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "sleep 1" } });
  emit({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: [{ type: "text", text: "working" }] } });
  const snapshot = wrapper.getStreamSnapshot();
  assert.deepEqual(snapshot.streamingMessage, first);
  assert.equal(snapshot.isStreaming, true);
  assert.deepEqual(snapshot.toolEvents.map(({ toolCallId, toolName, args, partialResult }) => ({ toolCallId, toolName, args, partialResult })), [
    { toolCallId: "tool-1", toolName: "bash", args: { command: "sleep 1" }, partialResult: { content: [{ type: "text", text: "working" }] } },
  ]);
  await Promise.resolve(); // no further frame: reload must still have a snapshot
  assert.deepEqual(wrapper.getStreamSnapshot(), snapshot);
  emit({ type: "message_start", message: { role: "user", content: "steering" } });
  emit({ type: "message_end", message: { role: "user", content: "steering" } });
  assert.deepEqual(wrapper.getStreamSnapshot().streamingMessage, first);
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "newer" }] } });
  assert.deepEqual(snapshot.streamingMessage, first, "later frames do not mutate prior HTTP snapshots");
  snapshot.cursor.sequence = -1;
  snapshot.streamingMessage.role = "user";
  snapshot.toolEvents[0].toolName = "changed";
  snapshot.toolEvents.length = 0;
  assert.equal(wrapper.getStreamSnapshot().toolEvents[0].toolName, "bash");
  assert.equal(wrapper.getStreamSnapshot().streamingMessage.role, "assistant");
  for (let i = 1; i < events.length; i++) {
    assert.equal(events[i].web.streamId, events[0].web.streamId);
    assert.ok(events[i].web.sequence > events[i - 1].web.sequence);
  }
  emit({ type: "tool_execution_end", toolCallId: "tool-1" });
  emit({ type: "message_end", message: first });
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null);
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents, []);
});

test("a returned background tool's later updates stay out of the live snapshot", (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  emit({ type: "agent_start" });
  for (const id of ["ended", "committed"]) emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
  emit({ type: "tool_execution_end", toolCallId: "ended" });
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "committed", content: [] } });
  // omp keeps reporting a backgrounded job on its call id after the call returned, with no later end.
  for (const id of ["ended", "committed"]) {
    emit({ type: "tool_execution_update", toolCallId: id, toolName: "bash", partialResult: { content: [{ type: "text", text: "done" }] } });
  }
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents, []);
  assert.equal(events.some((event) => event.type === "tool_execution_update"), false, "open tabs drop them too: the row would show running again");
  emit({ type: "agent_end" });
  emit({ type: "agent_start" });
  emit({ type: "tool_execution_update", toolCallId: "ended", toolName: "bash", partialResult: { content: [] } });
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents, [], "a job outliving its run stays out of the next run's snapshot");
  emit({ type: "tool_execution_start", toolCallId: "ended", toolName: "bash", args: {} });
  emit({ type: "tool_execution_update", toolCallId: "ended", toolName: "bash", partialResult: { content: [] } });
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents.map((event) => event.toolCallId), ["ended"], "a new start of a reused id is live again");
});

test("live tool-result images reach tabs and the replay snapshot as media URLs", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "omp-web-live-media-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const image = { type: "image", data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" };
  emit({ type: "tool_execution_start", toolCallId: "shot", toolName: "eval" });
  emit({ type: "tool_execution_update", toolCallId: "shot", partialResult: { content: [image] } });
  const url = events[1].partialResult.content[0].url;
  assert.match(url, /^\/api\/media\/[a-f0-9]{64}$/);
  assert.equal(wrapper.getStreamSnapshot().toolEvents[0].partialResult.content[0].url, url, "reconnecting tabs get the URL too");
  emit({ type: "message_end", message: { role: "toolResult", toolCallId: "shot", content: [{ type: "text", text: "done" }, image] } });
  assert.deepEqual(events[2].message.content[1], { type: "image", mimeType: "image/png", url });
  assert.equal(JSON.stringify(events).includes(image.data), false, "no base64 reaches a tab");
});

test("terminal failures, new runs, aborts and idle reconciliation cannot revive old partial output", async (t) => {
  let failPrompt = false;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "prompt" && failPrompt) throw new Error("prompt rejected");
    if (command.type === "get_state") return { sessionId: "snapshot-life", isStreaming: false, isCompacting: false };
    return {};
  });
  const seed = () => {
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "old" }] } });
    emit({ type: "tool_execution_start", toolCallId: "old-tool", toolName: "bash" });
  };
  const assertCleared = () => {
    const snapshot = wrapper.getStreamSnapshot();
    assert.equal(snapshot.streamingMessage, null);
    assert.deepEqual(snapshot.toolEvents, []);
  };
  seed();
  emit({ type: "agent_end", isTerminal: false });
  assert.equal(wrapper.getStreamSnapshot().isPromptRunning, true);
  assert.equal(wrapper.getStreamSnapshot().toolEvents[0].toolCallId, "old-tool");
  emit({ type: "agent_start" });
  assertCleared();
  seed();
  emit({ type: "agent_end", isTerminal: true });
  assertCleared();
  assert.equal(wrapper.getStreamSnapshot().isStreaming, false);
  seed();
  emit({ type: "prompt_error", id: "p1", command: "prompt", error: "provider failed" });
  assertCleared();
  assert.equal(wrapper.isRunning(), false);
  seed();
  await wrapper.send({ type: "abort" });
  assertCleared();
  seed();
  await wrapper.send({ type: "get_state" });
  assertCleared();
  assert.equal(wrapper.getStreamSnapshot().isPromptRunning, false);
  seed();
  failPrompt = true;
  await assert.rejects(wrapper.send({ type: "prompt", message: "retry" }), /prompt rejected/);
  assertCleared();
  await wrapper.destroyAndWait();
  assert.equal(wrapper.getStreamSnapshot().isStreaming, false);
});

test("session identity changes invalidate the stream epoch and all prior partial output", async (t) => {
  let sessionId = "identity-before";
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "switch_session") { sessionId = "identity-after"; return { cancelled: false }; }
    return { sessionId, sessionFile: `/tmp/${sessionId}.jsonl`, isStreaming: false, isCompacting: false };
  });
  await wrapper.send({ type: "get_state" });
  emit({ type: "agent_start" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "prior identity" }] } });
  emit({ type: "tool_execution_start", toolCallId: "before", toolName: "bash" });
  const before = wrapper.getStreamSnapshot();
  assert.equal(before.responseObserved, true);
  const result = await wrapper.send({ type: "switch_session", sessionPath: "/tmp/identity-after.jsonl" });
  assert.equal(result.newSessionId, "identity-after");
  const after = wrapper.getStreamSnapshot();
  assert.notEqual(after.cursor.streamId, before.cursor.streamId);
  assert.equal(after.cursor.sequence, 0);
  assert.equal(after.streamingMessage, null);
  assert.deepEqual(after.toolEvents, []);
  assert.equal(after.isPromptRunning, false);
  assert.equal(after.responseObserved, false);
});

test("reload replaces the native stream epoch and subscribes to replacement events", async (t) => {
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  let transport;
  const spawnReplacement = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => child.emit("exit", 0, null)); return true; },
    });
    transport = child;
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const command = readCommand(line);
        child.stdout.write(ompLine({
          type: "response", id: command.id, command: command.type, success: true,
          data: command.type === "get_state"
            ? { sessionId: "restart-session", isStreaming: false, isCompacting: false }
            : {},
        }) + "\n");
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write(`${ompLine({ type: "ready" })}\n`));
    return child;
  };
  await mockBuiltin(t, "node:child_process", { spawn: spawnReplacement });
  const { AgentSessionWrapper: ReloadWrapper } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  const { wrapper, emit } = snapshotSession(t, undefined, ReloadWrapper);
  emit({ type: "agent_start" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "old child" }] } });
  const before = wrapper.getStreamSnapshot();
  assert.equal(before.responseObserved, true);
  const restarting = wrapper.send({ type: "reload" });
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null, "restart clears old output before waiting for the replacement");
  assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
  await assert.rejects(wrapper.send({ type: "get_state" }), { code: "session_restarting" });
  await restarting;
  const after = wrapper.getStreamSnapshot();
  assert.notEqual(after.cursor.streamId, before.cursor.streamId);
  assert.equal(after.cursor.sequence, 0);
  assert.equal(after.streamingMessage, null);
  assert.deepEqual(after.toolEvents, []);
  assert.equal(after.responseObserved, false);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  transport.stdout.write(`${ompLine({ type: "agent_start" })}\n`);
  assert.equal(events[0].web.streamId, after.cursor.streamId);
  assert.ok(events[0].web.sequence > after.cursor.sequence);
  await wrapper.destroyAndWait();
});

test("dialog replay keeps sequence ordering and disconnect still settles owned host requests", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  const firstEvents = [];
  const detachFirst = wrapper.onEvent((event) => firstEvents.push(event));
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "browser" }] });
  emit({ type: "ui_request", id: 7, method: "input", args: ["Value"] });
  emit({ type: "host_tool_call", id: "host", toolName: "browser" });
  const beforeReplay = wrapper.getStreamSnapshot().cursor.sequence;
  const replay = [];
  const detachSecond = wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0].id, 7);
  assert.ok(replay[0].web.sequence > beforeReplay);
  assert.equal(replay.some((event) => event.type === "host_tool_call"), false, "host work retains its existing owner");
  detachFirst();
  assert.deepEqual(sentFrames, []);
  detachSecond();
  assert.equal(sentFrames[0].type, "host_tool_result");
  assert.equal(sentFrames[0].id, "host");
  assert.equal(sentFrames[0].isError, true);
  emit({ type: "ui_end", id: 7 });
  const afterCancel = [];
  wrapper.onEvent((event) => afterCancel.push(event));
  assert.deepEqual(afterCancel, []);
});

test("expired dialogs are not replayed by a later stream subscription", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, emit } = snapshotSession(t);
  emit({ type: "ui_request", id: 8, method: "input", args: ["Value", undefined, { timeout: 100 }] });
  t.mock.timers.tick(101);
  const received = [];
  wrapper.onEvent((event) => received.push(event));
  assert.deepEqual(received, []);
});

test("native web metadata cannot forge either wire or cached tool snapshot sequencing", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const forged = { streamId: "native-forgery", sequence: Number.MAX_SAFE_INTEGER };
  emit({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "pwd" }, web: forged });
  const first = wrapper.getStreamSnapshot();
  assert.equal(first.toolEvents[0].web, undefined);
  assert.notEqual(events[0].web.streamId, forged.streamId);
  assert.deepEqual(events[0].web, first.cursor);
  emit({ type: "tool_execution_update", toolCallId: "tool", partialResult: { content: [{ type: "text", text: "workspace" }] }, web: forged });
  const updated = wrapper.getStreamSnapshot();
  assert.equal(updated.toolEvents[0].web, undefined);
  assert.deepEqual(events[1].web, updated.cursor);
  assert.ok(updated.cursor.sequence > first.cursor.sequence);
  assert.equal(updated.toolEvents[0].toolName, "bash");
  assert.deepEqual(updated.toolEvents[0].args, { command: "pwd" });
});

test("new prompts and interrupts cannot reuse old response evidence before agent_start", async (t) => {
  let release;
  const { wrapper, emit } = snapshotSession(t, (command) => {
    if (command.type === "get_state") return Promise.resolve({ sessionId: "run-evidence", isStreaming: false, isCompacting: false });
    return new Promise((resolve) => { release = () => resolve({ agentInvoked: true }); });
  });
  for (const type of ["prompt", "abort_and_prompt"]) {
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, true);
    const pending = wrapper.send({ type, message: "next question" });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
    // An old completion while abort_and_prompt is in flight belongs to the
    // interrupted turn, not the replacement prompt.
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late old answer" }] } });
    emit({ type: "agent_end", isTerminal: true });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
    release();
    await pending;
    emit({ type: "agent_start" });
    emit({ type: "agent_end", isTerminal: true });
    assert.equal((await wrapper.send({ type: "get_state" })).responseObserved, false);
  }
});

test("only visible assistant content supplies current-run response evidence", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  for (const content of [
    [], " ", [{ type: "thinking", thinking: "reasoning" }],
    [{ type: "toolCall", id: "tool", name: "read", arguments: {} }],
    [{ type: "text", text: " " }],
  ]) {
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: { role: "assistant", content } });
    emit({ type: "agent_end", isTerminal: true });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
  }
  for (const content of ["answer", [{ type: "text", text: "answer" }], [{ type: "image", data: "image" }]]) {
    emit({ type: "agent_start" });
    emit({ type: "message_update", message: { role: "assistant", content } });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, true);
    emit({ type: "agent_start" });
    assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
  }
});

test("ask and form dialogs stay pending until a well-formed value or a cancel is forwarded", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit({ type: "ui_request", id: 1, method: "askDialog", args: [[{ id: "q", question: "Pick", options: [{ label: "A" }] }]] });
  emit({ type: "ui_request", id: 2, method: "formDialog", args: ["<form><input name=a></form>"] });
  for (const [id, value] of [[1, "A"], [1, ["A"]], [2, "x"], [2, { data: "a=1" }], [2, { data: null }]]) {
    await assert.rejects(wrapper.send({ type: "ui_response", id, value }), { name: "WebRpcError", code: "invalid_ui_response" }, JSON.stringify(value));
  }
  assert.deepEqual(sentFrames, [], "malformed answers never reach omp");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.deepEqual(replay.map((event) => event.method), ["askDialog", "formDialog"], "a rejected answer leaves the dialog pending for reconnects");

  const result = { kind: "submit", results: [{ id: "q", question: "Pick", options: ["A"], multi: false, selectedOptions: ["A"] }] };
  await wrapper.send({ type: "ui_response", id: 1, value: result });
  await wrapper.send({ type: "ui_response", id: 2 });
  assert.deepEqual(sentFrames, [{ type: "ui_response", id: 1, value: result }, { type: "ui_response", id: 2, value: undefined }]);
  const afterAnswer = [];
  wrapper.onEvent((event) => afterAnswer.push(event));
  assert.deepEqual(afterAnswer, []);
});

test("a runner dialog answer carries a numeric id; a non-numeric one is refused and the dialog stays pending", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit({ type: "ui_request", id: 4, method: "confirm", args: ["Keep going?", ""] });
  await assert.rejects(wrapper.send({ type: "ui_response", id: "four", value: true }), { name: "WebRpcError", code: "invalid_ui_response" });
  assert.deepEqual(sentFrames, []);
  await wrapper.send({ type: "ui_response", id: "4", value: true });
  assert.deepEqual(sentFrames, [{ type: "ui_response", id: 4, value: true }]);
});

test("answering a dialog in one tab dismisses it in every other attached tab", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const other = [];
  wrapper.onEvent((event) => other.push(event));
  emit({ type: "ui_request", id: 3, method: "confirm", args: ["Keep going?", ""] });
  other.length = 0;
  await wrapper.send({ type: "ui_response", id: 3, value: true });
  assert.deepEqual(other.map(({ type, id }) => ({ type, id })), [{ type: "ui_end", id: 3 }]);
  other.length = 0;
  await wrapper.send({ type: "ui_response", id: 3, value: true });
  assert.deepEqual(other, [], "an already-settled dialog emits nothing");
});

test("auto-approve answers tool approvals and “Allow tool” confirms without showing them", async (t) => {
  const host = Object.create(localHost, { autoApproveExtension: { value: () => true } });
  const { wrapper, emit, sentFrames } = snapshotSession(t, undefined, SnapshotWrapper, "", undefined, host);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  emit({ type: "ui_request", id: 1, method: "approve", args: [{ full: "Run bash: ls", compact: "bash: ls" }] });
  emit({ type: "ui_request", id: 2, method: "confirm", args: ["Allow tool: bash", ""] });
  emit({ type: "ui_request", id: 3, method: "confirm", args: ["Log in?", ""] });
  assert.deepEqual(sentFrames, [{ type: "ui_response", id: 1, value: "once" }, { type: "ui_response", id: 2, value: true }]);
  assert.deepEqual(events.filter((event) => event.type === "ui_request").map((event) => event.id), [3]);
});

test("a server-owned confirm takes omp's dialog path and its answer stays on the server", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  const sent = [];
  wrapper.proc.sendFrame = (frame) => sent.push(frame);
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  const answer = wrapper.confirmFromServer("Start a session on build-box in /srv/app?");
  assert.deepEqual(delivered, [["input", "Start a session on build-box in /srv/app?"]]);
  const request = events.find((event) => event.type === "ui_request" && event.method === "confirm");
  assert.deepEqual(request.args, ["Start a session on build-box in /srv/app?", ""]);
  assert.equal(wrapper.isRunning(), true, "a pending dialog keeps the session waiting on the user");
  await wrapper.send({ type: "ui_response", id: request.id, value: true });
  assert.equal(await answer, true);
  assert.deepEqual(sent, [], "omp never sees the server's dialog answer");
  assert.ok(events.some((event) => event.type === "ui_end" && event.id === request.id), "other tabs drop the dialog");

  const ended = wrapper.confirmFromServer("Second?");
  feed({ type: "agent_end", isTerminal: true, messages: [] });
  assert.equal(await ended, false, "a run that ends settles the dialog as declined");
  assert.equal(wrapper.isRunning(), false);

  const closed = wrapper.confirmFromServer("Third?");
  await wrapper.destroyAndWait();
  assert.equal(await closed, false, "a destroyed session settles the dialog as declined");
  assert.equal(await wrapper.confirmFromServer("Fourth?"), false);
});

// ----------------------------------------------------------------------------
// Disconnect reaper (DISCONNECT_DESTROY_MS)
//
// Most drive the real wrapper through the real timer. The window is injected
// through the constructor's test seam (the 120s default would make every
// assertion here vacuous), and the fake process records dispose() so "the child
// was torn down" is observed directly instead of inferred from isAlive() alone.
// ----------------------------------------------------------------------------

const REAP_MS = 25;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough that a correct implementation reaps, short enough to stay fast. */
const afterWindow = () => settle(REAP_MS * 8);

function reapedSession(t, sendCommand, windowMs = REAP_MS, host = localHost) {
  const disposed = [];
  const { wrapper, emit } = snapshotSession(t, sendCommand ?? (async () => ({})), SnapshotWrapper, "", windowMs, host);
  // The fake process is a plain object, so record dispose() instead.
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };
  return { wrapper, emit, disposed };
}

for (const [method, args] of [["askDialog", [[]]], ["confirm", ["Continue?", ""]], ["input", ["Continue?"]]]) {
  test(`a pending ${method} dialog survives disconnect cleanup until answered`, async (t) => {
    const { wrapper, emit, disposed } = reapedSession(t);
    emit({ type: "ui_request", id: 5, method, args });
    await afterWindow();
    assert.deepEqual(disposed, [], "waiting for a human is active work, not an abandoned session");
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), true);
    emit({ type: "ui_end", id: 5 });
    await afterWindow();
    assert.equal(disposed.length, 1, "cleanup is allowed after the pending dialog is gone");
  });
}

test("the ten-minute idle backstop also preserves a pending question", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, emit, disposed } = reapedSession(t, undefined, 0);
  emit({ type: "ui_request", id: 5, method: "askDialog", args: [[]] });
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal(wrapper.isAlive(), true);
  assert.deepEqual(disposed, []);
});

test("a session nobody ever subscribed is reaped without an SSE disconnect", async (t) => {
  // The regression this replaces: arming only from the onEvent unsubscribe path
  // meant a session created by /api/agent/new or /api/mcp, and every keystroke
  // that hits the predict_word fast path, never armed the fast reaper at all.
  const { wrapper, disposed } = reapedSession(t);
  assert.equal(wrapper.hasSubscribers(), false, "precondition: no SSE subscriber");
  await afterWindow();
  assert.equal(disposed.length, 1, "an unwatched session is torn down on schedule");
  assert.equal(wrapper.isAlive(), false);
});

test("a session with an attached SSE listener is never reaped, and is reaped after it detaches", async (t) => {
  const { wrapper, disposed } = reapedSession(t);
  const detach = wrapper.onEvent(() => {});
  assert.equal(wrapper.hasSubscribers(), true);
  // Well past the window: destroying here would leave the route's HTTP 200
  // stream half-open and drop the run without a terminal frame.
  await settle(REAP_MS * 4);
  assert.deepEqual(disposed, [], "a watched session survives past the window");
  assert.equal(wrapper.isAlive(), true);

  // A second tab keeps it alive after the first one leaves.
  const detach2 = wrapper.onEvent(() => {});
  detach();
  await settle(REAP_MS * 4);
  assert.deepEqual(disposed, [], "one remaining subscriber still protects it");
  assert.equal(wrapper.isAlive(), true);

  detach2();
  await afterWindow();
  assert.equal(disposed.length, 1, "the last tab leaving starts the reap clock");
  assert.equal(wrapper.isAlive(), false);
});

test("a session that keeps sending commands is not reaped mid-traffic", async (t) => {
  // POSTs to /api/agent/[id] (predict_word on every keystroke, get_state polls
  // while a run is active) reach sessions that have no SSE subscriber at all.
  // Control time: a busy parallel suite can delay a real keepalive past the
  // 25 ms deadline, which correctly reaps the idle wrapper before it is sent.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, disposed } = reapedSession(t);
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(Math.floor(REAP_MS / 4));
    await wrapper.send({ type: "get_state" });
  }
  assert.deepEqual(disposed, [], "traffic keeps pushing the deadline out");
  assert.equal(wrapper.isAlive(), true);

  t.mock.timers.tick(REAP_MS * 8);
  assert.equal(disposed.length, 1, "once traffic stops the session is reclaimed");
  assert.equal(wrapper.isAlive(), false);
});

test("the reaper never disposes the child under an in-flight command", async (t) => {
  // A command whose response the child still owes: the deadline check alone
  // would fire mid-command and surface as a bogus "Session is no longer
  // running" to whichever route asked.
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { wrapper, disposed } = reapedSession(t, async () => pending);
  const inflight = wrapper.send({ type: "get_state" });
  await settle(REAP_MS * 5);
  assert.deepEqual(disposed, [], "an awaited command blocks the reap");
  assert.equal(wrapper.isAlive(), true);

  release({ sessionId: "s1" });
  await inflight;
  await afterWindow();
  assert.equal(disposed.length, 1, "the reap resumes once the command settles");
});

for (const fails of [false, true]) {
  test(`a submitted upload survives disconnect during preparation; ${fails ? "failure releases protection and the send fence" : "the prepared prompt reaches omp"}`, async (t) => {
    const { runAgentCommand } = await import("./agent-command.ts");
    const { startUpload } = await import("./uploads.ts");
    const { getHost } = await import("./hosts/hub.ts");
    const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");
    const link = await linkHost("Slow upload copy");
    let release;
    const preparation = new Promise((resolve) => { release = resolve; });
    let attaching = false;
    const serving = link.serve({
      uploadStart: () => ({ received: 0, done: true }),
      uploadAttach: async () => {
        attaching = true;
        await preparation;
        if (fails) throw new Error("copy failed");
        return { path: "/remote/s/local/uploads/slow.txt", url: "local://uploads/slow.txt" };
      },
    });
    t.after(async () => { release(); link.drop(); await serving; });
    const id = randomUUID();
    const sessionId = randomUUID();
    await startUpload({ id, hostId: link.id, owner: "open", name: "slow.txt", size: 0, type: "text/plain", sink: { ack() {}, error() {} } });
    const sent = [];
    const { wrapper, disposed } = reapedSession(t, async (command) => {
      if (command.type === "get_state") return { sessionId, sessionFile: "/remote/s.jsonl", isStreaming: false, isCompacting: false };
      sent.push(command);
      return { agentInvoked: false };
    }, REAP_MS, getHost(link.id));
    const detach = wrapper.onEvent(() => {});
    await wrapper.send({ type: "get_state" });
    globalThis.__ompSessions ??= new Map();
    globalThis.__ompSessions.set(sessionId, wrapper);
    t.after(() => { globalThis.__ompSessions.delete(sessionId); globalThis.__ompUploads.delete(id); });

    const submitting = runAgentCommand(sessionId, { type: "prompt", message: "read it", uploads: [id] }, false, "open");
    await until(() => attaching, "upload preparation to start");
    const stop = fails ? runAgentCommand(sessionId, { type: "abort" }, false, "open") : null;
    detach();
    await afterWindow();
    const disposedDuringPreparation = [...disposed];
    const aliveDuringPreparation = wrapper.isAlive();
    release();
    const response = await submitting;
    const stopped = stop ? await stop : null;
    assert.deepEqual(disposedDuringPreparation, [], "preparing a submitted prompt is active command work");
    assert.equal(aliveDuringPreparation, true);
    assert.equal(response.status, fails ? 500 : 200, await response.clone().text());
    if (fails) {
      assert.equal((await response.json()).error, "Slow upload copy: copy failed");
      assert.equal(stopped.status, 200, "the failed attach releases the following Stop");
      assert.deepEqual(sent.map((command) => command.type), ["abort"], "a failed preparation never dispatches the prompt");
    } else {
      assert.deepEqual(sent, [{ type: "prompt", message: "read it\n\nAttached files (this session's local:// directory):\n- [`local://uploads/slow.txt`](/remote/s/local/uploads/slow.txt) (/remote/s/local/uploads/slow.txt, 0 B, text/plain)" }]);
    }
    await afterWindow();
    assert.equal(disposed.length, 1, "normal idle reaping resumes when preparation and dispatch settle");
  });
}

test("a running session is not reaped and is reaped once the run ends", async (t) => {
  const { wrapper, emit, disposed } = reapedSession(t);
  emit({ type: "agent_start" });
  assert.equal(wrapper.isRunning(), true, "precondition: mid-run");
  await settle(REAP_MS * 5);
  assert.deepEqual(disposed, [], "an unwatched run is left alone");
  assert.equal(wrapper.isAlive(), true);

  emit({ type: "agent_end", isTerminal: true });
  assert.equal(wrapper.isRunning(), false);
  await afterWindow();
  assert.equal(disposed.length, 1, "the abandoned run is reclaimed after it ends");
});

test("frames from the child also hold the session open", async (t) => {
  // Deliberately not agent_start: this must hold while nothing is "running",
  // so it can only pass if handleFrame itself records activity. A run's frames
  // are already covered by isRunning() above, which would hide a regression
  // here.
  //
  // A longer window than the group default, and frames driven by their own
  // interval: the property under test is a deadline that keeps moving, not
  // that this test's own timers fire on time. With a 25ms window, asserting
  // between sleeps meant a stalled event loop could reap the session before a
  // late frame arrived, and the test failed at random under a parallel run.
  const WINDOW_MS = 150;
  const { wrapper, emit, disposed } = reapedSession(t, undefined, WINDOW_MS);
  const frames = setInterval(() => emit({ type: "message_update" }), Math.floor(WINDOW_MS / 10));
  t.after(() => clearInterval(frames));

  await settle(WINDOW_MS * 5);
  assert.deepEqual(disposed, [], "frames hold the session open well past the reap window");
  assert.equal(wrapper.isAlive(), true);

  clearInterval(frames);
  await settle(WINDOW_MS * 8);
  assert.equal(disposed.length, 1, "the session is reclaimed once the frames stop");
  assert.equal(wrapper.isAlive(), false);
});

test("closing the last tab starts a fresh window instead of reaping on stale activity", async (t) => {
  // A reload closes the stream and reopens it within a second or two. Reaping
  // on the *last* activity instead of on the detach would kill the child under
  // a tab that is already on its way back, and the reconnected stream would 409
  // ("Session is not managed by omp-web") until a POST respawns it.
  const GRACE_MS = 400;
  const disposed = [];
  const { wrapper } = snapshotSession(t, async () => ({}), SnapshotWrapper, "", GRACE_MS);
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };

  const detach = wrapper.onEvent(() => {});
  // Well past the window while the tab is open: nothing may be reaped.
  await settle(GRACE_MS * 2);
  assert.deepEqual(disposed, [], "a watched session outlives the window");

  detach();
  await settle(GRACE_MS / 2);
  assert.deepEqual(disposed, [], "detaching grants a fresh window, it does not expose stale activity");
  await settle(GRACE_MS * 2);
  assert.equal(disposed.length, 1, "the window still elapses if no tab comes back");
});

test("a session stuck in its startup handshake is never reaped", async (t) => {
  // READY_TIMEOUT_MS and the disconnect window are the same order of magnitude,
  // so a child that never announces itself must fail through its own startup
  // timeout (which reports a real error) instead of being reaped as "unused".
  const disposed = [];
  const proc = {
    isAlive: true,
    onFrame: () => () => {},
    // Never resolves: the handshake stays open for the life of this test.
    waitReady: () => new Promise(() => {}),
    sendCommand: async () => ({}),
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(proc, process.cwd(), null, false, "", REAP_MS, localHost);
  t.after(() => wrapper.destroyAndWait());
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };

  wrapper.start();
  // startRpcSession() runs start() and then waitUntilReady(); the handshake is
  // the second half of that sequence.
  void wrapper.waitUntilReady();
  await settle(REAP_MS * 8);
  assert.deepEqual(disposed, [], "the handshake is in-flight work, not idleness");
  assert.equal(wrapper.isAlive(), true);
});

test("reaping is disabled when the disconnect window is 0", async (t) => {
  const disposed = [];
  const { wrapper } = snapshotSession(t, async () => ({}), SnapshotWrapper, "", 0);
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };
  await settle(REAP_MS * 8);
  assert.deepEqual(disposed, [], "OMP_WEB_DISCONNECT_DESTROY_MS=0 keeps only the 10min idle backstop");
  assert.equal(wrapper.isAlive(), true);
});

test("neither cleanup timer keeps the event loop alive", async () => {
  // The reaper and the idle timer are cleanup deadlines, not work: an unref'd
  // timer is what lets the dev server and a test runner exit. A ref'd one pins a
  // process that has nothing else pending for the full window.
  const moduleUrl = new URL("./rpc-manager.ts", import.meta.url).href;
  const script = `
    const { AgentSessionWrapper } = await import(${JSON.stringify(moduleUrl)});
    const wrapper = new AgentSessionWrapper(
      { isAlive: true, onFrame: () => () => {}, sendCommand: async () => ({}), sendFrame: () => {}, dispose: async () => {} },
      process.cwd(), null, false, "", 10 * 60 * 1000,
    );
    wrapper.start();
    process.stdout.write("armed\\n");
  `;
  const child = childProcess.spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("child kept the event loop alive")); }, 20_000);
    child.on("error", reject);
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.equal(code, 0, `child exited badly: ${err}`);
  assert.match(out, /armed/, "the wrapper armed its timers before the process should exit");
});


test("a session-persistence move re-keys the wrapper without resetting the run", async (t) => {
  let state = { sessionId: "old-id", sessionFile: "/s/old.jsonl", isStreaming: false };
  const { wrapper, emit } = snapshotSession(t, async (command) => (command.type === "get_state" ? { ...state } : {}), SnapshotWrapper, "old-id");
  await wrapper.send({ type: "get_state" });
  const changes = [];
  wrapper.onIdentityChange((oldId, newId, options) => changes.push([oldId, newId, options?.keepOldId === true]));

  emit({ type: "agent_start" });
  state = { sessionId: "new-id", sessionFile: "/s/new.jsonl", isStreaming: true };
  emit({ type: "notice", level: "warning", source: "session-persistence", message: "Session moved to a new file" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(changes, [["old-id", "new-id", true]]);
  assert.equal(wrapper.sessionId, "new-id");
  assert.equal(wrapper.sessionFile, "/s/new.jsonl");
  assert.equal(wrapper.isRunning(), true, "the in-flight run survives the move");
});

test("a later genuine session switch is not treated as a move", async (t) => {
  let state = { sessionId: "a", sessionFile: "/s/a.jsonl", isStreaming: false };
  const { wrapper, emit } = snapshotSession(t, async (command) => (command.type === "get_state" ? { ...state } : {}), SnapshotWrapper, "a");
  await wrapper.send({ type: "get_state" });
  const changes = [];
  wrapper.onIdentityChange((oldId, newId, options) => changes.push([oldId, newId, options?.keepOldId === true]));

  // A persistence warning that changes nothing must not leave the flag armed.
  emit({ type: "notice", level: "warning", source: "session-persistence", message: "write failed" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(changes, []);

  state = { sessionId: "b", sessionFile: "/s/b.jsonl", isStreaming: false };
  await wrapper.send({ type: "get_state" });
  assert.equal(wrapper.sessionId, "b");
  assert.deepEqual(changes, [], "a plain get_state change is not announced as a move");
});

test("generateTitle uses omp's native generate_title command", async (t) => {
  const sent = [];
  const { wrapper } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    return command.type === "generate_title" ? { title: "  Fix the login bug " } : {};
  });
  assert.equal(await wrapper.generateTitle(), "Fix the login bug");
  assert.deepEqual(sent, ["generate_title"]);
});

test("generateTitle falls back to /rename when generate_title is unknown", async (t) => {
  const sent = [];
  let name;
  const { wrapper } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    if (command.type === "prompt") { name = "Refactor sidebar"; return { agentInvoked: false }; }
    if (command.type === "get_state") return { sessionId: "s", sessionFile: "/s/s.jsonl", isStreaming: false, sessionName: name };
    return {};
  });
  assert.equal(await wrapper.generateTitle(), "Refactor sidebar");
  assert.ok(sent.includes("/rename"));
  // The unsupported answer is remembered for this child.
  sent.length = 0;
  await wrapper.generateTitle();
  assert.ok(!sent.includes("generate_title"));
});

test("generateTitle never sends /rename while a run is in flight", async (t) => {
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    return {};
  });
  emit({ type: "agent_start" });
  assert.equal(await wrapper.generateTitle(), null);
  assert.ok(!sent.includes("/rename"));
});

function sessionFileFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-auto-title-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessionFile = join(dir, "s.jsonl");
  writeFileSync(sessionFile, "{}\n");
  return sessionFile;
}

async function waitUntil(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), "condition not reached");
}

test("a finished turn titles an untitled session in the background, then stops asking", async (t) => {
  const sessionFile = sessionFileFixture(t);
  const sent = [];
  let name;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type === "prompt" ? command.message : command.type);
    if (command.type === "generate_title") throw new Error("Unknown command: generate_title");
    if (command.type === "prompt") { name = "Fix the login bug"; return { agentInvoked: false }; }
    if (command.type === "get_state") return { sessionId: "s", sessionFile, isStreaming: false, isCompacting: false, sessionName: name };
    return {};
  }, SnapshotWrapper, "s");
  await wrapper.send({ type: "get_state" });
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  emit({ type: "agent_start" });
  emit({ type: "agent_end" });
  await waitUntil(() => sent.includes("/rename"));
  assert.equal(wrapper.isRunning(), false, "the background /rename is not a run");
  emit({ type: "command_output", text: "Session renamed to Fix the login bug." });
  await waitUntil(() => sent.filter((type) => type === "get_state").length >= 3);
  assert.equal((await wrapper.send({ type: "get_session_stats" })).sessionName, "Fix the login bug");
  assert.deepEqual(events.filter((event) => event.type === "command_output" || event.type === "prompt_result"), []);

  sent.length = 0;
  emit({ type: "agent_start" });
  emit({ type: "agent_end" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!sent.includes("/rename") && !sent.includes("generate_title"), "a titled session is not renamed again");
});

test("auto-titling stops after a few turns omp declines to title", async (t) => {
  const sessionFile = sessionFileFixture(t);
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    if (command.type === "get_state") return { sessionId: "s", sessionFile, isStreaming: false, isCompacting: false };
    return {}; // generate_title without a title: omp declined a low-signal opener
  }, SnapshotWrapper, "s");
  await wrapper.send({ type: "get_state" });
  for (let turn = 0; turn < 5; turn++) {
    emit({ type: "agent_start" });
    emit({ type: "agent_end" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(sent.filter((type) => type === "generate_title").length, 3);
});

test("abort_and_restore_queue returns omp's withdrawn messages and clears the run like abort", async (t) => {
  const restored = { steering: [{ text: "steer" }], followUp: [{ text: "later" }] };
  const sent = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    sent.push(command.type);
    if (command.type === "abort_and_restore_queue") return restored;
    if (command.type === "get_state") return { sessionId: "abort-restore", isStreaming: false, isCompacting: false };
    return { ignored: true };
  });
  emit({ type: "agent_start" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } });

  assert.deepEqual(await wrapper.send({ type: "abort_and_restore_queue" }), restored);
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null);
  assert.equal(wrapper.getStreamSnapshot().isPromptRunning, false);
  assert.equal(await wrapper.send({ type: "abort" }), null, "plain abort still answers nothing");
  assert.deepEqual(sent.filter((type) => type.startsWith("abort")), ["abort_and_restore_queue", "abort"]);
});

test("MCP toggles run native commands, serialize prompts, and reload only after success", async (t) => {
  let dispatch;
  const commands = [];
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "prompt") dispatch = () => emit({ type: "command_output", text: 'Server "volatility" disabled (user config).' });
    return {};
  });
  let restarts = 0;
  wrapper.restart = async () => { restarts++; };
  const pending = wrapper.changeMcp("disable", "volatility");
  await Promise.resolve();
  await assert.rejects(wrapper.send({ type: "prompt", message: "ordinary question" }), { code: "session_busy" });
  await assert.rejects(wrapper.changeMcp("enable", "frida"), { code: "session_busy" });
  dispatch();
  await pending;
  assert.equal(restarts, 1);
  assert.deepEqual(commands.filter(c => c.type === "prompt"), [{ type: "prompt", message: "/mcp disable volatility" }]);
  await assert.rejects(wrapper.changeMcp("enable", "bad\n/mcp reload"), /Invalid MCP server name/);
  assert.equal(wrapper.isRunning(), false);
});

test("MCP command errors cannot report success or reload a session", async (t) => {
  let output;
  const { wrapper, emit } = snapshotSession(t, async (command) => {
    if (command.type === "prompt") output = () => emit({ type: "command_output", text: "Failed to enable MCP server: access denied" });
    return {};
  });
  wrapper.restart = async () => { assert.fail("must not restart on failed write"); };
  const pending = wrapper.changeMcp("enable", "volatility");
  await Promise.resolve(); output();
  await assert.rejects(pending, { code: "mcp_change_failed" });
  assert.equal(wrapper.isRunning(), false);
  emit({ type: "agent_start" });
  await assert.rejects(wrapper.changeMcp("disable", "volatility"), { code: "session_busy" });
});

async function editableSession(t, onEdit) {
  const commands = [];
  const state = {
    sessionId: "edit-same-session", sessionFile: join(isolatedAgentDir, "edit-same-session.jsonl"),
    isStreaming: false, isCompacting: false, queuedMessageCount: 0, isSettled: true, hasPendingAsyncWork: false,
  };
  const { promise: started, resolve: didStart } = Promise.withResolvers();
  let harness;
  const session = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "get_state") return { ...state };
    if (command.type === "edit_message") {
      didStart(command);
      if (onEdit) return onEdit(command, harness);
      return { sessionId: state.sessionId, cancelled: false, leafId: "edit-marker" };
    }
    if (command.type === "branch") return { cancelled: true };
    return {};
  }, SnapshotWrapper, state.sessionId);
  harness = { ...session, commands, state, started, get listenerCount() { return session.listenerCount; } };
  await session.wrapper.send({ type: "get_state" });
  commands.length = 0;
  return harness;
}

test("same-ID edit clears live evidence, invalidates only its own history, and refreshes all observers", async (t) => {
  const { sessionPathKey } = await import("./paths.ts");
  const { subscribeRunningSessions } = await import("./rpc-manager.ts");
  const { wrapper, emit, state, commands } = await editableSession(t);
  const observed = [[], []];
  for (const events of observed) wrapper.onEvent((event) => events.push(event));
  emit({ type: "agent_start" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } });
  emit({ type: "agent_end", isTerminal: true });
  emit({ type: "session_settled" });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "stale partial" }] } });
  emit({ type: "tool_execution_start", toolCallId: "stale-tool", toolName: "bash" });
  assert.equal(wrapper.getStreamSnapshot().responseObserved, true);
  for (const events of observed) events.length = 0;
  const ownKey = sessionPathKey(state.sessionFile);
  const otherKey = sessionPathKey(join(isolatedAgentDir, "unrelated-edit-peer.jsonl"));
  const peer = { retained: true };
  const ownIndex = `edit-test:${ownKey}`;
  const otherIndex = `edit-test:${otherKey}`;
  globalThis.__ompSessionEntriesCache ??= new Map();
  globalThis.__ompSessionHistoryIndexes ??= new Map();
  globalThis.__ompSessionScanCache ??= new Map();
  for (const cache of [globalThis.__ompSessionEntriesCache, globalThis.__ompSessionScanCache]) {
    cache.set(ownKey, { stale: true });
    cache.set(otherKey, peer);
  }
  globalThis.__ompSessionHistoryIndexes.set(ownIndex, { pathKey: ownKey });
  globalThis.__ompSessionHistoryIndexes.set(otherIndex, { pathKey: otherKey });
  t.after(() => {
    for (const cache of [globalThis.__ompSessionEntriesCache, globalThis.__ompSessionScanCache]) {
      cache.delete(ownKey); cache.delete(otherKey);
    }
    globalThis.__ompSessionHistoryIndexes.delete(ownIndex);
    globalThis.__ompSessionHistoryIndexes.delete(otherIndex);
  });
  const running = [];
  t.after(subscribeRunningSessions((update) => running.push(update)));
  const identityChanges = [];
  wrapper.onIdentityChange((...args) => identityChanges.push(args));
  const originalStream = wrapper.getStreamSnapshot().cursor.streamId;
  assert.deepEqual(await wrapper.send({ type: "edit_message", entryId: "u2" }), {
    sessionId: state.sessionId, cancelled: false, leafId: "edit-marker",
  });
  assert.equal(wrapper.sessionId, state.sessionId);
  assert.equal(wrapper.sessionFile, state.sessionFile);
  assert.deepEqual(identityChanges, []);
  assert.equal(commands.some((command) => command.type === "branch" || command.type === "new_session"), false);
  assert.equal(wrapper.getStreamSnapshot().cursor.streamId, originalStream, "same-session navigation is not a Fork or restart");
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null);
  assert.equal(wrapper.getStreamSnapshot().responseObserved, false);
  assert.deepEqual(wrapper.getStreamSnapshot().toolEvents, []);
  for (const events of observed) {
    assert.deepEqual(events.map((event) => ({ type: event.type, leafId: event.leafId })), [{ type: "session_history_changed", leafId: "edit-marker" }]);
  }
  for (const cache of [globalThis.__ompSessionEntriesCache, globalThis.__ompSessionScanCache]) {
    assert.equal(cache.has(ownKey), false);
    assert.equal(cache.get(otherKey), peer);
  }
  assert.equal(globalThis.__ompSessionHistoryIndexes.has(ownIndex), false);
  assert.equal(globalThis.__ompSessionHistoryIndexes.has(otherIndex), true);
  assert.ok(running.some((update) => update.refreshSessionList), "the sidebar is refreshed even though the session ID does not change");
  assert.equal(wrapper.isRunning(), false);
});

test("an ownership-moved edit follows native identity aliases and emits one usable history change", async (t) => {
  const { wrapper, emit, state, commands } = await editableSession(t, (_request, current) => {
    current.state.sessionId = "native-relocated-edit";
    current.state.sessionFile = join(isolatedAgentDir, "native-relocated-edit.jsonl");
    current.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
    return { sessionId: current.state.sessionId, cancelled: false, leafId: "relocated-marker" };
  });
  const oldId = wrapper.sessionId;
  const oldFile = wrapper.sessionFile;
  const registry = new Map([[oldId, wrapper]]);
  const changes = [];
  wrapper.onIdentityChange((from, to, options) => {
    changes.push([from, to, options]);
    if (!options?.keepOldId) registry.delete(from);
    registry.set(to, wrapper);
  });
  emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "old partial" }] } });
  const streamId = wrapper.getStreamSnapshot().cursor.streamId;
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await wrapper.send({ type: "edit_message", entryId: "u2" }), {
    sessionId: "native-relocated-edit", cancelled: false, leafId: "relocated-marker",
  });
  assert.notEqual(state.sessionFile, oldFile);
  assert.equal(wrapper.sessionId, state.sessionId);
  assert.equal(wrapper.sessionFile, state.sessionFile);
  assert.deepEqual(changes, [[oldId, state.sessionId, { keepOldId: true }]]);
  assert.equal(registry.get(oldId), wrapper, "an old tab still addresses the same live wrapper");
  assert.equal(registry.get(state.sessionId), wrapper);
  assert.equal(wrapper.getStreamSnapshot().cursor.streamId, streamId);
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null);
  assert.deepEqual(events.filter((event) => event.type === "session_history_changed").map((event) => event.leafId), ["relocated-marker"]);
  assert.equal(commands.some((command) => command.type === "branch" || command.type === "new_session" || command.type === "switch_session"), false);
  assert.equal(wrapper.isEditingHistory(), false);
  assert.equal(await registry.get(oldId).send({ type: "prompt", message: "after relocation" }), null);
});

for (const cancelled of [false, true]) {
  test(`a changed reply and native state without migration evidence are an unrelated switch (cancelled=${cancelled})`, async (t) => {
    const { wrapper } = await editableSession(t, (_request, current) => {
      current.state.sessionId = "unrelated-native-session";
      current.state.sessionFile = join(isolatedAgentDir, "unrelated-native-session.jsonl");
      return { sessionId: current.state.sessionId, cancelled, leafId: "unrelated-leaf" };
    });
    const events = [];
    wrapper.onEvent((event) => events.push(event));
    await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
    assert.equal(events.some((event) => event.type === "session_history_changed"), false);
    assert.equal(wrapper.isEditingHistory(), false);
    assert.equal(wrapper.isRunning(), false);
  });
}

test("cancellation after evidenced native moves preserves the final identity without a history change", async (t) => {
  const session = await editableSession(t, async (_request, current) => {
    for (const id of ["first-native-edit-move", "second-native-edit-move"]) {
      current.state.sessionId = id;
      current.state.sessionFile = join(isolatedAgentDir, `${id}.jsonl`);
      current.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
      await new Promise((resolve) => setImmediate(resolve));
    }
    return { sessionId: current.state.sessionId, cancelled: true, leafId: "unchanged-leaf" };
  });
  const changes = [];
  const events = [];
  session.wrapper.onIdentityChange((...args) => changes.push(args));
  session.wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await session.wrapper.send({ type: "edit_message", entryId: "u2" }), {
    sessionId: "second-native-edit-move", cancelled: true, leafId: "unchanged-leaf",
  });
  assert.equal(session.wrapper.sessionId, "second-native-edit-move");
  assert.deepEqual(changes.map(([from, to, options]) => [from, to, options?.keepOldId]), [
    ["edit-same-session", "first-native-edit-move", true],
    ["first-native-edit-move", "second-native-edit-move", true],
  ]);
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
  assert.equal(session.wrapper.isAlive(), true);
  assert.equal(session.listenerCount, 1);
});

test("prior native aliases cannot authorize a later unrelated switch during Edit", async (t) => {
  const session = await editableSession(t, (_request, current) => {
    current.state.sessionId = "unrelated-after-prior-move";
    current.state.sessionFile = join(isolatedAgentDir, "unrelated-after-prior-move.jsonl");
    return { sessionId: current.state.sessionId, cancelled: false, leafId: "wrong-leaf" };
  });
  session.state.sessionId = "previously-moved-edit-session";
  session.state.sessionFile = join(isolatedAgentDir, "previously-moved-edit-session.jsonl");
  session.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.wrapper.sessionId, "previously-moved-edit-session");
  const events = [];
  session.wrapper.onEvent((event) => events.push(event));
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
  assert.equal(session.wrapper.isEditingHistory(), false);
  assert.equal(session.listenerCount, 1);
});

for (const errorAt of ["before-result", "post-state"]) {
  test(`native persistence errors stay visible and defeat success through confirmation (${errorAt})`, async (t) => {
    const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed: permission denied" };
    const session = await editableSession(t, (_request, current) => {
      if (errorAt === "before-result") current.emit(notice);
      return { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" };
    });
    if (errorAt === "post-state") {
      const send = session.wrapper.proc.sendCommand;
      let states = 0;
      session.wrapper.proc.sendCommand = async (command, ...args) => {
        if (command.type === "get_state" && ++states === 2) session.emit(notice);
        return send(command, ...args);
      };
    }
    session.emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "preserved on failure" }] } });
    const before = session.wrapper.getStreamSnapshot().streamingMessage;
    const events = [];
    session.wrapper.onEvent((event) => events.push(event));
    await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u2" }), /Native append failed: permission denied/);
    assert.equal(events.filter((event) => event.type === "notice" && event.message === notice.message).length, 1);
    assert.equal(events.some((event) => event.type === "session_history_changed"), false);
    assert.deepEqual(session.wrapper.getStreamSnapshot().streamingMessage, before);
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.wrapper.isRunning(), false);
    assert.equal(session.listenerCount, 1, "only the wrapper's ordinary native listener remains");
    assert.equal(await session.wrapper.send({ type: "prompt", message: "after failed edit" }), null);
  });
}

for (const result of [
  { sessionId: "edit-same-session", cancelled: true, leafId: "old-leaf" },
  { error: "The edit target must be a user message" },
]) {
  test(`cancelled/failed edits do not clear snapshots or emit a history mutation (${JSON.stringify(result)})`, async (t) => {
    const session = await editableSession(t, () => {
      if (result.error) throw new Error(result.error);
      return result;
    });
    const { wrapper, emit } = session;
    emit({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "untouched" }] } });
    const before = wrapper.getStreamSnapshot();
    const events = [];
    wrapper.onEvent((event) => events.push(event));
    if (result.error) await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), /target must be a user message/);
    else assert.deepEqual(await wrapper.send({ type: "edit_message", entryId: "u2" }), result);
    assert.deepEqual(wrapper.getStreamSnapshot(), before);
    assert.deepEqual(events, []);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(session.listenerCount, 1, "cancelled/failed edits remove both operation listeners");
    assert.equal(await wrapper.send({ type: "prompt", message: "a subsequent real prompt" }), null, "the edit fence is released");
  });
}

for (const busyState of [{ isStreaming: true }, { isCompacting: true }, { queuedMessageCount: 1 }, { hasPendingAsyncWork: true }, { isSettled: false }]) {
  test(`authoritative native busy state rejects an edit before any prompt (${JSON.stringify(busyState)})`, async (t) => {
    const { wrapper, commands, state } = await editableSession(t);
    Object.assign(state, busyState);
    assert.equal(wrapper.isRunning(), false, "the wrapper has not seen a native busy event");
    await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_busy" });
    assert.deepEqual(commands.map((command) => command.type), ["get_state"]);
    assert.equal(wrapper.isRunning(), false);
  });
}

test("an OMP without authoritative settlement cannot edit history", async (t) => {
  const { wrapper, commands, state } = await editableSession(t);
  delete state.isSettled;
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_edit_unsupported" });
  assert.deepEqual(commands.map((command) => command.type), ["get_state"]);
  assert.equal(wrapper.isEditingHistory(), false);
});

for (const entryId of [undefined, null, "", "   ", 7]) {
  test(`invalid edit target IDs never reach OMP (${JSON.stringify(entryId)})`, async (t) => {
    const { wrapper, commands } = await editableSession(t);
    await assert.rejects(wrapper.send({ type: "edit_message", entryId }), { code: "invalid_edit_target" });
    assert.deepEqual(commands, []);
    assert.equal(wrapper.isRunning(), false);
  });
}

test("an edit fences prompts and history changes from every client until its correlated result", async (t) => {
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const session = await editableSession(t, async (_request, current) => {
    await gate;
    return { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" };
  });
  const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
  await session.started;
  assert.equal(session.wrapper.isEditingHistory(), true);
  assert.equal(session.wrapper.isRunning(), false, "local edits must not be resumed as interrupted model turns");
  const fenced = [
    { type: "edit_message", entryId: "u1" },
    { type: "prompt", message: "another tab" },
    { type: "steer", message: "steer" },
    { type: "follow_up", message: "queued" },
    { type: "fork", entryId: "u1" },
    { type: "new_session" }, { type: "switch_session", sessionPath: "/other.jsonl" },
    { type: "compact" }, { type: "reload" }, { type: "bash", command: "echo hi" },
    { type: "abort_and_prompt", message: "replace" }, { type: "abort" },
    { type: "set_session_name", name: "rename" }, { type: "set_model", provider: "x", modelId: "y" },
    { type: "remove_queued_message", messageId: "queued" },
  ];
  const sentBefore = session.commands.length;
  for (const command of fenced) await assert.rejects(session.wrapper.send(command), { code: "session_busy" });
  await assert.rejects(session.wrapper.getMcpList(), { code: "session_busy" });
  await assert.rejects(session.wrapper.generateTitle(), { code: "session_busy" });
  assert.equal(session.commands.length, sentBefore, "no fenced mutation reaches the shared child");
  await session.wrapper.send({ type: "get_state" });
  await session.wrapper.send({ type: "get_messages" });
  await session.wrapper.send({ type: "ui_response", id: 7 });
  assert.equal(session.sentFrames.at(-1).id, 7, "navigation hooks may still receive dialog answers");
  release();
  assert.equal((await editing).leafId, "marker");
  assert.equal(await session.wrapper.send({ type: "prompt", message: "after edit" }), null);
});

test("the mutation fence is acquired before the edit's native-state preflight can resolve", async (t) => {
  const { wrapper, state, commands } = await editableSession(t);
  const originalSend = wrapper.proc.sendCommand;
  const { promise: gate, resolve: release } = Promise.withResolvers();
  let preflight = true;
  wrapper.proc.sendCommand = async (command, ...rest) => {
    if (command.type === "get_state" && preflight) { preflight = false; await gate; }
    return originalSend(command, ...rest);
  };
  const editing = wrapper.send({ type: "edit_message", entryId: "u2" });
  await assert.rejects(wrapper.send({ type: "prompt", message: "racing preflight" }), { code: "session_busy" });
  await assert.rejects(wrapper.send({ type: "fork", entryId: "u1" }), { code: "session_busy" });
  assert.deepEqual(commands, []);
  release();
  assert.equal((await editing).sessionId, state.sessionId);
});

test("a pending Fork prevents an edit, while independent Fork retains its native branch contract", async (t) => {
  const { wrapper, commands } = await editableSession(t);
  const originalSend = wrapper.proc.sendCommand;
  const { promise: gate, resolve: release } = Promise.withResolvers();
  wrapper.proc.sendCommand = async (command, ...rest) => command.type === "branch" ? gate : originalSend(command, ...rest);
  const forking = wrapper.send({ type: "fork", entryId: "u2" });
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_busy" });
  assert.equal(commands.some((command) => command.type === "edit_message"), false);
  release({ cancelled: true });
  assert.deepEqual(await forking, { cancelled: true });
  wrapper.proc.sendCommand = originalSend;
  assert.equal((await wrapper.send({ type: "edit_message", entryId: "u2" })).cancelled, false);
});

for (const field of ["sessionId", "sessionFile"]) {
  test(`an identity mismatch in ${field} never looks like a successful same-session edit`, async (t) => {
    const { wrapper, state, commands } = await editableSession(t);
    state[field] = "different";
    await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
    assert.deepEqual(commands.map((command) => command.type), ["get_state"]);
  });
}

test("native identity is checked again after navigation rather than trusting the command's result alone", async (t) => {
  const { wrapper } = await editableSession(t, (_request, current) => {
    current.state.sessionFile = join(isolatedAgentDir, "unexpected-fork.jsonl");
    return { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" };
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
  assert.deepEqual(events, []);
  assert.equal(wrapper.isRunning(), false);
});

test("a timed-out navigation disposes the old child before releasing the edit fence", async (t) => {
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");
  const { wrapper } = await editableSession(t, async () => { throw new RpcCommandTimeoutError("edit_message", 15_000); });
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_unresponsive" });
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
  await assert.rejects(wrapper.send({ type: "prompt", message: "cannot race a late navigation" }), /no longer running/);
});

test("a persistence notice cannot release Edit before timed-out child teardown", async (t) => {
  const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");
  const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed before edit handler completion" };
  const { promise: disposal, resolve: finishDisposal } = Promise.withResolvers();
  t.after(finishDisposal);
  const session = await editableSession(t, (_request, current) => {
    current.emit(notice);
    return new Promise((_, reject) => {
      setTimeout(() => reject(new RpcCommandTimeoutError("edit_message", 15_000)), 15_000);
    });
  });
  const { promise: disposing, resolve: didDispose } = Promise.withResolvers();
  session.wrapper.proc.dispose = () => { didDispose(); return disposal; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = [];
  session.wrapper.onEvent((event) => events.push(event));
  let settled = false;
  const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
  void editing.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(editing, { message: notice.message });
  await session.started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the persistence notice does not confirm handler completion");
  assert.equal(session.wrapper.isEditingHistory(), true);
  assert.equal(session.wrapper.isAlive(), true);
  const mutations = [
    { type: "prompt", message: "next mutation" },
    { type: "fork", entryId: "u1" },
    { type: "switch_session", sessionPath: "/other.jsonl" },
  ];
  const sentBefore = session.commands.length;
  for (const command of mutations) await assert.rejects(session.wrapper.send(command), { code: "session_busy" });
  assert.equal(session.commands.length, sentBefore);
  t.mock.timers.tick(15_000);
  await disposing;
  assert.equal(session.wrapper.isEditingHistory(), true);
  assert.equal(settled, false, "the original write error is returned only after the child has stopped");
  assert.equal(session.wrapper.isAlive(), false);
  for (const command of mutations) await assert.rejects(session.wrapper.send(command), /no longer running/);
  session.emit({ type: "agent_start" });
  assert.equal(session.wrapper.isRunning(), false);
  assert.equal(events.some((event) => event.type === "agent_start" || event.type === "session_history_changed"), false);
  assert.equal(events.filter((event) => event.type === "notice" && event.message === notice.message).length, 1);
  finishDisposal();
  await rejection;
  assert.equal(session.wrapper.isEditingHistory(), false);
  assert.equal(session.listenerCount, 0);
});

test("a resumed session omp moved during startup stays routable by the requested id", async (t) => {
  const requestedId = "startup-move-requested";
  const movedId = "startup-move-forked";
  const newId = "startup-move-new";
  const { current, children } = await startupMoveHarness(t, movedId, newId);
  const requestedFile = join(isolatedAgentDir, `${requestedId}.jsonl`);
  const { startRpcSession, getRpcSession } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  // This machine is reached through its daemon; spawn the scripted child directly.
  const { localHost: stdioHost } = await import(`./hosts/local-host.ts?fresh=${isolatedFresh++}`);
  const { session, realSessionId } = await startRpcSession(requestedId, requestedFile, isolatedAgentDir, undefined, undefined, null, undefined, stdioHost);
  t.after(() => session.destroyAndWait());
  assert.equal(realSessionId, movedId);
  assert.equal(getRpcSession(movedId), session);
  assert.equal(getRpcSession(requestedId), session, "a client holding the requested id must still reach the wrapper");
  // A new conversation on the same wrapper must not stay reachable under the startup alias.
  await session.send({ type: "new_session" });
  assert.equal(current.sessionId, newId);
  assert.equal(getRpcSession(newId), session);
  assert.equal(getRpcSession(requestedId), undefined, "the startup alias names the old conversation");
  assert.equal(getRpcSession(movedId), undefined);
  await session.destroyAndWait();
  assert.equal(getRpcSession(newId), undefined);
  assert.equal(children.length, 1);
});

test("a tab still on the id omp moved away from during startup counts as viewing the conversation", async (t) => {
  const requestedId = "startup-move-viewed";
  const { children } = await startupMoveHarness(t, "startup-move-viewed-fork", "startup-move-viewed-new");
  const { delivered, restore } = await reachableTab();
  const { startRpcSession } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  const { localHost: stdioHost } = await import(`./hosts/local-host.ts?fresh=${isolatedFresh++}`);
  const { session } = await startRpcSession(requestedId, join(isolatedAgentDir, `${requestedId}.jsonl`), isolatedAgentDir, undefined, undefined, null, undefined, stdioHost);
  t.after(async () => {
    await session.destroyAndWait();
    restore();
  });
  globalThis.__ompNotificationHub.presence.set("tab-0001", {
    clientId: "tab-0001", deviceId: "desk-0001", visible: true, sessionId: requestedId, seq: 1, lastSeen: Date.now(),
  });
  for (const type of ["agent_start", "session_settled"]) children[0].stdout.write(`${ompLine({ type })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(delivered, [], "a visible tab on the requested id is watching this run");
});

/**
 * Fake omp children for `startRpcSession`: the first `get_state` already reports the forked
 * identity (omp moved the resumed session during startup) and `new_session` switches `current`.
 * Import rpc-manager and local-host fresh afterwards so they bind the fake spawn.
 */
async function startupMoveHarness(t, movedId, newId) {
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  const current = { sessionId: movedId, sessionFile: join(isolatedAgentDir, `${movedId}.jsonl`) };
  const children = [];
  const spawnMoved = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => child.emit("exit", 0, null)); return true; },
    });
    children.push(child);
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const command = readCommand(line);
        if (command.type === "new_session") Object.assign(current, { sessionId: newId, sessionFile: join(isolatedAgentDir, `${newId}.jsonl`) });
        const data = command.type === "get_state"
          ? { ...current, isStreaming: false, isCompacting: false }
          : {};
        child.stdout.write(`${ompLine({ type: "response", id: command.id, command: command.type, success: true, data })}\n`);
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write(`${ompLine({ type: "ready" })}\n`));
    return child;
  };
  await mockBuiltin(t, "node:child_process", { spawn: spawnMoved });
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  return { current, children };
}

test("independent Fork still sends native branch and returns a new session ID and its editable text", async (t) => {
  const commands = [];
  let sessionId = "original-fork-session";
  const { wrapper } = snapshotSession(t, async (command) => {
    commands.push(command);
    if (command.type === "branch") {
      sessionId = "new-fork-session";
      return { cancelled: false, text: "the forked prompt" };
    }
    if (command.type === "get_state") return { sessionId, sessionFile: join(isolatedAgentDir, `${sessionId}.jsonl`), isStreaming: false, isCompacting: false };
    return {};
  }, SnapshotWrapper, sessionId);
  await wrapper.send({ type: "get_state" });
  commands.length = 0;
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  assert.deepEqual(await wrapper.send({ type: "fork", entryId: "u2" }), {
    cancelled: false, newSessionId: "new-fork-session", text: "the forked prompt",
  });
  assert.deepEqual(commands.map((command) => command.type), ["branch", "get_state"]);
  assert.equal(wrapper.sessionId, "new-fork-session");
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
});
test("server agent tools are answered by the server, not the browser (#275)", async (t) => {
  // Enable the off-by-default gate via the isolated settings file, and
  // drop the cached settings so this test's gate value is actually read.
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const sentCommands = [];
  const { wrapper, emit, sentFrames } = snapshotSession(
    t,
    async (command) => { sentCommands.push(command); return {}; },
    SnapshotWrapper,
    "agent-source",
  );
  // A UI registration must not drop the server tools (send() merges them).
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  const registration = sentCommands.find((c) => c.type === "set_host_tools");
  assert.ok(registration.tools.some((tool) => tool.name === "list_sessions"));
  assert.ok(registration.tools.some((tool) => tool.name === "send_to_session"));

  // A tab watching this session must NOT receive the call: the server
  // answers it itself, with no browser involved.
  const own = [];
  const detach = wrapper.onEvent((event) => own.push(event));
  emit({ type: "host_tool_call", id: "list-1", toolName: "list_sessions", arguments: {} });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(own.some((event) => event.type === "host_tool_call"), false);
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].id, "list-1");
  assert.equal(sentFrames[0].isError, false);
  assert.deepEqual(JSON.parse(sentFrames[0].result.content[0].text), { sessions: [] });
  detach();
});

test("cancelling GitHub read and write confirmations closes dialogs without granting or posting", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  const previousLogin = globalThis.__ompGhLogin;
  globalThis.__ompGhLogin = undefined;
  const gh = fakeGhCli(t);
  const { closeWatchStore, grantRead, hasReadGrant } = await import("./github/watch-store.ts");
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    globalThis.__ompGhLogin = previousLogin;
    closeWatchStore();
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const sessionId = "github-confirm-cancel";
  const { session, transports } = await serverToolSession(t, sessionId, "laptop");
  const events = [];
  session.onEvent((event) => events.push(event));

  await cancelToolOnConfirmation(session, transports[0], events, "read-cancel", "github_read", { target: "acme/widgets#9" });
  assert.equal(hasReadGrant(sessionId, "acme/widgets"), false, "a cancelled read confirmation grants no repository access");

  grantRead(sessionId, "acme/widgets");
  await cancelToolOnConfirmation(session, transports[0], events, "write-cancel", "github_comment", { target: "acme/widgets#9", body: "do not post" });
  assert.equal(hasReadGrant(sessionId, "acme/widgets"), true, "cancelling a write keeps the existing read grant");
  assert.deepEqual((await readFile(gh.calls, "utf8")).trim().split("\n").map(JSON.parse), [["api", "--hostname", "github.com", "user", "--jq", ".login"]], "neither cancelled confirmation reaches a GitHub read or write");
});

test("a restart during checkGh cancels the write and never answers the replacement child", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, githubWritesUnasked: true, agentEnv: {} }));
  const previousLogin = globalThis.__ompGhLogin;
  globalThis.__ompGhLogin = undefined;
  const gh = fakeGhCli(t, { blockLogin: true });
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    globalThis.__ompGhLogin = previousLogin;
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const { session, transports } = await serverToolSession(t, "github-restart", "local");
  transports[0].emitFrame({ type: "host_tool_call", id: "restart-write", toolName: "github_comment", arguments: { target: "acme/widgets#9", body: "must not post" } });
  await waitUntil(() => existsSync(gh.started));
  await session.send({ type: "reload" });
  assert.equal(transports.length, 2, "reload started a replacement child while checkGh was pending");

  writeFileSync(gh.gate, "continue");
  await waitUntil(() => !session.serverToolCalls.has("restart-write"));
  assert.deepEqual((await readFile(gh.calls, "utf8")).trim().split("\n").map(JSON.parse), [["api", "--hostname", "github.com", "user", "--jq", ".login"]], "only the login check ran; no comment was posted");
  assert.deepEqual(hostToolResults(transports[1]), [], "the old child's result is never delivered to the replacement");
});

test("a server tool arriving during restart is rejected before it can start", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, githubWritesUnasked: true, agentEnv: {} }));
  const previousLogin = globalThis.__ompGhLogin;
  globalThis.__ompGhLogin = undefined;
  const gh = fakeGhCli(t, { blockLogin: true });
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    globalThis.__ompGhLogin = previousLogin;
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  let releaseSessionCheck;
  const deferredSessionCheck = new Promise((resolve) => { releaseSessionCheck = resolve; });
  let deferSessionCheck = false;
  const { session, transports } = await serverToolSession(
    t,
    "github-late-call",
    "local",
    () => deferSessionCheck ? deferredSessionCheck : Promise.resolve(false),
  );
  deferSessionCheck = true;
  const reloading = session.send({ type: "reload" });
  const releaseWork = async () => {
    releaseSessionCheck(false);
    writeFileSync(gh.gate, "continue");
    await reloading.catch(() => {});
    await waitUntil(() => !session.serverToolCalls.has("late-restart-write"));
  };
  try {
    await waitUntil(() => session.restarting);
    transports[0].emitFrame({
      type: "host_tool_call", id: "late-restart-write", toolName: "github_comment",
      arguments: { target: "acme/widgets#9", body: "must not post" },
    });
    assert.equal(session.serverToolCalls.has("late-restart-write"), false, "restart rejects the call before allocating a controller");
    await waitUntil(() => hostToolResults(transports[0]).some((frame) => frame.id === "late-restart-write"));
    const result = hostToolResults(transports[0]).find((frame) => frame.id === "late-restart-write");
    assert.equal(result.isError, true);
    assert.match(result.result.content[0].text, /restart/i);
    assert.equal(existsSync(gh.started), false, "the late call never checks GitHub");
  } finally {
    await releaseWork();
  }
  assert.equal(transports.length, 2, "the pending restart still replaces the child");
  assert.equal(existsSync(gh.calls), false, "the late call cannot check or post to GitHub");
  assert.deepEqual(hostToolResults(transports[1]), [], "the old call has no result on the replacement child");
});

test("a replacement child runs server tools during adoption while the old child stays fenced", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  let releaseSessionCheck;
  const sessionCheck = new Promise((resolve) => { releaseSessionCheck = resolve; });
  let waitForSessionCheck = false;
  const sessionId = "adoption-restart-tools";
  const oldCallId = "old-child-list";
  const newCallId = "replacement-list";
  const { session, transports, host } = await serverToolSession(
    t,
    sessionId,
    "local",
    () => waitForSessionCheck ? sessionCheck : Promise.resolve(false),
  );
  const replacement = adoptedTransport(sessionId, {
    held: [ompLine({ type: "host_tool_call", id: newCallId, toolName: "list_sessions", arguments: {} })],
    silent: ["get_btw_history"],
  });
  replacement.hostOwnedLifecycle = true;
  replacement.close = () => {};
  replacement.setHostTools = async () => {};
  host.spawnRpc = async (request) => {
    transports.push(replacement);
    return { transport: replacement, cwd: request.cwd, fellBack: false, launchAdvisor: false, pending: [] };
  };
  waitForSessionCheck = true;
  const reloading = session.send({ type: "reload" });
  let sessionCheckReleased = false;
  let adoptionReleased = false;
  const finishRestart = async () => {
    if (!sessionCheckReleased) {
      sessionCheckReleased = true;
      releaseSessionCheck(false);
    }
    if (!adoptionReleased) {
      await waitUntil(() => replacement.sent.includes("get_btw_history") || !session.restarting).catch(() => {});
      const command = replacement.frames.find((frame) => frame.type === "get_btw_history");
      if (command) {
        adoptionReleased = true;
        replacement.answer(command);
      }
    }
    await reloading.catch(() => {});
  };

  try {
    await waitUntil(() => session.restarting);
    transports[0].emitFrame({ type: "host_tool_call", id: oldCallId, toolName: "list_sessions", arguments: {} });
    await waitUntil(() => hostToolResults(transports[0]).some((frame) => frame.id === oldCallId));
    const oldResult = hostToolResults(transports[0]).find((frame) => frame.id === oldCallId);
    assert.equal(oldResult.isError, true, "the replacing child is rejected");
    assert.equal(session.serverToolCalls.has(oldCallId), false);

    releaseSessionCheck(false);
    sessionCheckReleased = true;
    await waitUntil(() => replacement.sent.includes("get_btw_history"));
    assert.equal(session.restarting, true, "the replacement is still in its adoption handshake");
    const handshake = replacement.frames.find((frame) => frame.type === "get_btw_history");
    replacement.answer(handshake);
    adoptionReleased = true;
    await waitUntil(() => hostToolResults(replacement).some((frame) => frame.id === newCallId));
    const newResults = hostToolResults(replacement).filter((frame) => frame.id === newCallId);
    assert.equal(newResults.length, 1, "the replacement's live list_sessions call executes once");
    assert.equal(newResults[0].isError, false, "the replacement's call is not rejected as restarting");
    assert.deepEqual(hostToolResults(transports[0]).filter((frame) => frame.id === newCallId), []);
    await reloading;
    assert.equal(session.restartingProc, null, "the replacement fence is cleared after restart");
  } finally {
    await finishRestart();
  }
});

test("a GitHub watch follows a session move during its snapshot fetch", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  const previousLogin = globalThis.__ompGhLogin;
  globalThis.__ompGhLogin = undefined;
  const gh = fakeGhCli(t, { blockQuery: true });
  const { closeWatchStore, listWatches } = await import("./github/watch-store.ts");
  const { startGithubWatcher, stopGithubWatcher } = await import("./github/watcher.ts");
  const { closeOutboxStore } = await import("./message-outbox.ts");
  // Exercise the production move subscription, including provisional watch intents.
  startGithubWatcher({ schedule: () => () => {} });
  t.after(() => {
    stopGithubWatcher();
    closeOutboxStore();
  });
  await waitUntil(() => typeof globalThis.__ompGithubWatcher?.detachMove === "function");
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    globalThis.__ompGhLogin = previousLogin;
    closeWatchStore();
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const oldId = "github-watch-move-a";
  const newId = "github-watch-move-b";
  const { session, transports, state } = await serverToolSession(t, oldId, "local");
  transports[0].emitFrame({
    type: "host_tool_call", id: "watch-before-move", toolName: "watch_github",
    arguments: { target: "acme/widgets#9" },
  });
  await waitUntil(() => existsSync(gh.started));

  state.sessionId = newId;
  state.sessionFile = `/nonexistent/${newId}.jsonl`;
  transports[0].emitFrame({ type: "notice", source: "session-persistence", message: "Session moved to a new file" });
  await waitUntil(() => session.sessionId === newId);
  writeFileSync(gh.gate, "continue");
  await waitUntil(() => hostToolResults(transports[0]).some((frame) => frame.id === "watch-before-move"));
  assert.deepEqual(listWatches().map((watch) => watch.sessionId), [newId]);

  transports[0].emitFrame({
    type: "host_tool_call", id: "unwatch-after-move", toolName: "unwatch_github",
    arguments: { target: "acme/widgets#9" },
  });
  await waitUntil(() => hostToolResults(transports[0]).some((frame) => frame.id === "unwatch-after-move"));
  assert.deepEqual(listWatches(), []);
});

test("switching conversations aborts an in-flight GitHub watch without leaking grants or results", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  const previousLogin = globalThis.__ompGhLogin;
  globalThis.__ompGhLogin = undefined;
  const gh = fakeGhCli(t, { blockQuery: true });
  const { closeWatchStore, hasReadGrant, listWatches } = await import("./github/watch-store.ts");
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    globalThis.__ompGhLogin = previousLogin;
    closeWatchStore();
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const oldId = "github-switch-before";
  const newId = "github-switch-after";
  const callId = "watch-switching-session";
  const { session, transports } = await serverToolSession(t, oldId, "laptop", undefined, (command, state) => {
    if (command.type === "switch_session") {
      state.sessionId = newId;
      state.sessionFile = `/nonexistent/${newId}.jsonl`;
    }
  });
  const events = [];
  session.onEvent((event) => events.push(event));
  transports[0].emitFrame({
    type: "host_tool_call", id: callId, toolName: "watch_github",
    arguments: { target: "acme/widgets#9" },
  });

  let signal;
  try {
    await waitUntil(() => events.some((event) => event.type === "ui_request" && event.method === "confirm"));
    const dialog = events.find((event) => event.type === "ui_request" && event.method === "confirm");
    signal = session.serverToolCalls.get(callId)?.signal;
    assert.ok(signal, "the watch call has its own cancellation signal");
    await session.send({ type: "ui_response", id: dialog.id, value: true });
    await waitUntil(() => existsSync(gh.started));
    assert.equal(hasReadGrant(oldId, "acme/widgets"), true, "the accepted read grant stays with its original conversation");

    await session.send({ type: "switch_session", sessionPath: "/tmp/github-switch-after.jsonl" });
    assert.equal(session.sessionId, newId);
    assert.equal(signal.aborted, true, "switching away aborts the pending server tool");
    writeFileSync(gh.gate, "continue");
    await waitUntil(() => !session.serverToolCalls.has(callId));

    assert.deepEqual(listWatches(), [], "the old watch is not registered under the new conversation");
    assert.equal(hasReadGrant(newId, "acme/widgets"), false, "the new conversation receives no read grant");
    assert.deepEqual(hostToolResults(transports[0]).filter((frame) => frame.id === callId), [], "the old tool result is not delivered into the switched conversation");
  } finally {
    writeFileSync(gh.gate, "continue");
    if (session.serverToolCalls.has(callId)) transports[0].emitFrame({ type: "host_tool_cancel", targetId: callId });
    await waitUntil(() => !session.serverToolCalls.has(callId));
  }
});

test("destroying during checkGh cancels the write before child teardown", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, githubWritesUnasked: true, agentEnv: {} }));
  const previousLogin = globalThis.__ompGhLogin;
  globalThis.__ompGhLogin = undefined;
  const gh = fakeGhCli(t, { blockLogin: true });
  t.after(() => {
    globalThis.__ompWebSettingsCache = undefined;
    globalThis.__ompGhLogin = previousLogin;
    try { rmSync(settingsPath); } catch { /* already gone */ }
  });

  const { session, transports } = await serverToolSession(t, "github-destroy", "local");
  transports[0].emitFrame({ type: "host_tool_call", id: "destroy-write", toolName: "github_comment", arguments: { target: "acme/widgets#9", body: "must not post" } });
  await waitUntil(() => existsSync(gh.started));
  await session.destroyAndWait();
  writeFileSync(gh.gate, "continue");
  await waitUntil(() => !session.serverToolCalls.has("destroy-write"));
  assert.deepEqual((await readFile(gh.calls, "utf8")).trim().split("\n").map(JSON.parse), [["api", "--hostname", "github.com", "user", "--jq", ".login"]], "destroy aborted before the GitHub write");
});

test("server agent tools are rejected when the gate is off (#275)", async (t) => {
  globalThis.__ompWebSettingsCache = undefined;
  t.after(() => { globalThis.__ompWebSettingsCache = undefined; });
  const { emit, sentFrames } = snapshotSession(t, undefined, SnapshotWrapper, "agent-source-off");
  emit({ type: "host_tool_call", id: "off-1", toolName: "list_sessions", arguments: {} });
  assert.deepEqual(sentFrames.map((f) => [f.id, f.isError]), [["off-1", true]]);
  assert.match(sentFrames[0].result.content[0].text, /disabled/);
});

test("waitForTurnEnd resolves on terminal agent_end and rejects on timeout (#275)", async (t) => {
  const { wrapper, emit } = snapshotSession(t, undefined, SnapshotWrapper, "waiter");
  const done = wrapper.waitForTurnEnd(1000);
  emit({ type: "agent_end", isTerminal: true });
  await done;
  await assert.rejects(() => wrapper.waitForTurnEnd(20), /Timed out/);
  const promptDone = wrapper.waitForTurnEnd(1000);
  emit({ type: "prompt_result" });
  await promptDone;
});

test("wrapper spawns through its host", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const requests = [];
  const invalidated = [];
  let emitLine;
  // In-memory child: answers every command and announces readiness.
  const transport = {
    lines: [],
    write(line, callback) {
      const command = readCommand(line);
      const data = command.type === "get_state"
        ? { sessionId: "s1-real", sessionFile: "/nonexistent/s1-real.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(ompLine({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener(ompLine({ type: "ready" }))); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  const fakeHost = {
    id: "fake",
    label: "Fake",
    status: () => "online",
    onStatus: () => () => {},
    async spawnRpc(request) {
      requests.push(request);
      return { transport, cwd: request.cwd, fellBack: false, launchAdvisor: false };
    },
    sessionFileExists: async () => false,
    invalidateSessionLists(sessionFile) { invalidated.push(sessionFile); },
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s1", "", "/w", undefined, false, null, undefined, fakeHost);
  t.after(() => session.destroyAndWait());
  assert.deepEqual(requests, [{ cwd: "/w", recordedCwd: null, sessionFile: "", toolNames: undefined, advisor: false, spawnModel: undefined }]);
  assert.equal(session.host, fakeHost);
  invalidated.length = 0;
  emitLine(ompLine({ type: "agent_end", isTerminal: true }));
  assert.deepEqual(invalidated, ["/nonexistent/s1-real.jsonl"]);
});

test("reload keeps the live child when its host cannot check the session file", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  let stopped = false;
  const transport = {
    write(line, callback) {
      const command = readCommand(line);
      const data = command.type === "get_state"
        ? { sessionId: "s2-real", sessionFile: "/nonexistent/s2-real.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(ompLine({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener(ompLine({ type: "ready" }))); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { stopped = true; queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { stopped = true; queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  // The link is up but the host does not answer in time (a 504).
  let unanswered = false;
  const remoteHost = {
    id: "remote",
    label: "Laptop",
    status: () => "online",
    onStatus: () => () => {},
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => {
      if (unanswered) throw new Error("Laptop did not answer sessionFileExists in time");
      return false;
    },
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s2", "", "/w", undefined, false, null, undefined, remoteHost);
  t.after(() => session.destroyAndWait());
  unanswered = true;
  await assert.rejects(session.send({ type: "reload" }), /Laptop did not answer/);
  assert.equal(session.restartingProc, null, "a failed preflight clears the old-process reference");
  assert.equal(stopped, false, "the old child must not be stopped");
  assert.equal(session.isAlive(), true);
  // Still subscribed: the child's frames keep reaching the UI.
  const events = [];
  session.onEvent((event) => events.push(event.type));
  emitLine(ompLine({ type: "agent_start" }));
  assert.deepEqual(events, ["agent_start"]);
  await session.send({ type: "get_state" });
});

test("a session whose host is offline refuses sends with host_offline and reports the link state", async () => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = readCommand(line);
      const data = command.type === "get_state"
        ? { sessionId: "s-offline", sessionFile: "/nonexistent/s-offline.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(ompLine({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener(ompLine({ type: "ready" }))); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  let status = "online";
  const statusListeners = new Set();
  const remoteHost = {
    id: "laptop",
    label: "Laptop",
    status: () => status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s-offline", "", "/w", undefined, false, null, undefined, remoteHost);
  const events = [];
  session.onEvent((event) => events.push(event));
  status = "offline";
  for (const listener of statusListeners) listener("offline");
  await assert.rejects(session.send({ type: "prompt", message: "hi" }), (error) => {
    assert.equal(error.code, "host_offline");
    assert.match(error.message, /^Laptop is offline/);
    assert.equal(error.delivery, "refused", "checked before anything was sent");
    return true;
  });
  assert.equal(session.isAlive(), true, "a down link is not an exited child");
  assert.deepEqual(events.filter((event) => event.type === "host_status").map(({ hostId, status }) => ({ hostId, status })), [{ hostId: "laptop", status: "offline" }]);
  await session.destroyAndWait();
  assert.equal(statusListeners.size, 0, "a destroyed session stops listening to its host");
});

test("a running remote session is listed with its host, so the sidebar groups its placeholder there", async () => {
  const { getRunningRpcSessions, startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = readCommand(line);
      const data = command.type === "get_state" ? { sessionId: "s-remote-run", sessionFile: "/nonexistent/s-remote-run.jsonl", isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => emitLine(ompLine({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener(ompLine({ type: "ready" }))); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  const remoteHost = {
    id: "laptop",
    label: "Laptop",
    status: () => "online",
    onStatus: () => () => {},
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s-remote-run", "", "/srv/app", undefined, false, null, undefined, remoteHost);
  await session.send({ type: "prompt", message: "hi" });
  assert.deepEqual(getRunningRpcSessions().find((running) => running.id === "s-remote-run"), { id: "s-remote-run", cwd: "/srv/app", hostId: "laptop" });
  await session.destroyAndWait();
});

test("a session with an open dialog is listed as awaiting input until the dialog is answered", async (t) => {
  const { getRunningRpcSessions, startRpcSession, subscribeRunningSessions } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = readCommand(line);
      const data = command.type === "get_state" ? { sessionId: "s-awaiting", sessionFile: "/nonexistent/s-awaiting.jsonl", isStreaming: false, isCompacting: false } : {};
      if (command.id && command.type !== "ui_response") queueMicrotask(() => emitLine(ompLine({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener(ompLine({ type: "ready" }))); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    endInput() { queueMicrotask(() => this.exit?.(0, null)); },
    killTree() { queueMicrotask(() => this.exit?.(null, "SIGTERM")); },
  };
  const host = {
    id: "laptop",
    label: "Laptop",
    status: () => "online",
    onStatus: () => () => {},
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s-awaiting", "", "/srv/app", undefined, false, null, undefined, host);
  t.after(() => session.destroyAndWait());
  const awaiting = () => getRunningRpcSessions().find((running) => running.id === "s-awaiting")?.awaitingInput === true;
  const pushed = [];
  t.after(subscribeRunningSessions((update) => pushed.push(update.runningSessions.some((running) => running.id === "s-awaiting" && running.awaitingInput))));

  emitLine(ompLine({ type: "ui_request", id: 1, method: "confirm", args: ["Continue?", ""] }));
  assert.equal(awaiting(), true);
  assert.equal(pushed.at(-1), true, "the sidebar is told the session waits on the user");
  await session.send({ type: "ui_response", id: 1, value: true });
  assert.equal(awaiting(), false);
  assert.equal(pushed.at(-1), false, "answering clears the mark without waiting for another omp frame");
});

test("a reload whose host drops while the old child exits fails host_offline and spawns nothing beside it", async () => {
  const { getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = readCommand(line);
      const data = command.type === "get_state" ? { sessionId: "s-reload-drop", sessionFile: "/nonexistent/s-reload-drop.jsonl", isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => emitLine(ompLine({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener(ompLine({ type: "ready" }))); },
    onStderr() {},
    onExit(listener) { this.exit = listener; },
    // Behind a dropped link the kill only waits in the outbox: the child exits when the link returns.
    endInput() {},
    killTree() {},
  };
  let status = "online";
  const statusListeners = new Set();
  const setStatus = (next) => {
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  };
  let spawns = 0;
  const remoteHost = {
    id: "laptop",
    label: "Laptop",
    status: () => status,
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    spawnRpc: async (request) => {
      spawns += 1;
      return { transport, cwd: request.cwd, fellBack: false, launchAdvisor: false };
    },
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const { session } = await startRpcSession("s-reload-drop", "", "/w", undefined, false, null, undefined, remoteHost);
  const reloading = session.send({ type: "reload" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  setStatus("offline");
  await assert.rejects(reloading, (error) => error.code === "host_offline");
  assert.equal(session.isAlive(), true, "the wrapper outlives the outage");
  setStatus("online");
  // The old child may still run there: nothing may reach it or start beside it.
  await assert.rejects(session.send({ type: "get_state" }), (error) => error.code === "host_offline");
  assert.equal(spawns, 1);
  // Its exit arrives with the link: only now may the next request start a fresh child.
  transport.exit(0, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(session.isAlive(), false);
  assert.equal(getRpcSession("s-reload-drop"), undefined);
  assert.equal(spawns, 1);
});

/** The omp child behind a LinkDriver: answers every command on its channel. */
function ompOverLink(link, sessionId, sessionFile = `/nonexistent/${sessionId}.jsonl`) {
  return async (message) => {
    if (message.type !== "stdin") return;
    const command = readCommand(message.line);
    const data = command.type === "get_state" ? { sessionId, sessionFile, isStreaming: false, isCompacting: false, isSettled: true, queuedMessageCount: 0 } : {};
    await link.post({ type: "stdout", ch: message.ch, line: ompLine({ type: "response", id: command.id, command: command.type, success: true, data }) });
  };
}

/** Serves the shared `open` op: a fresh channel per open, already past `ready`; an `expectedChannel` rejoin keeps its channel. `opened` records each launch with its channel. */
function openOverLink(opened = []) {
  return {
    async open(args) {
      const joined = args.expectedChannel !== undefined;
      const ch = args.expectedChannel ?? `ch-${opened.length + 1}`;
      if (!joined) opened.push({ ...args.launch, ch });
      return { ch, joined, pending: [], streaming: null, cwd: args.launch.cwd, fellBack: false, launchAdvisor: false, advisorSpawned: false, autoApproveExtension: false };
    },
    editLease: () => ({}),
    sessionFileExists: () => true,
    invalidateSessionLists: () => null,
  };
}

test("a prompt whose ack is lost to a quiet link answers host_offline and keeps the child", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Lidded laptop");
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const kills = [];
  const promptSent = Promise.withResolvers();
  const answer = ompOverLink(link, "s-lid");
  const omp = async (message) => {
    if (message.type === "kill") kills.push(message);
    // The lid closes as the prompt goes down: it is never acked.
    if (message.type === "stdin" && readCommand(message.line).type === "prompt") return promptSent.resolve();
    await answer(message);
  };
  const spawns = [];
  const ops = openOverLink(spawns);
  link.serve(ops, omp);
  ({ session } = await startRpcSession("s-lid", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));

  // Real timings: the prompt ack timeout and the offline window are both 30 s,
  // so the ack times out as (or before) the host is marked offline.
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const sending = session.send({ type: "prompt", message: "hi" });
  await promptSent.promise;
  t.mock.timers.tick(30_000);
  // The frame left before the link went quiet: it may still run there.
  await assert.rejects(sending, (error) => error.code === "host_offline" && error.delivery === "unknown");
  t.mock.timers.reset();
  assert.deepEqual(kills, [], "the child is not recycled");
  assert.equal(session.isAlive(), true);

  // The lid opens: the daemon redials with the child still running.
  await link.drop();
  await link.dial({ channels: [{ ch: spawns[0].ch, sessionId: "s-lid", cwd: "/w", pending: [] }] });
  link.serve(ops, omp);
  assert.equal((await session.send({ type: "get_state" })).sessionId, "s-lid");
  assert.deepEqual(kills, [], "no kill was queued for the reconnect either");
  assert.equal(session.isAlive(), true);
});

test("an edit that times out with no uplink since dispatch answers host_offline and sends no kill", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Editing box");
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const kills = [];
  const editAsked = Promise.withResolvers();
  const answer = ompOverLink(link, "s-edit");
  const omp = async (message) => {
    if (message.type === "kill") kills.push(message);
    // The link drops right after the edit preflight: the edit command is never answered.
    if (message.type === "stdin" && readCommand(message.line).type === "edit_message") return editAsked.resolve();
    await answer(message);
  };
  link.serve(openOverLink(), omp);
  ({ session } = await startRpcSession("s-edit", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const editing = session.send({ type: "edit_message", entryId: "e1" });
  await editAsked.promise;
  // EDIT_TIMEOUT_MS: well inside the 30 s offline window, so the host still looks online.
  t.mock.timers.tick(15_000);
  await assert.rejects(editing, (error) => error.code === "host_offline");
  t.mock.timers.reset();
  assert.equal(hub.getHost(link.id).status(), "online");
  assert.deepEqual(kills, [], "the child is not recycled");
  assert.equal(session.isAlive(), true);
});

test("a prompt that times out after the host sent uplink traffic is recycled as before", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Wedged omp box");
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const kills = [];
  const promptSent = Promise.withResolvers();
  const answer = ompOverLink(link, "s-wedged");
  const omp = async (message) => {
    if (message.type === "kill") {
      kills.push(message);
      return link.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" });
    }
    // omp takes the prompt and never acks it.
    if (message.type === "stdin" && readCommand(message.line).type === "prompt") return promptSent.resolve();
    await answer(message);
  };
  link.serve(openOverLink(), omp);
  ({ session } = await startRpcSession("s-wedged", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const sending = session.send({ type: "prompt", message: "hi" });
  await promptSent.promise;
  t.mock.timers.tick(1_000);
  // A pong after dispatch: the link is alive, so omp itself is what went quiet.
  await link.post();
  t.mock.timers.tick(29_000);
  await assert.rejects(sending, (error) => error.code === "session_unresponsive");
  t.mock.timers.reset();
  assert.equal(kills.length > 0, true, "the wedged child is recycled");
  assert.equal(session.isAlive(), false);
});

/** A wrapper whose host link starts down; `linkReturns()` brings it back. */
async function wrapperBehindDownLink(sessionId, disconnectDestroyMs) {
  const { AgentSessionWrapper } = await import("./rpc-manager.ts");
  let status = "offline";
  let statusChanged;
  const host = {
    id: "lid",
    label: "Lid",
    status: () => status,
    onStatus(listener) {
      statusChanged = listener;
      return () => {};
    },
    async spawnRpc() {
      throw new Error("not used");
    },
    sessionFileExists: async () => true,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
  const proc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => ({ sessionId, sessionFile: "", isStreaming: false, isCompacting: false }),
    sendFrame() {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(proc, "/w", null, false, sessionId, disconnectDestroyMs, host);
  wrapper.start();
  return {
    wrapper,
    linkReturns() {
      status = "online";
      statusChanged("online");
    },
  };
}

test("the disconnect reaper waits while the host link is down and runs once it returns", async () => {
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const { wrapper, linkReturns } = await wrapperBehindDownLink("s-reap", 20);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(wrapper.isAlive(), true, "a down link is not an abandoned session");
  linkReturns();
  await until(() => !wrapper.isAlive(), "the reaper once the link returns");
});

test("the idle timer waits while the host link is down and runs once it returns", async (t) => {
  await import("./rpc-manager.ts");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  // Reaping off (0): only the idle timer (IDLE_DESTROY_MS, 10 minutes) can dispose it.
  const { wrapper, linkReturns } = await wrapperBehindDownLink("s-idle", 0);
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(wrapper.isAlive(), true, "a down link is not an idle session");
  linkReturns();
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(wrapper.isAlive(), false);
  t.mock.timers.reset();
});

/** An omp child that answers every command; get_state reports `sessionId`, idle. */
function scriptedTransport(sessionId) {
  const transport = {
    sent: [],
    write(line, callback) {
      const command = readCommand(line);
      transport.sent.push(command.type);
      const data = command.type === "get_state" ? { sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => transport.emit(ompLine({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) {
      transport.emit = listener;
      queueMicrotask(() => listener(ompLine({ type: "ready" })));
    },
    onStderr() {},
    onExit(listener) { transport.exit = listener; },
    endInput() { queueMicrotask(() => transport.exit?.(0, null)); },
    killTree() { queueMicrotask(() => transport.exit?.(null, "SIGTERM")); },
  };
  return transport;
}

/** A host whose link status the test sets; it spawns `transport`. */
function scriptedHost(id, transport) {
  let status = "online";
  const listeners = new Set();
  return {
    id,
    label: id,
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setStatus(next) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
    spawnRpc: async (request) => ({ transport, cwd: request.cwd, fellBack: false, launchAdvisor: false }),
    sessionFileExists: async () => false,
    invalidateSessionLists() {},
    autoApproveExtension: () => false,
  };
}

/** A running session on `host`; `events` collects the types it emits. */
async function runningRemoteSession(t, sessionId, transport, host) {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const { session } = await startRpcSession(sessionId, "", "/w", undefined, false, null, undefined, host);
  t.after(() => session.destroyAndWait());
  const events = [];
  session.onEvent((event) => events.push(event.type));
  transport.emit(ompLine({ type: "agent_start" }));
  await until(() => session.isRunning(), "the run to start");
  transport.sent.length = 0;
  return { session, events, until };
}

test("a `!` reply read just before agent_end is deferred even when both arrive in one batch", async (t) => {
  const transport = scriptedTransport("s-bash-batch");
  const autoReply = transport.write;
  let bashId;
  transport.write = (line, callback) => {
    const command = readCommand(line);
    if (command.type !== "bash") return autoReply(line, callback);
    bashId = command.id;
    callback(null);
  };
  const { session, until } = await runningRemoteSession(t, "s-bash-batch", transport, scriptedHost("batch-box", transport));
  const reply = session.send({ type: "bash", command: "date" });
  await until(() => bashId, "the bash command to go out");
  // One host-link batch: the reply, then the turn's end, applied in one go.
  transport.emit(ompLine({ type: "response", id: bashId, command: "bash", success: true, data: { output: "x", exitCode: 0, cancelled: false, truncated: false } }));
  transport.emit(ompLine({ type: "agent_end", isTerminal: true }));
  assert.equal((await reply).deferred, true);
});

test("a run that ended while the host link was down ends for clients once it returns", async (t) => {
  const transport = scriptedTransport("s-gap");
  const host = scriptedHost("gap-box", transport);
  const { session, events, until } = await runningRemoteSession(t, "s-gap", transport, host);
  // omp's agent_end is lost with the link.
  host.setStatus("offline");
  host.setStatus("online");
  await until(() => events.includes("agent_end"), "the synthesized agent_end");
  assert.ok(transport.sent.includes("get_state"), "the reconnect reconciles with get_state");
  assert.equal(session.isRunning(), false);
});

test("a resync from the host reconciles the session", async (t) => {
  const transport = scriptedTransport("s-resync");
  let resync;
  // Duck-typed like RemoteRpcTransport: no class identity across bundles.
  transport.onResync = (listener) => { resync = listener; };
  const host = scriptedHost("resync-box", transport);
  const { session, events, until } = await runningRemoteSession(t, "s-resync", transport, host);
  assert.equal(typeof resync, "function", "the session listens for resync");
  resync();
  await until(() => events.includes("agent_end"), "the reconcile's agent_end");
  assert.ok(transport.sent.includes("get_state"));
  assert.equal(session.isRunning(), false);
});

test("restartAllRpcSessions restarts only this machine's sessions", async (t) => {
  const { restartAllRpcSessions, startRpcSession } = await import("./rpc-manager.ts");
  const localTransport = scriptedTransport("s-restart-local");
  const remoteTransport = scriptedTransport("s-restart-remote");
  const local = await startRpcSession("s-restart-local", "", "/w", undefined, false, null, undefined, scriptedHost("local", localTransport));
  const remote = await startRpcSession("s-restart-remote", "", "/w", undefined, false, null, undefined, scriptedHost("laptop", remoteTransport));
  t.after(() => remote.session.destroyAndWait());
  await restartAllRpcSessions();
  assert.equal(local.session.isAlive(), false);
  assert.equal(remote.session.isAlive(), true, "an omp update on this machine leaves a remote run alone");
});

test("disposing a session whose host goes offline mid-wait returns instead of waiting for the link", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const transport = scriptedTransport("s-bounded");
  // The kill waits in the link outbox: the child exits only once the link returns.
  transport.endInput = () => {};
  transport.killTree = () => {};
  const host = scriptedHost("bounded-box", transport);
  const { session } = await startRpcSession("s-bounded", "", "/w", undefined, false, null, undefined, host);
  t.after(() => transport.exit?.(null, "SIGTERM"));
  const disposing = session.destroyAndWait();
  host.setStatus("offline");
  let guard;
  await Promise.race([disposing, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("destroyAndWait waited for the link")), 2_000); })]);
  clearTimeout(guard);
  assert.equal(session.isAlive(), false);
});

test("a resume that failed while its host went offline blocks a retry until its child exits", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-aaaaaaaaaaaa";
  const sessionFile = `/remote/sessions/${id}.jsonl`;
  const first = scriptedTransport(id);
  // The kill waits in the link outbox: this child exits only when the test says so.
  first.endInput = () => {};
  first.killTree = () => {};
  let firstExited = false;
  const exitFirst = () => {
    if (firstExited) return;
    firstExited = true;
    first.exit(null, "SIGTERM");
  };
  const host = scriptedHost("resume-box", first);
  const answer = first.write;
  first.write = (line, callback) => {
    const command = readCommand(line);
    if (command.type !== "get_state") return answer(line, callback);
    // The link drops during the handshake and its get_state fails.
    host.setStatus("offline");
    queueMicrotask(() => first.emit(ompLine({ type: "response", id: command.id, command: "get_state", success: false, error: "link lost" })));
    callback(null);
  };
  const second = scriptedTransport(id);
  const transports = [first, second];
  let spawns = 0;
  host.spawnRpc = async (request) => ({ transport: transports[spawns++], cwd: request.cwd, fellBack: false, launchAdvisor: false });
  let retried;
  t.after(async () => {
    exitFirst();
    await retried?.session.destroyAndWait();
  });

  await assert.rejects(startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, host));
  assert.equal(spawns, 1);
  host.setStatus("online");
  const retry = startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawns, 1, "no second --resume child while the first may still write the session file");
  exitFirst();
  retried = await retry;
  assert.equal(spawns, 2);
  assert.equal(retried.session.isAlive(), true);
});

/**
 * An omp child a previous run of this server spawned: already past `ready`, so
 * it never sends one. It answers every command except `silent` ones (the test
 * answers those with `answer`); get_state reports `sessionId` plus `state`.
 * `held` lines reach the first reader at once. With `exitOnKill: false` a kill
 * waits in the link outbox: the child exits when the test calls `exit`.
 */
function adoptedTransport(sessionId, { state = {}, held = [], silent = [], exitOnKill = true } = {}) {
  const transport = {
    sent: [],
    frames: [],
    kills: 0,
    write(line, callback) {
      const command = readCommand(line);
      transport.sent.push(command.type);
      transport.frames.push(command);
      callback(null);
      // Replies to dialogs and host calls are frames, not commands: nothing answers them.
      if (JSON.parse(line).t !== "cmd" || silent.includes(command.type)) return;
      transport.answer(command);
    },
    answer(command, reply = {}) {
      const data = command.type === "get_state" ? { sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: false, isCompacting: false, ...state }
        : {};
      queueMicrotask(() => transport.emit(ompLine({ type: "response", id: command.id, command: command.type, success: true, data, ...reply })));
    },
    onLine(listener) {
      transport.emit = listener;
      for (const line of held) listener(line);
    },
    onStderr() {},
    onExit(listener) { transport.exit = listener; },
    endInput() {
      transport.kills += 1;
      if (exitOnKill) queueMicrotask(() => transport.exit?.(0, null));
    },
    killTree() {
      transport.kills += 1;
      if (exitOnKill) queueMicrotask(() => transport.exit?.(null, "SIGTERM"));
    },
  };
  return transport;
}

function adoptionHost(id, transport) {
  const host = scriptedHost(id, transport);
  host.spawnRpc = async () => {
    throw new Error("adoption must not spawn");
  };
  return host;
}

const hostToolResults = (transport) => transport.frames.filter((frame) => frame.type === "host_tool_result");
/** Frames reach the transport through RpcProcess's write queue. */
const flushWrites = () => new Promise((resolve) => setImmediate(resolve));

test("adoptRpcSession re-syncs a live child with no spawn and no ready wait", async (t) => {
  const { adoptRpcSession, getExitedRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad01";
  // A crash record from before the restart.
  globalThis.__ompExitedSessions ??= new Map();
  globalThis.__ompExitedSessions.set(id, { id, cwd: "/w", at: Date.now(), code: null, signal: "SIGTERM", detail: "" });
  const transport = adoptedTransport(id, { state: { isStreaming: true } });
  const session = await adoptRpcSession({ host: adoptionHost("adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  t.after(() => session.destroyAndWait());

  assert.deepEqual(transport.sent, ["set_subagent_subscription", "set_event_filter", "get_state", "get_subagents", "get_btw_history"]);
  assert.equal(session.isRunning(), true, "omp reported a run in progress");
  assert.equal(session.sessionFile, `/nonexistent/${id}.jsonl`);
  assert.equal(getRpcSession(id), session);
  assert.equal(getExitedRpcSession(id), undefined, "the run goes on: no crash record");
  assert.equal(transport.kills, 0);
});

test("an adopted child's open requests come back: an ask for the next tab, a host tool call for an open tab", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad02";
  const transport = adoptedTransport(id);
  const calls = [];
  const leave = subscribeHostToolCalls((call) => calls.push(call));
  t.after(leave);
  const ask = { type: "ui_request", id: 1, method: "askDialog", args: [[{ id: "q", question: "Pick", options: [{ label: "A" }] }]] };
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } };
  const session = await adoptRpcSession({
    host: adoptionHost("replay-box", transport),
    transport,
    sessionId: id,
    cwd: "/w",
    replay: [ompLine(ask), ompLine(call)],
  });
  t.after(async () => {
    await session.destroyAndWait();
  });

  // Registered with the wrapper the restart lost: routed to the open tab, not rejected.
  assert.deepEqual(calls, [{ sessionId: id, hostId: "replay-box", cwd: "/w", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } }]);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);
  const events = [];
  session.onEvent((event) => events.push(event));
  assert.deepEqual(events.map((event) => [event.type, event.id]), [["ui_request", 1]]);
  assert.equal(session.isRunning(), true, "the run waits on its user");
});

test("with no tab open at hello, host tool calls wait for the first tab to attach until a tab registers its tools", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad04";
  const transport = adoptedTransport(id);
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } };
  const session = await adoptRpcSession({ host: adoptionHost("tabless-box", transport), transport, sessionId: id, cwd: "/w", replay: [ompLine(call)] });
  t.after(() => session.destroyAndWait());
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), [], "not rejected for want of a tab");
  assert.equal(session.isRunning(), true);
  // omp calls again before any tab is back.
  transport.emit(ompLine({ type: "host_tool_call", id: "h2", toolName: "read_clipboard", arguments: {} }));
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);

  const first = [];
  session.onEvent((event) => first.push(event));
  assert.deepEqual(first.map((event) => [event.type, event.id]), [["host_tool_call", "h1"], ["host_tool_call", "h2"]]);
  const second = [];
  session.onEvent((event) => second.push(event));
  assert.deepEqual(second, [], "a call reaches one tab only");
  await session.send({ type: "host_tool_result", id: "h1", result: { content: [] } });
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => frame.id), ["h1"]);

  // The tab registers its tools: omp now knows only those.
  await session.send({ type: "set_host_tools", tools: [{ name: "open_url" }] });
  transport.emit(ompLine({ type: "host_tool_call", id: "h3", toolName: "read_clipboard", arguments: {} }));
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError]), [["h1", undefined], ["h3", true]]);
  assert.equal(first.some((event) => event.id === "h3"), false);
});

test("a replayed host tool call no tab comes back for is settled after the disconnect window", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad05";
  const transport = adoptedTransport(id);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: {} };
  const session = await adoptRpcSession({ host: adoptionHost("abandoned-box", transport), transport, sessionId: id, cwd: "/w", replay: [ompLine(call)] });
  t.after(() => session.destroyAndWait());
  t.mock.timers.tick(119_000);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);
  // DISCONNECT_DESTROY_MS.
  t.mock.timers.tick(1_000);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError, frame.result.content[0].text]), [["h1", true, "No omp-web tab reconnected to answer this host tool"]]);
});

test("replayed standalone new_session and other mutating agent tools stay unknown; list_sessions runs", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, agentEnv: {} }));
  const id = "11111111-2222-4333-8444-adadadadad06";
  const transport = adoptedTransport(id);
  const replay = [
    { type: "host_tool_call", id: "n1", toolName: "new_session", arguments: { cwd: "/w" } },
    { type: "host_tool_call", id: "s1", toolName: "send_to_session", arguments: { sessionId: "other", message: "hi" } },
    { type: "host_tool_call", id: "l1", toolName: "list_sessions", arguments: {} },
  ].map((call) => ompLine(call));
  const session = await adoptRpcSession({ host: adoptionHost("agent-tools-box", transport), transport, sessionId: id, cwd: "/w", replay });
  t.after(async () => {
    await session.destroyAndWait();
    globalThis.__ompWebSettingsCache = undefined;
    rmSync(settingsPath, { force: true });
  });
  await until(() => hostToolResults(transport).length === 3, "every replayed agent tool answered");
  const unknown = "omp-web restarted while this ran; the outcome is unknown, check with list_sessions before retrying";
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError, frame.result.content[0].text === unknown]), [
    ["n1", true, true],
    ["s1", true, true],
    ["l1", false, false],
  ]);
});

test("replayed github_comment and github_resolve_thread stay unknown and post nothing; github_read runs again", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  globalThis.__ompWebSettingsCache = undefined;
  const settingsPath = join(isolatedAgentDir, "omp-web-settings.json");
  writeFileSync(settingsPath, JSON.stringify({ agentToolsEnabled: true, githubWritesUnasked: true, agentEnv: {} }));
  const id = "11111111-2222-4333-8444-adadadadad0c";
  const transport = adoptedTransport(id);
  const replay = [
    { type: "host_tool_call", id: "c1", toolName: "github_comment", arguments: { target: "acme/widgets#7", body: "hi" } },
    { type: "host_tool_call", id: "t1", toolName: "github_resolve_thread", arguments: { threadId: "PRRT_abc" } },
    // An invalid target fails validation: the read ran, and no gh process was needed to prove it.
    { type: "host_tool_call", id: "r1", toolName: "github_read", arguments: { target: "not a target" } },
  ].map((call) => ompLine(call));
  const session = await adoptRpcSession({ host: adoptionHost("github-tools-box", transport), transport, sessionId: id, cwd: "/w", replay });
  t.after(async () => {
    await session.destroyAndWait();
    globalThis.__ompWebSettingsCache = undefined;
    rmSync(settingsPath, { force: true });
  });
  await until(() => hostToolResults(transport).length === 3, "every replayed GitHub tool answered");
  const unknown = "omp-web restarted while this ran; the outcome is unknown, check with github_read (include comments or threads) before retrying";
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError, frame.result.content[0].text === unknown]), [
    ["c1", true, true],
    ["t1", true, true],
    ["r1", true, false],
  ]);
  assert.match(hostToolResults(transport).find((frame) => frame.id === "r1").result.content[0].text, /target/);
});

test("an agent tool omp called during the adoption handshake is live, not replayed", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  // The gate is off: a live call gets the gate's answer, a replayed one "outcome unknown".
  globalThis.__ompWebSettingsCache = undefined;
  t.after(() => { globalThis.__ompWebSettingsCache = undefined; });
  const id = "11111111-2222-4333-8444-adadadadad0a";
  const live = { type: "host_tool_call", id: "live1", toolName: "new_session", arguments: { cwd: "/w" } };
  const replayed = { type: "host_tool_call", id: "r1", toolName: "new_session", arguments: { cwd: "/w" } };
  const transport = adoptedTransport(id, { held: [ompLine(live)] });
  const session = await adoptRpcSession({ host: adoptionHost("handshake-tools-box", transport), transport, sessionId: id, cwd: "/w", replay: [ompLine(replayed)] });
  t.after(() => session.destroyAndWait());
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.result.content[0].text.startsWith("omp-web restarted"), /disabled/.test(frame.result.content[0].text)]), [
    ["r1", true, false],
    ["live1", false, true],
  ]);
});

test("an internal turn waiter neither takes an adopted session's parked host calls nor settles them", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad0b";
  const transport = adoptedTransport(id);
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: {} };
  const session = await adoptRpcSession({ host: adoptionHost("waiter-box", transport), transport, sessionId: id, cwd: "/w", replay: [ompLine(call)] });
  t.after(() => session.destroyAndWait());
  // An agent tool's waited delivery watches the session; no tab does.
  const waiting = session.waitForTurnEnd(5_000);
  transport.emit(ompLine({ type: "host_tool_call", id: "h2", toolName: "open_url", arguments: {} }));
  transport.emit(ompLine({ type: "agent_end", isTerminal: true }));
  await waiting;
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), [], "the waiter leaving settles nothing");

  const tab = [];
  session.onEvent((event) => tab.push(event));
  assert.deepEqual(tab.map((event) => [event.type, event.id]), [["host_tool_call", "h1"], ["host_tool_call", "h2"]]);
});

test("a start during adoption joins it; an adopted child is not replaced over --advisor, and a second child is refused", async (t) => {
  const { adoptRpcSession, getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-adadadadad07";
  const sessionFile = `/nonexistent/${id}.jsonl`;
  const transport = adoptedTransport(id, { silent: ["get_state"] });
  const host = adoptionHost("joined-box", transport);
  const adopting = adoptRpcSession({ host, transport, sessionId: id, cwd: "/w", replay: [] });
  await until(() => transport.sent.includes("get_state"), "the adoption's get_state");
  // A tab opens the session meanwhile, with the advisor toggle on.
  const starting = startRpcSession(id, sessionFile, "/w", undefined, true, "/w", undefined, host);
  transport.answer(transport.frames.find((frame) => frame.type === "get_state"));
  const session = await adopting;
  t.after(() => session.destroyAndWait());
  assert.equal((await starting).session, session, "the start joined the adoption");

  const again = await startRpcSession(id, sessionFile, "/w", undefined, true, "/w", undefined, host);
  assert.equal(again.session, session, "an idle adopted child is kept: its --advisor flag is unknown");
  assert.equal(session.isAlive(), true);

  const stray = adoptedTransport(id);
  await assert.rejects(adoptRpcSession({ host, transport: stray, sessionId: id, cwd: "/w", replay: [] }), /already started/);
  assert.equal(stray.kills, 1, "the second child is killed");
  assert.equal(getRpcSession(id), session);
  assert.equal(session.isAlive(), true);
});

test("an adopted child that turns out to run a session another wrapper holds is killed, not registered", async (t) => {
  const { adoptRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const holderId = "11111111-2222-4333-8444-adadadadad0c";
  const listedId = "11111111-2222-4333-8444-adadadadad0d";
  const first = adoptedTransport(holderId);
  const holder = await adoptRpcSession({ host: adoptionHost("holder-box", first), transport: first, sessionId: holderId, cwd: "/w", replay: [] });
  t.after(() => holder.destroyAndWait());
  // The host listed this child under the session it last reported; omp has switched to the holder's since.
  const stale = adoptedTransport(listedId, { state: { sessionId: holderId } });
  await assert.rejects(
    adoptRpcSession({ host: adoptionHost("stale-box", stale), transport: stale, sessionId: listedId, cwd: "/w", replay: [] }),
    /already started/,
  );
  assert.ok(stale.kills > 0, "the second writer is killed");
  assert.equal(getRpcSession(holderId), holder);
  assert.equal(holder.isAlive(), true);
});

test("an adoption whose get_state times out rejects and kills the child", async (t) => {
  const { adoptRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad03";
  const transport = adoptedTransport(id, { silent: ["get_state"] });
  const asked = Promise.withResolvers();
  const write = transport.write;
  transport.write = (line, callback) => {
    write(line, callback);
    if (readCommand(line).type === "get_state") asked.resolve();
  };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const adopting = adoptRpcSession({ host: adoptionHost("wedged-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  await asked.promise;
  // A child still busy with its startup work past the 5 s status-poll budget is not wedged yet.
  let settled = false;
  adopting.then(() => (settled = true), () => (settled = true));
  t.mock.timers.tick(5_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a slow first get_state does not fail the handshake");
  t.mock.timers.tick(25_000);
  await assert.rejects(adopting, (error) => error.name === "RpcCommandTimeoutError" && error.command === "get_state");
  assert.ok(transport.kills > 0, "the child is killed");
  assert.equal(getRpcSession(id), undefined);
});

test("an adoption that failed while its host went offline blocks a start until its child exits", async (t) => {
  const { adoptRpcSession, getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  const { until } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-adadadadad08";
  const sessionFile = `/nonexistent/${id}.jsonl`;
  const transport = adoptedTransport(id, { silent: ["get_state"], exitOnKill: false });
  const host = adoptionHost("dropping-adopt-box", transport);
  let spawns = 0;
  let retried;
  t.after(async () => {
    transport.exit?.(null, "SIGTERM");
    await retried?.session.destroyAndWait();
  });
  const adopting = adoptRpcSession({ host, transport, sessionId: id, cwd: "/w", replay: [] });
  await until(() => transport.sent.includes("get_state"), "the adoption's get_state");
  host.setStatus("offline");
  transport.answer(transport.frames.find((frame) => frame.type === "get_state"), { success: false, error: "link lost" });
  await assert.rejects(adopting, /link lost/);
  assert.equal(getRpcSession(id)?.isAlive(), false, "kept registered while its child may still write the file");

  host.setStatus("online");
  host.spawnRpc = async (request) => {
    spawns += 1;
    return { transport: scriptedTransport(id), cwd: request.cwd, fellBack: false, launchAdvisor: false };
  };
  const retry = startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawns, 0, "no second child while the adopted one may still write the session file");
  transport.exit(null, "SIGTERM");
  retried = await retry;
  assert.equal(spawns, 1);
  assert.equal(retried.session.isAlive(), true);
});

test("an adoption whose output outgrows channelBufferBytes before the replay fails and kills the child", async (t) => {
  const { adoptRpcSession, getRpcSession } = await import("./rpc-manager.ts");
  const { LINK_LIMITS } = await import("./hosts/link-protocol.ts");
  const saved = LINK_LIMITS.channelBufferBytes;
  LINK_LIMITS.channelBufferBytes = 1_000;
  t.after(() => { LINK_LIMITS.channelBufferBytes = saved; });
  const id = "11111111-2222-4333-8444-adadadadad09";
  const transport = adoptedTransport(id, { held: [ompLine({ type: "message_update", text: "x".repeat(2_000) })] });
  await assert.rejects(
    adoptRpcSession({ host: adoptionHost("chatty-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] }),
    /exceeded 1000 bytes/,
  );
  assert.ok(transport.kills > 0, "the child is killed");
  assert.equal(getRpcSession(id), undefined);
});

// omp's delta message updates (set_event_filter messageUpdates "delta", lib/message-delta.ts).
const deltaFixture = (await readFile(new URL("../tests/fixtures/omp-delta-stream.ndjson", import.meta.url), "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line));
/** One recorded assistant message: thinking, text, then a read call with streamed JSON arguments. */
const replyFrames = deltaFixture.filter((frame) => frame.messageId === "msg-2");
const replyEnd = replyFrames.at(-1);
const without = (object, key) => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};
const textDelta = (messageId, contentIndex, delta) => ({ type: "message_update", messageId, message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex, delta } });

/** A wrapper through its startup handshake; `filterReply` answers set_event_filter. */
async function deltaSession(t, filterReply = (command) => ({ events: null, messageUpdates: command.messageUpdates })) {
  const commands = [];
  const frameListeners = new Set();
  const wrapper = new SnapshotWrapper({
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    sendCommand: async (command) => {
      commands.push(command);
      if (command.type === "set_event_filter") return filterReply(command);
      return command.type === "get_state" ? { sessionId: "delta-session", isStreaming: true, isCompacting: false } : {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  }, process.cwd(), null, false, "", undefined, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  await wrapper.waitUntilReady();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return {
    wrapper,
    events,
    filters: () => commands.filter((command) => command.type === "set_event_filter").map(({ events: selection, messageUpdates }) => ({ events: selection, messageUpdates })),
    emit: (frame) => { for (const listener of frameListeners) listener(structuredClone(frame)); },
  };
}

test("startup asks omp for delta message updates, and delta frames go out as they came while the snapshot is the whole message", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  assert.deepEqual(filters(), [{ events: null, messageUpdates: "delta" }]);
  const updates = replyFrames.filter((frame) => frame.type === "message_update");
  emit({ type: "agent_start" });
  for (const frame of replyFrames.slice(0, -1)) emit(frame);
  const forwarded = events.filter((event) => event.type === "message_update");
  assert.deepEqual(forwarded.map((event) => without(event, "web")), updates, "deltas reach tabs unchanged");
  const { streamingMessage } = wrapper.getStreamSnapshot();
  const committed = replyEnd.message.content.map((block) => without(block, "intent"));
  assert.deepEqual(streamingMessage.content, committed);
  assert.equal(wrapper.getStreamSnapshot().responseObserved, true, "rebuilt text counts as a response");
  emit(replyEnd);
  assert.equal(wrapper.getStreamSnapshot().streamingMessage, null);
  assert.deepEqual(filters(), [{ events: null, messageUpdates: "delta" }], "nothing to recover");
});

test("a tab that attaches mid-message gets the whole message before the next delta", async (t) => {
  const { emit, wrapper } = await deltaSession(t);
  const toolDelta = replyFrames.findIndex((frame) => frame.assistantMessageEvent?.type === "toolcall_delta");
  for (const frame of replyFrames.slice(0, toolDelta + 2)) emit(frame);
  const seen = [];
  wrapper.onEvent((event) => seen.push(event));
  assert.equal(seen.length, 1);
  const [snapshot] = seen;
  assert.equal(snapshot.type, "message_update");
  assert.equal(snapshot.messageId, "msg-2");
  assert.deepEqual(snapshot.message, wrapper.getStreamSnapshot().streamingMessage);
  assert.deepEqual(snapshot.message.content[2].arguments, { path: "note.txt", i: "Reading" }, "streamed arguments so far");
  assert.equal(snapshot.message.content[2].partialJson, '{"path": "note.txt", "i": "Reading');
  assert.equal(snapshot.web.sequence, wrapper.getStreamSnapshot().cursor.sequence);
  emit(replyFrames[toolDelta + 2]);
  assert.deepEqual(seen.slice(1).map((event) => event.assistantMessageEvent.delta), [" note file"]);
});

test("a delta with no base is held back and omp sends full updates until the message ends", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  emit(textDelta("msg-9", 0, "lost"));
  await settle(0);
  assert.deepEqual(events.filter((event) => event.type === "message_update"), [], "never forward a delta nobody can apply");
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
  emit(textDelta("msg-9", 0, "still lost"));
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"], "one switch per loss");
  const full = { type: "message_update", messageId: "msg-9", message: { role: "assistant", content: [{ type: "text", text: "lost and found" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " found", partial: {} } };
  emit(full);
  assert.equal(events.at(-1).message.content[0].text, "lost and found");
  assert.deepEqual(wrapper.getStreamSnapshot().streamingMessage.content, full.message.content);
  emit({ type: "message_end", messageId: "msg-9", message: { role: "assistant", content: [{ type: "text", text: "lost and found" }] } });
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full", "delta"], "deltas again from the next message");
});

test("frames lost on the host link drop the base: the next delta recovers through full updates", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  for (const frame of replyFrames.slice(0, 4)) emit(frame);
  const before = events.length;
  await wrapper.reconcileAfterGap();
  emit(replyFrames[4]);
  await settle(0);
  assert.equal(events.slice(before).some((event) => event.type === "message_update"), false);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
});

test("an omp that opens blocks without their shell (before 18.13.2) stays on full updates", async (t) => {
  const { filters, emit } = await deltaSession(t);
  emit({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", messageId: "msg-2", message: { role: "assistant" }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  await settle(0);
  emit({ type: "message_end", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
});

for (const [name, filterReply] of [
  ["rejects set_event_filter", () => { throw new Error("Unknown command: set_event_filter"); }],
  ["ignores messageUpdates", () => ({ events: null })],
]) {
  test(`an omp that ${name} keeps full updates, forwarded as they came`, async (t) => {
    const { events, filters, emit, wrapper } = await deltaSession(t, filterReply);
    assert.equal(wrapper.sessionId, "delta-session");
    const full = { type: "message_update", messageId: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} } };
    emit({ type: "message_start", messageId: "msg-2", message: { role: "assistant", content: [] } });
    emit(full);
    emit({ type: "message_end", messageId: "msg-2", message: full.message });
    await settle(0);
    assert.deepEqual(events.filter((event) => event.type === "message_update").map((event) => without(event, "web")), [full]);
    assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta"], "asked once, never again");
  });
}

test("an adopted child streaming mid-message recovers its message through full updates", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad10";
  // The previous server had this child on deltas; its message started before this server.
  const transport = adoptedTransport(id, { state: { isStreaming: true }, held: [ompLine(textDelta("msg-4", 0, "mid"))] });
  const answer = transport.answer;
  transport.answer = (command, reply) => answer(command, command.type === "set_event_filter" ? { data: { events: null, messageUpdates: command.messageUpdates } } : reply);
  const session = await adoptRpcSession({ host: adoptionHost("delta-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  t.after(() => session.destroyAndWait());
  const events = [];
  session.onEvent((event) => events.push(event));
  await flushWrites();
  assert.deepEqual(transport.frames.filter((frame) => frame.type === "set_event_filter").map((frame) => frame.messageUpdates), ["delta", "full"]);
  assert.equal(session.getStreamSnapshot().streamingMessage, null, "no guessed message");
  transport.emit(ompLine({ type: "message_update", messageId: "msg-4", message: { role: "assistant", content: [{ type: "text", text: "the middle" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "dle", partial: {} } }));
  assert.equal(session.getStreamSnapshot().streamingMessage.content[0].text, "the middle");
  assert.equal(events.at(-1).message.content[0].text, "the middle");
  transport.emit(ompLine({ type: "message_end", messageId: "msg-4", message: { role: "assistant", content: [{ type: "text", text: "the middle." }] } }));
  await flushWrites();
  assert.deepEqual(transport.frames.filter((frame) => frame.type === "set_event_filter").map((frame) => frame.messageUpdates), ["delta", "full", "delta"]);
});

test("a full update never becomes a delta base: a delta after it recovers through full updates", async (t) => {
  const { events, filters, emit, wrapper } = await deltaSession(t);
  // Adopted mid-message: this message only ever had full updates.
  emit({ type: "message_update", messageId: "msg-4", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "write", arguments: { path: "a.ts" } }] }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "x", partial: {} } });
  const before = events.length;
  emit({ type: "message_update", messageId: "msg-4", message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '", "content": "hi"}' } });
  await settle(0);
  assert.equal(events.length, before, "not forwarded");
  assert.deepEqual(wrapper.getStreamSnapshot().streamingMessage.content[0].arguments, { path: "a.ts" }, "the arguments are not lost");
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
  // A message whose start was seen: a full update ahead of the stream replaces its base too.
  emit({ type: "message_end", messageId: "msg-4", message: { role: "assistant", content: [] } });
  emit({ type: "message_start", messageId: "msg-5", message: { role: "assistant", content: [] } });
  emit({ type: "message_update", messageId: "msg-5", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: {} } });
  const ahead = events.length;
  emit(textDelta("msg-5", 0, " world"));
  await settle(0);
  assert.equal(events.length, ahead, "never Hello world world");
});

test("a set_event_filter that fails does not leave deltas dropped: the next lost delta asks again, and the session stays on full", async (t) => {
  let failures = 1;
  const { filters, emit } = await deltaSession(t, (command) => {
    if (command.messageUpdates === "full" && failures-- > 0) throw new Error("omp went away");
    return { events: null, messageUpdates: command.messageUpdates };
  });
  emit(textDelta("msg-9", 0, "lost"));
  await settle(0);
  emit(textDelta("msg-9", 0, "lost again"));
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full", "full"]);
  emit({ type: "message_end", messageId: "msg-9", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
  await settle(0);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full", "full"], "no switch back to deltas");
});

test("a delta for a message that already ended has no base", async (t) => {
  const { events, filters, emit } = await deltaSession(t);
  for (const frame of replyFrames) emit(frame);
  const before = events.length;
  emit(textDelta("msg-2", 1, " late"));
  await settle(0);
  assert.equal(events.length, before);
  assert.deepEqual(filters().map((filter) => filter.messageUpdates), ["delta", "full"]);
});

test("creation-identified RPC startup coalesces one real child and retains its identity after ready", async (t) => {
  const { startNewRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Durable new session");
  const spawns = [];
  const id = "11111111-2222-4333-8444-000000000731";
  const creationId = `rpc-create-${randomUUID()}`;
  const ops = {
    ...openOverLink(spawns),
    validateCwd: ({ path }) => ({ ok: true, value: { cwd: path, projectRoot: "/worker/project" } }),
    sessionFileExists: () => false,
  };
  const answer = ompOverLink(link, id);
  link.serve(ops, async (message) => {
    if (message.type === "kill") return link.post({ type: "exit", ch: message.ch, code: null, signal: message.signal ?? "SIGTERM" });
    return answer(message);
  });
  let session;
  t.after(async () => { hub.closeHostLink(link.id); await session?.destroyAndWait(); });
  const host = hub.getHost(link.id);
  const cwd = "/worker/.project_worktrees/session/creation";
  const [first, duplicate] = await Promise.all([
    startNewRpcSession(host, cwd, ["read"], false, false, creationId),
    startNewRpcSession(host, cwd, ["read"], false, false, creationId),
  ]);
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  session = first.value.session;
  assert.equal(first.value.realSessionId, id);
  assert.equal(duplicate.value.session, session);
  assert.equal(spawns.length, 1, "a stable transport channel alone must not permit two RPC wrappers");
  assert.equal(spawns[0].creationId, creationId);
  const replay = await startNewRpcSession(host, cwd, ["read"], false, false, creationId);
  assert.equal(replay.ok, true);
  assert.equal(replay.value.realSessionId, id);
  assert.equal(replay.value.session, session);
  assert.equal(spawns.length, 1, "ready must not remove creation-ID coalescing");
});

test("prepared creation cannot accept a validateCwd fallback while standalone starts keep their fallback", async (t) => {
  const { startNewRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const link = await linkHost("Strict prepared cwd");
  const spawns = [];
  const id = "11111111-2222-4333-8444-000000000732";
  const answer = ompOverLink(link, id);
  link.serve({
    ...openOverLink(spawns),
    validateCwd: () => ({ ok: true, value: { cwd: "/fallback", projectRoot: "/fallback" } }),
    sessionFileExists: () => false,
  }, async (message) => {
    if (message.type === "kill") return link.post({ type: "exit", ch: message.ch, code: null, signal: "SIGTERM" });
    return answer(message);
  });
  let session;
  t.after(async () => { hub.closeHostLink(link.id); await session?.destroyAndWait(); });
  const host = hub.getHost(link.id);
  const strict = await startNewRpcSession(host, "/deleted-prepared-cwd", undefined, false, false, `strict-${randomUUID()}`);
  assert.equal(strict.ok, false, "a creation must fail rather than run outside its isolated worktree");
  assert.equal(spawns.length, 0);
  const standalone = await startNewRpcSession(host, "/deleted-standalone-cwd");
  assert.equal(standalone.ok, true);
  session = standalone.value.session;
  assert.equal(session.cwd, "/fallback");
});
