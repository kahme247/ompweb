package io.github.kahme247.ompweb.ui.files

import io.github.kahme247.ompweb.domain.FileEntry
import io.github.kahme247.ompweb.domain.GitFileDiff
import io.github.kahme247.ompweb.domain.GitFileStatus
import io.github.kahme247.ompweb.domain.GitStatusResponse
import io.github.kahme247.ompweb.domain.MAX_UPLOAD_BYTES_PER_FILE
import io.github.kahme247.ompweb.domain.comparableFilePath
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.SessionEventSource
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.FileReadResult
import io.github.kahme247.ompweb.net.GitApi
import io.github.kahme247.ompweb.net.MAX_FILE_SEARCH_LIMIT
import io.github.kahme247.ompweb.net.UploadFile
import io.github.kahme247.ompweb.testutil.FakeFilesApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Phase 9's Files view model: tabs/restore, cross-session reads, the diff
 * path, the explorer's refresh/reveal, uploads and search — including the
 * generation guards that keep a late answer from overwriting a newer state.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FilesViewModelTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test
    fun `a tab reads through the session that opened it`() = runTest {
        val api = FakeFilesApi()
        api.contents["repo/src/a.kt"] = FileReadResult.Text("val a = 1", "kotlin", 9)
        val vm = newVm(api)
        vm.setCwd("/repo")
        vm.openTab("src/a.kt", sourceSessionId = "session-2")
        advanceUntilIdle()

        val tab = vm.state.value.activeTab
        assertNotNull(tab)
        assertEquals("/repo/src/a.kt", tab!!.path)
        assertEquals("val a = 1", tab.content)
        assertEquals("kotlin", tab.language)
        assertFalse(tab.loading)
        // The tab's own session authorizes the read, not the visible chat.
        assertEquals(listOf(listOf("repo", "src", "a.kt") to "session-2"), api.reads)
    }

    @Test
    fun `a failed read shows the error and retry reads again`() = runTest {
        val api = FakeFilesApi()
        api.failure = ApiError.Http(500, "boom")
        val vm = newVm(api)
        vm.setCwd("/repo")
        vm.openTab("/repo/a.kt")
        advanceUntilIdle()

        val failed = vm.state.value.activeTab!!
        assertNotNull(failed.error)
        assertFalse(failed.loading)

        api.failure = null
        api.contents["repo/a.kt"] = FileReadResult.Text("ok", null, 2)
        vm.retryTab()
        advanceUntilIdle()

        val reloaded = vm.state.value.activeTab!!
        assertNull(reloaded.error)
        assertEquals("ok", reloaded.content)
    }

    @Test
    fun `a diff tab fetches the patch instead of the bytes`() = runTest {
        val api = FakeFilesApi()
        api.contents["repo/a.kt"] = FileReadResult.Text("new text", "kotlin", 8)
        val patch = "@@ -1 +1 @@\n-a\n+b\n"
        val git = FakeGitApi(patches = mapOf("/repo/a.kt" to patch))
        val vm = newVm(api, git)
        vm.setCwd("/repo")
        vm.openTab("/repo/a.kt", mode = FileOpenMode.Diff)
        advanceUntilIdle()

        val tab = vm.state.value.activeTab!!
        assertEquals(FileOpenMode.Diff, tab.mode)
        assertEquals(patch, tab.diff)
        // A requested diff must not be downgraded by the (never sent) text read.
        assertTrue(api.reads.isEmpty())
    }

    @Test
    fun `leaving the diff loads the text of a tab that never read it`() = runTest {
        val api = FakeFilesApi()
        api.contents["repo/a.kt"] = FileReadResult.Text("hello", "kotlin", 5)
        val vm = newVm(api, FakeGitApi(patches = mapOf("/repo/a.kt" to "@@\n-a\n+b\n")))
        vm.setCwd("/repo")
        vm.openTab("/repo/a.kt", mode = FileOpenMode.Diff)
        advanceUntilIdle()
        assertTrue(api.reads.isEmpty())

        vm.setMode(FileOpenMode.Source)
        advanceUntilIdle()

        assertEquals("hello", vm.state.value.activeTab!!.content)
    }

    @Test
    fun `a failed patch keeps the diff mode and offers the retry`() = runTest {
        val api = FakeFilesApi()
        val git = FakeGitApi(patches = mapOf("/repo/a.kt" to "@@\n-a\n+b\n"))
        git.failure = ApiError.Http(500, "boom")
        val vm = newVm(api, git)
        vm.setCwd("/repo")
        vm.openTab("/repo/a.kt", mode = FileOpenMode.Diff)
        advanceUntilIdle()

        val failed = vm.state.value.activeTab!!
        assertEquals(FileOpenMode.Diff, failed.mode)
        assertNotNull(failed.diffError)
        assertNull(failed.diff)

        git.failure = null
        vm.retryDiff()
        advanceUntilIdle()

        val retried = vm.state.value.activeTab!!
        assertNull(retried.diffError)
        assertEquals("@@\n-a\n+b\n", retried.diff)
    }

    @Test
    fun `one tab's slow diff does not cancel another tab's`() = runTest {
        val api = FakeFilesApi()
        val gate = CompletableDeferred<Unit>()
        val git = FakeGitApi(patches = mapOf("/repo/a.kt" to "patch-a", "/repo/b.kt" to "patch-b"))
        git.gatePath = "/repo/a.kt"
        git.gate = gate
        val vm = newVm(api, git)
        vm.setCwd("/repo")

        vm.openTab("/repo/a.kt", mode = FileOpenMode.Diff)
        vm.openTab("/repo/b.kt", mode = FileOpenMode.Diff)
        advanceUntilIdle()

        val b = vm.state.value.tabs.first { it.path == "/repo/b.kt" }
        assertEquals("patch-b", b.diff)
        assertFalse(b.diffLoading)

        gate.complete(Unit)
        advanceUntilIdle()

        val a = vm.state.value.tabs.first { it.path == "/repo/a.kt" }
        assertEquals("patch-a", a.diff)
        assertFalse(a.diffLoading)
    }

    @Test
    fun `refreshing clears the row spinner of a listing that is no longer requested`() = runTest {
        val api = FakeFilesApi()
        api.directories["/repo"] = listOf(FileEntry("src", isDir = true))
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        val gate = CompletableDeferred<Unit>()
        api.listingGate = gate
        vm.toggleDirectory("/repo/src")
        val key = comparableFilePath("/repo/src")
        assertTrue(key in vm.state.value.explorer.loading)

        // Collapsed again: the refresh will not ask for it, so its in-flight
        // answer is dropped and the spinner must not survive.
        vm.collapseAll()
        vm.refreshExplorer()
        assertFalse(key in vm.state.value.explorer.loading)

        gate.complete(Unit)
        advanceUntilIdle()
        assertFalse(key in vm.state.value.explorer.loading)
    }

    @Test
    fun `a failed root listing keeps the retry state`() = runTest {
        val api = FakeFilesApi()
        api.failure = ApiError.Http(500, "boom")
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        val explorer = vm.state.value.explorer
        assertNotNull(explorer.error)
        // `rootLoaded` is what hides the error/retry placeholder.
        assertFalse(explorer.rootLoaded)
        assertTrue(explorer.loading.isEmpty())
    }

    @Test
    fun `stored tabs are restored only once the origin is known`() = runTest {
        val store = MemoryFileTabStore()
        store.save("https://omp.test", listOf(StoredFileTab("/repo/a.kt", null)))
        val ready = CompletableDeferred<Unit>()
        var origin: String? = null
        val vm = newVm(
            store = store,
            origin = { origin },
            awaitOrigin = {
                ready.await()
                origin
            },
        )
        advanceUntilIdle()
        assertTrue(vm.state.value.tabs.isEmpty())

        origin = "https://omp.test"
        ready.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf("/repo/a.kt"), vm.state.value.tabs.map { it.path })
    }

    @Test
    fun `another installation's stored tabs are not restored`() = runTest {
        val store = MemoryFileTabStore()
        store.save("https://old.test", listOf(StoredFileTab("/repo/a.kt", null)))
        val vm = newVm(store = store, origin = { "https://omp.test" })
        advanceUntilIdle()
        assertTrue(vm.state.value.tabs.isEmpty())
    }

    @Test
    fun `a picker rejection rides along with the upload progress`() = runTest {
        val api = FakeFilesApi()
        val gate = CompletableDeferred<Unit>()
        api.uploadGate = gate
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        vm.upload(listOf(UploadFile("a.txt", "x".toByteArray())), pickError = "Upload failed: nope")
        advanceUntilIdle()

        assertTrue(vm.state.value.explorer.upload.busy)
        assertEquals("Upload failed: nope", vm.state.value.explorer.upload.error)

        gate.complete(Unit)
        advanceUntilIdle()
        assertNotNull(vm.state.value.explorer.upload.summary)
        assertEquals("Upload failed: nope", vm.state.value.explorer.upload.error)
    }

    @Test
    fun `an empty pick with only rejected URIs shows the picker error alone`() = runTest {
        val api = FakeFilesApi()
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        vm.upload(emptyList(), pickError = "Upload failed: too big")
        advanceUntilIdle()

        assertEquals("Upload failed: too big", vm.state.value.explorer.upload.error)
        assertTrue(api.uploadCalls.isEmpty())
    }

    @Test
    fun `a workspace switch abandons the running upload`() = runTest {
        val api = FakeFilesApi()
        val gate = CompletableDeferred<Unit>()
        api.uploadGate = gate
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()
        vm.upload(listOf(UploadFile("a.txt", "x".toByteArray())))
        advanceUntilIdle()
        assertTrue(vm.state.value.explorer.upload.busy)

        vm.setCwd("/other")
        advanceUntilIdle()
        gate.complete(Unit)
        advanceUntilIdle()

        val explorer = vm.state.value.explorer
        assertEquals("/other", explorer.cwd)
        assertFalse(explorer.upload.busy)
        assertNull(explorer.upload.summary)
    }

    @Test
    fun `reset abandons the running upload`() = runTest {
        val api = FakeFilesApi()
        val gate = CompletableDeferred<Unit>()
        api.uploadGate = gate
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()
        vm.upload(listOf(UploadFile("a.txt", "x".toByteArray())))
        advanceUntilIdle()
        assertTrue(vm.state.value.explorer.upload.busy)

        vm.reset()
        gate.complete(Unit)
        advanceUntilIdle()

        // The cancelled job must not write its summary into the reset state.
        val upload = vm.state.value.explorer.upload
        assertEquals(UploadPhase.Idle, upload.phase)
        assertFalse(upload.busy)
        assertNull(upload.summary)
        assertTrue(vm.state.value.tabs.isEmpty())
    }

    @Test
    fun `a 413 names the file and the server's size limits`() = runTest {
        val api = FakeFilesApi()
        api.uploadFailure = ApiError.Http(413, "")
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        vm.upload(listOf(UploadFile("big.bin", "x".toByteArray())))
        advanceUntilIdle()

        val failed = vm.state.value.explorer.upload.summary!!.failed.single()
        assertEquals("big.bin", failed.name)
        assertEquals("Too large for the server (25 MB per file, 100 MB per upload).", failed.message)
    }

    @Test
    fun `a 60 MB selection uploads one request per file, each under the per-file cap`() = runTest {
        val api = FakeFilesApi()
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        // The rebased server buffers at most 26 MiB before auth, so the phone
        // may never put more than one 25 MiB file into a request: 100 MB still
        // work, across several requests.
        val twenty = ByteArray(20 * 1024 * 1024)
        val files = listOf("a.bin", "b.bin", "c.bin").map { UploadFile(it, twenty) }

        vm.upload(files)
        advanceUntilIdle()

        assertEquals("one request per file", files.map { it.name }, api.uploadCalls.map { it.name })
        assertTrue(
            "no request carries more than the per-file cap: ${api.uploadCalls.map { it.bytes.size }}",
            api.uploadCalls.all { it.bytes.size <= MAX_UPLOAD_BYTES_PER_FILE },
        )
        assertEquals(60L * 1024 * 1024, api.uploadCalls.sumOf { it.bytes.size.toLong() })
    }

    @Test
    fun `search asks the shared file index for files of the workspace`() = runTest {
        val api = FakeFilesApi()
        api.indexMatches("src/a.kt")
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        vm.setSearchOpen(true)
        vm.setSearchQuery("a")
        // Typing does not hit the index: the debounce has to elapse first.
        advanceTimeBy(SEARCH_DEBOUNCE_MILLIS - 1)
        assertTrue(api.indexCalls.isEmpty())
        advanceTimeBy(2)
        advanceUntilIdle()

        assertEquals(listOf("src/a.kt"), vm.state.value.explorer.searchResults.map { it.path })
        val call = api.indexCalls.single()
        assertEquals("/repo", call.cwd)
        assertEquals("a", call.query)
        assertEquals(MAX_FILE_SEARCH_LIMIT, call.limit)
        assertTrue(call.filesOnly)
    }

    @Test
    fun `a reveal scrolls only to a row that exists and then expires`() = runTest {
        val api = FakeFilesApi()
        api.directories["/repo"] = listOf(FileEntry("a.txt", isDir = false, size = 3))
        val vm = newVm(api)
        vm.setCwd("/repo")
        advanceUntilIdle()

        vm.reveal("/repo/a.txt")
        runCurrent()
        assertNotNull(vm.state.value.explorer.revealTarget)

        // The pane acknowledges the (found) row, so the one-shot target is gone.
        vm.acknowledgeReveal()
        assertNull(vm.state.value.explorer.revealTarget)

        // An unacknowledged reveal is cleared by its own timeout, not before.
        vm.reveal("/repo/a.txt")
        runCurrent()
        assertNotNull(vm.state.value.explorer.revealTarget)
        advanceTimeBy(REVEAL_TIMEOUT_MILLIS - 1)
        assertNotNull(vm.state.value.explorer.revealTarget)
        advanceTimeBy(2)
        runCurrent()
        assertNull(vm.state.value.explorer.revealTarget)
    }

    @Test
    fun `opening a tab at a line keeps the line for the viewer`() = runTest {
        val api = FakeFilesApi()
        api.contents["repo/a.kt"] = FileReadResult.Text("one\ntwo\nthree", "kotlin", 14)
        val vm = newVm(api)
        vm.setCwd("/repo")
        vm.openTab("/repo/a.kt", line = 2)
        advanceUntilIdle()
        assertEquals(2, vm.state.value.activeTab!!.line)
    }

    private fun TestScope.newVm(
        api: FakeFilesApi = FakeFilesApi(),
        git: GitApi = FakeGitApi(),
        store: FileTabStore = MemoryFileTabStore(),
        origin: () -> String? = { ORIGIN },
        awaitOrigin: (suspend () -> String?)? = null,
    ): FilesViewModel {
        // A scope of its own on the test scheduler: `advanceUntilIdle`/`runCurrent`
        // drive it, and its endless watch collectors never keep `runTest` alive.
        val vmScope = CoroutineScope(StandardTestDispatcher(testScheduler))
        vmScopes += vmScope
        return FilesViewModel(
            api = api,
            git = git,
            events = FakeEvents(),
            scope = vmScope,
            tabStore = store,
            cacheDir = temp.newFolder("cache-${cacheCounter++}"),
            origin = origin,
            awaitOrigin = awaitOrigin ?: { origin() },
        )
    }

    @After
    fun cancelViewModels() {
        vmScopes.forEach { it.cancel() }
        vmScopes.clear()
    }

    private var cacheCounter = 0
    private val vmScopes = mutableListOf<CoroutineScope>()

    private class FakeGitApi(
        private val patches: Map<String, String> = emptyMap(),
    ) : GitApi {
        var changed: List<GitFileStatus> = emptyList()
        var failure: Exception? = null
        var gatePath: String? = null
        var gate: CompletableDeferred<Unit>? = null

        override suspend fun status(cwd: String): GitStatusResponse =
            GitStatusResponse(isGitRepository = true, repositoryRoot = cwd, files = changed)

        override suspend fun diff(cwd: String, path: String): GitFileDiff {
            if (path == gatePath) gate?.await()
            failure?.let { throw it }
            val patch = patches[path]
            return GitFileDiff(supported = patch != null, patch = patch)
        }
    }

    private class FakeEvents : SessionEventSource {
        override val state = MutableStateFlow(ConnectionState.Connected)
        private val frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 8)

        override fun subscribe(channel: EventChannel): Flow<JsonObject> = frames
    }

    private companion object {
        const val ORIGIN = "https://omp.test"

        // Mirrors `FilesViewModel`'s (private) timing constants.
        const val SEARCH_DEBOUNCE_MILLIS = 150L
        const val REVEAL_TIMEOUT_MILLIS = 1500L
    }
}
