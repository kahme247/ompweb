package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.chat.FileLinks
import io.github.kahme247.ompweb.domain.FileEntry
import io.github.kahme247.ompweb.domain.FileIndexEntry
import io.github.kahme247.ompweb.domain.UploadConflictStrategy
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink

/** The metadata `?type=meta` reports: the size label while a document downloads. */
data class FileMeta(val size: Long = 0)

/**
 * One `/api/file-index` answer: the flat `files` listing (no `q`) or the
 * ranked `matches` (with `q`), plus the server's truncation flag. One type for
 * the explorer's search and the composer's `@` menu, so the route is parsed
 * once.
 */
data class FileIndexPage(
    val files: List<String> = emptyList(),
    val matches: List<FileIndexEntry> = emptyList(),
    val truncated: Boolean = false,
)

/** `?type=upload-check`: names that already exist and the ones replace cannot touch. */
data class UploadCheckResult(val conflicts: List<String> = emptyList(), val nonReplaceable: List<String> = emptyList())

/** One file the upload picker handed over. */
data class UploadFile(val name: String, val bytes: ByteArray)

/** A per-file upload failure from the `207`/`200` body. */
data class UploadFailure(val name: String, val message: String)

/**
 * The answer to one upload request. [conflicts] is only populated for a `409`
 * from `?conflict=error`; [status] stays available so callers can tell a
 * partial `207` from a clean `200`.
 */
data class UploadOutcome(
    val status: Int,
    val uploaded: List<String> = emptyList(),
    val skipped: List<String> = emptyList(),
    val errors: List<UploadFailure> = emptyList(),
    val conflicts: List<String> = emptyList(),
    val nonReplaceable: List<String> = emptyList(),
) {
    val failed: Boolean get() = status !in 200..299 && status != 409
}

/**
 * `/api/files/[...path]` and `/api/file-index`, as an interface so the file
 * panel runs in JVM tests without a server.
 *
 * Git status/diff are deliberately absent: `net/GitApi.kt` is their one
 * client, and the viewer uses it for its diff mode.
 */
interface FilesApi {

    /** `GET ?type=list` — one directory's entries, dirs first (the server's order). */
    suspend fun listDirectory(directory: String): List<FileEntry>

    /** `GET ?type=read` — text or the raw bytes of an image/PDF/docx/audio/binary. */
    suspend fun read(segments: List<String>, sessionId: String?): FileReadResult

    /** `GET ?type=meta` — the size, used by the PDF viewer. */
    suspend fun meta(segments: List<String>, sessionId: String?): FileMeta

    /** `GET ?type=download` — bytes for SAF/share; capped like every body. */
    suspend fun download(segments: List<String>, sessionId: String?): ByteArray

    /** `GET ?type=preview` — the server-rendered docx HTML. */
    suspend fun previewHtml(segments: List<String>, sessionId: String?): String

    /**
     * `GET /api/file-index?cwd=[&q=][&limit=][&kind=file][&refresh=1]` — the
     * one client of the route: without [query] the flat listing for the
     * composer's `@` menu, with it the ranked matches for the explorer.
     */
    suspend fun index(
        cwd: String,
        query: String = "",
        limit: Int? = null,
        filesOnly: Boolean = false,
        refresh: Boolean = false,
    ): FileIndexPage

    /** `POST ?type=upload-check` with `{fileNames}`. */
    suspend fun uploadCheck(directory: String, fileNames: List<String>): UploadCheckResult

    /**
     * `POST ?type=upload&conflict=` with one `files` part. One request per file
     * gives the phone a real per-file progress and a per-file result — and it
     * keeps every request under the server's pre-auth proxy cap (26 MiB):
     * a 100 MB selection therefore travels as several requests of at most one
     * 25 MiB file each, never as one large body.
     */
    suspend fun upload(
        directory: String,
        file: UploadFile,
        strategy: UploadConflictStrategy,
        onProgress: (Int) -> Unit = {},
    ): UploadOutcome
}

/** Web `MAX_RESULT_LIMIT` (`lib/file-fuzzy.ts`). */
const val MAX_FILE_SEARCH_LIMIT = 200

