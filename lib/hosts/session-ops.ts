// The file-reading half of the session and project API routes. Every op takes
// a session id (never a path) and returns JSON-serializable values, so the
// `ompweb host` daemon can run the same code for a remote host. Live-wrapper
// work (RPC sends, stopping a child) stays in the routes on main.
// No `next/*` or `@/` imports: the daemon loads this through plain jiti.
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, type Stats } from "fs";
import * as fsRuntime from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { promisify } from "util";
import { comparableProjectPath } from "../comparable-path";
import { mediaFilePath } from "../media-cache";
import { resolveOmpBin } from "../omp/omp-cli";
import {
  archiveSessionFileWithArtifacts,
  buildSessionTree,
  deleteSessionFileWithArtifacts,
  getLeafEntryId,
  loadSessionFile,
  MAX_SESSION_LOAD_BYTES,
  parseTitleSlotLine,
  readSessionHeaderSync,
  setSessionTitle,
  writeSessionFileAtomicSync,
} from "../omp/session-files";
import { sessionPathKey } from "../paths";
import {
  hideProject,
  loadProjectRegistry,
  ProjectPathError,
  saveProjectRegistry,
  updateProjectsPresentation,
  upsertProject,
  validateProjectPath,
  type ProjectRegistryEntry,
} from "../project-registry";
import {
  buildSessionContext,
  getSessionContextBoundary,
  getSessionEntries,
  getSessionEntriesForDisplayAsync,
  getSessionHistoryPage,
  invalidateSessionCaches,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  readSessionHeader,
  resolveParentSessionId,
  resolveSessionIdByPath,
  resolveSessionPath,
  SessionFileTooLargeError,
} from "../session-reader";
import type { SessionHistoryCursor } from "../session-sync";
import { extractSubagentHistory, readCompletionArtifact, readSubagentTranscriptPage, resolveSubagentArtifact, subagentTranscriptPath } from "../subagent-history";
import { SUBAGENT_ID_RE } from "../subagent-types";
import { isRecord } from "../type-guards";
import type { ManagedProject, ProjectLaunchConfig, SessionContext, SessionInfo, SessionTitleSource } from "../types";
import { resolveProject } from "../worktree";

export type OpResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; error: string };

export interface SessionReadOptions {
  deferThinking: boolean;
  deferMedia: boolean;
}

export interface ContextReadOptions extends SessionReadOptions {
  /** Read-only transcript mode: include entries omitted from the active agent context. */
  includePreCompaction: boolean;
  /** Return only the active context's entry ids. */
  boundary: boolean;
  /** Paged history read (`?sync=1`). */
  sync: { cursor: SessionHistoryCursor | null; limit: number } | null;
}

/** `GET /api/sessions/[id]` minus the route's `sessionId` and live `agent`. */
export interface SessionReadValue {
  filePath: string;
  info: Omit<SessionInfo, "lastMessageAt" | "projectRoot" | "projectKey" | "worktreeBranch">;
  leafId: string | null;
  tree: unknown[];
  context: SessionContext;
}

export interface ProjectUpdate {
  cwd: string;
  alias?: string | null;
  sortOrder?: number | null;
  pinOrder?: number | null;
  launchConfig?: ProjectLaunchConfig | null;
}

