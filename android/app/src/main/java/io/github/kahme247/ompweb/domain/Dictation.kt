package io.github.kahme247.ompweb.domain

import java.io.File
import java.util.Locale

/** Where a dictation capture is transcribed: this phone or the configured server. */
enum class DictationEngine(val wire: String) {
    SERVER("server"),
    ON_DEVICE("on_device"),
}

/** The user's "Dictation engine" choice (`auto` prefers the server). */
enum class DictationEnginePreference(val wire: String) {
    /** Server STT when the app is connected to one, otherwise this phone. */
    AUTO("auto"),
    ON_DEVICE("on_device"),
    SERVER("server"),
    ;

    companion object {
        fun fromWire(value: String?): DictationEnginePreference =
            entries.firstOrNull { it.wire == value } ?: AUTO
    }
}

/**
 * Resolves the preference against the installation. "Configured server" means
 * the app has a server origin; [serverSttUnconfigured] is the server's own 501
 * answer to an earlier upload ("STT not configured"), which makes Auto use the
 * phone from then on instead of failing the same way every time. The STT
 * provider itself is server-side configuration this client cannot see.
 *
 * [onDeviceAvailable] is the phone's installed on-device speech model (not a
 * cloud recognizer). Auto uses the phone only while a model is installed; with
 * a server it stays on the server path, and with neither it fails with the
 * no-model error. An explicit [DictationEnginePreference.ON_DEVICE] is kept and
 * fails the same way instead of silently uploading audio.
 */
fun resolveDictationEngine(
    preference: DictationEnginePreference,
    serverConfigured: Boolean,
    serverSttUnconfigured: Boolean = false,
    onDeviceAvailable: Boolean = true,
): DictationEngine = when (preference) {
    DictationEnginePreference.SERVER -> DictationEngine.SERVER
    DictationEnginePreference.ON_DEVICE -> DictationEngine.ON_DEVICE
    DictationEnginePreference.AUTO -> when {
        serverConfigured && !serverSttUnconfigured -> DictationEngine.SERVER
        onDeviceAvailable -> DictationEngine.ON_DEVICE
        // No local model: the server is the only engine left (it reports its
        // own failure); without a server the on-device start reports the
        // missing model instead of reaching for a cloud recognizer.
        serverConfigured -> DictationEngine.SERVER
        else -> DictationEngine.ON_DEVICE
    }
}

/** Languages offered in Settings → Dictation language (BCP-47 tags). */
val DICTATION_LANGUAGE_TAGS: List<String> = listOf(
    "en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "it-IT", "pt-BR", "nl-NL",
    "pl-PL", "ru-RU", "tr-TR", "uk-UA", "cs-CZ", "sv-SE", "da-DK", "nb-NO",
    "fi-FI", "el-GR", "hu-HU", "ro-RO", "hi-IN", "id-ID", "ja-JP", "ko-KR",
    "zh-CN", "zh-TW", "th-TH", "vi-VN",
)

private val LANGUAGE_TAG = Regex("^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Z]{2}|[0-9]{3}))?$")

/**
 * The recognition language: the picked tag when it is a well-formed BCP-47
 * language tag, otherwise the device locale. A blank country stays
 * language-only (`de`), never `de-`.
 */
fun dictationLanguageTag(preferred: String?, device: Locale): String {
    val candidate = preferred?.trim()?.takeIf { it.isNotEmpty() && LANGUAGE_TAG.matches(it) }
    if (candidate != null) return candidate
    val language = device.language.ifBlank { "en" }
    return if (device.country.isBlank()) language else "$language-${device.country.uppercase(Locale.ROOT)}"
}

/** Display name of a language tag in the user's locale ("German (Germany)"). */
fun dictationLanguageLabel(tag: String, display: Locale = Locale.getDefault()): String {
    val name = Locale.forLanguageTag(tag).getDisplayName(display)
    return name.ifBlank { tag }
}

/** The offered tags with the device language first when the list lacks it. */
fun offeredDictationLanguages(
    device: Locale,
    offered: List<String> = DICTATION_LANGUAGE_TAGS,
): List<String> {
    val deviceTag = dictationLanguageTag(null, device)
    return if (offered.any { it.equals(deviceTag, ignoreCase = true) }) offered else listOf(deviceTag) + offered
}

/**
 * The live on-device transcript as edits on the composer field.
 *
 * The first partial anchors at the caret, later partials replace the visible
 * live text instead of appending to it, and the final transcript replaces the
 * partial. The field stays editable while listening: when the user changed it
 * under the live text, the buffer keeps what is visible and continues at the
 * new caret. Pure and anchored on text/caret reads, so the composer owns the
 * actual field.
 */
