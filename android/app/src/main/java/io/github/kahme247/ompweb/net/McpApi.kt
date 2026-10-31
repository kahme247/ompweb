package io.github.kahme247.ompweb.net

import java.net.URLEncoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** One project-level MCP server as `GET /api/mcp` returns it (secrets redacted). */
data class McpServerEntry(val name: String, val config: JsonObject)

/** A user-level server; only the fields the UI renders are sent (`safeUser`). */
data class McpUserServer(
    val name: String,
    val status: String,
    val type: String,
    val enabled: Boolean,
    val valid: Boolean,
)

/** The user-level `~/.omp/mcp.json` summary, never its raw configs. */
data class McpUserConfig(
    val path: String,
    val servers: List<McpUserServer>,
    val disabledServers: List<String>,
    val error: String?,
)

/** An entry of the merged inventory / live list. */
data class McpLiveServer(val name: String, val source: String, val status: String, val type: String?)

/** `GET /api/mcp` answer. [liveServers] is absent unless a session was given. */
data class McpSnapshot(
    val servers: List<McpServerEntry>,
    val user: McpUserConfig?,
    val inventory: List<McpLiveServer>,
    val liveServers: List<McpLiveServer>?,
    val liveError: String?,
    val path: String?,
)

/**
 * `/api/mcp` (`app/api/mcp/route.ts`): project MCP servers, the user-level
 * summary, the disabled list and the live omp view.
 */
interface McpApi {

    /**
     * [cwd] null lists only the user-level/discovered servers (the web route
     * allows it). [sessionId] asks for omp's live view; [live] false skips the
     * child-process call entirely (`?live=0`).
     */
    suspend fun load(cwd: String?, sessionId: String? = null, live: Boolean = true, advisor: Boolean = false): McpSnapshot

    /** `PUT` — validation only; returns the server's message ("… is valid"). */
    suspend fun validate(name: String, server: JsonObject): String

    /** `POST` — create or update (rename when [previousName] differs). */
    suspend fun save(cwd: String, name: String, previousName: String?, server: JsonObject)

    /** `DELETE` — remove one project server. */
    suspend fun remove(cwd: String, name: String)
}

/** Production [McpApi] over the app's authenticated client. */
class HttpMcpApi(private val api: ApiClient) : McpApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun load(cwd: String?, sessionId: String?, live: Boolean, advisor: Boolean): McpSnapshot {
        val params = buildList {
            if (cwd != null) add("cwd=${encode(cwd)}")
            if (sessionId != null) add("sessionId=${encode(sessionId)}")
            add("live=${if (live) 1 else 0}")
            if (advisor) add("advisor=1")
        }
        val request = api.requestBuilder("api/mcp?${params.joinToString("&")}").get().build()
        val body = send(request)
        val root = parseObject(body)
        return McpSnapshot(
            servers = (root["servers"] as? JsonArray).orEmpty().mapNotNull { element ->
                val entry = element as? JsonObject ?: return@mapNotNull null
                val name = string(entry["name"]) ?: return@mapNotNull null
                McpServerEntry(name, entry["config"] as? JsonObject ?: JsonObject(emptyMap()))
            },
            user = (root["user"] as? JsonObject)?.let { user ->
                McpUserConfig(
                    path = string(user["path"]).orEmpty(),
                    servers = (user["servers"] as? JsonArray).orEmpty().mapNotNull { element ->
                        val entry = element as? JsonObject ?: return@mapNotNull null
                        val name = string(entry["name"]) ?: return@mapNotNull null
                        McpUserServer(
                            name = name,
                            status = string(entry["status"]) ?: "configured",
                            type = string(entry["type"]) ?: "stdio",
                            enabled = boolean(entry["enabled"]) ?: true,
                            valid = boolean(entry["valid"]) ?: false,
                        )
                    },
                    disabledServers = (user["disabledServers"] as? JsonArray).orEmpty()
                        .mapNotNull { string(it) },
                    error = string(user["error"]),
                )
            },
            inventory = liveList(root["inventory"]),
            liveServers = (root["liveServers"] as? JsonArray)?.let { liveList(it) },
            liveError = string(root["liveError"]),
            path = string(root["path"]),
        )
    }

    override suspend fun validate(name: String, server: JsonObject): String {
        val payload = buildJsonObject {
            put("name", name)
            put("server", server)
        }.toString()
        val request = api.requestBuilder(MCP_PATH).put(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        val root = parseObject(send(request))
        return string(root["message"]) ?: "MCP server configuration is valid"
    }

    override suspend fun save(cwd: String, name: String, previousName: String?, server: JsonObject) {
        val payload = buildJsonObject {
            put("cwd", cwd)
            put("name", name)
            if (previousName != null) put("previousName", previousName)
            put("server", server)
        }.toString()
        val request = api.requestBuilder(MCP_PATH).post(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        send(request)
    }

    override suspend fun remove(cwd: String, name: String) {
        val payload = buildJsonObject {
            put("cwd", cwd)
            put("name", name)
        }.toString()
        val request = api.requestBuilder(MCP_PATH).delete(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        send(request)
    }

    private suspend fun send(request: okhttp3.Request): String {
        val response = api.exchange(request)
        val text = response.text()
        if (response.status !in 200..299) {
            throw api.errorFor(response.status, text, originOf(request))
        }
        return text
    }

    private fun parseObject(body: String): JsonObject = try {
        json.parseToJsonElement(body).jsonObject
    } catch (_: Exception) {
        throw ApiError.Http(200, body.take(2048))
    }

    private fun liveList(element: kotlinx.serialization.json.JsonElement?): List<McpLiveServer> =
        (element as? JsonArray).orEmpty().mapNotNull { item ->
            val entry = item as? JsonObject ?: return@mapNotNull null
            val name = string(entry["name"]) ?: return@mapNotNull null
            McpLiveServer(
                name = name,
                source = string(entry["source"]) ?: "",
                status = string(entry["status"]) ?: "configured",
                type = string(entry["type"]),
            )
        }

    private fun string(element: kotlinx.serialization.json.JsonElement?): String? =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun boolean(element: kotlinx.serialization.json.JsonElement?): Boolean? =
        (element as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

    private fun originOf(request: okhttp3.Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private companion object {
        const val MCP_PATH = "api/mcp"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
