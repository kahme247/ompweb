package io.github.kahme247.ompweb.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * X6/X7: a restarted service and a notification action run before DataStore's
 * first emission. Both wait via `SettingsStore.awaitLoaded`; these tests pin
 * that the wait ignores every not-yet-loaded snapshot instead of returning the
 * empty default (which has no origin and would stop the service / drop the
 * answer).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SettingsLoadedWaitTest {

    @Test
    fun `an already loaded snapshot is returned immediately`() = runTest {
        val snapshot = MutableStateFlow(SettingsSnapshot(loaded = true))
        assertEquals(true, awaitLoadedSnapshot(snapshot).loaded)
    }

    @Test
    fun `the wait stays suspended until the first loaded snapshot`() = runTest {
        val snapshot = MutableStateFlow(SettingsSnapshot())
        var result: SettingsSnapshot? = null
        val job = launch { result = awaitLoadedSnapshot(snapshot) }
        runCurrent()
        assertNull(result)

        // A later not-loaded emission is still not an answer.
        snapshot.value = SettingsSnapshot(themeId = "other")
        runCurrent()
        assertNull(result)

        snapshot.value = SettingsSnapshot(loaded = true, themeId = "other")
        runCurrent()
        assertTrue(job.isCompleted)
        assertEquals("other", result?.themeId)
    }
}
