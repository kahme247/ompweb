package io.github.kahme247.ompweb.data

import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** The cached session list of one origin together with its validator. */
data class CachedSessionList(val body: String, val etag: String?)

/**
 * The workspace's cache seam (`SessionsViewModel`): the last session list and
 * the last project list of one origin. Bodies are stored exactly as they came
 * from the server; a body that no longer parses is dropped on read.
 */
interface SessionListCache {

    fun readSessions(origin: String): CachedSessionList?

    fun writeSessions(origin: String, body: String, etag: String?)

    fun readProjects(origin: String): String?

    fun writeProjects(origin: String, body: String)
}

/**
 * The chat's cache seam (`ChatViewModel`): the whole context response of the
 * last opened sessions, keyed by the view they were fetched for (`leafId` and
 * the compaction setting). A cached page is only ever used for exactly that
 * view — seeding a transcript from another branch would show the wrong one.
 */
interface TranscriptCache {

    fun read(origin: String, sessionId: String, leafId: String?, includePreCompaction: Boolean): String?

    fun write(origin: String, sessionId: String, leafId: String?, includePreCompaction: Boolean, body: String)
}

/**
 * Cache-first storage for the app's own startup payloads, in `filesDir`
 * (never in the backup set: `allowBackup` is false and both rules files
 * exclude everything).
 *
 * Everything is scoped to one server origin by directory, so a server switch
 * can never read another installation's list or transcript, and
 * [clearLocalUserData][io.github.kahme247.ompweb.AppContainer.clearLocalUserData]
 * deletes the whole tree on logout, a switch and a 401.
 *
 * Transcripts are an LRU with three bounds: at most [maxTranscripts] entries,
 * [maxTotalBytes] in total and [maxTranscriptBytes] per response (a larger
 * transcript is not cached at all — it would not fit the budget and is the
 * one the phone can already re-fetch by opening it). Bodies are written
 * through a temp file, so a killed process never leaves a half JSON body
 * behind that would paint a broken transcript.
 */
