package io.github.kahme247.ompweb.ui.sessions

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Search
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.Button
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.layout.AnimatedPane
import androidx.compose.material3.adaptive.layout.PaneAdaptedValue
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffold
import androidx.compose.material3.adaptive.layout.ListDetailPaneScaffoldRole
import androidx.compose.material3.adaptive.navigation.rememberListDetailPaneScaffoldNavigator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.data.ChatDraft
import io.github.kahme247.ompweb.domain.TextAttachmentBudget
import io.github.kahme247.ompweb.domain.mergeImageAttachments
import io.github.kahme247.ompweb.domain.selectTextAttachments
import io.github.kahme247.ompweb.domain.ProjectActivity
import io.github.kahme247.ompweb.domain.ColdStartRestoreStep
import io.github.kahme247.ompweb.domain.coldStartRestoreStep
import io.github.kahme247.ompweb.domain.comparableProjectPath
import io.github.kahme247.ompweb.domain.explorerWorkspace
import io.github.kahme247.ompweb.domain.groupSessionsByProject
import io.github.kahme247.ompweb.domain.projectActivityCounts
import io.github.kahme247.ompweb.domain.sessionWorktreeRemoved
import io.github.kahme247.ompweb.domain.sessionsShowsRefreshError
import io.github.kahme247.ompweb.domain.sessionsShowsUpdating
import io.github.kahme247.ompweb.domain.visibleChatSession
import io.github.kahme247.ompweb.domain.visibleSessionEntries
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.net.ExportedSession
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.SessionSearchHit
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.ui.settings.SettingsViewModel
import io.github.kahme247.ompweb.ui.settings.ThemePickerDialog
import io.github.kahme247.ompweb.ui.chat.ChatViewModel
import io.github.kahme247.ompweb.ui.composer.ComposerAttachments
import io.github.kahme247.ompweb.ui.files.FilePanel
import io.github.kahme247.ompweb.ui.notifications.NotificationListPane
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class PickerPurpose { AddProject, NewSession }

/**
 * Workspace home: projects with their session trees, the open session header,
 * the new-session composer and every project/session dialog.
 *
 * A phone shows the list and navigates to the detail pane; from foldable width
 * upwards both panes stay visible (`ListDetailPaneScaffold`).
 */
