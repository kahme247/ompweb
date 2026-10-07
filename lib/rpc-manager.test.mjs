import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const runtimeJiti = createJiti(import.meta.url);
const { AgentSessionWrapper: SnapshotWrapper, subscribeHostToolCalls } = await runtimeJiti.import("./rpc-manager.ts");

function snapshotSession(t, sendCommand = async () => ({}), Wrapper = SnapshotWrapper, sessionId = "", disconnectDestroyMs) {
  let emit;
  const sentFrames = [];
  const wrapper = new Wrapper({
    isAlive: true,
    onFrame(listener) { emit = listener; return () => {}; },
    sendCommand,
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, sessionId, ...(disconnectDestroyMs === undefined ? [] : [disconnectDestroyMs]));
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, emit: (event) => emit(event) };
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
  emit({ type: "host_tool_call", id: "routed", toolName: "open_url", arguments: { url: "https://b.test" } });
  assert.deepEqual(calls, [{ sessionId: "cross-session", id: "routed", toolName: "open_url", arguments: { url: "https://b.test" } }]);
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

// Process-boundary fakes exercise the real wrapper without invoking the user's
// installed agent. Older unrelated source-contract coverage remains below.

test("rpc-manager spawns omp via RpcProcess and has no SDK imports", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /from "\.\/omp\/rpc-process"/);
  assert.doesNotMatch(source, /@earendil-works/);
  assert.doesNotMatch(source, /@oh-my-pi/);
});

test("session startup negotiates RPC v2 when the installed OMP advertises it", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /await this\.proc\.negotiateProtocol\(ready\)/);
  assert.match(source, /await proc\.negotiateProtocol\(ready\)/);
});

test("registered host tools route to listeners; unknown ones are rejected", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // Registered host tools (set_host_tools) are forwarded to attached UI
  // listeners, which answer with host_tool_result.
  assert.match(source, /case "host_tool_call":/);
  assert.match(source, /this\.hostToolNames\.has\(toolName\)/);
  assert.match(source, /this\.pendingHostTools\.set\(id, event\)/);
  assert.match(source, /case "set_host_tools":/);
  assert.match(source, /case "host_tool_result":/);
  // Unregistered tools / no attached listener are settled with an error so
  // the agent turn cannot hang waiting for a response.
  assert.match(source, /type: "host_tool_result"/);
  assert.match(source, /isError: true/);
  // A disconnected UI rejects outstanding host tool calls.
  assert.match(source, /rejectPendingHostTools\(/);
  assert.match(source, /listeners\.length === 0/);
});

