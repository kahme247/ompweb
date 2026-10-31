package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.ServerAddress
import java.net.URI
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * One published GitHub release the app can update to.
 *
 * The app is distributed as an APK on GitHub Releases (tags `android-v*`), so
 * its update check reads the public releases list of the repository
 * instead of asking the server. Releases for other parts of the project carry
 * other tag prefixes and are filtered out by [androidVersionFromTag].
 */
@Serializable
data class AndroidRelease(
    /** Version without the tag prefix, e.g. `1.2.3` for `android-v1.2.3`. */
    val version: String,
    /** The release page, opened in a Custom Tab. */
    val htmlUrl: String,
    /** A pre-release; never offered as an update. */
    val prerelease: Boolean = false,
    /** A draft; never offered as an update. */
    val draft: Boolean = false,
    /** The release's downloadable files, named `ompweb-<version>.apk` and `.sha256`. */
    val assets: List<AndroidReleaseAsset> = emptyList(),
)

/** One file attached to a release. */
@Serializable
data class AndroidReleaseAsset(
    val name: String,
    val downloadUrl: String,
    val size: Long = 0,
)

/**
 * The newest update one source offers, independent of where it came from.
 *
 * GitHub releases carry no `versionCode`, so [versionCode] is only set by a
 * custom feed; the APK's own version code is checked before installing
 * either way. [pageUrl] exists only for GitHub releases (the banner may offer
 * "Release page" there); a custom feed has no page to open.
 *
 * This model is also what the six-hour cache stores: it holds no secrets and
 * no request state, only what was announced.
 */
@Serializable
data class AndroidUpdateCandidate(
    val versionName: String,
    val versionCode: Long? = null,
    val pageUrl: String? = null,
    val apkUrl: String? = null,
    val apkSize: Long? = null,
    /** The feed's SHA-256, or null when [sha256Url] has to be fetched (GitHub asset). */
    val sha256: String? = null,
    /** The release's `ompweb-<version>.apk.sha256` asset. */
    val sha256Url: String? = null,
    val notes: String? = null,
)

/** The persisted result of one successful check (`ompweb-android-update`). */
@Serializable
data class AndroidUpdateCache(
    val checkedAtMillis: Long,
    /**
     * Where the answer came from: [ANDROID_UPDATE_GITHUB_SOURCE] or the custom
     * feed URL. A cache from another source is never shown.
     */
    val sourceKey: String = ANDROID_UPDATE_GITHUB_SOURCE,
    /** The announced update; null means "checked, up to date". */
    val candidate: AndroidUpdateCandidate? = null,
    /**
     * The installed `versionCode` the check was made for. An app update
     * invalidates the answer: the new build may itself be the announced one,
     * and the source must be asked again at least once after the install.
     * Older caches (written before this field existed) deserialize as 0 and
     * therefore also force one check after the upgrade.
     */
    val installedVersionCode: Long = 0,
)

/** The banner/card state: an update is available when [notice] is non-null. */
data class AndroidUpdateNotice(
    val currentVersion: String,
    val availableVersion: String,
    /** GitHub release page, when the source has one. */
    val releaseUrl: String? = null,
    /** Whether this build can download and install the APK itself. */
    val installable: Boolean = false,
)

/** The tag prefix used for Android releases in this repository. */
const val ANDROID_RELEASE_TAG_PREFIX: String = "android-v"

/** The [AndroidUpdateCache.sourceKey] of GitHub Releases. */
const val ANDROID_UPDATE_GITHUB_SOURCE: String = "github"

/** How long a successful check is reused before the source is asked again. */
const val ANDROID_UPDATE_CACHE_MILLIS: Long = 6L * 60L * 60L * 1000L

/**
 * How old the last successful check may be when the app comes back to the
 * foreground. The process lives for days, so the six-hour cache would leave a
 * published update unseen for most of that time; past this window the source
 * is asked again on every later return.
 */
const val ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS: Long = 30L * 60L * 1000L

/** A downloaded update larger than this is refused before and during the download. */
const val MAX_ANDROID_UPDATE_BYTES: Long = 200L * 1024L * 1024L

/** A custom feed may not exceed this; it is a handful of fields. */
const val MAX_ANDROID_UPDATE_FEED_BYTES: Long = 64L * 1024L

/** A `.sha256` file is one line; anything larger is not a checksum. */
const val MAX_ANDROID_UPDATE_CHECKSUM_BYTES: Long = 4L * 1024L

/** The only release pages the update notice may open. */
private const val ANDROID_RELEASE_PAGE_PATH = "/kahme247/ompweb/releases/"

