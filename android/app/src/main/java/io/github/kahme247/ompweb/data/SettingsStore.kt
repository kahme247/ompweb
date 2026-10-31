package io.github.kahme247.ompweb.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import io.github.kahme247.ompweb.domain.ActiveGoal
import io.github.kahme247.ompweb.domain.AndroidUpdateCache
import io.github.kahme247.ompweb.domain.DEFAULT_SOUND_ENABLED
import io.github.kahme247.ompweb.domain.DictationEnginePreference
import io.github.kahme247.ompweb.domain.FontSizePreference
import io.github.kahme247.ompweb.domain.NotifyIdentity
import io.github.kahme247.ompweb.domain.NotifyPrefs
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.domain.ToolPreset
import io.github.kahme247.ompweb.domain.TouchTargetsPreference
import io.github.kahme247.ompweb.domain.UiScalePreference
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.encodeActiveGoal
import io.github.kahme247.ompweb.domain.isValidNotificationId
import io.github.kahme247.ompweb.domain.parseActiveGoal
import io.github.kahme247.ompweb.domain.randomNotificationId
import io.github.kahme247.ompweb.net.ServerAddress
import io.github.kahme247.ompweb.net.ServerAddressResult
import io.github.kahme247.ompweb.ui.theme.DEFAULT_THEME_ID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull

private val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "ompweb-settings")

/** What the UI reads synchronously once DataStore emitted its first value. */
data class SettingsSnapshot(
    val origin: ServerAddress? = null,
    val themeId: String = DEFAULT_THEME_ID,
    /** Whether the server asked for a password; false for an open server. */
    val needsPassword: Boolean = true,
    /**
     * `null` means the user has never toggled a project: the sidebar then
     * expands only the active project (web `loadExpandedProjects`).
     */
    val expandedProjects: Set<String>? = null,
    val unreadSessionIds: Set<String> = emptySet(),
    /**
     * Sessions the user pinned, keyed by server origin (`scheme://host:port`).
     * A pin must never leak to another installation, whose ids mean nothing.
     */
    val pinnedSessionsByOrigin: Map<String, Set<String>> = emptyMap(),
    /** `dictation_engine` wire value (`auto`/`on_device`/`server`). */
    val dictationEngine: String = "auto",
    /** `dictation_language` BCP-47 tag; null uses the device locale. */
    val dictationLanguage: String? = null,
    val toolPreset: String = ToolPreset.FULL.wireName,
    /** Web default: finished and running tool calls start folded. */
    val toolCallsCollapsed: Boolean = true,
    /** Web default: the running turn folds its activity like a finished one. */
    val hideToolActivity: Boolean = true,
    /** Web default: reasoning stays folded until the user opens it. */
    val expandThinking: Boolean = false,
    /** Web default: reasoning blocks are shown (folded), not dropped. */
    val hideThinking: Boolean = false,
    /** Web default: the newest reply is read aloud only on request. */
    val ttsAutoplay: Boolean = false,
    /** A TextToSpeech voice name; null means the engine default. */
    val ttsVoice: String? = null,
    /** The session that was open last; restored on a cold start. */
    val lastSessionId: String? = null,
    /** The new-session pane's workspace when that was the last view; validated on restore. */
    val lastNewSessionCwd: String? = null,
    /** First visible transcript row per session, for restoring the scroll position. */
    val chatScrollPositions: Map<String, Int> = emptyMap(),
    /** `omp-web:submit-during-run`; queuing is the resilient default. */
    val submitDuringRun: SubmitDuringRunBehavior = SubmitDuringRunBehavior.DEFAULT,
    /** `omp-web:word-completion` wire value (`auto`/`on`/`off`). */
    val wordCompletion: String = "auto",
    /** `omp-sound-enabled`: play the completion tone. */
    val soundEnabled: Boolean = DEFAULT_SOUND_ENABLED,
    /** Per-session `/goal` records, keyed by session id. */
    val activeGoals: Map<String, ActiveGoal> = emptyMap(),
    /** `omp-web:composer-todo-collapsed`: the attached todo panel starts collapsed. */
    val composerTodoCollapsed: Boolean = true,
    /** `omp-web:composer-subagents-collapsed`: the attached roster starts collapsed. */
    val composerSubagentsCollapsed: Boolean = true,
    /** `omp-web:open-url-automatically`: open the agent's links without asking. */
    val openUrlAutomatically: Boolean = false,
    /** Sessions with the advisor enabled (`omp-advisor-enabled:<sid>`). */
    val advisorSessions: Set<String> = emptySet(),
    /** `omp-composer-models`: null means every model is offered. */
    val composerModels: Set<String>? = null,
    /** `omp-font-size`: chat font preference (sm/md/lg/xl). */
    val fontSize: String = "md",
    /** `omp-ui-scale`: overall UI zoom (compact/standard/comfortable/large). */
    val uiScale: String = "standard",
    /** `omp-touch-targets`: minimum interactive target (auto/compact/accessible). */
    val touchTargets: String = "auto",
    /** `omp-web:dismissed-app-update`: the app version the banner was dismissed for. */
    val dismissedAppUpdateVersion: String? = null,
    /** `omp-web:dismissed-omp-update`: the omp version the banner was dismissed for. */
    val dismissedOmpUpdateVersion: String? = null,
    /** `omp-web:completed-app-update`: the version whose install finished. */
    val completedAppUpdateVersion: String? = null,
    /** `ompweb:dismissed-android-update`: the Android release version the banner was dismissed for. */
    val dismissedAndroidUpdateVersion: String? = null,
    /** Last successful update check, cached for six hours. */
    val androidUpdateCache: AndroidUpdateCache? = null,
    /** `ompweb:android-update-feed`: custom feed URL; null means GitHub Releases. */
    val androidUpdateFeedUrl: String? = null,
    /** `omp-notify-prefs`; native defaults follow PLAN §4. */
    val notifyPrefs: NotifyPrefs = NotifyPrefs.DEFAULT,
    /** Per-installation identity for `PUT /api/notifications/devices` and presence. */
    val notifyDeviceId: String? = null,
    val notifyClientId: String? = null,
    /** The one-time onboarding prompt for the notification permission. */
    val notifyPermissionPrompted: Boolean = false,
    /** False until the first DataStore emission arrived; the app waits for it. */
    val loaded: Boolean = false,
)

