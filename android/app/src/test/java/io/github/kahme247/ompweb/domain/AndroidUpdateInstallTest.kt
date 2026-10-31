package io.github.kahme247.ompweb.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The decisions that run between "download finished" and "PackageInstaller
 * session": checksum, package names, version codes and the signing
 * certificate of the installed app.
 */
class AndroidUpdateInstallTest {

    private val sha = "a".repeat(64)

    private fun identity(
        packageName: String = PACKAGE,
        versionCode: Long = 10001,
        signer: String = "d73354b52dc7c3f0c74623c439ddb7b52e252811c6e6b5f851c9d04b7015fc87",
    ) = AndroidApkIdentity(
        packageName = packageName,
        versionCode = versionCode,
        versionName = "1.0.1",
        signerSha256 = setOf(signer),
    )

    private fun decide(
        installed: AndroidApkIdentity? = identity(versionCode = 10000),
        downloaded: AndroidApkIdentity? = identity(),
        announcedVersionCode: Long? = 10001,
        expectedSha256: String = sha,
        actualSha256: String = sha,
    ) = decideAndroidUpdateInstall(
        appPackageName = PACKAGE,
        installed = installed,
        downloaded = downloaded,
        announcedVersionCode = announcedVersionCode,
        expectedSha256 = expectedSha256,
        actualSha256 = actualSha256,
    )

    @Test
    fun `a matching newer APK signed with the installed key may install`() {
        assertEquals(AndroidInstallDecision.Install, decide())
    }

    @Test
    fun `a tampered SHA-256 is refused`() {
        val decision = decide(actualSha256 = "b".repeat(64)) as AndroidInstallDecision.Refuse

        assertTrue(decision.message.contains("SHA-256 mismatch"))
    }

    @Test
    fun `another package name is refused`() {
        assertTrue((decide(downloaded = identity(packageName = "com.example.evil")) as AndroidInstallDecision.Refuse)
            .message.contains("another package"))
        assertTrue((decide(installed = identity(packageName = "com.example.other")) as AndroidInstallDecision.Refuse)
            .message.contains("does not match this package"))
    }

    @Test
    fun `a different signing key is refused`() {
        val decision = decide(
            downloaded = identity(signer = "06d9d698c6a43f643a27643618fd4f7d431d26d4"),
        ) as AndroidInstallDecision.Refuse

        assertTrue(decision.message.contains("different key"))
    }

    @Test
    fun `a version code that is not higher is refused`() {
        assertTrue(
            (
                decide(
                    downloaded = identity(versionCode = 10000),
                    announcedVersionCode = 10000,
                ) as AndroidInstallDecision.Refuse
                ).message.contains("not newer"),
        )
    }

    @Test
    fun `a downloaded version code must match the announcement`() {
        val decision = decide(announcedVersionCode = 10002) as AndroidInstallDecision.Refuse

        assertTrue(decision.message.contains("does not match the announced one"))
    }

    @Test
    fun `an unreadable APK or app is refused with a reason`() {
        assertTrue((decide(downloaded = null) as AndroidInstallDecision.Refuse)
            .message.contains("not an installable app package"))
        assertTrue((decide(installed = null) as AndroidInstallDecision.Refuse)
            .message.contains("could not be read"))
        assertTrue(
            (decide(downloaded = identity().copy(signerSha256 = emptySet())) as AndroidInstallDecision.Refuse)
                .message.contains("signing certificate"),
        )
    }

    @Test
    fun `an invalid expected digest is refused before anything else`() {
        val decision = decide(expectedSha256 = "not-a-digest") as AndroidInstallDecision.Refuse

        assertTrue(decision.message.contains("no valid SHA-256"))
    }

    @Test
    fun `the digest helpers accept only 64 hex characters`() {
        assertTrue(isAndroidUpdateSha256(sha))
        assertTrue(isAndroidUpdateSha256("A".repeat(64)))
        assertTrue(!isAndroidUpdateSha256("a".repeat(63)))
        assertTrue(!isAndroidUpdateSha256("g".repeat(64)))
        assertNull(normalizeAndroidUpdateSha256(null))
        assertEquals(sha, normalizeAndroidUpdateSha256("A".repeat(64)))
    }

    @Test
    fun `a sha256sum file yields its digest`() {
        assertEquals(sha, parseAndroidUpdateSha256Asset("$sha  ompweb-1.0.1.apk\n"))
        assertEquals(sha, parseAndroidUpdateSha256Asset("SHA256 (ompweb-1.0.1.apk) = ${"a".repeat(64)}"))
        assertNull(parseAndroidUpdateSha256Asset("no digest here"))
    }

    @Test
    fun `sha256Hex hashes a stream`() {
        val digest = sha256Hex("abc".byteInputStream())

        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            digest,
        )
    }

    private companion object {
        const val PACKAGE = "io.github.kahme247.ompweb"
    }
}
