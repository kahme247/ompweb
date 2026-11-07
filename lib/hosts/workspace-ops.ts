import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { authorizeFileAccess } from "../file-authorization";
import { existingPathWithinRootsChecker, isAbsoluteFileRequestPath, isExistingFilePathAllowed, isFilePathAllowed } from "../file-access";
import { resolveDirentIsDirectory } from "../file-dirent";
import { indexWorkspaceFiles } from "../file-index";
import { inspectUploadTargets, validateUploadFileNames } from "../file-upload";
import type { StagedUploads } from "./uploads";
import { MAX_RESULT_LIMIT } from "../file-fuzzy";
import { documentPreviewKind, getAudioMime, getDocumentMime, getFileLanguage, getImageMime, TEXT_PREVIEW_MAX_BYTES } from "../file-types";
import { MAX_INLINE_BASH_OUTPUT_BYTES, openRegularFileNoFollow, readUtf8FileWithinLimit, resolveBashOutputPath } from "../bash-output";
import { isBashOutputPathReferencedBySession } from "../session-file-references";
import { isRecord } from "../type-guards";
import type { WorkspaceFileEvent, WorkspaceFileInfo, WorkspaceFileRequest, WorkspaceOps } from "../workspace-types";
import { HostOpError } from "./link-protocol";
import type { OpResult } from "./session-ops";
import { authorizeWorkspaceDirectory, getWorkspaceRoots } from "./workspace-roots";
import { WorkspaceReads } from "./workspace-reads";
import { WorkspaceWatches } from "./workspace-watch";
import { getGitFileDiff, getGitStatus } from "../git-changes";
import { resolveGithubRepo } from "../github-repo";
import { addWorktree, findCurrentWorktreePath, listWorktrees, removeWorktree, resolveProject, type WorktreeInfo } from "../worktree";
import { projectIdentityKey } from "../paths";
import { invalidateSessionListCache } from "../session-reader";
import { grantWorkspaceRoot, invalidateWorkspaceRoots } from "./workspace-roots";
import { getBrowseStartDirectory, getParentDirectory, listDirectories, listWindowsDrives, resolveDirectory, shouldShowWindowsDrivePicker } from "../directory-browser";
import { WorkspaceClones } from "./workspace-clone";
import { parseLocalUri } from "../local-uri";
import { resolveSessionLocalFile } from "../session-local-files";
import { filePathApiSegments } from "../file-paths";

const invalid = () => new HostOpError(400, "invalid_request", "Invalid workspace request");
async function result<T>(action: () => Promise<T>): Promise<OpResult<T>> {
  try { return { ok: true, value: await action() }; }
  catch (error) {
    if (error instanceof HostOpError) return { ok: false, status: error.status, code: error.code, error: error.message };
    throw error;
  }
}

