package io.github.kahme247.ompweb.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `GET https://api.github.com/repos/kahme247/ompweb/releases` parsing: the
 * list also carries web and omp releases, drafts and malformed rows.
 */
class AndroidReleaseApiTest {

    @Test
    fun `android releases are kept, other tags are dropped`() {
        val body = """
            [
              {
                "tag_name": "android-v1.1.0",
                "html_url": "https://github.com/kahme247/ompweb/releases/tag/android-v1.1.0",
                "prerelease": false,
                "draft": false
              },
              {
                "tag_name": "v0.5.2",
                "html_url": "https://github.com/kahme247/ompweb/releases/tag/v0.5.2"
              },
              {
                "tag_name": "android-v1.2.0-beta.1",
                "html_url": "https://github.com/kahme247/ompweb/releases/tag/android-v1.2.0-beta.1",
                "prerelease": true
              },
              {
                "tag_name": "android-v1.3.0",
                "html_url": "https://github.com/other/repo/releases/tag/android-v1.3.0"
              }
            ]
        """.trimIndent()

        val releases = parseAndroidReleases(body)

        assertEquals(listOf("1.1.0", "1.2.0-beta.1"), releases.map { it.version })
        assertTrue(releases[1].prerelease)
    }

    @Test
    fun `drafts and insecure pages survive parsing but never become updates`() {
        val body = """
            [
              {
                "tag_name": "android-v1.1.0",
                "html_url": "https://github.com/kahme247/ompweb/releases/tag/android-v1.1.0",
                "draft": true
              },
              {
                "tag_name": "android-v1.2.0",
                "html_url": "http://github.com/kahme247/ompweb/releases/tag/android-v1.2.0"
              }
            ]
        """.trimIndent()

        val releases = parseAndroidReleases(body)

        assertEquals(1, releases.size)
        assertTrue(releases.single().draft)
    }

    @Test
    fun `release assets must come from this repository`() {
        val body = """
            [
              {
                "tag_name": "android-v1.1.0",
                "html_url": "https://github.com/kahme247/ompweb/releases/tag/android-v1.1.0",
                "assets": [
                  {
                    "name": "ompweb-1.1.0.apk",
                    "browser_download_url": "https://github.com/kahme247/ompweb/releases/download/android-v1.1.0/ompweb-1.1.0.apk",
                    "size": 1234
                  },
                  {
                    "name": "ompweb-1.1.0.apk.sha256",
                    "browser_download_url": "https://github.com/kahme247/ompweb/releases/download/android-v1.1.0/ompweb-1.1.0.apk.sha256",
                    "size": 64
                  },
                  {
                    "name": "foreign.apk",
                    "browser_download_url": "https://evil.example/ompweb/foreign.apk",
                    "size": 1
                  },
                  {
                    "name": "no-size.apk",
                    "browser_download_url": "https://github.com/kahme247/ompweb/releases/download/x/no-size.apk"
                  }
                ]
              }
            ]
        """.trimIndent()

        val assets = parseAndroidReleases(body).single().assets

        assertEquals(
            listOf("ompweb-1.1.0.apk", "ompweb-1.1.0.apk.sha256", "no-size.apk"),
            assets.map { it.name },
        )
        assertEquals(1234L, assets.first().size)
        assertEquals(0L, assets.last().size)
    }
}
