// `local://` URLs as omp's own local-protocol.ts reads them (`extractRelativePath` + `validateRelativePath`, omp
// 18.3.1+ and the installed 18.15): the file an agent wrote with `local://x` is the one ompweb opens, and nothing omp
// refuses is accepted here. Stricter in a few ways, all on the safe side: a NUL byte and an empty path are refused; a
// backslash is always a separator, so a leading one is absolute and `a\..b` is refused off Windows (omp reads it there
// as one file name); on Windows a drive letter is absolute and an interior `..`-name (`a/..b`) is refused, which omp's
// `includes("/..")` misses once `normalize` has turned the separators into backslashes.
// Pure (no I/O, no `@/` imports): the open_file host tool in the browser and the server share it.

// Scheme and authority (omp's LOCAL_AUTHORITY_RE), then the raw path; a query or fragment is not part of the path.
const LOCAL_URI_RE = /^local:\/\/([^/?#]*)(\/[^?#]*)?/i;

export type LocalUriParse = { ok: true; relative: string } | { ok: false; error: string };

/** True for `local://…` (the scheme is case-insensitive); `local:x`, `skill://x` and plain paths are not local URLs. */
export function isLocalUri(input: string): boolean {
  return /^local:\/\//i.test(input);
}

const fail = (error: string): LocalUriParse => ({ ok: false, error });

/** The path under the session's local root that `input` names, or why it names none. Resolving it against a root and
 * confining it there (symlinks included) is the caller's job. `platform: null` leaves drive-letter rules to the owning host. */
export function parseLocalUri(input: string, platform: NodeJS.Platform | null = process.platform): LocalUriParse {
  const match = LOCAL_URI_RE.exec(input);
  if (!match) return fail("Not a local:// URL");
  // The authority is the first path segment, decoded once with the rest, as written (a second decode corrupts `%`).
  const host = match[1];
  const pathname = match[2] ?? "";
  const hasPath = pathname !== "" && pathname !== "/";
  const combined = host ? (hasPath ? `${host}${pathname}` : host) : hasPath ? pathname.slice(1) : "";
  if (!combined) return fail("local:// names no file: use local://<file>");
  let decoded: string;
  try {
    decoded = decodeURIComponent(combined.replace(/\\/g, "/"));
  } catch {
    return fail(`Invalid URL encoding in local:// path: ${input}`);
  }
  if (decoded.includes("\0")) return fail("A NUL byte is not allowed in a local:// path");
  // A POSIX or Windows root (`/x`, `\x`); on Windows also `C:\x` and `C:x`. Elsewhere `a:1.md` is a file name.
  if (/^[\\/]/.test(decoded) || (platform === "win32" && /^[a-zA-Z]:/.test(decoded))) {
    return fail("Absolute paths are not allowed in local:// URLs");
  }
  // omp's rule: no `..` segment, and none that starts with `..` (`normalized.startsWith("..")` / `includes("/..")`).
  if (decoded.split(/[\\/]/).some((segment) => segment.startsWith(".."))) return fail("Path traversal (..) is not allowed in local:// URLs");
  return { ok: true, relative: decoded };
}
