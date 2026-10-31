package io.github.kahme247.ompweb.ui.composer.dictation

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.os.Bundle

/**
 * [OnDeviceStt] over Android's [SpeechRecognizer].
 *
 * Only the on-device recognizer is ever built (`createOnDeviceSpeechRecognizer`,
 * API 31+); without an installed on-device model the class reports
 * [OnDeviceSttError.NoRecognizer] instead of falling back to the default
 * recognizer, which may send the audio over the network while the UI promises
 * on-device processing. The intent asks for partial results, a short silence
 * window (the utterance ends itself) and offline preference.
 *
 * `RECORD_AUDIO` is requested by the composer before dictation starts, so this
 * class never asks for permissions itself.
 */
class AndroidOnDeviceStt(context: Context) : OnDeviceStt {

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())

    private var recognizer: SpeechRecognizer? = null
    private var listener: OnDeviceStt.Listener? = null

    override fun isOnDeviceAvailable(): Boolean = runCatching {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)
    }.getOrDefault(false)

    // The composer requests RECORD_AUDIO before dictation starts; lint cannot
    // see across that call boundary.
    @SuppressLint("MissingPermission")
    override fun start(languageTag: String, listener: OnDeviceStt.Listener) {
        if (!onMainThread()) {
            main.post { start(languageTag, listener) }
            return
        }
        release()
        this.listener = listener
        if (!isOnDeviceAvailable()) {
            this.listener = null
            listener.onError(OnDeviceSttError.NoRecognizer)
            return
        }
        // The recognizer factory itself needs API 31: spell the level out so
        // lint sees the guard instead of only the `isOnDeviceAvailable` call.
        val created = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
            }.getOrNull()
        } else {
            null
        }
        if (created == null) {
            this.listener = null
            listener.onError(OnDeviceSttError.NoRecognizer)
            return
        }
        recognizer = created
        created.setRecognitionListener(RecognitionAdapter())
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, appContext.packageName)
            // End the utterance on a pause instead of listening until the tap.
            // The extras are spelled as integers: recognizer implementations
            // read them with getIntExtra (a Long silently falls back to their
            // default and would never end the take on silence).
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, MIN_SPEECH_MS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_MS)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        val started = runCatching { created.startListening(intent) }.isSuccess
        if (!started) {
            release()
            listener.onError(OnDeviceSttError.NoRecognizer)
        }
    }

    override fun stop() {
        onMain { current -> runCatching { current.stopListening() } }
    }

    override fun cancel() {
        onMain { current -> runCatching { current.cancel() } }
        release()
    }

    override fun release() {
        if (!onMainThread()) {
            main.post { release() }
            return
        }
        val current = recognizer
        recognizer = null
        listener = null
        if (current != null) {
            runCatching { current.setRecognitionListener(null) }
            runCatching { current.destroy() }
        }
    }

    private fun onMain(block: (SpeechRecognizer) -> Unit) {
        if (!onMainThread()) {
            main.post { onMain(block) }
            return
        }
        recognizer?.let(block)
    }

    private fun onMainThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()

    /** Forwards the callbacks, then destroys the recognizer exactly once. */
    private inner class RecognitionAdapter : RecognitionListener {

        override fun onPartialResults(partialResults: Bundle?) {
            val text = firstResult(partialResults) ?: return
            if (text.isBlank()) return
            listener?.onPartial(text)
        }

        override fun onResults(results: Bundle?) {
            val text = firstResult(results).orEmpty()
            val target = listener
            release()
            target?.onFinal(text)
        }

        override fun onError(error: Int) {
            val target = listener
            release()
            target?.onError(errorOf(error))
        }

        override fun onReadyForSpeech(params: Bundle?) = Unit

        override fun onBeginningOfSpeech() = Unit

        override fun onRmsChanged(rmsdB: Float) = Unit

        override fun onBufferReceived(buffer: ByteArray?) = Unit

        override fun onEndOfSpeech() = Unit

        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }

    private fun firstResult(bundle: Bundle?): String? =
        runCatching {
            bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
        }.getOrNull()

    private companion object {
        const val MIN_SPEECH_MS = 500
        const val SILENCE_MS = 1_500

        fun errorOf(error: Int): OnDeviceSttError = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
            -> OnDeviceSttError.NoSpeech
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> OnDeviceSttError.Permission
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
            -> OnDeviceSttError.Offline
            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
            SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE,
            -> OnDeviceSttError.LanguageUnavailable
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> OnDeviceSttError.Busy
            else -> OnDeviceSttError.Failed
        }
    }
}
