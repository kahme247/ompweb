import assert from "node:assert/strict";
import { createServer, request as httpRequest, Server } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { credentialsEnv, MIN_SHARED_CREDENTIALS_OMP, startBrokerForwarder } from "./daemon-broker.ts";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const closeServer = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** A real loopback upstream that records each request (body included) and answers with `answer(req, res, record)`. */
async function upstream(t, answer = (_req, res) => res.end("{}")) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(record);
      answer(req, res, record);
    });
  });
  await listen(server);
  t.after(() => closeServer(server));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

/** A forwarder whose `login` yields `link` (a value or a function of the decoded key), started by its first env(). */
async function forwarder(t, link) {
  const logins = [];
  const instance = startBrokerForwarder({
    login: (key) => {
      logins.push(key);
      return typeof link === "function" ? link(key) : link;
    },
    log: () => {},
  });
  t.after(() => instance.stop());
  const env = await instance.env("http://server.example");
  const base = env.OMP_AUTH_BROKER_URL;
  const key = new URL(base).pathname.slice(1);
  const auth = { authorization: `Bearer ${env.OMP_AUTH_BROKER_TOKEN}` };
  return { instance, logins, base, key, secret: env.OMP_AUTH_BROKER_TOKEN, auth, send: (path, init = {}) => fetch(`${new URL(base).origin}/${key}${path}`, { ...init, headers: { ...auth, ...init.headers } }) };
}

test("env: one loopback listener and one secret, a key per server", async (t) => {
  const instance = startBrokerForwarder({ login: () => null, log: () => {} });
  t.after(() => instance.stop());
  const [first, second] = await Promise.all([instance.env("http://a.example/ompweb"), instance.env("https://b.example")]);
  assert.match(first.OMP_AUTH_BROKER_URL, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+$/);
  assert.deepEqual(Object.keys(first).sort(), ["OMP_AUTH_BROKER_TOKEN", "OMP_AUTH_BROKER_URL"]);
  assert.equal(Buffer.from(new URL(first.OMP_AUTH_BROKER_URL).pathname.slice(1), "base64url").toString(), "http://a.example/ompweb");
  assert.equal(Buffer.from(new URL(second.OMP_AUTH_BROKER_URL).pathname.slice(1), "base64url").toString(), "https://b.example");
  assert.equal(first.OMP_AUTH_BROKER_TOKEN.length, 43);
  assert.match(first.OMP_AUTH_BROKER_TOKEN, /^[A-Za-z0-9_-]+$/);
  assert.equal(new URL(first.OMP_AUTH_BROKER_URL).origin, new URL(second.OMP_AUTH_BROKER_URL).origin);
  assert.equal(first.OMP_AUTH_BROKER_TOKEN, second.OMP_AUTH_BROKER_TOKEN);
  assert.deepEqual(await instance.env("http://a.example/ompweb"), first);
});

