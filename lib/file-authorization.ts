import fs from "fs";
import { homedir } from "os";
import path from "path";
import {

  isExistingFilePathAllowed,
  isExistingPathWithinRoots,
  isFilePathAllowed,
  isOmpSecretFile,
  isWindowsAbsolutePath,
  normalizeSlashes,
  resolveRequestedFilePath,
} from "./file-access";
import { isFilePathReferencedBySession } from "./session-file-references";
import { normalizeForComparison } from "./paths";
import { sessionLocalRootContaining } from "./session-local-files";

/** Rebuild an absolute path from `/api/files/[...path]` catch-all segments. */
export function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

/**
 * The catch-all param never carries a leading slash, so an absolute request is
 * indistinguishable from a relative one once it is joined — `filePathFromSegments`
 * guesses absolute by prefixing `/`, which is right for every real browse and
 * wrong for the bare workspace paths `MarkdownBody` linkifies (#135). Try the
 * absolute reading first and, only when neither an allowed root nor the owning
 * session's local root authorizes it, fan out over the roots. Writes skip this
 * (see the files route's `getUploadDirectory`): a relative upload path must
 * not select the target dir.
 */
async function resolveReadFilePath(
  segments: string[],
  allowedRoots: Set<string>,
  sessionId: string | null,
  allowSessionReference: boolean,
  sessionFile?: string | null,
): Promise<{ filePath: string; localRoot: string | null }> {
  // `~/…` names the server user's home, never a workspace-relative candidate.
  const homePath = segments[0] === "~";
  const absolutePath = homePath ? normalizeSlashes(path.join(homedir(), ...segments.slice(1))) : filePathFromSegments(segments);
  let filePath = absolutePath;
  let localRoot = allowSessionReference ? await sessionLocalRootContaining(absolutePath, sessionId, sessionFile) : null;
  // A session-owned absolute path must not be shadowed by a workspace-relative namesake, even when it is missing.
  if (!homePath && !localRoot && !isFilePathAllowed(absolutePath, allowedRoots)) {
    filePath = resolveRequestedFilePath(segments.join("/"), allowedRoots) ?? absolutePath;
    if (filePath !== absolutePath && allowSessionReference) localRoot = await sessionLocalRootContaining(filePath, sessionId, sessionFile);
  }
  return { filePath, localRoot };
}

export type FileAccessDecision =
  | { ok: true; filePath: string; stat: fs.Stats }
  | { ok: false; status: 403 | 404; error: string; code: "access_denied" | "file_not_found" };

const ACCESS_DENIED: FileAccessDecision = { ok: false, status: 403, error: "Access denied", code: "access_denied" };

/**
 * The single allow-list gate for reading workspace files (`/api/files` and the
 * live file-watch channel): resolves the requested catch-all segments, then
 * admits the path when it is inside an allowed root, or — when
 * `allowSessionReference` — inside the given session's own `local://`
 * directory, or referenced by that session's transcript.
 */
export async function authorizeFileAccess(
  segments: string[],
  sessionId: string | null,
  allowSessionReference: boolean,
  allowedRoots: Set<string>,
  sessionFile?: string | null,
): Promise<FileAccessDecision> {
  const { filePath, localRoot } = await resolveReadFilePath(segments, allowedRoots, sessionId, allowSessionReference, sessionFile);
  const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
  // Even an allowed ancestor or transcript reference cannot bypass the session-local root's narrower confinement.
  const allowedBySessionReference =
    !allowedByRoot &&
    !localRoot &&
    allowSessionReference &&
    await isFilePathReferencedBySession(filePath, sessionId);
  if (!allowedByRoot && !localRoot && !allowedBySessionReference) return ACCESS_DENIED;
  // Authorize the namespace before canonical secret probing touches the filesystem.
  if (isOmpSecretFile(filePath)) return ACCESS_DENIED;

  let realPath: string;
  try {
    realPath = fs.realpathSync(filePath);
  } catch {
    return { ok: false, status: 404, error: "Not found", code: "file_not_found" };
  }
  if (allowedBySessionReference && normalizeForComparison(realPath) !== normalizeForComparison(filePath)
    && !isExistingFilePathAllowed(realPath, allowedRoots)
    && !await isFilePathReferencedBySession(realPath, sessionId)) return ACCESS_DENIED;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, status: 404, error: "Not found", code: "file_not_found" };
  }

  if (localRoot) {
    if (!isExistingPathWithinRoots(filePath, new Set([localRoot]))) return ACCESS_DENIED;
  } else if (!allowedBySessionReference && !isExistingFilePathAllowed(filePath, allowedRoots)) {
    return ACCESS_DENIED;
  }
  return { ok: true, filePath, stat };
}