async function worktreeMutation<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof HostOpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const codes: Array<[string, string]> = [
      ["Branch name is required", "branch_required"], ["Invalid branch name", "invalid_branch_name"],
      ["Directory already exists", "worktree_directory_exists"], ["Not a worktree", "not_a_worktree"],
      ["Cannot remove the main worktree", "cannot_remove_main_worktree"],
    ];
    const dirty = /contains modified or untracked files|is dirty/i.test(message);
    throw new HostOpError(dirty ? 409 : 400, dirty ? "worktree_dirty" : codes.find(([prefix]) => message.startsWith(prefix))?.[1] ?? "worktree_failed", message);
  }
}
function fileInfo(filePath: string, stat: fs.Stats): WorkspaceFileInfo {
  return { path: filePath, name: path.basename(filePath), size: stat.size, mtimeMs: stat.mtimeMs,
    isDirectory: stat.isDirectory(), language: getFileLanguage(filePath),
    mime: getImageMime(filePath) ?? getAudioMime(filePath) ?? getDocumentMime(filePath) ?? "text/plain",
    previewKind: documentPreviewKind(filePath) };
}
async function access(input: WorkspaceFileRequest, reference: boolean) {
  if (!isRecord(input) || !Array.isArray(input.segments) || !input.segments.every((part) => typeof part === "string")
    || !(input.sessionId === null || typeof input.sessionId === "string")
    || !(input.sessionFile === undefined || input.sessionFile === null || typeof input.sessionFile === "string")) throw invalid();
  const checked = await authorizeFileAccess(input.segments, input.sessionId, reference, await getWorkspaceRoots(), input.sessionFile);
  if (!checked.ok) throw new HostOpError(checked.status, checked.code, checked.error);
  return checked;
}
async function listDirectory(input: WorkspaceFileRequest, root: string | null) {
  if (root !== null && typeof root !== "string") throw invalid();
  const checked = await access(input, false);
  if (!checked.stat.isDirectory()) throw new HostOpError(400, "not_a_directory", "Not a directory");
  let insideRoot: ((target: string) => boolean) | null = null;
  if (root !== null) {
    // The listed path is authorized already; the root can only narrow it.
    if (!isAbsoluteFileRequestPath(root)) throw new HostOpError(403, "outside_root", "Outside the explorer root");
    insideRoot = existingPathWithinRootsChecker(new Set([root]));
    if (!insideRoot(checked.filePath)) throw new HostOpError(403, "outside_root", "Outside the explorer root");
  }
  const entries = fs.readdirSync(checked.filePath, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(checked.filePath, entry.name);
      const isDir = resolveDirentIsDirectory(entry, entryPath);
      const isLink = entry.isSymbolicLink();
      if (isDir === null && !isLink) return [];
      let linkTarget: string | undefined;
      if (isLink) {
        try { linkTarget = fs.readlinkSync(entryPath); }
        catch { /* Replaced since readdir: list it without a target. */ }
      }
      const outsideRoot = insideRoot !== null && isLink && !insideRoot(entryPath);
      return [{ name: entry.name, isDir: isDir ?? false, size: 0, modified: "",
        ...(linkTarget !== undefined && { linkTarget }), ...(outsideRoot && { outsideRoot }) }];
    }).sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));
  return { path: checked.filePath, entries };
}
async function openFile(input: WorkspaceFileRequest) {
  const checked = await access(input, true);
  if (!checked.stat.isFile()) throw new HostOpError(400, "not_a_file", "Not a file");
  const opened = await openRegularFileNoFollow(fs.realpathSync(checked.filePath));
  if (opened.fileInfo.dev !== checked.stat.dev || opened.fileInfo.ino !== checked.stat.ino) {
    await opened.handle.close();
    throw new HostOpError(409, "file_changed", "The file changed while it was being opened");
  }
  return { handle: opened.handle, info: fileInfo(checked.filePath, opened.fileInfo) };
}
async function bashPath(sessionId: string, requested: string): Promise<string> {
  if (typeof sessionId !== "string" || typeof requested !== "string") throw invalid();
  const resolved = resolveBashOutputPath(requested, tmpdir());
  if (!resolved) throw new HostOpError(400, "invalid_path", "Invalid bash output path");
  if (!await isBashOutputPathReferencedBySession(resolved, sessionId)) throw new HostOpError(403, "access_denied", "Access denied");
  return resolved;
}

