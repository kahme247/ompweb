package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptPlanTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private fun user(text: String, timestamp: Long = 1) = parseChatMessage(
        obj("""{"role":"user","content":[{"type":"text","text":"$text"}],"timestamp":$timestamp}"""),
        entryId = "u$timestamp",
        syntheticKey = "u",
    )!!

    private fun assistant(timestamp: Long, content: String) = parseChatMessage(
        obj("""{"role":"assistant","content":$content,"timestamp":$timestamp}"""),
        entryId = "a$timestamp",
        syntheticKey = "a",
    )!!

    @Test
    fun `a turn with tools folds its activity into one segment`() {
        val messages = listOf(
            user("run it"),
            assistant(2, """[{"type":"thinking","thinking":"plan"}]"""),
            assistant(3, """[{"type":"toolCall","toolCallId":"c1","toolName":"bash","input":{"command":"echo hi"}}]"""),
            parseChatMessage(
                obj("""{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"hi"}]}"""),
                "r1",
                "r",
            )!!,
            assistant(4, """[{"type":"text","text":"done"}]"""),
        )
        val rows = TranscriptPlan.build(messages)
        val group = rows.filterIsInstance<TranscriptRow.Group>().single()
        assertEquals("one activity segment, one text segment", 2, group.segments.size)
        val activity = group.segments[0] as TurnSegment.Activity
        assertEquals(1, activity.toolCallCount)
        assertTrue(activity.pieces.any { it.message is ChatMessage.ToolResult || it.blocks?.any { b -> b is AssistantBlock.ToolCall } == true })
        val text = group.segments[1] as TurnSegment.Text
        assertTrue(text.last)
        assertEquals("done", (text.blocks.single() as AssistantBlock.Text).text)
    }

    @Test
    fun `a plain answer renders as standalone messages`() {
        val rows = TranscriptPlan.build(listOf(user("hi"), assistant(2, """[{"type":"text","text":"hello"}]""")))
        assertEquals(2, rows.filterIsInstance<TranscriptRow.Message>().size)
        assertTrue(rows.filterIsInstance<TranscriptRow.Group>().isEmpty())
    }

    @Test
    fun `hide thinking removes thinking from the fold`() {
        val messages = listOf(
            user("hi"),
            assistant(2, """[{"type":"toolCall","toolCallId":"c1","toolName":"bash","input":{}}]"""),
            assistant(3, """[{"type":"thinking","thinking":"aha"}]"""),
            assistant(4, """[{"type":"text","text":"done"}]"""),
        )
        val rows = TranscriptPlan.build(messages, hideThinking = true)
        val group = rows.filterIsInstance<TranscriptRow.Group>().single()
        val activity = group.segments.filterIsInstance<TurnSegment.Activity>()
        assertTrue(activity.all { piece -> piece.pieces.all { it.blocks?.any { b -> b is AssistantBlock.Thinking } != true } })
    }

    @Test
    fun `tool results are indexed by call id and passive context attaches to the last call`() {
        val messages = listOf(
            user("hi"),
            assistant(2, """[{"type":"toolCall","toolCallId":"c1","toolName":"bash","input":{}}]"""),
            assistant(3, """[{"type":"toolCall","toolCallId":"c2","toolName":"read","input":{}}]"""),
            parseChatMessage(
                obj("""{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":"one"}"""),
                "r1",
                "r",
            )!!,
            parseChatMessage(
                obj("""{"role":"toolResult","toolCallId":"c2","toolName":"read","content":"two"}"""),
                "r2",
                "r",
            )!!,
            parseChatMessage(
                obj("""{"role":"custom","customType":"passive-tool-context","content":"\u001B[31mred\u001B[0m context"}"""),
                "p1",
                "p",
            )!!,
            assistant(4, """[{"type":"text","text":"done"}]"""),
        )
        val results = TranscriptPlan.collectToolResults(messages)
        assertEquals(2, results.size)
        assertEquals("red context", results["c2"]?.passiveContext?.trim())
        assertNull(results["c1"]?.passiveContext)
    }

    @Test
    fun `passive tool context strips ansi and control characters`() {
        val sanitized = TranscriptPlan.sanitizePassiveToolContext("\u001B[1;32mok\u001B[0m\u0000\n\ntext")
        assertEquals("ok\n\ntext", sanitized)
    }

    // ------------------------------------------------ display preferences

    @Test
    fun `a running tool call opens unless the reader collapsed tool cards`() {
        assertTrue(ChatDisplayPrefs.toolCallExpanded(toolCallsCollapsed = false, running = true))
        assertFalse("collapsed cards stay folded while running", ChatDisplayPrefs.toolCallExpanded(true, true))
        assertFalse("a finished call always starts folded", ChatDisplayPrefs.toolCallExpanded(false, false))
    }

    @Test
    fun `expand thinking opens reasoning blocks`() {
        assertTrue(ChatDisplayPrefs.thinkingExpanded(expandThinking = true))
        assertFalse("the web default folds reasoning", ChatDisplayPrefs.thinkingExpanded(false))
    }

    @Test
    fun `the live tail is flat only while tools are visible`() {
        assertTrue(ChatDisplayPrefs.liveTail(hideToolActivity = false, streaming = true, isLastGroup = true))
        assertFalse(
            "hiding tool activity keeps the fold in place",
            ChatDisplayPrefs.liveTail(hideToolActivity = true, streaming = true, isLastGroup = true),
        )
        assertFalse(
            "only the last group is the live tail",
            ChatDisplayPrefs.liveTail(hideToolActivity = false, streaming = true, isLastGroup = false),
        )
        assertFalse(ChatDisplayPrefs.liveTail(hideToolActivity = false, streaming = false, isLastGroup = true))
    }
}
