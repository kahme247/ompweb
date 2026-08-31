import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// rpc-manager.ts drives the user's `omp` binary over NDJSON (lib/omp/rpc-process)
// instead of embedding a Bun-only SDK. These are source-contract tests (the
// module cannot be imported from .mjs without a TS loader).

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

test("RPC process cleanup reaps Windows child trees as well as POSIX groups", async () => {
  const source = await readFile(new URL("./omp/rpc-process.ts", import.meta.url), "utf8");
  assert.match(source, /process\.platform === "win32"/);
  assert.match(source, /taskkill/);
  assert.match(source, /process\.kill\(-pid/);
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
  assert.match(spawnArgs, /if \(advisor\) args\.push\("--advisor"\)/);
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

test("prompt completion is driven by agent_end / prompt_result, not prompt_done", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(source, /case "prompt_result":/);
  assert.match(source, /isTerminal !== false/);
  assert.doesNotMatch(source, /"prompt_done"/);
});

test("agent startup broadcasts a session-list refresh without waiting for a reply", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const agentStart = source.slice(source.indexOf('case "agent_start":'), source.indexOf('case "agent_end":'));

  assert.match(agentStart, /invalidateSessionListCache\(\)/);
  assert.match(agentStart, /refreshSessionList = true/);
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

test("timed-out extension dialogs are not replayed on reconnect", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const onEvent = source.slice(source.indexOf("onEvent(listener: EventListener)"), source.indexOf("onDestroy(cb:"));

  assert.match(onEvent, /expiresAt !== undefined && expiresAt <= now/);
  assert.match(onEvent, /this\.forgetPendingUiRequest\(id\)/);
  // The expiry also fires on its own so a long-lived session stops holding it.
  assert.match(source, /setTimeout\(\(\) => this\.forgetPendingUiRequest\(id\), timeout\)/);
});

test("restart rejects concurrent commands and disposes a failed replacement", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("private async restart()"), source.indexOf("async send(command"));

  assert.match(restart, /if \(this\.restarting\) throw new WebRpcError\(RESTARTING_MESSAGE, "session_restarting"\)/);
  assert.match(restart, /void proc\.dispose\(\)/);
  // send() must refuse while the child is being swapped out.
  const send = source.slice(source.indexOf("async send(command"), source.indexOf('case "prompt": {'));
  assert.match(send, /if \(this\.restarting\) throw new WebRpcError\(RESTARTING_MESSAGE, "session_restarting"\)/);
});

