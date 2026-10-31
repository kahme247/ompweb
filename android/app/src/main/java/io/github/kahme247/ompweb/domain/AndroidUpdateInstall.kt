package io.github.kahme247.ompweb.domain

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * What PackageManager reports about one APK — the installed app or a
 * downloaded file. Both sides are read with `GET_SIGNING_CERTIFICATES`, so the
 * comparison uses the same certificate source Android uses to decide whether
 * an update may replace an app.
 */
data class AndroidApkIdentity(
    val packageName: String,
    val versionCode: Long,
    val versionName: String?,
    /** SHA-256 of every current signer certificate, lower-case hex. */
    val signerSha256: Set<String>,
)

/** The outcome of the local checks that run before PackageInstaller opens a session. */
sealed interface AndroidInstallDecision {
    data object Install : AndroidInstallDecision

    /** [message] is shown to the user; nothing was installed. */
    data class Refuse(val message: String) : AndroidInstallDecision
}

/**
 * Decides whether a downloaded update may replace the installed app.
 *
 * The checks are the ones Android would silently fail on — or, worse, accept
 * from another package — so they run here with a clear message instead:
 * checksum, package name, announced version code, a strictly higher version
 * code and the signing certificate of the installed app. Only a positive
 * result of every check leads to an install.
 */
fun decideAndroidUpdateInstall(
    appPackageName: String,
    installed: AndroidApkIdentity?,
    downloaded: AndroidApkIdentity?,
    announcedVersionCode: Long?,
    expectedSha256: String,
    actualSha256: String,
): AndroidInstallDecision {
    if (downloaded == null) {
        return AndroidInstallDecision.Refuse(
            "The downloaded file is not an installable app package.",
        )
    }
    val expected = normalizeAndroidUpdateSha256(expectedSha256)
        ?: return AndroidInstallDecision.Refuse("The update has no valid SHA-256 to verify.")
    val actual = normalizeAndroidUpdateSha256(actualSha256)
    if (expected != actual) {
        return AndroidInstallDecision.Refuse(
            "The downloaded file is damaged or was tampered with (SHA-256 mismatch). It was not installed.",
        )
    }
    if (installed == null) {
        return AndroidInstallDecision.Refuse(
            "The installed app's version information could not be read.",
        )
    }
    if (installed.packageName != appPackageName) {
        return AndroidInstallDecision.Refuse(
            "The installed app does not match this package (${installed.packageName}).",
        )
    }
    if (downloaded.packageName != appPackageName) {
        return AndroidInstallDecision.Refuse(
            "The downloaded app is for another package (${downloaded.packageName}). It was not installed.",
        )
    }
    if (announcedVersionCode != null && downloaded.versionCode != announcedVersionCode) {
        return AndroidInstallDecision.Refuse(
            "The downloaded app's version code (${downloaded.versionCode}) does not match the announced one " +
                "($announcedVersionCode). It was not installed.",
        )
    }
    if (downloaded.versionCode <= installed.versionCode) {
        return AndroidInstallDecision.Refuse(
            "The downloaded app (version code ${downloaded.versionCode}) is not newer than the installed " +
                "version (${installed.versionCode}). It was not installed.",
        )
    }
    if (installed.signerSha256.isEmpty() || downloaded.signerSha256.isEmpty()) {
        return AndroidInstallDecision.Refuse(
            "The signing certificate of the app could not be read. The update was not installed.",
        )
    }
    if (installed.signerSha256 != downloaded.signerSha256) {
        return AndroidInstallDecision.Refuse(
            "The downloaded app is signed with a different key than the installed app. It was not installed.",
        )
    }
    return AndroidInstallDecision.Install
}

/** The first SHA-256 digest in a `.sha256` asset (GNU `sha256sum` format). */
fun parseAndroidUpdateSha256Asset(text: String): String? {
    val match = Regex("(?i)\\b[0-9a-f]{64}\\b").find(text) ?: return null
    return normalizeAndroidUpdateSha256(match.value)
}

/** SHA-256 of [input] as lower-case hex. The stream is not closed. */
fun sha256Hex(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
}

/** SHA-256 of [file]; null when the file cannot be read. */
fun sha256Hex(file: File): String? =
    runCatching { file.inputStream().use(::sha256Hex) }.getOrNull()

/**
 * Whether [candidate]'s APK size is a plausible download. The announced size
 * is the cap for the transfer; [MAX_ANDROID_UPDATE_BYTES] is the absolute one.
 */
fun isAndroidUpdateSizeAllowed(size: Long?): Boolean =
    size != null && size in 1..MAX_ANDROID_UPDATE_BYTES
