package io.github.kahme247.ompweb.chat

/**
 * Lightweight transcript row planner (web: `lib/chat-transcript-plan.ts`).
 *
 * A user message (or a compaction summary) anchors a turn. The turn renders
 * as its anchor followed by text segments; runs of activity between text
 * (thinking, tool calls, notices) fold into one collapsed "Process details"
 * row. Text is never hidden, so an answer stays visible while its tools fold
 * away.
 */
sealed interface TranscriptRow {
    val key: String

    /** A message rendered on its own (before the first anchor, or a turn with nothing to fold). */
    data class Message(val message: ChatMessage) : TranscriptRow {
        override val key: String = "message:${message.key}"
    }

    data class Group(
        val anchor: ChatMessage,
        val anchorIndex: Int,
        val endIndex: Int,
        val segments: List<TurnSegment>,
    ) : TranscriptRow {
        override val key: String = "turn:${anchor.key}"
    }
}

sealed interface TurnSegment {
    /** Visible assistant text/images from one message; `last` carries usage and the error. */
    data class Text(
        val message: ChatMessage.Assistant,
        val messageIndex: Int,
        val blocks: List<AssistantBlock>,
        val last: Boolean,
        val key: String,
    ) : TurnSegment

    data class Activity(
        val pieces: List<ActivityPiece>,
        val stepCount: Int,
        val toolCallCount: Int,
        val key: String,
    ) : TurnSegment
}

/**
 * A folded activity entry: the listed blocks of an assistant message, or a
 * whole non-assistant message.
 */
data class ActivityPiece(
    val message: ChatMessage,
    val index: Int,
    val blocks: List<AssistantBlock>? = null,
)

const val PASSIVE_TOOL_CONTEXT = "passive-tool-context"
const val MOUNT_NOTICE = "xdev-mount-notice"

object TranscriptPlan {

    fun isGroupAnchor(message: ChatMessage): Boolean =
        message is ChatMessage.User ||
            (message is ChatMessage.Custom && message.customType == "compaction")

    fun build(messages: List<ChatMessage>, hideThinking: Boolean = false): List<TranscriptRow> {
        val rows = ArrayList<TranscriptRow>()
        var index = 0
        while (index < messages.size) {
            val anchor = messages[index]
            if (!isGroupAnchor(anchor)) {
                rows += TranscriptRow.Message(anchor)
                index += 1
                continue
            }
            val end = turnEnd(messages, index)
            val segments = planTurnSegments(messages, index, end, hideThinking)
            if (segments.any { it is TurnSegment.Activity }) {
                rows += TranscriptRow.Group(anchor, index, end, segments)
            } else {
                // Nothing to fold: render anchor and the rest as standalone messages.
                for (renderIndex in index until end) rows += TranscriptRow.Message(messages[renderIndex])
            }
            index = end
        }
        return rows
    }

    private fun turnEnd(messages: List<ChatMessage>, start: Int): Int {
        var end = start + 1
        while (end < messages.size && !isGroupAnchor(messages[end])) end += 1
        return end
    }

