package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port of `runHostTool` / `AppShell.requestOpenUrl` in the web: which calls
 * auto-open, which ask, which fail, and the exact result frames the agent
 * receives.
 */
class HostToolsTest {

    @Test
    fun `only the viewed session counts as same-session`() {
        assertFalse(isCrossSession("s1", "s1"))
        assertTrue(isCrossSession("s1", "s2"))
        assertTrue(isCrossSession("s1", null))
    }

    @Test
    fun `open_url rejects bad schemes before any consent or auto-open`() {
        assertEquals(
            HostToolDecision.Error,
            openUrlDecision("javascript:alert(1)", "s1", "s1", autoOpen = true),
        )
        assertEquals(HostToolDecision.Error, openUrlDecision("", "s1", "s1", autoOpen = true))
        assertEquals(HostToolDecision.Error, openUrlDecision(null, "s1", "s1", autoOpen = true))
    }

    @Test
    fun `auto-open applies to the viewed session only, other sessions always ask`() {
        assertEquals(
            HostToolDecision.Execute,
            openUrlDecision("https://example.com", "s1", "s1", autoOpen = true),
        )
        assertEquals(
            HostToolDecision.Ask,
            openUrlDecision("https://example.com", "s1", "s1", autoOpen = false),
        )
        assertEquals(
            HostToolDecision.Ask,
            openUrlDecision("https://example.com", "s2", "s1", autoOpen = true),
        )
        assertEquals(
            HostToolDecision.Ask,
            openUrlDecision("https://example.com", "s1", null, autoOpen = true),
        )
    }

    @Test
    fun `open_file opens same-session files, asks across sessions and rejects a blank path`() {
        assertEquals(HostToolDecision.Execute, openFileDecision("src/Main.kt", "s1", "s1"))
        assertEquals(HostToolDecision.Ask, openFileDecision("src/Main.kt", "s2", "s1"))
        assertEquals(HostToolDecision.Ask, openFileDecision("src/Main.kt", "s1", null))
        assertEquals(HostToolDecision.Error, openFileDecision("", "s1", "s1"))
        assertEquals(HostToolDecision.Error, openFileDecision(null, "s1", "s1"))
    }

    @Test
    fun `asked results tell the agent which session the user is viewing`() {
        assertEquals("Asked the user to confirm opening https://a.test.", askedResult("https://a.test", false))
        assertTrue(askedResult("https://a.test", true).contains("another ompweb session"))
        assertEquals("Opened https://a.test", openedResult("https://a.test"))
    }

    @Test
    fun `host_tool_result wraps one text block and the error flag`() {
        val ok = hostToolResultCommand("call-1", "Opened https://a.test", isError = false)
        assertEquals("host_tool_result", ok["type"]?.jsonPrimitive?.content)
        assertEquals("call-1", ok["id"]?.jsonPrimitive?.content)
        assertEquals("false", ok["isError"]?.jsonPrimitive?.content)
        val content = ok["result"]!!.jsonObject["content"]!!.jsonArray.single().jsonObject
        assertEquals("text", content["type"]?.jsonPrimitive?.content)
        assertEquals("Opened https://a.test", content["text"]?.jsonPrimitive?.content)

        val failed = hostToolResultCommand("call-2", UNSAFE_URL_RESULT, isError = true)
        assertEquals("true", failed["isError"]?.jsonPrimitive?.content)
    }

    @Test
    fun `host_uri_result reports content or an error, never both`() {
        val read = hostUriResultCommand("uri-1", content = "hello", contentType = "text/plain")
        assertEquals("hello", read["content"]?.jsonPrimitive?.content)
        assertEquals("text/plain", read["contentType"]?.jsonPrimitive?.content)
        assertFalse(read.containsKey("isError"))

        val error = hostUriResultCommand("uri-2", error = CLIPBOARD_READ_DENIED)
        assertEquals("true", error["isError"]?.jsonPrimitive?.content)
        assertEquals(CLIPBOARD_READ_DENIED, error["error"]?.jsonPrimitive?.content)
        assertFalse(error.containsKey("content"))
    }

    @Test
    fun `the registration payloads list the three host tools and the pi-web scheme`() {
        val tools = setHostToolsCommand()
        assertEquals("set_host_tools", tools["type"]?.jsonPrimitive?.content)
        val names = tools["tools"]!!.jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }
        assertEquals(listOf("open_url", "notify", "open_file"), names)

        val schemes = setHostUriSchemesCommand()
        assertEquals("set_host_uri_schemes", schemes["type"]?.jsonPrimitive?.content)
        val scheme = schemes["schemes"]!!.jsonArray.single().jsonObject
        assertEquals("pi-web", scheme["scheme"]?.jsonPrimitive?.content)
        assertEquals("true", scheme["writable"]?.jsonPrimitive?.content)
    }

    @Test
    fun `unknown tools and resources answer with the web wording`() {
        assertEquals(
            "Host tool \"unknown\" is not available in ompweb",
            unknownHostToolResult("unknown"),
        )
        assertEquals("Unknown pi-web resource: audio", unknownHostUriResult("audio"))
        assertEquals("No path provided", NO_PATH_RESULT)
        assertEquals("Notification shown", NOTIFICATION_SHOWN_RESULT)
    }
}
