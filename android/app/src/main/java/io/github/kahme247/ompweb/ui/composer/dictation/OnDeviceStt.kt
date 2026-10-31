package io.github.kahme247.ompweb.ui.composer.dictation

/** Why on-device recognition ended without an error message from the server. */
enum class OnDeviceSttError {
    /** No recognizer installed (no Google app on this phone). */
    NoRecognizer,

    /** `RECORD_AUDIO` is missing. */
    Permission,

    /** The recognizer needs a network connection (a cloud recognizer without data). */
    Offline,

    /** The recognizer does not support the picked language (on-device models are per language). */
    LanguageUnavailable,

    /** Another app is using the microphone/recognizer. */
    Busy,

    /** Silence at the start: nothing was said. */
    NoSpeech,

    /** Anything else (client/server/audio failure). */
    Failed,
}

/**
 * The platform speech recognizer behind on-device dictation, as an interface so
 * the view-model logic runs in JVM tests. [Listener] callbacks arrive on the
 * main thread, in order; the implementation destroys its recognizer after the
 * final transcript or an error, so a new [start] always builds a fresh one.
 */
interface OnDeviceStt {

    /**
     * This phone has an installed on-device recognition model
     * (`SpeechRecognizer.isOnDeviceRecognitionAvailable`, API 31+). A cloud
     * recognizer does not count: "on this phone" must never upload audio.
     */
    fun isOnDeviceAvailable(): Boolean

    /**
     * Starts listening on the on-device recognizer in [languageTag] (BCP-47,
     * e.g. `de-DE`). Reports [Listener.onPartial] while the user talks and
     * exactly one of [Listener.onFinal] / [Listener.onError] afterwards; with
     * [isOnDeviceAvailable] false it reports [OnDeviceSttError.NoRecognizer]
     * instead of falling back to a network recognizer.
     */
    fun start(languageTag: String, listener: Listener)

    /** End the utterance and wait for the final transcript. */
    fun stop()

    /** Abort without a transcript and destroy the recognizer. */
    fun cancel()

    /** Destroys the recognizer if one is still alive (idempotent). */
    fun release()

    interface Listener {
        fun onPartial(text: String)

        fun onFinal(text: String)

        fun onError(error: OnDeviceSttError)
    }
}
