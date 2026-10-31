package io.github.kahme247.ompweb.ui.files

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.FileSearchRow
import io.github.kahme247.ompweb.domain.FileTreeRow
import io.github.kahme247.ompweb.domain.GitFileStatusKind
import io.github.kahme247.ompweb.domain.changedDirectoryPaths
import io.github.kahme247.ompweb.domain.comparableFilePath
import io.github.kahme247.ompweb.domain.flattenFileTree
import io.github.kahme247.ompweb.domain.formatFileSize
import io.github.kahme247.ompweb.domain.relativeFilePath
import io.github.kahme247.ompweb.domain.atMentionText
import io.github.kahme247.ompweb.net.MAX_FILE_SEARCH_LIMIT
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import kotlinx.coroutines.launch

/** Test tag prefix of one tree row; the key tests focus the row by path. */
internal const val FILE_ROW_TAG_PREFIX = "file-row:"

/**
 * The Explorer tab (web `components/FileExplorer.tsx`, lazy `?type=list`
 * tree): refresh, collapse all, file search over `/api/file-index`, the
 * upload flow with its conflict question, git decorations, and per-row
 * actions (open, mention, download, share, copy path).
 *
 * The pane owns no Android plumbing beyond the SAF picker: saving, sharing and
 * the clipboard stay in `FilePanel`, which also knows the active composer.
 */
@Composable
fun FileExplorerPane(
    state: ExplorerUiState,
    vm: FilesViewModel,
    onOpenFile: (path: String) -> Unit,
    onMention: (String) -> Unit,
    onCopyPath: (String) -> Unit,
    onDownload: (String) -> Unit,
    onShare: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val cwd = state.cwd
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    // Resolved here: a Context read inside the picker callback is not
    // configuration-aware (lint `LocalContextGetResourceValueCall`).
    val uploadFailedLabel = stringResource(R.string.files_upload_failed)
    val uploadLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val pick = FileTransfer.readUploads(context, uris)
            val pickError = pick.rejected.takeIf { it.isNotEmpty() }
                ?.let { names -> uploadFailedLabel + ": " + names.joinToString(", ") }
            // Both outcomes travel together: the banner shows the rejected
            // URIs next to the progress of the files that did read.
            if (pick.files.isNotEmpty()) {
                vm.upload(pick.files, pickError)
            } else if (pickError != null) {
                vm.reportUploadError(pickError)
            }
        }
    }

    Column(modifier.fillMaxSize()) {
        ExplorerToolbar(
            searchOpen = state.searchOpen,
            onSearchToggle = { vm.setSearchOpen(!state.searchOpen) },
            onRefresh = vm::refreshExplorer,
            onCollapseAll = vm::collapseAll,
            onUpload = { uploadLauncher.launch(arrayOf("*/*")) },
            uploadEnabled = cwd != null && !state.upload.busy,
        )
        if (state.searchOpen) {
            ExplorerSearchBar(
                query = state.searchQuery,
                onQueryChange = vm::setSearchQuery,
                onClose = { vm.setSearchOpen(false) },
            )
        }
        UploadFeedback(state = state, vm = vm, onMention = onMention)

        val loadError = state.error
        when {
            cwd == null -> ExplorerPlaceholder(
                title = stringResource(R.string.files_no_workspace),
                hint = stringResource(R.string.files_no_workspace_hint),
            )

            loadError != null && !state.rootLoaded -> ExplorerPlaceholder(
                title = stringResource(R.string.files_load_failed, loadError),
                hint = null,
                action = stringResource(R.string.files_retry) to vm::refreshExplorer,
            )

            state.searchOpen -> ExplorerSearchResults(
                state = state,
                onOpen = { row -> onOpenFile(row.path) },
                onRetry = vm::retrySearch,
            )

            else -> ExplorerTree(
                state = state,
                vm = vm,
                onOpenFile = onOpenFile,
                onMention = onMention,
                onCopyPath = onCopyPath,
                onDownload = onDownload,
                onShare = onShare,
            )
        }
    }

    val conflict = state.upload.conflict
    val phase = state.upload.phase
    if (phase == UploadPhase.Conflict && conflict != null) {
        UploadConflictDialog(
            conflicts = conflict.conflicts,
            nonReplaceable = conflict.nonReplaceable,
            canReplace = conflict.canReplace,
            onReplace = { vm.resolveUploadConflict(io.github.kahme247.ompweb.domain.UploadConflictStrategy.Overwrite) },
            onSkip = { vm.resolveUploadConflict(io.github.kahme247.ompweb.domain.UploadConflictStrategy.Skip) },
            onCancel = vm::cancelUploadConflict,
        )
    }
}

