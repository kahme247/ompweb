@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.github.kahme247.ompweb.ui.chat

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.chat.ChatDisplayPrefs
import io.github.kahme247.ompweb.chat.ChatNotice
import io.github.kahme247.ompweb.chat.ContentionCopy
import io.github.kahme247.ompweb.chat.formatGenerationRate
import io.github.kahme247.ompweb.chat.HeaderBlock
import io.github.kahme247.ompweb.chat.LoadEarlierState
import io.github.kahme247.ompweb.chat.NoticeKind
import io.github.kahme247.ompweb.chat.ScrollLogic
import io.github.kahme247.ompweb.chat.Speaker
import io.github.kahme247.ompweb.chat.SpeakerRole
import io.github.kahme247.ompweb.chat.STREAM_RATE_PUBLISH_MS
import io.github.kahme247.ompweb.chat.TailMeasure
import io.github.kahme247.ompweb.chat.TranscriptFormat
import io.github.kahme247.ompweb.chat.TranscriptRow
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.net.ElsewhereSession
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.chat.CompactResult
import io.github.kahme247.ompweb.domain.ActiveGoal
import io.github.kahme247.ompweb.domain.ElsewhereKind
import io.github.kahme247.ompweb.domain.elsewhereKind
import io.github.kahme247.ompweb.domain.ExtensionDialogState
import io.github.kahme247.ompweb.domain.ExtensionWidgetPlacement
import io.github.kahme247.ompweb.domain.chatShowsConnecting
import io.github.kahme247.ompweb.domain.formatGoalElapsed
import io.github.kahme247.ompweb.ui.composer.ComposerBar
import io.github.kahme247.ompweb.ui.composer.MinimizedComposerBar
import io.github.kahme247.ompweb.ui.composer.MinimizeComposerButton
import io.github.kahme247.ompweb.ui.panels.ComposerPanels
import io.github.kahme247.ompweb.ui.panels.SubagentTranscriptDialog
import io.github.kahme247.ompweb.ui.panels.btw.BtwFailureKind
import io.github.kahme247.ompweb.ui.panels.btw.BtwHistoryDialog
import io.github.kahme247.ompweb.ui.panels.btw.BtwPanel
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionDialogHost
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionOpenUrlNotice
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionStatusBar
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionTerminalPanel
import io.github.kahme247.ompweb.ui.panels.extension.ExtensionWidgets
import io.github.kahme247.ompweb.ui.render.LinkTarget
import io.github.kahme247.ompweb.ui.render.LocalFileLinkBaseDir
import io.github.kahme247.ompweb.ui.render.copyTextToClipboard
import io.github.kahme247.ompweb.ui.hosttools.openExternalUrl
import io.github.kahme247.ompweb.ui.sessions.SessionExport
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private const val TRANSCRIPT_WINDOW = 60
private const val NEAR_BOTTOM_DP = 96

/**
 * Height of the transcript's tail anchor. Exactly on the pixel grid at every
 * density, so it never reads as a gap, but visible to the lazy list, which is
 * what lets the follow scroll target it (a zero-height item is not measured
 * into the visible range).
 */
private val TRANSCRIPT_TAIL_ANCHOR = 1.dp

