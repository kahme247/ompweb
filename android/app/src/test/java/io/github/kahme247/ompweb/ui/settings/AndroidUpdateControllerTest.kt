package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.data.AndroidUpdatePreferences
import io.github.kahme247.ompweb.data.AndroidUpdatePreferencesSnapshot
import io.github.kahme247.ompweb.domain.ANDROID_UPDATE_CACHE_MILLIS
import io.github.kahme247.ompweb.domain.ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS
import io.github.kahme247.ompweb.domain.ANDROID_UPDATE_GITHUB_SOURCE
import io.github.kahme247.ompweb.domain.AndroidApkIdentity
import io.github.kahme247.ompweb.domain.AndroidUpdateCache
import io.github.kahme247.ompweb.domain.AndroidUpdateCandidate
import io.github.kahme247.ompweb.domain.sha256Hex
import io.github.kahme247.ompweb.net.AndroidUpdateDownload
import io.github.kahme247.ompweb.net.AndroidUpdateDownloader
import io.github.kahme247.ompweb.net.AndroidUpdateSource
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The controller is where cache, source switching and the install pipeline
 * meet. Everything that talks to Android is a fake here; the real
 * PackageManager/PackageInstaller wiring is exercised by the app, not by JVM
 * tests.
 */
class AndroidUpdateControllerTest {

    private val now = 1_700_000_000_000L
    private val packageName = "io.github.kahme247.ompweb"
    private val installedSigner =
        "d73354b52dc7c3f0c74623c439ddb7b52e252811c6e6b5f851c9d04b7015fc87"

    private fun candidate(
        version: String = "1.0.1",
        versionCode: Long = 10001,
        withApk: Boolean = true,
    ) = AndroidUpdateCandidate(
        versionName = version,
        versionCode = versionCode,
        pageUrl = null,
        apkUrl = if (withApk) "https://updates.example.com/ompweb-$version.apk" else null,
        apkSize = if (withApk) 64L else null,
        sha256 = if (withApk) "a".repeat(64) else null,
    )

    private fun identity(versionCode: Long = 10001, signer: String = installedSigner) =
        AndroidApkIdentity(
            packageName = packageName,
            versionCode = versionCode,
            versionName = "1.0.1",
            signerSha256 = setOf(signer),
        )

    private fun controller(
        scope: kotlinx.coroutines.CoroutineScope,
        prefs: FakePrefs,
        source: AndroidUpdateSource,
        downloader: AndroidUpdateDownloader? = null,
        inspector: AndroidApkInspector? = null,
        installer: AndroidApkInstaller? = null,
        installStatus: Flow<AndroidInstallSessionStatus> = emptyFlow(),
        clock: () -> Long = { now },
    ) = AndroidUpdateController(
        source = source,
        settings = prefs,
        scope = scope,
        currentVersion = "1.0.0",
        installedPackageName = packageName,
        currentVersionCode = 10000,
        downloader = downloader,
        inspector = inspector,
        installer = installer,
        installStatus = installStatus,
        now = clock,
    )

    @Test
    fun `a fresh cache answers from disk without a request`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = FakePrefs(
            AndroidUpdatePreferencesSnapshot(
                cache = AndroidUpdateCache(now, ANDROID_UPDATE_GITHUB_SOURCE, candidate(), installedVersionCode = 10000),
            ),
        )
        val source = FakeSource(candidate("1.2.0"))
        val controller = controller(backgroundScope, prefs, source)

        controller.check()

