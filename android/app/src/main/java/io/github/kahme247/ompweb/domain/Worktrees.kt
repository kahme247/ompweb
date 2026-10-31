package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.net.WorktreeList
import io.github.kahme247.ompweb.net.userMessage

/**
 * Client-side rules of the Worktrees tab (`components/WorktreesPanel.tsx`,
 * `lib/worktree.ts`, `app/api/worktrees/route.ts`) and of the Phase-4
 * new-session worktree select — one cache, one set of rules (AGENTS.md
 * "Worktrees and project grouping").
 *
 * The server owns git. What the client decides: whether the tab applies to
 * the active cwd, which worktree is current, where a created worktree lands,
 * which branches may be sent at all, and what a failed call means on screen
 * (dirty ⇒ ask before force).
 */

/** Directory suffix AGENTS.md documents for created worktrees. */
const val WORKTREE_DIR_SUFFIX = "-worktrees"

/** Stable error `code`s of `app/api/worktrees/route.ts` (`worktreeErrorCode`). */
object WorktreeCode {
    const val BRANCH_REQUIRED = "branch_required"
    const val INVALID_BRANCH_NAME = "invalid_branch_name"
    const val DIRECTORY_EXISTS = "worktree_directory_exists"
    const val NOT_A_WORKTREE = "not_a_worktree"
    const val CANNOT_REMOVE_MAIN = "cannot_remove_main_worktree"
    const val DIRTY = "worktree_dirty"
    const val ACCESS_DENIED = "access_denied"
    const val DIRECTORY_NOT_FOUND = "directory_not_found"
}

/**
 * What a failed worktree call means for the pane.
 *
 * [Dirty] is the 409 `worktree_dirty` answer: removing a worktree with
 * uncommitted files is refused once, and the UI asks before retrying with
 * `force` (AGENTS.md invariant: force confirmation, main worktree never
 * removable).
 */
sealed interface WorktreeFailure {
    data object Dirty : WorktreeFailure
    data object BranchRequired : WorktreeFailure
    data object InvalidBranchName : WorktreeFailure
    data object DirectoryExists : WorktreeFailure
    data object NotAWorktree : WorktreeFailure
    data object CannotRemoveMain : WorktreeFailure
    data object AccessDenied : WorktreeFailure
    data object DirectoryNotFound : WorktreeFailure

    /** Anything else; [message] is display-ready. */
    data class Other(val message: String) : WorktreeFailure
}

/** Maps an [ApiError] (or any throwable) onto the pane's reaction. */
fun worktreeFailure(error: Throwable): WorktreeFailure = when (error) {
    is ApiError.ServerResponse -> when (error.code) {
        WorktreeCode.DIRTY -> WorktreeFailure.Dirty
        WorktreeCode.BRANCH_REQUIRED -> WorktreeFailure.BranchRequired
        WorktreeCode.INVALID_BRANCH_NAME -> WorktreeFailure.InvalidBranchName
        WorktreeCode.DIRECTORY_EXISTS -> WorktreeFailure.DirectoryExists
        WorktreeCode.NOT_A_WORKTREE -> WorktreeFailure.NotAWorktree
        WorktreeCode.CANNOT_REMOVE_MAIN -> WorktreeFailure.CannotRemoveMain
        WorktreeCode.ACCESS_DENIED -> WorktreeFailure.AccessDenied
        WorktreeCode.DIRECTORY_NOT_FOUND -> WorktreeFailure.DirectoryNotFound
        // A 409 without the code is still git refusing a dirty worktree.
        else -> if (error.status == 409) WorktreeFailure.Dirty else WorktreeFailure.Other(error.userMessage())
    }
    is ApiError.Forbidden -> WorktreeFailure.AccessDenied
    else -> WorktreeFailure.Other(error.userMessage())
}

/** Characters git's own ref rules reject (`lib/worktree.ts` `addWorktree`). */
private val INVALID_BRANCH_CHARACTERS = Regex("[\\s\\u0000-\\u001f\\u007f~^:?*\\[\\]\\\\]")

/** Characters that cannot appear in the directory name of a branch. */
private val BRANCH_DIR_SEPARATORS = Regex("[/\\\\:*?\"<>|\\s]+")

/** `sanitizeBranchForDir`: `feature/login x` → `feature-login-x`. */
fun sanitizeBranchForDir(branch: String): String =
    BRANCH_DIR_SEPARATORS.replace(branch, "-").trim('-')

/**
 * Rejects a branch before the request when git certainly would
 * (`branch_required` / `invalid_branch_name`), so the pane can keep the input
 * open and say why. `null` means "send it and let git decide".
 */