test("a request without the secret or with a wrong one is 401 and reaches neither login nor upstream", async (t) => {
  const up = await upstream(t);
  const f = await forwarder(t, { url: up.url, token: "login-token" });
  const origin = new URL(f.base).origin;
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${f.secret.slice(1)}` }, { authorization: `Bearer ${f.secret}x` }, { authorization: f.secret }]) {
    const response = await fetch(`${origin}/${f.key}/v1/snapshot`, { headers });
    assert.equal(response.status, 401, JSON.stringify(headers));
    await response.arrayBuffer();
  }
  assert.deepEqual(f.logins, []);
  assert.deepEqual(up.requests, []);
});

test("forwards to the broker route with the link token, only the allowed headers each way, and the query", async (t) => {
  const body = JSON.stringify({ ok: true });
  const up = await upstream(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: '"v1"', "cache-control": "no-store", vary: "accept", "content-encoding": "gzip", "set-cookie": "a=b", "x-upstream": "1" });
    res.end(gzipSync(body));
  });
  const f = await forwarder(t, { url: up.url, token: "login-token" });
  const response = await f.send("/v1/snapshot?wait=5", {
    headers: { accept: "application/json", "if-none-match": '"v0"', "omp-auth-broker-capabilities": "snapshot", cookie: "session=1", "x-extra": "1" },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("etag"), '"v1"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "accept");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-upstream"), null);
  assert.deepEqual(f.logins, ["http://server.example"]);
  assert.equal(up.requests.length, 1);
  const [seen] = up.requests;
  assert.equal(seen.method, "GET");
  assert.equal(seen.url, "/api/hosts/broker/v1/snapshot?wait=5");
  assert.equal(seen.headers.authorization, "Bearer login-token");
  assert.equal(seen.headers.accept, "application/json");
  assert.equal(seen.headers["if-none-match"], '"v0"');
  assert.equal(seen.headers["omp-auth-broker-capabilities"], "snapshot");
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers["x-extra"], undefined);
  assert.equal(JSON.stringify(seen.headers).includes(f.secret), false, "the secret never leaves the daemon");
});

test("passes the method and body of a write through", async (t) => {
  const up = await upstream(t, (_req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end('{"error":"x"}');
  });
  const f = await forwarder(t, { url: up.url, token: "login-token" });
  const post = await f.send("/v1/credential/3/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
  assert.equal(post.status, 409);
  assert.equal(await post.text(), '{"error":"x"}');
  const del = await f.send("/v1/credential/3/blocks", { method: "DELETE" });
  assert.equal(del.status, 409);
  await del.arrayBuffer();
  assert.deepEqual(up.requests.map(({ method, url, body }) => [method, url, body.toString()]), [
    ["POST", "/api/hosts/broker/v1/credential/3/refresh", '{"a":1}'],
    ["DELETE", "/api/hosts/broker/v1/credential/3/blocks", ""],
  ]);
  assert.equal(up.requests[0].headers["content-type"], "application/json");
});

test("login is read on every request", async (t) => {
  const up = await upstream(t);
  let count = 0;
  const f = await forwarder(t, () => ({ url: up.url, token: `token-${++count}` }));
  for (let index = 0; index < 2; index += 1) await (await f.send("/v1/snapshot")).arrayBuffer();
  assert.deepEqual(up.requests.map((seen) => seen.headers.authorization), ["Bearer token-1", "Bearer token-2"]);
});

test("a server URL with a path prefix and trailing slash keeps its prefix", async (t) => {
  const up = await upstream(t);
  const instance = startBrokerForwarder({ login: (key) => ({ url: key, token: "login-token" }), log: () => {} });
  t.after(() => instance.stop());
  const { OMP_AUTH_BROKER_URL, OMP_AUTH_BROKER_TOKEN } = await instance.env(`${up.url}/ompweb/`);
  await (await fetch(`${OMP_AUTH_BROKER_URL}/v1/healthz`, { headers: { authorization: `Bearer ${OMP_AUTH_BROKER_TOKEN}` } })).arrayBuffer();
  assert.deepEqual(up.requests.map((seen) => seen.url), ["/ompweb/api/hosts/broker/v1/healthz"]);
});

test("no login for the server is 403 and nothing is forwarded", async (t) => {
  const f = await forwarder(t, null);
  const response = await f.send("/v1/snapshot");
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "No credential link for this server" });
  assert.deepEqual(f.logins, ["http://server.example"]);
});

test("a server answer of 400 or above is logged with its status only", async (t) => {
  let status = 403;
  const up = await upstream(t, (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end('{"error":"BODY-SECRET"}');
  });
  const messages = [];
  const instance = startBrokerForwarder({ login: () => ({ url: up.url, token: "login-token" }), log: (message) => messages.push(message) });
  t.after(() => instance.stop());
  const { OMP_AUTH_BROKER_URL, OMP_AUTH_BROKER_TOKEN } = await instance.env(up.url);
  const send = async () => (await fetch(`${OMP_AUTH_BROKER_URL}/v1/snapshot?wait=5`, { headers: { authorization: `Bearer ${OMP_AUTH_BROKER_TOKEN}` } })).text();
  for (status of [403, 503, 200, 304]) await send();
  assert.deepEqual(messages, ["broker forward answered 403", "broker forward answered 503"]);
});

test("an unreachable upstream is 502", async (t) => {
  const gone = createServer();
  await listen(gone);
  const url = `http://127.0.0.1:${gone.address().port}`;
  await closeServer(gone);
  const messages = [];
  const instance = startBrokerForwarder({ login: () => ({ url, token: "login-token" }), log: (message) => messages.push(message) });
  t.after(() => instance.stop());
  const { OMP_AUTH_BROKER_URL, OMP_AUTH_BROKER_TOKEN } = await instance.env(url);
  const response = await fetch(`${OMP_AUTH_BROKER_URL}/v1/snapshot`, { headers: { authorization: `Bearer ${OMP_AUTH_BROKER_TOKEN}` } });
  assert.equal(response.status, 502);
  await response.arrayBuffer();
  assert.equal(messages.join("\n").includes("login-token") || messages.join("\n").includes(OMP_AUTH_BROKER_TOKEN), false);
});

