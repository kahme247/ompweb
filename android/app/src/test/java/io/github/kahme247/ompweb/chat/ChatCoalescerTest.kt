package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatCoalescerTest {

    /** A scheduler that only runs when the test says so. */
    private class Deferred {
        private var scheduled: (() -> Unit)? = null
        val scheduler: FlushScheduler = { flush ->
            scheduled = flush
            { scheduled = null }
        }

        fun run() {
            val flush = scheduled
            assertTrue("expected a scheduled flush", flush != null)
            flush!!.invoke()
        }
    }

    private fun frame(json: String): JsonObject = Json.parseToJsonElement(json).jsonObject

    private fun update(text: String, sequence: Int) = frame(
        """{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"$text"}]},
           "web":{"streamId":"s","sequence":$sequence}}""",
    )

    private fun toolUpdate(id: String, text: String) = frame(
        """{"type":"tool_execution_update","toolCallId":"$id","toolName":"bash",
           "partialResult":{"content":[{"type":"text","text":"$text"}]}}""",
    )

    @Test
    fun `only the newest message update is dispatched`() {
        val seen = mutableListOf<JsonObject>()
        val deferred = Deferred()
        val coalescer = ChatFrameCoalescer({ seen += it }, deferred.scheduler)

        coalescer.push(update("a", 1))
        coalescer.push(update("b", 2))
        assertTrue(seen.isEmpty())
        deferred.run()
        assertEquals(1, seen.size)
        assertEquals(2L, seen.single().obj("web")!!.long("sequence"))
    }

    @Test
    fun `tool updates keep one latest snapshot per tool in first-seen order`() {
        val seen = mutableListOf<String>()
        val deferred = Deferred()
        val coalescer = ChatFrameCoalescer({ frame ->
            seen += frame.string("toolCallId") + ":" + frame.string("type")
        }, deferred.scheduler)

        coalescer.push(toolUpdate("t1", "one"))
        coalescer.push(toolUpdate("t1", "two"))
        coalescer.push(toolUpdate("t2", "three"))
        assertTrue(seen.isEmpty())
        deferred.run()

        assertEquals(listOf("t1:tool_execution_update", "t2:tool_execution_update"), seen)
    }

    @Test
    fun `a normal frame flushes pending output first`() {
        val seen = mutableListOf<String>()
        val deferred = Deferred()
        val coalescer = ChatFrameCoalescer({ frame -> seen += frame.string("type")!! }, deferred.scheduler)

        coalescer.push(update("a", 1))
        coalescer.push(frame("""{"type":"agent_end","web":{"streamId":"s","sequence":2}}"""))

        assertEquals(listOf("message_update", "agent_end"), seen)
    }

    @Test
    fun `message end drops a pending message update but keeps tool output`() {
        val seen = mutableListOf<String>()
        val deferred = Deferred()
        val coalescer = ChatFrameCoalescer({ frame -> seen += frame.string("type")!! }, deferred.scheduler)

        coalescer.push(update("a", 1))
        coalescer.push(toolUpdate("t1", "x"))
        coalescer.push(frame("""{"type":"message_end","web":{"streamId":"s","sequence":2}}"""))
        assertEquals(listOf("message_end"), seen)

        deferred.run()
        assertEquals(listOf("message_end", "tool_execution_update"), seen)
    }

    @Test
    fun `reset drops everything without dispatching`() {
        val seen = mutableListOf<JsonObject>()
        val deferred = Deferred()
        val coalescer = ChatFrameCoalescer({ seen += it }, deferred.scheduler)
        coalescer.push(update("a", 1))
        coalescer.reset()
        assertFalse(seen.any())
    }
}
