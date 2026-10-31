package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put

/**
 * The `models.yml` editor model, ported from `lib/omp/models-config.ts` and
 * `ModelsConfig*.tsx`, plus the System tab's registry/roles/fallbacks helpers.
 *
 * Pure: no Android or HTTP types, so every rule below is JVM-tested. The app
 * never parses YAML — the server returns the parsed file as JSON and serializes
 * it back, so "round-trip" here means the JSON tree survives the editor
 * untouched (unknown keys are carried in `extras`, like the web's YAML merge).
 */

/** `cost` of one model. The server requires all four fields when the block exists. */
data class ModelCostConfig(
    val input: Double? = null,
    val output: Double? = null,
    val cacheRead: Double? = null,
    val cacheWrite: Double? = null,
    val extras: Map<String, JsonElement> = emptyMap(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        val emitted = HashSet<String>(4)
        input?.let { put("input", JsonPrimitive(it)); emitted += "input" }
        output?.let { put("output", JsonPrimitive(it)); emitted += "output" }
        cacheRead?.let { put("cacheRead", JsonPrimitive(it)); emitted += "cacheRead" }
        cacheWrite?.let { put("cacheWrite", JsonPrimitive(it)); emitted += "cacheWrite" }
        extras.forEach { (key, value) -> if (key !in emitted) put(key, value) }
    }

    companion object {
        val COST_KEYS = listOf("input", "output", "cacheRead", "cacheWrite")
        val KNOWN = COST_KEYS.toSet()
    }
}

/** omp's `thinking` block (mode/efforts/defaultLevel/effortMap). */
data class ThinkingConfig(
    val mode: String? = null,
    val efforts: List<String>? = null,
    val defaultLevel: String? = null,
    val effortMap: Map<String, String>? = null,
    val extras: Map<String, JsonElement> = emptyMap(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        val emitted = HashSet<String>(4)
        mode?.let { put("mode", it); emitted += "mode" }
        efforts?.let { list ->
            put("efforts", buildJsonArray { list.forEach { add(JsonPrimitive(it)) } })
            emitted += "efforts"
        }
        defaultLevel?.let { put("defaultLevel", it); emitted += "defaultLevel" }
        effortMap?.let { map ->
            put("effortMap", buildJsonObject { map.forEach { (level, effort) -> put(level, effort) } })
            emitted += "effortMap"
        }
        extras.forEach { (key, value) -> if (key !in emitted) put(key, value) }
    }

    companion object {
        val KNOWN = setOf("mode", "efforts", "defaultLevel", "effortMap")
    }
}

/** One `providers.<name>.models[]` row (the subset the editor edits). */
data class ModelConfig(
    val id: String = "",
    val name: String? = null,
    val api: String? = null,
    val reasoning: Boolean? = null,
    val thinking: ThinkingConfig? = null,
    /** Raw `input` list; `text`/`image`. Null means "not specified". */
    val input: List<String>? = null,
    val contextWindow: Int? = null,
    val maxTokens: Int? = null,
    val cost: ModelCostConfig? = null,
    /** Keys the editor does not expose (`baseUrl`, `headers`, `compat`, …), preserved verbatim. */
    val extras: Map<String, JsonElement> = emptyMap(),
) {
    val hasImageInput: Boolean get() = input?.contains("image") == true

    /** True while the row is only the empty "Add model" draft (`omitUntouchedModelDrafts`). */
    val isUntouchedDraft: Boolean
        get() = id.isBlank() && name == null && api == null && reasoning == null && thinking == null &&
            input == null && contextWindow == null && maxTokens == null && cost == null && extras.isEmpty()

    fun toJson(): JsonObject = buildJsonObject {
        val emitted = HashSet<String>(10)
        put("id", id)
        emitted += "id"
        name?.let { put("name", it); emitted += "name" }
        api?.let { put("api", it); emitted += "api" }
        reasoning?.let { put("reasoning", JsonPrimitive(it)); emitted += "reasoning" }
        thinking?.let { put("thinking", it.toJson()); emitted += "thinking" }
        input?.let { list ->
            put("input", buildJsonArray { list.forEach { add(JsonPrimitive(it)) } })
            emitted += "input"
        }
        contextWindow?.let { put("contextWindow", JsonPrimitive(it)); emitted += "contextWindow" }
        maxTokens?.let { put("maxTokens", JsonPrimitive(it)); emitted += "maxTokens" }
        cost?.let { put("cost", it.toJson()); emitted += "cost" }
        extras.forEach { (key, value) -> if (key !in emitted) put(key, value) }
    }

    companion object {
        val KNOWN = setOf(
            "id", "name", "api", "reasoning", "thinking", "input", "contextWindow", "maxTokens", "cost",
        )
    }
}

