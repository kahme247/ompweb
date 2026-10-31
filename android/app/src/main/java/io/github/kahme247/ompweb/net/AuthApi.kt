package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.OAuthFrame
import io.github.kahme247.ompweb.domain.parseOAuthFrame
import io.github.kahme247.ompweb.events.SseParser
import java.io.IOException
import java.net.URLEncoder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Auth routes of the Providers tab (`app/api/auth`):
 * provider rosters, stored accounts, API-key status and the OAuth login stream.
 * An interface so `ProvidersModelsViewModel` is JVM-testable.
 */
interface AuthApi {

    /** `GET /api/auth/providers` — providers that support a browser/OAuth login. */
    suspend fun oauthProviders(): List<OAuthProvider>

    /** `GET /api/auth/all-providers` — every provider omp knows, with model counts. */
    suspend fun apiKeyProviders(): List<ApiKeyProvider>

    /** `GET /api/auth/api-key/{provider}` — configured state; never the key itself. */
    suspend fun apiKeyStatus(provider: String): ApiKeyStatus

    /**
     * The server's explanation of why keys cannot be edited here
     * (`POST /api/auth/api-key/{provider}` always answers 501 without writing).
     * Returns `null` when even that probe fails.
     */
    suspend fun apiKeyGuidance(provider: String): String?

    /** `GET /api/auth/accounts/{provider}` — stored credentials omp holds. */
    suspend fun accounts(provider: String): ProviderAccounts

    /** `DELETE /api/auth/accounts/{provider}?credentialId=`. */
    suspend fun disconnectAccount(provider: String, credentialId: Long)

    /**
     * `GET /api/auth/login/{provider}` as an SSE stream. Calls [onFrame] for
     * every parsed frame until a terminal frame, EOF, or cancellation; the
     * server disposes its child when the call is cancelled.
     */
    suspend fun login(provider: String, onFrame: (OAuthFrame) -> Unit)

    /** `POST /api/auth/login/{provider} {token, code}` with the pasted code/URL or a selected option id. */
    suspend fun submitLogin(provider: String, token: String, value: String)
}

data class OAuthProvider(
    val id: String,
    val name: String = "",
    val loggedIn: Boolean = false,
)

data class ApiKeyProvider(
    val id: String,
    val displayName: String = "",
    val configured: Boolean = false,
    val modelCount: Int = 0,
)

data class ApiKeyStatus(
    val provider: String = "",
    val displayName: String = "",
    val configured: Boolean = false,
    val models: Int = 0,
)

/** One stored credential; [label]/[detail] are omp's, never a raw key. */
data class ProviderAccount(
    val credentialId: Long,
    val label: String,
    val detail: String,
    /** `api_key` or `oauth`. */
    val type: String,
)

data class ProviderAccounts(
    val supported: Boolean = true,
    val accounts: List<ProviderAccount> = emptyList(),
)

/** Production [AuthApi] over the app's single authenticated client. */
fun ApiClient.authApi(): AuthApi = HttpAuthApi(this)

private val authJson = Json { ignoreUnknownKeys = true }
private val AUTH_JSON_MEDIA = "application/json".toMediaType()

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

private fun parseAuthObject(text: String): JsonObject? = try {
    authJson.parseToJsonElement(text) as? JsonObject
} catch (_: Exception) {
    null
}

private class HttpAuthApi(private val api: ApiClient) : AuthApi {

