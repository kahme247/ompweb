package io.github.kahme247.ompweb.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.kahme247.ompweb.AppContainer
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.chat.ChatViewModel
import io.github.kahme247.ompweb.ui.connect.ConnectScreen
import io.github.kahme247.ompweb.ui.connect.ConnectViewModel
import io.github.kahme247.ompweb.ui.hosttools.HostToolPromptHost
import io.github.kahme247.ompweb.ui.onboarding.PasswordScreen
import io.github.kahme247.ompweb.ui.notifications.NotificationBellButton
import io.github.kahme247.ompweb.ui.notifications.NotificationHistoryViewModel
import io.github.kahme247.ompweb.ui.notifications.NotificationNoticeHost
import io.github.kahme247.ompweb.ui.notifications.NotificationListPane
import io.github.kahme247.ompweb.ui.onboarding.ServerTooOldScreen
import io.github.kahme247.ompweb.ui.sessions.DirectoryPickerViewModel
import io.github.kahme247.ompweb.ui.sessions.NewSessionViewModel
import io.github.kahme247.ompweb.ui.sessions.SessionsScreen
import io.github.kahme247.ompweb.ui.sessions.SessionsViewModel
import io.github.kahme247.ompweb.ui.settings.LocalNativeSettingsDependencies
import io.github.kahme247.ompweb.ui.settings.NativeSettingsDependencies
import io.github.kahme247.ompweb.ui.settings.NativeSettingsViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsAgentsHostViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsHostViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsProvidersHostViewModel
import io.github.kahme247.ompweb.ui.settings.SettingsScreen
import io.github.kahme247.ompweb.ui.settings.SettingsViewModel
import io.github.kahme247.ompweb.ui.settings.AndroidUpdateBanner
import io.github.kahme247.ompweb.ui.settings.UpdateNoticeBanner
import io.github.kahme247.ompweb.ui.hosttools.openExternalUrl
import io.github.kahme247.ompweb.ui.settings.agents.AgentsTab
import io.github.kahme247.ompweb.ui.settings.agents.agentsSearchEntries
import io.github.kahme247.ompweb.ui.settings.models.ProvidersModelsTab
import io.github.kahme247.ompweb.ui.settings.models.providersModelsSearchEntries
import io.github.kahme247.ompweb.ui.settings.native.NativeSettingsTab
import io.github.kahme247.ompweb.ui.settings.native.nativeSettingsSearchEntries
import io.github.kahme247.ompweb.domain.FontSizePreference
import io.github.kahme247.ompweb.domain.LOCAL_SETTINGS_SEARCH_ENTRIES
import io.github.kahme247.ompweb.domain.TouchTargetsPreference
import io.github.kahme247.ompweb.domain.settingsSearchEntries
import io.github.kahme247.ompweb.domain.UiScalePreference
import io.github.kahme247.ompweb.ui.theme.OmpWebTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Pause between the first painted content and the app's own update check, so
 * the two optional checks never share the startup window with the list and the
 * first transcript.
 */
private const val STARTUP_UPDATE_STAGGER_MILLIS = 1_500L

