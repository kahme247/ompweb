package io.github.kahme247.ompweb.ui.git

import io.github.kahme247.ompweb.domain.GitCollapseReason
import io.github.kahme247.ompweb.domain.GitFileDiff
import io.github.kahme247.ompweb.domain.GitFileStatus
import io.github.kahme247.ompweb.domain.GitFileStatusKind
import io.github.kahme247.ompweb.domain.GitStatusResponse
import io.github.kahme247.ompweb.domain.fileName
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.GitApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Git tab's view model: loading, the web's selection rule, filter/refresh,
 * the `.gitattributes` group and the "late answer for another workspace" guard.
 * No diff is rendered here — a row opens the viewer in Diff mode.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class GitChangesViewModelTest {

    private fun file(
        path: String,
        status: GitFileStatusKind = GitFileStatusKind.MODIFIED,
        collapse: GitCollapseReason? = null,
    ) = GitFileStatus(
        filePath = path,
        status = status,
        code = status.code,
        collapseReason = collapse,
    )

    private class FakeGitApi : GitApi {
        val statuses = mutableMapOf<String, GitStatusResponse>()
        val failures = mutableMapOf<String, Throwable>()
        val calls = mutableListOf<String>()
        var gate: CompletableDeferred<Unit>? = null

        override suspend fun status(cwd: String): GitStatusResponse {
            calls += cwd
            val pending = gate
            if (pending != null) {
                gate = null
                pending.await()
            }
            failures[cwd]?.let { throw it }
            return statuses[cwd] ?: GitStatusResponse(isGitRepository = false, repositoryRoot = null, files = emptyList())
        }

        override suspend fun diff(cwd: String, path: String): GitFileDiff =
            error("the pane opens Slice A's viewer; the view model never fetches a diff")
    }

    @Test
    fun `loads the changes and previews the first reviewable file`() = runTest {
        val api = FakeGitApi()
        api.statuses["/repo"] = GitStatusResponse(
            isGitRepository = true,
            repositoryRoot = "/repo",
            files = listOf(
                file("/repo/graph.json", collapse = GitCollapseReason.NO_DIFF),
                file("/repo/src/App.tsx"),
                file("/repo/notes.txt", GitFileStatusKind.UNTRACKED),
            ),
        )
        val vm = GitChangesViewModel(api, this)

        vm.bind("/repo")
        advanceUntilIdle()

        val state = vm.state.value
        assertTrue(state.loaded)
        assertTrue(state.isRepo)
        assertEquals("/repo", state.cwd)
        assertEquals(3, state.files.size)
        assertEquals("/repo/src/App.tsx", state.selectedPath)
        assertFalse(state.attributeGroupOpen)
    }

    @Test
    fun `a non-repo workspace renders the not-a-repo state`() = runTest {
        val api = FakeGitApi()
        api.statuses["/plain"] = GitStatusResponse(false, null, emptyList())
        val vm = GitChangesViewModel(api, this)

        vm.bind("/plain")
        advanceUntilIdle()

        val state = vm.state.value
        assertTrue(state.loaded)
        assertFalse(state.isRepo)
        assertTrue(state.files.isEmpty())
        assertNull(state.error)
    }

    @Test
    fun `a failed load keeps the message and retry loads again`() = runTest {
        val api = FakeGitApi()
        api.failures["/repo"] = ApiError.Forbidden("denied")
        val vm = GitChangesViewModel(api, this)

        vm.bind("/repo")
        advanceUntilIdle()
        assertEquals("Not allowed", vm.state.value.error)
        assertTrue(vm.state.value.loaded)

        api.failures.remove("/repo")
        api.statuses["/repo"] = GitStatusResponse(true, "/repo", listOf(file("/repo/a.ts")))
        vm.refresh()
        advanceUntilIdle()

        assertEquals(2, api.calls.size)
        assertNull(vm.state.value.error)
        assertTrue(vm.state.value.isRepo)
        assertEquals("/repo/a.ts", vm.state.value.selectedPath)
    }

    @Test
    fun `refresh keeps the previewed file while it still exists`() = runTest {
        val api = FakeGitApi()
        api.statuses["/repo"] = GitStatusResponse(
            true,
            "/repo",
            listOf(file("/repo/a.ts"), file("/repo/b.ts")),
        )
        val vm = GitChangesViewModel(api, this)
        vm.bind("/repo")
        advanceUntilIdle()

        vm.select("/repo/b.ts")
        vm.refresh()
        advanceUntilIdle()

        assertEquals("/repo/b.ts", vm.state.value.selectedPath)

        // A row that vanished falls back to the first reviewable one.
        api.statuses["/repo"] = GitStatusResponse(true, "/repo", listOf(file("/repo/a.ts")))
        vm.refresh()
        advanceUntilIdle()
        assertEquals("/repo/a.ts", vm.state.value.selectedPath)
    }

    @Test
    fun `filter and clear round trip`() = runTest {
        val api = FakeGitApi()
        api.statuses["/repo"] = GitStatusResponse(true, "/repo", listOf(file("/repo/a.ts")))
        val vm = GitChangesViewModel(api, this)
        vm.bind("/repo")
        advanceUntilIdle()

        vm.setFilter("APP")
        assertEquals("APP", vm.state.value.filter)
        vm.clearFilter()
        assertEquals("", vm.state.value.filter)
    }

    @Test
    fun `the gitattributes group opens when nothing else is reviewable`() = runTest {
        val api = FakeGitApi()
        api.statuses["/repo"] = GitStatusResponse(
            true,
            "/repo",
            listOf(file("/repo/graph.json", collapse = GitCollapseReason.GENERATED)),
        )
        val vm = GitChangesViewModel(api, this)
        vm.bind("/repo")
        advanceUntilIdle()

        assertTrue(vm.state.value.attributeGroupOpen)
        vm.toggleAttributeGroup()
        assertFalse(vm.state.value.attributeGroupOpen)
    }

    @Test
    fun `a late answer for the previous workspace is dropped`() = runTest {
        val api = FakeGitApi()
        val gate = CompletableDeferred<Unit>()
        api.gate = gate
        api.statuses["/old"] = GitStatusResponse(true, "/old", listOf(file("/old/old.ts")))
        api.statuses["/new"] = GitStatusResponse(true, "/new", listOf(file("/new/new.ts")))
        val vm = GitChangesViewModel(api, this)

        vm.bind("/old")
        runCurrent()
        vm.bind("/new")
        advanceUntilIdle()
        gate.complete(Unit)
        advanceUntilIdle()

        val state = vm.state.value
        assertEquals("/new", state.cwd)
        assertEquals(listOf("new.ts"), state.files.map { fileName(it.filePath) })
        assertEquals("/new/new.ts", state.selectedPath)
    }

    @Test
    fun `re-entering the tab reloads the changes instead of showing the last visit`() = runTest {
        val api = FakeGitApi()
        api.statuses["/repo"] = GitStatusResponse(true, "/repo", listOf(file("/repo/a.ts")))
        val vm = GitChangesViewModel(api, this)

        vm.activate("/repo")
        advanceUntilIdle()
        assertEquals(1, api.calls.size)
        vm.setFilter("a")

        // Files changed on disk while another tab was shown (agent writes,
        // uploads); returning to Git must pick them up.
        api.statuses["/repo"] = GitStatusResponse(
            true,
            "/repo",
            listOf(file("/repo/a.ts"), file("/repo/b.ts")),
        )
        vm.activate("/repo")
        advanceUntilIdle()

        assertEquals(2, api.calls.size)
        assertEquals(2, vm.state.value.files.size)
        assertEquals("the filter survives a re-entry", "a", vm.state.value.filter)
    }

    @Test
    fun `a missing workspace loads nothing`() = runTest {
        val api = FakeGitApi()
        val vm = GitChangesViewModel(api, this)

        vm.bind(null)
        assertTrue(vm.state.value.loaded)
        assertNull(vm.state.value.cwd)
        assertTrue(vm.state.value.files.isEmpty())

        vm.refresh()
        advanceUntilIdle()
        assertTrue(api.calls.isEmpty())
    }
}
