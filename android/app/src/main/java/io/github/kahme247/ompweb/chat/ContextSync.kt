package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull

/** Durable display-history position scoped to one session and selected view. */
data class HistoryCursor(val firstEntryId: String?, val lastEntryId: String?)

/** Ordering within one web-owned RPC process; resets when that process changes. */
data class StreamCursor(val streamId: String, val sequence: Long)

/**
 * The live half of a context response. Only applied for sequence-newer
 * fields; the transcript and the live tool state must not overwrite each
 * other (web: `hooks/useAgentSession-sync.ts` + `useAgentSession.ts:2555`).
 */
data class LiveSnapshot(
    val cursor: StreamCursor?,
    val isStreaming: Boolean,
    val isPromptRunning: Boolean,
    val isCompacting: Boolean,
    val streamingMessage: ChatMessage.Assistant?,
    val toolEvents: List<LiveToolEvent>,
    val responseObserved: Boolean,
)

data class LiveToolEvent(
    val type: String,
    val toolCallId: String,
    val toolName: String?,
    val args: JsonObject?,
    val result: ChatMessage.ToolResult?,
    val isError: Boolean,
)

/** One parsed `GET /api/sessions/{id}/context?sync=1` page. */
data class ContextPage(
    val mode: String,
    val baseEntryId: String?,
    val cursor: HistoryCursor?,
    val hasMore: Boolean,
    val sessionId: String?,
    val leafId: String?,
    val thinkingLevel: String?,
    val model: ModelRef?,
    val entryIds: List<String>,
    val messages: List<ChatMessage>,
    val live: LiveSnapshot?,
    /** The plan omp derives from the session file; applied while no run is active. */
    val todoPhases: List<io.github.kahme247.ompweb.domain.TodoPhase> = emptyList(),
)

object ContextSync {

    fun parse(root: JsonObject): ContextPage {
        val context = root.obj("context")
        val entryIds = (context?.array("entryIds") ?: JsonArray(emptyList()))
            .mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull }
        val messages = ArrayList<ChatMessage>()
        val rawMessages = context?.array("messages") ?: JsonArray(emptyList())
        for (index in rawMessages.indices) {
            val raw = rawMessages[index] as? JsonObject ?: continue
            val entryId = entryIds.getOrNull(index)
            val message = parseChatMessage(raw, entryId, syntheticKey = "ctx:$index")
            if (message != null) messages += message
        }
        // A malformed page would misalign ids and messages; the caller rejects it.
        val aligned = messages.size == entryIds.size
        val cursor = root.obj("cursor")?.let {
            HistoryCursor(it.string("firstEntryId"), it.string("lastEntryId"))
        }
        return ContextPage(
            mode = root.string("mode") ?: "replace",
            baseEntryId = root.string("baseEntryId"),
            cursor = cursor,
            hasMore = root.bool("hasMore") == true,
            sessionId = root.string("sessionId"),
            leafId = root.string("leafId"),
            thinkingLevel = context?.string("thinkingLevel"),
            model = context?.obj("model")?.let {
                ModelRef(
                    provider = it.string("provider") ?: "",
                    id = it.string("modelId") ?: it.string("id") ?: "",
                    name = it.string("name"),
                )
            },
            entryIds = if (aligned) entryIds else emptyList(),
            messages = if (aligned) messages else emptyList(),
            live = parseLive(root.obj("live")),
            todoPhases = io.github.kahme247.ompweb.domain.parseTodoPhases(context?.get("todoPhases")),
        )
    }

    private fun parseLive(live: JsonObject?): LiveSnapshot? {
        if (live == null) return null
        val cursor = live.obj("cursor")?.let {
            val streamId = it.string("streamId") ?: return@let null
            StreamCursor(streamId, it.long("sequence") ?: 0L)
        }
        val streaming = live.obj("streamingMessage")?.let {
            parseChatMessage(it, entryId = null, syntheticKey = "live:stream") as? ChatMessage.Assistant
        }?.copy(streaming = true)
        val toolEvents = live.array("toolEvents")?.mapNotNull { element ->
            val event = element as? JsonObject ?: return@mapNotNull null
            val id = event.string("toolCallId") ?: return@mapNotNull null
            val type = event.string("type") ?: return@mapNotNull null
            val partial = event.obj("partialResult")?.let {
                parseToolResultPayload(it, "live:tool:$id")?.copy(partial = true)
            }
            val result = event.obj("result")?.let {
                parseToolResultPayload(it, "live:tool:$id")
            }
            LiveToolEvent(
                type = type,
                toolCallId = id,
                toolName = event.string("toolName"),
                args = event.obj("args"),
                result = partial ?: result,
                isError = event.bool("isError") == true,
            )
        } ?: emptyList()
        return LiveSnapshot(
            cursor = cursor,
            isStreaming = live.bool("isStreaming") == true,
            isPromptRunning = live.bool("isPromptRunning") == true,
            isCompacting = live.bool("isCompacting") == true,
            streamingMessage = streaming,
            toolEvents = toolEvents,
            responseObserved = live.bool("responseObserved") == true,
        )
    }
}
