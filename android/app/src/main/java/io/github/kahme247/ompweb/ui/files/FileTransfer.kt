package io.github.kahme247.ompweb.ui.files

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import io.github.kahme247.ompweb.chat.FileLinks
import io.github.kahme247.ompweb.domain.MAX_UPLOAD_BYTES_PER_FILE
import io.github.kahme247.ompweb.domain.MAX_UPLOAD_BYTES_TOTAL
import io.github.kahme247.ompweb.net.UploadFile
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** What the upload picker produced: readable files, and names it had to skip. */
data class UploadPick(val files: List<UploadFile> = emptyList(), val rejected: List<String> = emptyList()) {
    val isEmpty: Boolean get() = files.isEmpty() && rejected.isEmpty()
}

/**
 * Device-side halves of the file panel: reading picked documents into bounded
 * byte arrays, saving a server file through SAF, sharing one through the app's
 * FileProvider, and building a `?type=read` URL for Coil.
 *
 * The server caps a single upload at 25 MiB and buffers every request body up
 * to 26 MiB before auth, so the picker never buffers more than 25 MiB per file
 * and the upload sends one file per request; the batch stops at the 100 MiB
 * aggregate cap. An oversized document is reported instead of read.
 */
object FileTransfer {

    private const val READ_CHUNK = 64 * 1024

