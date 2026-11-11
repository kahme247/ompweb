import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "auth-broker-"));
const oldBin = process.env.OMP_WEB_OMP_BIN;

// Fake `omp`: `auth-broker token` prints tok-N (N from a counter file); `auth-broker serve` logs its pid to a
// starts file, listens on port 0 and prints the listening line. Files live in $FAKE_BROKER_DIR, set per test; a
// `token-fails`, `serve-exits` or `serve-silent` file there makes that step fail.
const source = `const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dir = process.env.FAKE_BROKER_DIR;
const [group, command] = process.argv.slice(2);
if (group !== "auth-broker") process.exit(2);
if (command === "token") {
  if (fs.existsSync(path.join(dir, "token-fails"))) process.exit(3);
  const counter = path.join(dir, "counter");
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0) + 1;
  fs.writeFileSync(counter, String(n));
  console.log("tok-" + n);
} else if (command === "serve") {
  fs.appendFileSync(path.join(dir, "starts"), process.pid + "\\n");
  if (fs.existsSync(path.join(dir, "serve-exits"))) process.exit(4);
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/echo") res.end(String(req.headers.authorization));
    else if (req.url === "/v1/stream") { res.writeHead(200, { "content-type": "text/plain" }); res.write("chunk\\n"); }
    else if (req.url === "/v1/deny") { res.writeHead(401); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1", () => {
    if (fs.existsSync(path.join(dir, "serve-silent"))) return;
    console.log("warming up");
    console.log(JSON.stringify({ message: "booting" }));
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", pid: process.pid, message: "auth-broker listening", url: "http://127.0.0.1:" + server.address().port }));
  });
}
`;
const fakeOmp = join(scratch, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
if (process.platform === "win32") {
  // Windows cannot spawn a shebang script: a .cmd launcher, which wrapWindowsScript routes through cmd.exe.
  writeFileSync(`${fakeOmp}.cjs`, source);
  writeFileSync(fakeOmp, `@"${process.execPath.replaceAll("%", "%%")}" "${fakeOmp.replaceAll("%", "%%")}.cjs" %*\r\n`);
} else writeFileSync(fakeOmp, `#!${process.execPath}\n${source}`, { mode: 0o755 });
process.env.OMP_WEB_OMP_BIN = fakeOmp;

const { AUTH_BROKER_TIMINGS, AuthBrokerUnavailableError, abortBrokerRequests, brokerFetch, disposeAuthBroker } = await import("./auth-broker.ts");
const defaultTimings = { ...AUTH_BROKER_TIMINGS };

test.after(() => {
  if (oldBin === undefined) delete process.env.OMP_WEB_OMP_BIN; else process.env.OMP_WEB_OMP_BIN = oldBin;
  rmSync(scratch, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("auth broker test timeout");
    await sleep(10);
  }
}
let dir;
const starts = () => (existsSync(join(dir, "starts")) ? readFileSync(join(dir, "starts"), "utf8").split("\n").filter(Boolean).map(Number) : []);
const get = (hostId, path) => brokerFetch(hostId, path, { method: "GET", headers: new Headers(), signal: new AbortController().signal });

/** A test with its own counter and starts files; afterwards the broker and every child it started are gone. */
function scenario(name, run) {
  test(name, async () => {
    dir = mkdtempSync(join(scratch, "case-"));
    process.env.FAKE_BROKER_DIR = dir;
    try {
      await run();
    } finally {
      Object.assign(AUTH_BROKER_TIMINGS, defaultTimings);
      disposeAuthBroker();
      await until(() => starts().every((pid) => !alive(pid)));
    }
  });
}

scenario("starts once for concurrent calls", async () => {
  assert.equal(starts().length, 0);
  const [a, b] = await Promise.all([get("h1", "/v1/echo"), get("h1", "/v1/echo")]);
  assert.equal(await a.text(), "Bearer tok-1");
  assert.equal(await b.text(), "Bearer tok-1");
  assert.equal(starts().length, 1);
});

scenario("stays up while a stream is open, stops when idle", async () => {
  AUTH_BROKER_TIMINGS.idleMs = 50;
  const response = await get("h1", "/v1/stream");
  const reader = response.body.getReader();
  await reader.read();
  const [pid] = starts();
  await sleep(200);
  assert.ok(alive(pid), "child must outlive the idle timeout while a stream is open");
  await reader.cancel();
  await until(() => !alive(pid), 1000);
});

scenario("aborts only the named host", async () => {
  const readers = [];
  for (const hostId of ["h1", "h2"]) {
    const reader = (await get(hostId, "/v1/stream")).body.getReader();
    await reader.read();
    readers.push(reader);
  }
  const [next1, next2] = readers.map((reader) => reader.read());
  next2.catch(() => {});
  abortBrokerRequests("h1");
  await assert.rejects(next1);
  const state = await Promise.race([next2.then(() => "settled", () => "settled"), sleep(200).then(() => "reading")]);
  assert.equal(state, "reading");
  await readers[1].cancel();
});

scenario("restarts after the broker refuses its token", async () => {
  await assert.rejects(get("h1", "/v1/deny"), (error) => error instanceof AuthBrokerUnavailableError && error.reason === "refused_token");
  const [first] = starts();
  await until(() => !alive(first), 1000);
  const response = await get("h1", "/v1/echo");
  assert.equal(await response.text(), "Bearer tok-2");
  assert.equal(starts().length, 2);
});

scenario("restarts after the child exits", async () => {
  await (await get("h1", "/v1/echo")).text();
  const [pid] = starts();
  process.kill(pid, "SIGKILL");
  await until(() => !alive(pid));
  const response = await get("h1", "/v1/echo");
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(starts().length, 2);
});

scenario("a failed start names its reason", async () => {
  AUTH_BROKER_TIMINGS.readyMs = 1000;
  const reason = () => get("h1", "/v1/echo").then(
    () => assert.fail("the broker started"),
    (error) => { assert.ok(error instanceof AuthBrokerUnavailableError); return error.reason; },
  );
  for (const [flag, expected] of [["token-fails", "token_command_failed"], ["serve-exits", "exited"], ["serve-silent", "not_ready"]]) {
    writeFileSync(join(dir, flag), "");
    assert.equal(await reason(), expected, flag);
    rmSync(join(dir, flag));
  }
});
