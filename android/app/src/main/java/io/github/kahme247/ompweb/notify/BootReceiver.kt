package io.github.kahme247.ompweb.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.github.kahme247.ompweb.OmpWebApplication
import kotlinx.coroutines.Job

/**
 * Brings the notification service back after a reboot and after the app is
 * updated. The service is only started when notifications are enabled and a
 * server/session is still configured; `NotificationCenter` re-checks both.
 *
 * `goAsync()` keeps the process alive until the stored settings are read and
 * the service start has been issued; Android gives a manifest receiver about
 * ten seconds for that.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (
            intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        val application = context.applicationContext as? OmpWebApplication ?: return
        val pending = goAsync()
        val job: Job = application.container.notifications.onBoot()
        job.invokeOnCompletion { pending.finish() }
    }
}
