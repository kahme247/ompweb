package io.github.kahme247.ompweb.net

import java.net.URLEncoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** Where a skill came from (`SkillInfo.sourceInfo`). */
data class SkillSourceInfo(val source: String?, val scope: String?)

/** Install provenance of a skill (`SkillInfo.install`). */
data class SkillInstallInfo(
    val packageName: String,
    val scope: String,
    val source: String,
    val skillsShUrl: String?,
    val versionHash: String?,
    val canCheckForUpdates: Boolean,
)

/**
 * One skill from `GET /api/skills`. [togglable] is false for plugin/registry
 * copies whose `SKILL.md` is not user-owned (the PATCH would be refused).
 */
data class NativeSkillInfo(
    val name: String,
    val description: String,
    val filePath: String,
    val baseDir: String,
    val disableModelInvocation: Boolean,
    val sourceInfo: SkillSourceInfo,
    val install: SkillInstallInfo?,
    val togglable: Boolean,
)

/** One skills.sh search hit. */
data class SkillSearchResult(val packageName: String, val installs: String, val url: String)

/** Result of checking one installed skill (`POST /api/skills/check`). */
data class SkillUpdateResult(
    val packageName: String,
    val scope: String,
    val state: String,
    val currentVersion: String?,
    val latestVersion: String?,
    val message: String?,
)

/**
 * `/api/skills` plus its actions: list, toggle, search, install, check and
 * update (the route family under `app/api/skills`). Failures are [ApiError]s;
 * the server's message
 * is the user-facing wording.
 */
interface SkillsApi {

    suspend fun list(cwd: String): List<NativeSkillInfo>

    /** Returns the value the file now has (the server reports the truth). */
    suspend fun setModelInvocationDisabled(filePath: String, disabled: Boolean, cwd: String?): Boolean

    suspend fun search(query: String, limit: Int = 50): List<SkillSearchResult>

    /** `scope` is `global` or `project`; a project install needs [cwd]. */
    suspend fun install(packageName: String, scope: String, cwd: String?)

    suspend fun checkUpdates(cwd: String, packageName: String? = null, scope: String? = null): List<SkillUpdateResult>

    suspend fun update(cwd: String, packageName: String, scope: String)
}

/** Production [SkillsApi] over the app's authenticated client. */
class HttpSkillsApi(private val api: ApiClient) : SkillsApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun list(cwd: String): List<NativeSkillInfo> {
        val request = api.requestBuilder("$SKILLS_PATH?cwd=${encode(cwd)}").get().build()
        val root = parseObject(send(request))
        return (root["skills"] as? JsonArray).orEmpty().mapNotNull(::parseSkill)
    }

    override suspend fun setModelInvocationDisabled(filePath: String, disabled: Boolean, cwd: String?): Boolean {
        val payload = buildJsonObject {
            put("filePath", filePath)
            put("disableModelInvocation", disabled)
            if (cwd != null) put("cwd", cwd)
        }.toString()
        val request = api.requestBuilder(SKILLS_PATH).patch(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        val root = parseObject(send(request))
        return boolean(root["disableModelInvocation"]) ?: disabled
    }

    override suspend fun search(query: String, limit: Int): List<SkillSearchResult> {
        val payload = buildJsonObject {
            put("query", query)
            put("limit", limit)
        }.toString()
        val request = api.requestBuilder("$SKILLS_PATH/search").post(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        val root = parseObject(send(request))
        return (root["results"] as? JsonArray).orEmpty().mapNotNull { element ->
            val entry = element as? JsonObject ?: return@mapNotNull null
            val name = string(entry["package"]) ?: return@mapNotNull null
            SkillSearchResult(name, string(entry["installs"]).orEmpty(), string(entry["url"]).orEmpty())
        }
    }

    override suspend fun install(packageName: String, scope: String, cwd: String?) {
        val payload = buildJsonObject {
            put("package", packageName)
            put("scope", scope)
            if (cwd != null) put("cwd", cwd)
        }.toString()
        val request = api.requestBuilder("$SKILLS_PATH/install").post(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        send(request)
    }

    override suspend fun checkUpdates(cwd: String, packageName: String?, scope: String?): List<SkillUpdateResult> {
        val payload = buildJsonObject {
            put("cwd", cwd)
            if (packageName != null) put("package", packageName)
            if (scope != null) put("scope", scope)
        }.toString()
        val request = api.requestBuilder("$SKILLS_PATH/check").post(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        val root = parseObject(send(request))
        return (root["updates"] as? JsonArray).orEmpty().mapNotNull { element ->
            val entry = element as? JsonObject ?: return@mapNotNull null
            val name = string(entry["package"]) ?: return@mapNotNull null
            SkillUpdateResult(
                packageName = name,
                scope = string(entry["scope"]) ?: "global",
                state = string(entry["state"]) ?: "error",
                currentVersion = string(entry["currentVersion"]),
                latestVersion = string(entry["latestVersion"]),
                message = string(entry["message"]),
            )
        }
    }

    override suspend fun update(cwd: String, packageName: String, scope: String) {
        val payload = buildJsonObject {
            put("cwd", cwd)
            put("package", packageName)
            put("scope", scope)
        }.toString()
        val request = api.requestBuilder("$SKILLS_PATH/update").post(payload.toRequestBody(JSON_MEDIA_TYPE)).build()
        send(request)
    }

    private fun parseSkill(element: JsonElement): NativeSkillInfo? {
        val entry = element as? JsonObject ?: return null
        val name = string(entry["name"]) ?: return null
        val source = entry["sourceInfo"] as? JsonObject
        val install = (entry["install"] as? JsonObject)?.let { info ->
            val packageName = string(info["package"]) ?: return@let null
            SkillInstallInfo(
                packageName = packageName,
                scope = string(info["scope"]) ?: "global",
                source = string(info["source"]).orEmpty(),
                skillsShUrl = string(info["skillsShUrl"]),
                versionHash = string(info["versionHash"]),
                canCheckForUpdates = boolean(info["canCheckForUpdates"]) ?: false,
            )
        }
        return NativeSkillInfo(
            name = name,
            description = string(entry["description"]).orEmpty(),
            filePath = string(entry["filePath"]).orEmpty(),
            baseDir = string(entry["baseDir"]).orEmpty(),
            disableModelInvocation = boolean(entry["disableModelInvocation"]) ?: false,
            sourceInfo = SkillSourceInfo(
                source = source?.let { string(it["source"]) },
                scope = source?.let { string(it["scope"]) },
            ),
            install = install,
            togglable = boolean(entry["togglable"]) ?: true,
        )
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

    private fun string(element: JsonElement?): String? =
        (element as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun boolean(element: JsonElement?): Boolean? =
        (element as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

    private fun originOf(request: okhttp3.Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private companion object {
        const val SKILLS_PATH = "api/skills"
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
