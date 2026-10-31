package io.github.kahme247.ompweb.ui.files

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.fileName
import io.github.kahme247.ompweb.domain.relativeFilePath
import io.github.kahme247.ompweb.ui.git.GitChangesPane
import io.github.kahme247.ompweb.ui.git.GitChangesViewModel
import io.github.kahme247.ompweb.ui.hosttools.openExternalUrl
import io.github.kahme247.ompweb.ui.render.GithubRepoRef
import io.github.kahme247.ompweb.ui.render.LinkTarget
import io.github.kahme247.ompweb.ui.render.copyTextToClipboard
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu
import io.github.kahme247.ompweb.ui.worktrees.WorktreesPane
import io.github.kahme247.ompweb.ui.worktrees.WorktreesViewModel
import io.github.kahme247.ompweb.ui.worktrees.rememberWorktreeActions
import kotlinx.coroutines.launch

/**
 * The right panel (web `components/RightPanel.tsx` + `components/TabBar.tsx`):
 * the Explorer/Git/Worktrees tabs, the optional Notifications tab on phones
 * and one tab per open file.
 *
 * The panel is pure layout plus the device plumbing a host cannot do for it
 * (SAF save, share sheet, clipboard toast); every server call stays in
 * [FilesViewModel] and Slice B's view models. The shell decides whether it is
 * the third pane or a full-screen sheet, and passes the active composer's
 * mention target in [onMention].
 */