@OptIn(
    ExperimentalMaterial3Api::class,
    ExperimentalMaterial3AdaptiveApi::class,
)
@Composable
fun SessionsScreen(
    appContainer: io.github.kahme247.ompweb.AppContainer,
    viewModel: SessionsViewModel,
    newSessionViewModel: NewSessionViewModel,
    directoryPickerViewModel: DirectoryPickerViewModel,
    chatViewModel: ChatViewModel,
    themeId: String,
    onThemeSelected: (String) -> Unit,
    onSignOut: () -> Unit,
    onChangeServer: () -> Unit,
    notificationBell: @Composable () -> Unit = {},
    /** Opens Settings at the current workspace (null when none is selected). */
    onOpenSettings: (String?) -> Unit = {},
    /** An overlay (notification list/settings) hides the chat behind it. */
    overlayOpen: Boolean = false,
    restoreSessionId: String? = null,
    restoreNewSessionCwd: String? = null,
    /**
     * The shell's update announcement (web: a toast below the chrome). It is
     * rendered *inside* the visible pane's content, below that pane's top bar:
     * as a floating overlay it covered every top-bar action.
     */
    updateBanner: @Composable () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val history by viewModel.history.collectAsStateWithLifecycle()
    val draftState by appContainer.draftStore.state.collectAsStateWithLifecycle()
    val pendingShare by appContainer.pendingShare.collectAsStateWithLifecycle()
    val pendingSessionOpen by appContainer.pendingSessionOpen.collectAsStateWithLifecycle()
    val navigator = rememberListDetailPaneScaffoldNavigator<Unit>()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val compact = navigator.scaffoldDirective.maxHorizontalPartitions <= 1

    // The session list's provider warning (web `SessionSidebar`): process-scoped
    // so the five-minute refresh survives rotation. The settings surface keeps
    // its own instance, cleared on close, but both share the process poller.
    val usageViewModel: SettingsViewModel = viewModel(factory = appContainer.settingsViewModelFactory)

    // Phase 9: the Files panel is process-scoped (tabs survive rotation) and
    // lives beside the scaffold on wide screens, as a sheet on phones.
    val filesViewModel = appContainer.filesViewModel
    val gitChangesViewModel = appContainer.gitChangesViewModel
    val worktreesViewModel = appContainer.worktreesViewModel
    val filesState by filesViewModel.state.collectAsStateWithLifecycle()
    // GitHub issue links inside previewed markdown resolve against the repo of
    // the open session's checkout.
    val chatUi by chatViewModel.ui.collectAsStateWithLifecycle()
    /** The composer's model, shown in the palette's information line (A7). */
    val chatControls by chatViewModel.controls.state.collectAsStateWithLifecycle()
    /** Configured server's version for the new-session intro (A17). */
    val serverVersion by appContainer.serverVersion.collectAsStateWithLifecycle()
    val pendingCwdOpen by appContainer.pendingCwdOpen.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { appContainer.refreshServerInfo() }

    val worktreesState by worktreesViewModel.state.collectAsStateWithLifecycle()
    /** The open session's folder and its repo, from the detail or the list summary. */
    val sessionCwd = state.selectedSessionId?.let { id ->
        state.detail?.info?.cwd ?: state.sessions.firstOrNull { it.id == id }?.cwd
    }?.takeIf { it.isNotBlank() }
    val sessionProjectRoot = state.selectedSessionId?.let { id ->
        state.detail?.info?.projectRoot ?: state.sessions.firstOrNull { it.id == id }?.projectRoot
    }
    // The workspace the explorer shows: the open session's checkout (unless its
    // worktree was removed), then the sidebar, then the new session.
    val explorerCwd = remember(
        sessionCwd,
        sessionProjectRoot,
        state.activeCwd,
        state.newSessionCwd,
        worktreesState.projectRoot,
        worktreesState.worktrees,
    ) {
        explorerWorkspace(
            sessionCwd = sessionCwd,
            sessionWorktreeRemoved = sessionWorktreeRemoved(
                sessionCwd = sessionCwd,
                sessionProjectRoot = sessionProjectRoot,
                repoProjectRoot = worktreesState.projectRoot,
                worktrees = worktreesState.worktrees,
            ),
            sidebarCwd = state.activeCwd,
            newSessionCwd = state.newSessionCwd,
        )
    }
    LaunchedEffect(explorerCwd) { filesViewModel.setCwd(explorerCwd) }
    LaunchedEffect(explorerCwd) { worktreesViewModel.load(explorerCwd) }
    // A worktree switch/create/remove-current moves the sidebar's effective
    // cwd (and the next new session), never the cwd of the open session.
    LaunchedEffect(worktreesViewModel) {
        worktreesViewModel.switched.collect { path -> viewModel.setEffectiveCwd(path) }
    }

    // Presence: the server suppresses OS notifications only while this exact
    // chat is on screen in a foreground app. The detail pane must be the
    // visible one — a compact back tap keeps the selection but shows the list —
    // and an open overlay (including the phone Files sheet) covers the chat.
    val detailVisible = navigator.scaffoldValue[ListDetailPaneScaffoldRole.Detail] != PaneAdaptedValue.Hidden
    // One update banner instance, in the pane the reader is looking at: on the
    // tablet both panes are composed, and a second copy would duplicate the
    // live region and its buttons. On a short window (320 × 568 dp at font
    // scale 2.0, or landscape) the banner costs the chat more height than it is
    // worth — measured: it took 120 dp and left the composer's Send row
    // clipped — so there the list keeps it and the chat shows none.
    val windowTallEnoughForChatBanner =
        LocalConfiguration.current.screenHeightDp >= MIN_HEIGHT_FOR_CHAT_BANNER
    val detailShowsBanner = detailVisible &&
        windowTallEnoughForChatBanner &&
        (state.selectedSessionId != null || state.newSessionCwd != null)
    val noBanner: @Composable () -> Unit = {}
    val listBanner: @Composable () -> Unit = if (detailShowsBanner) noBanner else updateBanner
    val detailBanner: @Composable () -> Unit = if (detailShowsBanner) updateBanner else noBanner
    val filesSheetOpen = compact && filesState.panelOpen
    val chatCovered = overlayOpen || filesSheetOpen
    LaunchedEffect(state.selectedSessionId, detailVisible, chatCovered) {
        appContainer.notifications.setVisibleSession(
            visibleChatSession(state.selectedSessionId, detailVisible, chatCovered),
        )
    }
    DisposableEffect(Unit) {
        onDispose { appContainer.notifications.setVisibleSession(null) }
    }

    var quickSwitcherOpen by remember { mutableStateOf(false) }
    // A dead session drops the selection (A10); on a phone the detail pane is
    // still on screen, so the shell goes back to the list instead of showing
    // the empty detail. The user's own back tap keeps the selection, so this
    // only fires for a selection that vanished from under the pane.
    LaunchedEffect(state.selectedSessionId, state.newSessionCwd) {
        val detailShown = navigator.scaffoldValue[ListDetailPaneScaffoldRole.Detail] != PaneAdaptedValue.Hidden
        if (state.selectedSessionId == null && state.newSessionCwd == null && detailShown) {
            if (navigator.canNavigateBack()) navigator.navigateBack()
        }
    }
    var themeSwitcherOpen by remember { mutableStateOf(false) }
    var pickerPurpose by remember { mutableStateOf<PickerPurpose?>(null) }
    var renameSessionTarget by remember { mutableStateOf<SessionSummary?>(null) }
    var deleteSessionTarget by remember { mutableStateOf<SessionSummary?>(null) }
    var renameProjectTarget by remember { mutableStateOf<ManagedProject?>(null) }
    var launchConfigTarget by remember { mutableStateOf<ManagedProject?>(null) }
    var hideProjectTarget by remember { mutableStateOf<ManagedProject?>(null) }
    var pendingExport by remember { mutableStateOf<ExportedSession?>(null) }
    var shareUris by remember { mutableStateOf<List<android.net.Uri>?>(null) }
    var exitDraftPrompt by remember { mutableStateOf(false) }
    val snackbarHostState = remember { SnackbarHostState() }
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    val exportLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/html"),
    ) { uri ->
        val exported = pendingExport
        pendingExport = null
        if (uri != null && exported != null) {
            scope.launch {
                val saved = SessionExport.writeToUri(context, uri, exported.body)
                Toast.makeText(
                    context,
                    if (saved) R.string.toast_export_saved else R.string.toast_export_failed,
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    val importLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val text = SessionExport.readText(context, uri, MAX_IMPORT_BYTES)
            if (text == null) {
                Toast.makeText(context, R.string.toast_import_failed, Toast.LENGTH_SHORT).show()
            } else {
                val name = SessionExport.displayName(context, uri, "imported.jsonl")
                viewModel.importSession(name, text)
            }
        }
    }

    // The view model outlives this screen; tie its work to the screen being visible.
    DisposableEffect(viewModel) {
        viewModel.setActive(true)
        onDispose { viewModel.setActive(false) }
    }
    LaunchedEffect(Unit) { focusRequester.requestFocus() }
    LaunchedEffect(navigator) {
        if (navigator.currentDestination == null) {
            navigator.navigateTo(ListDetailPaneScaffoldRole.List)
        }
    }
    LaunchedEffect(state.notice?.id) {
        val notice = state.notice ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(notice.text)
        viewModel.dismissNotice()
    }

    // Resolved during composition: reading resources from the context inside
    // a coroutine can return a stale configuration.
    val transcriptFailedText = stringResource(R.string.toast_transcript_failed)
    val transcriptTruncatedText = stringResource(R.string.toast_transcript_truncated, MAX_CLIPBOARD_CHARS)
    val transcriptCopiedText = stringResource(R.string.toast_transcript_copied)
    val copyFailedText = stringResource(R.string.toast_copy_failed)
    val idCopiedText = stringResource(R.string.toast_id_copied)

    LaunchedEffect(pendingShare) {
        if (pendingShare.isNotEmpty()) shareUris = pendingShare
    }

    fun openDetail() {
        if (compact) scope.launch { navigator.navigateTo(ListDetailPaneScaffoldRole.Detail) }
    }

    fun openFiles() {
        openDetail()
        filesViewModel.showPanel()
    }

    /** An `@`-mention from the panel goes to whichever composer is on screen. */
    fun insertMention(text: String) {
        if (state.selectedSessionId != null) {
            chatViewModel.composer.insertAtCaret(text)
        } else {
            newSessionViewModel.composer.insertAtCaret(text)
        }
    }

    fun openFileTab(path: String, line: Int?) {
        filesViewModel.openTab(
            path = path,
            line = line,
            sourceSessionId = state.selectedSessionId,
            cwd = explorerCwd,
        )
    }

    fun openSession(id: String) {
        viewModel.selectSession(id)
        openDetail()
    }

    // A notification tap (or the notification history list) asked for one
    // session; navigate once the shell exists, also after a password screen.
    LaunchedEffect(pendingSessionOpen) {
        if (pendingSessionOpen == null) return@LaunchedEffect
        // Null when the request belongs to another installation's origin.
        val sessionId = appContainer.consumeSessionOpen() ?: return@LaunchedEffect
        openSession(sessionId)
    }

    fun openNewSession(cwd: String? = null) {
        viewModel.startNewSession(cwd)
        openDetail()
    }

    // A workspace link (`ompweb://cwd?path=…`) keeps the selected session in
    // the list while the compose pane is gone; a back tap returns to it. The
    // consume call returns null for another installation's origin.
    LaunchedEffect(pendingCwdOpen) {
        if (pendingCwdOpen == null) return@LaunchedEffect
        val cwd = appContainer.consumeCwdOpen() ?: return@LaunchedEffect
        openNewSession(cwd)
    }

    /** Send shared content into an existing draft, enforcing the same budgets. */
    fun acceptShare(sessionId: String?, cwd: String?) {
        val uris = shareUris ?: return
        shareUris = null
        appContainer.consumeShare()
        val targetCwd = cwd ?: state.activeCwd ?: state.home
        val key = sessionId ?: targetCwd?.let { "new:$it" }
        if (key == null) {
            Toast.makeText(context, R.string.composer_share_failed, Toast.LENGTH_SHORT).show()
            return
        }
        scope.launch {
            val batch = withContext(Dispatchers.IO) { ComposerAttachments.readShare(context, uris) }
            if (batch.images.isEmpty() && batch.files.isEmpty()) {
                Toast.makeText(context, R.string.composer_share_failed, Toast.LENGTH_SHORT).show()
                return@launch
            }
            val existing = appContainer.draftStore.getDraft(key) ?: ChatDraft()
            val images = mergeImageAttachments(existing.images, batch.images)
            val fileSelection = selectTextAttachments(
                batch.files,
                { it.size },
                TextAttachmentBudget(
                    usedBytes = existing.files.sumOf { it.size },
                    usedSlots = existing.files.size,
                ),
            )
            appContainer.draftStore.setDraft(
                key,
                existing.copy(images = images, files = existing.files + fileSelection.accepted),
            )
            // A mounted pane keeps its own state; reload it explicitly instead
            // of relying on the open/prepare early returns.
            if (chatViewModel.composer.currentDraftKey == key) {
                chatViewModel.composer.applyStoredDraft()
            }
            if (newSessionViewModel.composer.currentDraftKey == key) {
                newSessionViewModel.composer.applyStoredDraft()
            }
            if (sessionId != null) openSession(sessionId) else openNewSession(targetCwd)
        }
    }

    fun backToList() {
        scope.launch {
            if (compact && navigator.canNavigateBack()) navigator.navigateBack() else viewModel.closeDetail()
        }
    }

    fun goHistory(direction: Int) {
        val moved = if (direction < 0) viewModel.navigateBack() else viewModel.navigateForward()
        if (moved) openDetail()
    }

    // Process death starts a new process but keeps the last opened session in
    // settings; reopen it once per process. The decision lives in
    // `coldStartRestoreStep`: an effect that runs before `GET /api/sessions`
    // answered must not burn the one attempt, and a re-run after the restore
    // (rotation) must not open a second pane.
    LaunchedEffect(
        state.loading,
        state.error,
        state.sessions,
        state.selectedSessionId,
        state.newSessionCwd,
        restoreSessionId,
        restoreNewSessionCwd,
    ) {
        val step = coldStartRestoreStep(
            pending = ColdStartSessionRestore.pending,
            // `loading` is false before the first load starts and after a
            // failed one; only a successful answer resolves the target.
            listLoaded = !state.loading && state.error == null,
            sessionIds = state.sessions.map { it.id },
            selectedSessionId = state.selectedSessionId,
            newSessionCwd = state.newSessionCwd,
            lastSessionId = restoreSessionId,
            lastNewSessionCwd = restoreNewSessionCwd,
        )
        if (step.consumes) ColdStartSessionRestore.pending = false
        when (step) {
            ColdStartRestoreStep.Wait, ColdStartRestoreStep.Done -> Unit
            is ColdStartRestoreStep.OpenSession -> openSession(step.id)
            // Last view was the new-session pane: validate its workspace
            // before reopening it (a deleted directory must not block the
            // list).
            is ColdStartRestoreStep.OpenNewSession -> viewModel.restoreNewSession(step.cwd)
            is ColdStartRestoreStep.ForgetSession -> viewModel.forgetLastSessionIfCurrent(step.id)
        }
    }

    fun requestExport(session: SessionSummary) {
        scope.launch {
            val exported = viewModel.exportHtml(session.id) ?: return@launch
            pendingExport = exported
            exportLauncher.launch(exported.fileName)
        }
    }

    fun shareSession(session: SessionSummary) {
        scope.launch {
            val exported = viewModel.exportHtml(session.id) ?: return@launch
            val shared = SessionExport.share(context, exported.fileName, exported.body)
            if (!shared) {
                Toast.makeText(context, R.string.toast_export_failed, Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun copyTranscript(session: SessionSummary) {
        scope.launch {
            val markdown = viewModel.transcriptMarkdown(session.id)
            if (markdown == null) {
                Toast.makeText(context, transcriptFailedText, Toast.LENGTH_SHORT).show()
                return@launch
            }
            // A Binder transaction cannot carry arbitrarily long text; the
            // clipboard binding would throw and the copy would silently fail.
            val capped = markdown.take(MAX_CLIPBOARD_CHARS)
            val copied = SessionExport.copyToClipboard(context, "transcript", capped, sensitive = true)
            val text = when {
                !copied -> transcriptFailedText
                capped.length < markdown.length -> transcriptTruncatedText
                else -> transcriptCopiedText
            }
            Toast.makeText(context, text, Toast.LENGTH_SHORT).show()
        }
    }

    fun copyId(id: String) {
        val copied = SessionExport.copyId(context, id)
        Toast.makeText(context, if (copied) idCopiedText else copyFailedText, Toast.LENGTH_SHORT).show()
    }

    val canNavigateBack = compact && navigator.canNavigateBack()
    val hasUnsentDrafts = draftState.any { !it.value.isEmpty() }
    BackHandler(
        enabled = quickSwitcherOpen || state.archive.open || filesState.panelOpen || canNavigateBack ||
            history.canBack || state.selectedSessionId != null || state.newSessionCwd != null ||
            hasUnsentDrafts,
    ) {
        when {
            quickSwitcherOpen -> quickSwitcherOpen = false
            state.archive.open -> viewModel.closeArchive()
            // Viewer tab → panel → (then) the chat/list below.
            filesState.panelOpen -> filesViewModel.back()
            canNavigateBack -> scope.launch { navigator.navigateBack() }
            viewModel.navigateBack() -> openDetail()
            state.selectedSessionId != null || state.newSessionCwd != null -> viewModel.closeDetail()
            hasUnsentDrafts -> exitDraftPrompt = true
            else -> viewModel.closeDetail()
        }
    }

    var rootFocus by remember { mutableStateOf<androidx.compose.ui.focus.FocusState?>(null) }
    // The composer may take focus after the root did (new session, "focus
    // composer" after a send). When the chat opens and nothing else owns the
    // focus, the root must own it again so Esc can abort.
    LaunchedEffect(state.selectedSessionId) {
        if (state.selectedSessionId != null && rootFocus?.hasFocus != true) focusRequester.requestFocus()
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .focusRequester(focusRequester)
            .focusable()
            .onFocusChanged { rootFocus = it }
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val key = event.key.toShellKeyName() ?: return@onPreviewKeyEvent false
                val composerState = chatViewModel.composer.state.value
                val context = ShortcutContext(
                    detailVisible = detailVisible,
                    chatCovered = chatCovered,
                    // Compose has no query for the focused semantics node; a
                    // focused descendant of the shell is treated as a text
                    // field (the web rule: never abort from INPUT/TEXTAREA).
                    textFieldFocused = rootFocus?.let { it.hasFocus && !it.isFocused } ?: false,
                    busy = chatViewModel.ui.value.busy,
                    paletteOpen = composerState.slash != null ||
                        composerState.at != null ||
                        composerState.history != null,
                    dialogOpen = quickSwitcherOpen || themeSwitcherOpen || pickerPurpose != null ||
                        renameSessionTarget != null || deleteSessionTarget != null ||
                        renameProjectTarget != null || launchConfigTarget != null ||
                        hideProjectTarget != null || state.archive.open || exitDraftPrompt ||
                        shareUris != null,
                )
                handleSessionShortcut(
                    event = ShellKeyEvent(
                        key = key,
                        ctrl = event.isCtrlPressed,
                        meta = event.isMetaPressed,
                        alt = event.isAltPressed,
                        shift = event.isShiftPressed,
                    ),
                    context = context,
                    actions = ShortcutActions(
                        quickSwitcher = { quickSwitcherOpen = !quickSwitcherOpen },
                        // Same path as the drawer's New button: without an
                        // active workspace the view model creates the session
                        // in `home` and the detail pane opens a draft.
                        newSession = { openNewSession() },
                        abort = { chatViewModel.stop() },
                        cycleModel = { chatViewModel.cycleModel() },
                        cycleThinking = { chatViewModel.cycleThinkingLevel() },
                        dictation = { chatViewModel.toggleDictation() },
                        historyBack = { goHistory(-1) },
                        historyForward = { goHistory(1) },
                    ),
                )
            },
    ) {
        // Phase 9's third column: ListDetailPaneScaffold only knows list+detail,
        // so the Files panel sits beside it (phones get a full-screen sheet).
        Row(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.weight(1f)) {
                ListDetailPaneScaffold(
                    directive = navigator.scaffoldDirective,
                    value = navigator.scaffoldValue,
                    listPane = {
                AnimatedPane {
                    SessionListPane(
                        state = state,
                        historyCanBack = history.canBack,
                        historyCanForward = history.canForward,
                        themeId = themeId,
                        onRefresh = viewModel::refresh,
                        onRetryConnection = viewModel::retryConnection,
                        onThemeSelected = onThemeSelected,
                        onSignOut = onSignOut,
                        onChangeServer = onChangeServer,
                        notificationBell = notificationBell,
                        onOpenSettings = { onOpenSettings(state.activeCwd) },
                        usageWarning = {
                            ProviderUsageWarningRow(
                                viewModel = usageViewModel,
                                // Settings shows the full provider block right
                                // below its categories, on phones and tablets.
                                onClick = { onOpenSettings(state.activeCwd) },
                            )
                        },
                        onBack = { goHistory(-1) },
                        onForward = { goHistory(1) },
                        onQuickSwitcher = { quickSwitcherOpen = true },
                        onSearchToggle = { viewModel.setSearchOpen(!state.searchOpen) },
                        onSearchQueryChange = viewModel::setSearchQuery,
                        onSearchClose = { viewModel.setSearchOpen(false) },
                        onSearchModeChange = viewModel::setSearchMode,
                        onOpenMessageHit = { hit ->
                            // The detail pane replaces the list; a focused
                            // search field would otherwise keep the keyboard
                            // over the transcript.
                            focusManager.clearFocus()
                            openSession(hit.sessionId)
                            chatViewModel.scrollToEntry(hit.sessionId, hit.entryId)
                        },
                        onLoadMoreMessageResults = viewModel::loadMoreMessageResults,
                        onRetryMessageSearch = viewModel::retryMessageSearch,
                        onRunningOnlyToggle = { viewModel.setRunningOnly(!state.runningOnly) },
                        onNewSession = { openNewSession() },
                        onAddProject = { pickerPurpose = PickerPurpose.AddProject },
                        onOpenFiles = { openFiles() },
                        onImport = { importLauncher.launch(arrayOf("*/*")) },
                        onOpenArchive = viewModel::openArchive,
                        onOpenSession = { id -> openSession(id) },
                        onTogglePin = viewModel::togglePin,
                        onToggleProject = viewModel::toggleProject,
                        onActivateProject = viewModel::activateProject,
                        onNewSessionInProject = { path ->
                            viewModel.newSessionInProject(path)
                            openDetail()
                        },
                        onRenameProject = { renameProjectTarget = it },
                        onLaunchConfig = { launchConfigTarget = it },
                        onHideProject = { hideProjectTarget = it },
                        onMoveProject = viewModel::moveProjectBy,
                        onMoveProjectTo = viewModel::moveProjectTo,
                        onRenameSession = { renameSessionTarget = it },
                        onArchiveSession = viewModel::archiveSession,
                        onAutoNameSession = viewModel::autoNameSession,
                        onCopyTranscript = { copyTranscript(it) },
                        onExportSession = { requestExport(it) },
                        onDeleteSession = { deleteSessionTarget = it },
                        onCopyId = { copyId(it) },
                        updateBanner = listBanner,
                    )
                }
            },
            detailPane = {
                AnimatedPane {
                    val selectedId = state.selectedSessionId
                    val summary = selectedId?.let { id ->
                        state.sessions.firstOrNull { it.id == id }
                            ?: SessionSummary(
                                id = id,
                                cwd = state.detail?.info?.cwd.orEmpty(),
                                name = state.detail?.info?.name,
                                messageCount = state.detail?.info?.messageCount ?: 0,
                            )
                    }
                    when {
                        selectedId != null -> SessionDetailPane(
                            state = state,
                            summary = summary,
                            compact = compact,
                            onBack = { backToList() },
                            onSelectParent = { parentId -> openSession(parentId) },
                            onRetry = viewModel::reloadDetail,
                            onRename = { summary?.let { renameSessionTarget = it } },
                            onAutoName = { summary?.let { viewModel.autoNameSession(it.id) } },
                            onArchive = { summary?.let { viewModel.archiveSession(it.id) } },
                            onDelete = { summary?.let { deleteSessionTarget = it } },
                            onCopyTranscript = { summary?.let { copyTranscript(it) } },
                            onExport = { summary?.let { requestExport(it) } },
                            onShare = { summary?.let { shareSession(it) } },
                            onCopyId = { copyId(selectedId) },
                            chatViewModel = chatViewModel,
                            onForkedSession = { newId -> openSession(newId) },
                            // Chat failures surface in the shell's snackbar
                            // host: a system Toast is gone before the reader
                            // notices it, which made a rejected fork look like
                            // a dead button.
                            onChatError = { message -> scope.launch { snackbarHostState.showSnackbar(message) } },
                            onOpenFiles = { openFiles() },
                            onOpenFile = { path, line -> openFileTab(path, line) },
                            updateBanner = detailBanner,
                        )

                        state.newSessionCwd != null -> NewSessionPane(
                            viewModel = newSessionViewModel,
                            cwd = state.newSessionCwd,
                            projects = state.projects,
                            home = state.home,
                            compact = compact,
                            appVersion = appContainer.appVersion,
                            serverVersion = serverVersion,
                            onBack = { backToList() },
                            onBrowse = { pickerPurpose = PickerPurpose.NewSession },
                            onCreated = { created ->
                                // `/btw` in a new chat: the session exists, the
                                // question is asked by the chat once it opens.
                                created.sideQuestion?.let { raw ->
                                    chatViewModel.askSideQuestionInNewChat(created.id, raw)
                                }
                                viewModel.openCreatedSession(created.id, created.cwd)
                            },
                            updateBanner = detailBanner,
                        )

                        else -> SessionDetailEmpty()
                    }
                }
            },
        )

            // The shell root owns the snackbar: in the compact layout the list
            // pane (whose Scaffold used to host it) is not composed while a
            // chat is open, so chat notices such as a refused `/plan` never
            // reached the screen. Inside the left box: the Files column must
            // not cover it.
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .imePadding(),
            )
            }

            if (!compact && filesState.panelOpen) {
                Box(
                    modifier = Modifier
                        .width(FILES_PANEL_WIDTH)
                        .fillMaxHeight()
                        .background(LocalOmpColors.current.border),
                ) {
                    FilePanel(
                        vm = filesViewModel,
                        gitChanges = gitChangesViewModel,
                        worktrees = worktreesViewModel,
                        onMention = { text -> insertMention(text) },
                        onClose = { filesViewModel.closePanel() },
                        githubRepo = chatUi.githubRepo,
                        modifier = Modifier.padding(start = 1.dp),
                    )
                }
            }
        }

        if (filesSheetOpen) {
            // Phone layout: the panel is a full-screen sheet above the shell,
            // with the notification history as its fourth fixed tab (the wide
            // layout keeps the bell dialog). A back press inside the sheet
            // window never reaches the screen's BackHandler, so the dialog
            // forwards it to the same step chain: viewer → explorer → closed.
            OmpDialog(
                onDismissRequest = { filesViewModel.back() },
                properties = DialogProperties(usePlatformDefaultWidth = false),
            ) {
                Surface(color = LocalOmpColors.current.background, modifier = Modifier.fillMaxSize()) {
                    FilePanel(
                        vm = filesViewModel,
                        gitChanges = gitChangesViewModel,
                        worktrees = worktreesViewModel,
                        onMention = { text -> insertMention(text) },
                        onClose = { filesViewModel.closePanel() },
                        githubRepo = chatUi.githubRepo,
                        notifications = {
                            NotificationListPane(
                                vm = appContainer.notificationHistoryViewModel,
                                onOpenSession = { sessionId ->
                                    filesViewModel.closePanel()
                                    openSession(sessionId)
                                },
                            )
                        },
                    )
                }
            }
        }

        if (quickSwitcherOpen) {
            QuickSwitcherDialog(
                sessions = state.sessions,
                runningIds = state.runningIds,
                home = state.home,
                currentModel = chatControls.modelName
                    ?: chatControls.model?.let { "${it.provider}/${it.modelId}" },
                onSelectSession = { id ->
                    quickSwitcherOpen = false
                    openSession(id)
                },
                onNewSession = {
                    quickSwitcherOpen = false
                    openNewSession()
                },
                onChangeTheme = {
                    quickSwitcherOpen = false
                    themeSwitcherOpen = true
                },
                onDismiss = { quickSwitcherOpen = false },
            )
        }

        if (themeSwitcherOpen) {
            ThemePickerDialog(
                selectedThemeId = themeId,
                onSelect = onThemeSelected,
                onDismiss = { themeSwitcherOpen = false },
            )
        }

        if (state.archive.open) {
            ArchiveBrowserDialog(
                state = state.archive,
                onClose = viewModel::closeArchive,
                onRefresh = viewModel::refreshArchive,
                onSearch = viewModel::setArchiveSearch,
                onSelect = viewModel::selectArchiveEntry,
                onRestore = { key -> viewModel.restoreArchiveEntry(key) { openDetail() } },
                onCopyId = { copyId(it) },
            )
        }

        pickerPurpose?.let { purpose ->
            DirectoryPickerDialog(
                viewModel = directoryPickerViewModel,
                initialPath = when (purpose) {
                    PickerPurpose.AddProject -> state.activeCwd ?: state.home
                    PickerPurpose.NewSession -> state.newSessionCwd ?: state.activeCwd ?: state.home
                },
                onDismiss = { pickerPurpose = null },
                onSelected = { path, config ->
                    when (purpose) {
                        PickerPurpose.AddProject -> viewModel.addProject(path, config)
                        PickerPurpose.NewSession -> newSessionViewModel.setCwd(path)
                    }
                    // Closing through a selection skips the dialog's own
                    // reset(), which left the previous clone log/status in
                    // the next picker session.
                    directoryPickerViewModel.reset()
                    pickerPurpose = null
                },
            )
        }

        renameSessionTarget?.let { session ->
            NameDialog(
                title = stringResource(R.string.session_rename_title),
                label = stringResource(R.string.session_rename_hint),
                initial = session.name ?: session.title().orEmpty(),
                onConfirm = { name ->
                    viewModel.renameSession(session.id, name)
                    renameSessionTarget = null
                },
                onDismiss = { renameSessionTarget = null },
            )
        }

        deleteSessionTarget?.let { session ->
            ConfirmDialog(
                title = stringResource(R.string.session_delete_title),
                body = stringResource(R.string.session_delete_body),
                confirmLabel = stringResource(R.string.common_delete),
                danger = true,
                onConfirm = {
                    viewModel.deleteSession(session.id)
                    deleteSessionTarget = null
                },
                onDismiss = { deleteSessionTarget = null },
            )
        }

        renameProjectTarget?.let { project ->
            NameDialog(
                title = stringResource(R.string.project_rename),
                label = stringResource(R.string.project_label_hint),
                initial = project.alias.orEmpty(),
                onConfirm = { alias ->
                    viewModel.renameProject(project.path, alias)
                    renameProjectTarget = null
                },
                onDismiss = { renameProjectTarget = null },
            )
        }

        launchConfigTarget?.let { project ->
            LaunchConfigDialog(
                project = project,
                onSave = { config ->
                    viewModel.saveProjectLaunchConfig(project.path, config)
                    launchConfigTarget = null
                },
                onDismiss = { launchConfigTarget = null },
            )
        }

        hideProjectTarget?.let { project ->
            ConfirmDialog(
                title = stringResource(R.string.project_hide_title),
                body = stringResource(R.string.project_hide_body),
                confirmLabel = stringResource(R.string.project_hide_confirm),
                danger = true,
                onConfirm = {
                    viewModel.removeProject(project.path)
                    hideProjectTarget = null
                },
                onDismiss = { hideProjectTarget = null },
            )
        }

        shareUris?.let { uris ->
            ShareTargetDialog(
                count = uris.size,
                sessions = state.sessions.take(8),
                onNewChat = { acceptShare(null, null) },
                onSession = { session -> acceptShare(session.id, session.cwd) },
                onDismiss = {
                    shareUris = null
                    appContainer.consumeShare()
                },
            )
        }

        if (exitDraftPrompt) {
            ExitDraftDialog(
                draftCount = draftState.count { !it.value.isEmpty() },
                onStay = { exitDraftPrompt = false },
                onLeave = {
                    exitDraftPrompt = false
                    (context as? android.app.Activity)?.finish()
                },
            )
        }

    }
}

@Composable
private fun ShareTargetDialog(
    count: Int,
    sessions: List<SessionSummary>,
    onNewChat: () -> Unit,
    onSession: (SessionSummary) -> Unit,
    onDismiss: () -> Unit,
) {
    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.composer_share_title)) },
        text = {
            Column(
                modifier = Modifier
                    .heightIn(max = 420.dp)
                    .verticalScroll(rememberScrollState()),
            ) {
                Text(
                    text = stringResource(R.string.composer_share_count, count),
                    color = LocalOmpColors.current.textDim,
                    fontSize = 12.sp,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = stringResource(R.string.composer_share_new_chat),
                    color = LocalOmpColors.current.accent,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClick = onNewChat)
                        .padding(vertical = 10.dp),
                )
                sessions.forEach { session ->
                    Text(
                        text = session.name?.takeIf { it.isNotBlank() } ?: session.title().orEmpty(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSession(session) }
                            .padding(vertical = 10.dp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.composer_share_cancel))
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionListPane(
    state: SessionsUiState,
    historyCanBack: Boolean,
    historyCanForward: Boolean,
    themeId: String,
    onRefresh: () -> Unit,
    onRetryConnection: () -> Unit,
    onThemeSelected: (String) -> Unit,
    onSignOut: () -> Unit,
    onChangeServer: () -> Unit,
    notificationBell: @Composable () -> Unit,
    /** Footer above the drawer's bottom edge: the provider limit warning row. */
    usageWarning: @Composable () -> Unit = {},
    onOpenSettings: () -> Unit,
    onBack: () -> Unit,
    onForward: () -> Unit,
    onQuickSwitcher: () -> Unit,
    onSearchToggle: () -> Unit,
    onSearchQueryChange: (String) -> Unit,
    onSearchClose: () -> Unit,
    onSearchModeChange: (SessionSearchMode) -> Unit,
    /** A message-search hit: open its session, then jump to the entry. */
    onOpenMessageHit: (SessionSearchHit) -> Unit,
    onLoadMoreMessageResults: () -> Unit,
    onRetryMessageSearch: () -> Unit,
    onRunningOnlyToggle: () -> Unit,
    onNewSession: () -> Unit,
    onAddProject: () -> Unit,
    /** Phase 9: opens the Files panel (Explorer/Git/Worktrees). */
    onOpenFiles: () -> Unit,
    onImport: () -> Unit,
    onOpenArchive: () -> Unit,
    onOpenSession: (String) -> Unit,
    onTogglePin: (String) -> Unit,
    onToggleProject: (String) -> Unit,
    onActivateProject: (String) -> Unit,
    onNewSessionInProject: (String) -> Unit,
    onRenameProject: (ManagedProject) -> Unit,
    onLaunchConfig: (ManagedProject) -> Unit,
    onHideProject: (ManagedProject) -> Unit,
    onMoveProject: (String, Int) -> Unit,
    onMoveProjectTo: (String, Int) -> Unit,
    onRenameSession: (SessionSummary) -> Unit,
    onArchiveSession: (String) -> Unit,
    onAutoNameSession: (String) -> Unit,
    onCopyTranscript: (SessionSummary) -> Unit,
    onExportSession: (SessionSummary) -> Unit,
    onDeleteSession: (SessionSummary) -> Unit,
    onCopyId: (String) -> Unit,
    /** The shell's update announcement, shown below this pane's top bar. */
    updateBanner: @Composable () -> Unit = {},
) {
    var menuOpen by remember { mutableStateOf(false) }
    var themePickerOpen by remember { mutableStateOf(false) }
    val colors = LocalOmpColors.current

    // Relative times must age while the list is open.
    val now by produceState(initialValue = Instant.now()) {
        while (true) {
            delay(60_000)
            value = Instant.now()
        }
    }

    val filterActive = state.searchQuery.isNotBlank() || state.runningOnly
    val displaySessions = remember(
        state.sessions,
        state.runningIds,
        state.runningCwds,
        state.exited,
        state.projects,
        state.activeCwd,
    ) {
        withLivePlaceholders(
            sessions = state.sessions,
            runningIds = state.runningIds,
            runningCwds = state.runningCwds,
            exited = state.exited,
            projects = state.projects,
            activeCwd = state.activeCwd,
        )
    }
    val displayProjects = remember(state.projects, displaySessions) {
        withWorkspaceProjects(state.projects, displaySessions)
    }
    val allGrouped = remember(displayProjects, displaySessions) {
        groupSessionsByProject(displayProjects, displaySessions)
    }
    val elsewhereIds = remember(state.elsewhere) { state.elsewhere.keys }
    // "Running only" and the project activity counts cover both kinds of live
    // session: the ones this server drives and the ones another omp process
    // owns. Unread badges and notifications stay on `runningIds` alone.
    val liveIds = remember(state.runningIds, elsewhereIds) { state.runningIds + elsewhereIds.toList() }
    val visibleEntries = remember(
        displayProjects,
        allGrouped,
        liveIds,
        state.searchQuery,
        state.runningOnly,
    ) {
        visibleSessionEntries(
            projects = displayProjects,
            sessionsByProject = allGrouped,
            runningOnly = state.runningOnly,
            runningIds = liveIds,
            query = state.searchQuery,
        )
    }
    val visibleProjects = remember(visibleEntries) { visibleEntries.map { it.first } }
    val visibleSessions = remember(visibleEntries) { visibleEntries.flatMap { it.second } }
    val grouped = remember(visibleEntries) { visibleEntries.associate { it.first.path to it.second } }
    // Pinned rows are a shortcut at the top; they stay in their project tree
    // too (removing them there would reparent a pinned fork's children). A
    // filter still applies, so a running-only or title search does not show an
    // unrelated pin.
    val pinnedSessions = remember(displaySessions, visibleSessions, state.pinnedIds, filterActive) {
        (if (filterActive) visibleSessions else displaySessions).filter { it.id in state.pinnedIds }
    }
    val activities = remember(displaySessions, liveIds, state.unreadIds, state.exited) {
        projectActivityCounts(displaySessions, liveIds, state.unreadIds, state.exited.keys)
    }
    val listState = rememberLazyListState()
    val edgeScrollPx = with(LocalDensity.current) { 56.dp.toPx() }
    var draggingPath by remember { mutableStateOf<String?>(null) }
    var dragOffset by remember { mutableStateOf(0f) }
    var dragLocalY by remember { mutableStateOf(0f) }
    var dropIndex by remember { mutableStateOf(-1) }

    fun finishDrag() {
        val path = draggingPath
        if (path != null) {
            // dropIndex is an index into the rendered projects; the move itself
            // takes the position in the full project order. Ending on the
            // dragged row itself (a long press without dragging) moves nothing.
            val targetPath = dropTargetPath(visibleProjects.map { it.path }, dropIndex, path)
            val target = displayProjects.indexOfFirst { it.path == targetPath }
            if (targetPath != null && target >= 0) onMoveProjectTo(path, target)
        }
        draggingPath = null
        dragOffset = 0f
        dragLocalY = 0f
        dropIndex = -1
    }

    // Keep a long list reachable while dragging: the web scrolls under the
    // pointer, and without this a target below the viewport cannot be hit.
    LaunchedEffect(draggingPath) {
        val path = draggingPath ?: return@LaunchedEffect
        while (isActive) {
            val info = listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == path }
            if (info != null) {
                val pointerY = info.offset + dragLocalY
                val viewport = listState.layoutInfo
                val delta = when {
                    pointerY < viewport.viewportStartOffset + edgeScrollPx -> -edgeScrollPx
                    pointerY > viewport.viewportEndOffset - edgeScrollPx -> edgeScrollPx
                    else -> 0f
                }
                if (delta != 0f) {
                    listState.scrollBy(delta)
                    val target = dropTargetKey(
                        viewport.visibleItemsInfo.map { DragItemBounds(it.key.toString(), it.offset, it.size) },
                        info.offset + dragLocalY,
                    )
                    val targetIndex = visibleProjects.indexOfFirst { it.path == target }
                    if (targetIndex >= 0) dropIndex = targetIndex
                }
            }
            delay(16)
        }
    }

    Scaffold(
        topBar = {
            // A phone-width pane cannot hold eight 48 dp actions: the row
            // clipped the bell and the overflow menu, and the title was
            // squeezed into a one-character column that grew the bar to 405 dp
            // and pushed the list off the screen (320 dp, font 200 %). Keep the
            // four actions every screen needs and move the rest into the
            // overflow menu, where Search and Settings already live.
            BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
                val narrowChrome = maxWidth < NARROW_CHROME_MAX_WIDTH
                TopAppBar(
                    title = {
                        if (state.searchOpen) {
                            OutlinedTextField(
                                value = state.searchQuery,
                                onValueChange = onSearchQueryChange,
                                placeholder = {
                                    Text(
                                        stringResource(
                                            if (state.searchMode == SessionSearchMode.Messages) {
                                                R.string.sessions_search_messages_placeholder
                                            } else {
                                                R.string.home_search
                                            },
                                        ),
                                    )
                                },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        } else {
                            Text(
                                text = stringResource(R.string.home_title),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = {},
                    actions = {
                        if (!state.searchOpen) {
                            if (!narrowChrome) {
                                IconButton(onClick = onBack, enabled = historyCanBack) {
                                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = stringResource(R.string.nav_back))
                                }
                                IconButton(onClick = onForward, enabled = historyCanForward) {
                                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.nav_forward))
                                }
                            }
                            IconButton(onClick = onSearchToggle) {
                                Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.home_search))
                            }
                            IconButton(onClick = onNewSession) {
                                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.new_session_title))
                            }
                            if (!narrowChrome) {
                                IconButton(onClick = onOpenFiles) {
                                    Icon(
                                        Icons.AutoMirrored.Filled.List,
                                        contentDescription = stringResource(R.string.files_open_in_session),
                                    )
                                }
                                IconButton(onClick = onOpenSettings) {
                                    Icon(
                                        Icons.Filled.Settings,
                                        contentDescription = stringResource(R.string.settings_title),
                                    )
                                }
                            }
                            notificationBell()
                            IconButton(onClick = { menuOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = stringResource(R.string.sessions_menu))
                            }
                            OmpDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                if (narrowChrome) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.nav_back)) },
                                        enabled = historyCanBack,
                                        onClick = {
                                            menuOpen = false
                                            onBack()
                                        },
                                    )
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.nav_forward)) },
                                        enabled = historyCanForward,
                                        onClick = {
                                            menuOpen = false
                                            onForward()
                                        },
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.home_search)) },
                                    onClick = {
                                        menuOpen = false
                                        onSearchToggle()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.home_running_only)) },
                                    leadingIcon = {
                                        if (state.runningOnly) {
                                            Icon(Icons.Filled.Check, contentDescription = null)
                                        }
                                    },
                                    onClick = {
                                        menuOpen = false
                                        onRunningOnlyToggle()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.home_quick_switcher)) },
                                    onClick = {
                                        menuOpen = false
                                        onQuickSwitcher()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.home_add_project)) },
                                    onClick = {
                                        menuOpen = false
                                        onAddProject()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.home_archive)) },
                                    onClick = {
                                        menuOpen = false
                                        onOpenArchive()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.home_import)) },
                                    onClick = {
                                        menuOpen = false
                                        onImport()
                                    },
                                )
                                if (narrowChrome) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.files_open_in_session)) },
                                        onClick = {
                                            menuOpen = false
                                            onOpenFiles()
                                        },
                                    )
                                }
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.settings_title)) },
                                    onClick = {
                                        menuOpen = false
                                        onOpenSettings()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.menu_theme)) },
                                    onClick = {
                                        menuOpen = false
                                        themePickerOpen = true
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.menu_sign_out)) },
                                    onClick = {
                                        menuOpen = false
                                        onSignOut()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.menu_change_server)) },
                                    onClick = {
                                        menuOpen = false
                                        onChangeServer()
                                    },
                                )
                            }
                        }
                    },
                )
            }
        },
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize(),
            ) {
                // The update announcement lives in the content, below the app bar
                // (the floating overlay used to cover every action in it).
                updateBanner()
                ConnectionBanner(state = state, onRetry = onRetryConnection)
                // A failed revalidation is not "still updating": the slot
                // holds the honest reason and a retry, while the cached rows
                // stay usable.
                val listError = state.error
                if (sessionsShowsRefreshError(state.sessions.isNotEmpty(), listError != null) && listError != null) {
                    ListRefreshErrorRow(error = listError, onRetry = onRefresh)
                } else if (sessionsShowsUpdating(state.runningKnown, state.sessions.isNotEmpty(), listError != null)) {
                    ListUpdatingRow()
                }
                if (state.projectsError != null) {
                    ProjectsErrorBanner(onRetry = onRefresh)
                }
                if (state.searchOpen) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 12.dp, vertical = 4.dp),
                    ) {
                        FilterChip(
                            selected = state.searchMode == SessionSearchMode.Sessions,
                            onClick = { onSearchModeChange(SessionSearchMode.Sessions) },
                            label = { Text(stringResource(R.string.sessions_search_scope_sessions)) },
                        )
                        Spacer(Modifier.width(8.dp))
                        // No `messageSearch` capability = an older server whose
                        // search route answers 404: the mode is not offered.
                        if (state.messageSearchSupported) {
                            FilterChip(
                                selected = state.searchMode == SessionSearchMode.Messages,
                                onClick = { onSearchModeChange(SessionSearchMode.Messages) },
                                label = { Text(stringResource(R.string.sessions_search_scope_messages)) },
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        if (state.searchMode == SessionSearchMode.Sessions) {
                            FilterChip(
                                selected = state.runningOnly,
                                onClick = onRunningOnlyToggle,
                                label = { Text(stringResource(R.string.home_running_only)) },
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = onSearchClose) {
                            Text(stringResource(R.string.home_search_close))
                        }
                    }
                }
                PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = onRefresh,
                    // The provider strip below keeps its intrinsic height: a
                    // fillMaxSize() here made the pull-to-refresh box take the
                    // whole column and the footer was pushed out of the drawer
                    // (A1).
                    modifier = Modifier.weight(1f),
                ) {
                    val error = state.error
                    when {
                        state.searchMode == SessionSearchMode.Messages && state.searchQuery.isNotBlank() -> MessageSearchResults(
                            search = state.messageSearch,
                            sessions = displaySessions,
                            now = now,
                            onOpenHit = onOpenMessageHit,
                            onLoadMore = onLoadMoreMessageResults,
                            onRetry = onRetryMessageSearch,
                        )

                        state.loading && displayProjects.isEmpty() -> LoadingSessions()
    
                        error != null && displayProjects.isEmpty() && visibleSessions.isEmpty() -> SessionsError(
                            error = error,
                            onRetry = onRefresh,
                        )
    
                        displayProjects.isEmpty() && visibleSessions.isEmpty() -> EmptySessions(
                            onAddProject = onAddProject,
                            // Web's getting-started button opens the add-project
                            // picker as well (`AppShell` "Open workspaces").
                            onOpenWorkspaces = onAddProject,
                        )
    
                        filterActive && visibleProjects.isEmpty() && pinnedSessions.isEmpty() -> Text(
                            text = stringResource(R.string.home_no_matches),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textDim,
                            modifier = Modifier.padding(24.dp),
                        )
    
                        else -> LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                            if (pinnedSessions.isNotEmpty()) {
                                item(key = "pinned-sessions") {
                                    PinnedSection(
                                        sessions = pinnedSessions,
                                        now = now,
                                        runningIds = state.runningIds,
                                        unreadIds = state.unreadIds,
                                        exitedIds = state.exited.keys,
                                        elsewhereIds = elsewhereIds,
                                        selectedSessionId = state.selectedSessionId,
                                        namingSessionId = state.autoName.sessionId
                                            ?.takeIf { state.autoName.phase == AutoNamePhase.Naming },
                                        onSelectSession = onOpenSession,
                                        onTogglePin = { onTogglePin(it.id) },
                                        onRenameSession = onRenameSession,
                                        onArchiveSession = { onArchiveSession(it.id) },
                                        onAutoName = { onAutoNameSession(it.id) },
                                        onCopyTranscript = onCopyTranscript,
                                        onExportSession = onExportSession,
                                        onDeleteSession = onDeleteSession,
                                        onCopyId = onCopyId,
                                    )
                                }
                            }
                            itemsIndexed(items = visibleProjects, key = { _, project -> project.path }) { index, project ->
                                val projectSessions = grouped[project.path].orEmpty()
                                val activity = activities[comparableProjectPath(project.path)] ?: ProjectActivity()
                                val expandedKey = comparableProjectPath(project.path)
                                val defaultKey = comparableProjectPath(
                                    state.activeCwd ?: displayProjects.firstOrNull()?.path.orEmpty(),
                                )
                                val expanded = filterActive ||
                                    state.expandedProjects?.contains(expandedKey) == true ||
                                    (state.expandedProjects == null && expandedKey == defaultKey)
                                ProjectBlock(
                                    project = project,
                                    allProjectSessions = allGrouped[project.path].orEmpty(),
                                    visibleSessions = projectSessions,
                                    activity = activity,
                                    expanded = expanded,
                                    filterActive = filterActive,
                                    now = now,
                                    runningIds = state.runningIds,
                                    unreadIds = state.unreadIds,
                                    exitedIds = state.exited.keys,
                                    elsewhereIds = elsewhereIds,
                                    selectedSessionId = state.selectedSessionId,
                                    namingSessionId = state.autoName.sessionId
                                        ?.takeIf { state.autoName.phase == AutoNamePhase.Naming },
                                    pinnedIds = state.pinnedIds,
                                    dragging = draggingPath == project.path,
                                    dragOffset = dragOffset,
                                    dropHighlight = draggingPath != null &&
                                        draggingPath != project.path && index == dropIndex,
                                    onToggle = { onToggleProject(project.path) },
                                    onActivate = { onActivateProject(project.path) },
                                    onNewSession = { onNewSessionInProject(project.path) },
                                    onTogglePin = { onTogglePin(it.id) },
                                    onRenameProject = { onRenameProject(project) },
                                    onLaunchConfig = { onLaunchConfig(project) },
                                    onMoveUp = { onMoveProject(project.path, -1) },
                                    onMoveDown = { onMoveProject(project.path, 1) },
                                    onHide = { onHideProject(project) },
                                    onDragStart = { pointerY ->
                                        draggingPath = project.path
                                        dragOffset = 0f
                                        dragLocalY = pointerY
                                        // `itemsIndexed(visibleProjects)` counts the
                                        // projects, not the lazy items: the pinned
                                        // header is a separate item and must not
                                        // shift the drop index.
                                        dropIndex = index
                                    },
                                    onDrag = { delta, pointerY ->
                                        dragOffset += delta
                                        dragLocalY = pointerY
                                        val info = listState.layoutInfo.visibleItemsInfo
                                            .firstOrNull { it.key == project.path }
                                        if (info != null) {
                                            val target = dropTargetKey(
                                                listState.layoutInfo.visibleItemsInfo.map {
                                                    DragItemBounds(it.key.toString(), it.offset, it.size)
                                                },
                                                info.offset + pointerY,
                                            )
                                            val targetIndex = visibleProjects.indexOfFirst {
                                                it.path == target
                                            }
                                            if (targetIndex >= 0) dropIndex = targetIndex
                                        }
                                    },
                                    onDragEnd = { finishDrag() },
                                    onDragCancel = {
                                        draggingPath = null
                                        dragOffset = 0f
                                        dragLocalY = 0f
                                        dropIndex = -1
                                    },
                                    onSelectSession = onOpenSession,
                                    onRenameSession = onRenameSession,
                                    onArchiveSession = { session -> onArchiveSession(session.id) },
                                    onAutoName = { session -> onAutoNameSession(session.id) },
                                    onCopyTranscript = onCopyTranscript,
                                    onExportSession = onExportSession,
                                    onDeleteSession = onDeleteSession,
                                    onCopyId = onCopyId,
                                )
                                HorizontalDivider(color = colors.border)
                            }
                        }
                    }
                }
                // The provider block itself lives in Settings; the list only
                // warns while a window is tight (the composable emits nothing
                // otherwise, so the list keeps the whole height).
                usageWarning()
            }
        }
    }

    if (themePickerOpen) {
        ThemePickerDialog(
            selectedThemeId = themeId,
            onSelect = onThemeSelected,
            onDismiss = { themePickerOpen = false },
        )
    }
}

