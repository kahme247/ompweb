import { isRecord } from "../type-guards";
import { isWindowsAbsolutePath } from "../paths";
import type { WorkspaceOps } from "../workspace-types";
import { LINK_LIMITS } from "./link-protocol";

const text = (value: unknown): value is string => typeof value === "string" && value.length <= 32768;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const gitStatus = (value: unknown) => typeof value === "string" && ["modified", "added", "deleted", "renamed", "untracked", "conflict"].includes(value);
function info(value: unknown): boolean {
  return isRecord(value) && text(value.path) && text(value.name) && count(value.size)
    && typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs)
    && typeof value.isDirectory === "boolean" && text(value.language) && text(value.mime)
    && (value.previewKind === null || value.previewKind === "pdf" || value.previewKind === "docx");
}

export function validWorkspaceResult(op: keyof WorkspaceOps, result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result.ok === false) return typeof result.status === "number" && Number.isInteger(result.status)
    && result.status >= 400 && result.status <= 599 && text(result.code) && text(result.error);
  if (result.ok !== true || !("value" in result)) return false;
  const value = result.value;
  if (op === "closeFile" || op === "unwatchFile" || op === "removeWorktree") return value === null;
  if (op === "readFileChunk") return value instanceof Uint8Array && value.byteLength <= LINK_LIMITS.pieceBytes;
  if (!isRecord(value)) return false;
  switch (op) {
    case "home": return text(value.home);
    case "defaultCwd": return text(value.cwd);
    case "resolveLocalFile": return text(value.path) && (value.path.startsWith("/") || isWindowsAbsolutePath(value.path));
    case "startClone": return text(value.id);
    case "readClone": case "cancelClone": return count(value.cursor) && typeof value.reset === "boolean" && typeof value.terminal === "boolean"
      && Array.isArray(value.frames) && value.frames.length <= 8193 && value.frames.every((frame) => isRecord(frame) && (
        frame.type === "output" ? typeof frame.text === "string" && frame.text.length <= 64 * 1024
          : frame.type === "done" || frame.type === "cancelled" ? text(frame.path)
            : frame.type === "error" && text(frame.error) && text(frame.code)));
    case "browseDirectories": return text(value.path) && (value.parentPath === null || text(value.parentPath))
      && Array.isArray(value.directories) && value.directories.every((entry) => isRecord(entry) && text(entry.name) && text(entry.path))
      && (value.drives === undefined || Array.isArray(value.drives) && value.drives.every((entry) => isRecord(entry) && text(entry.name) && text(entry.path)));
    case "githubRepo": return value.repo === null || text(value.repo);
    case "addWorktree": return text(value.path) && text(value.branch);
    case "listWorktrees": return text(value.projectRoot) && text(value.projectKey) && typeof value.isGit === "boolean" && typeof value.isTopLevel === "boolean"
      && (value.currentWorktreePath === null || text(value.currentWorktreePath)) && Array.isArray(value.worktrees) && value.worktrees.length <= 10000
      && value.worktrees.every((tree) => isRecord(tree) && text(tree.path) && (tree.branch === null || text(tree.branch)) && typeof tree.isMain === "boolean");
    case "gitStatus": return typeof value.isGitRepository === "boolean" && (value.repositoryRoot === null || text(value.repositoryRoot))
      && Array.isArray(value.files) && value.files.every((file) => isRecord(file) && text(file.filePath) && gitStatus(file.status)
        && typeof file.code === "string" && /^[MADRUC]$/.test(file.code) && text(file.indexStatus) && text(file.worktreeStatus)
        && (file.collapseReason === undefined || ["generated", "vendored", "documentation", "no-diff"].includes(file.collapseReason as string)));
    case "gitDiff": return typeof value.supported === "boolean" && (value.status === undefined || gitStatus(value.status))
      && (value.patch === undefined || typeof value.patch === "string" && value.patch.length <= 1024 * 1024);
    case "inspectUploads": return Array.isArray(value.conflicts) && value.conflicts.length <= 1000 && value.conflicts.every(text)
      && Array.isArray(value.nonReplaceable) && value.nonReplaceable.length <= 1000 && value.nonReplaceable.every(text);
    case "publishUpload": return text(value.path) && text(value.name) && typeof value.skipped === "boolean";
    case "fileInfo": case "watchFile": return info(value);
    case "openFile": case "openBashOutput": return text(value.id) && info(value.info);
    case "readTextFile": return typeof value.content === "string" && value.content.length <= 256 * 1024
      && text(value.language) && count(value.size) && value.size <= 256 * 1024;
    case "readBashOutput": return value.tooLarge === true
      ? count(value.size) && count(value.maxBytes)
      : value.tooLarge === false && typeof value.output === "string" && value.output.length <= 5 * 1024 * 1024;
    case "listFiles": case "listFilesInRoot": return text(value.path) && Array.isArray(value.entries) && value.entries.every((entry) =>
      isRecord(entry) && text(entry.name) && typeof entry.isDir === "boolean" && count(entry.size) && text(entry.modified)
      && (entry.linkTarget === undefined || text(entry.linkTarget))
      && (entry.outsideRoot === undefined || typeof entry.outsideRoot === "boolean"));
    case "fileIndex": return Array.isArray(value.files)
      ? value.files.length <= 5000 && value.files.every(text) && typeof value.truncated === "boolean"
      : Array.isArray(value.matches) && value.matches.length <= 200 && value.matches.every((entry) =>
        isRecord(entry) && text(entry.path) && typeof entry.isDir === "boolean")
        && (value.truncated === undefined || typeof value.truncated === "boolean");
  }
}
