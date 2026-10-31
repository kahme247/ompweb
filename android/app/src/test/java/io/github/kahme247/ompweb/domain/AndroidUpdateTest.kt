package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The app's own update check: tag filtering, numeric version comparison,
 * draft/prerelease exclusion, the custom feed format, per-version dismiss and
 * the six-hour cache.
 */
class AndroidUpdateTest {

    private fun release(
        version: String,
        url: String = "https://github.com/kahme247/ompweb/releases/tag/android-v$version",
        prerelease: Boolean = false,
        draft: Boolean = false,
    ) = AndroidRelease(
        version = version,
        htmlUrl = url,
        prerelease = prerelease,
        draft = draft,
    )

    private fun candidate(
        version: String,
        versionCode: Long? = null,
        pageUrl: String? = "https://github.com/kahme247/ompweb/releases/tag/android-v$version",
        withApk: Boolean = false,
    ) = AndroidUpdateCandidate(
        versionName = version,
        versionCode = versionCode,
        pageUrl = pageUrl,
        apkUrl = if (withApk) {
            "https://github.com/kahme247/ompweb/releases/download/android-v$version/ompweb-$version.apk"
        } else {
            null
        },
        apkSize = if (withApk) 5_610_321L else null,
        sha256 = if (withApk) "a".repeat(64) else null,
    )

    @Test
    fun `only android-v tags are app releases`() {
        assertEquals("1.2.3", androidVersionFromTag("android-v1.2.3"))
        assertNull(androidVersionFromTag("v0.5.2"))
        assertNull(androidVersionFromTag("omp-v18.12.6"))
        assertNull(androidVersionFromTag("android-v"))
        assertNull(androidVersionFromTag("android-1.2.3"))
    }

    @Test
    fun `versions compare numerically, not as text`() {
        assertTrue(compareAndroidVersions("1.0.10", "1.0.9") > 0)
        assertTrue(compareAndroidVersions("1.10.0", "1.9.9") > 0)
        assertTrue(compareAndroidVersions("2.0.0", "10.0.0") < 0)
        assertEquals(0, compareAndroidVersions("1.1", "1.1.0"))
        assertEquals(0, compareAndroidVersions("v1.1.0", "1.1.0"))
    }

    @Test
    fun `a debug suffix is a build label, not a newer version`() {
        assertEquals("1.0.0", normalizeInstalledVersion("1.0.0-debug"))
        assertEquals("1.0.0", normalizeInstalledVersion("1.0.0+20261023"))
        assertEquals(0, compareAndroidVersions("1.0.0-debug", "1.0.0"))
        assertTrue(isParsableAndroidVersion("1.2.3"))
        assertFalse(isParsableAndroidVersion("nightly"))
    }

    @Test
    fun `a prerelease sorts below its release`() {
        assertTrue(compareAndroidVersions("1.1.0-beta.1", "1.1.0") < 0)
        assertTrue(compareAndroidVersions("1.1.0", "1.1.0-beta.1") > 0)
        assertTrue(compareAndroidVersions("1.1.0-beta.2", "1.1.0-beta.1") > 0)
    }

    @Test
    fun `an unparsable version never fakes an update`() {
        assertEquals(0, compareAndroidVersions("nightly", "1.0.0"))
        assertNull(newestAndroidRelease(listOf(release("1.1.0")), "nightly"))
    }

    @Test
    fun `the newest published release wins and older ones are ignored`() {
        val latest = newestAndroidRelease(
            listOf(release("1.0.1"), release("1.2.0"), release("1.1.5")),
            "1.0.0",
        )!!

        assertEquals("1.2.0", latest.version)
    }

    @Test
    fun `only this repository's release pages and assets are accepted`() {
        assertTrue(
            isAndroidReleasePage("https://github.com/kahme247/ompweb/releases/tag/android-v1.1.0"),
        )
        assertFalse(
            isAndroidReleasePage("https://evil.example/kahme247/ompweb/releases/tag/android-v1.1.0"),
        )
        assertFalse(
            isAndroidReleasePage("https://github.com/kahme247/ompweb.evil/releases/tag/android-v1.1.0"),
        )
        assertFalse(
            isAndroidReleasePage("https://github.com/other/ompweb/releases/tag/android-v1.1.0"),
        )
        assertFalse(
            isAndroidReleasePage("https://github.com@evil.example/kahme247/ompweb/releases/x"),
        )
        assertFalse(
            isAndroidReleasePage("http://github.com/kahme247/ompweb/releases/tag/android-v1.1.0"),
        )
        // `java.net.URI#getHost` is null for authorities it cannot parse as a
        // server (underscore here): the guard must answer false, not throw.
        assertFalse(
            isAndroidReleasePage("https://foo_bar/kahme247/ompweb/releases/tag/android-v1.1.0"),
        )

        assertTrue(
            isAndroidReleaseAsset(
                "https://github.com/kahme247/ompweb/releases/download/android-v1.1.0/ompweb-1.1.0.apk",
            ),
        )
        assertFalse(
            isAndroidReleaseAsset(
                "https://evil.example/kahme247/ompweb/releases/download/android-v1.1.0/ompweb-1.1.0.apk",
            ),
        )
        assertFalse(
            isAndroidReleaseAsset(
                "http://github.com/kahme247/ompweb/releases/download/android-v1.1.0/ompweb-1.1.0.apk",
            ),
        )
    }