        assertEquals("1.0.1", controller.state.value.latest?.versionName)
        assertTrue(source.calls.isEmpty())
    }

    @Test
    fun `a stale cache asks the source and persists the answer`() = runTest(UnconfinedTestDispatcher()) {
        val stale = now - ANDROID_UPDATE_CACHE_MILLIS - 1
        val prefs = FakePrefs(
            AndroidUpdatePreferencesSnapshot(
                cache = AndroidUpdateCache(stale, ANDROID_UPDATE_GITHUB_SOURCE, null, installedVersionCode = 10000),
            ),
        )
        val source = FakeSource(candidate("1.2.0"))
        val controller = controller(backgroundScope, prefs, source)

        controller.check()

        assertEquals(listOf<String?>(null), source.calls)
        assertEquals("1.2.0", controller.state.value.latest?.versionName)
        val cache = prefs.value.cache!!
        assertEquals(now, cache.checkedAtMillis)
        assertEquals(ANDROID_UPDATE_GITHUB_SOURCE, cache.sourceKey)
        assertEquals("1.2.0", cache.candidate?.versionName)
    }

    @Test
    fun `a cold start reuses the cache for six hours and then asks`() =
        runTest(UnconfinedTestDispatcher()) {
            val prefs = FakePrefs()
            val source = FakeSource(candidate("1.0.1", 10001))
            var clock = now
            val controller = controller(backgroundScope, prefs, source, clock = { clock })

            // The check on app start fills the cache with one request.
            controller.check()
            assertEquals(1, source.calls.size)

            // A restart inside the six-hour window answers from the cache.
            clock = now + ANDROID_UPDATE_CACHE_MILLIS - 1
            controller.check()
            controller.check()
            assertEquals(1, source.calls.size)
            assertEquals("1.0.1", controller.state.value.latest?.versionName)

            // Once the window has passed, the next start asks.
            clock = now + ANDROID_UPDATE_CACHE_MILLIS + 1
            controller.check()
            assertEquals(2, source.calls.size)
        }

    @Test
    fun `a return to the foreground rechecks once the answer is thirty minutes old`() =
        runTest(UnconfinedTestDispatcher()) {
            val prefs = FakePrefs()
            val source = FakeSource(candidate("1.0.1", 10001))
            var clock = now
            val controller = controller(backgroundScope, prefs, source, clock = { clock })

            // Cold start: the shell's staggered check.
            controller.check()
            assertEquals(1, source.calls.size)

            // Inside the foreground window the answer is reused, however often
            // the user switches apps.
            clock = now + ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS - 1
            controller.checkOnForeground()
            controller.checkOnForeground()
            assertEquals(1, source.calls.size)

            // Past it the next return asks the source again, even though the
            // six-hour cache would still answer.
            clock = now + ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS + 1
            assertTrue(clock < now + ANDROID_UPDATE_CACHE_MILLIS)
            controller.checkOnForeground()
            assertEquals(2, source.calls.size)
            assertEquals(clock, prefs.value.cache?.checkedAtMillis)

            // That request refilled the window.
            clock += ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS - 1
            controller.checkOnForeground()
            assertEquals(2, source.calls.size)
        }

    @Test
    fun `an app update invalidates the cache and checks once`() =
        runTest(UnconfinedTestDispatcher()) {
            // The answer was written by the previous build (`versionCode`
            // 9999); the installed build is 10000, so it may be exactly the
            // release that was just installed and the source must be asked.
            val prefs = FakePrefs(
                AndroidUpdatePreferencesSnapshot(
                    cache = AndroidUpdateCache(
                        now - 1_000,
                        ANDROID_UPDATE_GITHUB_SOURCE,
                        candidate("1.1.0", 10010),
                        installedVersionCode = 9_999,
                    ),
                ),
            )
            val source = FakeSource(candidate("1.2.0"))
            val controller = controller(backgroundScope, prefs, source)

            assertNull("the old build's answer is not shown", controller.state.value.latest)
            assertNull(controller.state.value.checkedAtMillis)

            controller.check()

            assertEquals(1, source.calls.size)
            assertEquals("1.2.0", controller.state.value.latest?.versionName)
            assertEquals(10000L, prefs.value.cache?.installedVersionCode)
        }

    @Test
    fun `a failed check keeps the cached answer and marks the failure`() = runTest(UnconfinedTestDispatcher()) {
        val cache = AndroidUpdateCache(
            now - ANDROID_UPDATE_CACHE_MILLIS - 1,
            ANDROID_UPDATE_GITHUB_SOURCE,
            candidate("1.1.0"),
            installedVersionCode = 10000,
        )
        val prefs = FakePrefs(AndroidUpdatePreferencesSnapshot(cache = cache))
        val source = FakeSource(failure = IOException("offline"))
        val controller = controller(backgroundScope, prefs, source)

        controller.check(force = true)

        assertTrue(controller.state.value.failed)
        assertEquals("1.1.0", controller.state.value.latest?.versionName)
        // The failed check must not overwrite the good cache.
        assertEquals(cache, prefs.value.cache)
    }

    @Test
    fun `dismissing hides exactly the announced version`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = FakePrefs()
        val controller = controller(backgroundScope, prefs, FakeSource(candidate("1.1.0")))
        controller.check()
        val notice = controller.state.value.notice!!
        assertEquals("1.1.0", notice.availableVersion)

        controller.dismiss(notice.availableVersion)

        assertNull(controller.state.value.notice)
        assertEquals("1.1.0", prefs.value.dismissedVersion)
    }

    @Test
    fun `an invalid or public http feed url is refused without a request`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = FakePrefs()
        val source = FakeSource(candidate())
        val controller = controller(backgroundScope, prefs, source)

        val error = controller.setUpdateFeedUrl("http://example.com/latest.json")

        assertTrue(error != null && error.contains("https://"))
        assertNull(prefs.value.feedUrl)
        assertTrue(source.calls.isEmpty())
    }

    @Test
    fun `a custom feed replaces the GitHub answer and is used by the next check`() = runTest(UnconfinedTestDispatcher()) {
        val feed = "https://updates.example.com/latest.json"
        val prefs = FakePrefs()
        val source = FakeSource(candidate("1.0.1", 10001))
        val controller = controller(backgroundScope, prefs, source)
        controller.check()
        assertEquals(ANDROID_UPDATE_GITHUB_SOURCE, prefs.value.cache?.sourceKey)

        val error = controller.setUpdateFeedUrl(feed)

        assertNull(error)
        assertEquals(feed, prefs.value.feedUrl)
        assertEquals(listOf<String?>(null, feed), source.calls)
        assertEquals(feed, prefs.value.cache?.sourceKey)
        assertEquals("1.0.1", controller.state.value.latest?.versionName)
    }

    @Test
    fun `switching back to GitHub drops the custom answer`() = runTest(UnconfinedTestDispatcher()) {
        val feed = "https://updates.example.com/latest.json"
        val prefs = FakePrefs(AndroidUpdatePreferencesSnapshot(feedUrl = feed))
        val source = FakeSource(candidate("1.0.1", 10001))
        val controller = controller(backgroundScope, prefs, source)
        controller.check()
        assertEquals(feed, controller.state.value.feedUrl)

        val error = controller.setUpdateFeedUrl(null)

        assertNull(error)
        assertNull(prefs.value.feedUrl)
        assertEquals(ANDROID_UPDATE_GITHUB_SOURCE, prefs.value.cache?.sourceKey)
    }

    @Test
    fun `switching the source during a running check still checks the new source`() =
        runTest(UnconfinedTestDispatcher()) {
            val feed = "https://updates.example.com/latest.json"
            val gate = CompletableDeferred<Unit>()
            var calls = 0
            val source = object : AndroidUpdateSource {
                override suspend fun latest(
                    feedUrl: String?,
                    installedVersionName: String,
                    installedVersionCode: Long,
                ): AndroidUpdateCandidate? {
                    calls++
                    if (calls == 1) gate.await()
                    return candidate("1.0.1", 10001)
                }
            }
            val prefs = FakePrefs()
            val controller = controller(backgroundScope, prefs, source)
            controller.check()
            assertTrue(controller.state.value.checking)

            controller.setUpdateFeedUrl(feed)

            gate.complete(Unit)
            assertEquals(feed, controller.state.value.feedUrl)
            assertEquals("1.0.1", controller.state.value.latest?.versionName)
            assertFalse(controller.state.value.checking)
            assertEquals(feed, prefs.value.cache?.sourceKey)
        }

    @Test
    fun `install downloads, verifies and hands the file to the installer, then deletes it`() =
        runTest(UnconfinedTestDispatcher()) {
            val prefs = FakePrefs()
            val file = File.createTempFile("ompweb-update", ".apk").apply {
                writeText("fake apk")
                deleteOnExit()
            }
            val downloader = FakeDownloader(file)
            val installer = FakeInstaller()
            val controller = controller(
                backgroundScope,
                prefs,
                FakeSource(candidate()),
                downloader = downloader,
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
            )
            controller.check()

            controller.install()

            awaitInstall(controller) { installer.installed.isNotEmpty() && !file.exists() }
            assertEquals(1, downloader.calls)
            assertEquals(listOf(file), installer.installed)
            assertEquals(AndroidUpdateInstallState.Installing, controller.state.value.install)
            assertFalse(file.exists())
            assertFalse(downloader.lastProgress.isEmpty())
        }

    @Test
    fun `a confirmation request turns installing into waiting for the user`() =
        runTest(UnconfinedTestDispatcher()) {
            val installer = FakeInstaller()
            val controller = controller(
                backgroundScope,
                FakePrefs(),
                FakeSource(candidate()),
                downloader = FakeDownloader(File.createTempFile("ompweb-update", ".apk")),
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
                installStatus = installer.status,
            )
            controller.check()
            controller.install()
            awaitInstall(controller) { controller.state.value.install == AndroidUpdateInstallState.Installing }

            installer.status.emit(AndroidInstallSessionStatus.ConfirmationNeeded(installer.sessionId))

            assertEquals(AndroidUpdateInstallState.AwaitingConfirmation, controller.state.value.install)
        }

    @Test
    fun `a rejected confirmation ends the install with the system's reason and a retry`() =
        runTest(UnconfinedTestDispatcher()) {
            val installer = FakeInstaller()
            val file = File.createTempFile("ompweb-update", ".apk").apply { deleteOnExit() }
            val downloader = FakeDownloader(file)
            val controller = controller(
                backgroundScope,
                FakePrefs(),
                FakeSource(candidate()),
                downloader = downloader,
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
                installStatus = installer.status,
            )
            controller.check()
            controller.install()
            awaitInstall(controller) { installer.installed.isNotEmpty() }
            installer.status.emit(AndroidInstallSessionStatus.ConfirmationNeeded(installer.sessionId))

            installer.status.emit(
                AndroidInstallSessionStatus.Failed(
                    installer.sessionId,
                    "INSTALL_FAILED_ABORTED: User rejected permissions",
                ),
            )

            val failed = controller.state.value.install as AndroidUpdateInstallState.Failed
            assertTrue(failed.message.contains("User rejected permissions"))
            // The retry button must actually start a second attempt.
            controller.install()
            awaitInstall(controller) { installer.installed.size == 2 && downloader.calls == 2 }
        }

    @Test
    fun `a successful session answer clears the installing state`() =
        runTest(UnconfinedTestDispatcher()) {
            val installer = FakeInstaller()
            val controller = controller(
                backgroundScope,
                FakePrefs(),
                FakeSource(candidate()),
                downloader = FakeDownloader(File.createTempFile("ompweb-update", ".apk")),
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
                installStatus = installer.status,
            )
            controller.check()
            controller.install()
            awaitInstall(controller) { controller.state.value.install == AndroidUpdateInstallState.Installing }

            installer.status.emit(AndroidInstallSessionStatus.Installed(installer.sessionId))

            assertEquals(AndroidUpdateInstallState.Idle, controller.state.value.install)
        }

    @Test
    fun `a terminal status of another session cannot decide this attempt`() =
        runTest(UnconfinedTestDispatcher()) {
            val installer = FakeInstaller()
            val controller = controller(
                backgroundScope,
                FakePrefs(),
                FakeSource(candidate()),
                downloader = FakeDownloader(File.createTempFile("ompweb-update", ".apk")),
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
                installStatus = installer.status,
            )
            controller.check()
            controller.install()
            awaitInstall(controller) { controller.state.value.install == AndroidUpdateInstallState.Installing }
            assertEquals(listOf(installer.sessionId), installer.reportedSessions)

            // An earlier process left a session whose confirmation was never
            // answered; it delivers its terminal abort into this process while
            // the new attempt is installing. It must not fail the new attempt
            // (and must not swallow its later SUCCESS).
            installer.status.emit(
                AndroidInstallSessionStatus.Failed(
                    installer.sessionId + 1,
                    "INSTALL_FAILED_ABORTED: User rejected permissions",
                ),
            )

            assertEquals(AndroidUpdateInstallState.Installing, controller.state.value.install)

            installer.status.emit(AndroidInstallSessionStatus.ConfirmationNeeded(installer.sessionId))
            assertEquals(AndroidUpdateInstallState.AwaitingConfirmation, controller.state.value.install)

            // A success of the foreign session still changes nothing.
            installer.status.emit(AndroidInstallSessionStatus.Installed(installer.sessionId + 1))
            assertEquals(AndroidUpdateInstallState.AwaitingConfirmation, controller.state.value.install)

            installer.status.emit(AndroidInstallSessionStatus.Installed(installer.sessionId))
            assertEquals(AndroidUpdateInstallState.Idle, controller.state.value.install)
        }

    @Test
    fun `a status without a waiting install is ignored`() =
        runTest(UnconfinedTestDispatcher()) {
            val installer = FakeInstaller()
            val controller = controller(
                backgroundScope,
                FakePrefs(),
                FakeSource(candidate()),
                installer = installer,
                installStatus = installer.status,
            )
            controller.check()

            installer.status.emit(AndroidInstallSessionStatus.Failed(installer.sessionId, "late answer"))
            installer.status.emit(AndroidInstallSessionStatus.ConfirmationNeeded(installer.sessionId))
            installer.status.emit(AndroidInstallSessionStatus.Installed(installer.sessionId))

            assertEquals(AndroidUpdateInstallState.Idle, controller.state.value.install)
        }

    @Test
    fun `confirming reopens the pending dialog and fails clearly without one`() =
        runTest(UnconfinedTestDispatcher()) {
            val installer = FakeInstaller()
            val controller = controller(
                backgroundScope,
                FakePrefs(),
                FakeSource(candidate()),
                downloader = FakeDownloader(File.createTempFile("ompweb-update", ".apk")),
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
                installStatus = installer.status,
            )
            controller.check()
            controller.install()
            awaitInstall(controller) { controller.state.value.install == AndroidUpdateInstallState.Installing }
            installer.status.emit(AndroidInstallSessionStatus.ConfirmationNeeded(installer.sessionId))

            controller.confirmInstall()

            assertEquals(1, installer.confirmationOpens)
            assertEquals(AndroidUpdateInstallState.AwaitingConfirmation, controller.state.value.install)

            installer.confirmationAvailable = false
            controller.confirmInstall()

            val failed = controller.state.value.install as AndroidUpdateInstallState.Failed
            assertTrue(failed.message.contains("Install the update again"))
        }

    @Test
    fun `a tampered checksum is refused and the file is deleted`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = FakePrefs()
        val file = File.createTempFile("ompweb-update", ".apk").apply {
            writeText("fake apk")
            deleteOnExit()
        }
        val downloader = FakeDownloader(file, expectedSha256 = "b".repeat(64))
        val installer = FakeInstaller()
        val controller = controller(
            backgroundScope,
            prefs,
            FakeSource(candidate()),
            downloader = downloader,
            inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
            installer = installer,
        )
        controller.check()

        controller.install()

        awaitInstall(controller) {
            controller.state.value.install is AndroidUpdateInstallState.Failed && !file.exists()
        }
        val state = controller.state.value.install as AndroidUpdateInstallState.Failed
        assertTrue(state.message.contains("SHA-256"))
        assertTrue(installer.installed.isEmpty())
        assertFalse(file.exists())
    }

    @Test
    fun `a different signer is refused`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = FakePrefs()
        val file = File.createTempFile("ompweb-update", ".apk").apply {
            writeText("fake apk")
            deleteOnExit()
        }
        val installer = FakeInstaller()
        val controller = controller(
            backgroundScope,
            prefs,
            FakeSource(candidate()),
            downloader = FakeDownloader(file),
            inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity(signer = "ab".repeat(32)) }),
            installer = installer,
        )
        controller.check()

        controller.install()

        awaitInstall(controller) {
            controller.state.value.install is AndroidUpdateInstallState.Failed && !file.exists()
        }
        val state = controller.state.value.install as AndroidUpdateInstallState.Failed
        assertTrue(state.message.contains("different key"))
        assertTrue(installer.installed.isEmpty())
        assertFalse(file.exists())
    }

    @Test
    fun `without the install permission the controller asks for it instead of downloading`() =
        runTest(UnconfinedTestDispatcher()) {
            val prefs = FakePrefs()
            val downloader = FakeDownloader(File.createTempFile("ompweb-update", ".apk"))
            val installer = FakeInstaller(canInstallPackages = false)
            val controller = controller(
                backgroundScope,
                prefs,
                FakeSource(candidate()),
                downloader = downloader,
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
            )
            controller.check()

            controller.install()

            assertEquals(AndroidUpdateInstallState.NeedsPermission, controller.state.value.install)
            assertEquals(0, downloader.calls)
            assertEquals(0, installer.opens)
        }

    @Test
    fun `returning from the install permission settings continues the install`() =
        runTest(UnconfinedTestDispatcher()) {
            val prefs = FakePrefs()
            val file = File.createTempFile("ompweb-update", ".apk").apply { deleteOnExit() }
            val downloader = FakeDownloader(file)
            val installer = FakeInstaller(canInstallPackages = false)
            val controller = controller(
                backgroundScope,
                prefs,
                FakeSource(candidate()),
                downloader = downloader,
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
            )
            controller.check()

            controller.install()
            assertEquals(AndroidUpdateInstallState.NeedsPermission, controller.state.value.install)
            assertEquals(0, downloader.calls)
            assertEquals(0, installer.opens)

            installer.canInstallPackages = true
            controller.resumeInstallAfterPermission()

            awaitInstall(controller) { installer.installed.isNotEmpty() }
            assertEquals(1, downloader.calls)
            assertEquals(listOf(file), installer.installed)
        }

    @Test
    fun `resuming without a pending permission does nothing`() =
        runTest(UnconfinedTestDispatcher()) {
            val downloader = FakeDownloader(File.createTempFile("ompweb-update", ".apk"))
            val installer = FakeInstaller()
            val controller = controller(
                backgroundScope,
                FakePrefs(),
                FakeSource(candidate()),
                downloader = downloader,
                inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
                installer = installer,
            )

            controller.resumeInstallAfterPermission()

            assertEquals(AndroidUpdateInstallState.Idle, controller.state.value.install)
            assertEquals(0, downloader.calls)
            assertTrue(installer.installed.isEmpty())
        }

    @Test
    fun `a source whose release has no APK cannot be installed`() = runTest(UnconfinedTestDispatcher()) {
        val prefs = FakePrefs()
        val downloader = FakeDownloader(File.createTempFile("ompweb-update", ".apk"))
        val controller = controller(
            backgroundScope,
            prefs,
            FakeSource(candidate(withApk = false)),
            downloader = downloader,
            inspector = FakeInspector(installedIdentity = { identity(versionCode = 10000) }, downloadedIdentity = { identity() }),
            installer = FakeInstaller(),
        )
        controller.check()

        controller.install()

        val state = controller.state.value.install as AndroidUpdateInstallState.Failed
        assertTrue(state.message.contains("no APK"))
        assertEquals(0, downloader.calls)
    }

    /**
     * The install coroutine finishes the SHA-256 on Dispatchers.IO, so the
     * launch alone is not a barrier. Poll the observed outcome instead of
     * sleeping a fixed time.
     */
    private fun awaitInstall(
        controller: AndroidUpdateController,
        condition: () -> Boolean,
    ) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < deadline) {
            Thread.sleep(5)
        }
        assertTrue("the install did not reach the expected state", condition())
    }

    private class FakePrefs(
        initial: AndroidUpdatePreferencesSnapshot = AndroidUpdatePreferencesSnapshot(),
    ) : AndroidUpdatePreferences {
        private val flow = MutableStateFlow(initial)
        override val androidUpdatePreferences: StateFlow<AndroidUpdatePreferencesSnapshot> = flow

        val value: AndroidUpdatePreferencesSnapshot get() = flow.value

        override suspend fun setDismissedAndroidUpdate(version: String?) {
            flow.update { it.copy(dismissedVersion = version) }
        }

        override suspend fun setAndroidUpdateCache(cache: AndroidUpdateCache) {
            flow.update { it.copy(cache = cache) }
        }

        override suspend fun setAndroidUpdateFeedUrl(url: String?) {
            flow.update { it.copy(feedUrl = url) }
        }
    }

    private class FakeSource(
        private val answer: AndroidUpdateCandidate? = null,
        private val failure: Exception? = null,
    ) : AndroidUpdateSource {
        val calls = mutableListOf<String?>()

        override suspend fun latest(
            feedUrl: String?,
            installedVersionName: String,
            installedVersionCode: Long,
        ): AndroidUpdateCandidate? {
            calls += feedUrl
            failure?.let { throw it }
            return answer
        }
    }

    private class FakeDownloader(
        private val file: File,
        private val expectedSha256: String? = null,
    ) : AndroidUpdateDownloader {
        var calls = 0
        val lastProgress = mutableListOf<Pair<Long, Long>>()

        override suspend fun download(
            candidate: AndroidUpdateCandidate,
            onProgress: (received: Long, total: Long) -> Unit,
        ): AndroidUpdateDownload {
            calls++
            if (!file.exists()) file.writeText("fake apk")
            val digest = expectedSha256 ?: sha256Hex(file).orEmpty()
            onProgress(32, 64)
            lastProgress += 32L to 64L
            return AndroidUpdateDownload(file, digest, file.length())
        }
    }

    private class FakeInspector(
        private val installedIdentity: () -> AndroidApkIdentity?,
        private val downloadedIdentity: () -> AndroidApkIdentity?,
    ) : AndroidApkInspector {
        override fun installed(): AndroidApkIdentity? = installedIdentity.invoke()

        override fun inspect(file: File): AndroidApkIdentity? = downloadedIdentity.invoke()
    }

    private class FakeInstaller(
        override var canInstallPackages: Boolean = true,
    ) : AndroidApkInstaller {
        val installed = mutableListOf<File>()
        val status = MutableSharedFlow<AndroidInstallSessionStatus>(extraBufferCapacity = 8)
        override val sessionStatus: Flow<AndroidInstallSessionStatus> = status
        var opens = 0
        var confirmationOpens = 0
        var confirmationAvailable = true

        /** The `PackageInstaller` session id the fake reports for an attempt. */
        var sessionId = 7

        /** The id reported for every attempt, in order. */
        val reportedSessions = mutableListOf<Int>()

        override fun openInstallPermissionSettings() {
            opens++
        }

        override fun openPendingConfirmation(): Boolean {
            confirmationOpens++
            return confirmationAvailable
        }

        override suspend fun install(apk: File, onSession: (Int) -> Unit) {
            installed += apk
            reportedSessions += sessionId
            // The real installer reports the id before the commit, so every
            // status of this session can be matched against it.
            onSession(sessionId)
        }
    }
}
