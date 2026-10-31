package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One router for both composers: the chat send path and the new-session send
 * path must classify `!cmd`, web slash commands, client built-ins and plain
 * prompts identically (web `handleSend` / `sendQueued`).
 */
class ComposerRoutingTest {

    private fun route(
        raw: String,
        hasAttachments: Boolean = false,
        hasImages: Boolean = false,
        bash: BashInvocation? = null,
    ): ComposerRoute = routeComposerSubmission(
        raw = raw,
        prompt = raw,
        hasAttachments = hasAttachments,
        hasImages = hasImages,
        bash = bash,
    )

    @Test
    fun `a parsed shell command wins over slash routing`() {
        val bash = BashInvocation(command = "ls -la", excludeFromContext = true)
        val routed = route("!!ls -la", bash = bash)

        assertEquals(ComposerRoute.Bash(bash), routed)
    }

    @Test
    fun `attachments disable web slash expansion`() {
        assertEquals(ComposerRoute.Prompt("/goal ship it"), route("/goal ship it", hasAttachments = true))
        assertEquals(ComposerRoute.Prompt("/goal ship it"), route("/goal ship it", hasImages = true))
    }

    @Test
    fun `a web command becomes its expanded prompt`() {
        val routed = route("/goal ship the export")
        assertTrue("expected a web prompt, got $routed", routed is ComposerRoute.WebPrompt)
        routed as ComposerRoute.WebPrompt
        assertEquals("goal", routed.name)
        assertEquals("ship the export", routed.args)
        assertTrue(
            "the expansion keeps the argument: ${routed.prompt}",
            routed.prompt.contains("ship the export"),
        )
        assertTrue(
            "the raw slash text never reaches omp: ${routed.prompt}",
            routed.prompt.startsWith("Work toward this goal"),
        )
    }

    @Test
    fun `a missing required argument reports usage instead of sending`() {
        val routed = route("/plan")
        assertEquals(ComposerRoute.Usage("/plan", "composer_cmd_plan_arg"), routed)
    }

    @Test
    fun `a client builtin keeps its raw text and arguments`() {
        assertEquals(ComposerRoute.Builtin("compact", ""), route("/compact"))
        assertEquals(ComposerRoute.Builtin("name", "new title"), route("/name new title"))
    }

    @Test
    fun `everything else is a plain prompt`() {
        assertEquals(ComposerRoute.Prompt("hello"), route("hello"))
        assertEquals(ComposerRoute.Prompt("/skill:review"), route("/skill:review"))
        assertEquals(ComposerRoute.Prompt("/"), route("/"))
    }

    // ------------------------------------------------------------------ /loop

    @Test
    fun `loop counts match the web for zero, leading zeros and huge numbers`() {
        assertTrue("/loop 0 uses the default", attempts("/loop 0 ship it") == 3)
        assertTrue("/loop 007 keeps seven", attempts("/loop 007 ship it") == 7)
        assertTrue("/loop 4 keeps four", attempts("/loop 4 ship it") == 4)
        assertTrue("a huge count is capped", attempts("/loop 99999999999999999999 ship it") == 10)
        assertTrue("10 is the maximum", attempts("/loop 10 ship it") == 10)
        assertTrue("no count means the default", attempts("/loop ship it") == 3)
    }

    @Test
    fun `a loop count never swallows the task line`() {
        val prompt = (expandWebSlashCommand("/loop 2 fix the parser") as WebSlashExpansion.Expand).prompt
        assertTrue(prompt.contains("up to 2 attempts in total"))
        assertTrue("the task stays whole: $prompt", prompt.trimEnd().endsWith("fix the parser"))
    }

    private fun attempts(command: String): Int {
        val prompt = (expandWebSlashCommand(command) as WebSlashExpansion.Expand).prompt
        val match = Regex("up to (\\d+) attempts").find(prompt) ?: error("no attempt count in $prompt")
        return match.groupValues[1].toInt()
    }
}