test("a redirect from the upstream is 502 and is never followed", async (t) => {
  const up = await upstream(t, (_req, res) => {
    res.writeHead(302, { location: "/other-app/x" });
    res.end();
  });
  const messages = [];
  const instance = startBrokerForwarder({ login: () => ({ url: up.url, token: "login-token" }), log: (message) => messages.push(message) });
  t.after(() => instance.stop());
  const { OMP_AUTH_BROKER_URL, OMP_AUTH_BROKER_TOKEN } = await instance.env(up.url);
  const response = await fetch(`${OMP_AUTH_BROKER_URL}/v1/snapshot`, { headers: { authorization: `Bearer ${OMP_AUTH_BROKER_TOKEN}` } });
  assert.equal(response.status, 502);
  await response.arrayBuffer();
  // The target would carry the link token to another application on the same origin.
  assert.deepEqual(up.requests.map((seen) => seen.url), ["/api/hosts/broker/v1/snapshot"]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes("login-token") || messages[0].includes(OMP_AUTH_BROKER_TOKEN), false);
});

test("a body over 1 MiB is 413 and reaches no upstream; 1 MiB passes", async (t) => {
  const up = await upstream(t);
  const f = await forwarder(t, { url: up.url, token: "login-token" });
  const over = await f.send("/v1/usage/observed", { method: "POST", body: Buffer.alloc(1_048_576 + 1) });
  assert.equal(over.status, 413);
  await over.arrayBuffer();
  assert.deepEqual(up.requests, []);
  const exact = await f.send("/v1/usage/observed", { method: "POST", body: Buffer.alloc(1_048_576) });
  assert.equal(exact.status, 200);
  await exact.arrayBuffer();
  assert.equal(up.requests[0].body.length, 1_048_576);
});

test("a path that climbs out of the broker route is 404 and reaches no upstream", async (t) => {
  const up = await upstream(t);
  const f = await forwarder(t, { url: `${up.url}/ompweb`, token: "login-token" });
  const origin = new URL(f.base);
  // fetch would normalize the dots itself: send the request line as written.
  const status = (path) => new Promise((resolve, reject) => {
    httpRequest({ host: origin.hostname, port: origin.port, path: `/${f.key}${path}`, headers: f.auth }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject).end();
  });
  for (const path of ["/../../x", "/v1/../../../api/hosts", "/%2e%2e/%2e%2e/x", "/v1/..\\..\\x"]) assert.equal(await status(path), 404, path);
  assert.deepEqual(up.requests, []);
});