@Composable
private fun ConnectionBanner(state: SessionsUiState, onRetry: () -> Unit) {
    val colors = LocalOmpColors.current
    val reconnecting = state.connection == ConnectionState.Reconnecting && state.liveUpdates
    val messageRes = when {
        !state.liveUpdates -> R.string.banner_live_unavailable
        state.connection == ConnectionState.Reconnecting -> R.string.banner_reconnecting
        state.connection == ConnectionState.Offline -> R.string.banner_offline
        else -> null
    } ?: return

    Surface(
        color = colors.statusWarning.copy(alpha = 0.12f),
        contentColor = colors.statusWarning,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        ) {
            if (reconnecting) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = colors.statusWarning,
                )
                Spacer(Modifier.width(12.dp))
            }
            Text(
                text = stringResource(messageRes),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.sessions_retry))
            }
        }
    }
}

/**
 * Cache-first list: the rows are the ones this device saw last, so "no running
 * badge" is not a fact yet. One muted line with a spinner says the badges are
 * still being fetched; it disappears with the first server answer.
 */
@Composable
private fun ListUpdatingRow() {
    val colors = LocalOmpColors.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(start = 16.dp, end = 16.dp, top = 6.dp, bottom = 2.dp),
    ) {
        CircularProgressIndicator(
            modifier = Modifier.size(11.dp),
            strokeWidth = 1.5.dp,
            color = colors.textDim,
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = stringResource(R.string.sessions_list_updating),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textDim,
        )
    }
}

