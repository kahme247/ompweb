package io.github.kahme247.ompweb.net

import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/** What an unauthenticated `GET /api/sessions` tells us about the server. */
enum class ProbeResult {
    REACHABLE,
    PASSWORD_REQUIRED,
    MISCONFIGURED,
    FORBIDDEN,
    NOT_OMPWEB,
    UNREACHABLE,
    TLS_ERROR,
}

/** The capability handshake answer for one server address. */
sealed interface AppInfoProbe {
    /** `/api/app-info` exists and its `api` version is one this app speaks. */
    data class Supported(val info: AppInfo) : AppInfoProbe

    /** The endpoint is missing or its `api` version is unknown: the server needs an update. */
    data class TooOld(val serverVersion: String?) : AppInfoProbe

    data object PasswordRequired : AppInfoProbe
    data object Forbidden : AppInfoProbe
    data object Misconfigured : AppInfoProbe
    data object Unreachable : AppInfoProbe
    data object TlsError : AppInfoProbe
    data object NotOmpweb : AppInfoProbe
}

/**
 * Sends a single, short, unauthenticated request to `<origin>/api/sessions`.
 *
 * The request deliberately carries no `Origin` and no `Sec-Fetch-Site` header:
 * ompweb's origin gate answers those with 403, and a native client is not a
 * browser. A missing `.body` on 401 is treated as not-ompweb rather than a
 * password prompt, so a random web server cannot imitate the sign-in flow.
 *
 * Redirects are not followed and the answer body is capped, so a server the
 * user mistyped can neither move the request to another origin nor make the
 * probe allocate an unbounded body.
 */
class ServerProbe(
    private val client: OkHttpClient = defaultClient(),
) {
    suspend fun probe(address: ServerAddress): ProbeResult = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(address.apiUrl("api/sessions"))
            .header("Accept", "application/json")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val body = readCappedBody(response) ?: return@withContext ProbeResult.NOT_OMPWEB
                when (response.code) {
                    200 -> if (isSessionList(body)) ProbeResult.REACHABLE else ProbeResult.NOT_OMPWEB
                    401 -> if (hasPasswordRequiredCode(body)) {
                        ProbeResult.PASSWORD_REQUIRED
                    } else {
                        ProbeResult.NOT_OMPWEB
                    }
                    503 -> ProbeResult.MISCONFIGURED
                    403 -> ProbeResult.FORBIDDEN
                    else -> ProbeResult.NOT_OMPWEB
                }
            }
        } catch (_: SSLException) {
            ProbeResult.TLS_ERROR
        } catch (_: IOException) {
            ProbeResult.UNREACHABLE
        }
    }

    /**
     * Reads `GET /api/app-info`, the handshake that tells the app whether the
     * server is new enough to talk to. The auth gate runs before routing, so an
     * unauthenticated server with a password answers 401 here and the real
     * version check happens again after sign-in.
     */
    suspend fun probeAppInfo(address: ServerAddress): AppInfoProbe = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(address.apiUrl("api/app-info"))
            .header("Accept", "application/json")
            .get()
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val body = readCappedBody(response) ?: return@withContext AppInfoProbe.NotOmpweb
                when (response.code) {
                    200 -> {
                        val info = try {
                            json.decodeFromString(AppInfo.serializer(), body)
                        } catch (_: Exception) {
                            null
                        }
                        when {
                            info == null -> AppInfoProbe.NotOmpweb
                            info.api != SUPPORTED_API -> AppInfoProbe.TooOld(info.version.ifBlank { null })
                            else -> AppInfoProbe.Supported(info)
                        }
                    }
                    // An older ompweb has no such route; Next answers 404.
                    404, 405 -> AppInfoProbe.TooOld(null)
                    401 -> AppInfoProbe.PasswordRequired
                    403 -> AppInfoProbe.Forbidden
                    503 -> AppInfoProbe.Misconfigured
                    else -> AppInfoProbe.NotOmpweb
                }
            }
        } catch (_: SSLException) {
            AppInfoProbe.TlsError
        } catch (_: IOException) {
            AppInfoProbe.Unreachable
        }
    }

    companion object {
        /** A probe answer is a small JSON object; anything larger is not ompweb. */
        const val MAX_BODY_BYTES = 64 * 1024

        /** The `/api/app-info` version this app was written against. */
        const val SUPPORTED_API = 1

        private val json = Json { ignoreUnknownKeys = true }

        private fun defaultClient(): OkHttpClient = HttpPolicyInterceptor.install(
            OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS)
                .callTimeout(8, TimeUnit.SECONDS)
                .retryOnConnectionFailure(false)
                .followRedirects(false),
        ).build()

        /** Read at most [MAX_BODY_BYTES]; `null` means the body exceeded the cap. */
        private fun readCappedBody(response: Response): String? {
            if (response.body.contentLength() > MAX_BODY_BYTES) return null
            val bytes = response.peekBody(MAX_BODY_BYTES.toLong() + 1).bytes()
            return if (bytes.size > MAX_BODY_BYTES) null else bytes.toString(Charsets.UTF_8)
        }

        private fun isSessionList(body: String): Boolean = try {
            val root = json.parseToJsonElement(body) as? JsonObject
            root?.get("sessions") is JsonArray
        } catch (_: Exception) {
            false
        }

        private fun hasPasswordRequiredCode(body: String): Boolean = try {
            val root = json.parseToJsonElement(body) as? JsonObject
            root?.get("code")?.jsonPrimitive?.contentOrNull == "password_required"
        } catch (_: Exception) {
            false
        }
    }
}
