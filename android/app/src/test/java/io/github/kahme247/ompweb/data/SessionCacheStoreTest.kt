package io.github.kahme247.ompweb.data

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * JVM tests for the cache-first store: origin isolation, the transcript LRU
 * with its three bounds, and that a broken file is a miss instead of a crash
 * (a cache must never be able to break the app that reads it).
 */
class SessionCacheStoreTest {

    @get:Rule
    val temp = TemporaryFolder()

    private var now = 1_000L

    private fun store(
        maxTranscripts: Int = 3,
        maxTotalBytes: Long = 1_000,
        maxTranscriptBytes: Long = 400,
    ) = SessionCacheStore(
        root = File(temp.root, "session-cache"),
        clock = { now },
        maxTranscripts = maxTranscripts,
        maxTotalBytes = maxTotalBytes,
        maxTranscriptBytes = maxTranscriptBytes,
    )

    @Test
    fun listAndProjectsRoundTripPerOrigin() {
        val cache = store()
        cache.writeSessions("http://a:1", """{"sessions":[{"id":"s1"}]}""", "\"etag-1\"")
        cache.writeProjects("http://a:1", """{"projects":[{"path":"/w"}]}""")

        val stored = cache.readSessions("http://a:1")
        assertEquals("""{"sessions":[{"id":"s1"}]}""", stored?.body)
        assertEquals("\"etag-1\"", stored?.etag)
        assertEquals("""{"projects":[{"path":"/w"}]}""", cache.readProjects("http://a:1"))
    }

    @Test
    fun anotherOriginNeverSeesTheList() {
        val cache = store()
        cache.writeSessions("http://a:1", """{"sessions":[]}""", null)

        assertNull("a server switch must not inherit the list", cache.readSessions("http://b:2"))
        assertNull(cache.readProjects("http://b:2"))
        assertNull(cache.read("http://b:2", "s1", null, false))
    }

    @Test
    fun transcriptRoundTripRequiresTheSameView() {
        val cache = store()
        cache.write("http://a:1", "s1", "leaf-1", false, """{"context":{}}""")

        assertEquals("""{"context":{}}""", cache.read("http://a:1", "s1", "leaf-1", false))
        assertNull("another branch is not this transcript", cache.read("http://a:1", "s1", "leaf-2", false))
        assertNull(cache.read("http://a:1", "s1", "leaf-1", true))
        assertNull(cache.read("http://a:1", "s2", "leaf-1", false))
    }

    @Test
    fun transcriptsAreEvictedLeastRecentlyUsedFirst() {
        val cache = store()
        cache.write("http://a:1", "s1", null, false, """{"n":1}""")
        now = 2_000L
        cache.write("http://a:1", "s2", null, false, """{"n":2}""")
        now = 3_000L
        cache.write("http://a:1", "s3", null, false, """{"n":3}""")

        // Touch s1 so it becomes the most recently used entry.
        now = 4_000L
        assertNotNull(cache.read("http://a:1", "s1", null, false))

        now = 5_000L
        cache.write("http://a:1", "s4", null, false, """{"n":4}""")

        assertEquals(3, cache.transcriptCount("http://a:1"))
        assertNotNull("touched entry survives", cache.read("http://a:1", "s1", null, false))
        assertNull("oldest untouched entry is gone", cache.read("http://a:1", "s2", null, false))
        assertNotNull(cache.read("http://a:1", "s3", null, false))
        assertNotNull(cache.read("http://a:1", "s4", null, false))
    }

    @Test
    fun aTranscriptLargerThanThePerResponseCapIsNotCached() {
        val cache = store(maxTranscriptBytes = 20)
        cache.write("http://a:1", "s1", null, false, """{"payload":"${"x".repeat(64)}"}""")

        assertNull(cache.read("http://a:1", "s1", null, false))
        assertEquals(0, cache.transcriptCount("http://a:1"))
    }