/**
 * Cache-first list whose revalidation failed: the rows are still the last
 * known ones, but nothing is on its way any more. One narrow row with the
 * reason and a retry replaces the *Updating…* spinner; the full-screen
 * [SessionsError] would hide the rows it could still show.
 */
@Composable
private fun ListRefreshErrorRow(error: SessionsLoadError, onRetry: () -> Unit) {
    val colors = LocalOmpColors.current
    Surface(
        color = colors.statusError.copy(alpha = 0.10f),
        contentColor = colors.statusError,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 2.dp),
        ) {
            Text(
                text = error.message(),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.sessions_retry))
            }
        }
    }
}

@Composable
private fun ProjectsErrorBanner(onRetry: () -> Unit) {
    val colors = LocalOmpColors.current
    Surface(
        color = colors.statusError.copy(alpha = 0.10f),
        contentColor = colors.statusError,
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(start = 16.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        ) {
            Text(
                text = stringResource(R.string.projects_error),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.sessions_retry))
            }
        }
    }
}

@Composable
private fun LoadingSessions() {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun EmptySessions(onAddProject: () -> Unit, onOpenWorkspaces: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.sessions_empty_title),
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.sessions_empty_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        // Web `AppShell`'s getting-started block: numbered steps, then the
        // "Open workspaces" action that opens the add-project picker.
        Text(
            text = stringResource(R.string.sessions_getting_started),
            style = MaterialTheme.typography.titleSmall,
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text = stringResource(R.string.sessions_step_add_project),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = stringResource(R.string.sessions_step_new_session),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = onOpenWorkspaces) {
            Text(stringResource(R.string.sessions_open_workspaces))
        }
        Spacer(Modifier.height(4.dp))
        TextButton(onClick = onAddProject) {
            Text(stringResource(R.string.home_add_project))
        }
    }
}

