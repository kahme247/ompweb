package io.github.kahme247.ompweb.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.data.SessionListCache
import io.github.kahme247.ompweb.data.WorkspacePreferences
import io.github.kahme247.ompweb.domain.NavigationEntry
import io.github.kahme247.ompweb.domain.NavigationHistory
import io.github.kahme247.ompweb.domain.applyRunningTransition
import io.github.kahme247.ompweb.domain.comparableProjectPath
import io.github.kahme247.ompweb.domain.pruneUnread
import io.github.kahme247.ompweb.domain.sortManagedProjects
import io.github.kahme247.ompweb.domain.transcriptToMarkdown
import io.github.kahme247.ompweb.domain.workspaceKeyOf
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.events.EventChannel
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.events.EventSubscriptionException
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.AppInfo
import io.github.kahme247.ompweb.net.CwdValidation
import io.github.kahme247.ompweb.net.ApiError
import io.github.kahme247.ompweb.net.ArchiveEntry
import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.net.ExitedSession
import io.github.kahme247.ompweb.net.ExportedSession
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.ProjectLaunchConfig
import io.github.kahme247.ompweb.net.ProjectList
import io.github.kahme247.ompweb.net.RunningSession
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.SessionList
import io.github.kahme247.ompweb.net.SessionListAnswer
import io.github.kahme247.ompweb.net.SessionSearchHit
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.net.SessionDetail
import io.github.kahme247.ompweb.net.SessionInfo
import io.github.kahme247.ompweb.net.captureApi
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** Why a session or project request failed; the screen owns the wording. */
sealed interface SessionsLoadError {
    data object Network : SessionsLoadError
    data object Forbidden : SessionsLoadError
    data object Misconfigured : SessionsLoadError
    data class Server(val code: Int) : SessionsLoadError
}

/** One-shot snackbar payload; [id] makes repeated identical texts visible. */
data class UiNotice(val id: Long, val text: String, val error: Boolean = false)

/** Header data of the open session (messages stay out of the state). */
data class SessionDetailView(
    val info: SessionInfo,
    val model: String? = null,
    val thinkingLevel: String? = null,
    val branch: String? = null,
    val currentWorktreePath: String? = null,
    val projectRoot: String? = null,
)

/** Which corpus the search field scans. */
enum class SessionSearchMode {
    /** Titles and first user messages of the already-loaded list. */
    Sessions,

    /** Full text across every session file (`GET /api/sessions/messages/search`). */
    Messages,
}

/**
 * The last message-search request. [query] is the query the page in [results]
 * belongs to (a stale "Load more" must not pair its [cursor] with a newer
 * query); [partial] means the server stopped early (time/byte budget) and
 * another request can continue. [skippedFiles] sums the session files the
 * server could not search at all (larger than its scan limit) over the pages of
 * [query], so "no matches" can be qualified instead of claimed.
 *
 * [autoPages] counts the follow-up pages this run requested on its own (a
 * `partial` page with no row), so the results can show a progress state while
 * the scan continues; it is 0 again with every new query.
 */
data class MessageSearchState(
    val query: String = "",
    val loading: Boolean = false,
    val results: List<SessionSearchHit> = emptyList(),
    val partial: Boolean = false,
    val cursor: String? = null,
    val skippedFiles: Int = 0,
    val error: String? = null,
    val autoPages: Int = 0,
)

data class ArchiveUiState(
    val open: Boolean = false,
    val loading: Boolean = false,
    val entries: List<ArchiveEntry> = emptyList(),
    val error: String? = null,
    val search: String = "",
    val selectedKey: String? = null,
    val restoringKey: String? = null,
)

/** Progress of the auto-name action for one session (A5). */
enum class AutoNamePhase { Idle, Naming, Success, Error }

/**
 * The last auto-name attempt: [sessionId] and [title] belong to the result of
 * [phase]. The session menus disable the item while its session is naming;
 * the detail header shows spinner, check or error for exactly this id.
 */
data class AutoNameStatus(
    val sessionId: String? = null,
    val phase: AutoNamePhase = AutoNamePhase.Idle,
    val title: String? = null,
) {
    fun isNaming(id: String): Boolean = phase == AutoNamePhase.Naming && sessionId == id
}

data class SessionsUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val sessions: List<SessionSummary> = emptyList(),
    val projects: List<ManagedProject> = emptyList(),
    val projectsLoaded: Boolean = false,
    val projectsError: SessionsLoadError? = null,
    val runningIds: Set<String> = emptySet(),
    val runningCwds: Map<String, String> = emptyMap(),
    /**
     * The running badges are backed by server data: a `GET /api/sessions`
     * answer or a `running` frame. A cache-first list knows none of them, so
     * it shows *Updating…* instead of pretending nothing runs.
     */
    val runningKnown: Boolean = false,
    val exited: Map<String, ExitedSession> = emptyMap(),
    /**
     * Sessions another omp process owns, by id (server `elsewhereSessions` and
     * the `running` frame). Kept apart from [runningIds]: an unread badge or a
     * notification must never follow a run this server does not drive.
     */
    val elsewhere: Map<String, ElsewhereSession> = emptyMap(),
    val unreadIds: Set<String> = emptySet(),
    /** `null` = nothing stored yet; only the active project expands. */
    val expandedProjects: Set<String>? = null,
    val activeCwd: String? = null,
    val home: String? = null,
    val selectedSessionId: String? = null,
    val newSessionCwd: String? = null,
    val detail: SessionDetailView? = null,
    val detailLoading: Boolean = false,
    val detailError: SessionsLoadError? = null,
    val searchQuery: String = "",
    val searchOpen: Boolean = false,
    /** Metadata filter (titles/first messages) or full-text message search. */
    val searchMode: SessionSearchMode = SessionSearchMode.Sessions,
    /**
     * The server advertises `capabilities.messageSearch`, so
     * `GET /api/sessions/messages/search` exists. A server without it hides
     * the "In messages" mode instead of failing with 404.
     */
    val messageSearchSupported: Boolean = false,
    val messageSearch: MessageSearchState = MessageSearchState(),
    /** Session ids pinned for the current server origin. */
    val pinnedIds: Set<String> = emptySet(),
    val runningOnly: Boolean = false,
    val error: SessionsLoadError? = null,
    val connection: ConnectionState = ConnectionState.Reconnecting,
    val liveUpdates: Boolean = true,
    val notice: UiNotice? = null,
    val archive: ArchiveUiState = ArchiveUiState(),
    val autoName: AutoNameStatus = AutoNameStatus(),
)

/**
 * The workspace home: session list, managed projects, live running badges,
 * unread markers, expansion memory, the open session header and the archive
 * browser.
 *
 * The list comes from `GET /api/sessions` and `GET /api/projects`; the
 * `running` channel keeps badges current and asks for a reload whenever the
 * server reports a session file change. After every reconnect the list is
 * reloaded, because the server keeps no replay buffer.
 *
 * Navigation history is in memory (like the web's `lib/navigation-history.ts`)
 * and the system back stack is driven by the screen: back steps through this
 * history before leaving the app. Dead entries (deleted sessions) are dropped
 * on traversal instead of showing an error.
 */
