package io.github.kahme247.ompweb.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The skill-resolution report mirrors the allowlist of
 * `lib/skill-diagnostics.ts`: an unknown reason or a malformed entry rejects
 * the whole snapshot, so the UI never shows a partial report with the wrong
 * winner.
 */
class SkillDiagnosticsTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun element(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private val entry =
        """{"name":"clean","filePath":"C:/repo/.skills/clean/SKILL.md","source":"project"}"""

    private fun report(diagnostics: String): JsonObject = element(
        """
        {"cwd":"C:/repo","showStartupDiagnostics":true,"diagnostics":[$diagnostics]}
        """.trimIndent(),
    )

    @Test
    fun aFullReportParsesWithItsCounts() {
        val snapshot = parseSkillDiagnosticsSnapshot(
            report(
                """
                {"name":"clean","reason":"source-order",
                 "skills":[
                   $entry,
                   {"name":"clean","filePath":"C:/home/.omp/skills/clean/SKILL.md","source":"user","pluginName":"pack"}
                 ],
                 "duplicates":[{"skill":$entry,"retained":$entry}]}
                """.trimIndent(),
            ),
        )!!

        assertEquals("C:/repo", snapshot.cwd)
        assertTrue(snapshot.showStartupDiagnostics)
        val diagnostic = snapshot.diagnostics.single()
        assertEquals(SkillDiagnosticReason.SOURCE_ORDER, diagnostic.reason)
        assertEquals(2, diagnostic.skills.size)
        assertEquals("pack", diagnostic.skills[1].pluginName)
        assertNull(diagnostic.skills[0].pluginName)
        assertEquals(1, snapshot.conflictCount)
        assertEquals(1, snapshot.duplicateCount)
    }

    @Test
    fun everyWireReasonIsAccepted() {
        val reasons = listOf("source-order", "custom-directory", "authored-over-installed")
        val diagnostics = reasons.joinToString(",") { reason ->
            """{"name":"$reason","reason":"$reason","skills":[$entry],"duplicates":[]}"""
        }

        val snapshot = parseSkillDiagnosticsSnapshot(report(diagnostics))!!

        assertEquals(3, snapshot.diagnostics.size)
        assertEquals(0, snapshot.conflictCount)
        assertEquals(0, snapshot.duplicateCount)
    }

    @Test
    fun anUnknownReasonRejectsTheWholeReport() {
        assertNull(
            parseSkillDiagnosticsSnapshot(
                report(
                    """{"name":"clean","reason":"magic","skills":[$entry],"duplicates":[]}""",
                ),
            ),
        )
    }

    @Test
    fun aMissingFieldRejectsTheWholeReport() {
        assertNull(parseSkillDiagnosticsSnapshot(element("""{"showStartupDiagnostics":true,"diagnostics":[]}""")))
        assertNull(parseSkillDiagnosticsSnapshot(element("""{"cwd":"C:/repo","diagnostics":[]}""")))
        assertNull(parseSkillDiagnosticsSnapshot(element("""{"cwd":"C:/repo","showStartupDiagnostics":true}""")))
        assertNull(
            parseSkillDiagnosticsSnapshot(
                report("""{"name":"clean","reason":"source-order","skills":[],"duplicates":null}"""),
            ),
        )
    }

    @Test
    fun aMalformedSkillEntryRejectsTheWholeReport() {
        assertNull(
            parseSkillDiagnosticsSnapshot(
                report(
                    """
                    {"name":"clean","reason":"source-order",
                     "skills":[{"name":"clean","source":"project"}],"duplicates":[]}
                    """.trimIndent(),
                ),
            ),
        )
        assertNull(
            parseSkillDiagnosticsSnapshot(
                report(
                    """
                    {"name":"clean","reason":"source-order","skills":[$entry],
                     "duplicates":[{"skill":$entry}]}
                    """.trimIndent(),
                ),
            ),
        )
        assertNull(
            parseSkillDiagnosticsSnapshot(
                report(
                    """
                    {"name":"clean","reason":"source-order","skills":[
                       {"name":"clean","filePath":"p","source":"project","pluginName":7}
                     ],"duplicates":[]}
                    """.trimIndent(),
                ),
            ),
        )
    }

    @Test
    fun anAbsentElementIsAnUnavailableReport() {
        assertNull(parseSkillDiagnosticsSnapshot(null))
    }

    @Test
    fun anEmptyReportIsValidAndClean() {
        val snapshot = parseSkillDiagnosticsSnapshot(report(""))!!

        assertEquals(emptyList<SkillDiagnostic>(), snapshot.diagnostics)
        assertEquals(0, snapshot.conflictCount)
        assertEquals(0, snapshot.duplicateCount)
    }
}
