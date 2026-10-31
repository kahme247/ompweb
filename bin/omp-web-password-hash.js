"use strict";

// The `OMP_WEB_PASSWORD_HASH` format, in one place. This file must stay plain
// CJS JS with no dependencies beyond node:crypto: the packaged launcher
// (bin/omp-web.js) validates and hashes before the server exists, lib/web-password-hash.ts
// is the typed view of it for the server, and the service installers hash the
// password they write. See issue #239.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { randomBytes, scryptSync, timingSafeEqual } = require("node:crypto");

/** Salt length in bytes. */
const SALT_BYTES = 16;
/** Derived key length in bytes. */
const DIGEST_BYTES = 32;
/** Cost used when hashing a new password. N = 2^15 = 32768 (32 MiB, ~60 ms). */
const DEFAULT_LOG_N = 15;
/** Block size and parallelization used when hashing a new password. */
const DEFAULT_R = 8;
const DEFAULT_P = 1;
/**
 * Lowest cost accepted when verifying. N = 2^12 (4 MiB) is below the OWASP
 * recommendation but still slow enough to make a leaked hash expensive to
 * brute-force; anything cheaper is treated as corrupt rather than "valid".
 */
const MIN_LOG_N = 12;
/** Largest accepted `r`, and the cap on scrypt's working memory. */
const MAX_R = 32;
const MAX_MEMORY_BYTES = 128 * 1024 * 1024;

const HASH_PATTERN = /^scrypt\$(\d{1,2})\$(\d{1,3})\$(\d{1,2})\$([A-Za-z0-9_-]{16,64})\$([A-Za-z0-9_-]{16,128})$/;

/** scrypt's own memory formula (128 * N * r) plus headroom for its scratch space. */
function maxMemoryFor(logN, r) {
  return Math.min(MAX_MEMORY_BYTES, 128 * 2 ** logN * r * 2);
}

function equals(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** Hash a password into the `scrypt$ln$r$p$salt$digest` format. */
function hashPassword(password, options = {}) {
  const logN = options.logN ?? DEFAULT_LOG_N;
  const r = options.r ?? DEFAULT_R;
  const p = options.p ?? DEFAULT_P;
  const salt = randomBytes(SALT_BYTES);
  const digest = scryptSync(password, salt, DIGEST_BYTES, { N: 2 ** logN, r, p, maxmem: maxMemoryFor(logN, r) });
  return ["scrypt", logN, r, p, salt.toString("base64url"), digest.toString("base64url")].join("$");
}

/**
 * Parse a stored hash without verifying anything. Returns the parameters and
 * encoded halves, or null when the text is not a plausible hash — callers use
 * this to reject a plaintext password before it can be mistaken for one. The
 * encoded salt and digest must decode to exactly the expected byte counts, so
 * a truncated or padded copy is refused instead of silently compared.
 */
function parsePasswordHash(value) {
  if (typeof value !== "string") return null;
  const match = HASH_PATTERN.exec(value.trim());
  if (!match) return null;
  const logN = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!Number.isSafeInteger(logN) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return null;
  if (logN < MIN_LOG_N || r < 1 || r > MAX_R || p < 1) return null;
  if (2 ** logN * r * 128 > MAX_MEMORY_BYTES) return null;
  if (Buffer.from(match[4], "base64url").length !== SALT_BYTES) return null;
  if (Buffer.from(match[5], "base64url").length !== DIGEST_BYTES) return null;
  return { logN, r, p, salt: match[4], digest: match[5] };
}

/** True when the value is a hash this build is willing to verify. */
function isPasswordHash(value) {
  return parsePasswordHash(value) !== null;
}

/**
 * Check a candidate password against a stored hash. A malformed or too-weak
 * hash never matches: configured-but-unusable must fail closed, not open.
 */
function verifyPassword(candidate, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let digest;
  try {
    digest = scryptSync(candidate, Buffer.from(parsed.salt, "base64url"), DIGEST_BYTES, {
      N: 2 ** parsed.logN,
      r: parsed.r,
      p: parsed.p,
      maxmem: maxMemoryFor(parsed.logN, parsed.r),
    });
  } catch {
    // Out-of-memory or unsupported parameters: treat as a failed sign-in.
    return false;
  }
  return equals(digest.toString("base64url"), parsed.digest);
}

module.exports = {
  SALT_BYTES,
  DIGEST_BYTES,
  DEFAULT_LOG_N,
  DEFAULT_R,
  DEFAULT_P,
  MIN_LOG_N,
  hashPassword,
  parsePasswordHash,
  isPasswordHash,
  verifyPassword,
};
