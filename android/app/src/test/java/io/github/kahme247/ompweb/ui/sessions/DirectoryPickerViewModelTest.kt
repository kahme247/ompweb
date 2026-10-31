package io.github.kahme247.ompweb.ui.sessions

import androidx.lifecycle.ViewModelStore
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * The clone stream is a long blocking HTTP read; cancelling it must not fall
 * back to a local coroutine cancel that can never interrupt the read. The
 * DELETE in this test fails, which is exactly the path the review found
 * stuck on "Cancelling…".
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryPickerViewModelTest {

    private lateinit var server: MockWebServer
    private lateinit var address: ServerAddress
    private lateinit var store: ViewModelStore
    private lateinit var viewModel: DirectoryPickerViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(Dispatchers.Default)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path?.startsWith("/api/cwd/browse") == true) {
                    return json("""{"path":"/work","parentPath":"/","directories":[]}""")
                }
                if (request.path == "/api/projects/clone") {
                    return if (request.method == "DELETE") {
                        MockResponse().setResponseCode(500)
                            .setBody("""{"error":"clone not found"}""")
                    } else {
                        MockResponse()
                            .setResponseCode(200)
                            .setHeader("Content-Type", "application/x-ndjson")
                            .setBody(cloneBody())
                            .throttleBody(1024, 200, TimeUnit.MILLISECONDS)
                    }
                }
                return MockResponse().setResponseCode(404)
            }
        }
        server.start()
        address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        val client = OkHttpClient.Builder().readTimeout(30, TimeUnit.SECONDS).build()
        viewModel = DirectoryPickerViewModel(ApiClient(client, { address }))
        store = ViewModelStore().apply { put("picker", viewModel) }
    }

    @After
    fun tearDown() {
        store.clear()
        server.shutdown()
    }

    @Test
    fun `cancelling a clone whose DELETE fails still drops the stream`() {
        viewModel.start("/work")
        waitFor("directory loaded") { viewModel.state.value.path == "/work" }

        viewModel.setCloneUrl("https://example.com/repo.git")
        viewModel.select { _, _ -> }
        waitFor("clone stream opened") { viewModel.state.value.cloneLog.isNotEmpty() }

        viewModel.cancelClone()

        waitFor("clone cancelled") { viewModel.state.value.cloneStatus == "Clone cancelled" }
        assertEquals(false, viewModel.state.value.cloneRunning)
    }

    @Test
    fun `a 404 before the clone registered drops the stream instead of waiting`() {
        // The server has not responded to the POST yet, so it cannot know the
        // id: the 404 has to mean "cancel locally".
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path?.startsWith("/api/cwd/browse") == true) {
                    return json("""{"path":"/work","parentPath":"/","directories":[]}""")
                }
                if (request.path == "/api/projects/clone") {
                    return if (request.method == "DELETE") {
                        MockResponse().setResponseCode(404).setBody("""{"error":"unknown clone"}""")
                    } else {
                        MockResponse().setResponseCode(200)
                            .setHeader("Content-Type", "application/x-ndjson")
                            .setBody(cloneBody())
                            .throttleBody(1024, 400, TimeUnit.MILLISECONDS)
                            .setHeadersDelay(500, TimeUnit.MILLISECONDS)
                    }
                }
                return MockResponse().setResponseCode(404)
            }
        }
        viewModel.start("/work")
        waitFor("directory loaded") { viewModel.state.value.path == "/work" }

        viewModel.setCloneUrl("https://example.com/repo.git")
        viewModel.select { _, _ -> }
        waitFor("clone request sent") { viewModel.state.value.cloneRunning }

        viewModel.cancelClone()

        waitFor("clone cancelled") { viewModel.state.value.cloneStatus == "Clone cancelled" }
        assertEquals(false, viewModel.state.value.cloneRunning)
    }

    private fun cloneBody(): String = (1..20).joinToString("\n") { index ->
        """{"type":"output","text":"cloning chunk $index ${"x".repeat(800)}"}"""
    } + "\n"

    /**
     * A typed path that the server rejects must stay in the field (so the user
     * can fix one character), block "Select this folder" and show the server's
     * sentence; "Retry" re-browses that typed path, not the directory that
     * happened to be loaded before.
     */
    @Test
    fun `a rejected typed path keeps the input, blocks select and is what retry browses`() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.requestUrl?.queryParameter("path") == "/work") {
                    return json("""{"path":"/work","parentPath":"/","directories":[]}""")
                }
                return MockResponse()
                    .setResponseCode(404)
                    .setHeader("Content-Type", "application/json")
                    .setBody("""{"error":"Directory does not exist","code":"directory_not_found"}""")
            }
        }
        viewModel.start("/work")
        waitFor("directory loaded") { viewModel.state.value.path == "/work" }

        viewModel.setPathInput("/missing")
        viewModel.submitPath()
        waitFor("browse rejected") { !viewModel.state.value.loading && viewModel.state.value.error != null }

        val failed = viewModel.state.value
        assertEquals("Directory does not exist", failed.error)
        assertEquals("/missing", failed.pathInput)
        assertEquals("/work", failed.path)
        assertEquals(false, failed.canSelect)

        drainRequests()
        viewModel.submitPath()
        waitFor("retry answered") { !viewModel.state.value.loading && viewModel.state.value.error != null }
        assertEquals("/missing", server.takeRequest(8, TimeUnit.SECONDS)?.requestUrl?.queryParameter("path"))
    }

    private fun drainRequests() {
        while (server.takeRequest(50, TimeUnit.MILLISECONDS) != null) Unit
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun waitFor(message: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 8_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        throw AssertionError("$message; state=${viewModel.state.value}")
    }
}
