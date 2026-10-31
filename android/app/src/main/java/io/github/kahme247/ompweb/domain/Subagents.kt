package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Subagent roster + telemetry shared by the composer panels and the transcript
 * dialog (web `lib/subagent-types.ts`, `lib/subagent-format.ts`,
 * `lib/subagent-history.ts`).
 *
 * Every wire field is optional: omp payloads are parsed leniently and a
 * malformed frame is ignored rather than breaking the run.
 */

/** A subagent id as omp writes it into artifact filenames; rejects separators and `..`. */
val SUBAGENT_ID_RE = Regex("^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$")

/** The transcript route's id bound (server-side `SUBAGENT_ID_MAX_LENGTH`). */
const val SUBAGENT_ID_MAX_LENGTH = 100

/** Per-subagent live activity entries kept for the transcript dialog. */
const val SUBAGENT_ACTIVITY_BUFFER_MAX = 50

/**
 * Distinct subagent ids retained in the activity/version maps. Each per-id
 * list is capped, but a long turn can spawn unbounded ids (repeated or
 * recursive task calls), so the outer maps are bounded too.
 */
const val SUBAGENT_ACTIVITY_MAX_IDS = 64

/** Keep only the most recently inserted [SUBAGENT_ACTIVITY_MAX_IDS] entries. */
fun <T> pruneSubagentIds(map: Map<String, T>): Map<String, T> {
    if (map.size <= SUBAGENT_ACTIVITY_MAX_IDS) return map
    val keep = map.entries.drop(map.size - SUBAGENT_ACTIVITY_MAX_IDS)
    return LinkedHashMap<String, T>(keep.size).apply { keep.forEach { put(it.key, it.value) } }
}

/** True when [id] may address a subagent transcript (dotted ids included). */
fun isValidSubagentId(id: String): Boolean =
    id.length <= SUBAGENT_ID_MAX_LENGTH && SUBAGENT_ID_RE.matches(id)

enum class SubagentAgentSource(val wireName: String) {
    BUNDLED("bundled"),
    USER("user"),
    PROJECT("project"),
    ;

    companion object {
        fun fromWire(value: String?): SubagentAgentSource? =
            entries.firstOrNull { it.wireName == value }
    }
}

enum class SubagentStatus(val wireName: String) {
    STARTED("started"),
    COMPLETED("completed"),
    FAILED("failed"),
    ABORTED("aborted"),
    ;

    companion object {
        /** Roster statuses only; `pending`/`running` map to [STARTED] separately. */
        fun fromWire(value: String?): SubagentStatus? = entries.firstOrNull { it.wireName == value }
    }
}

enum class SubagentSource { LIVE, HISTORY }

/** Snapshot statuses that mean "running" on the wire. */
private fun snapshotStatus(value: String?): SubagentStatus? = when (value) {
    "pending", "running" -> SubagentStatus.STARTED
    else -> SubagentStatus.fromWire(value)
}

data class SubagentRetryState(
    val attempt: Int,
    val maxAttempts: Int,
    val delayMs: Long,
    val errorMessage: String,
    val startedAtMs: Long,
)

data class SubagentRetryFailure(val attempt: Int, val errorMessage: String)

/** Live per-subagent progress snapshot (oh-my-pi `AgentProgress`). */
data class SubagentProgress(
    val index: Int? = null,
    val id: String? = null,
    val agent: String? = null,
    val agentSource: SubagentAgentSource? = null,
    val status: SubagentStatus? = null,
    val task: String? = null,
    val assignment: String? = null,
    val description: String? = null,
    val lastIntent: String? = null,
    val currentTool: String? = null,
    val tokens: Long? = null,
    val contextTokens: Long? = null,
    val contextWindow: Long? = null,
    val cost: Double? = null,
    val durationMs: Long? = null,
    val resolvedModel: String? = null,
    val retryState: SubagentRetryState? = null,
    val retryFailure: SubagentRetryFailure? = null,
    val inflightTaskDetails: JsonElement? = null,
    val extractedToolData: Map<String, JsonArray>? = null,
)

/** Settled result of a subagent run, as the session file records it. */
data class SubagentResult(
    val error: String? = null,
    val abortReason: String? = null,
)

/**
 * One roster entry. [batchSeq] is the ordinal of the spawning `task` call as
 * the session file recorded it; only history entries carry it, so live frames
 * sort after the calls the file already knows.
 */
