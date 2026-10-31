package io.github.kahme247.ompweb.ui.settings

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import io.github.kahme247.ompweb.domain.AndroidApkIdentity
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.withContext

/** Reads the installed app's and a downloaded file's identity through PackageManager. */
interface AndroidApkInspector {
    /** The installed app, or null when Android cannot read it. */
    fun installed(): AndroidApkIdentity?

    /** The APK in [file], or null when it is not a readable package. */
    fun inspect(file: File): AndroidApkIdentity?
}

/**
 * Verification seam of the in-app updater: the installed app and the
 * downloaded APK are read with `GET_SIGNING_CERTIFICATES`, the same source
 * Android uses to decide whether an update may replace an app.
 */
class PackageManagerAndroidApkInspector(context: Context) : AndroidApkInspector {

    private val appContext = context.applicationContext
    private val packageManager = appContext.packageManager

    override fun installed(): AndroidApkIdentity? = runCatching {
        identity(packageManager.getPackageInfo(appContext.packageName, signingFlags()))
    }.getOrNull()

    override fun inspect(file: File): AndroidApkIdentity? = runCatching {
        // getPackageArchiveInfo parses the file without installing it; the
        // signing flags make it report the APK's own signers.
        @Suppress("DEPRECATION")
        packageManager.getPackageArchiveInfo(file.absolutePath, signingFlags())?.let(::identity)
    }.getOrNull()

    private fun signingFlags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }

    private fun identity(info: PackageInfo): AndroidApkIdentity {
        val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
        val signers = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners.orEmpty()
        } else {
            @Suppress("DEPRECATION")
            info.signatures.orEmpty()
        }
        val signerSha256 = signers.mapNotNull { signature ->
            runCatching {
                MessageDigest.getInstance("SHA-256")
                    .digest(signature.toByteArray())
                    .joinToString("") { "%02x".format(it) }
            }.getOrNull()
        }.toSet()
        return AndroidApkIdentity(
            packageName = info.packageName,
            versionCode = versionCode,
            versionName = info.versionName,
            signerSha256 = signerSha256,
        )
    }
}

/** One answer of the PackageInstaller session an update install opened. */
sealed interface AndroidInstallSessionStatus {
    /**
     * The `PackageInstaller` session that answered (`EXTRA_SESSION_ID`), so
     * the updater can tell its own attempt from a session left over by an
     * earlier process.
     */
    val sessionId: Int

    /**
     * Android shows its own "update this app" dialog. The receiver starts it;
     * when that start is refused (the app has no visible window), the updater
     * offers "Confirm install" instead of pretending to install.
     */
    data class ConfirmationNeeded(override val sessionId: Int) : AndroidInstallSessionStatus

    /** The session installed the APK; the app comes back with the new version. */
    data class Installed(override val sessionId: Int) : AndroidInstallSessionStatus

    /** [message] is the system's reason, e.g. `INSTALL_FAILED_ABORTED: User rejected permissions`. */
    data class Failed(override val sessionId: Int, val message: String) : AndroidInstallSessionStatus
}

/**
 * The bridge from [AndroidUpdateInstallReceiver] into the running updater.
 *
 * PackageInstaller answers to a manifest-declared receiver, which the system
 * can create on its own; the updater cannot hand it a callback object, so the
 * status and the pending confirmation live in this process-wide object. It is
 * deliberately process-scoped: after a process death there is no install state
 * to repair, because [AndroidUpdateController] starts idle.
 */
object AndroidUpdateInstallBridge {
    private const val EVENT_BUFFER = 8

    @Volatile
    private var confirmation: Intent? = null

    private val _events = MutableSharedFlow<AndroidInstallSessionStatus>(extraBufferCapacity = EVENT_BUFFER)

    /** Status answers; the controller collects them for the lifetime of the app. */
    val events: SharedFlow<AndroidInstallSessionStatus> = _events.asSharedFlow()

    /** Publishes one answer; a status without a collector (process death) is dropped. */
    fun publish(status: AndroidInstallSessionStatus) {
        _events.tryEmit(status)
    }

    /** Keeps the system's confirmation intent so the updater can reopen it after a refused start. */
    fun remember(confirmation: Intent) {
        this.confirmation = confirmation
    }

    /** The confirmation intent once; a second tap cannot open a second dialog. */
    fun takeConfirmation(): Intent? = confirmation.also { confirmation = null }
}

/** Installs an already verified APK through a PackageInstaller session. */
interface AndroidApkInstaller {
    /** Whether this app may install packages (`REQUEST_INSTALL_PACKAGES` + the user's toggle). */
    val canInstallPackages: Boolean

    /**
     * The session's status answers. `commit()` only means "handed to
     * Android": a rejected confirmation or a failed session arrives here and
     * must not leave the updater stuck in "Installing".
     */
    val sessionStatus: Flow<AndroidInstallSessionStatus>

    /** Opens Android's "install unknown apps" page for this app. */
    fun openInstallPermissionSettings()

    /** Opens the confirmation of a session that waits for the user; false when none is pending. */
    fun openPendingConfirmation(): Boolean

