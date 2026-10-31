package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.net.WorktreeList
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The worktree rules of `lib/worktree.ts`, `app/api/worktrees/route.ts` and
 * `components/WorktreesPanel.tsx` as the Android client applies them: which
 * workspaces show the tab, which worktree is current, where a created checkout
 * lands, which branches are rejected before the request, and the dirty →
 * force flow.
 */
class WorktreesTest {

    private fun entry(path: String, branch: String? = null, isMain: Boolean = false) =
        WorktreeEntry(path = path, branch = branch, isMain = isMain)

    private fun list(
        root: String = "/work/repo",
        isGit: Boolean = true,
        isTopLevel: Boolean = true,
        worktrees: List<WorktreeEntry> = listOf(entry(root, "main", isMain = true)),
    ) = WorktreeList(
        projectRoot = root,
        isGit = isGit,
        isTopLevel = isTopLevel,
        currentWorktreePath = root,
        worktrees = worktrees,
    )

    @Test
    fun `sanitizes a branch into the checkout directory name`() {
        assertEquals("feature-login-x", sanitizeBranchForDir("feature/login x"))
        assertEquals("padded", sanitizeBranchForDir("  padded  "))
        assertEquals("a-b-c-d-e-f-g-h-i", sanitizeBranchForDir("""a:b*c?d"e<f>g|h\i"""))
        assertEquals("x", sanitizeBranchForDir("---x---"))
        assertEquals("", sanitizeBranchForDir(" / "))
    }

