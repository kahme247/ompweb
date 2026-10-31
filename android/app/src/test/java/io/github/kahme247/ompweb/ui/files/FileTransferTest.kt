package io.github.kahme247.ompweb.ui.files

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The upload batch budget of [FileTransfer.collectUploads] (S2): a selection
 * may not buffer more than the server accepts, so every pick is read at most
 * up to the per-file cap and the remaining aggregate budget.
 */
class FileTransferTest {

    /** Mimics `readBounded`: the bytes when the document fits, null otherwise. */
    private fun reader(sizes: Map<String, Int>): (String, Long) -> ByteArray? = { name, limit ->
        sizes.getValue(name).takeIf { it <= limit }?.let { ByteArray(it) }
    }

    @Test
    fun `picks stop reading once the aggregate budget is spent`() {
        val pick = FileTransfer.collectUploads(
            picks = listOf("a", "b", "c", "d"),
            nameOf = { name, _ -> name },
            read = reader(mapOf("a" to 10, "b" to 10, "c" to 5, "d" to 1)),
            perFileLimit = 10,
            totalLimit = 25,
        )

        // "c" fits exactly into what is left; "d" gets a zero limit and is
        // reported instead of being read (or buffered) at all.
        assertEquals(listOf("a", "b", "c"), pick.files.map { it.name })
        assertEquals(listOf(10, 10, 5), pick.files.map { it.bytes.size })
        assertEquals(listOf("d"), pick.rejected)
    }

    @Test
    fun `a file above the per-file cap is rejected inside an unused budget`() {
        val pick = FileTransfer.collectUploads(
            picks = listOf("small", "large"),
            nameOf = { name, _ -> name },
            read = reader(mapOf("small" to 4, "large" to 11)),
            perFileLimit = 10,
            totalLimit = 100,
        )

        assertEquals(listOf("small"), pick.files.map { it.name })
        assertEquals(listOf("large"), pick.rejected)
    }

    @Test
    fun `a used name forces a distinct server name`() {
        val pick = FileTransfer.collectUploads(
            picks = listOf("a.txt", "a.txt"),
            nameOf = { name, _ -> name },
            read = reader(mapOf("a.txt" to 2)),
            perFileLimit = 10,
            totalLimit = 100,
            usedNames = setOf("a.txt"),
        )

        assertEquals(listOf("a (2).txt", "a (3).txt"), pick.files.map { it.name })
    }
}
