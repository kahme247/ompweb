package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.NativeSettingsDocument
import java.io.IOException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** `GET /api/omp-settings` answer: the config file path plus its native keys. */
data class NativeSettingsSnapshot(
    val path: String,
    val document: NativeSettingsDocument,
)

/**
 * `/api/omp-settings` (`app/api/omp-settings/route.ts`), behind an interface
 * so the settings view model runs in JVM tests without a server.
 *
 * The API only moves whole snapshots: the server merges the keys it owns into
 * the user's `config.yml` and leaves everything else untouched, so unknown
 * keys that came back from [load] must be sent back unchanged.
 */
interface NativeSettingsApi {

    suspend fun load(): NativeSettingsSnapshot

    /** `PUT {settings}` — the whole snapshot; answers the server's canonical settings. */
    suspend fun save(document: NativeSettingsDocument): NativeSettingsSnapshot
}

/**
 * Production [NativeSettingsApi]. The web aborts its GET/PUT after 12 s; a
 * settings file can be large and omp's utility process may be busy, but a
 * silent minute-long hang is worse than an explicit retryable failure.
 */
class HttpNativeSettingsApi(
    private val api: ApiClient,
    /** The web's 12 s abort; tests shrink it instead of waiting. */
    private val timeoutMillis: Long = TIMEOUT_MS,
) : NativeSettingsApi {

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * OkHttp's blocking `execute` does not react to coroutine cancellation, so
     * the abort cancels the [okhttp3.Call] itself from a timer; that unblocks
     * the IO thread immediately instead of waiting for the client's 60 s read
     * timeout.
     */
    private val executor = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override suspend fun load(): NativeSettingsSnapshot = request("omp-settings") {
        api.requestBuilder(PATH).get().build()
    }

    override suspend fun save(document: NativeSettingsDocument): NativeSettingsSnapshot {
        val payload = buildJsonObject { put("settings", document.root) }.toString()
        return request("save native settings") {
            api.requestBuilder(PATH)
                .put(payload.toRequestBody(JSON_MEDIA_TYPE))
                .build()
        }
    }

    private suspend fun request(label: String, build: () -> okhttp3.Request): NativeSettingsSnapshot =
        withContext(Dispatchers.IO) {
            val request = build()
            val call = api.openStream(request)
            val timedOut = java.util.concurrent.atomic.AtomicBoolean(false)
            // The whole exchange (headers *and* body) runs inside the timer
            // window: cancelling the Call also stops a body that trickles in
            // after the headers, and the capped read stops a chunked body
            // that has no Content-Length (P11Sec 1).
            val timer = executor.launch {
                delay(timeoutMillis)
                timedOut.set(true)
                call.cancel()
            }
            val exchange = try {
                executor.async { executeAndRead(call, label, timedOut) }.await()
            } catch (cancelled: kotlinx.coroutines.CancellationException) {
                call.cancel()
                throw cancelled
            } finally {
                timer.cancel()
            }
            if (exchange.code !in 200..299) {
                throw api.errorFor(exchange.code, exchange.text, originOf(request))
            }
            parse(exchange.text, exchange.code)
        }

    private fun executeAndRead(
        call: okhttp3.Call,
        label: String,
        timedOut: java.util.concurrent.atomic.AtomicBoolean,
    ): NativeExchange = try {
        call.execute().use { response ->
            NativeExchange(
                code = response.code,
                // Same hard cap as `ApiClient`'s exchange, counted per byte:
                // a chunked answer has `contentLength() == -1`.
                text = api.readCappedBytes(response, MAX_BODY_BYTES).toString(Charsets.UTF_8),
            )
        }
    } catch (error: IOException) {
        throw networkFailure(label, error, timedOut)
    } catch (error: ApiError.Network) {
        // The capped read maps a mid-body abort (our timeout) here.
        throw networkFailure(label, (error.cause as? IOException) ?: IOException(error), timedOut)
    }

    private fun networkFailure(
        label: String,
        error: IOException,
        timedOut: java.util.concurrent.atomic.AtomicBoolean,
    ): ApiError.Network =
        if (timedOut.get()) ApiError.Network(IOException("$label timed out", error)) else ApiError.Network(error)

    private data class NativeExchange(val code: Int, val text: String)

    private fun parse(body: String, status: Int): NativeSettingsSnapshot {
        val root = try {
            json.parseToJsonElement(body).jsonObject
        } catch (_: Exception) {
            throw ApiError.Http(status, body.take(2048))
        }
        (root["error"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull?.let {
            throw ApiError.ServerResponse(status, null, it)
        }
        val settings = root["settings"] as? JsonObject ?: throw ApiError.Http(status, body.take(2048))
        val path = (root["path"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull.orEmpty()
        return NativeSettingsSnapshot(path, NativeSettingsDocument(settings))
    }

    private fun originOf(request: okhttp3.Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    /** `internal` so the JVM test can pin the web's 12 s abort without waiting for it. */
    internal companion object {
        private const val PATH = "api/omp-settings"
        const val TIMEOUT_MS = 12_000L

        /** Same ceiling as `ApiClient`'s capped exchange; a config file never comes close. */
        private const val MAX_BODY_BYTES = 4L * 1024 * 1024

        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