    @Test
    fun `rejects the branch names git rejects, keeps valid refs`() {
        assertEquals(WorktreeFailure.BranchRequired, validateWorktreeBranch(""))
        assertEquals(WorktreeFailure.BranchRequired, validateWorktreeBranch("   "))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("-force"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("feature x"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("a..b"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch(".hidden"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("trailing."))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("x.lock"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("feat~1"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("feat^2"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("a:b"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("a?b"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("a*b"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("a[b"))
        assertEquals(WorktreeFailure.InvalidBranchName, validateWorktreeBranch("""a\b"""))

        assertNull(validateWorktreeBranch("feature/login"))
        assertNull(validateWorktreeBranch("fix-123"))
        assertNull(validateWorktreeBranch("  release/2.0  "))
    }

    @Test
    fun `places new checkouts under repo-root-worktrees`() {
        assertEquals("/work/repo-worktrees/feature-x", worktreeTargetPath("/work/repo", "feature/x"))
        assertEquals("/work/repo-worktrees/main", worktreeTargetPath("/work/repo/", "main"))
        assertEquals(
            """C:\work\repo-worktrees\fix-1""",
            worktreeTargetPath("""C:\work\repo""", "fix/1"),
        )
        assertNull(worktreeTargetPath("/work/repo", "   "))
        assertNull(worktreeTargetPath("", "main"))
    }

    @Test
    fun `maps the route's error codes onto the pane's reaction`() {
        assertEquals(
            WorktreeFailure.Dirty,
            worktreeFailure(ApiError.ServerResponse(409, WorktreeCode.DIRTY, "contains modified files")),
        )
        // A 409 without the code is still git refusing a dirty worktree.
        assertEquals(
            WorktreeFailure.Dirty,
            worktreeFailure(ApiError.ServerResponse(409, null, "is dirty")),
        )
        assertEquals(
            WorktreeFailure.BranchRequired,
            worktreeFailure(ApiError.ServerResponse(400, WorktreeCode.BRANCH_REQUIRED, "branch is required")),
        )
        assertEquals(
            WorktreeFailure.InvalidBranchName,
            worktreeFailure(ApiError.ServerResponse(400, WorktreeCode.INVALID_BRANCH_NAME, "Invalid branch name: x")),
        )
        assertEquals(
            WorktreeFailure.DirectoryExists,
            worktreeFailure(ApiError.ServerResponse(400, WorktreeCode.DIRECTORY_EXISTS, "exists")),
        )
        assertEquals(
            WorktreeFailure.NotAWorktree,
            worktreeFailure(ApiError.ServerResponse(400, WorktreeCode.NOT_A_WORKTREE, "not a worktree")),
        )
        assertEquals(
            WorktreeFailure.CannotRemoveMain,
            worktreeFailure(ApiError.ServerResponse(400, WorktreeCode.CANNOT_REMOVE_MAIN, "main")),
        )
        assertEquals(
            WorktreeFailure.AccessDenied,
            worktreeFailure(ApiError.Forbidden("denied")),
        )
        assertEquals(
            WorktreeFailure.Other("fatal: not a git repository"),
            worktreeFailure(ApiError.ServerResponse(400, null, "fatal: not a git repository")),
        )
        assertEquals(
            WorktreeFailure.Other("Cannot reach the server"),
            worktreeFailure(ApiError.Network(IOException("offline"))),
        )
    }

    @Test
    fun `resolves the current worktree case-insensitively and falls back to main`() {
        val worktrees = listOf(
            entry("""C:\work\repo""", "main", isMain = true),
            entry("""C:\work\repo-worktrees\feat""", "feat"),
        )

        assertEquals("""C:\work\repo-worktrees\feat""", currentWorktreePath(worktrees, "c:/WORK/REPO-worktrees/FEAT"))
        assertEquals("""C:\work\repo""", currentWorktreePath(worktrees, """C:\work\repo"""))
        // A cwd that is not a worktree top level (session in a subdirectory) is not "current".
        assertEquals("""C:\work\repo""", currentWorktreePath(worktrees, """C:\work\repo\src"""))
        assertEquals("""C:\work\repo""", currentWorktreePath(worktrees, null))
        assertNull(currentWorktreePath(emptyList(), """C:\work\repo"""))
    }

    @Test
    fun `the tab only applies to a git top level`() {
        assertTrue(isWorktreeContextAvailable(list()))
        assertFalse(isWorktreeContextAvailable(list(isTopLevel = false)))
        assertFalse(isWorktreeContextAvailable(list(isGit = false)))
        assertFalse(isWorktreeContextAvailable(list(root = "")))
    }

    @Test
    fun `created and removed worktrees update the list optimistically`() {
        val main = entry("C:/work/repo", "main", isMain = true)
        val created = entry("C:/work/repo-worktrees/feat", "feat")

        val afterCreate = withCreatedWorktree(listOf(main), created)
        assertEquals(listOf(main, created), afterCreate)
        // A refresh that already landed must not duplicate the row (Windows casing).
        assertEquals(afterCreate, withCreatedWorktree(afterCreate, entry("c:/WORK/repo-worktrees/FEAT", "feat")))

        val afterRemove = withoutWorktree(afterCreate, "c:/WORK/repo-worktrees/feat")
        assertEquals(listOf(main), afterRemove)
        assertEquals(afterRemove, withoutWorktree(afterRemove, "C:/work/repo-worktrees/feat"))
    }

    @Test
    fun `removing the current checkout moves the cwd back to the main checkout`() {
        assertEquals(
            "/work/repo",
            worktreeCwdAfterRemove("/work/repo", "/work/repo-worktrees/feat", "/work/repo-worktrees/feat"),
        )
        // Case-folded comparison on Windows forms.
        assertEquals(
            """C:\work\repo""",
            worktreeCwdAfterRemove("""C:\work\repo""", """C:\work\repo-worktrees\feat""", "c:/WORK/REPO-WORKTREES/FEAT"),
        )
        assertNull(worktreeCwdAfterRemove("/work/repo", "/work/repo-worktrees/feat", "/work/repo"))
        assertNull(worktreeCwdAfterRemove("/work/repo", "/work/repo-worktrees/feat", null))
    }

    @Test
    fun `the main worktree is never removable`() {
        assertFalse(canRemoveWorktree(entry("/work/repo", "main", isMain = true)))
        assertTrue(canRemoveWorktree(entry("/work/repo-worktrees/feat", "feat")))
    }

    @Test
    fun `a session whose worktree was removed falls back to the sidebar cwd`() {
        val main = entry("/work/repo", "main", isMain = true)
        val feat = entry("/work/repo-worktrees/feat", "feat")

        // The list still has the checkout: the session's folder is the explorer's.
        assertFalse(
            sessionWorktreeRemoved(
                sessionCwd = "/work/repo-worktrees/feat",
                sessionProjectRoot = "/work/repo",
                repoProjectRoot = "/work/repo",
                worktrees = listOf(main, feat),
            ),
        )
        assertEquals(
            "/work/repo-worktrees/feat",
            explorerWorkspace(
                sessionCwd = "/work/repo-worktrees/feat",
                sessionWorktreeRemoved = false,
                sidebarCwd = "/work/repo",
                newSessionCwd = "/work/repo",
            ),
        )

        // After the removal only the main checkout is left: the explorer must
        // not keep running on the deleted folder (web `sessionWorktreeRemoved`).
        assertTrue(
            sessionWorktreeRemoved(
                sessionCwd = "/work/repo-worktrees/feat",
                sessionProjectRoot = "/work/repo",
                repoProjectRoot = "/work/repo",
                worktrees = listOf(main),
            ),
        )
        assertEquals(
            "/work/repo",
            explorerWorkspace(
                sessionCwd = "/work/repo-worktrees/feat",
                sessionWorktreeRemoved = true,
                sidebarCwd = "/work/repo",
                newSessionCwd = null,
            ),
        )
    }

    @Test
    fun `a session outside the repo and a subdirectory are never removed worktrees`() {
        val worktrees = listOf(entry("/work/repo", "main", isMain = true))

        assertFalse(sessionWorktreeRemoved("/other/session", "/other", "/work/repo", worktrees))
        // A subdirectory below the main checkout belongs to that worktree.
        assertFalse(sessionWorktreeRemoved("/work/repo/src", "/work/repo", "/work/repo", worktrees))
        // No loaded repo list (non-repo workspace, still loading) proves nothing.
        assertFalse(sessionWorktreeRemoved("/work/repo-worktrees/feat", "/work/repo", null, emptyList()))

        // The new-session target is the last fallback when neither is usable.
        assertEquals(
            "/work/pane",
            explorerWorkspace(
                sessionCwd = null,
                sessionWorktreeRemoved = false,
                sidebarCwd = " ",
                newSessionCwd = "/work/pane",
            ),
        )
    }
}
