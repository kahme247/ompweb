package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.NOTIFICATION_HISTORY_MAX_IDS
import io.github.kahme247.ompweb.domain.NotificationHistoryEntry
import io.github.kahme247.ompweb.domain.isValidNotificationHistoryId
import io.github.kahme247.ompweb.domain.parseNotificationHistoryEntries
import java.net.URLEncoder
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * `/api/notifications/history` (`app/api/notifications/history/route.ts`), as
 * an interface so the history view model runs in JVM tests without a server.
 *
 * Every method throws an [ApiError] on failure: the view model treats a failed
 * change request as "the server did not accept it" and reloads the server's
 * list instead of keeping a local state the server does not have.
 */
interface NotificationHistoryApi {

    /** `GET` — every entry, newest first. */
    suspend fun load(): List<NotificationHistoryEntry>

    /** `PATCH {ids}` — mark up to [NOTIFICATION_HISTORY_MAX_IDS] entries read. */
    suspend fun markRead(ids: List<String>)

    /** `DELETE ?id=` — remove one entry. */
    suspend fun remove(id: String)

    /** `DELETE ?all=1` — clear the whole history. */
    suspend fun clear()
}

/**
 * The production [NotificationHistoryApi] over the app's single authenticated
 * client (origin binding, cookie jar, policy interceptor, typed errors).
 */
class HttpNotificationHistoryApi(private val api: ApiClient) : NotificationHistoryApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun load(): List<NotificationHistoryEntry> {
        val request = api.requestBuilder(HISTORY_PATH).get().build()
        val response = api.exchange(request)
        val text = response.text()
        if (response.status !in 200..299) throw api.errorFor(response.status, text, originOf(request))
        return try {
            parseNotificationHistoryEntries(json.parseToJsonElement(text))
        } catch (_: SerializationException) {
            throw ApiError.Http(200, text.take(2048))
        }
    }

    override suspend fun markRead(ids: List<String>) {
        val wanted = ids.asSequence()
            .filter(::isValidNotificationHistoryId)
            .distinct()
            .take(NOTIFICATION_HISTORY_MAX_IDS)
            .toList()
        if (wanted.isEmpty()) return
        val body = buildJsonObject {
            put("ids", buildJsonArray { wanted.forEach { add(JsonPrimitive(it)) } })
        }.toString()
        send(api.requestBuilder(HISTORY_PATH).patch(body.toRequestBody(JSON_MEDIA_TYPE)).build())
    }

    override suspend fun remove(id: String) {
        if (!isValidNotificationHistoryId(id)) return
        send(api.requestBuilder("$HISTORY_PATH?id=${encodeQuery(id)}").delete().build())
    }

    override suspend fun clear() {
        send(api.requestBuilder("$HISTORY_PATH?all=1").delete().build())
    }

    private suspend fun send(request: okhttp3.Request) {
        val response = api.exchange(request)
        if (response.status !in 200..299) {
            throw api.errorFor(response.status, response.text(), originOf(request))
        }
    }

    private fun originOf(request: okhttp3.Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")

    private companion object {
        const val HISTORY_PATH = "api/notifications/history"
        val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}
