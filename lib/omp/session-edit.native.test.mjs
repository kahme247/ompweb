import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SESSION_EDIT_COMMAND, SESSION_EDIT_RESPONSE_PREFIX } from "./session-edit-extension.mjs";

const jiti = createJiti(import.meta.url);
const { editSessionHistory, SESSION_EDIT_EXTENSION_PATH } = await jiti.import("./session-edit.ts");
const { RpcProcess, RpcCommandTimeoutError } = await jiti.import("./rpc-process.ts");
const { resolveOmpBin } = await jiti.import("./omp-cli.ts");
const { buildSessionContext } = await jiti.import("../session-reader.ts");
const { loadSessionFile } = await jiti.import("./session-files.ts");

// Deliberately opt-in: the normal npm test glob discovers this file without
// launching an installed executable or inspecting the user's credentials.
const nativeOptions = {
  skip: process.env.OMP_WEB_TEST_NATIVE_EDIT !== "1" && "set OMP_WEB_TEST_NATIVE_EDIT=1 to exercise the installed OMP executable",
  timeout: 120_000,
};
const INPUT_PROBE_PREFIX = "omp-web-native-input-fixture:";
const retained = ["retained question U1", "retained answer A1"];
const throughU2 = [...retained, "edit question U2", "old answer A2"];
const entireHistory = [...throughU2, "later question U3", "later answer A3"];
const originalIds = ["u1", "a1", "u2", "a2", "u3", "a3"];

// OMP 18.12.6's supported disabledProviders setting gates implicit probes,
// built-in managers AND credential-free catalog refreshes. Keep the complete
// catalog list (packages/catalog/src/compat/provider-ids.ts), plus llama.cpp,
// rather than merely disabling the three usual localhost inference engines.
const disabledProviders = [
  "abliteration", "aiand", "aimlapi", "alibaba-coding-plan", "alibaba-token-plan", "amazon-bedrock",
  "anthropic", "apple", "azure", "baseten", "bedrock-mantle", "cerebras", "charm-hyper", "cline-pass",
  "cloudflare-ai-gateway", "cloudflare-workers-ai", "commandcode", "coralbricks", "coreweave", "cursor",
  "deepinfra", "deepseek", "devin", "factory-droid", "firepass", "fireworks", "github-copilot",
  "gitlab-duo", "gitlab-duo-agent", "gmi-cloud", "google", "google-antigravity", "google-gemini-cli",
  "google-vertex", "groq", "helmcode", "huggingface", "inception", "kilo", "kimi-code", "litellm",
  "llama.cpp", "lm-studio", "local", "meta", "minimax", "minimax-code", "minimax-code-cn", "mistral",
  "moonshot", "muse-code", "nanogpt", "novita", "nvidia", "ollama", "ollama-cloud", "openai",
  "openai-codex", "opencode-go", "opencode-zen", "openrouter", "qianfan", "qwen-portal", "sakana",
  "sambanova", "siliconflow", "siliconflow-cn", "singularityapi-dev", "singularityapi-tech", "snowflake",
  "stepfun", "synthetic", "together", "typesafe", "umans", "venice", "vercel-ai-gateway", "vllm",
  "wafer-serverless", "web", "xai", "xai-oauth", "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp", "yolo-auto", "zai", "zenmux", "zhipu-coding-plan",
];

function nativeEnvironment(root, agentDir) {
  // RpcProcess.env is an overlay, not a replacement. Replace the environment at
  // its existing spawn boundary: an ever-growing credential/endpoint denylist
  // would still leak new providers, auth brokers, proxies or config overlays.
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, directory] of [
    ["HOME", "home"], ["USERPROFILE", "home"], ["XDG_CONFIG_HOME", "config"],
    ["XDG_CACHE_HOME", "cache"], ["XDG_DATA_HOME", "data"], ["XDG_STATE_HOME", "state"],
    ["TMPDIR", "tmp"], ["TMP", "tmp"], ["TEMP", "tmp"],
  ]) {
    env[key] = join(root, directory);
    mkdirSync(env[key], { recursive: true });
  }
  return { ...env, PI_CODING_AGENT_DIR: agentDir, OMP_PROFILE: "", PI_PROFILE: "" };
}

