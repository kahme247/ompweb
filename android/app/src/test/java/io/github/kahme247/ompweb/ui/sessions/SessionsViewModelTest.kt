package io.github.kahme247.ompweb.ui.sessions

import androidx.lifecycle.ViewModelStore
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.WorkspacePreferences
import io.github.kahme247.ompweb.domain.ToolPreset
import io.github.kahme247.ompweb.domain.sessionsShowsRefreshError
import io.github.kahme247.ompweb.domain.sessionsShowsUpdating
import io.github.kahme247.ompweb.events.Backoff
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.events.EventStream
import io.github.kahme247.ompweb.events.EventTransport
import io.github.kahme247.ompweb.events.SseFrame
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.AppInfo
import io.github.kahme247.ompweb.net.EventPostResult
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import io.github.kahme247.ompweb.testutil.MemorySessionListCache
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

/**
 * Runtime tests for the two orderings the review found: a GET snapshot that
 * races a live running frame, and the reload after a reconnect. They use real
 * threads (the client really performs requests) and poll the StateFlow.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SessionsViewModelTest {

    private lateinit var server: MockWebServer
    private lateinit var address: ServerAddress
    private lateinit var transport: FakeTransport
    private lateinit var scope: CoroutineScope
    private lateinit var store: ViewModelStore
    private val sessionResponses = java.util.concurrent.LinkedBlockingQueue<MockResponse>()
    private val projectResponses = java.util.concurrent.LinkedBlockingQueue<MockResponse>()
    private val detailResponses = java.util.concurrent.LinkedBlockingQueue<MockResponse>()
    private val cwdResponses = java.util.concurrent.LinkedBlockingQueue<MockResponse>()
    private val autoNameResponses = java.util.concurrent.LinkedBlockingQueue<MockResponse>()
    private val searchResponses = java.util.concurrent.LinkedBlockingQueue<MockResponse>()
    /** Every `/api/sessions/messages/search` path the view model requested. */
    private val searchPaths = java.util.Collections.synchronizedList(mutableListOf<String>())
    /** The shell's `/api/app-info` answer; the app gates "In messages" on it. */
    private val serverInfo = MutableStateFlow<AppInfo?>(
        AppInfo(
            name = "ompweb",
            version = "0.5.2",
            api = 1,
            capabilities = mapOf("messageSearch" to true),
        ),
    )
    private lateinit var viewModel: SessionsViewModel
    private lateinit var mux: EventMux
    private val preferences = FakePreferences()
    private val cache = MemorySessionListCache()

    @Before
    fun setUp() {
        // Main is installed once per class (installMain): calling setMain from
        // every test raced with the previous test's still-unwinding view-model
        // coroutines and failed this class intermittently with "Dispatchers.Main
        // is used concurrently with setting it".
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path?.startsWith("/api/sessions/messages/search") == true -> {
                    searchPaths += request.path.orEmpty()
                    searchResponses.poll() ?: MockResponse().setResponseCode(500)
                }
                request.path?.endsWith("/auto-name") == true ->
                    autoNameResponses.poll() ?: MockResponse().setResponseCode(500)
                request.path?.matches(Regex("/api/sessions/[^/]+")) == true ->
                    detailResponses.poll() ?: MockResponse().setResponseCode(500)
                request.path?.startsWith("/api/sessions") == true ->
                    sessionResponses.poll() ?: MockResponse().setResponseCode(500)
                request.path == "/api/projects" ->
                    projectResponses.poll() ?: json("""{"projects":[]}""")
                request.path == "/api/home" ->
                    json("""{"home":"/home/test"}""")
                request.path == "/api/cwd/validate" ->
                    cwdResponses.poll() ?: MockResponse().setResponseCode(500)
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        transport = FakeTransport()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        mux = EventMux(
            transport = transport,
            scope = scope,
            backoff = Backoff(baseMillis = 10, maxMillis = 20, jitterRatio = 0.0, random = Random(0)),
        )
        viewModel = SessionsViewModel(
            api = ApiClient(OkHttpClient(), { address }),
            eventMux = mux,
            preferences = preferences,
            originNow = { address },
            serverInfo = serverInfo,
            cache = cache,
            // The tests drive real threads via `waitFor`; the cache work runs
            // inline so the seed and the write-through are ordered with the
            // request instead of racing it.
            cacheDispatcher = Dispatchers.Unconfined,
        )
        store = ViewModelStore()
        store.put("sessions", viewModel)
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
    fun `a running frame that races the list request is not overwritten by its snapshot`() {
        sessionResponses.add(
            sessions(
                """{"sessions":[{"id":"a","modified":"2026-10-20T10:00:00.000Z"}],"runningSessionIds":["a"]}""",
            ).setBodyDelay(1_500, java.util.concurrent.TimeUnit.MILLISECONDS),
        )

        viewModel.setActive(true)
        // The GET is on the wire now, its answer still 1.5 s away.
        assertNotNull(server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS))
        val stream = open()
        waitFor("mux connected") { viewModel.state.value.connection == ConnectionState.Connected }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }

        stream.send("s1", """{"type":"running","runningSessionIds":["b"]}""")
        waitFor("live badge applied") { viewModel.state.value.runningIds == setOf("b") }

        waitFor("list loaded") {
            !viewModel.state.value.loading && viewModel.state.value.sessions.isNotEmpty()
        }
        assertEquals(setOf("b"), viewModel.state.value.runningIds)
    }

    @Test
    fun `a reconnect reloads the session list because the server replays nothing`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"a"}],"runningSessionIds":[]}"""))
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"a"},{"id":"b"}],"runningSessionIds":[]}"""),
        )

        viewModel.setActive(true)
        val first = open()
        waitFor("initial list") { viewModel.state.value.sessions.size == 1 }

        first.close()
        waitFor("connection dropped") {
            viewModel.state.value.connection == ConnectionState.Reconnecting
        }

        open()
        waitFor("list reloaded after reconnect") { viewModel.state.value.sessions.size == 2 }
    }

    @Test
    fun `the cached list paints before the server answers`() {
        cache.writeSessions(
            address.origin,
            """{"sessions":[{"id":"cached","cwd":"/w"}],"runningSessionIds":[]}""",
            null,
        )
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"live","cwd":"/w"}],"runningSessionIds":[]}""")
                .setBodyDelay(1_500, java.util.concurrent.TimeUnit.MILLISECONDS),
        )

        viewModel.setActive(true)

        waitFor("cached list on screen") {
            viewModel.state.value.sessions.map { it.id } == listOf("cached")
        }
        assertFalse("the cached list is not a loading state", viewModel.state.value.loading)
        assertTrue("the cached list still revalidates", viewModel.state.value.refreshing)

        waitFor("server answer replaces it") {
            viewModel.state.value.sessions.map { it.id } == listOf("live")
        }
        assertFalse(viewModel.state.value.refreshing)
        assertEquals(
            "the fresh list is written through",
            listOf(address.origin),
            cache.sessionWrites.drop(1),
        )
    }

    @Test
    fun `a cached etag makes the cold-start list request a 304`() {
        cache.writeSessions(
            address.origin,
            """{"sessions":[{"id":"cached","cwd":"/w"}],"runningSessionIds":[]}""",
            "\"v1\"",
        )
        sessionResponses.add(MockResponse().setResponseCode(304))

        viewModel.setActive(true)
        var request = server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS)
        while (request != null && request.path?.startsWith("/api/sessions") != true) {
            request = server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS)
        }
        assertNotNull(request)
        assertEquals("\"v1\"", request!!.headers["If-None-Match"])

        waitFor("validated list kept") {
            !viewModel.state.value.refreshing &&
                viewModel.state.value.sessions.map { it.id } == listOf("cached")
        }
        assertNull("a 304 with a primed list is not an error", viewModel.state.value.error)
    }

    @Test
    fun `a failed revalidation over cached rows shows the error instead of updating forever`() {
        cache.writeSessions(
            address.origin,
            """{"sessions":[{"id":"cached","cwd":"/w"}],"runningSessionIds":["cached"]}""",
            null,
        )
        sessionResponses.add(MockResponse().setResponseCode(500))

        viewModel.setActive(true)

        waitFor("cached list on screen") {
            viewModel.state.value.sessions.map { it.id } == listOf("cached")
        }
        waitFor("list revalidation failed") { viewModel.state.value.error != null }
        assertFalse("no server answer carried the badges", viewModel.state.value.runningKnown)
        assertFalse(
            "the spinner would claim an answer is still on its way",
            sessionsShowsUpdating(
                viewModel.state.value.runningKnown,
                viewModel.state.value.sessions.isNotEmpty(),
                failed = true,
            ),
        )
        assertTrue(
            "the row holds the failure and a retry instead",
            sessionsShowsRefreshError(
                hasRows = viewModel.state.value.sessions.isNotEmpty(),
                failed = viewModel.state.value.error != null,
            ),
        )
    }

    @Test
    fun `cached rows keep saying Updating while the list request is in flight`() {
        cache.writeSessions(
            address.origin,
            """{"sessions":[{"id":"cached","cwd":"/w"}],"runningSessionIds":[]}""",
            null,
        )
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"cached","cwd":"/w"}],"runningSessionIds":[]}""")
                .setBodyDelay(1_500, java.util.concurrent.TimeUnit.MILLISECONDS),
        )

        viewModel.setActive(true)

        waitFor("cached list on screen") {
            viewModel.state.value.sessions.map { it.id } == listOf("cached")
        }
        waitFor("the request left") { viewModel.state.value.refreshing || viewModel.state.value.loading }
        assertNull("an unanswered request is not a failure", viewModel.state.value.error)
        assertTrue(
            "the list says it is still updating",
            sessionsShowsUpdating(
                viewModel.state.value.runningKnown,
                viewModel.state.value.sessions.isNotEmpty(),
                failed = viewModel.state.value.error != null,
            ),
        )
        assertFalse(
            "nothing failed, so there is no error row",
            sessionsShowsRefreshError(
                hasRows = viewModel.state.value.sessions.isNotEmpty(),
                failed = viewModel.state.value.error != null,
            ),
        )
    }

    @Test
    fun `a list answer settles the running badges`() {
        cache.writeSessions(
            address.origin,
            """{"sessions":[{"id":"cached","cwd":"/w"}],"runningSessionIds":[]}""",
            null,
        )
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"live","cwd":"/w"}],"runningSessionIds":["live"]}""")
                .setBodyDelay(800, java.util.concurrent.TimeUnit.MILLISECONDS),
        )

        viewModel.setActive(true)

        waitFor("cached list on screen") {
            viewModel.state.value.sessions.map { it.id } == listOf("cached")
        }
        assertFalse("the disk copy knows no badges", viewModel.state.value.runningKnown)

        waitFor("server answer applied") { viewModel.state.value.runningKnown }
        assertEquals(setOf("live"), viewModel.state.value.runningIds)
        assertFalse(
            "the updating line is gone",
            sessionsShowsUpdating(viewModel.state.value.runningKnown, hasRows = true, failed = false),
        )
    }

    @Test
    fun `a running frame settles the badges without a list answer`() {
        cache.writeSessions(
            address.origin,
            """{"sessions":[{"id":"cached","cwd":"/w"}],"runningSessionIds":[]}""",
            null,
        )
        sessionResponses.add(MockResponse().setResponseCode(500))

        viewModel.setActive(true)
        waitFor("cached list on screen") {
            viewModel.state.value.sessions.map { it.id } == listOf("cached")
        }
        assertFalse(viewModel.state.value.runningKnown)

        val stream = open()
        waitFor("mux connected") { viewModel.state.value.connection == ConnectionState.Connected }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }
        stream.send("s1", """{"type":"running","runningSessionIds":["cached"]}""")

        waitFor("badge from the running channel") { viewModel.state.value.runningKnown }
        assertEquals(setOf("cached"), viewModel.state.value.runningIds)
    }

    @Test
    fun `a failed project revalidation over cached projects keeps the rows without an error`() {
        cache.writeProjects(address.origin, """{"projects":[{"path":"/work/cached"}]}""")
        sessionResponses.add(MockResponse().setResponseCode(500))
        // The project answer arrives later than the cached paint, so the
        // failure really lands on top of visible rows.
        projectResponses.add(
            MockResponse().setResponseCode(500).setBodyDelay(600, java.util.concurrent.TimeUnit.MILLISECONDS),
        )

        viewModel.setActive(true)

        waitFor("cached project on screen") {
            viewModel.state.value.projects.map { it.path } == listOf("/work/cached")
        }
        var request = server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS)
        while (request != null && request.path != "/api/projects") {
            request = server.takeRequest(5, java.util.concurrent.TimeUnit.SECONDS)
        }
        assertNotNull("the project revalidation left", request)
        Thread.sleep(1_500)
        assertNull(
            "a failed revalidation must not paint an error over cached rows",
            viewModel.state.value.projectsError,
        )
        assertEquals(listOf("/work/cached"), viewModel.state.value.projects.map { it.path })
    }

    @Test
    fun `a failed project load without a cache still reports the error`() {
        projectResponses.add(MockResponse().setResponseCode(500))
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))

        viewModel.setActive(true)

        waitFor("project error") { viewModel.state.value.projectsError != null }
        assertEquals(SessionsLoadError.Server(500), viewModel.state.value.projectsError)
        assertTrue("nothing to show", viewModel.state.value.projects.isEmpty())
    }

    @Test
    fun `a fresh session whose file is not on disk yet is retried instead of failing`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"fresh","cwd":"/work/x"}],"runningSessionIds":[]}"""))
        // `requireSuccess` reports the 404 as a plain Http code, not as a
        // parsed ServerResponse — the retry must recognise both.
        detailResponses.add(
            MockResponse().setResponseCode(404).setBody("""{"error":"Session not found","code":"session_not_found"}"""),
        )
        detailResponses.add(
            json(
                """{"sessionId":"fresh","info":{"id":"fresh","cwd":"/work/x","messageCount":2},"context":{"thinkingLevel":"off"}}""",
            ),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }

        viewModel.selectSession("fresh")
        waitFor("detail loaded after the 404") { viewModel.state.value.detail != null }

        assertEquals(2, viewModel.state.value.detail?.info?.messageCount)
        assertEquals(null, viewModel.state.value.detailError)
    }

    @Test
    fun `activating a project expands it and toggling flips only that project`() {
        projectResponses.add(
            json("""{"projects":[{"path":"/work/one"},{"path":"/work/two"}]}"""),
        )
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))

        viewModel.setActive(true)
        waitFor("projects loaded") { viewModel.state.value.projects.size == 2 }
        waitFor("expansion seeded") { viewModel.state.value.expandedProjects != null }
        val one = "/work/one"
        val two = "/work/two"

        viewModel.activateProject(two)
        assertEquals(setOf(one, two), viewModel.state.value.expandedProjects)

        viewModel.toggleProject(two)
        assertEquals(setOf(one), viewModel.state.value.expandedProjects)

        viewModel.toggleProject(two)
        assertEquals(setOf(one, two), viewModel.state.value.expandedProjects)
    }

    @Test
    fun `a cold start keeps the persisted expansion and unread ids`() {
        val preferences = FakePreferences(
            SettingsSnapshot(
                loaded = true,
                expandedProjects = setOf("/work/a", "/work/b"),
                unreadSessionIds = setOf("s1"),
            ),
        )
        projectResponses.add(json("""{"projects":[{"path":"/work/a"},{"path":"/work/b"}]}"""))
        sessionResponses.add(sessions("""{"sessions":[{"id":"s1","cwd":"/work/a"}],"runningSessionIds":[]}"""))
        recreate(preferences)

        viewModel.setActive(true)
        waitFor("projects loaded") { viewModel.state.value.projects.size == 2 }
        waitFor("sessions loaded") { viewModel.state.value.sessions.isNotEmpty() }

        assertEquals(setOf("/work/a", "/work/b"), viewModel.state.value.expandedProjects)
        assertEquals(setOf("s1"), viewModel.state.value.unreadIds)
        // The first load must not reseed (and overwrite) the stored selection.
        assertEquals(setOf("/work/a", "/work/b"), preferences.current.expandedProjects)
        assertEquals(setOf("s1"), preferences.current.unreadSessionIds)
    }

    @Test
    fun `opening an unread session clears and persists its id`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"s1","cwd":"/work/a"}],"runningSessionIds":["s1"]}"""))
        detailResponses.add(
            json("""{"sessionId":"s1","info":{"id":"s1","cwd":"/work/a","messageCount":1},"context":{}}"""),
        )
        viewModel.setActive(true)
        val stream = open()
        waitFor("running badge") { viewModel.state.value.runningIds == setOf("s1") }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }

        // An unselected session that stops running becomes unread.
        stream.send("s1", """{"type":"running","runningSessionIds":[]}""")
        waitFor("unread badge") { viewModel.state.value.unreadIds == setOf("s1") }

        viewModel.selectSession("s1")
        waitFor("unread cleared") { viewModel.state.value.unreadIds.isEmpty() }
        waitFor("unread persisted") { preferences.current.unreadSessionIds.isEmpty() }
    }

    @Test
    fun `a slower older unread write never lands after the newer one`() {
        // The running transition writes {s1} slowly; the selection then clears
        // it. With one `launch` per write the stale {s1} could complete last
        // and leave the badge stored even though the state cleared it.
        val prefs = FakePreferences(writeDelayMillis = { ids -> if (ids.isEmpty()) 0L else 150L })
        recreate(prefs)
        sessionResponses.add(sessions("""{"sessions":[{"id":"s1","cwd":"/work/a"}],"runningSessionIds":["s1"]}"""))
        detailResponses.add(
            json("""{"sessionId":"s1","info":{"id":"s1","cwd":"/work/a","messageCount":1},"context":{}}"""),
        )
        viewModel.setActive(true)
        val stream = open()
        waitFor("running badge") { viewModel.state.value.runningIds == setOf("s1") }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }

        stream.send("s1", """{"type":"running","runningSessionIds":[]}""")
        waitFor("unread badge") { viewModel.state.value.unreadIds == setOf("s1") }
        viewModel.selectSession("s1")
        waitFor("unread cleared") { viewModel.state.value.unreadIds.isEmpty() }
        waitFor("unread persisted") { prefs.current.unreadSessionIds.isEmpty() }

        // Let the slow stale write finish if it were still running.
        Thread.sleep(300)
        assertTrue(
            "the newest unread value stays stored, prefs=${prefs.current.unreadSessionIds}",
            prefs.current.unreadSessionIds.isEmpty(),
        )
    }

    @Test
    fun `an exited badge survives a session list reload`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"a"}],"runningSessionIds":[]}"""))
        viewModel.setActive(true)
        val stream = open()
        waitFor("mux connected") { viewModel.state.value.connection == ConnectionState.Connected }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }

        stream.send(
            "s1",
            """{"type":"running","runningSessionIds":[],"exitedSessions":[{"id":"gone","cwd":"/work/x"}]}""",
        )
        waitFor("exited applied") { viewModel.state.value.exited.containsKey("gone") }

        sessionResponses.add(sessions("""{"sessions":[{"id":"a"},{"id":"b"}],"runningSessionIds":[]}"""))
        viewModel.refresh()
        waitFor("list reloaded") { viewModel.state.value.sessions.size == 2 }

        assertEquals(setOf("gone"), viewModel.state.value.exited.keys)
    }

    @Test
    fun `the session list reports sessions another omp process runs`() {
        sessionResponses.add(
            sessions(
                """{"sessions":[{"id":"a","cwd":"/work/x"}],"runningSessionIds":[],""" +
                    """"elsewhereSessions":[{"id":"a","kind":"omp-web",""" +
                    """"source":"instance-list","running":true,"active":true}]}""",
            ),
        )
        viewModel.setActive(true)
        waitFor("owner applied") { viewModel.state.value.elsewhere.containsKey("a") }

        val owner = viewModel.state.value.elsewhere.getValue("a")
        assertEquals("omp-web", owner.kind)
        assertEquals("instance-list", owner.source)
        assertTrue("a foreign run is not one of ours", "a" !in viewModel.state.value.runningIds)
    }

    @Test
    fun `a running frame adds and drops a foreign owner`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"a"}],"runningSessionIds":[]}"""))
        viewModel.setActive(true)
        val stream = open()
        waitFor("mux connected") { viewModel.state.value.connection == ConnectionState.Connected }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }

        stream.send(
            "s1",
            """{"type":"running","runningSessionIds":[],"elsewhereSessions":[""" +
                """{"id":"a","cwd":"/work/x","kind":"terminal","source":"process",""" +
                """"running":true,"active":true}]}""",
        )
        waitFor("owner applied") { viewModel.state.value.elsewhere.containsKey("a") }
        assertTrue("the owner is still not a local run", "a" !in viewModel.state.value.runningIds)

        // The foreign process exited: the same field, now empty, must drop it.
        stream.send("s1", """{"type":"running","runningSessionIds":[],"elsewhereSessions":[]}""")
        waitFor("owner dropped") { viewModel.state.value.elsewhere.isEmpty() }
    }

    @Test
    fun `a foreign entry without an id addresses no row`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"a"}],"runningSessionIds":[]}"""))
        viewModel.setActive(true)
        val stream = open()
        waitFor("mux connected") { viewModel.state.value.connection == ConnectionState.Connected }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }

        // The map is keyed by session id; the single-session owner report has
        // none, so such an entry in the list must not land under an empty id.
        stream.send(
            "s1",
            """{"type":"running","runningSessionIds":[],"elsewhereSessions":[""" +
                """{"kind":"terminal","source":"process","running":true,"active":true}]}""",
        )
        stream.send(
            "s1",
            """{"type":"running","runningSessionIds":[],"elsewhereSessions":[""" +
                """{"id":"a","cwd":"/work/x","kind":"terminal","source":"process",""" +
                """"running":true,"active":true}]}""",
        )
        waitFor("owner applied") { viewModel.state.value.elsewhere.containsKey("a") }

        assertEquals(setOf("a"), viewModel.state.value.elsewhere.keys)
    }

    @Test
    fun `a stale list response does not overwrite the reload triggered by a frame`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"a"}],"runningSessionIds":[]}"""))
        viewModel.setActive(true)
        val stream = open()
        waitFor("initial list") { viewModel.state.value.sessions.size == 1 }
        waitFor("running subscription") { transport.subscribes.isNotEmpty() }

        // The manual refresh answer is still in flight when the frame asks for
        // a new list; the newer answer must win.
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"a"}],"runningSessionIds":[]}""")
                .setBodyDelay(1_500, java.util.concurrent.TimeUnit.MILLISECONDS),
        )
        sessionResponses.add(sessions("""{"sessions":[{"id":"a"},{"id":"b"}],"runningSessionIds":[]}"""))
        viewModel.refresh()
        Thread.sleep(300)

        stream.send("s1", """{"type":"sessions-changed"}""")
        waitFor("new list applied") { viewModel.state.value.sessions.size == 2 }

        Thread.sleep(2_000)
        assertEquals(listOf("a", "b"), viewModel.state.value.sessions.map { it.id })
    }

    @Test
    fun `a remembered new-session cwd is validated before the pane is restored`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        cwdResponses.add(json("""{"success":true,"cwd":"/work/project","projectRoot":"/work"}"""))

        viewModel.restoreNewSession("/work/project")
        waitFor("pane restored with the normalized cwd") {
            viewModel.state.value.newSessionCwd == "/work/project"
        }
        assertNull("a restored pane is not a session", viewModel.state.value.selectedSessionId)
        waitFor("restore remembered") { preferences.current.lastNewSessionCwd == "/work/project" }
    }

    @Test
    fun `a stale new-session cwd falls back to the list with a notice`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        cwdResponses.add(
            MockResponse().setResponseCode(400)
                .setBody("""{"error":"Directory does not exist: /gone","code":"directory_not_found"}"""),
        )

        viewModel.restoreNewSession("/gone")
        waitFor("notice about the missing workspace") { viewModel.state.value.notice != null }

        assertNull("no pane is opened for a stale path", viewModel.state.value.newSessionCwd)
        val notice = viewModel.state.value.notice!!
        assertTrue("the failure is an error notice", notice.error)
        assertTrue("the reason is shown: ${notice.text}", notice.text.contains("Directory does not exist"))
        waitFor("stale marker dropped") { preferences.current.lastNewSessionCwd == null }
    }

    @Test
    fun `the new-session marker and the session marker are never stored together`() {
        preferences.seedLastSession("old-session")

        viewModel.startNewSession("/work/pane")

        waitFor("pane marker stored") { preferences.current.lastNewSessionCwd == "/work/pane" }
        assertNull(
            "opening the pane drops the session marker in the same write",
            preferences.current.lastSessionId,
        )

        detailResponses.add(
            json("""{"sessionId":"s1","info":{"id":"s1","cwd":"/work/x","messageCount":1},"context":{}}"""),
        )
        viewModel.selectSession("s1")
        waitFor("pane marker dropped when a session is shown") {
            preferences.current.lastNewSessionCwd == null
        }

        val both = preferences.lastViewWrites.filter { it.lastSessionId != null && it.lastNewSessionCwd != null }
        assertEquals("no write ever carried both markers: $both", emptyList<SettingsSnapshot>(), both)
    }

    @Test
    fun `a dead session never replaces the cold-start marker`() {
        // The web's URL guard drops an unknown id. A dead link must not become
        // the marker either: the next cold start has to restore the session the
        // user really left behind, not the list.
        preferences.seedLastSession("last-real")
        sessionResponses.add(sessions("""{"sessions":[{"id":"alive","cwd":"/work/a"}],"runningSessionIds":[]}"""))
        detailResponses.add(
            MockResponse().setResponseCode(404)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Session not found","code":"session_not_found"}"""),
        )

        viewModel.setActive(true)
        waitFor("session list loaded") { viewModel.state.value.sessions.isNotEmpty() }

        viewModel.selectSession("dead")
        waitFor("dead session dropped") {
            viewModel.state.value.selectedSessionId == null && viewModel.state.value.notice != null
        }
        assertEquals(
            "the last real view stays the marker",
            "last-real",
            preferences.current.lastSessionId,
        )
        val deadWrites = preferences.lastViewWrites.filter { it.lastSessionId == "dead" }
        assertEquals("a dead link is never remembered: $deadWrites", emptyList<SettingsSnapshot>(), deadWrites)
        assertTrue(
            "the drop is reported: ${viewModel.state.value.notice?.text}",
            viewModel.state.value.notice?.text?.contains("no longer exists") == true,
        )
    }

    @Test
    fun `a session deleted while it is open clears its own marker`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"s1","cwd":"/work/a"}],"runningSessionIds":[]}"""))
        detailResponses.add(json("""{"sessionId":"s1","info":{"id":"s1","cwd":"/work/a","messageCount":1},"context":{}}"""))

        viewModel.setActive(true)
        waitFor("session list loaded") { viewModel.state.value.sessions.isNotEmpty() }
        viewModel.selectSession("s1")
        waitFor("marker written once the detail is shown") { preferences.current.lastSessionId == "s1" }

        // The session vanishes on the server: the refreshed list no longer has
        // it, so the next detail request is a dead link instead of a retry.
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        detailResponses.add(
            MockResponse().setResponseCode(404)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Session not found","code":"session_not_found"}"""),
        )
        viewModel.refresh()
        waitFor("list reloaded without the session") { viewModel.state.value.sessions.isEmpty() }
        viewModel.reloadDetail()
        waitFor("session dropped") { viewModel.state.value.selectedSessionId == null }
        waitFor("own marker cleared") { preferences.current.lastSessionId == null }
    }

    @Test
    fun `a deleted session is not resurrected from the shared detail answer`() {
        sessionResponses.add(sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","messageCount":1}],"runningSessionIds":[]}"""))
        detailResponses.add(json("""{"sessionId":"s1","info":{"id":"s1","cwd":"/work/a","messageCount":1},"context":{}}"""))

        viewModel.setActive(true)
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }
        viewModel.selectSession("s1")
        waitFor("detail loaded") { viewModel.state.value.detail != null }

        // The DELETE succeeds and the refreshed list no longer holds the id;
        // the first detail answer is still inside its sharing window.
        detailResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        viewModel.deleteSession("s1")
        waitFor("delete reported") { viewModel.state.value.notice?.text?.contains("deleted") == true }

        // The row can still be tapped until the list repaints. Opening it must
        // reach the server (and 404), not replay the deleted transcript.
        detailResponses.add(
            MockResponse().setResponseCode(404)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Session not found","code":"session_not_found"}"""),
        )
        viewModel.selectSession("s1")
        waitFor("deleted session dropped") { viewModel.state.value.selectedSessionId == null }
        assertNull("the deleted transcript is never shown again", viewModel.state.value.detail)
        assertTrue(
            "the dead open is reported: ${viewModel.state.value.notice?.text}",
            viewModel.state.value.notice?.text?.contains("no longer exists") == true,
        )
    }

    @Test
    fun `renaming the open session updates its header`() {
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","name":"Old","messageCount":1}],"runningSessionIds":[]}"""),
        )
        detailResponses.add(
            json("""{"sessionId":"s1","info":{"id":"s1","cwd":"/work/a","name":"Old","messageCount":1},"context":{}}"""),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }
        viewModel.selectSession("s1")
        waitFor("detail loaded") { viewModel.state.value.detail?.info?.name == "Old" }

        detailResponses.add(MockResponse().setResponseCode(200).setBody("{}"))
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","name":"New","messageCount":1}],"runningSessionIds":[]}"""),
        )
        viewModel.renameSession("s1", "New")
        waitFor("rename reported") { viewModel.state.value.notice?.text?.contains("renamed") == true }

        assertEquals(
            "the header reads the new title instead of the pre-rename detail",
            "New",
            viewModel.state.value.detail?.info?.name,
        )
    }

    @Test
    fun `forgetting a dead link only drops its own marker`() {
        // A link for a session this installation never opened must not forget
        // the view the user actually left behind.
        preferences.seedLastSession("last")

        viewModel.forgetLastSessionIfCurrent("dead")
        Thread.sleep(200)
        assertEquals("the last real view stays the marker", "last", preferences.current.lastSessionId)

        viewModel.forgetLastSessionIfCurrent("last")
        waitFor("own marker cleared") { preferences.current.lastSessionId == null }
    }

    @Test
    fun `a worktree switch moves the open new-session pane with the sidebar`() {
        viewModel.startNewSession("/work/pane")
        waitFor("pane open") { viewModel.state.value.newSessionCwd == "/work/pane" }
        waitFor("pane marker stored") { preferences.current.lastNewSessionCwd == "/work/pane" }

        viewModel.setEffectiveCwd("/work/pane-worktrees/feat")

        // Web `handleCwdChange`: the pane's workspace falls back to the
        // moved sidebar cwd, so the next session starts in the worktree.
        assertEquals("/work/pane-worktrees/feat", viewModel.state.value.activeCwd)
        assertEquals("/work/pane-worktrees/feat", viewModel.state.value.newSessionCwd)
        waitFor("pane marker moved") {
            preferences.current.lastNewSessionCwd == "/work/pane-worktrees/feat"
        }
    }

    @Test
    fun `a worktree switch never retargets an open session`() {
        detailResponses.add(
            json("""{"sessionId":"s1","info":{"id":"s1","cwd":"/work/a","messageCount":1},"context":{}}"""),
        )
        viewModel.openCreatedSession("s1", "/work/a")
        waitFor("session open") { viewModel.state.value.selectedSessionId == "s1" }

        viewModel.setEffectiveCwd("/work/feat")

        assertEquals("/work/feat", viewModel.state.value.activeCwd)
        assertNull("an open session keeps its own cwd", viewModel.state.value.newSessionCwd)
        assertNull("no pane marker is written", preferences.current.lastNewSessionCwd)
    }

    @Test
    fun `auto-name without messages makes no request and explains why`() {
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","messageCount":0}],"runningSessionIds":[]}"""),
        )
        viewModel.setActive(true)
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }

        val before = server.requestCount
        viewModel.autoNameSession("s1")
        waitFor("guard notice") {
            viewModel.state.value.notice?.text?.contains("at least one message") == true
        }
        Thread.sleep(100)
        assertEquals("a session without messages is never named", before, server.requestCount)
        assertEquals(AutoNamePhase.Idle, viewModel.state.value.autoName.phase)
    }

    @Test
    fun `auto-name reports the title and treats a blank answer as an error`() {
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","messageCount":2}],"runningSessionIds":[]}"""),
        )
        autoNameResponses.add(json("""{"title":"Renamed session","generated":true}"""))
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","messageCount":2,"name":"Renamed session"}],"runningSessionIds":[]}"""),
        )
        viewModel.setActive(true)
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }

        viewModel.autoNameSession("s1")
        waitFor("success phase") { viewModel.state.value.autoName.phase == AutoNamePhase.Success }
        assertEquals("Renamed session", viewModel.state.value.autoName.title)
        assertTrue(
            "the header feedback names the title",
            viewModel.state.value.notice?.text?.contains("Title generated: Renamed session") == true,
        )

        sessionResponses.add(
            sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","messageCount":2}],"runningSessionIds":[]}"""),
        )
        autoNameResponses.add(json("""{"title":"   "}"""))
        viewModel.autoNameSession("s1")
        waitFor("blank answer is an error") {
            viewModel.state.value.autoName.phase == AutoNamePhase.Error
        }
        assertTrue(
            "an empty title is never shown as success",
            viewModel.state.value.notice?.text?.contains("empty title") == true,
        )
    }

    @Test
    fun `pinning a session persists it for the current origin and unpinning removes it`() {
        sessionResponses.add(
            sessions("""{"sessions":[{"id":"s1","cwd":"/work/a","modified":"2026-10-20T10:00:00.000Z"}],"runningSessionIds":[]}"""),
        )
        viewModel.setActive(true)
        waitFor("list loaded") { viewModel.state.value.sessions.isNotEmpty() }

        viewModel.togglePin("s1")
        assertEquals(setOf("s1"), viewModel.state.value.pinnedIds)
        waitFor("pin persisted") { preferences.pinWrites.isNotEmpty() }
        val write = preferences.pinWrites.last()
        assertEquals(address.origin, write.first)
        assertEquals(setOf("s1"), write.second)
        assertEquals(mapOf(address.origin to setOf("s1")), preferences.current.pinnedSessionsByOrigin)

        viewModel.togglePin("s1")
        assertEquals(emptySet<String>(), viewModel.state.value.pinnedIds)
        waitFor("unpin persisted") { preferences.current.pinnedSessionsByOrigin.isEmpty() }
        assertTrue("an empty pin list clears the origin entry", preferences.pinWrites.last().second.isEmpty())
    }

    @Test
    fun `a cold start restores only this origin's pins`() {
        val preferences = FakePreferences(
            SettingsSnapshot(
                loaded = true,
                pinnedSessionsByOrigin = mapOf(
                    address.origin to setOf("s1"),
                    "http://other.invalid:1" to setOf("from-another-installation"),
                ),
            ),
        )
        sessionResponses.add(sessions("""{"sessions":[{"id":"s1","cwd":"/work/a"}],"runningSessionIds":[]}"""))
        recreate(preferences)

        viewModel.setActive(true)
        waitFor("sessions loaded") { viewModel.state.value.sessions.isNotEmpty() }
        waitFor("pins seeded") { viewModel.state.value.pinnedIds.isNotEmpty() }

        assertEquals(setOf("s1"), viewModel.state.value.pinnedIds)
    }

    @Test
    fun `message search debounces to the last query and pages with the cursor`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        searchResponses.add(
            json(
                """{"query":"needle","results":[{"sessionId":"s1","title":"T","cwd":"/w","entryId":"e1","role":"user","timestamp":"2026-10-20T10:00:00.000Z","snippet":"a needle here","matchStart":2,"matchEnd":8}],"partial":true,"cursor":"abc","scannedFiles":1,"scannedBytes":100}""",
            ),
        )
        searchResponses.add(
            json(
                """{"query":"needle","results":[{"sessionId":"s2","entryId":"e2","role":"assistant","snippet":"needle","matchStart":0,"matchEnd":6}],"partial":false}""",
            ),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()

        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("ne")
        // The 350 ms debounce must swallow this prefix: only "needle" is sent.
        Thread.sleep(80)
        viewModel.setSearchQuery("needle")

        waitFor("first page") { viewModel.state.value.messageSearch.results.size == 1 }
        assertEquals(1, searchPaths.size)
        assertTrue(
            "the message route is called — `/api/sessions/search` is the server's sidebar ranking",
            searchPaths.single().startsWith("/api/sessions/messages/search?"),
        )
        assertTrue("the prefix query never left", searchPaths.single().contains("q=needle"))
        assertTrue(searchPaths.single().contains("limit=${SessionsViewModel.MESSAGE_SEARCH_LIMIT}"))
        val first = viewModel.state.value.messageSearch
        assertEquals(1, first.results.size)
        assertEquals("needle", first.results[0].snippet.substring(first.results[0].matchStart, first.results[0].matchEnd))
        assertEquals("abc", first.cursor)
        assertTrue(first.partial)
        assertEquals("user", first.results[0].role)

        viewModel.loadMoreMessageResults()
        waitFor("second page appended") { viewModel.state.value.messageSearch.results.size == 2 }
        assertTrue("the cursor is sent back", searchPaths.last().contains("cursor=abc"))
        assertEquals(listOf("e1", "e2"), viewModel.state.value.messageSearch.results.map { it.entryId })
        assertEquals(false, viewModel.state.value.messageSearch.partial)
        assertEquals(null, viewModel.state.value.messageSearch.cursor)

        viewModel.setSearchOpen(false)
        assertEquals(MessageSearchState(), viewModel.state.value.messageSearch)
    }

    @Test
    fun `a stale message search answer never replaces a newer query`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        searchResponses.add(
            json(
                """{"query":"old","results":[{"sessionId":"s1","entryId":"e1","role":"user","snippet":"old hit","matchStart":0,"matchEnd":3}],"partial":false}""",
            ).setBodyDelay(600, java.util.concurrent.TimeUnit.MILLISECONDS),
        )
        searchResponses.add(
            json(
                """{"query":"new","results":[{"sessionId":"s2","entryId":"e2","role":"user","snippet":"new hit","matchStart":0,"matchEnd":3}],"partial":false}""",
            ),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("old")
        waitFor("old request on the wire") { searchPaths.isNotEmpty() }

        viewModel.setSearchQuery("new")
        waitFor("new answer") {
            viewModel.state.value.messageSearch.results.singleOrNull()?.entryId == "e2"
        }
        // Wait past the old answer's delay: it must be dropped, not appended.
        Thread.sleep(800)
        assertEquals("e2", viewModel.state.value.messageSearch.results.single().entryId)
        assertEquals("new", viewModel.state.value.messageSearch.query)
    }

    @Test
    fun `load more during the debounce never pairs the old cursor with the new query`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        searchResponses.add(
            json(
                """{"query":"needle","results":[{"sessionId":"s1","entryId":"e1","role":"user","snippet":"needle","matchStart":0,"matchEnd":6}],"partial":true,"cursor":"abc"}""",
            ),
        )
        searchResponses.add(json("""{"query":"needlex","results":[],"partial":false}"""))

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("needle")
        waitFor("first page") { viewModel.state.value.messageSearch.results.size == 1 }
        assertEquals(1, searchPaths.size)
        assertEquals("abc", viewModel.state.value.messageSearch.cursor)

        // Typing again invalidates the page token: "Load more" inside the
        // debounce window must not send q=<new>&cursor=<old> (the server
        // answers that with 400 cursor_query_mismatch).
        viewModel.setSearchQuery("needlex")
        assertNull(viewModel.state.value.messageSearch.cursor)
        viewModel.loadMoreMessageResults()
        Thread.sleep(150)
        assertEquals("load more must not fire during the debounce", 1, searchPaths.size)

        waitFor("debounced run") { searchPaths.size == 2 }
        assertTrue("the new query is sent", searchPaths.last().contains("q=needlex"))
        assertTrue("no stale cursor is sent", !searchPaths.last().contains("cursor="))
    }

    @Test
    fun `skipped session files are surfaced and summed over the pages of a query`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        searchResponses.add(
            json(
                """{"query":"needle","results":[{"sessionId":"s1","entryId":"e1","role":"user","snippet":"needle","matchStart":0,"matchEnd":6}],"partial":true,"cursor":"abc","skippedFiles":1}""",
            ),
        )
        searchResponses.add(
            json(
                """{"query":"needle","results":[{"sessionId":"s2","entryId":"e2","role":"user","snippet":"needle","matchStart":0,"matchEnd":6}],"partial":false,"skippedFiles":2}""",
            ),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("needle")
        waitFor("first page") { viewModel.state.value.messageSearch.results.size == 1 }
        assertEquals(
            "the server's skip is not swallowed",
            1,
            viewModel.state.value.messageSearch.skippedFiles,
        )

        viewModel.loadMoreMessageResults()
        waitFor("second page appended") { viewModel.state.value.messageSearch.results.size == 2 }
        assertEquals(
            "each page visits its own slice, so the counts add up",
            3,
            viewModel.state.value.messageSearch.skippedFiles,
        )

        // A new query starts a fresh scan: the old count must not persist.
        searchResponses.add(json("""{"query":"other","results":[],"partial":false}"""))
        viewModel.setSearchQuery("other")
        waitFor("new query") { viewModel.state.value.messageSearch.query == "other" }
        assertEquals(0, viewModel.state.value.messageSearch.skippedFiles)
    }

    @Test
    fun `an empty partial page continues automatically until a row arrives`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        // A large session file eats the server's budget before the first match:
        // two empty `partial` pages, then a hit.
        searchResponses.add(
            json("""{"query":"needle","results":[],"partial":true,"cursor":"c1","scannedFiles":1,"scannedBytes":100}"""),
        )
        searchResponses.add(
            json("""{"query":"needle","results":[],"partial":true,"cursor":"c2","scannedFiles":1,"scannedBytes":200}"""),
        )
        searchResponses.add(
            json(
                """{"query":"needle","results":[{"sessionId":"s1","entryId":"e1","role":"user","snippet":"needle","matchStart":0,"matchEnd":6}],"partial":true,"cursor":"c3"}""",
            ),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("needle")

        waitFor("hit after the automatic pages") { viewModel.state.value.messageSearch.results.size == 1 }
        assertEquals("the first row ended the scan; no fourth page is requested", 3, searchPaths.size)
        assertTrue("page 2 continues page 1", searchPaths[1].contains("cursor=c1"))
        assertTrue("page 3 continues page 2", searchPaths[2].contains("cursor=c2"))
        assertTrue("every page belongs to the query", searchPaths.all { it.contains("q=needle") })

        val state = viewModel.state.value.messageSearch
        assertEquals("e1", state.results.single().entryId)
        assertEquals("needle", state.query)
        assertEquals("two automatic follow-ups ran", 2, state.autoPages)
        // The page after the hit is still partial: "Load more" stays available.
        assertTrue(state.partial)
        assertEquals("c3", state.cursor)
        assertEquals(false, state.loading)
        Thread.sleep(150)
        assertEquals("a page with a row never triggers another request", 3, searchPaths.size)
    }

    @Test
    fun `automatic continuation is capped at five pages per run`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        for (page in 1..SessionsViewModel.MESSAGE_SEARCH_AUTO_PAGE_LIMIT) {
            searchResponses.add(
                json("""{"query":"needle","results":[],"partial":true,"cursor":"c$page"}"""),
            )
        }

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("needle")

        waitFor("all five pages requested") { searchPaths.size == 5 }
        waitFor("run finished") { !viewModel.state.value.messageSearch.loading }
        Thread.sleep(200)
        assertEquals(
            "the run stops after ${SessionsViewModel.MESSAGE_SEARCH_AUTO_PAGE_LIMIT} pages",
            5,
            searchPaths.size,
        )
        val state = viewModel.state.value.messageSearch
        assertEquals(0, state.results.size)
        assertEquals("four automatic follow-ups after the first page", 4, state.autoPages)
        // The budget is not wasted information: the user can continue from here.
        assertTrue("the server is still partial", state.partial)
        assertEquals("c5", state.cursor)
        assertNull(state.error)
    }

    @Test
    fun `a new query cancels the automatic continuation`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        searchResponses.add(json("""{"query":"needle","results":[],"partial":true,"cursor":"c1"}"""))
        // The second page hangs long enough for the user to type again.
        searchResponses.add(
            json("""{"query":"needle","results":[],"partial":true,"cursor":"c2"}""")
                .setBodyDelay(800, java.util.concurrent.TimeUnit.MILLISECONDS),
        )
        searchResponses.add(
            json(
                """{"query":"new","results":[{"sessionId":"s2","entryId":"e2","role":"user","snippet":"new hit","matchStart":0,"matchEnd":3}],"partial":false}""",
            ),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("needle")

        waitFor("automatic page in flight") { searchPaths.size == 2 }
        waitFor("progress state while continuing") {
            val search = viewModel.state.value.messageSearch
            search.loading && search.autoPages == 1 && search.results.isEmpty()
        }

        viewModel.setSearchQuery("new")
        waitFor("new query answer") {
            val search = viewModel.state.value.messageSearch
            search.query == "new" && search.results.singleOrNull()?.entryId == "e2"
        }
        // Let the cancelled page arrive: it must not be appended or restart the
        // old scan.
        Thread.sleep(900)
        val state = viewModel.state.value.messageSearch
        assertEquals("new", state.query)
        assertEquals(listOf("e2"), state.results.map { it.entryId })
        assertNull(state.cursor)
        assertEquals(false, state.loading)
        assertTrue("no stale cursor is sent", !searchPaths.last().contains("cursor="))
    }

    @Test
    fun `a busy search shows a retry hint instead of the terse server text`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        searchResponses.add(
            MockResponse()
                .setResponseCode(429)
                .setHeader("Content-Type", "application/json")
                .setHeader("Retry-After", "1")
                .setBody("""{"error":"Too many searches in flight, retry shortly","code":"search_busy"}"""),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("needle")

        waitFor("busy answer") { viewModel.state.value.messageSearch.error != null }
        assertEquals(
            "The server is busy searching — try again in a moment.",
            viewModel.state.value.messageSearch.error,
        )
    }

    @Test
    fun `a missing search route explains the old server instead of HTTP 404`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        // A server without the route: Next's own 404 page, no `{error, code}`.
        searchResponses.add(
            MockResponse()
                .setResponseCode(404)
                .setHeader("Content-Type", "text/html")
                .setBody("<!doctype html><html><body>404</body></html>"),
        )

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        viewModel.setSearchQuery("needle")

        waitFor("old-server answer") { viewModel.state.value.messageSearch.error != null }
        assertEquals(
            "a missing route never surfaces as a raw status",
            "This server is too old for message search.",
            viewModel.state.value.messageSearch.error,
        )
    }

    @Test
    fun `without the messageSearch capability the message mode is not entered at all`() {
        serverInfo.value = AppInfo(name = "ompweb", version = "0.5.2", api = 1)
        recreate(preferences)
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        assertTrue("the capability stays off", !viewModel.state.value.messageSearchSupported)

        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        assertEquals(SessionSearchMode.Sessions, viewModel.state.value.searchMode)

        viewModel.setSearchQuery("needle")
        Thread.sleep(600)
        assertTrue("no request ever reaches the missing route", searchPaths.isEmpty())
    }

    @Test
    fun `a server that loses the search capability leaves the message mode`() {
        sessionResponses.add(sessions("""{"sessions":[],"runningSessionIds":[]}"""))
        searchResponses.add(json("""{"query":"needle","results":[],"partial":false}"""))

        viewModel.setActive(true)
        waitFor("list loaded") { !viewModel.state.value.loading }
        waitForCapabilities()
        viewModel.setSearchOpen(true)
        viewModel.setSearchMode(SessionSearchMode.Messages)
        assertEquals(SessionSearchMode.Messages, viewModel.state.value.searchMode)

        serverInfo.value = AppInfo(name = "ompweb", version = "0.5.2", api = 1)

        waitFor("mode left") {
            !viewModel.state.value.messageSearchSupported &&
                viewModel.state.value.searchMode == SessionSearchMode.Sessions
        }
        assertEquals(MessageSearchState(), viewModel.state.value.messageSearch)
    }

    private fun json(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    private fun sessions(body: String): MockResponse = MockResponse()
        .setResponseCode(200)
        .setHeader("Content-Type", "application/json")
        .setBody(body)

    /** Queues a stream and completes its hello as `cN`. */
    private fun open(): FakeStream {
        val stream = transport.openStream()
        stream.send(
            EventMux.MUX_CONTROL_EVENT,
            """{"type":"hello","connectionId":"c${transport.streamsOpened}"}""",
        )
        return stream
    }

    private fun waitFor(message: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 8_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        fail("$message; state=${viewModel.state.value}")
    }

    /** The app-info handshake gates "In messages"; wait for its capability. */
    private fun waitForCapabilities() {
        waitFor("server capability") { viewModel.state.value.messageSearchSupported }
    }

    /** Builds a second view model against the same server with its own prefs. */
    private fun recreate(prefs: FakePreferences) {
        viewModel = SessionsViewModel(
            api = ApiClient(OkHttpClient(), { address }),
            eventMux = mux,
            preferences = prefs,
            originNow = { address },
            serverInfo = serverInfo,
        )
        store.put("sessions2", viewModel)
    }

    private class FakePreferences(
        initial: SettingsSnapshot = SettingsSnapshot(loaded = true),
        /** Lets a test make one write slower than the next (stale-write race). */
        private val writeDelayMillis: (Set<String>) -> Long = { 0L },
    ) : WorkspacePreferences {
        private val state = MutableStateFlow(initial)
        override val snapshot: StateFlow<SettingsSnapshot> = state

        val current: SettingsSnapshot
            get() = state.value

        /** Every state written through the last-view API, in order. */
        val lastViewWrites = java.util.Collections.synchronizedList(mutableListOf<SettingsSnapshot>())

        /** A stored session marker, as the chat surface leaves it behind. */
        fun seedLastSession(sessionId: String) {
            lastViewWrites += state.value.copy(lastSessionId = sessionId)
            state.value = state.value.copy(lastSessionId = sessionId)
        }

        override suspend fun setExpandedProjects(projects: Set<String>) {
            state.update { it.copy(expandedProjects = projects) }
        }

        override suspend fun setUnreadSessionIds(ids: Set<String>) {
            delay(writeDelayMillis(ids))
            state.update { it.copy(unreadSessionIds = ids) }
        }

        override suspend fun setPinnedSessions(origin: String, ids: Set<String>) {
            pinWrites += origin to ids
            state.update {
                it.copy(
                    pinnedSessionsByOrigin = it.pinnedSessionsByOrigin.toMutableMap().apply {
                        if (ids.isEmpty()) remove(origin) else put(origin, ids)
                    },
                )
            }
        }

        /** Every pin write, in order; the pin tests assert origin scoping. */
        val pinWrites = java.util.Collections.synchronizedList(mutableListOf<Pair<String, Set<String>>>())

        override suspend fun setToolPreset(preset: ToolPreset) {
            state.update { it.copy(toolPreset = preset.wireName) }
        }

        override suspend fun setLastNewSessionView(cwd: String) {
            val next = state.value.copy(lastNewSessionCwd = cwd.takeIf { it.isNotBlank() }, lastSessionId = null)
            lastViewWrites += next
            state.value = next
        }

        override suspend fun setLastSessionView(sessionId: String) {
            val next = state.value.copy(lastSessionId = sessionId.takeIf { it.isNotBlank() }, lastNewSessionCwd = null)
            lastViewWrites += next
            state.value = next
        }

        override suspend fun clearLastNewSessionView() {
            val next = state.value.copy(lastNewSessionCwd = null)
            lastViewWrites += next
            state.value = next
        }

        override suspend fun clearLastSession() {
            val next = state.value.copy(lastSessionId = null)
            lastViewWrites += next
            state.value = next
        }
    }

    private class Subscription(val connectionId: String, val id: String, val channel: EventChannel)

    companion object {
        /**
         * Installed once for the whole class. `setMain` from every test raced
         * with the previous test's still-unwinding view-model coroutines and
         * failed this class intermittently ("Dispatchers.Main is used
         * concurrently with setting it").
         */
        @JvmStatic
        @BeforeClass
        fun installMain() {
            Dispatchers.setMain(Dispatchers.Default)
        }
    }

    private class FakeTransport : EventTransport {
        val streams = Channel<FakeStream>(Channel.UNLIMITED)
        val subscribes = mutableListOf<Subscription>()
        var streamsOpened = 0
            private set

        fun openStream(): FakeStream = FakeStream().also {
            streamsOpened++
            streams.trySend(it)
        }

        override suspend fun open(): EventStream = streams.receive()

        override suspend fun subscribe(connectionId: String, id: String, channel: EventChannel): EventPostResult {
            subscribes += Subscription(connectionId, id, channel)
            return EventPostResult.Ok
        }

        override suspend fun unsubscribe(connectionId: String, id: String) = Unit
    }

    private class FakeStream : EventStream {
        private val channel = Channel<SseFrame>(Channel.UNLIMITED)
        override val frames: Flow<SseFrame> = channel.receiveAsFlow()

        fun send(event: String, data: String) {
            channel.trySend(SseFrame(event, data))
        }

        override fun close() {
            channel.close()
        }
    }
}
