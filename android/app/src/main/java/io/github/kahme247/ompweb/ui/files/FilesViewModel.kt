package io.github.kahme247.ompweb.ui.files

import io.github.kahme247.ompweb.chat.FileLinks
import io.github.kahme247.ompweb.domain.FileEntry
import io.github.kahme247.ompweb.domain.FileSearchRow
import io.github.kahme247.ompweb.domain.GitFileStatus
import io.github.kahme247.ompweb.domain.MAX_UPLOAD_BYTES_PER_FILE
import io.github.kahme247.ompweb.domain.MAX_UPLOAD_BYTES_TOTAL
import io.github.kahme247.ompweb.domain.UploadConflictPlan
import io.github.kahme247.ompweb.domain.UploadConflictStrategy
import io.github.kahme247.ompweb.domain.ViewerKind
import io.github.kahme247.ompweb.domain.atMentionsText
import io.github.kahme247.ompweb.domain.availableViewerModes
import io.github.kahme247.ompweb.domain.comparableFilePath
import io.github.kahme247.ompweb.domain.defaultViewerMode
import io.github.kahme247.ompweb.domain.effectiveViewerMode
import io.github.kahme247.ompweb.domain.fileSearchRows
import io.github.kahme247.ompweb.domain.isAbsoluteFilePath
import io.github.kahme247.ompweb.domain.isInsideDirectory
import io.github.kahme247.ompweb.domain.joinFilePath
import io.github.kahme247.ompweb.domain.mergeDirectoryListing
import io.github.kahme247.ompweb.domain.normalizeFilePath
import io.github.kahme247.ompweb.domain.relativeFilePath
import io.github.kahme247.ompweb.domain.revealAncestors
import io.github.kahme247.ompweb.domain.uploadConflictPlan
import io.github.kahme247.ompweb.domain.viewerKind
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventSubscriptionException
import io.github.kahme247.ompweb.events.SessionEventSource
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.FileReadResult
import io.github.kahme247.ompweb.net.FileIndexPage
import io.github.kahme247.ompweb.net.FilesApi
import io.github.kahme247.ompweb.net.MAX_FILE_SEARCH_LIMIT
import io.github.kahme247.ompweb.net.GitApi
import io.github.kahme247.ompweb.net.UploadFile
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull

/** The tab strip's fixed entries; file tabs are additional. */
enum class FilesPanelView { Explorer, Git, Worktrees, Notifications, File }

/** One open file tab and everything the viewer needs for it. */
data class FileTab(
    val path: String,
    val sourceSessionId: String? = null,
    /** A line to scroll to when the tab opens (markdown link, host tool). */
    val line: Int? = null,
    /** The mode the opener asked for; `null` means "pick the type's default". */
    val requestedMode: FileOpenMode? = null,
    val mode: FileOpenMode = FileOpenMode.Source,
    val wrap: Boolean = false,
    val loading: Boolean = false,
    val content: String? = null,
    val language: String? = null,
    val size: Long = 0,
    val binaryMime: String? = null,
    val error: String? = null,
    val watching: Boolean = false,
    val diff: String? = null,
    val diffSupported: Boolean = false,
    val diffLoading: Boolean = false,
    val diffError: String? = null,
    val docxHtml: String? = null,
    val pdfPath: String? = null,
    /** Bumped on a live image change so Coil refetches the same URL. */
    val imageVersion: Int = 0,
) {
    val id: String get() = comparableFilePath(path)
        .takeIf { it.isNotEmpty() }
        ?: path

    val availableModes: List<FileOpenMode>
        get() = availableViewerModes(viewerKind(path), language, diffSupported)
}

data class UploadFailureUi(val name: String, val message: String)

/**
 * The failure row's text for one file. A 413 is the server's size verdict, but
 * its body is not guaranteed (a proxy or Next itself can answer before the
 * upload route does), and "HTTP 413" would hide the actual cause. The row
 * already names the file, so the message names the limits.
 */
internal fun uploadFailureMessage(error: Throwable): String {
    val status = when (error) {
        is ApiError.ServerResponse -> error.status
        is ApiError.Http -> error.code
        else -> null
    }
    return if (status == 413) {
        "Too large for the server (25 MB per file, 100 MB per upload)."
    } else {
        error.userMessage()
    }
}

data class UploadSummaryUi(
    val uploaded: List<String> = emptyList(),
    val skipped: List<String> = emptyList(),
    val failed: List<UploadFailureUi> = emptyList(),
)

enum class UploadPhase { Idle, Checking, Uploading, Conflict }

/** The explorer's upload banner/dialog state (web `FileExplorer` upload block). */
data class FileUploadUiState(
    val phase: UploadPhase = UploadPhase.Idle,
    val percent: Int = 0,
    val currentName: String? = null,
    val index: Int = 0,
    val total: Int = 0,
    val conflict: UploadConflictPlan? = null,
    val summary: UploadSummaryUi? = null,
    val error: String? = null,
) {
    val busy: Boolean get() = phase == UploadPhase.Checking || phase == UploadPhase.Uploading
}