@Composable
fun OmpWebRoot(container: AppContainer) {
    val appViewModel: AppViewModel = viewModel(factory = container.appViewModelFactory)
    val route by appViewModel.route.collectAsStateWithLifecycle()
    val settings by container.settings.snapshot.collectAsStateWithLifecycle()
    val passwordError by appViewModel.passwordError.collectAsStateWithLifecycle()
    val signingIn by appViewModel.signingIn.collectAsStateWithLifecycle()

    // Every path into Main (cold start, password, passwordless) registers the
    // notification device and starts the service when it is enabled.
    LaunchedEffect(route) {
        if (route == AppRoute.Main) container.notifications.onSignedIn()
    }

    // Until DataStore has delivered the stored theme, keep the window
    // background (the splash) instead of flashing the default dark palette.
    if (!settings.loaded) return

    OmpWebTheme(
        themeId = settings.themeId,
        fontSize = FontSizePreference.fromWire(settings.fontSize),
        uiScale = UiScalePreference.fromWire(settings.uiScale),
        touchTargets = TouchTargetsPreference.fromWire(settings.touchTargets),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            when (val current = route) {
                AppRoute.Loading -> LoadingScreen()
                is AppRoute.Connect -> {
                    val connectViewModel: ConnectViewModel = viewModel(factory = container.connectViewModelFactory)
                    ConnectScreen(
                        viewModel = connectViewModel,
                        onAccepted = appViewModel::acceptServer,
                        onTooOld = appViewModel::reportTooOld,
                        initialAddress = current.prefill,
                        initialResult = current.result,
                    )
                }
                AppRoute.Password -> PasswordScreen(
                    origin = settings.origin,
                    error = passwordError,
                    signingIn = signingIn,
                    onSubmit = appViewModel::signIn,
                    onChangeServer = appViewModel::changeServer,
                )
                is AppRoute.TooOld -> ServerTooOldScreen(
                    address = current.address,
                    serverVersion = current.serverVersion,
                    onRetry = appViewModel::retryServer,
                    onChangeServer = appViewModel::changeServer,
                )
                AppRoute.Main -> {
                    val sessionsViewModel: SessionsViewModel = viewModel(factory = container.sessionsViewModelFactory)
                    val newSessionViewModel: NewSessionViewModel =
                        viewModel(factory = container.newSessionViewModelFactory)
                    val directoryPickerViewModel: DirectoryPickerViewModel =
                        viewModel(factory = container.directoryPickerViewModelFactory)
                    val chatViewModel: ChatViewModel = viewModel(factory = container.chatViewModelFactory)
                    val notificationHistoryViewModel: NotificationHistoryViewModel =
                        container.notificationHistoryViewModel
                    val sessionsState by sessionsViewModel.state.collectAsStateWithLifecycle()
                    var notificationsOpen by rememberSaveable { mutableStateOf(false) }
                    var settingsOpen by rememberSaveable { mutableStateOf(false) }
                    var settingsCwd by rememberSaveable { mutableStateOf<String?>(null) }
                    val settingsHost: SettingsHostViewModel =
                        viewModel(factory = container.settingsHostViewModelFactory)

                    DisposableEffect(notificationHistoryViewModel) {
                        container.notifications.onDelivered = notificationHistoryViewModel::onDelivered
                        onDispose { container.notifications.onDelivered = null }
                    }

                    NotificationPermissionHost(container)
                    // `host_tool_call` frames arrive per session on the shared
                    // channel: the bridge must live above the chat screen so a
                    // consent prompt still works from the list or settings.
                    DisposableEffect(container.hostTools) {
                        container.hostTools.start()
                        onDispose { container.hostTools.stop() }
                    }
                    HostToolPromptHost(
                        controller = container.hostTools,
                        // The Files panel owns the viewer now: the tab is bound
                        // to the session that asked, so switching the chat
                        // cannot change which file is read. The path is passed
                        // through unchanged: a host tool names it relative to
                        // the workspace it ran in, and joining it with the cwd
                        // of whatever session is on screen would read the wrong
                        // directory (the server resolves it against its roots).
                        onOpenFile = { sessionId, path ->
                            container.filesViewModel.openTab(
                                path,
                                sourceSessionId = sessionId,
                                cwd = null,
                            )
                        },
                    )
                    // D1: the update banner is shell content (web
                    // `UpdateNoticeBanner` below the chrome); it hides itself
                    // for null/dismissed/completed versions.
                    val settingsViewModel: SettingsViewModel =
                        viewModel(factory = container.settingsViewModelFactory)
                    val updateNotice by settingsViewModel.updateNotice.collectAsStateWithLifecycle()
                    // The app's own update notice: GitHub Releases, cached for
                    // six hours on a cold start and revalidated on a return to
                    // the foreground once the answer is older than 30 minutes.
                    // The shell checks once content is on screen; the container
                    // owns the foreground rule. It is independent of the
                    // connected server, so it keeps its own state.
                    val androidUpdate by container.androidUpdates.state.collectAsStateWithLifecycle()
                    val context = LocalContext.current
                    // Startup burst: both update checks are optional hints, so
                    // they wait until content is on screen (the cached list
                    // makes that immediate) and then run one after the other
                    // instead of competing with the first transcript. The
                    // forced checks in Settings are untouched.
                    var startupChecksStarted by remember { mutableStateOf(false) }
                    LaunchedEffect(sessionsState.loading) {
                        if (startupChecksStarted || sessionsState.loading) return@LaunchedEffect
                        startupChecksStarted = true
                        settingsViewModel.checkForUpdateNotices()
                        delay(STARTUP_UPDATE_STAGGER_MILLIS)
                        container.androidUpdates.check()
                    }
                    // Android keeps the process alive for days, so a cold-start
                    // check alone would rarely run again: every later return to
                    // the foreground rechecks the server's update notices, the
                    // same rule the container applies to the app's own update.
                    // The observer is only installed once the staggered start
                    // check is out of the way, so the first event it sees is a
                    // real resume; the view model throttles those to one per
                    // hour (the server memoizes both answers for an hour) and a
                    // check that reached nothing retries after a short backoff.
                    // The cold start itself never waits out a window.
                    if (startupChecksStarted) {
                        DisposableEffect(settingsViewModel) {
                            val lifecycle = ProcessLifecycleOwner.get().lifecycle
                            val observer = LifecycleEventObserver { _, event ->
                                if (event == Lifecycle.Event.ON_START) {
                                    settingsViewModel.checkForUpdateNotices()
                                }
                            }
                            lifecycle.addObserver(observer)
                            onDispose { lifecycle.removeObserver(observer) }
                        }
                    }
                    // D2: the in-app notice cards (WP4 NotificationCenter) are
                    // the *last* layer above the shell. D1's banner is passed
                    // into the shell and renders inside the visible pane, below
                    // its top bar, so it never covers that bar.
                    MainShellLayers(
                        notices = {
                            NotificationNoticeHost(
                                notices = container.notifications.notices,
                                history = notificationHistoryViewModel,
                                onDismiss = container.notifications::dismissNotice,
                                onOpenSession = { sessionId ->
                                    container.offerSessionOpen(sessionId, settings.origin?.origin)
                                },
                            )
                        },
                    ) {
                    SessionsScreen(
                        appContainer = container,
                        viewModel = sessionsViewModel,
                        newSessionViewModel = newSessionViewModel,
                        directoryPickerViewModel = directoryPickerViewModel,
                        chatViewModel = chatViewModel,
                        themeId = settings.themeId,
                        onThemeSelected = appViewModel::setTheme,
                        onSignOut = appViewModel::signOut,
                        onChangeServer = appViewModel::changeServer,
                        notificationBell = {
                            NotificationBellButton(
                                vm = notificationHistoryViewModel,
                                onClick = { notificationsOpen = true },
                            )
                        },
                        onOpenSettings = { cwd ->
                            settingsCwd = cwd
                            settingsOpen = true
                        },
                        overlayOpen = notificationsOpen || settingsOpen,
                        restoreSessionId = settings.lastSessionId,
                        restoreNewSessionCwd = settings.lastNewSessionCwd,
                        // D1: the update banner is content, not an overlay: it
                        // sits below the active pane's top bar, so the bar
                        // stays visible, tappable and in the a11y tree.
                        updateBanner = {
                            Column {
                                UpdateNoticeBanner(
                                    state = updateNotice,
                                    onOpenSettings = {
                                        settingsCwd = null
                                        settingsOpen = true
                                    },
                                    // The state the reader saw is the version that
                                    // is dismissed, even if a check landed between
                                    // the render and the tap.
                                    onDismiss = { dismissed ->
                                        settingsViewModel.dismissUpdateNotice(dismissed)
                                    },
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                )
                                AndroidUpdateBanner(
                                    notice = androidUpdate.notice,
                                    install = androidUpdate.install,
                                    onInstall = { container.androidUpdates.install() },
                                    onOpenInstallSettings = {
                                        container.androidUpdates.openInstallPermissionSettings()
                                    },
                                    onConfirmInstall = { container.androidUpdates.confirmInstall() },
                                    onCancelInstall = { container.androidUpdates.cancelInstall() },
                                    onOpenRelease = { notice ->
                                        notice.releaseUrl?.let { url ->
                                            openExternalUrl(context, url)
                                        }
                                    },
                                    onDismiss = { notice ->
                                        container.androidUpdates.dismiss(notice.availableVersion)
                                    },
                                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                                )
                            }
                        },
                    )
                    }
                    if (notificationsOpen) {
                        NotificationPanelOverlay(
                            historyViewModel = notificationHistoryViewModel,
                            onOpenSession = { sessionId ->
                                notificationsOpen = false
                                container.offerSessionOpen(sessionId, settings.origin?.origin)
                            },
                            onClose = { notificationsOpen = false },
                        )
                    }
                    if (settingsOpen) {
                        // Created on first open, retained across rotation in the
                        // settings store, dropped on close/sign-out (no API keys
                        // left in the heap).
                        val providersModelsHost: SettingsProvidersHostViewModel = viewModel(
                            viewModelStoreOwner = settingsHost.owner,
                            factory = container.settingsProvidersHostFactory,
                        )
                        val agentsHost: SettingsAgentsHostViewModel = viewModel(
                            viewModelStoreOwner = settingsHost.owner,
                            factory = container.settingsAgentsHostFactory,
                        )
                        val nativeSettingsViewModel: NativeSettingsViewModel = viewModel(
                            viewModelStoreOwner = settingsHost.owner,
                            factory = container.nativeSettingsViewModelFactory,
                        )
                        val closeSettings = {
                            settingsOpen = false
                            settingsHost.clear()
                        }
                        OmpDialog(
                            onDismissRequest = closeSettings,
                            properties = DialogProperties(usePlatformDefaultWidth = false),
                        ) {
                            CompositionLocalProvider(
                                LocalNativeSettingsDependencies provides NativeSettingsDependencies(
                                    viewModel = nativeSettingsViewModel,
                                    sessionId = sessionsState.selectedSessionId,
                                ),
                            ) {
                                SettingsScreen(
                                    container = container,
                                    cwd = settingsCwd,
                                    viewModelStoreOwner = settingsHost.owner,
                                    searchEntries = settingsSearchEntries(
                                        LOCAL_SETTINGS_SEARCH_ENTRIES,
                                        nativeSettingsSearchEntries(),
                                        providersModelsSearchEntries(),
                                        agentsSearchEntries(),
                                    ),
                                    onClose = closeSettings,
                                    onSignOut = appViewModel::signOut,
                                    onChangeServer = appViewModel::changeServer,
                                    onThemeSelected = appViewModel::setTheme,
                                    nativeContent = { category, cwdForTab, highlight ->
                                        NativeSettingsTab(category, cwdForTab, highlight)
                                    },
                                    providersContent = { highlight ->
                                        ProvidersModelsTab(providersModelsHost.viewModel, highlight)
                                    },
                                    agentsContent = { cwdForTab, highlight ->
                                        AgentsTab(agentsHost.viewModel, cwdForTab, highlight)
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Full-screen notification history above the session shell. The dialog
 * window keeps touches away from the list below; Settings is its own surface.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NotificationPanelOverlay(
    historyViewModel: NotificationHistoryViewModel,
    onOpenSession: (String) -> Unit,
    onClose: () -> Unit,
) {
    OmpDialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = {},
                        navigationIcon = {
                            IconButton(onClick = onClose) {
                                Icon(
                                    Icons.AutoMirrored.Filled.ArrowBack,
                                    contentDescription = stringResource(R.string.nav_back),
                                )
                            }
                        },
                    )
                },
            ) { innerPadding ->
                NotificationListPane(
                    vm = historyViewModel,
                    onOpenSession = onOpenSession,
                    modifier = Modifier.padding(innerPadding),
                )
            }
        }
    }
}

/**
 * The only place that may request POST_NOTIFICATIONS: a launcher needs the
 * activity, so the settings screen emits `NotificationCenter.permissionRequests`
 * and this host performs it. The first sign-in shows a short explanation once;
 * after that the settings row reports the state and deep-links to the system.
 */
@Composable
private fun NotificationPermissionHost(container: AppContainer) {
    val snapshot by container.settings.snapshot.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        container.notifications.refreshService()
    }
    LaunchedEffect(container) {
        container.notifications.permissionRequests.collect {
            if (container.notifications.permissionStatus().canRequestPostNotifications) {
                launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                container.notifications.openSystemNotificationSettings()
            }
        }
    }

    var showOnboarding by remember { mutableStateOf(false) }
    LaunchedEffect(snapshot.loaded, snapshot.notifyPermissionPrompted) {
        if (
            snapshot.loaded &&
            !snapshot.notifyPermissionPrompted &&
            container.notifications.permissionStatus().canRequestPostNotifications
        ) {
            showOnboarding = true
        }
    }
    if (!showOnboarding) return

    fun finish(allow: Boolean) {
        showOnboarding = false
        scope.launch { container.settings.setNotifyPermissionPrompted(true) }
        if (allow) launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    OmpAlertDialog(
        onDismissRequest = { finish(false) },
        title = { Text(stringResource(R.string.notify_onboarding_title)) },
        text = { Text(stringResource(R.string.notify_onboarding_text)) },
        confirmButton = {
            TextButton(onClick = { finish(true) }) {
                Text(stringResource(R.string.notify_onboarding_allow))
            }
        },
        dismissButton = {
            TextButton(onClick = { finish(false) }) {
                Text(stringResource(R.string.notify_onboarding_later))
            }
        },
    )
}

@Composable
private fun LoadingScreen() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

/**
 * The signed-in shell's draw order: the session shell (list, chat, files
 * panel) first, the in-app notice cards last, on top of it.
 *
 * Compose paints siblings in declaration order and hit-tests them in reverse,
 * so a notice host composed *before* the opaque shell panes is both invisible
 * and untappable (B1/A12). Keeping the order in one composable also makes it
 * testable: the tests render this seam and click through the top layer.
 */
@Composable
internal fun MainShellLayers(
    notices: @Composable () -> Unit,
    shell: @Composable BoxScope.() -> Unit,
) {
    Box(modifier = Modifier.fillMaxSize()) {
        shell()
        notices()
    }
}
