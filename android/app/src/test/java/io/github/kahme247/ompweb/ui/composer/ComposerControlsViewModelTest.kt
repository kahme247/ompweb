package io.github.kahme247.ompweb.ui.composer

import io.github.kahme247.ompweb.data.SettingsSnapshot
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.ComposerControlsApi
import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.net.ModelsResponse
import io.github.kahme247.ompweb.testutil.FakeChatSettings
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * B15/B16/B18: the composer's Fast, Slow and advisor controls send the omp
 * command the toggle promises, and the advisor flag travels on every command of
 * a session whose toggle is on (web `?advisor=1` on the spawn query).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ComposerControlsViewModelTest {

    private class Recorded(val sessionId: String, val command: JsonObject, val advisor: Boolean)

    private class FakeApi : ComposerControlsApi {
        val commands = mutableListOf<Recorded>()
        var running = false

        override suspend fun models(cwd: String?): ModelsResponse = ModelsResponse()

        override suspend fun agentState(sessionId: String): JsonObject = buildJsonObject {
            put("running", running)
        }

        override suspend fun agentCommand(
            sessionId: String,
            command: JsonObject,
            advisor: Boolean,
            force: Boolean,
        ): JsonElement? {
            commands += Recorded(sessionId, command, advisor)
            return null
        }
    }

    @Test
    fun setFastModeSendsTheToggleCommand() = runTest {
        val api = FakeApi()
        val settings = FakeChatSettings()
        val controls = ComposerControlsViewModel(api, settings, this)
        controls.bind("s1", "/repo")
        advanceUntilIdle()

        controls.onFastModeChange(true)
        advanceUntilIdle()

        val command = api.commands.last()
        assertEquals("s1", command.sessionId)
        assertEquals("set_fast_mode", command.command["type"]?.jsonPrimitive?.content)
        assertTrue("the toggle value travels", command.command["enabled"]!!.jsonPrimitive.boolean)
        assertTrue("the optimistic state follows the toggle", controls.state.value.fastModeEnabled)

        controls.onFastModeChange(false)
        advanceUntilIdle()
        assertFalse(api.commands.last().command["enabled"]!!.jsonPrimitive.boolean)
        assertFalse(controls.state.value.fastModeEnabled)
    }

    @Test
    fun anIdleLiveChildBacksSlowWithTheServerValue() = runTest {
        // Same rule as the web (`setSlowModeSupported(agentState.alive ? … :
        // undefined)`): `alive` (the child exists), not `running` (a turn is in
        // flight), decides whether the live answer stands. An idle wrapper still
        // answers `get_state`, so the catalog must not override its Slow support.
        val controls = ComposerControlsViewModel(FakeApi(), FakeChatSettings(), this)
        controls.bind("s1", "/repo")
        advanceUntilIdle()
        assertFalse("a session without a child falls back to the catalog", controls.state.value.slowModeSupported)

        controls.onAgentState(
            buildJsonObject {
                put("running", false)
                put("alive", true)
                put("state", buildJsonObject { put("slowModeSupported", true) })
            },
        )
        assertTrue(
            "the idle child's own answer backs Slow",
            controls.state.value.slowModeSupported,
        )

        controls.onAgentState(
            buildJsonObject {
                put("running", true)
                put("alive", false)
                put("state", buildJsonObject { put("slowModeSupported", true) })
            },
        )
        assertFalse(
            "without a child the catalog decides again",
            controls.state.value.slowModeSupported,
        )
    }

    @Test
    fun setSlowModeSendsTheToggleCommand() = runTest {
        val api = FakeApi()
        val controls = ComposerControlsViewModel(api, FakeChatSettings(), this)
        controls.bind("s1", "/repo")
        advanceUntilIdle()

        controls.onSlowModeChange(true)
        advanceUntilIdle()

        val command = api.commands.last()
        assertEquals("set_slow_mode", command.command["type"]?.jsonPrimitive?.content)
        assertTrue(command.command["enabled"]!!.jsonPrimitive.boolean)
        assertEquals("the advisor never rides on a slow toggle", false, command.advisor)
    }

    @Test
    fun advisorFlagTravelsOnEveryCommandAndPersistsPerSession() = runTest {
        val api = FakeApi()
        val settings = FakeChatSettings()
        val controls = ComposerControlsViewModel(api, settings, this)

        // A new chat takes the pre-spawn toggle and persists it once the real
        // session id exists.
        controls.bind(null, "/repo")
        controls.onAdvisorChange(true)
        controls.bind("s1", "/repo")
        advanceUntilIdle()

        assertTrue(controls.state.value.advisorEnabled)
        assertTrue(
            "the choice is stored for the session",
            settings.snapshot.value.advisorSessions.contains("s1"),
        )

        controls.onFastModeChange(true)
        advanceUntilIdle()
        assertTrue("the spawn flag rides on later commands", api.commands.last().advisor)

        // Another session has its own advisor state.
        controls.bind("s2", "/repo")
        advanceUntilIdle()
        assertFalse("the flag is per session", controls.state.value.advisorEnabled)
        controls.onSlowModeChange(true)
        advanceUntilIdle()
        assertFalse("s2 never inherits s1's advisor", api.commands.last().advisor)

        controls.bind("s1", "/repo")
        advanceUntilIdle()
        assertTrue("s1 remembers its toggle", controls.state.value.advisorEnabled)
    }

    @Test
    fun disablingTheAdvisorStopsSendingTheSpawnFlag() = runTest {
        val api = FakeApi()
        val settings = FakeChatSettings()
        val controls = ComposerControlsViewModel(api, settings, this)
        controls.bind(null, "/repo")
        controls.onAdvisorChange(true)
        controls.bind("s1", "/repo")
        advanceUntilIdle()
        assertTrue(settings.snapshot.value.advisorSessions.contains("s1"))

        controls.onAdvisorChange(false)
        controls.onFastModeChange(true)
        advanceUntilIdle()

        assertFalse(api.commands.last().advisor)
        assertFalse(settings.snapshot.value.advisorSessions.contains("s1"))
    }

    @Test
    fun coldStartReadsThePersistedAdvisorFlagInsteadOfTheDefaults() = runTest {
        val api = FakeApi()
        // A previous process enabled the advisor for s1.
        val settings = FakeChatSettings(
            SettingsSnapshot(loaded = true, advisorSessions = setOf("s1")),
        )
        val controls = ComposerControlsViewModel(api, settings, this)

        // The first bind of a new process has no in-memory picks: it must not
        // look "spawned" (B18: the flag used to reset to the default false).
        controls.bind("s1", "/repo")
        advanceUntilIdle()

        assertTrue(controls.state.value.advisorEnabled)
        controls.onFastModeChange(true)
        advanceUntilIdle()
        assertTrue("the restored flag rides on later commands", api.commands.last().advisor)
    }

    @Test
    fun theNewSessionPaneHandsItsAdvisorChoiceToTheChatControls() = runTest {
        val api = FakeApi()
        val settings = FakeChatSettings()
        val pane = ComposerControlsViewModel(api, settings, this)
        val chat = ComposerControlsViewModel(api, settings, this)

        pane.bind(null, "/repo")
        pane.onAdvisorChange(true)
        pane.onSessionCreated("s1")
        advanceUntilIdle()

        assertTrue(
            "the choice is stored for the id the chat will open",
            settings.snapshot.value.advisorSessions.contains("s1"),
        )
        chat.bind("s1", "/repo")
        advanceUntilIdle()
        assertTrue("the chat composer shows the pane's choice", chat.state.value.advisorEnabled)

        chat.onFastModeChange(true)
        advanceUntilIdle()
        assertTrue("and sends the spawn flag like the web's ?advisor=1", api.commands.last().advisor)
    }

    @Test
    fun creatingASessionAppliesThePanesFastToggleForTheNewId() = runTest {
        val api = FakeApi()
        val settings = FakeChatSettings()
        val pane = ComposerControlsViewModel(api, settings, this)

        pane.bind(null, "/repo")
        pane.onFastModeChange(true)
        pane.onSessionCreated("s1")
        advanceUntilIdle()

        val command = api.commands.last()
        assertEquals("the spawn setter is sent", "set_fast_mode", command.command["type"]?.jsonPrimitive?.content)
        assertEquals("for the created session, not the pane's null scope", "s1", command.sessionId)
        assertTrue(command.command["enabled"]!!.jsonPrimitive.boolean)
    }

    @Test
    fun creatingASessionWithoutPendingTogglesSendsNothing() = runTest {
        val api = FakeApi()
        val settings = FakeChatSettings()
        val pane = ComposerControlsViewModel(api, settings, this)

        pane.bind(null, "/repo")
        pane.onSessionCreated("s1")
        advanceUntilIdle()

        assertTrue("no unsaved toggle, no command", api.commands.isEmpty())
        assertFalse(settings.snapshot.value.advisorSessions.contains("s1"))
    }

    @Test
    fun compactRunsTheBuiltinAndAbortCompactionCancelsIt() = runTest {
        val api = FakeApi()
        val controls = ComposerControlsViewModel(api, FakeChatSettings(), this)
        controls.bind("s1", "/repo")
        advanceUntilIdle()

        controls.compact()
        advanceUntilIdle()

        assertTrue(
            "the sheet's Compact button runs omp's builtin",
            api.commands.any {
                it.sessionId == "s1" && it.command["type"]?.jsonPrimitive?.content == "compact"
            },
        )
        assertFalse("the run settles once the command returns", controls.state.value.isCompacting)

        controls.abortCompaction()
        advanceUntilIdle()

        val abort = api.commands.last {
            it.command["type"]?.jsonPrimitive?.content == "abort_compaction"
        }
        assertEquals("the abort targets the bound session", "s1", abort.sessionId)
    }

    /**
     * N7: a settings command refused because another omp process owns the chat
     * (409 `session_running_elsewhere`) is reported as an ownership refusal, not
     * as the prompt wording ("your message was not sent"), so the chat can show
     * its banner and a command-specific message.
     */
    @Test
    fun aForeignOwnerRefusalIsReportedAsOwnershipNotAsACommandError() = runTest {
        val api = object : ComposerControlsApi {
            override suspend fun models(cwd: String?): ModelsResponse = ModelsResponse()

            override suspend fun agentState(sessionId: String): JsonObject = buildJsonObject { }

            override suspend fun agentCommand(
                sessionId: String,
                command: JsonObject,
                advisor: Boolean,
                force: Boolean,
            ): JsonElement? = throw ApiError.SessionRunningElsewhere(
                ElsewhereSession(kind = "terminal", source = "process", running = false, active = true),
            )
        }
        val controls = ComposerControlsViewModel(api, FakeChatSettings(), this)
        controls.bind("s1", "/repo")
        advanceUntilIdle()

        controls.onFastModeChange(true)
        advanceUntilIdle()

        val refusal = controls.state.value.foreignRefusal
        assertNotNull("the chat learns the owner", refusal)
        assertEquals("terminal", refusal!!.elsewhere?.kind)
        assertNull("the send wording is not a command error", controls.state.value.error)

        controls.clearForeignRefusal()
        assertNull("the chat consumed the refusal", controls.state.value.foreignRefusal)
    }
}
