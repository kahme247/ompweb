package io.github.kahme247.ompweb.domain

import io.github.kahme247.ompweb.net.AppUpdateInfo
import io.github.kahme247.ompweb.net.OmpUpdateInfo

/** Which of the two server-managed updates a notice is about. */
enum class UpdateKind {
    /** omp-web itself (`/api/app-update`, `NpmUpdateStatus`). */
    APP,

    /** The installed `omp` binary (`/api/omp-update`). */
    OMP,
}

/**
 * The web's update announcement (`AppShell.tsx`: a toast whose id carries the
 * version) as a banner state: one pending update, the version it dismisses by,
 * and the version that was just installed.
 *
 * Both flags come from the web's localStorage keys: `omp-web:dismissed-*` and
 * `omp-web:completed-app-update`.
 */
data class UpdateNoticeState(
    val kind: UpdateKind,
    val currentVersion: String?,
    val availableVersion: String,
    /** The version this kind was dismissed for; a newer version shows again. */
    val dismissedVersion: String? = null,
    /** `omp-web:completed-app-update`: that install finished, so it is no news. */
    val completedVersion: String? = null,
) {
    /** A dismissed or just-installed version stays hidden; anything newer shows. */
    val visible: Boolean
        get() = dismissedVersion != availableVersion && completedVersion != availableVersion
}

/**
 * How long a successful start/resume notice check is reused. Both routes
 * memoize their answer for an hour (`lib/npm-update.ts: CHECK_TTL_MS`,
 * `lib/omp/updates.ts: OMP_UPDATE_CHECK_TTL_MS`: the first runs `npm view`, the
 * second `omp update --check`, each at most once per TTL), so asking more often
 * than that cannot find newer news. The window matches the server's TTL.
 */
const val UPDATE_NOTICE_CHECK_INTERVAL_MILLIS: Long = 60L * 60L * 1000L

/**
 * How long after a check that reached *no* endpoint the next attempt waits.
 * A failed check published nothing, so the hour would only keep a release
 * hidden: an offline start, a VPN that is not up yet or `omp update --check`
 * timing out buys a short backoff instead of the whole window. Long enough
 * that repeated foreground returns do not hammer both routes.
 */
const val UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS: Long = 2L * 60L * 1000L

/**
 * Whether the shell should ask for update notices now. [lastSuccessAtMillis]
 * is when a check last got an answer; the interval only counts from there, so
 * a failed check never consumes the window. [lastFailureAtMillis] is when a
 * check last ran without any answer and opens the short
 * [UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS] retry delay. Clock values in the
 * future (a clock that ran backwards) read as "not due", so a time change
 * cannot trigger a burst either.
 */
fun isUpdateNoticeCheckDue(
    lastSuccessAtMillis: Long?,
    lastFailureAtMillis: Long?,
    nowMillis: Long,
): Boolean {
    if (lastFailureAtMillis != null &&
        nowMillis - lastFailureAtMillis < UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS
    ) {
        return false
    }
    if (lastSuccessAtMillis == null) return true
    return nowMillis - lastSuccessAtMillis >= UPDATE_NOTICE_CHECK_INTERVAL_MILLIS
}

/**
 * Picks the one notice the shell announces. A visible omp-web update wins over
 * an omp update: it is the app the user is looking at, and installing it
 * restarts the server the other update runs on. A dismissed (or already
 * installed) version stays hidden and does not swallow the other update — the
 * web shows its two toasts independently. The caller re-checks on every start
 * and resume, so re-showing a dismissed version would nag.
 */
fun selectUpdateNotice(
    app: AppUpdateInfo?,
    omp: OmpUpdateInfo?,
    dismissedAppVersion: String?,
    dismissedOmpVersion: String?,
    completedAppVersion: String?,
): UpdateNoticeState? {
    val appNotice = appNotice(app, dismissedAppVersion, completedAppVersion)
    // A dismissed (or just installed) app version is no news, but it must not
    // swallow a pending omp update: the web shows both toasts independently.
    if (appNotice != null && appNotice.visible) return appNotice
    return ompNotice(omp, dismissedOmpVersion)
}

private fun appNotice(
    app: AppUpdateInfo?,
    dismissedAppVersion: String?,
    completedAppVersion: String?,
): UpdateNoticeState? {
    if (app == null || !app.updateAvailable || app.updatesDisabled) return null
    val version = app.availableVersion ?: return null
    return UpdateNoticeState(
        kind = UpdateKind.APP,
        currentVersion = app.currentVersion,
        availableVersion = version,
        dismissedVersion = dismissedAppVersion,
        completedVersion = completedAppVersion,
    )
}

private fun ompNotice(omp: OmpUpdateInfo?, dismissedOmpVersion: String?): UpdateNoticeState? {
    if (omp == null || !omp.updateAvailable || omp.updatesDisabled) return null
    val version = omp.availableVersion ?: return null
    return UpdateNoticeState(
        kind = UpdateKind.OMP,
        currentVersion = omp.currentVersion,
        availableVersion = version,
        dismissedVersion = dismissedOmpVersion,
    )
}

/** Server-side self-update stage (`SelfUpdateStatus.stage`). */
enum class UpdatePhase {
    IDLE,
    PREPARING,
    RESTARTING,
    INSTALLING,
    FINALIZING,
    COMPLETED,
    FAILED,
}

/**
 * Maps a `SelfUpdateStatus` to the phase the card shows. A status without a
 * stage already passed preparation (web: `status.stage ?? "stopping"`).
 */
fun updatePhaseFor(stage: String?): UpdatePhase = when (stage) {
    "preparing" -> UpdatePhase.PREPARING
    "stopping" -> UpdatePhase.RESTARTING
    "installing" -> UpdatePhase.INSTALLING
    "restarting", "finalizing" -> UpdatePhase.FINALIZING
    else -> UpdatePhase.RESTARTING
}

/** The attempt reached its terminal state; `state` is `succeeded`/`failed`. */
fun isTerminalUpdateState(state: String?): Boolean = state == "succeeded" || state == "failed"
