package io.github.kahme247.ompweb.ui.panels.btw

import io.github.kahme247.ompweb.chat.FlushScheduler
import io.github.kahme247.ompweb.domain.BtwRecord
import io.github.kahme247.ompweb.domain.BtwStatus
import io.github.kahme247.ompweb.domain.applyBtwEvent
import io.github.kahme247.ompweb.domain.btwType
import io.github.kahme247.ompweb.domain.latestBtwTurn
import io.github.kahme247.ompweb.domain.mergeBtwHistory
import io.github.kahme247.ompweb.domain.parseBtwRecord
import io.github.kahme247.ompweb.domain.upsertBtwRecord
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.BtwApi
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
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Side-question state the composer panel and the history dialog render. */
data class BtwState(
    val records: List<BtwRecord> = emptyList(),
    /** The topic in the composer panel; null hides the panel. */
    val activeId: String? = null,
    /** Panel body visible (header stays). A new topic always starts expanded. */
    val expanded: Boolean = true,
    val historyOpen: Boolean = false,
) {
    val active: BtwRecord? get() = records.firstOrNull { it.id == activeId }
    val visible: Boolean get() = active != null
}

/** Why an [BtwViewModel.ask] call did not start a side question. */
enum class BtwRefusal {
    /** No session is bound (the composer had no chat to ask from). */
    NO_SESSION,

    /** The question was blank. */
    EMPTY_QUESTION,

    /** Another side question is still starting; this one was not sent. */
    BUSY,

    /** The omp behind this server is older than `/btw`. */
    UNSUPPORTED,

    /** The request failed; the question was not asked. */
    FAILED,
}

sealed interface BtwAskResult {
    /** omp accepted the question; the answer streams through [BtwViewModel.onFrame]. */
    data object Started : BtwAskResult

    data class Refused(val reason: BtwRefusal) : BtwAskResult
}

enum class BtwFailureKind { UNSUPPORTED, FAILED }

/** A failure worth a toast (web `toastBtwError`). */
data class BtwFailure(val kind: BtwFailureKind, val detail: String? = null)

/** omp's `btw` failure when a Cancel (or session change) beat its first checkpoint. */
private const val CANCELLED_BEFORE_START = "cancelled before it started"

/** Deltas arrive at token rate; apply them at display rate (web `scheduleAtDisplayRate`). */
private const val DISPLAY_FLUSH_MS = 50L

/** An omp without the btw commands is not re-asked on every SSE connect (web `UNSUPPORTED_RETRY_MS`). */
const val BTW_UNSUPPORTED_RETRY_MS: Long = 60_000

/**
 * The pause after an omp answered "Unknown command" to a btw RPC (web's
 * module-global `unsupportedUntil`). Every [BtwViewModel] shares [shared], so
 * one old omp is not re-asked by every chat; a test injects its own gate to
 * stay independent of execution order.
 */
class BtwSupportGate {
    @Volatile
    private var unsupportedUntil = 0L

    fun isPaused(nowMs: Long): Boolean = nowMs < unsupportedUntil

    fun pause(nowMs: Long) {
        unsupportedUntil = nowMs + BTW_UNSUPPORTED_RETRY_MS
    }

    /** The commands answered again: a restarted omp is asked as usual. */
    fun resume() {
        unsupportedUntil = 0L
    }

    companion object {
        val shared = BtwSupportGate()
    }
}

/** The default display-rate scheduler: a 50 ms timer on [scope] (hidden-window safe). */
fun displayRateScheduler(scope: CoroutineScope): FlushScheduler = { flush ->
    val job: Job = scope.launch {
        delay(DISPLAY_FLUSH_MS)
        flush()
    }
    val cancel: () -> Unit = { job.cancel() }
    cancel
}

/**
 * Side questions (omp `/btw`) for one chat: the session's BTW history fed by
 * `btw_record`/`btw_delta` frames, the record shown in the composer panel, and
 * the history dialog. Port of `hooks/useBtw.ts` on top of `domain/Btw.kt`;
 * never touches the main transcript.
 *
 * Everything here is main-thread state: [onFrame] is called from the chat's
 * frame pump, exactly like the web hook.
 */
