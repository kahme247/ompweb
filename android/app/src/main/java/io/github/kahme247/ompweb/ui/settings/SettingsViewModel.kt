package io.github.kahme247.ompweb.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.github.kahme247.ompweb.data.SettingsViewPreferences
import io.github.kahme247.ompweb.domain.AgentEnv
import io.github.kahme247.ompweb.domain.UpdateKind
import io.github.kahme247.ompweb.domain.UpdateNoticeState
import io.github.kahme247.ompweb.domain.UpdatePhase
import io.github.kahme247.ompweb.domain.isTerminalUpdateState
import io.github.kahme247.ompweb.domain.isUpdateNoticeCheckDue
import io.github.kahme247.ompweb.domain.selectUpdateNotice
import io.github.kahme247.ompweb.domain.updatePhaseFor
import io.github.kahme247.ompweb.net.AppUpdateInfo
import io.github.kahme247.ompweb.net.MobileAccessInfo
import io.github.kahme247.ompweb.net.OmpUpdateInfo
import io.github.kahme247.ompweb.net.ProviderUsageSnapshot
import io.github.kahme247.ompweb.net.ReleaseNotes
import io.github.kahme247.ompweb.net.SelfUpdateStatus
import io.github.kahme247.ompweb.net.ServerAppInfo
import io.github.kahme247.ompweb.net.SystemApi
import io.github.kahme247.ompweb.net.UsageGranularity
import io.github.kahme247.ompweb.net.UsageReport
import io.github.kahme247.ompweb.net.UsageTimeRange
import io.github.kahme247.ompweb.net.WebServerSettings
import io.github.kahme247.ompweb.net.WindowsServiceAction
import io.github.kahme247.ompweb.net.WindowsServiceInfo
import io.github.kahme247.ompweb.net.userMessage
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * One in-app update attempt (web `AppUpdateDialog` / `handleOmpUpdateNow`):
 * the phase the card shows, the version being installed and the server's
 * error text when it failed.
 */
data class UpdateRunState(
    val kind: UpdateKind? = null,
    val phase: UpdatePhase = UpdatePhase.IDLE,
    val targetVersion: String? = null,
    val attemptId: String? = null,
    /** Server error text (`status.error`) when the attempt failed. */
    val error: String? = null,
    /** The status poll ran out of time ([UPDATE_TIMEOUT_MS]) without a terminal state. */
    val timedOut: Boolean = false,
) {
    val busy: Boolean
        get() = phase in setOf(
            UpdatePhase.PREPARING,
            UpdatePhase.RESTARTING,
            UpdatePhase.INSTALLING,
            UpdatePhase.FINALIZING,
        )
}

/** `/api/web-settings` plus the two update cards and the device-facing facts. */
data class SystemSettingsState(
    val loading: Boolean = false,
    val webSettings: WebServerSettings? = null,
    val webSettingsError: String? = null,
    val savingWebSettings: Boolean = false,
    val agentEnvDraft: String = "",
    val agentEnvDirty: Boolean = false,
    /** One message per rejected line (`AgentEnv.parse`); Save stays disabled. */
    val agentEnvErrors: List<String> = emptyList(),
    val appInfo: ServerAppInfo? = null,
    val appUpdate: AppUpdateInfo? = null,
    val checkingAppUpdate: Boolean = false,
    val appUpdateRun: UpdateRunState = UpdateRunState(UpdateKind.APP),
    val ompUpdate: OmpUpdateInfo? = null,
    val checkingOmpUpdate: Boolean = false,
    val ompUpdateRun: UpdateRunState = UpdateRunState(UpdateKind.OMP),
    val releaseNotes: ReleaseNotes? = null,
    val releaseNotesLoading: Boolean = false,
    val releaseNotesLoaded: Boolean = false,
    val releaseNotesError: String? = null,
    val releaseNotesOpen: Boolean = false,
    val restartingSessions: Boolean = false,
    val mobileAccess: MobileAccessInfo? = null,
    val mobileAccessError: String? = null,
    val windowsService: WindowsServiceInfo? = null,
    val windowsActionPending: Boolean = false,
    val windowsError: String? = null,
    val message: String? = null,
    val messageIsError: Boolean = false,
) {
    /** Save is gated on the parser: an invalid line never reaches the server. */
    val agentEnvValid: Boolean get() = agentEnvErrors.isEmpty()

    fun run(kind: UpdateKind): UpdateRunState = when (kind) {
        UpdateKind.APP -> appUpdateRun
        UpdateKind.OMP -> ompUpdateRun
    }
}

