package io.github.kahme247.ompweb.ui.sessions

import android.content.Context
import android.net.Uri
import io.github.kahme247.ompweb.ui.files.FileTransfer
import java.io.File

/** Clipboard + export plumbing for session actions. */
internal object SessionExport {

    /** Files this old were left behind by an interrupted share. */
    private const val STALE_EXPORT_AGE_MILLIS = 60L * 60_000L

    /**
     * Copies [text] and reports whether the clipboard accepted it. [sensitive]
     * marks the clip so Android 13+ hides its preview.
     */
    fun copyToClipboard(context: Context, label: String, text: String, sensitive: Boolean = false): Boolean =
        io.github.kahme247.ompweb.ui.render.copyTextToClipboard(context, label, text, sensitive)

    /**
     * B8/B28: copies a session (or archive entry) id. One function for both
     * menus so the clipboard label and the failure path cannot drift.
     */
    fun copyId(context: Context, id: String): Boolean =
        copyToClipboard(context, "session-id", id)

    /** Writes the export where the SAF picker pointed (`FileTransfer` owns the IO). */
    suspend fun writeToUri(context: Context, uri: Uri, bytes: ByteArray): Boolean =
        FileTransfer.writeToUri(context, uri, bytes)

    /**
     * Hands the export to the share sheet through the app's FileProvider and
     * removes the cache copy once the receiving app has had its chance to
     * read it (a share is a one-shot; the transcript must not stay on disk).
     */
    fun share(context: Context, fileName: String, bytes: ByteArray): Boolean =
        FileTransfer.share(context, fileName, "text/html", bytes)

    /** Deletes exports a previous run left in the cache. */
    fun purgeStaleExports(context: Context) {
        val now = System.currentTimeMillis()
        File(context.cacheDir, "exports").listFiles()?.forEach { file ->
            if (now - file.lastModified() > STALE_EXPORT_AGE_MILLIS) file.delete()
        }
    }

    /** Reads a picked import file, refusing anything the server would reject. */
    fun readText(context: Context, uri: Uri, limit: Int): String? = try {
        context.contentResolver.openInputStream(uri)?.use { stream ->
            val buffer = ByteArray(16 * 1024)
            val output = java.io.ByteArrayOutputStream()
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                output.write(buffer, 0, read)
                if (output.size() > limit) return null
            }
            String(output.toByteArray(), Charsets.UTF_8)
        }
    } catch (_: Exception) {
        null
    }

    fun displayName(context: Context, uri: Uri, fallback: String): String =
        FileTransfer.queryDisplayName(context, uri) ?: fallback
}