@Composable
fun FilePanel(
    vm: FilesViewModel,
    gitChanges: GitChangesViewModel,
    worktrees: WorktreesViewModel,
    onMention: (String) -> Unit,
    onClose: () -> Unit,
    githubRepo: GithubRepoRef? = null,
    notifications: (@Composable () -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val worktreeState by worktrees.state.collectAsStateWithLifecycle()
    val worktreeActions = rememberWorktreeActions(worktrees)
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val pathCopiedText = stringResource(R.string.files_path_copied)
    val copyFailedText = stringResource(R.string.toast_copy_failed)
    val savedText = stringResource(R.string.files_download_saved)
    val saveFailedText = stringResource(R.string.files_download_failed)
    val shareFailedText = stringResource(R.string.files_share_failed)

    fun copyPath(text: String) {
        val copied = copyTextToClipboard(context, "file path", text)
        Toast.makeText(context, if (copied) pathCopiedText else copyFailedText, Toast.LENGTH_SHORT).show()
    }

    var pendingSave by remember { mutableStateOf<Pair<String, String?>?>(null) }
    val saveLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.CreateDocument("*/*"),
    ) { uri ->
        val target = pendingSave
        pendingSave = null
        if (uri == null || target == null) return@rememberLauncherForActivityResult
        scope.launch {
            val bytes = runCatching { vm.fileBytes(target.first, target.second) }.getOrNull()
            val saved = bytes != null && FileTransfer.writeToUri(context, uri, bytes)
            Toast.makeText(context, if (saved) savedText else saveFailedText, Toast.LENGTH_SHORT).show()
        }
    }

    fun save(path: String, sessionId: String?) {
        pendingSave = path to sessionId
        saveLauncher.launch(fileName(path))
    }

    fun share(path: String, sessionId: String?, binaryMime: String?) {
        scope.launch {
            val bytes = runCatching { vm.fileBytes(path, sessionId) }.getOrNull()
            val shared = bytes != null && FileTransfer.share(
                context = context,
                fileName = fileName(path),
                mimeType = FileTransfer.mimeForPath(path, binaryMime),
                bytes = bytes,
            )
            if (!shared) Toast.makeText(context, shareFailedText, Toast.LENGTH_SHORT).show()
        }
    }

    val cwd = state.explorer.cwd
    val linkHandler: (LinkTarget) -> Unit = { target ->
        when (target) {
            is LinkTarget.File -> vm.openTab(target.path, line = target.line, cwd = cwd)

            is LinkTarget.External -> openExternalUrl(context, target.url)

            is LinkTarget.GithubIssue -> {
                val owner = target.owner.ifEmpty { githubRepo?.owner.orEmpty() }
                val repo = target.repo.ifEmpty { githubRepo?.repo.orEmpty() }
                if (owner.isNotEmpty() && repo.isNotEmpty()) {
                    openExternalUrl(context, "https://github.com/$owner/$repo/issues/${target.number}")
                }
            }

            is LinkTarget.Agent, is LinkTarget.Inert -> Unit
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .background(colors.background),
    ) {
        FilePanelHeader(
            tabs = state.tabs,
            activeTabId = state.activeTabId,
            onClose = onClose,
            onCloseOthers = vm::closeOtherTabs,
            onCloseAll = vm::closeAllTabs,
        )
        FileTabStrip(
            view = state.view,
            tabs = state.tabs,
            activeTabId = state.activeTabId,
            hasNotifications = notifications != null,
            onSelectView = vm::setView,
            onSelectTab = vm::selectTab,
            onCloseTab = vm::closeTab,
        )
        HorizontalDivider(color = colors.border)

        when (val view = state.view) {
            FilesPanelView.Explorer -> FileExplorerPane(
                state = state.explorer,
                vm = vm,
                onOpenFile = { path -> vm.openTab(path, cwd = cwd) },
                onMention = onMention,
                onCopyPath = { path -> copyPath(path) },
                onDownload = { path -> save(path, null) },
                onShare = { path -> share(path, null, null) },
            )

            FilesPanelView.Git -> GitChangesPane(
                cwd = cwd,
                onOpenFile = { path, mode -> vm.openTab(path, mode = mode, cwd = cwd) },
                viewModel = gitChanges,
            )

            FilesPanelView.Worktrees -> WorktreesPane(
                context = worktreeState,
                actions = worktreeActions,
            )

            FilesPanelView.Notifications -> {
                if (notifications != null) {
                    Box(Modifier.fillMaxSize()) { notifications() }
                } else {
                    // Formerly a phone tab; a wide layout has no Notifications tab.
                    LaunchedEffect(Unit) { vm.setView(FilesPanelView.Explorer) }
                }
            }

            FilesPanelView.File -> {
                val tab = state.activeTab
                if (tab == null) {
                    LaunchedEffect(Unit) { vm.setView(FilesPanelView.Explorer) }
                } else {
                    FileViewerPane(
                        tab = tab,
                        cwd = cwd,
                        githubRepo = githubRepo,
                        vm = vm,
                        onLink = linkHandler,
                        onMention = onMention,
                        onCopyPath = { copyPath(relativeFilePath(tab.path, cwd).ifEmpty { tab.path }) },
                        onDownload = { path -> save(path, tab.sourceSessionId) },
                        onShare = { path -> share(path, tab.sourceSessionId, tab.binaryMime) },
                        onReveal = { vm.reveal(tab.path) },
                    )
                }
            }
        }
    }
}

@Composable
private fun FilePanelHeader(
    tabs: List<FileTab>,
    activeTabId: String?,
    onClose: () -> Unit,
    onCloseOthers: () -> Unit,
    onCloseAll: () -> Unit,
) {
    val colors = LocalOmpColors.current
    var menuOpen by remember { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = stringResource(R.string.files_panel_title),
            color = colors.text,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.weight(1f))
        Box {
            IconButton(
                onClick = { menuOpen = true },
                enabled = tabs.isNotEmpty(),
                modifier = Modifier.size(28.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.MoreVert,
                    contentDescription = stringResource(R.string.files_tab_actions),
                    tint = if (tabs.isEmpty()) colors.textDim.copy(alpha = 0.4f) else colors.textMuted,
                    modifier = Modifier.size(16.dp),
                )
            }
            OmpDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.files_close_other_tabs), fontSize = 12.sp) },
                    enabled = tabs.size > 1 && activeTabId != null,
                    onClick = {
                        menuOpen = false
                        onCloseOthers()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.files_close_all_tabs), fontSize = 12.sp) },
                    onClick = {
                        menuOpen = false
                        onCloseAll()
                    },
                )
            }
        }
        IconButton(onClick = onClose) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = stringResource(R.string.files_close_panel),
                tint = colors.textMuted,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/** Test tag prefix of one tab; the key tests address tabs by view or file id. */
internal const val FILE_TAB_TAG_PREFIX = "files-tab:"

/** One rendered tab: a fixed view entry or an open file (`tabId`). */
internal data class FileTabEntry(
    val key: String,
    val label: String,
    val view: FilesPanelView? = null,
    val tabId: String? = null,
)