/** The only download URLs the GitHub source may hand to the downloader. */
private const val ANDROID_RELEASE_ASSET_PATH = "/kahme247/ompweb/releases/download/"

private val SHA256_HEX = Regex("[0-9a-f]{64}")

/** Whether [raw] is a 64-character hexadecimal SHA-256 digest. */
fun isAndroidUpdateSha256(raw: String?): Boolean =
    raw != null && SHA256_HEX.matches(raw.trim().lowercase())

/** Lower-cases a valid digest; null for anything else. */
fun normalizeAndroidUpdateSha256(raw: String?): String? =
    raw?.trim()?.lowercase()?.takeIf { SHA256_HEX.matches(it) }

/**
 * Whether [raw] is an `https` page under this repository's GitHub releases.
 * The API answer and the persisted cache are both untrusted input: checking
 * only the scheme would let a manipulated entry send the banner's "Release
 * page" button to a phishing host.
 */
fun isAndroidReleasePage(raw: String): Boolean {
    val uri = parseHttpsUri(raw) ?: return false
    return uri.host.equals("github.com", ignoreCase = true) &&
        (uri.path.orEmpty()).startsWith(ANDROID_RELEASE_PAGE_PATH)
}

/**
 * Whether [raw] is a download file under this repository's GitHub releases.
 * A release asset redirects to a storage host; the request URL itself must be
 * the repository's, so a manipulated releases answer cannot point the
 * downloader at an arbitrary server.
 */
fun isAndroidReleaseAsset(raw: String): Boolean {
    val uri = parseHttpsUri(raw) ?: return false
    return uri.host.equals("github.com", ignoreCase = true) &&
        (uri.path.orEmpty()).startsWith(ANDROID_RELEASE_ASSET_PATH)
}

private fun parseHttpsUri(raw: String): URI? {
    if (!raw.startsWith("https://", ignoreCase = true)) return null
    val uri = runCatching { URI(raw) }.getOrNull() ?: return null
    if (!uri.scheme.equals("https", ignoreCase = true)) return null
    if (uri.rawUserInfo != null) return null
    return uri
}

/**
 * The version part of an `android-v*` tag, or null for every other tag (web
 * and omp releases share the same list).
 */
fun androidVersionFromTag(tag: String): String? {
    if (!tag.startsWith(ANDROID_RELEASE_TAG_PREFIX)) return null
    return tag.removePrefix(ANDROID_RELEASE_TAG_PREFIX).trim().takeIf { it.isNotEmpty() }
}

/**
 * Strips the decoration `versionName` may carry: a leading `v`, build
 * metadata after `+`, and the debug build's `-debug` suffix. A real
 * pre-release suffix (`-beta.1`) is kept for [parseAndroidVersion].
 */
fun normalizeInstalledVersion(raw: String): String =
    raw.trim()
        .removePrefix("v")
        .removePrefix("V")
        .substringBefore('+')
        .removeSuffix("-debug")
        .trim()

private data class ParsedAndroidVersion(val core: List<Int>, val preRelease: String?)

private fun parseAndroidVersion(raw: String): ParsedAndroidVersion? {
    val version = normalizeInstalledVersion(raw)
    if (version.isEmpty()) return null
    val preRelease = version.substringAfter('-', missingDelimiterValue = "").takeIf { it.isNotEmpty() }
    val corePart = version.substringBefore('-')
    val segments = corePart.split('.')
    if (segments.isEmpty() || segments.any { it.isEmpty() || !it.all(Char::isDigit) }) return null
    return ParsedAndroidVersion(segments.map { it.toIntOrNull() ?: return null }, preRelease)
}

/** Whether [raw] is a numeric version the comparison understands (`1.2.3`, `1.2.3-beta.1`). */
fun isParsableAndroidVersion(raw: String): Boolean = parseAndroidVersion(raw) != null

/**
 * Compares two version strings numerically (`1.0.10` > `1.0.9`, `1.1` ==
 * `1.1.0`); a release sorts above the pre-release of the same core. An
 * unparsable side compares equal, so it can never fake an update.
 */
fun compareAndroidVersions(left: String, right: String): Int {
    val a = parseAndroidVersion(left) ?: return 0
    val b = parseAndroidVersion(right) ?: return 0
    val count = maxOf(a.core.size, b.core.size)
    for (index in 0 until count) {
        val difference = a.core.getOrElse(index) { 0 }.compareTo(b.core.getOrElse(index) { 0 })
        if (difference != 0) return difference
    }
    return when {
        a.preRelease == null && b.preRelease == null -> 0
        a.preRelease == null -> 1
        b.preRelease == null -> -1
        else -> a.preRelease.compareTo(b.preRelease, ignoreCase = true)
    }
}

