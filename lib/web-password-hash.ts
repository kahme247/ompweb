// The `OMP_WEB_PASSWORD_HASH` format lives in bin/omp-web-password-hash.js:
// the packaged launcher and the service installers must hash and validate a
// password before the server (and this module) exists. This file is the typed
// view of it for the server — never a second implementation.
import * as passwordHash from "../bin/omp-web-password-hash.js";

/**
 * Self-describing scrypt password hash. omp-web only ever stores and compares
 * a hash of the web sign-in password (issue #239): the plaintext used to live
 * in `OMP_WEB_PASSWORD`, which every `omp` child process inherited, so an
 * agent that ran `env` could print it into a session file and off to a model
 * provider.
 *
 * Format: `scrypt$<log2(N)>$<r>$<p>$<salt>$<digest>`
 *   - `log2(N)` (a.k.a. `ln`) instead of the raw cost: N is always a power of
 *     two, and the log keeps the encoded hash short and unambiguous.
 *   - salt and digest are unpadded base64url, salt is 16 bytes, digest 32.
 *
 * Verified with `timingSafeEqual`, so a wrong password cannot be told apart
 * from a right one by timing. The format is parsed strictly and the cost is
 * floored: a hand-written `scrypt$1$8$1$...` must not become an offline
 * brute-force gift for anyone who reads the hash out of `web-service.env`.
 */

/** Overridable cost, so tests hash at a fraction of the production cost. */
export interface PasswordHashOptions {
  logN?: number;
  r?: number;
  p?: number;
}

/** Parsed hash parameters. */
export interface ParsedPasswordHash {
  logN: number;
  r: number;
  p: number;
  salt: string;
  digest: string;
}

/** Salt length in bytes. */
export const PASSWORD_HASH_SALT_BYTES: number = passwordHash.SALT_BYTES;
/** Derived key length in bytes. */
export const PASSWORD_HASH_DIGEST_BYTES: number = passwordHash.DIGEST_BYTES;
/** Cost used when hashing a new password (N = 2^15). */
export const PASSWORD_HASH_LOG_N: number = passwordHash.DEFAULT_LOG_N;
export const PASSWORD_HASH_R: number = passwordHash.DEFAULT_R;
export const PASSWORD_HASH_P: number = passwordHash.DEFAULT_P;
/** Lowest cost accepted when verifying anything, including a stored hash. */
export const PASSWORD_HASH_MIN_LOG_N: number = passwordHash.MIN_LOG_N;

/** Hash a password for `OMP_WEB_PASSWORD_HASH`. */
export const hashPassword = passwordHash.hashPassword as (password: string, options?: PasswordHashOptions) => string;

/**
 * Parse a stored hash without verifying anything. Returns null when the text
 * is not a plausible hash — callers use this to reject a plaintext password
 * before it can be mistaken for one.
 */
export const parsePasswordHash = passwordHash.parsePasswordHash as (value: unknown) => ParsedPasswordHash | null;

/** True when the value is a hash this build is willing to verify. */
export const isPasswordHash = passwordHash.isPasswordHash as (value: unknown) => value is string;

/**
 * Check a candidate password against a stored hash. A malformed or too-weak
 * hash never matches: configured-but-unusable must fail closed, not open.
 */
export const verifyPassword = passwordHash.verifyPassword as (candidate: string, stored: string) => boolean;
