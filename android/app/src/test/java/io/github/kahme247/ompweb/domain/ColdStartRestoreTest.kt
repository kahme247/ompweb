package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The cold-start restore decision behind `SessionsScreen`'s effect. The live
 * Phase 11 run broke it in two ways: an effect that ran before `GET
 * /api/sessions` answered consumed the marker without a hit, so a slow list
 * never restored, and a dead deep-link id stayed the marker forever.
 */
class ColdStartRestoreTest {

    @Test
    fun `the marker survives an effect that runs before the list is loaded`() {
        val step = decide(listLoaded = false, sessionIds = emptyList(), lastSessionId = "s1")

        assertEquals(ColdStartRestoreStep.Wait, step)
        assertFalse("the one attempt must not be burned before the list answered", step.consumes)
    }

    @Test
    fun `an empty list does not decide that the saved session is gone`() {
        // This is the race from the live run: `loading` was already false but
        // the session list was still empty, so the old effect dropped `pending`
        // and never retried.
        val step = decide(listLoaded = true, sessionIds = emptyList(), lastSessionId = "s1")

        assertEquals(ColdStartRestoreStep.Wait, step)
        assertFalse(step.consumes)
    }

    @Test
    fun `the saved session opens once the loaded list contains it`() {
        val step = decide(listLoaded = true, sessionIds = listOf("a", "s1"), lastSessionId = "s1")

        assertEquals(ColdStartRestoreStep.OpenSession("s1"), step)
        assertTrue(step.consumes)
    }

    @Test
    fun `a saved session the loaded list does not know is forgotten`() {
        val step = decide(listLoaded = true, sessionIds = listOf("a", "b"), lastSessionId = "dead")

        assertEquals(ColdStartRestoreStep.ForgetSession("dead"), step)
        assertTrue(step.consumes)
    }

    @Test
    fun `a re-run after the restore opens nothing a second time`() {
        val restore = decide(listLoaded = true, sessionIds = listOf("s1"), lastSessionId = "s1")
        assertEquals(ColdStartRestoreStep.OpenSession("s1"), restore)

        // Rotation: the effect runs again over the same persisted marker. The
        // first run already settled the process-level flag…
        val afterRestore = decide(
            pending = !restore.consumes,
            listLoaded = true,
            sessionIds = listOf("s1"),
            selectedSessionId = "s1",
            lastSessionId = "s1",
        )
        assertEquals(ColdStartRestoreStep.Done, afterRestore)

        // …and even a composition that runs before the flag write settles must
        // not navigate twice, because something is already on screen.
        val whileShown = decide(
            pending = true,
            listLoaded = true,
            sessionIds = listOf("s1"),
            selectedSessionId = "s1",
            lastSessionId = "s1",
        )
        assertEquals(ColdStartRestoreStep.Done, whileShown)
    }

    @Test
    fun `a composed pane consumes the marker before the list loads`() {
        // The new-session pane is restored from its own marker; a re-run while
        // it is open must not validate and open it twice.
        val step = decide(
            listLoaded = false,
            sessionIds = emptyList(),
            newSessionCwd = "/work/pane",
            lastNewSessionCwd = "/work/pane",
        )

        assertEquals(ColdStartRestoreStep.Done, step)
        assertTrue(step.consumes)
    }

    @Test
    fun `the new-session marker reopens its pane`() {
        val step = decide(
            listLoaded = true,
            sessionIds = emptyList(),
            lastNewSessionCwd = "/work/pane",
        )

        assertEquals(ColdStartRestoreStep.OpenNewSession("/work/pane"), step)
        assertTrue(step.consumes)
    }

    @Test
    fun `without a marker there is nothing to restore`() {
        assertEquals(ColdStartRestoreStep.Done, decide(listLoaded = true, sessionIds = emptyList()))
        assertTrue(decide(listLoaded = true, sessionIds = emptyList()).consumes)
    }

    private fun decide(
        pending: Boolean = true,
        listLoaded: Boolean,
        sessionIds: List<String>,
        selectedSessionId: String? = null,
        newSessionCwd: String? = null,
        lastSessionId: String? = null,
        lastNewSessionCwd: String? = null,
    ) = coldStartRestoreStep(
        pending = pending,
        listLoaded = listLoaded,
        sessionIds = sessionIds,
        selectedSessionId = selectedSessionId,
        newSessionCwd = newSessionCwd,
        lastSessionId = lastSessionId,
        lastNewSessionCwd = lastNewSessionCwd,
    )
}
