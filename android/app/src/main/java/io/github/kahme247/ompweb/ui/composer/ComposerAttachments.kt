package io.github.kahme247.ompweb.ui.composer

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.FileProvider
import io.github.kahme247.ompweb.domain.AttachedTextFile
import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.MAX_ATTACHED_IMAGE_BYTES
import io.github.kahme247.ompweb.domain.MAX_ATTACHED_TEXT_BYTES
import io.github.kahme247.ompweb.domain.isTextAttachmentFile
import io.github.kahme247.ompweb.domain.readCappedOrNull
import io.github.kahme247.ompweb.ui.files.FileTransfer
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** What one picker/share batch produced; [skipped] counts unusable candidates. */
data class AttachmentBatch(
    val images: List<ComposerImage> = emptyList(),
    val files: List<AttachedTextFile> = emptyList(),
    val skipped: Int = 0,
)

/**
 * Android side of the web composer's attachment pickers:
 *
 * - text files are read as UTF-8 and handed to `ComposerController.addTextFiles`
 *   (which owns the 4 MB / 10-file budget and banners),
 * - images become base64 `ComposerImage`s. Photos that would exceed the 5 MB
 *   decoded cap (or exceed 2048 px) are downscaled and re-encoded as JPEG,
 *   because a modern camera file is always larger than the RPC accepts,
 * - the camera writes into `cacheDir/camera` through the app's FileProvider,
 *   and clipboard images go through the same reader as picked ones.
 */
object ComposerAttachments {

    suspend fun readShare(context: Context, uris: List<Uri>): AttachmentBatch {
        val images = ArrayList<ComposerImage>()
        val files = ArrayList<AttachedTextFile>()
        var skipped = 0
        for (uri in uris) {
            val mime = context.contentResolver.getType(uri).orEmpty()
            val name = FileTransfer.queryDisplayName(context, uri) ?: uri.lastPathSegment ?: "shared"
            when {
                mime.startsWith("image/") -> {
                    val image = readImage(context, uri)
                    if (image != null) images += image else skipped++
                }
                isTextAttachmentFile(name, mime) -> {
                    val file = readTextFile(context, uri)
                    if (file != null) files += file else skipped++
                }
                else -> skipped++
            }
        }
        return AttachmentBatch(images = images, files = files, skipped = skipped)
    }

    fun readTextFiles(context: Context, uris: List<Uri>): AttachmentBatch {
        val files = uris.mapNotNull { readTextFile(context, it) }
        return AttachmentBatch(files = files, skipped = uris.size - files.size)
    }

    suspend fun readImages(context: Context, uris: List<Uri>): AttachmentBatch {
        val images = uris.mapNotNull { readImage(context, it) }
        return AttachmentBatch(images = images, skipped = uris.size - images.size)
    }