class LiveDictationBuffer {

    private var base: String? = null
    private var anchor = 0
    private var live = ""
    /** The text this buffer produced last, to notice a user edit. */
    private var applied: String? = null

    val active: Boolean get() = base != null

    /** The live text as last accepted (already trimmed). */
    val text: String get() = live

    /** A new partial from the recognizer; null when the field is unchanged. */
    fun onPartial(current: String, caret: Int, partial: String): TextInsertion? {
        val next = partial.trim()
        if (base == null) {
            base = current
            anchor = caret.coerceIn(0, current.length)
            live = ""
        } else if (current != applied) {
            // The user edited the field while listening: the visible text is
            // theirs, so it becomes the new base and the caret the new anchor.
            base = current
            anchor = caret.coerceIn(0, current.length)
            live = ""
        }
        if (next == live) return null
        live = next
        val insertion = render(base.orEmpty(), anchor, live) ?: return null
        applied = insertion.text
        return insertion
    }

    /** The final transcript; null when it is blank and nothing was shown. */
    fun onFinal(current: String, caret: Int, final: String): TextInsertion? {
        val start = base
        val text = final.trim()
        val insertion = if (start == null) {
            if (text.isEmpty()) null else render(current, caret.coerceIn(0, current.length), text)
        } else {
            if (current != applied) {
                base = current
                anchor = caret.coerceIn(0, current.length)
                live = ""
            }
            val shown = if (text.isEmpty()) live else text
            if (shown.isEmpty()) null else render(base.orEmpty(), anchor, shown)
        }
        reset()
        return insertion
    }

    /** Removes the live text again; null when the user already changed it. */
    fun onCancel(current: String): TextInsertion? {
        val start = base
        val restored = if (start != null && current == applied) TextInsertion(start, anchor) else null
        reset()
        return restored
    }

    fun reset() {
        base = null
        anchor = 0
        live = ""
        applied = null
    }

    private fun render(base: String, anchor: Int, text: String): TextInsertion? {
        val at = anchor.coerceIn(0, base.length)
        val separator = if (text.isNotEmpty() && at > 0 && !base[at - 1].isWhitespace()) " " else ""
        val rendered = base.substring(0, at) + separator + text + base.substring(at)
        if (rendered == base && text.isEmpty()) return null
        return TextInsertion(rendered, at + separator.length + text.length)
    }
}

/**
 * What the composer does with a transcript once the server job finishes.
 * Mirrors `SttAfter` in `lib/stt.ts`: it travels with the recording, is kept
 * on the server job, and comes back with the owner's claim — so the choice
 * survives the composer being rebuilt (session switch, process death).
 */
enum class SttAfter(val wire: String?) {
    Send("send"),
    Steer("steer"),
    FollowUp("followup"),

    /** Record and insert the text into the draft; the field sends it. */
    Insert(null),
}

/** Job lifecycle as `lib/stt-jobs.ts` reports it. */
enum class SttJobStatus(val wire: String) {
    Pending("pending"),
    Done("done"),
    Error("error"),

    /** Another composer claimed or discarded the job; stand down silently. */
    Gone("gone"),
}

/** What a poll of `GET /api/stt/{jobId}` sees (never the transcript). */
data class SttJob(val id: String, val status: SttJobStatus, val error: String?)

/** What `DELETE /api/stt/{jobId}?claim=…` answers; [text] only for the claimer. */
data class SttClaim(
    val id: String,
    val status: SttJobStatus,
    val error: String?,
    val text: String?,
    val after: SttAfter?,
)

/** The recording this app keeps so a lost server job can be re-uploaded. */
data class LocalRecording(val file: File, val mimeType: String, val after: SttAfter)

/**
 * Persistence the dictation flow needs, separated from Android so the
 * ownership/claim logic stays JVM-testable.
 */
interface DictationStore {

    /**
     * This installation's job-owner token (web: `omp-web:stt-owner-token` in
     * sessionStorage). It owns the jobs this app uploads and retries, gets the
     * first claim and alone gets the send/queue choice back. A claim token is
     * per view-model instance and never equals this one.
     */
    fun ownerToken(): String

    /** A fresh file in the app cache for one recording. */
    fun scratchFile(name: String): File

    /** Keeps [file] as the local copy for [scope] (re-upload after a server restart). */
    fun keepRecording(scope: String, file: File, mimeType: String, after: SttAfter)

    /** The kept recording of [scope], if it still exists. */
    fun savedRecording(scope: String): LocalRecording?

