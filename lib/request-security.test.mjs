import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./request-security.ts");
}

test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { origin: "http://localhost:30141", "sec-fetch-site": "same-origin" },
  })), true);
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", { method: "POST" })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestOriginAllowed(request), true);
});

test("allows a matching Origin even when Sec-Fetch-Site is cross-site", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  assert.equal(isApiRequestOriginAllowed(new Request("http://localhost:30141/api/test", {
    headers: { origin: "http://localhost:30141", "sec-fetch-site": "cross-site" },
  })), true);
});

test("allows an origin whose port was stripped by a local proxy", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  // Regression test for issue #114: proxies forward loopback requests with
  // the Origin port stripped (`http://127.0.0.1:30177` -> `http://127.0.0.1`).
  const stripped = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "127.0.0.1:30177", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" },
  });
  assert.equal(isApiRequestOriginAllowed(stripped), true);
});

test("still rejects a same-host origin on a different explicit port", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  // Only the default-port (stripped) shape is tolerated: a page served from
  // another explicit port on the same host stays cross-origin.
  const otherPort = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "127.0.0.1:30177", origin: "http://127.0.0.1:9999", "sec-fetch-site": "cross-site" },
  });
  assert.equal(isApiRequestOriginAllowed(otherPort), false);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestOriginAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestOriginAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestOriginAllowed(crossSiteGet), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestOriginAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestOriginAllowed(request), false);
});
