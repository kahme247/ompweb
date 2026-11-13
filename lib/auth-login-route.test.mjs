import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { mock } from "bun:test";

// Real /api/auth/login/[provider] handlers over a fake runner that sends the
// login frames runner/src/commands/agents.ts documents.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ompweb-login-"));

const runners = [];
class FakeRunner {
  constructor(options) {
    runners.push(this);
    this.options = options;
    this.sent = [];
    this.commands = [];
    this.login = Promise.withResolvers();
  }
  emit(frame) { this.options.onFrame(frame); }
  waitReady() { return Promise.resolve({ type: "hello" }); }
  sendCommand(command) { this.commands.push(command); return this.login.promise; }
  sendFrame(frame) { this.sent.push(frame); }
  dispose() { return Promise.resolve(); }
}
const rpcProcessPath = join(import.meta.dir, "omp/rpc-process.ts");
const realRpcProcess = { ...(await import(rpcProcessPath)) };
mock.module(rpcProcessPath, () => ({ ...realRpcProcess, RpcProcess: FakeRunner }));
const route = await import("../app/api/auth/login/[provider]/route.ts");
// Later test files in this process import the real module.
after(() => mock.module(rpcProcessPath, () => realRpcProcess));

const params = { params: Promise.resolve({ provider: "anthropic" }) };
const url = "http://localhost/api/auth/login/anthropic";

/** Opens the SSE stream (which spawns the fake runner) and returns its event reader. */
async function openLogin() {
  const res = await route.GET(new Request(url), { ...params, disableIdleTimeout: () => {} });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith("data: ")) return JSON.parse(block.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value);
    }
  };
}

const submit = (token, code, provider = "anthropic") =>
  route.POST(
    new Request(url, { method: "POST", body: JSON.stringify({ token, code }) }),
    { params: Promise.resolve({ provider }) },
  );

test("login frames map to the browser's SSE events and the code goes back as login_input_response", async () => {
  const next = await openLogin();
  runners.at(-1).emit({ type: "login_open_url", url: "https://auth.test/x", instructions: "Sign in" });
  const auth = await next();
  assert.deepEqual({ ...auth, token: undefined }, { type: "auth", url: "https://auth.test/x", instructions: "Sign in", token: undefined });
  assert.deepEqual(runners.at(-1).commands, [{ type: "login", providerId: "anthropic" }]);

  runners.at(-1).emit({ type: "login_progress", message: "Waiting" });
  assert.deepEqual(await next(), { type: "progress", message: "Waiting" });

  runners.at(-1).emit({ type: "login_input", id: 3, prompt: "Paste the code", placeholder: "code" });
  assert.deepEqual(await next(), { type: "prompt_request", message: "Paste the code", placeholder: "code", token: auth.token });
  assert.equal((await submit(auth.token, "abc")).status, 200);
  assert.deepEqual(runners.at(-1).sent, [{ type: "login_input_response", id: 3, value: "abc" }]);

  runners.at(-1).login.resolve({ providerId: "anthropic" });
  assert.deepEqual(await next(), { type: "success" });
  assert.equal(await next(), null);
  assert.equal((await submit(auth.token, "late")).status, 404);
});

test("a code pasted before the runner asks is answered on the next login_input", async () => {
  const next = await openLogin();
  runners.at(-1).emit({ type: "login_open_url", url: "https://auth.test/y" });
  const auth = await next();
  assert.equal(auth.instructions, null);
  await submit(auth.token, "early");
  assert.deepEqual(runners.at(-1).sent, []);

  runners.at(-1).emit({ type: "login_input", id: 9, prompt: "Paste" });
  assert.deepEqual(runners.at(-1).sent, [{ type: "login_input_response", id: 9, value: "early" }]);

  runners.at(-1).login.reject(new Error("login: bad code"));
  assert.deepEqual(await next(), { type: "error", message: "login: bad code" });
});

test("a token is only accepted on its own provider's route", async () => {
  const next = await openLogin();
  runners.at(-1).emit({ type: "login_open_url", url: "https://auth.test/z" });
  const { token } = await next();
  assert.equal((await submit(token, "x", "anthropic-other")).status, 400);
  assert.deepEqual(runners.at(-1).sent, []);
  runners.at(-1).login.resolve({});
  assert.deepEqual(await next(), { type: "success" });
});