    override suspend fun oauthProviders(): List<OAuthProvider> {
        val root = call(api.requestBuilder(PROVIDERS_PATH).get().build())
        return (root["providers"] as? JsonArray).orEmpty().mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val id = item.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            OAuthProvider(
                id = id,
                name = item.string("name")?.takeIf { it.isNotBlank() } ?: id,
                loggedIn = (item["loggedIn"] as? JsonPrimitive)?.contentOrNull == "true",
            )
        }
    }

    override suspend fun apiKeyProviders(): List<ApiKeyProvider> {
        val root = call(api.requestBuilder(ALL_PROVIDERS_PATH).get().build())
        return (root["providers"] as? JsonArray).orEmpty().mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val id = item.string("id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            ApiKeyProvider(
                id = id,
                displayName = item.string("displayName")?.takeIf { it.isNotBlank() } ?: id,
                configured = (item["configured"] as? JsonPrimitive)?.contentOrNull == "true",
                modelCount = item.int("modelCount") ?: 0,
            )
        }
    }

    override suspend fun apiKeyStatus(provider: String): ApiKeyStatus {
        val root = call(api.requestBuilder(apiKeyPath(provider)).get().build())
        return ApiKeyStatus(
            provider = root.string("provider") ?: provider,
            displayName = root.string("displayName")?.takeIf { it.isNotBlank() } ?: provider,
            configured = (root["configured"] as? JsonPrimitive)?.contentOrNull == "true",
            models = root.int("models") ?: 0,
        )
    }

    override suspend fun apiKeyGuidance(provider: String): String? = try {
        val request = api.requestBuilder(apiKeyPath(provider))
            .post("{}".toRequestBody(AUTH_JSON_MEDIA))
            .build()
        val response = api.exchange(request)
        val text = response.text()
        parseAuthObject(text)?.string("error")?.takeIf { it.isNotBlank() }
            ?: text.take(400).takeIf { it.isNotBlank() }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        // The probe is best-effort; the panel falls back to its generic hint.
        null
    }

    override suspend fun accounts(provider: String): ProviderAccounts {
        val root = call(api.requestBuilder(accountsPath(provider)).get().build())
        val accounts = (root["accounts"] as? JsonArray).orEmpty().mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val id = item["credentialId"]?.let { (it as? JsonPrimitive)?.contentOrNull?.toLongOrNull() }
                ?: return@mapNotNull null
            ProviderAccount(
                credentialId = id,
                label = item.string("label").orEmpty(),
                detail = item.string("detail").orEmpty(),
                type = item.string("type").orEmpty(),
            )
        }
        return ProviderAccounts(
            supported = (root["supported"] as? JsonPrimitive)?.contentOrNull != "false",
            accounts = accounts,
        )
    }

    override suspend fun disconnectAccount(provider: String, credentialId: Long) {
        val request = api.requestBuilder("${accountsPath(provider)}?credentialId=$credentialId")
            .delete()
            .build()
        call(request)
    }

    override suspend fun login(provider: String, onFrame: (OAuthFrame) -> Unit) = withContext(Dispatchers.IO) {
        val request = api.requestBuilder(loginPath(provider), accept = "text/event-stream")
            .header("Cache-Control", "no-cache")
            .get()
            .build()
        val call = api.openStream(request)
        // OkHttp reads cannot be interrupted, so the coroutine's completion
        // (cancel of the view model job) closes the socket instead.
        val completion = currentJob()?.invokeOnCompletion { call.cancel() }
        try {
            val response = try {
                call.execute()
            } catch (error: IOException) {
                if (!isActive) return@withContext
                throw ApiError.Network(error)
            }
            response.use { reply ->
                if (reply.code !in 200..299) {
                    // Same hard cap as every other route: the error page of a
                    // proxy or rogue server has no trusted length (P11Sec 1).
                    val text = try {
                        api.readCappedBytes(reply, ApiClient.MAX_BODY_BYTES).toString(Charsets.UTF_8)
                    } catch (error: ApiError.Network) {
                        if (!isActive) return@withContext
                        throw error
                    }
                    throw api.errorFor(reply.code, text, originOf(request))
                }
                val source = reply.body.source()
                val parser = SseParser()
                while (isActive) {
                    val line = try {
                        source.readUtf8Line()
                    } catch (error: IOException) {
                        if (!isActive) return@withContext
                        throw ApiError.Network(error)
                    } ?: break
                    val frame = parser.consume(line) ?: continue
                    val parsed = parseOAuthFrame(frame.data) ?: continue
                    onFrame(parsed)
                    if (parsed is OAuthFrame.Success || parsed is OAuthFrame.Failed || parsed is OAuthFrame.Cancelled) break
                }
            }
        } finally {
            completion?.dispose()
            call.cancel()
        }
    }

    override suspend fun submitLogin(provider: String, token: String, value: String) {
        val payload = buildJsonObject {
            put("token", token)
            put("code", value)
        }
        val request = api.requestBuilder(loginPath(provider))
            .post(payload.toString().toRequestBody(AUTH_JSON_MEDIA))
            .build()
        call(request)
    }

    // --- transport ---------------------------------------------------------

    private suspend fun call(request: Request): JsonObject {
        val response = api.exchange(request)
        val text = response.text()
        if (response.status !in 200..299) throw api.errorFor(response.status, text, originOf(request))
        return parseAuthObject(text) ?: throw ApiError.Http(response.status, text.take(2048))
    }

    private fun originOf(request: Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private fun loginPath(provider: String): String = "api/auth/login/${encodeSegment(provider)}"

    private fun apiKeyPath(provider: String): String = "api/auth/api-key/${encodeSegment(provider)}"

    private fun accountsPath(provider: String): String = "api/auth/accounts/${encodeSegment(provider)}"

    private companion object {
        const val PROVIDERS_PATH = "api/auth/providers"
        const val ALL_PROVIDERS_PATH = "api/auth/all-providers"
    }
}

private fun encodeSegment(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

private suspend fun currentJob(): Job? = kotlin.coroutines.coroutineContext[Job]
