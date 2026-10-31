package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class McpValidationTest {

    private fun stdio(command: String = "npx"): JsonObject = buildJsonObject {
        put("type", "stdio")
        put("command", command)
    }

    @Test
    fun `valid stdio and http servers pass`() {
        assertNull(validateMcpServer("playwright", stdio("npx")))
        assertNull(validateMcpServer("docs", buildJsonObject { put("type", "http"); put("url", "https://example.test/mcp") }))
        assertNull(
            validateMcpServer(
                "docs",
                buildJsonObject {
                    put("type", "sse")
                    put("url", "http://localhost:8080/sse")
                    put("headers", buildJsonObject { put("Authorization", "Bearer x") })
                    put("timeout", 30_000)
                    put("requestIdFormat", "string")
                    put("enabled", false)
                },
            ),
        )
        // A missing type means stdio.
        assertNull(validateMcpServer("local", buildJsonObject { put("command", "omp-mcp") }))
    }

    @Test
    fun `server names follow omp's rule`() {
        assertNotNull(validateMcpServer("", stdio()))
        assertNotNull(validateMcpServer("-leading", stdio()))
        assertNotNull(validateMcpServer("has space", stdio()))
        assertNotNull(validateMcpServer("a".repeat(129), stdio()))
        assertNull(validateMcpServer("a".repeat(128), stdio()))
        assertNull(validateMcpServer("my.server_1-x", stdio()))
    }

    @Test
    fun `type and target rules match the server`() {
        assertEquals(
            "Server type must be stdio, http, or sse",
            validateMcpServer("x", buildJsonObject { put("type", "websocket"); put("url", "https://x.test") }),
        )
        assertEquals(
            "Provide exactly one of command or url",
            validateMcpServer(
                "x",
                buildJsonObject { put("command", "a"); put("url", "https://x.test") },
            ),
        )
        assertEquals("Provide exactly one of command or url", validateMcpServer("x", buildJsonObject { }))
        assertEquals(
            "Provide exactly one of command or url",
            validateMcpServer("x", buildJsonObject { put("type", "stdio"); put("command", "  ") }),
        )
        assertEquals(
            "A stdio server requires a command",
            validateMcpServer(
                "x",
                buildJsonObject { put("type", "stdio"); put("command", "  "); put("url", "https://x.test") },
            ),
        )
        assertEquals(
            "An HTTP or SSE server requires a URL",
            validateMcpServer(
                "x",
                buildJsonObject { put("type", "http"); put("command", "a"); put("url", "") },
            ),
        )
        assertEquals(
            "Server URL must be an http or https URL",
            validateMcpServer("x", buildJsonObject { put("type", "http"); put("url", "ftp://x.test") }),
        )
    }

    @Test
    fun `server url needs a scheme and a host like the server`() {
        fun httpUrl(url: String) = buildJsonObject { put("type", "http"); put("url", url) }

        assertEquals("Server URL must be an http or https URL", validateMcpServer("x", httpUrl("http://")))
        assertEquals("Server URL must be an http or https URL", validateMcpServer("x", httpUrl("https://")))
        // `new URL` strips leading/trailing C0 controls and spaces, so the
        // server accepts padded URLs; Android mirrors that trimming.
        assertNull(validateMcpServer("x", httpUrl(" https://example.test/mcp ")))
        assertNull(validateMcpServer("x", httpUrl("\t https://example.test/mcp\n")))
        // `new URL` normalises the protocol to lower case.
        assertNull(validateMcpServer("x", httpUrl("HTTPS://example.test/mcp")))
    }

    @Test
    fun `optional fields are type-checked`() {
        assertNotNull(validateMcpServer("x", buildJsonObject { put("command", "a"); put("args", "nope") }))
        assertNotNull(
            validateMcpServer(
                "x",
                buildJsonObject { put("command", "a"); put("args", JsonArray(listOf(JsonPrimitive(1)))) },
            ),
        )
        assertNotNull(
            validateMcpServer(
                "x",
                buildJsonObject { put("command", "a"); put("env", buildJsonObject { put("K", 1) }) },
            ),
        )
        assertNotNull(validateMcpServer("x", buildJsonObject { put("command", "a"); put("cwd", 1) }))
        assertNotNull(validateMcpServer("x", buildJsonObject { put("command", "a"); put("enabled", "true") }))
        assertNotNull(validateMcpServer("x", buildJsonObject { put("command", "a"); put("timeout", -1) }))
        assertNotNull(validateMcpServer("x", buildJsonObject { put("command", "a"); put("timeout", 600_001) }))
        assertNotNull(
            validateMcpServer("x", buildJsonObject { put("command", "a"); put("requestIdFormat", "uuid") }),
        )
    }

    @Test
    fun `editor parse requires a JSON object`() {
        val valid = parseMcpServerJson(NEW_MCP_SERVER_JSON)
        assertTrue(valid is McpServerParse.Valid)
        val template = (valid as McpServerParse.Valid).server
        assertEquals("stdio", (template["type"] as JsonPrimitive).content)
        assertTrue((template["args"] as JsonArray).isEmpty())

        assertTrue(parseMcpServerJson("[1, 2]") is McpServerParse.Invalid)
        assertTrue(parseMcpServerJson("null") is McpServerParse.Invalid)
        assertTrue(parseMcpServerJson("\"text\"") is McpServerParse.Invalid)
        val broken = parseMcpServerJson("{ not json ")
        assertTrue(broken is McpServerParse.Invalid)
        assertTrue((broken as McpServerParse.Invalid).message.startsWith("Invalid JSON"))
        assertEquals(
            "Server configuration must be a JSON object",
            (parseMcpServerJson("[]") as McpServerParse.Invalid).message,
        )
    }

    @Test
    fun `summary reports target, enabled and validity`() {
        val stdioSummary = summarizeMcpServer(
            buildJsonObject {
                put("command", "npx")
                put("args", JsonArray(listOf(JsonPrimitive("-y"), JsonPrimitive("pkg"))))
            },
        )
        assertEquals("stdio", stdioSummary.type)
        assertEquals("npx -y pkg", stdioSummary.target)
        assertTrue(stdioSummary.enabled)
        assertTrue(stdioSummary.valid)

        val httpSummary = summarizeMcpServer(
            buildJsonObject {
                put("type", "http")
                put("url", "https://example.test/mcp")
                put("enabled", false)
            },
        )
        assertEquals("http", httpSummary.type)
        assertEquals("https://example.test/mcp", httpSummary.target)
        assertFalse(httpSummary.enabled)
        assertTrue(httpSummary.valid)

        val broken = summarizeMcpServer(buildJsonObject { put("type", "http"); put("command", "npx") })
        assertFalse(broken.valid)
    }
}
