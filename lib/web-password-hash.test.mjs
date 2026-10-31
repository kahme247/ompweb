import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);

const {
  hashPassword,
  isPasswordHash,
  parsePasswordHash,
  verifyPassword,
  PASSWORD_HASH_MIN_LOG_N,
} = await import("./web-password-hash.ts");
// The shipped implementation, used by the launcher and the service installers.
const launcherImpl = require("../bin/omp-web-password-hash.js");

test("accepts only a self-describing scrypt hash", () => {
  const hash = hashPassword("correct horse", { logN: 12 });
  assert.match(hash, /^scrypt\$12\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(isPasswordHash(hash), true);

  for (const value of [undefined, null, 42, "", "hunter2", "scrypt$12$8$1$short$short", ` ${hash.slice(0, -3)}`]) {
    assert.equal(isPasswordHash(value), false, String(value));
  }
});

test("verifies the right password and rejects everything else", () => {
  const hash = hashPassword("correct horse", { logN: 12 });
  assert.equal(verifyPassword("correct horse", hash), true);
  assert.equal(verifyPassword("correct horse ", hash), false);
  assert.equal(verifyPassword("", hash), false);
  assert.equal(verifyPassword("Correct horse", hash), false);
});

test("hashes the same password differently every time", () => {
  const first = hashPassword("same", { logN: 12 });
  const second = hashPassword("same", { logN: 12 });
  assert.notEqual(first, second);
  assert.equal(verifyPassword("same", first), true);
  assert.equal(verifyPassword("same", second), true);
});

test("handles unicode and long passwords", () => {
  for (const password of ["🔐-パスワード-密码", "x".repeat(4096), " leading and trailing "]) {
    const hash = hashPassword(password, { logN: 12 });
    assert.equal(verifyPassword(password, hash), true, password.slice(0, 16));
  }
});

test("refuses a hash below the cost floor", () => {
  // A weak hash must not be accepted just because it was written by hand.
  const weak = hashPassword("secret", { logN: 12 }).replace("scrypt$12$", "scrypt$04$");
  assert.equal(parsePasswordHash(weak), null);
  assert.equal(verifyPassword("secret", weak), false);
  assert.equal(PASSWORD_HASH_MIN_LOG_N, 12);
});

test("refuses malformed parameters instead of throwing", () => {
  const good = hashPassword("secret", { logN: 12 });
  const [, , r, p, salt, digest] = good.split("$");
  for (const candidate of [
    `scrypt$12$0$${salt}$${digest}`,
    `scrypt$12$999$${salt}$${digest}`,
    `scrypt$99$${r}$${p}$${salt}$${digest}`,
    `scrypt$12$${r}$${p}$${salt}`,
    `scrypt$12$${r}$${p}$not base64!$${digest}`,
    `scrypt$12$${r}$${p}$${salt}$not_a_digest`,
  ]) {
    assert.equal(isPasswordHash(candidate), false, candidate);
    assert.equal(verifyPassword("secret", candidate), false, candidate);
  }
});

test("the shipped encoder and the server verifier agree", () => {
  // bin/ carries the canonical implementation; lib/ is a typed view of it.
  assert.equal(launcherImpl.hashPassword, hashPassword);
  assert.equal(launcherImpl.isPasswordHash, isPasswordHash);
  assert.equal(launcherImpl.verifyPassword, verifyPassword);

  const hash = launcherImpl.hashPassword("from the launcher", { logN: 12 });
  assert.equal(isPasswordHash(hash), true);
  assert.equal(verifyPassword("from the launcher", hash), true);
  assert.equal(verifyPassword("from elsewhere", hash), false);
});

test("the shipped default cost matches the documented parameters", () => {
  const hash = launcherImpl.hashPassword("default cost");
  assert.match(hash, /^scrypt\$15\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyPassword("default cost", hash), true);
});