function textOf(messages) {
  return messages.map((message) => typeof message.content === "string"
    ? message.content
    : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
}

async function within(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fixture(t, binary = process.env.OMP_WEB_OMP_BIN || resolveOmpBin()) {
  const root = mkdtempSync(join(tmpdir(), "omp-native-edit-acceptance-"));
  const agentDir = join(root, "agent");
  const processes = [];
  t.after(async () => {
    try {
      await Promise.all(processes.map((proc) => within(proc.dispose(500), 5_000, "native child disposal")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  const env = nativeEnvironment(root, agentDir);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), `disabledProviders: ${JSON.stringify(disabledProviders)}\n`);
  const provider = "omp-web-native-edit-fixture";
  const model = "offline-history-edit";
  const api = "openai-completions";
  // No provider catalog or credentials are copied from the user's agent dir.
  // The only restored model is inert even if a regression dispatches a prompt.
  writeFileSync(join(agentDir, "models.yml"), `providers:
  ${provider}:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: native-edit-fixture-inert-key
    api: ${api}
    models:
      - id: ${model}
        contextWindow: 8192
        maxTokens: 1024
`);
  const sessionId = randomUUID();
  const sessionFile = join(root, "history.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const message = (id, parentId, role, text) => ({
    type: "message", id, parentId, timestamp,
    message: role === "user"
      ? { role, content: text, timestamp: 1 }
      : {
          role, content: [{ type: "text", text }], timestamp: 1,
          api, provider, model, stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
  });
  const entries = [
    { type: "session", version: 3, id: sessionId, cwd: root, timestamp },
    ...originalIds.map((id, index) => message(id, index === 0 ? null : originalIds[index - 1], index % 2 === 0 ? "user" : "assistant", entireHistory[index])),
  ];
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  async function open(file = sessionFile, extensions = []) {
    // Retain every child immediately, including one that fails before ready.
    const frames = [];
    const proc = new RpcProcess({
      cwd: root,
      env,
      dependencies: {
        resolveOmpBin: () => binary,
        spawn(file, args, options) {
          // This still starts the real selected OMP with RpcProcess's actual
          // args, stdio and process-group policy; only inheritance is replaced.
          return spawn(file, args, { ...options, env: { ...env } });
        },
      },
      extraArgs: [
        "--resume", file, "--no-tools", "--no-rules", "--no-skills", "--no-extensions", "--no-title",
        "--extension", SESSION_EDIT_EXTENSION_PATH,
        ...extensions.flatMap((extension) => ["--extension", extension]),
      ],
      onFrame(frame) { frames.push(frame); },
    });
    processes.push(proc);
    const ready = await proc.waitReady(20_000);
    await within(proc.negotiateProtocol(ready), 5_000, "native protocol negotiation");
    return { proc, frames };
  }

  return { root, sessionId, sessionFile, open };
}

// Poison real inheritance, not just a hand-constructed options.env object.
// The listener remains active through discovery, Edit and child shutdown.
test("native fixture excludes inherited provider endpoints, credentials and config during startup discovery", nativeOptions, async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [], data: [] }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await within(new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }), 5_000, "provider recorder shutdown");
  });
  await within(new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  }), 5_000, "provider recorder startup");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const poisonRoot = mkdtempSync(join(tmpdir(), "omp-native-edit-poison-"));
  t.after(() => rmSync(poisonRoot, { recursive: true, force: true }));
  const poisonConfig = join(poisonRoot, "inherited-config.yml");
  writeFileSync(poisonConfig, "disabledProviders: []\n");
  const poisoned = {
    OLLAMA_BASE_URL: endpoint,
    OLLAMA_HOST: endpoint,
    LLAMA_CPP_BASE_URL: endpoint,
    LM_STUDIO_BASE_URL: endpoint,
    OPENAI_BASE_URL: `${endpoint}/v1`,
    OPENAI_API_KEY: "native-isolation-poison-not-a-real-key",
    ANTHROPIC_API_KEY: "native-isolation-poison-not-a-real-key",
    AWS_ACCESS_KEY_ID: "native-isolation-poison-not-a-real-key",
    AWS_SECRET_ACCESS_KEY: "native-isolation-poison-not-a-real-secret",
    OMP_AUTH_BROKER_URL: endpoint,
    PI_CONFIG_FILES: poisonConfig,
    PI_CODING_AGENT_DIR: join(poisonRoot, "agent"),
    OMP_PROFILE: "native-isolation-poison",
    PI_PROFILE: "native-isolation-poison",
    HOME: join(poisonRoot, "inherited-home"),
    XDG_CONFIG_HOME: join(poisonRoot, "inherited-config"),
  };
  const previous = new Map(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  // Resolve against the real HOME before poisoning it, including supported
  // ~/.bun/bin and ~/.local/bin installs that are absent from PATH.
  const binary = process.env.OMP_WEB_OMP_BIN || resolveOmpBin();
  let f;
  let child;
  try {
    Object.assign(process.env, poisoned);
    f = fixture(t, binary);
    child = await f.open();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  // This command awaits OMP's actual background discovery, not merely ready or
  // agent_start. Without the supported provider policy, even clean env would
  // allow implicit local probes and credential-free catalog HTTP refreshes.
  const catalog = await child.proc.sendCommand({ type: "get_available_models" }, 20_000);
  assert.deepEqual(catalog.models.map(({ provider, id }) => [provider, id]), [
    ["omp-web-native-edit-fixture", "offline-history-edit"],
  ], "only the inert fixture provider survives completed startup discovery");
  assert.deepEqual(await messagesOf(child.proc), entireHistory);
  const edited = await editSessionHistory(child.proc, "u2", f.sessionId);
  assert.equal(edited.cancelled, false);
  assert.equal(edited.sessionId, f.sessionId);
  assert.ok(edited.leafId);
  assert.deepEqual(await messagesOf(child.proc), retained);
  assert.deepEqual(buildSessionContext(loadSessionFile(f.sessionFile).entries).entryIds, ["u1", "a1"]);
  assertNoAgentRun(child.frames);
  await within(child.proc.dispose(500), 5_000, "isolated native child disposal");
  assert.deepEqual(requests, [], "inherited provider endpoints receive zero requests through discovery, Edit and shutdown");
});

