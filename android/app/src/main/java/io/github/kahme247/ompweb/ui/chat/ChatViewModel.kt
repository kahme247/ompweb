package io.github.kahme247.ompweb.ui.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.chat.BranchNode
import io.github.kahme247.ompweb.chat.BranchRow
import io.github.kahme247.ompweb.chat.BranchTree
import io.github.kahme247.ompweb.chat.ChatEffect
import io.github.kahme247.ompweb.chat.ChatEngine
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.ChatNotice
import io.github.kahme247.ompweb.chat.ChatState
import io.github.kahme247.ompweb.chat.CompactResult
import io.github.kahme247.ompweb.chat.ContentionCopy
import io.github.kahme247.ompweb.chat.ContextPage
import io.github.kahme247.ompweb.chat.ContextSync
import io.github.kahme247.ompweb.chat.ForkTarget
import io.github.kahme247.ompweb.chat.ForkTargets
import io.github.kahme247.ompweb.chat.HistoryCursor
import io.github.kahme247.ompweb.chat.TranscriptPlan
import io.github.kahme247.ompweb.chat.TranscriptRow
import io.github.kahme247.ompweb.chat.NoticeKind
import io.github.kahme247.ompweb.data.ChatSettings
import io.github.kahme247.ompweb.data.ComposerDraftStore
import io.github.kahme247.ompweb.data.DraftRecovery
import io.github.kahme247.ompweb.data.TranscriptCache
import io.github.kahme247.ompweb.domain.ActiveGoal
import io.github.kahme247.ompweb.domain.BashInvocation
import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.ComposerRoute
import io.github.kahme247.ompweb.domain.DictationState
import io.github.kahme247.ompweb.domain.ExtensionNoticeLevel
import io.github.kahme247.ompweb.domain.ForeignSubmitDecision
import io.github.kahme247.ompweb.domain.foreignSubmitDecision
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.domain.WordGhost
import io.github.kahme247.ompweb.domain.isClientBuiltinCommand
import io.github.kahme247.ompweb.domain.isValidSubagentId
import io.github.kahme247.ompweb.domain.routeComposerSubmission
import io.github.kahme247.ompweb.domain.validateOutgoingPrompt
import io.github.kahme247.ompweb.domain.SubagentActivityEvent
import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.SubagentSource
import io.github.kahme247.ompweb.domain.SubagentTranscriptMessage
import io.github.kahme247.ompweb.domain.createActiveGoal
import io.github.kahme247.ompweb.domain.parseSubagentHistoryEntry
import io.github.kahme247.ompweb.domain.parseSubagentSnapshot
import io.github.kahme247.ompweb.domain.parseSubagentTranscriptPage
import io.github.kahme247.ompweb.domain.readCompactResult
import io.github.kahme247.ompweb.ui.hosttools.HostToolsController
import io.github.kahme247.ompweb.ui.panels.btw.BtwAskResult
import io.github.kahme247.ompweb.ui.panels.btw.BtwRefusal
import io.github.kahme247.ompweb.ui.panels.btw.BtwViewModel
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionUiController
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.SessionEventSource
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.ChatApi
import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.net.FilesApi
import io.github.kahme247.ompweb.net.QueueRestore
import io.github.kahme247.ompweb.net.SkillDiagnosticsApi
import io.github.kahme247.ompweb.net.QueuedMessageRemoval
import io.github.kahme247.ompweb.net.isQueuedWhileShellRunning
import io.github.kahme247.ompweb.net.userMessage
import io.github.kahme247.ompweb.ui.composer.ComposerController
import io.github.kahme247.ompweb.ui.composer.ComposerStrings
import io.github.kahme247.ompweb.ui.composer.ComposerSubmission
import io.github.kahme247.ompweb.ui.composer.CompletionSound
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.controls.WordPredictor
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import io.github.kahme247.ompweb.domain.DictationOutcome
import io.github.kahme247.ompweb.domain.DictationResult
import io.github.kahme247.ompweb.domain.dictationOutcome
import io.github.kahme247.ompweb.ui.render.GithubRepoRef
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Display preferences the chat needs from `SettingsStore` (web `omp-web:*` keys). */
data class ChatPreferences(
    val toolCallsCollapsed: Boolean = true,
    val hideToolActivity: Boolean = true,
    val expandThinking: Boolean = false,
    val hideThinking: Boolean = false,
    val ttsAutoplay: Boolean = false,
)

/** A deferred thinking block's fetched text. */
sealed interface ThinkingEntry {
    data object Loading : ThinkingEntry

    data class Text(val text: String) : ThinkingEntry

    data class Error(val message: String) : ThinkingEntry
}

/** A one-shot instruction for the screens (navigation or feedback). */
sealed interface ChatEvent {
    /** The fork command produced a new session; open it. */
    data class Forked(val sessionId: String) : ChatEvent

    /** omp cancelled the fork because a run was still in flight. */
    data object ForkCancelled : ChatEvent

    /** The fork command answered `success` but created no session. */
    data object ForkFailed : ChatEvent

    /** Show a short message (clipboard/network/agent failure). */
    data class Toast(val message: String) : ChatEvent

    /** Put [text] on the clipboard (builtin `/copy`). */
    data class CopyText(val text: String) : ChatEvent
}

data class BranchNavigatorState(
    val rows: List<BranchRow>,
)

/** A subagent's paged raw transcript (web transcript pager state). */
data class SubagentTranscriptState(
    val open: Boolean = false,
    val messages: List<SubagentTranscriptMessage> = emptyList(),
    val nextByte: Long = 0L,
    val loading: Boolean = false,
    val error: String? = null,
    val exhausted: Boolean = false,
)

/**
 * The subagent transcript dialog (web `SubagentTranscriptDialog`): the roster
 * entry's header telemetry, the settled completion, and the paged raw
 * transcript. `live` mirrors the roster source (history entries never show the
 * activity tail and add the token/cost/duration line).
 */
data class SubagentDialogState(
    val id: String,
    val loading: Boolean = true,
    val completion: String? = null,
    val truncated: Boolean = false,
    val error: String? = null,
    val agent: String? = null,
    val description: String? = null,
    val task: String? = null,
    val sessionFile: String? = null,
    val resolvedModel: String? = null,
    /** Raw history telemetry; the dialog localizes the units. */
    val tokens: Long? = null,
    val cost: Double? = null,
    val durationMs: Long? = null,
    val outcomeError: String? = null,
    val live: Boolean = true,
    val activity: List<SubagentActivityEvent> = emptyList(),
    val transcript: SubagentTranscriptState = SubagentTranscriptState(),
)

/** A loaded (or failed) full bash-output file. */
sealed interface BashOutputUi {
    data object Loading : BashOutputUi

    data class Ready(val text: String) : BashOutputUi

    data class Error(val message: String) : BashOutputUi
}

/** Everything the chat surface renders. */
data class ChatUiState(
    val sessionId: String? = null,
    val engine: ChatState = ChatState(),
    val rows: List<TranscriptRow> = emptyList(),
    val toolResults: Map<String, ChatMessage.ToolResult> = emptyMap(),
    val forkTargets: List<ForkTarget?> = emptyList(),
    val preferences: ChatPreferences = ChatPreferences(),
    val githubRepo: GithubRepoRef? = null,
    val hasCompaction: Boolean = false,
    val branchTree: List<BranchNode> = emptyList(),
    val branchHasBranch: Boolean = false,
    val branch: BranchNavigatorState? = null,
    val subagent: SubagentDialogState? = null,
    val thinking: Map<String, ThinkingEntry> = emptyMap(),
    val notices: List<ChatNotice> = emptyList(),
    /** Full bash output loaded on demand, keyed by `fullOutputPath`. */
    val bashOutputs: Map<String, BashOutputUi> = emptyMap(),
    /** Id of the reply currently read aloud, if any. */
    val speakingId: String? = null,
    val forkingEntryId: String? = null,
    val stopping: Boolean = false,
    /** Forked edit-and-resend text waiting for the composer to adopt it. */
    val prefill: String? = null,
    /** The session's active `/goal`, shown above the composer. */
    val activeGoal: ActiveGoal? = null,
    /** `omp-web:submit-during-run`, read for the composer's Enter behavior. */
    val submitDuringRun: SubmitDuringRunBehavior = SubmitDuringRunBehavior.DEFAULT,
    /** The `/plan` turn still running; its banner sits above the composer. */
    val planObjective: String? = null,
    /** System prompt panel: closed, loading, loaded text, empty or failed. */
    val systemPrompt: SystemPromptState = SystemPromptState.Idle,
    /** Startup skill-notice "Turn off" round trip is in flight. */
    val skillDiagnosticsSaving: Boolean = false,
    /** Why the last "Turn off" did not take effect (shown inline). */
    val skillDiagnosticsFailure: SkillDiagnosticsFailure? = null,
    /** Transient compaction result banner (web `compactResult`, 6 s). */
    val compactResult: CompactResult? = null,
    /** Transient compaction failure banner (web `compactError`, 3 s). */
    val compactError: String? = null,
    /** `omp-web:composer-todo-collapsed`: the attached todo panel's body. */
    val todoCollapsed: Boolean = true,
    /** `omp-web:composer-subagents-collapsed`: the attached roster's body. */
    val subagentsCollapsed: Boolean = true,
    val connection: ConnectionState = ConnectionState.Reconnecting,
    /** Row to restore on the next transcript layout; consumed by the screen. */
    val restoreScrollIndex: Int? = null,
    /**
     * A submit is waiting for the live run state before it can be routed: the
     * composer shows it as sending and refuses further input, the draft stays
     * in the field until the route decision is made.
     */
    val submitPending: Boolean = false,
    /**
     * A send the chat is holding because another omp process owns the session
     * (web "Trotzdem senden (Kopie)"). Non-null = the confirmation dialog is
     * open for exactly this submission; the draft stays in the field until the
     * user decides, and only the dialog's confirm sends with `?force=1`.
     */
    val foreignSend: ComposerSubmission? = null,
    /**
     * omp moved this chat to a copy because another process held the file
     * (`session_contention_fork`). The banner offers opening the original and
     * the copy; the copy carries the sent text.
     */
    val contentionCopy: ContentionCopy? = null,
) {
    val busy: Boolean
        get() = engine.busy || engine.streamingActive
}

/**
 * Phase 5 chat view model: owns the transport around the pure [ChatEngine]
 * (web `useAgentSession*`).
 *
 * It subscribes the session channel, executes the engine's effects (context
 * sync, agent-state reconcile, autoplay), reassembles multi-page history,
 * settles a just-sent prompt, forks, fetches deferred thinking/subagent
 * output/files, and keeps the per-session scroll memory. All engine input
 * happens on the main dispatcher, so the coalescer's schedule callback can be
 * a 16 ms coroutine.
 */
