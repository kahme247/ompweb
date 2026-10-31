package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.ContextUsageInfo
import io.github.kahme247.ompweb.domain.SessionStats
import io.github.kahme247.ompweb.domain.SessionTokenTotals
import io.github.kahme247.ompweb.domain.ThinkingModelMeta
import io.github.kahme247.ompweb.domain.UsageLimit
import io.github.kahme247.ompweb.domain.parseContextUsage
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The server calls the composer controls (model, thinking, fast/slow, advisor,
 * usage, context sheet, word prediction) make, as an interface so the view
 * model runs in JVM tests without a server.
 *
 * [ApiClient] implements it: [models] and [agentState] already exist, and
 * [agentCommand] is the public form of its private `sendAgentCommand` (the
 * `?advisor=1` query is the wrapper's spawn flag, see `lib/agent-client.ts`).
 */
interface ComposerControlsApi {

    /** `GET /api/models?cwd=` — the live model catalog the picker builds its rows from. */
    suspend fun models(cwd: String?): ModelsResponse

    /** `GET /api/agent/{id}` — `{running, state}`; never spawns a process. */
    suspend fun agentState(sessionId: String): JsonObject

    /**
     * `POST /api/agent/{id}` — one omp RPC command, returning the route's
     * `data` field. [advisor] appends `?advisor=1`, the spawn flag carried by
     * every command of a session whose advisor toggle is on. [force] appends
     * `?force=1`, which skips the server's gate against a session another omp
     * process owns — only used after the user confirmed that the send goes
     * into a copy.
     */
    suspend fun agentCommand(
        sessionId: String,
        command: JsonObject,
        advisor: Boolean = false,
        force: Boolean = false,
    ): JsonElement?
}

/** The composer-relevant slice of `WebSessionState` / `get_state`. */
data class AgentConfigSnapshot(
    val model: ThinkingModelMeta? = null,
    val thinkingLevel: String? = null,
    val fastModeEnabled: Boolean? = null,
    val fastModeActive: Boolean? = null,
    val slowModeSupported: Boolean? = null,
    val slowModeEnabled: Boolean? = null,
    val slowModeScope: String? = null,
    val usageLimit: UsageLimit? = null,
    val contextUsage: ContextUsageInfo? = null,
    val tokensPerSecond: Double? = null,
    val isCompacting: Boolean? = null,
)

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

private fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject

/** Read `model` (`OmpModel` shape: `id`, `provider`, `name`, `reasoning`, `thinking.efforts`). */
fun parseThinkingModel(element: JsonElement?): ThinkingModelMeta? {
    val root = element as? JsonObject ?: return null
    val provider = root.string("provider") ?: return null
    val id = root.string("id") ?: root.string("modelId") ?: return null
    val efforts = root.obj("thinking")?.get("efforts") as? JsonArray
    return ThinkingModelMeta(
        provider = provider,
        modelId = id,
        name = root.string("name"),
        reasoning = root.bool("reasoning"),
        efforts = efforts?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull },
    )
}

/** Read `usageLimit` (`{stage:"low_priority"|"wrap_up", …}`); unknown stages are ignored. */
fun parseUsageLimit(element: JsonElement?): UsageLimit? {
    val root = element as? JsonObject ?: return null
    val stage = when (root.string("stage")) {
        "low_priority" -> UsageLimit.Stage.LOW_PRIORITY
        "wrap_up" -> UsageLimit.Stage.WRAP_UP
        else -> return null
    }
    return UsageLimit(
        stage = stage,
        resetsAtSec = root.number("resetsAtSec")?.toLong(),
        allowanceLeftPercent = root.number("allowanceLeftPercent"),
        extraUsage = root.bool("extraUsage") == true,
    )
}

/**
 * Parse one `WebSessionState`. Accepts the bare state object as well as the
 * `{running, state}` envelope `GET /api/agent/{id}` returns, so a caller can
 * hand over whichever object it already holds.
 */
fun parseAgentConfig(payload: JsonObject): AgentConfigSnapshot {
    val state = (payload["state"] as? JsonObject) ?: payload
    return AgentConfigSnapshot(
        model = parseThinkingModel(state["model"]),
        thinkingLevel = state.string("thinkingLevel"),
        fastModeEnabled = state.bool("fastModeEnabled"),
        fastModeActive = state.bool("fastModeActive"),
        slowModeSupported = state.bool("slowModeSupported"),
        slowModeEnabled = state.bool("slowModeEnabled"),
        slowModeScope = state.string("slowModeScope"),
        usageLimit = parseUsageLimit(state["usageLimit"]),
        contextUsage = parseContextUsage(state["contextUsage"]),
        tokensPerSecond = state.number("tokensPerSecond"),
        isCompacting = state.bool("isCompacting"),
    )
}

/** Parse the `get_session_stats` answer (`SessionStatsInfo`, plus `sessionName`). */
fun parseSessionStats(payload: JsonElement?): SessionStats? {
    val root = payload as? JsonObject ?: return null
    val sessionId = root.string("sessionId") ?: return null
    val tokens = root.obj("tokens")
    return SessionStats(
        sessionId = sessionId,
        sessionFile = root.string("sessionFile"),
        sessionName = root.string("sessionName"),
        userMessages = root.int("userMessages") ?: 0,
        assistantMessages = root.int("assistantMessages") ?: 0,
        toolCalls = root.int("toolCalls") ?: 0,
        toolResults = root.int("toolResults") ?: 0,
        totalMessages = root.int("totalMessages") ?: 0,
        tokens = SessionTokenTotals(
            input = tokens?.int("input") ?: 0,
            output = tokens?.int("output") ?: 0,
            cacheRead = tokens?.int("cacheRead") ?: 0,
            cacheWrite = tokens?.int("cacheWrite") ?: 0,
            total = tokens?.int("total") ?: 0,
        ),
        cost = root.number("cost") ?: 0.0,
        contextUsage = parseContextUsage(root["contextUsage"]),
    )
}

/** The `predict_word` answer's suffix (`{suffix: null}` when omp has nothing). */
fun parsePredictedSuffix(payload: JsonElement?): String? {
    val root = payload as? JsonObject ?: return null
    return root.string("suffix")?.takeIf { it.isNotEmpty() }
}
