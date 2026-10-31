import assert from "node:assert/strict";
import test from "node:test";

const { runAgentCommand } = await import("./agent-command.ts");
const route = await import("../app/api/agent/[id]/route.ts");

function withSession(id, session) {
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(id, session);
  return () => globalThis.__ompSessions.delete(id);
}

const ctx = (id) => ({ params: Promise.resolve({ id }) });
const post = (id, body, raw = JSON.stringify(body)) =>
  route.POST(new Request(`http://omp.test/api/agent/${id}`, { method: "POST", body: raw }), ctx(id));

test("runAgentCommand answers a live session exactly as the route", async () => {
  const seen = [];
  const drop = withSession("s1", {
    isAlive: () => true,
    advisorSpawned: false,
    isRunning: () => false,
    isEditingHistory: () => false,
    send: async (body) => {
      seen.push(body);
      return { model: "m" };
    },
  });
  try {
    const body = { type: "get_state" };
    const direct = await runAgentCommand("s1", body, false);
    const viaRoute = await post("s1", body);
    assert.equal(direct.status, viaRoute.status);
    assert.deepEqual(await direct.json(), { success: true, data: { model: "m" } });
    assert.deepEqual(await viaRoute.json(), { success: true, data: { model: "m" } });
    assert.deepEqual(seen, [body, body]);
  } finally {
    drop();
  }
});

test("a missing type is 400 command_type_required; a no-spawn command without a wrapper gets its canned reply", async () => {
  const missing = await runAgentCommand("nobody", {}, false);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "command_type_required");

  const canned = await runAgentCommand("nobody", { type: "predict_word" }, false);
  assert.equal(canned.status, 200);
  assert.deepEqual(await canned.json(), { success: true, data: { suffix: null } });
});

test("POST and GET answers carry received/replied times", async () => {
  const drop = withSession("s2", {
    isAlive: () => true,
    advisorSpawned: false,
    isRunning: () => false,
    isEditingHistory: () => false,
    send: async () => ({}),
  });
  try {
    const answers = [];
    for (const call of [
      () => post("s2", { type: "get_state" }),
      () => post("s2", null, "{not json"),
      () => route.GET(new Request("http://omp.test/api/agent/s2"), ctx("s2")),
    ]) {
      const before = Date.now();
      const res = await call();
      answers.push({ res, before, after: Date.now() });
    }
    assert.equal(answers[1].res.status, 400);
    for (const { res, before, after } of answers) {
      const received = res.headers.get("x-omp-received-at");
      const replied = res.headers.get("x-omp-replied-at");
      assert.match(received, /^\d+$/);
      assert.match(replied, /^\d+$/);
      assert.ok(before <= Number(received) && Number(received) <= Number(replied) && Number(replied) <= after);
    }
  } finally {
    drop();
  }
});
