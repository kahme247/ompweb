package io.github.kahme247.ompweb.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** Resource counts of one plugin or of the whole plugin set. */
data class PluginResourceCounts(
    val extensions: Int = 0,
    val skills: Int = 0,
    val prompts: Int = 0,
    val themes: Int = 0,
) {
    val total: Int get() = extensions + skills + prompts + themes
}

/** One file a plugin contributes. */
data class PluginResourceInfo(val kind: String, val name: String, val path: String, val relativePath: String)

/** A plugin warning/error line. */
data class PluginDiagnostic(val type: String, val message: String, val source: String?, val path: String?)

/** One installed/configured plugin (`PluginPackageInfo`). */
data class PluginPackageInfo(
    val source: String,
    val scope: String,
    val filtered: Boolean,
    val disabled: Boolean,
    val installedPath: String?,
    val packageName: String?,
    val version: String?,
    val configuredVersion: String?,
    val counts: PluginResourceCounts,
    val resources: List<PluginResourceInfo>,
    val status: String,
)

/** `GET /api/plugins` and every action's refreshed answer. */
data class PluginsSnapshot(
    val packages: List<PluginPackageInfo>,
    val totals: PluginResourceCounts,
    val diagnostics: List<PluginDiagnostic>,
)

/** `POST /api/plugins` actions. */
enum class PluginAction(val wire: String) { INSTALL("install"), REMOVE("remove"), UPDATE("update"), DISABLE("disable"), ENABLE("enable") }

/**
 * `/api/plugins` (`app/api/plugins/route.ts`): plugin management delegated to
 * the user's omp binary. Every action answers the refreshed full list.
 */
interface PluginsApi {

    suspend fun load(cwd: String): PluginsSnapshot

    /** `scope` is `global` or `project`; [source] is required by omp for most actions. */
    suspend fun action(action: PluginAction, source: String?, scope: String, cwd: String): PluginsSnapshot

    /** Reload the open session so its omp process picks up plugin changes. */
    suspend fun reload(sessionId: String)
}

/** Production [PluginsApi]; reload reuses the chat transport's `POST /api/agent/{id}/reload`. */
class HttpPluginsApi(private val api: ApiClient) : PluginsApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun load(cwd: String): PluginsSnapshot {
        val request = api.requestBuilder("$PLUGINS_PATH?cwd=${java.net.URLEncoder.encode(cwd, "UTF-8")}").get().build()
        return parse(send(request))
    }

    override suspend fun action(action: PluginAction, source: String?, scope: String, cwd: String): PluginsSnapshot {
        val payload = buildJsonObject {
            put("action", action.wire)
            if (source != null) put("source", source)
            put("scope", scope)
            put("cwd", cwd)
        }.toString()
        val request = api.requestBuilder(PLUGINS_PATH).post(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        return parse(send(request))
    }

    override suspend fun reload(sessionId: String) {
        api.reload(sessionId)
    }

    private suspend fun send(request: okhttp3.Request): String {
        val response = api.exchange(request)
        val text = response.text()
        if (response.status !in 200..299) {
            throw api.errorFor(response.status, text, originOf(request))
        }
        return text
    }

    private fun parse(body: String): PluginsSnapshot {
        val root = try {
            json.parseToJsonElement(body).jsonObject
        } catch (_: Exception) {
            throw ApiError.Http(200, body.take(2048))
        }
        return PluginsSnapshot(
            packages = (root["packages"] as? JsonArray).orEmpty().mapNotNull(::parsePackage),
            totals = parseCounts(root["totals"] as? JsonObject),
            diagnostics = (root["diagnostics"] as? JsonArray).orEmpty().mapNotNull { element ->
                val entry = element as? JsonObject ?: return@mapNotNull null
                PluginDiagnostic(
                    type = string(entry["type"]) ?: "warning",
                    message = string(entry["message"]).orEmpty(),
                    source = string(entry["source"]),
                    path = string(entry["path"]),
                )
            },
        )
    }

    private fun parsePackage(element: JsonElement): PluginPackageInfo? {
        val entry = element as? JsonObject ?: return null
        val source = string(entry["source"]) ?: return null
        return PluginPackageInfo(
            source = source,
            scope = string(entry["scope"]) ?: "global",
            filtered = boolean(entry["filtered"]) ?: false,
            disabled = boolean(entry["disabled"]) ?: false,
            installedPath = string(entry["installedPath"]),
            packageName = string(entry["packageName"]),
            version = string(entry["version"]),
            configuredVersion = string(entry["configuredVersion"]),
            counts = parseCounts(entry["counts"] as? JsonObject),
            resources = (entry["resources"] as? JsonArray).orEmpty().mapNotNull { item ->
                val resource = item as? JsonObject ?: return@mapNotNull null
                PluginResourceInfo(
                    kind = string(resource["kind"]) ?: "extension",
                    name = string(resource["name"]).orEmpty(),
                    path = string(resource["path"]).orEmpty(),
                    relativePath = string(resource["relativePath"]).orEmpty(),
                )
            },
            status = string(entry["status"]) ?: "installed",
        )
    }

    private fun parseCounts(entry: JsonObject?): PluginResourceCounts = PluginResourceCounts(
        extensions = (entry?.get("extensions") as? JsonPrimitive)?.intOrNull ?: 0,
        skills = (entry?.get("skills") as? JsonPrimitive)?.intOrNull ?: 0,
        prompts = (entry?.get("prompts") as? JsonPrimitive)?.intOrNull ?: 0,
        themes = (entry?.get("themes") as? JsonPrimitive)?.intOrNull ?: 0,
    )

    private fun string(element: JsonElement?): String? =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun boolean(element: JsonElement?): Boolean? =
        (element as? JsonPrimitive)?.takeUnless { it.isString }?.let { p ->
            when (p.content) {
                "true" -> true
                "false" -> false
                else -> null
            }
        }

    private fun originOf(request: okhttp3.Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private companion object {
        const val PLUGINS_PATH = "api/plugins"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