/** Phase 5 chat surface inside the session detail pane. */
@Composable
fun ChatScreen(
    sessionId: String,
    cwd: String?,
    viewModel: ChatViewModel,
    onForked: (String) -> Unit,
    onError: (String) -> Unit,
    /** A `File` link in the transcript: the shell's Files panel opens the tab. */
    onOpenFile: (path: String, line: Int?) -> Unit,
    /**
     * Open another session by id: the "continued in a copy" banner links the
     * original chat after omp moved this conversation to a copy.
     */
    onOpenSession: (String) -> Unit,
    modifier: Modifier = Modifier,
    /**
     * The session list's owner report for this session (`elsewhereSessions`).
     * The list hears the server's `running` frames, so it can know the chat is
     * run elsewhere before this screen's own live-state read answers; the seed
     * is handed to [ChatViewModel.open].
     */
    elsewhere: ElsewhereSession? = null,
) {
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val composerState by viewModel.composer.state.collectAsStateWithLifecycle()
    val searchState by viewModel.search.collectAsStateWithLifecycle()
    val focusManager = LocalFocusManager.current
    // Web `ChatWindow`: the chevron collapses the composer into a one-line
    // pill; an extension dialog (and a new session) restores it.
    var composerMinimized by rememberSaveable { mutableStateOf(false) }
    var composerFocusRequested by remember { mutableStateOf(false) }
    val composerPlaceholder = stringResource(R.string.composer_placeholder)
    val minimizedStatusText = phaseStatusText(phaseLabel(ui.engine))
    val context = LocalContext.current
    val btwState by viewModel.btw.state.collectAsStateWithLifecycle()
    val extensionDialog by viewModel.extensionUi.dialog.collectAsStateWithLifecycle()
    LaunchedEffect(extensionDialog) {
        if (extensionDialog != null) composerMinimized = false
    }
    val extensionStatuses by viewModel.extensionUi.statusItems.collectAsStateWithLifecycle()
    val extensionWidgets by viewModel.extensionUi.widgets.collectAsStateWithLifecycle()
    val btwVisible = btwState.visible
    // Side-question failures are one-shot toasts (web `toastBtwError`).
    val btwUnsupportedText = stringResource(R.string.btw_unsupported)
    val btwFailedText = stringResource(R.string.btw_failed)
    // Resolved during composition: the clipboard label must not read resources
    // off `LocalContext` inside a lambda (configuration-aware query lint), and
    // the copy result is acknowledged like the web (`btw.copied`/`copyFailed`).
    val btwCopyLabel = stringResource(R.string.btw_copy)
    val btwCopiedText = stringResource(R.string.btw_copied)
    val btwCopyFailedText = stringResource(R.string.btw_copy_failed)
    val copyBtwAnswer: (String) -> Unit = { text ->
        val copied = copyTextToClipboard(context, btwCopyLabel, text)
        Toast.makeText(
            context,
            if (copied) btwCopiedText else btwCopyFailedText,
            Toast.LENGTH_SHORT,
        ).show()
    }
    LaunchedEffect(viewModel, btwUnsupportedText, btwFailedText) {
        viewModel.btw.errors.collect { failure ->
            val text = when (failure.kind) {
                BtwFailureKind.UNSUPPORTED -> btwUnsupportedText
                BtwFailureKind.FAILED -> failure.detail ?: btwFailedText
            }
            Toast.makeText(context, text, Toast.LENGTH_LONG).show()
        }
    }
    val colors = LocalOmpColors.current
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    // Resolved during composition: reading resources from the context inside a
    // coroutine can return a stale configuration.
    val forkCancelledText = stringResource(R.string.chat_fork_cancelled)
    val forkFailedText = stringResource(R.string.chat_fork_failed)
    // Resolved here: the reveal effect must not read resources in a coroutine.
    val revealMissingText = stringResource(R.string.chat_search_reveal_missing)

    // The list's owner report is part of the key: an owner that appears while
    // the chat is open (a `running` frame) seeds the banner without a send.
    LaunchedEffect(sessionId, cwd, elsewhere) { viewModel.open(sessionId, cwd, elsewhere) }
    // Leaving the chat closes its host/extension consent scopes; [open]
    // re-arms them when the surface comes back.
    DisposableEffect(viewModel) { onDispose { viewModel.onChatHidden() } }
    LaunchedEffect(Unit) { viewModel.prepareSpeech() }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) viewModel.onForeground()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            viewModel.stopSpeech()
        }
    }
    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is ChatEvent.Forked -> onForked(event.sessionId)
                // A refused or failed fork must never look like a dead button.
                is ChatEvent.ForkCancelled -> onError(forkCancelledText)
                is ChatEvent.ForkFailed -> onError(forkFailedText)
                is ChatEvent.Toast -> onError(event.message)
                is ChatEvent.CopyText -> {
                    val copied = copyTextToClipboard(context, "assistant message", event.text, sensitive = false)
                    if (!copied) onError(event.text)
                }
            }
        }
    }

    var pendingDownload by remember { mutableStateOf<String?>(null) }
    val outputSavedText = stringResource(R.string.chat_output_saved)
    val outputSaveFailedText = stringResource(R.string.chat_output_save_failed)
    val downloadLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("text/plain"),
    ) { uri ->
        val path = pendingDownload
        pendingDownload = null
        if (uri != null && path != null) {
            scope.launch {
                val bytes = viewModel.bashOutputBytes(path)
                if (bytes != null) {
                    val saved = SessionExport.writeToUri(context, uri, bytes)
                    Toast.makeText(
                        context,
                        if (saved) outputSavedText else outputSaveFailedText,
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        }
    }

    LaunchedEffect(ui.prefill) { viewModel.adoptPrefill() }
    // Live tokens/s is derived from the newest frame; without a tick a stalled
    // stream would keep its last number until the next frame. Web runs the same
    // 500 ms interval (useStreamRate) and hides the value after 2 s of silence.
    LaunchedEffect(viewModel, ui.engine.streamingActive) {
        if (!ui.engine.streamingActive) return@LaunchedEffect
        while (true) {
            delay(STREAM_RATE_PUBLISH_MS)
            viewModel.refreshLiveRate()
        }
    }
    LaunchedEffect(ui.busy, ui.engine.bashRunning, ui.sessionId) {
        viewModel.composer.setRunning(ui.busy || ui.engine.bashRunning)
    }
    LaunchedEffect(ui.engine.remoteCommands) {
        viewModel.composer.setRemoteCommands(ui.engine.remoteCommands)
    }

    val linkHandler: (LinkTarget) -> Unit = { target ->
        when (target) {
            is LinkTarget.File -> onOpenFile(target.path, target.line)
            is LinkTarget.Agent -> viewModel.openSubagent(target.handle)
            is LinkTarget.External -> openExternalUrl(context, target.url)
            // Unsupported scheme: the row rendered it as plain text.
            is LinkTarget.Inert -> Unit
            is LinkTarget.GithubIssue -> {
                val repo = ui.githubRepo
                val owner = if (target.owner.isNotEmpty()) target.owner else repo?.owner
                val name = if (target.repo.isNotEmpty()) target.repo else repo?.repo
                if (owner != null && name != null) {
                    openExternalUrl(context, "https://github.com/$owner/$name/issues/${target.number}")
                }
            }
        }
    }
    val callbacks = remember(linkHandler) {
        ChatRowCallbacks(
            onLink = linkHandler,
            onFork = { entryId, editPrompt -> viewModel.fork(entryId, editPrompt) },
            onLoadThinking = { entryId, blockIndex -> viewModel.loadThinking(entryId, blockIndex) },
            onToggleSpeech = { entryId, key, text -> viewModel.toggleSpeech(entryId, key, text) },
            onStopSpeech = { viewModel.stopSpeech() },
            onLoadBashOutput = { path -> viewModel.loadBashOutput(path) },
            onDownloadBashOutput = { path ->
                pendingDownload = path
                downloadLauncher.launch(path.substringAfterLast('/').ifBlank { "bash-output.txt" })
            },
            onEditFromHere = { prevAssistantEntryId, text -> viewModel.editFromHere(prevAssistantEntryId, text) },
        )
    }

    val rows = ui.rows
    // Day labels and header shapes follow the shared minute clock; the time
    // settings revision rebuilds the cached formatters (zone, 12/24-hour)
    // without a process restart.
    val timeRevision = rememberTimeFormatRevision()
    val minuteNow = rememberMinuteNow()
    val endAnchored = (rows.size - TRANSCRIPT_WINDOW).coerceAtLeast(0)
    // First rendered transcript row; the window is pinned to the tail while the
    // reader is at the bottom and frozen (or extended upwards) otherwise.
    //
    // The window, the follow latch and the first-scroll latch are saveable:
    // a configuration change (rotation, fold, resize) recreates the composable
    // and the lazy list restores its first item + offset from the saved
    // instance state. Restoring the window with them keeps that item pointing
    // at the same transcript row; resetting them (as before) re-pinned the
    // window to the tail and jumped to the newest row.
    var windowStart by rememberSaveable(sessionId) { mutableStateOf(0) }
    var paging by remember(sessionId) { mutableStateOf(LoadEarlierState()) }
    var pendingReveal by remember(sessionId) { mutableStateOf<Int?>(null) }
    var initialScrollDone by rememberSaveable(sessionId) { mutableStateOf(false) }
    var followEnabled by rememberSaveable(sessionId) { mutableStateOf(true) }
    val nearBottomThreshold = with(LocalDensity.current) { NEAR_BOTTOM_DP.dp.roundToPx() }

    /** The transcript tail as the list really laid it out, in pixels. */
    fun tailMeasure(): TailMeasure = listState.tailMeasure()
    val nearBottom by remember(listState, nearBottomThreshold) {
        derivedStateOf { ScrollLogic.isNearBottom(tailMeasure(), nearBottomThreshold) }
    }
    /**
     * A list that has not laid out yet reports "near bottom" (an empty layout
     * counts as the tail). Scroll decisions must only trust a measured layout:
     * a recreated surface (rotation, fold) would otherwise pin itself to the
     * tail before the restored position is measured, which is exactly the jump
     * this screen must not make.
     */
    fun laidOutNearBottom(): Boolean =
        listState.layoutInfo.totalItemsCount > 0 && nearBottom
    // The status bar and above-editor widgets ride as the transcript's first
    // item (web `ChatWindow`: they scroll with the messages, not as an overlay).
    val extensionHeaderVisible = extensionStatuses.isNotEmpty() ||
        extensionWidgets.any { it.placement == ExtensionWidgetPlacement.AboveEditor }
    // The compacted-history notice is the next transcript item (web
    // `ChatWindow` renders it inside the scroll container, above the first
    // message), so it scrolls away instead of pinning above the composer.
    val compactionNoticeVisible = ui.hasCompaction
    // The cache-first note is another lead item; the scroll math (rail, anchor
    // restore) counts every item above the first row.
    val historyUpdatingVisible = ui.engine.historyStale
    val transcriptLeadItems = (if (extensionHeaderVisible) 1 else 0) +
        (if (compactionNoticeVisible) 1 else 0) +
        (if (historyUpdatingVisible) 1 else 0)
    val headerOffset = transcriptLeadItems + (if (windowStart > 0) 1 else 0)

    // One more window of older rows, anchored on the row the reader was looking
    // at (web `chat-lazy-load.ts` + the `ChatWindow` scroll restore).
    fun loadEarlier(revealFirstLoaded: Boolean) {
        if (windowStart <= 0) return
        val visible = listState.firstVisibleItemIndex
        val anchorRow = ScrollLogic.rowIndexForItem(visible, windowStart, transcriptLeadItems)
        windowStart = (windowStart - TRANSCRIPT_WINDOW).coerceAtLeast(0)
        pendingReveal = if (revealFirstLoaded) {
            ScrollLogic.revealLoadedItem(windowStart, transcriptLeadItems)
        } else {
            ScrollLogic.itemIndexForRow(anchorRow, windowStart, transcriptLeadItems)
        }
    }

    // Pin the window to the tail whenever the reader is at the bottom. A saved
    // reading position restores its own window first, a pending reveal owns
    // it, and a surface that has not laid out yet has no position to judge.
    // The reveal id is deliberately not a key: its *consume* (right after the
    // jump) must not re-pin the window over the row the jump just opened.
    LaunchedEffect(endAnchored, nearBottom, ui.restoreScrollIndex) {
        if (ui.restoreScrollIndex != null || searchState.revealEntryId != null) return@LaunchedEffect
        if (!laidOutNearBottom()) return@LaunchedEffect
        windowStart = endAnchored
    }

    // A window saved for a longer transcript (branch switch, compaction) must
    // not render past the tail on the recreated surface.
    LaunchedEffect(rows.size, windowStart) {
        val clamped = ScrollLogic.clampWindow(windowStart, rows.size)
        if (clamped != windowStart) windowStart = clamped
    }

    val messageIndex = remember(ui.engine.messages) {
        ui.engine.messages.mapIndexed { index, message -> message.key to index }.toMap()
    }
    val displayedRows = remember(rows, windowStart) {
        if (rows.isEmpty()) emptyList() else rows.subList(windowStart.coerceIn(0, rows.size), rows.size)
    }
    // Day separators of the rendered window, derived from the rendered message
    // sequence (not the header blocks), so a day change inside one turn is
    // drawn too. Recomputed when the zone/time settings change.
    val dayBreaks = remember(displayedRows, ui.preferences.hideThinking, timeRevision) {
        TranscriptFormat.daySeparators(displayedRows, ui.preferences.hideThinking)
    }
    val userTurns = remember(displayedRows, windowStart) {
        userTurnIndices(displayedRows, headerOffset)
    }
    // The fast-scroll rail is a tablet affordance; phones keep the plain thumb.
    val showScrollRail = LocalConfiguration.current.screenWidthDp >= 600
    val streaming = ui.engine.streaming
    val pending = ui.engine.pendingUser
    // Speaker headers and day dividers: one plan for the rendered window plus
    // the optimistic prompt and the streaming reply, so a run of blocks by the
    // same speaker shares a single header across items.
    val transcriptHeaders = remember(
        displayedRows,
        pending,
        streaming?.key,
        streaming?.model,
        streaming?.timestamp,
    ) {
        val blocks = TranscriptFormat.headerBlocks(displayedRows).toMutableList()
        if (pending != null) {
            blocks += HeaderBlock("pending", Speaker(SpeakerRole.You), null)
        }
        if (streaming != null) {
            blocks += HeaderBlock("streaming", TranscriptFormat.speakerOf(streaming), streaming.timestamp)
        }
        TranscriptFormat.headerSlots(blocks)
    }
    // The tail anchor is the last item: a hairline spacer, so scrolling to it
    // lands on the very bottom whatever the height of the rows above it.
    val totalItems = displayedRows.size + headerOffset + (if (pending != null) 1 else 0) +
        (if (streaming != null) 1 else 0) + 1

    // Follow the tail while the reader has not scrolled away from it; sending a
    // prompt re-enables following (web `useAgentSession` send scroll intent).
    //
    // The trigger is the *measured* layout, not the message list: text, tool
    // output and folding grow inside existing rows, and the keyboard or a panel
    // shrinks the viewport — none of that changes a row count. A content-keyed
    // effect also ran before the list had measured the new content, so it
    // scrolled to the previous bottom and left the newest lines below the fold.
    // The layout snapshot is emitted after a measure pass, which is what makes
    // the follow land on the newest text.
    LaunchedEffect(listState) {
        snapshotFlow { listState.tailMeasure() }.collect { measure ->
            if (!followEnabled) return@collect
            // A saved reading position owns the scroll until the reader
            // decides otherwise; following it would yank them to the tail. A
            // pending reveal of a server-side search hit owns it too.
            if (ui.restoreScrollIndex != null || searchState.revealEntryId != null) return@collect
            if (!ScrollLogic.needsTailScroll(measure)) return@collect
            listState.scrollToTail()
        }
    }

    // A manual drag leaves the tail (the reader wins over the stream). Flinging
    // continues after the finger lifts, so following is only re-enabled once
    // the scroll settled — and only when it settled at the tail.
    LaunchedEffect(listState) {
        var settle: Job? = null
        listState.interactionSource.interactions.collect { interaction ->
            when (interaction) {
                is DragInteraction.Start -> {
                    settle?.cancel()
                    followEnabled = false
                }
                is DragInteraction.Stop, is DragInteraction.Cancel -> {
                    settle?.cancel()
                    settle = scope.launch {
                        snapshotFlow { listState.isScrollInProgress }.first { !it }
                        // The release is reported before the list measures the
                        // new offset: judge the tail only after that pass, or a
                        // drag away from the bottom would re-arm following
                        // on the stale (still at bottom) layout.
                        withFrameNanos { }
                        withFrameNanos { }
                        followEnabled = ScrollLogic.isNearBottom(listState.tailMeasure(), nearBottomThreshold)
                    }
                }
            }
        }
    }

    // Open a session at its newest message unless a reading position is saved
    // or a server-side search hit is waiting to be revealed: the reveal owns
    // the scroll then (it may land two frames before this effect's tail jump).
    LaunchedEffect(rows.size, ui.engine.historyLoaded, ui.restoreScrollIndex) {
        if (initialScrollDone || rows.isEmpty() || ui.restoreScrollIndex != null) return@LaunchedEffect
        if (searchState.revealEntryId != null) {
            initialScrollDone = true
            return@LaunchedEffect
        }
        initialScrollDone = true
        withFrameNanos { }
        withFrameNanos { }
        listState.scrollToTail()
    }

    // Restore a saved reading position once the transcript has content. A
    // pending reveal of a server-side search hit wins: the reader asked for
    // that entry, not for where they stopped reading last time.
    LaunchedEffect(ui.restoreScrollIndex, rows.size, searchState.revealEntryId) {
        val restore = ui.restoreScrollIndex ?: return@LaunchedEffect
        if (rows.isEmpty()) return@LaunchedEffect
        initialScrollDone = true
        if (searchState.revealEntryId != null) {
            viewModel.consumeRestoreScroll()
            return@LaunchedEffect
        }
        val target = restore.coerceIn(0, rows.size - 1)
        windowStart = minOf(target, endAnchored)
        // Let the wider window compose before scrolling to the row.
        withFrameNanos { }
        withFrameNanos { }
        val item = ScrollLogic.itemIndexForRow(target, windowStart, transcriptLeadItems)
            .coerceIn(0, (listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
        listState.scrollToItem(item)
        // The restored position decides whether following resumes: once the
        // restore flag clears, the measured follow effect would otherwise drag
        // a saved mid-transcript position down to the tail.
        withFrameNanos { }
        followEnabled = ScrollLogic.followAfterRestore(
            restoredRow = target,
            rowCount = rows.size,
            measure = listState.tailMeasure(),
            thresholdPx = nearBottomThreshold,
        )
        viewModel.consumeRestoreScroll()
    }

    // Keep a freshly prepended window from moving the reader's row.
    LaunchedEffect(pendingReveal, windowStart) {
        val row = pendingReveal ?: return@LaunchedEffect
        pendingReveal = null
        withFrameNanos { }
        val total = listState.layoutInfo.totalItemsCount
        if (total == 0) return@LaunchedEffect
        listState.scrollToItem(row.coerceIn(0, total - 1))
    }

    // Persist the reading position (row index, not the lazy item index).
    LaunchedEffect(listState, windowStart, transcriptLeadItems) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { item ->
            val rowIndex = ScrollLogic.rowIndexForItem(item, windowStart, transcriptLeadItems)
            viewModel.onScrollPosition(rowIndex, ScrollLogic.isNearBottom(listState.tailMeasure(), nearBottomThreshold))
        }
    }

    // Load one more window when the reader reaches the top. The latch arms only
    // after the tail was seen and a non-zero first item was visible, so a
    // prepended window cannot re-trigger itself.
    LaunchedEffect(listState, windowStart) {
        snapshotFlow { listState.firstVisibleItemIndex }.collect { item ->
            val decision = ScrollLogic.decideLoadEarlier(
                firstVisibleItemIndex = item,
                windowStart = windowStart,
                nearBottom = ScrollLogic.isNearBottom(listState.tailMeasure(), nearBottomThreshold),
                state = paging,
            )
            paging = decision.state
            if (decision.expand) loadEarlier(revealFirstLoaded = false)
        }
    }

    // ------------------------------------------------------------- chat search

    // The search marks must describe the transcript they were typed against:
    // a streamed reply or a reloaded history changes the hit list, and so does
    // hiding the thinking text the query used to match. The query itself is
    // not a key: `setSearchQuery` already refreshes, so keying it would scan
    // the whole transcript twice per keystroke.
    LaunchedEffect(searchState.open, ui.rows.size, ui.engine.messages.size, ui.preferences.hideThinking) {
        if (searchState.open) viewModel.refreshSearchHits()
    }

    /**
     * Show [rowIndex] in the transcript, even when it sits above the rendered
     * window, and stop following the tail so the jump is not undone by a
     * running turn. Marks it as the search's active hit.
     */
    fun revealRow(rowIndex: Int) {
        if (rows.isEmpty()) return
        val target = rowIndex.coerceIn(0, rows.lastIndex)
        if (target < windowStart) {
            windowStart = (target / TRANSCRIPT_WINDOW) * TRANSCRIPT_WINDOW
        }
        followEnabled = false
        pendingReveal = ScrollLogic.itemIndexForRow(target, windowStart, transcriptLeadItems)
    }

    // ↑/↓ and the first hit own the scroll while the field is open.
    val activeHitKey = searchState.active?.rowKey
    LaunchedEffect(searchState.open, activeHitKey, ui.rows.size) {
        if (!searchState.open) return@LaunchedEffect
        val key = activeHitKey ?: return@LaunchedEffect
        val index = ChatSearch.rowIndexForRowKey(ui.rows, key) ?: return@LaunchedEffect
        revealRow(index)
    }

    // Hand-off of the server-side search (`ui/sessions`): scroll to the entry
    // and flash its row. A request that arrives before the rows exist stays
    // queued in the view model and is applied by this effect once they do.
    // The hit may also live in history the compaction view hides; that history
    // is loaded instead of dropping the jump, and a hit that is really absent
    // is reported rather than swallowed.
    var flashRowKey by remember(sessionId) { mutableStateOf<String?>(null) }
    LaunchedEffect(
        searchState.revealEntryId,
        ui.rows.size,
        ui.engine.historyLoaded,
        ui.engine.historyLoading,
        ui.engine.pagesLoading,
        ui.engine.historyError,
        ui.hasCompaction,
        ui.engine.includePreCompaction,
    ) {
        val entry = searchState.revealEntryId ?: return@LaunchedEffect
        val index = ChatSearch.rowIndexForEntry(ui.rows, ui.engine.messages, entry)
        if (index != null) {
            revealRow(index)
            flashRowKey = ui.rows[index].key
            viewModel.consumeRevealEntry()
            return@LaunchedEffect
        }
        if (ui.hasCompaction && !ui.engine.includePreCompaction) {
            viewModel.togglePreCompactionHistory()
            return@LaunchedEffect
        }
        val failure = ui.engine.historyError
        if (failure != null) {
            viewModel.consumeRevealEntry()
            Toast.makeText(context, failure, Toast.LENGTH_LONG).show()
            return@LaunchedEffect
        }
        if (!ui.engine.historyLoaded || ui.engine.historyLoading || ui.engine.pagesLoading) {
            return@LaunchedEffect
        }
        viewModel.consumeRevealEntry()
        Toast.makeText(context, revealMissingText, Toast.LENGTH_SHORT).show()
    }
    LaunchedEffect(flashRowKey) {
        val key = flashRowKey ?: return@LaunchedEffect
        delay(2_500L)
        if (flashRowKey == key) flashRowKey = null
    }
    val matchedRowKeys = remember(searchState.hits) {
        searchState.hits.mapTo(HashSet()) { it.rowKey }
    }
    // Measured height of the in-chat search bar above the transcript. The plan
    // does not compose that bar, so it reserves the measured height to keep the
    // 45 % transcript share while the search is open.
    var searchBarHeight by remember { mutableStateOf(0.dp) }
    val density = LocalDensity.current

    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .imePadding(),
    ) {
        // The keyboard shrinks the pane to the space above the IME; the plan
        // splits what is left (user feedback 25.10.: the transcript shrank to
        // four lines while typing). The transcript keeps at least 45 % of it,
        // the composer caps there and scrolls its secondary rows, and on a
        // phone the panels stack and the controls row step aside while the
        // keyboard covers the screen. They come back when the IME closes; the
        // controls stay reachable before the field takes focus.
        val fontScale = LocalDensity.current.fontScale
        val wide = LocalConfiguration.current.screenWidthDp >= ChatLayout.WIDE_SCREEN_DP
        val plan = ChatLayout.plan(
            availableHeight = maxHeight,
            imeVisible = WindowInsets.isImeVisible,
            wide = wide,
            fontScale = fontScale,
            reservedHeight = if (searchState.open) searchBarHeight else 0.dp,
        )
        val composerMaxHeight = plan.composerMaxHeight
        val motionEnabled = rememberSystemMotionEnabled()
        CompositionLocalProvider(
            LocalFileLinkBaseDir provides cwd,
            LocalChatMotion provides motionEnabled,
            LocalChatNow provides minuteNow,
            LocalTimeFormatRevision provides timeRevision,
        ) {
            Surface(color = colors.background, modifier = Modifier.fillMaxSize()) {
                Column(Modifier.fillMaxSize()) {
                    if (searchState.open) {
                        ChatSearchBar(
                            state = searchState,
                            // Pre-compaction entries are not part of the loaded
                            // transcript, so the local search cannot find them.
                            olderHistoryHidden = ui.hasCompaction && !ui.engine.includePreCompaction,
                            fullHistoryBusy = ui.engine.pagesLoading || ui.engine.historyLoading,
                            onQueryChange = viewModel::setSearchQuery,
                            onStep = viewModel::stepSearch,
                            onClose = {
                                focusManager.clearFocus()
                                viewModel.closeSearch()
                            },
                            // Loading the full history is what makes the older
                            // entries searchable; the query re-runs by itself.
                            onSearchFullHistory = { viewModel.togglePreCompactionHistory() },
                            modifier = Modifier
                                .padding(horizontal = 8.dp, vertical = 5.dp)
                                .onSizeChanged { size ->
                                    searchBarHeight = with(density) { size.height.toDp() }
                                },
                        )
                    }
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        val compact = LocalConfiguration.current.screenWidthDp < 600
                        LazyColumn(
                            state = listState,
                            modifier = Modifier
                                .fillMaxHeight()
                                .widthIn(max = 900.dp)
                                .fillMaxWidth()
                                .align(Alignment.TopCenter),
                            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                                start = 10.dp,
                                end = 10.dp,
                                top = 8.dp,
                                bottom = 10.dp,
                            ),
                        ) {
                            if (extensionHeaderVisible) {
                                item(key = "extension-header") {
                                    ExtensionStatusBar(controller = viewModel.extensionUi)
                                }
                            }
                            if (compactionNoticeVisible) {
                                item(key = "compaction-notice") {
                                    CompactionNotice(
                                        includePreCompaction = ui.engine.includePreCompaction,
                                        onToggle = viewModel::togglePreCompactionHistory,
                                    )
                                }
                            }
                            // Cache-first: the transcript on screen came from
                            // disk and the server answer is still on its way.
                            // One muted line, no spinner — the cached rows are
                            // readable and the live load replaces them.
                            if (ui.engine.historyStale) {
                                item(key = "history-updating") {
                                    Text(
                                        text = stringResource(R.string.chat_history_updating),
                                        color = colors.textDim,
                                        fontSize = 11.sp,
                                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                                    )
                                }
                            }
                            if (rows.isEmpty() && streaming == null && pending == null) {
                                item(key = "state") {
                                    TranscriptEmptyState(
                                        loading = ui.engine.historyLoading && !ui.engine.historyLoaded,
                                        error = ui.engine.historyError,
                                        onRetry = viewModel::retryHistory,
                                        modifier = Modifier.fillParentMaxSize(),
                                    )
                                }
                            }
                            if (windowStart > 0) {
                                item(key = "earlier") {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clickable { loadEarlier(revealFirstLoaded = true) }
                                            .padding(vertical = 10.dp),
                                        horizontalArrangement = Arrangement.Center,
                                    ) {
                                        Text(
                                            text = if (ui.engine.pagesLoading) stringResource(R.string.chat_earlier_loading)
                                            else stringResource(R.string.chat_earlier),
                                            color = colors.accent,
                                            fontSize = 12.sp,
                                        )
                                    }
                                }
                            }
                            items(
                                count = displayedRows.size,
                                key = { index -> displayedRows[index].key },
                            ) { index ->
                                val row = displayedRows[index]
                                val absoluteIndex = windowStart + index
                                val liveTail = ChatDisplayPrefs.liveTail(
                                    hideToolActivity = ui.preferences.hideToolActivity,
                                    streaming = ui.engine.streamingActive,
                                    isLastGroup = absoluteIndex == rows.lastIndex &&
                                        row is TranscriptRow.Group,
                                )
                                ChatRow(
                                    row = row,
                                    messages = ui.engine.messages,
                                    state = ui,
                                    liveTail = liveTail,
                                    indexByKey = messageIndex,
                                    callbacks = callbacks,
                                    // The last group of a turn that still runs
                                    // keeps the fold informed (live activity,
                                    // counters, elapsed) until it ends.
                                    runningTurn = ui.busy && absoluteIndex == rows.lastIndex &&
                                        row is TranscriptRow.Group,
                                    highlight = when {
                                        row.key == activeHitKey || row.key == flashRowKey ->
                                            ChatRowHighlight.Active
                                        row.key in matchedRowKeys -> ChatRowHighlight.Match
                                        else -> ChatRowHighlight.None
                                    },
                                    headers = transcriptHeaders,
                                    dayBreaks = dayBreaks,
                                )
                            }
                            pending?.let { pendingUser ->
                                item(key = "pending") {
                                    PendingUserBubble(
                                        text = pendingUser.text,
                                        header = transcriptHeaders["pending"],
                                    )
                                }
                            }
                            streaming?.let { message ->
                                item(key = "streaming") {
                                    AssistantRow(
                                        message = message,
                                        state = ui,
                                        forkTarget = null,
                                        streaming = true,
                                        callbacks = callbacks,
                                        header = transcriptHeaders["streaming"],
                                    )
                                }
                            }
                            // The tail anchor: the follow scroll targets this
                            // last, hairline item, so it lands on the very
                            // bottom regardless of the height of the rows above
                            // it (web `messagesEndRef` + `scrollIntoView`).
                            item(key = "tail-anchor") {
                                Spacer(Modifier.height(TRANSCRIPT_TAIL_ANCHOR))
                            }
                        }

                        if (totalItems > 0 && showScrollRail) {
                            ChatScrollRail(
                                listState = listState,
                                totalItems = listState.layoutInfo.totalItemsCount,
                                userTurns = userTurns,
                                modifier = Modifier
                                    .align(Alignment.CenterEnd)
                                    .fillMaxHeight()
                                    .padding(end = 1.dp),
                            )
                        }

                        if (rows.isNotEmpty() && !nearBottom) {
                            FloatingActionButton(
                                onClick = {
                                    followEnabled = true
                                    scope.launch { listState.scrollToTail() }
                                },
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(end = if (compact) 20.dp else 26.dp, bottom = 14.dp),
                                containerColor = colors.panel,
                                contentColor = colors.textMuted,
                                shape = CircleShape,
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.KeyboardArrowDown,
                                    contentDescription = stringResource(R.string.chat_jump_latest),
                                )
                            }
                        }
                    }

                    Box(Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier
                                .align(Alignment.BottomCenter)
                                .widthIn(max = 900.dp)
                                .fillMaxWidth()
                                .padding(horizontal = 8.dp, vertical = 5.dp),
                            verticalArrangement = Arrangement.spacedBy(5.dp),
                        ) {
                            ChatBanners(ui = ui, onRetryHistory = viewModel::retryHistory)
                            ForeignRunBanner(
                                elsewhere = ui.engine.foreignRun,
                                sendAnywayEnabled = composerState.hasContent,
                                onSendAnyway = viewModel::requestForeignSend,
                            )
                            ContentionForkBanner(
                                copy = ui.contentionCopy,
                                onOpen = { id ->
                                    onOpenSession(id)
                                    viewModel.dismissContentionFork()
                                },
                                onDismiss = viewModel::dismissContentionFork,
                            )
                            ExtensionOpenUrlNotice(viewModel.extensionUi)
                            if (ui.notices.isNotEmpty()) {
                                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                    ui.notices.takeLast(5).forEach { notice ->
                                        NoticeBar(notice = notice, onDismiss = { viewModel.dismissNotice(notice) })
                                    }
                                }
                            }
                            ComposerModeStatus(goal = ui.activeGoal, plan = ui.planObjective)
                            CompactBanner(ui.compactResult, ui.compactError)
                            // The attached extension dialog sits above the
                            // panels, inside the composer column (web places it
                            // in the panel stack, not as an overlay).
                            ExtensionDialogHost(viewModel.extensionUi)
                            // Web `ChatWindow`: startup skill-conflict notice
                            // sits above the panels, in normal chat and in the
                            // empty new chat alike.
                            SkillDiagnosticsNotice(
                                snapshot = ui.engine.skillDiagnostics,
                                saving = ui.skillDiagnosticsSaving,
                                failure = ui.skillDiagnosticsFailure,
                                onDisable = { viewModel.setSkillStartupDiagnostics(false) },
                            )
                            // While the keyboard is open on a phone the attached
                            // panels (todo / subagents / btw) step aside: they
                            // are a reading surface, and the transcript needs
                            // the height. Their collapsed state is kept, so they
                            // are back exactly as they were when the IME closes.
                            if (!plan.hidePanels) {
                                ComposerPanels(
                                    todoPhases = ui.engine.todoPhases,
                                    subagents = ui.engine.subagents,
                                    todoCollapsed = ui.todoCollapsed,
                                    subagentsCollapsed = ui.subagentsCollapsed,
                                    onTodoCollapsedChange = viewModel::setTodoCollapsed,
                                    onSubagentsCollapsedChange = viewModel::setSubagentsCollapsed,
                                    onSelectSubagent = { info -> viewModel.openSubagent(info) },
                                    leading = if (btwVisible) {
                                        {
                                            BtwPanel(
                                                vm = viewModel.btw,
                                                onCopy = copyBtwAnswer,
                                                onLink = linkHandler,
                                            )
                                        }
                                    } else {
                                        null
                                    },
                                )
                            }
                            // A modal extension dialog owns the screen; the
                            // composer stays composed (draft/IME) but takes no
                            // space (web hides the input, keeps its state).
                            val composerHidden =
                                composerMinimized || extensionDialog is ExtensionDialogState.Ask
                            // The composer stays composed while minimized (draft,
                            // attachments and a recording survive) but takes no
                            // space, like the web's `display: none`.
                            Box(
                                modifier = if (composerHidden) {
                                    Modifier
                                        .fillMaxWidth()
                                        .height(0.dp)
                                        // TalkBack must not reach controls that are
                                        // visually hidden (web `display: none`).
                                        .clearAndSetSemantics {}
                                } else {
                                    Modifier
                                        .fillMaxWidth()
                                        .heightIn(max = composerMaxHeight)
                                        .verticalScroll(rememberScrollState())
                                },
                            ) {
                                Column(Modifier.fillMaxWidth()) {
                                    if (!composerHidden) {
                                        MinimizeComposerButton(
                                            onMinimize = { composerMinimized = true },
                                            modifier = Modifier.padding(vertical = 2.dp),
                                        )
                                    }
                                    ComposerBar(
                                        composer = viewModel.composer,
                                        controls = viewModel.controls,
                                        dictation = viewModel.dictation,
                                        ghost = viewModel.ghost.collectAsStateWithLifecycle().value,
                                        placeholder = composerPlaceholder,
                                        streaming = ui.busy,
                                        stopping = ui.stopping,
                                        bashRunning = ui.engine.bashRunning,
                                        queue = ui.engine.queue,
                                        autoRetry = ui.engine.autoRetry,
                                        submitDuringRun = ui.submitDuringRun,
                                        submitting = ui.submitPending,
                                        // While the submit waits for the live
                                        // state the field is locked, so the
                                        // routed text cannot be edited away.
                                        inputEnabled = !ui.submitPending,
                                        onSend = {
                                            followEnabled = true
                                            scope.launch { listState.scrollToTail() }
                                            viewModel.submit()
                                        },
                                        onQueue = {
                                            followEnabled = true
                                            viewModel.submit(forceQueue = true)
                                        },
                                        onStop = viewModel::stop,
                                        onAbortRetry = viewModel::abortRetry,
                                        onAcceptGhost = { viewModel.acceptGhost() },
                                        onHistory = viewModel::openHistory,
                                        onQueueEdit = viewModel::editQueued,
                                        onQueueDelete = viewModel::deleteQueued,
                                        onQueueSteer = viewModel::steerQueued,
                                        autoFocus = composerFocusRequested,
                                        onMinimize = { composerMinimized = true },
                                        textFieldMaxHeight = plan.textFieldMaxHeight,
                                        textFieldMaxLines = plan.textFieldMaxLines,
                                        showControlsRow = !plan.hideControlsRow,
                                    )
                                }
                            }
                            if (composerMinimized && extensionDialog !is ExtensionDialogState.Ask) {
                                MinimizedComposerBar(
                                    draftPreview = composerState.text,
                                    hasAttachments = composerState.images.isNotEmpty() ||
                                        composerState.files.isNotEmpty(),
                                    placeholder = composerPlaceholder,
                                    statusText = minimizedStatusText,
                                    streaming = ui.busy,
                                    onExpand = {
                                        composerMinimized = false
                                        composerFocusRequested = true
                                    },
                                    onStop = viewModel::stop,
                                )
                            }
                            ExtensionWidgets(
                                controller = viewModel.extensionUi,
                                placement = ExtensionWidgetPlacement.BelowEditor,
                            )
                            ChatFooter(ui = ui)
                        }
                    }
                }
            }
        }

        ui.branch?.let { branch ->
            BranchNavigatorDialog(
                state = branch,
                onSelect = { leaf -> viewModel.selectLeaf(leaf) },
                onDismiss = viewModel::closeBranchNavigator,
            )
        }
        ui.subagent?.let { dialog ->
            SubagentTranscriptDialog(
                state = dialog,
                githubRepo = ui.githubRepo,
                onLink = linkHandler,
                onToggleTranscript = viewModel::toggleSubagentTranscript,
                onLoadMore = viewModel::loadMoreSubagentTranscript,
                onDismiss = viewModel::closeSubagent,
            )
        }
        BtwHistoryDialog(
            vm = viewModel.btw,
            onCopy = copyBtwAnswer,
            onLink = linkHandler,
        )
        // GAP 1: read-only system prompt panel, opened from the top bar.
        SystemPromptSheet(state = ui.systemPrompt, onDismiss = viewModel::closeSystemPrompt)
        ui.foreignSend?.let {
            ForeignSendDialog(
                onSendAnyway = viewModel::confirmForeignSend,
                onCancel = viewModel::cancelForeignSend,
            )
        }
        // Slice C: the terminal sheet (renders nothing while the controller
        // has no terminal). The dialog and status band live in the layout above.
        ExtensionTerminalPanel(viewModel.extensionUi)
    }
}

