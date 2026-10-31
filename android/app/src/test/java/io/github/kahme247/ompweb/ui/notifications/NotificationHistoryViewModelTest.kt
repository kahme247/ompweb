package io.github.kahme247.ompweb.ui.notifications

import io.github.kahme247.ompweb.domain.NotificationHistoryEntry
import io.github.kahme247.ompweb.domain.NotificationHistoryEvent
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.NotificationHistoryApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The history store's behavior from `lib/notification-history.ts`: optimistic
 * changes, rollback by reloading the server's list, no refetch for a delivered
 * event, and marked-read-on-close limited to what the list showed.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class NotificationHistoryViewModelTest {

    private fun entry(id: String, read: Boolean = false, at: Long = 1L): NotificationHistoryEntry =
        NotificationHistoryEntry(
            id = id,
            event = NotificationHistoryEvent(
                type = id.substringAfter(':'),
                sessionId = id.substringBefore(':'),
                sessionName = "Session ${id.substringBefore(':')}",
            ),
            at = at,
            read = read,
        )

    private class FakeHistoryApi : NotificationHistoryApi {
        var entries: List<NotificationHistoryEntry> = emptyList()
        var loads = 0
        var loadFailure: Throwable? = null
        var readFailure: Throwable? = null
        var removeFailure: Throwable? = null
        var clearFailure: Throwable? = null
        var loadGate: CompletableDeferred<Unit>? = null
        var readGate: CompletableDeferred<Unit>? = null
        val reads = mutableListOf<List<String>>()
        val removed = mutableListOf<String>()
        var clears = 0

        override suspend fun load(): List<NotificationHistoryEntry> {
            loads++
            val gate = loadGate
            if (gate != null) {
                loadGate = null
                gate.await()
            }
            loadFailure?.let { throw it }
            return entries
        }

        override suspend fun markRead(ids: List<String>) {
            val gate = readGate
            if (gate != null) {
                readGate = null
                gate.await()
            }
            readFailure?.let { throw it }
            reads += ids
            val wanted = ids.toSet()
            entries = entries.map { if (it.id in wanted) it.copy(read = true) else it }
        }

        override suspend fun remove(id: String) {
            removeFailure?.let { throw it }
            removed += id
            entries = entries.filterNot { it.id == id }
        }

        override suspend fun clear() {
            clearFailure?.let { throw it }
            clears++
            entries = emptyList()
        }
    }

    private fun deliveredEvent(sessionId: String = "s9", type: String = "completed") = buildJsonObject {
        put("type", type)
        put("sessionId", sessionId)
        put("sessionName", "Delivered")
    }

    @Test
    fun `refresh replaces the list with the server's and clears loading`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed"), entry("s2:input", read = true)) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        assertEquals(listOf("s1:completed", "s2:input"), vm.state.value.entries.map { it.id })
        assertEquals(1, vm.state.value.unreadCount)
        assertFalse(vm.state.value.loading)
        assertNull(vm.state.value.error)
    }

    @Test
    fun `a failed load keeps the shown list and reports the error`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()
        assertEquals(listOf("s1:completed"), vm.state.value.entries.map { it.id })

        api.loadFailure = ApiError.Http(500, "boom")
        vm.refresh()
        advanceUntilIdle()

        assertEquals(listOf("s1:completed"), vm.state.value.entries.map { it.id })
        assertEquals("HTTP 500", vm.state.value.error)
        assertFalse(vm.state.value.loading)

        vm.dismissError()
        assertNull(vm.state.value.error)
    }

    @Test
    fun `a delivered event joins the list without a refetch`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.onDelivered(deliveredEvent(sessionId = "s9"))
        advanceUntilIdle()

        assertEquals(1, api.loads)
        assertEquals(listOf("s9:completed", "s1:completed"), vm.state.value.entries.map { it.id })
        assertEquals(2, vm.state.value.unreadCount)
    }

    @Test
    fun `mark read is optimistic and sends exactly the requested ids`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed"), entry("s2:input")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.markRead(listOf("s1:completed", "missing"))
        // Optimistic: visible before the request runs.
        assertEquals(true, vm.state.value.entries.first { it.id == "s1:completed" }.read)
        assertEquals(1, vm.state.value.unreadCount)

        advanceUntilIdle()
        assertEquals(listOf(listOf("s1:completed")), api.reads)
        assertEquals(0, api.loads - 1)
    }

    @Test
    fun `a failed mark read reloads the server's list`() = runTest {
        val api = FakeHistoryApi().apply {
            entries = listOf(entry("s1:completed"))
            readFailure = ApiError.Http(500, "boom")
        }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()
        val loadsAfterRefresh = api.loads

        vm.markRead(listOf("s1:completed"))
        advanceUntilIdle()

        // The optimistic read is rolled back by the server's truth.
        assertEquals(false, vm.state.value.entries.single().read)
        assertEquals(1, vm.state.value.unreadCount)
        assertEquals(loadsAfterRefresh + 1, api.loads)
    }

    @Test
    fun `mark all read sends every unread id and leaves read entries alone`() = runTest {
        val api = FakeHistoryApi().apply {
            entries = listOf(entry("s1:completed"), entry("s2:input"), entry("s3:error", read = true))
        }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.markAllRead()
        advanceUntilIdle()

        assertEquals(listOf(listOf("s1:completed", "s2:input")), api.reads)
        assertEquals(0, vm.state.value.unreadCount)
    }

    @Test
    fun `mark all read does nothing when everything is read`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed", read = true)) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.markAllRead()
        advanceUntilIdle()
        assertTrue(api.reads.isEmpty())
    }

    @Test
    fun `remove is optimistic and a failure restores the server's entry`() = runTest {
        val api = FakeHistoryApi().apply {
            entries = listOf(entry("s1:completed"), entry("s2:input"))
        }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.remove("s1:completed")
        assertEquals(listOf("s2:input"), vm.state.value.entries.map { it.id })
        advanceUntilIdle()
        assertEquals(listOf("s1:completed"), api.removed)
        assertEquals(listOf("s2:input"), vm.state.value.entries.map { it.id })

        api.removeFailure = ApiError.Http(500, "boom")
        vm.remove("s2:input")
        advanceUntilIdle()
        assertEquals(listOf("s2:input"), vm.state.value.entries.map { it.id })
    }

    @Test
    fun `clear empties the list optimistically and a failure restores it`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed"), entry("s2:input")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.clearAll()
        assertTrue(vm.state.value.entries.isEmpty())
        advanceUntilIdle()
        assertEquals(1, api.clears)
        assertTrue(vm.state.value.entries.isEmpty())

        api.clearFailure = ApiError.Http(500, "boom")
        api.entries = listOf(entry("s1:completed"), entry("s2:input"))
        vm.clearAll()
        advanceUntilIdle()
        assertEquals(listOf("s1:completed", "s2:input"), vm.state.value.entries.map { it.id })
    }

    @Test
    fun `closing the list marks what it showed and leaves later arrivals unread`() = runTest {
        val api = FakeHistoryApi().apply {
            entries = listOf(entry("s1:completed"), entry("s2:input", read = true))
        }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.onListOpened()
        vm.onDelivered(deliveredEvent(sessionId = "s3", type = "error"))
        vm.onListClosed()
        advanceUntilIdle()

        assertEquals(
            listOf(listOf("s3:error", "s1:completed")),
            api.reads,
        )

        // An entry that arrives after the close is not marked by it.
        vm.onDelivered(deliveredEvent(sessionId = "s4", type = "input"))
        advanceUntilIdle()
        assertEquals(1, api.reads.size)
        assertEquals(1, vm.state.value.unreadCount)
    }

    @Test
    fun `closing without opening does nothing`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()

        vm.onListClosed()
        advanceUntilIdle()
        assertTrue(api.reads.isEmpty())
        assertEquals(1, vm.state.value.unreadCount)
    }

    @Test
    fun `a snapshot that raced a delivered event is replaced by a second load`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed")) }
        val vm = NotificationHistoryViewModel(api, this)

        val gate = CompletableDeferred<Unit>()
        api.loadGate = gate
        vm.refresh()
        runCurrent()

        // The server records the delivered event; the in-flight snapshot predates it.
        api.entries = listOf(entry("s9:completed", at = 5), entry("s1:completed"))
        vm.onDelivered(deliveredEvent(sessionId = "s9"))
        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(2, api.loads)
        assertEquals(listOf("s9:completed", "s1:completed"), vm.state.value.entries.map { it.id })
        assertEquals(5L, vm.state.value.entries.first().at)
    }

    @Test
    fun `a delivered event with a malformed body is ignored`() = runTest {
        val api = FakeHistoryApi()
        val vm = NotificationHistoryViewModel(api, this)
        vm.onDelivered(buildJsonObject { put("type", "completed") })
        advanceUntilIdle()
        assertTrue(vm.state.value.entries.isEmpty())
        assertEquals(0, api.loads)
    }

    @Test
    fun `reset clears the list and drops a load of the old origin`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()
        assertEquals(listOf("s1:completed"), vm.state.value.entries.map { it.id })

        val gate = CompletableDeferred<Unit>()
        api.loadGate = gate
        vm.refresh()
        runCurrent()
        vm.reset()
        assertTrue(vm.state.value.entries.isEmpty())
        assertFalse(vm.state.value.loading)

        // The old origin's answer arrives late; it must not fill the new list.
        api.entries = listOf(entry("old:completed"))
        gate.complete(Unit)
        advanceUntilIdle()
        assertTrue(vm.state.value.entries.isEmpty())
        assertNull(vm.state.value.error)
    }

    @Test
    fun `reset drops a change request of the old origin without a reload`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()
        val loadsBefore = api.loads

        val gate = CompletableDeferred<Unit>()
        api.readGate = gate
        vm.markRead(listOf("s1:completed"))
        runCurrent()
        vm.reset()
        gate.complete(Unit)
        advanceUntilIdle()

        assertEquals(loadsBefore, api.loads)
        assertTrue(vm.state.value.entries.isEmpty())
    }

    @Test
    fun `the new installation starts empty and does not mark the old list read`() = runTest {
        val api = FakeHistoryApi().apply { entries = listOf(entry("s1:completed")) }
        val vm = NotificationHistoryViewModel(api, this)
        vm.refresh()
        advanceUntilIdle()
        vm.onListOpened()

        vm.reset()
        vm.onDelivered(deliveredEvent(sessionId = "s2"))
        advanceUntilIdle()

        assertEquals(listOf("s2:completed"), vm.state.value.entries.map { it.id })
        assertTrue(api.reads.isEmpty())
    }
}
