package io.github.kahme247.ompweb.net

import io.github.kahme247.ompweb.domain.AndroidRelease
import io.github.kahme247.ompweb.domain.AndroidReleaseAsset
import io.github.kahme247.ompweb.domain.androidVersionFromTag
import io.github.kahme247.ompweb.domain.isAndroidReleaseAsset
import io.github.kahme247.ompweb.domain.isAndroidReleasePage
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * The public GitHub releases list of the ompweb repository. The app itself is
 * distributed as an APK there (tags `android-v*`), so its update check
 * is independent of the connected server.
 *
 * This request must not carry the session cookie and must never be pointed at
 * the configured server: [HttpAndroidReleaseSource] takes an unauthenticated
 * client and hard-codes the repository.
 */
interface AndroidReleaseSource {
    /** Every release the repository lists, newest first; drafts included (filtered on read). */
    suspend fun releases(): List<AndroidRelease>
}

/** GitHub's REST API over a client without the app's session cookie jar. */
class HttpAndroidReleaseSource(
    private val client: OkHttpClient,
    private val owner: String = DEFAULT_OWNER,
    private val repo: String = DEFAULT_REPO,
    private val userAgent: String = DEFAULT_USER_AGENT,
) : AndroidReleaseSource {

    override suspend fun releases(): List<AndroidRelease> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("https://api.github.com/repos/$owner/$repo/releases?per_page=100")
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", userAgent)
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                // Offline, rate-limited (403/429) or a GitHub outage: the caller
                // keeps its cache and stays silent, so there is nothing to retry here.
                throw IOException("GitHub releases answered HTTP ${response.code}")
            }
            parseAndroidReleases(response.body?.string().orEmpty())
        }
    }

    private companion object {
        const val DEFAULT_OWNER = "kahme247"
        const val DEFAULT_REPO = "ompweb"
        const val DEFAULT_USER_AGENT = "ompweb-android"
    }
}

private val releaseJson = Json { ignoreUnknownKeys = true }

/**
 * Parses `GET /releases`. Entries with another tag prefix (`v0.5.2`, `omp-v…`)
 * are dropped; a release without an `android-v*` tag is not for this app.
 * Only a page under this repository's GitHub releases survives, because the
 * banner opens it. Attached files are kept only when they point at this
 * repository's release downloads; the APK itself is optional (an older
 * release may have none), so the notice can still offer its page.
 */
fun parseAndroidReleases(body: String): List<AndroidRelease> {
    val root = runCatching { releaseJson.parseToJsonElement(body) }.getOrNull() as? JsonArray
        ?: return emptyList()
    return root.mapNotNull { element ->
        val entry = element as? JsonObject ?: return@mapNotNull null
        val tag = entry["tag_name"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
        val version = androidVersionFromTag(tag) ?: return@mapNotNull null
        val url = entry["html_url"]?.jsonPrimitive?.contentOrNull
            ?.takeIf(::isAndroidReleasePage)
            ?: return@mapNotNull null
        AndroidRelease(
            version = version,
            htmlUrl = url,
            prerelease = entry["prerelease"]?.jsonPrimitive?.booleanOrNull == true,
            draft = entry["draft"]?.jsonPrimitive?.booleanOrNull == true,
            assets = parseAndroidReleaseAssets(entry["assets"] as? JsonArray),
        )
    }
}

private fun parseAndroidReleaseAssets(entries: JsonArray?): List<AndroidReleaseAsset> =
    entries.orEmpty().mapNotNull { element ->
        val asset = element as? JsonObject ?: return@mapNotNull null
        val name = asset["name"]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
            ?: return@mapNotNull null
        val downloadUrl = asset["browser_download_url"]?.jsonPrimitive?.contentOrNull
            ?.takeIf(::isAndroidReleaseAsset)
            ?: return@mapNotNull null
        AndroidReleaseAsset(
            name = name,
            downloadUrl = downloadUrl,
            size = asset["size"]?.jsonPrimitive?.longOrNull ?: 0L,
        )
    }