data class SubagentInfo(
    val id: String,
    val agent: String,
    val status: SubagentStatus,
    val index: Int,
    val agentSource: SubagentAgentSource? = null,
    val description: String? = null,
    val task: String? = null,
    val assignment: String? = null,
    val sessionFile: String? = null,
    val parentToolCallId: String? = null,
    val detached: Boolean? = null,
    val progress: SubagentProgress? = null,
    val lastUpdate: Long? = null,
    val result: SubagentResult? = null,
    val source: SubagentSource = SubagentSource.LIVE,
    val batchSeq: Int? = null,
) {
    val running: Boolean
        get() = source != SubagentSource.HISTORY && status == SubagentStatus.STARTED

    /** The task line a chip shows; assignment is the prompt, task the headline. */
    val headline: String?
        get() = task ?: description ?: assignment
}

enum class SubagentActivityKind { TOOL, TEXT, NOTICE }

/** A compact live-activity entry derived from a `subagent_event` frame. */
data class SubagentActivityEvent(val kind: SubagentActivityKind, val label: String, val ts: Long)

/** True when [id] can address an artifact inside the artifacts directory. */
private fun JsonObject.stringOrNull(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject.intOrNull(key: String): Int? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString.not() }?.intOrNull

private fun JsonObject.longOrNull(key: String): Long? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString.not() }?.longOrNull

private fun JsonObject.doubleOrNull(key: String): Double? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString.not() }?.doubleOrNull

private fun JsonObject.boolOrNull(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString.not() }?.booleanOrNull

private fun JsonObject.objOrNull(key: String): JsonObject? = this[key] as? JsonObject

/** Defensively copy an `AgentProgress`-shaped object; null when it carries nothing. */
fun parseSubagentProgress(element: JsonElement?): SubagentProgress? {
    val value = element as? JsonObject ?: return null
    val out = SubagentProgress(
        index = value.intOrNull("index"),
        id = value.stringOrNull("id"),
        agent = value.stringOrNull("agent"),
        agentSource = SubagentAgentSource.fromWire(value.stringOrNull("agentSource")),
        status = snapshotStatus(value.stringOrNull("status")),
        task = value.stringOrNull("task"),
        assignment = value.stringOrNull("assignment"),
        description = value.stringOrNull("description"),
        lastIntent = value.stringOrNull("lastIntent"),
        currentTool = value.stringOrNull("currentTool"),
        tokens = value.longOrNull("tokens"),
        contextTokens = value.longOrNull("contextTokens"),
        contextWindow = value.longOrNull("contextWindow"),
        cost = value.doubleOrNull("cost"),
        durationMs = value.longOrNull("durationMs"),
        resolvedModel = value.stringOrNull("resolvedModel"),
        inflightTaskDetails = value["inflightTaskDetails"],
        extractedToolData = (value.objOrNull("extractedToolData"))?.let { data ->
            data.mapNotNull { (key, entry) -> (entry as? JsonArray)?.let { key to it } }.toMap()
        }?.takeIf { it.isNotEmpty() },
    )
    // All retry fields are documented as required upstream; fabricating
    // defaults for a partial frame would render a false "retrying" state.
    val retryState = value.objOrNull("retryState")?.let { retry ->
        val attempt = retry.intOrNull("attempt")
        val maxAttempts = retry.intOrNull("maxAttempts")
        val delayMs = retry.longOrNull("delayMs")
        val errorMessage = retry.stringOrNull("errorMessage")
        val startedAtMs = retry.longOrNull("startedAtMs")
        if (attempt != null && maxAttempts != null && delayMs != null &&
            errorMessage != null && startedAtMs != null
        ) {
            SubagentRetryState(attempt, maxAttempts, delayMs, errorMessage, startedAtMs)
        } else {
            null
        }
    }
    val failure = value.objOrNull("retryFailure")?.let { failureRaw ->
        val attempt = failureRaw.intOrNull("attempt")
        val message = failureRaw.stringOrNull("errorMessage")
        if (attempt != null && message != null) SubagentRetryFailure(attempt, message) else null
    }
    val filled = out.copy(retryState = retryState, retryFailure = failure)
    return if (filled == SubagentProgress()) null else filled
}