    fun planTurnSegments(
        messages: List<ChatMessage>,
        anchorIndex: Int,
        endIndex: Int,
        hideThinking: Boolean = false,
    ): List<TurnSegment> {
        val segments = ArrayList<TurnSegment>()
        val anchorKey = messages[anchorIndex].key
        var activityIndex = -1

        fun addActivity(piece: ActivityPiece, toolCalls: Int) {
            if (activityIndex < 0) {
                activityIndex = segments.size
                segments += TurnSegment.Activity(
                    pieces = emptyList(),
                    stepCount = 0,
                    toolCallCount = 0,
                    key = "activity:$anchorKey:$activityIndex",
                )
            }
            val current = segments[activityIndex] as TurnSegment.Activity
            segments[activityIndex] = current.copy(
                pieces = current.pieces + piece,
                stepCount = current.stepCount + 1,
                toolCallCount = current.toolCallCount + toolCalls,
            )
        }

        for (index in anchorIndex + 1 until endIndex) {
            val message = messages[index]
            // Tool results render inline under their tool call inside the fold.
            if (message is ChatMessage.ToolResult) continue
            // Mount notices never render; passive tool context rides on its tool card.
            if (message is ChatMessage.Custom && (message.customType == MOUNT_NOTICE || message.customType == PASSIVE_TOOL_CONTEXT)) continue
            if (message !is ChatMessage.Assistant) {
                addActivity(ActivityPiece(message, index), 0)
                continue
            }
            var blocks = displayableBlocks(message)
            if (hideThinking) blocks = blocks.filter { it !is AssistantBlock.Thinking }
            var lastTextIndex = -1
            var text = ArrayList<AssistantBlock>()
            var other = ArrayList<AssistantBlock>()

            fun flushText() {
                if (text.isEmpty()) return
                lastTextIndex = segments.size
                segments += TurnSegment.Text(
                    message = message,
                    messageIndex = index,
                    blocks = text,
                    last = false,
                    key = "text:${message.key}:$lastTextIndex",
                )
                activityIndex = -1
                text = ArrayList()
            }

            fun flushOther() {
                if (other.isEmpty()) return
                addActivity(
                    ActivityPiece(message, index, other),
                    other.count { it is AssistantBlock.ToolCall },
                )
                other = ArrayList()
            }

            for (block in blocks) {
                when {
                    block is AssistantBlock.Image ||
                        (block is AssistantBlock.Text && block.text.trim().isNotEmpty()) -> {
                        flushOther()
                        text += block
                    }
                    block !is AssistantBlock.Text -> {
                        flushText()
                        other += block
                    }
                }
            }
            flushText()
            flushOther()
            // A provider error must stay visible even when the message ended in activity.
            if (!message.errorMessage.isNullOrBlank() && segments.lastIndex != lastTextIndex) {
                lastTextIndex = segments.size
                segments += TurnSegment.Text(
                    message = message,
                    messageIndex = index,
                    blocks = emptyList(),
                    last = false,
                    key = "text:${message.key}:$lastTextIndex",
                )
                activityIndex = -1
            }
            if (lastTextIndex >= 0 && segments.lastIndex == lastTextIndex) {
                val segment = segments[lastTextIndex] as TurnSegment.Text
                segments[lastTextIndex] = segment.copy(last = true)
            }
        }
        return segments
    }

    /** Drop placeholder thinking blocks the server did not send with content. */
    fun displayableBlocks(message: ChatMessage.Assistant): List<AssistantBlock> =
        message.blocks.filterNot { block ->
            block is AssistantBlock.Thinking && !block.deferred && !message.streaming && block.thinking.isBlank()
        }

    /**
     * Index committed tool results by tool call id and attach each passive
     * developer context to the last tool call of the batch it follows.
     */
    fun collectToolResults(messages: List<ChatMessage>): Map<String, ChatMessage.ToolResult> {
        val results = LinkedHashMap<String, ChatMessage.ToolResult>()
        var lastToolCallId: String? = null
        for (message in messages) {
            if (message is ChatMessage.ToolResult) {
                results[message.toolCallId] = message
                continue
            }
            if (message is ChatMessage.Assistant) {
                lastToolCallId = null
                for (block in message.blocks) {
                    if (block is AssistantBlock.ToolCall) lastToolCallId = block.toolCallId
                }
                continue
            }
            val attached = lastToolCallId
            val result = attached?.let(results::get)
            lastToolCallId = null
            if (result == null || result.passiveContext != null) continue
            if (message !is ChatMessage.Custom || message.customType != PASSIVE_TOOL_CONTEXT) continue
            val text = sanitizePassiveToolContext(message.text)
            if (text.isEmpty()) continue
            results[result.toolCallId] = result.copy(passiveContext = text)
        }
        return results
    }

    private const val PASSIVE_TOOL_CONTEXT_MAX = 2000

    /** Display text without ANSI/control/zero-width/bidi characters. */
    fun sanitizePassiveToolContext(raw: String): String {
        val stripped = raw
            .replace(ANSI_ESCAPE, "")
            .replace(CONTROL_CHARS, "")
        return stripped
            .split("\n")
            .map { it.trimEnd() }
            .joinToString("\n")
            .replace(Regex("\n{3,}"), "\n\n")
            .trimStart('\n')
            .trimEnd()
            .take(PASSIVE_TOOL_CONTEXT_MAX)
            .trimEnd()
    }

    private val ANSI_ESCAPE = Regex("\u001B\\[[0-9;?]*[ -/]*[@-~]|\u001B\\][^\u0007]*\u0007")
    private val CONTROL_CHARS = Regex("[\\x00-\\x08\\x0B-\\x1F\\x7F-\\x9F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]")
}
