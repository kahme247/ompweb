package io.github.kahme247.ompweb.chat

/**
 * How the reader's chat preferences map onto transcript row state (web
 * `ChatWindow`/`MessageView`): the three preferences that decide whether a
 * row starts folded, open, or as a flat live tail.
 */
object ChatDisplayPrefs {
    /**
     * Tool cards open while the call runs only when the reader did not ask for
     * collapsed cards; finished calls always start folded.
     */
    fun toolCallExpanded(toolCallsCollapsed: Boolean, running: Boolean): Boolean =
        !toolCallsCollapsed && running

    /** Thinking blocks start open when "expand thinking" is on. */
    fun thinkingExpanded(expandThinking: Boolean): Boolean = expandThinking

    /**
     * The running turn renders flat (one row per message, activity visible)
     * unless tool activity is hidden; the fold then stays in place.
     */
    fun liveTail(hideToolActivity: Boolean, streaming: Boolean, isLastGroup: Boolean): Boolean =
        !hideToolActivity && streaming && isLastGroup
}
