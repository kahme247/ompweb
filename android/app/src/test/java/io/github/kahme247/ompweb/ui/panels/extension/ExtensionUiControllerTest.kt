package io.github.kahme247.ompweb.ui.panels.extension

import io.github.kahme247.ompweb.domain.AskAnswer
import io.github.kahme247.ompweb.domain.CLIPBOARD_READ_DENIED
import io.github.kahme247.ompweb.domain.CLIPBOARD_UNAVAILABLE_WRITE
import io.github.kahme247.ompweb.domain.ClipboardBridge
import io.github.kahme247.ompweb.domain.ExtensionNotice
import io.github.kahme247.ompweb.domain.ExtensionNoticeLevel
import io.github.kahme247.ompweb.domain.ExtensionResponse
import io.github.kahme247.ompweb.net.ExtensionApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * Phase-7 review S1 and B5: clipboard reads are default-deny with a per-chat
 * consent, and a replayed request for an answered dialog can never leave a
 * panel nobody can answer.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ExtensionUiControllerTest {

    private class FakeApi : ExtensionApi {
        val commands = mutableListOf<Pair<String, JsonObject>>()

        override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
            commands += sessionId to command
            return null
        }

        fun last(): JsonObject = commands.last().second
    }

    private class FakeClipboard(var text: String? = "secret") : ClipboardBridge {
        var reads = 0
        val writes = mutableListOf<String>()

        override fun readText(): String? {
            reads++
            return text
        }

        override fun writeText(text: String) {
            writes += text
        }
    }

    private fun readFrame(id: String = "clip-1"): JsonObject = buildJsonObject {
        put("type", "host_uri_request")
        put("id", id)
        put("operation", "read")
        put("url", "pi-web://clipboard")
    }

    private fun writeFrame(id: String = "clip-w", content: String = "hello"): JsonObject = buildJsonObject {
        put("type", "host_uri_request")
        put("id", id)
        put("operation", "write")
        put("url", "pi-web://clipboard")
        put("content", content)
    }

    private fun openUrlFrame(url: String = "https://example.com/page"): JsonObject = buildJsonObject {
        put("type", "extension_ui_request")
        put("method", "open_url")
        put("url", url)
        put("instructions", "Look here")
    }

    private fun statusFrame(key: String = "build", text: String = "running"): JsonObject = buildJsonObject {
        put("type", "extension_ui_request")
        put("method", "setStatus")
        put("statusKey", key)
        put("statusText", text)
    }

    private fun confirmFrame(id: String = "q1"): JsonObject = buildJsonObject {
        put("type", "extension_ui_request")
        put("method", "confirm")
        put("id", id)
        put("title", "Proceed?")
        put("message", "Delete the file")
    }

    /** One `ask` question with two options, exactly as omp sends it. */
    private fun askFrame(id: String = "ask-1", expiresAt: Long? = null): JsonObject = buildJsonObject {
        put("type", "extension_ui_request")
        put("method", "ask")
        put("id", id)
        if (expiresAt != null) put("expiresAt", expiresAt)
        putJsonArray("questions") {
            add(
                buildJsonObject {
                    put("id", "color")
                    put("question", "Which colour?")
                    put("multi", false)
                    putJsonArray("options") {
                        add(buildJsonObject { put("label", "Red") })
                        add(buildJsonObject { put("label", "Green") })
                    }
                },
            )
        }
    }

    private fun answers(id: String): ExtensionResponse.Answers = ExtensionResponse.Answers(
        id,
        listOf(AskAnswer("color", listOf("Green"), customInput = null)),
    )

    @Test
    fun `a denied clipboard read is refused and the denial sticks for the chat`() = runTest {
        val api = FakeApi()
        val clip = FakeClipboard()
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.attachPlatform(opener = {}, clipboard = clip)

        controller.onFrame(readFrame())
        advanceUntilIdle()
        // Nothing is read before the user decides.
        assertEquals(0, clip.reads)
        assertEquals("s1", controller.clipboardPrompt.value?.sessionId)

        controller.denyClipboardRead()
        advanceUntilIdle()
        val result = api.last().jsonObject
        assertEquals("host_uri_result", result["type"]!!.jsonPrimitive.content)
        assertEquals("clip-1", result["id"]!!.jsonPrimitive.content)
        assertEquals(CLIPBOARD_READ_DENIED, result["error"]!!.jsonPrimitive.content)

        // A second read is refused without a second dialog.
        controller.onFrame(readFrame("clip-2"))
        advanceUntilIdle()
        assertNull(controller.clipboardPrompt.value)
        assertEquals(0, clip.reads)
        assertEquals("clip-2", api.last().jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun `an allowed read returns the clipboard once and is announced`() = runTest {
        val api = FakeApi()
        val clip = FakeClipboard(text = "copied text")
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.attachPlatform(opener = {}, clipboard = clip)

        controller.onFrame(readFrame())
        advanceUntilIdle()
        controller.approveClipboardRead()
        advanceUntilIdle()

        assertEquals(1, clip.reads)
        val result = api.last().jsonObject
        assertEquals("copied text", result["content"]!!.jsonPrimitive.content)
        // The read is announced in the chat; the bar is fed by `notices`
        // (SharedFlow without replay, so its content is covered by the
        // notice-level UI test rather than this correlation).

        // The approval is per session: the next read needs no dialog.
        controller.onFrame(readFrame("clip-2"))
        advanceUntilIdle()
        assertNull(controller.clipboardPrompt.value)
        assertEquals(2, clip.reads)
    }

    @Test
    fun `a clipboard write is executed and reported`() = runTest {
        val api = FakeApi()
        val clip = FakeClipboard()
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.attachPlatform(opener = {}, clipboard = clip)

        controller.onFrame(writeFrame(content = "pasted"))
        advanceUntilIdle()

        assertEquals(listOf("pasted"), clip.writes)
        val result = api.last().jsonObject
        assertEquals("clip-w", result["id"]!!.jsonPrimitive.content)
        assertNull(result["isError"])
    }

    @Test
    fun `Done closes the panel on the tap instead of waiting for the RPC`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val sent = mutableListOf<JsonObject>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                sent += command
                // The route does not acknowledge the answer, but the client
                // still waits a full round trip.
                gate.await()
                return null
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")

        controller.onFrame(askFrame())
        assertEquals("ask-1", controller.dialog.value?.id)

        controller.respond(answers("ask-1"))
        runCurrent()
        // The panel is gone while the request is still on its way.
        assertNull(controller.dialog.value)

        // A second Done tap while it is in flight cannot reach the wire.
        controller.respond(answers("ask-1"))
        runCurrent()
        assertEquals(1, sent.size)
        assertEquals("extension_ui_response", sent.single()["type"]!!.jsonPrimitive.content)

        gate.complete(Unit)
        advanceUntilIdle()
        assertNull(controller.dialog.value)

        // The reconnect replay of the answered question never reopens it.
        controller.onFrame(askFrame())
        assertNull(controller.dialog.value)
        assertEquals(1, sent.size)
    }

    @Test
    fun `Cancel closes the panel immediately and is sent once`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val sent = mutableListOf<JsonObject>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                sent += command
                gate.await()
                return null
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.onFrame(askFrame())

        controller.respond(ExtensionResponse.Cancelled("ask-1"))
        controller.respond(ExtensionResponse.Cancelled("ask-1"))
        runCurrent()

        assertNull(controller.dialog.value)
        assertEquals(1, sent.size)
        assertTrue(sent.single()["cancelled"]!!.jsonPrimitive.content.toBoolean())
        gate.complete(Unit)
        advanceUntilIdle()
    }

    @Test
    fun `answering two questions in a row sends one response each`() = runTest {
        val gates = mutableMapOf<String, CompletableDeferred<Unit>>()
        val sent = mutableListOf<JsonObject>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                sent += command
                gates.getOrPut(command["id"]!!.jsonPrimitive.content) { CompletableDeferred() }.await()
                return null
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")

        controller.onFrame(askFrame("ask-1"))
        controller.respond(answers("ask-1"))
        runCurrent()
        // The next question arrives while the first answer is still in flight.
        controller.onFrame(askFrame("ask-2"))
        assertEquals("ask-2", controller.dialog.value?.id)
        controller.respond(answers("ask-2"))
        runCurrent()
        assertEquals(listOf("ask-1", "ask-2"), sent.map { it["id"]!!.jsonPrimitive.content })

        // The first answer settling must not unlock a second send of the second.
        gates.getValue("ask-1").complete(Unit)
        runCurrent()
        controller.respond(answers("ask-2"))
        runCurrent()
        assertEquals(2, sent.size)

        gates.getValue("ask-2").complete(Unit)
        advanceUntilIdle()
        assertNull(controller.dialog.value)
    }

    @Test
    fun `a failed send puts the panel back with an error and a retry works`() = runTest {
        var fail = true
        val sent = mutableListOf<JsonObject>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                sent += command
                if (fail) throw IOException("Unable to answer the extension dialog")
                return null
            }
        }
        val controller = ExtensionUiController(api, this)
        val notices = mutableListOf<ExtensionNotice>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            controller.notices.collect { notices += it }
        }
        controller.bind("s1")
        controller.onFrame(askFrame())

        controller.respond(answers("ask-1"))
        advanceUntilIdle()
        // Back on screen, not burnt: the error says why.
        assertEquals("ask-1", controller.dialog.value?.id)
        assertEquals(ExtensionNoticeLevel.Error, notices.single().level)

        fail = false
        controller.respond(answers("ask-1"))
        runCurrent()
        assertNull(controller.dialog.value)
        advanceUntilIdle()
        assertEquals(2, sent.size)
    }

    @Test
    fun `a failed answer after a session switch does not restore the old session's dialog`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val sent = mutableListOf<String>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                sent += sessionId
                gate.await()
                throw IOException("Unable to answer the extension dialog")
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.bind("A")
        controller.onFrame(askFrame())

        controller.respond(answers("ask-1"))
        runCurrent()
        // The panel is gone, the answer is still on its way to A.
        assertNull(controller.dialog.value)
        assertEquals(listOf("A"), sent)

        // The user switches the chat while the answer is in flight; the switch
        // drops every panel of A.
        controller.bind("B")
        assertNull(controller.dialog.value)

        // The send now fails: A's dialog must not appear in chat B, where
        // nothing could answer it (the id belongs to A's session).
        gate.complete(Unit)
        advanceUntilIdle()
        assertNull(controller.dialog.value)
        assertEquals(listOf("A"), sent)
    }

    @Test
    fun `a failed answer past the request's deadline leaves no panel`() = runTest {
        val sent = mutableListOf<JsonObject>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                sent += command
                throw IOException("Unable to answer the extension dialog")
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        // The round trip outlasts the request's timeout: the server settled the
        // request already, so the failed send must not put a dead card back.
        controller.onFrame(askFrame(expiresAt = 1_000))

        controller.respond(answers("ask-1"))
        advanceUntilIdle()
        assertNull(controller.dialog.value)
        assertEquals(1, sent.size)

        // A late replay of the expired request stays out too.
        controller.onFrame(askFrame(expiresAt = 1_000))
        advanceUntilIdle()
        assertNull(controller.dialog.value)
    }

    @Test
    fun `a restored panel expires on its re-armed timer`() = runTest {
        var fail = true
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                if (fail) throw IOException("Unable to answer the extension dialog")
                return null
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        val timeout = 60_000L
        controller.onFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "ask")
                put("id", "ask-1")
                put("timeout", timeout)
                putJsonArray("questions") {
                    add(
                        buildJsonObject {
                            put("id", "color")
                            put("question", "Which colour?")
                            put("multi", false)
                            putJsonArray("options") { add(buildJsonObject { put("label", "Green") }) }
                        },
                    )
                }
            },
        )

        controller.respond(answers("ask-1"))
        // The failed send puts the panel back (still inside its timeout).
        runCurrent()
        assertEquals("ask-1", controller.dialog.value?.id)

        // The restore re-armed the expiry timer: the panel goes away by itself
        // at its deadline instead of staying as an unanswerable card.
        advanceTimeBy(timeout + 1)
        runCurrent()
        assertNull(controller.dialog.value)
        fail = false
    }

    @Test
    fun `a panel without a bound session is never claimed`() = runTest {
        val sent = mutableListOf<String>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                sent += command["id"]!!.jsonPrimitive.content
                return null
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.onFrame(askFrame())
        assertEquals("ask-1", controller.dialog.value?.id)

        // No session, no send and — above all — no claim: the id stays usable.
        controller.respond(answers("ask-1"))
        advanceUntilIdle()
        assertTrue(sent.isEmpty())

        controller.bind("s1")
        controller.onFrame(askFrame())
        assertEquals("ask-1", controller.dialog.value?.id)
        controller.respond(answers("ask-1"))
        advanceUntilIdle()
        assertEquals(listOf("ask-1"), sent)
    }

    @Test
    fun `a dialog that arrives while the chat is hidden is shown when the chat returns`() = runTest {
        val api = FakeApi()
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        // Back to the list: nothing renders the panel, the stream keeps running.
        controller.bind(null)
        controller.onFrame(askFrame())
        controller.bind("s1")
        assertEquals("the same chat gets its pending request back", "ask-1", controller.dialog.value?.id)

        controller.respond(answers("ask-1"))
        advanceUntilIdle()
        assertEquals("s1", api.commands.single().first)
        assertEquals(
            listOf("Green"),
            api.last()["answers"]!!.jsonArray[0].jsonObject["selectedOptions"]!!
                .jsonArray.map { it.jsonPrimitive.content },
        )
    }

    @Test
    fun `a dialog is kept while the chat is hidden and dropped on a session switch`() = runTest {
        val controller = ExtensionUiController(FakeApi(), this)
        controller.bind("s1")
        controller.onFrame(askFrame())
        // The chat surface leaves the stage (list, rotation, notification).
        controller.bind(null)
        assertEquals(
            "the hidden chat's only copy of the request stays",
            "ask-1",
            controller.dialog.value?.id,
        )
        controller.bind("s1")
        assertEquals("ask-1", controller.dialog.value?.id)
        // Another chat never inherits it.
        controller.bind("s2")
        assertNull(controller.dialog.value)
    }

    @Test
    fun `a request that expires while the chat is hidden does not come back`() = runTest {
        val controller = ExtensionUiController(FakeApi(), this)
        controller.bind("s1")
        controller.onFrame(askFrame(expiresAt = System.currentTimeMillis() + 1))
        controller.bind(null)
        // The deadline keeps running while nothing renders the panel.
        advanceTimeBy(10)
        runCurrent()
        controller.bind("s1")
        assertNull(
            "its own deadline settled it, a panel now could only be answered into the void",
            controller.dialog.value,
        )
    }

    @Test
    fun `a failed answer while the chat is hidden keeps the panel for its return`() = runTest {
        val gate = CompletableDeferred<Unit>()
        val api = object : ExtensionApi {
            override suspend fun command(sessionId: String, command: JsonObject): JsonElement? {
                gate.await()
                throw IOException("Unable to answer the extension dialog")
            }
        }
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.onFrame(askFrame())
        controller.respond(answers("ask-1"))
        runCurrent()
        assertNull("the tap closes the panel", controller.dialog.value)

        // The user leaves the chat while the send is still on the wire and the
        // send then fails: the request is still open, so its panel must be
        // waiting when the chat comes back (no replay would bring it).
        controller.bind(null)
        gate.complete(Unit)
        advanceUntilIdle()
        assertEquals("ask-1", controller.dialog.value?.id)

        controller.bind("s1")
        assertEquals("ask-1", controller.dialog.value?.id)
    }

    /**
     * The chat keeps its subscription while the surface is away, so a host URI
     * that arrives there must still be answered: omp waits for the result, and
     * no invisible consent dialog may be stacked for it.
     */
    @Test
    fun `a clipboard read that arrives while the chat is hidden is answered as denied`() = runTest {
        val api = FakeApi()
        val clip = FakeClipboard()
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.attachPlatform(opener = {}, clipboard = clip)
        controller.bind(null)

        controller.onFrame(readFrame())
        advanceUntilIdle()

        assertNull("nothing may ask for consent while nothing is on screen", controller.clipboardPrompt.value)
        assertEquals("the clipboard is not read behind the list", 0, clip.reads)
        assertEquals("the answer goes to the session that asked", "s1", api.commands.single().first)
        val result = api.last().jsonObject
        assertEquals("host_uri_result", result["type"]!!.jsonPrimitive.content)
        assertEquals("clip-1", result["id"]!!.jsonPrimitive.content)
        assertEquals(CLIPBOARD_READ_DENIED, result["error"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a clipboard write that arrives while the chat is hidden is answered as unavailable`() = runTest {
        val api = FakeApi()
        val clip = FakeClipboard()
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.attachPlatform(opener = {}, clipboard = clip)
        controller.bind(null)

        controller.onFrame(writeFrame(content = "pasted"))
        advanceUntilIdle()

        assertTrue("no silent write without the chat that would announce it", clip.writes.isEmpty())
        assertEquals("s1", api.commands.single().first)
        val result = api.last().jsonObject
        assertEquals("clip-w", result["id"]!!.jsonPrimitive.content)
        assertEquals(CLIPBOARD_UNAVAILABLE_WRITE, result["error"]!!.jsonPrimitive.content)
    }

    /**
     * An `open_url` that arrives while the chat is hidden is the user's to
     * decide on return: it must neither open by itself nor be dropped when the
     * same chat comes back.
     */
    @Test
    fun `an open_url that arrives while the chat is hidden waits for the return`() = runTest {
        val controller = ExtensionUiController(FakeApi(), this)
        val opened = mutableListOf<String>()
        controller.bind("s1")
        controller.attachPlatform(opener = { opened += it }, clipboard = FakeClipboard())
        controller.bind(null)

        controller.onFrame(openUrlFrame())
        advanceUntilIdle()
        assertTrue("never auto-opens", opened.isEmpty())

        controller.bind("s1")
        assertEquals("https://example.com/page", controller.openUrlPrompt.value?.url)
        assertEquals("Look here", controller.openUrlPrompt.value?.instructions)
        assertTrue("still waiting for the tap", opened.isEmpty())

        controller.openUrlNow()
        assertEquals(listOf("https://example.com/page"), opened)
    }

    @Test
    fun `an open_url does not follow a switch into another chat`() = runTest {
        val controller = ExtensionUiController(FakeApi(), this)
        controller.bind("A")
        controller.onFrame(openUrlFrame())
        assertNotNull(controller.openUrlPrompt.value)

        controller.bind("B")
        assertNull("B never shows A's prompt", controller.openUrlPrompt.value)
    }

    @Test
    fun `reset forgets the panels, the prompt and the answered ids`() = runTest {
        val api = FakeApi()
        val clip = FakeClipboard()
        val controller = ExtensionUiController(api, this)
        controller.bind("s1")
        controller.attachPlatform(opener = {}, clipboard = clip)
        controller.onFrame(askFrame())
        controller.onFrame(statusFrame())
        controller.onFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "setWidget")
                put("widgetKey", "w")
                putJsonArray("widgetLines") { add("x") }
            },
        )
        controller.onFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "custom")
                put("id", "term-1")
                putJsonArray("lines") { add("line") }
            },
        )
        controller.onFrame(openUrlFrame())
        // A read is waiting for its consent when the user is signed out.
        controller.onFrame(readFrame())
        advanceUntilIdle()
        assertEquals("s1", controller.clipboardPrompt.value?.sessionId)
        assertNotNull(controller.dialog.value)

        controller.reset()
        advanceUntilIdle()

        assertNull("no panel of the dropped user survives", controller.dialog.value)
        assertNull(controller.openUrlPrompt.value)
        assertNull("the consent dialog goes with the panels", controller.clipboardPrompt.value)
        assertTrue(controller.statusItems.value.isEmpty())
        assertTrue(controller.widgets.value.isEmpty())
        assertNull(controller.terminal.value)
        // The read that was waiting is answered instead of hanging.
        assertEquals(CLIPBOARD_READ_DENIED, api.last().jsonObject["error"]!!.jsonPrimitive.content)
        // `reset` drops the answered ids too: a request replayed to the next
        // sign-in must be answerable again (only a switch keeps the history).
        controller.onFrame(askFrame())
        assertEquals("ask-1", controller.dialog.value?.id)
    }

    @Test
    fun `an unsafe open_url never reaches the system opener`() = runTest {
        val api = FakeApi()
        val controller = ExtensionUiController(api, this)
        val opened = mutableListOf<String>()
        controller.bind("s1")
        controller.attachPlatform(opener = { opened += it }, clipboard = FakeClipboard())

        controller.onFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "open_url")
                put("url", "file:///etc/passwd")
            },
        )
        advanceUntilIdle()
        assertNull(controller.openUrlPrompt.value)

        controller.onFrame(
            buildJsonObject {
                put("type", "extension_ui_request")
                put("method", "open_url")
                put("url", "https://example.com/page")
            },
        )
        // S4: even a safe URL waits for the user's tap.
        assertNotNull(controller.openUrlPrompt.value)
        assertTrue(opened.isEmpty())

        controller.openUrlNow()
        assertEquals(listOf("https://example.com/page"), opened)
    }
}
