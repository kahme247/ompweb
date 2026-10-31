package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.MoreVert
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.displayCwd
import io.github.kahme247.ompweb.domain.projectPathLabel
import io.github.kahme247.ompweb.net.SessionInfo
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.ui.chat.ChatScreen
import io.github.kahme247.ompweb.ui.chat.ChatViewModel
import io.github.kahme247.ompweb.ui.chat.SystemPromptIcon
import io.github.kahme247.ompweb.ui.chat.SystemPromptState
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu

/**
 * Header and metadata of the open session. Phase 5 owns the transcript below
 * this header; the pane therefore shows everything the session detail API
 * knows (project, cwd, branch/worktree, model, timestamps, fork parent) plus
 * every session action.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionDetailPane(
    state: SessionsUiState,
    summary: SessionSummary?,
    compact: Boolean,
    onBack: () -> Unit,
    onSelectParent: (String) -> Unit,
    onRetry: () -> Unit,
    onRename: () -> Unit,
    onAutoName: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
    onCopyTranscript: () -> Unit,
    onExport: () -> Unit,
    onShare: () -> Unit,
    onCopyId: () -> Unit,
    chatViewModel: ChatViewModel,
    onForkedSession: (String) -> Unit,
    onChatError: (String) -> Unit,
    /** The header's Files button (Phase 9 panel). */
    onOpenFiles: () -> Unit,
    /** A transcript file link: the shell's Files panel opens the tab. */
    onOpenFile: (path: String, line: Int?) -> Unit,
    /** The shell's update announcement, shown below this pane's top bar. */
    updateBanner: @Composable () -> Unit = {},
) {
    val detail = state.detail
    val info = detail?.info
    val title = info?.name?.takeIf { it.isNotBlank() }
        ?: summary?.title()
        ?: stringResource(R.string.session_untitled)
    var menuOpen by remember { mutableStateOf(false) }
    var detailsOpen by remember { mutableStateOf(false) }
    val chat by chatViewModel.ui.collectAsStateWithLifecycle()
    val chatSearch by chatViewModel.search.collectAsStateWithLifecycle()
    val colors = LocalOmpColors.current
    val selectedId = info?.id ?: state.selectedSessionId
    // A4: the web's project / cwd / branch context next to the title. The
    // detail's branch wins over the summary's worktree branch because the
    // open session's checked-out branch is the current one.
    val breadcrumb = (info ?: summary?.asSessionInfo())?.let {
        sessionBreadcrumb(it, state.projects, state.home, branch = detail?.branch)
    }
    // A5: the header reports exactly this session's auto-name attempt.
    val autoName = state.autoName.takeIf { it.sessionId == selectedId }
    val naming = autoName?.phase == AutoNamePhase.Naming
    val messageCount = info?.messageCount ?: summary?.messageCount ?: 0

    Scaffold(
        topBar = {
            TopAppBar(
                title = { SessionHeaderTitle(title = title, breadcrumb = breadcrumb) },
                navigationIcon = {
                    if (compact) {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                                contentDescription = stringResource(R.string.nav_back),
                            )
                        }
                    }
                },
                actions = {
                    when (autoName?.phase) {
                        AutoNamePhase.Naming -> CircularProgressIndicator(
                            strokeWidth = 1.5.dp,
                            modifier = Modifier
                                .padding(horizontal = 8.dp)
                                .size(16.dp)
                                .testTag("auto-name-progress"),
                        )
                        AutoNamePhase.Success -> Icon(
                            imageVector = Icons.Filled.Check,
                            contentDescription = stringResource(R.string.session_auto_name_done),
                            tint = colors.statusSuccess,
                            modifier = Modifier
                                .padding(horizontal = 8.dp)
                                .size(16.dp)
                                .testTag("auto-name-ok"),
                        )
                        AutoNamePhase.Error -> Icon(
                            imageVector = Icons.Filled.Warning,
                            contentDescription = stringResource(R.string.session_auto_name_failed),
                            tint = colors.statusError,
                            modifier = Modifier
                                .padding(horizontal = 8.dp)
                                .size(16.dp)
                                .testTag("auto-name-error"),
                        )
                        else -> Unit
                    }
                    if (chat.branchHasBranch) {
                        TextButton(onClick = chatViewModel::openBranchNavigator) {
                            Text(stringResource(R.string.detail_branches))
                        }
                    }
                    // Web `AppShell`: the terminal button opens the session's
                    // system prompt and stays highlighted while it is open.
                    IconButton(onClick = chatViewModel::openSystemPrompt) {
                        Icon(
                            imageVector = SystemPromptIcon,
                            contentDescription = stringResource(R.string.system_prompt_title),
                            tint = if (chat.systemPrompt is SystemPromptState.Idle) {
                                LocalContentColor.current
                            } else {
                                colors.accent
                            },
                        )
                    }
                    // In-chat search (Slice: message search stays in the
                    // transcript); the same ChatViewModel instance is used by
                    // the chat pane below.
                    IconButton(onClick = chatViewModel::toggleSearch) {
                        Icon(
                            imageVector = Icons.Filled.Search,
                            contentDescription = stringResource(R.string.chat_search_open),
                            tint = if (chatSearch.open) colors.accent else LocalContentColor.current,
                        )
                    }
                    IconButton(onClick = onOpenFiles) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.List,
                            contentDescription = stringResource(R.string.files_open_in_session),
                        )
                    }
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(
                            imageVector = Icons.Filled.MoreVert,
                            contentDescription = stringResource(R.string.detail_actions),
                        )
                    }
                    OmpDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.detail_session_details)) },
                            onClick = { menuOpen = false; detailsOpen = true },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_rename)) },
                            onClick = { menuOpen = false; onRename() },
                        )
                        DropdownMenuItem(
                            text = {
                                Text(
                                    stringResource(
                                        if (naming) R.string.session_auto_name_running
                                        else R.string.session_auto_name,
                                    ),
                                )
                            },
                            enabled = !naming && messageCount > 0,
                            onClick = { menuOpen = false; onAutoName() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_archive)) },
                            onClick = { menuOpen = false; onArchive() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_copy_transcript)) },
                            onClick = { menuOpen = false; onCopyTranscript() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_export)) },
                            onClick = { menuOpen = false; onExport() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_share)) },
                            onClick = { menuOpen = false; onShare() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_copy_id)) },
                            onClick = { menuOpen = false; onCopyId() },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.session_delete)) },
                            onClick = { menuOpen = false; onDelete() },
                        )
                    }
                },
            )
        },
    ) { innerPadding ->
        val sessionId = info?.id ?: state.selectedSessionId
        val cwd = info?.cwd?.takeIf { it.isNotBlank() }
            ?: summary?.cwd?.takeIf { it.isNotBlank() }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            // Below this pane's top bar, above the transcript: the banner used
            // to float over the bar and covered its actions.
            updateBanner()
            Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
                if (sessionId != null) {
                    // The transcript owns the body; session metadata lives in the
                    // "Session details" dialog reached from the overflow menu.
                    ChatScreen(
                        sessionId = sessionId,
                        cwd = cwd,
                        viewModel = chatViewModel,
                        onForked = onForkedSession,
                        onError = onChatError,
                        onOpenFile = onOpenFile,
                        // The header's parent link already opens a session by
                        // id; the "continued in a copy" banner needs exactly
                        // that (open the original of a contention fork).
                        onOpenSession = onSelectParent,
                        // The list already knows when another omp process owns
                        // this chat; the screen paints that in the composer
                        // without waiting for its own state read.
                        elsewhere = state.elsewhere[sessionId],
                        modifier = Modifier.fillMaxSize(),
                    )
                } else if (state.detailLoading) {
                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                } else {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(24.dp),
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
            }
        }
        if (detailsOpen) {
            SessionDetailsDialog(
                state = state,
                detail = detail,
                info = info,
                summary = summary,
                loading = state.detailLoading && detail == null,
                failed = state.detailError != null && detail == null,
                onRetry = onRetry,
                onSelectParent = onSelectParent,
                onDismiss = { detailsOpen = false },
            )
        }
    }
}

