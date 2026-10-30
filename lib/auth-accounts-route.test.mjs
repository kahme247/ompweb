import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

// Real /api/auth/accounts/[provider] handlers; the shared utility omp process
// is replaced by a fake that answers like omp does (or like an older omp).
const route = await import("../app/api/auth/accounts/[provider]/route.ts");

let reply;
const sent = [];
beforeEach(() => {
  sent.length = 0;
  globalThis.__ompUtilityRpcState = {
    proc: {
      isAlive: true,
      sendCommand: async (command) => { sent.push(command); return reply(command); },
      dispose: async () => {},
    },
    idleTimer: null,
    queue: Promise.resolve(),
  };
});

const params = { params: Promise.resolve({ provider: "anthropic" }) };
const url = "http://localhost/api/auth/accounts/anthropic";
const unknownCommand = (command) => { throw new Error(`Unknown command: ${command.type}`); };

test("GET lists only well-formed accounts and only their known fields", async () => {
  reply = () => ({
    accounts: [
      { credentialId: 7, provider: "anthropic", label: "a@x.test", detail: "oauth #7", type: "oauth", active: true, token: "secret" },
      { credentialId: "8", label: "bad id", detail: "", type: "oauth", active: false },
    ],
  });
  const body = await (await route.GET(new Request(url), params)).json();
  assert.deepEqual(sent, [{ type: "get_logout_accounts", providerId: "anthropic" }]);
  assert.deepEqual(body, {
    supported: true,
    accounts: [{ credentialId: 7, label: "a@x.test", detail: "oauth #7", type: "oauth" }],
  });
});

test("older omp without the RPC is reported as unsupported, not as an error", async () => {
  reply = unknownCommand;
  const list = await route.GET(new Request(url), params);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { supported: false, accounts: [] });

  const del = await route.DELETE(new Request(`${url}?credentialId=7`, { method: "DELETE" }), params);
  assert.equal(del.status, 501);
  assert.equal((await del.json()).code, "logout_unsupported");
});

test("DELETE removes exactly the requested credential", async () => {
  reply = () => ({});
  const res = await route.DELETE(new Request(`${url}?credentialId=7`, { method: "DELETE" }), params);
  assert.equal(res.status, 200);
  assert.deepEqual(sent, [{ type: "logout", providerId: "anthropic", credentialId: 7 }]);
});

test("DELETE rejects ids omp could misread without contacting it", async () => {
  reply = () => ({});
  for (const id of ["", "abc", "-1", "1.5", "9007199254740993"]) {
    const res = await route.DELETE(new Request(`${url}?credentialId=${encodeURIComponent(id)}`, { method: "DELETE" }), params);
    assert.equal(res.status, 400, `credentialId=${JSON.stringify(id)}`);
  }
  assert.deepEqual(sent, []);
});

test("other omp failures surface as server errors", async () => {
  reply = () => { throw new Error("Credential 7 is not stored for anthropic"); };
  const res = await route.DELETE(new Request(`${url}?credentialId=7`, { method: "DELETE" }), params);
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not stored/);
});
