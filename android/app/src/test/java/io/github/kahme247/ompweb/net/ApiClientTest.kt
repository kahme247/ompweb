package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.MAX_UPLOAD_BYTES_PER_FILE
import io.github.kahme247.ompweb.domain.UploadConflictStrategy
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ApiClientTest {

    private lateinit var server: MockWebServer
    private lateinit var address: ServerAddress

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun client(onUnauthorized: (ServerAddress) -> Unit = {}): ApiClient =
        ApiClient(OkHttpClient(), { address }, onUnauthorized)

    private fun json(code: Int, body: String): MockResponse =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun `sessions parses the list and the running ids`() {
        server.enqueue(
            json(
                200,
                """{"sessions":[{"id":"s1","cwd":"C:/repo","name":"Demo","modified":"2026-10-20T10:00:00.000Z","messageCount":3}],"runningSessionIds":["s1"]}""",
            ),
        )

        val result = runBlocking { client().sessions() }

        assertEquals(1, result.sessions.size)
        assertEquals("Demo", result.sessions.single().name)
        assertEquals(listOf("s1"), result.runningSessionIds)
    }

    @Test
    fun `sessions parses a session another omp process runs`() {
        server.enqueue(
            json(
                200,
                """{"sessions":[{"id":"s1","cwd":"C:/repo"}],"runningSessionIds":[],""" +
                    """"elsewhereSessions":[{"id":"s1","kind":"terminal",""" +
                    """"source":"process","running":true,"active":true}]}""",
            ),
        )

        val result = runBlocking { client().sessions() }

        assertEquals(
            listOf(
                ElsewhereSession(
                    id = "s1",
                    kind = "terminal",
                    source = "process",
                    running = true,
                    active = true,
                ),
            ),
            result.elsewhereSessions,
        )
        assertTrue("a foreign run is not a local running id", result.runningSessionIds.isEmpty())
    }

    /**
     * A foreign owner answers `GET /api/mcp` without a live list (the server
     * refuses to spawn a second writer) and explains why in `liveError`. The
     * absent list must stay null so the settings section falls back to the
     * configured inventory instead of claiming there are no servers.
     */
    @Test
    fun `a foreign owner leaves the live MCP list absent and explains why`() {
        server.enqueue(
            json(
                200,
                """{"servers":[],"inventory":[{"name":"local","source":"project","status":"configured"}],""" +
                    """"liveError":"This session is being run by another omp process."}""",
            ),
        )

        val snapshot = runBlocking { HttpMcpApi(client()).load("/repo", "s1") }

        assertNull("no live answer keeps the inventory usable", snapshot.liveServers)
        assertEquals(
            "the refusal is explained",
            "This session is being run by another omp process.",
            snapshot.liveError,
        )
        assertEquals(listOf("local"), snapshot.inventory.map { it.name })
    }

    @Test
    fun `a forced prompt skips the foreign owner gate`() {
        server.enqueue(json(200, """{"success":true,"data":null}"""))
        server.enqueue(json(200, """{"success":true,"data":null}"""))
        val api = client()

        runBlocking {
            api.prompt("s1", "plain")
            api.prompt("s1", "into a copy", force = true)
        }

        assertEquals("a plain prompt keeps the gate on", "/api/agent/s1", server.takeRequest().path)
        assertEquals(
            "the confirmed send asks for the copy",
            "/api/agent/s1?force=1",
            server.takeRequest().path,
        )
    }

    @Test
    fun `a refused send maps to the foreign owner error`() {
        // The server's exact 409 body: `elsewhere` is its `SessionElsewhere`
        // (no id/cwd/pid — the request named the session, and the owner's
        // process details stay on the server).
        server.enqueue(
            json(
                409,
                """{"error":"This session is being run by another omp process",""" +
                    """"code":"session_running_elsewhere","elsewhere":{"kind":"omp-web",""" +
                    """"source":"instance-list","running":true,"active":true}}""",
            ),
        )

        val error = assertThrows(ApiError.SessionRunningElsewhere::class.java) {
            runBlocking { client().prompt("s1", "hello") }
        }
        assertEquals("omp-web", error.elsewhere?.kind)
        assertEquals(true, error.elsewhere?.active)
    }

    @Test
    fun `sessions revalidates with If-None-Match and keeps the list on 304`() {
        server.enqueue(
            json(
                200,
                """{"sessions":[{"id":"s1","cwd":"C:/repo","name":"Demo"}],"runningSessionIds":[]}""",
            ).setHeader("ETag", "\"v1\""),
        )
        server.enqueue(MockResponse().setResponseCode(304))

        val api = client()
        val first = runBlocking { api.sessions() }
        val second = runBlocking { api.sessions() }

        assertEquals("a 304 keeps the cached list", first.sessions, second.sessions)
        server.takeRequest()
        assertEquals(
            "the second request revalidates instead of refetching",
            "\"v1\"",
            server.takeRequest().getHeader("If-None-Match"),
        )
    }

    @Test
    fun `app-info exposes the messageSearch capability and defaults it to false`() {
        server.enqueue(
            json(
                200,
                """{"name":"ompweb","version":"0.5.2","api":1,"capabilities":{"heartbeatParam":true,"messageSearch":true}}""",
            ),
        )
        server.enqueue(
            json(
                200,
                """{"name":"ompweb","version":"0.5.1","api":1,"capabilities":{"heartbeatParam":true}}""",
            ),
        )

        val current = runBlocking { client().appInfo() }
        val older = runBlocking { client().appInfo() }

        assertTrue(current.supportsMessageSearch)
        assertEquals("an absent flag means the route does not exist", false, older.supportsMessageSearch)
    }

    @Test
    fun `401 raises Unauthorized and reports the sign-out event`() {
        var unauthorized = 0
        server.enqueue(json(401, """{"code":"password_required"}"""))

        assertThrows(ApiError.Unauthorized::class.java) {
            runBlocking { client(onUnauthorized = { _ -> unauthorized++ }).sessions() }
        }
        assertEquals(1, unauthorized)
    }

    @Test
    fun `503 raises ServerMisconfigured`() {
        server.enqueue(json(503, """{"code":"password_misconfigured"}"""))

        assertThrows(ApiError.ServerMisconfigured::class.java) {
            runBlocking { client().sessions() }
        }
    }

    @Test
    fun `503 session_slow raises SessionSlow instead of ServerMisconfigured`() {
        // `GET /api/agent/{id}` answers this while omp is busy: the run keeps
        // going, so it must never surface as a server setup problem.
        server.enqueue(
            json(
                503,
                """{"error":"omp is busy and did not answer in time; the session keeps running.","code":"session_slow"}""",
            ),
        )

        val error = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().agentState("s1") }
        }
        assertEquals(
            "omp is busy and did not answer in time; the session keeps running.",
            error.serverMessage,
        )
    }

    @Test
    fun `503 session_state_timeout is treated like session_slow`() {
        // Upstream's `get_state` timeout keeps the child alive and says "ask
        // again later" — the same contract as `session_slow`. A rebased server
        // normalizes the code, but an older one must not surface as a hard
        // error either.
        server.enqueue(
            json(
                503,
                """{"error":"omp did not answer the state read in time; the session keeps running.","code":"session_state_timeout"}""",
            ),
        )

        val error = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().agentState("s1") }
        }
        assertEquals(
            "omp did not answer the state read in time; the session keeps running.",
            error.serverMessage,
        )
    }

    @Test
    fun `503 session_slow carries the server run state`() {
        // A blocked child also says whether a turn is in flight: `running:false`
        // is the only way the chat can settle a run whose transcript it cannot
        // read, so the field must survive the parse.
        server.enqueue(
            json(
                503,
                """{"error":"omp is busy","code":"session_slow","running":false,"alive":true,"silentForMs":0}""",
            ),
        )
        val idle = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().agentState("s1") }
        }
        assertEquals(false, idle.running)

        // An older server reports nothing, which stays "unknown", not "idle".
        server.enqueue(
            json(
                503,
                """{"error":"omp is busy","code":"session_slow"}""",
            ),
        )
        val unknown = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().agentState("s1") }
        }
        assertNull(unknown.running)
    }

    @Test
    fun `400 session_state_timeout from a prompt keeps maybeStarted`() {
        server.enqueue(
            json(
                400,
                """{"error":"omp did not answer in time.","code":"session_state_timeout","maybeStarted":true}""",
            ),
        )

        val error = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().prompt("s1", "hi") }
        }
        assertTrue(error.maybeStarted)
    }

    @Test
    fun `500 session_state_timeout from the state route raises SessionSlow`() {
        // Upstream's `/state` route answers 500 when omp blocks its event loop
        // past the read timeout. The child is kept, so the chat must show
        // "busy, still running" instead of an error card for a dead server.
        server.enqueue(
            json(
                500,
                """{"error":"omp did not answer the state read in time; the session keeps running.","code":"session_state_timeout"}""",
            ),
        )

        val error = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().sessions() }
        }
        assertEquals(
            "omp did not answer the state read in time; the session keeps running.",
            error.serverMessage,
        )
        assertEquals(false, error.maybeStarted)
    }

    @Test
    fun `400 session_slow from a prompt keeps maybeStarted`() {
        // POST /api/agent answers 400 when omp was too busy to acknowledge the
        // prompt; `maybeStarted` says the frame may already be running.
        server.enqueue(
            json(
                400,
                """{"error":"omp is busy and did not acknowledge the message in time; it may still be running.","code":"session_slow","maybeStarted":true}""",
            ),
        )

        val error = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().prompt("s1", "hi") }
        }
        assertTrue(error.maybeStarted)
        assertEquals(
            "omp is busy and did not acknowledge the message in time; it may still be running.",
            error.serverMessage,
        )
    }

    @Test
    fun `400 session_slow from an abort keeps abortUnconfirmed`() {
        // POST /api/agent answers this when omp did not confirm the abort: the
        // run may still be going, so the stop must not look completed.
        server.enqueue(
            json(
                400,
                """{"error":"omp is busy and did not answer the abort in time; the abort is not confirmed and the session keeps running.","code":"session_slow","abortUnconfirmed":true}""",
            ),
        )

        val error = assertThrows(ApiError.SessionSlow::class.java) {
            runBlocking { client().abort("s1") }
        }
        assertTrue(error.abortUnconfirmed)
        assertEquals(
            "an abort timeout says nothing about a started prompt",
            false,
            error.maybeStarted,
        )
    }

    @Test
    fun `403 raises Forbidden`() {
        server.enqueue(json(403, """{"code":"forbidden"}"""))

        assertThrows(ApiError.Forbidden::class.java) {
            runBlocking { client().sessions() }
        }
    }

    @Test
    fun `any other error status carries the code and the body`() {
        server.enqueue(json(500, """{"error":"boom"}"""))

        val error = assertThrows(ApiError.Http::class.java) {
            runBlocking { client().sessions() }
        }
        assertEquals(500, error.code)
        assertTrue(error.body.contains("boom"))
    }

    @Test
    fun `a rejected browse keeps the server's sentence for the picker`() {
        // `GET /api/cwd/browse` answers `{error, code}`; the picker shows
        // `userMessage()`, which used to degrade to the bare "HTTP 404"
        // because the browse call bypassed the body-parsing mapper.
        server.enqueue(json(404, """{"error":"Directory does not exist","code":"directory_not_found"}"""))

        val error = assertThrows(ApiError.ServerResponse::class.java) {
            runBlocking { client().browseDirectory("/missing") }
        }

        assertEquals(404, error.status)
        assertEquals("directory_not_found", error.code)
        assertEquals("Directory does not exist", error.userMessage())
    }

    @Test
    fun `a refused connection raises Network`() {
        val deadAddress = (ServerAddress.parse("http://127.0.0.1:1") as ServerAddressResult.Valid).address
        val client = ApiClient(OkHttpClient(), { deadAddress })

        val error = assertThrows(ApiError.Network::class.java) {
            runBlocking { client.sessions() }
        }
        assertTrue(error.cause is IOException)
    }

    @Test
    fun `login maps 200 401 404 and 413`() {
        server.enqueue(json(200, """{"ok":true}"""))
        server.enqueue(json(401, """{"error":"invalid_password"}"""))
        server.enqueue(json(404, """{"code":"password_not_required"}"""))
        server.enqueue(json(413, """{"error":"payload_too_large"}"""))

        val client = client()
        assertEquals(LoginOutcome.Success, runBlocking { client.login("secret") })
        assertEquals(LoginOutcome.WrongPassword, runBlocking { client.login("nope") })
        assertEquals(LoginOutcome.PasswordDisabled, runBlocking { client.login("secret") })
        assertEquals(LoginOutcome.TooLarge, runBlocking { client.login("secret") })
    }

    @Test
    fun `a wrong password does not report the global sign-out event`() {
        var unauthorized = 0
        server.enqueue(json(401, """{"error":"invalid_password"}"""))

        runBlocking { client(onUnauthorized = { _ -> unauthorized++ }).login("nope") }

        assertEquals(0, unauthorized)
    }

    @Test
    fun `postEvent maps ok, unknown connection and rejections`() {
        server.enqueue(json(200, """{"ok":true}"""))
        server.enqueue(json(404, """{"code":"unknown_connection"}"""))
        server.enqueue(json(409, """{"error":"no wrapper","code":"session_not_running"}"""))

        val client = client()
        val payload = buildJsonObject {
            put("connectionId", "c1")
        }

        assertEquals(EventPostResult.Ok, runBlocking { client.postEvent(payload) })
        assertEquals(EventPostResult.ConnectionUnknown, runBlocking { client.postEvent(payload) })
        val rejected = runBlocking { client.postEvent(payload) } as EventPostResult.Rejected
        assertEquals(409, rejected.status)
        assertEquals("session_not_running", rejected.code)
        assertEquals("no wrapper", rejected.message)
    }

    @Test
    fun `postEvent treats a 404 without unknown_connection as a rejected subscription`() {
        server.enqueue(json(404, """{"error":"no such session","code":"file_not_found"}"""))

        val result = runBlocking {
            client().postEvent(buildJsonObject { put("connectionId", "c1") })
        }

        val rejected = result as EventPostResult.Rejected
        assertEquals(404, rejected.status)
        assertEquals("file_not_found", rejected.code)
    }

    @Test
    fun `postEvent maps a 403 to a rejected subscription`() {
        server.enqueue(json(403, """{"error":"forbidden","code":"forbidden"}"""))

        val result = runBlocking {
            client().postEvent(buildJsonObject { put("connectionId", "c1") })
        }

        assertEquals(403, (result as EventPostResult.Rejected).status)
    }

    @Test
    fun `a request without a configured origin raises NotConfigured`() {
        val client = ApiClient(OkHttpClient(), { null })

        assertThrows(ApiError.NotConfigured::class.java) {
            runBlocking { client.sessions() }
        }
    }

    @Test
    fun `two overlapping detail loads share one request`() {
        server.enqueue(
            json(
                200,
                """{"sessionId":"s1","leafId":"e2","info":{"id":"s1","cwd":"C:/repo"},"context":{"messages":[]},"tree":[]}""",
            ).setBodyDelay(300, java.util.concurrent.TimeUnit.MILLISECONDS),
        )
        val api = client()

        val results = runBlocking {
            val first = async { api.sessionDetail("s1") }
            val second = async { api.sessionDetail("s1") }
            first.await() to second.await()
        }

        assertEquals(1, server.requestCount)
        assertEquals("e2", results.first.leafId)
        assertEquals("e2", results.second.leafId)
    }

    @Test
    fun `a detail load right after the first one joins it instead of fetching again`() {
        server.enqueue(
            json(
                200,
                """{"sessionId":"s1","leafId":"e2","info":{"id":"s1","cwd":"C:/repo"},"context":{"messages":[]},"tree":[]}""",
            ),
        )
        val api = client()

        val first = runBlocking { api.sessionDetail("s1") }
        val second = runBlocking { api.sessionDetail("s1") }

        assertEquals("the header and the chat share the transcript transfer", 1, server.requestCount)
        assertEquals(first.leafId, second.leafId)
    }

    @Test
    fun `a failed detail load is retried by the next caller`() {
        server.enqueue(json(500, """{"error":"boom"}"""))
        server.enqueue(
            json(
                200,
                """{"sessionId":"s1","leafId":"e2","info":{"id":"s1","cwd":"C:/repo"},"context":{"messages":[]},"tree":[]}""",
            ),
        )
        val api = client()

        assertThrows(ApiError.Http::class.java) { runBlocking { api.sessionDetail("s1") } }
        assertEquals("e2", runBlocking { api.sessionDetail("s1") }.leafId)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `a primed session list answers a 304 with the cached list`() {
        server.enqueue(MockResponse().setResponseCode(304))
        val api = client()
        val primed = SessionList(sessions = emptyList())
        api.primeSessionList(primed, "\"v9\"")

        val result = runBlocking { api.sessions() }

        assertEquals(primed, result)
        assertEquals("\"v9\"", server.takeRequest().headers["If-None-Match"])
    }

    @Test
    fun `the list answer pairs its body with the etag of the same response`() {
        server.enqueue(
            json(200, """{"sessions":[{"id":"slow","cwd":"/slow"}],"runningSessionIds":[]}""")
                .setHeader("ETag", "\"slow-v1\"")
                .setBodyDelay(400, TimeUnit.MILLISECONDS),
        )
        server.enqueue(
            json(200, """{"sessions":[{"id":"fast","cwd":"/fast"}],"runningSessionIds":[]}""")
                .setHeader("ETag", "\"fast-v1\""),
        )
        val api = client()

        val answers = runBlocking {
            val slow = async(Dispatchers.IO) { api.sessionListAnswer() }
            // Let the slow answer leave, then overtake it with a second one.
            assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
            val fast = api.sessionListAnswer()
            slow.await() to fast
        }

        // The shared cache already holds the fast answer when the slow body is
        // persisted; a store that read the ETag from the cache would pair the
        // slow list with "fast-v1" and be answered 304 for a list it never sent.
        assertEquals("\"slow-v1\"", answers.first.etag)
        assertEquals(listOf("slow"), answers.first.list.sessions.map { it.id })
        assertEquals("\"fast-v1\"", answers.second.etag)
        assertEquals(listOf("fast"), answers.second.list.sessions.map { it.id })
    }

    @Test
    fun `a mutation drops the shared detail answer`() {
        val body = """{"sessionId":"s1","info":{"id":"s1","cwd":"/w","name":"Old"},"context":{"messages":[]}}"""
        server.enqueue(json(200, body))
        server.enqueue(json(200, """{"ok":true}"""))
        server.enqueue(json(404, """{"error":"Session not found"}"""))
        val api = client()

        assertEquals("Old", runBlocking { api.sessionDetail("s1") }.info?.name)
        runBlocking { api.renameSession("s1", "New") }

        // Without the invalidation this would join the two-second window and
        // answer with the pre-rename body.
        api.invalidateSessionDetail("s1")

        assertThrows(ApiError.Http::class.java) { runBlocking { api.sessionDetail("s1") } }
        assertEquals("the next open really asks the server", 3, server.requestCount)
    }

    @Test
    fun `a cancelled owner never cancels the callers sharing its request`() {
        val body = """{"sessionId":"s1","leafId":"e2","info":{"id":"s1","cwd":"/w"},"context":{"messages":[]},"tree":[]}"""
        server.enqueue(json(200, body).setBodyDelay(400, TimeUnit.MILLISECONDS))
        val api = client()
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        val owner = scope.launch { runCatching { api.sessionDetail("s1") } }
        assertNotNull("the owner's request is on the wire", server.takeRequest(2, TimeUnit.SECONDS))
        val joiner = scope.async { runCatching { api.sessionDetail("s1") } }
        // The joiner must be inside the shared flight before the owner leaves.
        Thread.sleep(100)
        runBlocking { owner.cancelAndJoin() }

        val joined = runBlocking { joiner.await() }
        val error = joined.exceptionOrNull()
        assertTrue(
            "the joiner is not cancelled by the owner: $error",
            error !is CancellationException,
        )
        assertEquals("one transfer served both callers", 1, server.requestCount)
        assertEquals("e2", joined.getOrThrow().leafId)
        scope.cancel()
    }

    @Test
    fun `clearMemoryCaches forgets the validators and the shared transcripts`() {
        server.enqueue(
            json(200, """{"sessions":[{"id":"s1","cwd":"/w"}],"runningSessionIds":[]}""").setHeader("ETag", "\"v1\""),
        )
        server.enqueue(
            json(200, """{"sessionId":"s1","info":{"id":"s1","cwd":"/w"},"context":{"messages":[]}}"""),
        )
        server.enqueue(
            json(200, """{"sessions":[{"id":"s1","cwd":"/w"}],"runningSessionIds":[]}""").setHeader("ETag", "\"v2\""),
        )
        server.enqueue(
            json(200, """{"sessionId":"s1","info":{"id":"s1","cwd":"/w"},"context":{"messages":[]}}"""),
        )
        val api = client()

        runBlocking {
            api.sessions()
            api.sessionDetail("s1")
            api.clearMemoryCaches()
            api.sessions()
            api.sessionDetail("s1")
        }

        val requests = List(4) { index ->
            // A bounded wait: a request the client did not send must fail the
            // test, not block the worker.
            server.takeRequest(2, TimeUnit.SECONDS) ?: error("request #$index never arrived")
        }
        assertNull("the wiped validator is not revalidated", requests[2].headers["If-None-Match"])
        assertEquals("the wiped detail is fetched again", 4, requests.size)
        assertEquals(
            "the detail was not served from the heap",
            2,
            requests.count { it.path?.startsWith("/api/sessions/s1") == true },
        )
    }

    @Test
    fun `contextFullRaw returns the exact body the server sent`() {
        val body = """{" sessionId ":"s1","context":{"messages":[]}}"""
        server.enqueue(json(200, body))

        val result = runBlocking { client().contextFullRaw("s1") }

        assertEquals(body, result)
    }

    /**
     * The chat's submit waits ten seconds for the live state. A blocking
     * `execute()` only ends at a socket timeout, so the read needs its own
     * bound: this server never sends headers, the client's read timeout is the
     * app's 60 s, and the answer must still arrive at the live-state bound.
     */
    @Test
    fun `the live state read is bounded by its own timeout, not the read timeout`() {
        assertEquals("the submit bound and the read bound are the same 10 s", 10_000L, ApiClient.LIVE_STATE_READ_TIMEOUT_MILLIS)
        server.enqueue(MockResponse().setHeadersDelay(60, TimeUnit.SECONDS).setBody("""{"running":false}"""))
        val api = ApiClient(
            OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build(),
            { address },
        )

        val started = System.nanoTime()
        assertThrows(ApiError.Network::class.java) {
            runBlocking { api.agentState("s1") }
        }
        val elapsedMillis = (System.nanoTime() - started) / 1_000_000

        assertTrue(
            "the read gives up at its own bound instead of the 60 s read timeout: $elapsedMillis ms",
            elapsedMillis < 20_000,
        )
    }

    /**
     * The other half of the bound: the coroutine that waits for the live state
     * must be able to abandon a call that is already blocking. Its cancellation
     * closes the OkHttp call, otherwise the wait would last until the server
     * (or the read timeout) ends it.
     */
    @Test
    fun `cancelling the waiting coroutine closes the live state call`() {
        server.enqueue(MockResponse().setHeadersDelay(30, TimeUnit.SECONDS).setBody("""{"running":false}"""))
        val api = ApiClient(
            OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).build(),
            { address },
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        runBlocking {
            val read = scope.async { api.agentState("s1") }
            // The server sends nothing for 30 s; the read must be in flight.
            delay(300)
            assertTrue("the read is on the wire", !read.isCompleted)

            val started = System.nanoTime()
            read.cancel()
            read.join()
            val elapsedMillis = (System.nanoTime() - started) / 1_000_000

            assertTrue("the cancelled read returns at once: $elapsedMillis ms", elapsedMillis < 5_000)
            assertTrue("the read was cancelled, not answered", read.isCancelled)
        }
        scope.cancel()
    }

    /**
     * The server buffers every request body up to 26 MiB before auth. One
     * maximum-size file must therefore still fit, multipart envelope included;
     * larger selections travel as several requests (one file each).
     */
    @Test
    fun `a maximum-size upload request stays below the pre-auth body cap`() {
        server.enqueue(json(200, """{"uploaded":["big.bin"]}"""))
        val api = client()
        val bytes = ByteArray(MAX_UPLOAD_BYTES_PER_FILE.toInt()) { 'a'.code.toByte() }

        val outcome = runBlocking {
            api.filesApi().upload("repo", UploadFile("big.bin", bytes), UploadConflictStrategy.Error)
        }

        val request = server.takeRequest()
        val bodySize = request.body.size
        assertTrue(
            "one 25 MiB file plus its multipart headers fits the 26 MiB cap: $bodySize",
            bodySize <= 26L * 1024 * 1024,
        )
        assertTrue("the multipart envelope is part of the body: $bodySize", bodySize > MAX_UPLOAD_BYTES_PER_FILE)
        assertEquals("/api/files/repo?type=upload&conflict=error", request.path)
        assertEquals(listOf("big.bin"), outcome.uploaded)
    }
}