    fun clearRecording()
}

/** Everything the composer needs to render the dictation surface. */
sealed interface DictationState {
    data object Idle : DictationState

    data class Recording(
        val elapsedMs: Long,
        val level: Float,
        val paused: Boolean,
    ) : DictationState

    /**
     * On-device recognition is listening: the composer field stays visible and
     * receives the transcript at its caret as it is spoken; the strip below it
     * offers stop/cancel. Stops on silence (the recognizer ends the utterance)
     * or tap.
     */
    data class Live(val elapsedMs: Long) : DictationState

    data class Uploading(val elapsedMs: Long) : DictationState

    data class Transcribing(val elapsedMs: Long) : DictationState

    data class Failed(val message: String, val canRetry: Boolean) : DictationState

    /** The job was claimed or discarded elsewhere; the composer stands down. */
    data object Gone : DictationState
}

/**
 * One finished transcript. [isOwner] is true when this composer uploaded (or
 * retried) the job: only then may the composer act on [after]; another
 * device's transcript is inserted as text only.
 */
data class DictationResult(val text: String, val after: SttAfter, val isOwner: Boolean)

/** What a delivered transcript does with the composer (web `onTranscript`). */
sealed interface DictationOutcome {
    val text: String

    /** Put the transcript into the field; the user sends it. */
    data class Insert(override val text: String) : DictationOutcome

    data class Send(override val text: String) : DictationOutcome

    data class Steer(override val text: String) : DictationOutcome

    data class FollowUp(override val text: String) : DictationOutcome
}

/**
 * Append a transcript to the draft with one separating space, unless the
 * draft is empty or already ends in whitespace (web `onTranscript`).
 */
fun mergeTranscript(draft: String, transcript: String): String =
    if (draft.isNotEmpty() && !draft.endsWith(" ")) "$draft $transcript" else draft + transcript

/**
 * Classifies a finished transcript like the web composer: another composer's
 * job and an explicit `Insert` only fill the field. Without a session (a new
 * chat / the new-session pane) `Send`, `Steer` and `FollowUp` all become a
 * normal send — there is no run to steer and nothing to queue behind.
 */
fun dictationOutcome(
    result: DictationResult,
    draft: String,
    hasSession: Boolean,
): DictationOutcome {
    if (!result.isOwner || result.after == SttAfter.Insert) return DictationOutcome.Insert(result.text)
    val text = mergeTranscript(draft, result.text)
    if (!hasSession) return DictationOutcome.Send(text)
    return when (result.after) {
        SttAfter.Send -> DictationOutcome.Send(text)
        SttAfter.Steer -> DictationOutcome.Steer(text)
        SttAfter.FollowUp -> DictationOutcome.FollowUp(text)
        SttAfter.Insert -> DictationOutcome.Insert(result.text)
    }
}

/** Playback of a recording (local or the server's kept copy). */
sealed interface DictationPlayback {
    data object Idle : DictationPlayback

    data object Preparing : DictationPlayback

    data class Playing(val positionMs: Long, val durationMs: Long, val paused: Boolean = false) : DictationPlayback
}

enum class DictationPhase { Idle, Recording, Uploading, Transcribing, Failed, Gone }

/** One decision of the poll/claim loop (see [DictationMachine]). */
sealed interface DictationStep {
    /** Keep waiting (poll again, or claim again). */
    data object Wait : DictationStep

    /** The job is done: send the one claim that delivers the text. */
    data object Claim : DictationStep

    data class Delivered(val text: String, val after: SttAfter, val isOwner: Boolean) : DictationStep

    data class Failed(val message: String) : DictationStep

    /** Claimed or discarded elsewhere: stop following without an error. */
    data object StandDown : DictationStep
}

/**
 * The dictation ownership/claim/retry/timeout rules of `hooks/useDictation.ts`,
 * as a pure state machine.
 *
 * It owns no I/O: the view model feeds recorder events, HTTP answers and the
 * wall clock in, and acts on the [DictationStep] it gets back. The rules it
 * keeps are the ones the server enforces (`lib/stt-jobs.ts`): a claim on an
 * unfinished job changes nothing, a finished job answers the first claim token
 * (repeatable with the same token), only the owner gets the `after` choice,
 * "gone" means another composer won, a 404 is only this browser's failure when
 * it recorded the job, and the follow loop gives up after six minutes.
 */
class DictationMachine(private val clock: () -> Long) {

    var phase: DictationPhase = DictationPhase.Idle
        private set

    var after: SttAfter = SttAfter.Insert
        private set