/** A SAF/share download larger than this is refused instead of buffered. */
const val MAX_FILE_DOWNLOAD_BYTES: Long = 64L * 1024 * 1024

/** Production [FilesApi] over the app's single authenticated client. */
fun ApiClient.filesApi(): FilesApi = HttpFilesApi(this)

private class HttpFilesApi(private val api: ApiClient) : FilesApi {

    private val json = Json { ignoreUnknownKeys = true }

    override suspend fun listDirectory(directory: String): List<FileEntry> {
        val request = api.requestBuilder(fileApiPath(directory, "list")).get().build()
        val exchange = api.exchange(request)
        val text = requireOk(exchange, request)
        val entries = parseObject(text)?.get("entries") as? JsonArray
            ?: throw ApiError.Http(exchange.status, text.take(2048))
        return entries.mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val name = item.string("name")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            FileEntry(
                name = name,
                isDir = item.boolean("isDir") == true,
                size = item.string("size")?.toLongOrNull() ?: 0,
            )
        }
    }

    override suspend fun read(segments: List<String>, sessionId: String?): FileReadResult =
        api.fileRead(segments, sessionId)

    override suspend fun meta(segments: List<String>, sessionId: String?): FileMeta {
        val request = api.requestBuilder(fileApiPath(segments, "meta", sessionId)).get().build()
        val text = requireOk(api.exchange(request), request)
        val root = parseObject(text) ?: return FileMeta()
        return FileMeta(size = root.string("size")?.toLongOrNull() ?: 0)
    }

    override suspend fun download(segments: List<String>, sessionId: String?): ByteArray =
        withContext(Dispatchers.IO) {
            val request = api.requestBuilder(fileApiPath(segments, "download", sessionId), accept = "*/*").get().build()
            val exchange = api.exchange(request, MAX_FILE_DOWNLOAD_BYTES)
            if (exchange.status !in 200..299) throw failure(exchange, request)
            exchange.body
        }

    override suspend fun previewHtml(segments: List<String>, sessionId: String?): String {
        val request = api.requestBuilder(fileApiPath(segments, "preview", sessionId), accept = "text/html").get().build()
        return requireOk(api.exchange(request), request)
    }

    override suspend fun index(
        cwd: String,
        query: String,
        limit: Int?,
        filesOnly: Boolean,
        refresh: Boolean,
    ): FileIndexPage {
        val path = buildString {
            append("api/file-index?cwd=").append(encodeQuery(cwd))
            if (query.isNotEmpty()) append("&q=").append(encodeQuery(query))
            if (limit != null) append("&limit=").append(limit)
            // The panel ranks files only: directories would consume the budget
            // before the limit (see `app/api/file-index/route.ts`).
            if (filesOnly) append("&kind=file")
            if (refresh) append("&refresh=1")
        }
        val request = api.requestBuilder(path).get().build()
        val text = requireOk(api.exchange(request), request)
        val root = parseObject(text) ?: return FileIndexPage()
        return FileIndexPage(
            files = root.stringList("files"),
            matches = (root["matches"] as? JsonArray).orEmpty().mapNotNull { element ->
                val item = element as? JsonObject ?: return@mapNotNull null
                val matchPath = item.string("path")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                FileIndexEntry(matchPath, item.boolean("isDir") == true)
            },
            truncated = root.boolean("truncated") == true,
        )
    }

    override suspend fun uploadCheck(directory: String, fileNames: List<String>): UploadCheckResult {
        val payload = buildJsonObject {
            put(
                "fileNames",
                JsonArray(fileNames.map { JsonPrimitive(it) }),
            )
        }
        val request = api.requestBuilder(fileApiPath(directory, "upload-check"))
            .post(payload.toString().toRequestBody())
            .build()
        val exchange = api.exchange(request)
        val text = requireOk(exchange, request)
        val root = parseObject(text) ?: throw ApiError.Http(exchange.status, text.take(2048))
        return UploadCheckResult(
            conflicts = root.stringList("conflicts"),
            nonReplaceable = root.stringList("nonReplaceable"),
        )
    }

    override suspend fun upload(
        directory: String,
        file: UploadFile,
        strategy: UploadConflictStrategy,
        onProgress: (Int) -> Unit,
    ): UploadOutcome {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart(
                "files",
                file.name,
                ProgressRequestBody(file.bytes, "application/octet-stream", onProgress),
            )
            .build()
        val path = buildString {
            append(fileApiPath(directory, "upload"))
            append("&conflict=").append(strategy.wire)
        }
        val request = api.requestBuilder(path).post(body).build()
        val exchange = api.exchange(request, MAX_FILE_UPLOAD_BODY_BYTES)
        val text = exchange.text()
        val root = parseObject(text)
        // 409 conflict, 207 partial success and 200 are all answers about files.
        if (exchange.status != 409 && exchange.status !in 200..299) throw failure(exchange, request)
        return UploadOutcome(
            status = exchange.status,
            uploaded = root?.stringList("uploaded").orEmpty(),
            skipped = root?.stringList("skipped").orEmpty(),
            errors = root?.errorList().orEmpty(),
            conflicts = root?.stringList("conflicts").orEmpty(),
            nonReplaceable = root?.stringList("nonReplaceable").orEmpty(),
        )
    }

    private fun requireOk(exchange: RawExchange, request: Request): String {
        if (exchange.status in 200..299) return exchange.text()
        throw failure(exchange, request)
    }

    private fun failure(exchange: RawExchange, request: Request): ApiError {
        val text = exchange.text()
        // Auth and the server-configuration answers keep their global meaning.
        if (exchange.status == 401 || exchange.status == 403 || exchange.status == 503) {
            val origin = ServerAddress(request.url.scheme, request.url.host, request.url.port)
            return api.errorFor(exchange.status, text, origin)
        }
        val root = parseObject(text)
        val message = root?.string("error")
        return if (message != null) {
            ApiError.ServerResponse(exchange.status, root.string("code"), message)
        } else {
            ApiError.Http(exchange.status, text.take(2048))
        }
    }

    private fun parseObject(text: String): JsonObject? =
        runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull

    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.booleanOrNull

    private fun JsonObject.stringList(key: String): List<String> =
        (this[key] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }

    private fun JsonObject.errorList(): List<UploadFailure> =
        (this["errors"] as? JsonArray).orEmpty().mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val name = item.string("name") ?: return@mapNotNull null
            UploadFailure(name, item.string("error") ?: "Upload failed")
        }

    private fun fileApiPath(directory: String, type: String, sessionId: String? = null): String =
        fileApiPath(FileLinks.apiPathSegments(directory), type, sessionId)

    private fun fileApiPath(segments: List<String>, type: String, sessionId: String? = null): String {
        val encoded = segments.joinToString("/") { encodePathSegment(it) }
        val query = buildString {
            append("api/files/").append(encoded).append("?type=").append(type)
            if (!sessionId.isNullOrBlank()) append("&sessionId=").append(encodePathSegment(sessionId))
        }
        return query
    }

    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private fun encodeQuery(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun String.toRequestBody(): RequestBody =
        toRequestBody("application/json; charset=utf-8".toMediaType())
}

/** Upload bodies can exceed the generic body cap; the server caps them at 25 MiB. */
private const val MAX_FILE_UPLOAD_BODY_BYTES: Long = 32L * 1024 * 1024

/** A request body that reports upload progress as OkHttp drains it. */
private class ProgressRequestBody(
    private val bytes: ByteArray,
    private val contentType: String,
    private val onProgress: (Int) -> Unit,
) : RequestBody() {

    override fun contentType() = contentType.toMediaType()

    override fun contentLength(): Long = bytes.size.toLong()

    override fun writeTo(sink: BufferedSink) {
        var written = 0
        val total = bytes.size
        if (total == 0) {
            onProgress(100)
            return
        }
        val chunk = 64 * 1024
        while (written < total) {
            val count = minOf(chunk, total - written)
            sink.write(bytes, written, count)
            written += count
            onProgress((written * 100L / total).toInt())
        }
    }
}
