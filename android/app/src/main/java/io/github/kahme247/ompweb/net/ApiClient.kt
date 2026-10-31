package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.SkillDiagnosticsSnapshot
import io.github.kahme247.ompweb.domain.SlashCommandItem
import io.github.kahme247.ompweb.domain.parseSkillDiagnosticsSnapshot
import io.github.kahme247.ompweb.domain.parseSlashCommands
import java.io.EOFException
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** One NDJSON frame from `POST /api/projects/clone`. */
sealed interface CloneFrame {
    data class Output(val text: String) : CloneFrame

    data class Done(val path: String) : CloneFrame

    data class Cancelled(val path: String) : CloneFrame

    data class Error(val message: String, val code: String?) : CloneFrame
}

/**
 * One raw HTTP exchange for callers that need multipart uploads or binary
 * bodies ([io.github.kahme247.ompweb.net.SttApi]).
 */
class RawExchange(val status: Int, val body: ByteArray, val contentType: String?) {
    fun text(): String = body.toString(Charsets.UTF_8)
}

/** The self-contained HTML export of one session, ready for SAF/share. */
data class ExportedSession(val fileName: String, val body: ByteArray)

/** The session list of one origin plus the ETag it was delivered with. */
private data class CachedSessions(val etag: String, val list: SessionList)

/**
 * One `GET /api/sessions` answer: the list **and** the validator that belongs
 * to that very response. Callers that write the list to disk persist both from
 * this pair, never the list from one answer with the ETag of another.
 */
data class SessionListAnswer(val list: SessionList, val etag: String?)

/** What `POST /api/web-auth/session` told us. */
enum class LoginOutcome {
    Success,

    /** 401: the password is wrong. */
    WrongPassword,

    /** 404: the server has no password protection; no cookie is needed. */
    PasswordDisabled,

    /** 413: the request body was too large for the server's cap. */
    TooLarge,
}

/** The answer to one `/api/events` subscribe/unsubscribe POST. */
sealed interface EventPostResult {
    data object Ok : EventPostResult

    /** 404 `unknown_connection`: the server restarted; reconnect and resubscribe. */
    data object ConnectionUnknown : EventPostResult

    /** The subscription itself was refused (409 for a wrapper-less session, 400 for a bad channel). */
    data class Rejected(val status: Int, val code: String?, val message: String) : EventPostResult
}

/**
 * The app's HTTP entry to one ompweb server.
 *
 * Deliberately sends no `Origin` and no `Sec-Fetch-Site`: ompweb's origin gate
 * answers those with 403, because a native client is not a browser. Every
 * request carries the session cookie of exactly the configured origin (see
 * `OriginBoundCookieJar`), and every 401 is reported to [onUnauthorized] so
 * the app can return to the password screen from anywhere.
 */
