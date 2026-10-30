import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { NextRequest } = await import("next/server.js");
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server.js");
const {
  createWebSession,
  isValidWebPassword,
  isValidWebSession,
  isWebPasswordEnabled,
  webPasswordConfigurationProblem,
} = await import("./web-auth.ts");
const { hashPassword } = await import("./web-password-hash.ts");
const {
  deriveSessionSigningKey,
  resetWebAuthSecretCache,
  pinWebAuthSecretForTests,
  webAuthSecretPath,
} = await import("./web-auth-secret.ts");
const { config, proxy } = await import("../proxy.ts");

const PASSWORD = "correct horse battery staple";
// N = 2^12 for the test suite: the format and code path are identical, only
// the cost differs, and a full-cost hash per test would dominate the run.
const PASSWORD_HASH = hashPassword(PASSWORD, { logN: 12 });
const TEST_SECRET = { salt: "a".repeat(43), key: "b".repeat(43) };

function withEnvVars(values, run) {
  const saved = new Map();
  for (const name of ["OMP_WEB_PASSWORD_HASH", "OMP_WEB_PASSWORD"]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  pinWebAuthSecretForTests(TEST_SECRET);
  try {
    return run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    pinWebAuthSecretForTests();
  }
}

test("accepts only the hashed password and validates signed sessions", () => {
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    assert.equal(isWebPasswordEnabled(), true);
    assert.equal(isValidWebPassword(PASSWORD), true);
    assert.equal(isValidWebPassword("wrong"), false);
    assert.equal(isValidWebPassword(""), false);

    const now = 1_700_000_000_000;
    const session = createWebSession(now);
    assert.equal(isValidWebSession(session, now), true);
    assert.equal(isValidWebSession(session, now + 31 * 24 * 60 * 60 * 1000), false);
    assert.equal(isValidWebSession("v1.1.aaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", now), false);
    assert.equal(isValidWebSession(undefined, now), false);
  });
});

test("a different password hash invalidates existing sessions", () => {
  const now = 1_700_000_000_000;
  const first = withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => createWebSession(now));
  withEnvVars({ OMP_WEB_PASSWORD_HASH: hashPassword("rotated", { logN: 12 }) }, () => {
    assert.equal(isValidWebSession(first, now), false);
  });
  // ...and the same hash plus the same installation secret keeps working.
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    assert.equal(isValidWebSession(first, now), true);
  });
});

test("the signing key never equals the stored hash", () => {
  // Anyone holding the hash (it sits in web-service.env) must not be able to
  // forge a session, so the cookie key is derived, not reused.
  const key = deriveSessionSigningKey(PASSWORD_HASH, TEST_SECRET);
  assert.notEqual(key, PASSWORD_HASH);
  assert.doesNotMatch(key, /scrypt/);
  const rotated = deriveSessionSigningKey(hashPassword("rotated", { logN: 12 }), TEST_SECRET);
  assert.notEqual(key, rotated);
});

test("a rotated installation secret invalidates sessions too", () => {
  const now = 1_700_000_000_000;
  const first = withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => createWebSession(now));
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    pinWebAuthSecretForTests({ salt: "c".repeat(43), key: "d".repeat(43) });
    assert.equal(isValidWebSession(first, now), false);
  });
});

test("reports a plaintext or malformed configuration instead of running open", () => {
  const plaintext = withEnvVars({ OMP_WEB_PASSWORD: "secret" }, () => webPasswordConfigurationProblem());
  assert.match(plaintext ?? "", /no longer accepted/);
  assert.match(plaintext ?? "", /hash-password/);

  const malformed = withEnvVars({ OMP_WEB_PASSWORD_HASH: "not-a-hash" }, () => webPasswordConfigurationProblem());
  assert.match(malformed ?? "", /not a valid password hash/);

  const both = withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH, OMP_WEB_PASSWORD: "secret" }, () =>
    webPasswordConfigurationProblem());
  assert.match(both ?? "", /Both/);

  assert.equal(withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => webPasswordConfigurationProblem()), null);
  assert.equal(withEnvVars({}, () => webPasswordConfigurationProblem()), null);
  withEnvVars({ OMP_WEB_PASSWORD: "secret" }, () => {
    assert.equal(isWebPasswordEnabled(), false);
    assert.equal(isValidWebPassword("secret"), false);
  });
});

