import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { hashPassword } from "@/lib/web-password-hash";

const repo = path.join(import.meta.dir, "..");
const root = mkdtempSync(path.join(os.tmpdir(), "omp-web-app-"));
const home = path.join(root, "home");
mkdirSync(path.join(root, "dist"));
mkdirSync(home);
writeFileSync(path.join(root, "dist", "index.html"), "<!doctype html><html><head><title>omp web</title></head><body></body></html>");
// "junction" needs no admin rights on Windows and is ignored elsewhere.
for (const dir of ["public", "node_modules"]) symlinkSync(path.join(repo, dir), path.join(root, dir), "junction");

const ENV = { HOME: home, PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"), OMP_WEB_OMP_BIN: "/nonexistent/omp" };
const saved = Object.fromEntries(["OMP_WEB_PASSWORD_HASH", "OMP_WEB_PASSWORD", ...Object.keys(ENV)].map((name) => [name, process.env[name]]));
delete process.env.OMP_WEB_PASSWORD_HASH;
delete process.env.OMP_WEB_PASSWORD;
Object.assign(process.env, ENV);
// Imported after the environment is set, so no module sees the real home or agent dir.
const { startServer } = await import("./app");
const server = startServer({ port: 0, hostname: "127.0.0.1", dev: false, root });
const url = (pathname: string) => new URL(pathname, server.url);

/** A request whose target goes on the wire verbatim: fetch() would resolve `..` and `%2e%2e` before sending. */
function rawRequest(method: string, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
  const socket = net.createConnection(server.port!, "127.0.0.1", () => {
    const lines = [`${method} ${target} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", "Content-Length: 0"];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
  let response = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => (response += chunk));
  socket.on("end", () => resolve({ status: Number(response.slice(9, 12)), body: response.slice(response.indexOf("\r\n\r\n") + 4) }));
  socket.on("error", reject);
  return promise;
}

after(async () => {
  await server.stop(true);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("API routes answer through the gate", async () => {
  const hosts = await fetch(url("/api/hosts"));
  assert.equal(hosts.status, 200);
  assert.ok(Array.isArray((await hosts.json()).hosts));
  assert.equal(hosts.headers.get("x-frame-options"), "DENY");

  const crossOrigin = await fetch(url("/api/hosts"), { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" });
  assert.equal(crossOrigin.status, 403);

  assert.equal((await fetch(url("/api/nope"))).status, 404);
  assert.equal((await fetch(url("/api/sessions/%E0%A4%A/state"))).status, 400);
  assert.equal((await fetch(url("/api"))).status, 404);
});

test("a path that leaves its route after `..` resolution never reaches that route's handler", async (t) => {
  // The files route serves anything under the agent dir; `x` pads `/assets/x` to the route's `/api/files` depth.
  const secret = path.join(ENV.PI_CODING_AGENT_DIR, "secret.txt");
  mkdirSync(ENV.PI_CODING_AGENT_DIR, { recursive: true });
  writeFileSync(secret, "TOP-SECRET");
  const file = secret.split(path.sep).join("/").replace(/^\/?/, "/");
  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("pw", { logN: 12 });
  t.after(() => {
    delete process.env.OMP_WEB_PASSWORD_HASH;
  });

  assert.equal((await rawRequest("GET", `/api/files${file}?type=read`)).status, 401);
  for (const target of [
    `/api/files/../../assets/x${file}?type=read`,
    `/api/files/%2e%2e/%2e%2e/assets/x${file}?type=read`,
    `/api/files/.%2e/%2e./assets/x${file}?type=read`,
  ]) {
    const { status, body } = await rawRequest("GET", target);
    assert.equal(status, 404, target);
    assert.doesNotMatch(body, /TOP-SECRET/, target);
  }
  // An encoded slash is not a separator, so this stays in the files route and its gate.
  assert.equal((await rawRequest("GET", `/api/files/..%2f..%2fassets/x${file}?type=read`)).status, 401);
  assert.equal((await rawRequest("GET", "/assets/../api/hosts")).status, 401);

  // The origin check reads the same resolved path: the upload handler is never reached cross-origin.
  const evil = { Origin: "https://evil.example" };
  assert.equal((await rawRequest("POST", `/api/files/../../assets/x${path.posix.dirname(file)}`, evil)).status, 404);
  assert.equal((await rawRequest("POST", "/api/files/../hosts", evil)).status, 403);
});

test("pages get the index, files their content, and anything else 404", async () => {
  const index = await fetch(url("/"));
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(index.headers.get("cache-control"), "private, no-cache, max-age=0, must-revalidate");
  assert.match(await index.text(), /<link rel="manifest" href="\/api\/manifest" crossorigin="use-credentials"><\/head>/);

  const page = await fetch(url("/some/page"));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "private, no-cache, max-age=0, must-revalidate");
  assert.match(await page.text(), /<title>omp web<\/title>/);
  assert.equal((await fetch(url("/missing.js"))).status, 404);
  assert.equal((await fetch(url("/sw.js"))).headers.get("cache-control"), "no-cache");
  assert.equal((await fetch(url("/icon.svg"))).status, 200);
  assert.equal((await fetch(url("/katex/katex.min.css"))).status, 200);
  assert.equal((await fetch(url("/..%2Fpackage.json"))).status, 404);
});

test("the event stream outlives Bun's 10 s default idle timeout", { timeout: 25_000 }, async () => {
  const controller = new AbortController();
  const stream = await fetch(url("/api/events"), { signal: controller.signal });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const hello = decoder.decode((await reader.read()).value);
    const connectionId = /"connectionId":"([^"]+)"/.exec(hello)?.[1];
    assert.ok(connectionId, hello);

    // A real idle gap: Bun.serve's native idle timer cannot be faked.
    await Bun.sleep(12_000);
    const subscribe = await fetch(url("/api/events"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId, subscribe: { id: "s1", channel: { kind: "hosts" } } }),
    });
    assert.equal(subscribe.status, 200);
    const next = await reader.read();
    assert.equal(next.done, false, "the stream was closed while idle");
    assert.match(decoder.decode(next.value), /"sub":"s1"/);
  } finally {
    controller.abort();
  }
});
