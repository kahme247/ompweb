package io.github.kahme247.ompweb.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The skill-resolution report reaches the UI from two places: the live
 * `skill_diagnostics_update` frame and `get_state`. The revision fence keeps a
 * slower snapshot from resurrecting a report the live frame already replaced
 * (web `skillDiagnosticsSeqRef`), and the Disable reply obeys the same rule.
 */
class ChatEngineSkillDiagnosticsTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private fun engine(): ChatEngine = ChatEngine(now = { 1_800_000_000_000L })

    private val entry =
        """{"name":"clean","filePath":"C:/repo/.skills/clean/SKILL.md","source":"project"}"""

    private fun frame(showStartup: Boolean = true, reason: String = "source-order"): JsonObject = obj(
        """
        {"type":"skill_diagnostics_update","data":{
          "cwd":"C:/repo","showStartupDiagnostics":$showStartup,
          "diagnostics":[{"name":"clean","reason":"$reason","skills":[$entry],"duplicates":[]}]}}
        """.trimIndent(),
    )

    private fun state(showStartup: Boolean): JsonObject = obj(
        """
        {"running":false,"state":{"skillDiagnostics":{
          "cwd":"C:/repo","showStartupDiagnostics":$showStartup,
          "diagnostics":[]}}}
        """.trimIndent(),
    )

    @Test
    fun aLiveFramePublishesTheReportAndBumpsTheRevision() {
        val engine = engine()

        engine.onFrame(frame())
        engine.flush()

        val snapshot = engine.state.value.skillDiagnostics!!
        assertEquals("C:/repo", snapshot.cwd)
        assertTrue(snapshot.showStartupDiagnostics)
        assertEquals(1, engine.state.value.skillDiagnosticsRevision)
    }

    @Test
    fun aMalformedReportClearsTheBanner() {
        val engine = engine()
        engine.onFrame(frame())
        engine.flush()

        engine.onFrame(obj("""{"type":"skill_diagnostics_update","data":"nope"}"""))
        engine.flush()

        assertNull(engine.state.value.skillDiagnostics)
        assertEquals(2, engine.state.value.skillDiagnosticsRevision)
    }

    @Test
    fun aGetStateSnapshotFillsAMissingReport() {
        val engine = engine()

        engine.applyAgentState(state(showStartup = false), expectedRunId = engine.state.value.runId)
        engine.flush()

        val snapshot = engine.state.value.skillDiagnostics!!
        assertFalse(snapshot.showStartupDiagnostics)
        assertEquals(1, engine.state.value.skillDiagnosticsRevision)
    }

    @Test
    fun aSnapshotRequestedBeforeALiveFrameCannotOverwriteIt() {
        val engine = engine()
        val revisionWhenRequested = engine.state.value.skillDiagnosticsRevision

        engine.onFrame(frame(showStartup = true))
        engine.flush()
        engine.applyAgentState(
            state(showStartup = false),
            expectedSkillDiagnosticsRevision = revisionWhenRequested,
        )
        engine.flush()

        assertTrue(engine.state.value.skillDiagnostics!!.showStartupDiagnostics)
        assertEquals(1, engine.state.value.skillDiagnosticsRevision)
    }

    @Test
    fun aSetterReplyOvertakenByALiveFrameIsIgnored() {
        val engine = engine()
        engine.onFrame(frame(showStartup = true))
        engine.flush()
        val revisionWhenSent = engine.state.value.skillDiagnosticsRevision
        val live = engine.state.value.skillDiagnostics!!

        engine.onFrame(frame(showStartup = true))
        engine.flush()

        val applied = engine.applySkillDiagnostics(live, expectedRevision = revisionWhenSent)

        assertFalse(applied)
        assertEquals(2, engine.state.value.skillDiagnosticsRevision)
    }

    @Test
    fun aSetterReplyAppliesWhileNoNewerReportArrived() {
        val engine = engine()
        engine.onFrame(frame(showStartup = true))
        engine.flush()
        val revisionWhenSent = engine.state.value.skillDiagnosticsRevision
        val current = engine.state.value.skillDiagnostics!!

        val applied = engine.applySkillDiagnostics(
            current.copy(showStartupDiagnostics = false),
            expectedRevision = revisionWhenSent,
        )

        assertTrue(applied)
        assertFalse(engine.state.value.skillDiagnostics!!.showStartupDiagnostics)
        assertEquals(2, engine.state.value.skillDiagnosticsRevision)
    }
}
