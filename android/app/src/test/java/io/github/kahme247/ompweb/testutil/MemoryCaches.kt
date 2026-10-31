package io.github.kahme247.ompweb.testutil

import io.github.kahme247.ompweb.data.CachedSessionList
import io.github.kahme247.ompweb.data.SessionListCache
import io.github.kahme247.ompweb.data.TranscriptCache

/**
 * In-memory [TranscriptCache] for the JVM tests: the same key rules as the
 * file store (origin, session, leaf, compaction view) without touching disk.
 */
class MemoryTranscriptCache : TranscriptCache {

    /** One cache key: origin, session, leaf and compaction view. */
    data class Key(
        val origin: String,
        val sessionId: String,
        val leafId: String?,
        val includePreCompaction: Boolean,
    )

    private val entries = LinkedHashMap<Key, String>()

    /** Every write, in order, so a test can prove what was persisted. */
    val writes = mutableListOf<Key>()

    override fun read(origin: String, sessionId: String, leafId: String?, includePreCompaction: Boolean): String? =
        entries[Key(origin, sessionId, leafId, includePreCompaction)]

    override fun write(
        origin: String,
        sessionId: String,
        leafId: String?,
        includePreCompaction: Boolean,
        body: String,
    ) {
        val key = Key(origin, sessionId, leafId, includePreCompaction)
        entries[key] = body
        writes += key
    }
}

/** In-memory [SessionListCache] with the same per-origin scoping. */
class MemorySessionListCache : SessionListCache {

    private val sessions = LinkedHashMap<String, CachedSessionList>()
    private val projects = LinkedHashMap<String, String>()

    val sessionWrites = mutableListOf<String>()

    override fun readSessions(origin: String): CachedSessionList? = sessions[origin]

    override fun writeSessions(origin: String, body: String, etag: String?) {
        sessions[origin] = CachedSessionList(body = body, etag = etag)
        sessionWrites += origin
    }

    override fun readProjects(origin: String): String? = projects[origin]

    override fun writeProjects(origin: String, body: String) {
        projects[origin] = body
    }
}