/** Whether [nowMillis] is still inside the 6-hour window of a successful check. */
fun isAndroidUpdateCacheFresh(cache: AndroidUpdateCache, nowMillis: Long): Boolean {
    val age = nowMillis - cache.checkedAtMillis
    return age in 0 until ANDROID_UPDATE_CACHE_MILLIS
}

/**
 * The newest published, non-prerelease release that is newer than
 * [currentVersion]; null when the installed build is current. Drafts and
 * prereleases are excluded, and a release without a page under this
 * repository's GitHub releases is ignored because the banner may only open
 * that page.
 */
fun newestAndroidRelease(releases: List<AndroidRelease>, currentVersion: String): AndroidRelease? {
    val installed = normalizeInstalledVersion(currentVersion)
    return releases
        .asSequence()
        .filter { !it.draft && !it.prerelease }
        .filter { isAndroidReleasePage(it.htmlUrl) }
        .filter { compareAndroidVersions(it.version, installed) > 0 }
        .maxWithOrNull { left, right -> compareAndroidVersions(left.version, right.version) }
}

/**
 * Whether [candidate] is an update over the installed build. A source that
 * announces a `versionCode` (custom feed) is judged by it, because Android
 * decides installability by that number; GitHub releases only carry a name.
 */
fun isAndroidUpdateCandidateNewer(
    candidate: AndroidUpdateCandidate,
    currentVersion: String,
    currentVersionCode: Long,
): Boolean {
    val announcedCode = candidate.versionCode
    if (announcedCode != null) return announcedCode > currentVersionCode
    return compareAndroidVersions(candidate.versionName, currentVersion) > 0
}

/** Whether this candidate comes with everything needed to install it. */
val AndroidUpdateCandidate.canInstall: Boolean
    get() = apkUrl?.let(::isAndroidUpdateUrlAllowed) == true &&
        apkSize != null &&
        apkSize in 1..MAX_ANDROID_UPDATE_BYTES &&
        (sha256 == null || isAndroidUpdateSha256(sha256)) &&
        (sha256 != null || sha256Url?.let(::isAndroidReleaseAsset) == true)

/**
 * The banner state for [candidate] unless that version was dismissed.
 * Dismissing is per version: a newer release shows again, the dismissed one
 * never does.
 */
fun androidUpdateNotice(
    candidate: AndroidUpdateCandidate?,
    currentVersion: String,
    currentVersionCode: Long,
    dismissedVersion: String?,
): AndroidUpdateNotice? {
    val update = candidate ?: return null
    if (!isAndroidUpdateCandidateNewer(update, currentVersion, currentVersionCode)) return null
    if (dismissedVersion != null && compareAndroidVersions(dismissedVersion, update.versionName) >= 0) {
        return null
    }
    return AndroidUpdateNotice(
        currentVersion = normalizeInstalledVersion(currentVersion),
        availableVersion = update.versionName,
        releaseUrl = update.pageUrl?.takeIf(::isAndroidReleasePage),
        installable = update.canInstall,
    )
}

/** A custom feed address the user entered: https anywhere, plain http only in a private network. */
sealed interface AndroidUpdateFeedUrlResult {
    /** The normalized absolute URL to fetch. */
    data class Valid(val url: String) : AndroidUpdateFeedUrlResult

    /** [message] is shown under the input field. */
    data class Invalid(val message: String) : AndroidUpdateFeedUrlResult
}

/**
 * Validates the feed address against the same rules as the server address
 * (`ServerAddress`): `https://` anywhere, plain `http://` only for loopback,
 * RFC 1918, CGNAT, link-local, `.local` and Tailscale names. The network
 * layer enforces the resolved peer address again ([HttpPolicyInterceptor]).
 */
fun parseAndroidUpdateFeedUrl(raw: String): AndroidUpdateFeedUrlResult {
    val input = raw.trim()
    if (input.isEmpty()) return AndroidUpdateFeedUrlResult.Invalid("Enter the address of the update feed.")
    if (input.length > 2048) return AndroidUpdateFeedUrlResult.Invalid("The address is too long.")
    if (input.any { it.isWhitespace() || it.code < 0x20 || it.code == 0x7f }) {
        return AndroidUpdateFeedUrlResult.Invalid("The address must not contain spaces.")
    }
    val uri = runCatching { URI(input) }.getOrNull()
        ?: return AndroidUpdateFeedUrlResult.Invalid("Enter a complete address, for example https://example.com/ompweb/latest.json.")
    val scheme = uri.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") {
        return AndroidUpdateFeedUrlResult.Invalid("Only http:// and https:// addresses are supported.")
    }
    if (uri.rawUserInfo != null) {
        return AndroidUpdateFeedUrlResult.Invalid("Do not include a username or password in the address.")
    }
    val host = uri.host?.lowercase()?.removeSuffix(".").orEmpty()
    if (host.isEmpty()) {
        return AndroidUpdateFeedUrlResult.Invalid("Enter a complete address, for example https://example.com/ompweb/latest.json.")
    }
    if (scheme == "http" && !ServerAddress.allowsPlainHttp(host)) {
        return AndroidUpdateFeedUrlResult.Invalid(ANDROID_UPDATE_PLAIN_HTTP_MESSAGE)
    }
    return AndroidUpdateFeedUrlResult.Valid(uri.toString())
}

