package io.github.kahme247.ompweb.net

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * P11Sec 1: the login stream owns its `Call`, so its non-2xx body is read
 * outside `ApiClient.exchange`; it must use the same hard cap there.
 */
class AuthApiTest {

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

    private fun api(): ApiClient = ApiClient(OkHttpClient(), { address })

    @Test
    fun `a chunked login error body above the cap is rejected`() {
        val oversized = "x".repeat(ApiClient.MAX_BODY_BYTES.toInt() + 1)
        server.enqueue(
            MockResponse()
                .setResponseCode(500)
                .setHeader("Content-Type", "text/plain")
                // No Content-Length: the old `body.string()` buffered it whole.
                .setChunkedBody(oversized, 64 * 1024),
        )

        val error = runBlocking {
            runCatching { api().authApi().login("openai") {} }.exceptionOrNull()
        }

        val http = error as? ApiError.Http
        assertEquals("expected a capped read, got $error", 500, http?.code)
        assertTrue(
            "the cap is counted per byte: ${http?.body}",
            http?.body.orEmpty().contains("exceeded"),
        )
    }

    @Test
    fun `a small login error body still maps onto the auth error`() {
        server.enqueue(
            MockResponse()
                .setResponseCode(403)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"forbidden"}"""),
        )

        val error = runBlocking {
            runCatching { api().authApi().login("openai") {} }.exceptionOrNull()
        }

        assertTrue("expected Forbidden, got $error", error is ApiError.Forbidden)
    }
}
