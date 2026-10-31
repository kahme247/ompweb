package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.JsonObject

/** Schedules [flush] and returns a cancel function. */
typealias FlushScheduler = (() -> Unit) -> () -> Unit

/**
 * Display-rate coalescing of `message_update` and `tool_execution_update`
 * frames (web: `lib/message-update-coalescer.ts`).
 *
 * Every update carries the full accumulated partial message, so only the
 * newest one is worth rendering. Tool updates keep one latest snapshot per
 * `toolCallId`. Any other frame type flushes the buffers first, and
 * `message_end` drops a pending message update without touching buffered
 * tool updates (those belong to the tool the committed message announced).
 */
class ChatFrameCoalescer(
    private val dispatch: (JsonObject) -> Unit,
    private val schedule: FlushScheduler = { flush -> flush(); {} },
) {
    private var pendingMessage: JsonObject? = null
    private val pendingTools = LinkedHashMap<String, JsonObject>()
    private var cancelScheduled: (() -> Unit)? = null

    fun push(frame: JsonObject) {
        when (frame.string("type")) {
            "message_update" -> {
                pendingMessage = frame
                scheduleFlush()
            }
            "tool_execution_update" -> {
                val toolCallId = frame.string("toolCallId")
                if (toolCallId == null) {
                    // Two tools must never overwrite each other's slot.
                    flush()
                    dispatch(frame)
                    return
                }
                pendingTools[toolCallId] = frame
                scheduleFlush()
            }
            "message_end" -> {
                pendingMessage = null
                if (pendingTools.isEmpty()) cancel()
                dispatch(frame)
            }
            else -> {
                if (pendingMessage != null || pendingTools.isNotEmpty()) cancel()
                flush()
                dispatch(frame)
            }
        }
    }

    fun flush() {
        cancelScheduled = null
        val message = pendingMessage
        val tools = pendingTools.values.toList()
        pendingMessage = null
        pendingTools.clear()
        message?.let(dispatch)
        tools.forEach(dispatch)
    }

    /** Drop pending output and cancel the scheduled flush (stream replaced). */
    fun reset() {
        pendingMessage = null
        pendingTools.clear()
        cancel()
    }

    private fun scheduleFlush() {
        if (cancelScheduled == null) cancelScheduled = schedule(::flush)
    }

    private fun cancel() {
        cancelScheduled?.invoke()
        cancelScheduled = null
    }
}