// ------------------------------------------------------------------ helpers

/** The transcript tail in pixels; see [TailMeasure]. */
private fun LazyListState.tailMeasure(): TailMeasure {
    val info = layoutInfo
    val last = info.visibleItemsInfo.lastOrNull()
    return TailMeasure(
        totalItems = info.totalItemsCount,
        lastVisibleIndex = last?.index ?: -1,
        lastVisibleEnd = last?.let { it.offset + it.size } ?: 0,
        viewportEnd = info.viewportEndOffset,
    )
}

/**
 * Jump to the transcript's tail anchor (the hairline spacer that is always the
 * last item). Its item start is the end of the content, so the request is
 * clamped to the maximum scroll offset — the list lands on the very bottom of
 * whatever the rows above it measured to, with no separate delta pass that
 * would read a stale layout.
 */
private suspend fun LazyListState.scrollToTail() {
    val total = layoutInfo.totalItemsCount
    if (total == 0) return
    scrollToItem(total - 1)
}

// ------------------------------------------------------------------ pieces

@Composable
private fun TranscriptEmptyState(
    loading: Boolean,
    error: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    Box(modifier = modifier, contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(24.dp),
        ) {
            when {
                loading -> {
                    CircularProgressIndicator(strokeWidth = 2.dp, color = colors.accent)
                    Text(stringResource(R.string.chat_loading), color = colors.textMuted, fontSize = 13.sp)
                }

                error != null -> {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = colors.statusError,
                    )
                    Text(stringResource(R.string.chat_load_failed), color = colors.text, fontSize = 14.sp)
                    Text(
                        text = error,
                        color = colors.textDim,
                        fontSize = 12.sp,
                        textAlign = TextAlign.Center,
                    )
                    TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
                }

                else -> {
                    Text(stringResource(R.string.chat_empty_title), color = colors.text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    Text(
                        text = stringResource(R.string.chat_empty_hint),
                        color = colors.textDim,
                        fontSize = 12.5.sp,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}

@Composable
private fun NoticeBar(notice: ChatNotice, onDismiss: () -> Unit) {
    val colors = LocalOmpColors.current
    val tone = when (notice.kind) {
        NoticeKind.Error -> colors.statusError
        NoticeKind.Warning -> colors.statusWarning
        NoticeKind.Info -> colors.accent
    }
    LaunchedEffect(notice) {
        kotlinx.coroutines.delay(if (notice.kind == NoticeKind.Error) 30_000L else 5_000L)
        onDismiss()
    }
    Surface(
        color = tone.copy(alpha = 0.10f),
        contentColor = tone,
        shape = RoundedCornerShape(7.dp),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite }
            .border(1.dp, tone.copy(alpha = 0.35f), RoundedCornerShape(7.dp)),
    ) {
        Row(
            modifier = Modifier.padding(start = 9.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = notice.message,
                fontSize = 11.5.sp,
                modifier = Modifier.weight(1f),
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            IconButton(onClick = onDismiss) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.chat_dismiss), modifier = Modifier.size(14.dp))
            }
        }
    }
}

@Composable
internal fun ChatBanners(
    ui: ChatUiState,
    onRetryHistory: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val engine = ui.engine
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        engine.autoRetry?.let { retry ->
            val attempt = listOfNotNull(retry.attempt?.let { "attempt $it" }, retry.maxAttempts?.let { "of $it" })
                .joinToString(" ")
            BannerRow(
                text = listOfNotNull(
                    if (attempt.isNotEmpty()) stringResource(R.string.chat_banner_retrying, attempt)
                    else stringResource(R.string.chat_banner_retrying_plain),
                    retry.message,
                ).joinToString(" — "),
                tone = colors.statusWarning,
                action = null,
                onAction = {},
            )
        }
        if (ui.connection != ConnectionState.Connected) {
            BannerRow(
                text = when (ui.connection) {
                    ConnectionState.Reconnecting -> stringResource(R.string.chat_banner_reconnecting)
                    ConnectionState.Offline -> stringResource(R.string.chat_banner_offline)
                    ConnectionState.Connected -> ""
                },
                tone = colors.statusWarning,
                action = null,
                onAction = {},
            )
        }
        engine.error?.takeIf { it.isNotBlank() }?.let { error ->
            BannerRow(
                text = error,
                tone = colors.statusError,
                action = null,
                onAction = {},
            )
        }
        engine.historyError?.takeIf { it.isNotBlank() && engine.historyLoaded }?.let { error ->
            BannerRow(
                text = error,
                tone = colors.statusError,
                action = stringResource(R.string.chat_retry),
                onAction = onRetryHistory,
            )
        }
    }
}

