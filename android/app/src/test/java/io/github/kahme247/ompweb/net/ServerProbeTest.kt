package io.github.kahme247.ompweb.net

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class ServerProbeTest {

    private lateinit var server: MockWebServer
    private val probe = ServerProbe()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun address() = ServerAddress("http", "127.0.0.1", server.port)

    private fun probeEnqueued(response: MockResponse): ProbeResult {
        server.enqueue(response)
        return runBlocking { probe.probe(address()) }
    }

    @Test
    fun `200 with a session list is reachable`() {
        val result = probeEnqueued(MockResponse().setResponseCode(200).setBody("""{"sessions":[],"runningSessionIds":[]}"""))
        assertEquals(ProbeResult.REACHABLE, result)
    }

    @Test
    fun `200 that is not an ompweb payload is not ompweb`() {
        assertEquals(
            ProbeResult.NOT_OMPWEB,
            probeEnqueued(MockResponse().setResponseCode(200).setBody("<html>hello</html>")),
        )
        assertEquals(
            ProbeResult.NOT_OMPWEB,
            probeEnqueued(MockResponse().setResponseCode(200).setBody("""{"error":"nope"}""")),
        )
    }

    @Test
    fun `401 with password_required is a password prompt`() {
        val result = probeEnqueued(
            MockResponse().setResponseCode(401)
                .setBody("""{"error":"Password required","code":"password_required"}"""),
        )
        assertEquals(ProbeResult.PASSWORD_REQUIRED, result)
    }

    @Test
    fun `401 without the ompweb code is not ompweb`() {
        val result = probeEnqueued(
            MockResponse().setResponseCode(401).setBody("""{"error":"unauthorized"}"""),
        )
        assertEquals(ProbeResult.NOT_OMPWEB, result)
    }

    @Test
    fun `503 means the server password is misconfigured`() {
        assertEquals(
            ProbeResult.MISCONFIGURED,
            probeEnqueued(MockResponse().setResponseCode(503)),
        )
    }

    @Test
    fun `403 means the request was blocked`() {
        assertEquals(
            ProbeResult.FORBIDDEN,
            probeEnqueued(MockResponse().setResponseCode(403)),
        )
    }

    @Test
    fun `other status codes are not ompweb`() {
        assertEquals(
            ProbeResult.NOT_OMPWEB,
            probeEnqueued(MockResponse().setResponseCode(404)),
        )
    }

    @Test
    fun `request carries the api path and no browser origin headers`() {
        probeEnqueued(MockResponse().setResponseCode(401).setBody("""{"code":"password_required"}"""))
        val recorded = server.takeRequest()
        assertEquals("/api/sessions", recorded.path)
        assertNull(recorded.getHeader("Origin"))
        assertNull(recorded.getHeader("Sec-Fetch-Site"))
    }

    @Test
    fun `a redirect is not followed`() {
        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "http://example.com/api/sessions"),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"sessions":[]}"""))
        assertEquals(ProbeResult.NOT_OMPWEB, runBlocking { probe.probe(address()) })
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `an oversized answer is not read`() {
        val oversized = MockResponse()
            .setResponseCode(200)
            .setBody("x".repeat(ServerProbe.MAX_BODY_BYTES + 1))
        assertEquals(ProbeResult.NOT_OMPWEB, probeEnqueued(oversized))
        val chunked = MockResponse()
            .setResponseCode(200)
            .setChunkedBody("x".repeat(ServerProbe.MAX_BODY_BYTES + 1024), 8 * 1024)
        assertEquals(ProbeResult.NOT_OMPWEB, probeEnqueued(chunked))
    }

    @Test
    fun `connection refused is unreachable`() {
        val deadServer = MockWebServer().apply { start() }
        val deadPort = deadServer.port
        deadServer.shutdown()
        val result = runBlocking {
            probe.probe(ServerAddress("http", "127.0.0.1", deadPort))
        }
        assertEquals(ProbeResult.UNREACHABLE, result)
    }
}
