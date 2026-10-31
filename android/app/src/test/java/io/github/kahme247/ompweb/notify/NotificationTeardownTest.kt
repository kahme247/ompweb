package io.github.kahme247.ompweb.notify

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * X5: the unregister of a notification device has to run (and finish) while
 * the old cookie and origin still exist. These tests pin the order, the
 * bounded wait and the cancellation rule of [NotificationTeardown].
 */
class NotificationTeardownTest {

    @Test
    fun `unregister completes before the identity is forgotten`() = runTest {
        val events = mutableListOf<String>()
        NotificationTeardown().run(
            unregister = { events += "unregister" },
            forgetIdentity = { events += "forget" },
        )
        assertEquals(listOf("unregister", "forget"), events)
    }

    @Test
    fun `a hanging unregister is abandoned after the timeout`() = runTest {
        val events = mutableListOf<String>()
        NotificationTeardown(timeoutMillis = 3_000).run(
            unregister = {
                events += "unregister"
                delay(60_000)
            },
            forgetIdentity = { events += "forget" },
        )
        // Sign-out must not wait for an offline server, but the device id is
        // forgotten either way, so this installation cannot answer again.
        assertEquals(listOf("unregister", "forget"), events)
        assertEquals(3_000L, testScheduler.currentTime)
    }

    @Test
    fun `a failing unregister still forgets the identity`() = runTest {
        val events = mutableListOf<String>()
        NotificationTeardown().run(
            unregister = {
                events += "unregister"
                throw IllegalStateException("401")
            },
            forgetIdentity = { events += "forget" },
        )
        assertEquals(listOf("unregister", "forget"), events)
    }

    @Test
    fun `a cancelled sign-out does not forget the identity`() = runTest {
        var forgot = false
        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            NotificationTeardown().run(
                unregister = { awaitCancellation() },
                forgetIdentity = { forgot = true },
            )
        }
        runCurrent()
        job.cancelAndJoin()
        // The caller was cancelled, not the network: keep the identity so the
        // next sign-out can unregister for real.
        assertFalse(forgot)
        assertTrue(job.isCancelled)
    }
}
