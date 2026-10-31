package io.github.kahme247.ompweb.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.data.ComposerDraftStore
import io.github.kahme247.ompweb.domain.ComposerRoute
import io.github.kahme247.ompweb.domain.DictationOutcome
import io.github.kahme247.ompweb.domain.DictationResult
import io.github.kahme247.ompweb.domain.dictationOutcome
import io.github.kahme247.ompweb.domain.routeComposerSubmission
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.CwdValidation
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.filesApi
import io.github.kahme247.ompweb.net.userMessage
import io.github.kahme247.ompweb.ui.composer.ComposerController
import io.github.kahme247.ompweb.ui.composer.ComposerStrings
import io.github.kahme247.ompweb.ui.composer.ComposerSubmission
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import io.github.kahme247.ompweb.ui.worktrees.WorktreeCache
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class NewSessionUiState(
    val cwd: String? = null,
    val worktrees: List<WorktreeEntry> = emptyList(),
    val worktreesLoading: Boolean = false,
    val currentWorktreePath: String? = null,
    val sending: Boolean = false,
    /** True while `POST /api/cwd/validate` has not answered for [cwd]. */
    val validating: Boolean = false,
    /** null = no workspace selected; false blocks Send (A9). */
    val cwdValid: Boolean? = null,
    val error: String? = null,
    /** A composer notice (skipped attachment, invalid size) for the screen's toast. */
    val notice: String? = null,
)

/**
 * A session the pane created; the screen navigates to it. [sideQuestion] rides
 * along for `/btw`: the session exists only so the chat can ask it there.
 */
data class CreatedSession(val id: String, val cwd: String, val sideQuestion: String? = null)

/**
 * Composer state for a brand-new session: workspace/worktree, the shared
 * composer (text, attachments, drafts, palettes) and Slice B/C's controls.
 *
 * Wire contract: `POST /api/agent/new {cwd, type:"ensure_session", ...}`
 * creates the omp child and returns its real id, then
 * `POST /api/agent/{id} {type:"prompt", message, images}` sends the first turn
 * (`app/api/agent/new/route.ts`). Spawn options (model, thinking, tools,
 * advisor) come from `ComposerControlsViewModel.pendingSpawnOptions()`.
 */