/** The Explorer tab's tree, git decorations, search and upload state. */
data class ExplorerUiState(
    val cwd: String? = null,
    val children: Map<String, List<FileEntry>> = emptyMap(),
    val expanded: Set<String> = emptySet(),
    val loading: Set<String> = emptySet(),
    val error: String? = null,
    val rootLoaded: Boolean = false,
    val gitFiles: List<GitFileStatus> = emptyList(),
    val searchOpen: Boolean = false,
    val searchQuery: String = "",
    val searchResults: List<FileSearchRow> = emptyList(),
    val searchTruncated: Boolean = false,
    val searchLoading: Boolean = false,
    val searchFailed: Boolean = false,
    /** Uploaded files (absolute) to highlight after an upload. */
    val highlight: Set<String> = emptySet(),
    /** A reveal request still waiting for its row to scroll into view. */
    val revealTarget: String? = null,
    val upload: FileUploadUiState = FileUploadUiState(),
)

data class FilesUiState(
    val panelOpen: Boolean = false,
    val view: FilesPanelView = FilesPanelView.Explorer,
    val tabs: List<FileTab> = emptyList(),
    val activeTabId: String? = null,
    val explorer: ExplorerUiState = ExplorerUiState(),
) {
    val activeTab: FileTab? get() = tabs.firstOrNull { it.id == activeTabId }
}

/**
 * The right panel's files: explorer tree, file tabs and their viewers, search,
 * uploads and the live `file` channel.
 *
 * Process-scoped (like `NotificationHistoryViewModel` and Slice B's view
 * models) so tabs survive rotation with the shell; [FileTabStore] additionally
 * restores the open paths after a process death. `explorerCwd` is pushed in by
 * the shell (`open session cwd → sidebar cwd → new-session cwd`).
 */
