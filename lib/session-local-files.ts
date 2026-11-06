// A session's own `local://` directory on the machine that runs this code: which directory it is, a `local://` path
// resolved inside it, and whether a path lies in it. Resolves on the owning Node daemon, without consulting main's
// live-session or host state. The session id and the daemon's index (or a verified live-file hint) name the file;
// `sessionLocalRoot` (omp's rule, shared with composer uploads) names its directory, never the cwd or viewed session.
import { realpathSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { isExistingPathWithinRoots, isOmpSecretFile, isPathWithinRoots } from "./file-access";
import { getSessionsDir, sessionLocalRoot } from "./omp/paths";
import { readSessionHeaderSync } from "./omp/session-files";
import { isValidSessionId } from "./session-file-references-core";
import { resolveSessionPath } from "./session-reader";

type SessionLocalFailure = { ok: false; status: 400 | 403 | 404 | 503; code: string; error: string };
type SessionLocalRoot = { ok: true; root: string } | SessionLocalFailure;

const SESSION_NOT_FOUND: SessionLocalFailure = { ok: false, status: 404, code: "session_not_found", error: "Session not found" };

/** A live-file hint wins only when it is inside this daemon's sessions directory and its header names the session.
 * Otherwise the caller falls back to the daemon's own index, including any custom session files it knows. */
function verifiedSessionFile(sessionId: string, hint: string | null | undefined): string | null {
  if (typeof hint !== "string" || !path.isAbsolute(hint) || !hint.endsWith(".jsonl")
    || !isExistingPathWithinRoots(hint, new Set([getSessionsDir()]))) return null;
  return readSessionHeaderSync(hint)?.id === sessionId ? hint : null;
}

/** The `local://` root of a session on this machine: a verified live-file hint wins over the daemon's session index,
 * which lags a new session. 404 when neither names a file. */
async function sessionLocalRootFor(sessionId: string | null, hint: string | null | undefined): Promise<SessionLocalRoot> {
  if (!isValidSessionId(sessionId)) return SESSION_NOT_FOUND;
  const sessionFile = verifiedSessionFile(sessionId, hint) ?? (await resolveSessionPath(sessionId));
  return sessionFile ? { ok: true, root: sessionLocalRoot(sessionFile, sessionId) } : SESSION_NOT_FOUND;
}

/** True when `target`, or its nearest existing ancestor (so a missing file still counts), resolves through symlinks to
 * somewhere outside `root`. A root that does not exist has nothing in it to escape; null when the root exists but
 * cannot be canonicalized, so confinement cannot be checked and the caller refuses. */
function resolvesOutside(root: string, target: string): boolean | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only a root that is not there has nothing in it to escape; any other failure cannot vouch for confinement.
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    return null;
  }
  for (let current = target; ; ) {
    try {
      const existing = realpathSync(current);
      return !isExistingPathWithinRoots(existing, new Set([realRoot]));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      // A loop, a permission error or the top of the tree: not provably inside.
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) return true;
      current = parent;
    }
  }
}

/** Where `relative` (from `parseLocalUri`, which already refused `..` and absolute names) lies in the session's local
 * root, for a file that is there: a path that resolves outside the root through a symlink (or cannot be shown not to)
 * is refused first, then a missing one is 404 `file_not_found` and a directory or other non-file 400 `not_a_file`, as
 * the viewer's own read would answer. Never reads the file. */
export async function resolveSessionLocalFile(
  sessionId: string,
  relative: string,
  sessionFile: string | null,
): Promise<{ ok: true; path: string } | SessionLocalFailure> {
  const located = await sessionLocalRootFor(sessionId, sessionFile);
  if (!located.ok) return located;
  const target = path.resolve(located.root, relative);
  const outside = resolvesOutside(located.root, target);
  if (outside === null) return { ok: false, status: 503, code: "local_root_unavailable", error: "The session's local:// directory could not be checked" };
  if (outside) return { ok: false, status: 403, code: "access_denied", error: "Access denied" };
  if (isOmpSecretFile(target)) return { ok: false, status: 403, code: "access_denied", error: "Access denied" };
  let stat: Stats;
  try {
    stat = statSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, status: 404, code: "file_not_found", error: "File not found in this session's local:// directory" };
    }
    return { ok: false, status: 403, code: "access_denied", error: "Access denied" };
  }
  if (!stat.isFile()) return { ok: false, status: 400, code: "not_a_file", error: "Not a file: the file viewer opens files, not directories" };
  return { ok: true, path: target };
}

/** The session's local root when `filePath` lies inside it: what lets a tab read its own session's artifacts wherever
 * the host keeps them. `sessionFile` is main's optional hint of the live file (verified, never trusted). Null for
 * anything else, and for any failure to find the session. */
export async function sessionLocalRootContaining(filePath: string, sessionId: string | null, sessionFile?: string | null): Promise<string | null> {
  try {
    const located = await sessionLocalRootFor(sessionId, sessionFile);
    return located.ok && isPathWithinRoots(filePath, new Set([located.root])) ? located.root : null;
  } catch {
    return null;
  }
}