@Composable
private fun SessionsError(error: SessionsLoadError, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = error.message(),
            style = MaterialTheme.typography.bodyLarge,
            color = LocalOmpColors.current.statusError,
        )
        Spacer(Modifier.height(16.dp))
        TextButton(onClick = onRetry) {
            Text(stringResource(R.string.sessions_retry))
        }
    }
}

@Composable
private fun SessionDetailEmpty() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = stringResource(R.string.detail_no_selection),
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.detail_no_selection_hint),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** The user-facing text for a load failure; the server variant carries its status code. */
@Composable
private fun SessionsLoadError.message(): String = when (this) {
    SessionsLoadError.Network -> stringResource(R.string.sessions_error_network)
    SessionsLoadError.Forbidden -> stringResource(R.string.sessions_error_forbidden)
    SessionsLoadError.Misconfigured -> stringResource(R.string.sessions_error_misconfigured)
    is SessionsLoadError.Server -> stringResource(R.string.sessions_error_server, code)
}

/** The Compose key names the shell binds; null for every other key. */
private fun Key.toShellKeyName(): ShellKeyName? = when (this) {
    Key.K -> ShellKeyName.K
    Key.N -> ShellKeyName.N
    Key.M -> ShellKeyName.M
    Key.T -> ShellKeyName.T
    Key.Escape -> ShellKeyName.Escape
    Key.DirectionLeft -> ShellKeyName.DirectionLeft
    Key.DirectionRight -> ShellKeyName.DirectionRight
    Key.LeftBracket -> ShellKeyName.LeftBracket
    Key.RightBracket -> ShellKeyName.RightBracket
    else -> null
}

