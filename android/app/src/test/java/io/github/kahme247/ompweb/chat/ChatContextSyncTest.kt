package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatContextSyncTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private fun page(
        mode: String,
        baseEntryId: String?,
        entryIds: List<String>,
        messages: List<String>,
    ): ContextPage {
        val ids = entryIds.joinToString(",") { "\"$it\"" }
        val payload = """
            {"mode":"$mode","baseEntryId":${baseEntryId?.let { "\"$it\"" } ?: "null"},
             "cursor":{"firstEntryId":"${entryIds.first()}","lastEntryId":"${entryIds.last()}"},
             "hasMore":false,"sessionId":"s1","leafId":"${entryIds.last()}",
             "context":{"thinkingLevel":"high","model":{"provider":"commandcode","modelId":"m1"},
                        "entryIds":[$ids],"messages":[${messages.joinToString(",")}]}}
        """.trimIndent()
        return ContextSync.parse(obj(payload))
    }

    @Test
    fun `parses history, model and live snapshot`() {
        val parsed = ContextSync.parse(
            obj(
                """
                {"mode":"replace","baseEntryId":null,
                 "cursor":{"firstEntryId":"e1","lastEntryId":"e2"},"hasMore":false,
                 "sessionId":"s1","leafId":"e2",
                 "context":{"thinkingLevel":"high","model":{"provider":"commandcode","modelId":"m1"},
                   "entryIds":["e1","e2"],
                   "messages":[
                     {"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1},
                     {"role":"assistant","content":[{"type":"text","text":"hi"}],"timestamp":2}]},
                 "live":{"cursor":{"streamId":"w","sequence":5},"isStreaming":true,
                   "isPromptRunning":true,"isCompacting":false,
                   "streamingMessage":{"role":"assistant","content":[{"type":"text","text":"partial"}],"timestamp":3},
                   "toolEvents":[
                     {"type":"tool_execution_start","toolCallId":"t1","toolName":"bash"},
                     {"type":"tool_execution_update","toolCallId":"t1","toolName":"bash",
                      "partialResult":{"content":[{"type":"text","text":"out"}]}}],
                   "responseObserved":true}}
                """.trimIndent(),
            ),
        )
        assertEquals(listOf("e1", "e2"), parsed.entryIds)
        assertEquals(2, parsed.messages.size)
        assertEquals("commandcode", parsed.model?.provider)
        assertEquals("m1", parsed.model?.id)
        assertEquals("e2", parsed.leafId)
        assertNotNull(parsed.live)
        assertEquals("w", parsed.live?.cursor?.streamId)
        assertEquals(5L, parsed.live?.cursor?.sequence)
        assertTrue(parsed.live?.isStreaming == true)
        assertEquals("partial", parsed.live?.streamingMessage?.blocks?.filterIsInstance<AssistantBlock.Text>()?.single()?.text)
        assertEquals("out", parsed.live?.toolEvents?.last()?.result?.text)
    }

    @Test
    fun `live absent for a wrapper-less idle session`() {
        val parsed = page("replace", null, listOf("e1"), listOf("""{"role":"user","content":"hi","timestamp":1}"""))
        assertNull(parsed.live)
        assertEquals("hi", (parsed.messages.single() as ChatMessage.User).text)
    }

    @Test
    fun `malformed page with misaligned ids yields no rows`() {
        val parsed = ContextSync.parse(
            obj(
                """
                {"mode":"replace","cursor":{},"hasMore":false,"sessionId":"s1",
                 "context":{"entryIds":["e1","e2"],"messages":[{"role":"user","content":"hi"}]}}
                """.trimIndent(),
            ),
        )
        assertTrue(parsed.messages.isEmpty())
        assertTrue(parsed.entryIds.isEmpty())
    }

    @Test
    fun `engine applies the live snapshot and replays running tools`() {
        val engine = ChatEngine(now = { 5L })
        engine.setSession("s1")
        val parsed = ContextSync.parse(
            obj(
                """
                {"mode":"replace","baseEntryId":null,"hasMore":false,"sessionId":"s1","leafId":"e1",
                 "context":{"entryIds":["e1"],"messages":[{"role":"user","content":"hi","timestamp":1}]},
                 "live":{"cursor":{"streamId":"w","sequence":5},"isStreaming":true,
                   "isPromptRunning":true,"isCompacting":false,
                   "streamingMessage":{"role":"assistant","content":[{"type":"text","text":"tal"}],"timestamp":2},
                   "toolEvents":[{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash"}]}}
                """.trimIndent(),
            ),
        )
        engine.applyContextPage(parsed)
        val state = engine.state.value
        assertTrue(state.historyLoaded)
        assertTrue(state.streamingActive)
        assertTrue(state.agentRunning)
        assertTrue(state.promptRunning)
        assertEquals("tal", state.streaming?.blocks?.filterIsInstance<AssistantBlock.Text>()?.single()?.text)
        assertEquals(1, state.liveTools.size)
        assertTrue(state.liveTools.single().running)
    }

    @Test
    fun `frame-committed rows survive a page that raced the file write`() {
        val engine = ChatEngine(now = { 10L })
        engine.setSession("s1")
        engine.sendStarted("hello", 1)
        engine.onFrame(
            obj("""{"type":"agent_start","web":{"streamId":"w","sequence":1}}"""),
        )
        engine.onFrame(
            obj(
                """{"type":"message_end","web":{"streamId":"w","sequence":3},
                   "message":{"role":"assistant","content":[{"type":"text","text":"answer"}],"timestamp":10}}""",
            ),
        )
        assertEquals(1, engine.state.value.messages.size)
        val userOnly = page("replace", null, listOf("e1"), listOf("""{"role":"user","content":"hello","timestamp":1}"""))
        engine.applyContextPage(userOnly)
        assertTrue(engine.state.value.messages.any { it is ChatMessage.Assistant })
        assertEquals("the unconfirmed reply stays visible", 2, engine.state.value.messages.size)

        val confirmed = page(
            "replace", null, listOf("e1", "e2"),
            listOf(
                """{"role":"user","content":"hello","timestamp":1}""",
                """{"role":"assistant","content":[{"type":"text","text":"answer"}],"timestamp":10}""",
            ),
        )
        engine.applyContextPage(confirmed)
        assertEquals("the confirmed page replaces the frame row", 2, engine.state.value.messages.size)
        assertEquals("e2", engine.state.value.messages[1].entryId)
    }

    @Test
    fun `stale message frames below the sequence floor are dropped`() {
        val engine = ChatEngine(now = { 1L })
        engine.setSession("s1")
        engine.onFrame(obj("""{"type":"agent_start","web":{"streamId":"w","sequence":1}}"""))
        engine.onFrame(
            obj(
                """{"type":"message_update","web":{"streamId":"w","sequence":10},
                   "message":{"role":"assistant","content":[{"type":"text","text":"ten"}]}}""",
            ),
        )
        engine.onFrame(
            obj(
                """{"type":"message_update","web":{"streamId":"w","sequence":9},
                   "message":{"role":"assistant","content":[{"type":"text","text":"nine"}]}}""",
            ),
        )
        val text = engine.state.value.streaming?.blocks?.filterIsInstance<AssistantBlock.Text>()?.single()?.text
        assertEquals("ten", text)
        assertFalse(engine.state.value.messages.any())
    }
}