test("restart restores the subagent event subscription before reading replacement state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const restart = source.slice(source.indexOf("private async restart()"), source.indexOf("async send(command"));
  const subscription = restart.indexOf('type: "set_subagent_subscription", level: "events"');
  const state = restart.indexOf('type: "get_state"');

  assert.ok(subscription >= 0, "restart must restore subagent subscription");
  assert.ok(state >= 0, "restart must read replacement state");
  assert.ok(subscription < state, "subscription must be restored before replacement state is read");
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

test("get_state timeout recycles wrapper and produces session_unresponsive WebRpcError", async () => {
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
        assert.equal(timeoutMs, 5000);
        throw new RpcCommandTimeoutError("get_state", 5000);
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

test("RPC and wrapper diagnostics expose read-only process identity", async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const { AgentSessionWrapper } = jiti("./rpc-manager.ts");
  const { RpcProcess } = jiti("./omp/rpc-process.ts");

  const rpc = Object.create(RpcProcess.prototype);
  Object.defineProperty(rpc, "child", { value: { pid: 4242 } });
  assert.equal(rpc.pid, 4242);
  assert.equal(Object.getOwnPropertyDescriptor(RpcProcess.prototype, "pid").set, undefined);

  const fakeProc = {
    pid: 4343,
    isAlive: true,
    onFrame: () => () => {},
    waitReady: async () => ({ type: "ready" }),
    negotiateProtocol: async () => {},
    sendCommand: async (command) => command.type === "get_state"
      ? {
          sessionId: "diagnostic-session",
          sessionName: "Diagnostic session",
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

  assert.equal(wrapper.diagnosticName, "Diagnostic session");
  assert.equal(wrapper.diagnosticPid, 4343);
  assert.equal(Object.getOwnPropertyDescriptor(AgentSessionWrapper.prototype, "diagnosticName").set, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(AgentSessionWrapper.prototype, "diagnosticPid").set, undefined);
  await wrapper.destroyAndWait();
});

test("app-update drain reports unique web wrappers and real settlement", async (t) => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url);
  const {
    beginAppUpdateDrain,
    cancelAppUpdateDrain,
    getAppUpdateDrainStatus,
  } = jiti("./rpc-manager.ts");
  const savedGlobals = {
    sessions: globalThis.__ompSessions,
    locks: globalThis.__ompStartLocks,
    promise: globalThis.__ompAppUpdateDrainPromise,
    status: globalThis.__ompAppUpdateDrainStatus,
  };
  const resetDrain = () => {
    cancelAppUpdateDrain();
    globalThis.__ompSessions = new Map();
    globalThis.__ompStartLocks = new Map();
  };

  try {
    await t.test("waits for starts, deduplicates aliases, and advances each row after its destroy", async () => {
      resetDrain();
      const startGate = Promise.withResolvers();
      const runningGate = Promise.withResolvers();
      const idleGate = Promise.withResolvers();
      globalThis.__ompStartLocks.set("starting-session", startGate.promise);

      let runningDestroyCalls = 0;
      let idleDestroyCalls = 0;
      const running = {
        sessionId: "running-session",
        diagnosticName: "Running work",
        diagnosticPid: 111,
        isRunning: () => true,
        destroyAndWait: () => {
          runningDestroyCalls += 1;
          return runningGate.promise;
        },
      };
      const idle = {
        sessionId: "idle-session",
        diagnosticName: undefined,
        diagnosticPid: 222,
        isRunning: () => false,
        destroyAndWait: () => {
          idleDestroyCalls += 1;
          return idleGate.promise;
        },
      };
      globalThis.__ompSessions.set("running-session", running);
      globalThis.__ompSessions.set("running-alias", running);
      globalThis.__ompSessions.set("idle-session", idle);

      const drain = beginAppUpdateDrain();
      assert.equal(beginAppUpdateDrain(), drain, "a duplicate drain reuses the retained promise");
      assert.deepEqual(getAppUpdateDrainStatus(), {
        state: "waiting",
        total: 0,
        stopped: 0,
        processes: [],
      });
      assert.equal(runningDestroyCalls, 0);
      assert.equal(idleDestroyCalls, 0);

      startGate.resolve({ session: running, realSessionId: "running-session" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runningDestroyCalls, 1);
      assert.equal(idleDestroyCalls, 1);
      globalThis.__ompAppUpdateDrainStatus.total = 99;
      globalThis.__ompAppUpdateDrainStatus.stopped = 99;
      assert.deepEqual(getAppUpdateDrainStatus(), {
        state: "stopping",
        total: 2,
        stopped: 0,
        processes: [
          {
            sessionId: "running-session",
            name: "Running work",
            pid: 111,
            activity: "running",
            state: "stopping",
          },
          {
            sessionId: "idle-session",
            name: undefined,
            pid: 222,
            activity: "idle",
            state: "stopping",
          },
        ],
      });

      const callerCopy = getAppUpdateDrainStatus();
      callerCopy.state = "failed";
      callerCopy.processes[0].state = "stopped";
      callerCopy.processes.push({ sessionId: "injected", activity: "idle", state: "stopped" });
      const untouched = getAppUpdateDrainStatus();
      assert.equal(untouched.state, "stopping");
      assert.equal(untouched.processes[0].state, "stopping");
      assert.equal(untouched.processes.length, 2);

      runningGate.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      const partiallyStopped = getAppUpdateDrainStatus();
      assert.equal(partiallyStopped.stopped, 1);
      assert.equal(partiallyStopped.processes[0].state, "stopped");
      assert.equal(partiallyStopped.processes[1].state, "stopping");

      idleGate.resolve();
      assert.equal(await drain, 2);
      const stopped = getAppUpdateDrainStatus();
      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.stopped, 2);
      assert.deepEqual(stopped.processes.map((process) => process.state), ["stopped", "stopped"]);

      cancelAppUpdateDrain();
      assert.equal(getAppUpdateDrainStatus(), undefined);
    });



    await t.test("empty registries complete with an empty stopped snapshot", async () => {
      resetDrain();
      assert.equal(await beginAppUpdateDrain(), 0);
      assert.deepEqual(getAppUpdateDrainStatus(), {
        state: "stopped",
        total: 0,
        stopped: 0,
        processes: [],
      });
    });

    await t.test("destroy failures wait for actual settlement before reopening the start gate", async () => {
      resetDrain();
      const settlingGate = Promise.withResolvers();
      globalThis.__ompSessions.set("broken-session", {
        sessionId: "broken-session",
        diagnosticName: "Broken work",
        diagnosticPid: 333,
        isRunning: () => true,
        destroyAndWait: async () => {
          throw new Error("destroy failed");
        },
      });
      globalThis.__ompSessions.set("settling-session", {
        sessionId: "settling-session",
        diagnosticName: "Settling work",
        diagnosticPid: 334,
        isRunning: () => false,
        destroyAndWait: () => settlingGate.promise,
      });

      let rejected = false;
      const observedDrain = beginAppUpdateDrain().catch((error) => {
        rejected = true;
        throw error;
      });
      const rejection = assert.rejects(observedDrain, /destroy failed/);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(rejected, false);
      assert.notEqual(globalThis.__ompAppUpdateDrainPromise, undefined);

      settlingGate.resolve();
      await rejection;
      assert.equal(globalThis.__ompAppUpdateDrainPromise, undefined);
      assert.deepEqual(getAppUpdateDrainStatus(), {
        state: "failed",
        total: 2,
        stopped: 1,
        processes: [{
          sessionId: "broken-session",
          name: "Broken work",
          pid: 333,
          activity: "running",
          state: "stopping",
        }, {
          sessionId: "settling-session",
          name: "Settling work",
          pid: 334,
          activity: "idle",
          state: "stopped",
        }],
      });

      cancelAppUpdateDrain();
      assert.equal(getAppUpdateDrainStatus(), undefined);
    });
  } finally {
    cancelAppUpdateDrain();
    globalThis.__ompSessions = savedGlobals.sessions;
    globalThis.__ompStartLocks = savedGlobals.locks;
    globalThis.__ompAppUpdateDrainPromise = savedGlobals.promise;
    globalThis.__ompAppUpdateDrainStatus = savedGlobals.status;
  }
});

test("app-update status stays on the authenticated route and drain discovery stays registry-only", async () => {
  const routeSource = await readFile(new URL("../app/api/app-update/route.ts", import.meta.url), "utf8");
  const managerSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const drainSource = managerSource.slice(
    managerSource.indexOf("export function beginAppUpdateDrain"),
    managerSource.indexOf("export function cancelAppUpdateDrain"),
  );

  assert.match(routeSource, /getAppUpdateDrainStatus/);
  assert.match(routeSource, /\.\.\.\(appUpdateDrain \? \{ appUpdateDrain \} : \{\}\)/);
  assert.doesNotMatch(routeSource, /process\.kill|taskkill|child_process/);
  assert.match(drainSource, /getRegistry\(\)/);
  assert.doesNotMatch(drainSource, /process\.|taskkill|child_process|execFile|spawn\(/);
});
