// `local://` URLs as omp's own local-protocol.ts reads them (`extractRelativePath` + `validateRelativePath`): the file
// an agent wrote with `local://x` is the one ompweb opens, and nothing omp refuses is accepted here. Stricter in one
// way: a Windows absolute suffix is refused on every platform, not only where it would resolve.
// Pure (no I/O, no `@/` imports): the open_file host tool in the browser and the server share it.

// Scheme and host, then the raw path; a query or fragment is not part of the path.
const LOCAL_URI_RE = /^local:\/\/([^/?#]*)(\/[^?#]*)?/i;

export type LocalUriParse = { ok: true; relative: string } | { ok: false; error: string };

/** True for `local://…` (the scheme is case-insensitive); `local:x`, `skill://x` and plain paths are not local URLs. */
export function isLocalUri(input: string): boolean {
  return /^local:\/\//i.test(input);
}

const fail = (error: string): LocalUriParse => ({ ok: false, error });

/** The path under the session's local root that `input` names, or why it names none. Resolving it against a root and
 * confining it there (symlinks included) is the caller's job. */
export function parseLocalUri(input: string): LocalUriParse {
  const match = LOCAL_URI_RE.exec(input);
  if (!match) return fail("Not a local:// URL");
  // omp decodes the host segment twice (`rawHost`, then the joined path) and the rest once: kept, so both read one file.
  let host = match[1];
  try {
    host = decodeURIComponent(host);
  } catch {
    // omp keeps an undecodable host raw; the joined path below then fails to decode.
  }
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
  // A POSIX root, a Windows root (`\x`, `C:\x`, `C:x`): none is relative to the local root.
  if (/^[\\/]|^[a-zA-Z]:/.test(decoded)) return fail("Absolute paths are not allowed in local:// URLs");
  if (decoded.split(/[\\/]/).includes("..")) return fail("Path traversal (..) is not allowed in local:// URLs");
  return { ok: true, relative: decoded };
}