const stateOf = (proc) => proc.sendCommand({ type: "get_state" }, 5_000);
const messagesOf = async (proc) => textOf((await proc.sendCommand({ type: "get_messages" }, 5_000)).messages);
function assertNoAgentRun(frames) {
  assert.equal(frames.some((frame) => frame.type === "agent_start"), false, "editing never starts a model run");
}
function editReplies(frames) {
  return frames.filter((frame) => frame.type === "extension_ui_request" && frame.method === "notify"
    && typeof frame.message === "string" && frame.message.startsWith(SESSION_EDIT_RESPONSE_PREFIX))
    .map((frame) => JSON.parse(frame.message.slice(SESSION_EDIT_RESPONSE_PREFIX.length)));
}

test("native edit changes effective context in the same file and survives reopening", nativeOptions, async (t) => {
  const f = fixture(t);
  const child = await f.open();
  const before = await stateOf(child.proc);
  assert.equal(before.sessionId, f.sessionId);
  assert.equal(before.sessionFile, f.sessionFile);
  assert.deepEqual(await messagesOf(child.proc), entireHistory);
  const beforeInvalid = readFileSync(f.sessionFile, "utf8");
  await assert.rejects(editSessionHistory(child.proc, "a1", f.sessionId), /target must be a user message/);
  assert.equal(readFileSync(f.sessionFile, "utf8"), beforeInvalid, "invalid targets do not persist any entry");

  const edited = await editSessionHistory(child.proc, "u2", f.sessionId);
  assert.equal(edited.cancelled, false);
  assert.equal(edited.sessionId, f.sessionId);
  assert.ok(edited.leafId);
  const after = await stateOf(child.proc);
  assert.equal(after.sessionId, f.sessionId);
  assert.equal(after.sessionFile, f.sessionFile);
  assert.deepEqual(await messagesOf(child.proc), retained);
  const entries = loadSessionFile(f.sessionFile).entries;
  for (const id of originalIds) {
    assert.ok(entries.some((entry) => entry.id === id), `the original branch entry ${id} is retained`);
  }
  const marker = entries.find((entry) => entry.id === edited.leafId);
  assert.ok(marker, "the chosen navigation leaf is persisted");
  assert.equal(marker.type, "custom");
  assert.equal(marker.customType, "omp-web-history-navigation");
  assert.equal(marker.parentId, "a1");
  assert.deepEqual(marker.data, { entryId: "u2" });
  assert.deepEqual(buildSessionContext(entries).entryIds, ["u1", "a1"]);
  assert.deepEqual(buildSessionContext(entries, "a2").entryIds, ["u1", "a1", "u2", "a2"]);
  assert.deepEqual(buildSessionContext(entries, "a3").entryIds, originalIds);
  assertNoAgentRun(child.frames);
  await within(child.proc.dispose(500), 5_000, "single-owner native child disposal");

  const resumed = await f.open();
  const reopened = await stateOf(resumed.proc);
  assert.equal(reopened.sessionId, f.sessionId);
  assert.equal(reopened.sessionFile, f.sessionFile);
  assert.deepEqual(await messagesOf(resumed.proc), retained);
  assert.deepEqual(buildSessionContext(loadSessionFile(f.sessionFile).entries).entryIds, ["u1", "a1"]);
  assertNoAgentRun(resumed.frames);
  await within(resumed.proc.dispose(500), 5_000, "reopened native child disposal");
});