    var jobId: String? = null
        private set

    /** True when this composer uploaded or retried [jobId] (first claim, `after`). */
    var mine: Boolean = true
        private set

    var message: String? = null
        private set

    var canRetry: Boolean = false
        private set

    var hasLocalAudio: Boolean = false
        private set

    var paused: Boolean = false
        private set

    /** Length of the finished recording; shown while uploading/transcribing. */
    var finalElapsedMs: Long = 0L
        private set

    private var startedAt = 0L
    private var pausedAt: Long? = null
    private var pausedTotal = 0L
    private var deadline = 0L
    private var claiming = false

    /** True while the last claim answered "done" without text (owner grace). */
    val awaitingClaim: Boolean get() = claiming

    fun reset() {
        phase = DictationPhase.Idle
        after = SttAfter.Insert
        jobId = null
        mine = true
        message = null
        canRetry = false
        hasLocalAudio = false
        paused = false
        finalElapsedMs = 0L
        startedAt = 0L
        pausedAt = null
        pausedTotal = 0L
        deadline = 0L
        claiming = false
    }

    fun setLocalAudio(present: Boolean) {
        hasLocalAudio = present
        canRetry = present || jobId != null
    }

    /** A new recording replaces whatever the deck showed. */
    fun start(after: SttAfter): Boolean {
        if (phase == DictationPhase.Recording || phase == DictationPhase.Uploading || phase == DictationPhase.Transcribing) {
            return false
        }
        reset()
        this.after = after
        phase = DictationPhase.Recording
        startedAt = clock()
        return true
    }

    fun pause(): Boolean {
        if (phase != DictationPhase.Recording || paused) return false
        paused = true
        pausedAt = clock()
        return true
    }

    fun resume(): Boolean {
        if (phase != DictationPhase.Recording || !paused) return false
        pausedTotal += clock() - (pausedAt ?: clock())
        pausedAt = null
        paused = false
        return true
    }

    /** Recording time without the paused stretches, capped at the 5-minute limit. */
    fun elapsedMs(): Long {
        if (phase != DictationPhase.Recording) return finalElapsedMs
        val end = if (paused) (pausedAt ?: clock()) else clock()
        return (end - startedAt - pausedTotal).coerceIn(0L, MAX_RECORDING_MS)
    }

    /**
     * The recorder answered or was stopped: the recording now uploads.
     * [after] lets the composer's Send/Queue button decide the intent at stop
     * time (web `stopAndFinishDictation`); null keeps the intent chosen at
     * [start].
     */
    fun finishRecording(after: SttAfter? = null) {
        if (phase != DictationPhase.Recording) return
        if (after != null) this.after = after
        finalElapsedMs = elapsedMs()
        paused = false
        pausedAt = null
        phase = DictationPhase.Uploading
    }

    fun uploadAccepted(id: String) {
        phase = DictationPhase.Transcribing
        jobId = id
        mine = true
        message = null
        canRetry = false
        claiming = false
        deadline = clock() + STT_TIMEOUT_MS
    }

    /** A recording that produced no uploadable audio (nothing was said, mic denied). */
    fun fail(message: String) {
        phase = DictationPhase.Failed
        this.message = message
        claiming = false
        canRetry = hasLocalAudio || jobId != null
    }

    fun beginUploadRetry(): Boolean {
        if (!hasLocalAudio) return false
        phase = DictationPhase.Uploading
        message = null
        canRetry = false
        claiming = false
        deadline = 0L
        return true
    }

    /** Jobs of this scope a browser may pick up (nothing of its own is running). */
    fun canAdopt(): Boolean = phase == DictationPhase.Idle || phase == DictationPhase.Gone

    /**
     * Adopts the newest live job of the scope. A failed job is shown with its
     * error so this composer can play, retry or discard the server's copy.
     */
    fun adopt(jobs: List<SttJob>): Boolean {
        if (!canAdopt()) return false
        val job = jobs.firstOrNull { it.status != SttJobStatus.Gone } ?: return false
        jobId = job.id
        mine = false
        hasLocalAudio = false
        finalElapsedMs = 0L
        after = SttAfter.Insert
        claiming = false
        if (job.status == SttJobStatus.Error) {
            phase = DictationPhase.Failed
            message = job.error ?: TRANSCRIPTION_FAILED
            canRetry = true
        } else {
            phase = DictationPhase.Transcribing
            message = null
            canRetry = false
            deadline = clock() + STT_TIMEOUT_MS
        }
        return true
    }

    /** A failed job the server still holds audio for: retry it server-side. */
    fun serverRetryJobId(): String? = jobId