/**
 * Web `ChatWindow`'s compacted-history notice. It is the transcript's own row
 * (rendered inside the scroll container, above the first message), so it
 * scrolls away with the messages instead of pinning above the composer.
 */
@Composable
internal fun CompactionNotice(includePreCompaction: Boolean, onToggle: () -> Unit) {
    BannerRow(
        text = stringResource(
            if (includePreCompaction) {
                R.string.chat_branch_banner_pre_shown
            } else {
                R.string.chat_branch_banner_compacted
            },
        ),
        tone = LocalOmpColors.current.textMuted,
        action = stringResource(
            if (includePreCompaction) {
                R.string.chat_branch_hide_earlier
            } else {
                R.string.chat_branch_show_earlier
            },
        ),
        onAction = onToggle,
    )
}

/**
 * Web `ComposerModeStatus`: the running goal (expandable, elapsed time) and…
 * plan banner for a `/plan` turn. Both are status-only, never interactive work.
 */
@Composable
internal fun ComposerModeStatus(goal: ActiveGoal?, plan: String?) {
    if (goal == null && plan == null) return
    val colors = LocalOmpColors.current
    var expanded by remember(goal?.startedAt, goal?.objective) { mutableStateOf(false) }
    var now by remember(goal?.startedAt) { mutableStateOf(System.currentTimeMillis()) }
    // The elapsed label is minute-granular; a 30 s tick keeps it honest.
    LaunchedEffect(goal?.startedAt) {
        if (goal == null) return@LaunchedEffect
        while (true) {
            now = System.currentTimeMillis()
            kotlinx.coroutines.delay(30_000L)
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (goal != null) {
            Surface(
                color = colors.accent.copy(alpha = 0.07f),
                contentColor = colors.text,
                shape = RoundedCornerShape(6.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, colors.accent.copy(alpha = 0.32f)),
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(
                        role = Role.Button,
                        onClickLabel = stringResource(
                            if (expanded) R.string.panels_goal_collapse else R.string.panels_goal_expand,
                        ),
                        onClick = { expanded = !expanded },
                    ),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                    verticalAlignment = if (expanded) Alignment.Top else Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = stringResource(R.string.panels_goal_active) + " · " +
                            formatGoalElapsed(now - goal.startedAt),
                        color = colors.textDim,
                        fontSize = 10.sp,
                        fontFamily = OmpMonoFontFamily,
                    )
                    Text(
                        text = goal.objective,
                        color = colors.text,
                        fontSize = 12.sp,
                        maxLines = if (expanded) Int.MAX_VALUE else 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        if (plan != null) {
            Surface(
                color = colors.panel,
                contentColor = colors.textMuted,
                shape = RoundedCornerShape(6.dp),
                border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    Icon(
                        imageVector = Icons.Filled.List,
                        contentDescription = null,
                        tint = colors.accent,
                        modifier = Modifier.size(14.dp),
                    )
                    Text(
                        text = stringResource(R.string.panels_plan_in_progress),
                        color = colors.textMuted,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = plan,
                        color = colors.textDim,
                        fontSize = 11.5.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

/**
 * Web `foreignRun` banner: another omp process owns this chat, so the send is
 * held back. The text stays in the composer and the transcript keeps
 * following the file; "send anyway" is the only way into a copy.
 *
 * [ElsewhereKind] names the owner, [ElsewhereSource] is not shown on purpose:
 * a user cares who runs the chat, not how the server proved it (the
 * confirmation dialog covers the weak-evidence case).
 */
@Composable
internal fun ForeignRunBanner(
    elsewhere: ElsewhereSession?,
    sendAnywayEnabled: Boolean,
    onSendAnyway: () -> Unit,
) {
    if (elsewhere == null) return
    val colors = LocalOmpColors.current
    val body = stringResource(
        when (elsewhereKind(elsewhere.kind)) {
            ElsewhereKind.OmpWeb -> R.string.composer_elsewhere_body_omp_web
            ElsewhereKind.Terminal -> R.string.composer_elsewhere_body_terminal
            ElsewhereKind.Unknown -> R.string.composer_elsewhere_body_unknown
        },
    )
    Surface(
        color = colors.statusWarning.copy(alpha = 0.08f),
        contentColor = colors.text,
        shape = RoundedCornerShape(6.dp),
        border = BorderStroke(1.dp, colors.statusWarning.copy(alpha = 0.35f)),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Row(
            modifier = Modifier.padding(start = 9.dp, end = 3.dp, top = 5.dp, bottom = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.Warning,
                contentDescription = null,
                tint = colors.statusWarning,
                modifier = Modifier.size(14.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.composer_elsewhere_title),
                    color = colors.statusWarning,
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = body,
                    color = colors.textMuted,
                    fontSize = 11.sp,
                )
            }
            TextButton(onClick = onSendAnyway, enabled = sendAnywayEnabled) {
                Text(
                    text = stringResource(R.string.composer_elsewhere_send_anyway),
                    fontSize = 11.sp,
                    color = if (sendAnywayEnabled) colors.accent else colors.textDim,
                )
            }
        }
    }
}

/**
 * Web `session_contention_fork` notice: a send raced the other owner, so omp
 * continued the conversation in a copy with a new id. The copy holds the text;
 * this banner keeps both chats reachable (the original stayed with the other
 * process). Persistent until opened or dismissed, because a fork is never
 * routine.
 */
@Composable
internal fun ContentionForkBanner(
    copy: ContentionCopy?,
    onOpen: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    if (copy == null) return
    val colors = LocalOmpColors.current
    Surface(
        color = colors.statusWarning.copy(alpha = 0.08f),
        contentColor = colors.text,
        shape = RoundedCornerShape(6.dp),
        border = BorderStroke(1.dp, colors.statusWarning.copy(alpha = 0.35f)),
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Column(
            modifier = Modifier.padding(start = 9.dp, end = 3.dp, top = 5.dp, bottom = 3.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    tint = colors.statusWarning,
                    modifier = Modifier.size(14.dp),
                )
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(R.string.composer_contention_title),
                        color = colors.statusWarning,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = stringResource(R.string.composer_contention_body),
                        color = colors.textMuted,
                        fontSize = 11.sp,
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = { onOpen(copy.originalId) }) {
                    Text(
                        text = stringResource(R.string.composer_contention_open_original),
                        fontSize = 11.sp,
                        color = colors.accent,
                    )
                }
                copy.copyId?.let { copyId ->
                    TextButton(onClick = { onOpen(copyId) }) {
                        Text(
                            text = stringResource(R.string.composer_contention_open_copy),
                            fontSize = 11.sp,
                            color = colors.accent,
                        )
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text(
                        text = stringResource(R.string.composer_contention_dismiss),
                        fontSize = 11.sp,
                        color = colors.textMuted,
                    )
                }
            }
        }
    }
}

/**
 * The confirmation before a send into a chat another omp process owns: omp
 * moves the chat to a copy with a new id on the first write, and that must be
 * a deliberate choice. "Keep reading" is the safe default.
 */
@Composable
internal fun ForeignSendDialog(
    onSendAnyway: () -> Unit,
    onCancel: () -> Unit,
) {
    OmpAlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.composer_elsewhere_confirm_title)) },
        text = { Text(stringResource(R.string.composer_elsewhere_confirm_body)) },
        confirmButton = {
            TextButton(onClick = onSendAnyway) {
                Text(stringResource(R.string.composer_elsewhere_confirm_send))
            }
        },
        dismissButton = {
            TextButton(onClick = onCancel) {
                Text(stringResource(R.string.composer_elsewhere_confirm_cancel))
            }
        },
    )
}

/** Web `compactResult` / `compactError`: transient banners (6 s / 3 s). */
@Composable
private fun CompactBanner(result: CompactResult?, error: String?) {
    val colors = LocalOmpColors.current
    if (result != null) {
        val reason = result.reason
        val verb = if (reason.isNotBlank() && reason != "manual") {
            stringResource(
                R.string.panels_compacted_with_reason,
                reason.replaceFirstChar { it.uppercase() },
            )
        } else {
            stringResource(R.string.panels_compacted)
        }
        val saved = (result.tokensBefore - result.estimatedTokensAfter).coerceAtLeast(0L)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.statusSuccess.copy(alpha = 0.08f), RoundedCornerShape(6.dp))
                .padding(horizontal = 9.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.CheckCircle,
                contentDescription = null,
                tint = colors.statusSuccess,
                modifier = Modifier.size(12.dp),
            )
            Text(
                text = stringResource(
                    R.string.panels_compact_result,
                    verb,
                    result.tokensBefore,
                    result.estimatedTokensAfter,
                    saved,
                ),
                color = colors.statusSuccess,
                fontSize = 11.5.sp,
            )
        }
    }
    if (error != null) {
        BannerRow(
            text = stringResource(R.string.panels_compact_error, error),
            tone = colors.statusError,
            action = null,
            onAction = {},
        )
    }
}

