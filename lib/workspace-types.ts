import type { FileIndexEntry } from "./file-fuzzy";
import type { UploadConflictStrategy, UploadTargetInspection } from "./file-upload";
import type { OpResult } from "./hosts/session-ops";
import type { GitFileDiffResponse, GitStatusResponse } from "./git-types";
import type { WorktreeInfo } from "./worktree";
import type { BrowsableDirectory } from "./directory-browser";
import type { CloneProgress } from "./git-clone";

export interface WorkspaceFileSource { hostId: string; cwd: string | null; sessionId: string | null }

export interface WorkspaceFileRequest { segments: string[]; sessionId: string | null }
export interface WorkspaceFileInfo {
  path: string; name: string; size: number; mtimeMs: number; isDirectory: boolean;
  language: string; mime: string; previewKind: "pdf" | "docx" | null;
}
export interface WorkspaceDirectoryListing {
  path: string; entries: Array<{ name: string; isDir: boolean; size: number; modified: string; linkTarget?: string; outsideRoot?: boolean }>;
}
export interface WorkspaceRead { id: string; info: WorkspaceFileInfo }
export type WorkspaceIndex = { files: string[]; truncated: boolean } | { matches: FileIndexEntry[]; truncated?: boolean };
export type WorkspaceBashOutput = { tooLarge: true; size: number; maxBytes: number } | { tooLarge: false; output: string };
export interface WorkspaceUploadResult { path: string; name: string; skipped: boolean }
export type WorkspaceFileEvent = { type: "change"; mtime: string; size: number } | { type: "error"; message: string };
export interface WorkspaceWorktrees {
  projectRoot: string; projectKey: string; isGit: boolean; isTopLevel: boolean;
  currentWorktreePath: string | null; worktrees: WorktreeInfo[];
}
export type WorkspaceDirectoryBrowse =
  | { path: string; parentPath: string | null; directories: BrowsableDirectory[] }
  | { path: ""; parentPath: null; directories: []; drives: BrowsableDirectory[] };

export interface WorkspaceOps {
  home(): Promise<OpResult<{ home: string }>>;
  listFiles(input: WorkspaceFileRequest, showHidden: boolean): Promise<OpResult<WorkspaceDirectoryListing>>;
  listFilesInRoot(input: WorkspaceFileRequest, root: string | null): Promise<OpResult<WorkspaceDirectoryListing>>;
  fileInfo(input: WorkspaceFileRequest): Promise<OpResult<WorkspaceFileInfo>>;
  readTextFile(input: WorkspaceFileRequest): Promise<OpResult<{ content: string; language: string; size: number }>>;
  openFile(input: WorkspaceFileRequest): Promise<OpResult<WorkspaceRead>>;
  readFileChunk(id: string, offset: number, length: number): Promise<OpResult<Uint8Array>>;
  closeFile(id: string): Promise<OpResult<null>>;
  fileIndex(cwd: string, query: string, limit: number, kind: "all" | "file", refresh: boolean): Promise<OpResult<WorkspaceIndex>>;
  readBashOutput(sessionId: string, path: string): Promise<OpResult<WorkspaceBashOutput>>;
  openBashOutput(sessionId: string, path: string): Promise<OpResult<WorkspaceRead>>;
  inspectUploads(directory: string, names: string[]): Promise<OpResult<UploadTargetInspection>>;
  publishUpload(id: string, directory: string, name: string, conflict: UploadConflictStrategy): Promise<OpResult<WorkspaceUploadResult>>;
  watchFile(id: string, epoch: string, input: WorkspaceFileRequest): Promise<OpResult<WorkspaceFileInfo>>;
  unwatchFile(id: string, epoch: string): Promise<OpResult<null>>;
  gitStatus(cwd: string): Promise<OpResult<GitStatusResponse>>;
  gitDiff(cwd: string, path: string): Promise<OpResult<GitFileDiffResponse>>;
  githubRepo(cwd: string): Promise<OpResult<{ repo: string | null }>>;
  listWorktrees(cwd: string): Promise<OpResult<WorkspaceWorktrees>>;
  addWorktree(cwd: string, branch: string): Promise<OpResult<{ path: string; branch: string }>>;
  removeWorktree(cwd: string, path: string, force: boolean): Promise<OpResult<null>>;
  browseDirectories(path: string | null): Promise<OpResult<WorkspaceDirectoryBrowse>>;
  defaultCwd(): Promise<OpResult<{ cwd: string }>>;
  startClone(id: string, parent: string, url: string): Promise<OpResult<{ id: string }>>;
  readClone(id: string, cursor: number): Promise<OpResult<CloneProgress>>;
  cancelClone(id: string): Promise<OpResult<CloneProgress>>;
}

export const WORKSPACE_OP_PARAMS: { readonly [K in keyof WorkspaceOps]: readonly string[] } = {
  home: [], listFiles: ["input", "showHidden"], fileInfo: ["input"], readTextFile: ["input"],
  openFile: ["input"], readFileChunk: ["id", "offset", "length"], closeFile: ["id"],
  fileIndex: ["cwd", "query", "limit", "kind", "refresh"],
  readBashOutput: ["sessionId", "path"], openBashOutput: ["sessionId", "path"],
  inspectUploads: ["directory", "names"], publishUpload: ["id", "directory", "name", "conflict"],
  watchFile: ["id", "epoch", "input"], unwatchFile: ["id", "epoch"],
  gitStatus: ["cwd"], gitDiff: ["cwd", "path"], githubRepo: ["cwd"],
  listWorktrees: ["cwd"], addWorktree: ["cwd", "branch"], removeWorktree: ["cwd", "path", "force"],
  browseDirectories: ["path"], defaultCwd: [], startClone: ["id", "parent", "url"], readClone: ["id", "cursor"], cancelClone: ["id"],
  // Older peers cap the advertised prefix before filtering unknown capabilities.
  listFilesInRoot: ["input", "root"],
};

export function isWorkspaceOp(value: string): value is keyof WorkspaceOps {
  return Object.hasOwn(WORKSPACE_OP_PARAMS, value);
}