/**
 * The client-side preferences the settings screens read and write. Split off
 * [SettingsStore] the same way [WorkspacePreferences] and [ChatSettings] are,
 * so `SettingsViewModel` runs in JVM tests with a fake instead of DataStore.
 */
interface SettingsViewPreferences {
    val snapshot: StateFlow<SettingsSnapshot>

    /** `omp-web:dismissed-app-update` / `omp-web:dismissed-omp-update`; null clears. */
    suspend fun setDismissedUpdate(kind: UpdateKind, version: String?)

    /** `omp-web:completed-app-update`: suppresses the banner for that version. */
    suspend fun setCompletedAppUpdate(version: String?)

    /** Dictation engine choice (`auto`/`on_device`/`server`). */
    suspend fun setDictationEngine(wire: String)

    /** Recognition language tag; null follows the device locale. */
    suspend fun setDictationLanguage(tag: String?)
}

/** The Android self-update banner's persistable facts. */
data class AndroidUpdatePreferencesSnapshot(
    /** The release version the user dismissed; a newer one shows again. */
    val dismissedVersion: String? = null,
    /** The last successful check; null until one succeeded. */
    val cache: AndroidUpdateCache? = null,
    /** A custom feed URL; null means GitHub Releases. */
    val feedUrl: String? = null,
)

/**
 * Persistence seam of the app-update check. Kept apart from
 * [SettingsViewPreferences] because the app update belongs to the installed
 * APK, not to the server installation, and because its cache is rewritten on
 * every check.
 */
interface AndroidUpdatePreferences {
    val androidUpdatePreferences: StateFlow<AndroidUpdatePreferencesSnapshot>

    /** Persists the dismissed release version; null clears it. */
    suspend fun setDismissedAndroidUpdate(version: String?)

    suspend fun setAndroidUpdateCache(cache: AndroidUpdateCache)

    /** Persists the selected update source; null selects GitHub Releases. */
    suspend fun setAndroidUpdateFeedUrl(url: String?)
}

/**
 * Client-side settings: the server origin, the theme preference, and the
 * sidebar's persisted workspace state (expanded projects, unread sessions,
 * tool preset — the web's `omp-web:*` localStorage keys).
 *
 * The session cookie is deliberately not stored here — it lives encrypted on
 * its own (see `EncryptedCookieRecords`). The password is never stored at all.
 * [originNow] is a plain in-memory read so the HTTP cookie jar (called on
 * OkHttp threads, with no coroutine context) can bind cookies to the origin.
 * Origin and password requirement are written through to the snapshot before
 * the DataStore write finishes, so a request started right after "Connect"
 * cannot see the previous origin.
 */