class BtwViewModel(
    private val api: BtwApi,
    private val scope: CoroutineScope,
    private val displayScheduler: FlushScheduler = displayRateScheduler(scope),
    /** Shared by every chat: one old omp must not be re-asked from each of them. */
    private val support: BtwSupportGate = BtwSupportGate.shared,
) {
    private val _state = MutableStateFlow(BtwState())
    val state: StateFlow<BtwState> = _state.asStateFlow()

    /** Toasts only (`toastBtwError`): the "requires a newer omp" hint and hard failures. */
    private val _errors = MutableSharedFlow<BtwFailure>(extraBufferCapacity = 8)
    val errors: SharedFlow<BtwFailure> = _errors.asSharedFlow()

    private var sessionId: String? = null

    // Frames queued until the display flush; the list is what this client
    // already knows, which decides auto-opening and which running records a
    // history snapshot may interrupt.
    private val pendingFrames = ArrayList<JsonObject>()
    private var cancelScheduledFlush: (() -> Unit)? = null

    private var historyJob: Job? = null
    private var askInFlight = false

    /** The chat now shows [sessionId]; the previous chat's side questions are dropped. */
    fun bind(sessionId: String?) {
        if (this.sessionId == sessionId) return
        this.sessionId = sessionId
        historyJob?.cancel()
        historyJob = null
        cancelScheduledFlush?.invoke()
        cancelScheduledFlush = null
        pendingFrames.clear()
        _state.value = BtwState()
    }

    /**
     * One session SSE frame. True when the frame was a side-question frame and
     * must not reach the transcript (the chat routes `btw_*` here *before*
     * `catchUp.observe`, so it can never reset the live view).
     */
    fun onFrame(frame: JsonObject): Boolean {
        when (frame.btwType()) {
            "btw_record", "btw_delta" -> Unit
            else -> return false
        }
        pendingFrames += frame
        if (cancelScheduledFlush == null) cancelScheduledFlush = displayScheduler { flushFrames() }
        return true
    }

    /** A fresh (re)subscription: re-read omp's history, silently. */
    fun onStreamOpen() {
        refreshHistory(explicit = false)
    }

    /** Half-open SSE recovery: re-read the history while an answer is still running. */
    fun onReconcile() {
        if (_state.value.records.any { latestBtwTurn(it).status == BtwStatus.RUNNING }) {
            refreshHistory(explicit = false)
        }
    }

    /**
     * Ask a side question, optionally as a follow-up of [followUpOf]. Returns
     * once omp accepted it (the answer streams) or refused it; a failure is
     * also pushed to [errors] so the caller only has to keep the draft.
     */
    suspend fun ask(question: String, followUpOf: String? = null): BtwAskResult {
        val text = question.trim()
        if (text.isEmpty()) return BtwAskResult.Refused(BtwRefusal.EMPTY_QUESTION)
        val sid = sessionId ?: return BtwAskResult.Refused(BtwRefusal.NO_SESSION)
        // A second ask while one is starting is ignored (web `btwAskPendingRef`).
        if (askInFlight) return BtwAskResult.Refused(BtwRefusal.BUSY)
        askInFlight = true
        try {
            val reply = try {
                api.send(
                    sid,
                    buildJsonObject {
                        put("type", "btw")
                        put("question", text)
                        if (followUpOf != null) put("recordId", followUpOf)
                    },
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                // The user's own Cancel: its `btw_record` already shows it, no message.
                if (errorMessage(error).contains(CANCELLED_BEFORE_START, ignoreCase = true)) {
                    return BtwAskResult.Started
                }
                report(error)
                return BtwAskResult.Refused(
                    if (isUnknownCommand(error)) BtwRefusal.UNSUPPORTED else BtwRefusal.FAILED,
                )
            }
            val record = parseBtwRecord((reply as? JsonObject)?.get("record"))
            if (sessionId != sid || record == null) return BtwAskResult.Started
            // The start state: never newer than frames, so upsert keeps streamed text.
            _state.update {
                it.copy(
                    records = upsertBtwRecord(it.records, record),
                    activeId = record.id,
                    expanded = true,
                )
            }
            return BtwAskResult.Started
        } finally {
            askInFlight = false
        }
    }

    /** Cancel the topic in the panel. */
    fun cancel() {
        val sid = sessionId ?: return
        val recordId = _state.value.activeId ?: return
        scope.launch {
            try {
                val reply = api.send(
                    sid,
                    buildJsonObject {
                        put("type", "btw_cancel")
                        put("recordId", recordId)
                    },
                )
                // Nothing was running: the shown state is stale (missed frame, lost child).
                val cancelled = (reply as? JsonObject)?.get("cancelled")
                    ?.let { (it as? JsonPrimitive)?.booleanOrNull }
                if (cancelled == false) readHistory(sid, explicit = false)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                report(error)
            }
        }
    }

    /** Hide the panel; the record stays in the history. */
    fun close() {
        _state.update { it.copy(activeId = null) }
    }

    /** Collapse or expand the panel body. */
    fun toggle() {
        if (_state.value.activeId == null) return
        _state.update { it.copy(expanded = !it.expanded) }
    }

    /** `/btw` alone: the history dialog. Unlike background reads, this starts omp. */
    fun openHistory() {
        _state.update { it.copy(historyOpen = true) }
        val sid = sessionId ?: return
        scope.launch {
            try {
                api.send(sid, buildJsonObject { put("type", "get_state") })
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                report(error)
                return@launch
            }
            readHistory(sid, explicit = true)
        }
    }

    fun closeHistory() {
        _state.update { it.copy(historyOpen = false) }
    }

    /** History dialog "Follow up": show that topic in the panel. */
    fun openRecord(recordId: String) {
        if (_state.value.records.none { it.id == recordId }) return
        _state.update { it.copy(activeId = recordId, expanded = true, historyOpen = false) }
    }

    /** Drain queued frames now (before a history snapshot is merged, or on demand). */
    internal fun flushFrames() {
        cancelScheduledFlush?.invoke()
        cancelScheduledFlush = null
        if (pendingFrames.isEmpty()) return
        val frames = pendingFrames.toList()
        pendingFrames.clear()
        val known = _state.value.records.mapTo(HashSet()) { it.id }
        _state.update { state ->
            state.copy(records = frames.fold(state.records, ::applyBtwEvent))
        }
        // A side question started elsewhere (another tab) opens the panel; a
        // topic this client already knows never reopens a panel the user closed.
        val started = frames.asReversed()
            .mapNotNull { parseBtwRecord(it["record"]) }
            .firstOrNull { latestBtwTurn(it).status == BtwStatus.RUNNING && it.id !in known }
        if (started != null) {
            _state.update { it.copy(activeId = started.id, expanded = true) }
        }
    }

    private fun refreshHistory(explicit: Boolean) {
        val sid = sessionId ?: return
        if (!explicit && support.isPaused(System.currentTimeMillis())) return
        historyJob?.cancel()
        historyJob = scope.launch { readHistory(sid, explicit) }
    }

    /**
     * Merge omp's history. Background reads (SSE open, reconcile, a no-op
     * cancel) stay silent: the route never starts omp for them, and an omp
     * without the commands is not asked again for a while.
     */
    private suspend fun readHistory(sid: String, explicit: Boolean) {
        if (!explicit && support.isPaused(System.currentTimeMillis())) return
        val knownBefore = _state.value.records.mapTo(LinkedHashSet()) { it.id }
        try {
            val reply = api.send(sid, buildJsonObject { put("type", "get_btw_history") })
            support.resume()
            if (sessionId != sid) return
            val snapshot = ((reply as? JsonObject)?.get("records") as? JsonArray)
                ?.mapNotNull { parseBtwRecord(it) }
                .orEmpty()
            // Frames already received go first: the staleness rules then keep
            // whichever of them and the snapshot is newer. Applied after it,
            // deltas the snapshot already holds would be appended twice.
            flushFrames()
            if (sessionId != sid) return
            val known = _state.value.records.mapTo(HashSet()) { it.id }
            _state.update { it.copy(records = mergeBtwHistory(it.records, snapshot, knownBefore)) }
            val running = snapshot.firstOrNull {
                latestBtwTurn(it).status == BtwStatus.RUNNING && it.id !in known
            }
            if (running != null && _state.value.activeId == null) {
                _state.update { it.copy(activeId = running.id, expanded = true) }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            if (isUnknownCommand(error)) support.pause(System.currentTimeMillis())
            if (explicit) report(error)
        }
    }

    private fun report(error: Throwable) {
        _errors.tryEmit(
            if (isUnknownCommand(error)) {
                BtwFailure(BtwFailureKind.UNSUPPORTED)
            } else {
                BtwFailure(BtwFailureKind.FAILED, errorMessage(error))
            },
        )
    }
}

private fun errorMessage(error: Throwable): String = error.userMessage()

/** An omp without the btw commands answers "Unknown command". */
private fun isUnknownCommand(error: Throwable): Boolean =
    error.message?.contains("Unknown command", ignoreCase = true) == true ||
        (error as? ApiError.ServerResponse)?.code == "unknown_command"