test("creates and reuses an installation secret with restrictive permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-auth-secret-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const path = webAuthSecretPath();
    assert.equal(path, join(dir, "omp-web", "web-auth-secret.json"));
    resetWebAuthSecretCache();
    const key = deriveSessionSigningKey(PASSWORD_HASH);
    const stored = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(typeof stored.salt, "string");
    assert.equal(typeof stored.key, "string");
    // 43 base64url chars = 32 bytes of entropy.
    assert.match(stored.key, /^[A-Za-z0-9_-]{43}$/);
    assert.match(stored.salt, /^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    // Re-reads the same file instead of generating a new key on every call.
    resetWebAuthSecretCache();
    assert.equal(deriveSessionSigningKey(PASSWORD_HASH), key);
    // A replaced file changes the key.
    writeFileSync(path, JSON.stringify({ salt: "e".repeat(43), key: "f".repeat(43) }), { mode: 0o600 });
    resetWebAuthSecretCache();
    assert.notEqual(deriveSessionSigningKey(PASSWORD_HASH), key);
    // A corrupted file is replaced instead of locking everyone out.
    writeFileSync(path, "{ not json");
    resetWebAuthSecretCache();
    const recovered = deriveSessionSigningKey(PASSWORD_HASH);
    assert.equal(typeof recovered, "string");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).key.length, 43);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    resetWebAuthSecretCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redirects browser requests to the password screen and blocks unauthenticated APIs", () => {
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    const pageResponse = proxy(new NextRequest("http://localhost:30177/"));
    assert.equal(pageResponse.status, 307);
    assert.equal(pageResponse.headers.get("location"), "http://localhost:30177/login");

    const crossSitePageResponse = proxy(new NextRequest("http://localhost:30177/", {
      headers: { "sec-fetch-site": "cross-site" },
    }));
    assert.equal(crossSitePageResponse.status, 307);

    const apiResponse = proxy(new NextRequest("http://localhost:30177/api/sessions"));
    assert.equal(apiResponse.status, 401);

    const signedInResponse = proxy(new NextRequest("http://localhost:30177/", {
      headers: { cookie: `omp_web_session=${createWebSession()}` },
    }));
    assert.equal(signedInResponse.status, 200);
  });
});

test("refuses every request while the password configuration is broken", () => {
  withEnvVars({ OMP_WEB_PASSWORD: "legacy-plaintext" }, () => {
    for (const url of ["http://localhost:30177/", "http://localhost:30177/api/sessions", "http://localhost:30177/login"]) {
      const response = proxy(new NextRequest(url));
      assert.equal(response.status, 503, url);
    }
  });
});

test("accepts the trusted proxy header only when its SHA-256 matches the configured digest", () => {
  const previousDigest = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  const digest = createHash("sha256").update("proxy-secret").digest("hex");
  const request = (path, value) => proxy(new NextRequest(`http://localhost:30177${path}`, {
    headers: value === undefined ? {} : { "x-omp-web-auth": value },
  }));
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    try {
      process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = digest;
      assert.equal(request("/", "proxy-secret").status, 200);
      assert.equal(request("/api/sessions", "proxy-secret").status, 200);
      assert.equal(request("/login", "proxy-secret").headers.get("location"), "http://localhost:30177/");
      assert.equal(request("/api/sessions", "wrong").status, 401);
      assert.equal(request("/api/sessions", "proxy-secretX").status, 401);
      assert.equal(request("/api/sessions", "proxy-secre").status, 401);
      assert.equal(request("/api/sessions", "PROXY-SECRET").status, 401);
      assert.equal(request("/api/sessions", "").status, 401);
      assert.equal(request("/api/sessions").status, 401);
      // The digest itself is not a credential.
      assert.equal(request("/api/sessions", digest).status, 401);

      process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = digest.toUpperCase();
      assert.equal(request("/api/sessions", "proxy-secret").status, 200, "uppercase digest");

      // Unset, empty or malformed digest disables the header; nginx's empty value never matches.
      for (const value of [undefined, "", "proxy-secret", digest.slice(1), `${digest}0`, `${digest.slice(2)}zz`]) {
        if (value === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
        else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = value;
        assert.equal(request("/api/sessions", "").status, 401, String(value));
        assert.equal(request("/api/sessions", "proxy-secret").status, 401, String(value));
      }
    } finally {
      if (previousDigest === undefined) delete process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
      else process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = previousDigest;
    }
  });
});

test("leaves Next.js build assets outside password protection", () => {
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/_next/static/chunks/app.js" }), false);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/sessions" }), true);
});

test("leaves the host link to its own bearer check, and nothing else under /api/hosts", () => {
  // The proxy would truncate host link uploads over 10 MB; the route authenticates them.
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/hosts/link" }), false);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/hosts/link/blob/0b6f2c9e-1d2a-4c55-9a3e-7f1e2d3c4b5a" }), false);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/hosts" }), true);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/hosts/abc" }), true);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/hosts/links" }), true);
  assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: "/api/hosts/link-settings" }), true);
});
