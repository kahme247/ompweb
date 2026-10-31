import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
// XDG_DATA_HOME could move the blobs dir out of the temp home (lib/omp/paths.ts).
const UNSET = ["OMP_WEB_PASSWORD_HASH", "OMP_WEB_PASSWORD", "OMP_WEB_TRUSTED_HEADER_SHA256", "XDG_DATA_HOME"];
const saved = Object.fromEntries([...UNSET, ...Object.keys(ENV)].map((name) => [name, process.env[name]]));
for (const name of UNSET) delete process.env[name];
Object.assign(process.env, ENV);
// Imported after the environment is set, so no module sees the real home or agent dir.
const { startServer } = await import("./app");
const server = startServer({ port: 0, hostname: "127.0.0.1", dev: false, root });
const url = (pathname: string) => new URL(pathname, server.url);

/**
 * A request whose target goes on the wire verbatim: fetch() would resolve `..` and `%2e%2e` before sending.
 * `headers` override the defaults; a null value leaves that header out.
 */
function rawRequest(
  method: string,
  target: string,
  headers: Record<string, string | null> = {},
  version = "HTTP/1.1",
): Promise<{ status: number; head: string; body: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; head: string; body: string }>();
  const socket = net.createConnection(server.port!, "127.0.0.1", () => {
    const lines = [`${method} ${target} ${version}`];
    for (const [name, value] of Object.entries({ Host: "127.0.0.1", Connection: "close", "Content-Length": "0", ...headers })) {
      if (value !== null) lines.push(`${name}: ${value}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
  let response = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => (response += chunk));
  socket.on("end", () => {
    const split = response.indexOf("\r\n\r\n");
    resolve({ status: Number(response.slice(9, 12)), head: response.slice(0, split), body: response.slice(split + 4) });
  });
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

// Bun.serve sets SO_REUSEPORT when `development` is false unless `reusePort: false` says otherwise; a second omp-web
// on the same agent dir must fail to start, as it did under Next, instead of sharing the port.
test("a second server on a port this one holds fails with EADDRINUSE", () => {
  assert.throws(() => startServer({ port: server.port!, hostname: "127.0.0.1", dev: false, root }), { code: "EADDRINUSE" });
});

test("server/main.ts on a taken port says so in one line and exits 1", () => {
  const result = spawnSync(process.execPath, [path.join(repo, "server", "main.ts"), "-p", String(server.port), "-H", "127.0.0.1"], {
    env: { ...process.env, OMP_WEB_PACKAGE_DIR: root },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr.trim(), `Port ${server.port} on 127.0.0.1 is already in use: is ompweb already running? Otherwise stop the process using it or start ompweb with --port ${server.port! + 1}.`);
});

test("a malformed or missing Host answers 400, not a 500", async () => {
  // Bun builds request.url from the Host header; HTTP/1.1 without one never reaches the app, HTTP/1.0 does.
  for (const host of ["a b", "[", ""]) assert.equal((await rawRequest("GET", "/api/hosts", { Host: host })).status, 400, host);
  assert.equal((await rawRequest("GET", "/", { Host: null }, "HTTP/1.0")).status, 400);
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

test("an ungated path is the file itself, and an ungated miss never gets the app shell", async (t) => {
  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("pw", { logN: 12 });
  t.after(() => {
    delete process.env.OMP_WEB_PASSWORD_HASH;
  });
  assert.equal((await fetch(url("/icon.svg"))).status, 200);
  for (const pathname of ["/icon.svg/foo", "/sw.js/not-a-file"]) {
    assert.equal((await fetch(url(pathname), { redirect: "manual" })).status, 307, pathname);
  }
  assert.equal((await fetch(url("/assets/missing"))).status, 404);
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
  // The shell is only served rendered (title, manifest link), never as the raw template.
  assert.equal((await fetch(url("/index.html"))).status, 404);
});

test("a trailing slash 308-redirects to the path without it, behind the gate", async (t) => {
  const location = (head: string) => /^location: (.*)$/im.exec(head)?.[1];
  for (const [target, expected] of [
    ["/some/page/?session=x", "/some/page?session=x"],
    ["/api/hosts/", "/api/hosts"],
    ["/icon.svg/", "/icon.svg"],
    // Never a protocol-relative target.
    ["//evil.example/", "/evil.example"],
  ]) {
    const { status, head } = await rawRequest("GET", target);
    assert.equal(status, 308, target);
    assert.equal(location(head), expected, target);
  }
  assert.equal((await rawRequest("GET", "/")).status, 200);

  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("pw", { logN: 12 });
  t.after(() => {
    delete process.env.OMP_WEB_PASSWORD_HASH;
  });
  assert.equal((await rawRequest("GET", "/api/hosts/")).status, 401);
  assert.equal(location((await rawRequest("GET", "/some/page/")).head), "/login");
});

test("each route answers under its own path with decoded params, and the manifest stays gated", async (t) => {
  // A space and a non-ASCII name pin the decoded `[...path]` segments, taken from the right index.
  mkdirSync(path.join(ENV.PI_CODING_AGENT_DIR, "blobs"), { recursive: true });
  const file = path.join(ENV.PI_CODING_AGENT_DIR, "my file é.txt");
  writeFileSync(file, "HELLO");
  const read = await fetch(url(`/api/files${file.split(path.sep).join("/").replace(/^\/?/, "/")}?type=read`));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).content, "HELLO");

  // A `:param` is decoded too: only the decoded hash (`%61` is `a`) names this PNG-signed blob.
  const hash = "a".repeat(64);
  writeFileSync(path.join(ENV.PI_CODING_AGENT_DIR, "blobs", hash), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal((await fetch(url(`/api/media/%61${hash.slice(1)}`))).status, 200);

  // Static segments win over `:id`: agent/new has no GET, and the search streams NDJSON.
  assert.equal((await fetch(url("/api/agent/new"))).status, 405);
  assert.match((await fetch(url("/api/sessions/search?q=x"))).headers.get("content-type") ?? "", /^application\/x-ndjson/);

  // Its link carries credentials (spec invariant 4).
  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("pw", { logN: 12 });
  t.after(() => {
    delete process.env.OMP_WEB_PASSWORD_HASH;
  });
  assert.equal((await fetch(url("/api/manifest"))).status, 401);
});

test("dev pages put the stylesheet before the pre-paint scripts, even when HTTP_PROXY points nowhere", async (t) => {
  // The dev shell comes from Bun's HTML bundle over loopback, which must not go through the proxy.
  const saved = Object.fromEntries(["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"].map((name) => [name, process.env[name]]));
  writeFileSync(path.join(root, "dev.css"), "body { color: red; }");
  writeFileSync(
    path.join(root, "dev.html"),
    '<!doctype html><html><head><title>omp web</title><script>void 0</script><link rel="stylesheet" href="./dev.css" /></head><body></body></html>',
  );
  // A file written at run time, so no static import; Bun turns it into an HTML bundle as dev.ts's import does.
  const { default: html } = await import(path.join(root, "dev.html"));
  const dev = startServer({ port: 0, hostname: "127.0.0.1", dev: true, root, html });
  Object.assign(process.env, { HTTP_PROXY: "http://127.0.0.1:9", http_proxy: "http://127.0.0.1:9" });
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await dev.stop(true);
  });
  const page = await fetch(new URL("/", dev.url), { proxy: false });
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<link rel="manifest" href="\/api\/manifest"/);
  // Bun moves the stylesheet after the inline scripts; the theme script reads --bg from it.
  assert.ok(body.indexOf('<link rel="stylesheet"') < body.indexOf("<script>void 0</script>"), body);
});

/** Sends `head` (request line and headers) and nothing more; resolves once the server hangs up. */
function stall(head: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const socket = net.createConnection(server.port!, "127.0.0.1", () => socket.write(`${head}\r\nHost: 127.0.0.1\r\n\r\n`));
  socket.resume();
  socket.on("close", () => resolve());
  socket.on("error", () => {});
  return promise;
}

test("Bun's idle timeout spares the event stream, the browser socket and the host link, and only them", { timeout: 30_000 }, async (t) => {
  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("pw", { logN: 12 });
  process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = new Bun.CryptoHasher("sha256").update("trusted").digest("hex");
  t.after(() => {
    delete process.env.OMP_WEB_PASSWORD_HASH;
    delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  });
  const signedIn = { "x-omp-web-auth": "trusted" };
  const controller = new AbortController();
  const stream = await fetch(url("/api/events"), { headers: signedIn, signal: controller.signal });
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const hello = decoder.decode((await reader.read()).value);
    const connectionId = /"connectionId":"([^"]+)"/.exec(hello)?.[1];
    assert.ok(connectionId, hello);

    // A host daemon's link: a WebSocket whose hello gets a welcome, and which the hub pings 15 s after it opens.
    const created = await fetch(url("/api/hosts"), { method: "POST", headers: signedIn, body: JSON.stringify({ label: "box" }) });
    const bearer = { authorization: `Bearer ${(await created.json()).token}` };
    const hostHello = { type: "hello", v: 4, ompVersion: "14.0.0", platform: "linux", home: "/home/u", autoApproveExtension: false, ack: 0, channels: [] };
    // This repo's DOM typing has no init argument; Bun's WebSocket takes `{ headers }`.
    const link = new WebSocket(url("/api/hosts/link").href.replace(/^http/, "ws"), { headers: bearer } as unknown as string[]);
    t.after(() => link.close());
    const welcome = Promise.withResolvers<string>();
    link.addEventListener("message", ({ data }) => welcome.resolve(String(data)), { once: true });
    link.onopen = () => link.send(JSON.stringify(hostHello));
    assert.match(await welcome.promise, /"type":"welcome"/);
    const ping = Promise.withResolvers<void>();
    link.addEventListener("message", ({ data }) => String(data).includes('"type":"ping"') && ping.resolve());
    link.addEventListener("close", ({ code }) => ping.reject(new Error(`the host link was closed while idle (${code})`)));

    // The browser's WebSocket transport: a hello on open, and the server's own ping every WS_HEARTBEAT_MS (10 s).
    const browser = new WebSocket(url("/api/events/ws").href.replace(/^http/, "ws"), { headers: signedIn } as unknown as string[]);
    t.after(() => browser.close());
    const browserFrames: string[] = [];
    let browserFrame = Promise.withResolvers<void>();
    browser.addEventListener("message", ({ data }) => {
      browserFrames.push(String(data));
      browserFrame.resolve();
    });
    const browserFrameMatching = async (pattern: RegExp) => {
      while (!browserFrames.some((frame) => pattern.test(frame))) {
        browserFrame = Promise.withResolvers<void>();
        await browserFrame.promise;
      }
    };
    await browserFrameMatching(/^mux \d+\n\{"type":"hello"/);

    // No caller without a session or a host token holds a socket open, wherever it stalls, and a signed-in
    // keep-alive socket is closed once its JSON answer, or a stream that lifted the timeout, went out.
    const stalled = {
      gated: stall("POST /api/hosts HTTP/1.1\r\nContent-Length: 100"),
      signIn: stall("POST /api/web-auth/session HTTP/1.1\r\nContent-Length: 100"),
      link: stall("POST /api/hosts/link HTTP/1.1\r\nAuthorization: Bearer nope\r\nContent-Length: 100"),
      page: stall("GET /login HTTP/1.1"),
      keptAlive: stall("GET /api/hosts HTTP/1.1\r\nx-omp-web-auth: trusted"),
      keptAliveStream: stall("GET /api/sessions/search?q=x HTTP/1.1\r\nx-omp-web-auth: trusted"),
    };
    // Real waits: Bun.serve's native idle timer (10 s, checked every 4 s) cannot be faked. The 20 s deadline only
    // names a socket that never closes.
    const open = new Set(Object.keys(stalled));
    await Promise.race([
      Promise.all(Object.entries(stalled).map(([name, closed]) => closed.then(() => open.delete(name)))),
      Bun.sleep(20_000),
    ]);
    assert.deepEqual([...open], []);

    // The ping proves the socket outlived the idle timeout; so has the event stream, opened before it. The link's
    // ping comes 15 s after it opened, so the browser socket, opened just after it, has had its 10 s ping by now.
    await ping.promise;
    assert.equal(link.readyState, WebSocket.OPEN);
    assert.equal(browser.readyState, WebSocket.OPEN, "the browser socket was closed while idle");
    assert.ok(browserFrames.some((frame) => /^ping \d+\n\{\}$/.test(frame)), `no server ping while idle: ${browserFrames.join(" | ")}`);
    browser.send(JSON.stringify({ t: "sub", id: "s1", channel: { kind: "hosts" } }));
    await browserFrameMatching(/^mux \d+\n\{"type":"open","sub":"s1"\}$/);
    const subscribe = await fetch(url("/api/events"), {
      method: "POST",
      headers: { ...signedIn, "content-type": "application/json" },
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

test("the host link and the browser socket refuse an unauthenticated upgrade with 401 and answer 426 to a request that does not upgrade", async (t) => {
  const created = await fetch(url("/api/hosts"), { method: "POST", body: JSON.stringify({ label: "refusing" }) });
  const bearer = { authorization: `Bearer ${(await created.json()).token}` };
  process.env.OMP_WEB_PASSWORD_HASH = hashPassword("pw", { logN: 12 });
  process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = new Bun.CryptoHasher("sha256").update("trusted").digest("hex");
  t.after(() => {
    delete process.env.OMP_WEB_PASSWORD_HASH;
    delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  });

  // The gate runs before the upgrade route: no session, or a foreign origin, never reaches the 426.
  const signedIn = { "x-omp-web-auth": "trusted" };
  assert.equal((await fetch(url("/api/events/ws"))).status, 401);
  assert.equal((await fetch(url("/api/events/ws"), { headers: { ...signedIn, origin: "http://evil.example" } })).status, 403);
  assert.equal((await fetch(url("/api/events/ws"), { headers: signedIn })).status, 426);

  const refused = new WebSocket(url("/api/hosts/link").href.replace(/^http/, "ws"));
  const events: string[] = [];
  refused.onopen = () => events.push("open");
  refused.onerror = (event) => events.push(`error ${(event as ErrorEvent).message}`);
  const closed = Promise.withResolvers<void>();
  refused.onclose = () => closed.resolve();
  await closed.promise;
  assert.equal(events.length, 1, events.join(" | "));
  assert.match(events[0], /^error .*\b401\b/);

  assert.equal((await fetch(url("/api/hosts/link"), { headers: bearer })).status, 426);
  const hostHello = { type: "hello", v: 3, ompVersion: "14.0.0", platform: "linux", home: "/home/u", autoApproveExtension: false, ack: 0, channels: [] };
  const outdated = await fetch(url("/api/hosts/link"), { method: "POST", headers: bearer, body: JSON.stringify(hostHello) });
  assert.equal(outdated.status, 426);
  assert.equal((await outdated.json()).hostVersion, 3);
});
