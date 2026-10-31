package io.github.kahme247.ompweb.ui.composer

import io.github.kahme247.ompweb.data.ChatDraft
import io.github.kahme247.ompweb.data.ComposerDraftStore
import io.github.kahme247.ompweb.domain.AttachedTextFile
import io.github.kahme247.ompweb.domain.BashInvocation
import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.MAX_ATTACHED_IMAGE_BYTES
import io.github.kahme247.ompweb.domain.SlashCommandItem
import io.github.kahme247.ompweb.domain.SlashCommandSource
import io.github.kahme247.ompweb.domain.TextAttachmentBudget
import io.github.kahme247.ompweb.domain.applyAtCompletion
import io.github.kahme247.ompweb.domain.buildEntriesFromFiles
import io.github.kahme247.ompweb.domain.buildSlashInsertText
import io.github.kahme247.ompweb.domain.composeMessageWithTextAttachments
import io.github.kahme247.ompweb.domain.describeTextAttachmentSkip
import io.github.kahme247.ompweb.domain.extractAtQuery
import io.github.kahme247.ompweb.domain.extractSlashQuery
import io.github.kahme247.ompweb.domain.filterFileEntries
import io.github.kahme247.ompweb.domain.filterSlashCommands
import io.github.kahme247.ompweb.domain.formatAttachmentBytes
import io.github.kahme247.ompweb.domain.inputHistory
import io.github.kahme247.ompweb.domain.insertAtCursor
import io.github.kahme247.ompweb.domain.parseBashInvocation
import io.github.kahme247.ompweb.domain.selectTextAttachments
import io.github.kahme247.ompweb.domain.validateImageBudget
import io.github.kahme247.ompweb.domain.validateOutgoingPrompt
import io.github.kahme247.ompweb.net.ChatApi
import io.github.kahme247.ompweb.net.FileIndexPage
import io.github.kahme247.ompweb.net.FilesApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One resolved composer submit (text plus attachments, or a shell command). */
data class ComposerSubmission(
    val raw: String,
    val prompt: String,
    val images: List<ComposerImage>,
    val hasAttachments: Boolean,
    val bash: BashInvocation?,
)

/**
 * The input half of a composer, shared by the chat and the new-session pane:
 * text, attachments, draft persistence, the `/` and `@` palettes, `↑` history
 * and the `!`/`!!` shell mode. Routing (prompt/steer/queue/bash/builtin) stays
 * with the owning view model because it differs per screen.
 *
 * Hosts feed it a draft key (`<sessionId>` or `new:<cwd>`), the working
 * directory and the session; every draft change is persisted so switching
 * sessions or killing the process never loses text.
 */
