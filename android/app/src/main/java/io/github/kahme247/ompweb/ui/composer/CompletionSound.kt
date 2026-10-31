package io.github.kahme247.ompweb.ui.composer

import android.media.AudioManager
import android.media.ToneGenerator

/**
 * The terminal-agent-end tone (web `hooks/useAudio.ts`): one short beep on the
 * notification stream, played only when `omp-sound-enabled` is on.
 *
 * A plain function type keeps the view model JVM-testable; the Android
 * implementation below is created once per app container.
 */
fun interface CompletionSound {
    fun play()
}

/** The tone is short and fire-and-forget; a device without one stays silent. */
class AndroidCompletionSound : CompletionSound {

    private val tone = try {
        ToneGenerator(AudioManager.STREAM_NOTIFICATION, VOLUME_PERCENT)
    } catch (_: RuntimeException) {
        null
    }

    override fun play() {
        try {
            tone?.startTone(ToneGenerator.TONE_PROP_BEEP, TONE_MILLIS)
        } catch (_: RuntimeException) {
            // Audio focus or a released stream: silence is the correct fallback.
        }
    }

    private companion object {
        const val VOLUME_PERCENT = 70
        const val TONE_MILLIS = 140
    }
}