// The first process really writes; merely resuming a session does not establish
// journal ownership. Its edit of U3 leaves U2 available for the second editor.
test("native non-owner Edit migrates while preserving the original writer and both branches", nativeOptions, async (t) => {
  const f = fixture(t);
  const owner = await f.open();
  assert.deepEqual(await messagesOf(owner.proc), entireHistory);
  const ownerEdit = await editSessionHistory(owner.proc, "u3", f.sessionId);
  assert.equal(ownerEdit.cancelled, false);
  assert.equal(ownerEdit.sessionId, f.sessionId);
  assert.ok(ownerEdit.leafId);
  const ownerState = await stateOf(owner.proc);
  assert.equal(ownerState.sessionId, f.sessionId);
  assert.equal(ownerState.sessionFile, f.sessionFile);
  assert.deepEqual(await messagesOf(owner.proc), throughU2);
  const originalBytes = readFileSync(f.sessionFile, "utf8");

  const editor = await f.open();
  assert.equal((await stateOf(editor.proc)).sessionId, f.sessionId);
  assert.deepEqual(await messagesOf(editor.proc), throughU2);
  const edited = await editSessionHistory(editor.proc, "u2", f.sessionId);
  assert.equal(edited.cancelled, false);
  assert.ok(edited.leafId);
  assert.notEqual(edited.sessionId, f.sessionId, "native copy-on-write gives the second writer its own identity");
  const moved = await stateOf(editor.proc);
  assert.equal(moved.sessionId, edited.sessionId, "the result reports native's authoritative active identity");
  assert.notEqual(moved.sessionFile, f.sessionFile);
  assert.equal(dirname(resolve(moved.sessionFile)), resolve(f.root), "the relocated journal remains test-owned");
  assert.deepEqual(await messagesOf(editor.proc), retained);
  assert.equal(owner.proc.isAlive, true);
  assert.equal((await stateOf(owner.proc)).sessionId, f.sessionId);
  assert.equal((await stateOf(owner.proc)).sessionFile, f.sessionFile);
  assert.deepEqual(await messagesOf(owner.proc), throughU2, "another editor cannot move the owner's active leaf");
  assert.equal(readFileSync(f.sessionFile, "utf8"), originalBytes, "another editor cannot rewrite the owner's journal");

  const movedEntries = loadSessionFile(moved.sessionFile).entries;
  for (const id of originalIds) {
    assert.ok(movedEntries.some((entry) => entry.id === id), `the old branch entry ${id} is retained`);
  }
  assert.ok(movedEntries.some((entry) => entry.id === edited.leafId), "the chosen leaf is persisted");
  assert.deepEqual(buildSessionContext(movedEntries).entryIds, ["u1", "a1"]);
  assert.deepEqual(buildSessionContext(movedEntries, "a3").entryIds, originalIds, "old U2/U3 remain readable as history, not active context");
  await editor.proc.dispose(500);

  const reopened = await f.open(moved.sessionFile);
  const reopenedState = await stateOf(reopened.proc);
  assert.equal(reopenedState.sessionId, moved.sessionId);
  assert.equal(reopenedState.sessionFile, moved.sessionFile);
  assert.deepEqual(await messagesOf(reopened.proc), retained);
  assert.deepEqual(buildSessionContext(loadSessionFile(moved.sessionFile).entries).entryIds, ["u1", "a1"]);
  assert.equal(readFileSync(f.sessionFile, "utf8"), originalBytes);
  for (const child of [owner, editor, reopened]) assertNoAgentRun(child.frames);
});