class ChatViewModel(
    private val api: ChatApi,
    private val eventMux: SessionEventSource,
    private val settings: ChatSettings,
    private val speech: Speech,
    private val savedStateHandle: SavedStateHandle,
    /** Localized `R.string.chat_prompt_maybe_started`; the view model has no
     * resources, so the container resolves it. */
    private val maybeStartedMessage: String,
    /** Localized `R.string.chat_stop_unconfirmed`: omp did not answer the abort
     * in time, so the run may still be going. */
    private val stopUnconfirmedMessage: String,
    /** Per-session composer drafts (text survives process death). */
    private val drafts: ComposerDraftStore,
    /** Localized composer labels the view model raises (no `Context` here). */
    private val composerStrings: ComposerStrings,
    /** Slice B: model / thinking / tools / advisor / context controls. */
    val controls: ComposerControlsViewModel,
    /** Slice C: voice dictation. */
    val dictation: DictationViewModel,
    /** Slice B: ghost-text word prediction. */
    private val wordPredictor: WordPredictor,
    /** Completion tone (`omp-sound-enabled`). */
    private val completionSound: CompletionSound,
    /** Slice B: side questions (`/btw`), fed by the session's frames. */
    val btw: BtwViewModel,
    /** Slice C: extension UI requests and push updates for the bound session. */
    val extensionUi: ExtensionUiController,
    /** Slice C: the app-wide host-tool bridge (`open_url`/`notify`/`open_file`). */
    private val hostTools: HostToolsController,
    /** The composer's `/api/file-index` client (one client with the explorer). */
    files: FilesApi,
    /**
     * `set_skill_startup_diagnostics` (GAP 3). Optional so existing tests keep
     * constructing the view model; the container passes [ApiClient], and a
     * missing client surfaces as "unavailable" in the notice instead of a
     * silent no-op.
     */
    private val skillDiagnostics: SkillDiagnosticsApi? = null,
    /**
     * The offline transcript cache. `null` disables cache-first painting; the
     * container passes the `SessionCacheStore`, and the JVM tests a fake or
     * nothing.
     */
    private val transcripts: TranscriptCache? = null,
    /**
     * Where the transcript cache is read and written. `Dispatchers.IO` in the
     * app; the JVM tests pass their test dispatcher so the seed lands
     * deterministically before the request.
     */
    private val cacheDispatcher: CoroutineDispatcher = Dispatchers.IO,
    /**
     * Bumped by `AppContainer.clearLocalUserData` (sign-out, server switch,
     * 401). On a change every transcript this view model holds in memory is
     * dropped: the disk cache is cleared at the same moment, and nothing of
     * the previous installation may survive in the heap.
     */
    private val sessionEpoch: StateFlow<Int>? = null,
) : ViewModel() {

    private val engine = ChatEngine(
        scheduler = { flush ->
            val job = viewModelScope.launch {
                delay(FRAME_COALESCE_MILLIS)
                flush()
            }
            return@ChatEngine { job.cancel() }
        },
        // `btw_*` frames never reach the transcript (web routes them before
        // `catchUp.observe`); the engine consumes them here.
        onBtwFrame = { frame -> btw.onFrame(frame) },
    )

    /** The composer's text, attachments, palettes and `!` shell mode. */
    val composer = ComposerController(
        drafts = drafts,
        scope = viewModelScope,
        api = api,
        files = files,
        strings = composerStrings,
        notice = { message -> _events.tryEmit(ChatEvent.Toast(message)) },
    )

    /** Slice B: the prediction for the current draft state, painted as ghost text. */
    val ghost: StateFlow<WordGhost?> = wordPredictor.ghost

    private val _ui = MutableStateFlow(ChatUiState())
    val ui: StateFlow<ChatUiState> = _ui.asStateFlow()

    /**
     * The in-chat search (top-bar search icon) and the jump hand-off for the
     * server-side search in `ui/sessions`
     * ([scrollToEntry]).
     */
    private val _search = MutableStateFlow(ChatSearchState())
    val search: StateFlow<ChatSearchState> = _search.asStateFlow()

    private val _events = MutableSharedFlow<ChatEvent>(extraBufferCapacity = 8)
    val events: SharedFlow<ChatEvent> = _events.asSharedFlow()

    private var sessionId: String? = null
    private var cwd: String? = null

    /** Names warned about once ("unknown slash command sent as text"). */
    private val warnedSlashCommands = HashSet<String>()
    /** One queue mutation (edit/delete/steer) at a time, like the web's guard. */
    private var queueMutationInFlight = false

    /** Edit-and-resend text waiting for the session a fork created. */
    private val prefillBySession = HashMap<String, String>()

    /** Search hits waiting for the session they belong to (server-side search hand-off). */
    private val pendingReveals = HashMap<String, String>()

    /**
     * The server origin [pendingReveals] were queued for. Those entry ids mean
     * nothing on another installation, so a change drops the queue.
     */
    private var lastOrigin: String? = settings.snapshot.value.origin?.origin

    /** `/btw` questions waiting for the session the new-session pane created. */
    private val pendingSideQuestions = HashMap<String, String>()

    /** Null means "the session's latest leaf"; a branch pick pins the view. */
    private var viewLeafId: String? = null
    private var detailLeafId: String? = null

    private var preferences = ChatPreferences()
    private var rowsCacheSource: List<ChatMessage>? = null
    private var rowsCacheHideThinking = false
    private var rowsCache: List<TranscriptRow> = emptyList()
    /** Last session-file model/thinking forwarded to Slice B's controls. */
    private var lastSessionModelKey: String? = null
    private var lastSessionThinking: String? = null
    private var committedToolResults: Map<String, ChatMessage.ToolResult> = emptyMap()
    private var forkCache: List<ForkTarget?> = emptyList()

    private var subscriptionJob: Job? = null
    private var historyJob: Job? = null
    private var historyRequested = false
    private var pendingReset = false
    private var historyGeneration = 0
    private var historyCursor: HistoryCursor? = null
    private var metaJob: Job? = null

    private var settleJob: Job? = null

    /**
     * Sessions with a `GET /api/agent/{id}` on the wire. The guard is
     * per-session because the view model outlives a session switch: a slow
     * answer for the previous session must never swallow the first live-state
     * read of the next one. A duplicate request for the session that is
     * already waiting is dropped; its answer is the same state.
     */
    private val reconcileInFlight = HashSet<String>()

    /**
     * Consecutive 503 answers that carried no run state, per session, and when
     * the first of them arrived. Reset by any successful read (and on run end):
     * it only bounds the "unknown" window of a server that does not report the
     * run state — the answer itself is authoritative when it does.
     */
    private var slowStateSession: String? = null
    private var slowStateRunId = -1L
    private var slowStateAnswers = 0

    /**
     * The submit that is waiting for the live state of [sessionId]: one at a
     * time, so a second Enter (or the button) cannot start a second route.
     */
    private var submitPendingJob: Job? = null

    /** The session whose submit is waiting; null when none is. */
    private var submitPendingSession: String? = null

    /**
     * Bumped by every [open] with another session and by
     * [clearSessionData]. A wait of an older epoch belongs to a chat that is
     * gone: it is cancelled and must neither route its draft nor clear the
     * "Sending…" of the new chat.
     */
    private var submitEpoch = 0L

    /** Auto-dismiss timers for the transient compaction banners. */
    private var compactResultJob: Job? = null
    private var compactErrorJob: Job? = null
    /** Debounced per-subagent refetches for the open transcript dialog. */
    private var subagentWatchJob: Job? = null
    private var subagentCompletionJob: Job? = null
    private var subagentTranscriptJob: Job? = null
    private var subagentDetailJob: Job? = null
    private var refetchedSubagentVersion = 0L
    private var refetchedTranscriptVersion = 0L
    private var latestSubagentVersion = 0L
    /** Guards the async subagent fetches of the currently open dialog. */
    private var subagentRequestSeq = 0
    private var transcriptRequestSeq = 0

    private var scrollSaveJob: Job? = null
    private var currentScrollIndex = 0
    private var lastPersistedScroll = 0
    private var lastNearBottom = true

    private val thinkingCache = LinkedHashMap<String, ThinkingEntry>()
    private val dismissedNotices = HashSet<String>()

    private var runCounter = 0L
    private var pumpingEffects = false

    init {
        composer.textObserver = { text, caret -> wordPredictor.onTextChanged(sessionId, text, caret) }
        viewModelScope.launch {
            settings.snapshot.collect { snapshot ->
                // Entry ids are session-file UUIDs; after "Change server" the
                // queued jump targets address another installation and must not
                // fire against this chat's transcript.
                val origin = snapshot.origin?.origin
                if (origin != lastOrigin) {
                    lastOrigin = origin
                    pendingReveals.clear()
                }
                val next = ChatPreferences(
                    toolCallsCollapsed = snapshot.toolCallsCollapsed,
                    hideToolActivity = snapshot.hideToolActivity,
                    expandThinking = snapshot.expandThinking,
                    hideThinking = snapshot.hideThinking,
                    ttsAutoplay = snapshot.ttsAutoplay,
                )
                if (next != preferences) {
                    if (next.hideThinking != preferences.hideThinking) rowsCacheSource = null
                    preferences = next
                    speech.setVoice(snapshot.ttsVoice)
                    publish()
                } else if (
                    _ui.value.todoCollapsed != snapshot.composerTodoCollapsed ||
                    _ui.value.subagentsCollapsed != snapshot.composerSubagentsCollapsed
                ) {
                    publish()
                }
            }
        }
        viewModelScope.launch {
            engine.state.collect { state -> publish(state) }
        }
        sessionEpoch?.let { epoch ->
            viewModelScope.launch {
                epoch.drop(1).collect { clearSessionData() }
            }
        }
        viewModelScope.launch {
            eventMux.state.collect { connection ->
                val previous = _ui.value.connection
                _ui.update { it.copy(connection = connection) }
                if (connection == ConnectionState.Connected && previous != ConnectionState.Connected) {
                    requestHistory(reset = false)
                    reconcileNow()
                }
            }
        }
        viewModelScope.launch {
            speech.state.collect { voice ->
                _ui.update { it.copy(speakingId = voice.speakingId) }
            }
        }
        viewModelScope.launch {
            // The live state of a freshly opened session can fail to arrive
            // (one 5xx, a proxy timeout, omp's session_slow). While it is
            // unknown there is no stream that would correct it, so the loop
            // asks again — with a growing delay, so an offline device does not
            // poll every few seconds. A known state polls only a busy run.
            var unknownBackoff = RECONCILE_UNKNOWN_FIRST_MILLIS
            var polledSession: String? = null
            while (isActive) {
                val current = engine.state.value
                if (sessionId != polledSession) {
                    polledSession = sessionId
                    unknownBackoff = RECONCILE_UNKNOWN_FIRST_MILLIS
                }
                val known = current.liveStateKnown
                // Another omp process owns the chat: no session channel streams
                // its transcript here, so the file is followed by polling (web
                // `catchUp`), and every poll refreshes the owner report.
                val foreign = current.foreignRun?.active == true
                delay(
                    when {
                        !known -> unknownBackoff
                        foreign -> FOREIGN_RUN_POLL_MILLIS
                        else -> RECONCILE_MILLIS
                    },
                )
                if (!known) {
                    unknownBackoff = minOf(unknownBackoff * 2, RECONCILE_UNKNOWN_MAX_MILLIS)
                    reconcileNow(countSlowAnswer = true)
                } else if (foreign) {
                    // Follow the file read-only AND re-read the owner report:
                    // without the state poll an owner that ended would keep the
                    // banner (and the send gate) forever, because no frame of
                    // this refused session channel would ever say otherwise.
                    requestHistory(reset = false)
                    reconcileNow(countSlowAnswer = true)
                } else if (engine.state.value.busy) {
                    reconcileNow(countSlowAnswer = true)
                }
            }
        }
        viewModelScope.launch {
            dictation.results.collect { result -> applyDictationResult(result) }
        }
        // On-device recognition writes its partials into the composer field at
        // the caret; the view model reads text and caret right before each edit
        // and hands the finished state back.
        dictation.attachLiveField(
            text = { composer.state.value.text },
            caret = { composer.state.value.caret },
            apply = composer::replaceText,
        )
        viewModelScope.launch {
            controls.state.collect { state ->
                state.foreignRefusal?.let { refusal ->
                    // A settings command (model/thinking/fast/compact/…) hit the
                    // ownership gate: the banner goes up and the message says the
                    // command was not applied instead of the send wording.
                    engine.setForeignRun(refusal.elsewhere ?: engine.state.value.foreignRun)
                    controls.clearForeignRefusal()
                    _events.tryEmit(ChatEvent.Toast(composerStrings.foreignCommandBlocked))
                }
                state.error?.let { message ->
                    _events.tryEmit(ChatEvent.Toast(message))
                    controls.clearError()
                }
            }
        }
        // Slice C surfaces its host/extension notices with omp's level; the
        // notice bar colours errors and warnings instead of dropping the level.
        viewModelScope.launch {
            extensionUi.notices.collect { notice ->
                engine.notice(
                    when (notice.level) {
                        ExtensionNoticeLevel.Info -> NoticeKind.Info
                        ExtensionNoticeLevel.Warning -> NoticeKind.Warning
                        ExtensionNoticeLevel.Error -> NoticeKind.Error
                    },
                    notice.message,
                )
            }
        }
        viewModelScope.launch {
            hostTools.notices.collect { message -> _events.tryEmit(ChatEvent.Toast(message)) }
        }
        // `extension_ui_editor_text`: a request may write the composer field.
        viewModelScope.launch {
            extensionUi.editorText.collect { text -> composer.setText(text) }
        }
    }

    // --------------------------------------------------------------- composer

    /** Tab/`→`: accept the ghost when it still matches the current draft. */
    fun acceptGhost(): Boolean {
        if (!composer.state.value.canAcceptGhost) return false
        val state = composer.state.value
        val insertion = wordPredictor.accept(state.text, state.caret) ?: return false
        composer.replaceText(insertion.text, insertion.caret)
        return true
    }

    /** Adopt the fork's edit-and-resend text into the field. */
    fun adoptPrefill() {
        val text = _ui.value.prefill ?: return
        _ui.update { it.copy(prefill = null) }
        composer.setText(text)
    }

    fun openHistory() {
        val busy = engine.state.value.busy || engine.state.value.streamingActive
        if (composer.state.value.text.isNotEmpty() || busy) return
        val userTexts = engine.state.value.messages.mapNotNull { message ->
            (message as? ChatMessage.User)?.text?.takeIf { !it.isBlank() }
        }
        composer.openHistory(userTexts)
    }

    // ---------------------------------------------------------- system prompt

    /**
     * Top-bar terminal icon (web `AppShell`): load the session's composed
     * system prompt on demand. `get_state` is the only source; an idle session
     * without an omp child answers from the saved state.
     */
    fun openSystemPrompt() {
        val sid = sessionId ?: return
        if (_ui.value.systemPrompt is SystemPromptState.Loading) return
        _ui.update { it.copy(systemPrompt = SystemPromptState.Loading) }
        viewModelScope.launch {
            try {
                val root = api.agentState(sid)
                if (sessionId != sid) return@launch resetStaleSystemPrompt()
                _ui.update { it.copy(systemPrompt = systemPromptFor(root)) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (sessionId != sid) return@launch resetStaleSystemPrompt()
                _ui.update { it.copy(systemPrompt = SystemPromptState.Failed(error.userMessage())) }
            }
        }
    }

    /**
     * A load started for a session the screen has left must not surface; the
     * sheet returns to idle, but a load the new session started stays.
     */
    private fun resetStaleSystemPrompt() {
        _ui.update {
            if (it.systemPrompt is SystemPromptState.Loading) {
                it.copy(systemPrompt = SystemPromptState.Idle)
            } else {
                it
            }
        }
    }

    fun closeSystemPrompt() {
        _ui.update { it.copy(systemPrompt = SystemPromptState.Idle) }
    }

    private fun refreshOpenSystemPrompt(root: JsonObject) {
        if (_ui.value.systemPrompt is SystemPromptState.Idle) return
        val text = systemPromptText(root) ?: return
        _ui.update {
            it.copy(
                systemPrompt = if (text.isEmpty()) SystemPromptState.Empty else SystemPromptState.Loaded(text),
            )
        }
    }

    private fun systemPromptFor(root: JsonObject): SystemPromptState {
        val text = systemPromptText(root) ?: return SystemPromptState.Failed(null)
        return if (text.isEmpty()) SystemPromptState.Empty else SystemPromptState.Loaded(text)
    }

    private fun systemPromptText(root: JsonObject): String? {
        val state = (root["state"] as? JsonObject) ?: root
        return (state["systemPrompt"] as? kotlinx.serialization.json.JsonPrimitive)
            ?.takeIf { it.isString }
            ?.content
    }

    // --------------------------------------------------------------- shortcuts

    /**
     * Ctrl/Cmd+M (web `ChatWindow`): start dictation into the draft, or stop
     * the running take. Upload/transcribe states are left alone so a shortcut
     * cannot lose a finished recording.
     */
    fun toggleDictation() {
        when (dictation.state.value) {
            is DictationState.Idle -> dictation.start(SttAfter.Insert)
            // Both listening modes end the same way; the text stays in the draft.
            is DictationState.Recording, is DictationState.Live -> dictation.stop()
            else -> Unit
        }
    }

    /**
     * Startup-notice "Turn off": persist the preference with a revision fence
     * so a live `skill_diagnostics_update` that lands during the call wins
     * (web `skillDiagnosticsSeqRef`). The notice shows why a change did not
     * stick instead of pretending it did.
     */
    fun setSkillStartupDiagnostics(enabled: Boolean) {
        if (_ui.value.skillDiagnosticsSaving) return
        val sid = sessionId
        val client = skillDiagnostics
        if (sid == null || client == null) {
            _ui.update {
                it.copy(
                    skillDiagnosticsFailure = if (sid == null) {
                        SkillDiagnosticsFailure.SaveFailed
                    } else {
                        SkillDiagnosticsFailure.Unavailable
                    },
                )
            }
            return
        }
        _ui.update { it.copy(skillDiagnosticsSaving = true, skillDiagnosticsFailure = null) }
        viewModelScope.launch {
            val revision = engine.state.value.skillDiagnosticsRevision
            try {
                val result = client.setSkillStartupDiagnostics(sid, enabled)
                if (result == null) {
                    _ui.update { it.copy(skillDiagnosticsFailure = SkillDiagnosticsFailure.Unavailable) }
                } else {
                    engine.applySkillDiagnostics(result, revision)
                    if (result.showStartupDiagnostics) {
                        _ui.update { it.copy(skillDiagnosticsFailure = SkillDiagnosticsFailure.Overridden) }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                _ui.update { it.copy(skillDiagnosticsFailure = SkillDiagnosticsFailure.SaveFailed) }
            } finally {
                _ui.update { it.copy(skillDiagnosticsSaving = false) }
            }
        }
    }

    /** Ctrl/Cmd+Alt+M: ask omp to advance the session's model (`cycle_model`). */
    fun cycleModel() = controls.cycleModel()

    /** Ctrl/Cmd+Alt+T: ask omp to advance the thinking level (`cycle_thinking_level`). */
    fun cycleThinkingLevel() = controls.cycleThinkingLevel()

    /**
     * The primary action: shell command, slash builtin/expansion or prompt;
     * during a run it queues/steers per `omp-web:submit-during-run` (Enter) or
     * always queues (button).
     */
    fun submit(forceQueue: Boolean = false) {
        submitComposer(forceQueue)
    }

    private fun submitComposer(forceQueue: Boolean) {
        // A submit that is still resolving the live state owns the composer;
        // a second Enter must not route the same draft again.
        if (_ui.value.submitPending) return
        val submission = composer.resolve() ?: return
        submitResolved(submission, forceQueue)
    }

    /** Route a resolved submission: shell, web expansion, builtin or prompt. */
    private fun submitResolved(submission: ComposerSubmission, forceQueue: Boolean) {
        // `/btw` runs beside any main turn (never queued, never a prompt) and
        // is checked before the streaming branch, like the web composer.
        if (isSideQuestion(submission.raw)) {
            submitSideQuestion(submission)
            return
        }
        val state = engine.state.value
        val streaming = state.busy || state.streamingActive
        val route = routeOf(submission)
        // After a cold start the app has no live view yet (cached transcript,
        // footer "Connecting…") while the session may well be running. A
        // plain `prompt` now would be refused by omp and the steer/follow-up
        // intent lost, so resolve the run state first and route afterwards.
        // Without a live state the idle path is not a decision the app is
        // allowed to make; `/btw` (above) and client builtins never depend on it.
        val liveDependent = route is ComposerRoute.Bash ||
            route is ComposerRoute.WebPrompt ||
            route is ComposerRoute.Prompt
        if (sessionId != null && !streaming && !state.liveStateKnown && liveDependent) {
            resolveLiveStateThenSubmit(submission, forceQueue)
            return
        }
        when (route) {
            is ComposerRoute.Bash -> {
                // Web parity: during a run a `!cmd` becomes a queued follow-up;
                // the draft only clears when the shell command actually starts.
                if (streaming) {
                    queueOrSteer(submission, route, submitMode(forceQueue))
                } else if (!holdForForeignOwner(submission)) {
                    if (executeBash(route.invocation)) composer.clear()
                }
            }
            is ComposerRoute.Usage -> _events.tryEmit(
                ChatEvent.Toast(composerStrings.requiresArgs(route.command, route.argumentHint)),
            )
            is ComposerRoute.WebPrompt -> {
                if (streaming) {
                    queueOrSteer(submission, route, submitMode(forceQueue))
                    return
                }
                if (route.name == "advisor" && !controls.state.value.advisorEnabled) {
                    _events.tryEmit(ChatEvent.Toast(composerStrings.advisorDisabled))
                    return
                }
                if (rejectsOversized(route.prompt, emptyList())) return
                val outgoing = ComposerSubmission(
                    raw = submission.raw,
                    prompt = route.prompt,
                    images = emptyList(),
                    hasAttachments = false,
                    bash = null,
                )
                if (holdForForeignOwner(outgoing)) return
                val dispatched = sendPrompt(outgoing, clearOnSuccess = true)
                if (route.name == "plan") {
                    // Web `activePlan`: the banner lives for this turn only.
                    _ui.update { it.copy(planObjective = route.args.takeIf { dispatched && it.isNotEmpty() }) }
                }
                if (route.name == "goal" && route.args.isNotEmpty()) {
                    val sid = sessionId
                    if (sid != null) {
                        val goal = createActiveGoal(route.args, System.currentTimeMillis())
                        viewModelScope.launch { settings.setActiveGoal(sid, goal) }
                        _ui.update { it.copy(activeGoal = goal) }
                    }
                }
            }
            is ComposerRoute.Builtin -> runBuiltinAction(route.name, route.args)
            is ComposerRoute.Prompt -> {
                if (streaming) {
                    queueOrSteer(submission, route, submitMode(forceQueue))
                } else if (!holdForForeignOwner(submission)) {
                    sendPrompt(submission, clearOnSuccess = true)
                }
            }
        }
    }

    /**
     * Hold a submission back while another omp process owns this session.
     *
     * omp lets one process write a session; a send from here would move the
     * chat to a copy on its first write. The server refuses such a send, but
     * the refusal must not swallow the draft, so the screen decides first (and
     * the server stays the authority for the racing case, see `sendPrompt`).
     * Returns true when the submit was stopped.
     *
     * [foreignSubmitDecision] separates a proven owner (banner + notice; the
     * explicit "send anyway (copy)" in the banner is the only way through) from
     * the weak transcript signal (a confirmation dialog right away).
     */
    private fun holdForForeignOwner(submission: ComposerSubmission): Boolean {
        val decision = foreignSubmitDecision(engine.state.value.foreignRun, confirmed = false)
        if (decision == ForeignSubmitDecision.Allow) return false
        val route = routeOf(submission)
        val prompt = route is ComposerRoute.Prompt || route is ComposerRoute.WebPrompt
        // A `!cmd` has no text worth keeping in a copy: it is simply refused.
        if (!prompt || decision == ForeignSubmitDecision.Block) {
            engine.notify(NoticeKind.Warning, composerStrings.foreignSendBlocked)
            return true
        }
        _ui.update { it.copy(foreignSend = submission) }
        return true
    }

    /**
     * The banner's "send anyway (copy)": open the confirmation for the current
     * draft. A client builtin needs no omp process and is routed as usual.
     */
    fun requestForeignSend() {
        val submission = composer.resolve() ?: return
        val route = routeOf(submission)
        if (route !is ComposerRoute.Prompt && route !is ComposerRoute.WebPrompt) {
            submitResolved(submission, forceQueue = false)
            return
        }
        _ui.update { it.copy(foreignSend = submission) }
    }

    /** The confirmation's cancel: nothing is sent, the draft stays as it is. */
    fun cancelForeignSend() {
        _ui.update { it.copy(foreignSend = null) }
    }

    /** Close the "continued in a copy" banner (after opening a chat). */
    fun dismissContentionFork() {
        _ui.update { it.copy(contentionCopy = null) }
    }

    /**
     * The confirmation's "send anyway (copy)": send with `?force=1`. The send
     * goes into a copy with a new chat id; the original stays as the other
     * process left it.
     */
    fun confirmForeignSend() {
        val pending = _ui.value.foreignSend ?: return
        _ui.update { it.copy(foreignSend = null) }
        if (sendPrompt(pending, clearOnSuccess = true, force = true)) return
        // The run state changed under the dialog (a stream arrived); the draft
        // is untouched, so the user can simply send again.
        engine.notify(NoticeKind.Warning, composerStrings.foreignSendBlocked)
    }

    /**
     * Take the session list's owner report for the open chat, unless this chat
     * already has one.
     *
     * The list hears the `running` frames of the server, so it can know about an
     * owner while this chat's own `GET /api/agent/{id}` is still on the wire or
     * was refused (`session_slow`). The seed only fills a gap — an owner this
     * chat already reports stays — and it stays a hint: the 2 s state poll while
     * a foreign run is active is what ends it again. `null` says nothing here:
     * an absent list entry comes from the list's own activity window, not from
     * this session's state.
     */
    private fun seedForeignRun(elsewhere: ElsewhereSession?) {
        if (elsewhere == null) return
        if (engine.state.value.foreignRun != null) return
        engine.setForeignRun(elsewhere)
    }

    private fun submitMode(forceQueue: Boolean): String = if (forceQueue) {
        "followUp"
    } else {
        when (settings.snapshot.value.submitDuringRun) {
            SubmitDuringRunBehavior.STEER -> "steer"
            SubmitDuringRunBehavior.QUEUE -> "followUp"
        }
    }

    /**
     * Wait for the live run state of [submission]'s session, then route it.
     *
     * The submit is held in the composer (`submitPending`): the draft stays
     * where it is, the primary action reads "Sending…" and input is locked, so
     * the text can neither be lost nor routed twice. Once the state is known
     * [submitResolved] runs again and picks steer/follow-up for a running
     * session or a prompt for an idle one. A state that cannot be read within
     * [LIVE_STATE_SUBMIT_TIMEOUT_MILLIS] leaves the draft untouched and says
     * so, instead of guessing and letting omp refuse the prompt.
     *
     * The wait belongs to the session that started it: switching the chat or
     * dropping the signed-in user ([clearSessionData]) cancels it through
     * [abandonPendingSubmit], and the epoch keeps a late cancellation from
     * touching the next chat's composer.
     */
    private fun resolveLiveStateThenSubmit(submission: ComposerSubmission, forceQueue: Boolean) {
        val sid = sessionId ?: return
        if (submitPendingJob?.isActive == true && submitPendingSession == sid) return
        val epoch = submitEpoch
        submitPendingSession = sid
        _ui.update { it.copy(submitPending = true) }
        submitPendingJob = viewModelScope.launch {
            try {
                val read = awaitLiveStateForSubmit()
                if (epoch != submitEpoch || sessionId != sid) return@launch
                when (read) {
                    // Slow only leaves the wait loop as running (the engine was
                    // marked alive); routing here still sees the busy state.
                    LiveRead.Running, LiveRead.Idle, LiveRead.Slow -> submitResolved(submission, forceQueue)
                    LiveRead.Skipped, is LiveRead.Failed ->
                        _events.tryEmit(ChatEvent.Toast(composerStrings.liveStateUnknown))
                }
            } finally {
                // A cancelled wait of the previous chat has already been
                // released by [abandonPendingSubmit]; only the current one may
                // clear the flags of the open composer.
                if (epoch == submitEpoch) {
                    submitPendingJob = null
                    submitPendingSession = null
                    _ui.update { it.copy(submitPending = false) }
                }
            }
        }
    }

    /**
     * Drops a submit that is still waiting for the live state, because the
     * chat it belongs to is gone ([open] with another session) or everything
     * of the signed-in user is being dropped ([clearSessionData]). The draft
     * stays in the composer store (Findings 1/2 of the 1.0.9 review: the wait
     * used to outlive its chat and kept the new composer on "Sending…").
     */
    private fun abandonPendingSubmit() {
        submitEpoch++
        val job = submitPendingJob
        submitPendingJob = null
        submitPendingSession = null
        job?.cancel()
        if (_ui.value.submitPending) {
            _ui.update { it.copy(submitPending = false) }
            _events.tryEmit(ChatEvent.Toast(composerStrings.submitAbandoned))
        }
    }

    /**
     * The bounded read [resolveLiveStateThenSubmit] waits on. A frame may
     * settle the state while the GET is pending, so the engine is checked
     * first; a read already on the wire is awaited rather than duplicated.
     */
    private suspend fun awaitLiveStateForSubmit(): LiveRead =
        withTimeoutOrNull(LIVE_STATE_SUBMIT_TIMEOUT_MILLIS) {
            var backoff = LIVE_STATE_SUBMIT_FIRST_MILLIS
            while (true) {
                val state = engine.state.value
                if (state.liveStateKnown) {
                    return@withTimeoutOrNull if (state.busy || state.streamingActive) {
                        LiveRead.Running
                    } else {
                        LiveRead.Idle
                    }
                }
                when (val read = readLiveState()) {
                    LiveRead.Running, LiveRead.Idle -> return@withTimeoutOrNull read
                    LiveRead.Skipped -> delay(LIVE_STATE_SUBMIT_POLL_MILLIS)
                    // A busy child: the engine is now marked running, so the
                    // next pass answers from its state; the backoff keeps a
                    // fenced (dropped) mark from spinning.
                    LiveRead.Slow, is LiveRead.Failed -> {
                        delay(backoff)
                        backoff = minOf(backoff * 2, LIVE_STATE_SUBMIT_MAX_RETRY_MILLIS)
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            LiveRead.Skipped
        } ?: LiveRead.Skipped

    /** `/btw` with or without a question (web `sendSideQuestion` regex). */
    private fun isSideQuestion(raw: String): Boolean = SIDE_QUESTION_REGEX.containsMatchIn(raw.trim())

    /**
     * `/btw <question>` asks a side question beside the main turn; `/btw`
     * alone opens the history dialog. Attachments cannot ride along, so the
     * draft (and its files) stay in the field (web `btw.attachmentsUnsupported`).
     */
    private fun submitSideQuestion(submission: ComposerSubmission) {
        if (submission.hasAttachments || submission.images.isNotEmpty()) {
            _events.tryEmit(ChatEvent.Toast(composerStrings.btwAttachmentsUnsupported))
            return
        }
        if (sessionId == null) {
            _events.tryEmit(ChatEvent.Toast(composerStrings.noSession))
            return
        }
        askSideQuestion(submission.raw)
    }

    /**
     * `/btw` for the open chat. A side question the new-session pane created
     * this session for arrives through [askSideQuestionInNewChat] and runs on
     * the first [open] of [sessionId].
     */
    private fun askSideQuestion(rawSubmission: String) {
        val sid = sessionId ?: return
        val raw = rawSubmission.trim()
        val question = raw.removePrefix("/btw").trim()
        // The session channel is observer-only: attach before asking so the
        // first deltas are not missed (web `ensureEventsConnected` before ask).
        ensureSubscribed(sid)
        if (question.isEmpty()) {
            composer.clear()
            btw.openHistory()
            return
        }
        viewModelScope.launch {
            when (val result = btw.ask(question)) {
                BtwAskResult.Started -> {
                    // Only clear what was sent; typing during the ask survives.
                    if (composer.state.value.text.trim() == raw) composer.clear()
                }
                is BtwAskResult.Refused -> when (result.reason) {
                    BtwRefusal.NO_SESSION -> _events.tryEmit(ChatEvent.Toast(composerStrings.noSession))
                    // BUSY keeps the draft; UNSUPPORTED/FAILED already reach `btw.errors`.
                    BtwRefusal.BUSY, BtwRefusal.EMPTY_QUESTION, BtwRefusal.UNSUPPORTED, BtwRefusal.FAILED -> Unit
                }
            }
        }
    }

    /**
     * Web `ensure_session` parity for `/btw` typed in a brand-new chat: the
     * pane created the session; the question is asked here once it is open.
     */
    fun askSideQuestionInNewChat(sessionId: String, raw: String) {
        if (this.sessionId == sessionId) {
            askSideQuestion(raw)
        } else {
            pendingSideQuestions[sessionId] = raw
        }
    }

    /** The 6 s compaction result banner (web `compactResult`). */
    private fun showCompactResult(result: CompactResult?) {
        compactResultJob?.cancel()
        _ui.update { it.copy(compactResult = result, compactError = null) }
        if (result == null) return
        compactResultJob = viewModelScope.launch {
            delay(COMPACT_RESULT_VISIBLE_MILLIS)
            _ui.update { it.copy(compactResult = null) }
        }
    }

    /** The 3 s compaction failure banner (web `compactError`). */
    private fun showCompactError(message: String?) {
        compactErrorJob?.cancel()
        _ui.update { it.copy(compactError = message, compactResult = null) }
        if (message == null) return
        compactErrorJob = viewModelScope.launch {
            delay(COMPACT_ERROR_VISIBLE_MILLIS)
            _ui.update { it.copy(compactError = null) }
        }
    }

    /**
     * `sendQueued` of the web composer, used during a run and by dictation
     * transcripts with a stored `after` choice: web slash commands still
     * expand, everything else goes through steer/follow_up.
     */
    private fun queueOrSteer(submission: ComposerSubmission, route: ComposerRoute, mode: String) {
        val sid = sessionId ?: return
        val key = composer.currentDraftKey
        // A side question is never queued behind the run it sits beside.
        if (isSideQuestion(submission.raw)) {
            submitSideQuestion(submission)
            return
        }
        when (route) {
            is ComposerRoute.Usage -> {
                _events.tryEmit(
                    ChatEvent.Toast(composerStrings.requiresArgs(route.command, route.argumentHint)),
                )
                return
            }
            is ComposerRoute.WebPrompt -> {
                if (rejectsOversized(route.prompt, submission.images)) return
                dispatchQueued(sid, mode, route.prompt, submission.images, key)
            }
            is ComposerRoute.Bash, is ComposerRoute.Builtin, is ComposerRoute.Prompt ->
                dispatchQueued(sid, mode, submission.prompt, submission.images, key)
        }
    }

    private fun dispatchQueued(
        sid: String,
        mode: String,
        text: String,
        images: List<ComposerImage>,
        key: String?,
    ) {
        if (text.isBlank() && images.isEmpty()) return
        composer.clear()
        viewModelScope.launch {
            try {
                val reply = if (mode == "steer") api.steer(sid, text, images) else api.followUp(sid, text, images)
                if (isQueuedWhileShellRunning(reply)) {
                    _events.tryEmit(ChatEvent.Toast(composerStrings.queuedWhileShellRunning))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: ApiError) {
                // The queue call never reached omp: text and images go back to
                // the draft they were sent from, even after a session switch.
                if (error is ApiError.SessionSlow && error.maybeStarted) {
                    _events.tryEmit(ChatEvent.Toast(maybeStartedMessage))
                } else {
                    recoverDraft(key, text, images)
                    if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
                }
            } catch (error: Exception) {
                recoverDraft(key, text, images)
                if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
            }
        }
    }

    /** Put queued text back where it came from (`recoverDraft` in the web hook). */
    private fun recoverDraft(key: String?, text: String, images: List<ComposerImage>) {
        if (key.isNullOrEmpty() || (text.isEmpty() && images.isEmpty())) return
        drafts.recoverDraft(key, DraftRecovery(text = text, images = images))
        if (key == composer.currentDraftKey) composer.applyStoredDraft()
    }

    /**
     * A non-send command was refused because another omp process owns the chat
     * (server `409 session_running_elsewhere`). Show the ownership banner the
     * prompt path uses and say the command was not applied — the send wording
     * ("your message was not sent") would be wrong. Returns true when handled.
     */
    private fun reportForeignCommand(error: Exception): Boolean {
        if (error !is ApiError.SessionRunningElsewhere) return false
        engine.setForeignRun(error.elsewhere ?: engine.state.value.foreignRun)
        _events.tryEmit(ChatEvent.Toast(composerStrings.foreignCommandBlocked))
        return true
    }

    /** Returns true when the shell command actually started (the draft may clear). */
    private fun executeBash(invocation: BashInvocation): Boolean {
        val sid = sessionId ?: run {
            _events.tryEmit(ChatEvent.Toast(composerStrings.shellSessionFailed))
            return false
        }
        val state = engine.state.value
        if (state.bashRunning || state.busy) return false
        engine.bashStarted()
        viewModelScope.launch {
            try {
                api.bash(sid, invocation.command, invocation.excludeFromContext)
                requestHistory(reset = false)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val input = (if (invocation.excludeFromContext) "!!" else "!") + invocation.command
                if (!reportForeignCommand(error)) engine.notify(NoticeKind.Error, error.userMessage())
                composer.insertIfEmpty(input)
            } finally {
                engine.bashFinished()
                pumpEffects()
            }
        }
        return true
    }

    /**
     * Run a client-owned `/command`. The caller already knows it is ours; a
     * command that needs a session without one keeps the typed text.
     */
    private fun runBuiltinAction(name: String, args: String) {
        val sid = sessionId
        if (sid == null) {
            if (name in setOf("copy", "compact", "reload", "name", "session")) {
                _events.tryEmit(ChatEvent.Toast(composerStrings.noSession))
            }
            return
        }
        when (name) {
            "compact" -> {
                composer.clear()
                viewModelScope.launch {
                    try {
                        val reply = api.compact(sid, args.ifEmpty { null })
                        _events.tryEmit(ChatEvent.Toast(composerStrings.compactedContext))
                        val parsed = readCompactResult(reply, "manual")
                        if (parsed != null) {
                            showCompactResult(
                                CompactResult(
                                    reason = parsed.reason,
                                    tokensBefore = parsed.tokensBefore.toLong(),
                                    estimatedTokensAfter = parsed.estimatedTokensAfter.toLong(),
                                ),
                            )
                        }
                        requestHistory(reset = true)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
                    }
                }
            }
            "reload" -> {
                composer.clear()
                viewModelScope.launch {
                    try {
                        api.reload(sid)
                        _events.tryEmit(ChatEvent.Toast(composerStrings.reloadedResources))
                        requestHistory(reset = false)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
                    }
                }
            }
            "name" -> {
                if (args.isEmpty()) {
                    _events.tryEmit(ChatEvent.Toast(composerStrings.nameUsage))
                    return
                }
                composer.clear()
                viewModelScope.launch {
                    try {
                        api.setSessionName(sid, args)
                        _events.tryEmit(ChatEvent.Toast(composerStrings.renamed(args)))
                        loadMeta(sid)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
                    }
                }
            }
            "session" -> {
                composer.clear()
                controls.openContextSheet()
                controls.refreshSessionStats()
            }
            "copy" -> {
                composer.clear()
                viewModelScope.launch {
                    try {
                        val text = api.lastAssistantText(sid)
                        if (text.isNullOrBlank()) {
                            _events.tryEmit(ChatEvent.Toast(composerStrings.noMessageToCopy))
                        } else {
                            _events.emit(ChatEvent.CopyText(text))
                            _events.tryEmit(ChatEvent.Toast(composerStrings.copiedLastMessage))
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
                    }
                }
            }
        }
    }

    private fun rejectsOversized(prompt: String, images: List<ComposerImage>): Boolean {
        val error = validateOutgoingPrompt(prompt, images) ?: return false
        _events.tryEmit(ChatEvent.Toast(error))
        return true
    }

    private fun applyDictationResult(result: DictationResult) {
        val outcome = dictationOutcome(result, composer.state.value.text, hasSession = sessionId != null)
        if (outcome is DictationOutcome.Insert) {
            composer.insertAtCaret(outcome.text)
            return
        }
        // Build the submission from the composer so attached images and files
        // ride along, exactly like typing the transcript and pressing send.
        val submission = composer.resolve(overrideText = outcome.text) ?: return
        when (outcome) {
            is DictationOutcome.Send -> submitResolved(submission, forceQueue = false)
            is DictationOutcome.Steer -> queueOrSteer(submission, routeOf(submission), "steer")
            is DictationOutcome.FollowUp -> queueOrSteer(submission, routeOf(submission), "followUp")
            is DictationOutcome.Insert -> Unit
        }
    }

    private fun routeOf(submission: ComposerSubmission): ComposerRoute = routeComposerSubmission(
        raw = submission.raw,
        prompt = submission.prompt,
        hasAttachments = submission.hasAttachments,
        hasImages = submission.images.isNotEmpty(),
        bash = submission.bash,
    )

    // ------------------------------------------------------------- public API

    /**
     * Show [sessionId]; switching cancels the previous session's work.
     *
     * [elsewhere] is the session list's owner report for this session (its
     * `elsewhereSessions`). It seeds the banner right away, so a chat the list
     * already marks as "running elsewhere" never looks free while this chat's
     * own live-state read is still on the wire (or when it is refused).
     */
    fun open(sessionId: String, cwd: String?, elsewhere: ElsewhereSession? = null) {
        if (this.sessionId == sessionId) {
            if (cwd != null && cwd != this.cwd) {
                this.cwd = cwd
                composer.bind(sessionId, cwd, sessionId)
                controls.bind(sessionId, cwd)
                publish()
                loadMeta(sessionId)
            }
            // The owner can appear while the chat is open (a `running` frame
            // reaches the list first): the banner must not wait for a send.
            seedForeignRun(elsewhere)
            // A surface recreated after [onChatHidden] (rotation, back to the
            // chat) re-arms the consent scopes it dropped on dispose.
            onChatVisible()
            return
        }
        val previousId = this.sessionId
        // A submit still waiting for the live state belongs to the chat being
        // left: its composer is gone, and the new chat must not stay locked on
        // "Sending…" until that read (bounded, but still seconds) returns.
        abandonPendingSubmit()
        if (previousId != null) {
            scrollSaveJob?.cancel()
            val next = if (lastNearBottom) 0 else currentScrollIndex
            if (next != lastPersistedScroll) {
                viewModelScope.launch { settings.setChatScrollPosition(previousId, next) }
            }
        }
        this.sessionId = sessionId
        this.cwd = cwd
        val savedSession = savedStateHandle.get<String>(KEY_SESSION)
        val restoring = savedSession == sessionId
        val savedScroll = if (restoring) savedStateHandle.get<Int>(KEY_SCROLL) ?: 0 else 0
        val restore = savedScroll.takeIf { it > 0 }
            ?: settings.snapshot.value.chatScrollPositions[sessionId]
            ?: 0
        viewLeafId = if (restoring) savedStateHandle.get<String>(KEY_LEAF) else null
        detailLeafId = null
        historyCursor = null
        historyJob?.cancel()
        historyJob = null
        historyRequested = false
        pendingReset = false
        historyGeneration++
        settleJob?.cancel()
        dismissedNotices.clear()
        thinkingCache.clear()
        rowsCacheSource = null
        committedToolResults = emptyMap()
        forkCache = emptyList()
        currentScrollIndex = 0
        lastPersistedScroll = 0
        lastNearBottom = true
        savedStateHandle[KEY_SESSION] = sessionId
        savedStateHandle[KEY_LEAF] = viewLeafId
        savedStateHandle[KEY_SCROLL] = 0
        engine.setSession(sessionId, viewLeafId)
        // The list may already know the owner (it hears the `running` frames
        // first); the seed paints the banner before this chat's own read
        // answers, and that read still has the last word.
        seedForeignRun(elsewhere)
        // A search belongs to the transcript it was typed in; the reveal hit of
        // the session list survives the switch it triggered.
        val reveal = pendingReveals.remove(sessionId)
        _search.update { ChatSearchState(revealEntryId = reveal) }
        _ui.update {
            it.copy(
                sessionId = sessionId,
                branch = null,
                subagent = null,
                branchTree = emptyList(),
                branchHasBranch = false,
                githubRepo = null,
                restoreScrollIndex = restore.takeIf { index -> index > 0 },
                prefill = prefillBySession.remove(sessionId),
                activeGoal = settings.snapshot.value.activeGoals[sessionId],
                planObjective = null,
                systemPrompt = SystemPromptState.Idle,
                // A move belongs to the chat that was copied, not the next one.
                contentionCopy = null,
            )
        }
        composer.bind(sessionId, cwd, sessionId)
        controls.bind(sessionId, cwd.orEmpty())
        dictation.bindScope(sessionId)
        onChatVisible()
        hostTools.register(sessionId)
        startSubscription(sessionId)
        // Cache-first: the transcript may be the disk copy, and an idle session
        // has no event stream to say so (its channel is refused). One cheap
        // `GET /api/agent/{id}` settles the live state, so the footer can stop
        // saying "Connecting…" and report the real run state.
        reconcileNow()
        loadMeta(sessionId)
        // The session file's task toolResults hold finished runs from earlier
        // visits (web `loadSession` → `refreshSubagentHistory`).
        refreshSubagentHistory(sessionId)
        pumpEffects()
        pendingSideQuestions.remove(sessionId)?.let { raw -> askSideQuestion(raw) }
        // The last-view marker is written by the shell when it selects the
        // session (`SessionsViewModel.showSession`), before this detail 404s.
    }

    /**
     * The chat surface is on screen: host tools and extension panels may act
     * for this session. Extension panes are re-bound, which is idempotent for
     * the same session and re-shows the panels it kept while hidden.
     */
    fun onChatVisible() {
        val sid = sessionId ?: return
        hostTools.setViewedSession(sid)
        extensionUi.bind(sid)
        btw.bind(sid)
    }

    /**
     * The chat surface left the stage (list, rotation, sign-out). Nothing may
     * keep acting as if the user still watched this session: the host consent
     * scope closes, the extension panels stop being reachable and an active
     * dictation ends (same rule as the composer's ON_STOP in
     * `ReportVisibility`). The recognizer and recorder have no UI left to
     * report to; leaving them running would keep the microphone busy behind
     * the list. The extension panels themselves stay in `ExtensionUiController`
     * (its subscription keeps running) — [bind] drops them only on a session
     * change, and [clearSessionData] wipes them.
     */
    fun onChatHidden() {
        hostTools.setViewedSession(null)
        extensionUi.bind(null)
        btw.bind(null)
        if (dictation.state.value is DictationState.Recording) dictation.stop()
        dictation.setVisible(false)
    }

    /**
     * Drops every piece of the signed-in user's data this view model holds in
     * memory: transcript rows, the engine's messages, fetched thinking text,
     * subagent dialogs and the session subscription. `AppContainer`
     * (`clearLocalUserData`) clears the disk cache and bumps the session epoch
     * on sign-out, a server switch and a 401; this keeps the same data from
     * surviving in the heap (a debug/bugreport heap dump, or the next server's
     * UI).
     */
    fun clearSessionData() {
        // The waiting submit holds the drafted text of a chat that is being
        // dropped: it must not route it, and it must not keep a "Sending…"
        // flag for the next sign-in either.
        abandonPendingSubmit()
        historyJob?.cancel()
        historyJob = null
        historyRequested = false
        pendingReset = false
        historyGeneration++
        historyCursor = null
        metaJob?.cancel()
        metaJob = null
        subscriptionJob?.cancel()
        subscriptionJob = null
        settleJob?.cancel()
        settleJob = null
        scrollSaveJob?.cancel()
        scrollSaveJob = null
        subagentWatchJob?.cancel()
        subagentCompletionJob?.cancel()
        subagentTranscriptJob?.cancel()
        subagentDetailJob?.cancel()
        sessionId = null
        cwd = null
        viewLeafId = null
        detailLeafId = null
        savedStateHandle.remove<String>(KEY_SESSION)
        savedStateHandle.remove<String>(KEY_LEAF)
        rowsCacheSource = null
        rowsCache = emptyList()
        rowsCacheHideThinking = false
        thinkingCache.clear()
        dismissedNotices.clear()
        committedToolResults = emptyMap()
        forkCache = emptyList()
        prefillBySession.clear()
        pendingReveals.clear()
        pendingSideQuestions.clear()
        warnedSlashCommands.clear()
        lastSessionModelKey = null
        lastSessionThinking = null
        engine.setSession(null, null)
        composer.bind(null, null, null)
        hostTools.setViewedSession(null)
        extensionUi.reset()
        btw.bind(null)
        _search.value = ChatSearchState()
        _ui.value = ChatUiState(
            preferences = preferences,
            submitDuringRun = _ui.value.submitDuringRun,
            todoCollapsed = _ui.value.todoCollapsed,
            subagentsCollapsed = _ui.value.subagentsCollapsed,
            connection = eventMux.state.value,
        )
    }

    fun retryHistory() {
        requestHistory(reset = true)
    }

    /** Direct prompt send without composer state (tests and programmatic callers). */
    fun send(text: String) {
        val message = text.trim()
        if (message.isEmpty()) return
        sendPrompt(
            ComposerSubmission(
                raw = message,
                prompt = message,
                images = emptyList(),
                hasAttachments = false,
                bash = null,
            ),
            clearOnSuccess = false,
        )
    }

    /**
     * Start a prompt run. [submission] has already passed the composer's size
     * validation; the optimistic turn, settlement, `session_slow` handling and
     * the text rollback on failure are the web `handleSend` rules. [force]
     * appends `?force=1`: the send goes into a copy of a chat another omp
     * process owns, only ever after the user confirmed it.
     */
    private fun sendPrompt(
        submission: ComposerSubmission,
        clearOnSuccess: Boolean,
        force: Boolean = false,
    ): Boolean {
        val sid = sessionId ?: return false
        val message = submission.prompt.trim()
        val images = submission.images
        if (message.isEmpty() && images.isEmpty()) return false
        val state = engine.state.value
        if (state.busy || state.bashRunning) return false

        // omp runs TUI-only commands nowhere but its terminal; over RPC the text
        // reaches the model as literal slash text, so say it once per name.
        if (message.startsWith("/") && images.isEmpty()) {
            val name = message.removePrefix("/").substringBefore(' ').substringBefore('\n')
            val known = isClientBuiltinCommand(name) ||
                engine.state.value.remoteCommands.any { it.name == name || it.name == "skill:$name" }
            if (!known && name.isNotEmpty() && warnedSlashCommands.add(name)) {
                _events.tryEmit(ChatEvent.Toast(composerStrings.unknownCommand(name)))
            }
        }

        val key = composer.currentDraftKey
        val rawForRecovery = submission.raw
        val imagesForRecovery = images
        if (clearOnSuccess) composer.clear()

        val runId = ++runCounter
        engine.sendStarted(message, runId, command = message.startsWith("/") && images.isEmpty())
        ensureSubscribed(sid)
        // The wrapper starts with this prompt: (re)register the host-tool
        // bridge and re-read the live roster (web send path).
        hostTools.register(sid)
        refreshSubagentRoster(sid)
        viewModelScope.launch {
            try {
                val result = api.prompt(sid, message, images, force = force)
                if (engine.state.value.runId != runId) return@launch
                val root = result as? JsonObject
                val queued = root?.get("queued")?.jsonPrimitive?.booleanOrNull == true
                if (queued) {
                    val reason = root["reason"]?.jsonPrimitive?.contentOrNull
                    engine.promptQueued(
                        if (reason == "shellRunning") composerStrings.queuedWhileShellRunning else reason,
                    )
                } else {
                    scheduleSettlement(runId)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (engine.state.value.runId == runId) {
                    // The frame may already sit in omp's stdin: keep the
                    // optimistic turn and the run (sending stays locked) and
                    // only surface the hint. The next frame or successful
                    // reconcile settles it.
                    if (error is ApiError.SessionSlow && error.maybeStarted) {
                        engine.promptMaybeStarted(maybeStartedMessage)
                    } else if (error is ApiError.SessionRunningElsewhere) {
                        // Another omp process owns the chat (it started writing
                        // between our state read and the send). Nothing was
                        // sent: drop the optimistic turn, keep the text and
                        // offer the explicit copy.
                        engine.setForeignRun(error.elsewhere ?: engine.state.value.foreignRun)
                        engine.sendFailed(null)
                        recoverDraft(key, rawForRecovery, imagesForRecovery)
                        if (force) {
                            engine.notify(NoticeKind.Warning, composerStrings.foreignSendBlocked)
                        } else {
                            _ui.update { it.copy(foreignSend = submission) }
                        }
                    } else {
                        engine.sendFailed(error.userMessage())
                        // Hand the text back instead of losing it with the
                        // rolled-back bubble (web `chatInputRef.insertIfEmpty`).
                        recoverDraft(key, rawForRecovery, imagesForRecovery)
                    }
                }
            } finally {
                pumpEffects()
            }
        }
        return true
    }

    /** `abort_retry`: let the auto-retry banner stop waiting for the backoff. */
    fun abortRetry() {
        val sid = sessionId ?: return
        viewModelScope.launch {
            try {
                api.abortRetry(sid)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
            }
        }
    }

    // ------------------------------------------------------------------ queue

    /** Edit a queued chip: withdraw it from omp, then restore text and images. */
    fun editQueued(queue: String, text: String) {
        mutateQueued(queue, text) { result ->
            val restoredText = if (text == "[Image]" && result.images.isNotEmpty()) "" else text
            recoverDraft(sessionId, restoredText, result.images)
        }
    }

    /** Delete a queued chip (the UI asked for confirmation first). */
    fun deleteQueued(queue: String, text: String) {
        mutateQueued(queue, text) { }
    }

    private fun mutateQueued(
        queue: String,
        text: String,
        onRemoved: (QueuedMessageRemoval) -> Unit,
    ) {
        val sid = sessionId ?: return
        if (queueMutationInFlight || text.isEmpty()) return
        queueMutationInFlight = true
        viewModelScope.launch {
            try {
                val result = api.removeQueuedMessage(sid, text, queue)
                if (result.removed) {
                    onRemoved(result)
                } else {
                    _events.tryEmit(ChatEvent.Toast(composerStrings.queuedRemovalUnavailable))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
            } finally {
                queueMutationInFlight = false
            }
        }
    }

    /** Promote a queued follow-up into omp's steering queue. */
    fun steerQueued(text: String) {
        val sid = sessionId ?: return
        if (queueMutationInFlight || text.isEmpty()) return
        if (text !in engine.state.value.queue.followUp) return
        queueMutationInFlight = true
        viewModelScope.launch {
            try {
                if (!api.promoteQueuedMessage(sid, text)) {
                    _events.tryEmit(ChatEvent.Toast(composerStrings.queuedPromotionUnavailable))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
            } finally {
                queueMutationInFlight = false
            }
        }
    }

    /**
     * Republish the live tokens/s estimate without a frame. The composer
     * ticker calls this while a reply streams, so a stalled stream ages out
     * instead of keeping its last number.
     */
    fun refreshLiveRate() {
        engine.refreshLiveRate()
    }

    /** Stop a `!!` shell command or the run, restoring omp's queue to the draft. */
    fun stop() {
        val sid = sessionId ?: return
        if (engine.state.value.bashRunning) {
            viewModelScope.launch {
                try {
                    api.abortBash(sid)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
                }
            }
            return
        }
        if (_ui.value.stopping) return
        _ui.update { it.copy(stopping = true) }
        viewModelScope.launch {
            try {
                withdrawAndAbort(sid)
            } finally {
                pumpEffects()
                _ui.update { it.copy(stopping = false) }
                delay(ABORT_RECONCILE_MILLIS)
                reconcileNow()
            }
        }
    }

    /**
     * Port of `withdrawAndAbort`: `abort_and_restore_queue` twice, fenced to
     * the run captured at the click; when omp does not know the command, its
     * pending messages are withdrawn one by one before `abort`.
     */
    private suspend fun withdrawAndAbort(sid: String) {
        val runId = engine.state.value.runId
        val runsEnded = engine.state.value.runsEnded
        fun sameRun(): Boolean =
            engine.state.value.runId == runId && engine.state.value.runsEnded == runsEnded

        var restored: QueueRestore? = null
        var unsupported = false
        var failures = 0
        var abortUnconfirmed = false
        for (attempt in 0..1) {
            if (attempt > 0 && (!sameRun() || unsupported || abortUnconfirmed || restored != null)) break
            try {
                restored = api.abortAndRestoreQueue(sid)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                unsupported = error.message?.contains("Unknown command") == true ||
                    (error is ApiError.ServerResponse && error.code == "unknown_command")
                if (!unsupported) failures++
                if (error is ApiError.SessionSlow && error.abortUnconfirmed) abortUnconfirmed = true
            }
        }
        if (abortUnconfirmed) {
            _events.tryEmit(ChatEvent.Toast(stopUnconfirmedMessage))
            return
        }
        if (!unsupported) {
            val entries = restored?.entries.orEmpty()
            val texts = entries
                .filterNot { it.text == "[Image]" && it.images.isNotEmpty() }
                .map { it.text }
                .filter { it.isNotEmpty() }
            val images = entries.flatMap { it.images }
            if (texts.isNotEmpty() || images.isNotEmpty()) {
                recoverDraft(sid, texts.joinToString("\n\n"), images)
            }
            engine.abortSent()
            if (failures > 0 && texts.isEmpty()) {
                _events.tryEmit(ChatEvent.Toast(composerStrings.queueRestoreUncertain))
            }
            return
        }

        // omp before `abort_and_restore_queue`: withdraw first, abort second.
        val snapshot = engine.state.value.queue
        data class Entry(val text: String, val queue: String)
        val entries = snapshot.followUp.map { Entry(it, "followUp") } + snapshot.steering.map { Entry(it, "steering") }
        val removed = BooleanArray(entries.size)
        val restoredFlag = BooleanArray(entries.size)
        var recoveredBlock = ""
        var failed = false
        var cancelled = false

        fun recoverWithdrawn() {
            val fresh = entries.indices.filter { removed[it] && !restoredFlag[it] }.map { entries[it].text }
            if (fresh.isEmpty()) return
            for (index in entries.indices) if (removed[index]) restoredFlag[index] = true
            val block = entries.indices.filter { restoredFlag[it] }.joinToString("\n\n") { entries[it].text }
            drafts.recoverDraft(
                sid,
                DraftRecovery(
                    text = block,
                    replace = if (recoveredBlock.isEmpty()) null else DraftRecovery.Replace(recoveredBlock, fresh.joinToString("\n\n")),
                ),
            )
            if (sid == composer.currentDraftKey) composer.applyStoredDraft()
            recoveredBlock = block
        }

        kotlinx.coroutines.coroutineScope {
            val removals = entries.mapIndexed { index, entry ->
                async {
                    val queues = if (entry.queue == "followUp") listOf("followUp", "steering") else listOf("steering")
                    try {
                        for (queue in queues) {
                            if (queue == "steering" && entry.queue == "followUp" && !sameRun()) return@async
                            val result = api.removeQueuedMessage(sid, entry.text, queue)
                            if (result.removed) {
                                removed[index] = true
                                return@async
                            }
                        }
                    } catch (cancel: CancellationException) {
                        throw cancel
                    } catch (_: Exception) {
                        failed = true
                    }
                }
            }
            withTimeoutOrNull(WITHDRAW_BEFORE_ABORT_MILLIS) {
                removals.forEach { it.await() }
            }
            recoverWithdrawn()
            if (sameRun()) {
                try {
                    api.abort(sid)
                    engine.abortSent()
                } catch (cancel: CancellationException) {
                    throw cancel
                } catch (error: Exception) {
                    if (error is ApiError.SessionSlow && error.abortUnconfirmed) {
                        _events.tryEmit(ChatEvent.Toast(stopUnconfirmedMessage))
                    }
                }
            }
            removals.forEach { it.await() }
            recoverWithdrawn()
        }
        if (failed) {
            _events.tryEmit(ChatEvent.Toast(composerStrings.queueDiscardFailed))
        }
    }

    fun togglePreCompactionHistory() {
        engine.setIncludePreCompaction(!engine.state.value.includePreCompaction)
        pumpEffects()
    }

    fun dismissNotice(notice: ChatNotice) {
        dismissedNotices += noticeKey(notice)
        // Also drop it from the engine: the dedupe there would otherwise
        // swallow the same message for the rest of the session.
        engine.dismissNotice(notice)
        publish()
    }

    fun consumeRestoreScroll() {
        if (_ui.value.restoreScrollIndex != null) _ui.update { it.copy(restoreScrollIndex = null) }
    }

    /**
     * The transcript's first visible row. Only a reading position is
     * persisted; an end-anchored (bottom) view stores 0 so the next open jumps
     * to the newest turn.
     */
    fun onScrollPosition(rowIndex: Int, nearBottom: Boolean) {
        currentScrollIndex = rowIndex
        lastNearBottom = nearBottom
        val sid = sessionId ?: return
        val next = if (nearBottom) 0 else rowIndex
        if (next == lastPersistedScroll) return
        savedStateHandle[KEY_SCROLL] = next
        savedStateHandle[KEY_LEAF] = viewLeafId
        scrollSaveJob?.cancel()
        scrollSaveJob = viewModelScope.launch {
            delay(SCROLL_SAVE_DEBOUNCE_MILLIS)
            settings.setChatScrollPosition(sid, next)
            lastPersistedScroll = next
        }
    }

    fun onForeground() {
        requestHistory(reset = false)
        reconcileNow()
    }

    // ---------------------------------------------------------------- history

    private fun requestHistory(reset: Boolean) {
        if (sessionId == null) return
        if (reset) {
            pendingReset = true
            // A reset (branch/compaction/reconnect) must not publish the page
            // that is still in flight for the previous view.
            if (historyJob?.isActive == true) historyGeneration++
        }
        historyRequested = true
        if (historyJob?.isActive == true) return
        historyJob = viewModelScope.launch { historyLoop() }
    }

    private suspend fun historyLoop() {
        while (historyRequested) {
            historyRequested = false
            val sid = sessionId ?: return
            val reset = pendingReset
            pendingReset = false
            if (reset) historyCursor = null
            val generation = ++historyGeneration
            engine.pagesLoading(true)
            try {
                if (reset || historyCursor == null) {
                    loadFullHistory(sid, generation)
                } else {
                    loadIncrementalHistory(sid, generation)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (generation == historyGeneration && sessionId == sid) {
                    engine.historyRequestFailed(error.userMessage())
                }
            } finally {
                engine.pagesLoading(false)
            }
            if (generation == historyGeneration && sessionId != sid) return
            reconcileNow()
        }
    }

    /**
     * Whole display history in ONE request (web `loadContext`), then publish a
     * single replacement page. Paging through `?sync=1` pages up front would
     * re-read the session file per page and delay first paint on large files.
     *
     * Cache-first: the last response for exactly this view (session, leaf,
     * compaction setting) is painted while the request is on the wire, and the
     * response replaces it and refreshes the cache. Nothing is seeded when the
     * engine already holds content, so a live frame or a page that arrived
     * first always wins.
     */
    private suspend fun loadFullHistory(sid: String, generation: Int) {
        val request = HistoryView(
            // Frozen for the whole request: a server switch while the body is
            // on the wire must neither seed nor store under the new origin.
            origin = settings.snapshot.value.origin?.origin,
            leafId = viewLeafId,
            includePreCompaction = engine.state.value.includePreCompaction,
        )
        seedCachedHistory(sid, request, generation)
        val response = loadFullContext(sid, request)
        val page = ContextSync.parse(response.root)
        if (generation != historyGeneration || sessionId != sid) return
        if (request.origin != settings.snapshot.value.origin?.origin) return
        if (page.sessionId != null && page.sessionId != sid) return
        if (page.entryIds.size != page.messages.size) throw ChatHistoryException("Invalid history page")
        val loaded = page.copy(
            mode = "replace",
            baseEntryId = null,
            cursor = null,
            hasMore = false,
            sessionId = sid,
        )
        // Later appends page from the delivered tail (live events, agent_end).
        historyCursor = HistoryCursor(page.entryIds.firstOrNull(), page.entryIds.lastOrNull())
        engine.applyContextPage(loaded)
        storeCachedHistory(sid, request, response.body, page)
    }

    /**
     * The view a full-history request is answered for: the cache key's other
     * half plus the origin the request went to. The origin is captured when
     * the request starts, never when its answer is written.
     */
    private data class HistoryView(
        val origin: String?,
        val leafId: String?,
        val includePreCompaction: Boolean,
    )

    /** One `GET .../context` answer: the body as sent, plus the parsed root. */
    private data class HistoryResponse(val body: String?, val root: JsonObject)

    /**
     * Paints the cached transcript of [view] before the request leaves. Only
     * an empty engine is seeded, and only the transcript half of the page: the
     * cached live snapshot (stream cursor, running tools) is stale by
     * definition and must never be replayed.
     */
    private suspend fun seedCachedHistory(sid: String, view: HistoryView, generation: Int) {
        val cache = transcripts ?: return
        val origin = view.origin ?: return
        val body = withContext(cacheDispatcher) {
            cache.read(origin, sid, view.leafId, view.includePreCompaction)
        } ?: return
        if (generation != historyGeneration || sessionId != sid) return
        if (settings.snapshot.value.origin?.origin != origin) return
        val page = runCatching {
            ContextSync.parse(Json.parseToJsonElement(body).jsonObject)
        }.getOrNull() ?: return
        if (page.sessionId != null && page.sessionId != sid) return
        if (page.entryIds.size != page.messages.size) return
        engine.seedCachedHistory(
            page.copy(
                mode = "replace",
                baseEntryId = null,
                cursor = null,
                hasMore = false,
                sessionId = sid,
                live = null,
            ),
        )
    }

    /** Refreshes the cache with a complete answer for [view]. */
    private suspend fun storeCachedHistory(
        sid: String,
        view: HistoryView,
        body: String?,
        page: ContextPage,
    ) {
        val cache = transcripts ?: return
        if (body.isNullOrEmpty() || page.messages.isEmpty() || page.hasMore) return
        val origin = view.origin ?: return
        // The answer belongs to the server the request went to. A switch while
        // it was on the wire (the container already wiped the disk cache) must
        // not file another installation's transcript — nor undo the wipe.
        if (settings.snapshot.value.origin?.origin != origin) return
        withContext(cacheDispatcher) {
            cache.write(origin, sid, view.leafId, view.includePreCompaction, body)
        }
    }

    /**
     * The whole history root for [sid]. omp does not write the session file
     * until the first assistant message exists, so a session that is already
     * running can answer 404 without a load problem — the server's sync route
     * answers an empty page for exactly this case. Treat that 404 as the empty
     * transcript it is (a notification tap into a dialog of a fresh session
     * must not paint a load error); a 404 from a session the server no longer
     * runs keeps the error.
     */
    private suspend fun loadFullContext(sid: String, view: HistoryView): HistoryResponse {
        try {
            val body = api.contextFullRaw(
                sessionId = sid,
                leafId = view.leafId,
                includePreCompaction = view.includePreCompaction,
            )
            return HistoryResponse(body, parseContextBody(body))
        } catch (missing: ApiError.Http) {
            if (missing.code != 404 || !sessionIsLive(sid)) throw missing
            return HistoryResponse(null, JsonObject(emptyMap()))
        }
    }

    /**
     * Same contract as the HTTP client's `decode`: a body that is not a JSON
     * object is an `ApiError.Http`, not a crash inside the history loop.
     */
    private fun parseContextBody(body: String): JsonObject = try {
        Json.parseToJsonElement(body).jsonObject
    } catch (error: SerializationException) {
        throw ApiError.Http(200, body.take(2048))
    }

    /** `GET /api/agent/{id}`: the server still has a runner (child) for [sid]. */
    private suspend fun sessionIsLive(sid: String): Boolean = try {
        val body = api.agentState(sid)
        // `alive` is the child; `running` is a turn in flight. An idle wrapper
        // still serves the session, so only `alive` answers this. An older
        // server has no `alive` and used `running` for exactly this.
        (body["alive"] ?: body["running"])?.jsonPrimitive?.booleanOrNull == true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        false
    }

    /** One append page; a reset/truncation answer falls back to a full reload. */
    private suspend fun loadIncrementalHistory(sid: String, generation: Int) {
        var cursor = historyCursor ?: return loadFullHistory(sid, generation)
        var pages = 0
        while (true) {
            val page = fetchPage(sid, encodeCursor(cursor))
            if (generation != historyGeneration || sessionId != sid) return
            if (page.sessionId != null && page.sessionId != sid) return
            if (page.entryIds.size != page.messages.size) throw ChatHistoryException("Invalid history page")
            val appendable = page.mode == "append" &&
                page.baseEntryId == engine.state.value.entryIds.lastOrNull()
            if (!appendable) {
                // The selected branch, compaction view or the file changed.
                return loadFullHistory(sid, generation)
            }
            engine.applyContextPage(page)
            val next = page.cursor ?: break
            cursor = next
            historyCursor = next
            pages++
            if (!page.hasMore || pages > MAX_PAGES) break
        }
    }

    private suspend fun fetchPage(sid: String, cursor: String?): ContextPage {
        val root = api.contextSync(
            sessionId = sid,
            cursor = cursor,
            leafId = viewLeafId,
            includePreCompaction = engine.state.value.includePreCompaction,
        )
        return ContextSync.parse(root)
    }

    private fun encodeCursor(cursor: HistoryCursor?): String? {
        if (cursor?.lastEntryId == null) return null
        return buildJsonObject {
            put("firstEntryId", cursor.firstEntryId)
            put("lastEntryId", cursor.lastEntryId)
        }.toString()
    }

    // ----------------------------------------------------------- meta & branch

    private fun loadMeta(sid: String) {
        metaJob?.cancel()
        metaJob = viewModelScope.launch {
            try {
                val detail = api.sessionDetail(sid)
                if (sessionId != sid) return@launch
                detailLeafId = detail.leafId
                val tree = BranchTree.parse(detail.tree)
                _ui.update {
                    it.copy(
                        branchTree = tree,
                        branchHasBranch = BranchTree.hasBranch(tree),
                        branch = it.branch,
                    )
                }
                if (tree.isNotEmpty() && _ui.value.branch != null) openBranchNavigator()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // A running-only session has no file yet; the branch tree is
                // simply empty until the first write.
            }
            val directory = cwd
            if (directory.isNullOrBlank()) return@launch
            try {
                val repo = api.githubRepo(directory) ?: return@launch
                val slash = repo.indexOf('/')
                if (slash <= 0 || slash == repo.lastIndex) return@launch
                if (sessionId != sid) return@launch
                _ui.update {
                    it.copy(githubRepo = GithubRepoRef(repo.substring(0, slash), repo.substring(slash + 1)))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Not a GitHub checkout, or the cwd is outside the allowed roots.
            }
        }
    }

    fun openBranchNavigator() {
        val tree = _ui.value.branchTree
        val active = viewLeafId ?: detailLeafId
        _ui.update {
            it.copy(branch = BranchNavigatorState(BranchTree.rows(tree, active)))
        }
    }

    fun closeBranchNavigator() {
        _ui.update { it.copy(branch = null) }
    }

    /** Returns false when the view cannot branch (a running turn owns the transcript). */
    fun selectLeaf(leafId: String?): Boolean {
        if (engine.state.value.busy) return false
        viewLeafId = leafId
        savedStateHandle[KEY_LEAF] = leafId
        engine.setLeaf(leafId)
        _ui.update { state ->
            state.copy(restoreScrollIndex = null)
        }
        pumpEffects()
        return true
    }

    /**
     * "Edit from here" on a user row: branch the view back to the assistant
     * answer before that turn and put its text into the composer, without
     * forking the session (web `ChatWindow` edit affordance). Like the web
     * (`MessageView` only prefills after `onNavigate()` succeeded, and
     * `insertIfEmpty` never overwrites a draft), a failed navigation aborts
     * and an existing draft stays untouched.
     */
    fun editFromHere(prevAssistantEntryId: String, text: String) {
        if (!selectLeaf(prevAssistantEntryId)) return
        if (composer.state.value.text.isNotBlank()) return
        composer.setText(text)
    }

    // ------------------------------------------------------------------ fork

    fun fork(entryId: String, editPrompt: Boolean) {
        val sid = sessionId ?: return
        if (engine.state.value.busy) return
        if (_ui.value.forkingEntryId != null) return
        _ui.update { it.copy(forkingEntryId = entryId) }
        viewModelScope.launch {
            try {
                val outcome = api.forkSession(sid, entryId)
                val newSessionId = outcome.newSessionId
                when {
                    // omp skipped the branch (a run was in flight); saying so is
                    // the only feedback the user would get otherwise.
                    outcome.cancelled -> _events.tryEmit(ChatEvent.ForkCancelled)
                    newSessionId.isNullOrBlank() -> _events.tryEmit(ChatEvent.ForkFailed)
                    else -> {
                        if (editPrompt) {
                            val text = outcome.text.orEmpty()
                            if (text.isNotBlank()) prefillBySession[newSessionId] = text
                        }
                        _events.tryEmit(ChatEvent.Forked(newSessionId))
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (!reportForeignCommand(error)) _events.tryEmit(ChatEvent.Toast(error.userMessage()))
            } finally {
                _ui.update { it.copy(forkingEntryId = null) }
            }
        }
    }

    // -------------------------------------------------------- thinking & files

    fun loadThinking(entryId: String?, blockIndex: Int) {
        val sid = sessionId ?: return
        if (entryId == null) return
        val key = thinkingKey(entryId, blockIndex)
        if (thinkingCache[key] != null) return
        thinkingCache[key] = ThinkingEntry.Loading
        publish()
        viewModelScope.launch {
            try {
                val text = api.thinking(sid, entryId, blockIndex)
                putThinking(key, ThinkingEntry.Text(text))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                putThinking(key, ThinkingEntry.Error(error.userMessage()))
            }
        }
    }

    private fun putThinking(key: String, entry: ThinkingEntry) {
        thinkingCache[key] = entry
        while (thinkingCache.size > THINKING_CACHE_LIMIT) {
            val oldest = thinkingCache.keys.first()
            thinkingCache.remove(oldest)
        }
        publish()
    }

    /** Fetch the full output a truncated `bashExecution` row points at. */
    fun loadBashOutput(path: String) {
        val sid = sessionId ?: return
        if (_ui.value.bashOutputs[path] is BashOutputUi.Ready) return
        _ui.update { it.copy(bashOutputs = it.bashOutputs + (path to BashOutputUi.Loading)) }
        viewModelScope.launch {
            val next = try {
                when (val result = api.bashOutput(sid, path)) {
                    is io.github.kahme247.ompweb.net.BashOutputResult.Text -> BashOutputUi.Ready(result.output)
                    is io.github.kahme247.ompweb.net.BashOutputResult.TooLarge ->
                        BashOutputUi.Error("Output is too large to preview (${formatBytes(result.size)}).")
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                BashOutputUi.Error(error.userMessage())
            }
            _ui.update { it.copy(bashOutputs = it.bashOutputs + (path to next)) }
        }
    }

    /** The raw bytes of a truncated bash output, for SAF download. */
    suspend fun bashOutputBytes(path: String): ByteArray? {
        val sid = sessionId ?: return null
        return try {
            api.bashOutputBytes(sid, path)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            _events.tryEmit(ChatEvent.Toast(error.userMessage()))
            null
        }
    }

    /** A transcript link (`agent://<id>` or a dotted child id) opens its dialog. */
    fun openSubagent(handle: String) {
        if (sessionId == null) return
        // A handle the transcript route would reject never reaches the dialog.
        val ids = io.github.kahme247.ompweb.ui.render.agentLinkIds(handle)
            .ifEmpty { listOf(handle.removePrefix("agent://")) }
            .filter { isValidSubagentId(it) }
        if (ids.isEmpty()) return
        val roster = engine.state.value.subagents
        val known = ids.firstNotNullOfOrNull { id -> roster.firstOrNull { it.id == id } }
        // Unknown handles get a synthetic history entry (web `agentLinkTarget`),
        // so the completion fetch decides what the dialog can show.
        val target = known ?: SubagentInfo(
            id = ids.last(),
            agent = ids.last(),
            status = io.github.kahme247.ompweb.domain.SubagentStatus.COMPLETED,
            index = 0,
            source = SubagentSource.HISTORY,
        )
        openSubagentDialog(target)
    }

    /** A roster chip opens the dialog with its live data. */
    fun openSubagent(info: SubagentInfo) {
        if (sessionId == null) return
        openSubagentDialog(info)
    }

    fun closeSubagent() {
        subagentWatchJob?.cancel()
        subagentWatchJob = null
        subagentCompletionJob?.cancel()
        subagentTranscriptJob?.cancel()
        subagentDetailJob?.cancel()
        subagentRequestSeq++
        transcriptRequestSeq++
        _ui.update { it.copy(subagent = null) }
    }

    /** Show or hide the raw transcript; opening it fetches the first page. */
    fun toggleSubagentTranscript() {
        val current = _ui.value.subagent ?: return
        val open = !current.transcript.open
        _ui.update { state ->
            val dialog = state.subagent ?: return@update state
            state.copy(subagent = dialog.copy(transcript = dialog.transcript.copy(open = open)))
        }
        if (open && current.transcript.messages.isEmpty() && !current.transcript.loading) {
            loadSubagentTranscriptPage(0L)
        }
    }

    fun loadMoreSubagentTranscript() {
        val current = _ui.value.subagent ?: return
        if (current.transcript.loading || current.transcript.exhausted) return
        loadSubagentTranscriptPage(current.transcript.nextByte)
    }

    private fun openSubagentDialog(info: SubagentInfo) {
        // Roster chips and synthetic handles share this chokepoint: an id the
        // transcript route rejects must not open a dialog that can only 400.
        if (!isValidSubagentId(info.id)) return
        // Bumped sequences invalidate every in-flight fetch of the previous dialog.
        subagentRequestSeq++
        transcriptRequestSeq++
        subagentWatchJob?.cancel()
        subagentCompletionJob?.cancel()
        subagentTranscriptJob?.cancel()
        subagentDetailJob?.cancel()
        // Per-subagent version counters must start at zero (web resets them on
        // open): a value carried over would skip the next refetch.
        refetchedSubagentVersion = 0L
        refetchedTranscriptVersion = 0L
        latestSubagentVersion = 0L
        _ui.update { it.copy(subagent = initialDialogState(info)) }
        watchSubagentVersions(info.id)
        loadSubagentCompletion(info.id)
    }

    private fun initialDialogState(info: SubagentInfo): SubagentDialogState {
        val progress = info.progress
        val history = info.source == SubagentSource.HISTORY
        return SubagentDialogState(
            id = info.id,
            loading = true,
            agent = info.agent,
            description = info.description,
            task = info.task ?: info.assignment,
            sessionFile = info.sessionFile,
            resolvedModel = progress?.resolvedModel,
            tokens = progress?.tokens,
            cost = progress?.cost,
            durationMs = progress?.durationMs,
            live = !history,
            activity = subagentActivity(info.id),
            outcomeError = if (history) info.result?.abortReason ?: info.result?.error else null,
        )
    }

    /** Roster updates (progress/lifecycle) refresh the open dialog's header. */
    private fun syncDialog(current: SubagentDialogState, info: SubagentInfo): SubagentDialogState {
        val progress = info.progress
        val history = info.source == SubagentSource.HISTORY
        return current.copy(
            agent = info.agent,
            description = info.description ?: current.description,
            task = info.task ?: info.assignment ?: current.task,
            sessionFile = info.sessionFile ?: current.sessionFile,
            resolvedModel = progress?.resolvedModel ?: current.resolvedModel,
            tokens = progress?.tokens ?: current.tokens,
            cost = progress?.cost ?: current.cost,
            durationMs = progress?.durationMs ?: current.durationMs,
            live = !history,
            activity = subagentActivity(info.id),
            outcomeError = if (history) info.result?.abortReason ?: info.result?.error else current.outcomeError,
        )
    }

    private fun subagentActivity(id: String): List<SubagentActivityEvent> =
        engine.state.value.subagentActivity[id].orEmpty().takeLast(4)

    /** Fetch the settled `<id>.md` output; live snapshots only enrich the header. */
    private fun loadSubagentCompletion(id: String) {
        val sid = sessionId ?: return
        val seq = ++subagentRequestSeq
        subagentCompletionJob?.cancel()
        _ui.update { state ->
            val dialog = state.subagent
            if (dialog != null && dialog.id == id) {
                state.copy(subagent = dialog.copy(loading = true, error = null))
            } else {
                state
            }
        }
        subagentCompletionJob = viewModelScope.launch {
            try {
                var completion: String? = null
                var truncated = false
                try {
                    val found = api.subagentCompletion(sid, id)
                    completion = found.completion
                    truncated = found.truncated
                } catch (error: ApiError.ServerResponse) {
                    // 404: no settled output (or no session file yet).
                    if (error.status != 404) throw error
                }
                // Live snapshots enrich the header (resolved model etc.) but
                // carry no settled output; the disk `<id>.md` is the source.
                if (completion == null && _ui.value.subagent?.live == true) {
                    val snapshot = fetchSubagentSnapshot(sid, id)
                    if (seq != subagentRequestSeq) return@launch
                    snapshot?.let { applySubagentDetail(it) }
                }
                if (seq != subagentRequestSeq) return@launch
                _ui.update { state ->
                    val dialog = state.subagent
                    if (dialog == null || dialog.id != id) return@update state
                    state.copy(
                        subagent = dialog.copy(
                            loading = false,
                            completion = completion,
                            truncated = truncated,
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (seq != subagentRequestSeq) return@launch
                // A failed refetch re-arms the version so the next bump retries.
                refetchedSubagentVersion = 0L
                _ui.update { state ->
                    val dialog = state.subagent
                    if (dialog == null || dialog.id != id) return@update state
                    state.copy(subagent = dialog.copy(loading = false, error = error.userMessage()))
                }
            }
        }
    }

    /** `get_subagents` lookup for the dialog's live header enrichment. */
    private suspend fun fetchSubagentSnapshot(sid: String, id: String): SubagentInfo? {
        val root = api.subagents(sid) as? JsonObject ?: return null
        val snapshots = (root["subagents"] as? kotlinx.serialization.json.JsonArray).orEmpty()
        return snapshots
            .mapNotNull { parseSubagentSnapshot(it, System.currentTimeMillis()) }
            .firstOrNull { it.id == id }
    }

    private fun applySubagentDetail(detail: SubagentInfo) {
        _ui.update { state ->
            val dialog = state.subagent
            if (dialog == null || dialog.id != detail.id) return@update state
            state.copy(
                subagent = dialog.copy(
                    agent = detail.agent,
                    description = detail.description ?: dialog.description,
                    task = detail.task ?: detail.assignment ?: dialog.task,
                    sessionFile = detail.sessionFile ?: dialog.sessionFile,
                    resolvedModel = detail.progress?.resolvedModel ?: dialog.resolvedModel,
                    tokens = detail.progress?.tokens ?: dialog.tokens,
                    cost = detail.progress?.cost ?: dialog.cost,
                    durationMs = detail.progress?.durationMs ?: dialog.durationMs,
                ),
            )
        }
    }

    /**
     * One page of the raw child transcript: RPC registry first, disk reader as
     * the fallback for a live entry whose wrapper restarted (web rule).
     */
    private fun loadSubagentTranscriptPage(startByte: Long) {
        val sid = sessionId ?: return
        val dialog = _ui.value.subagent ?: return
        val id = dialog.id
        if (!isValidSubagentId(id)) return
        val seq = ++transcriptRequestSeq
        subagentTranscriptJob?.cancel()
        _ui.update { state ->
            val current = state.subagent
            if (current != null && current.id == id) {
                state.copy(subagent = current.copy(transcript = current.transcript.copy(loading = true, error = null)))
            } else {
                state
            }
        }
        subagentTranscriptJob = viewModelScope.launch {
            try {
                val fromDisk = !dialog.live
                val page = try {
                    if (fromDisk) {
                        api.subagentTranscriptDisk(sid, id, startByte)
                    } else {
                        api.subagentTranscript(sid, id, dialog.sessionFile, startByte)
                    }
                } catch (error: Exception) {
                    if (error is CancellationException) throw error
                    // The RPC registry only knows children of the current
                    // process; a live entry from a restarted session falls
                    // back to the disk reader.
                    if (fromDisk) throw error
                    api.subagentTranscriptDisk(sid, id, startByte)
                }
                if (seq != transcriptRequestSeq) return@launch
                val parsed = parseSubagentTranscriptPage(page)
                    ?: throw ChatHistoryException("Invalid transcript page")
                _ui.update { state ->
                    val current = state.subagent
                    if (current == null || current.id != id) return@update state
                    val transcript = current.transcript
                    val messages = if (parsed.reset) parsed.messages else transcript.messages + parsed.messages
                    state.copy(
                        subagent = current.copy(
                            transcript = transcript.copy(
                                messages = messages,
                                nextByte = parsed.nextByte,
                                loading = false,
                                error = null,
                                exhausted = parsed.exhausted || parsed.nextByte <= parsed.fromByte,
                            ),
                        ),
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (seq != transcriptRequestSeq) return@launch
                _ui.update { state ->
                    val current = state.subagent
                    if (current == null || current.id != id) return@update state
                    state.copy(
                        subagent = current.copy(
                            transcript = current.transcript.copy(loading = false, error = error.userMessage()),
                        ),
                    )
                }
            }
        }
    }

    /**
     * Live child frames bump a per-subagent version; the open dialog debounces
     * (600 ms) a completion refetch and, while the transcript is open, the next
     * page. The latest version is never dropped: a bump mid-flight re-arms.
     */
    private fun watchSubagentVersions(id: String) {
        subagentWatchJob?.cancel()
        subagentWatchJob = viewModelScope.launch {
            engine.state
                .map { it.subagentVersions[id] ?: 0L }
                .distinctUntilChanged()
                .collectLatest { version ->
                    if (version == 0L) return@collectLatest
                    if (
                        version == refetchedSubagentVersion &&
                        version == latestSubagentVersion &&
                        version == refetchedTranscriptVersion
                    ) {
                        return@collectLatest
                    }
                    latestSubagentVersion = version
                    // A newer frame re-arms the timer instead of stacking fetches.
                    delay(SUBAGENT_REFETCH_DEBOUNCE_MILLIS)
                    if (version != refetchedSubagentVersion) {
                        refetchedSubagentVersion = version
                        loadSubagentCompletion(id)
                    }
                    val current = _ui.value.subagent
                    if (
                        current?.id == id &&
                        current.transcript.open &&
                        !current.transcript.loading &&
                        refetchedTranscriptVersion != latestSubagentVersion
                    ) {
                        refetchedTranscriptVersion = latestSubagentVersion
                        loadSubagentTranscriptPage(current.transcript.nextByte)
                    }
                }
        }
    }


    // --------------------------------------------------------- subagent roster

    /**
     * Hydrate the LIVE roster from `get_subagents` (web `refreshSubagentRoster`).
     *
     * Fenced after the await by session, run and roster generation: a snapshot
     * that resolves after a session switch, a new prompt or a roster clear
     * belongs to a different roster and must neither merge nor prune.
     */
    private fun refreshSubagentRoster(sid: String) {
        val requestedAt = System.currentTimeMillis()
        val runId = engine.state.value.runId
        val generation = engine.subagentGeneration()
        viewModelScope.launch {
            try {
                val root = api.subagents(sid) as? JsonObject ?: return@launch
                if (
                    sessionId != sid ||
                    engine.state.value.runId != runId ||
                    engine.subagentGeneration() != generation
                ) {
                    return@launch
                }
                val snapshots = (root["subagents"] as? kotlinx.serialization.json.JsonArray)
                    .orEmpty()
                    .mapNotNull { parseSubagentSnapshot(it, requestedAt) }
                // A point-in-time view never overwrites entries live frames
                // updated after the request was made.
                engine.mergeSubagents(snapshots, skipNewerThan = requestedAt)
                // The registry deletes a child before `get_subagents` returns
                // once its lifecycle is terminal; a live entry missing from the
                // snapshot lost a terminal frame. Entries newer than the request
                // survive the prune.
                engine.pruneLiveSubagents(snapshots.mapTo(HashSet()) { it.id }, requestedAt)
                // Mid-run disk history can hold children that finished before
                // the subscription attached.
                refreshSubagentHistory(sid)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Best effort: lifecycle/progress frames are the primary source.
            }
        }
    }

    /**
     * Recover the ON-DISK roster (the parent's `task` toolResults); survives
     * reloads and shows finished runs from earlier visits (web
     * `refreshSubagentHistory`).
     */
    private fun refreshSubagentHistory(sid: String) {
        val generation = engine.subagentGeneration()
        viewModelScope.launch {
            try {
                // A 404 means "no on-disk history yet".
                val root = api.subagentHistory(sid) as? JsonObject ?: return@launch
                if (sessionId != sid || engine.subagentGeneration() != generation) return@launch
                val entries = (root["subagents"] as? kotlinx.serialization.json.JsonArray)
                    .orEmpty()
                    .mapNotNull { parseSubagentHistoryEntry(it) }
                engine.mergeSubagents(entries)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Best effort; live frames win while a run is active.
            }
        }
    }

    // ----------------------------------------------------------------- speech

    fun toggleSpeech(entryId: String?, key: String, text: String) {
        speech.toggle(entryId ?: key, text)
    }

    fun stopSpeech() {
        speech.stop()
    }

    /** Bind the TTS service once the transcript is on screen. */
    fun prepareSpeech() {
        speech.prepare()
    }

    private fun autoplaySpeech() {
        if (!preferences.ttsAutoplay) return
        val messages = engine.state.value.messages
        val latest = messages.asReversed().firstOrNull { message ->
            message is ChatMessage.Assistant && message.streaming.not()
        } as? ChatMessage.Assistant ?: return
        val text = latest.blocks.filterIsInstance<io.github.kahme247.ompweb.chat.AssistantBlock.Text>()
            .joinToString("\n\n") { it.text }
        if (text.isBlank()) return
        speech.speak(latest.entryId ?: latest.key, text)
    }

    // --------------------------------------------------------------- transport

    private fun startSubscription(sid: String) {
        subscriptionJob?.cancel()
        subscriptionJob = viewModelScope.launch {
            var retryMillis = 0L
            while (isActive) {
                if (retryMillis > 0) delay(retryMillis)
                try {
                    eventMux.subscribe(EventChannel.Session(sid)).collect { frame ->
                        if (sessionId != sid) return@collect
                        // Live again: a later drop starts a fresh backoff.
                        retryMillis = SUBSCRIBE_RETRY_MIN_MILLIS
                        // Slice C consumes its own request/bridge frames so the
                        // transcript never sees them; side-question frames are
                        // consumed inside the engine ahead of `observe`.
                        if (hostTools.onFrame(sid, frame)) return@collect
                        if (extensionUi.onFrame(frame)) return@collect
                        controls.onFrame(frame)
                        engine.onFrame(frame)
                        // The engine's coalescer owns the flush (16 ms), matching
                        // the web's message-update coalescer; flushing per frame
                        // defeated it.
                        pumpEffects()
                    }
                    retryMillis = SUBSCRIBE_RETRY_MIN_MILLIS
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    // An idle session has no server-side wrapper, so the channel
                    // is refused; the web retries silently with capped backoff
                    // instead of surfacing an error. The next prompt restarts
                    // this loop immediately (see ensureSubscribed).
                    retryMillis = (retryMillis * 2).coerceIn(
                        SUBSCRIBE_RETRY_MIN_MILLIS,
                        SUBSCRIBE_RETRY_MAX_MILLIS,
                    )
                }
                if (sessionId != sid) return@launch
            }
        }
    }

    private fun ensureSubscribed(sid: String) {
        // The prompt creates the server-side wrapper; a subscription stuck in
        // the idle-session backoff must not delay the live stream.
        startSubscription(sid)
    }

    private fun pumpEffects() {
        if (pumpingEffects) return
        pumpingEffects = true
        try {
            while (true) {
                val effects = engine.drainEffects()
                if (effects.isEmpty()) break
                for (effect in effects) {
                    when (effect) {
                        is ChatEffect.RequestContext -> requestHistory(effect.reset)
                        ChatEffect.RequestAgentState -> reconcileNow()
                        ChatEffect.SpeakLastReply -> autoplaySpeech()
                        ChatEffect.PlayCompletionTone -> {
                            if (settings.snapshot.value.soundEnabled) completionSound.play()
                        }
                        is ChatEffect.ShowCompactResult -> showCompactResult(effect.result)
                        is ChatEffect.ShowCompactError -> showCompactError(effect.message)
                        // Run end: the registry is empty, the file holds this run's
                        // children; re-read both so the roster survives a missed frame.
                        ChatEffect.RefreshSubagents -> sessionId?.let { sid ->
                            refreshSubagentRoster(sid)
                            refreshSubagentHistory(sid)
                        }
                        // (Re)connected: register the bridges and re-read the side
                        // questions + roster the stream may have missed.
                        ChatEffect.StreamOpened -> sessionId?.let { sid ->
                            btw.onStreamOpen()
                            hostTools.register(sid)
                            refreshSubagentRoster(sid)
                            refreshSubagentHistory(sid)
                        }
                        // The conversation continued in a copy: keep the
                        // original reachable from the chat the user is in.
                        is ChatEffect.ContentionFork -> _ui.update {
                            it.copy(contentionCopy = ContentionCopy(effect.fromId, effect.toId))
                        }
                    }
                }
            }
        } finally {
            pumpingEffects = false
        }
    }

    private fun scheduleSettlement(runId: Long) {
        settleJob?.cancel()
        settleJob = viewModelScope.launch {
            delay(PROMPT_SETTLE_FIRST_MILLIS)
            repeat(PROMPT_SETTLE_ATTEMPTS) {
                if (engine.state.value.runId != runId) return@launch
                // Not a poll: this one-shot look after a send must not advance
                // the bounded "unknown" window, or "three consecutive polls"
                // would already be reached by the settlement alone. The
                // periodic reconcile loop is the only counter (web
                // `waitForPromptSettlement` does not count either).
                if (reconcileOnce(countSlowAnswer = false)) return@launch
                delay(PROMPT_SETTLE_INTERVAL_MILLIS)
            }
        }
    }

    /**
     * Asks for the live state once. [countSlowAnswer] marks a **poll**: an
     * answer without a run state then advances the unknown window. A read that
     * merely follows an open/refresh is not a poll — opening a chat fires
     * several of them at the same instant (the open itself, the connection
     * becoming live, the first history page landing), and counting each would
     * exhaust the window before the first timer tick. The window must measure
     * the polling cadence, not how many triggers happened to fire.
     */
    private fun reconcileNow(countSlowAnswer: Boolean = false) {
        viewModelScope.launch { reconcileOnce(countSlowAnswer) }
    }

    /** What a `GET /api/agent/{id}` says about the session. */
    private sealed interface LiveRead {
        /** omp answered: a turn (or a compacting run) is live. */
        data object Running : LiveRead

        /** omp answered: nothing is running. */
        data object Idle : LiveRead

        /** No session, a read is already on the wire, or its answer is stale. */
        data object Skipped : LiveRead

        /**
         * omp answered 503 `session_slow`: alive but blocked (a large session),
         * so a run is under way with an unknown state — never an ended one. The
         * engine keeps showing it as running and the next poll settles it.
         */
        data object Slow : LiveRead

        /** The read did not answer; the live state stays unknown. */
        data class Failed(val error: Exception) : LiveRead
    }

    /**
     * Returns true once the agent owns the run (stream/state took over). A slow
     * session counts: it is still running, so the settlement attempts must stop
     * hammering a blocked child; the periodic poll keeps watching it.
     */
    private suspend fun reconcileOnce(countSlowAnswer: Boolean = false): Boolean =
        when (readLiveState(countSlowAnswer)) {
            LiveRead.Running, LiveRead.Slow -> true
            else -> false
        }

    /** `GET /api/agent/{id}` applied to the engine, with the run fences. */
    private suspend fun readLiveState(countSlowAnswer: Boolean = false): LiveRead {
        val sid = sessionId ?: return LiveRead.Skipped
        if (!reconcileInFlight.add(sid)) {
            // A GET for this session is already on its way and its answer is
            // the same state; another one would only race it.
            return LiveRead.Skipped
        }
        // A snapshot requested before a new prompt must never end that
        // prompt's run (the GET can outlive the send), and one requested
        // before the current run ended must not resurrect it: omp freezes
        // `isPromptRunning`/`isStreaming` in the answer, and a same-run
        // snapshot would otherwise show a phantom run for a whole cycle. The
        // fences also cover the busy answer below.
        val runId = engine.state.value.runId
        val runsEnded = engine.state.value.runsEnded
        try {
            val queueRevision = engine.state.value.queueRevision
            val root = api.agentState(sid)
            if (sessionId != sid || engine.state.value.runId != runId) return LiveRead.Skipped
            if (engine.state.value.runsEnded != runsEnded) return LiveRead.Skipped
            clearSlowStateAnswers()
            // Keep an open system-prompt panel in sync with the same GET, so a
            // prompt change never shows stale text.
            refreshOpenSystemPrompt(root)
            controls.onAgentState(root)
            engine.applyAgentState(root, expectedRunId = runId, expectedQueueRevision = queueRevision)
            // This poll is the only reliable re-sync for a missed lifecycle
            // frame, and the only side-question refresh while streaming.
            btw.onReconcile()
            refreshSubagentRoster(sid)
            pumpEffects()
            val state = engine.state.value
            return if (state.busy || state.streamingActive) LiveRead.Running else LiveRead.Idle
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (slow: ApiError.SessionSlow) {
            // omp is busy (large sessions block its event loop for tens of
            // seconds), not gone. A frame that ended the run meanwhile wins
            // (same fences as the snapshot above); a submit that is waiting for
            // the state then routes as during a run instead of guessing "idle".
            if (sessionId == sid && engine.state.value.runId == runId
                && engine.state.value.runsEnded == runsEnded
            ) {
                when (slow.running) {
                    // Authoritative: no turn is in flight (the child is only
                    // blocked loading), so the run the screen still shows is
                    // over. Settling now is what stops "working" from
                    // outliving the run by hours.
                    false -> {
                        clearSlowStateAnswers()
                        engine.markLiveStateIdle()
                        return LiveRead.Idle
                    }
                    // Unreported (older server): bound the unknown window and
                    // let the running list — the server's own registry — decide.
                    // Only a poll advances the window: the burst of reads an
                    // open fires (open, connection, first page) is one
                    // observation, not three polls.
                    null -> {
                        engine.markLiveStateSlow(null)
                        if (countSlowAnswer && noteSlowStateAnswer(sid, runId)) {
                            // The window restarts before the registry decides
                            // (web clears `slowStateAnswersRef` first): a list
                            // that still names the run makes the next window
                            // three fresh polls, not one more every poll.
                            clearSlowStateAnswers()
                            if (!runningListNamesSession(sid)) {
                                engine.markLiveStateIdle()
                                return LiveRead.Idle
                            }
                        }
                    }
                    true -> engine.markLiveStateSlow(true)
                }
            }
            return LiveRead.Slow
        } catch (error: Exception) {
            return LiveRead.Failed(error)
        } finally {
            reconcileInFlight -= sid
        }
    }

    /** Counts a 503 without a run state for this run; true once the bound is exceeded. */
    private fun noteSlowStateAnswer(sid: String, runId: Long): Boolean {
        if (slowStateSession != sid || slowStateRunId != runId) {
            slowStateSession = sid
            slowStateRunId = runId
            slowStateAnswers = 1
            return false
        }
        slowStateAnswers += 1
        return slowStateAnswers >= SLOW_STATE_MAX_ANSWERS
    }

    private fun clearSlowStateAnswers() {
        slowStateSession = null
        slowStateRunId = -1L
        slowStateAnswers = 0
    }

    /**
     * Last resort when a 503 does not say whether a run exists: the running
     * list is the server's own run registry. An unreadable list answers `true`
     * (keep the run marked) — a failed lookup is never evidence of idleness.
     */
    private suspend fun runningListNamesSession(sid: String): Boolean = try {
        sid in api.runningSessionIds()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        true
    }

    // ---------------------------------------------------------------- render

    private fun publish(state: ChatState = engine.state.value) {
        // An idle session has no omp child to answer `get_state`; the file's
        // model/reasoning still label the controls until a live value arrives.
        val modelKey = state.model?.let { "${it.provider}/${it.id}/${it.name}" }
        if (modelKey != null && modelKey != lastSessionModelKey) {
            lastSessionModelKey = modelKey
            state.model?.let { controls.onSessionModel(it.provider, it.id, it.name) }
        }
        if (state.thinkingLevel != lastSessionThinking) {
            lastSessionThinking = state.thinkingLevel
            controls.onSessionThinking(state.thinkingLevel)
        }
        if (rowsCacheSource !== state.messages || rowsCacheHideThinking != preferences.hideThinking) {
            rowsCacheSource = state.messages
            rowsCacheHideThinking = preferences.hideThinking
            rowsCache = TranscriptPlan.build(state.messages, preferences.hideThinking)
            committedToolResults = TranscriptPlan.collectToolResults(state.messages)
            forkCache = ForkTargets.resolve(
                state.messages,
                state.entryIds.map { it.ifBlank { null } },
            )
        }
        val results = if (state.liveTools.isEmpty()) {
            committedToolResults
        } else {
            val merged = committedToolResults.toMutableMap()
            for (tool in state.liveTools) {
                tool.result?.let { merged[it.toolCallId] = it }
            }
            merged
        }
        val notices = state.notices.filterNot { noticeKey(it) in dismissedNotices }
        if (state.notices.isEmpty() && dismissedNotices.isNotEmpty()) dismissedNotices.clear()
        val hasCompaction = state.messages.any {
            it is ChatMessage.Custom && it.customType == "compaction"
        }
        val restore = _ui.value.restoreScrollIndex
        // A compaction start replaces any banner the previous one left behind
        // (web clears both on `auto_compaction_start`).
        if (state.compacting && (_ui.value.compactResult != null || _ui.value.compactError != null)) {
            compactResultJob?.cancel()
            compactErrorJob?.cancel()
            _ui.update { it.copy(compactResult = null, compactError = null) }
        }
        // A `/plan` banner belongs to the turn that is running right now.
        val planObjective = _ui.value.planObjective?.takeIf { state.agentRunning }
        val dialog = _ui.value.subagent?.let { current ->
            state.subagents.firstOrNull { it.id == current.id }?.let { info -> syncDialog(current, info) } ?: current
        }
        _ui.update {
            it.copy(
                engine = state,
                rows = rowsCache,
                toolResults = results,
                forkTargets = forkCache,
                preferences = preferences,
                hasCompaction = hasCompaction,
                thinking = LinkedHashMap(thinkingCache),
                restoreScrollIndex = restore,
                // Compaction banners only matter while history is shown.
                notices = notices,
                activeGoal = sessionId?.let { settings.snapshot.value.activeGoals[it] },
                submitDuringRun = settings.snapshot.value.submitDuringRun,
                planObjective = planObjective,
                todoCollapsed = settings.snapshot.value.composerTodoCollapsed,
                subagentsCollapsed = settings.snapshot.value.composerSubagentsCollapsed,
                subagent = dialog,
            )
        }
    }

    /** Collapse/expand the attached todo panel (`omp-web:composer-todo-collapsed`). */
    fun setTodoCollapsed(collapsed: Boolean) {
        _ui.update { it.copy(todoCollapsed = collapsed) }
        viewModelScope.launch { settings.setComposerTodoCollapsed(collapsed) }
    }

    /** Collapse/expand the attached subagent roster. */
    fun setSubagentsCollapsed(collapsed: Boolean) {
        _ui.update { it.copy(subagentsCollapsed = collapsed) }
        viewModelScope.launch { settings.setComposerSubagentsCollapsed(collapsed) }
    }

    // ------------------------------------------------------------ chat search

    /** The top bar's search icon: opens the field, or closes it if it is open. */
    fun toggleSearch() {
        if (_search.value.open) closeSearch() else openSearch()
    }

    fun openSearch() {
        if (_search.value.open) return
        _search.update { it.copy(open = true) }
        refreshSearchHits()
    }

    /** Closing the field drops the query and its marks, like the web's `Escape`. */
    fun closeSearch() {
        if (_search.value == ChatSearchState()) return
        _search.update { ChatSearchState() }
    }

    fun setSearchQuery(query: String) {
        _search.update { it.copy(query = query, activeIndex = 0) }
        refreshSearchHits()
    }

    /** ↑/↓ through the hits; wraps at both ends. */
    fun stepSearch(delta: Int) {
        _search.update { state ->
            state.copy(activeIndex = ChatSearch.step(state.activeIndex, state.hits.size, delta))
        }
    }

    /**
     * Re-runs the query against the loaded transcript. The screen calls this
     * whenever rows or messages change (a streamed reply, a reloaded history),
     * so the marks and the count never describe an older transcript.
     */
    fun refreshSearchHits() {
        val state = _search.value
        if (!state.open || state.query.isBlank()) {
            if (state.hits.isNotEmpty() || state.activeIndex != 0) {
                _search.update { it.copy(hits = emptyList(), activeIndex = 0) }
            }
            return
        }
        val ui = _ui.value
        val hits = ChatSearch.search(
            messages = ui.engine.messages,
            rowKeyByMessage = ChatSearch.rowKeyByMessage(ui.rows, ui.engine.messages),
            query = state.query,
            // The transcript drops thinking blocks while the reader hides
            // them; searching the raw text would report hits that no row shows.
            hideThinking = ui.preferences.hideThinking,
        )
        _search.update { current ->
            current.copy(
                hits = hits,
                activeIndex = current.activeIndex.coerceIn(0, (hits.size - 1).coerceAtLeast(0)),
            )
        }
    }

    /**
     * Scroll the transcript to the message [entryId] of [sessionId] and flash
     * it. The hand-off point for the server-side search in `ui/sessions`: the
     * caller needs no knowledge of rows, windows or lazy indices, and does not
     * clear anything afterwards (the transcript consumes the request after the
     * jump).
     *
     * A hit in another session is queued for that session: the session switch
     * runs after this call and resets the in-chat search state, so the request
     * would otherwise be dropped. A request made before the rows are loaded is
     * kept and applied as soon as the row exists; an entry that is not part of
     * the loaded display history (e.g. pre-compaction with the compaction view
     * off) is reported by the transcript instead of silently ignored.
     */
    fun scrollToEntry(sessionId: String, entryId: String) {
        if (entryId.isEmpty()) return
        if (this.sessionId == sessionId) {
            _search.update { it.copy(revealEntryId = entryId) }
        } else {
            pendingReveals[sessionId] = entryId
        }
    }

    /** The transcript landed on [ChatSearchState.revealEntryId]. */
    fun consumeRevealEntry() {
        if (_search.value.revealEntryId != null) _search.update { it.copy(revealEntryId = null) }
    }

    private fun persistScrollNow() {
        val sid = sessionId ?: return
        val next = if (lastNearBottom) 0 else currentScrollIndex
        savedStateHandle[KEY_SCROLL] = next
        savedStateHandle[KEY_LEAF] = viewLeafId
        if (next == lastPersistedScroll) return
        // onCleared cannot launch a view-model coroutine; the settings store
        // owns the dispatch (snapshot updates synchronously, DataStore writes
        // on its own scope).
        scrollSaveJob?.cancel()
        settings.persistChatScrollPosition(sid, next)
        lastPersistedScroll = next
    }

    override fun onCleared() {
        persistScrollNow()
        // Slice C's dialog is bound to this chat; a cleared chat drops it and
        // must also stop treating the old session as "viewed" (consent rule).
        onChatHidden()
        // The panel controller is app-scoped, this chat is not. A panel that
        // arrived while hidden must not outlive its chat: once the surface is
        // gone for good, no subscription of this client is left, the id may
        // have been settled by another tab, and an answer would vanish
        // fire-and-forget. Nothing is lost by dropping it — the next
        // subscription to that session replays whatever is still open.
        extensionUi.reset()
        speech.shutdown()
        super.onCleared()
    }

    private companion object {
        const val FRAME_COALESCE_MILLIS = 16L
        const val RECONCILE_MILLIS = 15_000L
        /**
         * Another omp process owns the chat: its transcript is followed by
         * polling (web `EXTERNAL_RUN_POLL_MS`, 2 s) for as long as the owner
         * reports activity.
         */
        const val FOREIGN_RUN_POLL_MILLIS = 2_000L
        /** First retry of a live state that never arrived; doubles to the max. */
        const val RECONCILE_UNKNOWN_FIRST_MILLIS = 3_000L
        const val RECONCILE_UNKNOWN_MAX_MILLIS = 60_000L
        /**
         * Consecutive 503 `session_slow` answers that carry no run state (older
         * server) before the running list decides: an unknown state must not
         * keep the screen in "working" forever (web `SLOW_STATE_MAX_ANSWERS`).
         */
        const val SLOW_STATE_MAX_ANSWERS = 3
        /** A submit waits at most this long for the live state before keeping the draft. */
        const val LIVE_STATE_SUBMIT_TIMEOUT_MILLIS = 10_000L
        /** Retry of a failed submit-time live-state read; doubles to the max. */
        const val LIVE_STATE_SUBMIT_FIRST_MILLIS = 500L
        const val LIVE_STATE_SUBMIT_MAX_RETRY_MILLIS = 4_000L
        /** Wait for a read that is already on the wire instead of stacking GETs. */
        const val LIVE_STATE_SUBMIT_POLL_MILLIS = 150L
        const val PROMPT_SETTLE_FIRST_MILLIS = 800L
        const val PROMPT_SETTLE_INTERVAL_MILLIS = 600L
        const val PROMPT_SETTLE_ATTEMPTS = 32
        const val ABORT_RECONCILE_MILLIS = 800L
        const val WITHDRAW_BEFORE_ABORT_MILLIS = 1_500L
        const val SUBSCRIBE_RETRY_MIN_MILLIS = 1_000L
        const val SUBSCRIBE_RETRY_MAX_MILLIS = 30_000L
        const val SCROLL_SAVE_DEBOUNCE_MILLIS = 600L
        const val THINKING_CACHE_LIMIT = 100
        const val MAX_PAGES = 200
        /** Web `compactResult` / `compactError` visibility. */
        const val COMPACT_RESULT_VISIBLE_MILLIS = 6_000L
        const val COMPACT_ERROR_VISIBLE_MILLIS = 3_000L
        /** Streaming child frames coalesce into one dialog refetch (web 600 ms). */
        const val SUBAGENT_REFETCH_DEBOUNCE_MILLIS = 600L

        /** `/btw` with a question or alone (web `sendSideQuestion`). */
        val SIDE_QUESTION_REGEX = Regex("^/btw(\\s|$)")

        const val KEY_SESSION = "chat_session_id"
        const val KEY_LEAF = "chat_leaf_id"
        const val KEY_SCROLL = "chat_scroll_index"

        fun thinkingKey(entryId: String, blockIndex: Int): String = "$entryId:$blockIndex"

        fun noticeKey(notice: ChatNotice): String =
            "${notice.kind}:${notice.createdAt}:${notice.message}"
    }
}

private class ChatHistoryException(message: String) : Exception(message)

private fun formatBytes(bytes: Long): String = when {
    bytes >= 1_048_576 -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1_048_576.0)
    bytes >= 1024 -> String.format(java.util.Locale.US, "%.1f KB", bytes / 1024.0)
    else -> "$bytes B"
}