@Composable
private fun ExplorerToolbar(
    searchOpen: Boolean,
    onSearchToggle: () -> Unit,
    onRefresh: () -> Unit,
    onCollapseAll: () -> Unit,
    onUpload: () -> Unit,
    uploadEnabled: Boolean,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 8.dp, end = 4.dp, top = 4.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        IconButton(onClick = onSearchToggle) {
            Icon(
                imageVector = if (searchOpen) Icons.Filled.Close else Icons.Filled.Search,
                contentDescription = stringResource(R.string.files_search_toggle),
                tint = if (searchOpen) colors.accent else colors.textDim,
                modifier = Modifier.size(16.dp),
            )
        }
        IconButton(onClick = onRefresh) {
            Icon(
                imageVector = Icons.Filled.Refresh,
                contentDescription = stringResource(R.string.files_refresh),
                tint = colors.textDim,
                modifier = Modifier.size(16.dp),
            )
        }
        TextButton(onClick = onCollapseAll, enabled = uploadEnabled) {
            Text(
                text = stringResource(R.string.files_collapse_all),
                color = if (uploadEnabled) colors.textDim else colors.textDim.copy(alpha = 0.4f),
                fontSize = 11.sp,
            )
        }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onUpload, enabled = uploadEnabled) {
            Icon(
                imageVector = Icons.Filled.Add,
                contentDescription = stringResource(R.string.files_upload),
                tint = if (uploadEnabled) colors.accent else colors.textDim,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun ExplorerSearchBar(query: String, onQueryChange: (String) -> Unit, onClose: () -> Unit) {
    val colors = LocalOmpColors.current
    val focusManager = LocalFocusManager.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 30.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(colors.background)
                .border(1.dp, colors.border, RoundedCornerShape(6.dp))
                .padding(horizontal = 8.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (query.isEmpty()) {
                Text(
                    text = stringResource(R.string.files_search_placeholder),
                    color = colors.textDim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                singleLine = true,
                textStyle = LocalTextStyle.current.copy(color = colors.text, fontSize = 12.sp),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        TextButton(onClick = onClose) {
            Text(stringResource(R.string.files_dismiss), color = colors.textDim, fontSize = 11.sp)
        }
    }
}

@Composable
private fun UploadFeedback(state: ExplorerUiState, vm: FilesViewModel, onMention: (String) -> Unit) {
    val colors = LocalOmpColors.current
    val upload = state.upload
    val background = colors.backgroundSubtle
    val error = upload.error
    val summary = upload.summary
    if (!upload.busy && error == null && summary == null) return
    Column(Modifier.fillMaxWidth()) {
        // A picker rejection and the upload progress are not alternatives:
        // both belong on screen at the same time.
        if (error != null) {
            FeedbackBanner(
                text = error,
                error = true,
                action = if (upload.busy) {
                    null
                } else {
                    stringResource(R.string.files_dismiss) to vm::dismissUploadFeedback
                },
            )
        }
        if (upload.busy) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .background(background)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text(
                    text = if (upload.phase == UploadPhase.Checking) {
                        stringResource(R.string.files_upload_checking)
                    } else {
                        upload.currentName?.let { name ->
                            stringResource(R.string.files_upload_progress, name, upload.percent)
                        } ?: stringResource(R.string.files_upload_checking)
                    },
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (upload.phase == UploadPhase.Uploading) {
                    Spacer(Modifier.height(4.dp))
                    LinearProgressIndicator(
                        progress = { upload.percent / 100f },
                        modifier = Modifier.fillMaxWidth().height(3.dp),
                        color = colors.accent,
                        trackColor = colors.border,
                    )
                    if (upload.total > 1) {
                        Text(
                            text = stringResource(R.string.files_upload_index, upload.index + 1, upload.total),
                            color = colors.textDim,
                            fontSize = 10.sp,
                        )
                    }
                }
            }
        }
        if (!upload.busy && summary != null) {
            val parts = buildList {
                if (summary.uploaded.isNotEmpty()) add(
                    stringResource(R.string.files_upload_uploaded, summary.uploaded.size),
                )
                if (summary.skipped.isNotEmpty()) add(
                    stringResource(R.string.files_upload_skipped, summary.skipped.size),
                )
                if (summary.failed.isNotEmpty()) add(
                    stringResource(R.string.files_upload_failed_count, summary.failed.size),
                )
            }
            FeedbackBanner(
                text = if (parts.isEmpty()) {
                    stringResource(R.string.files_upload_done)
                } else {
                    stringResource(R.string.files_upload_done) + " · " + parts.joinToString(" · ")
                },
                error = summary.failed.isNotEmpty(),
                action = if (summary.uploaded.isNotEmpty()) {
                    stringResource(R.string.files_upload_mention) to {
                        val text = vm.uploadedMentionText()
                        if (text != null) onMention(text)
                        vm.dismissUploadFeedback()
                    }
                } else {
                    null
                },
            )
            // The web lists every failed file by name with the reason on its
            // title; a bare count hides which file the user has to retry.
            summary.failed.forEach { failure ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .background(background)
                        .padding(horizontal = 10.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        imageVector = Icons.Filled.Warning,
                        contentDescription = null,
                        tint = colors.statusError,
                        modifier = Modifier.size(11.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        text = "${failure.name}: ${failure.message}",
                        color = colors.statusError,
                        fontSize = 10.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun FeedbackBanner(
    text: String,
    error: Boolean,
    action: Pair<String, () -> Unit>?,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (error) colors.statusError.copy(alpha = 0.12f) else colors.backgroundSubtle)
            .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (error) {
            Icon(
                imageVector = Icons.Filled.Warning,
                contentDescription = null,
                tint = colors.statusError,
                modifier = Modifier.size(13.dp),
            )
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text = text,
            modifier = Modifier.weight(1f),
            color = if (error) colors.statusError else colors.textMuted,
            fontSize = 11.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (action != null) {
            TextButton(onClick = action.second) {
                Text(action.first, color = colors.accent, fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun ExplorerTree(
    state: ExplorerUiState,
    vm: FilesViewModel,
    onOpenFile: (String) -> Unit,
    onMention: (String) -> Unit,
    onCopyPath: (String) -> Unit,
    onDownload: (String) -> Unit,
    onShare: (String) -> Unit,
) {
    val cwd = state.cwd ?: return
    val colors = LocalOmpColors.current
    val rows = remember(state.children, state.expanded, state.loading, cwd) {
        flattenFileTree(cwd, state.children, state.expanded, state.loading)
    }
    val directoryDots = remember(state.gitFiles, cwd) {
        changedDirectoryPaths(cwd, state.gitFiles.map { it.filePath })
    }
    val fileStatus = remember(state.gitFiles) {
        state.gitFiles.associate { comparableFilePath(it.filePath) to it.status }
    }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    // The keyboard cursor is the row the last arrow key (or the focused row)
    // selected. Keeping its path instead of its index survives an expand or a
    // refresh that inserts rows.
    var focusedPath by remember { mutableStateOf<String?>(null) }
    val focusedIndex = focusedPath
        ?.let { path -> rows.indexOfFirst { !it.empty && it.path == path } }
        ?.takeIf { it >= 0 }
    val onKey: (KeyEvent) -> Boolean = { event ->
        if (event.type != KeyEventType.KeyDown) {
            false
        } else {
            val key = when (event.key) {
                Key.DirectionUp -> FileTreeKey.Up
                Key.DirectionDown -> FileTreeKey.Down
                Key.MoveHome -> FileTreeKey.Home
                Key.MoveEnd -> FileTreeKey.End
                Key.DirectionLeft -> FileTreeKey.Left
                Key.DirectionRight -> FileTreeKey.Right
                Key.Enter, Key.NumPadEnter, Key.Spacebar -> FileTreeKey.Activate
                else -> null
            }
            when (val action = key?.let { FileKeyNav.treeAction(rows, focusedIndex, it) }) {
                is FileTreeAction.Focus -> {
                    rows.getOrNull(action.index)?.let { focusedPath = it.path }
                    scope.launch { listState.scrollToItem(action.index) }
                    true
                }

                FileTreeAction.ToggleDirectory -> {
                    rows.getOrNull(focusedIndex ?: -1)
                        ?.takeIf { it.isDir }
                        ?.let { vm.toggleDirectory(it.path) }
                    focusedIndex != null
                }

                FileTreeAction.OpenFile -> {
                    rows.getOrNull(focusedIndex ?: -1)
                        ?.takeIf { !it.isDir }
                        ?.let { onOpenFile(it.path) }
                    focusedIndex != null
                }

                else -> false
            }
        }
    }
    val revealTarget = state.revealTarget
    LaunchedEffect(revealTarget, rows) {
        if (revealTarget == null) return@LaunchedEffect
        val index = rows.indexOfFirst { comparableFilePath(it.path) == revealTarget }
        // Not there yet (ancestors still loading): keep the target, the next
        // tree emission retries, and the view model's timeout is the backstop.
        if (index >= 0) {
            listState.scrollToItem(index)
            vm.acknowledgeReveal()
        }
    }

    if (rows.isEmpty() && state.rootLoaded && !state.searchOpen) {
        ExplorerPlaceholder(
            title = stringResource(R.string.files_empty_directory),
            hint = null,
        )
        return
    }

    LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .onPreviewKeyEvent(onKey),
    ) {
        items(rows, key = { row -> (if (row.empty) "empty:" else "") + row.path }) { row ->
            if (row.empty) {
                Text(
                    text = stringResource(R.string.files_empty_directory),
                    modifier = Modifier.padding(start = (12 + row.depth * 14).dp, top = 4.dp, bottom = 4.dp),
                    color = colors.textDim,
                    fontSize = 10.5.sp,
                )
            } else {
                ExplorerRow(
                    row = row,
                    selected = comparableFilePath(row.path) in state.highlight,
                    focused = row.path == focusedPath,
                    gitKind = fileStatus[comparableFilePath(row.path)],
                    hasChangedChildren = row.isDir &&
                        comparableFilePath(row.path) in directoryDots,
                    onFocus = { focusedPath = row.path },
                    onOpen = {
                        if (row.isDir) vm.toggleDirectory(row.path) else onOpenFile(row.path)
                    },
                    onMention = {
                        onMention(atMentionText(relativeFilePath(row.path, cwd), row.isDir))
                    },
                    onCopyPath = { onCopyPath(relativeFilePath(row.path, cwd)) },
                    onDownload = if (row.isDir) null else ({ onDownload(row.path) }),
                    onShare = if (row.isDir) null else ({ onShare(row.path) }),
                )
            }
        }
    }
}

@Composable
private fun ExplorerRow(
    row: FileTreeRow,
    selected: Boolean,
    focused: Boolean,
    gitKind: GitFileStatusKind?,
    hasChangedChildren: Boolean,
    onFocus: () -> Unit,
    onOpen: () -> Unit,
    onMention: () -> Unit,
    onCopyPath: () -> Unit,
    onDownload: (() -> Unit)?,
    onShare: (() -> Unit)?,
) {
    val colors = LocalOmpColors.current
    var menuOpen by remember(row.path) { mutableStateOf(false) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(
                when {
                    selected -> colors.selected
                    focused -> colors.backgroundSubtle
                    else -> colors.background
                },
            )
            .onFocusChanged { focusState -> if (focusState.isFocused) onFocus() }
            .clickable(
                role = Role.Button,
                onClickLabel = stringResource(
                    if (row.isDir) R.string.files_open_directory else R.string.files_open_file,
                ),
                onClick = onOpen,
            )
            .testTag(FILE_ROW_TAG_PREFIX + row.path)
            .padding(start = (6 + row.depth * 14).dp, end = 2.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (row.isDir) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = colors.textDim,
                modifier = Modifier
                    .size(14.dp)
                    .rotate(if (row.expanded) 0f else -90f),
            )
        } else {
            Spacer(Modifier.width(14.dp))
        }
        Text(
            text = row.name,
            modifier = Modifier.weight(1f, fill = false),
            color = colors.text,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (row.isDir) {
            if (hasChangedChildren) {
                Box(
                    Modifier
                        .size(5.dp)
                        .clip(RoundedCornerShape(50))
                        .background(colors.statusModified),
                )
            }
            if (row.loading) {
                Text(text = "…", color = colors.textDim, fontSize = 11.sp)
            }
        } else {
            if (gitKind != null) {
                Text(
                    text = gitKind.code,
                    color = if (gitKind == GitFileStatusKind.ADDED) colors.statusSuccess else colors.statusModified,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.SemiBold,
                    fontFamily = OmpMonoFontFamily,
                )
            }
            if (row.size > 0) {
                Text(
                    text = formatFileSize(row.size),
                    color = colors.textDim,
                    fontSize = 10.sp,
                )
            }
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(
                    imageVector = Icons.Filled.MoreVert,
                    contentDescription = stringResource(R.string.files_row_actions),
                    tint = colors.textDim,
                    modifier = Modifier.size(14.dp),
                )
            }
            OmpDropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                if (!row.isDir) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.files_open_file), fontSize = 12.sp) },
                        onClick = {
                            menuOpen = false
                            onOpen()
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.files_mention), fontSize = 12.sp) },
                    onClick = {
                        menuOpen = false
                        onMention()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.files_copy_path), fontSize = 12.sp) },
                    onClick = {
                        menuOpen = false
                        onCopyPath()
                    },
                )
                if (onDownload != null) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.files_download), fontSize = 12.sp) },
                        onClick = {
                            menuOpen = false
                            onDownload()
                        },
                    )
                }
                if (onShare != null) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.files_share), fontSize = 12.sp) },
                        onClick = {
                            menuOpen = false
                            onShare()
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun ExplorerSearchResults(
    state: ExplorerUiState,
    onOpen: (FileSearchRow) -> Unit,
    onRetry: () -> Unit,
) {
    val colors = LocalOmpColors.current
    when {
        state.searchQuery.isBlank() -> ExplorerPlaceholder(
            title = stringResource(R.string.files_search_placeholder),
            hint = null,
        )

        state.searchFailed -> ExplorerPlaceholder(
            title = stringResource(R.string.files_search_failed, state.searchQuery),
            hint = null,
            action = stringResource(R.string.files_retry) to onRetry,
        )

        state.searchResults.isEmpty() && !state.searchLoading -> ExplorerPlaceholder(
            title = stringResource(R.string.files_search_empty),
            hint = null,
        )

        else -> LazyColumn(Modifier.fillMaxSize()) {
            items(state.searchResults, key = { it.path }) { row ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clickable(
                            role = Role.Button,
                            onClickLabel = stringResource(R.string.files_open_file),
                        ) { onOpen(row) }
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                ) {
                    Text(
                        text = row.name,
                        color = colors.text,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (row.directory.isNotEmpty()) {
                        Text(
                            text = row.directory,
                            color = colors.textDim,
                            fontSize = 10.5.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            if (state.searchTruncated) {
                item(key = "truncated") {
                    Text(
                        text = stringResource(R.string.files_search_truncated, MAX_FILE_SEARCH_LIMIT),
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                        color = colors.textDim,
                        fontSize = 10.5.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun ExplorerPlaceholder(
    title: String,
    hint: String?,
    action: Pair<String, () -> Unit>? = null,
) {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text = title, color = colors.text, fontSize = 12.5.sp)
        if (hint != null) {
            Spacer(Modifier.height(6.dp))
            Text(text = hint, color = colors.textDim, fontSize = 11.sp)
        }
        if (action != null) {
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = action.second) {
                Text(action.first, color = colors.accent, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun UploadConflictDialog(
    conflicts: List<String>,
    nonReplaceable: List<String>,
    canReplace: Boolean,
    onReplace: () -> Unit,
    onSkip: () -> Unit,
    onCancel: () -> Unit,
) {
    val colors = LocalOmpColors.current
    OmpAlertDialog(
        onDismissRequest = onCancel,
        title = { Text(stringResource(R.string.files_upload_conflict_title)) },
        text = {
            Column {
                Text(
                    text = stringResource(
                        R.string.files_upload_conflict_body,
                        conflicts.take(5).joinToString(", ") +
                            if (conflicts.size > 5) " +${conflicts.size - 5}" else "",
                    ),
                    fontSize = 13.sp,
                )
                if (nonReplaceable.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(
                            R.string.files_upload_conflict_non_replaceable,
                            nonReplaceable.joinToString(", "),
                        ),
                        color = colors.textDim,
                        fontSize = 12.sp,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onReplace, enabled = canReplace) {
                Text(stringResource(R.string.files_upload_replace))
            }
        },
        dismissButton = {
            Row {
                TextButton(onClick = onSkip) {
                    Text(stringResource(R.string.files_upload_skip))
                }
                TextButton(onClick = onCancel) {
                    Text(stringResource(R.string.files_upload_cancel))
                }
            }
        },
    )
}