export interface SessionOps {
  listSessions(): Promise<SessionInfo[]>;
  readSession(id: string, options: SessionReadOptions): Promise<OpResult<SessionReadValue>>;
  readContext(id: string, leafId: string | undefined, options: ContextReadOptions): Promise<OpResult<unknown>>;
  readThinking(id: string, entryId: string, block: number): Promise<OpResult<unknown>>;
  readSessionState(id: string): Promise<OpResult<unknown>>;
  readSubagentHistory(id: string): Promise<OpResult<unknown>>;
  readSubagentTranscript(id: string, subagentId: string, mode: "page" | "completion", cursor: number): Promise<OpResult<unknown>>;
  renameSessionFile(id: string, title: string, source?: SessionTitleSource): Promise<OpResult<null>>;
  /** `liveSessionIds`: sessions main has a live omp process for; their files are never rewritten. */
  deleteSession(id: string, liveSessionIds: string[]): Promise<OpResult<{ skippedChildren?: Array<{ id: string; reason: string }> }>>;
  archiveSession(id: string): Promise<OpResult<{ archivedPath: string }>>;
  exportSession(id: string): Promise<OpResult<{ html: string; fileName: string }>>;
  readMedia(hash: string): Promise<OpResult<Uint8Array>>;
  /** Raw registry entries, hidden ones included (main merges session-discovered projects). */
  listProjects(): Promise<ProjectRegistryEntry[]>;
  addProject(path: string, launchConfig?: ProjectLaunchConfig): Promise<OpResult<ManagedProject>>;
  /** Applied in one registry load/save. `newRoots` were registered by this call. */
  updateProject(updates: ProjectUpdate[]): Promise<OpResult<{ projects: ProjectRegistryEntry[]; newRoots: string[] }>>;
  hideProject(path: string): Promise<OpResult<null>>;
  validateCwd(path: string): Promise<OpResult<{ cwd: string; projectRoot: string }>>;
}

const execFileAsync = promisify(execFile);
const ok = <T>(value: T): OpResult<T> => ({ ok: true, value });
const fail = (status: number, code: string, error: string): OpResult<never> => ({ ok: false, status, code, error });
const sessionNotFound = () => fail(404, "session_not_found", "Session not found");
const sessionTooLarge = () => fail(413, "session_file_too_large", "Session file is too large to open in omp-web");

const SUBAGENT_ID_MAX_LENGTH = 100;

// Subagent ids are AdjectiveNoun names, optionally dotted for nested spawns
// (OMP allocates hierarchical ids like `Parent.Child`). The grammar bounds the
// value, rejects empty segments and traversal forms, and guarantees the joined
// path cannot escape the sibling dir; symlink escapes are additionally blocked
// by realpath confinement (resolveSubagentArtifact).
export function isValidSubagentId(subagentId: string): boolean {
  return SUBAGENT_ID_RE.test(subagentId) && subagentId.length <= SUBAGENT_ID_MAX_LENGTH;
}

/** Header-less files: tell "too large" from "missing or malformed" (the bounded header read returns null for both). */
function unreadableSession(filePath: string): OpResult<never> {
  const loaded = loadSessionFile(filePath, { resolveBlobs: false });
  if (loaded.error === "too_large") return sessionTooLarge();
  return fail(404, "session_file_malformed", "Session file is missing or malformed");
}

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;
const MAX_BRANCH_PREVIEW_LENGTH = 40;

function branchPreviewForEntry(entry: { id?: string; type?: string; message?: unknown }): { role?: "user" | "assistant"; text: string } | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return undefined;
  const message = entry.message as { role?: unknown; content?: unknown };
  let text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join(" ")
      : "";
  text = text.replace(/\s+/g, " " ).trim();
  if (text.length > MAX_BRANCH_PREVIEW_LENGTH) text = `${text.slice(0, MAX_BRANCH_PREVIEW_LENGTH)}…`;
  if (!text) text = message.role === "assistant" ? "[assistant]" : "message";
  const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
  return { ...(role ? { role } : {}), text };
}

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, branch points, and leaves while contracting single-child chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain.
 */
function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[] }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[], branchPreview?: { role?: "user" | "assistant"; text: string }): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
    ...(branchPreview ? { branchPreview } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node, undefined, branchPreviewForEntry(node.entry)));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[], branchPreview: undefined as { role?: "user" | "assistant"; text: string } | undefined }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds, branchPreview } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds, branchPreview ?? branchPreviewForEntry(node.entry)));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
          branchPreview: keep.has(node) ? undefined : (branchPreview ?? branchPreviewForEntry(node.entry)),
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      let branchPreview = branchPreviewForEntry(child.entry);
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
        branchPreview ??= branchPreviewForEntry(child.entry);
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds, branchPreview);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

/** Normalize a user-typed workspace path: ~ expands, relative resolves against the process cwd. */
function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

/**
 * Render a session to self-contained HTML by shelling out to the user's omp
 * binary: `omp --export <sessionPath> <outPath>` (the output path is the first
 * positional argument; verified against oh-my-pi main.ts/flag-tables.ts).
 */
