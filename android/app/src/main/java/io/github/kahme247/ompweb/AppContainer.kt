package io.github.kahme247.ompweb

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import androidx.core.content.pm.PackageInfoCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.kahme247.ompweb.data.ComposerDraftStore
import io.github.kahme247.ompweb.data.DraftStore
import io.github.kahme247.ompweb.data.EncryptedCookieRecords
import io.github.kahme247.ompweb.data.KeystoreCookieCipher
import io.github.kahme247.ompweb.data.OriginBoundCookieJar
import io.github.kahme247.ompweb.data.OriginScopedDraftStore
import io.github.kahme247.ompweb.data.SessionCacheStore
import io.github.kahme247.ompweb.data.SettingsStore
import io.github.kahme247.ompweb.events.EventMux
import io.github.kahme247.ompweb.events.HttpEventTransport
import io.github.kahme247.ompweb.net.ApiClient
import io.github.kahme247.ompweb.net.AppInfo
import io.github.kahme247.ompweb.net.AgentExtensionApi
import io.github.kahme247.ompweb.net.HttpAndroidReleaseSource
import io.github.kahme247.ompweb.net.HttpAndroidUpdateDownloader
import io.github.kahme247.ompweb.net.HttpAndroidUpdateSource
import io.github.kahme247.ompweb.net.HttpMcpApi
import io.github.kahme247.ompweb.net.HttpNativeSettingsApi
import io.github.kahme247.ompweb.net.HttpNotificationHistoryApi
import io.github.kahme247.ompweb.net.HttpNotificationsApi
import io.github.kahme247.ompweb.net.HttpPluginsApi
import io.github.kahme247.ompweb.net.HttpSkillsApi
import io.github.kahme247.ompweb.net.HttpPolicyInterceptor
import io.github.kahme247.ompweb.net.HttpSttApi
import io.github.kahme247.ompweb.net.NotificationsApi
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerProbe
import io.github.kahme247.ompweb.net.btwApi
import io.github.kahme247.ompweb.net.filesApi
import io.github.kahme247.ompweb.net.gitApi
import io.github.kahme247.ompweb.net.systemApi
import io.github.kahme247.ompweb.net.worktreesApi
import io.github.kahme247.ompweb.notify.NotificationCenter
import io.github.kahme247.ompweb.ui.AppViewModel
import io.github.kahme247.ompweb.ui.chat.ChatViewModel
import io.github.kahme247.ompweb.ui.chat.SpeechController
import io.github.kahme247.ompweb.ui.hosttools.HostToolsController
import io.github.kahme247.ompweb.ui.panels.btw.BtwViewModel
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionStrings
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionUiController
import io.github.kahme247.ompweb.ui.composer.AndroidCompletionSound
import io.github.kahme247.ompweb.ui.composer.ComposerStrings
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.controls.WordPredictor
import io.github.kahme247.ompweb.ui.composer.controls.wordInputCapabilities
import io.github.kahme247.ompweb.ui.composer.dictation.AndroidDictationStore
import io.github.kahme247.ompweb.ui.composer.dictation.AndroidOnDeviceStt
import io.github.kahme247.ompweb.ui.composer.dictation.DictationStrings
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import io.github.kahme247.ompweb.ui.connect.ConnectViewModel
import io.github.kahme247.ompweb.ui.files.FilesViewModel
import io.github.kahme247.ompweb.ui.files.PreferencesFileTabStore
import io.github.kahme247.ompweb.ui.git.GitChangesViewModel
import io.github.kahme247.ompweb.ui.render.RenderEnvironment
import io.github.kahme247.ompweb.ui.sessions.DirectoryPickerViewModel
import io.github.kahme247.ompweb.ui.sessions.NewSessionViewModel
import io.github.kahme247.ompweb.ui.sessions.SessionExport
import io.github.kahme247.ompweb.ui.sessions.SessionsViewModel
import io.github.kahme247.ompweb.ui.settings.AndroidUpdateController
import io.github.kahme247.ompweb.ui.settings.NativeSettingsViewModel
import io.github.kahme247.ompweb.ui.settings.PackageInstallerAndroidApkInstaller
import io.github.kahme247.ompweb.ui.settings.PackageManagerAndroidApkInspector
import io.github.kahme247.ompweb.ui.settings.SettingsAgentsHostViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsHostViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsProvidersHostViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsViewModel
import io.github.kahme247.ompweb.ui.worktrees.WorktreeCache
import io.github.kahme247.ompweb.ui.worktrees.WorktreeStrings
import io.github.kahme247.ompweb.ui.worktrees.WorktreesViewModel
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient

/**
 * A notification tap that asked for a session, plus the installation it was
 * posted for (`scheme://host:port`, null when not configured yet).
 */
data class PendingSessionOpen(val sessionId: String, val origin: String?)

/**
 * Manual dependency graph for the single-module app.
 *
 * There is exactly one [OkHttpClient] and one [EventMux] per process: the SSE
 * stream is shared by every screen, and the cookie jar has to see every
 * request to bind the session to the configured origin.
 */
class AppContainer(context: Context) {

    private val appContext = context.applicationContext

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** The installed app's `versionName` (intro line of the new-session pane). */
    val appVersion: String = runCatching {
        appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName
    }.getOrNull().orEmpty().ifBlank { "—" }

    /** The installed `versionCode`; Android decides installability by it. */
    val appVersionCode: Long = runCatching {
        PackageInfoCompat.getLongVersionCode(
            appContext.packageManager.getPackageInfo(appContext.packageName, 0),
        )
    }.getOrDefault(0L)

    private val _serverInfo = MutableStateFlow<AppInfo?>(null)

    /**
     * `GET /api/app-info` of the configured server: version for display and
     * the capabilities the screens gate on (`messageSearch`).
     */
    val serverInfo: StateFlow<AppInfo?> = _serverInfo.asStateFlow()

    /** `version` of the configured server, once known. */
    val serverVersion: StateFlow<String?> = _serverInfo
        .map { info -> info?.version?.takeIf { it.isNotBlank() } }
        .stateIn(appScope, SharingStarted.Eagerly, null)

    private var serverInfoRequested = false

    /**
     * Loads the server version and capabilities once. The shell calls this
     * when it becomes visible; a failure keeps the version line empty and the
     * capability-gated features off instead of surfacing an error.
     */
    fun refreshServerInfo() {
        if (serverInfoRequested || _serverInfo.value != null) return
        serverInfoRequested = true
        appScope.launch {
            runCatching { api.appInfo() }
                .onSuccess { info -> _serverInfo.value = info }
            serverInfoRequested = false
        }
    }

    val settings = SettingsStore(appContext, appScope)