fun validateWorktreeBranch(branch: String): WorktreeFailure? {
    val trimmed = branch.trim()
    if (trimmed.isEmpty()) return WorktreeFailure.BranchRequired
    // A bare positional like `--force` would be read as flags by `git worktree add -b`.
    if (trimmed.startsWith("-")) return WorktreeFailure.InvalidBranchName
    if (INVALID_BRANCH_CHARACTERS.containsMatchIn(trimmed)) return WorktreeFailure.InvalidBranchName
    if (trimmed.contains("..") || trimmed.endsWith(".lock")) return WorktreeFailure.InvalidBranchName
    if (trimmed.startsWith(".") || trimmed.endsWith(".")) return WorktreeFailure.InvalidBranchName
    if (sanitizeBranchForDir(trimmed).isEmpty()) return WorktreeFailure.InvalidBranchName
    return null
}

/** `<repoRoot>-worktrees/<sanitized-branch>`; `null` for an unusable branch. */
fun worktreeTargetPath(repoRoot: String, branch: String): String? {
    val root = repoRoot.trimEnd('/', '\\')
    val directory = sanitizeBranchForDir(branch.trim())
    if (root.isEmpty() || directory.isEmpty()) return null
    val separator = if (root.contains('\\')) "\\" else "/"
    return "$root$WORKTREE_DIR_SUFFIX$separator$directory"
}

/**
 * AGENTS.md / web `showWorktreeSwitcher`: only a Git top-level (main checkout
 * or a linked worktree) gets a worktree list. A repo subdirectory keeps its
 * own workspace identity and must not inherit the repository's worktrees.
 */
fun isWorktreeContextAvailable(list: WorktreeList): Boolean =
    list.isGit && list.isTopLevel && list.projectRoot.isNotBlank()

/**
 * The worktree the given cwd belongs to, or the main checkout. Paths compare
 * case-folded on Windows forms (`comparableProjectPath`), because the cwd may
 * be spelled with another drive-letter or directory case than git reports.
 */
fun currentWorktreePath(worktrees: List<WorktreeEntry>, cwd: String?): String? {
    if (cwd.isNullOrBlank()) return worktrees.firstOrNull { it.isMain }?.path
    val key = comparableProjectPath(cwd)
    return worktrees.firstOrNull { comparableProjectPath(it.path) == key }?.path
        ?: worktrees.firstOrNull { it.isMain }?.path
}

/** The main worktree is not removable (AGENTS.md); the pane also hides the action. */
fun canRemoveWorktree(worktree: WorktreeEntry): Boolean = !worktree.isMain

/** Optimistic `POST` result: append the created worktree unless it is listed already. */
fun withCreatedWorktree(worktrees: List<WorktreeEntry>, created: WorktreeEntry): List<WorktreeEntry> {
    val key = comparableProjectPath(created.path)
    if (worktrees.any { comparableProjectPath(it.path) == key }) return worktrees
    return worktrees + created
}

/** Optimistic `DELETE` result. */
fun withoutWorktree(worktrees: List<WorktreeEntry>, path: String): List<WorktreeEntry> {
    val key = comparableProjectPath(path)
    return worktrees.filter { comparableProjectPath(it.path) != key }
}

/**
 * Where the effective cwd moves when [removedPath] was the current worktree:
 * back to the main checkout, never onto the deleted directory.
 */
fun worktreeCwdAfterRemove(projectRoot: String, removedPath: String, currentPath: String?): String? =
    if (currentPath != null && comparableProjectPath(currentPath) == comparableProjectPath(removedPath)) {
        projectRoot
    } else {
        null
    }

/**
 * Web `AppShell.sessionWorktreeRemoved`: the open session's folder belongs to
 * [repoProjectRoot]'s worktree list, which no longer contains it — the
 * checkout was removed, so the explorer must not keep it as its workspace.
 */
fun sessionWorktreeRemoved(
    sessionCwd: String?,
    sessionProjectRoot: String?,
    repoProjectRoot: String?,
    worktrees: List<WorktreeEntry>,
): Boolean {
    if (sessionCwd.isNullOrBlank() || repoProjectRoot.isNullOrBlank()) return false
    val sessionProject = sessionProjectRoot?.takeIf { it.isNotBlank() } ?: sessionCwd
    if (comparableProjectPath(sessionProject) != comparableProjectPath(repoProjectRoot)) return false
    val cwd = comparableProjectPath(sessionCwd)
    return worktrees.none { entry ->
        val root = comparableProjectPath(entry.path)
        cwd == root || cwd.startsWith("$root/")
    }
}

/**
 * The explorer's workspace: the open session's folder first (unless its
 * worktree was removed), then the sidebar's effective cwd, then the
 * new-session target — web `AppShell.explorerCwd`.
 */
fun explorerWorkspace(
    sessionCwd: String?,
    sessionWorktreeRemoved: Boolean,
    sidebarCwd: String?,
    newSessionCwd: String?,
): String? =
    sessionCwd?.takeIf { !sessionWorktreeRemoved && it.isNotBlank() }
        ?: sidebarCwd?.takeIf { it.isNotBlank() }
        ?: newSessionCwd?.takeIf { it.isNotBlank() }