/** One `providers.<name>` entry. */
data class ProviderConfig(
    val baseUrl: String? = null,
    val apiKey: String? = null,
    val api: String? = null,
    /** `apiKey`, `none` or `oauth`; null keeps omp's default (`apiKey`). */
    val auth: String? = null,
    val headers: Map<String, String>? = null,
    val models: List<ModelConfig> = emptyList(),
    /** Keys the editor does not expose (`compat`, `modelOverrides`, …), preserved verbatim. */
    val extras: Map<String, JsonElement> = emptyMap(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        val emitted = HashSet<String>(6)
        // A fresh provider draft carries empty strings; the web writes bare
        // `{api: …}` and an empty key would be a real (broken) value to omp.
        baseUrl?.takeIf { it.isNotBlank() }?.let { put("baseUrl", it); emitted += "baseUrl" }
        apiKey?.takeIf { it.isNotBlank() }?.let { put("apiKey", it); emitted += "apiKey" }
        api?.let { put("api", it); emitted += "api" }
        auth?.let { put("auth", it); emitted += "auth" }
        headers?.let { map ->
            put("headers", buildJsonObject { map.forEach { (key, value) -> put(key, value) } })
            emitted += "headers"
        }
        if (models.isNotEmpty()) {
            put("models", buildJsonArray { models.forEach { add(it.toJson()) } })
            emitted += "models"
        }
        extras.forEach { (key, value) -> if (key !in emitted) put(key, value) }
    }

    companion object {
        val KNOWN = setOf("baseUrl", "apiKey", "api", "auth", "headers", "models")
    }
}

/** The whole `models.yml` document: `providers` plus any other top-level key. */
data class ModelsFileConfig(
    val providers: Map<String, ProviderConfig> = emptyMap(),
    val extras: Map<String, JsonElement> = emptyMap(),
    /**
     * JSON paths (`providers.<name>`, `providers.<name>.models[2]`) whose value
     * is not an object. The editor cannot express them, so saving is blocked
     * instead of dropping the user's content.
     */
    val unparsedEntries: List<String> = emptyList(),
) {
    fun toJson(): JsonObject = buildJsonObject {
        val rawProviders = extras["providers"]
        if (providers.isNotEmpty() || rawProviders == null) {
            put("providers", buildJsonObject { providers.forEach { (name, provider) -> put(name, provider.toJson()) } })
        }
        extras.forEach { (key, value) -> if (key != "providers" || providers.isEmpty()) put(key, value) }
    }

    /**
     * The body the editor PUTs: blank "Add model" rows are dropped
     * (`omitUntouchedModelDrafts`) so leaving an empty row never writes it.
     */
    fun forSave(): ModelsFileConfig = copy(
        providers = LinkedHashMap<String, ProviderConfig>(providers.size).apply {
            providers.forEach { (name, provider) ->
                put(name, provider.copy(models = provider.models.filterNot { it.isUntouchedDraft }))
            }
        },
    )
}

// ── Parsing ──────────────────────────────────────────────────────────────────