@Composable
internal fun FileTabStrip(
    view: FilesPanelView,
    tabs: List<FileTab>,
    activeTabId: String?,
    hasNotifications: Boolean,
    onSelectView: (FilesPanelView) -> Unit,
    onSelectTab: (String) -> Unit,
    onCloseTab: (String) -> Unit,
) {
    val entries = buildList {
        add(FileTabEntry("explorer", stringResource(R.string.files_tab_explorer), FilesPanelView.Explorer))
        add(FileTabEntry("git", stringResource(R.string.git_tab_title), FilesPanelView.Git))
        add(FileTabEntry("worktrees", stringResource(R.string.worktree_tab_title), FilesPanelView.Worktrees))
        if (hasNotifications) {
            add(FileTabEntry("notifications", stringResource(R.string.notify_ui_title), FilesPanelView.Notifications))
        }
        tabs.forEach { tab -> add(FileTabEntry(tab.id, fileName(tab.path), tabId = tab.id)) }
    }
    val activeKey = if (view == FilesPanelView.File && activeTabId != null) {
        activeTabId
    } else {
        entries.firstOrNull { it.view == view }?.key
    }
    val requesters = remember(entries.map { it.key }) {
        entries.associate { entry -> entry.key to FocusRequester() }
    }

    fun activate(entry: FileTabEntry) {
        if (entry.tabId != null) onSelectTab(entry.tabId) else entry.view?.let(onSelectView)
    }

    val onKey: (FileTabEntry, KeyEvent) -> Boolean = { entry, event ->
        if (event.type != KeyEventType.KeyDown) {
            false
        } else {
            when (event.key) {
                Key.Enter, Key.NumPadEnter, Key.Spacebar -> {
                    activate(entry)
                    true
                }

                Key.DirectionLeft, Key.DirectionRight, Key.MoveHome, Key.MoveEnd -> {
                    val navKey = when (event.key) {
                        Key.DirectionLeft -> FileTabKey.Left
                        Key.DirectionRight -> FileTabKey.Right
                        Key.MoveHome -> FileTabKey.Home
                        else -> FileTabKey.End
                    }
                    FileKeyNav.tabIndex(entries.size, entries.indexOf(entry), navKey)?.let { target ->
                        val next = entries[target]
                        // The web's tablist selects on the way and keeps focus on
                        // the tab, so the next arrow starts from there.
                        activate(next)
                        requesters[next.key]?.requestFocus()
                    }
                    true
                }

                Key.Delete, Key.Backspace -> {
                    // Only file tabs close; fixed tabs keep the key for the host.
                    val tabId = entry.tabId
                    if (tabId != null) onCloseTab(tabId)
                    tabId != null
                }

                else -> false
            }
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        entries.forEach { entry ->
            val modifier = Modifier
                .focusRequester(requesters.getValue(entry.key))
                .onPreviewKeyEvent { event -> onKey(entry, event) }
                .testTag(FILE_TAB_TAG_PREFIX + entry.key)
            if (entry.tabId != null) {
                val tab = tabs.first { it.id == entry.tabId }
                FileTabChip(
                    tab = tab,
                    selected = activeKey == entry.key,
                    onClick = { onSelectTab(tab.id) },
                    onClose = { onCloseTab(tab.id) },
                    modifier = modifier,
                )
            } else {
                TabChip(
                    label = entry.label,
                    selected = activeKey == entry.key,
                    onClick = { entry.view?.let(onSelectView) },
                    modifier = modifier,
                )
            }
        }
    }
}

@Composable
private fun TabChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    Text(
        text = label,
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (selected) colors.selected else colors.backgroundSubtle)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        color = if (selected) colors.text else colors.textMuted,
        fontSize = 11.sp,
        fontWeight = if (selected) FontWeight.Medium else FontWeight.Normal,
        maxLines = 1,
    )
}

@Composable
private fun FileTabChip(
    tab: FileTab,
    selected: Boolean,
    onClick: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val name = fileName(tab.path)
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (selected) colors.selected else colors.backgroundSubtle)
            .clickable(onClick = onClick)
            .padding(start = 8.dp, end = 2.dp, top = 3.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = name,
            color = if (selected) colors.text else colors.textMuted,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        IconButton(onClick = onClose) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = stringResource(R.string.files_close_tab, name),
                tint = colors.textDim,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}
