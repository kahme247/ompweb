package io.github.kahme247.ompweb.notify

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.kahme247.ompweb.MainActivity
import io.github.kahme247.ompweb.OmpWebApplication
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.NotifyChannel
import io.github.kahme247.ompweb.events.ConnectionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The built-in delivery channel (PLAN §4): a `specialUse` foreground service
 * that keeps the process alive and holds the notification service's single
 * `/api/events` connection plus presence reports. Its persistent silent
 * notification shows the connection status and the number of running agents.
 *
 * `START_STICKY` brings the service back after the app is swiped away; the
 * boot receiver covers a reboot and app update. The service never opens a
 * second socket — `EventMux` stays shared with the UI.
 */
class NotificationService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var center: NotificationCenter
    private var statusJob: Job? = null

    override fun onCreate() {
        super.onCreate()
        // Touching the container also arms the process-wide network callback
        // that reconnects the shared stream; a service-only layout (the UI
        // swiped away) must not lose that path.
        center = (application as OmpWebApplication).container.notifications
        promoteToForeground()
        center.activateRuntime()
        statusJob = serviceScope.launch {
            combine(center.connection, center.runningCount) { state, running -> state to running }
                .collect { (state, running) -> updateStatusNotification(state, running) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // A restart (START_STICKY) arrives with a null intent; the notification
        // must already be up before this method returns.
        promoteToForeground()
        center.activateRuntime()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        statusJob?.cancel()
        statusJob = null
        center.deactivateRuntime()
        serviceScope.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun promoteToForeground() {
        val notification = buildStatusNotification(center.connection.value, center.runningCount.value)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                STATUS_NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            ServiceCompat.startForeground(this, STATUS_NOTIFICATION_ID, notification, 0)
        }
    }

    private fun updateStatusNotification(state: ConnectionState, running: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        val notification = buildStatusNotification(state, running)
        runCatching {
            NotificationManagerCompat.from(this).notify(STATUS_NOTIFICATION_ID, notification)
        }
    }

    private fun buildStatusNotification(state: ConnectionState, running: Int): Notification {
        val text = when (state) {
            ConnectionState.Connected ->
                resources.getQuantityString(R.plurals.notify_status_connected, running, running)
            ConnectionState.Reconnecting -> getString(R.string.notify_status_reconnecting)
            ConnectionState.Offline -> getString(R.string.notify_status_unreachable)
        }
        val launch = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentIntent = PendingIntent.getActivity(
            this,
            STATUS_NOTIFICATION_ID,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, NotifyChannel.ConnectionStatus.id)
            .setSmallIcon(R.drawable.ic_notify_connection)
            .setColor(ContextCompat.getColor(this, R.color.notify_accent_connection))
            .setContentTitle(getString(R.string.notify_status_title))
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val ACTION_START = "io.github.kahme247.ompweb.notify.START"
        const val ACTION_STOP = "io.github.kahme247.ompweb.notify.STOP"
        private const val STATUS_NOTIFICATION_ID = 10

        /** Called by [NotificationCenter]; a background start may be refused, which is not fatal. */
        fun start(context: Context) {
            val intent = Intent(context, NotificationService::class.java).setAction(ACTION_START)
            runCatching { ContextCompat.startForegroundService(context, intent) }
        }

        fun stop(context: Context) {
            runCatching {
                context.stopService(Intent(context, NotificationService::class.java).setAction(ACTION_STOP))
            }
        }
    }
}
