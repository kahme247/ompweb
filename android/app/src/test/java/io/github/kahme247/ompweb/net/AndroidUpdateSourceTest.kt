package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.AndroidRelease
import io.github.kahme247.ompweb.domain.AndroidReleaseAsset
import io.github.kahme247.ompweb.domain.canInstall
import java.io.IOException
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * The update source: a custom feed is parsed and mapped onto the same
 * candidate the GitHub source produces, failures are exceptions (the
 * controller keeps its cache), and the request carries nothing from the
 * ompweb session.
 */
class AndroidUpdateSourceTest {

    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpClient

    private val sha = "a".repeat(64)

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        client = HttpPolicyInterceptor.install(
            OkHttpClient.Builder(),
            allowCrossOriginRedirects = true,
        ).build()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `a custom feed becomes an installable candidate`() = runTest {
        server.enqueue(
            MockResponse().setHeader("Content-Type", "application/json").setBody(
                feed(versionCode = 10001, apkUrl = "ompweb-1.0.1.apk"),
            ),
        )
        val source = HttpAndroidUpdateSource(FakeGithub(), client)

        val candidate = source.latest(server.url("/latest.json").toString(), "1.0.1", 10000)!!

        assertEquals("1.0.1", candidate.versionName)
        assertEquals(10001L, candidate.versionCode)
        assertEquals(server.url("/ompweb-1.0.1.apk").toString(), candidate.apkUrl)
        assertEquals(sha, candidate.sha256)
        assertEquals(64L, candidate.apkSize)
        assertEquals("Fixes chat scrolling.", candidate.notes)
        assertNull(candidate.pageUrl)
        assertTrue(candidate.canInstall)

        val request = server.takeRequest()
        assertEquals("/latest.json", request.path)
        assertEquals("ompweb-android", request.getHeader("User-Agent"))
        assertEquals("application/json", request.getHeader("Accept"))
        // Nothing about the connected ompweb server travels with an update check.
        assertNull(request.getHeader("Cookie"))
        assertNull(request.getHeader("Authorization"))
    }

    @Test
    fun `a feed that does not raise the version code is not an update`() = runTest {
        server.enqueue(MockResponse().setBody(feed(versionCode = 10000)))
        val source = HttpAndroidUpdateSource(FakeGithub(), client)

        assertNull(source.latest(server.url("/latest.json").toString(), "1.0.0", 10000))
    }

    @Test
    fun `a feed with an invalid body fails the check`() = runTest {
        server.enqueue(MockResponse().setBody("""{"versionName":"1.0.1"}"""))
        val source = HttpAndroidUpdateSource(FakeGithub(), client)

        try {
            source.latest(server.url("/latest.json").toString(), "1.0.0", 10000)
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().isNotBlank())
        }
    }

    @Test
    fun `an HTTP error fails the check`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500))
        val source = HttpAndroidUpdateSource(FakeGithub(), client)

        try {
            source.latest(server.url("/latest.json").toString(), "1.0.0", 10000)
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("500"))
        }
    }

    @Test
    fun `an oversized feed is refused instead of buffered`() = runTest {
        val huge = """{"versionName":"1.0.1","versionCode":10001,"apkUrl":"a.apk","sha256":"${"a".repeat(64)}","size":1,"""
        server.enqueue(
            MockResponse().setBody(huge + "\"notes\":\"" + "x".repeat(70_000) + "\"}"),
        )
        val source = HttpAndroidUpdateSource(FakeGithub(), client)

        try {
            source.latest(server.url("/latest.json").toString(), "1.0.0", 10000)
            fail("expected an IOException")
        } catch (expected: IOException) {
            assertTrue(expected.message.orEmpty().contains("too large"))
        }
    }

    @Test
    fun `GitHub releases map their assets onto the candidate`() = runTest {
        val github = FakeGithub(
            listOf(
                AndroidRelease(
                    version = "1.1.0",
                    htmlUrl = "https://github.com/kahme247/ompweb/releases/tag/android-v1.1.0",
                    assets = listOf(
                        AndroidReleaseAsset(
                            name = "ompweb-1.1.0.apk",
                            downloadUrl = "https://github.com/kahme247/ompweb/releases/download/android-v1.1.0/ompweb-1.1.0.apk",
                            size = 1234,
                        ),
                        AndroidReleaseAsset(
                            name = "ompweb-1.1.0.apk.sha256",
                            downloadUrl = "https://github.com/kahme247/ompweb/releases/download/android-v1.1.0/ompweb-1.1.0.apk.sha256",
                            size = 64,
                        ),
                    ),
                ),
            ),
        )
        val source = HttpAndroidUpdateSource(github, client)

        val candidate = source.latest(null, "1.0.0", 10000)!!

        assertEquals("1.1.0", candidate.versionName)
        assertNull(candidate.versionCode)
        assertEquals(1234L, candidate.apkSize)
        assertTrue(candidate.apkUrl!!.endsWith("/ompweb-1.1.0.apk"))
        assertTrue(candidate.sha256Url!!.endsWith("/ompweb-1.1.0.apk.sha256"))
        assertTrue(candidate.canInstall)
    }

    @Test
    fun `a GitHub release without assets is still announced but not installable`() = runTest {
        val github = FakeGithub(
            listOf(
                AndroidRelease(
                    version = "1.1.0",
                    htmlUrl = "https://github.com/kahme247/ompweb/releases/tag/android-v1.1.0",
                ),
            ),
        )
        val source = HttpAndroidUpdateSource(github, client)

        val candidate = source.latest(null, "1.0.0", 10000)!!

        assertNull(candidate.apkUrl)
        assertTrue(!candidate.canInstall)
    }

    private class FakeGithub(private val releases: List<AndroidRelease> = emptyList()) :
        AndroidReleaseSource {
        override suspend fun releases(): List<AndroidRelease> = releases
    }

    private fun feed(
        versionCode: Long,
        apkUrl: String = "https://updates.example.com/ompweb-1.0.1.apk",
    ) = """
        {
          "versionName": "1.0.1",
          "versionCode": $versionCode,
          "apkUrl": "$apkUrl",
          "sha256": "$sha",
          "size": 64,
          "notes": "Fixes chat scrolling."
        }
    """.trimIndent()
}