class SessionsViewModel(
    private val api: ApiClient,
    private val eventMux: EventMux,
    private val preferences: WorkspacePreferences,
    private val originNow: () -> ServerAddress?,
    /**
     * The shell's `GET /api/app-info` answer for the configured server. Its
     * `messageSearch` capability decides whether "In messages" exists at all;
     * the default keeps the mode off until the handshake has arrived.
     */
    serverInfo: StateFlow<AppInfo?> = MutableStateFlow(null),
    /**
     * Cache-first storage for the list and the project list. `null` disables
     * seeding (JVM tests); the container passes the `SessionCacheStore`.
     */
    private val cache: SessionListCache? = null,
    /**
     * Where the cache is read and written. `Dispatchers.IO` in the app; the
     * JVM tests pass their test dispatcher so a seed lands deterministically
     * before the request.
     */
    private val cacheDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    private val json = Json { ignoreUnknownKeys = true }

    private val _state = MutableStateFlow(SessionsUiState())
    val state: StateFlow<SessionsUiState> = _state.asStateFlow()

    private val _history = MutableStateFlow(NavigationHistory())
    val history: StateFlow<NavigationHistory> = _history.asStateFlow()

    private val active = MutableStateFlow(false)
    private val retryTicks = MutableStateFlow(0)
    private var loadJob: Job? = null
    private var delayedLoadJob: Job? = null
    private var detailJob: Job? = null
    private var archiveJob: Job? = null
    private var messageSearchJob: Job? = null

    /** Orders message-search responses; a stale answer must not overwrite a newer query. */
    private var messageSearchGeneration = 0L

    /** Origin of the list in state; `null` means "no list". */
    private var loadedOrigin: String? = null

    /**
     * The origin whose list/projects the server answered in this process. A
     * cached list may only fill an empty state, never replace a live answer.
     */
    private var liveListOrigin: String? = null
    private var liveProjectsOrigin: String? = null

    /** Incremented by every `running` frame that carries ids; orders them against GET snapshots. */
    private var runningFrameVersion = 0L

    /** Orders list responses: an older GET must never overwrite a newer one. */
    private var sessionsGeneration = 0L

    /** Same for the project list (reorder/reload races). */
    private var projectsGeneration = 0L

    /** Invalidates stale session-detail responses after a view switch. */
    private var detailGeneration = 0L

    /** Sessions this process just created; their file may lag behind the list. */
    private val recentlyCreated = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private var seededFromSettings = false
    private var noticeCounter = 0L

    /**
     * Workspace memory writes go through one queue. Two independent
     * `viewModelScope.launch` calls could finish out of order and leave the
     * *older* value in storage (the unread badge reappeared after a reload);
     * one consumer keeps the call order, so the last change wins.
     */
    private val preferenceWrites = Channel<suspend () -> Unit>(Channel.UNLIMITED)

    init {
        viewModelScope.launch {
            for (write in preferenceWrites) write()
        }
        viewModelScope.launch {
            serverInfo.collect { info ->
                val supported = info?.supportsMessageSearch == true
                if (!supported && _state.value.searchMode == SessionSearchMode.Messages) {
                    messageSearchJob?.cancel()
                    messageSearchGeneration++
                }
                _state.update { current ->
                    when {
                        current.messageSearchSupported == supported -> current
                        // A server that never had the route (or lost it after a
                        // switch/restart) must not stay in a mode whose every
                        // request would answer 404.
                        !supported && current.searchMode == SessionSearchMode.Messages -> current.copy(
                            messageSearchSupported = false,
                            searchMode = SessionSearchMode.Sessions,
                            messageSearch = MessageSearchState(),
                        )
                        else -> current.copy(messageSearchSupported = supported)
                    }
                }
            }
        }
        viewModelScope.launch {
            val snapshot = preferences.snapshot.first { it.loaded }
            if (!seededFromSettings) {
                seededFromSettings = true
                _state.update {
                    it.copy(
                        expandedProjects = it.expandedProjects ?: snapshot.expandedProjects,
                        unreadIds = if (it.unreadIds.isEmpty()) snapshot.unreadSessionIds else it.unreadIds,
                        pinnedIds = if (it.pinnedIds.isEmpty()) {
                            snapshot.pinnedSessionsByOrigin[originNow()?.origin ?: snapshot.origin?.origin].orEmpty()
                        } else {
                            it.pinnedIds
                        },
                    )
                }
                maybeSeedProjectExpansion()
            }
        }
        viewModelScope.launch {
            active.collectLatest { isActive ->
                if (!isActive) return@collectLatest
                try {
                    monitor()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: ApiError) {
                    _state.update {
                        it.copy(loading = false, refreshing = false, error = error.toLoadError())
                    }
                }
            }
        }
    }

    /** The screen became visible ([active] = true) or left the stage. */
    fun setActive(active: Boolean) {
        this.active.value = active
    }

    fun refresh() {
        delayedLoadJob?.cancel()
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    fun retryConnection() {
        eventMux.retryNow()
        refresh()
        if (!_state.value.liveUpdates) retryTicks.update { it + 1 }
    }

    private suspend fun monitor(): Unit = coroutineScope {
        loadJob?.cancel()
        loadJob = launch { load() }
        launch {
            var wasConnected = false
            eventMux.state.collect { connection ->
                _state.update { it.copy(connection = connection) }
                if (connection == ConnectionState.Connected) {
                    // A reconnect revalidates the list (the server replays
                    // nothing). So does the first connection of a process
                    // whose initial load failed: an offline start shows the
                    // cached list, and arriving on the network must refresh it
                    // without the user tapping Retry.
                    val stale = _state.value.error != null || _state.value.projectsError != null
                    if (wasConnected || stale) scheduleReload()
                    wasConnected = true
                }
            }
        }
        launch {
            retryTicks.collectLatest {
                try {
                    eventMux.subscribe(EventChannel.Running).collect { frame -> onRunningFrame(frame) }
                } catch (_: EventSubscriptionException) {
                    _state.update { it.copy(liveUpdates = false) }
                }
            }
        }
        awaitCancellation()
    }

    // --- List loading -------------------------------------------------------

    private suspend fun load() {
        val origin = originNow()
        if (origin == null) {
            // Sign-out: drop the server's data but keep the persisted
            // workspace memory so a re-login does not reseed (and overwrite)
            // the stored expansion selection.
            loadedOrigin = null
            liveListOrigin = null
            liveProjectsOrigin = null
            messageSearchJob?.cancel()
            messageSearchGeneration++
            val current = _state.value
            _state.value = SessionsUiState(
                loading = false,
                expandedProjects = current.expandedProjects,
                unreadIds = current.unreadIds,
            )
            return
        }
        val originKey = origin.origin
        val previousOrigin = loadedOrigin
        // A cold start is not an origin change: the seed from the settings
        // snapshot (expansion memory, unread ids) must survive the first
        // load, otherwise every start overwrites the stored selection.
        if (previousOrigin != null && originKey != previousOrigin) {
            messageSearchJob?.cancel()
            messageSearchGeneration++
            _state.update {
                it.copy(
                    sessions = emptyList(),
                    projects = emptyList(),
                    projectsLoaded = false,
                    projectsError = null,
                    runningIds = emptySet(),
                    runningCwds = emptyMap(),
                    runningKnown = false,
                    exited = emptyMap(),
                    elsewhere = emptyMap(),
                    unreadIds = emptySet(),
                    expandedProjects = null,
                    // Pins belong to the origin that issued the ids; carrying
                    // them across a server switch would pin unrelated sessions.
                    pinnedIds = preferences.snapshot.value.pinnedSessionsByOrigin[originKey].orEmpty(),
                    searchOpen = false,
                    searchQuery = "",
                    searchMode = SessionSearchMode.Sessions,
                    messageSearch = MessageSearchState(),
                    activeCwd = null,
                    home = null,
                    selectedSessionId = null,
                    newSessionCwd = null,
                    detail = null,
                    detailLoading = false,
                    detailError = null,
                    error = null,
                )
            }
            _history.value = NavigationHistory()
            liveListOrigin = null
            liveProjectsOrigin = null
        }
        loadedOrigin = originKey
        if (previousOrigin == null) {
            // Cold start (or sign-out → re-login): the snapshot may already
            // hold pins for this origin. A later emission cannot corrupt this
            // value because it is the persisted, origin-keyed state.
            _state.update {
                it.copy(pinnedIds = preferences.snapshot.value.pinnedSessionsByOrigin[originKey].orEmpty())
            }
        }
        // Cache-first: the last known workspace is painted before the first
        // request leaves, so a cold start shows its list in a few milliseconds
        // instead of waiting for the server. The answer below replaces it; a
        // cache entry can never overwrite a list the server already delivered.
        seedFromCache(originKey)
        _state.update {
            it.copy(
                loading = it.sessions.isEmpty(),
                refreshing = it.sessions.isNotEmpty(),
                error = null,
            )
        }
        coroutineScope {
            launch { loadSessions(originKey) }
            launch { loadProjects(originKey) }
            launch { loadHome(originKey) }
        }
    }

    private suspend fun loadSessions(originKey: String) {
        val generation = ++sessionsGeneration
        val runningVersion = runningFrameVersion
        val result = captureApi { api.sessionListAnswer() }
        if (generation != sessionsGeneration) return
        if (originNow()?.origin != originKey) return
        result.fold(
            onSuccess = { answer ->
                val list = answer.list
                liveListOrigin = originKey
                persistList(originKey, answer)
                val previousRunning = _state.value.runningIds
                val authoritativeRunning = runningFrameVersion == runningVersion
                val running = if (authoritativeRunning) list.runningSessionIds.toSet() else previousRunning
                val runningCwds = if (authoritativeRunning) {
                    list.runningSessions.associate { it.id to it.cwd }
                } else {
                    _state.value.runningCwds
                }
                val elsewhere = if (authoritativeRunning) {
                    list.elsewhereSessions.associateBy { it.id }
                } else {
                    _state.value.elsewhere
                }
                val alive = list.sessions.mapTo(HashSet()) { it.id }.apply { addAll(running) }
                // Recompute the transition inside the update: a selection that
                // cleared the badge while this response was in flight must not
                // be overwritten by a set derived from the older state.
                val unreadBefore = _state.value.unreadIds
                _state.update { current ->
                    val transitioned = if (authoritativeRunning) {
                        applyRunningTransition(
                            previousRunning,
                            running,
                            current.selectedSessionId,
                            current.unreadIds,
                        )
                    } else {
                        current.unreadIds
                    }
                    current.copy(
                        loading = false,
                        refreshing = false,
                        sessions = list.sessions,
                        runningIds = running,
                        runningCwds = runningCwds,
                        runningKnown = true,
                        elsewhere = elsewhere,
                        // `GET /api/sessions` does not send exitedSessions; only
                        // the running frames do. Taking the empty default here
                        // cleared every exited badge on each reload.
                        unreadIds = pruneUnread(transitioned, alive),
                        error = null,
                    )
                }
                if (_state.value.unreadIds != unreadBefore) persistUnread()
                maybeSeedProjectExpansion()
            },
            onFailure = { error ->
                if (error is ApiError.NotConfigured) {
                    loadedOrigin = null
                    _state.value = SessionsUiState(
                        loading = false,
                        expandedProjects = _state.value.expandedProjects,
                        unreadIds = _state.value.unreadIds,
                    )
                    return
                }
                _state.update {
                    it.copy(loading = false, refreshing = false, error = error.toLoadError())
                }
            },
        )
    }

    private suspend fun loadProjects(originKey: String) {
        val generation = ++projectsGeneration
        val result = captureApi { api.projects() }
        if (generation != projectsGeneration) return
        if (originNow()?.origin != originKey) return
        result.fold(
            onSuccess = { list ->
                liveProjectsOrigin = originKey
                persistProjects(originKey, list)
                val sorted = sortManagedProjects(list.projects)
                _state.update {
                    it.copy(projects = sorted, projectsLoaded = true, projectsError = null)
                }
                pruneExpansion(sorted)
                maybeSeedProjectExpansion()
            },
            onFailure = { error ->
                // Cache-first: when project rows are already on screen (from
                // the disk cache) a failed revalidation must not paint
                // "Projects could not be loaded." above them — offline the
                // reconnect banner already says the server is unreachable.
                // That is the rule the session list follows too. Without any
                // rows there is nothing else to show, so the error stays.
                _state.update { current ->
                    if (current.projects.isNotEmpty()) current
                    else current.copy(projectsLoaded = true, projectsError = error.toLoadError())
                }
            },
        )
    }

    private suspend fun loadHome(originKey: String) {
        if (_state.value.home != null) return
        val result = captureApi { api.homeDirectory() }
        if (originNow()?.origin != originKey) return
        result.onSuccess { home -> _state.update { it.copy(home = home) } }
    }

    // --- Cache-first ---------------------------------------------------------

    /**
     * Fills an empty workspace from the disk cache of [originKey]. Two guards
     * keep a cached payload from ever replacing live data: the state must be
     * empty and the server must not have answered for this origin yet in this
     * process ([liveListOrigin]/[liveProjectsOrigin]).
     *
     * The cached list also carries its ETag into [ApiClient], so the reload
     * that follows can be a `304` that keeps exactly this list.
     */
    private suspend fun seedFromCache(originKey: String) {
        val cache = cache ?: return
        if (_state.value.sessions.isEmpty() && liveListOrigin != originKey) {
            val stored = withContext(cacheDispatcher) { cache.readSessions(originKey) }
            val list = stored?.let { entry ->
                runCatching { json.decodeFromString(SessionList.serializer(), entry.body) }.getOrNull()
            }
            if (list != null && list.sessions.isNotEmpty()) {
                api.primeSessionList(list, stored.etag)
                _state.update { current ->
                    // A response that landed while the file was read wins. The
                    // flags move in the same update: the cached rows are
                    // already on screen, so a spinner over them would be wrong
                    // (and `loading` could otherwise be observed beside a
                    // non-empty list).
                    if (current.sessions.isNotEmpty()) {
                        current
                    } else {
                        current.copy(sessions = list.sessions, loading = false, refreshing = true)
                    }
                }
                maybeSeedProjectExpansion()
            }
        }
        if (!_state.value.projectsLoaded && liveProjectsOrigin != originKey) {
            val body = withContext(cacheDispatcher) { cache.readProjects(originKey) }
            val projects = body?.let { stored ->
                runCatching { json.decodeFromString(ProjectList.serializer(), stored) }.getOrNull()
            }
            if (projects != null) {
                val sorted = sortManagedProjects(projects.projects)
                _state.update { current ->
                    if (current.projectsLoaded) current else current.copy(projects = sorted, projectsLoaded = true)
                }
                maybeSeedProjectExpansion()
            }
        }
    }

    /** Write-through of the list the server just sent, with its validator. */
    private suspend fun persistList(originKey: String, answer: SessionListAnswer) {
        val cache = cache ?: return
        val body = runCatching { json.encodeToString(SessionList.serializer(), answer.list) }.getOrNull() ?: return
        withContext(cacheDispatcher) { cache.writeSessions(originKey, body, answer.etag) }
    }

    private suspend fun persistProjects(originKey: String, list: ProjectList) {
        val cache = cache ?: return
        val body = runCatching { json.encodeToString(ProjectList.serializer(), list) }.getOrNull() ?: return
        withContext(cacheDispatcher) { cache.writeProjects(originKey, body) }
    }

    /**
     * First successful project fetch: when nothing is stored, expand only the
     * active project (falling back to the top project) and remember it.
     */
    private fun maybeSeedProjectExpansion() {
        val current = _state.value
        if (!current.projectsLoaded || current.expandedProjects != null) return
        val activeKey = current.activeCwd?.let(::comparableProjectPath)
        val seed = activeKey?.takeIf { key -> current.projects.any { comparableProjectPath(it.path) == key } }
            ?: current.projects.firstOrNull()?.let { comparableProjectPath(it.path) }
        val expanded = seed?.let { setOf(it) } ?: emptySet()
        _state.update {
            it.copy(
                expandedProjects = expanded,
                activeCwd = it.activeCwd ?: current.projects.firstOrNull()?.path,
            )
        }
        persistExpanded(expanded)
    }

    private fun pruneExpansion(projects: List<ManagedProject>) {
        val stored = _state.value.expandedProjects ?: return
        val valid = projects.mapTo(HashSet()) { comparableProjectPath(it.path) }
        val pruned = stored.filterTo(linkedSetOf()) { it in valid }
        if (pruned.size != stored.size) {
            _state.update { it.copy(expandedProjects = pruned) }
            persistExpanded(pruned)
        }
    }

    private fun persistExpanded(projects: Set<String>) {
        preferenceWrites.trySend { preferences.setExpandedProjects(projects) }
    }

    /**
     * Writes the unread set **as it is when the write runs**. Sampling the
     * state instead of capturing a value at the call site is what keeps a
     * reload that resolved against an older state from storing the badge
     * again after the selection already cleared it.
     */
    private fun persistUnread() {
        preferenceWrites.trySend { preferences.setUnreadSessionIds(_state.value.unreadIds) }
    }

    /** Session files change in bursts; one reload per burst is enough. */
    private fun scheduleReload() {
        delayedLoadJob?.cancel()
        delayedLoadJob = viewModelScope.launch {
            delay(RELOAD_DEBOUNCE_MILLIS)
            load()
        }
    }

    private fun onRunningFrame(frame: JsonObject) {
        try {
            val ids = (frame["runningSessionIds"] as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                ?.toSet()
            if (ids != null) runningFrameVersion++
            val runningSessions = parseRunningSessions(frame["runningSessions"])
            val exitedSessions = parseExitedSessions(frame["exitedSessions"])
            // A frame that carries the field replaces the map wholesale: an
            // owner that ended must drop its badge even though the id list
            // itself is unchanged.
            val elsewhereSessions = parseElsewhereSessions(frame["elsewhereSessions"])
            val refresh = (frame["refreshSessionList"] as? JsonPrimitive)?.booleanOrNull == true ||
                frame["type"]?.jsonPrimitive?.contentOrNull == "sessions-changed"
            val previous = _state.value
            val running = ids ?: previous.runningIds
            var unread = previous.unreadIds
            if (ids != null) {
                unread = applyRunningTransition(
                    previous.runningIds,
                    running,
                    previous.selectedSessionId,
                    previous.unreadIds,
                )
            }
            _state.update {
                it.copy(
                    runningIds = running,
                    // Only a frame that carries the id list settles the badges;
                    // a partial frame says nothing about them.
                    runningKnown = previous.runningKnown || ids != null,
                    runningCwds = runningSessions?.associate { session -> session.id to session.cwd }
                        ?: previous.runningCwds,
                    exited = exitedSessions?.associateBy { session -> session.id } ?: previous.exited,
                    elsewhere = elsewhereSessions?.associateBy { session -> session.id } ?: previous.elsewhere,
                    unreadIds = unread,
                    liveUpdates = true,
                )
            }
            if (unread != previous.unreadIds) persistUnread()
            if (refresh) scheduleReload()
        } catch (_: Exception) {
            // A malformed frame must never crash the list.
        }
    }

    private fun parseRunningSessions(element: kotlinx.serialization.json.JsonElement?): List<RunningSession>? =
        (element as? JsonArray)?.mapNotNull { item ->
            try {
                json.decodeFromJsonElement(RunningSession.serializer(), item)
            } catch (_: Exception) {
                null
            }
        }

    private fun parseExitedSessions(element: kotlinx.serialization.json.JsonElement?): List<ExitedSession>? =
        (element as? JsonArray)?.mapNotNull { item ->
            try {
                json.decodeFromJsonElement(ExitedSession.serializer(), item)
            } catch (_: Exception) {
                null
            }
        }

    private fun parseElsewhereSessions(element: kotlinx.serialization.json.JsonElement?): List<ElsewhereSession>? =
        (element as? JsonArray)?.mapNotNull { item ->
            try {
                // One entry per session: an entry without an id cannot be shown
                // under a row (the single-session report omits it on purpose).
                json.decodeFromJsonElement(ElsewhereSession.serializer(), item).takeIf { it.id.isNotBlank() }
            } catch (_: Exception) {
                null
            }
        }

    // --- View selection and navigation history ------------------------------

    fun selectSession(id: String, recordHistory: Boolean = true) {
        val summary = _state.value.sessions.firstOrNull { it.id == id }
        val cwd = summary?.cwd ?: _state.value.runningCwds[id] ?: _state.value.activeCwd
        showSession(id, cwd, recordHistory)
    }

    /** A session just created by the new-session pane (or restored archive). */
    fun openCreatedSession(id: String, cwd: String? = null) {
        recentlyCreated += id
        showSession(id, cwd ?: _state.value.activeCwd, recordHistory = true)
        viewModelScope.launch { load() }
    }

    private fun showSession(id: String, cwd: String?, recordHistory: Boolean, fresh: Boolean = false) {
        val entry = NavigationEntry(sessionId = id, cwd = cwd)
        if (recordHistory) _history.update { it.push(entry) }
        detailGeneration++
        detailJob?.cancel()
        // The web drops the id from the unread set whenever the selected
        // session changes (SessionSidebar.tsx effect on selectedSessionId).
        val unread = _state.value.unreadIds
        val withoutId = unread - id
        if (withoutId != unread) {
            _state.update { it.copy(unreadIds = withoutId) }
            persistUnread()
        }
        _state.update {
            val projectKey = it.sessions.firstOrNull { session -> session.id == id }?.let { session -> workspaceKeyOf(session) }
            it.copy(
                selectedSessionId = id,
                newSessionCwd = null,
                detail = null,
                detailLoading = true,
                detailError = null,
                activeCwd = projectKey ?: cwd ?: it.activeCwd,
            )
        }
        val generation = detailGeneration
        detailJob = viewModelScope.launch { loadDetail(id, generation, fresh) }
    }

    fun startNewSession(cwd: String? = null) {
        val fallback = _state.value.activeCwd ?: _state.value.projects.firstOrNull()?.path
        val target = cwd ?: fallback
        if (target != null) {
            showNewSession(target, recordHistory = true)
            return
        }
        viewModelScope.launch {
            val result = captureApi { api.defaultCwd() }
            result.fold(
                onSuccess = { resolved -> showNewSession(resolved, recordHistory = true) },
                onFailure = { error -> showNotice(error.userMessage(), error = true) },
            )
        }
    }

    private fun showNewSession(cwd: String, recordHistory: Boolean) {
        detailGeneration++
        detailJob?.cancel()
        rememberLastView(newSessionCwd = cwd)
        if (recordHistory) _history.update { it.push(NavigationEntry(sessionId = null, cwd = cwd)) }
        _state.update {
            it.copy(
                selectedSessionId = null,
                newSessionCwd = cwd,
                detail = null,
                detailLoading = false,
                detailError = null,
                activeCwd = cwd,
            )
        }
    }

    /**
     * Cold-start restore of the new-session pane. The saved workspace is
     * validated first (`POST /api/cwd/validate`): a stale path drops the pane
     * and reports why, so the list stays usable (web `AppShell` restore).
     */
    fun restoreNewSession(cwd: String) {
        viewModelScope.launch {
            val result = captureApi { api.validateCwd(cwd) }
            result.fold(
                onSuccess = { validation ->
                    when (validation) {
                        is CwdValidation.Valid -> showNewSession(validation.cwd, recordHistory = false)
                        is CwdValidation.Invalid -> {
                            preferences.clearLastNewSessionView()
                            val reason = validation.message ?: validation.code
                            showNotice(
                                if (reason == null) "Workspace unavailable" else "Workspace unavailable: $reason",
                                error = true,
                            )
                        }
                    }
                },
                onFailure = { error -> showNotice(error.userMessage(), error = true) },
            )
        }
    }

    /**
     * Keeps `lastSessionId` and the new-session cwd mutually exclusive (one
     * atomic write). Written when the session's detail has loaded, so the
     * marker only ever names a session this installation really displayed: a
     * dead link 404s before this call and leaves the previous view in place
     * (a session deleted while it is open is still cleared by
     * [dropMissingSession]).
     */
    private fun rememberSessionView(sessionId: String) {
        viewModelScope.launch { preferences.setLastSessionView(sessionId) }
    }

    /** Keeps `lastSessionId` and the new-session cwd mutually exclusive (one atomic write). */
    private fun rememberLastView(newSessionCwd: String?) {
        viewModelScope.launch {
            if (newSessionCwd == null) {
                preferences.clearLastNewSessionView()
            } else {
                preferences.setLastNewSessionView(newSessionCwd)
            }
        }
    }

    /** Opens the composer for a project card (or the top project). */
    fun newSessionInProject(projectPath: String) {
        expandProject(projectPath, expand = true)
        showNewSession(projectPath, recordHistory = true)
    }

    fun reloadDetail() {
        val id = _state.value.selectedSessionId ?: return
        val cwd = _state.value.detail?.info?.cwd
            ?: _state.value.sessions.firstOrNull { it.id == id }?.cwd
        showSession(id, cwd, recordHistory = false, fresh = true)
    }

    /** Leaves the open session/composer (system back past the list). */
    fun closeDetail(): Boolean {
        val current = _state.value
        if (current.selectedSessionId == null && current.newSessionCwd == null) return false
        detailGeneration++
        detailJob?.cancel()
        rememberLastView(newSessionCwd = null)
        _state.update {
            it.copy(
                selectedSessionId = null,
                newSessionCwd = null,
                detail = null,
                detailLoading = false,
                detailError = null,
            )
        }
        return true
    }

    fun navigateBack(): Boolean = stepHistory(-1)

    fun navigateForward(): Boolean = stepHistory(1)

    private fun stepHistory(direction: Int): Boolean {
        var cursor = _history.value
        if (direction < 0 && !cursor.canBack) return false
        if (direction > 0 && !cursor.canForward) return false
        while (true) {
            val targetIndex = cursor.index + direction
            if (targetIndex < 0 || targetIndex >= cursor.entries.size) return false
            val entry = cursor.entries[targetIndex]
            val id = entry.sessionId
            if (id != null && !_state.value.loading && !sessionExists(id)) {
                // The target was deleted/archived: skip it permanently.
                cursor = cursor.removeAt(targetIndex)
                _history.value = cursor
                if (direction < 0 && !cursor.canBack) return false
                if (direction > 0 && !cursor.canForward) return false
                continue
            }
            cursor = cursor.step(direction)
            _history.value = cursor
            val current = cursor.current ?: return false
            if (current.sessionId == null) {
                showNewSession(current.cwd ?: _state.value.activeCwd ?: "", recordHistory = false)
            } else {
                showSession(current.sessionId, current.cwd, recordHistory = false)
            }
            return true
        }
    }

    private fun sessionExists(id: String): Boolean =
        _state.value.sessions.any { it.id == id } || id in _state.value.runningIds

    // --- Detail -------------------------------------------------------------

    private suspend fun loadDetail(id: String, generation: Long, fresh: Boolean = false) {
        var attempt = 0
        while (true) {
            val result = captureApi {
                if (fresh) api.sessionDetailFresh(id) else api.sessionDetail(id)
            }
            val succeeded = result.isSuccess
            if (generation != detailGeneration) return
            if (succeeded) {
                val detail = result.getOrThrow()
                applyDetail(detail, generation, id)
                return
            }
            val error = result.exceptionOrNull()
            // The session file appears a moment after `ensure_session`, so the
            // first open of a fresh session 404s. `requireSuccess` reports
            // that as a plain Http code (it does not parse the JSON error
            // body), so both representations count as "not on disk yet".
            val notYetOnDisk = when (error) {
                is ApiError.ServerResponse -> error.status == 404
                is ApiError.Http -> error.code == 404
                else -> false
            }
            // A 404 for an id the list and the running set do not know (and
            // this process did not just create) is a dead link: retrying only
            // delays the way back to the list. The web's URL guard drops the
            // id the same way.
            if (notYetOnDisk && !sessionExists(id) && id !in recentlyCreated) {
                dropMissingSession(id)
                return
            }
            if (notYetOnDisk && attempt < INITIAL_RESTORE_MAX_ATTEMPTS) {
                attempt++
                delay(INITIAL_RESTORE_RETRY_MILLIS)
                if (generation != detailGeneration) return
                continue
            }
            _state.update {
                it.copy(detail = null, detailLoading = false, detailError = error?.toLoadError() ?: SessionsLoadError.Network)
            }
            return
        }
    }

    private suspend fun applyDetail(detail: SessionDetail, generation: Long, id: String) {
        val info = detail.info ?: run {
            _state.update { it.copy(detailLoading = false, detailError = SessionsLoadError.Server(500)) }
            return
        }
        val model = detail.context?.model?.let { current ->
            listOfNotNull(current.provider.takeIf { it.isNotBlank() }, current.modelId.takeIf { it.isNotBlank() })
                .joinToString("/")
                .takeIf { it.isNotEmpty() }
        }
        _state.update {
            it.copy(
                detailLoading = false,
                detailError = null,
                detail = SessionDetailView(
                    info = info,
                    model = model,
                    thinkingLevel = detail.context?.thinkingLevel,
                ),
                activeCwd = info.projectKey ?: it.activeCwd,
            )
        }
        // The marker names a session the reader actually saw: it is written
        // once the detail is on screen, so a dead link (which never loads) can
        // not overwrite the view the user left behind.
        rememberSessionView(id)
        val cwd = info.cwd
        if (cwd.isBlank()) return
        val worktrees = try {
            api.worktrees(cwd)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: ApiError) {
            null
        }
        if (generation != detailGeneration) return
        if (worktrees != null) {
            val currentPath = worktrees.currentWorktreePath ?: cwd
            val branch = worktrees.worktrees.firstOrNull { it.path == currentPath }?.branch
                ?: info.worktreeBranch
            _state.update { current ->
                val view = current.detail ?: return@update current
                current.copy(
                    detail = view.copy(
                        branch = branch,
                        currentWorktreePath = currentPath,
                        projectRoot = worktrees.projectRoot,
                    ),
                )
            }
        }
    }

    // --- Session actions ----------------------------------------------------

    fun renameSession(id: String, name: String) {
        if (name.isBlank()) return
        runAction {
            try {
                api.renameSession(id, name.trim())
            } catch (slow: ApiError.SessionSlow) {
                // The rebased server answers `503 session_slow` instead of
                // writing the title behind a live omp child (that write would
                // be clobbered on omp's next flush). Nothing changed, so say
                // so and keep the old title.
                showNotice("The agent is busy — the session was not renamed. Try again in a moment.", error = true)
                return@runAction
            }
            // The shared detail answer still carries the old title; the next
            // open must ask the server instead of joining it.
            api.invalidateSessionDetail(id)
            patchDetailName(id, name.trim())
            reloadSessions()
            showNotice("Session renamed")
        }
    }

    /** Keeps the open session's header in step with a title the user just set. */
    private fun patchDetailName(id: String, name: String) {
        _state.update { current ->
            val view = current.detail ?: return@update current
            if (current.selectedSessionId != id || view.info.name == name) return@update current
            current.copy(detail = view.copy(info = view.info.copy(name = name)))
        }
    }

    /**
     * Generates a title from the session's messages. A session without
     * messages has nothing to summarize, so the menu item is disabled and the
     * action refuses it here as well; a blank server title is an error, never
     * "Title generated: .".
     */
    fun autoNameSession(id: String) {
        val current = _state.value
        if (current.autoName.isNaming(id)) return
        val summary = current.sessions.firstOrNull { it.id == id }
        if (summary != null && summary.messageCount <= 0) {
            showNotice("Auto-name needs at least one message", error = true)
            return
        }
        _state.update { it.copy(autoName = AutoNameStatus(id, AutoNamePhase.Naming)) }
        viewModelScope.launch {
            val result = captureApi { api.autoNameSession(id) }
            result.fold(
                onSuccess = { response ->
                    val title = response.title.trim()
                    if (title.isEmpty()) {
                        // A blank title must not look like a success.
                        _state.update { it.copy(autoName = AutoNameStatus(id, AutoNamePhase.Error)) }
                        showNotice("The server returned an empty title", error = true)
                    } else {
                        _state.update { it.copy(autoName = AutoNameStatus(id, AutoNamePhase.Success, title)) }
                        // Same as rename: the shared answer still says the old title.
                        api.invalidateSessionDetail(id)
                        patchDetailName(id, title)
                        showNotice(
                            if (response.generated) "Title generated: $title" else "Title set to: $title",
                        )
                    }
                },
                onFailure = { error ->
                    _state.update { it.copy(autoName = AutoNameStatus(id, AutoNamePhase.Error)) }
                    showNotice(error.userMessage(), error = true)
                },
            )
            if (result.isSuccess) reloadSessions()
        }
    }

    fun archiveSession(id: String) {
        runAction {
            api.archiveSession(id)
            // An open within the sharing window must hit the server, not the
            // pre-archive answer that is still cached in memory.
            api.invalidateSessionDetail(id)
            handleSessionGone(id)
            reloadSessions()
            showNotice("Session archived")
        }
    }

    fun deleteSession(id: String) {
        runAction {
            api.deleteSession(id)
            // The row can still be on screen until the reload lands; opening
            // it then must 404 instead of replaying the deleted transcript.
            api.invalidateSessionDetail(id)
            handleSessionGone(id)
            reloadSessions()
            showNotice("Session deleted")
        }
    }

    fun importSession(fileName: String, content: String) {
        runAction {
            api.importSession(fileName, content)
            reloadSessions()
            showNotice("Session imported")
        }
    }

    /** Copy-transcript payload; `null` after a failure (notice already shown). */
    suspend fun transcriptMarkdown(id: String): String? {
        val summary = _state.value.sessions.firstOrNull { it.id == id }
        return try {
            val detail = api.sessionDetail(id)
            val info = detail.info
            transcriptToMarkdown(
                messages = detail.context?.messages ?: emptyList(),
                title = info?.name ?: summary?.name,
                cwd = info?.cwd ?: summary?.cwd,
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: ApiError) {
            showNotice(error.userMessage(), error = true)
            null
        }
    }

    /** Self-contained HTML export, ready for SAF or the share sheet. */
    suspend fun exportHtml(id: String): ExportedSession? = try {
        api.exportSession(id)
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: ApiError) {
        showNotice(error.userMessage(), error = true)
        null
    }

    /**
     * A dead session view (deleted on the server, or a stale deep link): drop
     * the selection, remove the entry from the in-memory history so Back does
     * not return to it, and tell the user once. Unlike [handleSessionGone]
     * this does not open a new-session draft — an unknown id gives no cwd.
     */
    private fun dropMissingSession(id: String) {
        val current = _state.value
        if (current.selectedSessionId != id) return
        detailGeneration++
        detailJob?.cancel()
        val history = _history.value
        val index = history.entries.indexOfFirst { it.sessionId == id }
        if (index >= 0) _history.value = history.removeAt(index)
        _state.update {
            it.copy(
                selectedSessionId = null,
                detail = null,
                detailLoading = false,
                detailError = null,
                newSessionCwd = null,
            )
        }
        forgetLastSessionIfCurrent(id)
        showNotice("Session no longer exists", error = true)
    }

    /**
     * A dead session must not stay the cold-start marker — the next start would
     * try it again and land on the list instead of the last real view. Only the
     * marker for *this* id is dropped: a deep link to a session this
     * installation never opened must not forget the session the user left.
     */
    fun forgetLastSessionIfCurrent(id: String) {
        viewModelScope.launch {
            if (preferences.snapshot.value.lastSessionId == id) preferences.clearLastSession()
        }
    }

    private fun handleSessionGone(id: String) {
        val current = _state.value
        if (current.selectedSessionId != id) return
        val cwd = current.detail?.info?.cwd ?: current.sessions.firstOrNull { it.id == id }?.cwd
        detailGeneration++
        detailJob?.cancel()
        _state.update {
            it.copy(
                selectedSessionId = null,
                detail = null,
                detailLoading = false,
                detailError = null,
                newSessionCwd = cwd,
                activeCwd = cwd ?: it.activeCwd,
            )
        }
    }

    // --- Project actions ----------------------------------------------------

    fun toggleProject(projectPath: String) {
        val key = comparableProjectPath(projectPath)
        val current = _state.value.expandedProjects ?: emptySet()
        val next = if (key in current) current - key else current + key
        _state.update { it.copy(expandedProjects = next) }
        persistExpanded(next)
    }

    fun activateProject(projectPath: String) {
        expandProject(projectPath, expand = true)
        _state.update { it.copy(activeCwd = projectPath) }
    }

    /**
     * A worktree switch/create/remove moved the workspace: the sidebar's
     * effective cwd (and with it the next new session) follows, while an open
     * session keeps its own cwd. Unlike [activateProject] this does not touch
     * the expanded project set — a worktree is not a sidebar project row.
     *
     * An open new-session pane starts in the moved workspace (web
     * `handleCwdChange`: the pane's cwd falls back to the sidebar's), so its
     * target follows the same event and stays persisted.
     */
    fun setEffectiveCwd(path: String) {
        val current = _state.value
        val paneOpen = current.selectedSessionId == null && current.newSessionCwd != null
        if (paneOpen) rememberLastView(newSessionCwd = path)
        _state.update {
            it.copy(
                activeCwd = path,
                newSessionCwd = if (paneOpen) path else it.newSessionCwd,
            )
        }
    }

    private fun expandProject(projectPath: String, expand: Boolean) {
        val key = comparableProjectPath(projectPath)
        val current = _state.value.expandedProjects ?: emptySet()
        if (!expand || key in current) return
        val next = current + key
        _state.update { it.copy(expandedProjects = next) }
        persistExpanded(next)
    }

    fun addProject(cwd: String, launchConfig: ProjectLaunchConfig? = null) {
        runAction {
            val project = api.addProject(cwd, launchConfig)
            reloadProjects()
            expandProject(project.path, expand = true)
            _state.update { it.copy(activeCwd = project.path) }
            showNotice("Project added")
        }
    }

    fun renameProject(projectPath: String, alias: String?) {
        runAction {
            api.updateProjectAlias(projectPath, alias?.trim().orEmpty())
            reloadProjects()
        }
    }

    fun saveProjectLaunchConfig(projectPath: String, config: ProjectLaunchConfig?) {
        runAction {
            api.updateProjectLaunchConfig(projectPath, config)
            reloadProjects()
            showNotice(if (config == null) "Launch configuration cleared" else "Launch configuration saved")
        }
    }

    fun removeProject(projectPath: String) {
        runAction {
            api.deleteProject(projectPath)
            val key = comparableProjectPath(projectPath)
            _state.update { current ->
                current.copy(
                    expandedProjects = current.expandedProjects?.minus(key),
                    activeCwd = if (current.activeCwd == projectPath) null else current.activeCwd,
                )
            }
            reloadProjects()
            showNotice("Project hidden")
        }
    }

    fun moveProjectBy(projectPath: String, delta: Int) {
        moveProjectTo(projectPath, Math.max(0, projectIndex(projectPath) + delta))
    }

    /** Long-press drag and drop: both indices refer to the sorted list. */
    fun moveProjectTo(projectPath: String, targetIndex: Int) {
        val current = _state.value.projects
        val from = projectIndex(projectPath)
        if (from < 0) return
        val boundedTarget = targetIndex.coerceIn(0, current.size - 1)
        if (from == boundedTarget) return
        val next = current.toMutableList()
        val moved = next.removeAt(from)
        next.add(boundedTarget, moved)
        runAction {
            api.reorderProjects(next.map { it.path })
            reloadProjects()
        }
    }

    private fun projectIndex(path: String): Int =
        _state.value.projects.indexOfFirst { comparableProjectPath(it.path) == comparableProjectPath(path) }

    // --- Filtering ----------------------------------------------------------

    fun setSearchQuery(query: String) {
        _state.update {
            if (it.searchQuery == query) return@update it
            // The page token (and `partial`) belong to the previous query, so
            // "Load more" cannot continue a search the user has moved on from;
            // the same goes for the automatic-continuation progress.
            it.copy(
                searchQuery = query,
                messageSearch = it.messageSearch.copy(cursor = null, partial = false, autoPages = 0),
            )
        }
        if (_state.value.searchMode == SessionSearchMode.Messages) scheduleMessageSearch()
    }

    fun setSearchOpen(open: Boolean) {
        if (!open) {
            messageSearchJob?.cancel()
            messageSearchGeneration++
        }
        _state.update {
            it.copy(
                searchOpen = open,
                searchQuery = if (open) it.searchQuery else "",
                searchMode = if (open) it.searchMode else SessionSearchMode.Sessions,
                messageSearch = if (open) it.messageSearch else MessageSearchState(),
            )
        }
        if (open && _state.value.searchMode == SessionSearchMode.Messages && _state.value.searchQuery.isNotBlank()) {
            scheduleMessageSearch(immediate = true)
        }
    }

    /** "Sessions" ↔ "In messages"; switching runs the current query again. */
    fun setSearchMode(mode: SessionSearchMode) {
        if (_state.value.searchMode == mode) return
        // The mode only exists when the server advertised the route; hiding the
        // chip is not enough, a stale call must not send a request that 404s.
        if (mode == SessionSearchMode.Messages && !_state.value.messageSearchSupported) return
        messageSearchJob?.cancel()
        messageSearchGeneration++
        _state.update {
            it.copy(
                searchMode = mode,
                messageSearch = if (mode == SessionSearchMode.Messages) it.messageSearch else MessageSearchState(),
            )
        }
        if (mode == SessionSearchMode.Messages && _state.value.searchQuery.isNotBlank()) {
            scheduleMessageSearch(immediate = true)
        }
    }

    fun setRunningOnly(runningOnly: Boolean) {
        _state.update { it.copy(runningOnly = runningOnly) }
    }

    /**
     * Debounced, cancellable full-text search. Every keystroke replaces the
     * previous request, and a response that belongs to an older query is
     * dropped in [runMessageSearch].
     */
    private fun scheduleMessageSearch(immediate: Boolean = false) {
        messageSearchJob?.cancel()
        val query = _state.value.searchQuery.trim()
        val generation = ++messageSearchGeneration
        if (query.isEmpty()) {
            _state.update { it.copy(messageSearch = MessageSearchState()) }
            return
        }
        messageSearchJob = viewModelScope.launch {
            if (!immediate) delay(MESSAGE_SEARCH_DEBOUNCE_MILLIS)
            if (generation == messageSearchGeneration) {
                runMessageSearch(query, cursor = null, append = false, generation = generation)
            }
        }
    }

    /** The error row's "Try again": repeats the current query without debounce. */
    fun retryMessageSearch() {
        if (_state.value.searchMode == SessionSearchMode.Messages) scheduleMessageSearch(immediate = true)
    }

    /**
     * Failure wording for the message search. A 429 `search_busy` means the
     * server is still running other scans (two at most), so it gets a retry
     * hint instead of its terse body. A 404 means the server does not serve
     * `GET /api/sessions/messages/search` at all — an older ompweb, whose Next
     * fallback has no JSON code — so the row explains that instead of
     * "HTTP 404".
     */
    private fun searchErrorMessage(error: Throwable): String = when {
        (error as? ApiError.ServerResponse)?.code == "search_busy" ->
            "The server is busy searching — try again in a moment."
        (error as? ApiError.ServerResponse)?.status == 404 ||
            (error as? ApiError.Http)?.code == 404 ->
            "This server is too old for message search."
        else -> error.userMessage()
    }

    /** Next slice of a `partial` server answer ("Load more"). */
    fun loadMoreMessageResults() {
        val current = _state.value.messageSearch
        // The cursor belongs to the query that produced the page: a keystroke
        // inside the debounce window would otherwise pair it with the new query
        // and the server rejects that with 400 `cursor_query_mismatch`.
        val query = current.query
        val cursor = current.cursor ?: return
        if (current.loading || query.isEmpty() || query != _state.value.searchQuery.trim()) return
        messageSearchJob?.cancel()
        val generation = ++messageSearchGeneration
        messageSearchJob = viewModelScope.launch {
            runMessageSearch(query, cursor, append = true, generation = generation)
        }
    }

    /**
     * One search run: the requested page plus, while the server keeps stopping
     * early without a row, automatic follow-ups with its cursor.
     *
     * A `partial` page with zero results means "the scan ran out of budget
     * before it reached a match", not "nothing matched"; stopping there showed
     * a false miss until the user found "Load more". The run is bounded by
     * [MESSAGE_SEARCH_AUTO_PAGE_LIMIT] and stops as soon as a page brings a
     * row. A new query, a mode switch or closing the search bumps
     * [messageSearchGeneration], which cancels this coroutine and also guards
     * every state update, so a stale page can never repopulate the list.
     */
    private suspend fun runMessageSearch(
        query: String,
        cursor: String?,
        append: Boolean,
        generation: Long,
    ) {
        val origin = originNow() ?: return
        if (generation != messageSearchGeneration) return
        var nextCursor = cursor
        var appending = append
        var pages = 0
        var autoPages = 0
        _state.update {
            it.copy(
                messageSearch = it.messageSearch.copy(
                    query = query,
                    loading = true,
                    error = null,
                    results = if (append) it.messageSearch.results else emptyList(),
                    partial = if (append) it.messageSearch.partial else false,
                    cursor = if (append) it.messageSearch.cursor else null,
                    autoPages = 0,
                ),
            )
        }
        while (true) {
            if (generation != messageSearchGeneration) return
            val result = captureApi { api.searchSessions(query, MESSAGE_SEARCH_LIMIT, nextCursor) }
            if (generation != messageSearchGeneration) return
            if (originNow()?.origin != origin.origin) return
            pages += 1
            val page = result.getOrNull()
            if (page == null) {
                val error = result.exceptionOrNull()?.let { searchErrorMessage(it) } ?: return
                _state.update { current ->
                    if (current.messageSearch.query != query) return@update current
                    current.copy(
                        messageSearch = current.messageSearch.copy(
                            loading = false,
                            error = error,
                            autoPages = autoPages,
                        ),
                    )
                }
                return
            }
            // Empty + partial + cursor: the budget stopped the page before its
            // first match, so continue without waiting for a tap.
            val continueScan = page.partial && page.results.isEmpty() && page.cursor != null &&
                pages < MESSAGE_SEARCH_AUTO_PAGE_LIMIT
            val nextAutoPages = if (continueScan) autoPages + 1 else autoPages
            _state.update { current ->
                if (current.messageSearch.query != query || current.searchMode != SessionSearchMode.Messages) {
                    return@update current
                }
                val combined = if (appending) current.messageSearch.results + page.results else page.results
                current.copy(
                    messageSearch = MessageSearchState(
                        query = query,
                        loading = continueScan,
                        // A cursor is exact, but a session file can be
                        // rewritten between pages: never show one entry twice.
                        results = combined.distinctBy { it.sessionId to it.entryId },
                        partial = page.partial,
                        cursor = page.cursor,
                        // Pages visit disjoint slices of the file list, so a
                        // skipped session file is reported exactly once: sum.
                        skippedFiles = (if (appending) current.messageSearch.skippedFiles else 0) +
                            page.skippedFiles,
                        error = null,
                        autoPages = nextAutoPages,
                    ),
                )
            }
            if (!continueScan) return
            nextCursor = page.cursor
            appending = true
            autoPages = nextAutoPages
        }
    }

    // --- Pinning ------------------------------------------------------------

    /**
     * Pins/unpins a session for the current origin. Pins are persisted through
     * the ordered preference queue, so two fast taps leave the last state.
     */
    fun togglePin(sessionId: String) {
        val origin = originNow()?.origin ?: return
        val current = _state.value.pinnedIds
        val next = if (sessionId in current) current - sessionId else current + sessionId
        _state.update { it.copy(pinnedIds = next) }
        preferenceWrites.trySend { preferences.setPinnedSessions(origin, next) }
    }

    // --- Archive browser ----------------------------------------------------

    fun openArchive() {
        _state.update { it.copy(archive = it.archive.copy(open = true)) }
        refreshArchive()
    }

    fun closeArchive() {
        archiveJob?.cancel()
        _state.update { it.copy(archive = it.archive.copy(open = false)) }
    }

    fun setArchiveSearch(query: String) {
        _state.update { it.copy(archive = it.archive.copy(search = query)) }
    }

    fun selectArchiveEntry(key: String?) {
        _state.update { it.copy(archive = it.archive.copy(selectedKey = key)) }
    }

    fun refreshArchive() {
        archiveJob?.cancel()
        archiveJob = viewModelScope.launch {
            _state.update { it.copy(archive = it.archive.copy(loading = true, error = null)) }
            val result = captureApi { api.archivedSessions() }
            result.fold(
                onSuccess = { list ->
                    _state.update { current ->
                        current.copy(
                            archive = current.archive.copy(
                                loading = false,
                                entries = list.archives,
                                error = null,
                                selectedKey = current.archive.selectedKey
                                    ?.takeIf { key -> list.archives.any { it.key == key } },
                            ),
                        )
                    }
                },
                onFailure = { error ->
                    _state.update {
                        it.copy(archive = it.archive.copy(loading = false, error = error.userMessage()))
                    }
                },
            )
        }
    }

    fun restoreArchiveEntry(key: String, onRestored: ((String) -> Unit)? = null) {
        val entry = _state.value.archive.entries.firstOrNull { it.key == key }
        runAction {
            _state.update { it.copy(archive = it.archive.copy(restoringKey = key)) }
            try {
                val response = api.restoreArchive(key)
                val restoredId = response.sessionId ?: entry?.id
                _state.update {
                    it.copy(
                        archive = it.archive.copy(open = false, restoringKey = null),
                    )
                }
                showNotice("Session restored")
                if (restoredId != null) {
                    openCreatedSession(restoredId, entry?.cwd)
                    onRestored?.invoke(restoredId)
                } else {
                    reloadSessions()
                }
            } finally {
                _state.update { it.copy(archive = it.archive.copy(restoringKey = null)) }
            }
        }
    }

    fun dismissNotice() {
        _state.update { it.copy(notice = null) }
    }

    // --- Plumbing -----------------------------------------------------------

    private suspend fun reloadSessions() {
        val origin = originNow() ?: return
        loadSessions(origin.origin)
    }

    private suspend fun reloadProjects() {
        val origin = originNow() ?: return
        loadProjects(origin.origin)
    }

    private fun runAction(block: suspend () -> Unit) {
        viewModelScope.launch {
            // captureApi turns every transport/serialization failure into an
            // ApiError; without it an IOException would crash the app.
            captureApi { block() }.exceptionOrNull()?.let { error ->
                showNotice(error.userMessage(), error = true)
            }
        }
    }

    private fun showNotice(text: String, error: Boolean = false) {
        noticeCounter++
        _state.update { it.copy(notice = UiNotice(noticeCounter, text, error)) }
    }

    private fun Throwable.toLoadError(): SessionsLoadError =
        (this as? ApiError)?.toLoadError() ?: SessionsLoadError.Network

    private fun ApiError.toLoadError(): SessionsLoadError = when (this) {
        is ApiError.Network -> SessionsLoadError.Network
        is ApiError.Forbidden -> SessionsLoadError.Forbidden
        is ApiError.ServerMisconfigured -> SessionsLoadError.Misconfigured
        is ApiError.SessionSlow -> SessionsLoadError.Server(503)
        is ApiError.SessionRunningElsewhere -> SessionsLoadError.Server(409)
        is ApiError.Unauthorized -> SessionsLoadError.Server(401)
        is ApiError.NotConfigured -> SessionsLoadError.Network
        is ApiError.Http -> SessionsLoadError.Server(code)
        is ApiError.ServerResponse -> SessionsLoadError.Server(status)
    }

    companion object {
        const val RELOAD_DEBOUNCE_MILLIS = 400L
        const val INITIAL_RESTORE_MAX_ATTEMPTS = 8
        const val INITIAL_RESTORE_RETRY_MILLIS = 1000L
        /** Long enough to skip most intermediate keystrokes, short enough to feel live. */
        const val MESSAGE_SEARCH_DEBOUNCE_MILLIS = 350L
        /** One server page; the server caps at 100. */
        const val MESSAGE_SEARCH_LIMIT = 30

        /**
         * Pages one search run may request on its own while every answer is
         * `partial` and empty (one initial page + four automatic follow-ups).
         * Five empty pages mean a huge unscanned file filled the budget; the
         * "Load more results" button takes it from there.
         */
        const val MESSAGE_SEARCH_AUTO_PAGE_LIMIT = 5
    }
}