    /**
     * Opens a session, copies [apk] into it and commits. Throws when the
     * session cannot be created, written or committed. Android performs the
     * replacement asynchronously; a self-update usually replaces this process.
     *
     * [onSession] receives the `PackageInstaller` session id before the commit
     * hands the session over, so the caller can filter the status answers of
     * that very session (an older session of a previous process answers to the
     * same receiver and must not decide this attempt).
     */
    suspend fun install(apk: File, onSession: (Int) -> Unit)
}

/**
 * The real installer. `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` is only
 * set from API 31 on and only for a self-update (same package, same signing
 * key), which Android allows without the extra confirmation; otherwise the
 * system shows its own confirmation via [AndroidUpdateInstallReceiver].
 */
class PackageInstallerAndroidApkInstaller(context: Context) : AndroidApkInstaller {

    private val appContext = context.applicationContext

    override val canInstallPackages: Boolean
        get() = appContext.packageManager.canRequestPackageInstalls()

    override val sessionStatus: Flow<AndroidInstallSessionStatus>
        get() = AndroidUpdateInstallBridge.events

    override fun openInstallPermissionSettings() {
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${appContext.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { appContext.startActivity(intent) }
    }

    override fun openPendingConfirmation(): Boolean {
        val confirmation = AndroidUpdateInstallBridge.takeConfirmation() ?: return false
        confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { appContext.startActivity(confirmation) }.isSuccess
    }

    override suspend fun install(apk: File, onSession: (Int) -> Unit) = withContext(Dispatchers.IO) {
        val packageInstaller = appContext.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        ).apply {
            setAppPackageName(appContext.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                runCatching {
                    setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                }
            }
        }
        val sessionId = packageInstaller.createSession(params)
        // Before the commit: every status this session publishes carries this
        // id, and the updater must already know which one is its own.
        onSession(sessionId)
        try {
            packageInstaller.openSession(sessionId).use { session ->
                session.openWrite(APK_SESSION_NAME, 0, apk.length()).use { output ->
                    apk.inputStream().use { input -> input.copyTo(output) }
                    session.fsync(output)
                }
                val result = Intent(appContext, AndroidUpdateInstallReceiver::class.java)
                // Android 14+ rejects an immutable status receiver ("The
                // commit() status receiver should come from a mutable
                // PendingIntent"); the flag exists from API 31.
                val pendingIntentFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        PendingIntent.FLAG_MUTABLE
                    } else {
                        0
                    }
                val pendingIntent = PendingIntent.getBroadcast(
                    appContext,
                    sessionId,
                    result,
                    pendingIntentFlags,
                )
                session.commit(pendingIntent.intentSender)
            }
        } catch (error: Exception) {
            runCatching { packageInstaller.abandonSession(sessionId) }
            throw error
        }
    }

    private companion object {
        const val APK_SESSION_NAME = "ompweb-update.apk"
    }
}

/**
 * Receives the PackageInstaller session status. A "confirm install" answer is
 * started (the system asks when it does not grant the silent self-update);
 * every answer also reaches the running updater, so a rejected confirmation or
 * a failed session becomes a visible reason with a retry instead of a
 * permanent "Installing the update…". Failures are logged with the system's
 * message too, because the download itself is already verified and deleted by
 * then.
 */
class AndroidUpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // Which session answered. A session of an earlier process can still
        // deliver its terminal status here; the updater filters by this id
        // instead of applying it to whatever install is running now.
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, NO_SESSION)
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirmation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                if (confirmation == null) {
                    AndroidUpdateInstallBridge.publish(
                        AndroidInstallSessionStatus.Failed(
                            sessionId,
                            "Android did not provide the install confirmation. Start the install again.",
                        ),
                    )
                    return
                }
                AndroidUpdateInstallBridge.publish(AndroidInstallSessionStatus.ConfirmationNeeded(sessionId))
                AndroidUpdateInstallBridge.remember(confirmation)
                confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                // A background app may not start this activity (Android's
                // background-activity policy); the updater then offers the
                // stashed confirmation itself, from its visible window.
                runCatching { context.startActivity(confirmation) }
                    .onFailure { Log.w(TAG, "could not show the install confirmation", it) }
            }

            PackageInstaller.STATUS_SUCCESS -> {
                Log.i(TAG, "ompweb update install status $status")
                AndroidUpdateInstallBridge.publish(AndroidInstallSessionStatus.Installed(sessionId))
            }

            PackageInstaller.STATUS_FAILURE,
            PackageInstaller.STATUS_FAILURE_ABORTED,
            PackageInstaller.STATUS_FAILURE_BLOCKED,
            PackageInstaller.STATUS_FAILURE_CONFLICT,
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
            PackageInstaller.STATUS_FAILURE_INVALID,
            PackageInstaller.STATUS_FAILURE_STORAGE,
            -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                    ?.takeIf { it.isNotBlank() }
                    ?: "Android could not install the update (status $status)."
                Log.w(TAG, "ompweb update install failed ($status): $message")
                AndroidUpdateInstallBridge.publish(AndroidInstallSessionStatus.Failed(sessionId, message))
            }

            else -> Log.i(TAG, "ompweb update install status $status")
        }
    }

    private companion object {
        const val TAG = "OmpWebUpdate"

        /** The system always names the session; `-1` only marks a broken intent. */
        const val NO_SESSION = -1
    }
}
