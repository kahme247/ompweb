package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.AndroidUpdateCandidate
import io.github.kahme247.ompweb.domain.MAX_ANDROID_UPDATE_BYTES
import io.github.kahme247.ompweb.domain.MAX_ANDROID_UPDATE_CHECKSUM_BYTES
import io.github.kahme247.ompweb.domain.isAndroidUpdateSizeAllowed
import io.github.kahme247.ompweb.domain.parseAndroidUpdateSha256Asset
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The downloaded APK and the digest the source announced for it. */
data class AndroidUpdateDownload(
    val file: File,
    val expectedSha256: String,
    val size: Long,
)

/** Downloads an announced APK into the app's cache. */
interface AndroidUpdateDownloader {
    /**
     * Downloads [candidate] and returns the file with the announced digest.
     * [onProgress] runs with bytes received and the announced total. The
     * caller deletes the file when the install finishes or fails.
     *
     * Cancelling the calling coroutine cancels the HTTP call and deletes the
     * partial file.
     */
    suspend fun download(
        candidate: AndroidUpdateCandidate,
        onProgress: (received: Long, total: Long) -> Unit,
    ): AndroidUpdateDownload
}

/**
 * OkHttp download with a hard size cap, progress and cancellation.
 *
 * The URL and its digest come from the update source, never from the
 * connected server. The checksum is either the feed's own field or the
 * release's `.sha256` asset, fetched over the same cookie-free client.
 */
class HttpAndroidUpdateDownloader(
    private val client: OkHttpClient,
    private val cacheDir: File,
    private val userAgent: String = "ompweb-android",
) : AndroidUpdateDownloader {

    override suspend fun download(
        candidate: AndroidUpdateCandidate,
        onProgress: (received: Long, total: Long) -> Unit,
    ): AndroidUpdateDownload {
        val apkUrl = candidate.apkUrl?.takeIf { it.isNotBlank() }
            ?: throw IOException("This release has no APK to install.")
        val expectedSize = candidate.apkSize
        if (!isAndroidUpdateSizeAllowed(expectedSize)) {
            throw IOException("The announced APK size is missing or too large.")
        }
        val announcedSize = expectedSize!!
        val expectedSha256 = candidate.sha256?.let { sha ->
            sha.takeIf { it.isNotBlank() } ?: throw IOException("The announced SHA-256 is empty.")
        } ?: fetchChecksum(candidate.sha256Url)
            ?: throw IOException("This release has no SHA-256 to verify the download.")

        val directory = cacheDir
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw IOException("The update cache directory could not be created.")
        }
        // A previous attempt's file (process death during a download) must not
        // be mistaken for this one.
        directory.listFiles()?.forEach { existing -> existing.delete() }
        val target = File(directory, "ompweb-update.apk")
        try {
            downloadToFile(apkUrl, target, announcedSize, onProgress)
            if (target.length() != announcedSize) {
                throw IOException("The download is incomplete.")
            }
            return AndroidUpdateDownload(target, expectedSha256, target.length())
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    private suspend fun fetchChecksum(checksumUrl: String?): String? {
        val url = checksumUrl?.takeIf { it.isNotBlank() } ?: return null
        val text = withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", userAgent)
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("The update's checksum file answered HTTP ${response.code}")
                }
                response.body.readLimited(MAX_ANDROID_UPDATE_CHECKSUM_BYTES)
            }
        }
        return parseAndroidUpdateSha256Asset(text)
    }

    private suspend fun downloadToFile(
        url: String,
        target: File,
        expectedSize: Long,
        onProgress: (received: Long, total: Long) -> Unit,
    ) {
        val request = Request.Builder()
            .url(url)
            .header("User-Agent", userAgent)
            .build()
        val call = client.newCall(request)
        suspendCancellableCoroutine<Unit> { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isCancelled) return
                    continuation.resumeWithException(
                        IOException("The update download failed: ${e.message}", e),
                    )
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use { answer ->
                        try {
                            if (!answer.isSuccessful) {
                                throw IOException("The update download answered HTTP ${answer.code}")
                            }
                            val body = answer.body
                            val contentLength = body.contentLength()
                            if (contentLength >= 0 && contentLength != expectedSize) {
                                throw IOException("The download's size does not match the announced size.")
                            }
                            var total = 0L
                            var reported = 0L
                            target.outputStream().use { output ->
                                body.byteStream().use { input ->
                                    val buffer = ByteArray(DOWNLOAD_CHUNK)
                                    while (true) {
                                        if (continuation.isCancelled) {
                                            throw IOException("The download was canceled.")
                                        }
                                        val read = input.read(buffer)
                                        if (read < 0) break
                                        total += read
                                        if (total > expectedSize || total > MAX_ANDROID_UPDATE_BYTES) {
                                            throw IOException("The download is larger than announced.")
                                        }
                                        output.write(buffer, 0, read)
                                        if (total - reported >= PROGRESS_STEP || total == expectedSize) {
                                            reported = total
                                            onProgress(total, expectedSize)
                                        }
                                    }
                                }
                            }
                            if (total != expectedSize) {
                                throw IOException("The download ended before the full file arrived.")
                            }
                            if (continuation.isCancelled) {
                                throw IOException("The download was canceled.")
                            }
                            onProgress(total, expectedSize)
                            continuation.resume(Unit)
                        } catch (error: Throwable) {
                            target.delete()
                            if (!continuation.isCancelled) continuation.resumeWithException(error)
                        }
                    }
                }
            })
        }
    }

    private companion object {
        const val DOWNLOAD_CHUNK = 64 * 1024
        const val PROGRESS_STEP = 64L * 1024L
    }
}