private fun JsonObject.stringOrNull(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.booleanOrNull(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.intOrNull(key: String): Int? =
    (this[key] as? JsonPrimitive)?.intOrNull

private fun JsonObject.doubleOrNull(key: String): Double? =
    (this[key] as? JsonPrimitive)?.doubleOrNull

/** `null` when the value is missing, not an array, or holds a non-string element. */
private fun JsonObject.stringList(key: String): List<String>? {
    val array = this[key] as? JsonArray ?: return null
    return array.map { element ->
        (element as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
    }
}

/** `null` when the value is missing, not an object, or holds a non-string value. */
private fun JsonObject.stringMap(key: String): Map<String, String>? {
    val root = this[key] as? JsonObject ?: return null
    val result = LinkedHashMap<String, String>(root.size)
    for ((name, value) in root) {
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
        result[name] = text
    }
    return result
}

/**
 * Keys of [this] that are not [known]; explicit `null`s stay there so a save
 * preserves them.
 */
private fun JsonObject.extrasExcept(known: Set<String>): MutableMap<String, JsonElement> {
    val result = LinkedHashMap<String, JsonElement>()
    forEach { (key, value) ->
        if (key !in known || value == JsonNull) result[key] = value
    }
    return result
}

/**
 * Keeps a known key verbatim when its value has the wrong JSON shape, so a
 * hand-written oddity survives an editor save instead of being silently
 * dropped. Valid values are typed and therefore not duplicated.
 */
private fun JsonObject.keepRaw(
    extras: MutableMap<String, JsonElement>,
    key: String,
    converted: Any?,
) {
    if (converted != null) return
    val raw = this[key] ?: return
    extras[key] = raw
}

private fun parseCost(element: JsonElement?): ModelCostConfig? {
    val root = element as? JsonObject ?: return null
    return ModelCostConfig(
        input = root.doubleOrNull("input"),
        output = root.doubleOrNull("output"),
        cacheRead = root.doubleOrNull("cacheRead"),
        cacheWrite = root.doubleOrNull("cacheWrite"),
        extras = root.extrasExcept(ModelCostConfig.KNOWN),
    )
}

private fun parseThinking(element: JsonElement?): ThinkingConfig? {
    val root = element as? JsonObject ?: return null
    val efforts = root.stringList("efforts")
    val effortMap = root.stringMap("effortMap")
    val extras = root.extrasExcept(ThinkingConfig.KNOWN)
    root.keepRaw(extras, "efforts", efforts)
    root.keepRaw(extras, "effortMap", effortMap)
    return ThinkingConfig(
        mode = root.stringOrNull("mode"),
        efforts = efforts,
        defaultLevel = root.stringOrNull("defaultLevel"),
        effortMap = effortMap,
        extras = extras,
    )
}

private fun parseModel(element: JsonElement): ModelConfig? {
    val root = element as? JsonObject ?: return null
    val thinking = parseThinking(root["thinking"])
    val input = root.stringList("input")
    val cost = parseCost(root["cost"])
    val extras = root.extrasExcept(ModelConfig.KNOWN)
    root.keepRaw(extras, "thinking", thinking)
    root.keepRaw(extras, "input", input)
    root.keepRaw(extras, "cost", cost)
    return ModelConfig(
        id = root.stringOrNull("id").orEmpty(),
        name = root.stringOrNull("name"),
        api = root.stringOrNull("api"),
        reasoning = root.booleanOrNull("reasoning"),
        thinking = thinking,
        input = input,
        contextWindow = root.intOrNull("contextWindow"),
        maxTokens = root.intOrNull("maxTokens"),
        cost = cost,
        extras = extras,
    )
}

private fun parseProvider(
    name: String,
    element: JsonElement,
    unparsed: MutableList<String>,
): ProviderConfig? {
    val root = element as? JsonObject ?: return null
    val modelsRoot = root["models"] as? JsonArray
    val models = modelsRoot?.mapIndexedNotNull { index, model ->
        parseModel(model) ?: run {
            unparsed += "providers.$name.models[$index]"
            null
        }
    }
    val headers = root.stringMap("headers")
    val extras = root.extrasExcept(ProviderConfig.KNOWN)
    // A non-list `models` value cannot be edited, so keep it verbatim instead
    // of writing an empty list over the user's YAML.
    if (models == null) root.keepRaw(extras, "models", null)
    root.keepRaw(extras, "headers", headers)
    return ProviderConfig(
        baseUrl = root.stringOrNull("baseUrl"),
        apiKey = root.stringOrNull("apiKey"),
        api = root.stringOrNull("api"),
        auth = root.stringOrNull("auth"),
        headers = headers,
        models = models.orEmpty(),
        extras = extras,
    )
}

/**
 * Parses the JSON the server returns for models.yml. Non-object providers or
 * models cannot be edited; they are reported in
 * [ModelsFileConfig.unparsedEntries] so a save is blocked instead of silently
 * deleting them.
 */
fun parseModelsFile(root: JsonObject): ModelsFileConfig {
    val providersRoot = root["providers"] as? JsonObject
    val providers = LinkedHashMap<String, ProviderConfig>(providersRoot?.size ?: 0)
    val unparsed = ArrayList<String>()
    providersRoot?.forEach { (name, value) ->
        val provider = parseProvider(name, value, unparsed)
        if (provider != null) providers[name] = provider else unparsed += "providers.$name"
    }
    val extras = root.extrasExcept(setOf("providers"))
    if (providersRoot == null) root["providers"]?.let { extras["providers"] = it }
    return ModelsFileConfig(providers = providers, extras = extras, unparsedEntries = unparsed)
}

// ── Validation (mirrors validateModelsConfig) ────────────────────────────────

/**
 * Provider `baseUrl` rule: blank (inherit) or an http(s) URL, scheme matched
 * case-insensitively. This is the editor's own client-side guard, stricter than
 * `lib/omp/models-config.ts`, which only requires a non-empty `baseUrl` when
 * models are defined and accepts `not-a-url`. The inline hint and
 * [validateModelsConfig] both use it so an invalid value never reaches the file.
 */
fun isValidProviderBaseUrl(value: String?): Boolean {
    val text = value?.trim().orEmpty()
    if (text.isEmpty()) return true
    val lower = text.lowercase(java.util.Locale.ROOT)
    return lower.startsWith("http://") || lower.startsWith("https://")
}

/**
 * Returns the first validation error, or `null` when the file may be saved.
 * Messages are the server's own (`lib/omp/models-config.ts`) so the editor
 * shows what `PUT /api/models-config` would have answered, with one exception:
 * the `baseUrl` format error is Android's stricter client-side guard (see
 * [isValidProviderBaseUrl]); the server does not reject `not-a-url` there.
 */
fun validateModelsConfig(file: ModelsFileConfig): String? {
    for ((providerName, provider) in file.providers) {
        if (!isValidProviderBaseUrl(provider.baseUrl)) {
            return "Provider $providerName: \"baseUrl\" must be an http:// or https:// URL."
        }
        val models = provider.models
        if (models.isNotEmpty()) {
            if (provider.baseUrl.isNullOrBlank()) {
                return "Provider $providerName: \"baseUrl\" is required when defining custom models."
            }
            if (provider.apiKey.isNullOrBlank() && (provider.auth ?: "apiKey") != "none") {
                return "Provider $providerName: \"apiKey\" is required when defining custom models unless auth is \"none\"."
            }
        }
        for (model in models) {
            if (model.id.isBlank()) {
                return "Provider $providerName: model missing \"id\""
            }
            if (provider.api.isNullOrBlank() && model.api.isNullOrBlank()) {
                return "Provider $providerName, model ${model.id}: no \"api\" specified. Set at provider or model level."
            }
            if (model.contextWindow != null && model.contextWindow <= 0) {
                return "Provider $providerName, model ${model.id}: invalid contextWindow"
            }
            if (model.maxTokens != null && model.maxTokens <= 0) {
                return "Provider $providerName, model ${model.id}: invalid maxTokens"
            }
            val cost = model.cost ?: continue
            for (key in ModelCostConfig.COST_KEYS) {
                val value = when (key) {
                    "input" -> cost.input
                    "output" -> cost.output
                    "cacheRead" -> cost.cacheRead
                    else -> cost.cacheWrite
                }
                if (value == null || !value.isFinite()) {
                    return "Provider $providerName, model ${model.id}: cost.$key is required " +
                        "(cost needs input, output, cacheRead, and cacheWrite)"
                }
            }
        }
    }
    return null
}

/** `new-provider`, `new-provider-1`, … never colliding with an existing key. */
fun uniqueProviderName(providers: Map<String, ProviderConfig>, base: String = "new-provider"): String {
    if (!providers.containsKey(base)) return base
    var index = 1
    while (providers.containsKey("$base-$index")) index++
    return "$base-$index"
}

// ── Editing ──────────────────────────────────────────────────────────────────

fun ModelsFileConfig.withProvider(name: String, provider: ProviderConfig): ModelsFileConfig {
    val next = LinkedHashMap(providers)
    next[name] = provider
    return copy(providers = next)
}

/** Renames in place; the provider keeps its position in the list. */
fun ModelsFileConfig.renameProvider(oldName: String, newName: String): ModelsFileConfig {
    if (oldName == newName || !providers.containsKey(oldName)) return this
    val next = LinkedHashMap<String, ProviderConfig>(providers.size)
    providers.forEach { (name, provider) -> next[if (name == oldName) newName else name] = provider }
    return copy(providers = next)
}

fun ModelsFileConfig.withoutProvider(name: String): ModelsFileConfig =
    copy(providers = LinkedHashMap(providers).apply { remove(name) })

/** Appends an empty model row and returns its index. */
fun ModelsFileConfig.addModelDraft(providerName: String): Pair<ModelsFileConfig, Int> {
    val provider = providers[providerName] ?: ProviderConfig()
    val index = provider.models.size
    return withProvider(providerName, provider.copy(models = provider.models + ModelConfig())) to index
}

fun ModelsFileConfig.withModel(providerName: String, index: Int, model: ModelConfig): ModelsFileConfig {
    val provider = providers[providerName] ?: return this
    if (index !in provider.models.indices) return this
    val models = provider.models.toMutableList().apply { this[index] = model }
    return withProvider(providerName, provider.copy(models = models))
}

fun ModelsFileConfig.withoutModel(providerName: String, index: Int): ModelsFileConfig {
    val provider = providers[providerName] ?: return this
    if (index !in provider.models.indices) return this
    val models = provider.models.toMutableList().apply { removeAt(index) }
    return withProvider(providerName, provider.copy(models = models))
}

// ── Editor option lists (web `ModelsConfig-types.ts`) ───────────────────────

/** `API_OPTIONS`: the API protocols omp can speak. */
val API_PROTOCOLS: List<String> = listOf(
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
    "anthropic-messages",
    "bedrock-converse-stream",
    "google-generative-ai",
    "google-gemini-cli",
    "google-vertex",
)

/** One "quick endpoint preset" of the provider editor. */
data class EndpointPreset(val label: String, val baseUrl: String, val auth: String)

/** `ENDPOINT_PRESETS`; [auth] is `none`, `apiKey`, or `keep` (leave the provider's mode). */
val ENDPOINT_PRESETS: List<EndpointPreset> = listOf(
    EndpointPreset("Ollama", "http://localhost:11434/v1", "none"),
    EndpointPreset("LM Studio / vLLM", "http://localhost:1234/v1", "none"),
    EndpointPreset("OpenRouter", "https://openrouter.ai/api/v1", "apiKey"),
    EndpointPreset("Local Proxy (2455)", "http://127.0.0.1:2455/v1", "keep"),
)

/** Drops an all-empty cost block so the editor never writes `cost: {}` (which omp rejects). */
fun normalizedModelCost(cost: ModelCostConfig?): ModelCostConfig? {
    if (cost == null) return null
    val empty = cost.input == null && cost.output == null && cost.cacheRead == null &&
        cost.cacheWrite == null && cost.extras.isEmpty()
    return if (empty) null else cost
}

// ── Thinking levels (`model.thinking`) ───────────────────────────────────────

/** `provider/model` — the key `enabledModels` and role/fallback selectors use. */
val ModelOption.registryKey: String get() = "$provider/$modelId"

/** The levels `ThinkingEditor` offers (`THINKING_LEVELS`). */
val MODEL_THINKING_LEVELS: List<String> = listOf("minimal", "low", "medium", "high", "xhigh", "max")

/**
 * Includes/excludes [level] exactly like `ThinkingEditor.setLevel`:
 * - excluded: the level leaves `efforts`, its `effortMap` entry is dropped;
 * - included with a blank [customEffort]: `efforts` contains it, no map entry;
 * - included with a custom effort: the map carries the override.
 *
 * Returns `null` (the whole block is removed) when no level remains or every
 * level is on with no override, matching the web's reset-to-auto rule.
 */
fun withThinkingLevel(
    thinking: ThinkingConfig?,
    level: String,
    included: Boolean,
    customEffort: String?,
): ThinkingConfig? {
    if (level !in MODEL_THINKING_LEVELS) return thinking
    val current = thinking ?: ThinkingConfig()
    val includedLevels = LinkedHashSet(current.efforts ?: MODEL_THINKING_LEVELS)
    val map = LinkedHashMap(current.effortMap.orEmpty())
    if (included) {
        includedLevels.add(level)
        val effort = customEffort?.trim().orEmpty()
        if (effort.isEmpty()) map.remove(level) else map[level] = effort
    } else {
        includedLevels.remove(level)
        map.remove(level)
    }
    val ordered = MODEL_THINKING_LEVELS.filter { includedLevels.contains(it) }
    if (ordered.isEmpty() || (ordered.size == MODEL_THINKING_LEVELS.size && map.isEmpty())) return null
    return current.copy(
        mode = current.mode ?: "effort",
        efforts = ordered,
        effortMap = map.ifEmpty { null },
    )
}

// ── Model roles (`/api/model-roles`) ─────────────────────────────────────────
/** omp's native role names, in the web's display order. */
val NATIVE_MODEL_ROLES: List<String> = listOf(
    "default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor",
)

/** `provider/model` plus an optional `:effort` suffix. */
data class ModelRoleSelector(val model: String, val effort: String?) {
    val wire: String get() = composeModelRoleSelector(model, effort)
}

private val ROLE_EFFORT = Regex(":([^,:]+)$")

/** Splits `provider/model:effort` exactly like `ModelsConfig-panels.tsx`. */
fun parseModelRoleSelector(raw: String): ModelRoleSelector {
    val effort = ROLE_EFFORT.find(raw)?.groupValues?.get(1)
    val model = if (effort == null) raw else raw.replaceFirst(ROLE_EFFORT, "")
    return ModelRoleSelector(model = model, effort = effort)
}

/** Rebuilds a role selector, clearing the role when it has no model. */
fun composeModelRoleSelector(model: String, effort: String?): String =
    if (model.isEmpty()) "" else model + (effort?.takeIf { it.isNotEmpty() }?.let { ":$it" } ?: "")

/**
 * The values the role and fallback pickers offer: `provider/model`
 * ([registryKey]), never the composer's `provider:model` key. The web uses the
 * slash form for both dropdowns (`ModelsConfig-panels.tsx`); a colon selector is
 * unresolvable for omp even though the route would store it.
 */
fun roleModelKeys(options: List<ModelOption>): List<String> = options.map { it.registryKey }

// ── Fallback chains (`retry.fallbackChains`) ─────────────────────────────────

fun addFallbackModel(chain: List<String>, selector: String): List<String> {
    val value = selector.trim()
    if (value.isEmpty() || chain.contains(value)) return chain
    return chain + value
}

fun removeFallbackModel(chain: List<String>, selector: String): List<String> =
    chain.filterNot { it == selector }

/** Swaps the entry at [index] with its neighbour; out-of-range is a no-op. */
fun moveFallbackModel(chain: List<String>, index: Int, offset: Int): List<String> {
    val target = index + offset
    if (index !in chain.indices || target !in chain.indices) return chain
    return chain.toMutableList().apply {
        val moved = this[index]
        this[index] = this[target]
        this[target] = moved
    }
}

// ── Native registry (`enabledModels`, `disabledProviders`, provider order) ───

/** Every provider the registry panel lists: live models, connected providers and already-disabled ids. */
fun registryProviderIds(
    modelProviders: List<String>,
    connectedProviders: List<String>,
    disabledProviders: List<String>,
): List<String> = (modelProviders + connectedProviders + disabledProviders)
    .filter { it.isNotBlank() }
    .distinct()
    .sorted()

/** The stored preference first, then every remaining provider (web `orderedProviders`). */
fun orderedRegistryProviders(order: List<String>, all: List<String>): List<String> {
    val known = LinkedHashMap<String, Unit>()
    order.forEach { if (it.isNotBlank()) known[it] = Unit }
    all.forEach { if (it.isNotBlank()) known[it] = Unit }
    return known.keys.toList()
}

/** "Restrict selected models" on: the allow-list starts with every live model. */
fun toggleModelAllowList(enabledModels: List<String>, allKeys: List<String>, enabled: Boolean): List<String> =
    if (enabled) allKeys else emptyList()

fun toggleEnabledModel(enabledModels: List<String>, key: String, enabled: Boolean): List<String> =
    if (enabled) {
        if (enabledModels.contains(key)) enabledModels else enabledModels + key
    } else {
        enabledModels.filterNot { it == key }
    }

fun toggleDisabledProvider(disabledProviders: List<String>, provider: String, disabled: Boolean): List<String> =
    if (disabled) {
        if (disabledProviders.contains(provider)) disabledProviders else disabledProviders + provider
    } else {
        disabledProviders.filterNot { it == provider }
    }

// ── Composer visibility (`omp-composer-models`) ──────────────────────────────

/** `null` means "every model is offered"; the first toggle materializes the full set. */
private fun materializedVisibility(visible: Set<String>?, all: List<ModelOption>): Set<String> =
    visible ?: all.map { it.key }.toSet()

fun toggleComposerModelVisibility(
    visible: Set<String>?,
    all: List<ModelOption>,
    key: String,
    visibleNow: Boolean,
): Set<String> {
    val next = materializedVisibility(visible, all).toMutableSet()
    if (visibleNow) next.add(key) else next.remove(key)
    return next
}

fun toggleComposerProviderVisibility(
    visible: Set<String>?,
    all: List<ModelOption>,
    provider: String,
    visibleNow: Boolean,
): Set<String> {
    val next = materializedVisibility(visible, all).toMutableSet()
    all.filter { it.provider == provider }.forEach { model ->
        if (visibleNow) next.add(model.key) else next.remove(model.key)
    }
    return next
}

fun visibleComposerModelCount(visible: Set<String>?, all: List<ModelOption>): Int =
    all.count { visible == null || visible.contains(it.key) }

// ── Save guards ──────────────────────────────────────────────────────────────

/**
 * `models.yml` has no ETag. A save therefore re-reads the file and compares it
 * with the JSON the editor loaded; a difference means someone changed it
 * externally and a blind PUT would overwrite that change. A failed fresh read
 * counts as a conflict (the editor never saves over an unknown state).
 */
fun modelsConfigConflict(loaded: JsonObject?, fresh: JsonObject?): Boolean =
    fresh == null || loaded != fresh

/**
 * Registry/fallback writes rebuild the whole `/api/omp-settings` snapshot from
 * the loaded document. Without that document (or after a failed load) a write
 * would replace retry/registry keys with the defaults, so it stays blocked.
 */
fun nativeSettingsWritable(settings: JsonObject?, error: String?): Boolean =
    settings != null && error == null

