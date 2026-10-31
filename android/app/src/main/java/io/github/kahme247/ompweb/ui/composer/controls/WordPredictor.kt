package io.github.kahme247.ompweb.ui.composer.controls

import android.content.Context
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.view.InputDevice
import io.github.kahme247.ompweb.data.ChatSettings
import io.github.kahme247.ompweb.domain.GhostAdvance
import io.github.kahme247.ompweb.domain.GhostInsertion
import io.github.kahme247.ompweb.domain.WORD_PREDICTION_DEBOUNCE_MS
import io.github.kahme247.ompweb.domain.WORD_PREDICTION_MAX_DRAFT_LENGTH
import io.github.kahme247.ompweb.domain.WORD_PREDICTION_UNSUPPORTED_RETRY_MS
import io.github.kahme247.ompweb.domain.WordCompletionMode
import io.github.kahme247.ompweb.domain.WordGhost
import io.github.kahme247.ompweb.domain.acceptGhost
import io.github.kahme247.ompweb.domain.advanceGhost
import io.github.kahme247.ompweb.domain.atLineEnd
import io.github.kahme247.ompweb.domain.isUnsupportedPredictionError
import io.github.kahme247.ompweb.domain.wordCompletionActive
import io.github.kahme247.ompweb.net.ComposerControlsApi
import io.github.kahme247.ompweb.net.parsePredictedSuffix
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Which input devices the composer sees. The web's `auto` mode goes by
 * `(pointer: fine)`; on Android the equivalent is a hardware keyboard
 * (`Configuration.keyboard != KEYBOARD_NOKEYS`) or a connected mouse.
 */
data class WordInputCapabilities(
    val hardwareKeyboard: Boolean = false,
    val finePointer: Boolean = false,
)

/** Reads the current device capabilities; cheap enough to call per keystroke. */
fun wordInputCapabilities(context: Context): WordInputCapabilities {
    val app = context.applicationContext
    val hardwareKeyboard =
        app.resources.configuration.keyboard != Configuration.KEYBOARD_NOKEYS
    val inputManager = app.getSystemService(Context.INPUT_SERVICE) as? InputManager
    val finePointer = inputManager?.inputDeviceIds?.any { id ->
        val device = inputManager.getInputDevice(id) ?: return@any false
        device.sources and InputDevice.SOURCE_MOUSE == InputDevice.SOURCE_MOUSE
    } == true
    return WordInputCapabilities(hardwareKeyboard, finePointer)
}

/**
 * Composer word prediction: one `predict_word` per settled keystroke burst,
 * ghost text only while the caret ends its line, accept/typed-past outcomes
 * reported back as `predict_word_feedback`.
 *
 * Port of `hooks/useWordPrediction.ts`. Predictions never spawn an omp child
 * (the route answers `{suffix: null}` without a live process) and a brand-new
 * chat sends none at all — there is no session id yet. An omp without
 * `predict_word` pauses the engine for a minute instead of asking on every key.
 */
class WordPredictor(
    private val api: ComposerControlsApi,
    private val settings: ChatSettings,
    private val scope: CoroutineScope,
    /** Read per keystroke; [wordInputCapabilities] supplies the Android answer. */
    private val capabilities: () -> WordInputCapabilities = { WordInputCapabilities() },
    private val clock: () -> Long = { System.currentTimeMillis() },
) {

    private val _ghost = MutableStateFlow<WordGhost?>(null)

    /** The ghost for the latest draft state (text, caret and suffix), or null. */
    val ghost: StateFlow<WordGhost?> = _ghost.asStateFlow()

    private var sessionId: String? = null
    private var lastText: String? = null
    private var lastCaret: Int = -1
    private var job: Job? = null

    /** Monotonic token; every draft change invalidates in-flight predictions. */
    private var seq = 0
    private var unsupportedUntil = 0L

    /**
     * Feed every draft/caret change. `caret` is the selection start; a ghost
     * predicted for another text/caret is carried (typing that matches it) or
     * dropped, exactly like `advanceGhost`.
     */
    fun onTextChanged(sessionId: String?, text: String, caret: Int) {
        if (sessionId != this.sessionId) {
            this.sessionId = sessionId
            setGhost(null)
            lastText = null
            lastCaret = -1
        }
        val at = caret.coerceIn(0, text.length)
        // `onValueChange` and a selection callback can report the same keystroke twice.
        if (lastText == text && lastCaret == at) return
        lastText = text
        lastCaret = at
        val token = cancelScheduled()

        var carried: WordGhost? = null
        _ghost.value?.let { current ->
            val advanced: GhostAdvance = advanceGhost(current, text, at)
            if (advanced.typedPast) report(current, accepted = false)
            carried = advanced.ghost
        }

        val sid = sessionId
        val mode = WordCompletionMode.fromWire(settings.snapshot.value.wordCompletion)
        val caps = capabilities()
        if (sid == null ||
            !wordCompletionActive(mode, caps.hardwareKeyboard, caps.finePointer) ||
            !atLineEnd(text, at)
        ) {
            setGhost(null)
            return
        }
        setGhost(carried)
        if (text.length > WORD_PREDICTION_MAX_DRAFT_LENGTH) return
        if (clock() < unsupportedUntil) return
        job = scope.launch {
            delay(WORD_PREDICTION_DEBOUNCE_MS)
            if (token != seq) return@launch
            try {
                val answer = api.agentCommand(
                    sid,
                    buildJsonObject {
                        put("type", "predict_word")
                        put("text", text)
                        put("cursor", at)
                    },
                    advisor = false,
                )
                val predicted = parsePredictedSuffix(answer)
                // A null answer while typing through a shown ghost keeps that ghost.
                if (token == seq && predicted != null) {
                    setGhost(WordGhost(text, at, predicted))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (isUnsupportedPredictionError(e.message)) {
                    unsupportedUntil = clock() + WORD_PREDICTION_UNSUPPORTED_RETRY_MS
                }
            }
        }
    }

    /**
     * Take the ghost for insertion (reporting the accept), or null when none is
     * showing or it belongs to another draft state. Use the returned
     * [GhostInsertion] to replace the draft: its `text`/`caret` are the whole
     * field after the insertion, so a stale field cannot splice twice.
     */
    fun accept(text: String, caret: Int): GhostInsertion? {
        val current = _ghost.value ?: return null
        if (current.text != text || current.caret != caret) return null
        cancelScheduled()
        setGhost(null)
        report(current, accepted = true)
        return acceptGhost(current)
    }

    private fun cancelScheduled(): Int {
        seq += 1
        job?.cancel()
        job = null
        return seq
    }

    private fun setGhost(next: WordGhost?) {
        _ghost.value = next
    }

    private fun report(current: WordGhost, accepted: Boolean) {
        val sid = sessionId ?: return
        scope.launch {
            try {
                api.agentCommand(
                    sid,
                    buildJsonObject {
                        put("type", "predict_word_feedback")
                        put("text", current.text)
                        put("cursor", current.caret)
                        put("suggestion", current.suffix)
                        put("accepted", accepted)
                    },
                    advisor = false,
                )
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Feedback is best effort: a lost sample never disturbs typing.
            }
        }
    }
}