test("a response is passed on chunk by chunk and a client that leaves aborts the upstream", async (t) => {
  const closed = deferred();
  let held;
  const up = await upstream(t, (_req, res) => {
    held = res;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write("data: one\n\n");
    res.once("close", closed.resolve);
  });
  const f = await forwarder(t, { url: up.url, token: "login-token" });
  const controller = new AbortController();
  const response = await f.send("/v1/snapshot/stream", { headers: { accept: "text/event-stream" }, signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(up.requests[0].headers.accept, "text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value), "data: one\n\n");
  held.write("data: two\n\n");
  assert.equal(decoder.decode((await reader.read()).value), "data: two\n\n");
  controller.abort();
  await closed.promise;
});

test("stop() ends an open stream and frees the port", async (t) => {
  const up = await upstream(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": keepalive\n\n");
  });
  const f = await forwarder(t, { url: up.url, token: "login-token" });
  const response = await f.send("/v1/snapshot/stream");
  const reader = response.body.getReader();
  await reader.read();
  await f.instance.stop();
  assert.equal((await reader.read().catch(() => ({ done: true }))).done, true);
  await assert.rejects(f.send("/v1/snapshot"));
});

test("stop() before any env() and a second stop() are harmless", async () => {
  const instance = startBrokerForwarder({ login: () => null, log: () => {} });
  await instance.stop();
  await instance.env("http://server.example");
  await instance.stop();
  await instance.stop();
});

test("a server error after it is listening is logged by code, never thrown", async (t) => {
  // The server is not reachable through the interface: catch it as it starts listening.
  const own = Object.getOwnPropertyDescriptor(Server.prototype, "listen");
  const inherited = Server.prototype.listen;
  const bound = [];
  Server.prototype.listen = function (...args) {
    bound.push(this);
    return inherited.apply(this, args);
  };
  const messages = [];
  const instance = startBrokerForwarder({ login: () => null, log: (message) => messages.push(message) });
  t.after(() => instance.stop());
  try {
    await instance.env("http://server.example");
  } finally {
    if (own) Object.defineProperty(Server.prototype, "listen", own);
    else delete Server.prototype.listen;
  }
  assert.equal(bound.length, 1);
  assert.doesNotThrow(() => bound[0].emit("error", Object.assign(new Error("detail that must not be logged"), { code: "EMFILE" })));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /EMFILE/);
  assert.equal(messages[0].includes("detail that must not be logged"), false);
});

function fakeForwarder() {
  const calls = [];
  return { calls, env: async (server) => (calls.push(server), { OMP_AUTH_BROKER_URL: `http://127.0.0.1:1/${server}`, OMP_AUTH_BROKER_TOKEN: "secret" }), stop: async () => {} };
}
const launch = { cwd: "/w", recordedCwd: null, sessionFile: "/s.jsonl", advisor: false };

test("credentialsEnv: no credentialsServer is undefined and nothing else runs", async () => {
  const forwarder = fakeForwarder();
  assert.equal(await credentialsEnv(launch, { forwarder, ompVersion: async () => assert.fail("the version is not read") }), undefined);
  assert.deepEqual(forwarder.calls, []);
});

// omp --version prints "omp/<version>"; one leading "omp/" is dropped before parsing, and the message keeps the text as reported.
for (const [version, found] of [["15.13.0", "15.13.0"], ["omp/15.13.0", "omp/15.13.0"], [null, "unknown"], ["garbage", "garbage"], ["omp/garbage", "omp/garbage"], ["", ""]]) {
  test(`credentialsEnv: omp ${JSON.stringify(version)} is refused and the forwarder is not started`, async () => {
    const forwarder = fakeForwarder();
    await assert.rejects(credentialsEnv({ ...launch, credentialsServer: "http://server.example" }, { forwarder, ompVersion: async () => version }), {
      name: "HostOpError",
      status: 409,
      code: "host_omp_too_old",
      message: `Shared credentials need omp ${MIN_SHARED_CREDENTIALS_OMP} or newer on this host (found ${found})`,
    });
    assert.deepEqual(forwarder.calls, []);
  });
}

for (const version of ["15.13.1", "omp/15.13.1", "18.18.6", "omp/18.18.6"]) {
  test(`credentialsEnv: omp ${version} gets the forwarder's environment`, async () => {
    const forwarder = fakeForwarder();
    assert.deepEqual(await credentialsEnv({ ...launch, credentialsServer: "http://server.example" }, { forwarder, ompVersion: async () => version }), {
      OMP_AUTH_BROKER_URL: "http://127.0.0.1:1/http://server.example",
      OMP_AUTH_BROKER_TOKEN: "secret",
    });
    assert.deepEqual(forwarder.calls, ["http://server.example"]);
  });
}