data class UsageState(
    val range: UsageTimeRange = UsageTimeRange.THIRTY_DAYS,
    val granularity: UsageGranularity = UsageGranularity.DAILY,
    /** Web `metricView`: the bars and the tapped value switch between cost and tokens. */
    val metric: UsageMetricView = UsageMetricView.COST,
    /** Web `breakdownView`: which table the Breakdown card lists. */
    val breakdown: UsageBreakdownView = UsageBreakdownView.MODEL,
    /** The tapped bar; null until the user taps one. */
    val selectedPointIndex: Int? = null,
    val report: UsageReport? = null,
    val loading: Boolean = false,
    val error: String? = null,
)

data class ProviderUsageState(
    val snapshot: ProviderUsageSnapshot? = null,
    val loading: Boolean = false,
    val error: Boolean = false,
    /** The one expanded account row (web `expandedKey`); null = all collapsed. */
    val expandedKey: String? = null,
)

/**
 * State for Settings → System & Updates, Usage and the provider usage block.
 *
 * The sheet's navigation (open tab, search query, highlight) deliberately does
 * not live here: `SettingsScreen` keeps it in `rememberSaveable` so it
 * survives rotation, a density change and process death, and starts on the
 * category list again after the sheet is closed.
 *
 * Local display preferences are not mirrored here: the sheet reads the
 * [SettingsViewPreferences.snapshot] directly and writes through it, so there
 * is one source of truth. Everything else this view model owns is server
 * state.
 */
