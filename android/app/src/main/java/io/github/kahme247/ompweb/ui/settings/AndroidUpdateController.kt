package io.github.kahme247.ompweb.ui.settings

import io.github.kahme247.ompweb.data.AndroidUpdatePreferences
import io.github.kahme247.ompweb.domain.AndroidInstallDecision
import io.github.kahme247.ompweb.domain.AndroidUpdateCache
import io.github.kahme247.ompweb.domain.AndroidUpdateCandidate
import io.github.kahme247.ompweb.domain.AndroidUpdateFeedUrlResult
import io.github.kahme247.ompweb.domain.AndroidUpdateNotice
import io.github.kahme247.ompweb.domain.ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS
import io.github.kahme247.ompweb.domain.ANDROID_UPDATE_GITHUB_SOURCE
import io.github.kahme247.ompweb.domain.androidUpdateNotice
import io.github.kahme247.ompweb.domain.canInstall
import io.github.kahme247.ompweb.domain.decideAndroidUpdateInstall
import io.github.kahme247.ompweb.domain.isAndroidUpdateCacheFresh
import io.github.kahme247.ompweb.domain.isAndroidUpdateCandidateNewer
import io.github.kahme247.ompweb.domain.normalizeInstalledVersion
import io.github.kahme247.ompweb.domain.parseAndroidUpdateFeedUrl
import io.github.kahme247.ompweb.domain.sha256Hex
import io.github.kahme247.ompweb.net.AndroidUpdateDownloader
import io.github.kahme247.ompweb.net.AndroidUpdateSource
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the install button is doing; one state at a time. */
sealed interface AndroidUpdateInstallState {
    data object Idle : AndroidUpdateInstallState

    data class Downloading(val received: Long, val total: Long) : AndroidUpdateInstallState

    data object Verifying : AndroidUpdateInstallState

    data object Installing : AndroidUpdateInstallState

    /** Android's own confirmation dialog is up (or was refused and can be reopened). */
    data object AwaitingConfirmation : AndroidUpdateInstallState

    /** Android's "install unknown apps" permission is missing; the UI offers the settings link. */
    data object NeedsPermission : AndroidUpdateInstallState

    /** [message] is the clear reason nothing was installed. */
    data class Failed(val message: String) : AndroidUpdateInstallState
}

/**
 * Everything the shell banner and Settings → System & Updates show about the
 * installed app's own update.
 *
 * [latest] is the newest update from the last successful check (also while
 * that check is older than six hours, so an offline start still reports a
 * known update); [failed] is set when the source could not be reached.
 * [notice] is the dismissible banner state — null when the app is current or
 * the version was dismissed. [feedUrl] is the selected source: null means
 * GitHub Releases, otherwise the custom feed.
 */
data class AndroidUpdateState(
    val currentVersion: String,
    val currentVersionCode: Long = 0,
    val checking: Boolean = false,
    val latest: AndroidUpdateCandidate? = null,
    val dismissedVersion: String? = null,
    val checkedAtMillis: Long? = null,
    val failed: Boolean = false,
    val feedUrl: String? = null,
    val install: AndroidUpdateInstallState = AndroidUpdateInstallState.Idle,
) {
    val notice: AndroidUpdateNotice?
        get() = androidUpdateNotice(latest, currentVersion, currentVersionCode, dismissedVersion)
}

/**
 * The app's own update check and install: a check
 * on start, on every return to the foreground and on demand, a six-hour cache
 * per source, and no polling.
 *
 * Two rules shorten that cache. A cache written for another installed build
 * (an app update happened since) is ignored — the new build is checked once,
 * even when the old answer is minutes old. And a return to the foreground
 * revalidates the source once the answer is older than
 * [ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS] (30 minutes), because the app
 * process lives for days and a six-hour window would keep a published release
 * unseen for most of them. Cold start and the Settings button keep the
 * six-hour rule and `force = true` respectively.
 *
 * Failures stay quiet — the banner is a hint, not an error surface — and the
 * cached answer is kept, so being offline never turns into a false "up to
 * date" (nothing is written on failure).
 *
 * The source (GitHub or a custom feed), the downloader, the installer and the
 * session-status flow are the seams; [settings] is the JVM-testable
 * persistence seam. A downloaded APK is deleted after the install completes or
 * fails.
 */
