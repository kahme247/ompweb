package io.github.kahme247.ompweb.ui.chat

import io.github.kahme247.ompweb.chat.AssistantBlock
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.TranscriptRow

/**
 * One transcript row whose rendered text contains the search query.
 *
 * A hit is a *row*, not a substring and not a message: the transcript cannot
 * scroll to a position inside a rendered markdown block, and a folded turn
 * renders several messages inside one group row. Counting messages instead
 * would report a higher total than the number of marked rows and let the
 * arrows land on the same row twice.
 */
data class ChatSearchHit(
    /** Key of the [TranscriptRow] to scroll to and mark. */
    val rowKey: String,
)

/**
 * The in-chat search surface (top-bar search icon): the open field, the query,
 * the hits in transcript order and the hit the arrows have selected.
 */
data class ChatSearchState(
    val open: Boolean = false,
    val query: String = "",
    val hits: List<ChatSearchHit> = emptyList(),
    val activeIndex: Int = 0,
    /**
     * An entry the transcript must scroll to and flash — the hand-off point of
     * the server-side search in `ui/sessions` (see
     * `ChatViewModel.scrollToEntry`). Cleared by the transcript once it jumped.
     */
    val revealEntryId: String? = null,
) {
    val total: Int get() = hits.size

    val active: ChatSearchHit? get() = hits.getOrNull(activeIndex)
}

/**
 * Text search over the *loaded* transcript (user feedback 25.10.: find text in
 * the chat without leaving it). Pure: the view model and the transcript only
 * hand in rows/messages, so matching and stepping are unit-testable without a
 * composition.
 */
internal object ChatSearch {

    fun normalize(query: String): String = query.trim().lowercase()

    /**
     * Everything the row shows as text. Tool output is included on purpose: a
     * command's output is often what the reader is looking for. Thinking text
     * is part of the row only while the reader has not hidden it — searching
     * what is not rendered would count hits the transcript can never reveal.
     */
    fun searchableText(message: ChatMessage, hideThinking: Boolean = false): String = when (message) {
        is ChatMessage.User -> message.text
        is ChatMessage.Assistant -> buildString {
            for (block in message.blocks) {
                when (block) {
                    is AssistantBlock.Text -> append(block.text)
                    is AssistantBlock.Thinking -> if (!hideThinking) append(block.thinking)
                    is AssistantBlock.ToolCall -> append(block.toolName).append(' ').append(block.input)
                    is AssistantBlock.Image, is AssistantBlock.Other -> Unit
                }
                append('\n')
            }
        }
        is ChatMessage.ToolResult -> message.toolName + "\n" + message.text
        is ChatMessage.BashExecution -> message.command + "\n" + (message.output ?: "")
        is ChatMessage.Custom -> message.text
        is ChatMessage.Other -> message.role
    }

    /**
     * Maps every message key to the row that renders it. A folded turn renders
     * all of its messages inside one group row, so the group's whole message
     * range maps to the group key.
     */
    fun rowKeyByMessage(rows: List<TranscriptRow>, messages: List<ChatMessage>): Map<String, String> {
        val map = HashMap<String, String>(messages.size * 2)
        for (row in rows) {
            when (row) {
                is TranscriptRow.Message -> map[row.message.key] = row.key
                is TranscriptRow.Group -> {
                    for (index in row.anchorIndex until row.endIndex) {
                        messages.getOrNull(index)?.let { map[it.key] = row.key }
                    }
                }
            }
        }
        return map
    }

    /**
     * All rows that contain [query], in transcript order and exactly once per
     * row. Hits without a rendered row (a mount notice folded away) are
     * dropped: there is nothing to scroll to.
     */
    fun search(
        messages: List<ChatMessage>,
        rowKeyByMessage: Map<String, String>,
        query: String,
        hideThinking: Boolean = false,
    ): List<ChatSearchHit> {
        val needle = normalize(query)
        if (needle.isEmpty()) return emptyList()
        val hits = ArrayList<ChatSearchHit>()
        val seenRows = HashSet<String>()
        for (message in messages) {
            val rowKey = rowKeyByMessage[message.key] ?: continue
            if (!seenRows.add(rowKey)) continue
            val text = searchableText(message, hideThinking)
            // A row that holds several messages only needs one match, but the
            // first message of a folded turn may be the one without it.
            if (text.contains(needle, ignoreCase = true)) {
                hits += ChatSearchHit(rowKey = rowKey)
            } else {
                seenRows.remove(rowKey)
            }
        }
        return hits
    }

    /** Next/previous hit, wrapping at both ends. */
    fun step(current: Int, total: Int, delta: Int): Int {
        if (total <= 0) return 0
        return ((current + delta) % total + total) % total
    }

    fun rowIndexForRowKey(rows: List<TranscriptRow>, rowKey: String): Int? =
        rows.indexOfFirst { it.key == rowKey }.takeIf { it >= 0 }

    /**
     * The row that carries [entryId] — the hand-off point of the server-side
     * search (`ui/sessions`), which only knows message ids.
     */
    fun rowIndexForEntry(
        rows: List<TranscriptRow>,
        messages: List<ChatMessage>,
        entryId: String,
    ): Int? {
        if (entryId.isEmpty()) return null
        rows.forEachIndexed { index, row ->
            when (row) {
                is TranscriptRow.Message -> if (row.message.entryId == entryId) return index
                is TranscriptRow.Group -> {
                    for (messageIndex in row.anchorIndex until row.endIndex) {
                        if (messages.getOrNull(messageIndex)?.entryId == entryId) return index
                    }
                }
            }
        }
        return null
    }
}
