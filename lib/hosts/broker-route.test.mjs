import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { mock } from "bun:test";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-broker-route-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const originalLog = console.log;
const logs = [];
console.log = (...args) => logs.push(args.join(" "));
after(() => {
  console.log = originalLog;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

// brokerFetch records what the route sends and answers with `answer`; the broker child itself is auth-broker.test.mjs's.
const realBroker = await import("../omp/auth-broker.ts");
const { AuthBrokerUnavailableError } = realBroker;
const calls = [];
const defaultAnswer = () => new Response("{}", { status: 200 });
let answer = defaultAnswer;
mock.module("../omp/auth-broker.ts", () => ({
  ...realBroker,
  brokerFetch: async (...args) => {
    calls.push(args);
    return answer(...args);
  },
}));
const route = await import("../../app/api/hosts/broker/[...path]/route.ts");
const { createHost, revokeHost, rotateLocalHostToken, updateHost } = await import("./registry.ts");

const hostsFile = join(agentDir, "omp-web", "hosts.json");

/** The route's answer to `method path`, and how often it switched Bun's idle timeout off. */
async function send(method, path, { token, headers = {}, body, search = "", signal } = {}) {
  let idle = 0;
  const request = new Request(`http://main.test/api/hosts/broker/${path}${search}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body,
    signal,
  });
  const response = await route[method](request, {
    params: Promise.resolve({ path: path.split("/") }),
    disableIdleTimeout: () => { idle++; },
  });
  return { response, idle: () => idle };
}

function sharingHost(label = "sharer") {
  const { host, token } = createHost(label);
  updateHost(host.id, { shareCredentials: true });
  return { host, token };
}

beforeEach(() => {
  calls.length = 0;
  logs.length = 0;
  answer = defaultAnswer;
});

test("a missing or unknown bearer token is 401 and nothing is forwarded", async () => {
  for (const token of [undefined, "not-a-host-token"]) {
    const { response, idle } = await send("GET", "v1/healthz", { token });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unknown host token" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(idle(), 0, "a caller that failed the token never turns the idle timeout off");
  }
  assert.equal(calls.length, 0);
});

test("sharing off, and the local record whatever its flag says, are 403", async () => {
  const { token } = createHost("private");
  const off = await send("GET", "v1/healthz", { token });
  assert.equal(off.response.status, 403);
  assert.deepEqual(await off.response.json(), { error: "Credential sharing is off for this host" });
  assert.equal(off.response.headers.get("cache-control"), "no-store");

  // A hand-edited hosts.json can give `local` the flag; the route refuses it by id.
  const localToken = rotateLocalHostToken();
  const file = JSON.parse(readFileSync(hostsFile, "utf8"));
  file.hosts.find((h) => h.id === "local").shareCredentials = true;
  writeFileSync(hostsFile, JSON.stringify(file));
  const local = await send("GET", "v1/healthz", { token: localToken });
  assert.equal(local.response.status, 403);
  assert.deepEqual(await local.response.json(), { error: "Credential sharing is off for this host" });

  assert.equal(calls.length, 0);
});

test("an unreadable hosts.json is 503, not 401", async () => {
  const { token } = sharingHost("registry");
  const saved = readFileSync(hostsFile, "utf8");
  writeFileSync(hostsFile, "{not json");
  try {
    const { response } = await send("GET", "v1/healthz", { token });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(typeof (await response.json()).error, "string");
  } finally {
    writeFileSync(hostsFile, saved);
  }
  assert.equal(calls.length, 0);
});

test("the path and query go to the broker for the host the token names", async () => {
  const { host, token } = sharingHost("forwarded");
  const { response } = await send("GET", "v1/snapshot", { token, search: "?wait=30000" });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const [hostId, path, init] = calls[0];
  assert.equal(hostId, host.id);
  assert.equal(path, "/v1/snapshot?wait=30000");
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  assert.ok(logs.includes(`[omp-web] broker ${host.id} GET /v1/snapshot 200`), `log lines: ${logs.join(" | ")}`);
  assert.ok(!logs.some((line) => line.includes("wait=")), "the query is not logged");
});

test("every allow-listed method and path is forwarded", async () => {
  const { token } = sharingHost("allowed");
  const allowed = [
    ["GET", "v1/healthz"], ["GET", "v1/snapshot"], ["GET", "v1/snapshot/stream"], ["GET", "v1/credentials/disabled"],
    ["GET", "v1/usage"], ["GET", "v1/usage/history"], ["GET", "v1/usage/clients"],
    ["POST", "v1/credential/12/refresh"], ["POST", "v1/credential/12/disable"], ["POST", "v1/credential/12/block"],
    ["DELETE", "v1/credential/12/blocks"],
    ["POST", "v1/usage/observed"], ["POST", "v1/usage/stale"],
  ];
  for (const [method, path] of allowed) {
    calls.length = 0;
    const { response } = await send(method, path, { token, body: method === "POST" ? "{}" : undefined });
    assert.equal(response.status, 200, `${method} ${path}`);
    assert.equal(calls[0]?.[1], `/${path}`, `${method} ${path}`);
  }
});

test("anything off the allow-list is 404 and keeps the idle timeout", async () => {
  const { token } = sharingHost("unlisted");
  for (const [method, path] of [
    ["POST", "v1/credential"],
    ["GET", "v1/credential/1/refresh"],
    ["GET", "v1/credentials/check"],
    ["GET", "v2/snapshot"],
    ["POST", "v1/credential/x/refresh"],
  ]) {
    const { response, idle } = await send(method, path, { token, body: method === "POST" ? "{}" : undefined });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(idle(), 0, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test("only content-type, accept, if-none-match and the capabilities header reach the broker", async () => {
  const { token } = sharingHost("req-headers");
  await send("GET", "v1/snapshot", {
    token,
    headers: {
      cookie: "session=secret",
      "x-forwarded-for": "10.0.0.9",
      "content-type": "application/json",
      accept: "text/event-stream",
      "if-none-match": '"abc"',
      "omp-auth-broker-capabilities": "snapshot-v2",
    },
  });
  const { headers } = calls[0][2];
  assert.ok(headers instanceof Headers);
  assert.deepEqual(Object.fromEntries(headers), {
    accept: "text/event-stream",
    "content-type": "application/json",
    "if-none-match": '"abc"',
    "omp-auth-broker-capabilities": "snapshot-v2",
  });
  for (const name of ["cookie", "x-forwarded-for", "authorization"]) assert.equal(headers.get(name), null, name);
});

test("the answer keeps the upstream status, body and only content-type, etag, cache-control and vary", async () => {
  const { token } = sharingHost("res-headers");
  answer = () => new Response("payload", {
    status: 202,
    headers: {
      "content-type": "application/json",
      etag: '"v1"',
      "cache-control": "max-age=5",
      vary: "accept",
      "set-cookie": "broker=1",
      "x-other": "1",
    },
  });
  const { response } = await send("GET", "v1/usage", { token });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "payload");
  assert.deepEqual(Object.fromEntries(response.headers), {
    "cache-control": "max-age=5",
    "content-type": "application/json",
    etag: '"v1"',
    vary: "accept",
  });
});

test("a body-less 304 passes through", async () => {
  const { token } = sharingHost("not-modified");
  answer = () => new Response(null, { status: 304, headers: { etag: '"v1"' } });
  const { response } = await send("GET", "v1/snapshot", { token, headers: { "if-none-match": '"v1"' } });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"v1"');
});

test("a POST body of at most 1 MiB is forwarded; one byte more is 413", async () => {
  const { token } = sharingHost("upload");
  const exact = new Uint8Array(1024 * 1024).fill(7);
  const accepted = await send("POST", "v1/usage/observed", { token, body: exact });
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(new Uint8Array(calls[0][2].body), exact);

  calls.length = 0;
  const refused = await send("POST", "v1/usage/observed", { token, body: new Uint8Array(1024 * 1024 + 1) });
  assert.equal(refused.response.status, 413);
  assert.equal(refused.response.headers.get("cache-control"), "no-store");
  assert.equal(typeof (await refused.response.json()).error, "string");
  assert.equal(calls.length, 0);
});

test("an unavailable broker is 503 and any other failure 502", async () => {
  const { token } = sharingHost("failing");
  answer = () => { throw new AuthBrokerUnavailableError("down"); };
  const unavailable = await send("GET", "v1/healthz", { token });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.response.headers.get("cache-control"), "no-store");
  assert.equal(typeof (await unavailable.response.json()).error, "string");

  answer = () => { throw new Error("x"); };
  const failed = await send("GET", "v1/healthz", { token });
  assert.equal(failed.response.status, 502);
  assert.equal(failed.response.headers.get("cache-control"), "no-store");
  assert.equal(typeof (await failed.response.json()).error, "string");
});

test("a 403 and a 404 are logged like a forwarded request, a 404 or 403 path only as plain /v1/ text, and a 401 not at all", async () => {
  const { host: off, token: offToken } = createHost("logged-off");
  await send("GET", "v1/healthz", { token: offToken });
  await send("GET", "v1/odd path", { token: offToken });
  const { host, token } = sharingHost("logged-404");
  await send("POST", "v1/credential", { token, body: "BODY-SECRET" });
  await send("GET", "v2/snapshot", { token });
  await send("GET", "v1/evil\ninjected", { token });
  await send("GET", "v1/healthz", { token: "not-a-host-token" });
  assert.deepEqual(logs, [
    `[omp-web] broker ${off.id} GET /v1/healthz 403`,
    `[omp-web] broker ${off.id} GET - 403`,
    `[omp-web] broker ${host.id} POST /v1/credential 404`,
    `[omp-web] broker ${host.id} GET - 404`,
    `[omp-web] broker ${host.id} GET - 404`,
  ]);
  for (const secret of [offToken, token, "not-a-host-token", "BODY-SECRET"]) assert.ok(!logs.join("\n").includes(secret));
});

test("a failed forward logs the class of its reason, never the error's text or the body", async () => {
  const { host, token } = sharingHost("reasons");
  const unavailable = (reason) => () => { throw new AuthBrokerUnavailableError(`stderr says secret-text (${reason})`, reason); };
  for (const [throwing, status, reason] of [
    [unavailable("binary_missing"), 503, "binary_missing"],
    [unavailable("token_command_failed"), 503, "token_command_failed"],
    [unavailable("not_ready"), 503, "not_ready"],
    [unavailable("exited"), 503, "exited"],
    [unavailable("refused_token"), 503, "refused_token"],
    [unavailable(undefined), 503, "fetch_failed"],
    [() => { throw new DOMException("secret-text", "AbortError"); }, 502, "aborted"],
    [() => { throw new Error("secret-text"); }, 502, "fetch_failed"],
  ]) {
    logs.length = 0;
    answer = throwing;
    const { response } = await send("POST", "v1/usage/observed", { token, body: "BODY-SECRET" });
    assert.equal(response.status, status, reason);
    assert.deepEqual(logs, [`[omp-web] broker ${host.id} POST /v1/usage/observed ${status} ${reason}`]);
  }

  // The host disconnected: whatever brokerFetch then throws, the request was aborted.
  logs.length = 0;
  answer = () => { throw new Error("secret-text"); };
  const { response } = await send("GET", "v1/snapshot/stream", { token, signal: AbortSignal.abort() });
  assert.equal(response.status, 502);
  assert.deepEqual(logs, [`[omp-web] broker ${host.id} GET /v1/snapshot/stream 502 aborted`]);
});

test("the idle timeout goes off once for an accepted request", async () => {
  const { token } = sharingHost("idle");
  const { idle } = await send("GET", "v1/snapshot/stream", { token });
  assert.equal(idle(), 1);
});

/** A POST whose body the test releases later; `started` settles once the route is reading it. */
function stalledPost(token) {
  let release;
  const body = new ReadableStream({
    start(controller) {
      release = () => {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      };
    },
  });
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  const request = new Request("http://main.test/api/hosts/broker/v1/credential/1/disable", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body,
    duplex: "half",
  });
  const response = route.POST(request, {
    params: Promise.resolve({ path: ["v1", "credential", "1", "disable"] }),
    disableIdleTimeout: reading,
  });
  return { started, release, response };
}

test("a body that arrives late is forwarded while the host still shares", async () => {
  const { host, token } = sharingHost("slow");
  const post = stalledPost(token);
  await post.started;
  assert.equal(calls.length, 0, "nothing is forwarded before the body is complete");
  post.release();
  assert.equal((await post.response).status, 200);
  assert.deepEqual(calls.map(([hostId, path]) => [hostId, path]), [[host.id, "/v1/credential/1/disable"]]);
});

test("a host switched off while its body is still arriving gets 403 and nothing is forwarded", async () => {
  const { host, token } = sharingHost("switched-off");
  const post = stalledPost(token);
  await post.started;
  updateHost(host.id, { shareCredentials: false });
  post.release();
  const response = await post.response;
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Credential sharing is off for this host" });
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, [`[omp-web] broker ${host.id} POST /v1/credential/1/disable 403`]);
});

test("a host revoked while its body is still arriving gets 401 and nothing is forwarded", async () => {
  const { host, token } = sharingHost("revoked");
  const post = stalledPost(token);
  await post.started;
  revokeHost(host.id);
  post.release();
  const response = await post.response;
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unknown host token" });
  assert.equal(calls.length, 0);
});