class SettingsStore(context: Context, private val scope: CoroutineScope) :
    WorkspacePreferences, ChatSettings, SettingsViewPreferences, AndroidUpdatePreferences {

    private val dataStore = context.applicationContext.settingsDataStore
    private val _snapshot = MutableStateFlow(SettingsSnapshot())
    override val snapshot: StateFlow<SettingsSnapshot> = _snapshot.asStateFlow()

    /** A derived view so the update checker does not depend on the whole settings surface. */
    override val androidUpdatePreferences: StateFlow<AndroidUpdatePreferencesSnapshot> =
        snapshot.map { current ->
            AndroidUpdatePreferencesSnapshot(
                dismissedVersion = current.dismissedAndroidUpdateVersion,
                cache = current.androidUpdateCache,
                feedUrl = current.androidUpdateFeedUrl,
            )
        }.stateIn(scope, SharingStarted.Eagerly, AndroidUpdatePreferencesSnapshot())
    private val notifyIdentityMutex = Mutex()

    init {
        scope.launch {
            dataStore.data.collect { preferences ->
                val origin = parseOrigin(preferences[ORIGIN])
                _snapshot.value = SettingsSnapshot(
                    origin = origin,
                    themeId = preferences[THEME]?.takeIf { it.isNotBlank() } ?: DEFAULT_THEME_ID,
                    needsPassword = preferences[NEEDS_PASSWORD] ?: true,
                    expandedProjects = parseStringSet(preferences[EXPANDED_PROJECTS]),
                    unreadSessionIds = parseStringSet(preferences[UNREAD_SESSIONS]) ?: emptySet(),
                    pinnedSessionsByOrigin = parsePinnedSessions(preferences[PINNED_SESSIONS]),
                    dictationEngine = preferences[DICTATION_ENGINE]?.takeIf { it.isNotBlank() } ?: "auto",
                    dictationLanguage = preferences[DICTATION_LANGUAGE]?.takeIf { it.isNotBlank() },
                    toolPreset = preferences[TOOL_PRESET]?.takeIf { it.isNotBlank() } ?: ToolPreset.FULL.wireName,
                    toolCallsCollapsed = preferences[TOOL_CALLS_COLLAPSED] ?: true,
                    hideToolActivity = preferences[HIDE_TOOL_ACTIVITY] ?: true,
                    expandThinking = preferences[EXPAND_THINKING] ?: false,
                    hideThinking = preferences[HIDE_THINKING] ?: false,
                    ttsAutoplay = preferences[TTS_AUTOPLAY] ?: false,
                    ttsVoice = preferences[TTS_VOICE]?.takeIf { it.isNotBlank() },
                    lastSessionId = preferences[LAST_SESSION_ID]?.takeIf { it.isNotBlank() },
                    lastNewSessionCwd = preferences[LAST_NEW_SESSION_CWD]?.takeIf { it.isNotBlank() },
                    chatScrollPositions = parseScrollPositions(preferences[CHAT_SCROLL_POSITIONS]),
                    submitDuringRun = SubmitDuringRunBehavior.fromWire(preferences[SUBMIT_DURING_RUN]),
                    wordCompletion = preferences[WORD_COMPLETION]?.takeIf { it.isNotBlank() } ?: "auto",
                    soundEnabled = preferences[SOUND_ENABLED] ?: DEFAULT_SOUND_ENABLED,
                    activeGoals = parseGoals(preferences[ACTIVE_GOALS]),
                    composerTodoCollapsed = preferences[COMPOSER_TODO_COLLAPSED] ?: true,
                    composerSubagentsCollapsed = preferences[COMPOSER_SUBAGENTS_COLLAPSED] ?: true,
                    openUrlAutomatically = preferences[OPEN_URL_AUTOMATICALLY] ?: false,
                    advisorSessions = parseStringSet(preferences[ADVISOR_SESSIONS]) ?: emptySet(),
                    composerModels = parseStringSet(preferences[COMPOSER_MODELS]),
                    fontSize = preferences[FONT_SIZE]?.takeIf { it.isNotBlank() } ?: "md",
                    uiScale = preferences[UI_SCALE]?.takeIf { it.isNotBlank() } ?: "standard",
                    touchTargets = preferences[TOUCH_TARGETS]?.takeIf { it.isNotBlank() } ?: "auto",
                    dismissedAppUpdateVersion = preferences[DISMISSED_APP_UPDATE]?.takeIf { it.isNotBlank() },
                    dismissedOmpUpdateVersion = preferences[DISMISSED_OMP_UPDATE]?.takeIf { it.isNotBlank() },
                    completedAppUpdateVersion = preferences[COMPLETED_APP_UPDATE]?.takeIf { it.isNotBlank() },
                    dismissedAndroidUpdateVersion = preferences[DISMISSED_ANDROID_UPDATE]?.takeIf { it.isNotBlank() },
                    androidUpdateCache = parseAndroidUpdateCache(preferences[ANDROID_UPDATE_CACHE]),
                    androidUpdateFeedUrl = preferences[ANDROID_UPDATE_FEED]?.takeIf { it.isNotBlank() },
                    notifyPrefs = parseNotifyPrefs(preferences[NOTIFY_PREFS]),
                    notifyDeviceId = preferences[NOTIFY_DEVICE_ID]?.takeIf(::isValidNotificationId),
                    notifyClientId = preferences[NOTIFY_CLIENT_ID]?.takeIf(::isValidNotificationId),
                    notifyPermissionPrompted = preferences[NOTIFY_PERMISSION_PROMPTED] ?: false,
                    loaded = true,
                )
            }
        }
    }

    fun originNow(): ServerAddress? = _snapshot.value.origin

    /**
     * Suspends until the first DataStore emission filled the snapshot.
     *
     * A broadcaster started from a notification action and the notification
     * service's own start run before that emission in a cold process; reading
     * the snapshot there would see "no origin configured" and misjudge both
     * the origin and the enabled flag.
     */
    suspend fun awaitLoaded(): SettingsSnapshot = awaitLoadedSnapshot(snapshot)

    suspend fun setOrigin(origin: String?) {
        val parsed = parseOrigin(origin)
        synchronized(this) { _snapshot.value = _snapshot.value.copy(origin = parsed) }
        dataStore.edit { preferences ->
            if (origin == null) {
                preferences.remove(ORIGIN)
            } else {
                preferences[ORIGIN] = origin
            }
        }
    }

    suspend fun setNeedsPassword(needsPassword: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(needsPassword = needsPassword) }
        dataStore.edit { preferences -> preferences[NEEDS_PASSWORD] = needsPassword }
    }

    /**
     * The stable per-installation notification identity. Generated once and
     * kept across restarts; `clearNotifyIdentity()` drops it with the rest of
     * the signed-in user's local data.
     */
    suspend fun ensureNotifyIdentity(): NotifyIdentity = notifyIdentityMutex.withLock {
        val current = _snapshot.value
        if (isValidNotificationId(current.notifyDeviceId) && isValidNotificationId(current.notifyClientId)) {
            return@withLock NotifyIdentity(current.notifyDeviceId!!, current.notifyClientId!!)
        }
        val created = NotifyIdentity(
            deviceId = current.notifyDeviceId?.takeIf(::isValidNotificationId) ?: randomNotificationId(),
            clientId = current.notifyClientId?.takeIf(::isValidNotificationId) ?: randomNotificationId(),
        )
        synchronized(this) {
            _snapshot.value = _snapshot.value.copy(
                notifyDeviceId = created.deviceId,
                notifyClientId = created.clientId,
            )
        }
        dataStore.edit { preferences ->
            if (!isValidNotificationId(preferences[NOTIFY_DEVICE_ID])) preferences[NOTIFY_DEVICE_ID] = created.deviceId
            if (!isValidNotificationId(preferences[NOTIFY_CLIENT_ID])) preferences[NOTIFY_CLIENT_ID] = created.clientId
        }
        val stored = _snapshot.value
        NotifyIdentity(
            deviceId = stored.notifyDeviceId ?: created.deviceId,
            clientId = stored.notifyClientId ?: created.clientId,
        )
    }

    suspend fun clearNotifyIdentity() {
        synchronized(this) {
            _snapshot.value = _snapshot.value.copy(notifyDeviceId = null, notifyClientId = null)
        }
        dataStore.edit { preferences ->
            preferences.remove(NOTIFY_DEVICE_ID)
            preferences.remove(NOTIFY_CLIENT_ID)
        }
    }

    suspend fun setNotifyPrefs(prefs: NotifyPrefs) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(notifyPrefs = prefs) }
        dataStore.edit { preferences -> preferences[NOTIFY_PREFS] = prefs.toJson().toString() }
    }

    suspend fun setNotifyPermissionPrompted(prompted: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(notifyPermissionPrompted = prompted) }
        dataStore.edit { preferences -> preferences[NOTIFY_PERMISSION_PROMPTED] = prompted }
    }

    suspend fun setTheme(themeId: String) {
        dataStore.edit { preferences -> preferences[THEME] = themeId }
    }

    /** Persisted as one JSON array; an empty set is still a stored choice. */
    override suspend fun setExpandedProjects(projects: Set<String>) {
        val encoded = encodeStringSet(projects)
        synchronized(this) { _snapshot.value = _snapshot.value.copy(expandedProjects = projects.toSet()) }
        dataStore.edit { preferences -> preferences[EXPANDED_PROJECTS] = encoded }
    }

    /** Removed entirely when empty, like `saveUnreadSessionIds` on the web. */
    override suspend fun setUnreadSessionIds(ids: Set<String>) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(unreadSessionIds = ids.toSet()) }
        dataStore.edit { preferences ->
            if (ids.isEmpty()) {
                preferences.remove(UNREAD_SESSIONS)
            } else {
                preferences[UNREAD_SESSIONS] = encodeStringSet(ids)
            }
        }
    }

    /**
     * Pins are scoped to one server origin: the same id on another
     * installation is a different session. The whole map is rewritten in one
     * edit so an origin's list can never be half-updated.
     */
    override suspend fun setPinnedSessions(origin: String, ids: Set<String>) {
        val key = origin.trim()
        if (key.isEmpty()) return
        val next = _snapshot.value.pinnedSessionsByOrigin.toMutableMap().apply {
            if (ids.isEmpty()) remove(key) else put(key, ids.toSet())
        }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(pinnedSessionsByOrigin = next) }
        dataStore.edit { preferences ->
            if (next.isEmpty()) {
                preferences.remove(PINNED_SESSIONS)
            } else {
                preferences[PINNED_SESSIONS] = encodePinnedSessions(next)
            }
        }
    }

    override suspend fun setToolPreset(preset: ToolPreset) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(toolPreset = preset.wireName) }
        dataStore.edit { preferences -> preferences[TOOL_PRESET] = preset.wireName }
    }

    /**
     * One `edit` for both markers: the pane's workspace is stored and the
     * session marker removed together (a blank cwd clears the pane marker).
     */
    override suspend fun setLastNewSessionView(cwd: String) {
        val normalized = cwd.takeIf { it.isNotBlank() }
        synchronized(this) {
            _snapshot.value = _snapshot.value.copy(lastNewSessionCwd = normalized, lastSessionId = null)
        }
        dataStore.edit { preferences ->
            if (normalized == null) {
                preferences.remove(LAST_NEW_SESSION_CWD)
            } else {
                preferences[LAST_NEW_SESSION_CWD] = normalized
            }
            preferences.remove(LAST_SESSION_ID)
        }
    }

    override suspend fun clearLastNewSessionView() {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(lastNewSessionCwd = null) }
        dataStore.edit { preferences -> preferences.remove(LAST_NEW_SESSION_CWD) }
    }

    /**
     * Mirror of [setLastNewSessionView] for the session side: one edit stores
     * the session marker and removes the pane marker together.
     */
    override suspend fun setLastSessionView(sessionId: String) {
        synchronized(this) {
            _snapshot.value = _snapshot.value.copy(lastSessionId = sessionId, lastNewSessionCwd = null)
        }
        dataStore.edit { preferences ->
            preferences[LAST_SESSION_ID] = sessionId
            preferences.remove(LAST_NEW_SESSION_CWD)
        }
    }

    override suspend fun clearLastSession() {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(lastSessionId = null) }
        dataStore.edit { preferences -> preferences.remove(LAST_SESSION_ID) }
    }

    /** Remember the first visible transcript row of [sessionId] (top row = 0). */
    override suspend fun setChatScrollPosition(sessionId: String, rowIndex: Int) {
        val next = scrollPositionsWith(sessionId, rowIndex)
        synchronized(this) { _snapshot.value = _snapshot.value.copy(chatScrollPositions = next) }
        dataStore.edit { preferences -> writeScrollPositions(preferences, next) }
    }

    /** Same as [setChatScrollPosition], usable from `onCleared` (no caller scope). */
    override fun persistChatScrollPosition(sessionId: String, rowIndex: Int) {
        val next = scrollPositionsWith(sessionId, rowIndex)
        synchronized(this) { _snapshot.value = _snapshot.value.copy(chatScrollPositions = next) }
        scope.launch { dataStore.edit { preferences -> writeScrollPositions(preferences, next) } }
    }

    override suspend fun setSubmitDuringRun(behavior: SubmitDuringRunBehavior) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(submitDuringRun = behavior) }
        dataStore.edit { preferences -> preferences[SUBMIT_DURING_RUN] = behavior.wireName }
    }

    override suspend fun setWordCompletion(mode: String) {
        val normalized = when (mode) {
            "on", "off" -> mode
            else -> "auto"
        }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(wordCompletion = normalized) }
        dataStore.edit { preferences -> preferences[WORD_COMPLETION] = normalized }
    }

    override suspend fun setDictationEngine(wire: String) {
        val normalized = DictationEnginePreference.fromWire(wire).wire
        synchronized(this) { _snapshot.value = _snapshot.value.copy(dictationEngine = normalized) }
        dataStore.edit { preferences -> preferences[DICTATION_ENGINE] = normalized }
    }

    override suspend fun setDictationLanguage(tag: String?) {
        val normalized = tag?.trim()?.takeIf { it.isNotEmpty() }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(dictationLanguage = normalized) }
        dataStore.edit { preferences ->
            if (normalized == null) preferences.remove(DICTATION_LANGUAGE)
            else preferences[DICTATION_LANGUAGE] = normalized
        }
    }

    override suspend fun setSoundEnabled(enabled: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(soundEnabled = enabled) }
        dataStore.edit { preferences -> preferences[SOUND_ENABLED] = enabled }
    }

    override suspend fun setActiveGoal(sessionId: String, goal: ActiveGoal?) {
        val next = _snapshot.value.activeGoals.toMutableMap().apply {
            if (goal == null) remove(sessionId) else put(sessionId, goal)
        }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(activeGoals = next) }
        dataStore.edit { preferences ->
            if (next.isEmpty()) {
                preferences.remove(ACTIVE_GOALS)
            } else {
                preferences[ACTIVE_GOALS] = encodeGoals(next)
            }
        }
    }

    override suspend fun setComposerTodoCollapsed(collapsed: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(composerTodoCollapsed = collapsed) }
        dataStore.edit { preferences -> preferences[COMPOSER_TODO_COLLAPSED] = collapsed }
    }

    override suspend fun setComposerSubagentsCollapsed(collapsed: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(composerSubagentsCollapsed = collapsed) }
        dataStore.edit { preferences -> preferences[COMPOSER_SUBAGENTS_COLLAPSED] = collapsed }
    }

    override suspend fun setOpenUrlAutomatically(enabled: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(openUrlAutomatically = enabled) }
        dataStore.edit { preferences -> preferences[OPEN_URL_AUTOMATICALLY] = enabled }
    }

    suspend fun setToolCallsCollapsed(collapsed: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(toolCallsCollapsed = collapsed) }
        dataStore.edit { preferences -> preferences[TOOL_CALLS_COLLAPSED] = collapsed }
    }

    suspend fun setHideToolActivity(hidden: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(hideToolActivity = hidden) }
        dataStore.edit { preferences -> preferences[HIDE_TOOL_ACTIVITY] = hidden }
    }

    suspend fun setExpandThinking(expand: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(expandThinking = expand) }
        dataStore.edit { preferences -> preferences[EXPAND_THINKING] = expand }
    }

    suspend fun setTtsAutoplay(enabled: Boolean) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(ttsAutoplay = enabled) }
        dataStore.edit { preferences -> preferences[TTS_AUTOPLAY] = enabled }
    }

    suspend fun setTtsVoice(name: String?) {
        val voice = name?.takeIf { it.isNotBlank() }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(ttsVoice = voice) }
        dataStore.edit { preferences ->
            if (voice == null) preferences.remove(TTS_VOICE) else preferences[TTS_VOICE] = voice
        }
    }

    suspend fun setFontSize(preference: FontSizePreference) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(fontSize = preference.wire) }
        dataStore.edit { preferences -> preferences[FONT_SIZE] = preference.wire }
    }

    suspend fun setUiScale(preference: UiScalePreference) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(uiScale = preference.wire) }
        dataStore.edit { preferences -> preferences[UI_SCALE] = preference.wire }
    }

    suspend fun setTouchTargets(preference: TouchTargetsPreference) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(touchTargets = preference.wire) }
        dataStore.edit { preferences -> preferences[TOUCH_TARGETS] = preference.wire }
    }

    override suspend fun setDismissedUpdate(kind: UpdateKind, version: String?) {
        val normalized = version?.takeIf { it.isNotBlank() }
        synchronized(this) {
            _snapshot.value = when (kind) {
                UpdateKind.APP -> _snapshot.value.copy(dismissedAppUpdateVersion = normalized)
                UpdateKind.OMP -> _snapshot.value.copy(dismissedOmpUpdateVersion = normalized)
            }
        }
        dataStore.edit { preferences ->
            val key = when (kind) {
                UpdateKind.APP -> DISMISSED_APP_UPDATE
                UpdateKind.OMP -> DISMISSED_OMP_UPDATE
            }
            if (normalized == null) preferences.remove(key) else preferences[key] = normalized
        }
    }

    override suspend fun setCompletedAppUpdate(version: String?) {
        val normalized = version?.takeIf { it.isNotBlank() }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(completedAppUpdateVersion = normalized) }
        dataStore.edit { preferences ->
            if (normalized == null) {
                preferences.remove(COMPLETED_APP_UPDATE)
            } else {
                preferences[COMPLETED_APP_UPDATE] = normalized
            }
        }
    }

    override suspend fun setDismissedAndroidUpdate(version: String?) {
        val normalized = version?.takeIf { it.isNotBlank() }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(dismissedAndroidUpdateVersion = normalized) }
        dataStore.edit { preferences ->
            if (normalized == null) {
                preferences.remove(DISMISSED_ANDROID_UPDATE)
            } else {
                preferences[DISMISSED_ANDROID_UPDATE] = normalized
            }
        }
    }

    override suspend fun setAndroidUpdateCache(cache: AndroidUpdateCache) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(androidUpdateCache = cache) }
        dataStore.edit { preferences -> preferences[ANDROID_UPDATE_CACHE] = json.encodeToString(cache) }
    }

    override suspend fun setAndroidUpdateFeedUrl(url: String?) {
        val normalized = url?.trim()?.takeIf { it.isNotEmpty() }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(androidUpdateFeedUrl = normalized) }
        dataStore.edit { preferences ->
            if (normalized == null) {
                preferences.remove(ANDROID_UPDATE_FEED)
            } else {
                preferences[ANDROID_UPDATE_FEED] = normalized
            }
        }
    }

    override suspend fun setComposerModels(models: Set<String>?) {
        synchronized(this) { _snapshot.value = _snapshot.value.copy(composerModels = models) }
        dataStore.edit { preferences ->
            if (models == null) {
                preferences.remove(COMPOSER_MODELS)
            } else {
                preferences[COMPOSER_MODELS] = encodeStringSet(models)
            }
        }
    }

    override suspend fun setAdvisorEnabled(sessionId: String, enabled: Boolean) {
        val next = _snapshot.value.advisorSessions.toMutableSet().apply {
            if (enabled) add(sessionId) else remove(sessionId)
        }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(advisorSessions = next) }
        dataStore.edit { preferences ->
            if (next.isEmpty()) {
                preferences.remove(ADVISOR_SESSIONS)
            } else {
                preferences[ADVISOR_SESSIONS] = encodeStringSet(next)
            }
        }
    }

    override fun markSessionCreated(sessionId: String, advisor: Boolean) {
        val next = _snapshot.value.advisorSessions.toMutableSet().apply {
            if (advisor) add(sessionId) else remove(sessionId)
        }
        synchronized(this) { _snapshot.value = _snapshot.value.copy(advisorSessions = next) }
        scope.launch { setAdvisorEnabled(sessionId, advisor) }
    }

    private fun scrollPositionsWith(sessionId: String, rowIndex: Int): Map<String, Int> =
        _snapshot.value.chatScrollPositions.toMutableMap().apply {
            if (rowIndex <= 0) remove(sessionId) else put(sessionId, rowIndex)
        }

    private fun writeScrollPositions(preferences: MutablePreferences, positions: Map<String, Int>) {
        if (positions.isEmpty()) {
            preferences.remove(CHAT_SCROLL_POSITIONS)
        } else {
            preferences[CHAT_SCROLL_POSITIONS] = encodeScrollPositions(positions)
        }
    }

    private companion object {
        val ORIGIN = stringPreferencesKey("server_origin")
        val THEME = stringPreferencesKey("theme")
        val NEEDS_PASSWORD = booleanPreferencesKey("needs_password")
        val EXPANDED_PROJECTS = stringPreferencesKey("expanded_projects")
        val UNREAD_SESSIONS = stringPreferencesKey("unread_sessions")
        val PINNED_SESSIONS = stringPreferencesKey("pinned_sessions_by_origin")
        val DICTATION_ENGINE = stringPreferencesKey("dictation_engine")
        val DICTATION_LANGUAGE = stringPreferencesKey("dictation_language")
        val TOOL_PRESET = stringPreferencesKey("tool_preset")
        val TOOL_CALLS_COLLAPSED = booleanPreferencesKey("tool_calls_collapsed")
        val HIDE_TOOL_ACTIVITY = booleanPreferencesKey("hide_tool_activity")
        val EXPAND_THINKING = booleanPreferencesKey("expand_thinking")
        val HIDE_THINKING = booleanPreferencesKey("hide_thinking")
        val TTS_AUTOPLAY = booleanPreferencesKey("tts_autoplay")
        val TTS_VOICE = stringPreferencesKey("tts_voice")
        val LAST_SESSION_ID = stringPreferencesKey("last_session_id")
        val LAST_NEW_SESSION_CWD = stringPreferencesKey("last_new_session_cwd")
        val CHAT_SCROLL_POSITIONS = stringPreferencesKey("chat_scroll_positions")
        val SUBMIT_DURING_RUN = stringPreferencesKey("submit_during_run")
        val WORD_COMPLETION = stringPreferencesKey("word_completion")
        val SOUND_ENABLED = booleanPreferencesKey("sound_enabled")
        val ACTIVE_GOALS = stringPreferencesKey("active_goals")
        val COMPOSER_TODO_COLLAPSED = booleanPreferencesKey("composer_todo_collapsed")
        val COMPOSER_SUBAGENTS_COLLAPSED = booleanPreferencesKey("composer_subagents_collapsed")
        val OPEN_URL_AUTOMATICALLY = booleanPreferencesKey("open_url_automatically")
        val ADVISOR_SESSIONS = stringPreferencesKey("advisor_sessions")
        val COMPOSER_MODELS = stringPreferencesKey("composer_models")
        val FONT_SIZE = stringPreferencesKey("omp-font-size")
        val UI_SCALE = stringPreferencesKey("omp-ui-scale")
        val TOUCH_TARGETS = stringPreferencesKey("omp-touch-targets")
        val DISMISSED_APP_UPDATE = stringPreferencesKey("omp-web:dismissed-app-update")
        val DISMISSED_OMP_UPDATE = stringPreferencesKey("omp-web:dismissed-omp-update")
        val COMPLETED_APP_UPDATE = stringPreferencesKey("omp-web:completed-app-update")
        val DISMISSED_ANDROID_UPDATE = stringPreferencesKey("ompweb:dismissed-android-update")
        val ANDROID_UPDATE_CACHE = stringPreferencesKey("ompweb:android-update-cache")
        val ANDROID_UPDATE_FEED = stringPreferencesKey("ompweb:android-update-feed")
        val NOTIFY_PREFS = stringPreferencesKey("notify_prefs")
        val NOTIFY_DEVICE_ID = stringPreferencesKey("notify_device_id")
        val NOTIFY_CLIENT_ID = stringPreferencesKey("notify_client_id")
        val NOTIFY_PERMISSION_PROMPTED = booleanPreferencesKey("notify_permission_prompted")

        val json = Json { ignoreUnknownKeys = true }

        fun parseAndroidUpdateCache(raw: String?): AndroidUpdateCache? {
            if (raw.isNullOrBlank()) return null
            return try {
                json.decodeFromString<AndroidUpdateCache>(raw)
            } catch (_: Exception) {
                // A truncated or old cache is simply a cache miss.
                null
            }
        }

        fun parseNotifyPrefs(raw: String?): NotifyPrefs {
            if (raw.isNullOrBlank()) return NotifyPrefs.DEFAULT
            return try {
                NotifyPrefs.parse(json.parseToJsonElement(raw))
            } catch (_: Exception) {
                NotifyPrefs.DEFAULT
            }
        }

        fun parseScrollPositions(raw: String?): Map<String, Int> {
            if (raw.isNullOrBlank()) return emptyMap()
            return try {
                val root = json.parseToJsonElement(raw) as? kotlinx.serialization.json.JsonObject ?: return emptyMap()
                root.mapNotNull { (key, value) ->
                    val index = (value as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: return@mapNotNull null
                    if (index <= 0) null else key to index
                }.toMap()
            } catch (_: Exception) {
                emptyMap()
            }
        }

        fun encodeScrollPositions(values: Map<String, Int>): String =
            kotlinx.serialization.json.JsonObject(
                values.mapValues { JsonPrimitive(it.value) },
            ).toString()

        fun parseGoals(raw: String?): Map<String, ActiveGoal> {
            if (raw.isNullOrBlank()) return emptyMap()
            return try {
                val root = json.parseToJsonElement(raw) as? kotlinx.serialization.json.JsonObject
                    ?: return emptyMap()
                root.mapNotNull { (sessionId, value) ->
                    val goal = parseActiveGoal((value as? JsonPrimitive)?.contentOrNull) ?: return@mapNotNull null
                    sessionId to goal
                }.toMap()
            } catch (_: Exception) {
                emptyMap()
            }
        }

        fun encodeGoals(goals: Map<String, ActiveGoal>): String =
            kotlinx.serialization.json.JsonObject(
                goals.mapValues { (_, goal) -> JsonPrimitive(encodeActiveGoal(goal)) },
            ).toString()

        fun parseOrigin(raw: String?): ServerAddress? {
            if (raw.isNullOrBlank()) return null
            return (ServerAddress.parse(raw) as? ServerAddressResult.Valid)?.address
        }

        fun parseStringSet(raw: String?): Set<String>? {
            if (raw == null) return null
            return try {
                (json.parseToJsonElement(raw) as? JsonArray)
                    ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                    ?.toCollection(linkedSetOf())
                    ?: emptySet()
            } catch (_: Exception) {
                emptySet()
            }
        }

        fun encodeStringSet(values: Set<String>): String =
            buildJsonArray { values.sorted().forEach { add(JsonPrimitive(it)) } }.toString()

        /** `{origin: [sessionId, …]}`; malformed entries are dropped. */
        fun parsePinnedSessions(raw: String?): Map<String, Set<String>> {
            if (raw.isNullOrBlank()) return emptyMap()
            return try {
                val root = json.parseToJsonElement(raw) as? JsonObject ?: return emptyMap()
                root.mapNotNull { (origin, value) ->
                    if (origin.isBlank()) return@mapNotNull null
                    val ids = (value as? JsonArray)
                        ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                        ?.filter { it.isNotBlank() }
                        ?.toSet()
                        ?: return@mapNotNull null
                    if (ids.isEmpty()) null else origin to ids
                }.toMap()
            } catch (_: Exception) {
                emptyMap()
            }
        }

        fun encodePinnedSessions(values: Map<String, Set<String>>): String =
            JsonObject(
                values.toSortedMap().mapValues { (_, ids) ->
                    buildJsonArray { ids.sorted().forEach { add(JsonPrimitive(it)) } }
                },
            ).toString()
    }
}

/**
 * Suspends until [snapshot] carries its first DataStore emission. Kept apart
 * from [SettingsStore] so the wait itself is testable: a broadcaster or a
 * restarted service that decides from the empty default would judge the origin
 * and the enabled flag wrongly.
 */
suspend fun awaitLoadedSnapshot(snapshot: StateFlow<SettingsSnapshot>): SettingsSnapshot =
    snapshot.first { it.loaded }
