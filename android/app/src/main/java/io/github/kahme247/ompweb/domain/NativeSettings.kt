package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Settings categories that hold native OMP rows (web `SettingsConfig.tsx`).
 * [EXTENSIONS] is the web tab `mcp` (Extensions & Tools: native MCP toggles,
 * MCP server editor, Skills and Plugins). The web tab ids live in Slice A's
 * `SettingsTab`.
 */
enum class NativeCategory { GENERAL, SAFETY, MODELS, INTELLIGENCE, EXTENSIONS }

/** omp's thinking levels (`NativeSettings.defaultThinkingLevel`). */
val THINKING_LEVELS: List<String> = listOf("auto", "minimal", "low", "medium", "high", "xhigh", "max")

/** `textVerbosity` choices. */
val TEXT_VERBOSITIES: List<String> = listOf("low", "medium", "high")

/** `personality` choices. */
val PERSONALITIES: List<String> = listOf("default", "friendly", "pragmatic", "none")

/** `tools.approvalMode` choices. */
val APPROVAL_MODES: List<String> = listOf("always-ask", "write", "yolo")

/** `tools.approval.bash` choices. */
val BASH_APPROVAL_POLICIES: List<String> = listOf("allow", "prompt", "deny")

/** `tools.approval.extension` choices, in the web's select order. */
val EXTENSION_APPROVAL_POLICIES: List<String> = listOf("prompt", "allow")

/** `memory.backend` choices. */
val MEMORY_BACKENDS: List<String> = listOf("off", "local", "mnemopi", "hindsight")

/** `mnemopi.scoping` choices, in the web's select order. */
val MEMORY_SCOPES: List<String> = listOf("per-project", "per-project-tagged", "global")

/** `retry.fallbackRevertPolicy` choices. */
val FALLBACK_REVERT_POLICIES: List<String> = listOf("cooldown-expiry", "never")

/** `advisor.syncBacklog` choices. */
val ADVISOR_BACKLOGS: List<String> = listOf("off", "1", "3", "5")

/** Retry attempts offered by the web select (the server accepts 0–20). */
val RETRY_ATTEMPTS: List<Int> = listOf(0, 1, 2, 3, 4, 5)

/** omp's compaction methods in its settings-menu order (`lib/compaction-methods.ts`). */
val COMPACTION_METHODS: List<String> = listOf("remote", "snapcompact", "handoff", "soft", "shake")

/** omp's effective order while `compaction.methodOrder` is unset. */
val DEFAULT_COMPACTION_METHOD_ORDER: List<String> = listOf("remote", "snapcompact", "handoff", "shake", "soft")

/**
 * Defaults the web settings panel shows for keys omp leaves unset (it renders
 * `?? default` next to every control). These are display defaults; a key that
 * is absent stays absent in the document and omp's own default applies.
 */
object NativeSettingsDefaults {
    const val THINKING_LEVEL = "high"
    const val AUTO_THINKING_SOURCE = "classifier"
    const val TEXT_VERBOSITY = "medium"
    const val PERSONALITY = "default"
    const val HIDE_THINKING_BLOCK = false
    const val EXTERNAL_THINKING = false
    const val APPROVAL_MODE = "yolo"
    const val BASH_APPROVAL = "prompt"
    const val EXTENSION_APPROVAL = "prompt"
    const val SHOW_STARTUP_DIAGNOSTICS = true
    const val COMPACTION_ENABLED = true
    const val COMPACTION_AUTO_CONTINUE = true
    const val COMPACTION_MID_TURN = true
    const val MEMORY_BACKEND = "mnemopi"
    const val AUTOLEARN_ENABLED = true
    const val AUTOLEARN_AUTO_CONTINUE = true
    const val MEMORY_SCOPE = "per-project"
    const val AUTO_RECALL = true
    const val AUTO_RETAIN = true
    const val RETRY_ENABLED = true
    const val MAX_RETRIES = 2
    const val MODEL_FALLBACK = false
    const val MCP_PROJECT_CONFIG = true
    const val MCP_RENDER_MARKDOWN = true
    const val MCP_NOTIFICATIONS = false
}

