package io.github.kahme247.ompweb.net

import java.net.URLEncoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Agent roster routes (`app/api/agents`), as an interface so `AgentsViewModel`
 * is JVM-testable. A 403 means the workspace is not allowed for file access —
 * a normal answer the UI turns into a warning, never a crash.
 */
interface AgentsApi {

    /** `GET /api/agents?cwd=` — every agent omp finds, plus scan diagnostics. */
    suspend fun list(cwd: String?): AgentsDocument

    /** `POST` (create) or `PUT` (update) `/api/agents` with the full agent payload. */
    suspend fun save(
        cwd: String?,
        scope: String,
        name: String,
        previousName: String?,
        agent: JsonObject,
        update: Boolean,
    ): AgentSaveResult

    /** `DELETE /api/agents {cwd?, scope, name}`. */
    suspend fun delete(cwd: String?, scope: String, name: String)

    /** `POST /api/agents {action:"unpack", cwd?, scope}` — copy omp's bundled templates in. */
    suspend fun unpack(cwd: String?, scope: String): AgentUnpackResult
}

/** One discovered agent file. Mirrors `AgentInfo` of `lib/omp/agents-service.ts`. */
data class AgentInfo(
    val name: String,
    val description: String = "",
    /** `provider/model` role selectors (`@designer`, `@smol`) when set. */
    val model: List<String> = emptyList(),
    val tools: List<String> = emptyList(),
    /** `spawns: "*"` lists no names and sets [spawnsAll]. */
    val spawns: List<String> = emptyList(),
    val spawnsAll: Boolean = false,
    val thinkingLevel: String? = null,
    /** `bundled`, `user` or `project`. */
    val source: String = "user",
    /** `bundled`/`user`/`project`; used as the write scope for user/project. */
    val scope: String = "user",
    val filePath: String = "",
    val valid: Boolean = true,
    val enabled: Boolean = true,
    val body: String? = null,
    /** The untouched frontmatter, sent back as `existingFrontmatter` so unknown keys survive. */
    val rawFrontmatter: JsonObject? = null,
) {
    val isBundled: Boolean get() = scope == "bundled" || source == "bundled"
}

data class AgentDiagnostic(
    val type: String = "warning",
    val message: String = "",
    val path: String? = null,
)

data class AgentsDocument(
    val agents: List<AgentInfo> = emptyList(),
    val diagnostics: List<AgentDiagnostic> = emptyList(),
)

data class AgentSaveResult(
    val agent: AgentInfo? = null,
    val path: String? = null,
)

data class AgentUnpackResult(
    val total: Int = 0,
    val written: Int = 0,
    val skipped: Int = 0,
)

/** Production [AgentsApi] over the app's single authenticated client. */
fun ApiClient.agentsApi(): AgentsApi = HttpAgentsApi(this)

private val agentsJson = Json { ignoreUnknownKeys = true; explicitNulls = false }
private val AGENTS_JSON_MEDIA = "application/json".toMediaType()

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.int(key: String): Int? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()

private fun JsonObject.strings(key: String): List<String>? {
    val array = this[key] as? JsonArray ?: return null
    return array.mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.contentOrNull }
}

private fun parseAgentsObject(text: String): JsonObject? = try {
    agentsJson.parseToJsonElement(text) as? JsonObject
} catch (_: Exception) {
    null
}

private fun parseAgent(element: JsonElement): AgentInfo? {
    val root = element as? JsonObject ?: return null
    val name = root.string("name")?.takeIf { it.isNotBlank() } ?: return null
    val spawnsRaw = root["spawns"]
    val spawnsAll = (spawnsRaw as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull == "*"
    return AgentInfo(
        name = name,
        description = root.string("description").orEmpty(),
        model = root.strings("model").orEmpty(),
        tools = root.strings("tools").orEmpty(),
        spawns = if (spawnsAll) emptyList() else root.strings("spawns").orEmpty(),
        spawnsAll = spawnsAll,
        thinkingLevel = root.string("thinkingLevel")?.takeIf { it.isNotBlank() },
        source = root.string("source") ?: "user",
        scope = root.string("scope") ?: "user",
        filePath = root.string("filePath").orEmpty(),
        valid = (root["valid"] as? JsonPrimitive)?.contentOrNull != "false",
        enabled = (root["enabled"] as? JsonPrimitive)?.contentOrNull != "false",
        body = root.string("body"),
        rawFrontmatter = root["rawFrontmatter"] as? JsonObject,
    )
}

private class HttpAgentsApi(private val api: ApiClient) : AgentsApi {

    override suspend fun list(cwd: String?): AgentsDocument {
        val suffix = if (cwd.isNullOrBlank()) "" else "?cwd=${encodeQuery(cwd)}"
        val root = call(api.requestBuilder("$AGENTS_PATH$suffix").get().build())
        return AgentsDocument(
            agents = (root["agents"] as? JsonArray).orEmpty().mapNotNull { parseAgent(it) },
            diagnostics = (root["diagnostics"] as? JsonArray).orEmpty().mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                AgentDiagnostic(
                    type = item.string("type") ?: "warning",
                    message = item.string("message").orEmpty(),
                    path = item.string("path"),
                )
            },
        )
    }

    override suspend fun save(
        cwd: String?,
        scope: String,
        name: String,
        previousName: String?,
        agent: JsonObject,
        update: Boolean,
    ): AgentSaveResult {
        val payload = buildJsonObject {
            if (!cwd.isNullOrBlank()) put("cwd", cwd)
            put("scope", scope)
            put("name", name)
            if (!previousName.isNullOrBlank()) put("previousName", previousName)
            put("agent", agent)
        }
        val request = jsonRequest(AGENTS_PATH, if (update) "PUT" else "POST", payload.toString())
        val root = call(request)
        return AgentSaveResult(
            agent = root["agent"]?.let { parseAgent(it) },
            path = root.string("path"),
        )
    }

    override suspend fun delete(cwd: String?, scope: String, name: String) {
        val payload = buildJsonObject {
            if (!cwd.isNullOrBlank()) put("cwd", cwd)
            put("scope", scope)
            put("name", name)
        }
        call(jsonRequest(AGENTS_PATH, "DELETE", payload.toString()))
    }

    override suspend fun unpack(cwd: String?, scope: String): AgentUnpackResult {
        val payload = buildJsonObject {
            put("action", "unpack")
            if (!cwd.isNullOrBlank()) put("cwd", cwd)
            put("scope", scope)
        }
        val root = call(jsonRequest(AGENTS_PATH, "POST", payload.toString()))
        return AgentUnpackResult(
            total = root.int("total") ?: 0,
            written = root.int("written") ?: 0,
            skipped = root.int("skipped") ?: 0,
        )
    }

    // --- transport ---------------------------------------------------------

    private suspend fun call(request: Request): JsonObject {
        val response = api.exchange(request)
        val text = response.text()
        if (response.status !in 200..299) {
            throw api.errorFor(
                response.status,
                text,
                ServerAddress(request.url.scheme, request.url.host, request.url.port),
            )
        }
        return parseAgentsObject(text) ?: throw ApiError.Http(response.status, text.take(2048))
    }

    private fun jsonRequest(path: String, method: String, payload: String): Request {
        val body = payload.toRequestBody(AGENTS_JSON_MEDIA)
        val builder = api.requestBuilder(path)
        return when (method) {
            "PUT" -> builder.put(body).build()
            "DELETE" -> builder.delete(body).build()
            else -> builder.post(body).build()
        }
    }

    private companion object {
        const val AGENTS_PATH = "api/agents"
    }
}

private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")
