import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
const { proxy } = await import("../proxy.ts");

const PASSWORD = "correct horse battery staple";
// N = 2^12 for the test suite: the format and code path are identical, only
// the cost differs, and a full-cost hash per test would dominate the run.
const PASSWORD_HASH = hashPassword(PASSWORD, { logN: 12 });
const TEST_SECRET = { salt: "a".repeat(43), key: "b".repeat(43) };

/** Sets the password variables and pins the secret; returns the undo. */
function setEnvVars(values) {
  const saved = new Map();
  for (const name of ["OMP_WEB_PASSWORD_HASH", "OMP_WEB_PASSWORD"]) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  pinWebAuthSecretForTests(TEST_SECRET);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    pinWebAuthSecretForTests();
  };
}

function withEnvVars(values, run) {
  const restore = setEnvVars(values);
  try {
    return run();
  } finally {
    restore();
  }
}

/** proxy() for a URL. */
const gate = (url, init) => proxy(new Request(url, init));

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
    const pageResponse = gate("http://localhost:30177/");
    assert.equal(pageResponse.status, 307);
    assert.equal(pageResponse.headers.get("location"), "/login");

    const deepLink = gate("http://localhost:30177/?session=x");
    assert.equal(deepLink.status, 307);
    assert.equal(deepLink.headers.get("location"), "/login?next=%2F%3Fsession%3Dx");

    // Relative, so a TLS proxy in front keeps https (Bun's request.url is always http://).
    const behindTls = gate("http://ai-web.example.com/?session=x", { headers: { "x-forwarded-proto": "https" } });
    assert.equal(behindTls.headers.get("location"), "/login?next=%2F%3Fsession%3Dx");

    const crossSitePageResponse = gate("http://localhost:30177/", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(crossSitePageResponse.status, 307);

    const apiResponse = gate("http://localhost:30177/api/sessions");
    assert.equal(apiResponse.status, 401);

    assert.equal(gate("http://localhost:30177/", {
      headers: { cookie: `omp_web_session=${createWebSession()}` },
    }), null);
    assert.equal(gate("http://localhost:30177/login", {
      headers: { cookie: `omp_web_session=${createWebSession()}` },
    }).headers.get("location"), "/");
    assert.equal(gate("http://localhost:30177/login"), null);
    assert.equal(gate("http://localhost:30177/api/web-auth/session", { method: "POST" }), null);
  });
});

test("without a password every request continues and /login leads home", () => {
  withEnvVars({}, () => {
    assert.equal(gate("http://localhost:30177/"), null);
    assert.equal(gate("http://localhost:30177/api/sessions"), null);
    const login = gate("http://localhost:30177/login");
    assert.equal(login.status, 307);
    assert.equal(login.headers.get("location"), "/");
  });
});

test("refuses every request while the password configuration is broken", () => {
  withEnvVars({ OMP_WEB_PASSWORD: "legacy-plaintext" }, () => {
    for (const url of ["http://localhost:30177/", "http://localhost:30177/api/sessions", "http://localhost:30177/login"]) {
      const response = gate(url);
      assert.equal(response.status, 503, url);
    }
  });
});

test("accepts the trusted proxy header only when its SHA-256 matches the configured digest", () => {
  const previousDigest = process.env.OMP_WEB_TRUSTED_HEADER_SHA256;
  const digest = createHash("sha256").update("proxy-secret").digest("hex");
  const request = (path, value) => gate(`http://localhost:30177${path}`, {
    headers: value === undefined ? {} : { "x-omp-web-auth": value },
  });
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    try {
      process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = digest;
      assert.equal(request("/", "proxy-secret"), null);
      assert.equal(request("/api/sessions", "proxy-secret"), null);
      assert.equal(request("/login", "proxy-secret").headers.get("location"), "/");
      assert.equal(request("/api/sessions", "wrong").status, 401);
      assert.equal(request("/api/sessions", "proxy-secretX").status, 401);
      assert.equal(request("/api/sessions", "proxy-secre").status, 401);
      assert.equal(request("/api/sessions", "PROXY-SECRET").status, 401);
      assert.equal(request("/api/sessions", "").status, 401);
      assert.equal(request("/api/sessions").status, 401);
      // The digest itself is not a credential.
      assert.equal(request("/api/sessions", digest).status, 401);

      process.env.OMP_WEB_TRUSTED_HEADER_SHA256 = digest.toUpperCase();
      assert.equal(request("/api/sessions", "proxy-secret"), null, "uppercase digest");

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

test("leaves the login page's assets, the icons and the service worker outside password protection", () => {
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    for (const path of ["/sw.js", "/assets/a.js", "/_bun/client/index.js", "/favicon.ico", "/icon.svg", "/icon.png", "/icon-192.png", "/badge-96.png"]) {
      assert.equal(gate(`http://localhost:30177${path}`), null, path);
    }
    assert.equal(gate("http://localhost:30177/api/sessions").status, 401);
    assert.equal(gate("http://localhost:30177/event-stream-worker.js").status, 307);
  });
});

test("leaves the host link to its own bearer check, and nothing else under /api/hosts", () => {
  withEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }, () => {
    assert.equal(gate("http://localhost:30177/api/hosts/link"), null);
    assert.equal(gate("http://localhost:30177/api/hosts/link/blob/x"), null);
    assert.equal(gate("http://localhost:30177/api/hosts/link/blob/0b6f2c9e-1d2a-4c55-9a3e-7f1e2d3c4b5a"), null);
    for (const path of ["/api/hosts", "/api/hosts/abc", "/api/hosts/links", "/api/hosts/linkx", "/api/hosts/link-settings"]) {
      assert.equal(gate(`http://localhost:30177${path}`).status, 401, path);
    }
  });
});

test("signing in sets an HttpOnly, SameSite=Lax session cookie, Secure only over https", async (t) => {
  const { POST } = await import("../app/api/web-auth/session/route.ts");
  t.after(setEnvVars({ OMP_WEB_PASSWORD_HASH: PASSWORD_HASH }));
  const signIn = async (headers) => {
    const response = await POST(new Request("http://localhost:30177/api/web-auth/session", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ password: PASSWORD }),
    }));
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie");
  };

  const plain = await signIn({});
  assert.match(plain, /^omp_web_session=[^;]+;/);
  assert.equal(isValidWebSession(/^omp_web_session=([^;]+)/.exec(plain)[1]), true);
  for (const attribute of [/; HttpOnly(;|$)/i, /; Path=\/(;|$)/i, /; Max-Age=2592000(;|$)/i, /; SameSite=Lax(;|$)/i]) {
    assert.match(plain, attribute);
  }
  assert.doesNotMatch(plain, /; Secure(;|$)/i);
  assert.match(await signIn({ "x-forwarded-proto": "https" }), /; Secure(;|$)/i);
  assert.match(await signIn({ "x-forwarded-proto": "https, http" }), /; Secure(;|$)/i);
});
