import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST /api/notifications/answer with fake live wrappers: no omp spawn,
// no notification store writes beyond the throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-answer-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  globalThis.__ompSessions = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/notifications/answer/route.ts");
const { WebRpcError } = await jiti.import("@/lib/rpc-manager");

const URL_ = "http://localhost/api/notifications/answer";
const post = (body, headers = {}) => route.POST(new Request(URL_, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

function fakeSession({ alive = true, result = "answered", error = null } = {}) {
  const calls = [];
  return {
    calls,
    session: {
      isAlive: () => alive,
      answerExtensionUiRequest(id, response) {
        calls.push([id, response]);
        if (error) throw error;
        return result;
      },
    },
  };
}

test("a valid answer reaches the live wrapper exactly once", async () => {
  const { calls, session } = fakeSession();
  globalThis.__ompSessions = new Map([["s1", session]]);
  const response = await post({ sessionId: "s1", requestId: "req-1", response: { confirmed: true } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "answered" });
  assert.deepEqual(calls, [["req-1", { confirmed: true }]]);
});

test("all four response variants are accepted", async () => {
  const { calls, session } = fakeSession();
  globalThis.__ompSessions = new Map([["s1", session]]);
  for (const answer of [{ value: "main" }, { confirmed: false }, { cancelled: true }, { answers: [{ id: "q", selectedOptions: ["A"], customInput: "other" }] }]) {
    assert.equal((await post({ sessionId: "s1", requestId: "req", response: answer })).status, 200);
  }
  assert.deepEqual(calls.map(([, answer]) => answer), [
    { value: "main" }, { confirmed: false }, { cancelled: true }, { answers: [{ id: "q", selectedOptions: ["A"], customInput: "other" }] },
  ]);
});

test("alreadySettled and sessionGone are reported, not treated as errors", async () => {
  globalThis.__ompSessions = new Map([["s1", fakeSession({ result: "alreadySettled" }).session]]);
  const settled = await post({ sessionId: "s1", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await settled.json(), { status: "alreadySettled" });

  const dead = await post({ sessionId: "s2", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await dead.json(), { status: "sessionGone" });

  globalThis.__ompSessions = new Map([["s3", fakeSession({ alive: false }).session]]);
  const exited = await post({ sessionId: "s3", requestId: "req", response: { value: "x" } });
  assert.deepEqual(await exited.json(), { status: "sessionGone" });
});

test("malformed requests are rejected before touching any session", async () => {
  const { calls, session } = fakeSession();
  globalThis.__ompSessions = new Map([["s1", session]]);
  const cases = [
    null,
    [],
    "text",
    { sessionId: "s1", requestId: "req" },
    { sessionId: "", requestId: "req", response: { value: "x" } },
    { sessionId: "s1", requestId: "r".repeat(257), response: { value: "x" } },
    { sessionId: "s1", requestId: "req", response: {} },
    { sessionId: "s1", requestId: "req", response: { value: 1 } },
    { sessionId: "s1", requestId: "req", response: { cancelled: false } },
    { sessionId: "s1", requestId: "req", response: { value: "x", confirmed: true } },
    { sessionId: "s1", requestId: "req", response: { answers: "yes" } },
    { sessionId: "s1", requestId: "req", response: { answers: [{ id: 1, selectedOptions: [] }] } },
  ];
  for (const body of cases) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "invalid_answer_request");
  }
  assert.deepEqual(calls, []);
});

test("invalid JSON and an oversized body get distinct statuses", async () => {
  assert.equal((await post("{not json")).status, 400);
  const huge = JSON.stringify({ sessionId: "s1", requestId: "req", response: { value: "x".repeat(70_000) } });
  const response = await post(huge, { "content-length": String(Buffer.byteLength(huge)) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "request_too_large");
});

test("a wrapper validation error becomes a 400 with its own code", async () => {
  const { session } = fakeSession({ error: new WebRpcError("Invalid ask dialog answers", "invalid_ask_answers") });
  globalThis.__ompSessions = new Map([["s1", session]]);
  const response = await post({ sessionId: "s1", requestId: "req", response: { value: "x" } });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid ask dialog answers", code: "invalid_ask_answers" });
});