/**
 * The detail header's title line: the session title plus the project / cwd /
 * branch breadcrumb (A4). Extracted so the golden matrix renders exactly the
 * line the pane ships and the compose test can assert its text.
 */
@Composable
internal fun SessionHeaderTitle(title: String, breadcrumb: SessionBreadcrumb?) {
    val colors = LocalOmpColors.current
    Column {
        Text(
            text = title,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.semantics { heading() },
        )
        if (breadcrumb != null && !breadcrumb.isEmpty) {
            Text(
                text = breadcrumb.text,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.testTag("session-breadcrumb"),
            )
        }
    }
}

@Composable
private fun SessionDetailsDialog(
    state: SessionsUiState,
    detail: SessionDetailView?,
    info: SessionInfo?,
    summary: SessionSummary?,
    loading: Boolean,
    failed: Boolean,
    onRetry: () -> Unit,
    onSelectParent: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val title = info?.name?.takeIf { it.isNotBlank() }
        ?: summary?.title()
        ?: stringResource(R.string.session_untitled)
    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
        text = {
            Box(modifier = Modifier.heightIn(max = 460.dp)) {
                when {
                    loading -> Box(
                        modifier = Modifier.fillMaxWidth().height(120.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }

                    failed -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            text = stringResource(R.string.detail_load_failed),
                            color = colors.statusError,
                        )
                        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
                    }

                    info != null -> Column(
                        modifier = Modifier.verticalScroll(rememberScrollState()),
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (info.id in state.runningIds) {
                                StatusPill(
                                    text = stringResource(R.string.session_running),
                                    color = colors.statusSuccess,
                                )
                            }
                            if (info.id in state.exited) {
                                StatusPill(
                                    text = stringResource(R.string.session_exited),
                                    color = colors.statusWarning,
                                )
                            }
                            if (info.id in state.unreadIds) {
                                StatusPill(
                                    text = stringResource(R.string.session_unread),
                                    color = colors.accent,
                                )
                            }
                            Text(
                                text = stringResource(R.string.detail_messages, info.messageCount),
                                style = MaterialTheme.typography.labelMedium,
                                color = colors.textDim,
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                        DetailField(
                            label = stringResource(R.string.detail_cwd),
                            value = displayCwd(info.cwd, state.home),
                            mono = true,
                        )
                        val projectPath = info.projectRoot
                            ?: state.projects.firstOrNull {
                                it.path == info.projectKey || info.cwd.startsWith(it.path)
                            }?.path
                        if (projectPath != null) {
                            DetailField(
                                label = stringResource(R.string.detail_project),
                                value = projectPathLabel(projectPath),
                            )
                        }
                        detail?.branch?.takeIf { it.isNotBlank() }?.let { branch ->
                            DetailField(label = stringResource(R.string.detail_branch), value = branch)
                        }
                        detail?.currentWorktreePath?.let { worktree ->
                            if (detail.projectRoot != null && worktree != detail.projectRoot) {
                                DetailField(
                                    label = stringResource(R.string.detail_worktree),
                                    value = worktree,
                                    mono = true,
                                )
                            }
                        }
                        detail?.model?.let {
                            DetailField(label = stringResource(R.string.detail_model), value = it)
                        }
                        detail?.thinkingLevel?.takeIf { it.isNotBlank() }?.let { level ->
                            DetailField(label = stringResource(R.string.detail_thinking), value = level)
                        }
                        parseTimestamp(info.created)?.let { created ->
                            DetailField(label = stringResource(R.string.detail_created), value = absoluteDate(created))
                        }
                        parseTimestamp(info.modified)?.let { modified ->
                            DetailField(label = stringResource(R.string.detail_updated), value = absoluteDate(modified))
                        }
                        info.parentSessionId?.let { parentId ->
                            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                            val parentTitle = state.sessions.firstOrNull { it.id == parentId }?.title()
                                ?: parentId.take(12)
                            TextButton(onClick = { onDismiss(); onSelectParent(parentId) }) {
                                Text(
                                    text = stringResource(R.string.session_fork_of, parentTitle),
                                    color = colors.accent,
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) }
        },
    )
}

@Composable
private fun DetailField(label: String, value: String, mono: Boolean = false) {
    val colors = LocalOmpColors.current
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = colors.textDim,
        )
        Text(
            text = value,
            style = if (mono) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = colors.text,
        )
    }
}

@Composable
private fun StatusPill(text: String, color: androidx.compose.ui.graphics.Color) {
    Surface(
        color = color.copy(alpha = 0.15f),
        contentColor = color,
        shape = RoundedCornerShape(999.dp),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
        )
    }
}

/** The summary carries the fields the breadcrumb needs (no detail loaded yet). */
private fun SessionSummary.asSessionInfo(): SessionInfo = SessionInfo(
    id = id,
    cwd = cwd,
    name = name,
    messageCount = messageCount,
    parentSessionId = parentSessionId,
    projectRoot = projectRoot,
    projectKey = projectKey,
    worktreeBranch = worktreeBranch,
)