    @Test
    fun anOversizedRewriteDropsThePreviousCopy() {
        val cache = store(maxTranscriptBytes = 20)
        cache.write("http://a:1", "s1", null, false, """{"v":1}""")
        assertNotNull(cache.read("http://a:1", "s1", null, false))

        cache.write("http://a:1", "s1", null, false, """{"payload":"${"x".repeat(64)}"}""")

        assertNull("a stale copy must not answer the open", cache.read("http://a:1", "s1", null, false))
    }

    @Test
    fun theTotalBudgetEvictsTheOldestEntries() {
        // Four 100-byte bodies fit the count (10) but not the 250-byte budget.
        val cache = store(maxTranscripts = 10, maxTotalBytes = 250, maxTranscriptBytes = 400)
        for (index in 1..3) {
            now = 1_000L * index
            cache.write("http://a:1", "s$index", null, false, "x".repeat(100))
        }

        assertEquals(2, cache.transcriptCount("http://a:1"))
        assertNull(cache.read("http://a:1", "s1", null, false))
        assertNotNull(cache.read("http://a:1", "s2", null, false))
        assertNotNull(cache.read("http://a:1", "s3", null, false))
    }

    @Test
    fun aCorruptTranscriptFileIsAMissAndIsForgotten() {
        val cache = store()
        cache.write("http://a:1", "s1", null, false, """{"ok":true}""")
        val originDirs = File(temp.root, "session-cache").listFiles().orEmpty()
        val bodyFiles = originDirs.flatMap { dir -> dir.listFiles().orEmpty().filter { it.name.startsWith("t-") } }
        assertEquals(1, bodyFiles.size)
        bodyFiles.single().writeText("")

        assertNull(cache.read("http://a:1", "s1", null, false))
        assertEquals(0, cache.transcriptCount("http://a:1"))
    }

    @Test
    fun aCorruptListFileIsAMiss() {
        val cache = store()
        cache.writeSessions("http://a:1", """{"sessions":[]}""", null)
        val originDir = File(temp.root, "session-cache").listFiles().orEmpty().single()
        File(originDir, "sessions.json").writeText("{not json")

        assertNull(cache.readSessions("http://a:1"))
    }

    @Test
    fun clearAllDropsEveryOrigin() {
        val cache = store()
        cache.writeSessions("http://a:1", """{"sessions":[]}""", null)
        cache.write("http://a:1", "s1", null, false, """{"n":1}""")
        cache.write("http://b:2", "s1", null, false, """{"n":1}""")

        cache.clearAll()

        assertNull(cache.readSessions("http://a:1"))
        assertNull(cache.read("http://a:1", "s1", null, false))
        assertNull(cache.read("http://b:2", "s1", null, false))
        assertTrue(File(temp.root, "session-cache").listFiles().orEmpty().isEmpty())
    }

    @Test
    fun aCorruptTranscriptIndexDropsTheOrphanedBodies() {
        val cache = store(maxTranscripts = 10)
        cache.write("http://a:1", "s1", null, false, "x".repeat(100))
        now = 2_000L
        cache.write("http://a:1", "s2", null, false, "y".repeat(100))
        val dir = File(temp.root, "session-cache").listFiles().orEmpty().single()
        assertEquals(2, dir.listFiles().orEmpty().count { it.name.startsWith("t-") })

        // A broken index (filesystem, external tool): the entries are gone, the
        // bodies are still there and were unreachable from then on.
        File(dir, "transcripts.json").writeText("{not json")
        assertNull(cache.read("http://a:1", "s1", null, false))

        now = 3_000L
        cache.write("http://a:1", "s3", null, false, "z".repeat(100))

        assertEquals(
            "only the indexed body survives the rebuild",
            1,
            dir.listFiles().orEmpty().count { it.name.startsWith("t-") },
        )
        assertEquals(1, cache.transcriptCount("http://a:1"))
        assertNull("the orphaned transcript stays a miss", cache.read("http://a:1", "s1", null, false))
    }

    @Test
    fun anEmptyBodyIsNeverStored() {
        val cache = store()
        cache.write("http://a:1", "s1", null, false, "")
        cache.writeSessions("http://a:1", "", "\"etag\"")

        assertNull(cache.read("http://a:1", "s1", null, false))
        assertNull(cache.readSessions("http://a:1"))
    }
}
