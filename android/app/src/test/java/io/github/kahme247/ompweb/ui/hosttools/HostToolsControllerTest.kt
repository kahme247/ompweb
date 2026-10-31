package io.github.kahme247.ompweb.ui.hosttools

import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.domain.HostToolKind
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.events.EventStream
import io.github.kahme247.ompweb.events.EventTransport
import io.github.kahme247.ompweb.net.EventPostResult
import io.github.kahme247.ompweb.net.ExtensionApi
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The host-tool rules of `AppShell.tsx:1579-1635` + `runHostTool`: when a URL
 * opens directly, when it asks, what the agent is told, and how a decline
 * never leaves an agent waiting.
 */
class HostToolsControllerTest {

    private class FakeApi : ExtensionApi {
        val commands = mutableListOf<Pair<String, JsonObject>>()

        override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
            commands += sessionId to command
            return null
        }

        fun results(): List<JsonObject> = commands.map { it.second }

        fun texts(): List<String> = results().map { command ->
            command["result"]!!.jsonObject["content"]!!.jsonArray.single()
                .jsonObject["text"]!!.jsonPrimitive.content
        }
    }

    private class RecordingOpener(
        private val notifyResult: Boolean = true,
    ) : HostToolOpener {
        val urls = mutableListOf<String>()
        val notifications = mutableListOf<Pair<String, String>>()

        override fun openUrl(url: String) {
            urls += url
        }

        override fun notify(title: String, message: String): Boolean {
            notifications += title to message
            return notifyResult
        }
    }

    private fun mux(scope: CoroutineScope): EventMux = EventMux(
        object : EventTransport {
            override suspend fun open(): EventStream = throw UnsupportedOperationException("unused")

            override suspend fun subscribe(
                connectionId: String,
                id: String,
                channel: EventChannel,
            ): EventPostResult = EventPostResult.Ok

            override suspend fun unsubscribe(connectionId: String, id: String) = Unit
        },
        scope,
    )

    private fun call(toolName: String, arguments: JsonObject): JsonObject = buildJsonObject {
        put("type", "host_tool_call")
        put("id", "call-1")
        put("toolCallId", "tc-1")
        put("toolName", toolName)
        put("arguments", arguments)
    }

    private fun urlArguments(url: String): JsonObject = buildJsonObject { put("url", url) }

    @Test
    fun `same-session urls open directly when auto-open is on`() = runTest {
        val api = FakeApi()
        val opener = RecordingOpener()
        val controller = HostToolsController(
            api,
            mux(this),
            FakeChatSettings(SettingsSnapshot(loaded = true, openUrlAutomatically = true)),
            this,
        )
        controller.attach(opener, { _, _ -> })
        controller.setViewedSession("s1")

        assertTrue(controller.onFrame("s1", call("open_url", urlArguments("https://a.test"))))
        advanceUntilIdle()

        assertEquals(listOf("https://a.test"), opener.urls)
        assertNull(controller.pending.value)
        assertEquals(listOf("Opened https://a.test"), api.texts())
        assertEquals("false", api.results()[0]["isError"]?.jsonPrimitive?.content)
    }

    @Test
    fun `without auto-open the prompt answers the agent before the user decides`() = runTest {
        val api = FakeApi()
        val opener = RecordingOpener()
        val controller = HostToolsController(api, mux(this), FakeChatSettings(), this)
        controller.attach(opener, { _, _ -> })
        controller.setViewedSession("s1")

        controller.onFrame("s1", call("open_url", urlArguments("https://a.test")))
        advanceUntilIdle()

        val prompt = controller.pending.value!!
        assertEquals(HostToolKind.OpenUrl, prompt.kind)
        assertFalse(prompt.crossSession)
        assertTrue(api.texts().single().startsWith("Asked the user to confirm opening https://a.test"))
        assertEquals("false", api.results().single()["isError"]?.jsonPrimitive?.content)

        controller.approve()
        advanceUntilIdle()
        assertEquals(listOf("https://a.test"), opener.urls)
        assertNull(controller.pending.value)
        assertEquals(1, api.commands.size)

        // Declining after the hand-off sends nothing: the call is already settled.
        controller.onFrame("s1", call("open_url", urlArguments("https://b.test")))
        advanceUntilIdle()
        controller.deny()
        advanceUntilIdle()
        assertEquals(2, api.commands.size)
        assertNull(controller.pending.value)
    }

    @Test
    fun `another session always asks even with auto-open and marks the prompt`() = runTest {
        val api = FakeApi()
        val opener = RecordingOpener()
        val controller = HostToolsController(
            api,
            mux(this),
            FakeChatSettings(SettingsSnapshot(loaded = true, openUrlAutomatically = true)),
            this,
        )
        controller.attach(opener, { _, _ -> })
        controller.setViewedSession("s2")

        controller.onFrame("s1", call("open_url", urlArguments("https://a.test")))
        advanceUntilIdle()

        val prompt = controller.pending.value!!
        assertTrue(prompt.crossSession)
        assertTrue(api.texts().single().contains("another ompweb session"))
        assertTrue(opener.urls.isEmpty())
    }

    @Test
    fun `unsafe urls are refused and never prompt`() = runTest {
        val api = FakeApi()
        val opener = RecordingOpener()
        val controller = HostToolsController(api, mux(this), FakeChatSettings(), this)
        controller.attach(opener, { _, _ -> })
        controller.setViewedSession("s1")

        controller.onFrame("s1", call("open_url", urlArguments("javascript:alert(1)")))
        advanceUntilIdle()

        assertNull(controller.pending.value)
        assertTrue(opener.urls.isEmpty())
        assertEquals("true", api.results().single()["isError"]?.jsonPrimitive?.content)
        assertEquals("Unsafe or invalid URL not opened", api.texts().single())
    }

    @Test
    fun `open_file opens the viewed session and asks across sessions`() = runTest {
        val api = FakeApi()
        val opened = mutableListOf<Pair<String, String>>()
        val controller = HostToolsController(api, mux(this), FakeChatSettings(), this)
        controller.attach(RecordingOpener(), { sessionId, path -> opened += sessionId to path })
        controller.setViewedSession("s1")

        val pathArgs = buildJsonObject { put("path", "src/Main.kt") }
        controller.onFrame("s1", call("open_file", pathArgs))
        advanceUntilIdle()
        assertEquals(listOf("s1" to "src/Main.kt"), opened)
        assertEquals(listOf("Opened src/Main.kt"), api.texts())

        controller.setViewedSession("s2")
        controller.onFrame("s1", call("open_file", pathArgs))
        advanceUntilIdle()
        val prompt = controller.pending.value!!
        assertEquals(HostToolKind.OpenFile, prompt.kind)
        // S3: the dialog shows the full path, not a base name.
        assertEquals("src/Main.kt", prompt.target)
        assertTrue(api.texts().last().contains("another ompweb session"))
    }

    @Test
    fun `reset drops the viewed session and every unanswered prompt`() = runTest {
        val api = FakeApi()
        val controller = HostToolsController(api, mux(this), FakeChatSettings(), this)
        controller.setViewedSession("s2")

        controller.onFrame("s1", call("open_file", buildJsonObject { put("path", "a.txt") }))
        advanceUntilIdle()
        assertNotNull(controller.pending.value)
        controller.onFrame("s1", call("open_file", buildJsonObject { put("path", "b.txt") }))
        advanceUntilIdle()
        // The second request waits behind the first.
        assertEquals("a.txt", controller.pending.value?.target)

        // Sign-out / local wipe: nothing may survive and act for the old user.
        val answeredBeforeReset = api.results().size
        controller.reset()
        assertNull(controller.pending.value)
        assertEquals("the reset answers nothing", answeredBeforeReset, api.results().size)
    }

    @Test
    fun `notify falls back to a notice and still answers the agent`() = runTest {
        val api = FakeApi()
        val notices = mutableListOf<String>()
        val controller = HostToolsController(api, mux(this), FakeChatSettings(), this)
        controller.attach(RecordingOpener(notifyResult = false), { _, _ -> })
        val collector = launch { controller.notices.collect { notices += it } }
        runCurrent()

        controller.onFrame(
            "s1",
            call(
                "notify",
                buildJsonObject {
                    put("title", "Build done")
                    put("message", "All green")
                },
            ),
        )
        advanceUntilIdle()

        assertEquals(listOf("Build done: All green"), notices)
        assertEquals(listOf("Notification shown"), api.texts())
        assertEquals("false", api.results().single()["isError"]?.jsonPrimitive?.content)
        collector.cancel()
    }

    @Test
    fun `unknown tools are refused with an error result`() = runTest {
        val api = FakeApi()
        val controller = HostToolsController(api, mux(this), FakeChatSettings(), this)
        controller.attach(RecordingOpener(), { _, _ -> })
        assertTrue(controller.onFrame("s1", call("launch_missiles", buildJsonObject {})))
        advanceUntilIdle()
        assertEquals("true", api.results().single()["isError"]?.jsonPrimitive?.content)
        assertEquals("Host tool \"launch_missiles\" is not available in ompweb", api.texts().single())
    }

    @Test
    fun `host_tool_cancel drops the queued prompt without answering again`() = runTest {
        val api = FakeApi()
        val controller = HostToolsController(api, mux(this), FakeChatSettings(), this)
        controller.attach(RecordingOpener(), { _, _ -> })
        controller.onFrame("s1", call("open_url", urlArguments("https://a.test")))
        advanceUntilIdle()
        assertNotNull(controller.pending.value)

        val cancel = buildJsonObject {
            put("type", "host_tool_cancel")
            put("targetId", "call-1")
        }
        assertTrue(controller.onFrame("s1", cancel))
        assertNull(controller.pending.value)
        assertEquals(1, api.commands.size)
    }

    @Test
    fun `unrelated frames pass through`() {
        val controller = HostToolsController(FakeApi(), mux(CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined)), FakeChatSettings(), CoroutineScope(kotlinx.coroutines.Dispatchers.Unconfined))
        assertFalse(controller.onFrame("s1", buildJsonObject { put("type", "message_update") }))
    }

}