class NewSessionViewModel(
    private val api: ApiClient,
    drafts: ComposerDraftStore,
    private val composerStrings: ComposerStrings,
    /** Slice B: model / thinking / tools / advisor / context controls. */
    val controls: ComposerControlsViewModel,
    /** Slice C: voice dictation. */
    val dictation: DictationViewModel,
    /** Slice B's shared worktree cache (also used by the Files panel). */
    private val worktreeCache: WorktreeCache,
) : ViewModel() {

    private val _state = MutableStateFlow(NewSessionUiState())
    val state: StateFlow<NewSessionUiState> = _state.asStateFlow()

    // A channel, not a flag: the Send tap and a dictated first prompt each
    // navigate exactly once.
    private val createdChannel = Channel<CreatedSession>(Channel.BUFFERED)
    /** Emitted once per created session, for the first prompt and after a failed one. */
    val created: Flow<CreatedSession> = createdChannel.receiveAsFlow()

    /** The composer shared with the chat surface (`new:<cwd>` draft key). */
    val composer = ComposerController(
        drafts = drafts,
        scope = viewModelScope,
        api = api,
        files = api.filesApi(),
        strings = composerStrings,
        notice = { message -> _state.update { it.copy(notice = message) } },
    )

    init {
        // Slice C: a transcript from the pane's mic must not die in the
        // buffer. Insert fills the field; Send (and, with no run to steer or
        // queue behind, Steer/FollowUp) sends the first turn like the tap.
        viewModelScope.launch {
            dictation.results.collect { result -> applyDictationResult(result) }
        }
        // On-device partials are spliced into this pane's composer field while
        // the recognizer runs; server dictation still arrives via `results`.
        dictation.attachLiveField(
            text = { composer.state.value.text },
            caret = { composer.state.value.caret },
            apply = composer::replaceText,
        )
        // The cache is shared with the Files panel's Worktrees tab: a create or
        // remove there must reach this select without a cwd change (the web's
        // single `WorktreeContext` re-renders both).
        viewModelScope.launch {
            worktreeCache.revision.drop(1).collect { reloadWorktrees() }
        }
    }

    private var preparedCwd: String? = null
    private var requestGeneration = 0L

    /**
     * Loads the worktrees and binds the composer/controls to [cwd].
     *
     * A workspace deep link or a picker selection is validated against the
     * server first (`POST /api/cwd/validate`, web AppShell's `?cwd=` guard):
     * a dead path shows the server's reason in the pane and keeps Send
     * disabled instead of creating a session in a nonexistent directory.
     */
    fun prepare(cwd: String?) {
        val current = _state.value
        if (cwd != null && cwd == preparedCwd) {
            // Reopening the same pane is a no-op while the check is in flight
            // or already passed — but a failed check must run again: the user
            // has no other way back (a fixed path, a network hiccup) and the
            // pane would otherwise stay "invalid" and silently drop Send (A9).
            if (current.validating || current.cwdValid == true) return
            revalidate(cwd)
            return
        }
        preparedCwd = cwd
        requestGeneration++
        _state.update {
            it.copy(
                cwd = cwd,
                worktrees = emptyList(),
                currentWorktreePath = cwd,
                error = null,
                validating = !cwd.isNullOrBlank(),
                cwdValid = if (cwd.isNullOrBlank()) null else false,
            )
        }
        if (cwd.isNullOrBlank()) return
        composer.bind(draftKey(cwd), cwd, null)
        controls.bind(null, cwd)
        dictation.bindScope(draftKey(cwd))
        val generation = requestGeneration
        viewModelScope.launch { validateCwd(cwd, generation) }
        viewModelScope.launch { loadWorktrees(cwd, generation) }
    }

    /** Re-runs only the workspace check after a failed one (nothing else changed). */
    private fun revalidate(cwd: String) {
        requestGeneration++
        _state.update { it.copy(validating = true, cwdValid = false, error = null) }
        val generation = requestGeneration
        viewModelScope.launch { validateCwd(cwd, generation) }
    }

    /** The validation answer of [prepare]; a stale generation is dropped. */
    private suspend fun validateCwd(cwd: String, generation: Long) {
        val result = captureApi { api.validateCwd(cwd) }
        if (generation != requestGeneration) return
        result.fold(
            onSuccess = { validation ->
                _state.update { state ->
                    when (validation) {
                        is CwdValidation.Valid -> state.copy(
                            validating = false,
                            cwdValid = true,
                            error = null,
                        )
                        is CwdValidation.Invalid -> state.copy(
                            validating = false,
                            cwdValid = false,
                            // The pane falls back to R.string.cwd_invalid when
                            // the server gave no reason of its own.
                            error = validation.message?.takeIf { it.isNotBlank() },
                        )
                    }
                }
            },
            onFailure = { error ->
                _state.update {
                    it.copy(validating = false, cwdValid = false, error = error.userMessage())
                }
            },
        )
    }

    /** Selected workspace or worktree; the session runs in exactly this dir. */
    fun setCwd(cwd: String) {
        prepare(cwd)
    }

    fun consumeNotice() {
        if (_state.value.notice != null) _state.update { it.copy(notice = null) }
    }

    /** Creates the session, sends the first prompt (with attachments) and reports it via [created]. */
    fun send() {
        if (_state.value.sending) return
        // An unvalidated or rejected workspace must not create a session, not
        // even from a dictated transcript. The button stays live, so the tap
        // must say why it did nothing (A9).
        if (_state.value.cwdValid != true) {
            composer.showNotice(composerStrings.cwdInvalid)
            return
        }
        val submission = composer.resolve() ?: return
        startSend(submission)
    }

    /** Handles a dictated transcript: Insert fills the field, anything else sends it. */
    private fun applyDictationResult(result: DictationResult) {
        val outcome = dictationOutcome(result, composer.state.value.text, hasSession = false)
        if (outcome is DictationOutcome.Insert) {
            composer.insertAtCaret(outcome.text)
            return
        }
        val submission = composer.resolve(overrideText = outcome.text) ?: return
        // A send refused because creation is already running (or has no cwd)
        // keeps the transcript in the field instead of dropping it.
        if (!startSend(submission)) composer.setText(outcome.text)
    }

    /** Routes a resolved submission; false when nothing was started. */
    private fun startSend(submission: ComposerSubmission): Boolean {
        val current = _state.value
        val cwd = current.cwd
        if (current.sending || cwd.isNullOrBlank()) return false
        if (current.cwdValid != true) return false
        val route = routeComposerSubmission(
            raw = submission.raw,
            prompt = submission.prompt,
            hasAttachments = submission.hasAttachments,
            hasImages = submission.images.isNotEmpty(),
            bash = submission.bash,
        )
        when (route) {
            is ComposerRoute.Usage -> {
                composer.showNotice(
                    composerStrings.requiresArgs(route.command, route.argumentHint),
                )
                return false
            }
            is ComposerRoute.Builtin -> {
                // `/btw` creates the session and asks in the chat (web `askBtw`);
                // every other action command needs a session this pane lacks.
                if (route.name != "btw") {
                    composer.showNotice(composerStrings.noSession)
                    return false
                }
            }
            is ComposerRoute.Bash, is ComposerRoute.WebPrompt, is ComposerRoute.Prompt -> Unit
        }
        _state.update { it.copy(sending = true, error = null) }
        viewModelScope.launch {
            var createdId: String? = null
            try {
                val options = controls.pendingSpawnOptions()
                createdId = api.createSession(
                    cwd = cwd,
                    toolNames = options.toolNames,
                    provider = options.provider,
                    modelId = options.modelId,
                    thinkingLevel = options.thinkingLevel,
                    advisor = options.advisor,
                )
                // The chat composer is another controls instance: persist the
                // pane's advisor choice for the real id before the shell opens
                // it, and apply the Fast/Slow toggles the spawn call cannot
                // carry (B18).
                controls.onSessionCreated(createdId)
                when (route) {
                    is ComposerRoute.Builtin -> Unit // the chat asks `/btw` itself
                    is ComposerRoute.Bash -> api.bash(
                        createdId,
                        route.invocation.command,
                        route.invocation.excludeFromContext,
                    )
                    is ComposerRoute.WebPrompt -> api.prompt(createdId, route.prompt, emptyList())
                    else -> api.prompt(createdId, submission.prompt, submission.images)
                }
                composer.clear()
                _state.update { it.copy(sending = false) }
                createdChannel.trySend(
                    CreatedSession(
                        id = createdId,
                        cwd = cwd,
                        sideQuestion = if (route is ComposerRoute.Builtin) submission.raw else null,
                    ),
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: ApiError) {
                _state.update { it.copy(sending = false, error = error.userMessage()) }
                // The omp child exists even when the first command failed; open
                // it so the turn can be retried from the real chat instead of
                // silently orphaning the session.
                createdId?.let { id -> createdChannel.trySend(CreatedSession(id, cwd)) }
            }
        }
        return true
    }

    /**
     * Re-reads the prepared workspace's list after the shared cache changed.
     * The cache already holds the new answer, so this is local unless the
     * change belonged to another repo.
     */
    private fun reloadWorktrees() {
        val cwd = preparedCwd?.takeIf { it.isNotBlank() } ?: return
        viewModelScope.launch { loadWorktrees(cwd, requestGeneration) }
    }

    private suspend fun loadWorktrees(cwd: String, generation: Long) {
        _state.update { it.copy(worktreesLoading = true) }
        val result = captureApi { worktreeCache.list(cwd) }
        if (generation != requestGeneration) return
        result.fold(
            onSuccess = { list ->
                _state.update {
                    it.copy(
                        worktreesLoading = false,
                        worktrees = if (list.isGit) list.worktrees else emptyList(),
                        currentWorktreePath = list.currentWorktreePath ?: cwd,
                    )
                }
            },
            onFailure = {
                _state.update { it.copy(worktreesLoading = false, worktrees = emptyList()) }
            },
        )
    }

    private fun draftKey(cwd: String): String = "new:$cwd"
}
