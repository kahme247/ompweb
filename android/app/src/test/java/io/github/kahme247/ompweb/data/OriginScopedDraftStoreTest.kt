package io.github.kahme247.ompweb.data

import io.github.kahme247.ompweb.testutil.MemoryDrafts
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Draft keys are bound to the configured server origin, so a second
 * installation's session ids can never surface another server's unsent text.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class OriginScopedDraftStoreTest {

    @Test
    fun `drafts are stored under the current origin only`() = runTest(UnconfinedTestDispatcher()) {
        val raw = MemoryDrafts()
        val origin = MutableStateFlow<String?>("https://a.example:8443")
        val store = OriginScopedDraftStore(raw, backgroundScope, origin)

        store.setDraft("s1", ChatDraft(value = "hello"))
        assertEquals(
            "the persisted key carries the origin",
            ChatDraft(value = "hello"),
            raw.getDraft("https://a.example:8443\u0000s1"),
        )
        assertEquals(ChatDraft(value = "hello"), store.getDraft("s1"))

        origin.value = "https://b.example"
        assertNull("another origin never sees the draft", store.getDraft("s1"))
        assertTrue("the published state follows the origin", store.state.value.isEmpty())
        store.setDraft("s1", ChatDraft(value = "other"))
        assertEquals(
            "a same-named key of the second origin is separate",
            ChatDraft(value = "hello"),
            raw.getDraft("https://a.example:8443\u0000s1"),
        )
        assertEquals("other", store.state.value["s1"]?.value)

        origin.value = "https://a.example:8443"
        assertEquals(
            "switching back restores the first origin's draft",
            "hello",
            store.getDraft("s1")?.value,
        )
        assertEquals("mine becomes visible again", setOf("s1"), store.state.value.keys)
        assertEquals("hello", store.state.value["s1"]?.value)
    }

    @Test
    fun `the published state is filtered to the current origin`() = runTest(UnconfinedTestDispatcher()) {
        val raw = MemoryDrafts()
        val origin = MutableStateFlow<String?>("https://a.example")
        val store = OriginScopedDraftStore(raw, backgroundScope, origin)

        store.setDraft("s1", ChatDraft(value = "mine"))
        raw.setDraft("https://b.example\u0000s2", ChatDraft(value = "theirs"))
        assertEquals("a foreign key never enters the state", setOf("s1"), store.state.value.keys)

        origin.value = "https://b.example"
        assertEquals(setOf("s2"), store.state.value.keys)
        assertEquals("theirs", store.state.value["s2"]?.value)
    }

    @Test
    fun `without an origin nothing is published`() = runTest(UnconfinedTestDispatcher()) {
        val raw = MemoryDrafts(mapOf("https://a.example\u0000s1" to ChatDraft(value = "a")))
        val store = OriginScopedDraftStore(raw, backgroundScope, MutableStateFlow(null))

        assertTrue("no session, no visible drafts", store.state.value.isEmpty())
    }

    @Test
    fun `recovery events are mapped back to plain keys and foreign origins are dropped`() =
        runTest(UnconfinedTestDispatcher()) {
            val raw = MemoryDrafts()
            val store = OriginScopedDraftStore(raw, backgroundScope, MutableStateFlow("https://a.example"))
            val events = mutableListOf<DraftRecoveryEvent>()
            backgroundScope.launch { store.recoveries.collect { events += it } }

            raw.recoverDraft("https://a.example\u0000s1", DraftRecovery(text = "queued"))
            raw.recoverDraft("https://b.example\u0000s2", DraftRecovery(text = "leaked"))

            assertEquals(listOf("s1"), events.map { it.key })
            assertEquals("queued", events.single().recovery.text)
        }

    @Test
    fun `clearAll drops every origin`() = runTest(UnconfinedTestDispatcher()) {
        val raw = MemoryDrafts(
            mapOf(
                "https://a.example\u0000s1" to ChatDraft(value = "a"),
                "https://b.example\u0000s2" to ChatDraft(value = "b"),
            ),
        )
        val store = OriginScopedDraftStore(raw, backgroundScope, MutableStateFlow("https://a.example"))

        store.clearAll()

        assertNull(raw.getDraft("https://a.example\u0000s1"))
        assertNull(raw.getDraft("https://b.example\u0000s2"))
        assertTrue(store.state.value.isEmpty())
    }
}