async function runOmpExport(filePath: string, outputPath: string): Promise<void> {
  const bin = resolveOmpBin();
  if (!bin) {
    throw new Error("omp binary not found. Install oh-my-pi or set OMP_WEB_OMP_BIN.");
  }
  await execFileAsync(bin, ["--export", filePath, outputPath], {
    cwd: tmpdir(),
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

/** This machine's session and project files. */
export const sessionOps: SessionOps = {
  listSessions: () => listAllSessions(),

  async readSession(id, { deferThinking, deferMedia: deferToolResultImages }) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    try {
      // Single unified read path: the cached parse serves unchanged files from
      // memory (a stat per request), and blob resolution happens on a per-entry
      // deep copy so shared cached objects are never mutated.
      const header = readSessionHeader(filePath);
      if (header === null) return unreadableSession(filePath);
      const displayEntries = await getSessionEntriesForDisplayAsync(filePath, { skipToolResultImages: deferToolResultImages });
      const leafId = getLeafEntryId(displayEntries);
      const tree = projectTreeForResponse(buildSessionTree(displayEntries));
      const context = buildSessionContext(displayEntries, leafId, { deferThinking, deferToolResultImages });

      let modified = header.timestamp ?? new Date().toISOString();
      try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
      const parentSessionId = header.parentSession
        ? await resolveParentSessionId(header.parentSession)
        : undefined;
      const firstUser = context.messages.find((m) => m.role === "user");
      const info = {
        path: filePath,
        id: header.id,
        cwd: header.cwd ?? "",
        name: header.title,
        created: header.timestamp,
        modified,
        messageCount: context.messages.length,
        firstMessage: firstUser
          ? (() => {
              const c = (firstUser as { content: unknown }).content;
              return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
            })()
          : "(no messages)",
        parentSessionId,
      };
      return ok({ filePath, info, leafId, tree, context });
    } catch (error) {
      if (error instanceof SessionFileTooLargeError) return sessionTooLarge();
      throw error;
    }
  },

  async readContext(id, leafId, { deferThinking, deferMedia: deferToolResultImages, includePreCompaction, boundary, sync }) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    try {
      const header = readSessionHeader(filePath);
      if (header === null) return unreadableSession(filePath);
      if (boundary) return ok(getSessionContextBoundary(filePath));
      if (sync) {
        return ok(getSessionHistoryPage(filePath, sync.cursor, sync.limit, leafId, {
          deferThinking,
          deferToolResultImages,
          includePreCompaction,
        }));
      }
      // Deduplicated cached read; blob resolution on per-entry deep copies.
      const entries = await getSessionEntriesForDisplayAsync(filePath, { skipToolResultImages: deferToolResultImages });
      const context = buildSessionContext(entries, leafId, {
        deferThinking,
        deferToolResultImages,
        includePreCompaction,
      });
      return ok({ context });
    } catch (error) {
      // Past the load ceiling: the same 413 as the null-header path, not a
      // 500, so the frontend does not treat history as gone.
      if (error instanceof SessionFileTooLargeError) return sessionTooLarge();
      throw error;
    }
  },

  async readThinking(id, entryId, blockIndex) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    // Lenient JSONL parsing keeps omp's malformed-line tolerance.
    const entry = getSessionEntries(filePath).find((candidate) => candidate.id === entryId);
    if (!entry || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") {
      return fail(404, "assistant_message_not_found", "Assistant message not found");
    }
    const block = entry.message.content[blockIndex];
    if (!block || block.type !== "thinking") {
      return fail(404, "thinking_block_not_found", "Thinking block not found");
    }
    return ok({ thinking: block.thinking });
  },

  async readSessionState(id) {
    return (await resolveSessionPath(id)) ? ok({ running: false }) : sessionNotFound();
  },

  async readSubagentHistory(id) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    return ok({ subagents: extractSubagentHistory(filePath) });
  },

  async readSubagentTranscript(id, subagentId, mode, fromByte) {
    if (!isValidSubagentId(subagentId)) return fail(400, "invalid_subagent_id", "Invalid subagent id");
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    if (mode === "completion") {
      const resolved = resolveSubagentArtifact(filePath, subagentId, ".md");
      if (!resolved) return fail(404, "transcript_not_found", "Subagent completion not found");
      // Read the RESOLVED path: re-deriving from the raw session path here
      // would reopen whatever the symlink points at after the check.
      const completion = readCompletionArtifact(resolved);
      return ok({
        sessionFile: subagentTranscriptPath(filePath, subagentId),
        completion: completion?.completion ?? null,
        truncated: completion?.truncated ?? false,
      });
    }
    const resolved = resolveSubagentArtifact(filePath, subagentId, ".jsonl");
    if (!resolved) return fail(404, "transcript_not_found", "Subagent transcript not found");
    return ok(readSubagentTranscriptPage(resolved, fromByte));
  },

  async renameSessionFile(id, title, source = "user") {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    setSessionTitle(filePath, title, source);
    invalidateSessionCaches(filePath);
    return ok(null);
  },

  async deleteSession(id, liveSessionIds) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    const live = new Set(liveSessionIds);

    // Read only the bounded header before deleting.
    const deletedHeader = readSessionHeader(filePath);
    const deletedSessionId = deletedHeader?.id ?? id;
    const parentSession = deletedHeader?.parentSession;

    // Children reference their parent either by file path or by bare session id
    // (see resolveParentSessionId), so the grandparent has to be written back in
    // whichever form each child used. Resolve both forms up front.
    let grandparentPath: string | undefined;
    let grandparentId: string | undefined;
    if (parentSession) {
      const idForPath = await resolveSessionIdByPath(parentSession);
      if (idForPath) {
        grandparentPath = parentSession;
        grandparentId = idForPath;
      } else {
        const pathForId = await resolveSessionPath(parentSession);
        if (pathForId) {
          grandparentPath = pathForId;
          grandparentId = parentSession;
        }
      }
    }

    // Re-attach all direct children to this session's parent (cascade re-parent)
    // Scan sibling files in the same directory
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    const skippedChildren: Array<{ id: string; reason: string }> = [];
    try {
      const readDirectorySync = Reflect.get(fsRuntime, "readdirSync") as typeof readdirSync;
      const files = readDirectorySync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
      for (const file of files) {
        const childPath = join(dir, file);

        // Re-parenting rewrites the whole child file; a child at/above the
        // load ceiling would cause a huge allocation (RangeError) during the
        // read and a full-file rewrite. Skip it like a live session.
        try {
          if (statSync(childPath).size > MAX_SESSION_LOAD_BYTES) {
            // Report the real session id when the header is readable without
            // loading the whole file (bounded 64KB prefix read).
            let oversizedId = file;
            try {
              const fd = openSync(childPath, "r");
              try {
                const head = Buffer.alloc(64 * 1024);
                const bytes = readSync(fd, head, 0, head.length, 0);
                const lines = head.toString("utf8", 0, bytes).split("\n");
                const headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
                const parsed = JSON.parse(lines[headerIndex] ?? "{}") as { id?: unknown };
                if (typeof parsed.id === "string") oversizedId = parsed.id;
              } finally {
                closeSync(fd);
              }
            } catch {
              // Header unreadable — fall back to the basename.
            }
            skippedChildren.push({ id: oversizedId, reason: "session_child_too_large" });
            continue;
          }
        } catch {
          continue; // vanished between readdir and stat — not a child we can fix
        }
        const childHeader = readSessionHeaderSync(childPath);
        if (!childHeader || !childHeader.parentSession) continue;
        const linkedByPath = sessionPathKey(childHeader.parentSession) === targetPathKey;
        if (!linkedByPath && childHeader.parentSession !== deletedSessionId) continue;

        // A live omp process owns its session file and flushes its whole
        // in-memory state on write — our rewrite would be clobbered by (or
        // interleaved with) its next flush.
        const childId = childHeader.id;
        if (childId && live.has(childId)) {
          skippedChildren.push({ id: childId, reason: "session_child_live" });
          continue;
        }

        let lines: string[];
        let headerIndex: number;
        let header: { type?: string; id?: string; parentSession?: string };
        try {
          lines = readFileSync(childPath, "utf8").split("\n");
          headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
          header = JSON.parse(lines[headerIndex]) as typeof header;
        } catch {
          continue;
        }

        // Write the replacement in the same form the child used.
        header.parentSession = linkedByPath
          ? (grandparentPath ?? parentSession)
          : (grandparentId ?? parentSession);
        lines[headerIndex] = JSON.stringify(header);
        try {
          // Atomic: writeFileSync truncates first, so a crash or ENOSPC here
          // would permanently truncate a session the user did NOT delete.
          writeSessionFileAtomicSync(childPath, lines.join("\n"), "reparent");
        } catch {
          skippedChildren.push({ id: childId ?? file, reason: "session_child_rewrite_failed" });
        }
      }
    } catch { /* skip if dir unreadable */ }

    deleteSessionFileWithArtifacts(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionCaches(); // deletion drops the file: full flush is correct
    return ok(skippedChildren.length > 0 ? { skippedChildren } : {});
  },

  async archiveSession(id) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    const archivedPath = archiveSessionFileWithArtifacts(filePath);
    invalidateSessionPathCache(id);
    // The file is gone: full flush is correct (drops its caches + refreshes list).
    invalidateSessionListCache();
    return ok({ archivedPath });
  },

  async exportSession(id) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return sessionNotFound();
    const tempDir = join(tmpdir(), "omp-web-export");
    mkdirSync(tempDir, { recursive: true });
    const fileName = `omp-session-${basename(filePath, ".jsonl")}.html`;
    const outputPath = join(tempDir, `${randomUUID()}.html`);
    try {
      await runOmpExport(filePath, outputPath);
      return ok({ html: readFileSync(outputPath, "utf8"), fileName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("omp binary not found")) return fail(500, "omp_not_found", message);
      throw error;
    } finally {
      rmSync(outputPath, { force: true });
    }
  },

  async readMedia(hash) {
    if (!/^[0-9a-f]{64}$/.test(hash)) return fail(400, "invalid_hash", "Invalid media hash");
    // As /api/media: the sweep can delete our copy between lookup and read once
    // omp's blob is complete; one more lookup then finds the blob.
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = mediaFilePath(hash);
      if (!file) break;
      try {
        return ok(readFileSync(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(500, "media_read_failed", "Media could not be read");
      }
    }
    return fail(404, "media_not_found", "Media not found");
  },

  listProjects: async () => loadProjectRegistry().projects,

  async addProject(cwd, launchConfig) {
    try {
      const normalized = validateProjectPath(cwd);
      const { projectRoot } = await resolveProject(normalized);
      const next = upsertProject(loadProjectRegistry(), projectRoot, new Date().toISOString(), launchConfig);
      saveProjectRegistry(next);
      const entry = next.projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(projectRoot))!;
      return ok({ path: entry.path, addedAt: entry.addedAt, launchConfig: entry.launchConfig });
    } catch (error) {
      if (error instanceof ProjectPathError) return fail(400, error.code, error.message);
      throw error;
    }
  },

  async updateProject(rawUpdates) {
    // Pre-load registry so we can distinguish "already managed but now
    // deleted" (allow reorder/alias) from "session-discovered ghost" (must not
    // auto-register a deleted path). validateProjectPath is still required for
    // the latter.
    const earlyRegistry = loadProjectRegistry();
    const isAlreadyManaged = (cwd: string): string | null => {
      // Cheap check without stat: resolve ~ and relative, then compare.
      // Mirrors validateProjectPath's normalizeCwd + canonicalProjectPath fallback.
      let probe = normalizeCwd(cwd.trim());
      try { probe = realpathSync(probe); } catch { /* deleted dirs fall back to resolved */ }
      const key = comparableProjectPath(probe);
      const match = earlyRegistry.projects.find((p) => comparableProjectPath(p.path) === key);
      return match ? match.path : null;
    };

    const parsed: Array<Omit<ProjectUpdate, "cwd"> & { path: string }> = [];
    const skipped: Array<{ cwd: string; code: string; error: string }> = [];
    for (const { cwd, ...fields } of rawUpdates) {
      // Same existence/directory checks as POST: an auto-registering endpoint
      // must never persist ghost entries for deleted paths, plain files, or
      // unexpanded "~"/relative paths. For bulk reorder (multiple entries),
      // a single ghost (e.g. a session-discovered directory that was deleted
      // on disk) must not abort the entire batch — skip it instead.
      // Already-managed projects bypass the check so a user's explicitly added
      // workspace stays reorderable/renamable even after its directory is removed.
      const managedPath = isAlreadyManaged(cwd);
      if (managedPath) {
        parsed.push({ path: managedPath, ...fields });
        continue;
      }
      let normalized: string;
      try {
        normalized = validateProjectPath(cwd);
      } catch (error) {
        if (error instanceof ProjectPathError) {
          if (rawUpdates.length > 1) {
            skipped.push({ cwd, code: error.code, error: error.message });
            continue;
          }
          return fail(400, error.code, error.message);
        }
        throw error;
      }
      let projectRoot: string;
      try {
        ({ projectRoot } = await resolveProject(normalized));
      } catch (error) {
        if (rawUpdates.length > 1) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({ cwd, code: "resolve_failed", error: message });
          continue;
        }
        throw error;
      }
      parsed.push({ path: projectRoot, ...fields });
    }
    // Bulk path: every entry was a ghost — propagate the first failure so the
    // client gets a meaningful 400 instead of a misleading 200 with no changes.
    if (parsed.length === 0 && skipped.length > 0) {
      const first = skipped[0]!;
      return fail(400, first.code, first.error);
    }

    // Duplicate targets within one batch merge per-field (later defined
    // fields win) instead of the whole later update replacing the earlier.
    const merged = new Map<string, (typeof parsed)[number]>();
    for (const update of parsed) {
      const key = comparableProjectPath(update.path);
      const previous = merged.get(key);
      merged.set(key, previous ? {
        path: previous.path,
        alias: update.alias !== undefined ? update.alias : previous.alias,
        sortOrder: update.sortOrder !== undefined ? update.sortOrder : previous.sortOrder,
        pinOrder: update.pinOrder !== undefined ? update.pinOrder : previous.pinOrder,
        launchConfig: update.launchConfig !== undefined ? update.launchConfig : previous.launchConfig,
      } : update);
    }

    let registry = loadProjectRegistry();
    const newRoots: string[] = [];
    for (const update of merged.values()) {
      const key = comparableProjectPath(update.path);
      if (!registry.projects.some((p) => comparableProjectPath(p.path) === key)) {
        registry = upsertProject(registry, update.path);
        newRoots.push(update.path);
      }
    }
    // Hidden entries are invisible management-wise: user actions target rows
    // on screen, so their stored display data stays untouched.
    const updates = [...merged.values()].filter((update) => {
      const entry = registry.projects.find((p) => comparableProjectPath(p.path) === comparableProjectPath(update.path));
      return !entry?.hidden;
    });
    const next = updateProjectsPresentation(registry, updates);
    saveProjectRegistry(next);

    const updatedKeys = new Set(updates.map((update) => comparableProjectPath(update.path)));
    const projects = next.projects
      .filter((entry) => updatedKeys.has(comparableProjectPath(entry.path)))
      .map((entry) => ({ path: entry.path, addedAt: entry.addedAt, hidden: entry.hidden, alias: entry.alias, sortOrder: entry.sortOrder, pinOrder: entry.pinOrder, launchConfig: entry.launchConfig }));
    return ok({ projects, newRoots });
  },

  async hideProject(cwd) {
    // Canonicalize worktree paths so hiding a worktree hides its whole project.
    const { projectRoot } = await resolveProject(cwd);
    saveProjectRegistry(hideProject(loadProjectRegistry(), projectRoot));
    return ok(null);
  },

  async validateCwd(cwd) {
    const normalizedCwd = normalizeCwd(cwd);
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch {
      return fail(400, "directory_not_found", `Directory does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) {
      return fail(400, "not_a_directory", `Path is not a directory: ${cwd}`);
    }
    const project = await resolveProject(normalizedCwd);
    return ok({ cwd: normalizedCwd, projectRoot: project.projectRoot });
  },
};
