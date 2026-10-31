package io.github.kahme247.ompweb.ui.settings.native

import io.github.kahme247.ompweb.domain.NativeSettingsDocument
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.HttpNativeSettingsApi
import io.github.kahme247.ompweb.net.NativeSettingsApi
import io.github.kahme247.ompweb.net.NativeSettingsSnapshot
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B22: `/api/omp-settings` must fail fast instead of hanging, and a failed
 * reload must never throw away the document the user is editing.
 */
class NativeSettingsControllerTest {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val server = MockWebServer()
    private var serverStarted = false

    @After
    fun tearDown() {
        scope.cancel()
        if (serverStarted) server.shutdown()
    }

    private fun waitFor(message: String, timeoutMillis: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMillis
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out waiting for $message")
    }

    private class FakeApi(
        var snapshot: NativeSettingsSnapshot = NativeSettingsSnapshot("config.yml", NativeSettingsDocument()),
    ) : NativeSettingsApi {
        var loadFailure: Throwable? = null
        var saveFailure: Throwable? = null
        var loads = 0
        val saved = mutableListOf<NativeSettingsDocument>()

        override suspend fun load(): NativeSettingsSnapshot {
            loads += 1
            loadFailure?.let { throw it }
            return snapshot
        }

        override suspend fun save(document: NativeSettingsDocument): NativeSettingsSnapshot {
            saveFailure?.let { throw it }
            saved += document
            snapshot = NativeSettingsSnapshot(snapshot.path, document)
            return snapshot
        }
    }

    @Test
    fun `failedLoadKeepsDraftEditable`() {
        val confirmed = NativeSettingsDocument().withString("textVerbosity", "low")
        val api = FakeApi(NativeSettingsSnapshot("config.yml", confirmed))
        val controller = NativeSettingsController(api, scope)

        controller.load()
        waitFor("first load") { controller.state.value.loaded }
        assertEquals(confirmed, controller.state.value.document)

        api.loadFailure = IOException("offline")
        controller.load(force = true)
        waitFor("reload failure") { controller.state.value.error != null }

        val afterFailure = controller.state.value
        assertEquals("the loaded document survives a failed reload", confirmed, afterFailure.document)
        assertTrue("the page still counts as loaded", afterFailure.loaded)
        assertFalse(afterFailure.loading)
        assertEquals(2, api.loads)

        // The draft stays editable: the next edit applies and is saved.
        controller.edit { it.withString("textVerbosity", "high") }
        waitFor("edit saved") { api.saved.isNotEmpty() }
        assertEquals("high", controller.state.value.document.string("textVerbosity"))
        assertNull(controller.state.value.error)
    }

    @Test
    fun `a chunked body above four mebibytes is rejected`() {
        val oversized = "x".repeat(4 * 1024 * 1024 + 1)
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                // No Content-Length, exactly like a chunked rogue/proxy answer.
                .setChunkedBody(oversized, 64 * 1024),
        )
        server.start()
        serverStarted = true
        val address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        val api = HttpNativeSettingsApi(ApiClient(OkHttpClient(), { address }))

        val error = kotlinx.coroutines.runBlocking { runCatching { api.load() }.exceptionOrNull() }

        val http = error as? ApiError.Http
        assertEquals("expected a capped read, got $error", 200, http?.code)
        assertTrue(
            "the cap is reported by byte count, not Content-Length",
            http?.body.orEmpty().contains("exceeded"),
        )
    }

    @Test
    fun `a body that trickles in is cut by the same timeout`() {
        // Headers arrive at once; the body would need ~40 * 50 ms. The 200 ms
        // timer must abort the read itself, not just the header exchange.
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"path":"config.yml","settings":{}}""")
                .throttleBody(1, 50, java.util.concurrent.TimeUnit.MILLISECONDS),
        )
        server.start()
        serverStarted = true
        val address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        val api = HttpNativeSettingsApi(ApiClient(OkHttpClient(), { address }), timeoutMillis = 200)

        val started = System.currentTimeMillis()
        val error = kotlinx.coroutines.runBlocking { runCatching { api.load() }.exceptionOrNull() }
        val elapsed = System.currentTimeMillis() - started

        assertTrue("expected a retryable network error, got $error", error is ApiError.Network)
        assertTrue(
            "the timeout names the exchange: ${error?.cause?.message}",
            error?.cause?.message.orEmpty().contains("timed out"),
        )
        assertTrue("must abort at the timer, took ${elapsed}ms", elapsed < 5_000)
    }

    @Test
    fun `loadTimesOutAfterTwelveSeconds`() {
        // The web aborts GET/PUT after 12 s; the constant is the contract.
        assertEquals(12_000L, HttpNativeSettingsApi.TIMEOUT_MS)

        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        server.start()
        serverStarted = true
        val address = (ServerAddress.parse("http://127.0.0.1:${server.port}") as ServerAddressResult.Valid).address
        // 200 ms instead of 12 s so the test finishes; the path is identical.
        val api = HttpNativeSettingsApi(ApiClient(OkHttpClient(), { address }), timeoutMillis = 200)
        val controller = NativeSettingsController(api, scope)

        val started = System.currentTimeMillis()
        controller.load()
        waitFor("timeout") { controller.state.value.error != null }
        val elapsed = System.currentTimeMillis() - started

        // The abort surfaces as the retryable network failure ("Cannot reach the
        // server"); OkHttp's own read timeout is 10 s, so finishing in ~200 ms
        // proves our 12 s guard did the aborting.
        assertEquals("Cannot reach the server", controller.state.value.error.orEmpty())
        assertTrue("must abort long before a minute, took ${elapsed}ms", elapsed < 5_000)
        assertFalse(controller.state.value.loading)
        assertFalse("a never-answered load never counts as loaded", controller.state.value.loaded)
    }
}