/**
 * "Search in messages" results: one row per matching entry, newest first (the
 * server scans backwards). Tapping a row opens its session and jumps to the
 * entry. Empty `partial` pages are continued automatically (the view model
 * fetches up to [SessionsViewModel.MESSAGE_SEARCH_AUTO_PAGE_LIMIT] pages, and
 * this surface shows that progress); "Load more" stays for the page budget a
 * run cannot cover, also when that page holds no row yet, because a `partial`
 * answer with zero results means "the scan stopped before it reached a match",
 * not "nothing matched".
 */
@Composable
internal fun MessageSearchResults(
    search: MessageSearchState,
    sessions: List<SessionSummary>,
    now: Instant,
    onOpenHit: (SessionSearchHit) -> Unit,
    onLoadMore: () -> Unit,
    onRetry: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val titles = remember(sessions) {
        sessions.associate { session -> session.id to (session.title() ?: session.id) }
    }
    when {
        search.results.isEmpty() && search.loading -> Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text(
                    text = if (search.autoPages > 0) {
                        stringResource(
                            R.string.sessions_search_messages_continuing,
                            search.autoPages + 1,
                            SessionsViewModel.MESSAGE_SEARCH_AUTO_PAGE_LIMIT,
                        )
                    } else {
                        stringResource(R.string.sessions_search_messages_loading)
                    },
                    color = colors.textMuted,
                )
            }
        }

        search.results.isEmpty() && search.error != null -> Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(search.error, color = colors.textMuted, textAlign = TextAlign.Center)
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.sessions_search_messages_retry))
            }
        }

        // An empty page is only "no matches" once the server says the scan is
        // complete. A page that stopped on the time/byte budget hands back a
        // cursor while the rest of the history is still unscanned (a single
        // large session file can fill the first pages on its own), so the next
        // page must stay reachable here too.
        search.results.isEmpty() && !search.loading -> Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (search.skippedFiles > 0) {
                SkippedFilesNotice(count = search.skippedFiles)
                Spacer(Modifier.height(8.dp))
            }
            if (search.partial) {
                Text(
                    text = stringResource(R.string.sessions_search_messages_partial),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textDim,
                    textAlign = TextAlign.Center,
                )
                if (search.cursor != null) {
                    TextButton(onClick = onLoadMore) {
                        Text(stringResource(R.string.sessions_search_messages_load_more))
                    }
                }
            } else {
                Text(
                    text = stringResource(R.string.sessions_search_messages_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textDim,
                    textAlign = TextAlign.Center,
                )
            }
        }

        else -> LazyColumn(modifier = Modifier.fillMaxSize()) {
            if (search.skippedFiles > 0) {
                item(key = "message-search-skipped") {
                    SkippedFilesNotice(count = search.skippedFiles)
                }
            }
            items(items = search.results, key = { "${it.sessionId}:${it.entryId}" }) { hit ->
                MessageHitRow(
                    hit = hit,
                    sessionTitle = titles[hit.sessionId],
                    now = now,
                    onClick = { onOpenHit(hit) },
                )
            }
            item(key = "message-search-footer") {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    when {
                        search.loading -> CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(18.dp),
                        )

                        search.partial && search.cursor != null -> TextButton(onClick = onLoadMore) {
                            Text(stringResource(R.string.sessions_search_messages_load_more))
                        }
                    }
                    if (search.loading && search.autoPages > 0) {
                        Text(
                            text = stringResource(
                                R.string.sessions_search_messages_continuing,
                                search.autoPages + 1,
                                SessionsViewModel.MESSAGE_SEARCH_AUTO_PAGE_LIMIT,
                            ),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textDim,
                            textAlign = TextAlign.Center,
                        )
                    }
                    if (search.partial) {
                        Text(
                            text = stringResource(R.string.sessions_search_messages_partial),
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textDim,
                            textAlign = TextAlign.Center,
                        )
                    }
                    search.error?.let { message ->
                        Text(message, color = colors.textMuted, textAlign = TextAlign.Center)
                        TextButton(onClick = onRetry) {
                            Text(stringResource(R.string.sessions_search_messages_retry))
                        }
                    }
                }
            }
        }
    }
}