class ApiClient(
    private val client: OkHttpClient,
    private val origin: () -> ServerAddress?,
    private val onUnauthorized: (ServerAddress) -> Unit = {},
) : ChatApi, ComposerControlsApi, SkillDiagnosticsApi, SessionSearchApi {

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    /**
     * One daemon thread per running clone stream. Kept off [Dispatchers.IO]
     * because the read cannot be interrupted: the thread ends when the call
     * is cancelled.
     */
    private val cloneExecutor = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "clone-stream").apply { isDaemon = true }
    }

    /**
     * Derived clients for [openEventStream], one per requested heartbeat.
     * Built lazily and reused: every builder copy allocates a new dispatcher
     * wrapper and connection pool view.
     */
    private val eventStreamClients = ConcurrentHashMap<Int, OkHttpClient>()

    /**
     * The client of [agentState] — the same policy plus a hard per-call
     * timeout. The submit gate waits ten seconds for that answer, so a server
     * that never answers must cost the same ten seconds instead of the
     * 60 s read timeout (a trickling body would otherwise hold the call, and
     * the composer, indefinitely). Built once: the copy shares pool,
     * dispatcher and cookie jar.
     */
    private val liveStateClient: OkHttpClient by lazy {
        client.newBuilder()
            .callTimeout(LIVE_STATE_READ_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)
            .build()
    }

    /**
     * Last session list per origin together with its ETag, so a poll that the
     * server answers with 304 keeps the list the UI already shows (A23, web
     * `SessionSidebar`). Keyed by origin: a server switch must never reuse the
     * previous installation's list.
     */
    private val sessionsCache = ConcurrentHashMap<String, CachedSessions>()

    /**
     * `GET /api/sessions/{id}` requests currently on the wire, keyed by origin
     * and id. Opening a session asks two view models for the same body within
     * milliseconds of each other (`SessionsViewModel.loadDetail` for the
     * header, `ChatViewModel.loadMeta` for the branch tree); sharing the
     * request is what keeps the transcript from crossing the wire twice.
     *
     * A finished answer stays here for [DETAIL_SHARE_WINDOW_MILLIS] so a
     * request that starts right after the first one still joins it instead of
     * opening a second transfer. After that every caller asks the server
     * again — this is request sharing, not a content cache.
     */
    private val detailFlights = HashMap<String, DetailFlight>()
    private val detailLock = Any()

    /**
     * Seeds the ETag cache with a list read from disk, so the first request of
     * a cold start can be a conditional one and a `304` keeps exactly that
     * list instead of failing for a missing entry.
     */
    fun primeSessionList(list: SessionList, etag: String?) {
        val cacheKey = sessionsCacheKey() ?: return
        if (etag.isNullOrEmpty()) return
        synchronized(sessionsCache) { sessionsCache[cacheKey] = CachedSessions(etag, list) }
    }

    /**
     * Drops every answer this client keeps in memory: the list/ETag per origin
     * and the shared detail answers (each carries a whole transcript). Called
     * when the signed-in user's data is dropped, so nothing of that
     * installation survives on the heap.
     */
    fun clearMemoryCaches() {
        synchronized(sessionsCache) { sessionsCache.clear() }
        synchronized(detailLock) { detailFlights.clear() }
    }

    private fun sessionsCacheKey(): String? {
        val requestUrl = url("api/sessions")
        return "${requestUrl.scheme}://${requestUrl.host}:${requestUrl.port}"
    }

    suspend fun sessions(): SessionList = sessionListAnswer().list

    /**
     * The list together with the validator of **this** answer. A caller that
     * persists the body must use this pair: [sessionsCache] may already hold a
     * newer answer by the time the write runs, and a body paired with another
     * response's ETag makes the server answer `304` for a list it never sent.
     */
    suspend fun sessionListAnswer(): SessionListAnswer = withContext(Dispatchers.IO) {
        val requestUrl = url("api/sessions")
        val cacheKey = "${requestUrl.scheme}://${requestUrl.host}:${requestUrl.port}"
        val cached = synchronized(sessionsCache) { sessionsCache[cacheKey] }
        val request = Request.Builder()
            .url(requestUrl)
            .header("Accept", "application/json")
            .apply { if (cached != null) header("If-None-Match", cached.etag) }
            .get()
            .build()
        val response = perform(request)
        if (response.status == 304) {
            // Without an entry the 304 is a server bug; surfacing it as an
            // error is better than pretending the list is empty.
            val kept = cached ?: throw errorFor(304, response.body, response.origin)
            return@withContext SessionListAnswer(kept.list, kept.etag)
        }
        val body = requireSuccess(response)
        val list = decode(body) { json.decodeFromString(SessionList.serializer(), body) }
        val etag = response.etag
        synchronized(sessionsCache) {
            if (etag == null) sessionsCache.remove(cacheKey) else sessionsCache[cacheKey] = CachedSessions(etag, list)
        }
        SessionListAnswer(list, etag)
    }

    // --- Projects -----------------------------------------------------------

    /** `GET /api/app-info`: the server's name/version handshake (intro version line). */
    suspend fun appInfo(): AppInfo = withContext(Dispatchers.IO) {
        val body = requireSuccess(perform(get("api/app-info")))
        decode(body) { json.decodeFromString(AppInfo.serializer(), body) }
    }

    suspend fun projects(): ProjectList = withContext(Dispatchers.IO) {
        val body = requireSuccess(perform(get("api/projects")))
        decode(body) { json.decodeFromString(ProjectList.serializer(), body) }
    }

    /**
     * `POST /api/projects {cwd, launchConfig?}`. The server validates the
     * directory and resolves Git worktrees to their main project root
     * (`app/api/projects/route.ts` POST).
     */
    suspend fun addProject(cwd: String, launchConfig: ProjectLaunchConfig? = null): ManagedProject =
        withContext(Dispatchers.IO) {
            val payload = buildJsonObject {
                put("cwd", cwd)
                if (launchConfig != null) put("launchConfig", launchConfig.toJson())
            }
            val response = perform(postJson("api/projects", payload.toString()))
            if (response.status !in 200..299) throw requestError(response)
            val body = decode(response.body) { json.decodeFromString(ProjectResponse.serializer(), response.body) }
            body.project ?: throw ApiError.Http(response.status, response.body)
        }

    suspend fun updateProjectAlias(cwd: String, alias: String) = withContext(Dispatchers.IO) {
        patchProject(buildJsonObject { put("cwd", cwd); put("alias", alias) })
    }

    /** `launchConfig = null` clears the stored configuration. */
    suspend fun updateProjectLaunchConfig(cwd: String, launchConfig: ProjectLaunchConfig?) = withContext(Dispatchers.IO) {
        patchProject(
            buildJsonObject {
                put("cwd", cwd)
                put("launchConfig", launchConfig?.toJson() ?: JsonNull)
            },
        )
    }

    /**
     * Persists one whole-list order as a single atomic batched PATCH — the
     * server applies every entry in one registry save, so a drag reorder can
     * never interleave with another writer (`app/api/projects/route.ts` PATCH).
     */
    suspend fun reorderProjects(paths: List<String>) = withContext(Dispatchers.IO) {
        val updates = buildJsonArray {
            paths.forEachIndexed { index, path ->
                add(
                    buildJsonObject {
                        put("cwd", path)
                        put("sortOrder", JsonPrimitive(index))
                    },
                )
            }
        }
        patchProject(buildJsonObject { put("updates", updates) })
    }

    suspend fun deleteProject(cwd: String) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject { put("cwd", cwd) }
        val response = perform(postJson("api/projects", payload.toString(), method = "DELETE"))
        if (response.status !in 200..299) throw requestError(response)
    }

    private fun patchProject(payload: JsonObject) {
        val response = perform(postJson("api/projects", payload.toString(), method = "PATCH"))
        if (response.status !in 200..299) throw requestError(response)
    }

    // --- Sessions -----------------------------------------------------------

    override suspend fun sessionDetail(id: String): SessionDetail = withContext(Dispatchers.IO) {
        sharedSessionDetail(id)
    }

    /**
     * The same request without the sharing window. An explicit reload must see
     * what the server has *now*: a session that was just deleted answers 404
     * here, instead of repeating the answer another view model received two
     * seconds ago.
     */
    suspend fun sessionDetailFresh(id: String): SessionDetail = withContext(Dispatchers.IO) {
        invalidateSessionDetail(id)
        fetchSessionDetail(id)
    }

    /**
     * A mutation changed what `GET /api/sessions/{id}` answers (rename,
     * auto-name, delete, archive). The shared answer of the last request must
     * never be handed to the next caller: an open right after a delete would
     * otherwise resurrect the session from the two-second sharing window.
     */
    fun invalidateSessionDetail(id: String) {
        // Without a configured origin there is no key and nothing to forget.
        if (origin() == null) return
        synchronized(detailLock) { detailFlights.remove(detailKey(id)) }
    }

    private fun detailKey(id: String): String {
        val origin = url("api/sessions/${encodePathSegment(id)}")
        return "${origin.scheme}://${origin.host}:${origin.port}|$id"
    }

    /**
     * One in-flight `GET /api/sessions/{id}` per origin and id. The first
     * caller fetches; every caller that arrives while it runs (or within
     * [DETAIL_SHARE_WINDOW_MILLIS] after it) gets the same answer.
     */
    private suspend fun sharedSessionDetail(id: String): SessionDetail {
        val key = detailKey(id)
        val flight: DetailFlight
        val owner: Boolean
        synchronized(detailLock) {
            val now = System.currentTimeMillis()
            // Bounded: an expired answer carries a whole transcript, so the
            // table never keeps more than the requests of the last window.
            detailFlights.entries.removeAll { !it.value.isActive() && now - it.value.completedAt > DETAIL_SHARE_WINDOW_MILLIS }
            val running = detailFlights[key]
            if (running != null && (running.isActive() || running.isFresh(now))) {
                flight = running
                owner = false
            } else {
                flight = DetailFlight(CompletableDeferred())
                detailFlights[key] = flight
                owner = true
            }
        }
        if (!owner) return flight.result.await()
        return try {
            val detail = fetchSessionDetail(id)
            flight.completedAt = System.currentTimeMillis()
            flight.result.complete(detail)
            detail
        } catch (error: Throwable) {
            synchronized(detailLock) { detailFlights.remove(key, flight) }
            // The owner's own cancellation is its business: every joiner is an
            // unrelated caller that still wants the body. Completing their
            // shared answer with the owner's CancellationException would cancel
            // their coroutine instead of letting them show/retry a failure.
            flight.result.completeExceptionally(
                if (error is CancellationException) IOException("Request cancelled") else error,
            )
            throw error
        }
    }

    private class DetailFlight(val result: CompletableDeferred<SessionDetail>) {
        @Volatile
        var completedAt: Long = 0

        fun isActive(): Boolean = !result.isCompleted

        fun isFresh(now: Long = System.currentTimeMillis()): Boolean =
            completedAt > 0 && now - completedAt <= DETAIL_SHARE_WINDOW_MILLIS
    }

    private suspend fun fetchSessionDetail(id: String): SessionDetail {
        val body = requireSuccess(perform(get("api/sessions/${encodePathSegment(id)}")))
        return decode(body) { json.decodeFromString(SessionDetail.serializer(), body) }
    }

    /** `PATCH /api/sessions/{id} {name}` — the server persists the title. */
    suspend fun renameSession(id: String, name: String) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject { put("name", name) }
        val response = perform(postJson("api/sessions/${encodePathSegment(id)}", payload.toString(), method = "PATCH"))
        if (response.status !in 200..299) throw requestError(response)
    }

    suspend fun deleteSession(id: String) = withContext(Dispatchers.IO) {
        val response = perform(postJson("api/sessions/${encodePathSegment(id)}", "{}", method = "DELETE"))
        if (response.status !in 200..299) throw requestError(response)
    }

    /** `POST /api/sessions/{id}/archive` — refuses parents with 409. */
    suspend fun archiveSession(id: String) = withContext(Dispatchers.IO) {
        val response = perform(postJson("api/sessions/${encodePathSegment(id)}/archive", "{}"))
        if (response.status !in 200..299) throw requestError(response)
    }

    suspend fun autoNameSession(id: String): AutoNameResponse = withContext(Dispatchers.IO) {
        val response = perform(postJson("api/sessions/${encodePathSegment(id)}/auto-name", "{}"))
        if (response.status !in 200..299) throw requestError(response)
        decode(response.body) { json.decodeFromString(AutoNameResponse.serializer(), response.body) }
    }

    /** `POST /api/sessions/import {fileName, content}` — a native omp JSONL. */
    suspend fun importSession(fileName: String, content: String) = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("fileName", fileName)
            put("content", content)
        }
        val response = perform(postJson("api/sessions/import", payload.toString()))
        if (response.status !in 200..299) throw requestError(response)
    }

    /**
     * `GET /api/sessions/messages/search?q=&limit=&cursor=` — read-only
     * full-text search over the session files. The server bounds every page
     * (time, bytes, result count); [cursor] asks for the next slice.
     *
     * The older `/api/sessions/search` is **not** this route: servers from
     * 0.6.0 on use it for the sidebar ranking and answer NDJSON, so the app
     * only ever calls the `messages/` path (guarded by
     * `capabilities.messageSearch`).
     */
    override suspend fun searchSessions(
        query: String,
        limit: Int,
        cursor: String?,
    ): SessionSearchPage = withContext(Dispatchers.IO) {
        val params = buildString {
            append("q=").append(encodeQuery(query))
            append("&limit=").append(limit.coerceIn(1, 100))
            if (!cursor.isNullOrBlank()) append("&cursor=").append(encodeQuery(cursor))
        }
        val response = perform(get("api/sessions/messages/search?$params"))
        // The route answers errors as `{error, code}` (a busy server sends 429
        // `search_busy`), so the UI can localize them instead of printing
        // "HTTP 429".
        if (response.status !in 200..299) throw requestError(response)
        val body = response.body
        decode(body) { json.decodeFromString(SessionSearchPage.serializer(), body) }
    }

    /** The self-contained HTML of `GET /api/sessions/{id}/export`. */
    suspend fun exportSession(id: String): ExportedSession = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url("api/sessions/${encodePathSegment(id)}/export"))
            .header("Accept", "text/html")
            .get()
            .build()
        val response = try {
            client.newCall(request).execute()
        } catch (error: IOException) {
            throw ApiError.Network(error)
        }
        val origin = request.url.let { ServerAddress(it.scheme, it.host, it.port) }
        response.use {
            if (it.code !in 200..299) throw requestError(RawResponse(it.code, readCappedBody(it), origin))
            val name = fileNameFromContentDisposition(it.header("Content-Disposition"))
                ?: "omp-session-${id.take(12)}.html"
            // Read with the same cap as every other route: `bytes()` would
            // allocate an unbounded (chunked) body before the size check.
            ExportedSession(name, readCappedBytes(it, MAX_EXPORT_BYTES))
        }
    }

    /** `POST /api/agent/new` with `type:"ensure_session"` returns the real id. */
    suspend fun createSession(
        cwd: String,
        toolNames: List<String>?,
        provider: String?,
        modelId: String?,
        thinkingLevel: String?,
        advisor: Boolean,
    ): String = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            put("cwd", cwd)
            put("type", "ensure_session")
            if (toolNames != null) put("toolNames", buildJsonArray { toolNames.forEach { add(JsonPrimitive(it)) } })
            if (provider != null && modelId != null) {
                put("provider", provider)
                put("modelId", modelId)
            }
            if (!thinkingLevel.isNullOrBlank() && thinkingLevel != "auto") put("thinkingLevel", thinkingLevel)
            if (advisor) put("advisor", true)
        }
        val response = perform(postJson("api/agent/new", payload.toString()))
        if (response.status !in 200..299) throw requestError(response)
        val body = decode(response.body) { json.decodeFromString(AgentNewResponse.serializer(), response.body) }
        body.sessionId.takeIf { it.isNotBlank() } ?: throw ApiError.Http(response.status, response.body)
    }

    /** `POST /api/agent/{id} {type:"prompt"}` with images and streaming behavior. */
    override suspend fun prompt(
        sessionId: String,
        message: String,
        images: List<ComposerImage>,
        streamingBehavior: String?,
        force: Boolean,
    ): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject {
            put("type", "prompt")
            put("message", message)
            if (images.isNotEmpty()) put("images", imagesJson(images))
            if (!streamingBehavior.isNullOrBlank()) put("streamingBehavior", streamingBehavior)
        },
        force = force,
    )

    /** `{type:"steer", message, images?}` — into the running turn. */
    override suspend fun steer(
        sessionId: String,
        message: String,
        images: List<ComposerImage>,
    ): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject {
            put("type", "steer")
            put("message", message)
            if (images.isNotEmpty()) put("images", imagesJson(images))
        },
    )

    /** `{type:"follow_up", message, images?}` — queued behind the running turn. */
    override suspend fun followUp(
        sessionId: String,
        message: String,
        images: List<ComposerImage>,
    ): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject {
            put("type", "follow_up")
            put("message", message)
            if (images.isNotEmpty()) put("images", imagesJson(images))
        },
    )

    override suspend fun bash(sessionId: String, command: String, excludeFromContext: Boolean): JsonElement? =
        sendAgentCommand(
            sessionId,
            buildJsonObject {
                put("type", "bash")
                put("command", command)
                put("excludeFromContext", excludeFromContext)
            },
        )

    override suspend fun abortBash(sessionId: String): JsonElement? =
        sendAgentCommand(sessionId, buildJsonObject { put("type", "abort_bash") })

    override suspend fun abortAndRestoreQueue(sessionId: String): QueueRestore = withContext(Dispatchers.IO) {
        val data = sendAgentCommand(sessionId, buildJsonObject { put("type", "abort_and_restore_queue") })
        val root = data as? JsonObject
        QueueRestore(
            steering = queuedEntries(root?.get("steering")),
            followUp = queuedEntries(root?.get("followUp")),
        )
    }

    override suspend fun removeQueuedMessage(
        sessionId: String,
        message: String,
        queue: String,
    ): QueuedMessageRemoval = withContext(Dispatchers.IO) {
        val data = sendAgentCommand(
            sessionId,
            buildJsonObject {
                put("type", "remove_queued_message")
                put("message", message)
                put("queue", queue)
            },
        )
        val root = data as? JsonObject
        QueuedMessageRemoval(
            removed = (root?.get("removed") as? JsonPrimitive)?.booleanOrNull == true,
            images = imagesFromRpc(root?.get("images")),
        )
    }

    override suspend fun promoteQueuedMessage(sessionId: String, message: String): Boolean = withContext(Dispatchers.IO) {
        val data = sendAgentCommand(
            sessionId,
            buildJsonObject {
                put("type", "promote_queued_message")
                put("message", message)
            },
        )
        val root = data as? JsonObject
        (root?.get("promoted") as? JsonPrimitive)?.booleanOrNull == true
    }

    override suspend fun commands(sessionId: String): List<SlashCommandItem> = withContext(Dispatchers.IO) {
        val data = sendAgentCommand(sessionId, buildJsonObject { put("type", "get_commands") })
        parseSlashCommands((data as? JsonObject)?.get("commands"))
    }

    override suspend fun skillDiagnostics(sessionId: String): SkillDiagnosticsSnapshot? =
        parseSkillDiagnosticsSnapshot(
            sendAgentCommand(sessionId, buildJsonObject { put("type", "get_skill_diagnostics") }),
        )

    override suspend fun setSkillStartupDiagnostics(
        sessionId: String,
        enabled: Boolean,
    ): SkillDiagnosticsSnapshot? = parseSkillDiagnosticsSnapshot(
        sendAgentCommand(
            sessionId,
            buildJsonObject {
                put("type", "set_skill_startup_diagnostics")
                put("enabled", enabled)
            },
        ),
    )

    override suspend fun compact(sessionId: String, customInstructions: String?): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject {
            put("type", "compact")
            if (!customInstructions.isNullOrBlank()) put("customInstructions", customInstructions)
        },
    )

    override suspend fun reload(sessionId: String): JsonElement? =
        sendAgentCommand(sessionId, buildJsonObject { put("type", "reload") })

    override suspend fun setSessionName(sessionId: String, name: String): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject {
            put("type", "set_session_name")
            put("name", name)
        },
    )

    override suspend fun lastAssistantText(sessionId: String): String? = withContext(Dispatchers.IO) {
        val data = sendAgentCommand(sessionId, buildJsonObject { put("type", "get_last_assistant_text") })
        ((data as? JsonObject)?.get("text") as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
    }

    override suspend fun skills(cwd: String): SkillsResponse = withContext(Dispatchers.IO) {
        val body = requireSuccess(perform(get("api/skills?cwd=${encodeQuery(cwd)}")))
        decode(body) { json.decodeFromString(SkillsResponse.serializer(), body) }
    }

    // --- Chat (Phase 5) -----------------------------------------------------

    /**
     * `GET /api/agent/{id}` — `{running, alive, state}` for reconciliation.
     *
     * The chat's submit gate waits at most ten seconds for this answer, so the
     * read is bounded and cancellable on its own: a blocking `execute()` only
     * ends at a socket timeout (60 s read here, unbounded for a trickling
     * body), and a coroutine timeout cannot interrupt it. [liveStateClient]
     * caps a server that never answers, and cancelling the waiting coroutine
     * closes the call, so the submit's bound is a real bound.
     */
    override suspend fun agentState(sessionId: String): JsonObject = withContext(Dispatchers.IO) {
        val body = requireSuccess(
            performCancellable(liveStateClient, get("api/agent/${encodePathSegment(sessionId)}")),
        )
        decode(body) { json.parseToJsonElement(body).jsonObject }
    }

    /**
     * `GET /api/sessions` — the ids the server runs a turn for right now
     * (`runningSessionIds`, the session list's own registry). Used only as the
     * fallback authority for a 503 that does not report the run state, so the
     * shared (ETag-revalidated) list read is reused instead of a new call.
     */
    override suspend fun runningSessionIds(): List<String> = sessions().runningSessionIds

    /** `GET /api/github-repo?cwd=` — `owner/repo` for the checkout, or null. */
    override suspend fun githubRepo(cwd: String): String? = withContext(Dispatchers.IO) {
        val body = requireSuccess(perform(get("api/github-repo?cwd=${encodeQuery(cwd)}")))
        decode(body) {
            json.parseToJsonElement(body).jsonObject["repo"]?.jsonPrimitive?.contentOrNull
        }
    }

    /** [agentCommand] with the session's advisor flag off. */
    private suspend fun sendAgentCommand(
        sessionId: String,
        command: JsonObject,
        force: Boolean = false,
    ): JsonElement? =
        agentCommand(sessionId, command, advisor = false, force = force)

    /**
     * `POST /api/agent/{id}` — every omp RPC command (`prompt`, `abort`,
     * `fork`, `get_state`, …). The route wraps the result in
     * `{success, data}`; `data` is null for fire-and-forget commands.
     * `?advisor=1` marks commands of an advisor-enabled session, `?force=1`
     * skips the gate against a session another omp process owns.
     */
    override suspend fun agentCommand(
        sessionId: String,
        command: JsonObject,
        advisor: Boolean,
        force: Boolean,
    ): JsonElement? =
        withContext(Dispatchers.IO) {
            val query = buildList {
                if (advisor) add("advisor=1")
                if (force) add("force=1")
            }.joinToString("&")
            val path = "api/agent/${encodePathSegment(sessionId)}" + if (query.isEmpty()) "" else "?$query"
            val response = perform(postJson(path, command.toString()))
            if (response.status !in 200..299) throw requestError(response)
            val root = decode(response.body) { json.parseToJsonElement(response.body).jsonObject }
            val failed = root["success"]?.jsonPrimitive?.booleanOrNull == false || root["error"] != null
            if (failed) {
                val code = root["code"]?.jsonPrimitive?.contentOrNull
                val message = root["error"]?.jsonPrimitive?.contentOrNull ?: "The command failed"
                throw ApiError.ServerResponse(response.status, code, message)
            }
            root["data"]
        }

    /**
     * `GET /api/sessions/{id}/context?sync=1` — one display-history page plus
     * the live snapshot.
     */
    override suspend fun contextSync(
        sessionId: String,
        cursor: String?,
        leafId: String?,
        includePreCompaction: Boolean,
        deferThinking: Boolean,
        deferMedia: Boolean,
    ): JsonObject = withContext(Dispatchers.IO) {
        val query = buildList {
            add("sync=1")
            if (cursor != null) add("cursor=${encodeQuery(cursor)}")
            if (leafId != null) add("leafId=${encodeQuery(leafId)}")
            add("includePreCompaction=${if (includePreCompaction) 1 else 0}")
            if (deferThinking) add("deferThinking=1")
            if (deferMedia) add("deferMedia=1")
        }.joinToString("&")
        val body = requireSuccess(perform(get("api/sessions/${encodePathSegment(sessionId)}/context?$query")))
        decode(body) { json.parseToJsonElement(body).jsonObject }
    }

    /**
     * `GET /api/sessions/{id}/context` — the whole display history (web
     * `loadContext`, one request per open). Older rows are revealed lazily by
     * the transcript window, not by additional history requests.
     */
    override suspend fun contextFull(
        sessionId: String,
        leafId: String?,
        includePreCompaction: Boolean,
        deferThinking: Boolean,
        deferMedia: Boolean,
    ): JsonObject = withContext(Dispatchers.IO) {
        val body = contextFullRaw(sessionId, leafId, includePreCompaction, deferThinking, deferMedia)
        decode(body) { json.parseToJsonElement(body).jsonObject }
    }

    /**
     * The same response as [contextFull], as the exact body the server sent.
     * The chat writes that body to the offline cache unchanged, so a cached
     * open parses byte-for-byte what a live open would have parsed.
     */
    override suspend fun contextFullRaw(
        sessionId: String,
        leafId: String?,
        includePreCompaction: Boolean,
        deferThinking: Boolean,
        deferMedia: Boolean,
    ): String = withContext(Dispatchers.IO) {
        val query = buildList {
            if (leafId != null) add("leafId=${encodeQuery(leafId)}")
            if (includePreCompaction) add("includePreCompaction=1")
            if (deferThinking) add("deferThinking=1")
            if (deferMedia) add("deferMedia=1")
        }.joinToString("&")
        val suffix = if (query.isEmpty()) "" else "?$query"
        requireSuccess(perform(get("api/sessions/${encodePathSegment(sessionId)}/context$suffix")))
    }

    /** `GET .../thinking?blockIndex=` for a deferred thinking block. */
    override suspend fun thinking(sessionId: String, entryId: String, blockIndex: Int): String =
        withContext(Dispatchers.IO) {
            val path = "api/sessions/${encodePathSegment(sessionId)}/entries/${encodePathSegment(entryId)}/thinking" +
                "?blockIndex=$blockIndex"
            val body = requireSuccess(perform(get(path)))
            decode(body) { json.decodeFromString(ThinkingResponse.serializer(), body) }.thinking
        }

    /** `POST /api/agent/{id} {type:"fork", entryId}`. */
    override suspend fun forkSession(sessionId: String, entryId: String): ForkOutcome =
        withContext(Dispatchers.IO) {
            val data = sendAgentCommand(
                sessionId,
                buildJsonObject {
                    put("type", "fork")
                    put("entryId", entryId)
                },
            )
            if (data == null || data is JsonNull) {
                throw ApiError.ServerResponse(200, null, "The session could not be forked")
            }
            val text = data.toString()
            decode(text) { json.decodeFromString(ForkOutcome.serializer(), text) }
        }

    /** `POST /api/agent/{id} {type:"abort"}`. */
    override suspend fun abort(sessionId: String): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject { put("type", "abort") },
    )

    /** `POST /api/agent/{id} {type:"abort_retry"}` — cancel the retry backoff. */
    override suspend fun abortRetry(sessionId: String): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject { put("type", "abort_retry") },
    )

    /** A referenced bash-output file of the current session, if still available. */
    override suspend fun bashOutput(sessionId: String, path: String): BashOutputResult = withContext(Dispatchers.IO) {
        val request = get("api/agent/${encodePathSegment(sessionId)}/bash-output?path=${encodeQuery(path)}")
        val response = perform(request)
        when (response.status) {
            in 200..299 -> {
                val root = decode(response.body) { json.parseToJsonElement(response.body).jsonObject }
                val output = root["data"]?.let { data ->
                    (data as? JsonObject)?.get("output")?.jsonPrimitive?.contentOrNull
                }
                BashOutputResult.Text(output ?: "")
            }
            413 -> {
                val root = try {
                    json.parseToJsonElement(response.body).jsonObject
                } catch (_: Exception) {
                    null
                }
                val data = root?.get("data") as? JsonObject
                BashOutputResult.TooLarge(
                    size = data?.get("size")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
                    maxBytes = data?.get("maxBytes")?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L,
                )
            }
            else -> throw requestError(response)
        }
    }

    /** The same bash output as a text download, for SAF "save full output". */
    override suspend fun bashOutputBytes(sessionId: String, path: String): ByteArray = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(url("api/agent/${encodePathSegment(sessionId)}/bash-output?path=${encodeQuery(path)}&download=1"))
            .header("Accept", "text/plain, */*")
            .get()
            .build()
        val response = try {
            client.newCall(request).execute()
        } catch (error: IOException) {
            throw ApiError.Network(error)
        }
        val origin = request.url.let { ServerAddress(it.scheme, it.host, it.port) }
        response.use {
            if (it.code !in 200..299) throw requestError(RawResponse(it.code, readCappedBody(it), origin))
            readCappedBytes(it, MAX_BASH_OUTPUT_BYTES)
        }
    }

    /** `GET /api/sessions/{id}/subagents/{subagentId}?mode=completion`. */
    override suspend fun subagentCompletion(sessionId: String, subagentId: String): SubagentCompletion =
        withContext(Dispatchers.IO) {
            val path = "api/sessions/${encodePathSegment(sessionId)}/subagents/${encodePathSegment(subagentId)}" +
                "?mode=completion"
            val body = requireSuccess(perform(get(path)))
            decode(body) { json.decodeFromString(SubagentCompletion.serializer(), body) }
        }

    /** `{type:"get_subagents"}` — the live registry roster. */
    override suspend fun subagents(sessionId: String): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject { put("type", "get_subagents") },
    )

    /** `GET /api/sessions/{id}/subagents` — the on-disk roster. */
    override suspend fun subagentHistory(sessionId: String): JsonElement? = withContext(Dispatchers.IO) {
        val path = "api/sessions/${encodePathSegment(sessionId)}/subagents"
        val response = perform(get(path))
        // A 404 means "no on-disk history yet"; the caller treats it as empty.
        if (response.status == 404) return@withContext null
        val body = requireSuccess(response)
        decode(body) { json.parseToJsonElement(body) }
    }

    /** `{type:"get_subagent_messages", …}` — one page from the live registry. */
    override suspend fun subagentTranscript(
        sessionId: String,
        subagentId: String,
        sessionFile: String?,
        fromByte: Long,
    ): JsonElement? = sendAgentCommand(
        sessionId,
        buildJsonObject {
            put("type", "get_subagent_messages")
            put("subagentId", subagentId)
            if (sessionFile != null) put("sessionFile", sessionFile)
            put("fromByte", fromByte)
        },
    )

    /** `GET .../subagents/{id}?fromByte=` — the disk fallback for a page. */
    override suspend fun subagentTranscriptDisk(sessionId: String, subagentId: String, fromByte: Long): JsonElement? =
        withContext(Dispatchers.IO) {
            val path = "api/sessions/${encodePathSegment(sessionId)}/subagents/${encodePathSegment(subagentId)}" +
                "?fromByte=$fromByte"
            val response = perform(get(path))
            if (response.status == 404) return@withContext null
            val body = requireSuccess(response)
            decode(body) { json.parseToJsonElement(body) }
        }

    /** `POST /api/cwd/validate` — a 400 answers with a `{error, code}` the UI localizes. */
    override suspend fun validateCwd(cwd: String): CwdValidation = withContext(Dispatchers.IO) {
        val payload = buildJsonObject { put("cwd", cwd) }
        val response = perform(postJson("api/cwd/validate", payload.toString()))
        if (response.status in 200..299) {
            val root = decode(response.body) { json.parseToJsonElement(response.body).jsonObject }
            CwdValidation.Valid(
                cwd = root["cwd"]?.jsonPrimitive?.contentOrNull ?: cwd,
                projectRoot = root["projectRoot"]?.jsonPrimitive?.contentOrNull,
            )
        } else {
            if (response.status == 401) onUnauthorized(response.origin)
            val parsed = parseErrorBody(response.body)
            CwdValidation.Invalid(parsed.code, parsed.message)
        }
    }

    /**
     * `GET /api/files/{segments}?type=read` — text types answer JSON
     * (`{content, language, size}`), binaries stream their bytes. `FilesApi`
     * is the only caller: the file panel reads every byte through it.
     */
    suspend fun fileRead(segments: List<String>, sessionId: String?): FileReadResult = withContext(Dispatchers.IO) {
        val encoded = segments.joinToString("/") { encodePathSegment(it) }
        val query = if (sessionId.isNullOrBlank()) {
            "api/files/$encoded?type=read"
        } else {
            "api/files/$encoded?type=read&sessionId=${encodePathSegment(sessionId)}"
        }
        val request = Request.Builder()
            .url(url(query))
            .header("Accept", "application/json, */*")
            .get()
            .build()
        val response = try {
            client.newCall(request).execute()
        } catch (error: IOException) {
            throw ApiError.Network(error)
        }
        val origin = request.url.let { ServerAddress(it.scheme, it.host, it.port) }
        response.use {
            if (it.code !in 200..299) throw requestError(RawResponse(it.code, readCappedBody(it), origin))
            val mimeType = it.header("Content-Type").orEmpty()
            val bytes = readCappedBytes(it, MAX_FILE_BYTES)
            if (mimeType.startsWith("application/json")) {
                val text = bytes.toString(Charsets.UTF_8)
                val file = decode(text) { json.decodeFromString(FileText.serializer(), text) }
                FileReadResult.Text(file.content, file.language, file.size)
            } else {
                FileReadResult.Binary(bytes, mimeType.substringBefore(';'))
            }
        }
    }

    // --- Archive browser ----------------------------------------------------

    suspend fun archivedSessions(): ArchiveList = withContext(Dispatchers.IO) {
        val body = requireSuccess(perform(get("api/sessions/archive")))
        decode(body) { json.decodeFromString(ArchiveList.serializer(), body) }
    }

    suspend fun restoreArchive(key: String): RestoreArchiveResponse = withContext(Dispatchers.IO) {
        val payload = buildJsonObject { put("key", key) }
        val response = perform(postJson("api/sessions/archive", payload.toString()))
        if (response.status !in 200..299) throw requestError(response)
        decode(response.body) { json.decodeFromString(RestoreArchiveResponse.serializer(), response.body) }
    }

    // --- Directories, worktrees, models -------------------------------------

    /**
     * `GET /api/cwd/browse?path=…`. A rejected path answers `{error, code}`
     * (404 `directory_not_found`, 400 `not_a_directory`); [requestError] keeps
     * that wording, so the picker shows the server's sentence instead of a
     * bare "HTTP 404" (the web picker shows the same text).
     */
    suspend fun browseDirectory(path: String?): BrowseResponse = withContext(Dispatchers.IO) {
        val suffix = if (path.isNullOrBlank()) "" else "?path=${encodeQuery(path)}"
        val response = perform(get("api/cwd/browse$suffix"))
        if (response.status !in 200..299) throw requestError(response)
        decode(response.body) { json.decodeFromString(BrowseResponse.serializer(), response.body) }
    }

    suspend fun defaultCwd(): String = withContext(Dispatchers.IO) {
        val response = perform(postJson("api/default-cwd", "{}"))
        if (response.status !in 200..299) throw requestError(response)
        decode(response.body) { json.decodeFromString(DefaultCwd.serializer(), response.body) }.cwd
    }

    suspend fun homeDirectory(): String = withContext(Dispatchers.IO) {
        val body = requireSuccess(perform(get("api/home")))
        decode(body) { json.decodeFromString(HomeDirectory.serializer(), body) }.home
    }

    suspend fun worktrees(cwd: String): WorktreeList = withContext(Dispatchers.IO) {
        val body = requireSuccess(perform(get("api/worktrees?cwd=${encodeQuery(cwd)}")))
        decode(body) { json.decodeFromString(WorktreeList.serializer(), body) }
    }

    override suspend fun models(cwd: String?): ModelsResponse = withContext(Dispatchers.IO) {
        val suffix = if (cwd.isNullOrBlank()) "" else "?cwd=${encodeQuery(cwd)}"
        val body = requireSuccess(perform(get("api/models$suffix")))
        decode(body) { json.decodeFromString(ModelsResponse.serializer(), body) }
    }

    // --- Clone --------------------------------------------------------------

    /**
     * `POST /api/projects/clone {id,parent,url}` streams NDJSON frames
     * (`output`, then exactly one of `done`/`cancelled`/`error`). The caller
     * owns [onOutput] and receives the terminal frame. Cancelling the calling
     * coroutine drops the stream, which makes the server cancel and clean up.
     */
    suspend fun cloneRepo(
        id: String,
        parent: String,
        url: String,
        onOpened: () -> Unit = {},
        onCall: (Call) -> Unit = {},
        onOutput: (String) -> Unit,
    ): CloneFrame {
        val payload = buildJsonObject {
            put("id", id)
            put("parent", parent)
            put("url", url)
        }
        val request = postJson("api/projects/clone", payload.toString())
        val call = client.newCall(request)
        // The caller can close the blocking read directly; waiting for the
        // coroutine job would keep a cancelled clone alive until the server
        // ends the stream.
        onCall(call)
        // OkHttp's read cannot be interrupted, so the stream runs on a plain
        // thread and cancellation closes the call instead of awaiting a
        // server-side end that may never come.
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            cloneExecutor.execute {
                val result = runCatching { readCloneStream(call, request, onOpened, onOutput) }
                if (continuation.isActive) {
                    val mapped: Result<CloneFrame> = result.fold(
                        onSuccess = { Result.success(it) },
                        onFailure = { error -> Result.failure(error.toCloneError()) },
                    )
                    continuation.resumeWith(mapped)
                }
            }
        }
    }

    private fun readCloneStream(
        call: Call,
        request: Request,
        onOpened: () -> Unit,
        onOutput: (String) -> Unit,
    ): CloneFrame {
        val response = try {
            call.execute()
        } catch (error: IOException) {
            throw ApiError.Network(error)
        }
        val origin = request.url.let { ServerAddress(it.scheme, it.host, it.port) }
        response.use {
            if (it.code !in 200..299) throw requestError(RawResponse(it.code, readCappedBody(it), origin))
            onOpened()
            val source = it.body.source()
            var streamedChars = 0L
            while (true) {
                val line = try {
                    // A hostile or broken server can stream one endless
                    // line; the strict read refuses to buffer it.
                    source.readUtf8LineStrict(MAX_CLONE_LINE_BYTES)
                } catch (_: EOFException) {
                    // `exhausted()` is true only for a regular stream end:
                    // a line over the cap leaves bytes buffered.
                    if (source.exhausted()) break
                    call.cancel()
                    return CloneFrame.Error(
                        "The clone output exceeded the display limit.",
                        "clone_output_too_large",
                    )
                } catch (error: IOException) {
                    throw ApiError.Network(error)
                }
                streamedChars += line.length
                if (streamedChars > MAX_CLONE_STREAM_CHARS) {
                    call.cancel()
                    return CloneFrame.Error(
                        "The clone output exceeded the display limit.",
                        "clone_output_too_large",
                    )
                }
                if (line.isBlank()) continue
                val frame = parseCloneFrame(line) ?: continue
                if (frame is CloneFrame.Output) {
                    onOutput(frame.text)
                } else {
                    return frame
                }
            }
            return CloneFrame.Error("The clone stream ended without a result", "clone_interrupted")
        }
    }

    private fun Throwable.toCloneError(): ApiError = when (this) {
        is ApiError -> this
        is IOException -> ApiError.Network(this)
        else -> ApiError.Network(IOException(this))
    }

    /**
     * `DELETE /api/projects/clone {id}`. `false` (404) means the server has
     * not registered the clone; every other failure is thrown so the caller
     * can drop the stream like the web does on a rejected fetch.
     */
    suspend fun cancelClone(id: String): Boolean = withContext(Dispatchers.IO) {
        val payload = buildJsonObject { put("id", id) }
        val response = perform(postJson("api/projects/clone", payload.toString(), method = "DELETE"))
        when {
            response.status == 404 -> false
            response.status !in 200..299 -> throw requestError(response)
            else -> true
        }
    }

    private fun parseCloneFrame(line: String): CloneFrame? = try {
        val root = json.parseToJsonElement(line).jsonObject
        when (root["type"]?.jsonPrimitive?.contentOrNull) {
            "output" -> CloneFrame.Output(root["text"]?.jsonPrimitive?.contentOrNull ?: "")
            "done" -> CloneFrame.Done(root["path"]?.jsonPrimitive?.contentOrNull ?: "")
            "cancelled" -> CloneFrame.Cancelled(root["path"]?.jsonPrimitive?.contentOrNull ?: "")
            "error" -> CloneFrame.Error(
                root["error"]?.jsonPrimitive?.contentOrNull ?: "Clone failed",
                root["code"]?.jsonPrimitive?.contentOrNull,
            )
            else -> null
        }
    } catch (_: Exception) {
        null
    }

    private fun ProjectLaunchConfig.toJson(): JsonObject = buildJsonObject {
        profile?.takeIf { it.isNotBlank() }?.let { put("profile", it) }
        if (advisor == true) put("advisor", true)
        if (!extraArgs.isNullOrEmpty()) put("extraArgs", buildJsonArray { extraArgs.forEach { add(JsonPrimitive(it)) } })
    }

    suspend fun login(password: String): LoginOutcome = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(LoginRequest.serializer(), LoginRequest(password))
        val response = perform(postJson("api/web-auth/session", payload))
        when (response.status) {
            401 -> LoginOutcome.WrongPassword
            404 -> LoginOutcome.PasswordDisabled
            413 -> LoginOutcome.TooLarge
            in 200..299 -> LoginOutcome.Success
            else -> throw errorFor(response.status, response.body, response.origin)
        }
    }

    suspend fun postEvent(payload: JsonObject): EventPostResult = withContext(Dispatchers.IO) {
        val response = perform(postJson("api/events", payload.toString()))
        when (response.status) {
            in 200..299 -> EventPostResult.Ok
            // Only an unknown connection means "reconnect"; a 404 with any
            // other code is the channel's own failure (for example
            // `file_not_found`) and must not reconnect forever.
            404 -> {
                val error = parseErrorBody(response.body)
                if (error.code == UNKNOWN_CONNECTION) {
                    EventPostResult.ConnectionUnknown
                } else {
                    EventPostResult.Rejected(response.status, error.code, error.message)
                }
            }
            // The protocol treats 400/403/409 as a fatal subscription error.
            400, 403, 409 -> {
                val error = parseErrorBody(response.body)
                EventPostResult.Rejected(response.status, error.code, error.message)
            }
            else -> throw errorFor(response.status, response.body, response.origin)
        }
    }

    /**
     * Opens the multiplexed SSE stream. The caller owns the [Call] and must
     * cancel it to close the connection; the response is read incrementally.
     *
     * `GET /api/events?heartbeat=<seconds>`: the body is idle between two
     * heartbeats, so the shared 60 s read timeout would fire long before the
     * app's default 110 s heartbeat and drop a healthy stream. This call
     * therefore uses a derived client (same pool, dispatcher, cookie jar and
     * interceptors) whose idle timeout is the heartbeat plus
     * [STREAM_READ_TIMEOUT_SLACK_SECONDS] (110 s + 30 s = 140 s by default);
     * [heartbeatSeconds] is the server's 15–110 s range.
     */
    fun openEventStream(heartbeatSeconds: Int): Call {
        val target = url("api/events")
            .newBuilder()
            .addQueryParameter("heartbeat", heartbeatSeconds.toString())
            .build()
        val request = Request.Builder()
            .url(target)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .get()
            .build()
        return eventStreamClient(heartbeatSeconds).newCall(request)
    }

    /** One derived client per requested heartbeat; built once, then reused. */
    private fun eventStreamClient(heartbeatSeconds: Int): OkHttpClient =
        eventStreamClients.getOrPut(heartbeatSeconds) {
            client.newBuilder()
                .readTimeout(heartbeatSeconds.toLong() + STREAM_READ_TIMEOUT_SLACK_SECONDS, TimeUnit.SECONDS)
                .build()
        }

    /** A request builder bound to the configured origin (same URL and cookie rules as every call). */
    fun requestBuilder(path: String, accept: String = "application/json"): Request.Builder =
        Request.Builder().url(url(path)).header("Accept", accept)

    /**
     * Executes [request]; an IOException becomes [ApiError.Network] and the
     * body is capped like every other route, so callers never see a raw
     * response or an unbounded read.
     */
    suspend fun exchange(request: Request, limit: Long = MAX_BODY_BYTES): RawExchange = withContext(Dispatchers.IO) {
        val response = try {
            client.newCall(request).execute()
        } catch (error: IOException) {
            throw ApiError.Network(error)
        }
        response.use { RawExchange(it.code, readCappedBytes(it, limit), it.header("Content-Type")) }
    }

    /**
     * Opens [request] for an incremental read (SSE/NDJSON). The caller owns the
     * [Call] and cancels it to stop; unlike [exchange] nothing is buffered, so
     * a long-lived stream stays readable. Used by the OAuth login stream, whose
     * blocking read must be interruptible from the calling coroutine.
     */
    fun openStream(request: Request): Call = client.newCall(request)

    /**
     * Maps a non-2xx status the same way every call does; [origin] is the
     * origin of the request that failed, so a late 401 from a server the user
     * already left cannot sign out the new one.
     */
    fun errorFor(status: Int, body: String, origin: ServerAddress): ApiError {
        when (status) {
            401 -> {
                onUnauthorized(origin)
                return ApiError.Unauthorized(body)
            }
            403 -> return ApiError.Forbidden(body)
        }
        // A busy omp answers `session_slow` (503 on the polls, 400 on
        // `POST /api/agent`); upstream's `get_state` timeout answers
        // `session_state_timeout` — 400 on the agent route, 500 on the state
        // route. The session keeps running in every case, so the code decides,
        // not the status: neither may surface as a server setup problem or a
        // plain HTTP error.
        val parsed = parseErrorBody(body)
        if (isSessionSlowCode(parsed.code)) {
            return ApiError.SessionSlow(parsed.message, parsed.maybeStarted, parsed.abortUnconfirmed, parsed.running)
        }
        if (status == 503) return ApiError.ServerMisconfigured(body)
        return ApiError.Http(status, body)
    }

    private fun get(path: String): Request = Request.Builder()
        .url(url(path))
        .header("Accept", "application/json")
        .get()
        .build()

    private fun postJson(path: String, payload: String, method: String = "POST"): Request {
        val builder = Request.Builder()
            .url(url(path))
            .header("Accept", "application/json")
        val body = payload.toRequestBody(JSON_MEDIA_TYPE)
        return when (method) {
            "DELETE" -> builder.delete(body).build()
            "PATCH" -> builder.patch(body).build()
            else -> builder.post(body).build()
        }
    }

    /**
     * Non-2xx handling for the routes that answer with `{error, code}` JSON:
     * auth failures keep their global meaning, everything else becomes a
     * [ApiError.ServerResponse] the UI can localize.
     */
    private fun requestError(response: RawResponse): ApiError {
        when (response.status) {
            401 -> onUnauthorized(response.origin)
            403 -> return ApiError.Forbidden(response.body)
        }
        val parsed = parseErrorBody(response.body)
        // `session_slow` is "busy, retry later" on every route, not just the
        // 503 polls: POST /api/agent answers 400 with the same code when a
        // prompt ack times out, and `maybeStarted` says the message may already
        // be running; `abortUnconfirmed` says an abort was not confirmed.
        // `session_state_timeout` (upstream's `get_state` timeout) carries the
        // same meaning, so it must not surface as a hard error either.
        if (isSessionSlowCode(parsed.code)) {
            return ApiError.SessionSlow(parsed.message, parsed.maybeStarted, parsed.abortUnconfirmed, parsed.running)
        }
        // The foreign-owner gate: the session is not broken, it just belongs to
        // another omp process. The chat needs the owner report for its banner.
        if (parsed.code == SESSION_RUNNING_ELSEWHERE) return ApiError.SessionRunningElsewhere(parsed.elsewhere)
        if (response.status == 503) return ApiError.ServerMisconfigured(response.body)
        return ApiError.ServerResponse(response.status, parsed.code, parsed.message)
    }

    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun fileNameFromContentDisposition(header: String?): String? {
        if (header == null) return null
        val match = Regex("""filename\s*=\s*"?([^";]+)"?""").find(header) ?: return null
        val raw = match.groupValues[1].substringAfterLast('/').substringAfterLast('\\').trim()
        return raw.takeIf { it.isNotEmpty() }
    }

    private fun url(path: String): okhttp3.HttpUrl {
        val address = origin() ?: throw ApiError.NotConfigured
        return address.apiUrl(path).toHttpUrl()
    }

    /**
     * A 2xx body that does not match the documented shape (a stale server, a
     * proxy error page) is an [ApiError.Http], so callers never see a raw
     * serialization exception and the UI can show "server answered with an error".
     */
    private inline fun <T> decode(body: String, block: () -> T): T = try {
        block()
    } catch (error: SerializationException) {
        throw ApiError.Http(200, body.take(2048))
    }

    private fun requireSuccess(response: RawResponse): String {
        if (response.status in 200..299) return response.body
        throw errorFor(response.status, response.body, response.origin)
    }

    private fun perform(request: Request): RawResponse = execute(client.newCall(request), request)

    /**
     * [perform] for a call the waiting coroutine must be able to give up on.
     * OkHttp's blocking `execute()` ignores coroutine cancellation, so the
     * cancellation closes the call; `withTimeout`/`cancel()` then release the
     * caller at once instead of at the next socket timeout. [http] carries
     * the per-call bound (`callTimeout`).
     */
    private suspend fun performCancellable(http: OkHttpClient, request: Request): RawResponse =
        suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            val outcome = runCatching { execute(call, request) }
            // A cancelled continuation ignores the result; the call is closed
            // by the hook above and `execute` returns right away.
            if (continuation.isActive) continuation.resumeWith(outcome)
        }

    /** One bounded request→response round trip; an IOException becomes [ApiError.Network]. */
    private fun execute(call: Call, request: Request): RawResponse {
        val response = try {
            call.execute()
        } catch (error: IOException) {
            throw ApiError.Network(error)
        }
        val origin = request.url.let { ServerAddress(it.scheme, it.host, it.port) }
        response.use {
            return RawResponse(it.code, readCappedBody(it), origin, it.header("ETag"))
        }
    }

    private fun readCappedBody(response: Response): String = readCappedBytes(response, MAX_BODY_BYTES).toString(Charsets.UTF_8)

    /**
     * Reads a response body with a hard ceiling. A connection that breaks
     * after the headers becomes an [ApiError.Network] instead of an
     * IOException escaping into a view-model coroutine. `internal` so the
     * auth stream and native settings API cap their own response reads the
     * same way (chunked bodies have no `Content-Length` to check).
     */
    internal fun readCappedBytes(response: Response, limit: Long): ByteArray {
        val body = response.body
        if (body.contentLength() > limit) {
            throw ApiError.Http(response.code, "The response body exceeded $limit bytes.")
        }
        val stream = body.byteStream()
        val buffer = ByteArray(16 * 1024)
        val output = java.io.ByteArrayOutputStream()
        var total = 0L
        while (true) {
            val read = try {
                stream.read(buffer)
            } catch (error: IOException) {
                throw ApiError.Network(error)
            }
            if (read == -1) break
            total += read
            if (total > limit) {
                throw ApiError.Http(response.code, "The response body exceeded $limit bytes.")
            }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private data class RawResponse(
        val status: Int,
        val body: String,
        val origin: ServerAddress,
        /** The `ETag` of this answer; the session list revalidates with it. */
        val etag: String? = null,
    )

    private data class ErrorBody(
        val code: String?,
        val message: String,
        val maybeStarted: Boolean,
        val abortUnconfirmed: Boolean,
        /** The owner report of a `session_running_elsewhere` answer. */
        val elsewhere: ElsewhereSession? = null,
        /** The server's run state on a `session_slow` answer (`null` = unreported). */
        val running: Boolean? = null,
    )

    private fun parseErrorBody(body: String): ErrorBody = try {
        val root = json.parseToJsonElement(body).jsonObject
        ErrorBody(
            code = root["code"]?.jsonPrimitive?.contentOrNull,
            message = root["error"]?.jsonPrimitive?.contentOrNull ?: body,
            maybeStarted = root["maybeStarted"]?.jsonPrimitive?.booleanOrNull == true,
            abortUnconfirmed = root["abortUnconfirmed"]?.jsonPrimitive?.booleanOrNull == true,
            elsewhere = elsewhereFrom(root["elsewhere"]),
            running = root["running"]?.jsonPrimitive?.booleanOrNull,
        )
    } catch (_: Exception) {
        ErrorBody(code = null, message = body, maybeStarted = false, abortUnconfirmed = false)
    }

    private fun imagesJson(images: List<ComposerImage>): JsonArray = buildJsonArray {
        images.forEach { image ->
            add(
                buildJsonObject {
                    put("type", "image")
                    put("data", image.data)
                    put("mimeType", image.mimeType)
                },
            )
        }
    }

    private fun queuedEntries(element: JsonElement?): List<QueuedMessagePayload> {
        val array = element as? JsonArray ?: return emptyList()
        return array.mapNotNull { item ->
            val entry = item as? JsonObject ?: return@mapNotNull null
            val text = (entry["text"] as? JsonPrimitive)?.contentOrNull.orEmpty()
            val images = imagesFromRpc(entry["images"])
            if (text.isEmpty() && images.isEmpty()) null else QueuedMessagePayload(text, images)
        }
    }

    @Serializable
    private data class LoginRequest(val password: String)

    internal companion object {
        internal const val MAX_BODY_BYTES = 8L * 1024 * 1024

        /**
         * How long a finished `GET /api/sessions/{id}` answer is shared with a
         * second caller (the header load and the chat's metadata load never
         * overlap exactly). Deliberately short: this shares one request burst,
         * it is not a transcript cache.
         */
        internal const val DETAIL_SHARE_WINDOW_MILLIS = 2_000L
        const val MAX_EXPORT_BYTES = 32L * 1024 * 1024
        const val MAX_FILE_BYTES = 16L * 1024 * 1024
        const val MAX_BASH_OUTPUT_BYTES = 8L * 1024 * 1024
        const val MAX_CLONE_LINE_BYTES = 256L * 1024
        const val MAX_CLONE_STREAM_CHARS = 8L * 1024 * 1024

        /**
         * Read-timeout slack over the SSE heartbeat: a heartbeat that arrives
         * on time must never race the idle timeout. 110 s heartbeat → 140 s.
         */
        const val STREAM_READ_TIMEOUT_SLACK_SECONDS = 30

        /**
         * Hard per-call bound of the live-state read (`GET /api/agent/{id}`).
         * It is the chat's submit bound: no answer within this window means
         * "unknown state", and the draft stays in the composer.
         */
        internal const val LIVE_STATE_READ_TIMEOUT_MILLIS = 10_000L
        const val UNKNOWN_CONNECTION = "unknown_connection"
        /** 503 code for "omp is busy, the session keeps running". */
        const val SESSION_SLOW = "session_slow"

        /**
         * The `get_state` timeout of servers before the rename: same meaning
         * as [SESSION_SLOW] (the child is kept, ask again later), so it is
         * mapped to the same [ApiError.SessionSlow]. Servers from the rebase
         * normalize it to `session_slow`; this stays for older answers and
         * for the route paths that still use it.
         */
        const val SESSION_STATE_TIMEOUT = "session_state_timeout"

        /** Both codes mean "omp did not answer in time; the session keeps running". */
        internal fun isSessionSlowCode(code: String?): Boolean =
            code == SESSION_SLOW || code == SESSION_STATE_TIMEOUT

        /** 409 code for "another omp process owns this session". */
        const val SESSION_RUNNING_ELSEWHERE = "session_running_elsewhere"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
