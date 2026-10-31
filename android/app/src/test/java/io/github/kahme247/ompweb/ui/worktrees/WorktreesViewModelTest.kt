package io.github.kahme247.ompweb.ui.worktrees

import io.github.kahme247.ompweb.domain.sanitizeBranchForDir
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.net.WorktreeList
import io.github.kahme247.ompweb.net.WorktreesApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The worktrees view model against the route contract: which repo the rows
 * belong to, create/switch/remove (optimistic, then the server's list), the
 * dirty → force flow, and the one cache shared with the new-session select.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class WorktreesViewModelTest {

    private class FakeWorktreesApi(
        var root: String = "/repo",
        var isGit: Boolean = true,
        var isTopLevel: Boolean = true,
    ) : WorktreesApi {
        val worktrees = mutableListOf(WorktreeEntry(path = root, branch = "main", isMain = true))
        val listCalls = mutableListOf<String>()
        val creates = mutableListOf<Pair<String, String>>()
        val removes = mutableListOf<Triple<String, String, Boolean>>()
        var listFailure: Throwable? = null
        var createFailure: Throwable? = null
        var removeDirtyOnce = false

        private fun snapshot(): WorktreeList = WorktreeList(
            projectRoot = root,
            isGit = isGit,
            isTopLevel = isTopLevel,
            currentWorktreePath = root,
            worktrees = worktrees.toList(),
        )

        override suspend fun list(cwd: String): WorktreeList {
            listCalls += cwd
            listFailure?.let { throw it }
            return snapshot()
        }

        override suspend fun create(cwd: String, branch: String): WorktreeEntry {
            creates += cwd to branch
            createFailure?.let { throw it }
            val entry = WorktreeEntry(
                path = "$root-worktrees/${sanitizeBranchForDir(branch)}",
                branch = branch,
            )
            worktrees += entry
            return entry
        }

        override suspend fun remove(cwd: String, path: String, force: Boolean) {
            removes += Triple(cwd, path, force)
            if (removeDirtyOnce && !force) {
                removeDirtyOnce = false
                throw ApiError.ServerResponse(409, "worktree_dirty", "Worktree contains modified files")
            }
            worktrees.removeAll { it.path == path }
        }
    }

    private fun withFeat(api: FakeWorktreesApi): String {
        val path = "${api.root}-worktrees/feat"
        api.worktrees += WorktreeEntry(path = path, branch = "feat")
        return path
    }

    @Test
    fun `loads the list and marks the worktree the cwd belongs to`() = runTest {
        val api = FakeWorktreesApi()
        val feat = withFeat(api)
        val vm = WorktreesViewModel(api, this)

        vm.load(feat)
        advanceUntilIdle()

        val state = vm.state.value
        assertTrue(state.available)
        assertEquals("/repo", state.projectRoot)
        assertEquals(feat, state.currentPath)
        assertEquals(2, state.worktrees.size)
        assertFalse(state.busy)
        assertNull(state.error)
    }

    @Test
    fun `a repo subdirectory gets no worktree context`() = runTest {
        val api = FakeWorktreesApi(isTopLevel = false)
        val vm = WorktreesViewModel(api, this)

        vm.load("/repo/src")
        advanceUntilIdle()

        assertFalse(vm.state.value.available)
        assertTrue(vm.state.value.worktrees.isEmpty())
        assertNull(vm.state.value.projectRoot)
    }

    @Test
    fun `a failed list is shown with the server wording`() = runTest {
        val api = FakeWorktreesApi()
        api.listFailure = ApiError.Forbidden("denied")
        val vm = WorktreesViewModel(api, this)

        vm.load("/repo")
        advanceUntilIdle()

        assertTrue(vm.state.value.ready)
        assertEquals("Not allowed", vm.state.value.error)
        assertFalse(vm.state.value.loading)
    }

    @Test
    fun `switching emits the new cwd without touching the list`() = runTest {
        val api = FakeWorktreesApi()
        val feat = withFeat(api)
        val vm = WorktreesViewModel(api, this)
        val events = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            vm.switched.collect { events += it }
        }

        vm.load("/repo")
        advanceUntilIdle()
        vm.select(feat)
        advanceUntilIdle()

        assertEquals(feat, vm.state.value.currentPath)
        assertEquals(listOf(feat), events)
        assertTrue(api.creates.isEmpty())
    }

    @Test
    fun `create posts the project root and selects the new checkout`() = runTest {
        val api = FakeWorktreesApi()
        val vm = WorktreesViewModel(api, this)
        val events = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            vm.switched.collect { events += it }
        }

        vm.load("/repo")
        advanceUntilIdle()
        val before = api.listCalls.size
        vm.create("  feature/x  ")
        advanceUntilIdle()

        assertEquals(listOf("/repo" to "feature/x"), api.creates)
        val created = "/repo-worktrees/feature-x"
        assertEquals(created, vm.state.value.currentPath)
        assertEquals(created, vm.state.value.worktrees.last().path)
        assertEquals(listOf(created), events)
        assertFalse(vm.state.value.busy)
        // The list is refreshed from the server after the optimistic insert.
        assertTrue(api.listCalls.size > before)
    }

    @Test
    fun `an invalid branch never reaches the server`() = runTest {
        val api = FakeWorktreesApi()
        val vm = WorktreesViewModel(api, this)
        vm.load("/repo")
        advanceUntilIdle()

        vm.create("-force")
        advanceUntilIdle()
        assertEquals(WorktreeStrings().invalidBranch, vm.state.value.error)
        assertTrue(api.creates.isEmpty())

        vm.create("   ")
        advanceUntilIdle()
        assertEquals(WorktreeStrings().branchRequired, vm.state.value.error)
        assertTrue(api.creates.isEmpty())
    }

    @Test
    fun `a rejected create shows the mapped wording`() = runTest {
        val api = FakeWorktreesApi()
        api.createFailure = ApiError.ServerResponse(400, "invalid_branch_name", "Invalid branch name: a b")
        val vm = WorktreesViewModel(api, this)
        vm.load("/repo")
        advanceUntilIdle()

        vm.create("feat")
        advanceUntilIdle()

        assertEquals(WorktreeStrings().invalidBranch, vm.state.value.error)
        assertFalse(vm.state.value.busy)
        assertEquals(1, vm.state.value.worktrees.size)
    }

    @Test
    fun `removing a dirty worktree asks before forcing`() = runTest {
        val api = FakeWorktreesApi()
        val feat = withFeat(api)
        api.removeDirtyOnce = true
        val vm = WorktreesViewModel(api, this)
        vm.load("/repo")
        advanceUntilIdle()

        vm.remove(feat)
        advanceUntilIdle()

        assertEquals(feat, vm.state.value.confirmRemove)
        assertNull(vm.state.value.error)
        assertEquals(2, vm.state.value.worktrees.size)
        assertEquals(Triple("/repo", feat, false), api.removes.single())

        vm.remove(feat, force = true)
        advanceUntilIdle()

        assertNull(vm.state.value.confirmRemove)
        assertEquals(1, vm.state.value.worktrees.size)
        assertEquals(Triple("/repo", feat, true), api.removes.last())
    }

    @Test
    fun `removing the current checkout moves back to the main checkout`() = runTest {
        val api = FakeWorktreesApi()
        val feat = withFeat(api)
        val vm = WorktreesViewModel(api, this)
        val events = mutableListOf<String>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            vm.switched.collect { events += it }
        }
        vm.load(feat)
        advanceUntilIdle()

        vm.remove(feat)
        advanceUntilIdle()

        assertEquals("/repo", vm.state.value.currentPath)
        assertTrue(events.contains("/repo"))
        assertEquals(listOf("/repo"), vm.state.value.worktrees.map { it.path })
    }

    @Test
    fun `the main worktree cannot be removed`() = runTest {
        val api = FakeWorktreesApi()
        val vm = WorktreesViewModel(api, this)
        vm.load("/repo")
        advanceUntilIdle()

        vm.remove("/repo")
        advanceUntilIdle()

        assertEquals(WorktreeStrings().cannotRemoveMain, vm.state.value.error)
        assertTrue(api.removes.isEmpty())
    }

    @Test
    fun `the list is cached per repository`() = runTest {
        val api = FakeWorktreesApi()
        val feat = withFeat(api)
        val vm = WorktreesViewModel(api, this)

        vm.load("/repo")
        advanceUntilIdle()
        assertEquals(1, api.listCalls.size)

        // The worktree of the same repo is answered from the cache.
        vm.load(feat)
        advanceUntilIdle()
        assertEquals(1, api.listCalls.size)
        assertEquals(feat, vm.state.value.currentPath)
    }
}
