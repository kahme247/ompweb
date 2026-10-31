package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.NotifyAnswer
import io.github.kahme247.ompweb.domain.NotifyPrefs
import io.github.kahme247.ompweb.domain.NotifyProject
import io.github.kahme247.ompweb.domain.PresenceReport
import io.github.kahme247.ompweb.domain.notifyProject
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** What `POST /api/notifications/test` answered. */
sealed interface TestPushResult {
    data object Sent : TestPushResult

    /** 502 `push_failed`: the push service's own answer, shown verbatim. */
    data class Failed(val message: String) : TestPushResult
}

/** The three 200 statuses of `POST /api/notifications/answer`. */
enum class AnswerOutcome { Answered, AlreadySettled, SessionGone }

/**
 * The notification routes of ompweb (`docs/android/protocol.md` §6.3). Kept
 * behind an interface so the service/receiver can be tested without a server.
 */
interface NotificationsApi {
    /**
     * `PUT /api/notifications/devices`; an omitted subscription keeps a
     * stored one. [origin] pins a captured server for the best-effort
     * unregister during sign-out, when the live origin may already change.
     */
    suspend fun putDevice(deviceId: String, prefs: NotifyPrefs, origin: ServerAddress? = null)

    /** Whether the server holds a Web Push subscription for this device (native never does). */
    suspend fun isSubscribed(deviceId: String): Boolean

    /** `POST /api/notifications/presence` — best effort, 204 expected. */
    suspend fun reportPresence(report: PresenceReport)

    suspend fun sendTest(deviceId: String): TestPushResult

    /** Answers a pending dialog without spawning omp. */
    suspend fun answer(sessionId: String, requestId: String, answer: NotifyAnswer): AnswerOutcome

    /**
     * Session id → project for the notification groups, from `GET /api/sessions`
     * (`projectKey`, else `projectRoot`, else `cwd`). Only ids present in the
     * list are returned; a missing session stays ungrouped.
     */
    suspend fun sessionProjects(): Map<String, NotifyProject>

    /**
     * A notification "Reply" on a completed run is a normal follow-up prompt:
     * `POST /api/agent/{id} {type:"prompt"}` (spawns the session when it is no
     * longer live, exactly like sending from the chat).
     */
    suspend fun followUp(sessionId: String, message: String)
}

class HttpNotificationsApi(
    private val api: ApiClient,
    private val origin: () -> ServerAddress?,
) : NotificationsApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun putDevice(
        deviceId: String,
        prefs: NotifyPrefs,
        origin: ServerAddress?,
    ) = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("deviceId", deviceId)
            put("prefs", prefs.toJson())
        }
        val builder = origin?.let {
            okhttp3.Request.Builder()
                .url(it.apiUrl("api/notifications/devices"))
                .header("Accept", "application/json")
        } ?: api.requestBuilder("api/notifications/devices")
        // A pinned request must also report its own origin: a late 401 of the
        // previous installation must not sign out the configured one.
        requireOk(
            api.exchange(
                builder.put(body.toString().toRequestBody(JSON_MEDIA_TYPE)).build(),
            ),
            requestOrigin = origin ?: origin(),
        )
    }

    override suspend fun isSubscribed(deviceId: String): Boolean = withContext(Dispatchers.IO) {
        val response = api.exchange(
            api.requestBuilder("api/notifications/devices?deviceId=${encodeQuery(deviceId)}").get().build(),
        )
        if (response.status !in 200..299) return@withContext false
        (decode(response.text())["subscribed"] as? kotlinx.serialization.json.JsonPrimitive)
            ?.contentOrNull
            ?.toBooleanStrictOrNull()
            ?: false
    }

    override suspend fun reportPresence(report: PresenceReport) {
        val body = buildJsonObject {
            put("clientId", report.clientId)
            put("deviceId", report.deviceId)
            put("visible", report.visible)
            report.sessionId?.let { put("sessionId", it) }
            put("seq", report.seq)
        }
        // Presence is a hint, never a hard dependency: a failed report must not
        // surface anywhere (and must not sign the user out on a 401).
        runCatching {
            withContext(Dispatchers.IO) {
                api.exchange(
                    api.requestBuilder("api/notifications/presence")
                        .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
                        .build(),
                )
            }
        }
    }

    override suspend fun sendTest(deviceId: String): TestPushResult = withContext(Dispatchers.IO) {
        val body = buildJsonObject { put("deviceId", deviceId) }
        val response = api.exchange(
            api.requestBuilder("api/notifications/test")
                .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build(),
        )
        when {
            response.status in 200..299 -> TestPushResult.Sent
            response.status == 502 -> TestPushResult.Failed(errorMessage(response.text()))
            else -> throw api.errorFor(response.status, response.text(), origin() ?: throw ApiError.NotConfigured)
        }
    }

    override suspend fun answer(sessionId: String, requestId: String, answer: NotifyAnswer): AnswerOutcome =
        withContext(Dispatchers.IO) {
            val body = buildJsonObject {
                put("sessionId", sessionId)
                put("requestId", requestId)
                put("response", answer.toJson())
            }
            val response = api.exchange(
                api.requestBuilder("api/notifications/answer")
                    .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
                    .build(),
            )
            requireOk(response)
            when (decode(response.text())["status"]?.jsonPrimitive?.contentOrNull) {
                "answered" -> AnswerOutcome.Answered
                "alreadySettled" -> AnswerOutcome.AlreadySettled
                "sessionGone" -> AnswerOutcome.SessionGone
                else -> throw ApiError.Http(200, response.text().take(2048))
            }
        }

    override suspend fun sessionProjects(): Map<String, NotifyProject> = withContext(Dispatchers.IO) {
        // `GET /api/sessions` is conditional (ETag), so a refresh is one 304
        // once the list is warm. A project is the canonical `projectKey` (which
        // collapses worktrees), else the session's projectRoot/cwd.
        val list = api.sessions()
        list.sessions.mapNotNull { session ->
            val project = notifyProject(session.projectKey ?: session.projectRoot ?: session.cwd)
                ?: return@mapNotNull null
            session.id to project
        }.toMap()
    }

    override suspend fun followUp(sessionId: String, message: String) = withContext(Dispatchers.IO) {
        val body = buildJsonObject {
            put("type", "prompt")
            put("message", message)
        }
        requireOk(
            api.exchange(
                api.requestBuilder("api/agent/${encodePathSegment(sessionId)}")
                    .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
                    .build(),
                limit = MAX_AGENT_RESPONSE_BYTES,
            ),
        )
    }

    private fun requireOk(response: RawExchange, requestOrigin: ServerAddress? = origin()) {
        if (response.status in 200..299) return
        throw api.errorFor(response.status, response.text(), requestOrigin ?: throw ApiError.NotConfigured)
    }

    private fun decode(body: String): JsonObject = try {
        json.parseToJsonElement(body).jsonObject
    } catch (_: Exception) {
        throw ApiError.Http(200, body.take(2048))
    }

    private fun errorMessage(body: String): String = runCatching { decode(body)["error"]?.jsonPrimitive?.contentOrNull }
        .getOrNull()
        ?.takeIf { it.isNotBlank() }
        ?: "push_failed"

    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        /** A prompt answer is a small JSON ack, not a transcript dump. */
        const val MAX_AGENT_RESPONSE_BYTES = 4L * 1024 * 1024
    }
}
