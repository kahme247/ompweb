package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The client-side mirror of `lib/omp/agent-env-policy.ts`: the Settings editor
 * must reject a line before the server would, and never let a reserved name
 * through (A22).
 */
class AgentEnvTest {

    @Test
    fun `valid lines parse into values`() {
        val result = AgentEnv.parse(
            """
            # comment
            FOO=bar
            export PATHX=/usr/bin
            EMPTY=
            SPACED = padded value
            """.trimIndent(),
        )

        assertEquals(mapOf("FOO" to "bar", "PATHX" to "/usr/bin", "EMPTY" to "", "SPACED" to "padded value"), result.values)
        assertTrue(result.valid)
        assertEquals(emptyList<String>(), result.errors)
    }

    @Test
    fun `a later assignment wins like a shell`() {
        val result = AgentEnv.parse("FOO=1\nFOO=2")

        assertEquals(mapOf("FOO" to "2"), result.values)
        assertTrue(result.valid)
    }

    @Test
    fun `a line without a separator is reported with its line number`() {
        val result = AgentEnv.parse("FOO=bar\nBROKEN\n")

        assertEquals(mapOf("FOO" to "bar"), result.values)
        assertEquals(listOf("Line 2: expected KEY=VALUE"), result.errors)
        assertFalse(result.valid)
    }

    @Test
    fun `an empty name is reported`() {
        val result = AgentEnv.parse("=value")

        assertTrue(result.values.isEmpty())
        assertEquals(listOf("Line 1: missing variable name"), result.errors)
    }

    @Test
    fun `an invalid name is reported`() {
        val result = AgentEnv.parse("1BAD=x\nALSO-BAD=y\nDOTTED.NAME=z")

        assertTrue(result.values.isEmpty())
        assertEquals(
            listOf(
                "Line 1: \"1BAD\" is not a valid variable name",
                "Line 2: \"ALSO-BAD\" is not a valid variable name",
                "Line 3: \"DOTTED.NAME\" is not a valid variable name",
            ),
            result.errors,
        )
    }

    @Test
    fun `reserved exact names are denied case-insensitively`() {
        for (name in listOf("PATH", "Path", "PORT", "port", "NODE_OPTIONS", "HOME", "PI_CODING_AGENT_DIR", "NODE_ENV")) {
            val result = AgentEnv.parse("$name=1")
            assertTrue("$name must be denied", result.values.isEmpty())
            assertEquals(
                listOf("Line 1: \"$name\" is reserved by omp-web and cannot be set"),
                result.errors,
            )
        }
    }

    @Test
    fun `reserved prefixes are denied`() {
        for (name in listOf("OMP_WEB_TOKEN", "omp_web_password", "NEXT_PUBLIC_X", "_PRIVATE")) {
            val result = AgentEnv.parse("$name=1")
            assertTrue("$name must be denied", result.values.isEmpty())
            assertEquals(listOf("Line 1: \"$name\" is reserved by omp-web and cannot be set"), result.errors)
        }
        assertTrue(AgentEnv.isDeniedName("_"))
    }

    @Test
    fun `sanitize applies the same rules to an already structured record`() {
        val result = AgentEnv.sanitize(mapOf("FOO" to "bar", "PATH" to "/bin"))

        assertEquals(mapOf("FOO" to "bar"), result.values)
        assertEquals(1, result.errors.size)
    }

    @Test
    fun `format sorts by name so saves stay stable`() {
        assertEquals("A=1\nB=2\nC=3", AgentEnv.format(mapOf("C" to "3", "A" to "1", "B" to "2")))
        assertEquals("", AgentEnv.format(emptyMap()))
    }

    @Test
    fun `format and parse round-trip`() {
        val values = mapOf("ALPHA" to "one two", "BETA" to "", "GAMMA" to "a=b")
        val parsed = AgentEnv.parse(AgentEnv.format(values))

        assertEquals(values, parsed.values)
        assertTrue(parsed.valid)
    }
}
