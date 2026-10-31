package io.github.kahme247.ompweb.notify

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.kahme247.ompweb.data.SettingsStore
import io.github.kahme247.ompweb.domain.InAppNotice
import io.github.kahme247.ompweb.domain.NoticeRoute
import io.github.kahme247.ompweb.domain.NotifyEvent
import io.github.kahme247.ompweb.domain.NotifyIdentity
import io.github.kahme247.ompweb.domain.NotifyPrefs
import io.github.kahme247.ompweb.domain.NotifyProject
import io.github.kahme247.ompweb.domain.NotifyRuntimeAction
import io.github.kahme247.ompweb.domain.NotifyType
import io.github.kahme247.ompweb.domain.NotifyWhenActive
import io.github.kahme247.ompweb.domain.PresenceReport
import io.github.kahme247.ompweb.domain.inAppNotice
import io.github.kahme247.ompweb.domain.isValidNotificationId
import io.github.kahme247.ompweb.domain.nextPresenceSeq
import io.github.kahme247.ompweb.domain.noticeRoute
import io.github.kahme247.ompweb.domain.noticeRouteAfterPost
import io.github.kahme247.ompweb.domain.notificationRuntimeAction
import io.github.kahme247.ompweb.domain.parseNotifyDismiss
import io.github.kahme247.ompweb.domain.parseNotifyEvent
import io.github.kahme247.ompweb.domain.resolvePresence
import io.github.kahme247.ompweb.domain.runningSessionCount
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.net.NotificationsApi
import io.github.kahme247.ompweb.net.TestPushResult
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** What the settings screen shows about the device's permissions. */
data class NotificationPermissionStatus(
    val appNotificationsEnabled: Boolean,
    val postNotificationsGranted: Boolean,
    val batteryUnrestricted: Boolean,
    val canRequestPostNotifications: Boolean,
)

/** Result of the settings "Send test notification" button. */
sealed interface NotificationTestOutcome {
    data object Sent : NotificationTestOutcome
    data object LocalShown : NotificationTestOutcome
    data object Blocked : NotificationTestOutcome
    data class Failed(val message: String) : NotificationTestOutcome
}

/**
 * The app-level owner of notification state: identity and registration,
 * prefs, presence, service control and frame delivery.
 *
 * The foreground service calls [activateRuntime]/[deactivateRuntime]; every
 * other lifecycle point (sign-in, sign-out, prefs change, boot) goes through
 * this class so there is exactly one place that decides whether the service
 * and its single SSE subscription should run.
 */
