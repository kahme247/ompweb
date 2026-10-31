package io.github.kahme247.ompweb.ui.chat

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Whether speech synthesis is usable and which reply is being read. */
data class SpeechState(
    val speakingId: String? = null,
)

/** One installed platform TTS voice, as the settings picker shows it. */
data class SpeechVoiceOption(
    val name: String,
    val locale: String,
)

/**
 * Read-aloud as the chat view model sees it, so the view model runs in JVM
 * tests without a TTS engine.
 */
interface Speech {
    val state: StateFlow<SpeechState>

    fun prepare()

    fun setVoice(name: String?)

    fun speak(id: String, text: String)

    fun toggle(id: String, text: String)

    fun stop()

    fun shutdown()
}

/**
 * Read-aloud for assistant replies (web `useSpeechSynthesis` +
 * `lib/speech-sanitizer.ts`).
 *
 * The engine starts lazily: the first read-aloud request binds the platform
 * TTS service, so a process that never speaks never pays for it. Speaking a
 * second reply stops the first; closing the screen stops playback.
 */
class SpeechController(context: Context) : Speech {

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val _state = MutableStateFlow(SpeechState())
    override val state: StateFlow<SpeechState> = _state.asStateFlow()

    private val _voices = MutableStateFlow<List<SpeechVoiceOption>>(emptyList())
    /** Installed platform voices; empty until [refreshVoices] bound the engine. */
    val voices: StateFlow<List<SpeechVoiceOption>> = _voices.asStateFlow()

    private var engine: TextToSpeech? = null
    private var initializing = false
    private var pending: Pair<String, String>? = null
    private var voiceName: String? = null
    private var utteranceCounter = 0

    /** Bind the TTS service ahead of the first click so failures hide the buttons. */
    override fun prepare() {
        ensureEngine()
    }

    override fun setVoice(name: String?) {
        voiceName = name
        if (name != null) ensureEngine()
        applyVoice()
    }

    override fun speak(id: String, text: String) {
        val spoken = sanitizeForSpeech(text)
        if (spoken.isBlank()) return
        val tts = ensureEngine()
        if (tts == null) {
            pending = id to spoken
            return
        }
        applyVoice()
        emit { it.copy(speakingId = id) }
        utteranceCounter += 1
        // QUEUE_FLUSH: a new reply replaces the previous one.
        val result = tts.speak(spoken, TextToSpeech.QUEUE_FLUSH, null, "omp-$id-$utteranceCounter")
        if (result == TextToSpeech.ERROR) {
            emit { it.copy(speakingId = null) }
        }
    }

    override fun toggle(id: String, text: String) {
        if (_state.value.speakingId == id) stop() else speak(id, text)
    }

    override fun stop() {
        engine?.stop()
        pending = null
        emit { it.copy(speakingId = null) }
    }

    override fun shutdown() {
        pending = null
        engine?.stop()
        engine?.shutdown()
        engine = null
        initializing = false
        emit { SpeechState() }
    }

    private fun ensureEngine(): TextToSpeech? {
        engine?.let { return it }
        if (initializing) return null
        initializing = true
        val created = TextToSpeech(appContext) { status ->
            main.post {
                initializing = false
                if (status != TextToSpeech.SUCCESS) {
                    engine = null
                    emit { SpeechState() }
                    pending = null
                    return@post
                }
                applyVoice()
                publishVoices()
                pending?.let { (id, text) ->
                    pending = null
                    speak(id, text)
                }
            }
        }
        engine = created
        created.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit

                override fun onDone(utteranceId: String?) {
                    main.post { emit { it.copy(speakingId = null) } }
                }

                @Deprecated("Platform callback; onError(String, Int) is the modern one")
                override fun onError(utteranceId: String?) {
                    main.post { emit { it.copy(speakingId = null) } }
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    main.post { emit { it.copy(speakingId = null) } }
                }
            },
        )
        return created
    }

    private fun applyVoice() {
        val tts = engine ?: return
        val installed = tts.voices.orEmpty()
        val chosen = resolveSpeechVoice(
            installed.map { SpeechVoiceOption(it.name, it.locale.toLanguageTag()) },
            voiceName,
        )
        if (chosen != null) {
            tts.voice = installed.firstOrNull { it.name == chosen.name }
            return
        }
        tts.language = Locale.getDefault()
    }

    /**
     * Binds the engine (if needed) and publishes the installed voices for the
     * settings picker. Safe to call from every open of the General tab.
     */
    fun refreshVoices() {
        if (ensureEngine() != null) publishVoices()
    }

    private fun publishVoices() {
        val tts = engine ?: return
        val installed = tts.voices.orEmpty()
            .map { SpeechVoiceOption(it.name, it.locale.toLanguageTag()) }
            .sortedWith(compareBy({ it.locale }, { it.name }))
        if (_voices.value != installed) _voices.value = installed
    }

    private fun emit(transform: (SpeechState) -> SpeechState) {
        _state.value = transform(_state.value)
    }
}

/**
 * The installed voice a stored preference names, or `null` for the engine's
 * default language. Voice names are device-specific, so a remembered name that
 * is no longer installed falls back instead of silencing every reply.
 */
fun resolveSpeechVoice(installed: List<SpeechVoiceOption>, requested: String?): SpeechVoiceOption? =
    requested?.let { name -> installed.firstOrNull { it.name == name } }

/**
 * Strips markdown, code fences, links and bare URLs before synthesis — the
 * port of `sanitizeTextForSpeech` (same order, same rules).
 */
fun sanitizeForSpeech(text: String): String {
    var cleaned = text
    cleaned = cleaned.replace(Regex("```[\\s\\S]*?```"), " ")
    cleaned = cleaned.replace(Regex("`([^`]+)`"), "$1")
    cleaned = cleaned.replace(Regex("!\\[([^\\]]*)\\]\\([^)]*\\)"), "")
    cleaned = cleaned.replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1")
    cleaned = cleaned.replace(Regex("https?://\\S+"), "")
    cleaned = cleaned.replace(Regex("</?[A-Za-z][^<>]*>"), "")
    cleaned = cleaned.replace(Regex("^#{1,6}\\s+", RegexOption.MULTILINE), "")
    cleaned = cleaned.replace(Regex("^>\\s+", RegexOption.MULTILINE), "")
    cleaned = cleaned.replace(Regex("[*_]{1,3}([^*_]+)[*_]{1,3}"), "$1")
    cleaned = cleaned.replace(Regex("~~([^~]+)~~"), "$1")
    cleaned = cleaned.replace(Regex("^[\\s]*[-*+]\\s+", RegexOption.MULTILINE), "")
    cleaned = cleaned.replace(Regex("^[\\s]*\\d+\\.\\s+", RegexOption.MULTILINE), "")
    cleaned = cleaned.replace(Regex("^[-*_]{3,}\\s*$", RegexOption.MULTILINE), "")
    return cleaned.replace(Regex("\\s+"), " ").trim()
}
