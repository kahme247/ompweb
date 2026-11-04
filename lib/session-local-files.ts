// A session's own `local://` directory on this machine: which directory it is, a `local://` path resolved inside it,
// and whether a path lies in it. The root is always the session's own (never the cwd, never the session on screen):
// the id names the session, its owning host's metadata names the file, and `sessionLocalRoot` (omp's rule, shared with
// composer uploads) names the directory.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isPathWithinRoots, normalizeSlashes } from "./file-access";
import { LOCAL_HOST_ID } from "./hosts/registry";
import { hostForSessionId, sessionSpawnTarget } from "./hosts/session-index";
import { sessionLocalRoot } from "./hosts/uploads";
import { getRpcSession } from "./rpc-manager";
import { isValidSessionId } from "./session-file-references-core";

type SessionLocalFailure = { ok: false; status: 403 | 404 | 501; code: string; error: string };
type SessionLocalRoot = { ok: true; root: string } | SessionLocalFailure;

const SESSION_NOT_FOUND: SessionLocalFailure = { ok: false, status: 404, code: "session_not_found", error: "Session not found" };

/** The `local://` root of a session on this machine. 404 for a session no host has, 501 for one on a remote host: this
 * server reads only its own machine's files, and a path on the other machine must never be answered from here. A
 * live session's own file wins over the host's list, which lags a new session; 503 (thrown) while this machine's
 * daemon has never listed its sessions. */
async function sessionLocalRootFor(sessionId: string | null): Promise<SessionLocalRoot> {
  if (!isValidSessionId(sessionId)) return SESSION_NOT_FOUND;
  const live = getRpcSession(sessionId);
  const running = live?.isAlive() ? live : undefined;
  const host = running?.host ?? (await hostForSessionId(sessionId));
  if (!host) return SESSION_NOT_FOUND;
  if (host.id !== LOCAL_HOST_ID) {
    return {
      ok: false,
      status: 501,
      code: "remote_host_unsupported",
      error: `${host.label} runs this session: its local:// files are on that machine, and ompweb reads only its own machine's files for now`,
    };
  }
  const sessionFile = running?.sessionFile || (await sessionSpawnTarget(sessionId, host))?.sessionFile;
  return sessionFile ? { ok: true, root: sessionLocalRoot(sessionFile, sessionId) } : SESSION_NOT_FOUND;
}

/** True when `target`, or its nearest existing ancestor (so a missing file still counts), resolves through symlinks to
 * somewhere outside `root`. A root that does not exist has nothing in it to escape. */
function resolvesOutside(root: string, target: string): boolean {
  let realRoot: string;
  try {
    realRoot = normalizeSlashes(realpathSync(root));
  } catch {
    return false;
  }
  for (let current = target; ; ) {
    try {
      return !isPathWithinRoots(normalizeSlashes(realpathSync(current)), new Set([realRoot]));
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
 * root, for a file that is there: a missing one is 404 `file_not_found`, a path that resolves outside the root through
 * a symlink (or cannot be shown not to) is refused. Never reads the file. */
export async function resolveSessionLocalFile(
  sessionId: string,
  relative: string,
): Promise<{ ok: true; path: string } | SessionLocalFailure> {
  const located = await sessionLocalRootFor(sessionId);
  if (!located.ok) return located;
  const target = path.resolve(located.root, relative);
  if (resolvesOutside(located.root, target)) return { ok: false, status: 403, code: "access_denied", error: "Access denied" };
  try {
    statSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, status: 404, code: "file_not_found", error: "File not found in this session's local:// directory" };
    }
    return { ok: false, status: 403, code: "access_denied", error: "Access denied" };
  }
  return { ok: true, path: target };
}

/** The session's local root when `filePath` lies inside it: what lets a tab read its own session's artifacts wherever
 * the host keeps them. Null for anything else, and for any failure to find the session. */
export async function sessionLocalRootContaining(filePath: string, sessionId: string | null): Promise<string | null> {
  try {
    const located = await sessionLocalRootFor(sessionId);
    return located.ok && isPathWithinRoots(filePath, new Set([located.root])) ? located.root : null;
  } catch {
    return null;
  }
}