@Composable
private fun BannerRow(text: String, tone: androidx.compose.ui.graphics.Color, action: String?, onAction: () -> Unit) {
    if (text.isBlank()) return
    val colors = LocalOmpColors.current
    Surface(
        color = tone.copy(alpha = 0.08f),
        contentColor = tone,
        shape = RoundedCornerShape(6.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { liveRegion = LiveRegionMode.Polite }
                .padding(start = 9.dp, end = 3.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(text, fontSize = 11.5.sp, modifier = Modifier.weight(1f))
            if (action != null) {
                TextButton(onClick = onAction) {
                    Text(action, fontSize = 11.sp, color = colors.accent)
                }
            }
        }
    }
}

@Composable
private fun phaseStatusText(label: PhaseLabel?): String? = when (label?.kind) {
    null -> null
    PhaseLabelKind.Compacting -> stringResource(R.string.chat_status_compacting)
    PhaseLabelKind.WaitingModel -> stringResource(R.string.chat_phase_waiting_model)
    PhaseLabelKind.RunningTools -> if (label.more > 0) {
        stringResource(
            R.string.chat_phase_running_tools_more,
            label.tools.joinToString(", "),
            label.more,
        )
    } else {
        stringResource(
            R.string.chat_phase_running_tools,
            label.tools.joinToString(", "),
        )
    }
    PhaseLabelKind.RunningCommand -> stringResource(R.string.chat_phase_running_command)
    PhaseLabelKind.Working -> stringResource(R.string.chat_status_working)
}

/**
 * The status line under the composer. It only carries what the composer
 * controls row does not already show: model, thinking level and context usage
 * are on that row (picker, level, context ring), so repeating them here was a
 * second, stale-looking copy of the same facts (web `ChatInput`'s `statusText`
 * and the footer make the same split).
 */
@Composable
internal fun ChatFooter(ui: ChatUiState) {
    val colors = LocalOmpColors.current
    val engine = ui.engine
    val running = engine.busy || engine.streamingActive
    // Cached history on screen and no live word yet: without this line the
    // footer looks idle ("nothing runs") while the client is still connecting.
    val connecting = chatShowsConnecting(
        liveStateKnown = engine.liveStateKnown,
        hasTranscript = engine.historyStale || engine.messages.isNotEmpty(),
    )
    val startedAt = remember(
        running,
        engine.runStartedAt,
        engine.liveTools,
        engine.messages,
    ) { if (running) TranscriptFormat.turnStartedAt(engine) else null }
    val parts = buildList {
        if (connecting) add(stringResource(R.string.chat_status_connecting))
        val status = phaseStatusText(phaseLabel(engine))
        if (status != null) add(status)
        if (engine.pagesLoading) add(stringResource(R.string.chat_status_pages))
    }
    // The rate is visual only: it is kept out of the polite live region so a
    // screen reader does not announce a new number twice a second.
    val speedText = if (running) {
        engine.liveTokensPerSecond?.let {
            stringResource(R.string.chat_tokens_per_second, formatGenerationRate(it))
        }
    } else {
        null
    }
    // The turn duration reads the shared tick in its own composable, so the
    // footer's other lines do not recompose every second.
    val showElapsed = running && startedAt != null
    val queued = engine.queue.steering.size + engine.queue.followUp.size
    if (parts.isEmpty() && !showElapsed && queued == 0 && ui.speakingId == null && speedText == null) return
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (connecting) {
            CircularProgressIndicator(
                modifier = Modifier.size(10.dp),
                strokeWidth = 1.5.dp,
                color = colors.textDim,
            )
            Spacer(Modifier.width(5.dp))
        } else if (running && (parts.isNotEmpty() || showElapsed)) {
            LivePulseDot(size = 6.dp)
            Spacer(Modifier.width(5.dp))
        }
        if (parts.isNotEmpty()) {
            Text(
                text = parts.joinToString(" · "),
                color = colors.textDim,
                fontSize = 10.sp,
                fontFamily = OmpMonoFontFamily,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (speedText != null) {
            Text(
                text = (if (parts.isEmpty()) "" else " · ") + speedText,
                color = colors.textDim,
                fontSize = 10.sp,
                fontFamily = OmpMonoFontFamily,
                maxLines = 1,
                modifier = Modifier.clearAndSetSemantics {},
            )
        }
        ElapsedText(
            startedAt = startedAt,
            running = running,
            prefix = if (parts.isEmpty() && speedText == null) "" else " · ",
            color = colors.textDim,
            fontSize = 10.sp,
        )
        Spacer(Modifier.weight(1f))
        if (queued > 0) {
            Text(
                text = stringResource(R.string.chat_queued, queued),
                color = colors.textDim,
                fontSize = 10.sp,
            )
        }
        if (ui.speakingId != null) {
            Text(
                text = stringResource(R.string.chat_reading_aloud),
                color = colors.accent,
                fontSize = 10.sp,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}
