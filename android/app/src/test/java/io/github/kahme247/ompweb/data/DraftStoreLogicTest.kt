package io.github.kahme247.ompweb.data

import io.github.kahme247.ompweb.domain.ComposerImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Draft merging, eviction and the recovered-text rules of `lib/draft-store.ts`. */
class DraftStoreLogicTest {

    @Test
    fun `recovery prepends like a message block`() {
        assertEquals("new\n\nexisting", mergeRecoveredText("existing", DraftRecovery("new")))
        assertEquals("new", mergeRecoveredText("", DraftRecovery("new")))
        assertEquals("", mergeRecoveredText("", DraftRecovery("")))
    }

    @Test
    fun `a later recovery replaces the earlier block while it is still the lead`() {
        val first = DraftRecovery("one")
        val merged = mergeRecoveredText("", first)
        val second = DraftRecovery(
            text = "one\n\ntwo",
            replace = DraftRecovery.Replace(lead = "one", fallback = "two"),
        )
        assertEquals("one\n\ntwo", mergeRecoveredText(merged, second))
    }

    @Test
    fun `a changed draft keeps both the fallback and the user's text`() {
        val recovery = DraftRecovery(
            text = "queued",
            replace = DraftRecovery.Replace(lead = "old", fallback = "queued"),
        )
        assertEquals("queued\n\ntyped", mergeRecoveredText("typed", recovery))
    }

    @Test
    fun `the registry keeps insertion order and evicts the oldest draft`() {
        val registry = DraftRegistry(maxDrafts = 2)
        registry.set("a", ChatDraft(value = "first"))
        registry.set("b", ChatDraft(value = "second"))
        registry.set("a", ChatDraft(value = "updated"))
        registry.set("c", ChatDraft(value = "third"))

        assertNull("the first-inserted key is evicted", registry.get("a"))
        assertEquals("second", registry.get("b")?.value)
        assertEquals("third", registry.get("c")?.value)
    }

    @Test
    fun `only text and metadata survive a registry clone`() {
        val registry = DraftRegistry()
        registry.set(
            "s1",
            ChatDraft(
                value = "draft",
                images = listOf(ComposerImage("AAAA", "image/png")),
            ),
        )
        val clone = registry.get("s1")!!
        assertEquals("draft", clone.value)
        assertEquals(1, clone.images.size)
        assertTrue(clone.hasAttachments)
        assertFalse(registry.isEmpty())
    }
}
