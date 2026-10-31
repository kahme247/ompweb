package io.github.kahme247.ompweb.chat

import io.github.kahme247.ompweb.net.ElsewhereSession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The chat's view of a foreign owner: where the report comes from, when it is
 * kept and when a run of this app replaces it. The banner and the send gate
 * read exactly this field.
 */
class ChatForeignRunTest {

    private val json = Json { ignoreUnknownKeys = true }

    private fun obj(text: String): JsonObject = json.parseToJsonElement(text).jsonObject

    private fun engine(): ChatEngine = ChatEngine(now = { 1_800_000_000_000L })

    /** The server's single-session report: no id (the list entry has one). */
    private val owner = ElsewhereSession(
        kind = "terminal",
        source = "process",
        running = true,
        active = true,
    )

    @Test
    fun `a snapshot reports the foreign owner`() {
        val engine = engine()
        engine.setSession("s1")
        engine.applyAgentState(
            obj(
                """{"running":false,"state":{"isPromptRunning":false},""" +
                    """"elsewhere":{"kind":"terminal","source":"process",""" +
                    """"running":true,"active":true}}""",
            ),
        )
        assertEquals(owner, engine.state.value.foreignRun)
    }

    @Test
    fun `the owner report of the server reaches the banner without an id`() {
        val engine = engine()
        engine.setSession("s1")
        // The real `GET /api/agent/{id}` body: the single-session report is the
        // server's `SessionElsewhere` and has no `id` (and no `cwd`/`pid`: the
        // owner's process details stay on the server). A decode that insisted
        // on them dropped every live report — the banner never appeared while
        // the session list showed the very same owner.
        engine.applyAgentState(
            obj(
                """{"running":false,"state":{"isStreaming":false,"isPromptRunning":false},""" +
                    """"elsewhere":{"kind":"terminal","source":"process","running":false,""" +
                    """"active":true,"lastActivityAt":1800000000000}}""",
            ),
        )
        val report = engine.state.value.foreignRun
        assertNotNull("the banner must not depend on a field the server never sends", report)
        assertEquals("terminal", report!!.kind)
        assertEquals("process", report.source)
        assertEquals(1_800_000_000_000L, report.lastActivityAt)
    }

    @Test
    fun `a snapshot with an explicit null clears the owner`() {
        val engine = engine()
        engine.setSession("s1")
        engine.setForeignRun(owner)
        engine.applyAgentState(obj("""{"running":false,"elsewhere":null}"""))
        assertNull("the owner ended", engine.state.value.foreignRun)
    }

    @Test
    fun `an older server without the field keeps what is known`() {
        val engine = engine()
        engine.setSession("s1")
        engine.setForeignRun(owner)
        engine.applyAgentState(obj("""{"running":false,"state":{"isPromptRunning":false}}"""))
        assertEquals("no report is not a report of absence", owner, engine.state.value.foreignRun)
    }

    @Test
    fun `a locally running session drops a stale owner report`() {
        val engine = engine()
        engine.setSession("s1")
        engine.setForeignRun(owner)
        engine.applyAgentState(
            obj("""{"running":true,"state":{"isPromptRunning":true},"elsewhere":{"source":"process"}}"""),
        )
        assertNull("this server drives the run", engine.state.value.foreignRun)
    }

    @Test
    fun `starting a prompt from here clears the owner`() {
        val engine = engine()
        engine.setSession("s1")
        engine.setForeignRun(owner)
        engine.sendStarted("into a copy", runId = 7)
        assertNull("the user chose the copy", engine.state.value.foreignRun)
    }

    @Test
    fun `the refusal body sets the owner without a state snapshot`() {
        val engine = engine()
        engine.setSession("s1")
        engine.setForeignRun(owner)
        // The same report is not a state change, so no update is published.
        engine.setForeignRun(owner)
        assertNotNull(engine.state.value.foreignRun)
        engine.setForeignRun(null)
        assertNull(engine.state.value.foreignRun)
    }

    @Test
    fun `the contention fork clears the owner and reports the original`() {
        val engine = engine()
        engine.setSession("s1")
        engine.drainEffects()
        engine.setForeignRun(owner)
        // A forced send raced the owner: omp moved the conversation to a copy.
        // The copy is this app's now; the original stays with the other process.
        engine.onFrame(obj("""{"type":"session_contention_fork","fromId":"s1","toId":"s2"}"""))
        engine.flush()
        assertEquals(
            listOf(ChatEffect.ContentionFork("s1", "s2")),
            engine.drainEffects(),
        )
        assertNull("the copy is not foreign any more", engine.state.value.foreignRun)
    }

    @Test
    fun `an idle live child owns the session without looking like a run`() {
        val engine = engine()
        engine.setSession("s1")
        engine.setForeignRun(null)
        // The fresh-spawn answer from the report: omp is alive, answers
        // `get_state` with nothing running. `alive` keeps the ownership, `running`
        // stays false, so the screen must not say "working".
        engine.applyAgentState(
            obj(
                """{"running":false,"alive":true,""" +
                    """"state":{"isStreaming":false,"isPromptRunning":false,"isCompacting":false}}""",
            ),
        )
        assertTrue("the live state is known", engine.state.value.liveStateKnown)
        assertEquals("no run in flight", false, engine.state.value.agentRunning)
        assertEquals("nothing is busy", false, engine.state.value.busy)
    }

    @Test
    fun `an idle live child keeps the owner banner down`() {
        val engine = engine()
        engine.setSession("s1")
        engine.setForeignRun(owner)
        // `alive` (not `running`) is what proves the session is ours: an idle
        // wrapper still holds it, and a stale owner report must not survive it.
        engine.applyAgentState(
            obj(
                """{"running":false,"alive":true,"state":{"isPromptRunning":false},""" +
                    """"elsewhere":{"kind":"terminal","source":"process","running":true,"active":true}}""",
            ),
        )
        assertNull("our idle child owns the session", engine.state.value.foreignRun)
    }

    @Test
    fun `an answer without a child reports the foreign owner`() {
        val engine = engine()
        engine.setSession("s1")
        engine.applyAgentState(
            obj(
                """{"running":false,"alive":false,"state":{"isPromptRunning":false},""" +
                    """"elsewhere":{"kind":"terminal","source":"process","running":true,"active":true}}""",
            ),
        )
        assertEquals(owner, engine.state.value.foreignRun)
    }

    @Test
    fun `a slow answer without a run settles the marked turn`() {
        val engine = engine()
        engine.setSession("s1")
        engine.applyAgentState(obj("""{"running":true,"alive":true,"state":{"isPromptRunning":true}}"""))
        assertTrue("the turn is marked", engine.state.value.busy)

        // 503 `session_slow` with `running:false`: the child is only blocked, so
        // the turn the screen still shows is over.
        engine.markLiveStateSlow(false)

        assertEquals("the run is settled", false, engine.state.value.busy)
        assertTrue("the answer counts as live state", engine.state.value.liveStateKnown)
    }

    @Test
    fun `a slow answer that reports or omits the run keeps the turn`() {
        val unknown = engine()
        unknown.setSession("s1")
        unknown.markLiveStateSlow(null)
        assertTrue("an older server's answer keeps the turn marked", unknown.state.value.agentRunning)

        val running = engine()
        running.setSession("s1")
        running.markLiveStateSlow(true)
        assertTrue("a reported run keeps the turn marked", running.state.value.agentRunning)
    }
}