    /**
     * The app's own update source. It talks to GitHub or the user's custom
     * feed, never to the configured server, so it gets a client without the
     * session cookie jar. The plain-HTTP policy is enforced on every hop;
     * release assets may redirect to a download host, which is why
     * cross-origin redirects are allowed for this cookie-free client.
     */
    private val updateClient: OkHttpClient = HttpPolicyInterceptor.install(
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.SECONDS),
        allowCrossOriginRedirects = true,
    ).build()

    /**
     * The installed app's own update check and install. Downloads go to the
     * app cache and are verified against the feed and the installed signing
     * certificate before PackageInstaller sees them.
     */
    val androidUpdates = AndroidUpdateController(
        source = HttpAndroidUpdateSource(HttpAndroidReleaseSource(updateClient), updateClient),
        settings = settings,
        scope = appScope,
        currentVersion = appVersion,
        installedPackageName = appContext.packageName,
        currentVersionCode = appVersionCode,
        downloader = HttpAndroidUpdateDownloader(
            client = updateClient,
            cacheDir = File(appContext.cacheDir, "updates"),
        ),
        inspector = PackageManagerAndroidApkInspector(appContext),
        installer = PackageInstallerAndroidApkInstaller(appContext),
    )

    private val cookieCipher = KeystoreCookieCipher()

    private val cookieRecords = EncryptedCookieRecords(
        file = File(appContext.filesDir, "session-cookies.bin"),
        cipher = cookieCipher,
    )

    val cookieJar = OriginBoundCookieJar(
        configuredOrigin = { settings.originNow()?.origin?.toHttpUrlOrNull() },
        records = cookieRecords,
    )

    private val unauthorized = MutableSharedFlow<ServerAddress>(
        extraBufferCapacity = 1,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** Fires with the origin that answered 401, from any screen. */
    val authEvents: SharedFlow<ServerAddress> = unauthorized.asSharedFlow()

    private val _sessionEpoch = MutableStateFlow(0)

    /**
     * Bumped whenever the signed-in user's data is dropped (sign-out, server
     * switch, 401). Settings-scoped view models clear their state on a change,
     * so no models.yml/API key survives into the next installation.
     */
    val sessionEpoch: StateFlow<Int> = _sessionEpoch.asStateFlow()

    private val httpClient: OkHttpClient = HttpPolicyInterceptor.install(
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .cookieJar(cookieJar),
    ).build()

    val api = ApiClient(
        client = httpClient,
        origin = { settings.originNow() },
        onUnauthorized = { origin -> unauthorized.tryEmit(origin) },
    )

    /**
     * A derived client (shares pool, dispatcher and cookie jar) for the probes:
     * the jar makes the post-sign-in `/api/app-info` check authenticated, the
     * derived client refuses redirects and gives up after eight seconds.
     */
    private val probeClient: OkHttpClient = httpClient.newBuilder()
        .followRedirects(false)
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .callTimeout(8, TimeUnit.SECONDS)
        .build()

    val probe = ServerProbe(probeClient)

    val eventMux = EventMux(
        transport = HttpEventTransport(api, appScope),
        scope = appScope,
        // Monotonic and sleep-inclusive: a wall-clock jump must not stall the
        // network-triggered reconnect guard.
        clock = { android.os.SystemClock.elapsedRealtime() },
    )

    /**
     * Cache-first storage for the workspace list and the last opened
     * transcripts. It lives in `filesDir` (never in the backup set) and is
     * deleted by [clearLocalUserData] on logout, a server switch and a 401.
     */
    val sessionCache = SessionCacheStore(File(appContext.filesDir, SESSION_CACHE_DIR))

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    /**
     * One app-wide connectivity callback. A network coming back (Wi-Fi after
     * mobile data, Tailscale roaming) reconnects the shared event stream right
     * away instead of leaving a half-open socket until its read timeout, which
     * is what made the app show the previous state for up to two minutes after
     * a network change. `EventMux.onNetworkAvailable` rate-limits the retry, so
     * an `onAvailable` burst cannot become a reconnect storm, and the
     * notification service no longer registers a callback of its own — that
     * one existed only while its foreground service ran.
     */
    private fun registerNetworkCallback() {
        val manager = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                eventMux.onNetworkAvailable()
            }
        }
        runCatching { manager.registerDefaultNetworkCallback(callback) }
            .onSuccess { networkCallback = callback }
    }

    val notificationsApi: NotificationsApi = HttpNotificationsApi(api, settings::originNow)

    /**
     * Notification identity, registration, presence and the foreground
     * service. `clearLocalUserData()` forgets the device; the shell reports
     * the visible session and the process lifecycle reports foreground.
     */
    val notifications = NotificationCenter(
        context = appContext,
        settings = settings,
        api = notificationsApi,
        mux = eventMux,
        scope = appScope,
        isSignedIn = {
            val snapshot = settings.snapshot.value
            snapshot.origin != null && (!snapshot.needsPassword || cookieJar.hasCookies())
        },
    )

    /** App-wide read-aloud engine; binds TTS lazily on first use. */
    val speech = SpeechController(appContext)

    /**
     * Composer drafts keyed by session id or `new:<cwd>` (survives process
     * death). Keys are scoped to the configured origin, so a server switch can
     * never show another installation's recovered queue text.
     */
    private val rawDrafts = DraftStore(appContext, appScope)
    val draftStore: ComposerDraftStore = OriginScopedDraftStore(
        rawDrafts,
        appScope,
        settings.snapshot
            .map { snapshot -> snapshot.origin?.origin }
            .stateIn(appScope, SharingStarted.Eagerly, settings.snapshot.value.origin?.origin),
    )

    /** Localized composer labels for the view models (no `Context` there). */
    val composerStrings = ComposerStrings.from(appContext)

    private val sttApi = HttpSttApi(api)
    private val dictationStore = AndroidDictationStore(appContext)

    /** Slice B controls for the chat composer; `open()` rebinds it per session. */
    val chatControls = ComposerControlsViewModel(api, settings, appScope)

    /** Slice C dictation for the chat composer; owned by the process so jobs adopt. */
    val chatDictation = DictationViewModel(
        sttApi,
        dictationStore,
        appScope,
        DictationStrings.from(appContext),
        settings = settings.snapshot,
        onDevice = AndroidOnDeviceStt(appContext),
    )

    val wordPredictor = WordPredictor(
        api = api,
        settings = settings,
        scope = appScope,
        capabilities = { wordInputCapabilities(appContext) },
    )

    private val completionSound = AndroidCompletionSound()

    /** Slice C's localized labels, shared by its two controllers. */
    private val extensionStrings = ExtensionStrings.from(appContext)

    /** Slice B: side questions for the open chat (`bind` on session open). */
    val chatBtw = BtwViewModel(api.btwApi(), appScope)

    /** Slice C: extension dialogs/status/terminal for the open chat. */
    val chatExtensionUi = ExtensionUiController(
        api = AgentExtensionApi(api),
        scope = appScope,
        strings = extensionStrings,
    )

    /**
     * Slice C's host-tool bridge. App-wide on purpose: `host_tool_call` frames
     * arrive on the shared `host-tools` channel for every session, so the
     * consent prompt must work while no chat is open. Started by the signed-in
     * shell, not before.
     */
    val hostTools = HostToolsController(
        api = AgentExtensionApi(api),
        events = eventMux,
        settings = settings,
        scope = appScope,
        strings = extensionStrings,
    )

    /** A separate controls instance: a new session has its own spawn choices. */
    val newSessionControls = ComposerControlsViewModel(api, settings, appScope)
    val newSessionDictation = DictationViewModel(
        sttApi,
        dictationStore,
        appScope,
        DictationStrings.from(appContext),
        settings = settings.snapshot,
        onDevice = AndroidOnDeviceStt(appContext),
    )

    /**
     * URIs a share sheet handed us; the sessions screen consumes them into a
     * chooser and then into a draft. Held here because the activity may be
     * recreated before the screen composes.
     */
    private val _pendingShare = MutableStateFlow<List<Uri>>(emptyList())
    val pendingShare = _pendingShare.asStateFlow()

    fun offerShare(uris: List<Uri>) {
        if (uris.isNotEmpty()) _pendingShare.value = uris
    }

    fun consumeShare(): List<Uri> {
        val uris = _pendingShare.value
        if (uris.isNotEmpty()) _pendingShare.value = emptyList()
        return uris
    }

    /**
     * A notification tap (PendingIntent) or a deep link asked for a session.
     * Held here because the activity may be recreated before the shell is
     * composed.
     */
    private val _pendingSessionOpen = MutableStateFlow<PendingSessionOpen?>(null)
    val pendingSessionOpen = _pendingSessionOpen.asStateFlow()

    /** A `ompweb://cwd?path=…` link; the installation it was minted for, if named. */
    private val _pendingCwdOpen = MutableStateFlow<PendingSessionOpen?>(null)
    val pendingCwdOpen: StateFlow<PendingSessionOpen?> = _pendingCwdOpen.asStateFlow()

    fun offerSessionOpen(sessionId: String, origin: String?) {
        if (sessionId.isNotBlank()) _pendingSessionOpen.value = PendingSessionOpen(sessionId, origin)
    }

    /**
     * A workspace deep link (`ompweb://cwd?path=…`). The path is validated by
     * the new-session pane's `prepare` against the configured server, so a
     * dead path shows its error there instead of opening a broken composer.
     */
    fun offerCwdOpen(path: String, origin: String?) {
        if (path.isNotBlank()) _pendingCwdOpen.value = PendingSessionOpen(path, origin)
    }

    /**
     * The requested session, but only when it still belongs to the configured
     * installation — a tap on a notification of a server the user left must
     * not open (and scroll into) a same-id session of the new one. A
     * mismatching request is consumed without effect.
     *
     * A link that names no origin (the plain `ompweb://session/<id>` share
     * link) is bound at consumption time: it is accepted only while a server
     * is configured, because the id is meaningless without one.
     */
    fun consumeSessionOpen(): String? {
        val pending = _pendingSessionOpen.value ?: return null
        _pendingSessionOpen.value = null
        val configured = settings.originNow()?.origin
        val matches = pending.origin?.let { it == configured } ?: (configured != null)
        return pending.sessionId.takeIf { matches }
    }

    /** The requested workspace path, with the same origin rule as sessions. */
    fun consumeCwdOpen(): String? {
        val pending = _pendingCwdOpen.value ?: return null
        _pendingCwdOpen.value = null
        val configured = settings.originNow()?.origin
        val matches = pending.origin?.let { it == configured } ?: (configured != null)
        return pending.sessionId.takeIf { matches }
    }

    /**
     * Drop everything that belongs to the signed-in user of the current
     * origin: unsent drafts (and their recovered queue text), share payloads,
     * local recordings/playback copies, finished exports and camera staging.
     * Called on logout, a server switch and a 401, so nothing of one
     * installation survives into another.
     *
     * Suspends until the notification teardown has unregistered the device:
     * the caller may clear the cookie and the origin only afterwards.
     */
    suspend fun clearLocalUserData() {
        // Unregister before the cookie/origin disappear: the server should stop
        // routing to this device, and the identity is forgotten afterwards.
        notifications.clearDevice()
        // The list belongs to the old installation; a load still in flight
        // must not land in the next one.
        notificationHistoryViewModel.reset()
        // Files: tabs, explorer and cached worktree lists are installation state.
        filesViewModel.reset()
        worktreeCache.invalidate()
        worktreesViewModel.load(null)
        gitChangesViewModel.bind(null)
        _pendingSessionOpen.value = null
        _pendingCwdOpen.value = null
        _serverInfo.value = null
        serverInfoRequested = false
        hostTools.reset()
        draftStore.clearAll()
        // The list and the transcripts belong to the installation that is being
        // left: nothing of it may paint the next server's workspace.
        withContext(Dispatchers.IO) { sessionCache.clearAll() }
        // Same rule for the heap: the list/ETag per origin and the shared detail
        // answers (whole transcripts) must not outlive the account either.
        api.clearMemoryCaches()
        _pendingShare.value = emptyList()
        chatDictation.clearSessionData()
        newSessionDictation.clearSessionData()
        dictationStore.purgeOrphans()
        SessionExport.purgeStaleExports(appContext)
        File(appContext.cacheDir, "camera").deleteRecursively()
        // Settings view models hold the previous installation's models.yml.
        _sessionEpoch.update { it + 1 }
    }

    /**
     * Slice B's history mirror; process-scoped like its API, and fed live by
     * [NotificationCenter.onDelivered].
     */
    val notificationHistoryViewModel = io.github.kahme247.ompweb.ui.notifications.NotificationHistoryViewModel(
        HttpNotificationHistoryApi(api),
        appScope,
    )

    /** Slice B: worktree lists, shared by the new-session pane and the Files panel. */
    val worktreeCache = WorktreeCache(api.worktreesApi())

    /** Slice B: the Files panel's Git tab, bound to the explorer cwd. */
    val gitChangesViewModel = GitChangesViewModel(api.gitApi(), appScope)

    /** Slice B: the Files panel's Worktrees tab. */
    val worktreesViewModel = WorktreesViewModel(
        api = api.worktreesApi(),
        scope = appScope,
        cache = worktreeCache,
        strings = WorktreeStrings.from(appContext),
    )

    /**
     * Phase 9's Files panel: explorer, tabs, viewer and live file events.
     * Process-scoped so open tabs survive rotation; the tab paths are restored
     * by [PreferencesFileTabStore] after process death.
     */
    val filesViewModel = FilesViewModel(
        api = api.filesApi(),
        git = api.gitApi(),
        events = eventMux,
        scope = appScope,
        tabStore = PreferencesFileTabStore(appContext),
        cacheDir = appContext.cacheDir,
        origin = { settings.snapshot.value.origin?.origin },
        awaitOrigin = {
            settings.awaitLoaded()
            settings.snapshot.value.origin?.origin
        },
    )

    val appViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { AppViewModel(this@AppContainer) }
    }

    val connectViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { ConnectViewModel(probe) }
    }

    val sessionsViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer {
            SessionsViewModel(
                api,
                eventMux,
                settings,
                settings::originNow,
                serverInfo,
                cache = sessionCache,
            )
        }
    }

    val newSessionViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer {
            NewSessionViewModel(
                api = api,
                drafts = draftStore,
                composerStrings = composerStrings,
                controls = newSessionControls,
                dictation = newSessionDictation,
                worktreeCache = worktreeCache,
            )
        }
    }

    val directoryPickerViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { DirectoryPickerViewModel(api) }
    }

    /** Settings → System & Updates, Usage and provider limits. */
    val settingsViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { SettingsViewModel(api.systemApi(), settings) }
    }

    /** Owns the store of the settings-scoped view models (see SettingsHostViewModel). */
    val settingsHostViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { SettingsHostViewModel(this@AppContainer) }
    }

    val settingsProvidersHostFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { SettingsProvidersHostViewModel(this@AppContainer) }
    }

    val settingsAgentsHostFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer { SettingsAgentsHostViewModel(this@AppContainer) }
    }

    /** Native OMP settings, MCP, Skills and Plugins (Slice B controllers). */
    val nativeSettingsViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer {
            NativeSettingsViewModel(
                settingsApi = HttpNativeSettingsApi(api),
                mcpApi = HttpMcpApi(api),
                skillsApi = HttpSkillsApi(api),
                pluginsApi = HttpPluginsApi(api),
            )
        }
    }

    val chatViewModelFactory: ViewModelProvider.Factory = viewModelFactory {
        initializer {
            ChatViewModel(
                api,
                eventMux,
                settings,
                speech,
                createSavedStateHandle(),
                appContext.getString(R.string.chat_prompt_maybe_started),
                appContext.getString(R.string.chat_stop_unconfirmed),
                draftStore,
                composerStrings,
                chatControls,
                chatDictation,
                wordPredictor,
                completionSound,
                chatBtw,
                chatExtensionUi,
                hostTools,
                files = api.filesApi(),
                skillDiagnostics = api,
                transcripts = sessionCache,
                // Sign-out/switch/401 wipes the disk cache; the same bump drops
                // the transcript this activity-scoped view model holds.
                sessionEpoch = sessionEpoch,
            )
        }
    }

    init {
        // A network change must reach the shared event stream even when the
        // notification service is not running (it used to be the only
        // registrar, so the UI alone waited out the read timeout).
        registerNetworkCallback()
        // The render layer resolves relative media URLs and loads images with
        // the same authenticated client as the chat transport.
        RenderEnvironment.configure(
            baseUrlProvider = { settings.originNow()?.origin },
            httpClient = httpClient,
        )
        // Exports are one-shot share payloads; anything still in the cache was
        // left by an interrupted share or a process death.
        SessionExport.purgeStaleExports(appContext)
        // Recordings/playback downloads from a dead process are unreachable;
        // the kept recording (retry fallback) survives.
        dictationStore.purgeOrphans()
        ProcessLifecycleOwner.get().lifecycle.addObserver(
            object : DefaultLifecycleObserver {
                /** False until the cold start has been seen; see [onStart]. */
                private var foregrounded = false

                override fun onStart(owner: LifecycleOwner) {
                    notifications.setAppForeground(true)
                    eventMux.onForeground()
                    // Every return to the foreground continues an install that
                    // stopped at NeedsPermission — the shell banner has no
                    // screen-level resume hook, so coming back from Android's
                    // "install unknown apps" page used to leave it stuck there.
                    // Harmless in every other state.
                    androidUpdates.resumeInstallAfterPermission()
                    // Android keeps the process alive for days, so a check on
                    // start alone would rarely run again. Every later return
                    // to the foreground rechecks, and the controller bypasses
                    // its six-hour cache once the last answer is older than
                    // 30 minutes - otherwise a published release could stay
                    // unseen for most of the day. Inside that window the
                    // cached answer is reused, so app switching stays offline.
                    // The cold start is skipped: the shell staggers its own
                    // check until content is on screen, and the stored source
                    // is seeded by then.
                    if (foregrounded) {
                        androidUpdates.checkOnForeground()
                    } else {
                        foregrounded = true
                    }
                }

                override fun onStop(owner: LifecycleOwner) {
                    notifications.setAppForeground(false)
                    eventMux.onBackground()
                }
            },
        )
    }

    private companion object {
        /** `filesDir` subdirectory of the cache-first payloads. */
        const val SESSION_CACHE_DIR = "session-cache"
    }
}