/** The plain-HTTP rule, worded like the settings screen's server address message. */
const val ANDROID_UPDATE_PLAIN_HTTP_MESSAGE: String = ServerAddress.PLAIN_HTTP_MESSAGE

/**
 * Whether the updater may fetch [raw]: `https` anywhere, plain `http` only for
 * a private host. Applied to the feed address, the feed's `apkUrl` and the
 * checksum URL, so a feed cannot redirect the updater to a public plain-HTTP
 * server.
 */
fun isAndroidUpdateUrlAllowed(raw: String): Boolean {
    val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return false
    if (uri.rawUserInfo != null) return false
    return when (uri.scheme?.lowercase()) {
        "https" -> true
        "http" -> uri.host?.lowercase()?.let(ServerAddress::allowsPlainHttp) == true
        else -> false
    }
}

/** The parsed and validated body of a custom feed (`/latest.json`). */
@Serializable
data class AndroidUpdateFeed(
    val versionName: String,
    val versionCode: Long,
    /** Absolute after [parseAndroidUpdateFeed]; the feed may send a relative path. */
    val apkUrl: String,
    val sha256: String,
    val size: Long,
    val notes: String? = null,
)

sealed interface AndroidUpdateFeedResult {
    data class Parsed(val feed: AndroidUpdateFeed) : AndroidUpdateFeedResult

    /** [reason] is for diagnostics and tests; the UI reports a failed check. */
    data class Invalid(val reason: String) : AndroidUpdateFeedResult
}

private val feedJson = Json { ignoreUnknownKeys = true }

/**
 * Parses `{"versionName","versionCode","apkUrl","sha256","size","notes"?}`.
 *
 * `apkUrl` may be relative to [feedUrl]. Every URL in the answer has to pass
 * [isAndroidUpdateUrlAllowed]; the feed is untrusted input, so a single bad
 * field rejects the whole answer instead of installing something partial.
 */
fun parseAndroidUpdateFeed(body: String, feedUrl: String): AndroidUpdateFeedResult {
    val decoded = runCatching { feedJson.decodeFromString<AndroidUpdateFeed>(body) }.getOrNull()
        ?: return AndroidUpdateFeedResult.Invalid("The feed is not valid JSON with the required fields.")
    val versionName = normalizeInstalledVersion(decoded.versionName)
    if (!isParsableAndroidVersion(versionName)) {
        return AndroidUpdateFeedResult.Invalid("The feed has no valid versionName.")
    }
    if (decoded.versionCode <= 0) {
        return AndroidUpdateFeedResult.Invalid("The feed has no valid versionCode.")
    }
    if (versionName.length > 64) {
        return AndroidUpdateFeedResult.Invalid("The feed's versionName is too long.")
    }
    val sha256 = normalizeAndroidUpdateSha256(decoded.sha256)
        ?: return AndroidUpdateFeedResult.Invalid("The feed has no valid SHA-256.")
    if (decoded.size !in 1..MAX_ANDROID_UPDATE_BYTES) {
        return AndroidUpdateFeedResult.Invalid("The feed's APK size is missing or too large.")
    }
    val apkUrl = resolveAndroidUpdateUrl(feedUrl, decoded.apkUrl)
        ?: return AndroidUpdateFeedResult.Invalid("The feed's apkUrl is not an allowed address.")
    val notes = decoded.notes?.trim()?.takeIf { it.isNotEmpty() }?.take(2000)
    return AndroidUpdateFeedResult.Parsed(
        decoded.copy(
            versionName = versionName,
            apkUrl = apkUrl,
            sha256 = sha256,
            notes = notes,
        ),
    )
}

/** Resolves [raw] against [base] and returns it only when the updater may fetch it. */
fun resolveAndroidUpdateUrl(base: String, raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    val resolved = runCatching { URI(base).resolve(trimmed) }.getOrNull() ?: return null
    val absolute = resolved.toString()
    return absolute.takeIf(::isAndroidUpdateUrlAllowed)
}
