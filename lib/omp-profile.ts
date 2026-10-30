/**
 * OMP profile-name validation, mirroring the omp CLI's own rule so a profile
 * saved here can never make the spawned `omp --profile …` child exit at startup
 * (which surfaces in the UI as an HTTP 500 on the first message).
 *
 * Rule (see the CLI's error text): names must match ^[a-z0-9][a-z0-9._-]{0,63}$,
 * cannot be "." or "..", cannot end with ".", and cannot be a Windows reserved
 * device name (CON, PRN, AUX, NUL, COM0-9, LPT0-9, or any of those with an
 * extension such as con.txt).
 */

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Reserved device names apply to the base name before the first dot.
const WINDOWS_RESERVED_BASE = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 10 }, (_, i) => `com${i}`),
  ...Array.from({ length: 10 }, (_, i) => `lpt${i}`),
]);

/** True when `name` is a profile name omp will accept (empty input is "no profile" and valid). */
export function isValidOmpProfile(name: string): boolean {
  if (!name) return true;
  if (!PROFILE_NAME_PATTERN.test(name)) return false;
  if (name === "." || name === ".." || name.endsWith(".")) return false;
  const base = name.split(".")[0]!;
  return !WINDOWS_RESERVED_BASE.has(base);
}