class SessionCacheStore(
    private val root: File,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val maxTranscripts: Int = MAX_TRANSCRIPTS,
    private val maxTotalBytes: Long = MAX_TOTAL_BYTES,
    private val maxTranscriptBytes: Long = MAX_TRANSCRIPT_BYTES,
) : SessionListCache, TranscriptCache {

    private val lock = Any()

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    // --- session list / projects -------------------------------------------

    override fun readSessions(origin: String): CachedSessionList? = synchronized(lock) {
        val envelope = readEnvelope(originDir(origin), LIST_FILE, ListEnvelope.serializer()) ?: return null
        if (envelope.body.isEmpty()) return null
        CachedSessionList(body = envelope.body, etag = envelope.etag)
    }

    override fun writeSessions(origin: String, body: String, etag: String?) = synchronized(lock) {
        if (body.isEmpty()) return
        writeEnvelope(
            originDir(origin),
            LIST_FILE,
            ListEnvelope.serializer(),
            ListEnvelope(etag = etag, body = body, savedAt = clock()),
        )
    }

    override fun readProjects(origin: String): String? = synchronized(lock) {
        readEnvelope(originDir(origin), PROJECTS_FILE, BodyEnvelope.serializer())
            ?.body
            ?.takeIf { it.isNotEmpty() }
    }

    override fun writeProjects(origin: String, body: String) = synchronized(lock) {
        if (body.isEmpty()) return
        writeEnvelope(
            originDir(origin),
            PROJECTS_FILE,
            BodyEnvelope.serializer(),
            BodyEnvelope(body = body, savedAt = clock()),
        )
    }

    // --- transcripts ---------------------------------------------------------

    override fun read(
        origin: String,
        sessionId: String,
        leafId: String?,
        includePreCompaction: Boolean,
    ): String? = synchronized(lock) {
        val dir = originDir(origin)
        val index = readIndex(dir) ?: return null
        val key = keyOf(sessionId)
        val entry = index.entries.firstOrNull { it.key == key } ?: return null
        // Another branch or the compaction view: the cached body does not
        // answer this request, so it must not seed it.
        if (entry.leafId != leafId || entry.includePreCompaction != includePreCompaction) return null
        val file = File(dir, bodyName(key))
        val body = runCatching { if (file.isFile) file.readText() else null }.getOrNull()
        if (body.isNullOrEmpty()) {
            removeEntry(dir, index, entry)
            return null
        }
        writeIndex(dir, index.copy(entries = index.entries.map { if (it.key == key) it.copy(lastUsedAt = clock()) else it }))
        body
    }

    override fun write(
        origin: String,
        sessionId: String,
        leafId: String?,
        includePreCompaction: Boolean,
        body: String,
    ) = synchronized(lock) {
        val dir = originDir(origin)
        val key = keyOf(sessionId)
        val bytes = body.toByteArray(Charsets.UTF_8).size.toLong()
        if (body.isEmpty() || bytes > maxTranscriptBytes) {
            // Not cacheable: drop a previous copy so a later open cannot show a
            // transcript that is no longer the session's state.
            dropTranscript(dir, key)
            return
        }
        val file = File(dir, bodyName(key))
        if (!writeAtomically(file, body)) return
        val previous = readIndex(dir) ?: IndexEnvelope()
        val now = clock()
        val entry = IndexEntry(
            key = key,
            sessionId = sessionId,
            bytes = bytes,
            savedAt = now,
            lastUsedAt = now,
            leafId = leafId,
            includePreCompaction = includePreCompaction,
        )
        val kept = (previous.entries.filterNot { it.key == key } + entry).let(::evict)
        val keptKeys = kept.mapTo(HashSet()) { it.key }
        previous.entries.filter { it.key !in keptKeys }.forEach { stale ->
            runCatching { File(dir, bodyName(stale.key)).delete() }
        }
        writeIndex(dir, IndexEnvelope(kept))
        // Bodies the index no longer lists are unreachable: a corrupt or lost
        // index would otherwise pin them in `filesDir` forever, because the
        // eviction above can only see entries it still reads.
        sweepOrphanBodies(dir, keptKeys)
    }

    // --- lifecycle -----------------------------------------------------------

    /** Deletes every cached payload of every origin (logout, server switch, 401). */
    fun clearAll() = synchronized(lock) {
        runCatching { root.listFiles()?.forEach { it.deleteRecursively() } }
    }

    /** Number of cached transcripts of [origin]; the LRU's observable size. */
    fun transcriptCount(origin: String): Int = synchronized(lock) {
        readIndex(originDir(origin))?.entries?.size ?: 0
    }

    // --- internals -----------------------------------------------------------

    /**
     * Keep the [maxTranscripts] most recently used entries and stop after
     * [maxTotalBytes]: the caller deletes the bodies of everything this drops.
     * Ordering is by last use, newest first; ties fall back to insertion age
     * and then to the key so eviction is deterministic in tests.
     */
    private fun evict(entries: List<IndexEntry>): List<IndexEntry> {
        val ordered = entries.sortedWith(
            compareByDescending<IndexEntry> { it.lastUsedAt }
                .thenByDescending { it.savedAt }
                .thenBy { it.key },
        )
        val kept = ArrayList<IndexEntry>(minOf(ordered.size, maxTranscripts))
        var total = 0L
        for (entry in ordered) {
            if (kept.size >= maxTranscripts) break
            if (total + entry.bytes > maxTotalBytes) continue
            kept += entry
            total += entry.bytes
        }
        return kept
    }

    /** Removes one entry and its body (used when a body went missing). */
    private fun removeEntry(dir: File, index: IndexEnvelope, entry: IndexEntry) {
        runCatching { File(dir, bodyName(entry.key)).delete() }
        writeIndex(dir, index.copy(entries = index.entries.filterNot { it.key == entry.key }))
    }

    private fun dropTranscript(dir: File, key: String) {
        val index = readIndex(dir) ?: return
        val entry = index.entries.firstOrNull { it.key == key } ?: return
        removeEntry(dir, index, entry)
    }

    /**
     * Deletes every body file whose key is not in [keptKeys]. Only an index
     * entry can serve a body, so an unlisted file is dead weight — and after a
     * corrupt index it would stay there without any route out.
     */
    private fun sweepOrphanBodies(dir: File, keptKeys: Set<String>) {
        val files = dir.listFiles() ?: return
        for (file in files) {
            val name = file.name
            if (!name.startsWith(BODY_PREFIX) || !name.endsWith(BODY_SUFFIX)) continue
            val key = name.substring(BODY_PREFIX.length, name.length - BODY_SUFFIX.length)
            if (key !in keptKeys) runCatching { file.delete() }
        }
    }

    private fun originDir(origin: String): File = File(root, hash(origin))

    private fun keyOf(sessionId: String): String = hash(sessionId)

    private fun bodyName(key: String): String = "$BODY_PREFIX$key$BODY_SUFFIX"

    private fun <T> readEnvelope(dir: File, name: String, serializer: kotlinx.serialization.KSerializer<T>): T? {
        val file = File(dir, name)
        if (!file.isFile) return null
        return runCatching { json.decodeFromString(serializer, file.readText()) }
            .onFailure { runCatching { file.delete() } }
            .getOrNull()
    }

    private fun <T> writeEnvelope(dir: File, name: String, serializer: kotlinx.serialization.KSerializer<T>, value: T) {
        runCatching {
            dir.mkdirs()
            writeAtomically(File(dir, name), json.encodeToString(serializer, value))
        }
    }

    private fun readIndex(dir: File): IndexEnvelope? = readEnvelope(dir, INDEX_FILE, IndexEnvelope.serializer())

    private fun writeIndex(dir: File, index: IndexEnvelope) {
        writeEnvelope(dir, INDEX_FILE, IndexEnvelope.serializer(), index)
    }

    /** Writes through `<name>.tmp` and renames, so a reader never sees half a file. */
    private fun writeAtomically(file: File, content: String): Boolean {
        val dir = file.parentFile ?: return false
        dir.mkdirs()
        val temp = File(dir, "${file.name}.tmp")
        return runCatching {
            temp.writeText(content)
            // `renameTo` refuses an existing target on some filesystems.
            if (file.exists()) file.delete()
            temp.renameTo(file)
        }.getOrDefault(false)
    }

    private fun hash(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        val hex = StringBuilder(2 * digest.size)
        for (byte in digest) hex.append(HEX[(byte.toInt() shr 4) and 0x0f]).append(HEX[byte.toInt() and 0x0f])
        return hex.substring(0, 32)
    }

    @Serializable
    private data class ListEnvelope(
        val etag: String? = null,
        val body: String = "",
        val savedAt: Long = 0,
    )

    @Serializable
    private data class BodyEnvelope(
        val body: String = "",
        val savedAt: Long = 0,
    )

    @Serializable
    private data class IndexEnvelope(
        val entries: List<IndexEntry> = emptyList(),
    )

    @Serializable
    private data class IndexEntry(
        val key: String,
        val sessionId: String,
        val bytes: Long = 0,
        val savedAt: Long = 0,
        val lastUsedAt: Long = 0,
        val leafId: String? = null,
        val includePreCompaction: Boolean = false,
    )

    companion object {
        /** Most recently opened sessions kept for the offline first paint. */
        const val MAX_TRANSCRIPTS: Int = 20

        /** Total budget of the transcript cache. */
        const val MAX_TOTAL_BYTES: Long = 50L * 1024 * 1024

        /** One response larger than this is not cached at all. */
        const val MAX_TRANSCRIPT_BYTES: Long = 8L * 1024 * 1024

        private const val LIST_FILE = "sessions.json"
        private const val PROJECTS_FILE = "projects.json"
        private const val INDEX_FILE = "transcripts.json"
        private const val BODY_PREFIX = "t-"
        private const val BODY_SUFFIX = ".json"

        private val HEX = "0123456789abcdef".toCharArray()
    }
}