/** Map a `get_subagents` snapshot to roster form (live source). */
fun parseSubagentSnapshot(element: JsonElement?, now: Long): SubagentInfo? {
    val value = element as? JsonObject ?: return null
    val id = value.stringOrNull("id")?.takeIf { it.isNotEmpty() } ?: return null
    val agent = value.stringOrNull("agent")?.takeIf { it.isNotEmpty() } ?: return null
    // An unknown/future lifecycle status must not fabricate a live chip.
    val status = snapshotStatus(value.stringOrNull("status")) ?: return null
    return SubagentInfo(
        id = id,
        agent = agent,
        status = status,
        index = value.intOrNull("index") ?: -1,
        agentSource = SubagentAgentSource.fromWire(value.stringOrNull("agentSource")),
        description = value.stringOrNull("description"),
        task = value.stringOrNull("task"),
        assignment = value.stringOrNull("assignment"),
        sessionFile = value.stringOrNull("sessionFile"),
        parentToolCallId = value.stringOrNull("parentToolCallId"),
        progress = parseSubagentProgress(value["progress"]),
        // A missing lastUpdate would read as infinitely new and let back-to-back
        // stale snapshots regress a terminal status; stamp the read time.
        lastUpdate = value.longOrNull("lastUpdate") ?: now,
        source = SubagentSource.LIVE,
    )
}

/**
 * Map a `subagent_lifecycle` payload. Stricter than a snapshot: requires id +
 * status, and a missing `agent` defaults to `"subagent"`.
 */
fun parseSubagentLifecycle(element: JsonElement?, now: Long): SubagentInfo? {
    val value = element as? JsonObject ?: return null
    val id = value.stringOrNull("id")?.takeIf { it.isNotEmpty() } ?: return null
    val status = SubagentStatus.fromWire(value.stringOrNull("status")) ?: return null
    return SubagentInfo(
        id = id,
        agent = value.stringOrNull("agent") ?: "subagent",
        status = status,
        index = value.intOrNull("index") ?: -1,
        agentSource = SubagentAgentSource.fromWire(value.stringOrNull("agentSource")),
        description = value.stringOrNull("description"),
        sessionFile = value.stringOrNull("sessionFile"),
        parentToolCallId = value.stringOrNull("parentToolCallId"),
        detached = value.boolOrNull("detached"),
        lastUpdate = now,
        source = SubagentSource.LIVE,
    )
}

/** Extract a compact live-activity entry from a `subagent_event` payload. */
fun parseSubagentActivityEvent(element: JsonElement?, now: Long): SubagentActivityEvent? {
    val payload = element as? JsonObject ?: return null
    val event = payload.objOrNull("event") ?: return null
    when (event.stringOrNull("type")) {
        "tool_execution_start" -> {
            val toolName = event.stringOrNull("toolName") ?: "tool"
            val intent = event.stringOrNull("intent")?.trim()
            if (!intent.isNullOrEmpty()) {
                return SubagentActivityEvent(SubagentActivityKind.TOOL, "→ $toolName — $intent", now)
            }
            val args = (event["args"] as? JsonObject)?.keys?.take(3)?.joinToString(", ")
            val label = if (args.isNullOrEmpty()) "→ $toolName" else "→ $toolName ($args)"
            return SubagentActivityEvent(SubagentActivityKind.TOOL, label, now)
        }

        "message_end" -> {
            val message = event.objOrNull("message") ?: return null
            if (message.stringOrNull("role") != "assistant") return null
            val text = assistantText(message["content"]).trim()
            if (text.isEmpty()) return null
            return SubagentActivityEvent(SubagentActivityKind.TEXT, text.take(140), now)
        }

        "notice" -> {
            val message = event.stringOrNull("message") ?: return null
            return SubagentActivityEvent(SubagentActivityKind.NOTICE, message.take(140), now)
        }
    }
    return null
}

private fun assistantText(content: JsonElement?): String = when (content) {
    is JsonPrimitive -> content.contentOrNull.orEmpty()
    is JsonArray -> content.mapNotNull { block ->
        val obj = block as? JsonObject ?: return@mapNotNull null
        if (obj.stringOrNull("type") == "text") obj.stringOrNull("text") else null
    }.joinToString("\n")
    else -> ""
}

/**
 * Map an on-disk history entry (`GET /api/sessions/{id}/subagents`) to roster
 * form. Flat telemetry fields become the same [SubagentProgress] the live
 * frames carry, so chips render identically from either source.
 */
