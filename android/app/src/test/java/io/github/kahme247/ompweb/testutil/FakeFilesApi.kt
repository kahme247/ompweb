package io.github.kahme247.ompweb.testutil

import io.github.kahme247.ompweb.domain.FileEntry
import io.github.kahme247.ompweb.domain.FileIndexEntry
import io.github.kahme247.ompweb.domain.UploadConflictStrategy
import io.github.kahme247.ompweb.net.FileIndexPage
import io.github.kahme247.ompweb.net.FileMeta
import io.github.kahme247.ompweb.net.FileReadResult
import io.github.kahme247.ompweb.net.FilesApi
import io.github.kahme247.ompweb.net.UploadCheckResult
import io.github.kahme247.ompweb.net.UploadFile
import io.github.kahme247.ompweb.net.UploadOutcome
import kotlinx.coroutines.CompletableDeferred

/**
 * In-memory `FilesApi` for the view-model tests: listings, bodies and upload
 * answers are registered per test, every call is recorded, and a
 * [gate] (a `CompletableDeferred`) holds an answer in flight so a test can move
 * the cwd before it lands.
 *
 * Keys of [contents] are the API path segments joined with `/`, e.g. a
 * `/repo/a.kt` read is `"repo/a.kt"`.
 */
class FakeFilesApi : FilesApi {

    /** Directory (as asked) → its entries. Unregistered directories are empty. */
    val directories = mutableMapOf<String, List<FileEntry>>()
    val contents = mutableMapOf<String, FileReadResult>()

    val reads = mutableListOf<Pair<List<String>, String?>>()
    val listingCalls = mutableListOf<String>()
    val indexCalls = mutableListOf<IndexCall>()
    val checkCalls = mutableListOf<Pair<String, List<String>>>()
    val uploadCalls = mutableListOf<UploadFile>()

    /** Thrown by every call while set (the tests flip it between steps). */
    var failure: Exception? = null

    /** Thrown by [upload] only; [failure] would already fail the pre-flight. */
    var uploadFailure: Exception? = null

    /** Holds [listDirectory]/[read]/[upload] answers until completed. */
    var listingGate: CompletableDeferred<Unit>? = null
    var readGate: CompletableDeferred<Unit>? = null
    var uploadGate: CompletableDeferred<Unit>? = null

    var uploadCheck = UploadCheckResult()
    var uploadOutcome = UploadOutcome(status = 200, uploaded = emptyList())
    var indexPage = FileIndexPage()

    data class IndexCall(
        val cwd: String,
        val query: String,
        val limit: Int?,
        val filesOnly: Boolean,
        val refresh: Boolean,
    )

    override suspend fun listDirectory(directory: String): List<FileEntry> {
        listingCalls += directory
        listingGate?.await()
        failure?.let { throw it }
        return directories[directory] ?: emptyList()
    }

    override suspend fun read(segments: List<String>, sessionId: String?): FileReadResult {
        reads += segments to sessionId
        readGate?.await()
        failure?.let { throw it }
        return contents[segments.joinToString("/")] ?: FileReadResult.Text("", null, 0)
    }

    override suspend fun meta(segments: List<String>, sessionId: String?): FileMeta = FileMeta()

    override suspend fun download(segments: List<String>, sessionId: String?): ByteArray = ByteArray(0)

    override suspend fun previewHtml(segments: List<String>, sessionId: String?): String = ""

    override suspend fun index(
        cwd: String,
        query: String,
        limit: Int?,
        filesOnly: Boolean,
        refresh: Boolean,
    ): FileIndexPage {
        indexCalls += IndexCall(cwd, query, limit, filesOnly, refresh)
        failure?.let { throw it }
        return indexPage
    }

    override suspend fun uploadCheck(directory: String, fileNames: List<String>): UploadCheckResult {
        checkCalls += directory to fileNames
        failure?.let { throw it }
        return uploadCheck
    }

    override suspend fun upload(
        directory: String,
        file: UploadFile,
        strategy: UploadConflictStrategy,
        onProgress: (Int) -> Unit,
    ): UploadOutcome {
        uploadCalls += file
        uploadGate?.await()
        (uploadFailure ?: failure)?.let { throw it }
        onProgress(100)
        return uploadOutcome
    }

    /** Convenience for the search tests: one ranked match per path. */
    fun indexMatches(vararg paths: String) {
        indexPage = FileIndexPage(matches = paths.map { FileIndexEntry(it, false) })
    }
}