class SettingsViewModel(
    private val system: SystemApi,
    private val settings: SettingsViewPreferences,
    private val poller: ProviderUsagePoller = ProviderUsagePoller.shared(
        system,
        { settings.snapshot.value.origin?.origin },
    ),
    /** Wall clock for the notice-check throttle; tests pass a fake. */
    private val nowMillis: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val _system = MutableStateFlow(SystemSettingsState())
    val systemState: StateFlow<SystemSettingsState> = _system.asStateFlow()

    private val _usage = MutableStateFlow(UsageState())
    val usageState: StateFlow<UsageState> = _usage.asStateFlow()

    /**
     * The last fetched update infos; the banner is derived from them and the
     * persisted dismiss keys, so dismissing needs no extra state.
     */
    private val updateInputs = MutableStateFlow(UpdateInputs())

    /** The one update the shell announces (web: the version-keyed toast). */
    val updateNotice: StateFlow<UpdateNoticeState?> =
        combine(updateInputs, settings.snapshot) { inputs, snapshot ->
            selectUpdateNotice(
                app = inputs.app,
                omp = inputs.omp,
                dismissedAppVersion = snapshot.dismissedAppUpdateVersion,
                dismissedOmpVersion = snapshot.dismissedOmpUpdateVersion,
                completedAppVersion = snapshot.completedAppUpdateVersion,
            )
        }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    val providerUsageState: StateFlow<ProviderUsageState> get() = poller.state

    init {
        viewModelScope.launch {
            // Everything this view model holds is per-installation state: a
            // sign-out or server switch must not leave the previous server's
            // update banner or provider limits on screen (P11Sec 4). The
            // activity-scoped instance survives the route change, so the
            // origin is the signal.
            settings.snapshot
                .map { it.origin?.origin }
                .distinctUntilChanged()
                .drop(1)
                .collect { resetServerState() }
        }
    }

    private fun resetServerState() {
        // Bumped before the inputs are cleared: a check that was already in
        // flight against the previous origin must not repopulate the banner.
        serverGeneration += 1
        updateInputs.value = UpdateInputs()
        _system.value = SystemSettingsState()
        _usage.value = UsageState()
        poller.reset()
        // Another server is another installation: its notice check must not
        // wait out the window the previous one opened.
        synchronized(this) {
            lastNoticeCheckSuccessAtMillis = null
            lastNoticeCheckFailureAtMillis = null
            noticeCheckRunning = false
        }
    }

    /** Incremented on every origin change; see [resetServerState]. */
    private var serverGeneration = 0

    /** Loads the System tab once (or again after an explicit refresh). */
    fun loadSystem(force: Boolean = false) {
        if (_system.value.loading) return
        if (!force && _system.value.webSettings != null && _system.value.appInfo != null) {
            if (_system.value.mobileAccess != null && _system.value.windowsService != null) return
        }
        _system.update { it.copy(loading = true, webSettingsError = null) }
        viewModelScope.launch {
            coroutineScope {
                val appInfo = async { runCatching { system.appInfo() } }
                val web = async { runCatching { system.webSettings() } }
                val update = async { runCatching { system.appUpdate() } }
                val mobile = async { runCatching { system.mobileAccess() } }
                val windows = async { runCatching { system.windowsService() } }

                val appInfoResult = appInfo.await()
                val webResult = web.await()
                val updateResult = update.await()
                val mobileResult = mobile.await()
                val windowsResult = windows.await()

                updateResult.getOrNull()?.let { publishAppUpdate(it) }
                _system.update { state ->
                    val loadedWeb = webResult.getOrNull()
                    val draft = if (state.agentEnvDirty || loadedWeb == null) {
                        state.agentEnvDraft
                    } else {
                        AgentEnv.format(loadedWeb.agentEnv)
                    }
                    state.copy(
                        loading = false,
                        webSettings = loadedWeb ?: state.webSettings,
                        webSettingsError = webResult.exceptionOrNull()?.let(::describe),
                        agentEnvDraft = draft,
                        agentEnvErrors = AgentEnv.parse(draft).errors,
                        appInfo = appInfoResult.getOrNull() ?: state.appInfo,
                        appUpdate = updateResult.getOrNull() ?: state.appUpdate,
                        mobileAccess = mobileResult.getOrNull() ?: state.mobileAccess,
                        mobileAccessError = mobileResult.exceptionOrNull()?.let(::describe),
                        windowsService = windowsResult.getOrNull() ?: state.windowsService,
                        windowsError = windowsResult.exceptionOrNull()?.let(::describe),
                    )
                }
            }
        }
    }

    // ----------------------------------------------------------- update notice

    /** When [checkForUpdateNotices] last got an answer; see [isUpdateNoticeCheckDue]. */
    private var lastNoticeCheckSuccessAtMillis: Long? = null

    /** When [checkForUpdateNotices] last reached neither endpoint. */
    private var lastNoticeCheckFailureAtMillis: Long? = null

    /** A launch is in flight; a second resume must not stack on it. */
    private var noticeCheckRunning = false

    /**
     * The start/resume check behind the shell banner: both update endpoints,
     * without touching the System tab's cards (web `checkAppUpdate` /
     * `checkForUpdate` on app start). Failures are silent — a banner is an
     * optional hint, not an error surface.
     *
     * Successful runs are throttled to one per
     * [io.github.kahme247.ompweb.domain.UPDATE_NOTICE_CHECK_INTERVAL_MILLIS]:
     * resuming is frequent and the server memoizes each answer for an hour, so
     * a return to the foreground inside the window keeps the answer already on
     * screen. Only a check that got an answer opens that window; a check that
     * reached nothing (offline, VPN down, `omp update --check` timeout) leaves
     * the window closed and buys the short
     * [io.github.kahme247.ompweb.domain.UPDATE_NOTICE_FAILURE_BACKOFF_MILLIS]
     * retry delay instead — otherwise one failed start would hide a release for
     * an hour. The stamps are per view model — a cold start has none and
     * therefore checks.
     */
    fun checkForUpdateNotices() {
        if (!claimNoticeCheck()) return
        val generation = serverGeneration
        viewModelScope.launch {
            var answered = false
            coroutineScope {
                val app = async { runCatching { system.appUpdate() } }
                val omp = async { runCatching { system.ompUpdateCheck() } }
                val appResult = app.await()
                val ompResult = omp.await()
                answered = appResult.isSuccess || ompResult.isSuccess
                if (generation == serverGeneration) {
                    appResult.getOrNull()?.let(::publishAppUpdate)
                    ompResult.getOrNull()?.let(::publishOmpUpdate)
                }
            }
            recordNoticeCheck(generation, answered)
        }
    }

    /**
     * Test-and-set of the throttle window. Nothing is stamped yet: the outcome
     * decides whether this opens the hour or only the short failure backoff.
     */
    private fun claimNoticeCheck(): Boolean = synchronized(this) {
        if (noticeCheckRunning) return false
        if (!isUpdateNoticeCheckDue(lastNoticeCheckSuccessAtMillis, lastNoticeCheckFailureAtMillis, nowMillis())) {
            return false
        }
        noticeCheckRunning = true
        true
    }

    private fun recordNoticeCheck(generation: Int, answered: Boolean) = synchronized(this) {
        // A check against the previous server says nothing about this one; its
        // reset already cleared the stamps and the in-flight flag, and a newer
        // check may already be running.
        if (generation != serverGeneration) return@synchronized
        noticeCheckRunning = false
        val now = nowMillis()
        if (answered) {
            lastNoticeCheckSuccessAtMillis = now
            lastNoticeCheckFailureAtMillis = null
        } else {
            lastNoticeCheckFailureAtMillis = now
        }
    }

    /**
     * Hides the banner for the version it announces; a newer version shows
     * again. The banner hands back the state it rendered, so the dismissed
     * version is exactly the one the reader clicked (an update check that
     * landed in between must not swap it for another).
     */
    fun dismissUpdateNotice(notice: UpdateNoticeState? = updateNotice.value) {
        if (notice == null) return
        viewModelScope.launch { settings.setDismissedUpdate(notice.kind, notice.availableVersion) }
    }

    private fun publishAppUpdate(info: AppUpdateInfo) {
        updateInputs.update { it.copy(app = info) }
    }

    private fun publishOmpUpdate(info: OmpUpdateInfo) {
        updateInputs.update { it.copy(omp = info) }
    }

    // ------------------------------------------------------------ update cards

    fun checkAppUpdate(force: Boolean = false) {
        if (_system.value.checkingAppUpdate) return
        _system.update { it.copy(checkingAppUpdate = true) }
        viewModelScope.launch {
            val result = runCatching { system.appUpdate(force) }
            result.getOrNull()?.let(::publishAppUpdate)
            _system.update { state ->
                state.copy(
                    checkingAppUpdate = false,
                    appUpdate = result.getOrNull() ?: state.appUpdate,
                    message = result.exceptionOrNull()?.let(::describe),
                    messageIsError = result.isFailure,
                )
            }
        }
    }

    fun checkOmpUpdate(force: Boolean = false) {
        if (_system.value.checkingOmpUpdate) return
        _system.update { it.copy(checkingOmpUpdate = true) }
        viewModelScope.launch {
            val result = runCatching { system.ompUpdateCheck(force) }
            result.getOrNull()?.let(::publishOmpUpdate)
            _system.update { state ->
                state.copy(
                    checkingOmpUpdate = false,
                    ompUpdate = result.getOrNull() ?: state.ompUpdate,
                    message = result.exceptionOrNull()?.let(::describe),
                    messageIsError = result.isFailure,
                )
            }
        }
    }

    /**
     * The web's install flow (`handleOmpUpdateNow`, `AppUpdateDialog`):
     * prepare → commit → poll `status` every [POLL_INTERVAL_MS] until the
     * attempt is terminal, then acknowledge it.
     */
    fun startUpdate(kind: UpdateKind) {
        val current = _system.value.run(kind)
        if (current.busy) return
        setRun(kind, UpdateRunState(kind = kind, phase = UpdatePhase.PREPARING))
        viewModelScope.launch {
            val result = runCatching { runUpdate(kind) }
            val outcome = result.getOrNull()
            val failure = result.exceptionOrNull()
            when {
                failure != null -> setRun(
                    kind,
                    UpdateRunState(kind = kind, phase = UpdatePhase.FAILED, error = describe(failure)),
                )
                outcome is UpdatePoll.Terminal && outcome.status.state == "failed" -> {
                    acknowledge(kind, outcome.status.attemptId)
                    setRun(
                        kind,
                        UpdateRunState(
                            kind = kind,
                            phase = UpdatePhase.FAILED,
                            targetVersion = outcome.status.targetVersion,
                            attemptId = outcome.status.attemptId,
                            error = outcome.status.error,
                        ),
                    )
                }
                outcome is UpdatePoll.Terminal -> {
                    acknowledge(kind, outcome.status.attemptId)
                    finishUpdate(kind, outcome.status)
                }
                outcome is UpdatePoll.Vanished -> {
                    // The attempt is gone: either installed and cleaned, or dropped.
                    acknowledge(kind, outcome.attemptId)
                    finishVanished(kind, outcome.targetVersion, outcome.attemptId)
                }
                else -> setRun(
                    kind,
                    UpdateRunState(kind = kind, phase = UpdatePhase.FAILED, timedOut = true),
                )
            }
        }
    }

    private suspend fun runUpdate(kind: UpdateKind): UpdatePoll {
        val prepare = when (kind) {
            UpdateKind.APP -> system.appUpdatePrepare()
            UpdateKind.OMP -> system.ompUpdatePrepare()
        }
        setRun(
            kind,
            UpdateRunState(
                kind = kind,
                phase = UpdatePhase.PREPARING,
                targetVersion = prepare.targetVersion,
                attemptId = prepare.attemptId,
            ),
        )
        when (kind) {
            UpdateKind.APP -> system.appUpdateCommit(prepare.attemptId)
            UpdateKind.OMP -> system.ompUpdateCommit(prepare.attemptId)
        }
        setRun(
            kind,
            UpdateRunState(
                kind = kind,
                phase = UpdatePhase.RESTARTING,
                targetVersion = prepare.targetVersion,
                attemptId = prepare.attemptId,
            ),
        )
        return pollStatus(kind, prepare.attemptId, prepare.targetVersion)
    }

    /**
     * Polls until terminal. A failed request is not a failure of the update:
     * the server stops and restarts itself during the install, so the poll
     * keeps going (web `AppUpdateDialog` does the same behind its 15 min cap).
     */
    private suspend fun pollStatus(
        kind: UpdateKind,
        attemptId: String,
        targetVersion: String,
    ): UpdatePoll {
        val outcome = withTimeoutOrNull(UPDATE_TIMEOUT_MS) {
            while (true) {
                delay(POLL_INTERVAL_MS)
                val response = runCatching {
                    when (kind) {
                        UpdateKind.APP -> system.appUpdateStatus()
                        UpdateKind.OMP -> system.ompUpdateStatus()
                    }
                }
                if (response.isFailure) continue
                val status = response.getOrNull()
                    ?: return@withTimeoutOrNull UpdatePoll.Vanished(attemptId, targetVersion)
                if (isTerminalUpdateState(status.state)) {
                    return@withTimeoutOrNull UpdatePoll.Terminal(status)
                }
                setRun(
                    kind,
                    UpdateRunState(
                        kind = kind,
                        phase = updatePhaseFor(status.stage),
                        targetVersion = status.targetVersion.ifBlank { targetVersion },
                        attemptId = attemptId,
                    ),
                )
            }
            @Suppress("UNREACHABLE_CODE")
            UpdatePoll.TimedOut
        }
        return outcome ?: UpdatePoll.TimedOut
    }

    /** Success bookkeeping: refresh the version, remember the completed app version. */
    private suspend fun finishUpdate(kind: UpdateKind, status: SelfUpdateStatus) {
        val target = status.targetVersion.ifBlank { _system.value.run(kind).targetVersion.orEmpty() }
        when (kind) {
            UpdateKind.APP -> {
                val refreshed = runCatching { system.appUpdate(force = true) }.getOrNull()
                refreshed?.let(::publishAppUpdate)
                settings.setCompletedAppUpdate(target.takeIf { it.isNotBlank() })
                _system.update { it.copy(appUpdate = refreshed ?: it.appUpdate) }
            }
            UpdateKind.OMP -> {
                val refreshed = runCatching { system.ompUpdateCheck(force = true) }.getOrNull()
                refreshed?.let { publishOmpUpdate(it) }
                _system.update { it.copy(ompUpdate = refreshed ?: it.ompUpdate) }
                // Web `handleOmpUpdateNow`: restart the live sessions after success.
                runCatching { system.restartSessions() }
            }
        }
        setRun(
            kind,
            UpdateRunState(
                kind = kind,
                phase = UpdatePhase.COMPLETED,
                targetVersion = target.ifBlank { null },
                attemptId = status.attemptId,
            ),
        )
    }

    /**
     * The status endpoint answered `null`: the attempt was cleaned up. Confirm
     * by re-reading the running version — that is the only honest evidence
     * that the install happened, so a vanished attempt without a version bump
     * reports a failure instead of a false success.
     */
    private suspend fun finishVanished(kind: UpdateKind, targetVersion: String?, attemptId: String) {
        val installed = when (kind) {
            UpdateKind.APP -> runCatching { system.appUpdate(force = true) }.getOrNull()
                ?.also(::publishAppUpdate)
                ?.currentVersion
            UpdateKind.OMP -> runCatching { system.ompUpdateCheck(force = true) }.getOrNull()
                ?.also { publishOmpUpdate(it) }
                ?.currentVersion
        }
        val completed = installed != null && installed == targetVersion
        if (completed) {
            if (kind == UpdateKind.APP) settings.setCompletedAppUpdate(targetVersion)
            setRun(
                kind,
                UpdateRunState(
                    kind = kind,
                    phase = UpdatePhase.COMPLETED,
                    targetVersion = targetVersion,
                    attemptId = attemptId,
                ),
            )
        } else {
            setRun(
                kind,
                UpdateRunState(
                    kind = kind,
                    phase = UpdatePhase.FAILED,
                    targetVersion = targetVersion,
                    attemptId = attemptId,
                ),
            )
        }
    }

    private suspend fun acknowledge(kind: UpdateKind, attemptId: String) {
        runCatching {
            when (kind) {
                UpdateKind.APP -> system.acknowledgeAppUpdate(attemptId)
                UpdateKind.OMP -> system.acknowledgeOmpUpdate(attemptId)
            }
        }
    }

    private fun setRun(kind: UpdateKind, run: UpdateRunState) {
        _system.update { state ->
            when (kind) {
                UpdateKind.APP -> state.copy(appUpdateRun = run)
                UpdateKind.OMP -> state.copy(ompUpdateRun = run)
            }
        }
    }

    fun openReleaseNotes() {
        _system.update { it.copy(releaseNotesOpen = true) }
        if (_system.value.releaseNotesLoaded || _system.value.releaseNotesLoading) return
        _system.update { it.copy(releaseNotesLoading = true, releaseNotesError = null) }
        viewModelScope.launch {
            val result = runCatching { system.appUpdateNotes() }
            _system.update {
                it.copy(
                    releaseNotesLoading = false,
                    releaseNotesLoaded = result.isSuccess,
                    releaseNotes = result.getOrNull() ?: it.releaseNotes,
                    releaseNotesError = result.exceptionOrNull()?.let(::describe),
                )
            }
        }
    }

    fun closeReleaseNotes() {
        _system.update { it.copy(releaseNotesOpen = false) }
    }

    fun restartSessions() {
        if (_system.value.restartingSessions) return
        _system.update { it.copy(restartingSessions = true) }
        viewModelScope.launch {
            val result = runCatching { system.restartSessions() }
            val restarted = result.getOrNull()?.sessionsRestarted
            _system.update { state ->
                state.copy(
                    restartingSessions = false,
                    message = result.exceptionOrNull()?.let(::describe)
                        ?: "Restarted $restarted session${if (restarted == 1) "" else "s"}.",
                    messageIsError = result.isFailure,
                )
            }
        }
    }

    fun setAutoResumeSessions(enabled: Boolean) {
        saveWebSettings(autoResumeSessions = enabled)
    }

    private fun saveWebSettings(
        autoResumeSessions: Boolean? = null,
    ) {
        val current = _system.value.webSettings ?: return
        if (_system.value.savingWebSettings) return
        val nextResume = autoResumeSessions ?: current.autoResumeSessions
        _system.update { it.copy(savingWebSettings = true) }
        viewModelScope.launch {
            val result = runCatching {
                system.saveWebSettings(
                    autoResumeSessions = nextResume,
                )
            }
            _system.update { state ->
                val saved = result.getOrNull()
                state.copy(
                    savingWebSettings = false,
                    webSettings = saved ?: state.webSettings,
                    message = result.exceptionOrNull()?.let(::describe),
                    messageIsError = result.isFailure,
                )
            }
        }
    }

    fun updateAgentEnvDraft(text: String) {
        _system.update {
            it.copy(
                agentEnvDraft = text,
                agentEnvDirty = true,
                agentEnvErrors = AgentEnv.parse(text).errors,
            )
        }
    }

    /** No-op while the draft has parser errors; the UI disables the button too. */
    fun saveAgentEnv() {
        val state = _system.value
        val current = state.webSettings ?: return
        if (!state.agentEnvValid || state.savingWebSettings) return
        _system.update { it.copy(savingWebSettings = true) }
        viewModelScope.launch {
            val result = runCatching {
                system.saveWebSettings(
                    autoResumeSessions = current.autoResumeSessions,
                    agentEnv = _system.value.agentEnvDraft,
                )
            }
            _system.update { state ->
                val saved = result.getOrNull()
                state.copy(
                    savingWebSettings = false,
                    webSettings = saved ?: state.webSettings,
                    agentEnvDirty = if (saved != null) false else state.agentEnvDirty,
                    agentEnvDraft = saved?.let { AgentEnv.format(it.agentEnv) } ?: state.agentEnvDraft,
                    agentEnvErrors = saved?.let { AgentEnv.sanitize(it.agentEnv).errors } ?: state.agentEnvErrors,
                    message = result.exceptionOrNull()?.let(::describe) ?: "Agent environment saved.",
                    messageIsError = result.isFailure,
                )
            }
        }
    }

    fun runWindowsAction(action: WindowsServiceAction) {
        if (_system.value.windowsActionPending) return
        _system.update { it.copy(windowsActionPending = true) }
        viewModelScope.launch {
            val result = runCatching { system.windowsAction(action) }
            _system.update { state ->
                val actionInfo = result.getOrNull()
                state.copy(
                    windowsActionPending = false,
                    windowsService = actionInfo?.status ?: state.windowsService,
                    windowsError = result.exceptionOrNull()?.let(::describe),
                    message = actionInfo?.message?.takeIf { it.isNotBlank() },
                    messageIsError = result.isFailure || actionInfo?.success == false,
                )
            }
        }
    }

    fun loadUsage(force: Boolean = false) {
        if (_usage.value.loading) return
        val current = _usage.value
        _usage.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            val result = runCatching { system.usage(current.range, current.granularity, force) }
            _usage.update { state ->
                val report = result.getOrNull() ?: state.report
                state.copy(
                    loading = false,
                    report = report,
                    selectedPointIndex = state.selectedPointIndex?.takeIf { index ->
                        index < (report?.timeSeries?.size ?: 0)
                    },
                    error = result.exceptionOrNull()?.let(::describe),
                )
            }
        }
    }

    fun setUsageRange(range: UsageTimeRange) {
        if (_usage.value.range == range) return
        _usage.update { it.copy(range = range) }
        loadUsage()
    }

    fun setUsageGranularity(granularity: UsageGranularity) {
        if (_usage.value.granularity == granularity) return
        _usage.update { it.copy(granularity = granularity) }
        loadUsage()
    }

    /** Web `metricView` toggle; the chart re-renders from the same report. */
    fun setUsageMetric(metric: UsageMetricView) {
        _usage.update { it.copy(metric = metric) }
    }

    /** Web `breakdownView` selector; independent of the fetch granularity. */
    fun setUsageBreakdown(view: UsageBreakdownView) {
        _usage.update { it.copy(breakdown = view) }
    }

    /** Tapping a bar selects it (and shows its value); tapping it again clears. */
    fun toggleUsagePoint(index: Int) {
        _usage.update { it.copy(selectedPointIndex = if (it.selectedPointIndex == index) null else index) }
    }

    /** Loads now, e.g. after a pull-to-refresh or a manual retry. */
    fun loadProviderUsage(force: Boolean = false) {
        poller.refresh(force)
    }

    /** Expands one account row; tapping it again collapses it (web `expandedKey`). */
    fun toggleProviderUsageExpanded(key: String) {
        poller.toggleExpanded(key)
    }

    /** The provider block's surface calls these from `ON_START`/`ON_STOP`. */
    fun subscribeProviderUsage() {
        poller.subscribe()
    }

    fun unsubscribeProviderUsage() {
        poller.unsubscribe()
    }

    fun clearMessage() {
        _system.update { it.copy(message = null) }
    }

    private fun describe(error: Throwable): String = error.userMessage()

    companion object {
        /** Web `handleOmpUpdateNow`: 500 ms between two status polls. */
        const val POLL_INTERVAL_MS: Long = 500L

        /** Web `AppUpdateDialog`: fifteen minutes, here the status poll's budget. */
        const val UPDATE_TIMEOUT_MS: Long = 15 * 60_000L

        fun formatAgentEnv(agentEnv: Map<String, String>): String = AgentEnv.format(agentEnv)
    }
}

/** The latest fetched update infos; separate so the banner flow stays tiny. */
private data class UpdateInputs(
    val app: AppUpdateInfo? = null,
    val omp: OmpUpdateInfo? = null,
)

/** How the status poll ended; [Vanished] is a `null` body, not a timeout. */
private sealed interface UpdatePoll {
    data class Terminal(val status: SelfUpdateStatus) : UpdatePoll

    data class Vanished(val attemptId: String, val targetVersion: String?) : UpdatePoll

    data object TimedOut : UpdatePoll
}