class ComposerController(
    private val drafts: ComposerDraftStore,
    private val scope: CoroutineScope,
    private val api: ChatApi,
    /** The one `/api/file-index` client behind the `@` menu (shared with the explorer). */
    private val files: FilesApi,
    private val strings: ComposerStrings,
    private val notice: (String) -> Unit,
) {
    private val _state = MutableStateFlow(ComposerUiState())
    val state: StateFlow<ComposerUiState> = _state.asStateFlow()

    private var draftKey: String? = null
    private var cwd: String? = null
    private var sessionId: String? = null
    private var running = false

    private var remoteCommands: List<SlashCommandItem> = emptyList()
    private var dormantSkills: Set<String> = emptySet()
    private var fileIndex: FileIndexPage? = null
    private var indexCwd: String? = null
    private var indexLoadingCwd: String? = null
    private var commandsJob: Job? = null
    private var commandsRequestedFor: String? = null
    private var commandsLoadedFor: String? = null
    private var searchJob: Job? = null
    private var searchSequence = 0L
    private var editId = 0L

    /**
     * Invoked after every text/caret change, typed or programmatic. The chat
     * host uses it to feed word prediction; the new-session pane leaves it
     * unset. Set before [bind].
     */
    var textObserver: ((String, Int) -> Unit)? = null

    init {
        scope.launch {
            drafts.recoveries.collect { event ->
                if (event.key.isNotEmpty() && event.key == draftKey) applyStoredDraft()
            }
        }
    }

    val currentDraftKey: String? get() = draftKey

    /** Chat: `<sessionId>`; new session: `new:<cwd>`. Resets state and reloads the stored draft. */
    fun bind(key: String?, workingDirectory: String?, session: String?) {
        val keyChanged = key != draftKey
        draftKey = key
        sessionId = session
        if (workingDirectory != cwd) {
            cwd = workingDirectory
            fileIndex = null
            indexCwd = null
            indexLoadingCwd = null
            dormantSkills = emptySet()
            if (workingDirectory != null) loadSkills(workingDirectory)
        }
        val stored = key?.let(drafts::getDraft) ?: ChatDraft()
        _state.value = ComposerUiState(
            draft = stored,
            caret = stored.value.length,
            edit = nextEdit(stored.value, stored.value.length),
        )
        if (keyChanged) {
            remoteCommands = emptyList()
            commandsJob?.cancel()
            commandsRequestedFor = null
            commandsLoadedFor = null
        }
        if (session != null) loadCommands(session)
        publishText()
    }

    /** omp's roster (engine state / live `available_commands_update`). */
    fun setRemoteCommands(commands: List<SlashCommandItem>) {
        if (commands == remoteCommands) return
        remoteCommands = commands
        refreshMenus()
    }

    /** Streaming hides the client built-ins from the palette, exactly like the web composer. */
    fun setRunning(running: Boolean) {
        if (this.running == running) return
        this.running = running
        refreshMenus()
    }

    // ------------------------------------------------------------- text input

    fun onTextChanged(text: String, caret: Int) {
        val position = caret.coerceIn(0, text.length)
        _state.value = _state.value.copy(
            draft = _state.value.draft.copy(value = text),
            caret = position,
            bashMode = composerBashMode(text),
            bashExcluded = text.trimStart().startsWith("!!"),
            edit = null,
            history = null,
        )
        persist()
        refreshMenus()
        publishText()
    }

    /** Selection-only move (palette stays in sync with the caret). */
    fun onCaretMoved(caret: Int) {
        val position = caret.coerceIn(0, _state.value.text.length)
        if (position == _state.value.caret) return
        _state.value = _state.value.copy(caret = position)
        refreshMenus()
        publishText()
    }

    fun insertAtCaret(insert: String) {
        val current = _state.value
        val insertion = insertAtCursor(current.text, current.caret, insert)
        applyText(insertion.text, insertion.caret)
    }

    /** Put text back only when the composer is empty (web `insertIfEmpty`). */
    fun insertIfEmpty(text: String) {
        if (_state.value.text.isNotBlank()) return
        applyText(text, text.length)
    }

    fun setText(text: String) = applyText(text, text.length)

    /** Replace the whole field with a computed edit (accepted ghost, restore). */
    fun replaceText(text: String, caret: Int) = applyText(text, caret)

    fun clear() {
        _state.value = ComposerUiState(edit = nextEdit("", 0))
        draftKey?.let(drafts::clearDraft)
        publishText()
    }

    private fun applyText(text: String, caret: Int) {
        val position = caret.coerceIn(0, text.length)
        _state.value = _state.value.copy(
            draft = _state.value.draft.copy(value = text),
            caret = position,
            bashMode = composerBashMode(text),
            bashExcluded = text.trimStart().startsWith("!!"),
            edit = nextEdit(text, position),
        )
        persist()
        refreshMenus()
        publishText()
    }

    private fun publishText() {
        val current = _state.value
        textObserver?.invoke(current.text, current.caret)
    }

    private fun nextEdit(text: String, caret: Int): ComposerEdit = ComposerEdit(++editId, text, caret)

    private fun persist() {
        val key = draftKey ?: return
        val draft = _state.value.draft
        if (draft.isEmpty()) drafts.clearDraft(key) else drafts.setDraft(key, draft)
    }

    /** Reload after [DraftStore.recoverDraft] merged queue text back in. */
    fun applyStoredDraft() {
        val key = draftKey ?: return
        val stored = drafts.getDraft(key) ?: ChatDraft()
        _state.value = _state.value.copy(
            draft = stored,
            caret = stored.value.length,
            edit = nextEdit(stored.value, stored.value.length),
            slash = null,
            at = null,
            history = null,
        )
        publishText()
    }

    // -------------------------------------------------------------- palettes

    private fun refreshMenus() {
        refreshSlash()
        refreshAt()
    }

    private fun refreshSlash() {
        val current = _state.value
        val query = extractSlashQuery(current.text.substring(0, current.caret))
        if (query == null) {
            if (current.slash != null) _state.value = current.copy(slash = null)
            return
        }
        if (sessionId != null && remoteCommands.isEmpty()) loadCommands(sessionId!!)
        val pool = if (query.mode == io.github.kahme247.ompweb.domain.SlashMode.LEADING) {
            (if (running) emptyList() else strings.builtinCommands) + remoteCommands
        } else {
            remoteCommands
        }
        val filtered = filterSlashCommands(pool, query.query, query.mode == io.github.kahme247.ompweb.domain.SlashMode.MID_PROMPT)
        val ordered = if (query.mode == io.github.kahme247.ompweb.domain.SlashMode.LEADING) dormantSkillsLast(filtered) else filtered
        val active = current.slash?.activeIndex?.coerceIn(0, (ordered.size - 1).coerceAtLeast(0)) ?: 0
        _state.value = current.copy(
            slash = SlashMenuUi(query, ordered, active),
            at = null,
            history = null,
        )
    }

    private fun dormantSkillsLast(commands: List<SlashCommandItem>): List<SlashCommandItem> {
        if (dormantSkills.isEmpty()) return commands
        val (dormant, active) = commands.partition { command ->
            command.source == SlashCommandSource.SKILL &&
                command.name.removePrefix("skill:") in dormantSkills
        }
        return active + dormant
    }

    fun moveSlash(delta: Int) {
        val menu = _state.value.slash ?: return
        if (menu.commands.isEmpty()) return
        val next = Math.floorMod(menu.activeIndex + delta, menu.commands.size)
        _state.value = _state.value.copy(slash = menu.copy(activeIndex = next))
    }

    fun setSlashActive(index: Int) {
        val menu = _state.value.slash ?: return
        if (menu.commands.isEmpty()) return
        _state.value = _state.value.copy(slash = menu.copy(activeIndex = index.coerceIn(0, menu.commands.size - 1)))
    }

    fun setAtActive(index: Int) {
        val menu = _state.value.at ?: return
        if (menu.entries.isEmpty()) return
        _state.value = _state.value.copy(at = menu.copy(activeIndex = index.coerceIn(0, menu.entries.size - 1)))
    }

    fun setHistoryActive(index: Int) {
        val menu = _state.value.history ?: return
        if (menu.entries.isEmpty()) return
        _state.value = _state.value.copy(
            history = menu.copy(activeIndex = index.coerceIn(0, menu.entries.size - 1)),
        )
    }

    /** Surface a composer notice through the owner's channel. */
    fun showNotice(message: String) {
        if (message.isNotBlank()) notice(message)
    }

    /** Accept the highlighted palette row (Tab/Enter/direct tap). */
    fun acceptSlash(): Boolean {
        val menu = _state.value.slash ?: return false
        val command = menu.active ?: return false
        val current = _state.value
        val start = menu.query.start.coerceIn(0, current.text.length)
        val caret = current.caret.coerceIn(0, current.text.length)
        val insert = buildSlashInsertText(command.name, menu.query.mode)
        val next = current.text.substring(0, start) + insert + current.text.substring(caret)
        _state.value = current.copy(slash = null, at = null, history = null)
        applyText(next, start + insert.length)
        return true
    }

    private fun refreshAt() {
        val current = _state.value
        val query = extractAtQuery(current.text.substring(0, current.caret))
        if (query == null) {
            if (current.at != null) _state.value = current.copy(at = null)
            return
        }
        val directory = cwd ?: run {
            _state.value = current.copy(at = null)
            return
        }
        val cached = fileIndex
        if (cached == null) {
            _state.value = current.copy(at = AtMenuUi(query, emptyList(), searchingAll = true), slash = null, history = null)
            loadIndex(directory)
            return
        }
        val entries = filterFileEntries(buildEntriesFromFiles(cached.files), query.query)
        _state.value = current.copy(
            at = AtMenuUi(query, entries, activeIndex = 0, searchingAll = cached.truncated && query.query.isNotEmpty()),
            slash = null,
            history = null,
        )
        if (cached.truncated && query.query.isNotEmpty()) {
            searchServer(directory, query.query)
        }
    }

    fun moveAt(delta: Int) {
        val menu = _state.value.at ?: return
        if (menu.entries.isEmpty()) return
        val next = Math.floorMod(menu.activeIndex + delta, menu.entries.size)
        _state.value = _state.value.copy(at = menu.copy(activeIndex = next))
    }

    fun acceptAt(): Boolean {
        val menu = _state.value.at ?: return false
        val entry = menu.active ?: return false
        val current = _state.value
        val next = applyAtCompletion(current.text, current.caret, menu.query, entry)
        _state.value = current.copy(at = null, slash = null, history = null)
        applyText(next.text, next.caret)
        return true
    }

    private fun loadCommands(session: String) {
        if (commandsRequestedFor == session && (commandsJob?.isActive == true || commandsLoadedFor == session)) {
            return
        }
        commandsRequestedFor = session
        commandsJob = scope.launch {
            val commands = try {
                api.commands(session)
            } catch (_: Exception) {
                emptyList()
            }
            if (commands.isNotEmpty()) {
                commandsLoadedFor = session
                if (session == sessionId) setRemoteCommands(commands)
            }
        }
    }

    private fun loadSkills(directory: String) {
        scope.launch {
            val names = try {
                api.skills(directory).skills.filter { it.disableModelInvocation }.map { it.name }.toSet()
            } catch (_: Exception) {
                emptySet()
            }
            if (directory == cwd) {
                dormantSkills = names
                refreshMenus()
            }
        }
    }

    private fun loadIndex(directory: String) {
        if (indexCwd == directory && (fileIndex != null || indexLoadingCwd == directory)) return
        indexCwd = directory
        indexLoadingCwd = directory
        scope.launch {
            val listing = try {
                files.index(directory)
            } catch (_: Exception) {
                FileIndexPage()
            }
            if (indexLoadingCwd == directory) indexLoadingCwd = null
            if (directory == cwd) {
                fileIndex = listing
                refreshAt()
            }
        }
    }

    private fun searchServer(directory: String, query: String) {
        val sequence = ++searchSequence
        searchJob?.cancel()
        searchJob = scope.launch {
            delay(FILE_SEARCH_DEBOUNCE_MS)
            val listing = try {
                files.index(directory, query = query, filesOnly = true)
            } catch (_: Exception) {
                return@launch
            }
            if (sequence != searchSequence || directory != cwd) return@launch
            val menu = _state.value.at ?: return@launch
            if (menu.query.query != query) return@launch
            _state.value = _state.value.copy(at = menu.copy(entries = listing.matches, activeIndex = 0, searchingAll = false))
        }
    }

    // --------------------------------------------------------------- history

    fun openHistory(userTexts: List<String>) {
        val entries = inputHistory(userTexts, HISTORY_LIMIT).asReversed()
        if (entries.isEmpty()) return
        _state.value = _state.value.copy(
            history = HistoryMenuUi(entries, 0),
            slash = null,
            at = null,
        )
    }

    fun moveHistory(delta: Int) {
        val menu = _state.value.history ?: return
        if (menu.entries.isEmpty()) return
        val next = Math.floorMod(menu.activeIndex + delta, menu.entries.size)
        _state.value = _state.value.copy(history = menu.copy(activeIndex = next))
    }

    fun acceptHistory(): Boolean {
        val menu = _state.value.history ?: return false
        val text = menu.active ?: return false
        _state.value = _state.value.copy(history = null)
        applyText(text, text.length)
        return true
    }

    fun closeMenus() {
        val current = _state.value
        if (current.slash == null && current.at == null && current.history == null) return
        _state.value = current.copy(slash = null, at = null, history = null)
    }

    // ----------------------------------------------------------- attachments

    fun addImages(images: List<ComposerImage>) {
        if (images.isEmpty()) return
        var accepted = _state.value.images
        var error: String? = null
        var skipped = 0
        for (image in images) {
            val candidate = accepted + image
            val budgetError = validateImageBudget(candidate)
            if (budgetError != null) {
                skipped++
                error = budgetError
                continue
            }
            accepted = candidate
        }
        if (accepted.size != _state.value.images.size) {
            setDraft(_state.value.draft.copy(images = accepted))
        }
        if (skipped > 0) {
            val skippedNotice = String.format(
                strings.imageSkipped,
                skipped,
                formatAttachmentBytes(MAX_ATTACHED_IMAGE_BYTES),
            )
            notice(if (skipped == images.size) error ?: skippedNotice else skippedNotice)
        }
    }

    fun addTextFiles(files: List<AttachedTextFile>) {
        if (files.isEmpty()) return
        val current = _state.value.files
        val selection = selectTextAttachments(
            files,
            { it.size },
            TextAttachmentBudget(
                usedBytes = current.sumOf { it.size },
                usedSlots = current.size,
            ),
        )
        if (selection.accepted.isNotEmpty()) {
            setDraft(_state.value.draft.copy(files = current + selection.accepted))
        }
        val skip = describeTextAttachmentSkip(selection)
        if (skip != null) {
            notice(skip)
        } else if (files.size > selection.accepted.size) {
            notice(String.format(strings.filesSkipped, files.size - selection.accepted.size))
        }
    }

    fun removeImage(index: Int) {
        val images = _state.value.images
        if (index !in images.indices) return
        setDraft(_state.value.draft.copy(images = images.filterIndexed { position, _ -> position != index }))
    }

    fun removeFile(index: Int) {
        val files = _state.value.files
        if (index !in files.indices) return
        setDraft(_state.value.draft.copy(files = files.filterIndexed { position, _ -> position != index }))
    }

    fun setReadingAttachments(reading: Boolean) {
        if (_state.value.readingAttachments == reading) return
        _state.value = _state.value.copy(readingAttachments = reading)
    }

    private fun setDraft(draft: ChatDraft) {
        _state.value = _state.value.copy(draft = draft)
        persist()
    }

    // ---------------------------------------------------------------- submit

    /**
     * Resolve the composer into a submission: shell commands when the draft
     * starts with `!`/`!!`, otherwise the prompt with text attachments inlined.
     * Returns `null` for an empty draft or when the prompt exceeds the request
     * budget (the size error is raised as a notice and the draft is kept).
     */
    fun resolve(overrideText: String? = null): ComposerSubmission? {
        val current = _state.value
        val raw = (overrideText ?: current.text).trim()
        val images = current.images
        val files = current.files
        if (raw.isEmpty() && images.isEmpty() && files.isEmpty()) return null
        val bash = if (images.isEmpty()) parseBashInvocation(raw, files.isNotEmpty()) else null
        if (bash != null) {
            return ComposerSubmission(raw, raw, images, files.isNotEmpty(), bash)
        }
        val prompt = composeMessageWithTextAttachments(raw, files)
        val error = validateOutgoingPrompt(prompt, images)
        if (error != null) {
            notice(error)
            return null
        }
        return ComposerSubmission(raw, prompt, images, files.isNotEmpty(), null)
    }

    private companion object {
        const val HISTORY_LIMIT = 50
        const val FILE_SEARCH_DEBOUNCE_MS = 150L
    }
}
