import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeResponse, renderIndex, serveFile } from "./http";

const root = path.join(import.meta.dir, "..");
const CSP = "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: wss:; font-src 'self' data:; media-src 'self' blob:";

const finalize = (pathname: string, response: Response, headers: Record<string, string> = {}) =>
  finalizeResponse(new Request(`http://localhost${pathname}`, { headers }), response);

test("every path except /api/files/* gets the global security headers", () => {
  for (const pathname of ["/", "/login", "/api/file-index", "/api/sessions", "/api/files", "/assets/x.js"]) {
    const { headers } = finalize(pathname, new Response("x"));
    assert.equal(headers.get("content-security-policy"), CSP, pathname);
    assert.equal(headers.get("x-frame-options"), "DENY", pathname);
    assert.equal(headers.get("x-content-type-options"), "nosniff", pathname);
    assert.equal(headers.get("referrer-policy"), "no-referrer", pathname);
    assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(self), geolocation=()", pathname);
  }
});

test("file responses keep the handler's document policy", () => {
  for (const pathname of [
    "/api/files/home/user/project/logo.svg",
    "/api/files/home/user/project/docs/report.docx",
    "/api/files/C%3A/Users/me/project/logo.svg",
  ]) {
    assert.equal(finalize(pathname, new Response("x")).headers.get("content-security-policy"), null, pathname);
    const { headers } = finalize(pathname, new Response("x", { headers: { "Content-Security-Policy": "sandbox" } }));
    assert.equal(headers.get("content-security-policy"), "sandbox", pathname);
    // The app frames its own DOCX/PDF previews; DENY would block them.
    assert.equal(headers.get("x-frame-options"), "SAMEORIGIN", pathname);
    assert.equal(headers.get("x-content-type-options"), "nosniff", pathname);
    assert.equal(headers.get("referrer-policy"), "no-referrer", pathname);
    assert.equal(headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()", pathname);
  }
});

test("a config header overwrites the handler's, and redirects pass", () => {
  const framed = finalize("/api/hosts", new Response("x", { headers: { "X-Frame-Options": "SAMEORIGIN" } }));
  assert.equal(framed.headers.get("x-frame-options"), "DENY");
  const redirect = finalize("/", Response.redirect("http://localhost/login", 307));
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("location"), "http://localhost/login");
  assert.equal(redirect.headers.get("cache-control"), "private, no-cache, max-age=0, must-revalidate");
});

test("gzip applies to compressible 200 responses only", async () => {
  const gzip = { "accept-encoding": "gzip, deflate, br" };
  const json = JSON.stringify({ text: "x".repeat(2048) });
  const compressed = finalize("/assets/x.json", Response.json(JSON.parse(json)), gzip);
  assert.equal(compressed.headers.get("content-encoding"), "gzip");
  assert.equal(compressed.headers.get("vary"), "accept-encoding");
  assert.equal(compressed.headers.get("content-length"), null);
  assert.equal(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer()))), json);
  // An existing Vary keeps its names.
  const varied = finalize("/assets/x.json", Response.json(JSON.parse(json), { headers: { vary: "Origin" } }), gzip);
  assert.equal(varied.headers.get("vary"), "Origin, accept-encoding");
  assert.equal(finalize("/assets/x.json", Response.json(JSON.parse(json), { headers: { vary: "Accept-Encoding" } }), gzip).headers.get("vary"), "Accept-Encoding");
  assert.equal(finalize("/assets/x.json", Response.json(JSON.parse(json)), { "accept-encoding": "br;q=1, GZIP;q=0.5" }).headers.get("content-encoding"), "gzip");

  const skipped = [
    finalize("/assets/x.json", new Response(json, { headers: { "content-type": "text/event-stream" } }), gzip),
    finalize("/assets/x.txt", new Response(json, { status: 206, headers: { "content-type": "text/plain" } }), gzip),
    finalize("/assets/x.json", Response.json(JSON.parse(json))),
    // q=0 means "not acceptable" (RFC 9110).
    finalize("/assets/x.json", Response.json(JSON.parse(json)), { "accept-encoding": "gzip;q=0, identity" }),
    finalize("/assets/x.json", Response.json(JSON.parse(json)), { "accept-encoding": "gzip; q=0.000" }),
    finalize("/assets/x.json", Response.json(JSON.parse(json)), { "accept-encoding": "x-gzipped" }),
  ];
  for (const response of skipped) assert.equal(response.headers.get("content-encoding"), null);
});