class NotificationCenter(
    private val context: Context,
    private val settings: SettingsStore,
    private val api: NotificationsApi,
    private val mux: EventMux,
    private val scope: CoroutineScope,
    private val isSignedIn: () -> Boolean,
    /** The answer receiver replaces a notification with its result text. */
    internal val notifier: Notifier = AndroidNotifier(
        context.applicationContext,
        origin = { settings.originNow()?.origin },
        vibrate = { settings.snapshot.value.notifyPrefs.vibrate },
    ),
    /** The pulse for in-app notices; system notifications vibrate via their channel. */
    private val haptics: InAppHaptics = AndroidHaptics(
        context.applicationContext,
        enabled = { settings.snapshot.value.notifyPrefs.vibrate },
    ),
) {

    val connection: StateFlow<ConnectionState> = mux.state

    private val _runningCount = MutableStateFlow(0)
    val runningCount: StateFlow<Int> = _runningCount.asStateFlow()

    private val _runtimeActive = MutableStateFlow(false)
    val runtimeActive: StateFlow<Boolean> = _runtimeActive.asStateFlow()

    private val _registrationError = MutableStateFlow<String?>(null)
    val registrationError: StateFlow<String?> = _registrationError.asStateFlow()

    private val _permissionRequests = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val permissionRequests: SharedFlow<Unit> = _permissionRequests.asSharedFlow()

    /** Bumped after a permission answer or a return from system settings. */
    private val _permissionRevision = MutableStateFlow(0)
    val permissionRevision: StateFlow<Int> = _permissionRevision.asStateFlow()

    fun refreshPermissions() {
        _permissionRevision.value += 1
    }

    /** A notification delivered live; B's history view model adds it without refetching. */
    @Volatile
    var onDelivered: ((JsonObject) -> Unit)? = null

    private val _notices = MutableStateFlow<List<InAppNotice>>(emptyList())

    /**
     * In-app deliveries (web toast): `whenActive:"toast"` output and every
     * system post the app was not allowed to make. The shell renders them and
     * a tap opens the session and marks its history entry read.
     */
    val notices: StateFlow<List<InAppNotice>> = _notices.asStateFlow()

    /** The user closed one notice; a newer notice of the same tag stays. */
    fun dismissNotice(notice: InAppNotice) {
        _notices.update { current ->
            current.filterNot { it.id == notice.id && it.requestId == notice.requestId }
        }
    }

    private val activationMutex = Mutex()
    private val syncMutex = Mutex()
    private val teardown = NotificationTeardown()

    /**
     * Guards start/stop races: a service that is stopped and immediately
     * restarted must not leave an activation job running after its
     * deactivation (or the new service would have no subscription).
     */
    private var runtimeEpoch = 0

    private var notificationJob: Job? = null
    private var runningJob: Job? = null
    private var presenceJob: Job? = null

    private val presenceLock = Any()
    private var presenceSeq = 0L
    private var appForeground = false
    private var visibleSession: String? = null

    init {
        notifier.ensureChannels()
        scope.launch {
            settings.snapshot
                .map { snapshot -> Triple(snapshot.loaded, snapshot.origin, snapshot.notifyPrefs) }
                .distinctUntilChanged()
                .collect { (loaded, origin, prefs) ->
                    when (val action = notificationRuntimeAction(loaded, origin != null, prefs.enabled, isSignedIn())) {
                        NotifyRuntimeAction.Idle -> Unit
                        NotifyRuntimeAction.Start -> {
                            NotificationService.start(context)
                            syncDevice()
                        }
                        is NotifyRuntimeAction.Stop -> {
                            NotificationService.stop(context)
                            // "Notifications off" must reach the server too,
                            // otherwise it keeps routing this device's events.
                            if (action.syncDevice) syncDevice()
                        }
                    }
                }
        }
    }

    // ------------------------------------------------------------ lifecycle

    /** Signed in (or passwordless server ready): register and keep the service running. */
    fun onSignedIn() {
        scope.launch {
            settings.ensureNotifyIdentity()
            syncDevice()
            refreshService()
        }
    }

    /**
     * `clearLocalUserData()`: stop the service, close this app's
     * notifications, unregister the device while the old cookie and origin
     * still exist, then forget the identity.
     *
     * Suspends until the unregister finished (bounded by
     * [NotificationTeardown.DEFAULT_TIMEOUT_MILLIS]): the caller may only
     * clear the cookie and change the origin afterwards, or the PUT would be
     * unauthorized or go to the next installation.
     */
    suspend fun clearDevice() {
        val snapshot = settings.snapshot.value
        val identity = snapshot.identityOrNull()
        val origin = snapshot.origin
        NotificationService.stop(context)
        notifier.cancelAll()
        _notices.value = emptyList()
        teardown.run(
            unregister = {
                if (identity != null && origin != null) {
                    // Same lock as syncDeviceNow: an in-flight prefs PUT must
                    // not land after this one and re-enable the device.
                    syncMutex.withLock {
                        api.putDevice(identity.deviceId, snapshot.notifyPrefs.copy(enabled = false), origin)
                    }
                }
            },
            forgetIdentity = { settings.clearNotifyIdentity() },
        )
    }

    /** Boot or app update: restart the service only when it should be running. */
    fun onBoot(): Job = scope.launch {
        val snapshot = settings.awaitLoaded()
        if (snapshot.origin == null || !snapshot.notifyPrefs.enabled || !isSignedIn()) return@launch
        settings.ensureNotifyIdentity()
        syncDevice()
        NotificationService.start(context)
    }

    /** Start or stop the service according to prefs, sign-in and origin. */
    fun refreshService() {
        val snapshot = settings.snapshot.value
        if (!snapshot.loaded || snapshot.origin == null || !snapshot.notifyPrefs.enabled || !isSignedIn()) {
            NotificationService.stop(context)
        } else {
            NotificationService.start(context)
        }
    }

    // ------------------------------------------------------------ service runtime

    /** Called once by [NotificationService]; the service holds this subscription. */
    fun activateRuntime() {
        if (_runtimeActive.value) return
        val epoch = ++runtimeEpoch
        scope.launch {
            activationMutex.withLock {
                if (epoch != runtimeEpoch || _runtimeActive.value) return@withLock
                // A restarted service runs before the first DataStore
                // emission; judging prefs from an empty snapshot would stop a
                // service that should keep running.
                val snapshot = settings.awaitLoaded()
                if (epoch != runtimeEpoch) return@withLock
                if (!snapshot.notifyPrefs.enabled || !isSignedIn() || snapshot.origin == null) {
                    NotificationService.stop(context)
                    return@withLock
                }
                val identity = settings.ensureNotifyIdentity()
                if (epoch != runtimeEpoch) return@withLock
                _runtimeActive.value = true
                // The service owns the one process-wide SSE connection now.
                mux.setPersistent(true)
                notificationJob = scope.launch {
                    try {
                        mux.subscribe(EventChannel.Notifications(identity.clientId)).collect { frame ->
                            deliverFrame(frame)
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // EventMux reconnects; a refused channel only ends this flow.
                    }
                }
                runningJob = scope.launch {
                    try {
                        mux.subscribe(EventChannel.Running).collect { frame ->
                            runningSessionCount(frame)?.let { _runningCount.value = it }
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // Status only; the list screen has its own subscription.
                    }
                }
                presenceJob = scope.launch {
                    while (isActive) {
                        reportPresence()
                        delay(PRESENCE_INTERVAL_MILLIS)
                    }
                }
                reportPresence()
            }
        }
    }

    /** Called from `NotificationService.onDestroy`. */
    fun deactivateRuntime() {
        runtimeEpoch++
        if (!_runtimeActive.value) return
        _runtimeActive.value = false
        notificationJob?.cancel()
        runningJob?.cancel()
        presenceJob?.cancel()
        notificationJob = null
        runningJob = null
        presenceJob = null
        // Report the window state one last time: this is not a "gone" report,
        // it carries whatever the app is showing (a `visible: true` report for
        // the chat still on screen included), so the server keeps a fresh view
        // of this device instead of a report that may be one interval old and
        // lets that entry expire by its own TTL.
        reportPresence(force = true)
        mux.setPersistent(false)
    }

    // ------------------------------------------------------------ presence

    fun setAppForeground(foreground: Boolean) {
        val changed = synchronized(presenceLock) {
            val before = appForeground
            appForeground = foreground
            before != foreground
        }
        if (foreground) {
            // A tapped notification auto-cancels without a dismiss callback;
            // only the next foreground visit can repair the group's count/title.
            // Run this first: closing the visible chat's notifications rebuilds
            // the affected summaries from its own snapshot, and that rebuild
            // must be the last word on the group.
            notifier.refreshGroupSummaries()
            // Returning to a chat the user is looking at: its notifications
            // belong to the transcript now, not the shade.
            synchronized(presenceLock) { visibleSession }?.let(::clearSessionArtifacts)
        }
        if (changed) reportPresence()
    }

    /** The chat currently on screen, or null on any other view. */
    fun setVisibleSession(sessionId: String?) {
        val normalized = sessionId?.takeIf { it.isNotBlank() }
        val changed = synchronized(presenceLock) {
            val before = visibleSession
            visibleSession = normalized
            before != normalized
        }
        if (!changed) return
        // Opening a chat closes what was already posted for it (web: the
        // notification is read where the conversation is). A chat selected
        // while the app is in the background keeps its notification until the
        // user actually returns to it.
        if (normalized != null && isAppForeground()) clearSessionArtifacts(normalized)
        reportPresence()
    }

    /**
     * The app is "looking at" a session only in the foreground with exactly
     * that chat's pane on screen (phone and two-pane). The server suppresses
     * such events through the presence report; the local check covers the
     * window between a state change and that report reaching it.
     */
    private fun isSessionOnScreen(sessionId: String): Boolean =
        synchronized(presenceLock) { appForeground && visibleSession == sessionId }

    /** Drops the shade notifications and in-app notices of one session. */
    private fun clearSessionArtifacts(sessionId: String) {
        notifier.cancelSession(sessionId)
        _notices.update { current -> current.filterNot { it.sessionId == sessionId } }
    }

    private fun reportPresence(force: Boolean = false) {
        if (!force && !_runtimeActive.value) return
        val report = presenceReport() ?: return
        scope.launch { api.reportPresence(report) }
    }

    /**
     * The report for the current window state, or null before an identity
     * exists. [PresenceReport.seq] only grows, so the server never drops a
     * newer visibility change because reports overtook each other.
     */
    internal fun presenceReport(): PresenceReport? {
        val identity = settings.snapshot.value.identityOrNull() ?: return null
        val visibility = synchronized(presenceLock) {
            resolvePresence(appForeground, visibleSession)
        }
        val seq = synchronized(presenceLock) {
            presenceSeq = nextPresenceSeq(presenceSeq, System.currentTimeMillis())
            presenceSeq
        }
        return PresenceReport(
            clientId = identity.clientId,
            deviceId = identity.deviceId,
            visible = visibility.visible,
            sessionId = visibility.sessionId,
            seq = seq,
        )
    }

    // ------------------------------------------------------------ prefs

    fun setEnabled(enabled: Boolean) = updatePrefs { it.copy(enabled = enabled) }

    fun setTypeEnabled(type: NotifyType, enabled: Boolean) = updatePrefs { it.withType(type, enabled) }

    fun setWhenActive(whenActive: NotifyWhenActive) = updatePrefs { it.copy(whenActive = whenActive) }

    fun setVibrate(enabled: Boolean) = updatePrefs { it.copy(vibrate = enabled) }

    private fun updatePrefs(transform: (NotifyPrefs) -> NotifyPrefs) {
        scope.launch {
            val current = settings.snapshot.value.notifyPrefs
            val next = transform(current)
            if (next == current) return@launch
            // The snapshot collector restarts/stops the service and registers
            // the new prefs; doing it here too would double the PUT.
            settings.setNotifyPrefs(next)
        }
    }

    // ------------------------------------------------------------ registration

    /** Sends the current prefs to the server; serialized and reads prefs when sent. */
    fun syncDevice() {
        scope.launch { syncDeviceNow() }
    }

    suspend fun syncDeviceNow() {
        if (!isSignedIn() || settings.snapshot.value.origin == null) return
        syncMutex.withLock {
            var sent: NotifyPrefs? = null
            while (true) {
                val snapshot = settings.snapshot.value
                if (snapshot.origin == null || !isSignedIn()) return@withLock
                val prefs = snapshot.notifyPrefs
                if (prefs == sent) return@withLock
                sent = prefs
                val identity = settings.ensureNotifyIdentity()
                val result = runCatching { api.putDevice(identity.deviceId, prefs) }
                _registrationError.value = result.exceptionOrNull()?.userMessage()
                if (prefs == settings.snapshot.value.notifyPrefs) return@withLock
            }
        }
    }

    // ------------------------------------------------------------ permissions

    fun permissionStatus(): NotificationPermissionStatus {
        val appEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val power = context.getSystemService(PowerManager::class.java)
        return NotificationPermissionStatus(
            appNotificationsEnabled = appEnabled,
            postNotificationsGranted = granted,
            batteryUnrestricted = power?.isIgnoringBatteryOptimizations(context.packageName) ?: true,
            canRequestPostNotifications = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !granted,
        )
    }

    /** The settings screen's fix button: the activity-level launcher collects this. */
    fun requestPostNotificationPermission() {
        _permissionRequests.tryEmit(Unit)
    }

    /** Opens the system dialog explaining and requesting the battery exemption. */
    fun requestBatteryExemption() {
        val intent = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(fallback) }
        }
    }

    fun openSystemNotificationSettings() {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }
    }

    // ------------------------------------------------------------ test

    /**
     * `POST /api/notifications/test` for a subscribed device. Native devices
     * have no Web Push subscription, so the normal path is a local
     * notification through the same renderer; a 502 shows the push service's
     * answer instead.
     */
    suspend fun sendTest(): NotificationTestOutcome {
        if (!isSignedIn() || settings.snapshot.value.origin == null) {
            return NotificationTestOutcome.Failed("Not signed in")
        }
        val identity = settings.ensureNotifyIdentity()
        syncDeviceNow()
        val subscribed = captureApi { api.isSubscribed(identity.deviceId) }.getOrDefault(false)
        if (!subscribed) {
            return if (notifier.postTest()) {
                NotificationTestOutcome.LocalShown
            } else {
                NotificationTestOutcome.Blocked
            }
        }
        return try {
            when (val result = api.sendTest(identity.deviceId)) {
                TestPushResult.Sent -> NotificationTestOutcome.Sent
                is TestPushResult.Failed -> NotificationTestOutcome.Failed(result.message)
            }
        } catch (error: Exception) {
            NotificationTestOutcome.Failed(error.userMessage())
        }
    }

    // ------------------------------------------------------------ delivery

    /**
     * One frame of the notifications channel. One malformed or unexpected
     * frame must never end the subscription: the collect loop keeps running
     * and the next frame is still handled.
     *
     * Suspending on purpose: a notification may have to resolve its session's
     * project before it is posted, and frames must keep their order (a dismiss
     * for the same tag may follow immediately).
     */
    internal suspend fun deliverFrame(frame: JsonObject) {
        try {
            onNotificationFrame(frame)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Dropped frame; the channel stays subscribed.
        }
    }

    private suspend fun onNotificationFrame(frame: JsonObject) {
        when (frame["type"]?.jsonPrimitive?.contentOrNull) {
            "notification" -> {
                val kind = frame["kind"]?.jsonPrimitive?.contentOrNull
                val eventJson = frame["event"] as? JsonObject ?: return
                val event = parseNotifyEvent(eventJson) ?: return
                onDelivered?.invoke(eventJson)
                // The server already keeps this device quiet while its presence
                // says the chat is on screen; a report can still be in flight
                // when the frame arrives. Enforce the rule locally as well:
                // nothing is posted, shown or vibrated for the chat being read.
                if (isSessionOnScreen(event.sessionId)) {
                    clearSessionArtifacts(event.sessionId)
                    return
                }
                // `whenActive:"toast"` stays in the app; a system post the app
                // may not make (permission withdrawn, channel blocked) falls
                // back to the same in-app notice instead of disappearing.
                val route = noticeRoute(kind)
                val posted = route == NoticeRoute.System &&
                    notifier.post(event, projectFor(event.sessionId))
                if (noticeRouteAfterPost(route, posted) == NoticeRoute.InApp) {
                    showNotice(event)
                    // A notice the user sees in the app replaces the system
                    // notification, including its channel vibration.
                    if (isAppForeground()) haptics.pulse(event.type)
                }
            }
            "notification-dismiss" -> {
                parseNotifyDismiss(frame)?.let { dismiss ->
                    notifier.cancelIfMatches(dismiss.tag, dismiss.requestId)
                    // Only the notice standing for this request is retracted; a
                    // buffered dismiss must not close the next dialog's notice.
                    _notices.update { current ->
                        current.filterNot { it.matches(dismiss.tag, dismiss.requestId) }
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ grouping

    private val projectCache = mutableMapOf<String, NotifyProject?>()
    private var projectsFetchedAt = 0L

    /** Project lock; notification frames are serial, but lookups are also used by tests. */
    private val projectMutex = Mutex()

    /**
     * The project a session's notifications are grouped under. The wire event
     * carries no cwd, so the session list answers it (`projectKey`/`projectRoot`/
     * `cwd`). A lookup is cached for [PROJECT_CACHE_TTL]; when the server does
     * not list the session (deleted, an old alias) the notification stays
     * ungrouped instead of landing in a wrong group.
     */
    private suspend fun projectFor(sessionId: String): NotifyProject? = projectMutex.withLock {
        val now = System.currentTimeMillis()
        if (projectCache.containsKey(sessionId) && now - projectsFetchedAt < PROJECT_CACHE_TTL) {
            return@withLock projectCache[sessionId]
        }
        if (!projectCache.containsKey(sessionId) && now - projectsFetchedAt < PROJECT_LOOKUP_THROTTLE) {
            return@withLock null
        }
        val fetched = runCatching { api.sessionProjects() }.getOrDefault(emptyMap())
        projectsFetchedAt = now
        projectCache.putAll(fetched)
        if (!projectCache.containsKey(sessionId)) projectCache[sessionId] = null
        projectCache[sessionId]
    }

    private fun isAppForeground(): Boolean = synchronized(presenceLock) { appForeground }

    /** Adds [event] as the newest in-app notice, replacing its tag's older one. */
    private fun showNotice(event: NotifyEvent) {
        val notice = inAppNotice(event)
        _notices.update { current -> notice.addTo(current, MAX_IN_APP_NOTICES) }
    }

    private fun io.github.kahme247.ompweb.data.SettingsSnapshot.identityOrNull(): NotifyIdentity? {
        val device = notifyDeviceId?.takeIf(::isValidNotificationId) ?: return null
        val client = notifyClientId?.takeIf(::isValidNotificationId) ?: return null
        return NotifyIdentity(device, client)
    }

    companion object {
        /** The server's presence TTL is 60 s; report at half of it. */
        const val PRESENCE_INTERVAL_MILLIS = 30_000L

        /**
         * At most this many notices stay on screen; a new one pushes the
         * oldest out instead of growing the overlay without bound.
         */
        const val MAX_IN_APP_NOTICES = 3

        /** How long a resolved session project is trusted before a refresh. */
        const val PROJECT_CACHE_TTL = 5 * 60_000L

        /**
         * A session the list does not know is retried at most this often, so
         * an unknown id cannot turn every event into a list request.
         */
        const val PROJECT_LOOKUP_THROTTLE = 30_000L
    }
}
