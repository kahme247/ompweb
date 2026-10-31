package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.net.ProviderUsageSnapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A25: one shared poll loop that runs only while a surface is started.
 *
 * Virtual time drives the five-minute interval; the "lifecycle" here is
 * [ProviderUsagePoller.subscribe]/[unsubscribe], which the provider bar binds
 * to `ON_START`/`ON_STOP`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ProviderUsagePollerTest {

    private val requests = mutableListOf<Boolean>()

    private fun snapshot(generatedAt: Long): ProviderUsageSnapshot =
        ProviderUsageSnapshot(generatedAt = generatedAt, reports = emptyList())

    @Test
    fun `subscribing loads immediately and then every five minutes`() = runTest {
        val poller = ProviderUsagePoller(
            load = { force ->
                requests += force
                snapshot(requests.size.toLong())
            },
            scope = backgroundScope,
        )

        poller.subscribe()
        runCurrent()
        assertEquals(1, requests.size)
        assertEquals(1L, poller.state.value.snapshot?.generatedAt)

        advanceTimeBy(ProviderUsagePoller.DEFAULT_INTERVAL_MS)
        runCurrent()
        assertEquals(2, requests.size)

        advanceTimeBy(ProviderUsagePoller.DEFAULT_INTERVAL_MS)
        runCurrent()
        assertEquals(3, requests.size)
    }

    @Test
    fun `unsubscribing stops the loop, resubscribing loads again`() = runTest {
        val poller = ProviderUsagePoller(
            load = { force ->
                requests += force
                snapshot(requests.size.toLong())
            },
            scope = backgroundScope,
        )

        poller.subscribe()
        runCurrent()
        assertEquals(1, requests.size)

        poller.unsubscribe()
        runCurrent()
        advanceTimeBy(ProviderUsagePoller.DEFAULT_INTERVAL_MS * 3)
        runCurrent()
        assertEquals("STOPPED must not request", 1, requests.size)

        poller.subscribe()
        runCurrent()
        assertEquals("ON_START refreshes immediately", 2, requests.size)
        advanceTimeBy(ProviderUsagePoller.DEFAULT_INTERVAL_MS)
        runCurrent()
        assertEquals(3, requests.size)
    }

    @Test
    fun `two subscribers share one loop`() = runTest {
        val poller = ProviderUsagePoller(
            load = { force ->
                requests += force
                snapshot(requests.size.toLong())
            },
            scope = backgroundScope,
        )

        poller.subscribe()
        poller.subscribe()
        runCurrent()
        assertEquals(1, requests.size)

        poller.unsubscribe()
        advanceTimeBy(ProviderUsagePoller.DEFAULT_INTERVAL_MS)
        runCurrent()
        assertEquals("one observer is still attached", 2, requests.size)

        poller.unsubscribe()
        advanceTimeBy(ProviderUsagePoller.DEFAULT_INTERVAL_MS * 2)
        runCurrent()
        assertEquals(2, requests.size)
    }

    @Test
    fun `a manual refresh asks for a fresh snapshot`() = runTest {
        val poller = ProviderUsagePoller(
            load = { force ->
                requests += force
                snapshot(requests.size.toLong())
            },
            scope = backgroundScope,
        )

        poller.refresh(force = true)
        runCurrent()

        assertEquals(listOf(true), requests)
        assertEquals(1L, poller.state.value.snapshot?.generatedAt)
    }

    @Test
    fun `a failed load keeps the last snapshot and flags the error`() = runTest {
        var fail = false
        val poller = ProviderUsagePoller(
            load = {
                if (fail) error("offline")
                snapshot(7)
            },
            scope = backgroundScope,
        )

        poller.refresh()
        runCurrent()
        assertEquals(7L, poller.state.value.snapshot?.generatedAt)
        assertTrue(!poller.state.value.error)

        fail = true
        poller.refresh()
        // backgroundScope work runs on runCurrent; advanceUntilIdle only waits for foreground tasks.
        runCurrent()

        assertEquals(7L, poller.state.value.snapshot?.generatedAt)
        assertTrue(poller.state.value.error)
        assertTrue(!poller.state.value.loading)
    }

    @Test
    fun `unbalanced unsubscribes never go negative`() = runTest {
        val poller = ProviderUsagePoller(
            load = { force ->
                requests += force
                snapshot(1)
            },
            scope = backgroundScope,
        )

        poller.unsubscribe()
        poller.unsubscribe()
        poller.subscribe()
        runCurrent()
        assertEquals("one live observer restarts the loop", 1, requests.size)

        // The stale extra unsubscribes were clamped, so this one really stops it.
        poller.unsubscribe()
        advanceTimeBy(ProviderUsagePoller.DEFAULT_INTERVAL_MS * 2)
        runCurrent()
        assertEquals(1, requests.size)
    }

    @Test
    fun `a snapshot from a previous origin is discarded`() = runTest {
        var origin = "http://a"
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val poller = ProviderUsagePoller(
            load = { gate.await(); snapshot(9) },
            scope = backgroundScope,
            origin = { origin },
        )

        poller.refresh()
        runCurrent()
        origin = "http://b"
        gate.complete(Unit)
        runCurrent()

        assertNull("the old server's usage must not land", poller.state.value.snapshot)
        assertTrue(!poller.state.value.loading)
    }

    @Test
    fun `reset drops the previous snapshot and its expansion`() = runTest {
        val poller = ProviderUsagePoller(load = { snapshot(4) }, scope = backgroundScope)
        poller.refresh()
        runCurrent()
        poller.toggleExpanded("openai#0")
        assertEquals(4L, poller.state.value.snapshot?.generatedAt)

        poller.reset()

        assertNull(poller.state.value.snapshot)
        assertNull(poller.state.value.expandedKey)
        assertTrue(!poller.state.value.loading)
        assertTrue(!poller.state.value.error)
    }

    @Test
    fun `expanding one account row toggles it`() = runTest {
        val poller = ProviderUsagePoller(load = { snapshot(0) }, scope = backgroundScope)

        assertNull(poller.state.value.expandedKey)
        poller.toggleExpanded("openai#0")
        assertEquals("openai#0", poller.state.value.expandedKey)
        poller.toggleExpanded("openai#0")
        assertNull(poller.state.value.expandedKey)
    }
}
