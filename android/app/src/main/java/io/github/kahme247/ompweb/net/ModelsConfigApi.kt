package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.ModelConfig
import io.github.kahme247.ompweb.domain.ModelCostConfig
import io.github.kahme247.ompweb.domain.ModelsFileConfig
import io.github.kahme247.ompweb.domain.ProviderConfig
import io.github.kahme247.ompweb.domain.parseModelsFile
import java.net.URLEncoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Every provider/model route the Settings tab needs, as an interface so
 * `ProvidersModelsViewModel` runs in JVM tests without a server:
 * - `GET/PUT /api/models-config[?overwrite=true]` (the editor's file)
 * - `POST /api/models-config/test` (isolated registry resolution)
 * - `GET /api/models-config/catalog` (models.dev search)
 * - `GET/PUT /api/model-roles`, `POST /api/providers/enable`
 * - `GET /api/omp-settings` and `PUT` for the registry/retry keys
 * - `GET /api/models` for the live catalog (shared with the composer)
 */
interface ModelsConfigApi {

    suspend fun loadModelsConfig(): ModelsConfigDocument

    /** Writes the whole file; [overwriteUnparseable] only after an explicit user confirm. */
    suspend fun saveModelsConfig(config: ModelsFileConfig, overwriteUnparseable: Boolean = false)

    suspend fun testModel(providerName: String, provider: ProviderConfig, model: ModelConfig): ModelTestResult

    suspend fun catalog(query: String, provider: String, baseUrl: String, limit: Int = 30): List<CatalogModel>

    suspend fun modelRoles(): ModelRolesDocument

    suspend fun saveModelRoles(roles: Map<String, String>): Map<String, String>

    suspend fun enableProvider(provider: String)

    suspend fun runtimeModels(): ModelsResponse

    suspend fun ompSettings(): OmpSettingsDocument

    suspend fun saveOmpSettings(settings: JsonObject): JsonObject
}

/** `GET /api/models-config`: either the parsed file or the parse failure that blocks saving. */
data class ModelsConfigDocument(
    val config: ModelsFileConfig? = null,
    val parseError: String? = null,
    val path: String? = null,
    /** The JSON exactly as received; [ProvidersModelsViewModel] compares it before a save. */
    val raw: JsonObject? = null,
)

/** One row of `POST /api/models-config/test`; [ok] false carries the server's explanation. */
data class ModelTestResult(
    val ok: Boolean,
    val error: String? = null,
    val code: String? = null,
    val latencyMs: Long? = null,
    val responseText: String? = null,
)

/** One models.dev entry from `GET /api/models-config/catalog` (prices in USD per 1M tokens). */
data class CatalogModel(
    val key: String = "",
    val providerId: String = "",
    val providerName: String = "",
    val providerBaseUrl: String? = null,
    val id: String = "",
    val name: String = "",
    val reasoning: Boolean? = null,
    val input: List<String>? = null,
    val contextWindow: Int? = null,
    val maxTokens: Int? = null,
    val cost: ModelCostConfig = ModelCostConfig(),
)

data class ModelRolesDocument(
    val roles: Map<String, String> = emptyMap(),
    val path: String? = null,
)

/** `GET /api/omp-settings`: the whole settings object plus its file path. */
data class OmpSettingsDocument(
    val settings: JsonObject = JsonObject(emptyMap()),
    val path: String? = null,
)

/** Production [ModelsConfigApi] over the app's single authenticated client. */
fun ApiClient.modelsConfigApi(): ModelsConfigApi = HttpModelsConfigApi(this)

private val modelsJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

private val JSON_MEDIA = "application/json".toMediaType()

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

private fun JsonObject.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.strings(key: String): List<String>? {
    val array = this[key] as? JsonArray ?: return null
    return array.mapNotNull { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.contentOrNull }
}

private fun JsonObject.stringMap(key: String): Map<String, String>? {
    val root = this[key] as? JsonObject ?: return null
    val result = LinkedHashMap<String, String>()
    root.forEach { (name, value) ->
        (value as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.let { result[name] = it }
    }
    return result
}

private fun JsonPrimitive.doubleOrNull(): Double? = contentOrNull?.toDoubleOrNull()

private fun parseJsonObject(text: String): JsonObject? = try {
    modelsJson.parseToJsonElement(text) as? JsonObject
} catch (_: Exception) {
    null
}

private fun parseCatalogModel(element: JsonElement): CatalogModel? {
    val root = element as? JsonObject ?: return null
    val id = root.string("id")?.takeIf { it.isNotBlank() } ?: return null
    val costRoot = root["cost"] as? JsonObject
    return CatalogModel(
        key = root.string("key").orEmpty(),
        providerId = root.string("providerId").orEmpty(),
        providerName = root.string("providerName").orEmpty(),
        providerBaseUrl = root.string("providerBaseUrl"),
        id = id,
        name = root.string("name").orEmpty(),
        reasoning = root.boolean("reasoning"),
        input = root.strings("input"),
        contextWindow = root.int("contextWindow"),
        maxTokens = root.int("maxTokens"),
        cost = ModelCostConfig(
            input = (costRoot?.get("input") as? JsonPrimitive)?.doubleOrNull(),
            output = (costRoot?.get("output") as? JsonPrimitive)?.doubleOrNull(),
            cacheRead = (costRoot?.get("cacheRead") as? JsonPrimitive)?.doubleOrNull(),
            cacheWrite = (costRoot?.get("cacheWrite") as? JsonPrimitive)?.doubleOrNull(),
        ),
    )
}

private class HttpModelsConfigApi(private val api: ApiClient) : ModelsConfigApi {

    override suspend fun loadModelsConfig(): ModelsConfigDocument {
        val text = get(CONFIG_PATH)
        val root = parseJsonObject(text) ?: throw ApiError.Http(200, text.take(2048))
        val parseError = root.string("parseError")
        val path = root.string("path")
        return if (parseError != null) {
            ModelsConfigDocument(config = null, parseError = parseError, path = path, raw = root)
        } else {
            ModelsConfigDocument(config = parseModelsFile(root), parseError = null, path = path, raw = root)
        }
    }

    override suspend fun saveModelsConfig(config: ModelsFileConfig, overwriteUnparseable: Boolean) {
        val path = if (overwriteUnparseable) "$CONFIG_PATH?overwrite=true" else CONFIG_PATH
        sendJson(path, "PUT", config.toJson().toString())
    }

    override suspend fun testModel(
        providerName: String,
        provider: ProviderConfig,
        model: ModelConfig,
    ): ModelTestResult {
        val payload = buildJsonObject {
            put("providerName", providerName)
            put("provider", provider.toJson())
            put("model", model.toJson())
        }
        val request = jsonRequest(TEST_PATH, "POST", payload.toString())
        val response = api.exchange(request)
        val text = response.text()
        val root = parseJsonObject(text)
        if (response.status !in 200..299 && root == null) throw api.errorFor(response.status, text, originOf(request))
        if (root == null) throw ApiError.Http(response.status, text.take(2048))
        return ModelTestResult(
            ok = root.boolean("ok") == true,
            error = root.string("error"),
            code = root.string("code"),
            latencyMs = root["latencyMs"]?.let { (it as? JsonPrimitive)?.contentOrNull?.toLongOrNull() },
            responseText = root.string("responseText"),
        )
    }

    override suspend fun catalog(query: String, provider: String, baseUrl: String, limit: Int): List<CatalogModel> {
        val path = "$CATALOG_PATH?q=${encodeQuery(query)}&provider=${encodeQuery(provider)}" +
            "&baseUrl=${encodeQuery(baseUrl)}&limit=$limit"
        val text = get(path)
        val root = parseJsonObject(text) ?: throw ApiError.Http(200, text.take(2048))
        return (root["models"] as? JsonArray)?.mapNotNull { parseCatalogModel(it) }.orEmpty()
    }

    override suspend fun modelRoles(): ModelRolesDocument {
        val text = get(ROLES_PATH)
        val root = parseJsonObject(text) ?: throw ApiError.Http(200, text.take(2048))
        return ModelRolesDocument(
            roles = root.stringMap("roles").orEmpty(),
            path = root.string("path"),
        )
    }

    override suspend fun saveModelRoles(roles: Map<String, String>): Map<String, String> {
        val payload = buildJsonObject {
            put("roles", buildJsonObject { roles.forEach { (role, selector) -> put(role, selector) } })
        }
        val text = sendJson(ROLES_PATH, "PUT", payload.toString())
        val root = parseJsonObject(text) ?: throw ApiError.Http(200, text.take(2048))
        return root.stringMap("roles") ?: roles
    }

    override suspend fun enableProvider(provider: String) {
        val payload = buildJsonObject { put("provider", provider) }
        sendJson(ENABLE_PROVIDER_PATH, "POST", payload.toString())
    }

    override suspend fun runtimeModels(): ModelsResponse = api.models(null)

    override suspend fun ompSettings(): OmpSettingsDocument {
        val text = get(OMP_SETTINGS_PATH)
        val root = parseJsonObject(text) ?: throw ApiError.Http(200, text.take(2048))
        return OmpSettingsDocument(
            settings = root["settings"] as? JsonObject ?: JsonObject(emptyMap()),
            path = root.string("path"),
        )
    }

    override suspend fun saveOmpSettings(settings: JsonObject): JsonObject {
        val payload = buildJsonObject { put("settings", settings) }
        val text = sendJson(OMP_SETTINGS_PATH, "PUT", payload.toString())
        val root = parseJsonObject(text) ?: throw ApiError.Http(200, text.take(2048))
        return root["settings"] as? JsonObject ?: settings
    }

    // --- transport ---------------------------------------------------------

    private suspend fun get(path: String): String {
        val request = api.requestBuilder(path).get().build()
        return requireSuccess(request)
    }

    private suspend fun sendJson(path: String, method: String, payload: String): String =
        requireSuccess(jsonRequest(path, method, payload))

    private fun jsonRequest(path: String, method: String, payload: String): Request {
        val body = payload.toRequestBody(JSON_MEDIA)
        val builder = api.requestBuilder(path)
        return when (method) {
            "PUT" -> builder.put(body).build()
            "DELETE" -> builder.delete(body).build()
            else -> builder.post(body).build()
        }
    }

    private suspend fun requireSuccess(request: Request): String {
        val response = api.exchange(request)
        val text = response.text()
        if (response.status !in 200..299) throw api.errorFor(response.status, text, originOf(request))
        return text
    }

    private fun originOf(request: Request): ServerAddress =
        ServerAddress(request.url.scheme, request.url.host, request.url.port)

    private companion object {
        const val CONFIG_PATH = "api/models-config"
        const val TEST_PATH = "api/models-config/test"
        const val CATALOG_PATH = "api/models-config/catalog"
        const val ROLES_PATH = "api/model-roles"
        const val ENABLE_PROVIDER_PATH = "api/providers/enable"
        const val OMP_SETTINGS_PATH = "api/omp-settings"
    }
}

private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")
