import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  const compressed = finalize("/api/sessions", Response.json(JSON.parse(json)), gzip);
  assert.equal(compressed.headers.get("content-encoding"), "gzip");
  assert.equal(compressed.headers.get("vary"), "accept-encoding");
  assert.equal(compressed.headers.get("content-length"), null);
  assert.equal(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer()))), json);

  const skipped = [
    finalize("/api/events", new Response(json, { headers: { "content-type": "text/event-stream" } }), gzip),
    finalize("/api/files/a.txt", new Response(json, { status: 206, headers: { "content-type": "text/plain" } }), gzip),
    finalize("/api/sessions", Response.json(JSON.parse(json))),
  ];
  for (const response of skipped) assert.equal(response.headers.get("content-encoding"), null);
});

test("serveFile refuses traversal and sets the cache policy", async () => {
  const get = (pathname: string) => serveFile(new Request(`http://localhost${pathname}`), root, false);
  for (const pathname of ["/..%2Fpackage.json", "/%2e%2e/package.json", "/assets/..%5C..%5Cpackage.json", "/sw.js%00", "/katex/..%2F..%2Fpackage.json"]) {
    assert.equal(await get(pathname), null, pathname);
  }
  assert.equal((await get("/sw.js"))?.headers.get("cache-control"), "no-cache");
  assert.equal((await get("/icon.svg"))?.headers.get("cache-control"), "public, max-age=0");
  assert.equal((await get("/favicon.ico"))?.headers.get("cache-control"), "public, max-age=0");
  assert.equal((await get("/katex/katex.min.css"))?.headers.get("cache-control"), "public, max-age=0");
  assert.equal(await get("/"), null);
  assert.equal(await get("/assets"), null);
});

test("serveFile sends Last-Modified and answers a matching If-Modified-Since with 304", async () => {
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
  // RFC 9110: only GET and HEAD are conditional on If-Modified-Since.
  assert.equal((await get({ "if-modified-since": lastModified }, "POST"))?.status, 200);
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
