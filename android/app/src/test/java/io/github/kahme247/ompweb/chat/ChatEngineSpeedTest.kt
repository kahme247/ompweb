package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The live rate frames: one assistant message grows in text, the engine turns
 * the deltas into a rate at a fixed publish cadence, and every run boundary
 * clears it again.
 */
class ChatEngineSpeedTest {

    private val json = Json { ignoreUnknownKeys = true }
    private var clock = 1_000L

    private fun engine(): ChatEngine = ChatEngine(now = { clock })

    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private fun startFrame() = obj(
        """{"type":"message_start","message":{"role":"assistant","timestamp":900,"content":[]}}""",
    )

    private fun updateFrame(text: String) = obj(
        """{"type":"message_update","message":{"role":"assistant","timestamp":900,"content":[""" +
            """{"type":"text","text":"$text"}]}}""",
    )

    private fun endFrame(completedAt: Long) = obj(
        """
        {"type":"message_end","message":{"role":"assistant","timestamp":900,
         "content":[{"type":"text","text":"done"}],
         "usage":{"output":7751,"input":10},
         "duration":197638.7748,"ttft":2707.7157,"completedAt":$completedAt,
         "stopReason":"stop"}}
        """.trimIndent(),
    )

    /** Drive one assistant message to a published rate of 50 t/s. */
    private fun streamTwoHundredTokens(engine: ChatEngine) {
        engine.setSession("s1")
        engine.sendStarted("hi", 1L)
        engine.onFrame(startFrame())
        engine.flush()
        clock = 1_000L
        engine.onFrame(updateFrame("a".repeat(400)))
        engine.flush()
        clock = 3_000L
        engine.onFrame(updateFrame("a".repeat(800)))
        engine.flush()
    }

    @Test
    fun `the live rate is published after the 500 ms gate`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        assertEquals(50.0, engine.state.value.liveTokensPerSecond!!, 0.0001)
    }

    @Test
    fun `a short window stays empty`() {
        val engine = engine()
        engine.setSession("s1")
        engine.sendStarted("hi", 1L)
        engine.onFrame(startFrame())
        engine.flush()
        clock = 1_000L
        engine.onFrame(updateFrame("a".repeat(400)))
        engine.flush()
        clock = 1_200L
        engine.onFrame(updateFrame("a".repeat(800)))
        engine.flush()
        assertNull("under 700 ms", engine.state.value.liveTokensPerSecond)
    }

    @Test
    fun `a new assistant message resets the estimate`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 4_000L
        engine.onFrame(startFrame())
        engine.flush()
        assertNull(engine.state.value.liveTokensPerSecond)
    }

    @Test
    fun `message_end clears the live rate and commits the fields`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 5_000L
        engine.onFrame(endFrame(completedAt = 5_000L))
        engine.flush()
        assertNull(engine.state.value.liveTokensPerSecond)
        val message = engine.state.value.messages.last() as ChatMessage.Assistant
        assertEquals(7751, message.usageOutput)
        assertEquals(2707.7157, message.ttftMs!!, 0.0001)
        assertEquals(5_000L, message.completedAt)
        assertEquals("stop", message.stopReason)
        val speed = messageSpeed(message)!!
        assertEquals(39.76, speed.tokensPerSecond, 0.02)
    }

    @Test
    fun `a subagent frame never changes the rate`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 3_100L
        engine.onFrame(obj("""{"type":"subagent_event","payload":{"id":"sa1"}}"""))
        engine.flush()
        assertEquals(50.0, engine.state.value.liveTokensPerSecond!!, 0.0001)
    }

    @Test
    fun `an agent state snapshot without streaming clears the rate`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 3_100L
        engine.applyAgentState(
            obj("""{"running":true,"state":{"isStreaming":false,"isPromptRunning":false}}"""),
        )
        assertNull(engine.state.value.liveTokensPerSecond)
    }

    @Test
    fun `a user message start keeps the running rate`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 3_100L
        engine.onFrame(
            obj("""{"type":"message_start","message":{"role":"user","content":"next","timestamp":3000}}"""),
        )
        engine.flush()
        assertEquals(50.0, engine.state.value.liveTokensPerSecond!!, 0.0001)
    }

    @Test
    fun `the composer ticker keeps a live rate up to date without frames`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 3_500L
        engine.refreshLiveRate()
        assertEquals(50.0, engine.state.value.liveTokensPerSecond!!, 0.0001)
    }

    @Test
    fun `the composer ticker hides the rate once the stream stalls`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        // No frame for 2.6 s: the last delta is stale, so the number must go.
        clock = 5_600L
        engine.refreshLiveRate()
        assertNull(engine.state.value.liveTokensPerSecond)
    }

    @Test
    fun `a heartbeat frame without new tokens does not keep the rate alive`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 5_600L
        engine.onFrame(updateFrame("a".repeat(800)))
        engine.flush()
        assertNull(engine.state.value.liveTokensPerSecond)
    }

    @Test
    fun `the ticker does not invent a rate after the run ended`() {
        val engine = engine()
        streamTwoHundredTokens(engine)
        clock = 5_000L
        engine.onFrame(endFrame(completedAt = 5_000L))
        engine.flush()
        clock = 9_000L
        engine.refreshLiveRate()
        assertNull(engine.state.value.liveTokensPerSecond)
    }
}