/**
 * The persisted native OMP settings as the server returns them
 * (`GET /api/omp-settings` → `{path, settings}`).
 *
 * The server exposes only the keys it understands, but a settings file is the
 * user's real `config.yml`: [root] therefore keeps every unknown key
 * untouched, and every setter returns a new document instead of mutating.
 */
data class NativeSettingsDocument(val root: JsonObject = JsonObject(emptyMap())) {

    fun string(key: String): String? = (root[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun bool(key: String): Boolean? = (root[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

    fun int(key: String): Int? = (root[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull

    fun array(key: String): List<String>? = stringList(root[key])

    fun section(name: String): JsonObject = root[name] as? JsonObject ?: JsonObject(emptyMap())

    fun sectionString(name: String, key: String): String? =
        (section(name)[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    fun sectionBool(name: String, key: String): Boolean? =
        (section(name)[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

    fun sectionInt(name: String, key: String): Int? =
        (section(name)[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull

    fun withString(key: String, value: String?): NativeSettingsDocument = withValue(key, value?.let(::JsonPrimitive))

    fun withBool(key: String, value: Boolean?): NativeSettingsDocument = withValue(key, value?.let(::JsonPrimitive))

    /** Replaces an arbitrary top-level value (used by the registry/fallback panels). */
    fun withValue(key: String, value: JsonElement?): NativeSettingsDocument =
        if (value == null) NativeSettingsDocument(JsonObject(root - key))
        else NativeSettingsDocument(JsonObject(root + (key to value)))

    fun withSectionString(name: String, key: String, value: String?): NativeSettingsDocument =
        withSectionValue(name, key, value?.let(::JsonPrimitive))

    fun withSectionBool(name: String, key: String, value: Boolean?): NativeSettingsDocument =
        withSectionValue(name, key, value?.let(::JsonPrimitive))

    fun withSectionInt(name: String, key: String, value: Int?): NativeSettingsDocument =
        withSectionValue(name, key, value?.let(::JsonPrimitive))

    /** Merges one key into a section object; `null` removes it and empties disappear. */
    fun withSectionValue(name: String, key: String, value: JsonElement?): NativeSettingsDocument {
        val current = section(name)
        val next = if (value == null) JsonObject(current - key) else JsonObject(current + (key to value))
        return if (next.isEmpty()) NativeSettingsDocument(JsonObject(root - name)) else withValue(name, next)
    }

    /** Merges one key into an object nested inside a section (`tools.approval.bash`). */
    fun withNestedSectionString(
        name: String,
        sectionKey: String,
        key: String,
        value: String?,
    ): NativeSettingsDocument {
        val current = section(name)[sectionKey] as? JsonObject ?: JsonObject(emptyMap())
        val next = if (value == null) JsonObject(current - key) else JsonObject(current + (key to JsonPrimitive(value)))
        return withSectionValue(name, sectionKey, next.takeIf { it.isNotEmpty() })
    }

    // --- Typed rows (web display defaults) ---------------------------------

    fun thinkingLevel(): String = string("defaultThinkingLevel") ?: NativeSettingsDefaults.THINKING_LEVEL

    fun autoThinkingSource(): String =
        sectionString("providers", "autoThinkingSource") ?: NativeSettingsDefaults.AUTO_THINKING_SOURCE

    fun textVerbosity(): String = string("textVerbosity") ?: NativeSettingsDefaults.TEXT_VERBOSITY

    fun personality(): String = string("personality") ?: NativeSettingsDefaults.PERSONALITY

    fun hideThinkingBlock(): Boolean =
        bool("hideThinkingBlock") ?: NativeSettingsDefaults.HIDE_THINKING_BLOCK

    fun externalThinking(): Boolean = bool("externalThinking") ?: NativeSettingsDefaults.EXTERNAL_THINKING

    fun approvalMode(): String = sectionString("tools", "approvalMode") ?: NativeSettingsDefaults.APPROVAL_MODE

    fun bashApproval(): String =
        nestedString("tools", "approval", "bash") ?: NativeSettingsDefaults.BASH_APPROVAL

    fun extensionApproval(): String =
        nestedString("tools", "approval", "extension") ?: NativeSettingsDefaults.EXTENSION_APPROVAL

    fun showStartupDiagnostics(): Boolean =
        sectionBool("skills", "showStartupDiagnostics") ?: NativeSettingsDefaults.SHOW_STARTUP_DIAGNOSTICS

    fun compactionEnabled(): Boolean =
        sectionBool("compaction", "enabled") ?: NativeSettingsDefaults.COMPACTION_ENABLED

    fun compactionAutoContinue(): Boolean =
        sectionBool("compaction", "autoContinue") ?: NativeSettingsDefaults.COMPACTION_AUTO_CONTINUE

    fun compactionMidTurn(): Boolean =
        sectionBool("compaction", "midTurnEnabled") ?: NativeSettingsDefaults.COMPACTION_MID_TURN

    /**
     * omp's effective compaction order for this document: a valid `methodOrder`
     * list (unknown ids dropped, first occurrences kept, like omp) or the web
     * display default when the key is unset.
     */
    fun compactionMethodOrder(): List<String> {
        val raw = section("compaction")["methodOrder"]
        if (raw is JsonArray) {
            val known = raw.mapNotNull { (it as? JsonPrimitive)?.takeUnless { p -> p.isString.not() }?.content }
                .filter { it in COMPACTION_METHODS }
            return known.distinct()
        }
        return DEFAULT_COMPACTION_METHOD_ORDER
    }

    fun memoryBackend(): String = sectionString("memory", "backend") ?: NativeSettingsDefaults.MEMORY_BACKEND

    fun autolearnEnabled(): Boolean =
        sectionBool("autolearn", "enabled") ?: NativeSettingsDefaults.AUTOLEARN_ENABLED

    fun autolearnAutoContinue(): Boolean =
        sectionBool("autolearn", "autoContinue") ?: NativeSettingsDefaults.AUTOLEARN_AUTO_CONTINUE

    fun memoryScope(): String = sectionString("mnemopi", "scoping") ?: NativeSettingsDefaults.MEMORY_SCOPE

    fun autoRecall(): Boolean = sectionBool("mnemopi", "autoRecall") ?: NativeSettingsDefaults.AUTO_RECALL

    fun autoRetain(): Boolean = sectionBool("mnemopi", "autoRetain") ?: NativeSettingsDefaults.AUTO_RETAIN

    fun retryEnabled(): Boolean = sectionBool("retry", "enabled") ?: NativeSettingsDefaults.RETRY_ENABLED

    fun maxRetries(): Int = sectionInt("retry", "maxRetries") ?: NativeSettingsDefaults.MAX_RETRIES

    fun modelFallback(): Boolean = sectionBool("retry", "modelFallback") ?: NativeSettingsDefaults.MODEL_FALLBACK

    fun mcpProjectConfig(): Boolean =
        sectionBool("mcp", "enableProjectConfig") ?: NativeSettingsDefaults.MCP_PROJECT_CONFIG

    fun mcpRenderMarkdown(): Boolean =
        sectionBool("mcp", "renderMarkdownResults") ?: NativeSettingsDefaults.MCP_RENDER_MARKDOWN

    fun mcpNotifications(): Boolean =
        sectionBool("mcp", "notifications") ?: NativeSettingsDefaults.MCP_NOTIFICATIONS

    private fun nestedString(section: String, nested: String, key: String): String? {
        val inner = section(section)[nested] as? JsonObject ?: return null
        return (inner[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}

private fun stringList(element: JsonElement?): List<String>? {
    val array = element as? JsonArray ?: return null
    return array.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
}

/**
 * Validation of the writable native settings, mirroring
 * `lib/omp/settings-config.ts` `writeNativeSettings` (the server rejects the
 * whole PUT when one value is invalid). An empty list means the document can
 * be sent.
 */
fun validateNativeSettings(document: NativeSettingsDocument): List<String> {
    val root = document.root
    val issues = mutableListOf<String>()
    fun fail(message: String) {
        issues += message
    }

    fun checkRecord(name: String, value: JsonElement?) {
        if (value != null && value !is JsonObject) fail("$name must be an object")
    }

    checkRecord("providers", root["providers"])
    checkRecord("advisor", root["advisor"])
    checkRecord("tools", root["tools"])
    checkRecord("retry", root["retry"])
    checkRecord("compaction", root["compaction"])
    checkRecord("memory", root["memory"])
    checkRecord("autolearn", root["autolearn"])
    checkRecord("mnemopi", root["mnemopi"])
    checkRecord("mcp", root["mcp"])
    checkRecord("skills", root["skills"])
    val tools = root["tools"] as? JsonObject
    checkRecord("tools.approval", tools?.get("approval"))
    if (issues.isNotEmpty()) return issues

    val skills = root["skills"] as? JsonObject
    if (skills != null && skills.keys.any { it != "showStartupDiagnostics" }) fail("Unsupported skills setting")

    root["defaultThinkingLevel"]?.let {
        if (!isChoice(it, THINKING_LEVELS)) fail("Invalid default thinking level")
    }
    root["hideThinkingBlock"]?.let { if (!isPlainBoolean(it)) fail("hideThinkingBlock must be a boolean") }
    root["externalThinking"]?.let { if (!isPlainBoolean(it)) fail("externalThinking must be a boolean") }
    root["textVerbosity"]?.let {
        if (!isChoice(it, TEXT_VERBOSITIES)) fail("Invalid text verbosity")
    }
    root["personality"]?.let {
        if (!isChoice(it, PERSONALITIES)) fail("Invalid personality")
    }

    val providers = root["providers"] as? JsonObject
    providers?.get("autoThinkingSource")?.let {
        if (!isChoice(it, listOf("classifier", "vendor"))) fail("Invalid Auto thinking source")
    }

    val advisor = root["advisor"] as? JsonObject
    advisor?.get("enabled")?.let { if (!isPlainBoolean(it)) fail("advisor.enabled must be a boolean") }
    advisor?.get("subagents")?.let { if (!isPlainBoolean(it)) fail("advisor.subagents must be a boolean") }
    advisor?.get("syncBacklog")?.let {
        if (!isChoice(it, ADVISOR_BACKLOGS)) fail("Invalid advisor sync backlog")
    }
    advisor?.get("immuneTurns")?.let {
        val value = plainInt(it)
        if (value == null || value < 0 || value > 20) fail("Advisor immune turns must be an integer between 0 and 20")
    }

    tools?.get("approvalMode")?.let {
        if (!isChoice(it, APPROVAL_MODES)) fail("Invalid approval mode")
    }
    val approval = tools?.get("approval") as? JsonObject
    approval?.get("bash")?.let {
        if (!isChoice(it, BASH_APPROVAL_POLICIES)) fail("Invalid Bash approval policy")
    }
    approval?.get("extension")?.let {
        if (!isChoice(it, EXTENSION_APPROVAL_POLICIES)) {
            fail("Invalid extension tool approval policy")
        }
    }

    skills?.get("showStartupDiagnostics")?.let {
        if (!isPlainBoolean(it)) fail("skills.showStartupDiagnostics must be a boolean")
    }

    for (key in listOf("enabledModels", "disabledProviders", "modelProviderOrder")) {
        val value = root[key] ?: continue
        val list = value as? JsonArray ?: run { fail("$key must contain non-empty strings"); continue }
        if (list.any { !isNonBlankString(it) }) fail("$key must contain non-empty strings")
    }

    val retry = root["retry"] as? JsonObject
    retry?.get("enabled")?.let { if (!isPlainBoolean(it)) fail("retry.enabled must be a boolean") }
    retry?.get("modelFallback")?.let { if (!isPlainBoolean(it)) fail("retry.modelFallback must be a boolean") }
    retry?.get("maxRetries")?.let {
        val value = plainInt(it)
        if (value == null || value < 0 || value > 20) fail("Retry attempts must be an integer between 0 and 20")
    }
    retry?.get("fallbackRevertPolicy")?.let {
        if (!isChoice(it, FALLBACK_REVERT_POLICIES)) fail("Invalid fallback revert policy")
    }
    (retry?.get("fallbackChains") as? JsonObject)?.forEach { (role, chain) ->
        val list = chain as? JsonArray
        if (role.isBlank() || list == null || list.any { !isNonBlankString(it) }) {
            fail("Fallback chains require non-empty role and model selectors")
        }
    }

    val compaction = root["compaction"] as? JsonObject
    compaction?.get("enabled")?.let { if (!isPlainBoolean(it)) fail("compaction.enabled must be a boolean") }
    compaction?.get("midTurnEnabled")?.let { if (!isPlainBoolean(it)) fail("compaction.midTurnEnabled must be a boolean") }
    compaction?.get("autoContinue")?.let { if (!isPlainBoolean(it)) fail("compaction.autoContinue must be a boolean") }
    compaction?.get("methodOrder")?.let {
        val list = it as? JsonArray
        if (list == null) {
            fail("Invalid compaction method order")
        } else {
            val methods = list.mapNotNull { item -> (item as? JsonPrimitive)?.takeIf(::isPlainString)?.content }
            if (methods.size != list.size || methods.any { it !in COMPACTION_METHODS } || methods.distinct() != methods) {
                fail("Invalid compaction method order")
            }
        }
    }
    compaction?.get("keepRecentTokens")?.let {
        val value = plainInt(it)
        if (value == null || value < 1_000 || value > 1_000_000) {
            fail("Compaction retained tokens must be an integer between 1,000 and 1,000,000")
        }
    }

    (root["memory"] as? JsonObject)?.get("backend")?.let {
        if (!isChoice(it, MEMORY_BACKENDS)) fail("Invalid memory backend")
    }
    (root["autolearn"] as? JsonObject)?.let { autolearn ->
        autolearn["enabled"]?.let { if (!isPlainBoolean(it)) fail("autolearn.enabled must be a boolean") }
        autolearn["autoContinue"]?.let { if (!isPlainBoolean(it)) fail("autolearn.autoContinue must be a boolean") }
        autolearn["minToolCalls"]?.let {
            val value = plainInt(it)
            if (value == null || value < 0 || value > 100) {
                fail("Auto-learn minimum tool calls must be an integer between 0 and 100")
            }
        }
    }
    (root["mnemopi"] as? JsonObject)?.let { mnemopi ->
        mnemopi["scoping"]?.let {
            if (!isChoice(it, MEMORY_SCOPES)) fail("Invalid Mnemopi memory scope")
        }
        mnemopi["autoRecall"]?.let { if (!isPlainBoolean(it)) fail("mnemopi.autoRecall must be a boolean") }
        mnemopi["autoRetain"]?.let { if (!isPlainBoolean(it)) fail("mnemopi.autoRetain must be a boolean") }
        mnemopi["noEmbeddings"]?.let { if (!isPlainBoolean(it)) fail("mnemopi.noEmbeddings must be a boolean") }
    }
    (root["mcp"] as? JsonObject)?.let { mcp ->
        mcp["enableProjectConfig"]?.let { if (!isPlainBoolean(it)) fail("mcp.enableProjectConfig must be a boolean") }
        mcp["renderMarkdownResults"]?.let { if (!isPlainBoolean(it)) fail("mcp.renderMarkdownResults must be a boolean") }
        mcp["notifications"]?.let { if (!isPlainBoolean(it)) fail("mcp.notifications must be a boolean") }
        mcp["notificationDebounceMs"]?.let {
            val value = plainInt(it)
            if (value == null || value < 0 || value > 60_000) {
                fail("MCP notification debounce must be an integer between 0 and 60,000")
            }
        }
    }
    return issues
}

private fun isPlainString(element: JsonElement): Boolean = element is JsonPrimitive && element.isString

/**
 * The server's URL rule (`new URL(...)` + protocol check): a scheme of http or
 * https (case-insensitively) and a non-empty host. `new URL` strips leading and
 * trailing C0 controls and spaces before parsing, so the Android rule trims the
 * same ASCII whitespace and accepts `" https://host "` like the server does.
 */
@Suppress("TrimLambda") // `new URL` strips only C0 controls and spaces, not all Unicode whitespace.
private fun isHttpUrl(value: String?): Boolean {
    val text = value?.trim { it <= ' ' } ?: return false
    if (text.isEmpty()) return false
    val uri = try {
        java.net.URI(text)
    } catch (_: Exception) {
        return false
    }
    val scheme = uri.scheme?.lowercase(java.util.Locale.ROOT)
    return (scheme == "http" || scheme == "https") && !uri.host.isNullOrEmpty()
}

private fun isChoice(element: JsonElement, allowed: Collection<String>): Boolean {
    val value = (element as? JsonPrimitive)?.takeIf { it.isString }?.content
    return value != null && value in allowed
}

private fun isNonBlankString(element: JsonElement): Boolean =
    (element as? JsonPrimitive)?.takeIf { it.isString }?.content?.isNotBlank() == true

private fun isPlainBoolean(element: JsonElement): Boolean =
    element is JsonPrimitive && !element.isString && element.booleanOrNull != null

private fun plainInt(element: JsonElement): Int? =
    (element as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull

// --- Compaction method order ------------------------------------------------

/**
 * The web's compaction-order control: checked methods in their order, then
 * every unchecked method below. Toggling appends a method to the end; moving
 * swaps a checked method with its checked neighbour only.
 */
fun toggleCompactionMethod(order: List<String>, method: String, enabled: Boolean): List<String> {
    val next = order.filter { it in COMPACTION_METHODS }.distinct().toMutableList()
    if (enabled) {
        if (method !in next) next += method
    } else {
        next -= method
    }
    return next
}

/** Moves [method] by [delta] positions inside the checked list; no-ops at the edge. */
fun moveCompactionMethod(order: List<String>, method: String, delta: Int): List<String> {
    val next = order.toMutableList()
    val index = next.indexOf(method)
    val target = index + delta
    if (index < 0 || target !in next.indices) return next
    val moved = next.removeAt(index)
    next.add(target, moved)
    return next
}

/** Checked first (in order), then unchecked methods in omp's menu order. */
fun compactionMethodRows(order: List<String>): List<Pair<String, Int>> {
    val checked = order.filter { it in COMPACTION_METHODS }.distinct()
    val rest = COMPACTION_METHODS.filter { it !in checked }
    return checked.mapIndexed { index, method -> method to index } + rest.map { it to -1 }
}

// --- Serialized save queue --------------------------------------------------

/**
 * The web's autosave drain (`saveNativeSettings`): edits are coalesced into
 * one pending snapshot, snapshots are PUT one at a time, and a failed PUT
 * discards the pending draft and keeps the last snapshot the server
 * confirmed — the UI then shows the truth instead of an unsaved edit.
 */
class NativeSettingsSaveQueue(initial: NativeSettingsDocument = NativeSettingsDocument()) {

    var confirmed: NativeSettingsDocument = initial
        private set

    private var draft: NativeSettingsDocument? = null
    private var sent: NativeSettingsDocument? = null

    /** The snapshot the UI shows: the pending edit, else the confirmed one. */
    val current: NativeSettingsDocument get() = draft ?: confirmed

    val hasPending: Boolean get() = draft != null

    /** Records a new snapshot; returns it so the caller can update its state. */
    fun edit(next: NativeSettingsDocument): NativeSettingsDocument {
        draft = next
        return next
    }

    /** Claims the current draft for sending (null when nothing is pending). */
    fun take(): NativeSettingsDocument? {
        val next = draft
        draft = null
        sent = next
        return next
    }

    /**
     * The server's canonical settings after a successful PUT. A draft created
     * while that PUT was in flight stays pending; a draft that was never sent
     * (a confirm without [take]) is superseded by the canonical snapshot.
     */
    fun confirm(server: NativeSettingsDocument) {
        confirmed = server
        if (sent == null) draft = null
        sent = null
    }

    /** Drops the pending draft and returns the last confirmed snapshot. */
    fun fail(): NativeSettingsDocument {
        draft = null
        sent = null
        return confirmed
    }
}

// --- MCP server JSON --------------------------------------------------------

/** The editor's starting text for a new server (web `newServer`). */
val NEW_MCP_SERVER_JSON: String = """
    {
      "type": "stdio",
      "command": "",
      "args": []
    }
""".trimIndent()

sealed interface McpServerParse {
    data class Valid(val server: JsonObject) : McpServerParse

    /** [message] is shown under the editor; a syntax error keeps the parser's wording. */
    data class Invalid(val message: String) : McpServerParse
}

private val McpEditorJson = kotlinx.serialization.json.Json

/** Parses the editor text: a JSON object is required (web `parse()`). */
fun parseMcpServerJson(text: String): McpServerParse {
    val element = try {
        McpEditorJson.parseToJsonElement(text)
    } catch (error: Exception) {
        val detail = error.message?.lineSequence()?.firstOrNull()?.take(200) ?: "syntax error"
        return McpServerParse.Invalid("Invalid JSON: $detail")
    }
    return if (element is JsonObject) McpServerParse.Valid(element)
    else McpServerParse.Invalid("Server configuration must be a JSON object")
}

/**
 * Mirrors `validateMcpServer` of `lib/omp/mcp-config.ts`: the first problem as
 * the server would word it, or null when `PUT /api/mcp` accepts the pair.
 */
fun validateMcpServer(name: String, server: JsonObject): String? {
    if (!OMP_RESOURCE_NAME_RE.matches(name)) {
        return "Server name may contain letters, numbers, dots, dashes, and underscores"
    }
    val type = server["type"]
    if (type != null && !isChoice(type, listOf("stdio", "http", "sse"))) {
        return "Server type must be stdio, http, or sse"
    }
    val typeName = (type as? JsonPrimitive)?.takeIf(::isPlainString)?.content
    val command = (server["command"] as? JsonPrimitive)?.takeIf(::isPlainString)?.content?.trim().orEmpty()
    val rawUrl = (server["url"] as? JsonPrimitive)?.takeIf(::isPlainString)?.content
    val url = rawUrl?.trim().orEmpty()
    val hasCommand = command.isNotEmpty()
    val hasUrl = url.isNotEmpty()
    if (hasCommand == hasUrl) return "Provide exactly one of command or url"
    if ((typeName == null || typeName == "stdio") && !hasCommand) return "A stdio server requires a command"
    if ((typeName == "http" || typeName == "sse") && !hasUrl) return "An HTTP or SSE server requires a URL"
    if (hasUrl && !isHttpUrl(rawUrl)) {
        return "Server URL must be an http or https URL"
    }
    server["args"]?.let { args ->
        val list = args as? JsonArray
        if (list == null || list.any { !isPlainString(it) }) return "args must be an array of strings"
    }
    server["env"]?.let { env ->
        val record = env as? JsonObject
        if (record == null || record.values.any { !isPlainString(it) }) return "env must map strings to strings"
    }
    server["headers"]?.let { headers ->
        val record = headers as? JsonObject
        if (record == null || record.values.any { !isPlainString(it) }) return "headers must map strings to strings"
    }
    server["cwd"]?.let { if (!isPlainString(it)) return "cwd must be a string" }
    server["enabled"]?.let { if (!isPlainBoolean(it)) return "enabled must be a boolean" }
    server["timeout"]?.let {
        val value = plainInt(it)
        if (value == null || value < 0 || value > 600_000) return "timeout must be an integer between 0 and 600000"
    }
    server["requestIdFormat"]?.let {
        if (!isChoice(it, listOf("number", "string"))) {
            return "requestIdFormat must be number or string"
        }
    }
    return null
}

/**
 * Summary shown next to a server row: type, target and whether the stored
 * config is usable (web `serverSummary`).
 */
data class McpServerSummary(val type: String, val target: String, val enabled: Boolean, val valid: Boolean)

fun summarizeMcpServer(server: JsonObject): McpServerSummary {
    val type = (server["type"] as? JsonPrimitive)?.takeIf(::isPlainString)?.content
        ?.takeIf { it != "stdio" } ?: "stdio"
    val command = (server["command"] as? JsonPrimitive)?.takeIf(::isPlainString)?.content?.trim().orEmpty()
    val url = (server["url"] as? JsonPrimitive)?.takeIf(::isPlainString)?.content?.trim().orEmpty()
    val hasCommand = command.isNotEmpty()
    val hasUrl = url.isNotEmpty()
    val valid = (hasCommand || hasUrl) && !(hasCommand && hasUrl) &&
        (if (type == "http" || type == "sse") hasUrl else hasCommand)
    val args = (server["args"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf(::isPlainString)?.content }
    val target = if (type == "http" || type == "sse") url
    else (command + args.orEmpty().joinToString("") { " $it" }).trim()
    val enabled = (server["enabled"] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull ?: true
    return McpServerSummary(type, target, enabled, valid)
}
