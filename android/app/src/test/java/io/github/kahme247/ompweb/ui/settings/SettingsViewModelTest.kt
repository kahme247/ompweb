package io.github.kahme247.ompweb.ui.settings

import androidx.lifecycle.ViewModelStore
import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.data.SettingsViewPreferences
import io.github.kahme247.ompweb.domain.UPDATE_NOTICE_CHECK_INTERVAL_MILLIS
import io.github.kahme247.ompweb.domain.UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.UpdatePhase
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import io.github.kahme247.ompweb.net.systemApi
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test

/**
 * The state and gate checks behind A11 (banner, dismiss, install flow, notes),
 * A16 (metric/breakdown/selection state) and A22 (agent-env save gate). Runs
 * against the real `HttpSystemApi` on a MockWebServer so the request bodies
 * are covered too.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest {

    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient
    private lateinit var scope: CoroutineScope
    private lateinit var viewModel: SettingsViewModel
    private var store = ViewModelStore()
    private val prefs = FakeSettingsPrefs()
    private val bodies = CopyOnWriteArrayList<Pair<String, String>>()
    private val paths = CopyOnWriteArrayList<String>()

    /** The view model's wall clock; tests move it to cross the throttle window. */
    private var nowMillis = 1_700_000_000_000L

    /** Route table: path prefix → (request, decoded body) → response. */
    private val routes = mutableMapOf<String, (RecordedRequest, String) -> MockResponse>()

    private class FakeSettingsPrefs : SettingsViewPreferences {
        private val _snapshot = MutableStateFlow(SettingsSnapshot(loaded = true))
        override val snapshot: StateFlow<SettingsSnapshot> = _snapshot.asStateFlow()

        override suspend fun setDismissedUpdate(kind: UpdateKind, version: String?) {
            _snapshot.update {
                when (kind) {
                    UpdateKind.APP -> it.copy(dismissedAppUpdateVersion = version)
                    UpdateKind.OMP -> it.copy(dismissedOmpUpdateVersion = version)
                }
            }
        }

        override suspend fun setCompletedAppUpdate(version: String?) {
            _snapshot.update { it.copy(completedAppUpdateVersion = version) }
        }

        override suspend fun setDictationEngine(wire: String) {
            _snapshot.update { it.copy(dictationEngine = wire) }
        }

        override suspend fun setDictationLanguage(tag: String?) {
            _snapshot.update { it.copy(dictationLanguage = tag) }
        }

        /** Simulates sign-out (`null`) or a switch to another server. */
        fun setOrigin(raw: String?) {
            val address = raw?.let {
                (ServerAddress.parse(it) as ServerAddressResult.Valid).address
            }
            _snapshot.update { it.copy(origin = address) }
        }
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path?.substringBefore('?').orEmpty()
                paths += request.path.orEmpty()
                val body = request.body.readUtf8()
                if (body.isNotEmpty()) bodies += path to body
                val route = routes.entries.firstOrNull { path.startsWith(it.key) }?.value
                return route?.invoke(request, body)
                    ?: MockResponse().setResponseCode(404).setBody("""{"error":"no route"}""")
            }
        }
        server.start()
        val address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        val api = ApiClient(OkHttpClient(), { address })
        this.api = api
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val poller = ProviderUsagePoller(load = { api.systemApi().providerUsage(it) }, scope = scope)
        viewModel = SettingsViewModel(api.systemApi(), prefs, poller, nowMillis = { nowMillis })
        store = ViewModelStore()
        store.put("settings", viewModel)
    }

    @After
    fun tearDown() {
        store.clear()
        scope.cancel()
        server.shutdown()
    }

    companion object {
        /**
         * `Dispatchers.Main` stays installed for the whole class: `viewModelScope`
         * dispatches continuations on it while a test tears down, and toggling it
         * per test makes that a "used concurrently with setting it" failure.
         */
        @BeforeClass
        @JvmStatic
        fun installMain() {
            Dispatchers.setMain(Dispatchers.Default)
        }

        @AfterClass
        @JvmStatic
        fun restoreMain() {
            Dispatchers.resetMain()
        }
    }

    private fun json(body: String, code: Int = 200): MockResponse =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun empty(): MockResponse = MockResponse().setResponseCode(204)

    private fun waitFor(message: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $message")
    }

    // ------------------------------------------------------------------ usage

    @Test
    fun `usage selectors keep metric, breakdown and the tapped bar in the state`() {
        val state = viewModel.usageState.value
        assertEquals(UsageMetricView.COST, state.metric)
        assertEquals(UsageBreakdownView.MODEL, state.breakdown)
        assertNull(state.selectedPointIndex)

        viewModel.setUsageMetric(UsageMetricView.TOKENS)
        viewModel.setUsageBreakdown(UsageBreakdownView.PROJECT)
        viewModel.toggleUsagePoint(2)

        assertEquals(UsageMetricView.TOKENS, viewModel.usageState.value.metric)
        assertEquals(UsageBreakdownView.PROJECT, viewModel.usageState.value.breakdown)
        assertEquals(2, viewModel.usageState.value.selectedPointIndex)

        viewModel.toggleUsagePoint(2)
        assertNull("tapping the same bar clears it", viewModel.usageState.value.selectedPointIndex)
    }

    @Test
    fun `a new report drops a selection that no longer exists`() {
        routes["/api/usage"] = { _, _ -> json(usageJson(points = 3)) }
        viewModel.loadUsage()
        waitFor("first report") { viewModel.usageState.value.report != null }
        viewModel.toggleUsagePoint(2)
        assertEquals(2, viewModel.usageState.value.selectedPointIndex)

        routes["/api/usage"] = { _, _ -> json(usageJson(points = 2)) }
        viewModel.loadUsage(force = true)
        waitFor("second report") { viewModel.usageState.value.report?.timeSeries?.size == 2 }
        waitFor("selection cleared") { viewModel.usageState.value.selectedPointIndex == null }
    }

    @Test
    fun `refresh re-requests the report and asks the server to bypass its cache`() {
        routes["/api/usage"] = { _, _ -> json(usageJson(points = 4)) }
        viewModel.loadUsage()
        waitFor("first report") { viewModel.usageState.value.report != null }
        val before = paths.count { it.startsWith("/api/usage") }

        viewModel.loadUsage(force = true)

        waitFor("the refreshed report") {
            paths.count { it.startsWith("/api/usage") } > before &&
                viewModel.usageState.value.report != null &&
                !viewModel.usageState.value.loading
        }
        val last = paths.last { it.startsWith("/api/usage") }
        assertTrue("force must bypass the server cache: $last", last.contains("refresh=true"))
    }

    // --------------------------------------------------------------- agent env

    @Test
    fun `an invalid agent env line blocks the save before any request`() {
        routes["/api/web-settings"] = { _, _ ->
            json("""{"autoResumeSessions":false,"agentEnv":{}}""")
        }
        viewModel.loadSystem()

        waitFor("web settings") { viewModel.systemState.value.webSettings != null }
        val before = server.requestCount

        viewModel.updateAgentEnvDraft("FOO=bar\nPORT=3000")
        val state = viewModel.systemState.value
        assertFalse(state.agentEnvValid)
        assertEquals(listOf("Line 2: \"PORT\" is reserved by omp-web and cannot be set"), state.agentEnvErrors)

        viewModel.saveAgentEnv()
        Thread.sleep(200)

        assertEquals("no PUT for an invalid draft", before, server.requestCount)
        assertTrue(viewModel.systemState.value.agentEnvDirty)
    }

    @Test
    fun `a valid agent env draft is saved with canonical formatting`() {
        routes["/api/web-settings"] = { request, _ ->
            if (request.method == "PUT") {
                json("""{"autoResumeSessions":false,"agentEnv":{"B":"2","A":"1"}}""")
            } else {
                json("""{"autoResumeSessions":false,"agentEnv":{}}""")
            }
        }
        viewModel.loadSystem()
        waitFor("web settings") { viewModel.systemState.value.webSettings != null }

        viewModel.updateAgentEnvDraft("B=2\nA=1")
        assertTrue(viewModel.systemState.value.agentEnvValid)
        viewModel.saveAgentEnv()

        waitFor("saved") { !viewModel.systemState.value.agentEnvDirty && !viewModel.systemState.value.savingWebSettings }
        assertEquals("A=1\nB=2", viewModel.systemState.value.agentEnvDraft)
        assertTrue(
            "PUT carries the raw draft for the server-side parser",
            bodies.any { (path, body) ->
                path == "/api/web-settings" && body.contains("\"agentEnv\":\"B=2\\nA=1\"")
            },
        )
    }

    // ----------------------------------------------------------------- banner

    @Test
    fun `a server switch clears the provider usage and the update banner`() {
        routes["/api/app-update"] = { _, _ ->
            json(
                """{"currentVersion":"1.0.0","availableVersion":"1.1.0","updateAvailable":true,
                   "updateCommand":"ompweb update","selfUpdateSupported":true}""",
            )
        }
        routes["/api/omp-update"] = { _, _ ->
            json("""{"currentVersion":"0.9.0","availableVersion":null,"updateAvailable":false,"updateCommand":"omp update"}""")
        }
        routes["/api/provider-usage"] = { _, _ ->
            json("""{"generatedAt":7,"reports":[{"provider":"openai","accountLabel":"work"}]}""")
        }

        viewModel.checkForUpdateNotices()
        waitFor("banner") { viewModel.updateNotice.value != null }
        viewModel.loadProviderUsage()
        waitFor("usage snapshot") { viewModel.providerUsageState.value.snapshot != null }
        assertEquals("openai", viewModel.providerUsageState.value.snapshot?.reports?.single()?.provider)

        // Change server: the activity-scoped view model survives the route
        // change, so the origin is the signal that everything is stale.
        prefs.setOrigin("http://10.0.0.2:30177")

        waitFor("banner cleared") { viewModel.updateNotice.value == null }
        waitFor("usage cleared") { viewModel.providerUsageState.value.snapshot == null }
        assertNull(viewModel.systemState.value.appUpdate)
        assertNull(viewModel.systemState.value.ompUpdate)
    }

    @Test
    fun `the start check announces an update and the dismissal hides that version`() {
        routes["/api/app-update"] = { _, _ ->
            json(
                """{"currentVersion":"1.0.0","availableVersion":"1.1.0","updateAvailable":true,
                   "updateCommand":"ompweb update","selfUpdateSupported":true}""",
            )
        }
        routes["/api/omp-update"] = { _, _ ->
            json("""{"currentVersion":"0.9.0","availableVersion":null,"updateAvailable":false,"updateCommand":"omp update"}""")
        }

        viewModel.checkForUpdateNotices()
        waitFor("notice") { viewModel.updateNotice.value != null }
        val notice = viewModel.updateNotice.value!!
        assertEquals(UpdateKind.APP, notice.kind)
        assertEquals("1.1.0", notice.availableVersion)
        assertTrue(notice.visible)

        viewModel.dismissUpdateNotice()
        // Dismissing the only pending update leaves no notice at all (the
        // next start re-checks and the persisted version keeps it hidden).
        waitFor("dismissed") { viewModel.updateNotice.value == null }
        assertEquals("1.1.0", prefs.snapshot.value.dismissedAppUpdateVersion)
    }

    @Test
    fun `a dismissed version stays hidden after a re-check and a new view model`() {
        // The live run saw the banner "come back" after Dismiss. The version
        // the banner rendered is persisted, so neither a start/resume re-check
        // nor a recreated (rotated) view model may show it again.
        routes["/api/app-update"] = { _, _ ->
            json(
                """{"currentVersion":"1.0.0","availableVersion":"1.1.0","updateAvailable":true,
                   "updateCommand":"ompweb update","selfUpdateSupported":true}""",
            )
        }
        routes["/api/omp-update"] = { _, _ ->
            json("""{"currentVersion":"0.9.0","availableVersion":null,"updateAvailable":false,"updateCommand":"omp update"}""")
        }

        viewModel.checkForUpdateNotices()
        waitFor("notice") { viewModel.updateNotice.value != null }
        val shown = viewModel.updateNotice.value!!
        viewModel.dismissUpdateNotice(shown)
        waitFor("hidden") { viewModel.updateNotice.value == null }
        assertEquals("1.1.0", prefs.snapshot.value.dismissedAppUpdateVersion)

        // Start/resume re-checks the same endpoints; the dismissed version
        // must not reappear. The check is throttled to one hour, so the resume
        // happens past that window.
        nowMillis += UPDATE_NOTICE_CHECK_INTERVAL_MILLIS
        viewModel.checkForUpdateNotices()
        waitFor("re-check answered") {
            paths.count { it.startsWith("/api/app-update") } >= 2
        }
        repeat(20) {
            Thread.sleep(10)
            assertNull("the dismissed version must stay hidden", viewModel.updateNotice.value)
        }

        // Rotation/process restart: a new view model over the same persisted
        // preferences, with the same update still pending on the server.
        val recreated = SettingsViewModel(
            api.systemApi(),
            prefs,
            ProviderUsagePoller(load = { api.systemApi().providerUsage(it) }, scope = scope),
            nowMillis = { nowMillis },
        )
        store.put("settings-recreated", recreated)
        recreated.loadSystem()
        waitFor("recreated loaded the app update") {
            recreated.systemState.value.appUpdate != null
        }
        repeat(20) {
            Thread.sleep(10)
            assertNull("a fresh view model must not re-announce it", recreated.updateNotice.value)
        }
    }

    @Test
    fun `a resume inside the one-hour window keeps the previous notice check`() {
        // The server memoizes both answers for an hour (`CHECK_TTL_MS` /
        // `OMP_UPDATE_CHECK_TTL_MS`), so a return to the foreground inside the
        // window cannot find anything newer and must not ask again.
        routes["/api/app-update"] = { _, _ ->
            json(
                """{"currentVersion":"1.0.0","availableVersion":"1.1.0","updateAvailable":true,
                   "updateCommand":"ompweb update","selfUpdateSupported":true}""",
            )
        }
        routes["/api/omp-update"] = { _, _ ->
            json("""{"currentVersion":"0.9.0","availableVersion":null,"updateAvailable":false,"updateCommand":"omp update"}""")
        }

        viewModel.checkForUpdateNotices()
        waitFor("the start check") {
            paths.count { it.startsWith("/api/app-update") } == 1 &&
                paths.count { it.startsWith("/api/omp-update") } == 1
        }

        nowMillis += UPDATE_NOTICE_CHECK_INTERVAL_MILLIS - 1
        viewModel.checkForUpdateNotices()
        Thread.sleep(200)
        assertEquals(
            "one millisecond before the window closes is still inside it",
            1,
            paths.count { it.startsWith("/api/app-update") },
        )
        assertEquals(1, paths.count { it.startsWith("/api/omp-update") })

        nowMillis += 1
        viewModel.checkForUpdateNotices()
        waitFor("the resumed check") {
            paths.count { it.startsWith("/api/app-update") } == 2 &&
                paths.count { it.startsWith("/api/omp-update") } == 2
        }
    }

    @Test
    fun `a check that reached no endpoint retries after a short backoff`() {
        // Offline, VPN not up yet or `omp update --check` in its timeout: both
        // routes fail. The old code had claimed the window before the request,
        // so one failed start hid a release for the full interval.
        val down = { _: RecordedRequest, _: String -> json("""{"error":"unreachable"}""", code = 503) }
        routes["/api/app-update"] = down
        routes["/api/omp-update"] = down

        viewModel.checkForUpdateNotices()
        waitFor("the failed check") {
            paths.count { it.startsWith("/api/app-update") } == 1 &&
                paths.count { it.startsWith("/api/omp-update") } == 1
        }
        // Let the launch record its outcome (it publishes nothing on failure).
        Thread.sleep(200)

        // A resume one second later is inside the retry backoff.
        nowMillis += 1_000L
        viewModel.checkForUpdateNotices()
        Thread.sleep(200)
        assertEquals(1, paths.count { it.startsWith("/api/app-update") })
        assertEquals(1, paths.count { it.startsWith("/api/omp-update") })

        // Past the backoff — and far inside the one-hour window — it asks again.
        nowMillis += UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS
        viewModel.checkForUpdateNotices()
        waitFor("the retried check") {
            paths.count { it.startsWith("/api/app-update") } == 2 &&
                paths.count { it.startsWith("/api/omp-update") } == 2
        }
        // Nothing answered, so still no banner.
        assertNull(viewModel.updateNotice.value)
    }

    // ---------------------------------------------------------- install flow

    @Test
    fun `the app update flow prepares, commits, polls and acknowledges`() {
        lateinit var statusCalls: IntArray
        statusCalls = IntArray(1)
        val appInfo = """{"currentVersion":"1.1.0","availableVersion":null,"updateAvailable":false,
            "updateCommand":"ompweb update","selfUpdateSupported":true}"""
        routes["/api/app-update/notes"] = { _, _ -> empty() }
        routes["/api/app-update"] = { request, body ->
            when {
                request.method == "GET" && request.path?.contains("force=1") == true -> json(appInfo)
                body.contains("\"prepare\"") ->
                    json("""{"attemptId":"a1","targetVersion":"1.1.0"}""", code = 202)
                body.contains("\"commit\"") -> json("""{"accepted":true,"attemptId":"a1"}""", code = 202)
                body.contains("\"acknowledge\"") -> json("""{"acknowledged":true,"attemptId":"a1"}""")
                body.contains("\"status\"") -> {
                    statusCalls[0] += 1
                    if (statusCalls[0] == 1) {
                        json("""{"attemptId":"a1","state":"running","stage":"installing","targetVersion":"1.1.0"}""")
                    } else {
                        json(
                            """{"attemptId":"a1","state":"succeeded","stage":"finalizing",
                               "targetVersion":"1.1.0","cleanupReady":true}""",
                        )
                    }
                }
                else -> json(
                    """{"currentVersion":"1.0.0","availableVersion":"1.1.0","updateAvailable":true,
                       "updateCommand":"ompweb update","selfUpdateSupported":true}""",
                )
            }
        }

        viewModel.startUpdate(UpdateKind.APP)
        waitFor("completed") { viewModel.systemState.value.appUpdateRun.phase == UpdatePhase.COMPLETED }

        val run = viewModel.systemState.value.appUpdateRun
        assertEquals(UpdateKind.APP, run.kind)
        assertEquals("1.1.0", run.targetVersion)
        assertEquals("a1", run.attemptId)
        assertEquals("1.1.0", prefs.snapshot.value.completedAppUpdateVersion)
        assertEquals("status polled twice", 2, statusCalls[0])
        assertTrue(
            "acknowledged after success",
            bodies.any { (path, body) -> path == "/api/app-update" && body.contains("\"acknowledge\"") },
        )
        assertEquals("1.1.0", viewModel.systemState.value.appUpdate?.currentVersion)
    }

    @Test
    fun `a failed attempt reports the server error`() {
        routes["/api/app-update"] = { _, body ->
            when {
                body.contains("\"prepare\"") -> json("""{"attemptId":"a2","targetVersion":"1.1.0"}""", code = 202)
                body.contains("\"commit\"") -> json("""{"accepted":true,"attemptId":"a2"}""", code = 202)
                body.contains("\"acknowledge\"") -> json("""{"acknowledged":true,"attemptId":"a2"}""")
                body.contains("\"status\"") ->
                    json("""{"attemptId":"a2","state":"failed","targetVersion":"1.1.0","error":"npm exited 1"}""")
                else -> json(
                    """{"currentVersion":"1.0.0","updateAvailable":true,"availableVersion":"1.1.0",
                       "updateCommand":"ompweb update","selfUpdateSupported":true}""",
                )
            }
        }

        viewModel.startUpdate(UpdateKind.APP)
        waitFor("failed") { viewModel.systemState.value.appUpdateRun.phase == UpdatePhase.FAILED }

        assertEquals("npm exited 1", viewModel.systemState.value.appUpdateRun.error)
        assertFalse(viewModel.systemState.value.appUpdateRun.timedOut)
    }

    // ------------------------------------------------------------ release notes

    @Test
    fun `a 204 leaves the release notes empty and the fetch happens once`() {
        var noteCalls = 0
        routes["/api/app-update/notes"] = { _, _ ->
            noteCalls += 1
            empty()
        }

        viewModel.openReleaseNotes()
        waitFor("notes loaded") { viewModel.systemState.value.releaseNotesLoaded }

        val state = viewModel.systemState.value
        assertTrue(state.releaseNotesOpen)
        assertNull(state.releaseNotes)
        assertNull(state.releaseNotesError)

        viewModel.closeReleaseNotes()
        assertFalse(viewModel.systemState.value.releaseNotesOpen)
        viewModel.openReleaseNotes()
        waitFor("still loaded") { viewModel.systemState.value.releaseNotesLoaded }

        assertEquals(1, noteCalls)
        assertTrue(viewModel.systemState.value.releaseNotesOpen)
    }

    @Test
    fun `release notes carry the version, body and link`() {
        routes["/api/app-update/notes"] = { _, _ ->
            json("""{"version":"1.1.0","body":"- fix A","htmlUrl":"https://github.com/o/r/releases/tag/v1.1.0"}""")
        }

        viewModel.openReleaseNotes()
        waitFor("notes") { viewModel.systemState.value.releaseNotes != null }

        val notes = viewModel.systemState.value.releaseNotes!!
        assertEquals("1.1.0", notes.version)
        assertEquals("- fix A", notes.body)
        assertTrue(notes.htmlUrl.contains("v1.1.0"))
    }

    private fun usageJson(points: Int): String {
        val series = (1..points).joinToString(",") { day ->
            """{"date":"2026-10-0$day","label":"Oct $day","totalCost":1.5,"totalTokens":1000}"""
        }
        return """
            {"timeRange":"30d","granularity":"daily",
             "summary":{"totalCost":4.5,"totalTokens":3000,"inputTokens":2000,"outputTokens":1000,
                        "reasoningTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"cacheSavings":0,
                        "activeDays":3,"tokensPerActiveDay":1000,"cachePercentage":0,
                        "costQuality":{"providerReported":100,"modelPriced":0,"unpriced":0}},
             "providers":[],"timeSeries":[$series],"modelBreakdown":[],"dayBreakdown":[],
             "projectBreakdown":[],
             "scanInfo":{"transcriptsScanned":1,"transcriptsOutsideWindow":0,"usageRecordsCount":3,"durationSeconds":0.1}}
        """.trimIndent()
    }
}