    @Test
    fun `drafts, prereleases, insecure pages and current versions are not updates`() {
        val releases = listOf(
            release("2.0.0", draft = true),
            release("1.9.0", prerelease = true),
            release("1.8.0", url = "http://github.com/kahme247/ompweb/releases/tag/android-v1.8.0"),
            release("1.7.0", url = "https://evil.example/kahme247/ompweb/releases/tag/android-v1.7.0"),
            release("1.0.0"),
            release("0.9.0"),
        )

        assertNull(newestAndroidRelease(releases, "1.0.0"))
    }

    @Test
    fun `a newer GitHub version becomes the notice`() {
        val notice = androidUpdateNotice(
            candidate("1.1.0"),
            currentVersion = "1.0.0-debug",
            currentVersionCode = 10000,
            dismissedVersion = null,
        )!!

        assertEquals("1.0.0", notice.currentVersion)
        assertEquals("1.1.0", notice.availableVersion)
        assertTrue(notice.releaseUrl.orEmpty().startsWith("https://github.com/"))
        assertFalse(notice.installable)
    }

    @Test
    fun `a custom feed is judged by its version code`() {
        val newer = androidUpdateNotice(
            candidate("1.0.1", versionCode = 10001, pageUrl = null, withApk = true),
            currentVersion = "1.0.1",
            currentVersionCode = 10000,
            dismissedVersion = null,
        )!!

        assertEquals("1.0.1", newer.availableVersion)
        assertNull(newer.releaseUrl)
        assertTrue(newer.installable)

        // Same versionName, higher code: still an update.
        assertTrue(
            isAndroidUpdateCandidateNewer(
                candidate("1.0.0", versionCode = 10001),
                "1.0.0",
                10000,
            ),
        )
        // Same code: no update, even with a higher name.
        assertNull(
            androidUpdateNotice(
                candidate("9.9.9", versionCode = 10000, pageUrl = null),
                currentVersion = "1.0.0",
                currentVersionCode = 10000,
                dismissedVersion = null,
            ),
        )
    }

    @Test
    fun `dismissing hides that version only`() {
        assertNull(
            androidUpdateNotice(candidate("1.1.0"), "1.0.0", 10000, dismissedVersion = "1.1.0"),
        )

        // A newer release is news again.
        assertEquals(
            "1.2.0",
            androidUpdateNotice(candidate("1.2.0"), "1.0.0", 10000, dismissedVersion = "1.1.0")!!
                .availableVersion,
        )

        // A stale dismissal of an older version must not hide the current one.
        assertEquals(
            "1.1.0",
            androidUpdateNotice(candidate("1.1.0"), "1.0.0", 10000, dismissedVersion = "1.0.5")!!
                .availableVersion,
        )
    }

    @Test
    fun `no notice for a missing candidate or a foreign page`() {
        assertNull(androidUpdateNotice(null, "1.0.0", 10000, null))
        val foreignPage = androidUpdateNotice(
            candidate("1.1.0", pageUrl = "https://evil.example/kahme247/ompweb/releases/tag/android-v1.1.0"),
            "1.0.0",
            10000,
            null,
        )
        assertNull(foreignPage?.releaseUrl)
    }

    @Test
    fun `only a plausible APK is installable`() {
        val installable = candidate("1.1.0", versionCode = 10001, pageUrl = null, withApk = true)
        assertTrue(installable.canInstall)

        assertFalse(installable.copy(apkUrl = null).canInstall)
        assertFalse(installable.copy(apkSize = 0).canInstall)
        assertFalse(installable.copy(apkSize = MAX_ANDROID_UPDATE_BYTES + 1).canInstall)
        assertFalse(installable.copy(sha256 = null).canInstall)
        assertFalse(
            installable.copy(
                apkUrl = "http://example.com/ompweb.apk",
            ).canInstall,
        )
        assertTrue(
            installable.copy(
                apkUrl = "http://192.168.1.5:30180/ompweb-1.0.1.apk",
            ).canInstall,
        )
    }

    @Test
    fun `a custom feed resolves its apk url and normalizes the digest`() {
        val body = feedBody(sha = "ABCDEF".repeat(10) + "ABCD", apkUrl = "ompweb-1.0.1.apk")

        val parsed = parseAndroidUpdateFeed(body, FEED_URL)

        assertTrue(parsed is AndroidUpdateFeedResult.Parsed)
        val feed = (parsed as AndroidUpdateFeedResult.Parsed).feed
        assertEquals("1.0.1", feed.versionName)
        assertEquals(10001L, feed.versionCode)
        assertEquals("https://updates.example.com/ompweb/ompweb-1.0.1.apk", feed.apkUrl)
        assertEquals("abcdef".repeat(10) + "abcd", feed.sha256)
        assertEquals(5_610_321L, feed.size)
        assertEquals("Fixes chat scrolling.", feed.notes)
    }

