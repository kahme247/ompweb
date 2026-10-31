package io.github.kahme247.ompweb.notify

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Build
import android.os.VibrationEffect
import android.os.VibrationAttributes
import android.os.Vibrator
import android.os.VibratorManager
import io.github.kahme247.ompweb.domain.NotifyType
import io.github.kahme247.ompweb.domain.vibrationPattern

/**
 * The pulse for a notice the app shows itself (foreground toast, or the
 * in-app fallback when Android refused the system notification). System
 * notifications vibrate through their channel on their own; only these
 * in-app deliveries need a manual waveform.
 */
fun interface InAppHaptics {
    /** Pulses [type]'s waveform; null/no pattern stays silent. Never called for sends. */
    fun pulse(type: NotifyType?)
}

/**
 * Whether an in-app event may vibrate: the user's "Vibrate" setting, a real
 * vibrator, and the system's silent/Do-Not-Disturb state. The AudioAttributes
 * of the actual vibration additionally let the platform apply its own policy,
 * so this is the first, cheap gate rather than the only one.
 */
fun inAppVibrationAllowed(
    enabled: Boolean,
    hasVibrator: Boolean,
    ringerSilent: Boolean,
    dndActive: Boolean,
): Boolean = enabled && hasVibrator && !ringerSilent && !dndActive

/** Vibration in the app's own notice, with the per-event waveform. */
class AndroidHaptics(
    private val context: Context,
    /** The current `NotifyPrefs.vibrate`; read on every pulse, not once. */
    private val enabled: () -> Boolean,
) : InAppHaptics {

    override fun pulse(type: NotifyType?) {
        val pattern = type?.vibrationPattern() ?: return
        val vibrator = vibrator(context) ?: return
        val audio = context.getSystemService(AudioManager::class.java)
        val policy = context.getSystemService(NotificationManager::class.java)
        val filter = runCatching { policy?.currentInterruptionFilter }.getOrNull()
        if (
            !inAppVibrationAllowed(
                enabled = enabled(),
                hasVibrator = vibrator.hasVibrator(),
                ringerSilent = audio?.ringerMode == AudioManager.RINGER_MODE_SILENT,
                // UNKNOWN/ALL/PRIORITY do not block outright; NONE (total silence)
                // and ALARMS do.
                dndActive = filter == NotificationManager.INTERRUPTION_FILTER_NONE ||
                    filter == NotificationManager.INTERRUPTION_FILTER_ALARMS,
            )
        ) {
            return
        }
        val effect = VibrationEffect.createWaveform(pattern, -1)
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                vibrator.vibrate(
                    effect,
                    VibrationAttributes.createForUsage(VibrationAttributes.USAGE_NOTIFICATION),
                )
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(
                    effect,
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
            }
        }
    }

    private fun vibrator(context: Context): Vibrator? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        }
}
