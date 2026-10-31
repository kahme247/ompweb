package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.AndroidUpdateCandidate
import io.github.kahme247.ompweb.domain.sha256Hex
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The APK download: hard size cap, progress, checksum asset fallback and
 * deletion of the partial file on any failure or cancellation.
 */
class AndroidUpdateDownloaderTest {

    private lateinit var server: MockWebServer
    private lateinit var cacheDir: File
    private lateinit var client: OkHttpClient
    private val apkBytes = "fake apk bytes for the updater".toByteArray()
    private val sha = "a".repeat(64)

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        cacheDir = File.createTempFile("ompweb-update-cache", "").let { marker ->
            marker.delete()
            marker
        }
        client = HttpPolicyInterceptor.install(
            OkHttpClient.Builder().callTimeout(0, TimeUnit.SECONDS),
            allowCrossOriginRedirects = true,
        ).build()
    }

    @After
    fun tearDown() {
        server.shutdown()
        cacheDir.deleteRecursively()
    }

    @Test
    fun `a download returns the file with the announced digest and final progress`() = runTest {
        server.enqueue(MockResponse().setBody(Buffer().write(apkBytes)))
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)
        val progress = mutableListOf<Pair<Long, Long>>()

        val download = downloader.download(candidate(sha256 = sha)) { received, total ->
            progress += received to total
        }

        assertEquals(sha, download.expectedSha256)
        assertEquals(apkBytes.size.toLong(), download.size)
        assertTrue(download.file.isFile)
        assertTrue(apkBytes.contentEquals(download.file.readBytes()))
        assertEquals(apkBytes.size.toLong() to apkBytes.size.toLong(), progress.last())
        assertEquals("/ompweb.apk", server.takeRequest().path)
    }

    @Test
    fun `a checksum asset is fetched and parsed when the feed has no digest`() = runTest {
        server.enqueue(MockResponse().setBody("$sha  ompweb.apk\n"))
        server.enqueue(MockResponse().setBody(Buffer().write(apkBytes)))
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)
        val candidate = candidate(sha256 = null).copy(
            sha256Url = server.url("/ompweb.apk.sha256").toString(),
        )

        val download = downloader.download(candidate) { _, _ -> }

        assertEquals(sha, download.expectedSha256)
        assertEquals("/ompweb.apk.sha256", server.takeRequest().path)
        assertEquals("/ompweb.apk", server.takeRequest().path)
    }

    @Test
    fun `an unusable checksum asset is an error`() = runTest {
        server.enqueue(MockResponse().setBody("no digest"))
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)
        val candidate = candidate(sha256 = null).copy(
            sha256Url = server.url("/ompweb.apk.sha256").toString(),
        )

        try {
            downloader.download(candidate) { _, _ -> }
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("SHA-256"))
        }
    }

    @Test
    fun `a size mismatch is refused and leaves no file behind`() = runTest {
        server.enqueue(MockResponse().setBody(Buffer().write(apkBytes)))
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)
        val candidate = candidate(sha256 = sha).copy(apkSize = apkBytes.size + 10L)

        try {
            downloader.download(candidate) { _, _ -> }
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("size"))
        }
        assertFalse(File(cacheDir, "ompweb-update.apk").exists())
    }

    @Test
    fun `an oversized announcement is refused before the request`() = runTest {
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)
        val candidate = candidate(sha256 = sha).copy(
            apkSize = io.github.kahme247.ompweb.domain.MAX_ANDROID_UPDATE_BYTES + 1,
        )

        try {
            downloader.download(candidate) { _, _ -> }
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("too large"))
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `cancelling the download deletes the partial file`() = runTest {
        val big = ByteArray(4 * 1024 * 1024) { 7 }
        server.enqueue(
            MockResponse()
                .setBody(Buffer().write(big))
                .setBodyDelay(10, TimeUnit.SECONDS),
        )
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)
        val candidate = candidate(sha256 = sha).copy(apkSize = big.size.toLong())
        val job = launch(Dispatchers.IO) {
            runCatching { downloader.download(candidate) { _, _ -> } }
        }
        assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))

        job.cancelAndJoin()

        val target = File(cacheDir, "ompweb-update.apk")
        val deadline = System.currentTimeMillis() + 5_000
        while (target.exists() && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertFalse(target.exists())
    }

    @Test
    fun `a previous attempt's file is removed before the new download`() = runTest {
        cacheDir.mkdirs()
        val stale = File(cacheDir, "ompweb-update.apk").apply { writeText("stale") }
        server.enqueue(MockResponse().setBody(Buffer().write(apkBytes)))
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)

        val download = downloader.download(candidate(sha256 = sha)) { _, _ -> }

        assertTrue(apkBytes.contentEquals(download.file.readBytes()))
        assertTrue(download.file == stale)
    }

    @Test
    fun `no APK url or no digest is refused`() = runTest {
        val downloader = HttpAndroidUpdateDownloader(client, cacheDir)

        try {
            downloader.download(candidate(sha256 = sha).copy(apkUrl = null)) { _, _ -> }
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("no APK"))
        }

        server.enqueue(MockResponse().setBody(Buffer().write(apkBytes)))
        try {
            downloader.download(candidate(sha256 = null)) { _, _ -> }
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("SHA-256"))
        }
    }

    private fun candidate(sha256: String?) = AndroidUpdateCandidate(
        versionName = "1.0.1",
        versionCode = 10001,
        apkUrl = server.url("/ompweb.apk").toString(),
        apkSize = apkBytes.size.toLong(),
        sha256 = sha256,
    )

    @Test
    fun `sha256Hex computes the standard digest`() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            sha256Hex("abc".byteInputStream()),
        )
    }
}
