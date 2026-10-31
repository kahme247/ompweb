package io.github.kahme247.ompweb.ui.chat

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import io.github.kahme247.ompweb.chat.AgentPhase
import io.github.kahme247.ompweb.chat.AssistantBlock
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.ChatState

/**
 * What the running turn is doing right now. With "hide tool activity" the
 * running turn folds into one collapsed "Process details" row; the collapsed
 * row still has to show that work is in progress (web `ChatWindow`'s
 * `pendingToolHeaders` and phase line, which stay above the composer).
 */
sealed interface LiveActivity {
    /** [name] plus its short argument/intent; [more] counts the other running calls. */
    data class Tool(val name: String, val intent: String, val more: Int) : LiveActivity

    /** The model is working and has not written anything yet. */
    data object Thinking : LiveActivity

    /** The model is writing its answer. */
    data object Writing : LiveActivity

    data object RunningCommand : LiveActivity

    data object Compacting : LiveActivity

    /** Busy without a known phase (an older omp, or between frames). */
    data object Working : LiveActivity
}

/**
 * The running turn's live activity, or null when nothing runs (the fold then
 * returns to its static summary).
 *
 * A tool is named from the transcript itself: an assistant tool call that has
 * no result yet is what the turn waits on. The server does not always stream
 * the tool phase frames (real runs show `waiting for model` during a 60 s
 * `sleep`), so the transcript is the reliable signal; the phase is the
 * fallback for servers that do stream them. The argument preview is the same
 * one the collapsed card header uses.
 *
 * "Writing…" is only claimed once the streamed message actually has text.
 */
fun liveActivity(state: ChatState): LiveActivity? {
    if (!state.busy && !state.streamingActive) return null
    if (state.compacting) return LiveActivity.Compacting
    pendingToolCall(state)?.let { return it }
    return when (val phase = state.agentPhase) {
        is AgentPhase.RunningTools -> phaseTool(phase, state) ?: LiveActivity.Working
        AgentPhase.RunningCommand -> LiveActivity.RunningCommand
        AgentPhase.WaitingModel, null -> if (writingNow(state)) LiveActivity.Writing else LiveActivity.Thinking
    }
}

/**
 * The model is writing its answer: the streamed message has text, or the
 * transcript's newest message is the assistant's answer (the server commits
 * the answer as it grows and does not keep a separate streaming message).
 * A freshly sent prompt is the newest message until the answer starts, so the
 * previous turn's text never reads as "Writing…".
 */
private fun writingNow(state: ChatState): Boolean =
    hasText(state.streaming) || hasText(state.messages.lastOrNull() as? ChatMessage.Assistant)

private fun hasText(message: ChatMessage.Assistant?): Boolean =
    message?.blocks?.any { block -> block is AssistantBlock.Text && block.text.isNotBlank() } == true

/**
 * The newest assistant tool call without a result. Only the live message and
 * the last committed assistant message are considered, so a call from an
 * older turn cannot be mistaken for the current one.
 */
private fun pendingToolCall(state: ChatState): LiveActivity.Tool? {
    val resolved = state.messages
        .filterIsInstance<ChatMessage.ToolResult>()
        .mapTo(HashSet()) { it.toolCallId }
    val candidates = listOfNotNull(
        state.streaming,
        state.messages.lastOrNull { it is ChatMessage.Assistant } as? ChatMessage.Assistant,
    )
    for (message in candidates) {
        val open = message.blocks
            .filterIsInstance<AssistantBlock.ToolCall>()
            .filter { it.toolCallId !in resolved }
        if (open.isEmpty()) continue
        val call = open.last()
        return LiveActivity.Tool(
            name = call.toolName.ifBlank { "tool" },
            intent = toolIntent(AssistantBlock.ToolCall(call.toolCallId, call.toolName, call.input)),
            more = open.size - 1,
        )
    }
    return null
}

private fun phaseTool(phase: AgentPhase.RunningTools, state: ChatState): LiveActivity.Tool? {
    val first = phase.tools.firstOrNull() ?: return null
    val live = state.liveTools.firstOrNull { it.toolCallId == first.id }
        ?: state.liveTools.firstOrNull { it.endedAt == null && it.toolName.equals(first.name, ignoreCase = true) }
    return LiveActivity.Tool(
        name = first.name.ifBlank { "tool" },
        intent = live?.args?.let { args -> toolIntent(AssistantBlock.ToolCall(first.id, first.name, args)) }.orEmpty(),
        more = (phase.tools.size - 1).coerceAtLeast(0),
    )
}

/** The one-line argument summary of a tool call, or an empty string. */
private fun toolIntent(call: AssistantBlock.ToolCall): String =
    getToolPreview(call).lineSequence().firstOrNull()?.trim().orEmpty()

/**
 * The clock the live fold measures elapsed time with. The transcript's own
 * timestamps come from the messages, so only the running row reads a wall
 * clock; tests pin it to keep screenshots deterministic.
 */
internal val LocalChatClock = staticCompositionLocalOf<() -> Long> { { System.currentTimeMillis() } }

/**
 * Whether the platform asks for motion (the "remove animations" accessibility
 * setting, i.e. animator duration scale 0). The running fold then shows a
 * static dot instead of the pulse, exactly like the web's reduced-motion path.
 */
internal val LocalChatMotion = staticCompositionLocalOf { true }

/** Reads and observes the system animator duration scale. */
@Composable
internal fun rememberSystemMotionEnabled(): Boolean {
    val context = LocalContext.current
    var enabled by remember(context) { mutableStateOf(motionEnabled(context)) }
    DisposableEffect(context) {
        val resolver = context.contentResolver
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                enabled = motionEnabled(context)
            }
        }
        resolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            observer,
        )
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return enabled
}

private fun motionEnabled(context: Context): Boolean = try {
    Settings.Global.getFloat(
        context.contentResolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    ) > 0f
} catch (_: SecurityException) {
    // A restricted profile may hide the setting; motion stays on.
    true
} catch (_: IllegalArgumentException) {
    true
}
