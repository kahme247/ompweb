import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { createGitEnvironment } from "./project-command-env";
import type {
  GitCollapseReason,
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  GIT_REVIEW_ATTRIBUTES,
  parseGitCollapseReasons,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER, input?: string): Promise<string> {
  const pending = execFileAsync("git", ["-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: createGitEnvironment({ LC_ALL: "C" }),
  });
  if (input !== undefined) {
    // git may exit before reading stdin (EPIPE); that failure surfaces through `pending`.
    pending.child.stdin?.on("error", () => {});
    pending.child.stdin?.end(input);
  }
  return (await pending).stdout;
}

/** The worktree toplevel in `cwd`'s own spelling: Git's --show-toplevel can differ in separators, 8.3 names and symlinks.
 * Null outside a worktree; a bare repository has a Git directory but no toplevel. */
async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    const [insideWorkTree, cdup = ""] = (await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-cdup"])).split("\n");
    return insideWorkTree === "true" ? path.resolve(cwd, cdup.trim()) : null;
  } catch {
    return null;
  }
}

function canonicalizePath(p: string): string {
  // Resolve symlinks so a project opened through a symlinked path compares
  // equal to the canonical repository root git reports (#322). Missing paths
  // (e.g. deleted files in a status listing) keep the lexical resolution.
  // .native returns the on-disk casing on case-insensitive filesystems
  // (macOS APFS), matching sameOnDiskEntry in lib/omp/agents-service.ts;
  // the plain realpathSync preserves input casing and would let two
  // spellings of the same directory compare unequal.
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(canonicalizePath(parent), canonicalizePath(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Lexical containment against an already-canonical parent: the target is a
// git status entry, whose location is repo-relative, so following the entry
// itself would drop a tracked symlink that points outside the selected
// directory. The canonical parent is what fixes the symlinked-cwd case
// (#322); the entry's own target is never resolved here.
function isWithinCanonicalParent(canonicalParent: string, target: string): boolean {
  const relative = path.relative(canonicalParent, path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

// Honors .gitattributes, $GIT_DIR/info/attributes and core.attributesFile.
// Paths go over stdin so large change sets cannot exceed the argv limit.
// Marking is a presentation hint: on failure every file stays in the main list.
async function readCollapseReasons(repositoryRoot: string, relativePaths: string[]): Promise<Map<string, GitCollapseReason>> {
  if (relativePaths.length === 0) return new Map();
  try {
    const output = await git(
      repositoryRoot,
      ["check-attr", "-z", "--stdin", ...GIT_REVIEW_ATTRIBUTES],
      // One record per queried attribute per path, so scale with the list.
      GIT_STATUS_MAX_BUFFER * GIT_REVIEW_ATTRIBUTES.length,
      `${relativePaths.join("\0")}\0`,
    );
    return parseGitCollapseReasons(output);
  } catch {
    return new Map();
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, repositoryRoot: null, files: [] };
  }

  // The cwd is canonicalized once: it is constant across the filter, and
  // entries are compared by location only (isWithinCanonicalParent) so a
  // tracked symlink inside the selection is kept even when its target
  // points outside it. getGitFileDiff below keeps the fully canonical
  // check, since git reads the file content through the link there.
  // Entries are repo-relative, so resolve them against the canonical root:
  // findRepositoryRoot keeps cwd's own spelling since #450, which for a
  // symlinked cwd is the link spelling — resolving entries against it
  // would put them lexically outside the canonical cwd and drop them
  // (#322). Only the root is canonicalized, never an entry itself.
  const canonicalCwd = canonicalizePath(cwd);
  const canonicalRoot = canonicalizePath(repositoryRoot);
  const entries = (await readStatusEntries(repositoryRoot))
    .filter((entry) => isWithinCanonicalParent(canonicalCwd, path.resolve(canonicalRoot, entry.path)));
  const reasons = await readCollapseReasons(repositoryRoot, entries.map((entry) => entry.path));
  const files = entries.map((entry): GitFileStatus => ({
    filePath: path.resolve(canonicalRoot, entry.path),
    ...classifyGitStatus(entry),
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    collapseReason: reasons.get(entry.path),
  }));

  // The response is self-consistent: repositoryRoot is canonical, matching
  // the canonical filePath entries, so callers can combine them with
  // path.relative. findRepositoryRoot's lexical spelling is only used as
  // git's -C cwd above, never returned here.
  return { isGitRepository: true, repositoryRoot: canonicalRoot, files };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot || !isWithinPath(repositoryRoot, filePath)) return { supported: false };

  const resolvedFilePath = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  // Derive the git-relative path from the canonical root and the
  // canonicalized file directory, keeping the leaf name: a caller may pass
  // the file through the symlinked cwd spelling, while a tracked symlink's
  // own name must survive — only its directory is resolved, never the
  // entry itself (resolving the entry would follow the link out of the
  // repository and drop it, the #322 case in reverse).
  const canonicalRoot = canonicalizePath(repositoryRoot);
  const canonicalDir = canonicalizePath(path.dirname(resolvedFilePath));
  const relativePath = toGitPath(path.relative(canonicalRoot, path.join(canonicalDir, path.basename(resolvedFilePath))));
  const entries = await readStatusEntries(repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") return { supported: false };

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  // `-diff` files: git itself prints no textual diff, so neither do we.
  if ((await readCollapseReasons(repositoryRoot, [relativePath])).get(relativePath) === "no-diff") {
    return { supported: false };
  }
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