fun parseSubagentHistoryEntry(element: JsonElement?): SubagentInfo? {
    val value = element as? JsonObject ?: return null
    val id = value.stringOrNull("id")?.takeIf { it.isNotEmpty() } ?: return null
    val agent = value.stringOrNull("agent")?.takeIf { it.isNotEmpty() } ?: return null
    val status = SubagentStatus.fromWire(value.stringOrNull("status")) ?: return null
    val retryFailure = value.objOrNull("retryFailure")?.let { raw ->
        val attempt = raw.intOrNull("attempt")
        val message = raw.stringOrNull("errorMessage")
        if (attempt != null && message != null) SubagentRetryFailure(attempt, message) else null
    }
    val progress = SubagentProgress(
        id = id,
        agent = agent,
        agentSource = SubagentAgentSource.fromWire(value.stringOrNull("agentSource")),
        status = status,
        task = value.stringOrNull("task"),
        assignment = value.stringOrNull("assignment"),
        description = value.stringOrNull("description"),
        lastIntent = value.stringOrNull("lastIntent"),
        tokens = value.longOrNull("tokens"),
        contextTokens = value.longOrNull("contextTokens"),
        contextWindow = value.longOrNull("contextWindow"),
        cost = value.doubleOrNull("cost"),
        durationMs = value.longOrNull("durationMs"),
        resolvedModel = value.stringOrNull("resolvedModel"),
        retryFailure = retryFailure,
    )
    val result = value.objOrNull("result")?.let { raw ->
        SubagentResult(
            error = raw.stringOrNull("error"),
            abortReason = raw.stringOrNull("abortReason"),
        )
    }
    return SubagentInfo(
        id = id,
        agent = agent,
        status = status,
        index = value.intOrNull("index") ?: -1,
        agentSource = progress.agentSource,
        description = progress.description,
        task = progress.task,
        assignment = progress.assignment,
        sessionFile = value.stringOrNull("sessionFile"),
        parentToolCallId = value.stringOrNull("parentToolCallId"),
        detached = value.boolOrNull("detached"),
        progress = if (progress == SubagentProgress()) null else progress,
        result = result,
        source = SubagentSource.HISTORY,
        batchSeq = value.intOrNull("batchSeq"),
    )
}

/** Ordinal for sorting: a batch the file has not recorded yet sorts last. */
private fun batchSeqOf(subagent: SubagentInfo): Int = subagent.batchSeq ?: Int.MAX_VALUE

/** Spawning call first, then position inside that call, then id. */
fun compareSubagents(a: SubagentInfo, b: SubagentInfo): Int {
    batchSeqOf(a).compareTo(batchSeqOf(b)).let { if (it != 0) return it }
    a.index.compareTo(b.index).let { if (it != 0) return it }
    return a.id.compareTo(b.id)
}

/**
 * Fold [incoming] into [prev], ordered by spawning call then position ([prev]'s
 * slot for an existing id is kept, never replaced by list position).
 *
 * Live frames win over on-disk history for the same id; `skipNewerThan` refuses
 * to overwrite entries live frames touched after a point-in-time snapshot was
 * requested, so a stale snapshot cannot regress a child's terminal status.
 * `batchSeq` survives every precedence rule: only the session file knows the
 * launch order, and the history entry carrying it often loses to a newer live
 * frame.
 */
fun mergeSubagentRoster(
    prev: List<SubagentInfo>,
    incoming: List<SubagentInfo>,
    skipNewerThan: Long? = null,
): List<SubagentInfo> {
    val byId = LinkedHashMap<String, SubagentInfo>(prev.size)
    prev.forEach { byId[it.id] = it }
    for (entry in incoming) {
        val existing = byId[entry.id]
        if (existing == null) {
            byId[entry.id] = entry
            continue
        }
        val batchSeq = existing.batchSeq ?: entry.batchSeq
        if (skipNewerThan != null && (existing.lastUpdate ?: 0L) >= skipNewerThan) {
            if (batchSeq != existing.batchSeq) byId[entry.id] = existing.copy(batchSeq = batchSeq)
            continue
        }
        if (entry.source == SubagentSource.HISTORY && existing.source != SubagentSource.HISTORY) {
            if (batchSeq != existing.batchSeq) byId[entry.id] = existing.copy(batchSeq = batchSeq)
            continue
        }
        if (entry.source != SubagentSource.HISTORY && existing.source == SubagentSource.HISTORY) {
            byId[entry.id] = entry.copy(batchSeq = batchSeq)
            continue
        }
        byId[entry.id] = mergeFields(existing, entry).copy(batchSeq = batchSeq)
    }
    return byId.values.sortedWith(Comparator(::compareSubagents))
}

