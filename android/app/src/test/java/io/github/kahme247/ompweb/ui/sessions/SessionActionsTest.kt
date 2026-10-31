package io.github.kahme247.ompweb.ui.sessions

import androidx.lifecycle.ViewModelStore
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.WorkspacePreferences
import io.github.kahme247.ompweb.domain.ToolPreset
import io.github.kahme247.ompweb.events.Backoff
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.net.EventPostResult
import io.github.kahme247.ompweb.events.EventStream
import io.github.kahme247.ompweb.events.EventTransport
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.ProjectLaunchConfig
import io.github.kahme247.ompweb.net.ProjectList
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import java.util.Collections
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

/**
 * Proof for the session and project actions the drawer's menus trigger:
 * rename (B1), copy transcript (B1), archive/delete (B1), project alias, hide
 * and launch config (B2), HTML export (B4), transcript import (B5), refresh
 * (B6) and the archive browser's load/filter/selection (B34).
 *
 * The mock server behaves like the real route (PATCH persists, DELETE removes)
 * so the reload after an action is asserted end to end.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionActionsTest {

    private lateinit var server: MockWebServer
    private lateinit var address: ServerAddress
    private lateinit var scope: CoroutineScope
    private lateinit var store: ViewModelStore
    private lateinit var viewModel: SessionsViewModel
    private val json = Json { ignoreUnknownKeys = true }

    private val recorded = Collections.synchronizedList(mutableListOf<RecordedRequest>())
    private val projects = Collections.synchronizedList(mutableListOf<ManagedProject>())

    @Volatile private var sessionList: String = """{"sessions":[],"runningSessionIds":[]}"""

    @Volatile private var detailBody: String =
        """{"sessionId":"s1","info":{"id":"s1","name":"Fix the drawer","cwd":"/work/x","messageCount":1},"context":{}}"""

    @Volatile private var exportBody: String = "<html><body>transcript</body></html>"

    /** Bodies are consumed in the dispatcher; the assertions read these copies. */
    @Volatile private var renameBody: String? = null
    @Volatile private var importBody: String? = null
    @Volatile private var launchBody: String? = null

    /** When set, PATCH /api/sessions/s1 answers with this instead of 200. */
    @Volatile private var renameResponse: MockResponse? = null

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                recorded += request
                val path = request.path.orEmpty().substringBefore('?')
                return when {
                    path == "/api/sessions" -> json(200, sessionList)
                    path == "/api/sessions/import" -> {
                        importBody = request.body.readUtf8()
                        json(200, """{"ok":true}""")
                    }
                    path == "/api/sessions/s1/archive" -> json(200, """{"ok":true}""")
                    path == "/api/sessions/s1/export" -> MockResponse()
                        .setResponseCode(200)
                        .setHeader("Content-Type", "text/html")
                        .setHeader("Content-Disposition", "attachment; filename=\"fix-the-drawer.html\"")
                        .setBody(exportBody)
                    path == "/api/sessions/s1" -> when (request.method) {
                        "PATCH" -> {
                            renameBody = request.body.readUtf8()
                            renameResponse ?: json(200, """{"ok":true}""")
                        }
                        "DELETE" -> json(200, """{"ok":true}""")
                        else -> json(200, detailBody)
                    }
                    path == "/api/projects" -> when (request.method) {
                        "POST" -> json(200, """{"project":{"path":"/work/new"}}""")
                        "PATCH" -> {
                            val body = request.body.readUtf8()
                            if (body.contains("launchConfig")) launchBody = body
                            applyProjectPatch(body)
                            json(200, """{"ok":true}""")
                        }
                        "DELETE" -> {
                            val cwd = json.parseToJsonElement(request.body.readUtf8())
                                .jsonObject["cwd"]?.jsonPrimitive?.content.orEmpty()
                            projects.removeAll { it.path == cwd }
                            json(200, """{"ok":true}""")
                        }
                        else -> json(
                            200,
                            json.encodeToString(ProjectList.serializer(), ProjectList(projects.toList())),
                        )
                    }
                    path == "/api/home" -> json(200, """{"home":"/home/test"}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        viewModel = SessionsViewModel(
            api = ApiClient(OkHttpClient(), { address }),
            eventMux = eventMux(),
            preferences = FakePreferences(),
            originNow = { address },
        )
        store = ViewModelStore()
        store.put("sessions", viewModel)
    }

    @After
    fun tearDown() {
        store.clear()
        scope.cancel()
        server.shutdown()
    }

    @Test
    fun `renaming a session patches the title and reloads the list`() {
        sessionList = """{"sessions":[{"id":"s1","cwd":"/work/x"}],"runningSessionIds":[]}"""
        viewModel.refresh()
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }
        val listCallsBefore = requests("GET", "/api/sessions").size

        viewModel.renameSession("s1", "  Fix the drawer  ")

        waitFor("rename acknowledged") { viewModel.state.value.notice?.text == "Session renamed" }
        assertEquals(
            "the trimmed title is the patch body",
            "Fix the drawer",
            json.parseToJsonElement(renameBody.orEmpty()).jsonObject["name"]?.jsonPrimitive?.content,
        )
        waitFor("list reloaded after the rename") {
            requests("GET", "/api/sessions").size == listCallsBefore + 1
        }
    }

    @Test
    fun `a busy agent refuses the rename instead of writing behind omp`() {
        sessionList = """{"sessions":[{"id":"s1","cwd":"/work/x"}],"runningSessionIds":[]}"""
        viewModel.refresh()
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }
        val listCallsBefore = requests("GET", "/api/sessions").size

        // Rebased servers answer the PATCH with 503 `session_slow` while a
        // live wrapper owns the title; the disk fallback must not claim it.
        renameResponse = json(
            503,
            """{"error":"omp is busy and did not answer in time; the session keeps running.","code":"session_slow"}""",
        )
        viewModel.renameSession("s1", "New title")

        waitFor("rename refused") { viewModel.state.value.notice?.error == true }
        val notice = viewModel.state.value.notice?.text.orEmpty()
        assertTrue("the busy answer is explained: $notice", notice.contains("busy"))
        assertTrue("the user is told to retry: $notice", notice.contains("Try again"))
        assertTrue("no success is claimed: $notice", !notice.contains("Session renamed"))
        assertEquals(
            "a refused rename does not reload the list as if it had worked",
            listCallsBefore,
            requests("GET", "/api/sessions").size,
        )
    }

    @Test
    fun `copy transcript renders the detail messages as markdown`() {
        sessionList = """{"sessions":[{"id":"s1","name":"Fix the drawer","cwd":"/work/x"}],"runningSessionIds":[]}"""
        detailBody = """
            {"sessionId":"s1","info":{"id":"s1","name":"Fix the drawer","cwd":"/work/x","messageCount":2},
             "context":{"messages":[
               {"role":"user","content":[{"type":"text","text":"Why is the bar hidden?"}]},
               {"role":"assistant","content":[{"type":"text","text":"Because the list filled the column."}]}
             ]}}
        """.trimIndent()
        viewModel.refresh()
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }

        val markdown = runBlocking { viewModel.transcriptMarkdown("s1") }.orEmpty()

        assertTrue("the title heads the transcript: $markdown", markdown.startsWith("# Fix the drawer"))
        assertTrue("the cwd is included: $markdown", markdown.contains("/work/x"))
        assertTrue("the user turn is present: $markdown", markdown.contains("## User"))
        assertTrue("the prompt survives: $markdown", markdown.contains("Why is the bar hidden?"))
        assertTrue("the answer survives: $markdown", markdown.contains("## Assistant"))
        assertTrue(
            "the assistant text survives: $markdown",
            markdown.contains("Because the list filled the column."),
        )
    }

    @Test
    fun `archiving a session drops the selection and drafts in its cwd`() {
        sessionList = """{"sessions":[{"id":"s1","cwd":"/work/x"}],"runningSessionIds":[]}"""
        detailBody = """{"sessionId":"s1","info":{"id":"s1","cwd":"/work/x","messageCount":1},"context":{}}"""
        viewModel.refresh()
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }
        viewModel.selectSession("s1")
        waitFor("detail open") { viewModel.state.value.selectedSessionId == "s1" }

        viewModel.archiveSession("s1")

        waitFor("archived") { viewModel.state.value.notice?.text == "Session archived" }
        assertNull("the archived session is closed", viewModel.state.value.selectedSessionId)
        assertEquals(
            "the next session starts in the archived session's workspace",
            "/work/x",
            viewModel.state.value.newSessionCwd,
        )
        assertTrue(
            "archive posts to the session's archive route",
            requests("POST", "/api/sessions/s1/archive").isNotEmpty(),
        )
    }

    @Test
    fun `deleting a session posts the delete and closes it`() {
        sessionList = """{"sessions":[{"id":"s1","cwd":"/work/x"}],"runningSessionIds":[]}"""
        detailBody = """{"sessionId":"s1","info":{"id":"s1","cwd":"/work/x","messageCount":1},"context":{}}"""
        viewModel.refresh()
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }
        viewModel.selectSession("s1")
        waitFor("detail open") { viewModel.state.value.selectedSessionId == "s1" }

        viewModel.deleteSession("s1")

        waitFor("deleted") { viewModel.state.value.notice?.text == "Session deleted" }
        assertNull("the deleted session is closed", viewModel.state.value.selectedSessionId)
        assertTrue(
            "delete uses the DELETE verb on the session",
            requests("DELETE", "/api/sessions/s1").isNotEmpty(),
        )
    }

    @Test
    fun `project alias hide and launch config are patched through`() {
        projects += ManagedProject("/work/x")
        viewModel.refresh()
        waitFor("projects loaded") { viewModel.state.value.projects.isNotEmpty() }

        viewModel.renameProject("/work/x", "Ops")
        waitFor("alias persisted") { projects.single().alias == "Ops" }

        viewModel.saveProjectLaunchConfig(
            "/work/x",
            ProjectLaunchConfig(profile = "fast", advisor = true, extraArgs = listOf("--verbose")),
        )
        waitFor("launch config persisted") {
            projects.single().launchConfig?.profile == "fast" &&
                projects.single().launchConfig?.advisor == true
        }
        val body = json.parseToJsonElement(launchBody.orEmpty()).jsonObject
        assertEquals("/work/x", body["cwd"]?.jsonPrimitive?.content)
        assertEquals("fast", body["launchConfig"]?.jsonObject?.get("profile")?.jsonPrimitive?.content)
        assertEquals(true, body["launchConfig"]?.jsonObject?.get("advisor")?.jsonPrimitive?.booleanOrNull)
        assertEquals(
            "--verbose",
            body["launchConfig"]?.jsonObject?.get("extraArgs")?.jsonArray?.single()?.jsonPrimitive?.content,
        )

        viewModel.removeProject("/work/x")
        waitFor("project hidden") {
            viewModel.state.value.notice?.text == "Project hidden" && projects.isEmpty()
        }
        assertTrue("hide deletes the registry entry", requests("DELETE", "/api/projects").isNotEmpty())
    }

    @Test
    fun `export html returns the server body and file name`() {
        sessionList = """{"sessions":[{"id":"s1","cwd":"/work/x"}],"runningSessionIds":[]}"""
        viewModel.refresh()
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }

        val exported = runBlocking { viewModel.exportHtml("s1") }

        assertTrue("the export is returned", exported != null)
        assertEquals("fix-the-drawer.html", exported!!.fileName)
        assertEquals(exportBody, String(exported.body, Charsets.UTF_8))
    }

    @Test
    fun `import posts the file and reloads the list`() {
        viewModel.refresh()
        waitFor("initial list") { !viewModel.state.value.loading }
        val listCallsBefore = requests("GET", "/api/sessions").size

        viewModel.importSession("taken.jsonl", """{"type":"session"}""")

        waitFor("import acknowledged") { viewModel.state.value.notice?.text == "Session imported" }
        val body = json.parseToJsonElement(importBody.orEmpty()).jsonObject
        assertEquals("taken.jsonl", body["fileName"]?.jsonPrimitive?.content)
        assertEquals("""{"type":"session"}""", body["content"]?.jsonPrimitive?.content)
        waitFor("list reloaded after the import") {
            requests("GET", "/api/sessions").size == listCallsBefore + 1
        }
    }

    @Test
    fun `refresh reloads the list`() {
        sessionList = """{"sessions":[{"id":"a"}],"runningSessionIds":[]}"""
        viewModel.refresh()
        waitFor("initial list") { viewModel.state.value.sessions.size == 1 }
        val listCallsBefore = requests("GET", "/api/sessions").size

        sessionList = """{"sessions":[{"id":"a"},{"id":"b"}],"runningSessionIds":[]}"""
        viewModel.refresh()

        waitFor("reloaded after refresh") { viewModel.state.value.sessions.size == 2 }
        assertEquals(
            "the refresh really issued a new list request",
            listCallsBefore + 1,
            requests("GET", "/api/sessions").size,
        )
    }

    @Test
    fun `the archive browser loads, filters and selects an entry`() {
        val archiveServer = MockWebServer()
        archiveServer.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty().substringBefore('?')
                return when {
                    path == "/api/sessions/archive" -> json(
                        200,
                        """
                        {"archives":[
                          {"key":"arch-1","id":"s-old","cwd":"/work/x","name":"Old session",
                           "firstMessage":"Hello","status":"archived","messageCount":3},
                          {"key":"arch-2","id":"s-other","cwd":"/work/y","name":"Fresh session",
                           "firstMessage":"World","status":"archived","messageCount":1}
                        ]}
                        """.trimIndent(),
                    )
                    path == "/api/sessions" -> json(200, """{"sessions":[],"runningSessionIds":[]}""")
                    path == "/api/projects" -> json(200, """{"projects":[]}""")
                    path == "/api/home" -> json(200, """{"home":"/home/test"}""")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        archiveServer.start()
        try {
            val origin = (ServerAddress.parse("http://127.0.0.1:${archiveServer.port}") as ServerAddressResult.Valid).address
            val other = SessionsViewModel(
                api = ApiClient(OkHttpClient(), { origin }),
                eventMux = eventMux(),
                preferences = FakePreferences(),
                originNow = { origin },
            )
            val otherStore = ViewModelStore()
            otherStore.put("archive", other)
            try {
                other.openArchive()
                waitFor("archive loaded") { other.state.value.archive.entries.size == 2 }
                val visible = visibleArchiveEntries(other.state.value.archive.entries, "OLD")
                assertEquals("the filter matches the name", 1, visible.size)
                assertEquals("arch-1", visible.single().key)
                assertTrue("the search is echoed", other.state.value.archive.search.isEmpty())
                other.setArchiveSearch("world")
                assertEquals(
                    "the search narrows to the other entry",
                    "arch-2",
                    visibleArchiveEntries(other.state.value.archive.entries, other.state.value.archive.search)
                        .single().key,
                )
                other.selectArchiveEntry("arch-1")
                assertEquals("arch-1", other.state.value.archive.selectedKey)
            } finally {
                otherStore.clear()
            }
        } finally {
            archiveServer.shutdown()
        }
    }

    private fun applyProjectPatch(body: String) {
        val element = json.parseToJsonElement(body).jsonObject
        val cwd = element["cwd"]?.jsonPrimitive?.content ?: return
        val index = projects.indexOfFirst { it.path == cwd }
        if (index < 0) return
        val current = projects[index]
        val alias = element["alias"]?.jsonPrimitive?.contentOrNull ?: current.alias
        val configElement = element["launchConfig"]
        val config = when {
            configElement == null -> current.launchConfig
            configElement is JsonNull -> null
            else -> {
                val obj = configElement.jsonObject
                ProjectLaunchConfig(
                    profile = obj["profile"]?.jsonPrimitive?.contentOrNull,
                    advisor = obj["advisor"]?.jsonPrimitive?.booleanOrNull,
                    extraArgs = obj["extraArgs"]?.jsonArray?.map { it.jsonPrimitive.content },
                )
            }
        }
        projects[index] = current.copy(alias = alias, launchConfig = config)
    }

    private fun eventMux(): EventMux = EventMux(
        transport = object : EventTransport {
            override suspend fun open(): EventStream = awaitCancellation()

            override suspend fun subscribe(
                connectionId: String,
                id: String,
                channel: EventChannel,
            ): EventPostResult = EventPostResult.Ok

            override suspend fun unsubscribe(connectionId: String, id: String) = Unit
        },
        scope = scope,
        backoff = Backoff(baseMillis = 10, maxMillis = 20, jitterRatio = 0.0, random = Random(0)),
    )

    private fun json(code: Int, body: String): MockResponse = MockResponse()
        .setResponseCode(code)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun requests(method: String, path: String): List<RecordedRequest> =
        synchronized(recorded) {
            recorded.filter { it.method == method && it.path?.substringBefore('?') == path }
        }

    private fun waitFor(message: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 8_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        fail("$message; state=${viewModel.state.value}")
    }

    private class FakePreferences : WorkspacePreferences {
        private val state = MutableStateFlow(SettingsSnapshot(loaded = true))
        override val snapshot: StateFlow<SettingsSnapshot> = state

        override suspend fun setExpandedProjects(projects: Set<String>) {
            state.update { it.copy(expandedProjects = projects) }
        }

        override suspend fun setUnreadSessionIds(ids: Set<String>) {
            state.update { it.copy(unreadSessionIds = ids) }
        }

        override suspend fun setPinnedSessions(origin: String, ids: Set<String>) {
            state.update {
                it.copy(
                    pinnedSessionsByOrigin = it.pinnedSessionsByOrigin.toMutableMap().apply {
                        if (ids.isEmpty()) remove(origin) else put(origin, ids)
                    },
                )
            }
        }

        override suspend fun setToolPreset(preset: ToolPreset) {
            state.update { it.copy(toolPreset = preset.wireName) }
        }

        override suspend fun setLastNewSessionView(cwd: String) {
            state.update { it.copy(lastNewSessionCwd = cwd, lastSessionId = null) }
        }

        override suspend fun setLastSessionView(sessionId: String) {
            state.update { it.copy(lastSessionId = sessionId, lastNewSessionCwd = null) }
        }

        override suspend fun clearLastNewSessionView() {
            state.update { it.copy(lastNewSessionCwd = null) }
        }

        override suspend fun clearLastSession() {
            state.update { it.copy(lastSessionId = null) }
        }
    }

    companion object {
        @JvmStatic
        @BeforeClass
        fun installMain() {
            Dispatchers.setMain(Dispatchers.Default)
        }
    }
}
