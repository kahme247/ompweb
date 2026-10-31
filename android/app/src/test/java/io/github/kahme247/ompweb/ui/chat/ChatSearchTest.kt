package io.github.kahme247.ompweb.ui.chat

import io.github.kahme247.ompweb.chat.AssistantBlock
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.TranscriptPlan
import io.github.kahme247.ompweb.chat.TranscriptRow
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Matching, counting and stepping of the in-chat search (pure, no composition). */
class ChatSearchTest {

    private fun user(key: String, text: String, entry: String? = key) = ChatMessage.User(
        key = key,
        timestamp = 0L,
        entryId = entry,
        text = text,
    )

    private fun assistant(key: String, text: String, entry: String? = key) = ChatMessage.Assistant(
        key = key,
        timestamp = 0L,
        entryId = entry,
        blocks = listOf(AssistantBlock.Text(text)),
    )

    private fun assistant(vararg blocks: AssistantBlock, key: String = "a1", entry: String? = key) =
        ChatMessage.Assistant(
            key = key,
            timestamp = 0L,
            entryId = entry,
            blocks = blocks.toList(),
        )

    private fun toolResult(key: String, toolName: String, text: String, entry: String? = key) =
        ChatMessage.ToolResult(
            key = key,
            timestamp = 0L,
            entryId = entry,
            toolCallId = "call-$key",
            toolName = toolName,
            text = text,
        )

    private fun toolCall(name: String = "read", input: String = "libs") = AssistantBlock.ToolCall(
        toolCallId = "call",
        toolName = name,
        input = JsonObject(mapOf("path" to JsonPrimitive(input))),
    )

    private fun search(messages: List<ChatMessage>, query: String, hideThinking: Boolean = false) =
        ChatSearch.search(
            messages = messages,
            rowKeyByMessage = ChatSearch.rowKeyByMessage(TranscriptPlan.build(messages), messages),
            query = query,
            hideThinking = hideThinking,
        )

    @Test
    fun findsAssistantUserAndToolOutputCaseInsensitively() {
        val messages = listOf(
            user("u1", "Bitte prüfe den Build"),
            assistant("a1", "Ich starte Gradle."),
            toolResult("t1", "bash", "BUILD SUCCESSFUL in 41s"),
        )
        val hits = search(messages, "build")
        assertEquals(2, hits.size)
        // Row keys, not message keys: the transcript scrolls to rows.
        assertEquals(listOf("message:u1", "message:t1"), hits.map { it.rowKey })
    }

    @Test
    fun countsRowsNotMessagesSoSteppingNeverRepeatsARow() {
        // Two matching turns: the first folds three matching messages into one
        // group row, the second is a standalone row. The counter must say 2 and
        // the arrows must alternate between the two rows, not visit the group
        // three times before moving on.
        val messages = listOf(
            user("u1", "needle in the prompt"),
            assistant(AssistantBlock.Text("needle in the answer"), toolCall(), key = "a1"),
            toolResult("t1", "read", "needle in the tool output"),
            user("u2", "another needle"),
        )
        val rows = TranscriptPlan.build(messages)
        val group = rows.filterIsInstance<TranscriptRow.Group>().single()
        val hits = ChatSearch.search(messages, ChatSearch.rowKeyByMessage(rows, messages), "needle")
        assertEquals(2, hits.size)
        assertEquals(listOf(group.key, "message:u2"), hits.map { it.rowKey })
        assertNotEquals(hits[0].rowKey, hits[1].rowKey)
        // Stepping: 0 -> 1 -> 0, i.e. every step lands on a different row.
        val first = ChatSearch.step(0, hits.size, 1)
        assertEquals(1, first)
        assertEquals(0, ChatSearch.step(first, hits.size, 1))
        assertEquals(1, ChatSearch.step(0, hits.size, -1))
    }

    @Test
    fun hiddenThinkingIsNotSearchable() {
        // Rendered: thinking text is on screen.
        val messages = listOf(
            user("u1", "go"),
            assistant(
                AssistantBlock.Thinking("secret reasoning about haystack", deferred = false, blockIndex = 0),
                AssistantBlock.Text("done"),
                key = "a1",
            ),
        )
        assertEquals(1, search(messages, "haystack", hideThinking = false).size)
        // "Thinking ausblenden": the block is filtered from the row, so a hit
        // there would highlight and count text no row shows.
        assertTrue(search(messages, "haystack", hideThinking = true).isEmpty())
        assertEquals(
            "hidden thinking is gone from the searchable text",
            "\ndone\n",
            ChatSearch.searchableText(messages[1] as ChatMessage.Assistant, hideThinking = true),
        )
    }

    @Test
    fun blankQueryHasNoHits() {
        val messages = listOf(user("u1", "anything"))
        assertTrue(search(messages, "   ").isEmpty())
        assertTrue(search(messages, "").isEmpty())
    }

    @Test
    fun foldedTurnMapsToItsGroupRow() {
        val messages = listOf(
            user("u1", "go"),
            assistant("a1", "working"), // text segment
            toolResult("t1", "read", "haystack inside the tool output"),
            // A non-assistant step folds the turn into one group row.
            ChatMessage.BashExecution(
                key = "b1",
                timestamp = 0L,
                entryId = "b1",
                command = "ls",
                output = null,
                exitCode = 0,
            ),
            assistant("a2", "done"),
        )
        val rows = TranscriptPlan.build(messages)
        val group = rows.filterIsInstance<TranscriptRow.Group>().single()
        val hits = search(messages, "haystack")
        assertEquals(1, hits.size)
        assertEquals(group.key, hits.first().rowKey)
        assertEquals(0, ChatSearch.rowIndexForRowKey(rows, group.key) ?: -1)
        // The folded tool output is reachable through the group's entry range.
        assertEquals(0, ChatSearch.rowIndexForEntry(rows, messages, "t1") ?: -1)
    }

    @Test
    fun steppingWrapsInBothDirections() {
        assertEquals(1, ChatSearch.step(0, 3, 1))
        assertEquals(0, ChatSearch.step(2, 3, 1))
        assertEquals(2, ChatSearch.step(0, 3, -1))
        assertEquals(0, ChatSearch.step(0, 0, 1))
    }

    @Test
    fun entryLookupFindsMessagesInsideAGroupAndMissesUnknownIds() {
        val messages = listOf(
            user("u1", "go", entry = "e-user"),
            assistant("a1", "working", entry = "e-assistant"),
            ChatMessage.ToolResult(
                key = "t1",
                timestamp = 0L,
                entryId = "e-tool",
                toolCallId = "call",
                toolName = "grep",
                text = "x",
            ),
        )
        val rows = TranscriptPlan.build(messages)
        assertEquals(2, ChatSearch.rowIndexForEntry(rows, messages, "e-tool") ?: -1)
        assertEquals(0, ChatSearch.rowIndexForEntry(rows, messages, "e-user") ?: -1)
        assertNull(ChatSearch.rowIndexForEntry(rows, messages, "unknown"))
        assertNull(ChatSearch.rowIndexForEntry(rows, messages, ""))
    }

    @Test
    fun assistantToolCallArgumentsAreSearchable() {
        val messages = listOf(assistant(toolCall(input = "libs/version.toml")))
        val hits = search(messages, "version.toml")
        assertEquals(1, hits.size)
    }
}
