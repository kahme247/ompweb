package io.github.kahme247.ompweb.chat

import io.github.kahme247.ompweb.domain.chatShowsConnecting
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Do we know anything about the live run yet?" — the flag behind the footer's
 * *Connecting…* line. A cache-first screen paints the disk transcript before
 * the server says a word, and an empty status line there reads as "idle".
 */
class ChatLiveStateTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private fun engine(): ChatEngine = ChatEngine(now = { 1_800_000_000_000L })

    @Test
    fun `a freshly opened session has an unknown live state`() {
        val engine = engine()
        engine.setSession("s1")
        assertFalse("nothing has been heard from the server yet", engine.state.value.liveStateKnown)
        assertTrue("cached rows do ask for the hint", chatShowsConnecting(false, hasTranscript = true))
        assertFalse("an empty chat keeps quiet", chatShowsConnecting(false, hasTranscript = false))
    }

    @Test
    fun `a session frame proves the stream is live`() {
        val engine = engine()
        engine.setSession("s1")
        engine.onFrame(obj("""{"type":"connected"}"""))
        engine.flush()
        assertTrue(engine.state.value.liveStateKnown)
        assertFalse("the real state is shown instead", chatShowsConnecting(true, hasTranscript = true))
    }

    @Test
    fun `any frame counts, even one the engine has no use for`() {
        val engine = engine()
        engine.setSession("s1")
        // `turn_start`/`turn_end` are not handled by the engine (omp's turn
        // markers); they still prove the session's stream is delivering.
        engine.onFrame(obj("""{"type":"turn_start"}"""))
        engine.flush()
        assertTrue(engine.state.value.liveStateKnown)
    }

    @Test
    fun `an agent state snapshot settles the live state even when nothing runs`() {
        val engine = engine()
        engine.setSession("s1")
        engine.applyAgentState(obj("""{"running":false,"state":{"isStreaming":false,"isPromptRunning":false}}"""))
        assertTrue("the server answered for this session", engine.state.value.liveStateKnown)
        assertFalse(engine.state.value.busy)
    }

    @Test
    fun `switching sessions forgets the known live state`() {
        val engine = engine()
        engine.setSession("s1")
        engine.applyAgentState(obj("""{"running":false}"""))
        assertTrue(engine.state.value.liveStateKnown)
        engine.setSession("s2")
        assertFalse("the next session starts over", engine.state.value.liveStateKnown)
    }

    @Test
    fun `a live context page settles the live state`() {
        val engine = engine()
        engine.setSession("s1")
        val page = ContextSync.parse(
            obj(
                """
                {"mode":"replace","baseEntryId":null,"hasMore":false,"sessionId":"s1","leafId":"e1",
                 "context":{"entryIds":["e1"],"messages":[{"role":"user","content":"hi","timestamp":1}]},
                 "live":{"cursor":{"streamId":"w","sequence":3},"isStreaming":false,
                   "isPromptRunning":false,"isCompacting":false}}
                """.trimIndent(),
            ),
        )
        engine.applyContextPage(page)
        assertTrue("the page proves the server has a live view", engine.state.value.liveStateKnown)
        assertFalse("an idle live page is not a run", engine.state.value.busy)
    }

    @Test
    fun `an accepted prompt marks the live state known`() {
        val engine = engine()
        engine.setSession("s1")
        engine.sendStarted("hello", runId = 1)
        assertTrue("the prompt went to a live session", engine.state.value.liveStateKnown)
        assertTrue(engine.state.value.busy)
    }
}