export function createWorkspaceService(uploads: StagedUploads, emit: (id: string, epoch: string, event: WorkspaceFileEvent) => void) {
  const reads = new WorkspaceReads();
  const clones = new WorkspaceClones();
  const watches = new WorkspaceWatches(async (input) => { const checked = await access(input, true); return fileInfo(checked.filePath, checked.stat); }, emit);
  const ops: WorkspaceOps = {
    home: () => result(async () => ({ home: homedir() })),
    browseDirectories: (requested) => result(async () => {
      if (requested !== null && typeof requested !== "string") throw invalid();
      const input = requested?.trim();
      if (shouldShowWindowsDrivePicker(input)) return { path: "" as const, parentPath: null, directories: [], drives: await listWindowsDrives() };
      let directory: string;
      try { directory = await resolveDirectory(getBrowseStartDirectory(input)); }
      catch { throw new HostOpError(404, "directory_not_found", "Directory does not exist"); }
      if (!fs.statSync(directory).isDirectory()) throw new HostOpError(400, "not_a_directory", "Path is not a directory");
      return { path: directory, parentPath: getParentDirectory(directory), directories: await listDirectories(directory) };
    }),
    defaultCwd: () => result(async () => {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const directory = path.join(homedir(), `omp-cwd-${date}`);
      fs.mkdirSync(directory, { recursive: true });
      const cwd = fs.realpathSync(directory);
      grantWorkspaceRoot(cwd);
      return { cwd };
    }),
    startClone: (id, parent, url) => result(() => clones.start(id, parent, url)),
    readClone: (id, cursor) => result(() => clones.read(id, cursor)),
    cancelClone: (id) => result(() => clones.cancel(id)),
    resolveLocalFile: (id, uri, sessionFile) => result(async () => {
      if (typeof id !== "string" || typeof uri !== "string" || !(sessionFile === null || typeof sessionFile === "string")) throw invalid();
      // Parsed again here: this host's platform decides what an absolute or drive-lettered name is.
      const parsed = parseLocalUri(uri);
      if (!parsed.ok) throw new HostOpError(400, "invalid_local_uri", parsed.error);
      const located = await resolveSessionLocalFile(id, parsed.relative, sessionFile);
      if (!located.ok) throw new HostOpError(located.status, located.code, located.error);
      return { path: located.path };
    }),
    gitStatus: (cwd) => result(async () => getGitStatus(await authorizeWorkspaceDirectory(cwd))),
    gitDiff: (cwd, requested) => result(async () => {
      const directory = await authorizeWorkspaceDirectory(cwd);
      if (typeof requested !== "string" || !path.isAbsolute(requested)) throw invalid();
      const checked = await access({ segments: filePathApiSegments(requested), sessionId: null }, false);
      return getGitFileDiff(directory, checked.filePath);
    }),
    githubRepo: (cwd) => result(async () => ({ repo: await resolveGithubRepo(await authorizeWorkspaceDirectory(cwd)) })),
    listWorktrees: (cwd) => result(async () => {
      const directory = await authorizeWorkspaceDirectory(cwd);
      const project = await resolveProject(directory);
      let worktrees: WorktreeInfo[] = [];
      let isGit = true;
      try { worktrees = await listWorktrees(fs.existsSync(path.join(directory, ".git")) ? directory : project.projectRoot); }
      catch { isGit = false; }
      worktrees = worktrees.filter((tree) => !fs.lstatSync(tree.path).isSymbolicLink());
      for (const tree of worktrees) grantWorkspaceRoot(tree.path);
      return { projectRoot: project.projectRoot, projectKey: projectIdentityKey(project.projectRoot), isGit,
        isTopLevel: project.isTopLevel, currentWorktreePath: findCurrentWorktreePath(worktrees, directory), worktrees };
    }),
    addWorktree: (cwd, branch) => result(() => worktreeMutation(async () => {
      const directory = await authorizeWorkspaceDirectory(cwd);
      if (typeof branch !== "string") throw invalid();
      const added = await addWorktree(directory, branch);
      grantWorkspaceRoot(added.path); invalidateSessionListCache(); invalidateWorkspaceRoots();
      return added;
    })),
    removeWorktree: (cwd, requested, force) => result(() => worktreeMutation(async () => {
      const directory = await authorizeWorkspaceDirectory(cwd);
      if (typeof requested !== "string" || !path.isAbsolute(requested) || typeof force !== "boolean") throw invalid();
      const trees = await listWorktrees(directory);
      const selected = trees.find((tree) => findCurrentWorktreePath([tree], requested) !== null);
      if (!selected || fs.lstatSync(selected.path).isSymbolicLink()) throw new HostOpError(400, "not_a_worktree", "Not a worktree of this repository");
      await removeWorktree(directory, selected.path, force);
      invalidateSessionListCache(); invalidateWorkspaceRoots();
      return null;
    })),
    watchFile: (id, epoch, input) => result(() => watches.watch(id, epoch, input)),
    unwatchFile: (id, epoch) => result(async () => { watches.unwatch(id, epoch); return null; }),
    inspectUploads: (directory, names) => result(async () => {
      if (!Array.isArray(names) || names.length > 1000 || !names.every((name) => typeof name === "string")) throw invalid();
      const error = validateUploadFileNames(names);
      if (error) throw new HostOpError(400, "invalid_file_name", error);
      return inspectUploadTargets(await authorizeWorkspaceDirectory(directory), names);
    }),
    publishUpload: (id, directory, name, conflict) => result(() => uploads.publish(id, directory, name, conflict)),
    listFiles: (input, showHidden) => result(async () => {
      if (typeof showHidden !== "boolean") throw invalid();
      return listDirectory(input, null);
    }),
    listFilesInRoot: (input, root) => result(() => listDirectory(input, root)),
    fileInfo: (input) => result(async () => { const checked = await access(input, true); return fileInfo(checked.filePath, checked.stat); }),
    openFile: (input) => result(async () => { const opened = await openFile(input); return reads.add(opened.handle, opened.info); }),
    readFileChunk: (id, offset, length) => result(() => reads.read(id, offset, length)),
    closeFile: (id) => result(async () => { if (typeof id !== "string") throw invalid(); await reads.close(id); return null; }),
    readTextFile: (input) => result(async () => {
      const opened = await openFile(input);
      const ticket = reads.add(opened.handle, opened.info);
      try {
        if (opened.info.size > TEXT_PREVIEW_MAX_BYTES) throw new HostOpError(413, "file_too_large_preview", "File too large for preview (>256KB)");
        const content = opened.info.size === 0 ? "" : (await reads.read(ticket.id, 0, opened.info.size)).toString("utf8");
        return { content, language: opened.info.language, size: opened.info.size };
      } finally { await reads.close(ticket.id); }
    }),
    fileIndex: (cwd, query, limit, kind, refresh) => result(async () => {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new HostOpError(400, "cwd_must_be_absolute", "cwd must be an absolute path");
      if (typeof query !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT
        || (kind !== "all" && kind !== "file") || typeof refresh !== "boolean") throw invalid();
      const roots = await getWorkspaceRoots();
      if (!isFilePathAllowed(cwd, roots)) throw new HostOpError(403, "access_denied", "Access denied");
      let stat: fs.Stats;
      try { stat = fs.statSync(cwd); } catch { throw new HostOpError(404, "directory_not_found", "Directory not found"); }
      if (!stat.isDirectory()) throw new HostOpError(400, "not_a_directory", "Not a directory");
      if (!isExistingFilePathAllowed(cwd, roots)) throw new HostOpError(403, "access_denied", "Access denied");
      return indexWorkspaceFiles(cwd, query.slice(0, 500), limit, kind, refresh);
    }),
    readBashOutput: (id, requested) => result(async () => {
      const read = await readUtf8FileWithinLimit(await bashPath(id, requested));
      return read.tooLarge ? { tooLarge: true as const, size: read.size, maxBytes: MAX_INLINE_BASH_OUTPUT_BYTES }
        : { tooLarge: false as const, output: read.content };
    }),
    openBashOutput: (id, requested) => result(async () => {
      const resolved = await bashPath(id, requested);
      const opened = await openRegularFileNoFollow(resolved);
      return reads.add(opened.handle, fileInfo(resolved, opened.fileInfo));
    }),
  };
  return {
    ops,
    onDisconnect: () => { watches.closeAll(); void reads.closeAll().catch(() => {}); },
    stop: async () => { watches.closeAll(); await Promise.all([reads.closeAll(), clones.stop()]); },
  };
}
