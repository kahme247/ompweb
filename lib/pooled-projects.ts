import { execFile } from "child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "path";
import { promisify } from "util";
import { cloneDirectoryName } from "./git-clone";
import { cloneRepository } from "./project-clone";
import { createChildProcessEnvironment } from "./project-command-env";
import type { OpResult } from "./hosts/session-ops";

export interface PreparedPoolProject {
  cwd: string;
  projectRoot: string;
  baseCommit: string;
}

const CREATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const preparations = new Map<string, Promise<void>>();
const exec = promisify(execFile);

class PreparationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
  }
}

/** The caller supplies the registered origin and confined clone root, never a creation-time URL. */
export async function preparePoolProject(input: {
  projectId: string;
  origin: string;
  cloneRoot: string;
  creationId: string;
  ref?: string;
}): Promise<OpResult<PreparedPoolProject>> {
  if (!CREATION_ID.test(input.creationId) || !PROJECT_ID.test(input.projectId)) {
    return { ok: false, status: 400, code: "invalid_pool_project_id", error: "Invalid project or creation ID" };
  }
  if (!cloneDirectoryName(input.origin) || input.origin !== input.origin.trim() || hasHttpsCredentials(input.origin)) {
    return { ok: false, status: 400, code: "invalid_git_url", error: "A registered HTTPS or SSH origin without embedded HTTPS credentials is required" };
  }
  if (!isAbsolute(input.cloneRoot) || resolve(input.cloneRoot) !== input.cloneRoot || dirname(input.cloneRoot) === input.cloneRoot) {
    return { ok: false, status: 400, code: "invalid_clone_root", error: "An absolute confined clone root is required" };
  }
  const previous = preparations.get(input.cloneRoot);
  const gate = Promise.withResolvers<void>();
  preparations.set(input.cloneRoot, gate.promise);
  await previous;
  try {
    return { ok: true, value: await prepare(input) };
  } catch (error) {
    if (error instanceof PreparationError) return { ok: false, status: error.status, code: error.code, error: error.message };
    return { ok: false, status: 500, code: "pool_prepare_failed", error: "Could not prepare project repository" };
  } finally {
    gate.resolve();
    if (preparations.get(input.cloneRoot) === gate.promise) preparations.delete(input.cloneRoot);
  }
}

function hasHttpsCredentials(origin: string): boolean {
  if (!origin.startsWith("https://")) return false;
  try {
    const url = new URL(origin);
    return !!url.username || !!url.password;
  } catch {
    return true;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: createChildProcessEnvironment({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_ALLOW_PROTOCOL: "https:ssh" }),
  });
  return stdout.trim();
}

/** Reject symlinks at every existing component, including the destination itself. */
async function directoryExists(path: string): Promise<boolean> {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new PreparationError("pool_path_conflict", `Unsafe project path: ${current}`);
    }
  }
  return true;
}

async function prepare(input: {
  projectId: string;
  origin: string;
  cloneRoot: string;
  creationId: string;
  ref?: string;
}): Promise<PreparedPoolProject> {
  const { cloneRoot, origin, creationId, projectId, ref } = input;
  const parent = dirname(cloneRoot);
  const sessionRoot = join(parent, `.${basename(cloneRoot)}_worktrees`, "session");
  const cwd = join(sessionRoot, creationId);
  const branch = `session/${creationId}`;
  const metadataKey = `branch.${branch}.ompwebPoolProject`;
  if (!await directoryExists(parent)) throw new PreparationError("invalid_clone_root", "Clone parent does not exist", 400);
  const existingWorktree = await directoryExists(cwd);
  const existingClone = await directoryExists(cloneRoot);
  if (existingWorktree && !existingClone) throw new PreparationError("pool_worktree_conflict", "Worktree target already exists");
  if (ref !== undefined) {
    if (!ref || ref.startsWith("-") || /\s/.test(ref)) throw new PreparationError("invalid_project_ref", "Invalid pushed ref", 400);
    await git(parent, "check-ref-format", ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);
  }

  if (!existingClone) {
    const temporary = await mkdtemp(join(parent, `.${basename(cloneRoot)}_clone-`));
    try {
      const staging = join(temporary, "repository");
      const cloned = await cloneRepository({ origin, target: staging });
      if (!cloned.ok) throw new PreparationError(cloned.code, cloned.error, cloned.status);
      if (await directoryExists(cloneRoot)) throw new PreparationError("clone_target_exists", "Clone target appeared during preparation");
      await rename(staging, cloneRoot);
    } finally {
      // Only this attempt's mkdtemp directory is removed; published/previous clones survive.
      await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
    }
  }

  const gitDirectory = join(cloneRoot, ".git");
  const gitStat = await lstat(gitDirectory);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink() || await git(cloneRoot, "rev-parse", "--show-toplevel") !== cloneRoot) {
    throw new PreparationError("pool_clone_conflict", "Clone root must be an independent repository");
  }
  // remote get-url expands insteadOf rewrites and cannot verify the registered literal origin.
  if (await git(cloneRoot, "config", "--get", "remote.origin.url") !== origin) {
    throw new PreparationError("pool_origin_mismatch", "Clone origin does not match the registered project");
  }

  if (existingWorktree) {
    const dotGit = await lstat(join(cwd, ".git"));
    if (!dotGit.isFile() || dotGit.isSymbolicLink()
      || await git(cwd, "rev-parse", "--show-toplevel") !== cwd
      || await realpath(await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")) !== await realpath(gitDirectory)
      || await git(cwd, "symbolic-ref", "--quiet", "--short", "HEAD") !== branch) {
      throw new PreparationError("pool_worktree_conflict", "Worktree target is owned by another checkout");
    }
    let metadata: { projectId?: string; ref?: string | null; baseCommit?: string };
    try {
      metadata = JSON.parse(await git(cloneRoot, "config", "--get", metadataKey));
    } catch {
      throw new PreparationError("pool_worktree_conflict", "Worktree has no matching pool preparation record");
    }
    if (!metadata || typeof metadata !== "object" || metadata.projectId !== projectId || metadata.ref !== (ref ?? null)
      || typeof metadata.baseCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(metadata.baseCommit)) {
      throw new PreparationError("pool_worktree_conflict", "Creation ID was already used for a different project or ref");
    }
    await git(cloneRoot, "cat-file", "-e", `${metadata.baseCommit}^{commit}`);
    return { cwd, projectRoot: cloneRoot, baseCommit: metadata.baseCommit };
  }

  // Fetch the remote ref itself, not a possibly unpublished local branch. Never reset or clean.
  await git(cloneRoot, "fetch", "--no-tags", "origin", ref ?? "HEAD");
  const baseCommit = await git(cloneRoot, "rev-parse", "--verify", "FETCH_HEAD^{commit}");
  await mkdir(sessionRoot, { recursive: true });
  if (!await directoryExists(sessionRoot) || await directoryExists(cwd)) {
    throw new PreparationError("pool_worktree_conflict", "Worktree target already exists");
  }
  await git(cloneRoot, "worktree", "add", "-b", branch, "--", cwd, baseCommit);
  // Persist the original base before returning; retries never rebase a dirty or committed session.
  await git(cloneRoot, "config", metadataKey, JSON.stringify({ projectId, ref: ref ?? null, baseCommit }));
  return { cwd, projectRoot: cloneRoot, baseCommit };
}