    private val shareCleanup = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "file-share-cleanup").apply { isDaemon = true }
    }

    /** Reads every pick, skipping unreadable or > [MAX_UPLOAD_BYTES_PER_FILE] documents. */
    suspend fun readUploads(
        context: Context,
        uris: List<Uri>,
        usedNames: Set<String> = emptySet(),
    ): UploadPick = withContext(Dispatchers.IO) {
        collectUploads(
            picks = uris,
            usedNames = usedNames,
            nameOf = { uri, index -> displayName(context, uri, fallback = "file-${index + 1}") },
            read = { uri, limit -> readBounded(context, uri, limit) },
        )
    }

    /**
     * The batch loop of [readUploads] without Android types, so the budget
     * arithmetic is testable on the JVM. Every pick is read at most up to the
     * per-file cap and whatever is left of the aggregate budget; a pick that
     * does not fit is reported instead of buffered. [read] must return the
     * bytes or null when the document is unreadable or larger than its limit.
     */
    internal fun <T> collectUploads(
        picks: List<T>,
        nameOf: (T, Int) -> String,
        read: (T, Long) -> ByteArray?,
        perFileLimit: Long = MAX_UPLOAD_BYTES_PER_FILE,
        totalLimit: Long = MAX_UPLOAD_BYTES_TOTAL,
        usedNames: Set<String> = emptySet(),
    ): UploadPick {
        val files = mutableListOf<UploadFile>()
        val rejected = mutableListOf<String>()
        val taken = usedNames.toMutableSet()
        // The server rejects a batch above the aggregate cap, so nothing past
        // it is buffered: every later file is reported instead of read.
        var budget = totalLimit
        picks.forEachIndexed { index, pick ->
            val name = nameOf(pick, index)
            val unique = uniqueName(name, taken)
            val bytes = read(pick, minOf(perFileLimit, budget.coerceAtLeast(0L)))
            if (bytes == null) {
                rejected += name
            } else {
                budget -= bytes.size
                taken += unique
                files += UploadFile(unique, bytes)
            }
        }
        return UploadPick(files, rejected)
    }

    /** SAF save; returns false when the destination could not be written. */
    suspend fun writeToUri(context: Context, uri: Uri, bytes: ByteArray): Boolean =
        withContext(Dispatchers.IO) {
            try {
                context.contentResolver.openOutputStream(uri, "wt")?.use { stream ->
                    stream.write(bytes)
                    stream.flush()
                } != null
            } catch (_: Exception) {
                false
            }
        }

    /**
     * Shares [bytes] as a real file. The cache copy lives under `exports/`
     * (the only shareable FileProvider path) and is deleted after the receiver
     * had its chance, like the transcript share.
     */
    fun share(context: Context, fileName: String, mimeType: String, bytes: ByteArray): Boolean = try {
        val directory = File(context.cacheDir, "exports").apply { mkdirs() }
        val safeName = sanitizeShareName(fileName)
        val file = File(directory, safeName)
        file.writeBytes(bytes)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        shareCleanup.schedule({ file.delete() }, 60L, TimeUnit.SECONDS)
        true
    } catch (_: Exception) {
        false
    }

    /**
     * The provider's suggested name for [uri], or null when it has none. One
     * cursor query for the upload picker, the composer's attachments and the
     * saved transcript.
     */
    fun queryDisplayName(context: Context, uri: Uri): String? = try {
        val name = context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (index >= 0 && cursor.moveToFirst()) cursor.getString(index) else null
        }
        name?.takeIf { it.isNotBlank() }?.substringAfterLast('/')?.substringAfterLast('\\')
    } catch (_: SecurityException) {
        // A share URI from another app may not be readable here.
        null
    } catch (_: IllegalArgumentException) {
        null
    }

    fun displayName(context: Context, uri: Uri, fallback: String): String =
        queryDisplayName(context, uri) ?: fallback

    /** `GET /api/files/<encoded>?type=read` as a relative URL (Coil resolves the base). */
    fun readUrl(path: String, sessionId: String?, version: Int = 0): String {
        val encoded = FileLinks.apiPathSegments(path).joinToString("/") { segment ->
            URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
        }
        val session = sessionId?.takeIf { it.isNotBlank() }?.let {
            "&sessionId=" + URLEncoder.encode(it, "UTF-8")
        }.orEmpty()
        val cacheBust = if (version > 0) "&v=$version" else ""
        return "/api/files/$encoded?type=read$session$cacheBust"
    }

    /**
     * A MIME type for sharing a viewed file. Text keeps an extension-derived
     * type so mail clients and editors show it correctly.
     */
    fun mimeForPath(path: String, binaryMime: String?): String {
        if (binaryMime != null) return binaryMime
        return when (path.substringAfterLast('.', "").lowercase()) {
            "md", "markdown", "mdx" -> "text/markdown"
            "json" -> "application/json"
            "html", "htm" -> "text/html"
            "css" -> "text/css"
            "js", "mjs", "cjs" -> "text/javascript"
            "ts", "kt", "java", "py", "rb", "go", "rs", "swift", "c", "cpp", "h", "hpp",
            "cs", "sh", "bash", "zsh", "sql", "yaml", "yml", "toml", "xml", "txt", "log",
            -> "text/plain"
            "csv" -> "text/csv"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "gif" -> "image/gif"
            "webp" -> "image/webp"
            "svg" -> "image/svg+xml"
            "pdf" -> "application/pdf"
            "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            "m4a" -> "audio/mp4"
            "ogg" -> "audio/ogg"
            "flac" -> "audio/flac"
            else -> "application/octet-stream"
        }
    }

    /** Reads at most [limit] bytes; null when the document is unreadable or larger. */
    private fun readBounded(context: Context, uri: Uri, limit: Long): ByteArray? = try {
        context.contentResolver.openInputStream(uri)?.use { stream ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(READ_CHUNK)
            var total = 0L
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                total += read
                if (total > limit) return null
                output.write(buffer, 0, read)
            }
            output.toByteArray()
        }
    } catch (_: Exception) {
        null
    }

    private fun uniqueName(name: String, taken: MutableSet<String>): String {
        if (name !in taken) return name
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        var index = 2
        while ("$base ($index)$extension" in taken) index++
        return "$base ($index)$extension"
    }

    private fun sanitizeShareName(name: String): String {
        val stripped = name.substringAfterLast('/').substringAfterLast('\\')
        val safe = stripped.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return safe.ifBlank { "file.txt" }
    }
}
