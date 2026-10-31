package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertTrue
import org.junit.Test

/** Behaviour of the "Copy transcript" formatter (`lib/transcript.ts`). */
class TranscriptMarkdownTest {

    private fun message(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    @Test
    fun `titles, cwd and user text become markdown sections`() {
        val markdown = transcriptToMarkdown(
            messages = listOf(message("""{"role":"user","content":"Hello there"}""")),
            title = "Chat",
            cwd = "/work/repo",
        )
        assertTrue(markdown.startsWith("# Chat"))
        assertTrue(markdown.contains("_/work/repo_"))
        assertTrue(markdown.contains("## User"))
        assertTrue(markdown.contains("Hello there"))
    }

    @Test
    fun `assistant text, thinking and a paired tool result render together`() {
        val messages = listOf(
            message(
                """{"role":"assistant","provider":"omp","model":"m","content":[""" +
                    """{"type":"thinking","thinking":"check files"},""" +
                    """{"type":"text","text":"I will look."},""" +
                    """{"type":"toolCall","toolName":"read","toolCallId":"c1","input":{"path":"a.txt"}}]}""",
            ),
            message("""{"role":"toolResult","toolCallId":"c1","toolName":"read","content":"file body"}"""),
        )
        val markdown = transcriptToMarkdown(messages)
        assertTrue(markdown.contains("## Assistant (omp/m)"))
        assertTrue(markdown.contains("<details><summary>Thinking</summary>"))
        assertTrue(markdown.contains("I will look."))
        assertTrue(markdown.contains("### Tool: read `c1`"))
        assertTrue(markdown.contains("\"path\": \"a.txt\""))
        assertTrue(markdown.contains("**Tool result: read**"))
        assertTrue(markdown.contains("file body"))
        // The result is nested under its call, never repeated as its own section.
        assertTrue(!markdown.contains("### Tool result: read"))
    }

    @Test
    fun `unpaired tool results and shell executions render standalone`() {
        val messages = listOf(
            message("""{"role":"toolResult","toolCallId":"orphan","toolName":"bash","content":"out"}"""),
            message("""{"role":"bashExecution","command":"ls","exitCode":0,"output":"a.txt"}"""),
        )
        val markdown = transcriptToMarkdown(messages)
        assertTrue(markdown.contains("### Tool result: bash"))
        assertTrue(markdown.contains("### Shell: `ls`"))
        assertTrue(markdown.contains("_exit 0_"))
        assertTrue(markdown.contains("a.txt"))
    }

    @Test
    fun `oversized blocks and fences are bounded and escaped`() {
        val huge = "x".repeat(TRANSCRIPT_BLOCK_CHAR_LIMIT + 50)
        val messages = listOf(
            message("""{"role":"user","content":"$huge"}"""),
            message("""{"role":"toolResult","toolCallId":"t","toolName":"bash","content":"```\ninner\n```"}"""),
        )
        val markdown = transcriptToMarkdown(messages)
        assertTrue(markdown.contains("…(truncated 50 chars)"))
        assertTrue(markdown.contains("~~~~\n```\ninner"))
    }
}
