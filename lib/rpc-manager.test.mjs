import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { mockBuiltin } from "../tests/mock-builtin.mjs";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
let isolatedFresh = 0;

// Wrappers publish notifications, which the notification store records: never in the real agent dir.
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "omp-rpc-manager-test-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
test.after(() => {
  globalThis.__ompNotificationStore?.db.close();
  globalThis.__ompNotificationStore = undefined;
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});

const { AgentSessionWrapper: SnapshotWrapper, subscribeHostToolCalls } = await import("./rpc-manager.ts");
// Wrappers built directly need an online host; the daemon's machine host is one.
const { localHost } = await import("./hosts/local-host.ts");

function snapshotSession(t, sendCommand = async () => ({}), Wrapper = SnapshotWrapper, sessionId = "", disconnectDestroyMs) {
  const frameListeners = new Set();
  const sentFrames = [];
  const wrapper = new Wrapper({
    isAlive: true,
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    sendCommand,
    sendFrame(frame) { sentFrames.push(frame); },
    dispose: async () => {},
  }, process.cwd(), null, false, sessionId, disconnectDestroyMs, localHost);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, sentFrames, get listenerCount() { return frameListeners.size; }, emit: (event) => { for (const listener of frameListeners) listener(event); } };
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
  const source = await readFile(new URL("./omp/rpc-transport.ts", import.meta.url), "utf8");
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /taskkill/);
  assert.match(source, /process\.kill\(-pid/);
});

test("workspace launch config appends safe OMP arguments", async () => {
  const source = await readFile(new URL("./hosts/local-host.ts", import.meta.url), "utf8");
  assert.match(source, /launchConfig\?\.profile/);
  assert.match(source, /launchConfig\?\.extraArgs/);
});

test("existing sessions resume deterministically via --resume <file>", async () => {
  const source = await readFile(new URL("./hosts/local-host.ts", import.meta.url), "utf8");
  const spawnArgs = source.slice(
    source.indexOf("export function buildSessionSpawnArgs"),
    source.indexOf("export function resolveSpawnCwd"),
  );

  assert.match(spawnArgs, /"--resume", sessionFile/);
  assert.match(spawnArgs, /"--no-tools"/);
  assert.match(spawnArgs, /"--tools"/);
  assert.match(spawnArgs, /advisor.*args\.push\("--advisor"\)/);
  assert.match(spawnArgs, /"--advisor"/);
});

test("pi tool preset names translate to omp builtin names", async () => {
  const source = await readFile(new URL("./hosts/local-host.ts", import.meta.url), "utf8");

  // omp renamed find->glob and dropped ls (tools/builtin-names.ts).
  assert.match(source, /find: "glob"/);
  assert.match(source, /DROPPED_TOOL_NAMES = new Set\(\["ls"\]\)/);
});

test("commands with no omp equivalent fail with a clear unsupported error", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const unsupported = source.slice(
    source.indexOf("const UNSUPPORTED_COMMANDS"),
    source.indexOf("function toImageContents"),
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
  assert.match(source, /this\.host\.invalidateSessionLists\(this\._sessionFile \|\| undefined\)/);
  assert.match(source, /notifyRunningChange\(\{ refreshSessionList \}\)/);
  assert.match(source, /snapshot === lastRunningSnapshot && !refreshSessionList/);
});

