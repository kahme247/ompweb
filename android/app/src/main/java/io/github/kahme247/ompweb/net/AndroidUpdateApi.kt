package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.AndroidUpdateCandidate
import io.github.kahme247.ompweb.domain.AndroidUpdateFeedResult
import io.github.kahme247.ompweb.domain.MAX_ANDROID_UPDATE_FEED_BYTES
import io.github.kahme247.ompweb.domain.newestAndroidRelease
import io.github.kahme247.ompweb.domain.parseAndroidUpdateFeed
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.ResponseBody
import okio.Buffer

/**
 * Where the app update is announced: GitHub Releases (default) or the user's
 * custom feed. One interface, one controller, no second update path.
 */
interface AndroidUpdateSource {
    /**
     * The update [feedUrl] announces over [installedVersionName] /
     * [installedVersionCode], or null when the installed build is current.
     * A `null` [feedUrl] selects GitHub Releases.
     *
     * Failures (offline, HTTP error, an unusable feed) throw; the controller
     * keeps its previous answer and shows "could not check".
     */
    suspend fun latest(
        feedUrl: String?,
        installedVersionName: String,
        installedVersionCode: Long,
    ): AndroidUpdateCandidate?
}

/**
 * Reads both sources over one client that carries no cookie jar and no
 * authorization header: nothing about the connected ompweb server leaves the
 * device for an update check. The client enforces the plain-HTTP policy on
 * every hop ([HttpPolicyInterceptor]).
 *
 * GitHub's release asset URLs redirect to a storage host, which is why the
 * client allows cross-origin redirects; the redirect target is still checked
 * against the scheme policy.
 */
class HttpAndroidUpdateSource(
    private val github: AndroidReleaseSource,
    private val client: OkHttpClient,
    private val userAgent: String = DEFAULT_USER_AGENT,
) : AndroidUpdateSource {

    override suspend fun latest(
        feedUrl: String?,
        installedVersionName: String,
        installedVersionCode: Long,
    ): AndroidUpdateCandidate? =
        if (feedUrl == null) {
            githubLatest(installedVersionName)
        } else {
            customLatest(feedUrl, installedVersionCode)
        }

    private suspend fun githubLatest(installedVersionName: String): AndroidUpdateCandidate? {
        val release = newestAndroidRelease(github.releases(), installedVersionName) ?: return null
        val apkName = "ompweb-${release.version}.apk"
        val apk = release.assets.firstOrNull { it.name == apkName }
        val checksum = release.assets.firstOrNull { it.name == "$apkName.sha256" }
        return AndroidUpdateCandidate(
            versionName = release.version,
            versionCode = null,
            pageUrl = release.htmlUrl,
            apkUrl = apk?.downloadUrl,
            apkSize = apk?.size?.takeIf { it > 0 },
            sha256Url = checksum?.downloadUrl,
        )
    }

    private suspend fun customLatest(feedUrl: String, installedVersionCode: Long): AndroidUpdateCandidate? {
        val body = fetchText(feedUrl, MAX_ANDROID_UPDATE_FEED_BYTES, "application/json")
        val feed = when (val parsed = parseAndroidUpdateFeed(body, feedUrl)) {
            is AndroidUpdateFeedResult.Parsed -> parsed.feed
            is AndroidUpdateFeedResult.Invalid -> throw IOException(parsed.reason)
        }
        // Android decides installability by versionCode; a feed that does not
        // raise it is not an update, whatever its versionName says.
        if (feed.versionCode <= installedVersionCode) return null
        return AndroidUpdateCandidate(
            versionName = feed.versionName,
            versionCode = feed.versionCode,
            pageUrl = null,
            apkUrl = feed.apkUrl,
            apkSize = feed.size,
            sha256 = feed.sha256,
            notes = feed.notes,
        )
    }

    private suspend fun fetchText(url: String, maxBytes: Long, accept: String?): String =
        withContext(Dispatchers.IO) {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", userAgent)
                .apply { if (accept != null) header("Accept", accept) }
                .build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("The update source answered HTTP ${response.code}")
                }
                response.body.readLimited(maxBytes)
            }
        }

    private companion object {
        const val DEFAULT_USER_AGENT = "ompweb-android"
    }
}

/**
 * Reads at most [maxBytes] from the body; a larger answer is refused instead of
 * being buffered. A feed is a handful of fields, not an APK.
 */
internal fun ResponseBody.readLimited(maxBytes: Long): String {
    val source = source()
    val buffer = Buffer()
    var total = 0L
    while (true) {
        val read = source.read(buffer, READ_CHUNK)
        if (read == -1L) break
        total += read
        if (total > maxBytes) throw IOException("The update answer is too large.")
    }
    return buffer.readUtf8()
}

private const val READ_CHUNK = 8L * 1024L
