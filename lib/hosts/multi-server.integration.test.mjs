import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = join(root, "tests", "fixtures");
const ID = "ba7c0e5e-0000-4000-8000-000000000001";

async function until(predicate, detail, logs, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await sleep(30);
  }
  throw new Error(`Timed out: ${detail}\n${logs()}`);
}

async function json(base, path, command) {
  const response = await fetch(`${base}${path}`, command && {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
  return body;
}

async function sessionStream(base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const frames = [];
  let failure;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const task = (async () => {
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += value;
      let at;
      while ((at = text.indexOf("\n\n")) !== -1) {
        const event = text.slice(0, at);
        text = text.slice(at + 2);
        const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data) frames.push(JSON.parse(data));
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) failure = error; });
  const log = () => JSON.stringify({ frames, failure: failure?.message });
  const hello = await until(() => frames.find((f) => f.type === "hello"), "SSE hello", log);
  await json(base, "/api/events", { connectionId: hello.connectionId, subscribe: { id: "s1", channel: { kind: "session", sessionId: ID } } });
  return { frames, log, close: async () => { controller.abort(); await task; } };
}

function hasMessage(frames, role, text) {
  return frames.some((f) => f.type === "message_end" && f.message?.role === role &&
    (typeof f.message.content === "string" ? f.message.content === text : f.message.content?.some((c) => c.type === "text" && c.text === text)));
}

test("two real web servers share one host process and one live conversation", { timeout: 90_000 }, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "ompweb-multi-server-"));
  const agentDir = join(scratch, "home", ".omp", "agent");
  const project = join(scratch, "project");
  const site = join(scratch, "site");
  mkdirSync(join(agentDir, "sessions", "-project"), { recursive: true });
  mkdirSync(project);
  mkdirSync(join(site, "dist"), { recursive: true });
  symlinkSync(join(root, "public"), join(site, "public"), "junction");
  writeFileSync(join(site, "dist", "index.html"), "<!doctype html><title>omp web</title><main id=\"root\"></main>");
  const sessionFile = join(agentDir, "sessions", "-project", `2026-01-01_${ID}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: ID, cwd: project, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  const ompLog = join(scratch, "omp.jsonl");
  const fake = join(scratch, process.platform === "win32" ? "omp.cmd" : "omp");
  const source = `import(${JSON.stringify(pathToFileURL(join(fixture, "multi-server-omp.mjs")).href)});\n`;
  if (process.platform === "win32") {
    writeFileSync(`${fake}.cjs`, source);
    writeFileSync(fake, `@"${process.execPath.replaceAll("%", "%%")}" "${fake.replaceAll("%", "%%")}.cjs" %*\r\n`);
  } else writeFileSync(fake, `#!${process.execPath}\n${source}`, { mode: 0o755 });
  const env = { ...process.env, HOME: join(scratch, "home"), USERPROFILE: join(scratch, "home"), PI_CODING_AGENT_DIR: agentDir,
    NODE_ENV: "production", OMP_WEB_OMP_BIN: fake, OMP_MULTI_SESSION_ID: ID, OMP_MULTI_SESSION_FILE: sessionFile, OMP_MULTI_LOG: ompLog,
    OMP_MULTI_RELEASE_FILE: join(scratch, "release-stream"),
    OMP_WEB_DISCONNECT_DESTROY_MS: "1000" };
  for (const key of ["OMP_WEB_PASSWORD", "OMP_WEB_PASSWORD_HASH", "OMP_WEB_TRUSTED_HEADER_SECRET", "OMP_WEB_TRUSTED_HEADER_SHA256", "OMP_WEB_PACKAGE_DIR"]) delete env[key];
  const children = [];
  const streams = [];
  let logs = "";
  const launch = (args, extra = {}) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    const state = { child, output: "" };
    children.push(child);
    for (const pipe of [child.stdout, child.stderr]) pipe.on("data", (chunk) => { state.output += chunk; logs += `[${child.pid}] ${chunk}`; });
    return state;
  };
  const stop = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timeout);
  };
  t.after(async () => {
    for (const stream of streams) await stream.close();
    for (const child of children.reverse()) await stop(child);
    rmSync(scratch, { recursive: true, force: true });
  });
  const server = async () => {
    const state = launch([join(fixture, "multi-server-app.ts")], { OMP_WEB_PACKAGE_DIR: site });
    const port = await until(() => /MULTI_SERVER_PORT=(\d+)/.exec(state.output)?.[1], "server ready", () => logs);
    return { child: state.child, base: `http://127.0.0.1:${port}` };
  };
  const a = await server();
  const b = await server();
  const daemon = launch([join(root, "bin", "omp-web-host.js")]);
  await until(async () => {
    const [ah, bh] = await Promise.all([json(a.base, "/api/hosts"), json(b.base, "/api/hosts")]);
    return ah.hosts.some((h) => h.id === "local" && h.status === "online") && bh.hosts.some((h) => h.id === "local" && h.status === "online");
  }, "both servers linked to the same daemon", () => logs);
  const daemonPid = daemon.child.pid;
  await json(a.base, `/api/agent/${ID}`, { type: "get_state" });
  await json(b.base, `/api/agent/${ID}`, { type: "get_state" });
  const sa = await sessionStream(a.base);
  const sb = await sessionStream(b.base);
  streams.push(sa, sb);
  await json(a.base, `/api/agent/${ID}`, { type: "prompt", message: "from A" });
  await until(() => hasMessage(sa.frames, "user", "from A") && hasMessage(sb.frames, "user", "from A"), "A prompt echoed on both", () => `${sa.log()}\n${sb.log()}\n${logs}`);
  await until(() => hasMessage(sa.frames, "assistant", "one two") && hasMessage(sb.frames, "assistant", "one two"), "same assistant result on both", () => logs);
  await json(b.base, `/api/agent/${ID}`, { type: "prompt", message: "from B" });
  await until(() => hasMessage(sa.frames, "user", "from B") && hasMessage(sb.frames, "user", "from B"), "B prompt echoed on both", () => logs);
  await until(() => sb.frames.filter((f) => f.type === "agent_end").length >= 2, "B turn settled", () => logs);
  const starts = () => existsSync(ompLog) ? readFileSync(ompLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const pids = starts().filter((e) => e.type === "start" && e.resumed).map((e) => e.pid);
  assert.equal(pids.length, 1, `session must spawn once: ${JSON.stringify(pids)}`);
  assert.equal(daemon.child.pid, daemonPid);
  assert.equal(sa.frames.filter((f) => f.type === "tool_execution_end").length, 2);
  assert.equal(sb.frames.filter((f) => f.type === "tool_execution_end").length, 2);
  for (const { frames } of [sa, sb]) {
    const result = frames.find(f => f.type === "tool_execution_end" && f.toolCallId === "t2")?.result;
    assert.equal(result?.details?.largeResult, "x".repeat(1_100_000), "both peers receive the 1.1 MB native tool result whole");
  }
  await json(a.base, `/api/agent/${ID}`, { type: "prompt", message: "ask" });
  await until(() => sa.frames.some((f) => f.type === "ui_request" && f.method === "askDialog") && sb.frames.some((f) => f.type === "ui_request" && f.method === "askDialog"), "one question on both", () => logs);
  const question = sb.frames.findLast((f) => f.type === "ui_request" && f.method === "askDialog");
  await json(b.base, `/api/agent/${ID}`, { type: "ui_response", id: question.id, value: { kind: "submit", results: [{ id: "pick", question: "Pick one", options: ["A", "B"], multi: false, selectedOptions: ["B"] }] } });
  await until(() => sa.frames.some((f) => f.type === "ui_end" && f.id === question.id), "answer on B closes A dialog", () => `${sa.log()}\n${logs}`);
  // The server closes A's dialog without waiting for omp, so the child's record of the answer can land later.
  await until(() => starts().some((e) => e.type === "answer" && e.id === String(question.id)), "omp receives the answer", () => logs);
  assert.equal(starts().filter((e) => e.type === "answer" && e.id === String(question.id)).length, 1);
  await json(b.base, `/api/agent/${ID}`, { type: "prompt", message: "slow" });
  await until(() => sb.frames.some((f) => f.type === "message_update" && f.messageId === "a4"), "stream starts before reconnect", () => logs);
  await stop(a.child);
  await sleep(1200);
  const a2 = await server();
  await until(async () => (await json(a2.base, "/api/hosts")).hosts.some((h) => h.id === "local" && h.status === "online"), "restarted server linked", () => logs);
  await json(a2.base, `/api/agent/${ID}`, { type: "get_state" });
  const sa2 = await sessionStream(a2.base);
  streams.push(sa2);
  await until(() => sa2.frames.some((f) => f.type === "message_update" && f.message?.content?.some((c) => c.text === "one")), "rejoined server receives current whole message", () => `${sa2.log()}\n${logs}`);
  writeFileSync(join(scratch, "release-stream"), "");
  await until(() => hasMessage(sa2.frames, "assistant", "one two"), "rejoined stream finishes without missing text", () => logs);
  await json(b.base, `/api/agent/${ID}`, { type: "prompt", message: "B after A restarts" });
  await until(() => hasMessage(sb.frames, "user", "B after A restarts"), "B still drives the same session", () => logs);
  assert.deepEqual(starts().filter((e) => e.type === "start" && e.resumed).map((e) => e.pid), pids);

  await until(async () => !(await json(b.base, `/api/sessions/${ID}/state`)).state?.isStreaming, "B turn finished before outbox send", () => logs);
  const { data: { scope } } = await json(b.base, `/api/agent/${ID}`, { type: "outbox_scope" });
  await json(b.base, `/api/agent/${ID}`, {
    type: "outbox_add", id: "peer-delivered-message", scope, mode: "prompt", message: "outbox from B",
  });
  await until(() => hasMessage(sa2.frames, "user", "outbox from B"), "peer sees the delivered prompt", () => `${sa2.log()}\n${logs}`);
  await until(() => [sa2, sb].every(({ frames }) => frames.some((frame) =>
    frame.type === "outbox_update" && frame.entries.length === 0 && frame.settledIds.includes("peer-delivered-message")
      && frame.nativeSettledIds?.includes("peer-delivered-message"))),
  "both servers retire the delivered outbox row without resubscribing", () => `${sa2.log()}\n${sb.log()}\n${logs}`);
  for (const { frames } of [sa2, sb]) {
    const echo = frames.find((frame) => frame.type === "message_end" && frame.clientMessageId === "peer-delivered-message");
    assert.ok(echo, "both real server links preserve the exact native outbox echo ID");
    assert.equal(echo.message.clientMessageId, undefined, "native correlation stays outside the provider message");
  }
  assert.equal(starts().find((entry) => entry.type === "stdin" && entry.command.args?.message === "outbox from B")?.command.args.clientMessageId, "peer-delivered-message");
});