test("registered host URI schemes route to listeners; unknown schemes are rejected", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // Registered schemes (set_host_uri_schemes) forward host_uri_request frames
  // to attached UI listeners, which answer with host_uri_result.
  assert.match(source, /case "set_host_uri_schemes":/);
  assert.match(source, /case "host_uri_request":/);
  assert.match(source, /case "host_uri_result":/);
  assert.match(source, /this\.hostUriSchemes\.get\(scheme\)/);
  assert.match(source, /registered\.writable/);
  // Unknown schemes / no listener get an error result so read/write never hangs.
  assert.match(source, /isError: true,\s*\n\s*error: `URI scheme/);
  // A disconnected UI rejects outstanding URI requests too.
  assert.match(source, /rejectPendingHostUris\(/);
});

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

test("RPC process cleanup reaps Windows child trees as well as POSIX groups", async () => {
  const source = await readFile(new URL("./omp/rpc-process.ts", import.meta.url), "utf8");
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /taskkill/);
  assert.match(source, /process\.kill\(-pid/);
});

test("workspace launch config appends safe OMP arguments", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /launchConfig\?\.profile/);
  assert.match(source, /launchConfig\?\.extraArgs/);
});

test("existing sessions resume deterministically via --resume <file>", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const spawnArgs = source.slice(
    source.indexOf("export function buildSessionSpawnArgs"),
    source.indexOf("function toImageContents"),
  );

  assert.match(spawnArgs, /"--resume", sessionFile/);
  assert.match(spawnArgs, /"--no-tools"/);
  assert.match(spawnArgs, /"--tools"/);
  assert.match(spawnArgs, /advisor.*args\.push\("--advisor"\)/);
  assert.match(spawnArgs, /"--advisor"/);
});

test("pi tool preset names translate to omp builtin names", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // omp renamed find->glob and dropped ls (tools/builtin-names.ts).
  assert.match(source, /find: "glob"/);
  assert.match(source, /DROPPED_TOOL_NAMES = new Set\(\["ls"\]\)/);
});

test("commands with no omp equivalent fail with a clear unsupported error", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const unsupported = source.slice(
    source.indexOf("const UNSUPPORTED_COMMANDS"),
    source.indexOf("const TOOL_NAME_ALIASES"),
  );

  for (const command of ["navigate_tree", "clear_queue", "get_tools", "set_tools"]) {
    assert.match(unsupported, new RegExp(`${command}:`));
  }
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

test("agent startup broadcasts a session-list refresh without waiting for a reply", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const agentStart = source.slice(source.indexOf('case "agent_start":'), source.indexOf('case "agent_end":'));

  // agent_start invalidates through the wrapper method (which falls back to
  // the full flush when no session file is known yet) and always refreshes
  // the sidebar.
  assert.match(agentStart, /invalidateSessionLists\(\)/);
  assert.match(agentStart, /refreshSessionList = true/);
  assert.match(source, /private invalidateSessionLists\(\)/);
  assert.match(source, /invalidateSessionListCache\(\)/);
  assert.match(source, /notifyRunningChange\(\{ refreshSessionList \}\)/);
  assert.match(source, /snapshot === lastRunningSnapshot && !refreshSessionList/);
});

test("live MCP status uses only OMP's local /mcp list command", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("async getMcpList()"), source.indexOf("private buildWebState"));

  assert.match(method, /message: "\/mcp list"/);
  assert.match(method, /mcp_list_timeout/);
  assert.match(source, /case "command_output":/);
  assert.match(source, /Wait for the current run to finish/);
});

test("`!!` shell commands are rejected instead of silently entering context", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const bashCase = source.slice(source.indexOf('case "bash": {'), source.indexOf("default: {"));

  // omp's RPC bash is `{type:"bash", command}` only — there is no exclusion
  // option, so honoring `!!` is impossible and must fail loudly.
  assert.match(bashCase, /command\.excludeFromContext === true/);
  assert.match(bashCase, /WebRpcError\(BASH_EXCLUDE_MESSAGE, "bash_exclude_unsupported"\)/);
  assert.doesNotMatch(bashCase, /excludeFromContext: /);
});

test("auto-compaction results carry the same estimatedTokensAfter as manual compact", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const autoCase = source.slice(
    source.indexOf('case "auto_compaction_end":'),
    source.indexOf('case "session_info_update":'),
  );

  assert.match(autoCase, /patchEstimatedTokensAfter\(event\.result\)/);
  // Both paths must go through the one estimator, not duplicate the formula.
  assert.equal(source.match(/estimatedTokensAfter = Math\.round/g)?.length, 1);
});


test("resolveSpawnCwd uses the recorded directory when it exists, falls back otherwise", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { resolveSpawnCwd, resolveSpawnCwdResult } = jiti("./rpc-manager.ts");
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
});

test("missing terminal agent_end clears isPromptRunning on raw idle get_state", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");

  let forwarded = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async () => { forwarded = true; return {}; },
    sendFrame: () => {},
    dispose: async () => {},
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "abort_and_prompt", message: "Hi", images: [{ type: "text", text: "nope" }] }),
    /Each attachment must be an image/,
  );
  assert.equal(forwarded, false, "an invalid attachment must never reach omp");
  await wrapper.destroyAndWait();
});

test("get_state timeout recycles an idle wrapper and produces session_unresponsive WebRpcError", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper, WebRpcError } = jiti("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = jiti("./omp/rpc-process.ts");

  let disposed = false;
  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendCommand: async (command, timeoutMs) => {
      if (command.type === "get_state") {
        throw new RpcCommandTimeoutError("get_state", timeoutMs);
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => { disposed = true; },
  };

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
  wrapper.start();

  await assert.rejects(
    wrapper.send({ type: "get_state" }),
    (err) => {
      assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
      assert.equal(err.code, "session_unresponsive");
      return true;
    },
  );

  assert.equal(disposed, true);
  assert.equal(wrapper.isAlive(), false);
});

test("get_state timeout keeps a running child that is still emitting frames", async (t) => {
  const { WebRpcError } = await runtimeJiti.import("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = await runtimeJiti.import("./omp/rpc-process.ts");
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let disposed = false;
  const { wrapper, emit } = snapshotSession(t, async (command, timeoutMs) => {
    if (command.type === "get_state") throw new RpcCommandTimeoutError("get_state", timeoutMs);
    return {};
  });
  wrapper.proc.dispose = async () => { disposed = true; };
  emit({ type: "agent_start" });
  assert.equal(wrapper.isRunning(), true);

  // The reply was late but the run kept streaming: report busy, never recycle.
  t.mock.timers.tick(30_000);
  emit({ type: "message_update", message: { role: "assistant", content: [] } });
  t.mock.timers.tick(30_000);
  await assert.rejects(wrapper.send({ type: "get_state" }), (err) => {
    assert.ok(err instanceof WebRpcError || err.name === "WebRpcError");
    assert.equal(err.code, "session_state_timeout");
    return true;
  });
  assert.equal(disposed, false);
  assert.equal(wrapper.isAlive(), true);

  // A running child silent for the whole window is wedged after all.
  t.mock.timers.tick(61_000);
  await assert.rejects(wrapper.send({ type: "get_state" }), { code: "session_unresponsive" });
  assert.equal(disposed, true);
  assert.equal(wrapper.isAlive(), false);
});

test("prompt ack timeout recycles a child that accepts the frame but withholds its response", async (t) => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper, WebRpcError } = jiti("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = jiti("./omp/rpc-process.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { getRunningRpcSessions, getRunningRpcSessionIds } = jiti("./rpc-manager.ts");

  assert.equal(typeof getRunningRpcSessions, "function");
  assert.equal(typeof getRunningRpcSessionIds, "function");
  const running = getRunningRpcSessions();
  const runningIds = getRunningRpcSessionIds();
  assert.ok(Array.isArray(running));
  assert.ok(Array.isArray(runningIds));
  assert.deepEqual(runningIds, running.map((r) => r.id));
});

test("unexpected child exit is retained until a replacement session clears it", async (t) => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const {
    AgentSessionWrapper,
    clearExitedRpcSession,
    getExitedRpcSession,
  } = jiti("./rpc-manager.ts");
  globalThis.__ompExitedSessions = new Map();
  t.after(() => { delete globalThis.__ompExitedSessions; });

  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper, getExitedRpcSession } = jiti("./rpc-manager.ts");
  globalThis.__ompExitedSessions = new Map();
  t.after(() => { delete globalThis.__ompExitedSessions; });

  const fakeProc = {
    isAlive: true,
    onFrame: () => () => {},
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd(), null, false, "resume-before-ready");
  wrapper.start();
  wrapper.handleProcessExit({ code: 1, signal: null, stderrTail: "startup failed" });

  assert.equal(getExitedRpcSession("resume-before-ready").detail, "startup failed");
  await wrapper.destroyAndWait();
});

test("buildSessionSpawnArgs maps tool presets to spawn flags", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { buildSessionSpawnArgs } = jiti("./rpc-manager.ts");

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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { buildSessionSpawnArgs } = jiti("./rpc-manager.ts");

  assert.deepEqual(
    buildSessionSpawnArgs("", undefined, false, { profile: "work", advisor: true, extraArgs: ["--verbose"] }),
    ["--advisor", "--profile", "work", "--verbose"],
  );
  // Explicit per-call advisor wins; reserved/smuggled args never reach the child.
  assert.deepEqual(
    buildSessionSpawnArgs("", undefined, true, { advisor: false, extraArgs: ["--cwd=/evil", "--resume", "--verbose"] }),
    ["--advisor", "--verbose"],
  );
  // Dash-leading profiles are dropped instead of becoming flag slots.
  assert.deepEqual(buildSessionSpawnArgs("", undefined, false, { profile: "--evil" }), []);
});


test("reload restart respawns with the wrapper's advisor flag", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // restart() must re-apply --advisor: without it the replacement child loses
  // the flag while advisorSpawned stays true, silently disabling advisor.
  assert.match(source, /buildSessionSpawnArgs\(resumable \? sessionFile : "", undefined, this\.advisorSpawned, launchConfigForCwd\(this\.cwd\)\)/);
});

test("replace gate compares the union of toggle and workspace advisor", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // A workspace-forced child compared against the raw toggle would
  // destroy+respawn on every toggle-off prompt.
  assert.match(source, /const effectiveAdvisor = advisor === true \|\| launchConfig\?\.advisor === true;/);
  assert.match(source, /existing\.advisorSpawned === effectiveAdvisor/);
});

test("fresh spawns force a new session when omp resumes the cwd's latest session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // startRpcSession: a bare spawn (no --resume) must never let omp's startup
  // resume handling land in an existing conversation — the first prompt would
  // silently enter an old .jsonl. An on-disk session file is the resume signal;
  // a fresh child reports a path it has not created yet.
  assert.match(
    source,
    /if \(!sessionFile && created\.sessionFile && existsSync\(created\.sessionFile\)\) \{\s*\n\s*await created\.send\(\{ type: "new_session" \}\);/,
  );
  // restart(): a sessionless wrapper restarts bare and needs the same guard.
  assert.match(
    source,
    /if \(!resumable && this\._sessionFile && existsSync\(this\._sessionFile\)\) \{\s*\n\s*await proc\.sendCommand\(\{ type: "new_session" \}\);/,
  );
});

test("mcp list ack timeout recycles a child that accepts the frame but withholds its response", async (t) => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper, WebRpcError } = jiti("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = jiti("./omp/rpc-process.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");
  const { RpcCommandTimeoutError } = jiti("./omp/rpc-process.ts");

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

  const wrapper = new AgentSessionWrapper(fakeProc, process.cwd());
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
  emit({ type: "response", command: "prompt", success: false, error: "provider failed" });
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
  const replacementCommands = [];
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
        const command = JSON.parse(line);
        replacementCommands.push(command);
        // Answer set_ask_dialog like an omp that predates it.
        child.stdout.write(JSON.stringify(command.type === "set_ask_dialog"
          ? { type: "response", id: command.id, command: command.type, success: false, error: "Unknown command: set_ask_dialog" }
          : {
              type: "response", id: command.id, command: command.type, success: true,
              data: command.type === "get_state"
                ? { sessionId: "restart-session", isStreaming: false, isCompacting: false }
                : {},
            }) + "\n");
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'));
    return child;
  };
  // Builtins bypass jiti virtual modules; synchronize Node's ESM bindings.
  const spawnMock = t.mock.method(childProcess, "spawn", spawnReplacement);
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
  const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { AgentSessionWrapper: ReloadWrapper } = await isolated.import("./rpc-manager.ts");
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
  const askOptIn = replacementCommands.find((command) => command.type === "set_ask_dialog");
  assert.equal(askOptIn?.enabled, true, "the replacement child is re-opted into the ask dialog; a rejection does not fail the restart");
  const after = wrapper.getStreamSnapshot();
  assert.notEqual(after.cursor.streamId, before.cursor.streamId);
  assert.equal(after.cursor.sequence, 0);
  assert.equal(after.streamingMessage, null);
  assert.deepEqual(after.toolEvents, []);
  assert.equal(after.responseObserved, false);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  transport.stdout.write('{"type":"agent_start"}\n');
  assert.equal(events[0].web.streamId, after.cursor.streamId);
  assert.ok(events[0].web.sequence > after.cursor.sequence);
  await wrapper.destroyAndWait();
});

test("dialog replay keeps sequence ordering and disconnect still settles owned host requests", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  const firstEvents = [];
  const detachFirst = wrapper.onEvent((event) => firstEvents.push(event));
  await wrapper.send({ type: "set_host_tools", tools: [{ name: "browser" }] });
  emit({ type: "extension_ui_request", id: "dialog", method: "input", title: "Value" });
  emit({ type: "host_tool_call", id: "host", toolName: "browser" });
  const beforeReplay = wrapper.getStreamSnapshot().cursor.sequence;
  const replay = [];
  const detachSecond = wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0].id, "dialog");
  assert.ok(replay[0].web.sequence > beforeReplay);
  assert.equal(replay.some((event) => event.type === "host_tool_call"), false, "host work retains its existing owner");
  detachFirst();
  assert.deepEqual(sentFrames, []);
  detachSecond();
  assert.equal(sentFrames[0].type, "host_tool_result");
  assert.equal(sentFrames[0].id, "host");
  assert.equal(sentFrames[0].isError, true);
  emit({ type: "extension_ui_request", method: "cancel", targetId: "dialog" });
  const afterCancel = [];
  wrapper.onEvent((event) => afterCancel.push(event));
  assert.deepEqual(afterCancel, []);
});

test("expired dialogs are not replayed by a later stream subscription", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, emit } = snapshotSession(t);
  emit({ type: "extension_ui_request", id: "expired", method: "input", title: "Value", timeout: 100 });
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

test("startup opts into the ask dialog and still starts when omp rejects the command", async (t) => {
  const commands = [];
  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
    onFrame: () => () => {},
    sendCommand: async (command) => {
      commands.push(command);
      if (command.type === "set_ask_dialog") throw new Error("Unknown command: set_ask_dialog");
      return command.type === "get_state"
        ? { sessionId: "ask-session", isStreaming: false, isCompacting: false }
        : {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd());
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  await wrapper.waitUntilReady();
  assert.deepEqual(commands.find((command) => command.type === "set_ask_dialog"), { type: "set_ask_dialog", enabled: true });
  assert.equal(wrapper.sessionId, "ask-session");
});

test("ask dialogs stay pending until a well-formed answers payload is forwarded", async (t) => {
  const { wrapper, emit, sentFrames } = snapshotSession(t);
  emit({
    type: "extension_ui_request", id: "ask", method: "ask",
    questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }],
  });
  for (const answers of [
    "A",
    [null],
    [{ id: 1, selectedOptions: [] }],
    [{ id: "q", selectedOptions: "A" }],
    [{ id: "q", selectedOptions: [1] }],
    [{ id: "q", selectedOptions: [], customInput: 5 }],
  ]) {
    await assert.rejects(
      wrapper.send({ type: "extension_ui_response", id: "ask", answers }),
      { name: "WebRpcError", code: "invalid_ask_answers" },
      JSON.stringify(answers),
    );
  }
  await assert.rejects(
    wrapper.send({ type: "extension_ui_response", id: "ask", value: "A" }),
    { name: "WebRpcError", code: "invalid_ask_answers" },
    "a select-style value cannot answer a pending ask",
  );
  assert.deepEqual(sentFrames, [], "malformed answers never reach omp");
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.equal(replay[0]?.method, "ask", "a rejected answer leaves the dialog pending for reconnects");

  const answers = [{ id: "q", selectedOptions: ["A"], customInput: "more" }];
  await wrapper.send({ type: "extension_ui_response", id: "ask", answers });
  assert.deepEqual(sentFrames, [{ type: "extension_ui_response", id: "ask", answers }]);
  const afterAnswer = [];
  wrapper.onEvent((event) => afterAnswer.push(event));
  assert.deepEqual(afterAnswer, []);

  emit({ type: "extension_ui_request", id: "ask2", method: "ask", questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }] });
  await wrapper.send({ type: "extension_ui_response", id: "ask2", cancelled: true });
  assert.deepEqual(sentFrames.at(-1), { type: "extension_ui_response", id: "ask2", cancelled: true });
});

test("answering a dialog in one tab dismisses it in every other attached tab", async (t) => {
  const { wrapper, emit } = snapshotSession(t);
  const other = [];
  wrapper.onEvent((event) => other.push(event));
  emit({ type: "extension_ui_request", id: "ask", method: "confirm", title: "Keep going?" });
  other.length = 0;
  await wrapper.send({ type: "extension_ui_response", id: "ask", confirmed: true });
  assert.deepEqual(other.map(({ type, method, targetId }) => ({ type, method, targetId })), [
    { type: "extension_ui_request", method: "cancel", targetId: "ask" },
  ]);
  other.length = 0;
  await wrapper.send({ type: "extension_ui_response", id: "ask", confirmed: true });
  assert.deepEqual(other, [], "an already-settled dialog emits nothing");
});

// ----------------------------------------------------------------------------
// Disconnect reaper (DISCONNECT_DESTROY_MS)
//
// These drive the real wrapper through the real timer. The window is injected
// through the constructor's test seam (the 120s default would make every
// assertion here vacuous), and the fake process records dispose() so "the child
// was torn down" is observed directly instead of inferred from isAlive() alone.
// ----------------------------------------------------------------------------

const REAP_MS = 25;
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough that a correct implementation reaps, short enough to stay fast. */
const afterWindow = () => settle(REAP_MS * 8);

function reapedSession(t, sendCommand, windowMs = REAP_MS) {
  const disposed = [];
  const { wrapper, emit } = snapshotSession(t, sendCommand ?? (async () => ({})), SnapshotWrapper, "", windowMs);
  // The fake process is a plain object, so record dispose() instead.
  const proc = wrapper.proc;
  const inner = proc.dispose.bind(proc);
  proc.dispose = async () => { disposed.push(Date.now()); return inner(); };
  return { wrapper, emit, disposed };
}

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
  const { wrapper, disposed } = reapedSession(t);
  const keepAlive = setInterval(() => { void wrapper.send({ type: "get_state" }); }, Math.floor(REAP_MS / 4));
  t.after(() => clearInterval(keepAlive));
  await settle(REAP_MS * 5);
  assert.deepEqual(disposed, [], "traffic keeps pushing the deadline out");
  assert.equal(wrapper.isAlive(), true);

  clearInterval(keepAlive);
  await afterWindow();
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
  const wrapper = new SnapshotWrapper(proc, process.cwd(), null, false, "", REAP_MS);
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
  // timer is what lets `next dev` and a test runner exit. A ref'd one pins a
  // process that has nothing else pending for the full window.
  const moduleUrl = new URL("./rpc-manager.ts", import.meta.url).href;
  const script = `
    import { createJiti } from "jiti";
    const { AgentSessionWrapper } = await createJiti(import.meta.url).import(${JSON.stringify(moduleUrl)});
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
test("skill diagnostics cross the wrapper only as parsed public DTOs", async (t) => {
  const privateSnapshot = {
    cwd: "/workspace",
    showStartupDiagnostics: true,
    diagnostics: [{
      name: "review",
      reason: "source-order",
      skills: [{
        name: "review",
        filePath: "/workspace/.agents/skills/review/SKILL.md",
        source: "project",
        pluginName: "tools",
        body: "private prompt",
        _source: { kind: "internal" },
      }],
      duplicates: [{
        skill: {
          name: "review",
          filePath: "/home/me/.agents/skills/review/SKILL.md",
          source: "user",
          frontmatter: { version: 2 },
        },
        retained: {
          name: "review",
          filePath: "/workspace/.agents/skills/review/SKILL.md",
          source: "project",
          containRoot: "/workspace",
        },
      }],
      internal: "hidden",
    }],
    privateField: true,
  };
  const publicSnapshot = {
    cwd: "/workspace",
    showStartupDiagnostics: true,
    diagnostics: [{
      name: "review",
      reason: "source-order",
      skills: [{
        name: "review",
        filePath: "/workspace/.agents/skills/review/SKILL.md",
        source: "project",
        pluginName: "tools",
      }],
      duplicates: [{
        skill: {
          name: "review",
          filePath: "/home/me/.agents/skills/review/SKILL.md",
          source: "user",
        },
        retained: {
          name: "review",
          filePath: "/workspace/.agents/skills/review/SKILL.md",
          source: "project",
        },
      }],
    }],
  };
  let stateDiagnostics = privateSnapshot;
  let directDiagnostics = privateSnapshot;
  let nativeFrame;
  const forwarded = [];
  const fakeProc = {
    isAlive: true,
    onFrame(listener) {
      nativeFrame = listener;
      return () => {};
    },
    async sendCommand(command) {
      forwarded.push(command);
      if (command.type === "get_state") {
        return {
          sessionId: "diagnostics-session",
          isStreaming: false,
          isCompacting: false,
          skillDiagnostics: stateDiagnostics,
        };
      }
      if (command.type === "get_skill_diagnostics") return directDiagnostics;
      if (command.type === "set_skill_startup_diagnostics") {
        return { ...privateSnapshot, showStartupDiagnostics: false };
      }
      return {};
    },
    sendFrame: () => {},
    dispose: async () => {},
  };
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd());
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());

  const state = await wrapper.send({ type: "get_state" });
  assert.deepEqual(state.skillDiagnostics, publicSnapshot);
  assert.deepEqual(await wrapper.send({ type: "get_skill_diagnostics" }), publicSnapshot);
  assert.deepEqual(
    await wrapper.send({ type: "set_skill_startup_diagnostics", enabled: true }),
    { ...publicSnapshot, showStartupDiagnostics: false },
    "setter replies are stripped to the public DTO",
  );

  const events = [];
  wrapper.onEvent((event) => events.push(event));
  nativeFrame({ type: "skill_diagnostics_update", data: privateSnapshot });
  const event = { ...events.at(-1) };
  delete event.web;
  assert.deepEqual(event, { type: "skill_diagnostics_update", data: publicSnapshot });

  stateDiagnostics = { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "clean" };
  assert.equal((await wrapper.send({ type: "get_state" })).skillDiagnostics, undefined);
  directDiagnostics = { cwd: "/workspace", showStartupDiagnostics: true, diagnostics: "clean" };
  await assert.rejects(() => wrapper.send({ type: "get_skill_diagnostics" }), /skill diagnostics/i);
  await assert.rejects(
    () => wrapper.send({ type: "set_skill_startup_diagnostics", enabled: "false" }),
    /enabled must be a boolean/i,
  );
  assert.equal(
    forwarded.some((command) => command.type === "set_skill_startup_diagnostics" && command.enabled === "false"),
    false,
    "invalid control data must not reach OMP",
  );
});
