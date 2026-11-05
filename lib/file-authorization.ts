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
 * absolute reading first and, only when no allowed root authorizes it, fan the
 * request out over the roots. Writes deliberately skip this (see the files
 * route's `getUploadDirectory`): a relative upload path must not select the
 * target dir.
 */
function resolveReadFilePath(segments: string[], allowedRoots: Set<string>): string {
  // `~/…` chat links name the server user's home, as the agent's shell did.
  // The expanded path then faces the same root/reference checks as any other.
  if (segments[0] === "~") return normalizeSlashes(path.join(homedir(), ...segments.slice(1)));
  const absolutePath = filePathFromSegments(segments);
  if (isFilePathAllowed(absolutePath, allowedRoots)) return absolutePath;
  return resolveRequestedFilePath(segments.join("/"), allowedRoots) ?? absolutePath;
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
): Promise<FileAccessDecision> {
  const filePath = resolveReadFilePath(segments, allowedRoots);
  const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
  // A session's own local:// directory is its artifact store wherever its host
  // keeps it (a custom session dir, Windows's temp fallback). Reads inside it
  // are confined to it, symlinks included, even when the transcript names the
  // path too.
  const localRoot = !allowedByRoot && allowSessionReference ? await sessionLocalRootContaining(filePath, sessionId) : null;
  const allowedBySessionReference =
    !allowedByRoot &&
    !localRoot &&
    allowSessionReference &&
    await isFilePathReferencedBySession(filePath, sessionId);
  if (!allowedByRoot && !localRoot && !allowedBySessionReference) return ACCESS_DENIED;
  // Making the omp config root readable (so `~/.agents/AGENTS.md` and
  // `~/.omp/AGENTS.md` open in the viewer, #135) also puts omp's credential
  // store inside an allowed root. Deny it before anything can stat, read or
  // download it, also through a symlink that resolves to it.
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