// As under Next: gzipping a 40 MB session read cost ~1 s per request on loopback. A reverse proxy can compress API traffic.
test("API answers are never gzipped, whatever the client accepts", async () => {
  const json = JSON.stringify({ text: "x".repeat(2048) });
  for (const [pathname, response] of [
    ["/api/sessions", Response.json(JSON.parse(json))],
    ["/api/files/a.txt", new Response(json, { headers: { "content-type": "text/plain" } })],
  ] as const) {
    const answer = finalize(pathname, response, { "accept-encoding": "gzip, deflate, br" });
    assert.equal(answer.headers.get("content-encoding"), null, pathname);
    assert.equal(await answer.text(), json, pathname);
  }
});

test("serveFile refuses traversal and sets the cache policy", async () => {
  const get = (pathname: string) => serveFile(new Request(`http://localhost${pathname}`), root, false);
  for (const pathname of [
    "/..%2Fpackage.json",
    "/%2e%2e/package.json",
    "/assets/..%5C..%5Cpackage.json",
    "/sw.js%00",
    "/katex/..%2F..%2Fpackage.json",
    "//etc/passwd",
    "/katex//etc/passwd",
  ]) {
    assert.equal(await get(pathname), null, pathname);
  }
  assert.equal((await get("/sw.js"))?.headers.get("cache-control"), "no-cache");
  assert.equal((await get("/icon.svg"))?.headers.get("cache-control"), "public, max-age=0");
  assert.equal((await get("/favicon.ico"))?.headers.get("cache-control"), "public, max-age=0");
  assert.equal((await get("/katex/katex.min.css"))?.headers.get("cache-control"), "public, max-age=0");
  assert.equal(await get("/"), null);
  assert.equal(await get("/assets"), null);
});