    fun retryAccepted(job: SttJob): DictationStep? = when (job.status) {
        SttJobStatus.Gone -> standDown()
        SttJobStatus.Error -> failStep(job.error ?: TRANSCRIPTION_FAILED)
        else -> {
            phase = DictationPhase.Transcribing
            jobId = job.id
            // `retrySttJob` makes the retrying browser the job's owner, so a
            // lost job is this composer's failure, not another's.
            mine = true
            message = null
            canRetry = false
            claiming = false
            deadline = clock() + STT_TIMEOUT_MS
            null
        }
    }

    /**
     * The server no longer has the job (restart, expiry, pruned tombstone):
     * only the local copy can be retried.
     */
    fun retryJobMissing(): DictationStep {
        jobId = null
        canRetry = hasLocalAudio
        return if (beginUploadRetry()) DictationStep.Wait else failStep(JOB_NOT_FOUND)
    }

    /** A kept recording whose upload never finished (process death): offer a re-upload. */
    fun restoreRecording(after: SttAfter, message: String) {
        reset()
        this.after = after
        hasLocalAudio = true
        fail(message)
    }

    fun retryRejected(message: String): DictationStep = failStep(message)

    /** `DELETE` without a claim: discard everywhere, including the upstream request. */
    fun discard() {
        reset()
    }

    /** Cancelled while recording. */
    fun cancelCapture() {
        reset()
    }

    /** `GET /api/stt/{jobId}` answer: `null` is a 404. */
    fun observe(job: SttJob?): DictationStep {
        if (phase != DictationPhase.Transcribing) return DictationStep.Wait
        if (expired()) return failStep(TIMED_OUT)
        return when (job?.status) {
            null -> {
                jobId = null
                if (mine) failStep(JOB_NOT_FOUND) else standDown()
            }
            SttJobStatus.Pending -> DictationStep.Wait
            SttJobStatus.Error -> failStep(job.error ?: TRANSCRIPTION_FAILED)
            SttJobStatus.Gone -> standDown()
            SttJobStatus.Done -> if (claiming) DictationStep.Wait else {
                claiming = true
                DictationStep.Claim
            }
        }
    }

    /** `DELETE ?claim=…` answer: `null` is a 404. */
    fun takeClaim(claim: SttClaim?): DictationStep {
        if (phase != DictationPhase.Transcribing) return DictationStep.Wait
        if (expired()) return failStep(TIMED_OUT)
        if (claim == null) {
            jobId = null
            return if (mine) failStep(JOB_NOT_FOUND) else standDown()
        }
        return when (claim.status) {
            SttJobStatus.Gone -> standDown()
            SttJobStatus.Error -> failStep(claim.error ?: TRANSCRIPTION_FAILED)
            SttJobStatus.Pending -> {
                // A claim on an unfinished job is a no-op; poll again.
                claiming = false
                DictationStep.Wait
            }
            SttJobStatus.Done -> {
                val text = claim.text?.trim()
                if (text.isNullOrEmpty()) {
                    // "done" without text: the recording browser keeps the first
                    // claim for 15s; repeat the claim with the same token.
                    DictationStep.Wait
                } else {
                    val owner = mine || claim.after != null
                    phase = DictationPhase.Idle
                    jobId = null
                    hasLocalAudio = false
                    message = null
                    canRetry = false
                    claiming = false
                    deadline = 0L
                    DictationStep.Delivered(text, claim.after ?: SttAfter.Insert, owner)
                }
            }
        }
    }

    private fun expired(): Boolean = deadline > 0 && clock() > deadline

    private fun failStep(message: String): DictationStep {
        fail(message)
        return DictationStep.Failed(message)
    }

    private fun standDown(): DictationStep {
        phase = DictationPhase.Gone
        jobId = null
        message = null
        canRetry = false
        hasLocalAudio = false
        claiming = false
        deadline = 0L
        return DictationStep.StandDown
    }

    companion object {
        /** `MAX_RECORDING_MS` in `hooks/useDictation.ts`. */
        const val MAX_RECORDING_MS = 300_000L

        /** The server gives the STT endpoint ~5 min; the deck waits a bit longer. */
        const val STT_TIMEOUT_MS = 6 * 60_000L
        const val STT_POLL_MS = 500L
        const val STT_ADOPT_MS = 4_000L

        const val TRANSCRIPTION_FAILED = "Transcription failed"
        const val TIMED_OUT = "Transcription timed out"
        const val JOB_NOT_FOUND = "Transcription job not found"
        const val NO_SPEECH = "No speech detected"
    }
}