/** Field-wise replacement: an absent (null) incoming field never erases data. */
private fun mergeFields(existing: SubagentInfo, entry: SubagentInfo): SubagentInfo = existing.copy(
    agent = entry.agent.ifBlank { existing.agent },
    status = entry.status,
    index = if (entry.index >= 0) entry.index else existing.index,
    agentSource = entry.agentSource ?: existing.agentSource,
    description = entry.description ?: existing.description,
    task = entry.task ?: existing.task,
    assignment = entry.assignment ?: existing.assignment,
    sessionFile = entry.sessionFile ?: existing.sessionFile,
    parentToolCallId = entry.parentToolCallId ?: existing.parentToolCallId,
    detached = entry.detached ?: existing.detached,
    progress = entry.progress ?: existing.progress,
    lastUpdate = entry.lastUpdate ?: existing.lastUpdate,
    result = entry.result ?: existing.result,
    source = entry.source,
)

/** Count of nested (grandchild) subagents an agent currently has in flight. */
fun countNestedSubagents(progress: SubagentProgress?): Int {
    if (progress == null) return 0
    var count = 0
    (progress.inflightTaskDetails as? JsonObject)?.let { details ->
        count += (details["progress"] as? JsonArray)?.size ?: 0
    }
    // Upstream records one TaskToolDetails per task call:
    // extractedToolData.task = [TaskToolDetails], each with progress[].
    progress.extractedToolData?.get("task")?.forEach { item ->
        val details = item as? JsonObject ?: return@forEach
        count += (details["progress"] as? JsonArray)?.size ?: 0
    }
    return count
}

/** One raw message of a subagent transcript page (`get_subagent_messages`). */
data class SubagentTranscriptMessage(
    val role: String,
    /** Blocks already flattened into the dialog's single text column. */
    val text: String,
)

/** One `get_subagent_messages` / disk-fallback page (web `SubagentMessagesPage`). */
data class SubagentTranscriptPage(
    val sessionFile: String?,
    val fromByte: Long,
    val nextByte: Long,
    val reset: Boolean,
    val totalBytes: Long?,
    val messages: List<SubagentTranscriptMessage>,
) {
    /** No further bytes exist: the pager hides "Load more" (web rule). */
    val exhausted: Boolean
        get() = if (totalBytes != null) nextByte >= totalBytes else messages.isEmpty()
}

/** Web `SubagentTranscriptRow`: labels a raw child message for the transcript. */
fun parseSubagentTranscriptPage(element: JsonElement?): SubagentTranscriptPage? {
    val value = element as? JsonObject ?: return null
    val fromByte = value.longOrNull("fromByte") ?: 0L
    val nextByte = value.longOrNull("nextByte") ?: fromByte
    val messages = (value["messages"] as? JsonArray)
        ?.mapNotNull { parseSubagentTranscriptMessage(it) }
        .orEmpty()
    return SubagentTranscriptPage(
        sessionFile = value.stringOrNull("sessionFile"),
        fromByte = fromByte,
        nextByte = nextByte,
        reset = value.boolOrNull("reset") == true,
        totalBytes = value.longOrNull("totalBytes"),
        messages = messages,
    )
}

private const val TRANSCRIPT_TEXT_LIMIT = 400

private fun parseSubagentTranscriptMessage(element: JsonElement): SubagentTranscriptMessage? {
    val value = element as? JsonObject ?: return null
    val role = value.stringOrNull("role") ?: return null
    val raw = value["content"]
    val blocks: List<JsonElement> = when {
        raw is JsonArray -> raw
        raw is JsonPrimitive && raw.isString -> listOf(raw)
        else -> emptyList()
    }
    fun textOf(block: JsonElement): String? {
        val obj = block as? JsonObject ?: return null
        if ((obj.stringOrNull("type") ?: "") != "text") return null
        return obj.stringOrNull("text")
    }
    val joined = blocks.mapNotNull(::textOf).joinToString("\n")
    val isError = value.boolOrNull("isError") == true
    val text = if (role == "assistant" && raw is JsonArray) {
        // Assistant turns interleave prose and tool calls in source order.
        blocks.joinToString("\n") { block ->
            val obj = block as? JsonObject ?: return@joinToString ""
            when (obj.stringOrNull("type")) {
                "toolCall" -> "→ ${obj.stringOrNull("toolName") ?: "tool"} " + (obj["input"]?.toString() ?: "{}")
                "text" -> obj.stringOrNull("text").orEmpty()
                else -> ""
            }
        }
    } else {
        joined.take(TRANSCRIPT_TEXT_LIMIT)
    }
    val body = when {
        text.isNotEmpty() -> text
        role == "user" || role == "assistant" -> ""
        isError -> "(error)"
        else -> "(no output)"
    }
    return SubagentTranscriptMessage(role = role, text = body)
}