    /** A picked image: raw when it fits, downscaled JPEG otherwise. */
    fun readImage(context: Context, uri: Uri): ComposerImage? {
        val bytes = try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                readCappedOrNull(stream, MAX_IMAGE_READ_BYTES)
            }
        } catch (_: SecurityException) {
            null
        } catch (_: IOException) {
            null
        } ?: return null
        // The declared type is provider metadata; the bytes decide what is
        // actually sent, and anything non-raster is re-encoded as JPEG.
        val mime = detectImageMime(bytes) ?: return downscale(bytes)
        if (bytes.size <= MAX_ATTACHED_IMAGE_BYTES) {
            return ComposerImage(Base64.encodeToString(bytes, Base64.NO_WRAP), mime)
        }
        return downscale(bytes)
    }

    /** Raster formats the RPC accepts raw, identified by their signature. */
    fun detectImageMime(bytes: ByteArray): String? = when {
        bytes.size > 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte() ->
            "image/jpeg"
        bytes.size > 8 && bytes[0] == 0x89.toByte() && bytes[1] == 0x50.toByte() &&
            bytes[2] == 0x4E.toByte() && bytes[3] == 0x47.toByte() -> "image/png"
        bytes.size > 12 && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WEBP" -> "image/webp"
        bytes.size > 6 && ascii(bytes, 0, 4) == "GIF8" -> "image/gif"
        else -> null
    }

    private fun ascii(bytes: ByteArray, offset: Int, length: Int): String =
        String(bytes, offset, length, Charsets.US_ASCII)

    /**
     * Decode with a bounded sample size, then compress in decreasing quality
     * until the decoded size fits the per-image budget. Returns null when even
     * the smallest attempt is too large (or undecodable).
     */
    fun downscale(bytes: ByteArray): ComposerImage? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / sample > MAX_IMAGE_EDGE || bounds.outHeight / sample > MAX_IMAGE_EDGE) {
            sample *= 2
        }
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
        var bitmap = decoded
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest > MAX_IMAGE_EDGE) {
            val scale = MAX_IMAGE_EDGE.toFloat() / longest
            bitmap = Bitmap.createScaledBitmap(
                decoded,
                (decoded.width * scale).toInt().coerceAtLeast(1),
                (decoded.height * scale).toInt().coerceAtLeast(1),
                true,
            )
            if (bitmap !== decoded) decoded.recycle()
        }
        try {
            for (quality in intArrayOf(85, 70, 55, 40)) {
                val out = ByteArrayOutputStream()
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) continue
                val encoded = out.toByteArray()
                if (encoded.size <= MAX_ATTACHED_IMAGE_BYTES) {
                    return ComposerImage(Base64.encodeToString(encoded, Base64.NO_WRAP), "image/jpeg")
                }
            }
            return null
        } finally {
            bitmap.recycle()
        }
    }

    fun readTextFile(context: Context, uri: Uri): AttachedTextFile? {
        if ((declaredSize(context, uri) ?: 0L) > MAX_ATTACHED_TEXT_BYTES) return null
        val bytes = try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                readCappedOrNull(stream, MAX_TEXT_READ_BYTES)
            }
        } catch (_: SecurityException) {
            null
        } catch (_: IOException) {
            null
        } ?: return null
        if (bytes.isEmpty() || bytes.any { it == 0.toByte() }) return null
        val name = FileTransfer.queryDisplayName(context, uri) ?: uri.lastPathSegment ?: "attachment.txt"
        val mime = context.contentResolver.getType(uri) ?: "text/plain"
        val content = String(bytes, Charsets.UTF_8)
        return AttachedTextFile(name = name, mimeType = mime, content = content, size = bytes.size)
    }

    private fun declaredSize(context: Context, uri: Uri): Long? = try {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else null
            }
    } catch (_: SecurityException) {
        null
    } catch (_: IllegalArgumentException) {
        null
    }

    /** Clipboard image as a draft attachment (`paste image` in the plus menu). */
    suspend fun clipboardImage(context: Context): ComposerImage? {
        val uri = clipboardImageUri(context) ?: return null
        return withContext(Dispatchers.IO) { readImage(context, uri) }
    }

    suspend fun hasClipboardImage(context: Context): Boolean = clipboardImageUri(context) != null

    /**
     * Clipboard access is a cross-process binder call and can hang; the menu
     * probe must never block the input path, so it runs on IO with a timeout.
     */
    private suspend fun clipboardImageUri(context: Context): Uri? = withContext(Dispatchers.IO) {
        withTimeoutOrNull(CLIPBOARD_TIMEOUT_MS) {
            val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: return@withTimeoutOrNull null
            val clip = manager.primaryClip?.takeIf { it.itemCount > 0 } ?: return@withTimeoutOrNull null
            val uri = clip.getItemAt(0).uri ?: return@withTimeoutOrNull null
            val mime = context.contentResolver.getType(uri)
            uri.takeIf { mime == null || mime.startsWith("image/") }
        }
    }

    /** A fresh camera target; the provider authority matches the manifest entry. */
    fun newCameraTarget(context: Context): CameraTarget {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "photo-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        return CameraTarget(file = file, uri = uri)
    }

    private const val MAX_IMAGE_EDGE = 2048

    /** Large camera files are downscaled, so read well past the decoded cap. */
    private const val MAX_IMAGE_READ_BYTES = 32 * 1024 * 1024

    /** Reading past the text budget means the file is over it; a capped read must not look complete. */
    private const val MAX_TEXT_READ_BYTES = MAX_ATTACHED_TEXT_BYTES

    private const val CLIPBOARD_TIMEOUT_MS = 500L
}

data class CameraTarget(val file: File, val uri: Uri)