test("serveFile never follows a symlink out of its directory", { skip: process.platform === "win32" }, async (t) => {
  const packageDir = mkdtempSync(path.join(os.tmpdir(), "omp-web-serve-link-"));
  t.after(() => rmSync(packageDir, { recursive: true, force: true }));
  const outside = path.join(packageDir, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
  mkdirSync(path.join(packageDir, "public"));
  writeFileSync(path.join(packageDir, "public", "inside.txt"), "ok");
  symlinkSync(path.join(outside, "secret.txt"), path.join(packageDir, "public", "leak.txt"));
  symlinkSync(outside, path.join(packageDir, "public", "outdir"));
  symlinkSync(path.join(packageDir, "public", "inside.txt"), path.join(packageDir, "public", "alias.txt"));
  const get = (pathname: string) => serveFile(new Request(`http://localhost${pathname}`), packageDir, true);
  assert.equal(await get("/leak.txt"), null);
  assert.equal(await get("/outdir/secret.txt"), null);
  assert.equal(await (await get("/alias.txt"))?.text(), "ok", "a link that stays inside is served");
});

test("serveFile sends Last-Modified and a weak ETag, and answers a match with 304", async () => {
  const get = (headers: Record<string, string> = {}, method = "GET") =>
    serveFile(new Request("http://localhost/icon.svg", { method, headers }), root, false);
  const lastModified = (await get())?.headers.get("last-modified");
  assert.ok(lastModified);
  const notModified = await get({ "if-modified-since": lastModified });
  assert.equal(notModified?.status, 304);
  assert.equal(notModified?.body, null);
  assert.equal(notModified?.headers.get("cache-control"), "public, max-age=0");
  const older = new Date(Date.parse(lastModified) - 1000).toUTCString();
  assert.equal((await get({ "if-modified-since": older }))?.status, 200);
  assert.equal((await get({ "if-modified-since": "garbage" }))?.status, 200);
  const etag = (await get())?.headers.get("etag");
  assert.match(etag ?? "", /^W\/"\d+-[\d.]+"$/);
  assert.equal((await get({ "if-none-match": etag! }))?.status, 304);
  assert.equal((await get({ "if-none-match": `"x", ${etag!.slice(2)}` }))?.status, 304, "weak comparison, in a list");
  // If-None-Match wins over If-Modified-Since: the Nix store gives every file the same mtime across releases.
  assert.equal((await get({ "if-none-match": 'W/"0-0"', "if-modified-since": lastModified }))?.status, 200);
  // RFC 9110: only GET and HEAD are conditional on If-Modified-Since; a static file takes no other method.
  const post = await get({ "if-modified-since": lastModified }, "POST");
  assert.equal(post?.status, 405);
  assert.equal(post?.headers.get("allow"), "GET, HEAD");
  assert.equal((await get({}, "DELETE"))?.status, 405);
  assert.equal((await get({}, "HEAD"))?.status, 200);
});

test("serveFile marks hashed assets immutable", async () => {
  const packageDir = mkdtempSync(path.join(os.tmpdir(), "omp-web-serve-file-"));
  try {
    await Bun.write(path.join(packageDir, "dist", "assets", "app-1234.js"), "x");
    const response = await serveFile(new Request("http://localhost/assets/app-1234.js"), packageDir, false);
    assert.equal(response?.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await serveFile(new Request("http://localhost/assets/app-1234.js"), packageDir, true), null, "dev never reads dist/");
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("serveFile skips a missing directory and serves from it once it exists", async (t) => {
  const packageDir = mkdtempSync(path.join(os.tmpdir(), "omp-web-serve-missing-"));
  t.after(() => rmSync(packageDir, { recursive: true, force: true }));
  const get = () => serveFile(new Request("http://localhost/late.txt"), packageDir, false);
  assert.equal(await get(), null);
  await Bun.write(path.join(packageDir, "public", "late.txt"), "ok");
  assert.equal(await (await get())?.text(), "ok");
});

test("serveFile follows a static directory swapped while it runs", async (t) => {
  // A release swapped in place: public/ is a link (a junction on Windows) that moves to a new directory.
  const packageDir = mkdtempSync(path.join(os.tmpdir(), "omp-web-serve-swap-"));
  t.after(() => rmSync(packageDir, { recursive: true, force: true }));
  for (const release of ["old", "new"]) await Bun.write(path.join(packageDir, release, "page.txt"), release);
  const link = path.join(packageDir, "public");
  const get = async () => (await serveFile(new Request("http://localhost/page.txt"), packageDir, false))?.text();
  symlinkSync(path.join(packageDir, "old"), link, "junction");
  assert.equal(await get(), "old");
  rmSync(link);
  symlinkSync(path.join(packageDir, "new"), link, "junction");
  assert.equal(await get(), "new");
});

test("renderIndex escapes the install name into the titles and adds the manifest link", () => {
  const html = '<html><head><title>omp web</title><meta name="apple-mobile-web-app-title" content="omp web" /></head><body></body></html>';
  const previous = process.env.OMP_WEB_NAME;
  process.env.OMP_WEB_NAME = "<script>";
  try {
    const rendered = renderIndex(html, new Request("http://localhost/"));
    assert.match(rendered, /<title>&lt;script&gt;<\/title>/);
    assert.match(rendered, /<meta name="apple-mobile-web-app-title" content="&lt;script&gt;"/);
    assert.match(rendered, /<link rel="manifest" href="\/api\/manifest" crossorigin="use-credentials"><\/head>/);
  } finally {
    if (previous === undefined) delete process.env.OMP_WEB_NAME;
    else process.env.OMP_WEB_NAME = previous;
  }
});

test("renderIndex puts the remembered theme color into the manifest link, and nothing else", () => {
  const link = (cookie: string) => /<link rel="manifest" href="([^"]*)"/.exec(renderIndex("<head></head>", new Request("http://localhost/", { headers: { cookie } })))?.[1];
  // Chrome refreshes an installed app's manifest without cookies, so the color has to be in the link.
  assert.equal(link("a=1; omp-theme-color=F2F0EA"), "/api/manifest?theme=F2F0EA");
  for (const value of ["zzzzzz", "%22%3E%3Cscript%3E", "abcdef0"]) assert.equal(link(`omp-theme-color=${value}`), "/api/manifest", value);
});