class FilesViewModel(
    private val api: FilesApi,
    private val git: GitApi,
    private val events: SessionEventSource,
    private val scope: CoroutineScope,
    private val tabStore: FileTabStore,
    private val cacheDir: File,
    private val origin: () -> String? = { null },
    /**
     * The origin, once the settings have loaded: tabs restored before that
     * would be judged against "no installation" and restored under the wrong
     * key.
     */
    private val awaitOrigin: suspend () -> String? = { origin() },
) {

    private val _state = MutableStateFlow(FilesUiState())
    val state: StateFlow<FilesUiState> = _state.asStateFlow()

    /** Bumped by every cwd change; late directory/git answers compare against it. */
    private var cwdGeneration = 0L
    private var gitGeneration = 0L
    private var searchGeneration = 0L
    /** Per-tab patch tokens: two tabs' diffs must not cancel each other. */
    private val diffTokens = mutableMapOf<String, Long>()
    private var uploadJob: Job? = null
    private var uploadGeneration = 0L

    private val loadingDirectories = mutableSetOf<String>()
    private val loadTokens = mutableMapOf<String, Long>()
    private val loadJobs = mutableMapOf<String, Job>()
    private var watchJob: Job? = null
    private var searchJob: Job? = null
    private var pendingUpload: List<UploadFile> = emptyList()

    init {
        scope.launch {
            val stored = runCatching { tabStore.load(awaitOrigin()) }.getOrDefault(emptyList())
            if (stored.isEmpty() || _state.value.tabs.isNotEmpty()) return@launch
            val restored = stored.map { FileTab(path = it.path, sourceSessionId = it.sourceSessionId) }
            _state.update { it.copy(tabs = restored, activeTabId = restored.firstOrNull()?.id) }
        }
    }

    // --- Panel & tabs -------------------------------------------------------

    fun showPanel() {
        if (_state.value.panelOpen) return
        _state.update { it.copy(panelOpen = true) }
        val active = _state.value.activeTab
        if (_state.value.view == FilesPanelView.File && active != null) {
            ensureTabLoaded(active)
            startWatch(active)
        }
    }

    fun closePanel() {
        stopWatch()
        _state.update { it.copy(panelOpen = false) }
    }

    /** Predictive/back: a file tab first returns to the explorer, then the panel closes. */
    fun back(): Boolean {
        val current = _state.value
        if (!current.panelOpen) return false
        if (current.view == FilesPanelView.File) {
            _state.update { it.copy(view = FilesPanelView.Explorer) }
            stopWatch()
        } else {
            closePanel()
        }
        return true
    }

    fun setView(view: FilesPanelView) {
        val next = if (view == FilesPanelView.File && _state.value.activeTab == null) {
            FilesPanelView.Explorer
        } else {
            view
        }
        _state.update { it.copy(view = next, panelOpen = true) }
        if (next == FilesPanelView.File) {
            _state.value.activeTab?.let { tab ->
                ensureTabLoaded(tab)
                startWatch(tab)
            }
        } else {
            stopWatch()
        }
    }

    /**
     * Opens (or reactivates) a file tab. [mode] overrides the type's default;
     * a path outside [cwd] is still opened (the server decides), so a host
     * tool's absolute path works after switching sessions.
     */
    fun openTab(
        path: String,
        mode: FileOpenMode? = null,
        line: Int? = null,
        sourceSessionId: String? = null,
        cwd: String? = _state.value.explorer.cwd,
    ) {
        val raw = path.trim()
        if (raw.isEmpty()) return
        val resolved = normalizeFilePath(raw).let { normalized ->
            when {
                normalized.isEmpty() -> return
                isAbsoluteFilePath(normalized) -> normalized
                cwd != null -> joinFilePath(cwd, normalized)
                else -> normalized
            }
        }
        val id = FileTab(path = resolved).id
        val existing = _state.value.tabs.firstOrNull { it.id == id }
        if (existing == null) {
            val tab = FileTab(
                path = resolved,
                sourceSessionId = sourceSessionId,
                line = line,
                requestedMode = mode,
                mode = mode ?: FileOpenMode.Source,
            )
            _state.update {
                it.copy(
                    tabs = it.tabs + tab,
                    activeTabId = tab.id,
                    view = FilesPanelView.File,
                    panelOpen = true,
                )
            }
            ensureTabLoaded(tab)
            // An image needs no read, so nothing else subscribes to its watch
            // channel and a changed file would never refresh.
            if (viewerKind(tab.path) == ViewerKind.Image) startWatch(tab)
            persistTabs()
            return
        }
        val updated = existing.copy(
            sourceSessionId = sourceSessionId ?: existing.sourceSessionId,
            line = line ?: existing.line,
            requestedMode = mode ?: existing.requestedMode,
            mode = mode ?: existing.mode,
        )
        _state.update { state ->
            state.copy(
                tabs = state.tabs.map { if (it.id == id) updated else it },
                activeTabId = id,
                view = FilesPanelView.File,
                panelOpen = true,
            )
        }
        ensureTabLoaded(updated)
        startWatch(updated)
        persistTabs()
    }

    fun selectTab(id: String) {
        val tab = _state.value.tabs.firstOrNull { it.id == id } ?: return
        _state.update { it.copy(activeTabId = id, view = FilesPanelView.File) }
        ensureTabLoaded(tab)
        startWatch(tab)
    }

    fun closeTab(id: String) {
        val current = _state.value
        val next = current.tabs.filterNot { it.id == id }
        cancelLoad(id)
        val active = when {
            next.isEmpty() -> null
            current.activeTabId == id -> next.last().id
            else -> current.activeTabId
        }
        _state.update {
            it.copy(
                tabs = next,
                activeTabId = active,
                view = if (next.isEmpty() && it.view == FilesPanelView.File) {
                    FilesPanelView.Explorer
                } else {
                    it.view
                },
            )
        }
        stopWatch()
        next.firstOrNull { it.id == active }?.let { tab ->
            if (_state.value.panelOpen && _state.value.view == FilesPanelView.File) {
                ensureTabLoaded(tab)
                startWatch(tab)
            }
        }
        persistTabs()
    }

    fun closeOtherTabs() {
        val active = _state.value.activeTab ?: return
        _state.value.tabs.filterNot { it.id == active.id }.forEach { cancelLoad(it.id) }
        _state.update { it.copy(tabs = listOf(active), activeTabId = active.id) }
        persistTabs()
    }

    fun closeAllTabs() {
        _state.value.tabs.forEach { cancelLoad(it.id) }
        stopWatch()
        _state.update {
            it.copy(
                tabs = emptyList(),
                activeTabId = null,
                view = if (it.view == FilesPanelView.File) FilesPanelView.Explorer else it.view,
            )
        }
        persistTabs()
    }

    /** Leaving Diff asks for the bytes a diff-only tab never loaded. */
    fun setMode(mode: FileOpenMode) {
        val tab = _state.value.activeTab ?: return
        if (tab.availableModes.isNotEmpty() && mode !in tab.availableModes) return
        updateTab(tab.id) { it.copy(mode = mode, requestedMode = mode) }
        ensureTabLoaded(tab.copy(mode = mode, requestedMode = mode))
    }

    fun toggleWrap() {
        val tab = _state.value.activeTab ?: return
        updateTab(tab.id) { it.copy(wrap = !it.wrap) }
    }

    fun retryTab() {
        val tab = _state.value.activeTab ?: return
        startLoad(tab.copy(error = null, content = null, binaryMime = null, docxHtml = null))
    }

    /** Raw bytes for Save/Share; throws the API error so the caller can toast it. */
    suspend fun fileBytes(path: String, sourceSessionId: String? = null): ByteArray =
        api.download(FileLinks.apiPathSegments(path), sourceSessionId)

    /** A picker-side rejection (unreadable or oversized URI) for the upload banner. */
    fun reportUploadError(message: String) {
        setUploadError(message)
    }

    // --- Explorer -----------------------------------------------------------

    fun setCwd(cwd: String?) {
        val normalized = cwd?.takeIf { it.isNotBlank() }
        val current = _state.value.explorer
        if (normalized == current.cwd && (normalized == null || current.rootLoaded)) return
        cwdGeneration++
        gitGeneration++
        searchGeneration++
        cancelUpload()
        loadingDirectories.clear()
        val keepSearch = current.searchOpen
        val keepQuery = current.searchQuery
        _state.update {
            it.copy(
                explorer = ExplorerUiState(
                    cwd = normalized,
                    searchOpen = keepSearch,
                    searchQuery = keepQuery,
                ),
            )
        }
        // A diff belongs to the directory it was asked for; a moved cwd must
        // refetch instead of showing the previous workspace's patch.
        diffTokens.clear()
        _state.update { state ->
            state.copy(
                tabs = state.tabs.map { it.copy(diff = null, diffSupported = false, diffLoading = false, diffError = null) },
            )
        }
        if (normalized == null) return
        loadDirectory(normalized, force = true)
        loadGitStatus()
        val active = _state.value.activeTab
        if (active != null && active.mode == FileOpenMode.Diff) ensureDiff(active, force = true)
        if (keepSearch && keepQuery.isNotBlank()) scheduleSearch(immediate = true)
    }

    fun refreshExplorer() {
        val cwd = _state.value.explorer.cwd ?: return
        // A refresh invalidates every listing in flight; those jobs return on
        // the generation check and would leave their row spinner forever.
        loadingDirectories.clear()
        _state.update { it.copy(explorer = it.explorer.copy(loading = emptySet())) }
        cwdGeneration++
        gitGeneration++
        searchGeneration++
        val expanded = _state.value.explorer.expanded
        loadDirectory(cwd, force = true)
        expanded.forEach { loadDirectory(it, force = true) }
        loadGitStatus()
        val active = _state.value.activeTab
        if (active != null && active.mode == FileOpenMode.Diff) ensureDiff(active, force = true)
        if (_state.value.explorer.searchOpen && _state.value.explorer.searchQuery.isNotBlank()) {
            scheduleSearch(immediate = true, refresh = true)
        }
    }

    fun toggleDirectory(path: String) {
        val key = comparableFilePath(path)
        val expanded = _state.value.explorer.expanded
        val nowExpanded = if (key in expanded) expanded - key else expanded + key
        _state.update { it.copy(explorer = it.explorer.copy(expanded = nowExpanded)) }
        if (key in nowExpanded) ensureDirectoryLoaded(path)
    }

    fun collapseAll() {
        _state.update { it.copy(explorer = it.explorer.copy(expanded = emptySet())) }
    }

    /** Reveals [path] in the tree: expands and loads every ancestor, then scrolls the row in. */
    fun reveal(path: String) {
        val cwd = _state.value.explorer.cwd
        val target = normalizeFilePath(path)
        if (cwd == null || !isInsideDirectory(target, cwd)) {
            _state.update { it.copy(view = FilesPanelView.Explorer, panelOpen = true) }
            return
        }
        val ancestors = revealAncestors(cwd, target)
        _state.update {
            it.copy(
                panelOpen = true,
                view = FilesPanelView.Explorer,
                explorer = it.explorer.copy(
                    expanded = it.explorer.expanded + ancestors.map(::comparableFilePath),
                    highlight = setOf(comparableFilePath(target)),
                    revealTarget = null,
                ),
            )
        }
        scope.launch {
            ancestors.forEach { ancestor -> loadDirectory(ancestor) }
            _state.update {
                it.copy(explorer = it.explorer.copy(revealTarget = comparableFilePath(target)))
            }
            delay(REVEAL_TIMEOUT_MILLIS)
            _state.update { state ->
                if (state.explorer.revealTarget == comparableFilePath(target)) {
                    state.copy(explorer = state.explorer.copy(revealTarget = null))
                } else {
                    state
                }
            }
        }
    }

    /** The explorer scrolled to [path] (or gave up); drop the one-shot scroll target. */
    fun acknowledgeReveal() {
        if (_state.value.explorer.revealTarget == null) return
        _state.update { it.copy(explorer = it.explorer.copy(revealTarget = null)) }
    }

    // --- Search -------------------------------------------------------------

    fun setSearchOpen(open: Boolean) {
        _state.update { it.copy(explorer = it.explorer.copy(searchOpen = open)) }
        if (!open) {
            searchJob?.cancel()
            searchGeneration++
            _state.update {
                it.copy(
                    explorer = it.explorer.copy(
                        searchQuery = "",
                        searchResults = emptyList(),
                        searchTruncated = false,
                        searchLoading = false,
                        searchFailed = false,
                    ),
                )
            }
        } else if (_state.value.explorer.searchQuery.isNotBlank()) {
            scheduleSearch(immediate = true)
        }
    }

    fun setSearchQuery(query: String) {
        _state.update { it.copy(explorer = it.explorer.copy(searchQuery = query)) }
        if (query.isBlank()) {
            searchJob?.cancel()
            searchGeneration++
            _state.update {
                it.copy(
                    explorer = it.explorer.copy(
                        searchResults = emptyList(),
                        searchTruncated = false,
                        searchLoading = false,
                        searchFailed = false,
                    ),
                )
            }
            return
        }
        scheduleSearch()
    }

    fun retrySearch() {
        scheduleSearch(immediate = true)
    }

    private fun scheduleSearch(immediate: Boolean = false, refresh: Boolean = false) {
        val explorer = _state.value.explorer
        val cwd = explorer.cwd ?: return
        val query = explorer.searchQuery.trim()
        if (query.isEmpty()) return
        searchJob?.cancel()
        val generation = ++searchGeneration
        _state.update { it.copy(explorer = it.explorer.copy(searchLoading = true, searchFailed = false)) }
        searchJob = scope.launch {
            if (!immediate) delay(SEARCH_DEBOUNCE_MILLIS)
            val result = captureApi {
                api.index(cwd, query, limit = MAX_FILE_SEARCH_LIMIT, filesOnly = true, refresh = refresh)
            }
            if (generation != searchGeneration) return@launch
            result.fold(
                onSuccess = { page: FileIndexPage ->
                    _state.update {
                        it.copy(
                            explorer = it.explorer.copy(
                                searchLoading = false,
                                searchFailed = false,
                                searchResults = fileSearchRows(page.matches.map { it.path }),
                                searchTruncated = page.truncated,
                            ),
                        )
                    }
                },
                onFailure = {
                    _state.update {
                        it.copy(
                            explorer = it.explorer.copy(
                                searchLoading = false,
                                searchFailed = true,
                                searchResults = emptyList(),
                                searchTruncated = false,
                            ),
                        )
                    }
                },
            )
        }
    }

    // --- Upload -------------------------------------------------------------

    /**
     * Pre-flights [files] and uploads them, or asks the conflict question
     * first. [pickError] is the picker's own rejection for the same action (an
     * unreadable or oversized URI): it rides along in the banner, so the
     * upload progress cannot swallow it.
     */
    fun upload(files: List<UploadFile>, pickError: String? = null) {
        if (_state.value.explorer.upload.busy) return
        val cwd = _state.value.explorer.cwd ?: return
        if (files.isEmpty()) {
            if (pickError != null) setUploadError(pickError)
            return
        }
        val tooLarge = files.firstOrNull { it.bytes.size > MAX_UPLOAD_BYTES_PER_FILE }
        if (tooLarge != null) {
            setUploadError("${tooLarge.name} is larger than 25 MB.", pickError)
            return
        }
        if (files.sumOf { it.bytes.size.toLong() } > MAX_UPLOAD_BYTES_TOTAL) {
            setUploadError("The selection is larger than 100 MB.", pickError)
            return
        }
        pendingUpload = files
        val generation = startUploadSession(
            FileUploadUiState(phase = UploadPhase.Checking, total = files.size, error = pickError),
        )
        uploadJob = scope.launch {
            val check = captureApi { api.uploadCheck(cwd, files.map { file -> file.name }) }
            if (!isCurrentUpload(cwd, generation)) return@launch
            check.fold(
                onSuccess = { result ->
                    val plan = uploadConflictPlan(result.conflicts, result.nonReplaceable)
                    if (plan != null) {
                        updateUploadState(cwd, generation) { explorer ->
                            explorer.copy(
                                upload = explorer.upload.copy(
                                    phase = UploadPhase.Conflict,
                                    conflict = plan,
                                    total = files.size,
                                ),
                            )
                        }
                    } else {
                        performUpload(cwd, generation, files, UploadConflictStrategy.Error)
                    }
                },
                onFailure = { error ->
                    pendingUpload = emptyList()
                    updateUploadState(cwd, generation) { explorer ->
                        explorer.copy(
                            upload = explorer.upload.copy(
                                phase = UploadPhase.Idle,
                                error = uploadErrorText(explorer.upload.error, error.userMessage()),
                            ),
                        )
                    }
                },
            )
        }
    }

    fun resolveUploadConflict(strategy: UploadConflictStrategy) {
        val files = pendingUpload
        val cwd = _state.value.explorer.cwd ?: return
        if (files.isEmpty()) return
        val generation = startUploadSession(
            _state.value.explorer.upload.copy(
                phase = UploadPhase.Uploading,
                conflict = null,
                total = files.size,
                index = 0,
                currentName = files.firstOrNull()?.name,
                percent = 0,
            ),
        )
        uploadJob = scope.launch { performUpload(cwd, generation, files, strategy) }
    }

    fun cancelUploadConflict() {
        pendingUpload = emptyList()
        _state.update {
            it.copy(explorer = it.explorer.copy(upload = FileUploadUiState()))
        }
    }

    fun dismissUploadFeedback() {
        _state.update {
            it.copy(explorer = it.explorer.copy(upload = FileUploadUiState()))
        }
    }

    /** The `@mention` text for the files the last upload created, if any. */
    fun uploadedMentionText(): String? {
        val cwd = _state.value.explorer.cwd ?: return null
        val uploaded = _state.value.explorer.upload.summary?.uploaded.orEmpty()
        if (uploaded.isEmpty()) return null
        return atMentionsText(uploaded.map { name -> relativeFilePath(joinFilePath(cwd, name), cwd) })
    }

    /**
     * Starts one upload run: a second selection or a cwd switch cancels the
     * previous job, whose stale writes the generation then drops.
     */
    private fun startUploadSession(initial: FileUploadUiState): Long {
        uploadJob?.cancel()
        uploadGeneration++
        _state.update { it.copy(explorer = it.explorer.copy(upload = initial)) }
        return uploadGeneration
    }

    private suspend fun performUpload(
        cwd: String,
        generation: Long,
        files: List<UploadFile>,
        strategy: UploadConflictStrategy,
    ) {
        val uploaded = mutableListOf<String>()
        val skipped = mutableListOf<String>()
        val failed = mutableListOf<UploadFailureUi>()
        for ((index, file) in files.withIndex()) {
            if (!isCurrentUpload(cwd, generation)) return
            updateUploadState(cwd, generation) { explorer ->
                explorer.copy(upload = explorer.upload.copy(currentName = file.name, index = index, percent = 0))
            }
            val outcome = try {
                api.upload(cwd, file, strategy) { percent ->
                    updateUploadState(cwd, generation) { explorer ->
                        explorer.copy(upload = explorer.upload.copy(percent = percent))
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failed += UploadFailureUi(file.name, uploadFailureMessage(error))
                null
            }
            if (!isCurrentUpload(cwd, generation)) return
            if (outcome != null) {
                if (outcome.status == 409) {
                    pendingUpload = files
                    updateUploadState(cwd, generation) { explorer ->
                        explorer.copy(
                            upload = explorer.upload.copy(
                                phase = UploadPhase.Conflict,
                                conflict = uploadConflictPlan(outcome.conflicts, outcome.nonReplaceable),
                                total = files.size,
                            ),
                        )
                    }
                    return
                }
                if (outcome.failed) {
                    failed += UploadFailureUi(file.name, "HTTP ${outcome.status}")
                } else {
                    uploaded += outcome.uploaded
                    skipped += outcome.skipped
                    failed += outcome.errors.map { UploadFailureUi(it.name, it.message) }
                }
            }
        }
        pendingUpload = emptyList()
        updateUploadState(cwd, generation) { explorer ->
            explorer.copy(
                upload = explorer.upload.copy(
                    phase = UploadPhase.Idle,
                    summary = UploadSummaryUi(uploaded, skipped, failed),
                    percent = 100,
                ),
                highlight = uploaded.mapTo(HashSet()) { name -> joinFilePath(cwd, name) },
            )
        }
        reloadAfterUpload(cwd, generation, uploaded)
    }

    /** Applies [transform] only while this run is still the one on screen. */
    private fun updateUploadState(cwd: String, generation: Long, transform: (ExplorerUiState) -> ExplorerUiState) {
        _state.update { state ->
            if (generation != uploadGeneration || state.explorer.cwd != cwd) return@update state
            state.copy(explorer = transform(state.explorer))
        }
    }

    private fun isCurrentUpload(cwd: String, generation: Long): Boolean =
        generation == uploadGeneration && _state.value.explorer.cwd == cwd

    private fun reloadAfterUpload(cwd: String, generation: Long, uploaded: List<String>) {
        if (!isCurrentUpload(cwd, generation)) return
        // Like a manual refresh: every listing already in flight is superseded.
        loadingDirectories.clear()
        _state.update { it.copy(explorer = it.explorer.copy(loading = emptySet())) }
        cwdGeneration++
        gitGeneration++
        loadDirectory(cwd, force = true)
        _state.value.explorer.expanded.forEach { loadDirectory(it, force = true) }
        loadGitStatus()
        if (uploaded.isNotEmpty()) {
            searchGeneration++
            if (_state.value.explorer.searchOpen && _state.value.explorer.searchQuery.isNotBlank()) {
                scheduleSearch(immediate = true, refresh = true)
            }
        }
    }

    /** Abandons a running or queued upload (workspace switch, logout). */
    private fun cancelUpload() {
        uploadJob?.cancel()
        uploadJob = null
        uploadGeneration++
        pendingUpload = emptyList()
    }

    private fun setUploadError(message: String, pickError: String? = null) {
        pendingUpload = emptyList()
        _state.update {
            it.copy(
                explorer = it.explorer.copy(
                    upload = FileUploadUiState(phase = UploadPhase.Idle, error = uploadErrorText(pickError, message)),
                ),
            )
        }
    }

    private fun uploadErrorText(first: String?, second: String?): String =
        listOfNotNull(first, second).filter { it.isNotBlank() }.joinToString("\n")

    // --- Directory loading --------------------------------------------------

    private fun loadDirectory(path: String, force: Boolean = false) {
        val cwd = _state.value.explorer.cwd
        val key = comparableFilePath(path)
        if (!force && key in _state.value.explorer.children) return
        if (key in loadingDirectories) return
        loadingDirectories += key
        _state.update { it.copy(explorer = it.explorer.copy(loading = it.explorer.loading + key)) }
        val generation = cwdGeneration
        scope.launch {
            val result = captureApi { api.listDirectory(path) }
            loadingDirectories -= key
            if (generation != cwdGeneration || _state.value.explorer.cwd != cwd) return@launch
            result.fold(
                onSuccess = { entries ->
                    _state.update {
                        it.copy(
                            explorer = it.explorer.copy(
                                children = mergeDirectoryListing(it.explorer.children, path, entries),
                                loading = it.explorer.loading - key,
                                error = if (key == comparableFilePath(cwd.orEmpty())) null else it.explorer.error,
                                rootLoaded = it.explorer.rootLoaded ||
                                    key == comparableFilePath(cwd.orEmpty()),
                            ),
                        )
                    }
                },
                onFailure = { error ->
                    // A failed root must not count as loaded: the pane keys its
                    // "could not load" state (with the retry) on exactly that.
                    _state.update {
                        it.copy(
                            explorer = it.explorer.copy(
                                loading = it.explorer.loading - key,
                                error = if (key == comparableFilePath(cwd.orEmpty())) error.userMessage() else it.explorer.error,
                            ),
                        )
                    }
                },
            )
        }
    }

    private fun ensureDirectoryLoaded(path: String) {
        if (comparableFilePath(path) !in _state.value.explorer.children) loadDirectory(path)
    }

    private fun loadGitStatus() {
        val cwd = _state.value.explorer.cwd ?: return
        val generation = ++gitGeneration
        scope.launch {
            val result = captureApi { git.status(cwd) }
            if (generation != gitGeneration) return@launch
            result.fold(
                onSuccess = { response ->
                    _state.update {
                        it.copy(
                            explorer = it.explorer.copy(
                                gitFiles = if (response.isGitRepository) response.files else emptyList(),
                            ),
                        )
                    }
                },
                onFailure = {
                    // A decoration failure must never hide the tree.
                    _state.update {
                        it.copy(explorer = it.explorer.copy(gitFiles = emptyList()))
                    }
                },
            )
        }
    }

    // --- File loading -------------------------------------------------------

    /**
     * Fetches whatever [tab] still lacks. The tab is re-read from the state:
     * callers hold a snapshot that a concurrent answer may already have
     * superseded. In Diff mode the patch is the content, so no bytes are read
     * and a read error cannot keep the diff from loading.
     */
    private fun ensureTabLoaded(tab: FileTab) {
        val current = _state.value.tabs.firstOrNull { it.id == tab.id } ?: tab
        val kind = viewerKind(current.path)
        if (current.mode != FileOpenMode.Diff && !current.loading && current.error == null) {
            val needsLoad = when (kind) {
                ViewerKind.Image -> false
                ViewerKind.Pdf -> current.pdfPath == null
                ViewerKind.Docx -> current.docxHtml == null
                ViewerKind.Text -> current.content == null && current.binaryMime == null
            }
            if (needsLoad) startLoad(current)
        }
        val wantsDiff = kind == ViewerKind.Text && (current.mode == FileOpenMode.Diff || hasGitChange(current.path))
        if (wantsDiff && current.diff == null && !current.diffLoading) ensureDiff(current)
    }

    private fun hasGitChange(path: String): Boolean {
        val key = comparableFilePath(path)
        return _state.value.explorer.gitFiles.any { comparableFilePath(it.filePath) == key }
    }

    private fun startLoad(tab: FileTab) {
        cancelLoad(tab.id)
        val token = (loadTokens[tab.id] ?: 0L) + 1
        loadTokens[tab.id] = token
        updateTab(tab.id) {
            it.copy(loading = true, error = null, diffError = null, docxHtml = null, pdfPath = null)
        }
        val job = scope.launch {
            when (viewerKind(tab.path)) {
                ViewerKind.Image -> updateTab(tab.id) { it.copy(loading = false) }
                ViewerKind.Pdf -> loadPdf(tab, token)
                ViewerKind.Docx -> loadDocx(tab, token)
                ViewerKind.Text -> loadText(tab, token)
            }
        }
        loadJobs[tab.id] = job
        if (_state.value.panelOpen) startWatch(tab)
    }

    private suspend fun loadText(tab: FileTab, token: Long) {
        val segments = FileLinks.apiPathSegments(tab.path)
        if (segments.isEmpty()) {
            failTab(tab.id, token, "Unable to open ${tab.path}.")
            return
        }
        val result = captureApi { api.read(segments, tab.sourceSessionId) }
        if (!isCurrent(tab.id, token)) return
        result.fold(
            onSuccess = { read ->
                when (read) {
                    is FileReadResult.Text -> updateTab(tab.id) { current ->
                        val requested = current.requestedMode
                        val language = read.language
                        val nextMode = when (requested) {
                            null -> defaultViewerMode(current.path, language)
                            // The patch is fetched separately; its `supported`
                            // flag is not known yet, so a requested diff must
                            // survive this read (ensureDiff falls back if the
                            // file turns out to have no diff).
                            FileOpenMode.Diff -> FileOpenMode.Diff
                            else -> effectiveViewerMode(
                                requested,
                                availableViewerModes(ViewerKind.Text, language, current.diffSupported),
                            )
                        }
                        current.copy(
                            loading = false,
                            content = read.content,
                            language = language,
                            size = read.size,
                            error = null,
                            binaryMime = null,
                            mode = nextMode,
                        )
                    }

                    is FileReadResult.Binary -> updateTab(tab.id) { current ->
                        current.copy(
                            loading = false,
                            content = null,
                            language = null,
                            size = read.bytes.size.toLong(),
                            binaryMime = read.mimeType,
                            mode = FileOpenMode.Source,
                        )
                    }
                }
            },
            onFailure = { error -> failTab(tab.id, token, error.userMessage()) },
        )
    }

    private suspend fun loadPdf(tab: FileTab, token: Long) {
        val segments = FileLinks.apiPathSegments(tab.path)
        val meta = captureApi { api.meta(segments, tab.sourceSessionId) }
        if (!isCurrent(tab.id, token)) return
        val size = meta.getOrNull()?.size ?: 0
        updateTab(tab.id) { it.copy(size = size) }
        val bytes = captureApi { api.download(segments, tab.sourceSessionId) }
        if (!isCurrent(tab.id, token)) return
        bytes.fold(
            onSuccess = { data ->
                val file = pdfCacheFile(tab.path)
                runCatching { file.writeBytes(data) }.fold(
                    onSuccess = {
                        updateTab(tab.id) {
                            it.copy(loading = false, pdfPath = file.absolutePath, size = data.size.toLong())
                        }
                    },
                    onFailure = { failTab(tab.id, token, "Unable to cache the PDF.") },
                )
            },
            onFailure = { error -> failTab(tab.id, token, error.userMessage()) },
        )
    }

    private suspend fun loadDocx(tab: FileTab, token: Long) {
        val segments = FileLinks.apiPathSegments(tab.path)
        val result = captureApi { api.previewHtml(segments, tab.sourceSessionId) }
        if (!isCurrent(tab.id, token)) return
        result.fold(
            onSuccess = { html ->
                updateTab(tab.id) { it.copy(loading = false, docxHtml = html, content = null) }
            },
            onFailure = { error -> failTab(tab.id, token, error.userMessage()) },
        )
    }

    private fun failTab(id: String, token: Long, message: String) {
        if (!isCurrent(id, token)) return
        updateTab(id) { it.copy(loading = false, error = message) }
    }

    private fun isCurrent(id: String, token: Long): Boolean =
        loadTokens[id] == token && _state.value.tabs.any { it.id == id }

    private fun cancelLoad(id: String) {
        loadJobs.remove(id)?.cancel()
        loadTokens[id] = (loadTokens[id] ?: 0L) + 1
    }

    private fun updateTab(id: String, transform: (FileTab) -> FileTab) {
        _state.update { state ->
            val tab = state.tabs.firstOrNull { it.id == id } ?: return@update state
            state.copy(tabs = state.tabs.map { if (it.id == id) transform(tab) else it })
        }
    }

    private fun pdfCacheFile(path: String): File {
        val directory = File(cacheDir, "files").apply { mkdirs() }
        val digest = MessageDigest.getInstance("SHA-1")
            .digest(path.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        return File(directory, "$digest.pdf")
    }

    // --- Diff ---------------------------------------------------------------

    /** Retries the patch of the active tab (the viewer's diff error state). */
    fun retryDiff() {
        val tab = _state.value.activeTab ?: return
        ensureDiff(tab, force = true)
    }

    private fun ensureDiff(tab: FileTab, force: Boolean = false) {
        val cwd = _state.value.explorer.cwd
        if (cwd == null) {
            updateTab(tab.id) { it.copy(diffLoading = false, diffSupported = false, diffError = "No workspace") }
            return
        }
        if (!force && tab.diff != null) return
        // Per tab: a slow patch of another tab must not discard this one.
        val token = (diffTokens[tab.id] ?: 0L) + 1
        diffTokens[tab.id] = token
        updateTab(tab.id) { it.copy(diffLoading = true, diffError = null) }
        scope.launch {
            val result = captureApi { git.diff(cwd, tab.path) }
            if (diffTokens[tab.id] != token || _state.value.tabs.none { it.id == tab.id }) return@launch
            result.fold(
                onSuccess = { diff ->
                    updateTab(tab.id) { current ->
                        val supported = diff.supported && !diff.patch.isNullOrBlank()
                        current.copy(
                            diffLoading = false,
                            diff = if (supported) diff.patch else null,
                            diffSupported = supported,
                            diffError = null,
                            mode = effectiveViewerMode(
                                if (current.mode == FileOpenMode.Diff && !supported) FileOpenMode.Source else current.mode,
                                availableViewerModes(ViewerKind.Text, current.language, supported),
                            ),
                        )
                    }
                },
                onFailure = { error ->
                    // Stay in Diff: the body shows the error with a retry, so a
                    // flaky fetch does not silently flip the user to Source.
                    updateTab(tab.id) { current ->
                        current.copy(
                            diffLoading = false,
                            diff = null,
                            diffSupported = false,
                            diffError = error.userMessage(),
                        )
                    }
                },
            )
        }
    }

    // --- Live file watch ----------------------------------------------------

    private fun startWatch(tab: FileTab) {
        watchJob?.cancel()
        watchJob = scope.launch {
            try {
                events.subscribe(EventChannel.File(tab.path, tab.sourceSessionId)).collect { frame ->
                    when (frame.frameType()) {
                        "connected" -> updateTab(tab.id) { it.copy(watching = true) }
                        "change" -> {
                            updateTab(tab.id) { it.copy(watching = true) }
                            refreshFromWatch(tab.id)
                        }
                        "error" -> updateTab(tab.id) { it.copy(watching = false) }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: EventSubscriptionException) {
                updateTab(tab.id) { it.copy(watching = false) }
            } catch (_: Exception) {
                updateTab(tab.id) { it.copy(watching = false) }
            }
        }
    }

    private fun stopWatch() {
        watchJob?.cancel()
        watchJob = null
        _state.update { state ->
            state.copy(tabs = state.tabs.map { it.copy(watching = false) })
        }
    }

    private fun refreshFromWatch(id: String) {
        val tab = _state.value.tabs.firstOrNull { it.id == id } ?: return
        when (viewerKind(tab.path)) {
            ViewerKind.Image -> updateTab(id) { it.copy(imageVersion = it.imageVersion + 1) }
            ViewerKind.Pdf, ViewerKind.Docx, ViewerKind.Text -> {
                // Keep the mode; a changed markdown file must not jump from
                // Preview back to Source. A diff tab reloads only its patch.
                if (tab.mode != FileOpenMode.Diff) startLoad(tab.copy(requestedMode = tab.mode, loading = false))
            }
        }
        if (tab.mode == FileOpenMode.Diff || tab.diff != null) ensureDiff(tab, force = true)
    }

    // --- Lifecycle ----------------------------------------------------------

    /** Logout / server switch: every path belonged to the previous installation. */
    fun reset() {
        watchJob?.cancel()
        searchJob?.cancel()
        cancelUpload()
        loadJobs.values.forEach { it.cancel() }
        loadJobs.clear()
        loadingDirectories.clear()
        pendingUpload = emptyList()
        cwdGeneration++
        gitGeneration++
        searchGeneration++
        diffTokens.clear()
        _state.value = FilesUiState()
        File(cacheDir, "files").deleteRecursively()
        scope.launch { tabStore.clear() }
    }

    private fun persistTabs() {
        val stored = _state.value.tabs.map { StoredFileTab(path = it.path, sourceSessionId = it.sourceSessionId) }
        val token = origin()
        scope.launch { runCatching { tabStore.save(token, stored) } }
    }

    private companion object {
        const val SEARCH_DEBOUNCE_MILLIS = 150L
        const val REVEAL_TIMEOUT_MILLIS = 1500L
    }
}

private fun JsonObject.frameType(): String? =
    (this["type"] as? kotlinx.serialization.json.JsonPrimitive)?.contentOrNull