class AndroidUpdateController(
    private val source: AndroidUpdateSource,
    private val settings: AndroidUpdatePreferences,
    private val scope: CoroutineScope,
    currentVersion: String,
    private val installedPackageName: String,
    private val currentVersionCode: Long = 0,
    private val downloader: AndroidUpdateDownloader? = null,
    private val inspector: AndroidApkInspector? = null,
    private val installer: AndroidApkInstaller? = null,
    private val installStatus: Flow<AndroidInstallSessionStatus> = AndroidUpdateInstallBridge.events,
    private val now: () -> Long = { System.currentTimeMillis() },
) {

    private val installedVersion = normalizeInstalledVersion(currentVersion)

    private val _state = MutableStateFlow(
        AndroidUpdateState(
            currentVersion = installedVersion,
            currentVersionCode = currentVersionCode,
        ),
    )
    val state: StateFlow<AndroidUpdateState> = _state.asStateFlow()

    private var installJob: Job? = null
    private var checkJob: Job? = null
    private var seeded = false

    /**
     * The `PackageInstaller` session this attempt opened, reported by the
     * installer before the commit. `PackageInstaller` answers by session id,
     * so this is what keeps a late answer of an earlier session (a dialog that
     * was never answered before a process death) from deciding this attempt.
     */
    @Volatile
    private var installSessionId: Int? = null

    init {
        // Seed the banner from the persisted cache before (and without) a
        // network round trip; the snapshot also delivers the selected source,
        // the dismissed version and a source switch.
        scope.launch {
            settings.androidUpdatePreferences.collect { stored ->
                val sourceKey = stored.feedUrl ?: ANDROID_UPDATE_GITHUB_SOURCE
                val cache = stored.cache?.takeIf {
                    it.sourceKey == sourceKey && it.installedVersionCode == currentVersionCode
                }
                val previous = _state.value
                val sourceChanged = seeded && previous.feedUrl != stored.feedUrl
                _state.update { current ->
                    current.copy(
                        feedUrl = stored.feedUrl,
                        dismissedVersion = stored.dismissedVersion,
                        latest = when {
                            sourceChanged -> null
                            current.checkedAtMillis == null ->
                                cache?.candidate?.takeIf(::isNewerThanInstalled)
                            else -> current.latest
                        },
                        checkedAtMillis = when {
                            sourceChanged -> null
                            current.checkedAtMillis == null -> cache?.checkedAtMillis
                            else -> current.checkedAtMillis
                        },
                        install = if (sourceChanged) AndroidUpdateInstallState.Idle else current.install,
                    )
                }
                if (sourceChanged) {
                    // The previous answer is about another source; its
                    // in-flight request must not keep this one from running.
                    restartCheck()
                }
                seeded = true
            }
        }
        // commit() only hands the APK to Android; the session itself answers
        // later, and that answer decides the visible state.
        scope.launch {
            installStatus.collect(::onInstallStatus)
        }
    }

    /**
     * Checks the selected source. A fresh cache is reused unless [force] (the
     * card's button); a failure keeps the previous answer and only marks
     * [state].
     */
    fun check(force: Boolean = false) {
        if (_state.value.checking) return
        startCheck(force)
    }

    /**
     * Check for a return to the foreground. Unlike [check] this bypasses the
     * six-hour cache once [AndroidUpdateState.checkedAtMillis] is older than
     * [ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS]; inside that window the answer
     * is reused so switching apps does not hit the network each time.
     */
    fun checkOnForeground() {
        if (_state.value.checking) return
        val checkedAt = _state.value.checkedAtMillis
        val recentlyChecked = checkedAt != null &&
            now() - checkedAt in 0 until ANDROID_UPDATE_FOREGROUND_CACHE_MILLIS
        startCheck(force = !recentlyChecked)
    }

    /** Runs one check and replaces any request that is still running. */
    private fun restartCheck() {
        checkJob?.cancel()
        checkJob = null
        _state.update { it.copy(checking = false) }
        startCheck(force = true)
    }

    private fun startCheck(force: Boolean) {
        val feedUrl = _state.value.feedUrl
        val sourceKey = feedUrl ?: ANDROID_UPDATE_GITHUB_SOURCE
        val cache = settings.androidUpdatePreferences.value.cache
            ?.takeIf { it.sourceKey == sourceKey && it.installedVersionCode == currentVersionCode }
        if (!force && cache != null && isAndroidUpdateCacheFresh(cache, now())) {
            applyCache(cache)
            return
        }
        _state.update { it.copy(checking = true, failed = false) }
        checkJob = scope.launch {
            runCatching { source.latest(feedUrl, installedVersion, currentVersionCode) }
                .onSuccess { candidate ->
                    // The user may have switched the source while the request
                    // was in flight; that answer is not about this source.
                    if ((_state.value.feedUrl ?: ANDROID_UPDATE_GITHUB_SOURCE) != sourceKey) return@onSuccess
                    val valid = candidate?.takeIf(::isNewerThanInstalled)
                    val cache = AndroidUpdateCache(
                        checkedAtMillis = now(),
                        sourceKey = sourceKey,
                        candidate = valid,
                        installedVersionCode = currentVersionCode,
                    )
                    // Persist first: a process death right after the answer
                    // must not make the app ask again on the next start.
                    // A failed write must not lose the answer or crash the app.
                    runCatching { settings.setAndroidUpdateCache(cache) }
                    applyCache(cache)
                }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    _state.update { it.copy(checking = false, failed = true) }
                }
        }
    }

    /** Hides the banner for exactly the version it announced; a newer one shows again. */
    fun dismiss(version: String? = _state.value.latest?.versionName) {
        val target = version ?: return
        _state.update { it.copy(dismissedVersion = target) }
        scope.launch { runCatching { settings.setDismissedAndroidUpdate(target) } }
    }

    /**
     * Selects the update source and drops every answer from the previous one.
     * `null` selects GitHub Releases. Returns an error message for an address
     * that fails the URL policy, otherwise null.
     */
    fun setUpdateFeedUrl(url: String?): String? {
        val normalized = if (url == null) {
            null
        } else {
            when (val parsed = parseAndroidUpdateFeedUrl(url)) {
                is AndroidUpdateFeedUrlResult.Valid -> parsed.url
                is AndroidUpdateFeedUrlResult.Invalid -> return parsed.message
            }
        }
        if (normalized == _state.value.feedUrl) return null
        _state.update {
            it.copy(
                feedUrl = normalized,
                latest = null,
                checkedAtMillis = null,
                failed = false,
                install = AndroidUpdateInstallState.Idle,
            )
        }
        scope.launch { runCatching { settings.setAndroidUpdateFeedUrl(normalized) } }
        restartCheck()
        return null
    }

    /** Opens Android's "install unknown apps" page for this app. */
    fun openInstallPermissionSettings() {
        installer?.openInstallPermissionSettings()
    }

    /**
     * Continues an install that stopped at [AndroidUpdateInstallState.NeedsPermission],
     * called when the screen resumes — typically when the user comes back from
     * Android's "install unknown apps" page. Does nothing in any other state;
     * if the permission is still missing, the state stays the same.
     */
    fun resumeInstallAfterPermission() {
        if (_state.value.install == AndroidUpdateInstallState.NeedsPermission) install()
    }

    /** Cancels a running download or verification and deletes its partial file. */
    fun cancelInstall() {
        installJob?.cancel()
        installJob = null
        installSessionId = null
        _state.update { it.copy(install = AndroidUpdateInstallState.Idle) }
    }

    /**
     * Reopens Android's confirmation for a session that waits for the user,
     * typically after a refused activity start left nobody with a dialog.
     * Without a stored confirmation the install is reported as failed, so the
     * updater never stays in a state without an action.
     */
    fun confirmInstall() {
        if (_state.value.install != AndroidUpdateInstallState.AwaitingConfirmation) return
        val pendingInstaller = installer
        if (pendingInstaller?.openPendingConfirmation() == true) return
        _state.update {
            it.copy(
                install = AndroidUpdateInstallState.Failed(
                    "Android's install confirmation is gone. Install the update again.",
                ),
            )
        }
    }

    /**
     * Maps one session answer onto the visible state. Answers are ignored
     * unless an install is running, and only the session this attempt opened
     * may decide it: `PackageInstaller` answers every session by id, and a
     * session left over from an earlier process (its confirmation was never
     * answered, the process was killed) delivers a terminal status into the
     * new process too. Without the id filter that old `FAILURE_ABORTED` failed
     * the new attempt and its later `SUCCESS` was ignored.
     */
    private fun onInstallStatus(status: AndroidInstallSessionStatus) {
        val current = _state.value.install
        val awaiting = current == AndroidUpdateInstallState.Installing ||
            current == AndroidUpdateInstallState.AwaitingConfirmation
        if (!awaiting) return
        // Before the installer reports its id nothing of this attempt has been
        // committed, so an answer now belongs to an earlier process.
        if (status.sessionId != installSessionId) return
        when (status) {
            is AndroidInstallSessionStatus.ConfirmationNeeded -> {
                if (current == AndroidUpdateInstallState.Installing) {
                    _state.update { it.copy(install = AndroidUpdateInstallState.AwaitingConfirmation) }
                }
            }

            is AndroidInstallSessionStatus.Installed -> {
                _state.update { it.copy(install = AndroidUpdateInstallState.Idle) }
            }

            is AndroidInstallSessionStatus.Failed -> {
                _state.update { it.copy(install = AndroidUpdateInstallState.Failed(status.message)) }
            }
        }
    }

    /**
     * Downloads, verifies and installs the announced update. Every refusal is
     * a [AndroidUpdateInstallState.Failed] with the reason; the downloaded
     * file is deleted in any case.
     */
    fun install() {
        val candidate = _state.value.latest ?: return
        // Two resume hooks can fire for the same return from Android's
        // permission page (the shell's foreground observer and the settings
        // card); one running attempt owns the download and the installer.
        if (installJob?.isActive == true) return
        when (_state.value.install) {
            is AndroidUpdateInstallState.Downloading,
            AndroidUpdateInstallState.Verifying,
            AndroidUpdateInstallState.Installing,
            AndroidUpdateInstallState.AwaitingConfirmation,
            -> return
            else -> Unit
        }
        val downloader = downloader ?: return failInstall("Updates cannot be installed by this build.")
        val inspector = inspector ?: return failInstall("Updates cannot be verified by this build.")
        val installer = installer ?: return failInstall("Updates cannot be installed by this build.")
        if (!candidate.canInstall) return failInstall("This release has no APK to install.")
        if (!installer.canInstallPackages) {
            _state.update { it.copy(install = AndroidUpdateInstallState.NeedsPermission) }
            return
        }

        installSessionId = null
        installJob = scope.launch {
            var downloaded: File? = null
            try {
                _state.update {
                    it.copy(
                        install = AndroidUpdateInstallState.Downloading(0, candidate.apkSize ?: 0),
                    )
                }
                val result = downloader.download(candidate) { received, total ->
                    _state.update {
                        it.copy(install = AndroidUpdateInstallState.Downloading(received, total))
                    }
                }
                downloaded = result.file
                _state.update { it.copy(install = AndroidUpdateInstallState.Verifying) }
                val actualSha256 = withContext(Dispatchers.IO) { sha256Hex(result.file) }.orEmpty()
                val decision = decideAndroidUpdateInstall(
                    appPackageName = installedPackageName,
                    installed = inspector.installed(),
                    downloaded = inspector.inspect(result.file),
                    announcedVersionCode = candidate.versionCode,
                    expectedSha256 = result.expectedSha256,
                    actualSha256 = actualSha256,
                )
                if (decision is AndroidInstallDecision.Refuse) {
                    _state.update { it.copy(install = AndroidUpdateInstallState.Failed(decision.message)) }
                    return@launch
                }
                _state.update { it.copy(install = AndroidUpdateInstallState.Installing) }
                installer.install(result.file) { sessionId -> installSessionId = sessionId }
                // commit() only hands the APK to Android. The session's own
                // answer (confirmation, failure, success) arrives through
                // installStatus and decides what the user sees; a self-update
                // usually replaces this process before the next start.
            } catch (canceled: CancellationException) {
                _state.update { it.copy(install = AndroidUpdateInstallState.Idle) }
                throw canceled
            } catch (error: Exception) {
                _state.update {
                    it.copy(
                        install = AndroidUpdateInstallState.Failed(
                            error.message?.takeIf { it.isNotBlank() }
                                ?: "The update could not be installed.",
                        ),
                    )
                }
            } finally {
                downloaded?.delete()
                installJob = null
            }
        }
    }

    private fun failInstall(message: String) {
        _state.update { it.copy(install = AndroidUpdateInstallState.Failed(message)) }
    }

    private fun isNewerThanInstalled(candidate: AndroidUpdateCandidate): Boolean =
        isAndroidUpdateCandidateNewer(candidate, installedVersion, currentVersionCode)

    private fun applyCache(cache: AndroidUpdateCache) {
        if (cache.sourceKey != (_state.value.feedUrl ?: ANDROID_UPDATE_GITHUB_SOURCE)) return
        _state.update { current ->
            current.copy(
                checking = false,
                failed = false,
                checkedAtMillis = cache.checkedAtMillis,
                latest = cache.candidate?.takeIf(::isNewerThanInstalled),
            )
        }
    }
}