/**
 * The server leaves session files above its scan limit (`SEARCH_LARGE_FILE_BYTES`,
 * 64 MiB) out of the search entirely. Their text is therefore not covered, and
 * "No matches" would overclaim without this line.
 */
@Composable
private fun SkippedFilesNotice(count: Int) {
    val colors = LocalOmpColors.current
    Text(
        text = pluralStringResource(R.plurals.sessions_search_messages_skipped, count, count),
        style = MaterialTheme.typography.labelSmall,
        color = colors.textDim,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

@Composable
private fun MessageHitRow(
    hit: SessionSearchHit,
    sessionTitle: String?,
    now: Instant,
    onClick: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val snippetLength = hit.snippet.length
    val matchStart = hit.matchStart.coerceIn(0, snippetLength)
    val matchEnd = hit.matchEnd.coerceIn(matchStart, snippetLength)
    // The server sends UTF-16 offsets into this exact snippet, so the mark can
    // be applied without a second search (and without folding case).
    val snippet = remember(hit.snippet, matchStart, matchEnd, colors.accent) {
        buildAnnotatedString {
            append(hit.snippet)
            if (matchEnd > matchStart) {
                addStyle(
                    SpanStyle(
                        background = colors.accent.copy(alpha = 0.3f),
                        fontWeight = FontWeight.SemiBold,
                    ),
                    matchStart,
                    matchEnd,
                )
            }
        }
    }
    val roleLabel = when (hit.role) {
        "assistant" -> R.string.sessions_search_role_assistant
        else -> R.string.sessions_search_role_user
    }
    val time = relativeTime(hit.timestamp, now)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = sessionTitle?.takeIf { it.isNotBlank() }
                    ?: hit.title.ifBlank { hit.sessionId },
                style = MaterialTheme.typography.titleSmall,
                color = colors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (time != null) {
                Text(
                    text = time,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
        Text(
            text = stringResource(roleLabel),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            color = if (hit.role == "user") colors.accent else colors.textDim,
            modifier = Modifier.padding(top = 2.dp),
        )
        Text(
            text = snippet,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textMuted,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 2.dp),
        )
    }
    HorizontalDivider(color = colors.textDim.copy(alpha = 0.12f))
}

private const val MAX_IMPORT_BYTES = 8 * 1024 * 1024
private const val MAX_CLIPBOARD_CHARS = 100_000

/**
 * Below this pane width the list's eight top-bar actions do not fit: eight
 * 48 dp targets need 384 dp, and the title needs room as well. The bar keeps
 * Search, New session, the bell and the overflow menu; Back/Forward and the
 * Files entry move into that menu.
 */
private val NARROW_CHROME_MAX_WIDTH = 480.dp

/**
 * Window height below which the chat pane does not host the update banner.
 *
 * Measured at 320 × 568 dp with font scale 2.0: the banner is 120 dp tall
 * there, the composer 245 dp and the pane header 101 dp, so the banner pushed
 * the composer's Send row out of the window. From ~620 dp up (a regular phone
 * is 890 dp) the chat keeps a usable transcript next to both.
 */
private const val MIN_HEIGHT_FOR_CHAT_BANNER = 620

/** Third column width; the same order of magnitude as the web's file panel. */
private val FILES_PANEL_WIDTH = 360.dp

/** Fresh-process marker for the cold-start session restore (never across rotation). */
private object ColdStartSessionRestore {
    var pending: Boolean = true
}