test("native append failure rejects Edit despite the extension's nominal success reply", nativeOptions, async (t) => {
  if (process.platform === "win32") {
    t.skip("chmod 0444 does not deterministically deny native append on Windows; no safe Unix permission mechanism is available");
    return;
  }
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    t.skip("requires a non-root Unix uid: root can bypass a test-owned journal's 0444 write permissions");
    return;
  }
  const f = fixture(t);
  const originalBytes = readFileSync(f.sessionFile, "utf8");
  // Apply permissions before OMP can create an append handle. A chmod after
  // opening the handle would not reliably fail writes on Unix.
  chmodSync(f.sessionFile, 0o444);
  let handle;
  try {
    handle = openSync(f.sessionFile, "a");
  } catch (error) {
    assert.ok(error.code === "EACCES" || error.code === "EPERM", `unexpected append probe failure: ${error}`);
  }
  if (handle !== undefined) {
    closeSync(handle);
    t.skip("this filesystem permits a non-root append-open on a 0444 test-owned journal; readonly permissions cannot force a native storage failure");
    return;
  }

  const child = await f.open();
  assert.equal((await stateOf(child.proc)).sessionId, f.sessionId);
  assert.deepEqual(await messagesOf(child.proc), entireHistory);
  await assert.rejects(editSessionHistory(child.proc, "u2", f.sessionId), (error) => {
    assert.equal(error instanceof RpcCommandTimeoutError, false, "a native write error must not degrade into an edit timeout");
    assert.match(error.message, /persist|write|append|permission|EACCES|EPERM|read.only/i);
    return true;
  });
  // A command barrier observes the completed extension handler without sleeps
  // or manufactured notifications, even if its failure notice arrived first.
  await stateOf(child.proc);
  const notices = child.frames.filter((frame) => frame.type === "notice" && frame.source === "session-persistence" && frame.level === "error");
  assert.ok(notices.length > 0, "native persistence exposes the actual OS write failure");
  assert.ok(editReplies(child.frames).some((reply) => reply.cancelled === false && typeof reply.leafId === "string" && !reply.error),
    "the real extension can nominally succeed while native persistence has failed");
  assert.equal(readFileSync(f.sessionFile, "utf8"), originalBytes, "the failed append did not persist an edit marker");
  assertNoAgentRun(child.frames);
});

function writeInputHook(root, mode) {
  const hook = join(root, `constructed-input-${mode}.mjs`);
  // This is a deliberately constructed compatibility fixture, not a claim that
  // any discovered real-world plugin intercepts the production Edit command.
  writeFileSync(hook, `export default function (pi) {
  pi.registerCommand("omp-web-native-edit-redirect", {
    description: "Native Edit input-hook acceptance fixture",
    handler: async (_args, ctx) => ctx.ui.notify(${JSON.stringify(INPUT_PROBE_PREFIX + "redirect-handler")}, "info"),
  });
  pi.on("input", async (event, ctx) => {
    if (!event.text.startsWith(${JSON.stringify(`/${SESSION_EDIT_COMMAND} `)})) return;
    ctx.ui.notify(${JSON.stringify(INPUT_PROBE_PREFIX + mode)}, "info");
    ${mode === "consume" ? "return { handled: true };" : mode === "redirect" ? 'return { text: "/omp-web-native-edit-redirect" };' : "return;"}
  });
}
`);
  return hook;
}

for (const mode of ["pass", "consume", "redirect"]) {
  test(`native constructed input hook (${mode}) cannot falsely acknowledge Edit`, nativeOptions, async (t) => {
    const f = fixture(t);
    const child = await f.open(f.sessionFile, [writeInputHook(f.root, mode)]);
    const originalBytes = readFileSync(f.sessionFile, "utf8");
    assert.deepEqual(await messagesOf(child.proc), entireHistory);
    if (mode === "pass") {
      const edited = await editSessionHistory(child.proc, "u2", f.sessionId);
      assert.equal(edited.cancelled, false);
      assert.equal(edited.sessionId, f.sessionId);
      assert.ok(edited.leafId);
      assert.deepEqual(await messagesOf(child.proc), retained);
      assert.deepEqual(buildSessionContext(loadSessionFile(f.sessionFile).entries).entryIds, ["u1", "a1"]);
    } else {
      await assert.rejects(editSessionHistory(child.proc, "u2", f.sessionId), (error) => {
        assert.ok(error instanceof RpcCommandTimeoutError, "consumed/redirected input never supplies a correlated edit outcome");
        assert.equal(error.command, "edit_message");
        return true;
      });
      assert.equal((await stateOf(child.proc)).sessionId, f.sessionId);
      assert.deepEqual(await messagesOf(child.proc), entireHistory);
      assert.equal(readFileSync(f.sessionFile, "utf8"), originalBytes);
      assert.deepEqual(editReplies(child.frames), [], "the redirected/consumed command never ran the Edit handler");
    }
    const notifications = child.frames.filter((frame) => frame.type === "extension_ui_request" && frame.method === "notify").map((frame) => frame.message);
    assert.ok(notifications.includes(INPUT_PROBE_PREFIX + mode), "the real native input hook observed the production command");
    assert.equal(notifications.includes(INPUT_PROBE_PREFIX + "redirect-handler"), mode === "redirect", "transformation dispatches only the fixture's registered command");
    assertNoAgentRun(child.frames);
  });
}
