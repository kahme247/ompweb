package io.github.kahme247.ompweb.chat

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Drives the seven recorded protocol fixtures through the engine. The
 * fixtures are the binding transcript shape (Phase 5 spec §15): every frame
 * type that occurs in a real run must land in the expected state.
 */
class ChatFixtureTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun fixture(name: String): List<JsonObject> =
        File("src/test/resources/protocol/$name.ndjson").readLines()
            .filter { it.isNotBlank() }
            .map { json.parseToJsonElement(it).jsonObject }

    private class Driver(val engine: ChatEngine) {
        var effectLog = mutableListOf<ChatEffect>()
        var btwFrames = 0
        var stateApplied: JsonObject? = null

        fun feed(frames: List<JsonObject>) {
            engine.setSession("session")
            effectLog += engine.drainEffects()
            for (frame in frames) {
                val rpc = frame["_rpc"] as? JsonObject
                if (rpc != null) {
                    val type = (rpc["body"] as? JsonObject)?.get("type")?.toString()?.trim('"')
                    if (type == "get_state") {
                        val data = (frame["_response"] as? JsonObject)?.get("data") as? JsonObject
                            ?: error("get_state fixture without data")
                        engine.applyAgentState(data)
                        stateApplied = data
                    }
                    continue
                }
                if (frame["_scenario"] != null) continue
                engine.onFrame(frame)
                engine.flush()
                effectLog += engine.drainEffects()
            }
        }

        fun resets(): Int = effectLog.count { it is ChatEffect.RequestContext && it.reset }
    }

    private fun driver(name: String): Driver {
        var btw = 0
        val engine = ChatEngine(
            now = { 1_800_000_000_000L },
            onBtwFrame = { btw += 1 },
        )
        val driver = Driver(engine)
        driver.feed(fixture(name))
        driver.btwFrames = btw
        return driver
    }

    @Test
    fun plainText() {
        val driver = driver("plain-text")
        val state = driver.engine.state.value
        assertEquals(2, state.messages.size)
        assertTrue(state.messages[0] is ChatMessage.User)
        val assistant = state.messages[1] as ChatMessage.Assistant
        assertEquals("fixture-ok", assistant.blocks.filterIsInstance<AssistantBlock.Text>().single().text)
        assertFalse(state.busy)
        assertNull(state.streaming)
        assertTrue(state.liveTools.isEmpty())
        assertNull(state.pendingUser)
    }

    @Test
    fun toolCall() {
        val driver = driver("tool-call")
        val state = driver.engine.state.value
        assertEquals("user, assistant(toolCall), toolResult, assistant text", 4, state.messages.size)
        val tools = state.messages[1] as ChatMessage.Assistant
        val call = tools.blocks.filterIsInstance<AssistantBlock.ToolCall>().single()
        assertEquals("bash", call.toolName)
        assertEquals("echo fixture", call.input.string("command"))
        val result = state.messages[2] as ChatMessage.ToolResult
        assertEquals(call.toolCallId, result.toolCallId)
        assertEquals("fixture\n", result.text)
        assertTrue("a committed result removes the live row", state.liveTools.isEmpty())
        val plan = TranscriptPlan.build(state.messages)
        val group = plan.filterIsInstance<TranscriptRow.Group>().single()
        val activity = group.segments.filterIsInstance<TurnSegment.Activity>().single()
        assertEquals(1, activity.toolCallCount)
        assertEquals(call.toolCallId, TranscriptPlan.collectToolResults(state.messages).keys.single())
    }

    @Test
    fun abortMidRun() {
        val driver = driver("abort-mid-run")
        val state = driver.engine.state.value
        assertEquals("agent_end.messages must not be appended", 2, state.messages.size)
        val assistant = state.messages[1] as ChatMessage.Assistant
        assertEquals("aborted", assistant.stopReason)
        assertEquals("Interrupted by user", assistant.errorMessage)
        assertFalse(state.busy)
        assertTrue(state.notices.any { it.message == "Interrupted by user" })
    }

    @Test
    fun queuedFollowUpRemoved() {
        var sawQueue = false
        val engine = ChatEngine(now = { 1_800_000_000_000L })
        engine.setSession("session")
        engine.drainEffects()
        for (frame in fixture("queued-follow-up-removed")) {
            if (frame["_rpc"] != null) continue
            if (frame["_scenario"] != null) continue
            engine.onFrame(frame)
            engine.flush()
            engine.drainEffects()
            if (frame.string("type") == "queue_update") {
                val queue = engine.state.value.queue
                if (queue.followUp == listOf("queued fixture message")) sawQueue = true
            }
        }
        assertTrue("the queued follow-up was visible while running", sawQueue)
        val state = engine.state.value
        assertTrue(state.queue.followUp.isEmpty())
        assertEquals(2, state.messages.size)
        assertFalse(state.busy)
    }

    @Test
    fun btwSideQuestionNeverTouchesTranscript() {
        val driver = driver("btw-side-question")
        val state = driver.engine.state.value
        assertEquals(3, driver.btwFrames)
        assertEquals(2, state.messages.size)
        assertEquals("btw frames must not start a new epoch", 1, driver.resets())
    }

    @Test
    fun getStateSnapshot() {
        val driver = driver("get-state")
        val state = driver.engine.state.value
        assertEquals("deepseek/deepseek-v4.1-flash", state.model?.id)
        assertEquals("commandcode", state.model?.provider)
        assertEquals("high", state.thinkingLevel)
        assertFalse(state.agentRunning)
        assertEquals(9448, state.contextUsage?.tokens)
        assertEquals(200000, state.contextUsage?.contextWindow)
    }

    @Test
    fun reconnectResubscribeDoesNotDuplicate() {
        val driver = driver("reconnect-resubscribe")
        val state = driver.engine.state.value
        assertEquals(2, state.messages.size)
        assertEquals("the same stream id must not reset the epoch", 1, driver.resets())
    }
}
