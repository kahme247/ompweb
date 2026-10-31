package io.github.kahme247.ompweb.ui.sessions

import androidx.lifecycle.ViewModelStore
import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.domain.SttClaim
import io.github.kahme247.ompweb.domain.SttJob
import io.github.kahme247.ompweb.domain.SttJobStatus
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import io.github.kahme247.ompweb.net.SttApi
import io.github.kahme247.ompweb.net.SttAudio
import io.github.kahme247.ompweb.net.SttRetryOutcome
import io.github.kahme247.ompweb.net.SttStartOutcome
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.net.WorktreeList
import io.github.kahme247.ompweb.net.worktreesApi
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import io.github.kahme247.ompweb.testutil.MemoryDictationStore
import io.github.kahme247.ompweb.testutil.MemoryDrafts
import io.github.kahme247.ompweb.ui.composer.ComposerStrings
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import io.github.kahme247.ompweb.ui.worktrees.WorktreeCache
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The composer's workspace selection drives the request bodies: a directory
 * picked in the directory browser (or a worktree chip) must be the cwd that
 * `POST /api/agent/new` receives, and the model catalog must be reloaded for
 * that workspace (Slice B's controls own it now).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NewSessionViewModelTest {

    private lateinit var server: MockWebServer
    private lateinit var address: ServerAddress
    private lateinit var scope: CoroutineScope
    private lateinit var store: ViewModelStore
    private lateinit var viewModel: NewSessionViewModel
    private lateinit var worktreeCache: WorktreeCache
    private val stt = PaneSttApi()
    private val drafts = MemoryDrafts()
    private val createdSessions = CopyOnWriteArrayList<CreatedSession>()
    private val requestedCwds = mutableListOf<String>()
    @Volatile private var createBody: String? = null
    @Volatile private var promptBody: String? = null
    @Volatile private var commandBody: String? = null
    @Volatile private var createCalls = 0
    /** Overrides the `/api/cwd/validate` answer for the invalid-workspace cases. */
    @Volatile private var cwdValidation: MockResponse? = null
    @Volatile private var cwdValidationCalls = 0

    @Before
    fun setUp() {
        Dispatchers.setMain(Dispatchers.Default)
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                return when {
                    path.startsWith("/api/models") -> {
                        requestedCwds += request.requestUrl?.queryParameter("cwd").orEmpty()
                        json(
                            """{"models":{},"modelList":[{"id":"m1","provider":"p","thinkingLevels":["off"]}]}""",
                        )
                    }
                    path.startsWith("/api/worktrees") -> json("""{"worktrees":[]}""")
                    // `prepare` validates the workspace before Send is allowed
                    // (A9); every prepared cwd in this class is acceptable
                    // unless a test overrides the answer.
                    path == "/api/cwd/validate" -> {
                        cwdValidationCalls++
                        cwdValidation ?: json(
                            """{"success":true,"cwd":"/home/test/project","projectRoot":"/home/test"}""",
                        )
                    }
                    path == "/api/agent/new" -> {
                        createCalls++
                        createBody = request.body.readUtf8()
                        json("""{"success":true,"sessionId":"new-1"}""")
                    }
                    path.startsWith("/api/agent/new-1") -> {
                        val body = request.body.readUtf8()
                        if (body.contains("\"type\":\"bash\"")) commandBody = body else promptBody = body
                        json("""{"ok":true}""")
                    }
                    path.startsWith("/api/agent/") -> json("""{"ok":true}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val api = ApiClient(OkHttpClient(), { address })
        val settings = FakeChatSettings()
        worktreeCache = WorktreeCache(api.worktreesApi())
        viewModel = NewSessionViewModel(
            api = api,
            drafts = drafts,
            composerStrings = ComposerStrings(noSession = NO_SESSION, cwdInvalid = CWD_INVALID),
            controls = ComposerControlsViewModel(api, settings, scope),
            dictation = DictationViewModel(stt, MemoryDictationStore(), scope, clock = { 0L }),
            worktreeCache = worktreeCache,
        )
        scope.launch { viewModel.created.collect { createdSessions += it } }
        store = ViewModelStore()
        store.put("new-session", viewModel)
    }

    @After
    fun tearDown() {
        store.clear()
        scope.cancel()
        // Main stays installed: testMainDispatcher rejects resetMain() while the
        // view model's fire-and-forget coroutines are still unwinding, which
        // made this race intermittently.
        server.shutdown()
    }

    @Test
    fun `a picked directory replaces the prepared workspace and is used for creation`() {
        viewModel.prepare("/home/test/project")
        waitFor("models for the initial workspace") { viewModel.controls.state.value.models.isNotEmpty() }

        viewModel.setCwd("/home/test/picked")
        waitFor("models for the picked workspace") {
            viewModel.state.value.cwd == "/home/test/picked" &&
                viewModel.state.value.cwdValid == true &&
                viewModel.controls.state.value.models.isNotEmpty()
        }

        viewModel.composer.setText("Reply with OK")
        viewModel.send()
        waitFor("session created in the picked workspace") { createdSessions.isNotEmpty() }

        assertEquals(CreatedSession("new-1", "/home/test/picked"), createdSessions.single())
        assertTrue(
            "the models request must follow the picked directory",
            requestedCwds.contains("/home/test/picked"),
        )
        assertTrue(
            "creation body must carry the picked cwd: $createBody",
            createBody?.contains("\"cwd\":\"/home/test/picked\"") == true,
        )
        assertTrue(
            "the first prompt goes to the created session: $promptBody",
            promptBody?.contains("\"message\":\"Reply with OK\"") == true,
        )
    }

    @Test
    fun `a worktree created in the files panel reaches the open pane`() {
        viewModel.prepare("/home/test/project")
        waitFor("pane prepared") { viewModel.state.value.cwd == "/home/test/project" }
        waitFor("initial worktree list") { !viewModel.state.value.worktreesLoading }

        // The Files panel's Worktrees tab shares this cache; its create/remove
        // stores the fresh list there (Bug 19: no cwd change follows, so the
        // pane has to follow the cache instead of a re-prepare).
        worktreeCache.put(
            "/home/test/project",
            WorktreeList(
                projectRoot = "/home/test/project",
                isGit = true,
                isTopLevel = true,
                worktrees = listOf(
                    WorktreeEntry("/home/test/project", branch = "main", isMain = true),
                    WorktreeEntry("/home/test/project-worktrees/feat", branch = "feat"),
                ),
            ),
        )

        waitFor("the select follows the shared cache") { viewModel.state.value.worktrees.size == 2 }
        assertEquals("/home/test/project", viewModel.state.value.currentWorktreePath)
        assertFalse(viewModel.state.value.worktreesLoading)
    }

    @Test
    fun `attached images ride along with the first prompt`() {
        viewModel.prepare("/home/test/project")
        // Send is gated on the workspace validation (A9): wait for both the
        // models and the `/api/cwd/validate` answer before tapping.
        waitFor("models loaded") { viewModel.controls.state.value.models.isNotEmpty() }
        waitFor("workspace validated") { viewModel.state.value.cwdValid == true }

        viewModel.composer.setText("Look at this")
        viewModel.composer.addImages(listOf(ComposerImage("iVBORw0KGgo=", "image/png")))
        viewModel.send()
        waitFor("session created") { createdSessions.isNotEmpty() }

        val body = promptBody.orEmpty()
        assertTrue("prompt carries the image: $body", body.contains("\"images\""))
        assertTrue("prompt carries the base64 data: $body", body.contains("iVBORw0KGgo="))
    }

    @Test
    fun `a shell command creates the session and runs the command`() {
        viewModel.prepare("/home/test/project")
        // Send is gated on the workspace validation (A9): wait for both the
        // models and the `/api/cwd/validate` answer before tapping.
        waitFor("models loaded") { viewModel.controls.state.value.models.isNotEmpty() }
        waitFor("workspace validated") { viewModel.state.value.cwdValid == true }

        viewModel.composer.setText("!!ls -la")
        viewModel.send()
        waitFor("shell command sent") { createdSessions.isNotEmpty() }

        assertEquals("new-1", createdSessions.single().id)
        val body = commandBody.orEmpty()
        assertTrue("the command body is a bash RPC: $body", body.contains("\"type\":\"bash\""))
        assertTrue("the command is forwarded: $body", body.contains("\"command\":\"ls -la\""))
        assertTrue("a double bang excludes the output: $body", body.contains("\"excludeFromContext\":true"))
        assertNull("no prompt turn is started beside the command", promptBody)
        assertEquals("the started command clears the composer", "", viewModel.composer.state.value.text)
    }

    @Test
    fun `a btw question creates the session and hands the question to the chat`() {
        viewModel.prepare("/home/test/project")
        // Send is gated on the workspace validation (A9): wait for both the
        // models and the `/api/cwd/validate` answer before tapping.
        waitFor("models loaded") { viewModel.controls.state.value.models.isNotEmpty() }
        waitFor("workspace validated") { viewModel.state.value.cwdValid == true }

        viewModel.composer.setText("/btw which file owns auth?")
        viewModel.send()
        waitFor("session created") { createdSessions.isNotEmpty() }

        assertEquals(
            CreatedSession("new-1", "/home/test/project", sideQuestion = "/btw which file owns auth?"),
            createdSessions.single(),
        )
        assertNull("a side question is not sent as a prompt turn", promptBody)
        assertEquals("the composer clears once the question is handed over", "", viewModel.composer.state.value.text)
    }

    @Test
    fun `a builtin command without a session keeps the text`() {
        viewModel.prepare("/home/test/project")
        // Send is gated on the workspace validation (A9): wait for both the
        // models and the `/api/cwd/validate` answer before tapping.
        waitFor("models loaded") { viewModel.controls.state.value.models.isNotEmpty() }
        waitFor("workspace validated") { viewModel.state.value.cwdValid == true }

        viewModel.composer.setText("/compact")
        viewModel.send()
        waitFor("notice shown") { viewModel.state.value.notice != null }

        assertEquals(NO_SESSION, viewModel.state.value.notice)
        assertTrue("a builtin never creates a session", createdSessions.isEmpty())
        assertEquals("the typed command stays", "/compact", viewModel.composer.state.value.text)
        assertEquals("nothing was created", 0, createCalls)
    }

    @Test
    fun `a web slash command reaches the agent as its expanded prompt`() {
        viewModel.prepare("/home/test/project")
        // Send is gated on the workspace validation (A9): wait for both the
        // models and the `/api/cwd/validate` answer before tapping.
        waitFor("models loaded") { viewModel.controls.state.value.models.isNotEmpty() }
        waitFor("workspace validated") { viewModel.state.value.cwdValid == true }

        viewModel.composer.setText("/goal ship it")
        viewModel.send()
        waitFor("prompt sent") { createdSessions.isNotEmpty() }

        assertEquals("new-1", createdSessions.single().id)
        val body = promptBody.orEmpty()
        assertTrue("the expansion is sent: $body", body.contains("Work toward this goal"))
        assertTrue("the argument survives: $body", body.contains("ship it"))
        assertFalse("the raw slash text never reaches omp: $body", body.contains("\"message\":\"/goal"))
    }

    @Test
    fun `a dictated Insert lands in the new-session composer`() {
        stt.liveJobs = listOf(SttJob("job-1", SttJobStatus.Done, null))
        stt.claim = SttClaim("job-1", SttJobStatus.Done, null, "dictated text", SttAfter.Insert)

        viewModel.prepare("/home/test/project")
        waitFor("transcript inserted") { viewModel.composer.state.value.text == "dictated text" }

        assertEquals("Insert never sends", 0, createCalls)
        assertTrue("Insert creates no session", createdSessions.isEmpty())
    }

    @Test
    fun `a dictated Send creates the session and sends the transcript with attachments`() {
        // Typed text and a pending image must ride along, exactly like tapping
        // Send after typing the transcript (web `onTranscript`).
        drafts.setDraft(
            "new:/home/test/project",
            io.github.kahme247.ompweb.data.ChatDraft(
                value = "look",
                images = listOf(ComposerImage("iVBORw0KGgo=", "image/png")),
            ),
        )
        stt.liveJobs = listOf(SttJob("job-1", SttJobStatus.Done, null))
        stt.claim = SttClaim("job-1", SttJobStatus.Done, null, "at this", SttAfter.Send)

        viewModel.prepare("/home/test/project")
        waitFor("dictated first turn created") { createdSessions.isNotEmpty() }

        assertEquals("new-1", createdSessions.single().id)
        val body = promptBody.orEmpty()
        assertTrue("the transcript follows the draft: $body", body.contains("\"message\":\"look at this\""))
        assertTrue("the attached image rides along: $body", body.contains("\"images\""))
        assertTrue("the image data rides along: $body", body.contains("iVBORw0KGgo="))
        assertEquals("the sent draft is cleared", "", viewModel.composer.state.value.text)
    }

    @Test
    fun `an invalid workspace keeps send disabled and shows the server reason`() {
        cwdValidation = MockResponse()
            .setResponseCode(400)
            .setHeader("Content-Type", "application/json")
            .setBody("""{"error":"Directory does not exist: /home/test/missing","code":"directory_not_found"}""")

        viewModel.prepare("/home/test/missing")
        waitFor("validation rejected") {
            viewModel.state.value.cwdValid == false && !viewModel.state.value.validating
        }
        assertEquals(
            "the server's reason is what the pane shows",
            "Directory does not exist: /home/test/missing",
            viewModel.state.value.error,
        )

        viewModel.composer.setText("Hello")
        viewModel.send()
        Thread.sleep(100)
        assertEquals("no session may be created in a dead workspace", 0, createCalls)
        assertEquals("the draft stays in the field", "Hello", viewModel.composer.state.value.text)
        assertEquals(
            "the live Send button says why nothing happened",
            CWD_INVALID,
            viewModel.state.value.notice,
        )
    }

    @Test
    fun `reopening the pane retries a failed workspace check`() {
        cwdValidation = MockResponse().setResponseCode(400).setBody("")
        viewModel.prepare("/home/test/flaky")
        waitFor("first check rejected") {
            viewModel.state.value.cwdValid == false && !viewModel.state.value.validating
        }

        // The reason is gone (the path exists again); the pane comes back and
        // must check again instead of staying invalid forever (A9).
        cwdValidation = null
        viewModel.prepare("/home/test/flaky")
        waitFor("the second prepare validates again") { viewModel.state.value.cwdValid == true }
        assertNull("the stale reason is cleared", viewModel.state.value.error)

        viewModel.composer.setText("Hello")
        viewModel.send()
        waitFor("the session is created after the retry") { createdSessions.isNotEmpty() }
    }

    @Test
    fun `reopening a valid pane does not check again`() {
        viewModel.prepare("/home/test/project")
        waitFor("first check passed") { viewModel.state.value.cwdValid == true }

        // A passing check stays cached while the pane is open: no second call.
        viewModel.prepare("/home/test/project")
        Thread.sleep(100)
        assertEquals("the validated workspace is not re-checked", 1, cwdValidationCalls)
        assertTrue(viewModel.state.value.cwdValid == true)
    }

    @Test
    fun `an invalid workspace without a message leaves error empty for the pane fallback`() {
        cwdValidation = MockResponse().setResponseCode(400).setBody("")

        viewModel.prepare("/home/test/missing")
        waitFor("validation rejected") {
            viewModel.state.value.cwdValid == false && !viewModel.state.value.validating
        }
        assertNull(
            "the pane falls back to R.string.cwd_invalid when the server is silent",
            viewModel.state.value.error,
        )
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
        fail("$message; state=${viewModel.state.value} controls=${viewModel.controls.state.value}")
    }

    private companion object {
        const val NO_SESSION = "No active session"
        const val CWD_INVALID = "That workspace is not available"
    }
}

/** A scope with one finished job this pane can adopt, exactly like the web's adopt loop. */
private class PaneSttApi : SttApi {
    @Volatile var liveJobs: List<SttJob> = emptyList()
    @Volatile var claim: SttClaim? = null

    override suspend fun start(
        scope: String?,
        owner: String,
        after: SttAfter?,
        audio: ByteArray,
        fileName: String,
        mimeType: String,
    ): SttStartOutcome = SttStartOutcome.Rejected("not configured")

    override suspend fun jobs(scope: String): List<SttJob> = liveJobs

    override suspend fun job(jobId: String): SttJob? = liveJobs.firstOrNull { it.id == jobId }

    override suspend fun claim(jobId: String, claimToken: String, ownerToken: String): SttClaim? = claim

    override suspend fun discard(jobId: String) = Unit

    override suspend fun retry(jobId: String, ownerToken: String): SttRetryOutcome = SttRetryOutcome.Missing

    override suspend fun audio(jobId: String): SttAudio? = null
}