test("live MCP status uses only OMP's local /mcp list command", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const method = source.slice(source.indexOf("async getMcpList()"), source.indexOf("private buildWebState"));

  assert.match(method, /"\/mcp list"/);
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

/** A wrapper whose omp frames the test drives, with one reachable tab collecting notifications. */
async function notifyingSession(t) {
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
  let feed;
  /** What omp's get_state answers; tests change it to simulate session moves and switches. */
  const ompState = { sessionId: "notify-session", sessionFile: "/tmp/notify-session.jsonl", isStreaming: false, isCompacting: false };
  const fakeProc = {
    isAlive: true,
    waitReady: async () => ({ type: "ready", protocolVersion: 2 }),
    negotiateProtocol: async () => {},
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
    globalThis.__ompNotificationHub = previousHub;
    globalThis.__ompExitedSessions = previousExited;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    // Windows cannot delete the directory while the store's database is open.
    globalThis.__ompNotificationStore?.db.close();
    globalThis.__ompNotificationStore = undefined;
    rmSync(dir, { recursive: true, force: true });
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
  feed({ type: "extension_ui_request", id: "q1", method: "confirm", title: "Delete the branch?", message: "" });
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

test("an asynchronous prompt failure (failed response) notifies the user", async (t) => {
  const { feed, delivered } = await notifyingSession(t);
  feed({ type: "response", id: "p1", command: "prompt", success: false, error: "No API key for provider" });
  assert.deepEqual(delivered, [["error", "No API key for provider"]]);
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
  // Explicit per-call advisor wins; reserved/smuggled args never reach the child.
  assert.deepEqual(
    buildSessionSpawnArgs("", undefined, true, { advisor: false, extraArgs: ["--cwd=/evil", "--resume", "--verbose"] }),
    ["--advisor", "--verbose"],
  );
  // Dash-leading profiles are dropped instead of becoming flag slots.
  assert.deepEqual(buildSessionSpawnArgs("", undefined, false, { profile: "--evil" }), []);
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


test("reload restart respawns with the wrapper's advisor flag", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // restart() must re-apply --advisor: without it the replacement child loses
  // the flag while advisorSpawned stays true, silently disabling advisor.
  assert.match(source, /sessionFile: resumable \? sessionFile : "",\s*\n\s*toolNames: undefined,\s*\n\s*advisor: this\.advisorSpawned,/);
});

test("replace gate compares the union of toggle and workspace advisor", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // A workspace-forced child compared against the raw toggle would
  // destroy+respawn on every toggle-off prompt.
  assert.match(source, /const effectiveAdvisor = advisor === true \|\| existing\?\.launchAdvisor === true;/);
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
    /if \(!sessionFile && created\.sessionFile && await host\.sessionFileExists\(created\.sessionFile\)\) \{\s*\n\s*await created\.send\(\{ type: "new_session" \}\);/,
  );
  // restart(): a sessionless wrapper restarts bare and needs the same guard.
  assert.match(
    source,
    /if \(!resumable && this\._sessionFile && await this\.host\.sessionFileExists\(this\._sessionFile\)\) \{\s*\n\s*await proc\.sendCommand\(\{ type: "new_session" \}\);/,
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
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
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

test("a server-owned confirm takes omp's dialog path and its answer stays on the server", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  const sent = [];
  wrapper.proc.sendFrame = (frame) => sent.push(frame);
  const events = [];
  wrapper.onEvent((event) => events.push(event));

  const answer = wrapper.confirmFromServer("Start a session on build-box in /srv/app?");
  assert.deepEqual(delivered, [["input", "Start a session on build-box in /srv/app?"]]);
  const request = events.find((event) => event.type === "extension_ui_request" && event.method === "confirm");
  assert.equal(request.title, "Start a session on build-box in /srv/app?");
  assert.equal(wrapper.isRunning(), true, "a pending dialog keeps the session waiting on the user");
  await wrapper.send({ type: "extension_ui_response", id: request.id, confirmed: true });
  assert.equal(await answer, true);
  assert.deepEqual(sent, [], "omp never sees the server's dialog answer");
  assert.ok(events.some((event) => event.method === "cancel" && event.targetId === request.id), "other tabs drop the dialog");

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

for (const method of ["ask", "confirm", "input"]) {
  test(`a pending ${method} dialog survives disconnect cleanup until answered`, async (t) => {
    const { wrapper, emit, disposed } = reapedSession(t);
    emit({ type: "extension_ui_request", id: "waiting", method, title: "Continue?", questions: [] });
    await afterWindow();
    assert.deepEqual(disposed, [], "waiting for a human is active work, not an abandoned session");
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), true);
    emit({ type: "extension_ui_request", method: "cancel", targetId: "waiting" });
    await afterWindow();
    assert.equal(disposed.length, 1, "cleanup is allowed after the pending dialog is gone");
  });
}

test("the ten-minute idle backstop also preserves a pending question", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { wrapper, emit, disposed } = reapedSession(t, undefined, 0);
  emit({ type: "extension_ui_request", id: "waiting", method: "ask", questions: [] });
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
  const wrapper = new SnapshotWrapper(fakeProc, process.cwd(), null, false, "", undefined, localHost);
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

function controlReply(requestId, result) {
  return { type: "extension_ui_request", method: "notify", message: `omp-web-edit:${JSON.stringify({ requestId, ...result })}` };
}

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
    if (command.type === "get_available_commands") {
      return { commands: [{ name: "omp-web-edit", source: "extension" }, { name: "public-command", source: "extension" }] };
    }
    if (command.type === "prompt" && command.message.startsWith("/omp-web-edit ")) {
      const request = JSON.parse(command.message.slice("/omp-web-edit ".length));
      didStart(request);
      if (onEdit) return onEdit(request, harness);
      session.emit(controlReply(request.requestId, { sessionId: state.sessionId, cancelled: false, leafId: "edit-marker" }));
      return undefined;
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

for (const cancelled of [false, true]) {
  test(`native no-data prompt acknowledgement retains the edit fence until its correlated result (cancelled=${cancelled})`, async (t) => {
    const session = await editableSession(t, () => {});
    const events = [];
    session.wrapper.onEvent((event) => events.push(event));
    let settled = false;
    const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
    void editing.then(() => { settled = true; }, () => { settled = true; });
    const request = await session.started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(session.wrapper.isEditingHistory(), true);
    await assert.rejects(session.wrapper.send({ type: "fork", entryId: "u1" }), { code: "session_busy" });
    const result = { sessionId: session.state.sessionId, cancelled, leafId: cancelled ? "original-leaf" : "delayed-marker" };
    session.emit(controlReply(request.requestId, result));
    assert.deepEqual(await editing, result);
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.wrapper.isAlive(), true);
    assert.equal(session.listenerCount, 1);
    assert.deepEqual(events.filter((event) => event.type === "session_history_changed").map((event) => event.leafId), cancelled ? [] : ["delayed-marker"]);
  });
}

test("an ownership-moved edit follows native identity aliases and emits one usable history change", async (t) => {
  const { wrapper, emit, state, commands } = await editableSession(t, (request, current) => {
    current.state.sessionId = "native-relocated-edit";
    current.state.sessionFile = join(isolatedAgentDir, "native-relocated-edit.jsonl");
    current.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "relocated-marker" }));
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
    const { wrapper } = await editableSession(t, (request, current) => {
      current.state.sessionId = "unrelated-native-session";
      current.state.sessionFile = join(isolatedAgentDir, "unrelated-native-session.jsonl");
      current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled, leafId: "unrelated-leaf" }));
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
  const session = await editableSession(t, async (request, current) => {
    for (const id of ["first-native-edit-move", "second-native-edit-move"]) {
      current.state.sessionId = id;
      current.state.sessionFile = join(isolatedAgentDir, `${id}.jsonl`);
      current.emit({ type: "notice", source: "session-persistence", level: "warning", message: "Session moved to a new file" });
      await new Promise((resolve) => setImmediate(resolve));
    }
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: true, leafId: "unchanged-leaf" }));
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
  const session = await editableSession(t, (request, current) => {
    current.state.sessionId = "unrelated-after-prior-move";
    current.state.sessionFile = join(isolatedAgentDir, "unrelated-after-prior-move.jsonl");
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "wrong-leaf" }));
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

test("an input-hook agent invocation fails Edit without clearing the actual run's fence", async (t) => {
  const session = await editableSession(t, (_request, current) => {
    current.state.isSettled = false;
    current.state.isStreaming = true;
    current.emit({ type: "agent_start" });
  });
  const events = [];
  session.wrapper.onEvent((event) => events.push(event));
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u2" }), /input hook invoked the agent/);
  assert.equal(session.wrapper.isEditingHistory(), false);
  assert.equal(session.wrapper.isRunning(), true, "the native run remains authoritative after edit rejection");
  assert.equal(events.some((event) => event.type === "session_history_changed"), false);
  assert.equal(session.listenerCount, 1);
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u1" }), { code: "session_busy" });
  session.emit({ type: "agent_end", isTerminal: true });
  session.emit({ type: "session_settled" });
  assert.equal(session.wrapper.isRunning(), false);
});

test("a hook acknowledgement before agent_start stops the child before releasing Edit", async (t) => {
  const { promise: disposal, resolve: finishDisposal } = Promise.withResolvers();
  t.after(finishDisposal);
  const session = await editableSession(t, () => ({ agentInvoked: true }));
  const { promise: disposing, resolve: didDispose } = Promise.withResolvers();
  session.wrapper.proc.dispose = () => { didDispose(); return disposal; };
  const events = [];
  session.wrapper.onEvent((event) => events.push(event));
  let settled = false;
  const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
  void editing.then(() => { settled = true; }, () => { settled = true; });
  const rejection = assert.rejects(editing, /input hook invoked the agent/);
  await disposing;
  assert.equal(settled, false, "Edit must await the actual child exit");
  assert.equal(session.wrapper.isEditingHistory(), true);
  assert.equal(session.wrapper.isAlive(), false, "the child is no longer reusable during shutdown");
  await assert.rejects(session.wrapper.send({ type: "edit_message", entryId: "u1" }), /no longer running/);
  await assert.rejects(session.wrapper.send({ type: "switch_session", sessionPath: "/other.jsonl" }), /no longer running/);
  session.emit({ type: "agent_start" });
  assert.equal(session.wrapper.isRunning(), false, "a deferred start from the disposed child is not admitted");
  assert.equal(events.some((event) => event.type === "agent_start" || event.type === "session_history_changed"), false);
  finishDisposal();
  await rejection;
  assert.equal(session.wrapper.isEditingHistory(), false);
  assert.equal(session.listenerCount, 0);
});

for (const errorAt of ["before-reply", "after-reply", "post-state"]) {
  test(`native persistence errors stay visible and defeat success through confirmation (${errorAt})`, async (t) => {
    const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed: permission denied" };
    const session = await editableSession(t, (request, current) => {
      if (errorAt === "before-reply") current.emit(notice);
      current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" }));
      if (errorAt === "after-reply") current.emit(notice);
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
  { sessionId: "edit-same-session", cancelled: false, leafId: "marker" },
  { sessionId: "edit-same-session", cancelled: true, leafId: "original-leaf" },
  { error: "navigation hook rejected after append failed" },
]) {
  test(`a persistence notice after no-data ack keeps second mutations fenced until handler completion (${JSON.stringify(result)})`, async (t) => {
    const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed while navigation was suspended" };
    const session = await editableSession(t, () => {});
    const events = [];
    session.wrapper.onEvent((event) => events.push(event));
    let settled = false;
    const editing = session.wrapper.send({ type: "edit_message", entryId: "u2" });
    void editing.then(() => { settled = true; }, () => { settled = true; });
    const rejection = assert.rejects(editing, { message: notice.message });
    const request = await session.started;
    await new Promise((resolve) => setImmediate(resolve));
    session.emit(notice);
    session.emit(controlReply("unrelated-edit", result));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "a write-error notice cannot finish a suspended navigation handler");
    assert.equal(session.wrapper.isEditingHistory(), true);
    assert.equal(session.listenerCount, 3, "both Edit listeners remain until correlated completion");
    const sentBefore = session.commands.length;
    for (const command of [
      { type: "prompt", message: "another tab after native error" },
      { type: "fork", entryId: "u1" },
      { type: "switch_session", sessionPath: "/other.jsonl" },
    ]) {
      await assert.rejects(session.wrapper.send(command), { code: "session_busy" });
    }
    assert.equal(session.commands.length, sentBefore, "the native error admits no second mutation");
    session.emit(controlReply(request.requestId, result));
    await rejection;
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.wrapper.isAlive(), true, "confirmed handler completion needs no child teardown");
    assert.equal(session.wrapper.isRunning(), false);
    assert.equal(session.listenerCount, 1, "both Edit listeners leave after correlated completion");
    assert.equal(events.filter((event) => event.type === "notice" && event.message === notice.message).length, 1);
    assert.equal(events.some((event) => event.type === "session_history_changed" || event.type === "extension_ui_request"), false);
    assert.equal(await session.wrapper.send({ type: "prompt", message: "after completed failed edit" }), null);
  });
}

for (const result of [
  { sessionId: "edit-same-session", cancelled: true, leafId: "old-leaf" },
  { error: "The edit target must be a user message" },
]) {
  test(`cancelled/failed edits do not clear snapshots or emit a history mutation (${JSON.stringify(result)})`, async (t) => {
    const session = await editableSession(t, (request, current) => current.emit(controlReply(request.requestId, result)));
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
  const session = await editableSession(t, async (request, current) => {
    await gate;
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" }));
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
  await session.wrapper.send({ type: "extension_ui_response", id: "navigation-hook-dialog", cancelled: true });
  assert.equal(session.sentFrames.at(-1).id, "navigation-hook-dialog", "navigation hooks may still receive dialog answers");
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
  assert.equal(commands.some((command) => command.type === "get_available_commands" || command.type === "prompt"), false);
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

test("native identity is checked again after navigation rather than trusting the extension's reply alone", async (t) => {
  const { wrapper } = await editableSession(t, (request, current) => {
    current.state.sessionFile = join(isolatedAgentDir, "unexpected-fork.jsonl");
    current.emit(controlReply(request.requestId, { sessionId: current.state.sessionId, cancelled: false, leafId: "marker" }));
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await assert.rejects(wrapper.send({ type: "edit_message", entryId: "u2" }), { code: "session_changed" });
  assert.deepEqual(events, []);
  assert.equal(wrapper.isRunning(), false);
});

test("a timed-out navigation disposes the old child before releasing the edit fence", async (t) => {
  const { wrapper, started } = await editableSession(t, () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const editing = wrapper.send({ type: "edit_message", entryId: "u2" });
  const rejection = assert.rejects(editing, { code: "session_unresponsive" });
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  await rejection;
  assert.equal(wrapper.isAlive(), false);
  assert.equal(wrapper.isRunning(), false);
  await assert.rejects(wrapper.send({ type: "prompt", message: "cannot race a late navigation" }), /no longer running/);
});

for (const timeoutAt of ["prompt-ack", "handler-result"]) {
  test(`a persistence notice cannot release Edit before timed-out child teardown (${timeoutAt})`, async (t) => {
    const { RpcCommandTimeoutError } = await import("./omp/rpc-process.ts");
    const notice = { type: "notice", source: "session-persistence", level: "error", message: "Native append failed before edit handler completion" };
    const { promise: disposal, resolve: finishDisposal } = Promise.withResolvers();
    t.after(finishDisposal);
    const session = await editableSession(t, (_request, current) => {
      if (timeoutAt === "handler-result") return undefined;
      current.emit(notice);
      return new Promise((_, reject) => {
        setTimeout(() => reject(new RpcCommandTimeoutError("prompt", 15_000)), 15_000);
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
    const request = await session.started;
    await new Promise((resolve) => setImmediate(resolve));
    if (timeoutAt === "handler-result") {
      session.emit(notice);
      await new Promise((resolve) => setImmediate(resolve));
    }
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
    session.emit(controlReply(request.requestId, { sessionId: session.state.sessionId, cancelled: false, leafId: "too-late-marker" }));
    session.emit({ type: "agent_start" });
    assert.equal(session.wrapper.isRunning(), false);
    assert.equal(events.some((event) => event.type === "agent_start" || event.type === "session_history_changed"), false);
    assert.equal(events.filter((event) => event.type === "notice" && event.message === notice.message).length, 1);
    finishDisposal();
    await rejection;
    assert.equal(session.wrapper.isEditingHistory(), false);
    assert.equal(session.listenerCount, 0);
  });
}

test("internal edit replies are hidden even when late, but public notices and commands still flow", async (t) => {
  const { wrapper, feed, delivered } = await notifyingSession(t);
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  feed(controlReply("not-pending", { error: "internal failure" }));
  const replay = [];
  wrapper.onEvent((event) => replay.push(event));
  assert.deepEqual(events, []);
  assert.deepEqual(replay, []);
  assert.deepEqual(delivered, []);
  feed({ type: "extension_ui_request", id: "public-notice", method: "notify", message: "Public extension notice", notifyType: "info" });
  assert.equal(events.at(-1).message, "Public extension notice");
  feed({ type: "available_commands_update", commands: [{ name: "omp-web-edit", source: "extension" }, { name: "public-command", source: "extension" }] });
  assert.deepEqual(events.at(-1).commands, [{ name: "public-command", source: "extension" }]);
  const editable = await editableSession(t);
  assert.deepEqual(await editable.wrapper.send({ type: "get_commands" }), {
    commands: [{ name: "public-command", source: "extension" }],
  });
});

test("initial spawn and reload both keep same-session editing available through the loaded bridge", async (t) => {
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  t.after(() => {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  const { writeFileSync } = await import("node:fs");
  const sessionId = "edit-spawn-and-reload";
  const sessionFile = join(isolatedAgentDir, "edit-spawn-and-reload.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: isolatedAgentDir }) + "\n");
  t.after(() => rmSync(sessionFile, { force: true }));
  const { SESSION_EDIT_EXTENSION_PATH } = await import("./hosts/local-host.ts");
  const spawns = [];
  let editCount = 0;
  const spawnReplacement = (file, args) => {
    spawns.push({ file, args });
    const extensionIndex = args.lastIndexOf("--extension");
    const bridgeLoaded = extensionIndex >= 0 && args[extensionIndex + 1] === SESSION_EDIT_EXTENSION_PATH;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { queueMicrotask(() => child.emit("exit", 0, null)); return true; },
    });
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const command = JSON.parse(line);
        let data = {};
        if (command.type === "get_state") data = { sessionId, sessionFile, isStreaming: false, isCompacting: false, queuedMessageCount: 0, isSettled: true, hasPendingAsyncWork: false };
        if (command.type === "get_available_commands") data = { commands: bridgeLoaded ? [{ name: "omp-web-edit", source: "extension" }] : [] };
        if (command.type === "prompt") {
          assert.equal(bridgeLoaded, true, "an unloaded internal command must not fall through as a model prompt");
          const { requestId } = JSON.parse(command.message.slice("/omp-web-edit ".length));
          const result = controlReply(requestId, { sessionId, cancelled: false, leafId: `spawn-marker-${++editCount}` });
          // Native extension dispatch acknowledges without data; navigation's
          // correlated notification can arrive on a later event-loop turn.
          setImmediate(() => child.stdout.write(JSON.stringify(result) + "\n"));
          data = undefined;
        }
        child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\n");
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write('{"type":"ready"}\n'));
    return child;
  };
  await mockBuiltin(t, "node:child_process", { spawn: spawnReplacement });
  const { startRpcSession } = await import(`./rpc-manager.ts?fresh=${isolatedFresh++}`);
  // The daemon's machine host spawns the (mocked) omp in this process.
  const { localHost: spawningHost } = await import(`./hosts/local-host.ts?fresh=${isolatedFresh++}`);
  const { session, realSessionId } = await startRpcSession(sessionId, sessionFile, isolatedAgentDir, undefined, undefined, undefined, undefined, spawningHost);
  t.after(() => session.destroyAndWait());
  const events = [];
  session.onEvent((event) => events.push(event));
  assert.equal(realSessionId, sessionId);
  assert.deepEqual(await session.send({ type: "edit_message", entryId: "u2" }), { sessionId, cancelled: false, leafId: "spawn-marker-1" });
  await session.send({ type: "reload" });
  assert.deepEqual(await session.send({ type: "edit_message", entryId: "u2" }), { sessionId, cancelled: false, leafId: "spawn-marker-2" });
  assert.equal(spawns.length, 2);
  assert.equal(session.sessionId, sessionId);
  assert.equal(session.sessionFile, sessionFile);
  assert.deepEqual(events.filter((event) => event.type === "session_history_changed").map((event) => event.leafId), ["spawn-marker-1", "spawn-marker-2"]);
  assert.equal(events.some((event) => event.type === "extension_ui_request"), false);
  await session.destroyAndWait();
});

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
      const command = JSON.parse(line);
      const data = command.type === "get_state"
        ? { sessionId: "s1-real", sessionFile: "/nonexistent/s1-real.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
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
  emitLine(JSON.stringify({ type: "agent_end", isTerminal: true }));
  assert.deepEqual(invalidated, ["/nonexistent/s1-real.jsonl"]);
});

test("reload keeps the live child when its host cannot check the session file", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  let stopped = false;
  const transport = {
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state"
        ? { sessionId: "s2-real", sessionFile: "/nonexistent/s2-real.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
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
  assert.equal(stopped, false, "the old child must not be stopped");
  assert.equal(session.isAlive(), true);
  // Still subscribed: the child's frames keep reaching the UI.
  const events = [];
  session.onEvent((event) => events.push(event.type));
  emitLine(JSON.stringify({ type: "agent_start" }));
  assert.deepEqual(events, ["agent_start"]);
  await session.send({ type: "get_state" });
});

test("a session whose host is offline refuses sends with host_offline and reports the link state", async () => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state"
        ? { sessionId: "s-offline", sessionFile: "/nonexistent/s-offline.jsonl", isStreaming: false, isCompacting: false }
        : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
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
      const command = JSON.parse(line);
      const data = command.type === "get_state" ? { sessionId: "s-remote-run", sessionFile: "/nonexistent/s-remote-run.jsonl", isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
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

test("a reload whose host drops while the old child exits fails host_offline and spawns nothing beside it", async () => {
  const { getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  let emitLine;
  const transport = {
    write(line, callback) {
      const command = JSON.parse(line);
      const data = command.type === "get_state" ? { sessionId: "s-reload-drop", sessionFile: "/nonexistent/s-reload-drop.jsonl", isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => emitLine(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) { emitLine = listener; queueMicrotask(() => listener('{"type":"ready"}')); },
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

test("a command written before the host link dropped resolves once the link returns", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");
  const timings = { ...hub.linkTimings };
  const link = await linkHost("Flaky box");
  let session;
  t.after(async () => {
    Object.assign(hub.linkTimings, timings);
    // Ends the link, which exits its channels, so the wrapper can finish disposing.
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });

  let ch;
  let holdNextGetState = false;
  let held = null;
  const respond = (command) => JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    data: command.type === "get_state" ? { sessionId: "s-flaky", sessionFile: "/nonexistent/s-flaky.jsonl", isStreaming: false, isCompacting: false } : {},
  });
  // The omp child behind the daemon: answers each command, except one get_state held across the drop.
  const omp = async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    if (holdNextGetState && command.type === "get_state") {
      holdNextGetState = false;
      held = command;
      return;
    }
    await link.post({ type: "stdout", ch, line: respond(command) });
  };
  const ops = {
    async spawn(args) {
      ch = args.ch;
      await link.post({ type: "stdout", ch, line: '{"type":"ready"}' });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    sessionFileExists: () => false,
    invalidateSessionLists: () => null,
  };
  link.serve(ops, omp);
  ({ session } = await startRpcSession("s-flaky", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));
  const statuses = [];
  session.onEvent((event) => {
    if (event.type === "host_status") statuses.push(event.status);
  });

  holdNextGetState = true;
  const pending = session.send({ type: "get_state" });
  await until(() => held, "the get_state to reach omp");
  // The link drops with the command applied but unanswered.
  hub.linkTimings.offlineMs = 30;
  await link.post();
  await link.drop();
  await until(() => hub.getHost(link.id).status() === "offline", "the host to go offline");
  hub.linkTimings.offlineMs = timings.offlineMs;

  await link.dial({ channels: [{ ch, sessionId: null, cwd: "/w", pending: [] }] });
  link.serve(ops, omp);
  await link.post({ type: "stdout", ch, line: respond(held) });
  const state = await pending;
  assert.equal(state.sessionId, "s-flaky");
  assert.deepEqual(statuses, ["offline", "online"]);
  assert.equal(session.isAlive(), true);
});

test("a run whose remote child vanished while the link was down resumes on that host", async (t) => {
  const { getRpcSession, startRpcSession } = await import("./rpc-manager.ts");
  const { RESUME_PROMPT } = await import("./session-resume.ts");
  const { saveWebServerSettings } = await import("./web-settings.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost, until } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-777777777777";
  const sessionFile = `/remote/sessions/${id}.jsonl`;
  const timings = { ...hub.linkTimings };
  saveWebServerSettings({ autoResumeSessions: true });
  const link = await linkHost("Rebooting box");
  t.after(async () => {
    saveWebServerSettings({ autoResumeSessions: false });
    Object.assign(hub.linkTimings, timings);
    hub.closeHostLink(link.id);
    await getRpcSession(id)?.destroyAndWait();
  });

  const spawns = [];
  const prompts = [];
  const respond = (command) => JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    data: command.type === "get_state" ? { sessionId: id, sessionFile, isStreaming: false, isCompacting: false } : {},
  });
  const omp = async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    if (command.type === "prompt") prompts.push({ ch: message.ch, message: command.message });
    await link.post({ type: "stdout", ch: message.ch, line: respond(command) });
  };
  const ops = {
    async spawn(args) {
      spawns.push(args);
      await link.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    listSessions: () => [{ path: sessionFile, id, cwd: "/w", created: "c", modified: "m", messageCount: 1, firstMessage: "hi" }],
    sessionFileExists: () => true,
    invalidateSessionLists: () => null,
  };
  link.serve(ops, omp);
  const { session } = await startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await link.post({ type: "stdout", ch: spawns[0].ch, line: '{"type":"agent_start"}' });
  await until(() => session.isRunning(), "the run to start");

  hub.linkTimings.offlineMs = 30;
  await link.post();
  await link.drop();
  await until(() => hub.getHost(link.id).status() === "offline", "the host to go offline");
  hub.linkTimings.offlineMs = timings.offlineMs;
  // The link returns without the child: it died while the host was unreachable.
  await link.dial({ channels: [] });
  link.serve(ops, omp);
  await until(() => prompts.some((prompt) => prompt.message === RESUME_PROMPT), "the resume prompt");

  assert.equal(session.isAlive(), false);
  assert.equal(spawns.length, 2);
  assert.deepEqual([spawns[1].sessionFile, spawns[1].recordedCwd], [sessionFile, "/w"]);
  assert.equal(prompts.find((prompt) => prompt.message === RESUME_PROMPT).ch, spawns[1].ch);
  assert.equal(getRpcSession(id).isAlive(), true);
});

/** The omp child behind a LinkDriver: answers every command on its channel. */
function ompOverLink(link, sessionId, sessionFile = `/nonexistent/${sessionId}.jsonl`) {
  return async (message) => {
    if (message.type !== "stdin") return;
    const command = JSON.parse(message.line);
    const data = command.type === "get_state" ? { sessionId, sessionFile, isStreaming: false, isCompacting: false, isSettled: true, queuedMessageCount: 0 } : {};
    await link.post({ type: "stdout", ch: message.ch, line: JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) });
  };
}

function spawnOverLink(link, spawns = []) {
  return {
    async spawn(args) {
      spawns.push(args);
      await link.post({ type: "stdout", ch: args.ch, line: '{"type":"ready"}' });
      return { cwd: args.cwd, fellBack: false, launchAdvisor: false, autoApproveExtension: false };
    },
    sessionFileExists: () => true,
    invalidateSessionLists: () => null,
  };
}

test("a session the host still runs an orphan child for spawns only after the orphan exits", async (t) => {
  const { startRpcSession } = await import("./rpc-manager.ts");
  const hub = await import("./hosts/hub.ts");
  const { linkHost } = await import("./hosts/link-driver.test-helper.mjs");
  const id = "11111111-2222-4333-8444-888888888888";
  const sessionFile = `/remote/sessions/${id}.jsonl`;
  // This server restarted while the host kept running the session's child (one it cannot adopt: no replay listed).
  const link = await linkHost("Survivor box", { channels: [{ ch: "orphan", sessionId: id, cwd: "/w", pending: null }] });
  let session;
  t.after(async () => {
    hub.closeHostLink(link.id);
    await session?.destroyAndWait();
  });
  const spawns = [];
  link.serve(spawnOverLink(link, spawns), ompOverLink(link, id, sessionFile));
  const starting = startRpcSession(id, sessionFile, "/w", undefined, false, "/w", undefined, hub.getHost(link.id));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawns.length, 0, "no second child while the orphan may still write the file");
  await link.post({ type: "exit", ch: "orphan", code: null, signal: "SIGTERM" });
  ({ session } = await starting);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].sessionFile, sessionFile);
});

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
    if (message.type === "stdin" && JSON.parse(message.line).type === "prompt") return promptSent.resolve();
    await answer(message);
  };
  const spawns = [];
  const ops = spawnOverLink(link, spawns);
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
  await link.dial({ channels: [{ ch: spawns[0].ch, sessionId: null, cwd: "/w", pending: [] }] });
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
  const catalogAsked = Promise.withResolvers();
  const answer = ompOverLink(link, "s-edit");
  const omp = async (message) => {
    if (message.type === "kill") kills.push(message);
    // The link drops right after the edit preflight: the catalog request is never answered.
    if (message.type === "stdin" && JSON.parse(message.line).type === "get_available_commands") return catalogAsked.resolve();
    await answer(message);
  };
  link.serve(spawnOverLink(link), omp);
  ({ session } = await startRpcSession("s-edit", "", "/w", undefined, false, null, undefined, hub.getHost(link.id)));

  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const editing = session.send({ type: "edit_message", entryId: "e1" });
  await catalogAsked.promise;
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
    if (message.type === "stdin" && JSON.parse(message.line).type === "prompt") return promptSent.resolve();
    await answer(message);
  };
  link.serve(spawnOverLink(link), omp);
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
      const command = JSON.parse(line);
      transport.sent.push(command.type);
      const data = command.type === "get_state" ? { sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: false, isCompacting: false } : {};
      queueMicrotask(() => transport.emit(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })));
      callback(null);
    },
    onLine(listener) {
      transport.emit = listener;
      queueMicrotask(() => listener('{"type":"ready"}'));
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
  transport.emit('{"type":"agent_start"}');
  await until(() => session.isRunning(), "the run to start");
  transport.sent.length = 0;
  return { session, events, until };
}

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
    const command = JSON.parse(line);
    if (command.type !== "get_state") return answer(line, callback);
    // The link drops during the handshake and its get_state fails.
    host.setStatus("offline");
    queueMicrotask(() => first.emit(JSON.stringify({ type: "response", id: command.id, command: "get_state", success: false, error: "link lost" })));
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
      const command = JSON.parse(line);
      transport.sent.push(command.type);
      transport.frames.push(command);
      callback(null);
      // Replies to dialogs and host calls are frames, not commands: nothing answers them.
      if (silent.includes(command.type) || command.type.endsWith("_result") || command.type === "extension_ui_response") return;
      transport.answer(command);
    },
    answer(command, reply = {}) {
      const data = command.type === "negotiate_protocol" ? { protocolVersion: 2 }
        : command.type === "get_state" ? { sessionId, sessionFile: `/nonexistent/${sessionId}.jsonl`, isStreaming: false, isCompacting: false, ...state }
          : {};
      queueMicrotask(() => transport.emit(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data, ...reply })));
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
  // This server restarted mid chunk sequence: the tail is dropped, not a protocol error.
  const bytes = Buffer.from(JSON.stringify({ type: "message_update", text: "x".repeat(1024 * 1024) }));
  const tail = { type: "rpc_chunk", chunkId: "lost", index: 3, count: 5, byteLength: bytes.byteLength, data: bytes.subarray(3 * 262144, 4 * 262144).toString("base64") };
  const transport = adoptedTransport(id, { state: { isStreaming: true }, held: [JSON.stringify(tail)] });
  const session = await adoptRpcSession({ host: adoptionHost("adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  t.after(() => session.destroyAndWait());

  assert.deepEqual(transport.sent, ["negotiate_protocol", "set_subagent_subscription", "set_ask_dialog", "get_state", "get_subagents", "get_btw_history"]);
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
  const ask = { type: "extension_ui_request", id: "q1", method: "ask", questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }] };
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } };
  const session = await adoptRpcSession({
    host: adoptionHost("replay-box", transport),
    transport,
    sessionId: id,
    cwd: "/w",
    replay: [JSON.stringify(ask), JSON.stringify(call)],
  });
  t.after(async () => {
    leave();
    await session.destroyAndWait();
  });

  // Registered with the wrapper the restart lost: routed to the open tab, not rejected.
  assert.deepEqual(calls, [{ sessionId: id, id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } }]);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);
  const events = [];
  session.onEvent((event) => events.push(event));
  assert.deepEqual(events.map((event) => [event.type, event.id]), [["extension_ui_request", "q1"]]);
  assert.equal(session.isRunning(), true, "the run waits on its user");
});

test("with no tab open at hello, host tool calls wait for the first tab to attach until a tab registers its tools", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  const id = "11111111-2222-4333-8444-adadadadad04";
  const transport = adoptedTransport(id);
  const call = { type: "host_tool_call", id: "h1", toolName: "open_url", arguments: { url: "https://a.test" } };
  const session = await adoptRpcSession({ host: adoptionHost("tabless-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(call)] });
  t.after(() => session.destroyAndWait());
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), [], "not rejected for want of a tab");
  assert.equal(session.isRunning(), true);
  // omp calls again before any tab is back.
  transport.emit(JSON.stringify({ type: "host_tool_call", id: "h2", toolName: "read_clipboard", arguments: {} }));
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
  transport.emit(JSON.stringify({ type: "host_tool_call", id: "h3", toolName: "read_clipboard", arguments: {} }));
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
  const session = await adoptRpcSession({ host: adoptionHost("abandoned-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(call)] });
  t.after(() => session.destroyAndWait());
  t.mock.timers.tick(119_000);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport), []);
  // DISCONNECT_DESTROY_MS.
  t.mock.timers.tick(1_000);
  await flushWrites();
  assert.deepEqual(hostToolResults(transport).map((frame) => [frame.id, frame.isError, frame.result.content[0].text]), [["h1", true, "No omp-web tab reconnected to answer this host tool"]]);
});

test("replayed server agent tools that change things are not run twice; list_sessions is", async (t) => {
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
  ].map((call) => JSON.stringify(call));
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

test("an agent tool omp called during the adoption handshake is live, not replayed", async (t) => {
  const { adoptRpcSession } = await import("./rpc-manager.ts");
  // The gate is off: a live call gets the gate's answer, a replayed one "outcome unknown".
  globalThis.__ompWebSettingsCache = undefined;
  t.after(() => { globalThis.__ompWebSettingsCache = undefined; });
  const id = "11111111-2222-4333-8444-adadadadad0a";
  const live = { type: "host_tool_call", id: "live1", toolName: "new_session", arguments: { cwd: "/w" } };
  const replayed = { type: "host_tool_call", id: "r1", toolName: "new_session", arguments: { cwd: "/w" } };
  const transport = adoptedTransport(id, { held: [JSON.stringify(live)] });
  const session = await adoptRpcSession({ host: adoptionHost("handshake-tools-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(replayed)] });
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
  const session = await adoptRpcSession({ host: adoptionHost("waiter-box", transport), transport, sessionId: id, cwd: "/w", replay: [JSON.stringify(call)] });
  t.after(() => session.destroyAndWait());
  // An agent tool's waited delivery watches the session; no tab does.
  const waiting = session.waitForTurnEnd(5_000);
  transport.emit(JSON.stringify({ type: "host_tool_call", id: "h2", toolName: "open_url", arguments: {} }));
  transport.emit(JSON.stringify({ type: "agent_end", isTerminal: true }));
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
    if (JSON.parse(line).type === "get_state") asked.resolve();
  };
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const adopting = adoptRpcSession({ host: adoptionHost("wedged-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] });
  await asked.promise;
  t.mock.timers.tick(5_000);
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
  const transport = adoptedTransport(id, { held: [JSON.stringify({ type: "message_update", text: "x".repeat(2_000) })] });
  await assert.rejects(
    adoptRpcSession({ host: adoptionHost("chatty-adopt-box", transport), transport, sessionId: id, cwd: "/w", replay: [] }),
    /exceeded 1000 bytes/,
  );
  assert.ok(transport.kills > 0, "the child is killed");
  assert.equal(getRpcSession(id), undefined);
});