    @Test
    fun `the feed may name an absolute APK url inside a private network`() {
        val body = feedBody(apkUrl = "http://192.168.1.5:30180/ompweb-1.0.1.apk")

        val feed = (parseAndroidUpdateFeed(body, FEED_URL) as AndroidUpdateFeedResult.Parsed).feed

        assertEquals("http://192.168.1.5:30180/ompweb-1.0.1.apk", feed.apkUrl)
    }

    @Test
    fun `a feed with a public plain-http apk url is refused`() {
        val body = feedBody(apkUrl = "http://example.com/ompweb-1.0.1.apk")

        assertTrue(parseAndroidUpdateFeed(body, FEED_URL) is AndroidUpdateFeedResult.Invalid)
    }

    @Test
    fun `a feed with a bad digest, size or version is refused`() {
        assertTrue(parseAndroidUpdateFeed(feedBody(sha = "abc"), FEED_URL) is AndroidUpdateFeedResult.Invalid)
        assertTrue(parseAndroidUpdateFeed(feedBody(sha = "g".repeat(64)), FEED_URL) is AndroidUpdateFeedResult.Invalid)
        assertTrue(parseAndroidUpdateFeed(feedBody(size = 0), FEED_URL) is AndroidUpdateFeedResult.Invalid)
        assertTrue(
            parseAndroidUpdateFeed(
                feedBody(size = MAX_ANDROID_UPDATE_BYTES + 1),
                FEED_URL,
            ) is AndroidUpdateFeedResult.Invalid,
        )
        assertTrue(parseAndroidUpdateFeed(feedBody(version = "nightly"), FEED_URL) is AndroidUpdateFeedResult.Invalid)
        assertTrue(parseAndroidUpdateFeed(feedBody(versionCode = 0), FEED_URL) is AndroidUpdateFeedResult.Invalid)
        assertTrue(parseAndroidUpdateFeed("not json", FEED_URL) is AndroidUpdateFeedResult.Invalid)
        assertTrue(
            parseAndroidUpdateFeed(
                """{"versionName":"1.0.1","versionCode":10001,"sha256":"${"a".repeat(64)}","size":1}""",
                FEED_URL,
            ) is AndroidUpdateFeedResult.Invalid,
        )
    }

    @Test
    fun `feed urls follow the server's plain-http policy`() {
        assertTrue(parseAndroidUpdateFeedUrl("https://example.com/latest.json") is AndroidUpdateFeedUrlResult.Valid)
        assertTrue(
            parseAndroidUpdateFeedUrl("http://100.64.0.10:30180/latest.json") is
                AndroidUpdateFeedUrlResult.Valid,
        )
        assertTrue(
            parseAndroidUpdateFeedUrl("http://my-pc.tailnet.ts.net/latest.json") is
                AndroidUpdateFeedUrlResult.Valid,
        )
        assertTrue(parseAndroidUpdateFeedUrl("http://example.com/latest.json") is AndroidUpdateFeedUrlResult.Invalid)
        assertTrue(parseAndroidUpdateFeedUrl("example.com/latest.json") is AndroidUpdateFeedUrlResult.Invalid)
        assertTrue(parseAndroidUpdateFeedUrl("https://user:secret@example.com/latest.json") is AndroidUpdateFeedUrlResult.Invalid)
        assertTrue(parseAndroidUpdateFeedUrl("") is AndroidUpdateFeedUrlResult.Invalid)
    }

    @Test
    fun `the cache lasts six hours and remembers its source`() {
        val checkedAt = 1_000_000L
        val cache = AndroidUpdateCache(
            checkedAtMillis = checkedAt,
            sourceKey = "https://updates.example.com/latest.json",
            candidate = candidate("1.1.0"),
        )

        assertTrue(isAndroidUpdateCacheFresh(cache, checkedAt))
        assertTrue(isAndroidUpdateCacheFresh(cache, checkedAt + ANDROID_UPDATE_CACHE_MILLIS - 1))
        assertFalse(isAndroidUpdateCacheFresh(cache, checkedAt + ANDROID_UPDATE_CACHE_MILLIS))
        // A clock that jumped backwards must not pin a cache forever.
        assertFalse(isAndroidUpdateCacheFresh(cache, checkedAt - 1))
        assertEquals("https://updates.example.com/latest.json", cache.sourceKey)
    }

    private fun feedBody(
        version: String = "1.0.1",
        versionCode: Long = 10001,
        apkUrl: String = "https://updates.example.com/ompweb/ompweb-1.0.1.apk",
        sha: String = "a".repeat(64),
        size: Long = 5_610_321,
    ) = """
        {
          "versionName": "$version",
          "versionCode": $versionCode,
          "apkUrl": "$apkUrl",
          "sha256": "$sha",
          "size": $size,
          "notes": "Fixes chat scrolling."
        }
    """.trimIndent()

    private companion object {
        const val FEED_URL = "https://updates.example.com/ompweb/latest.json"
    }
}
