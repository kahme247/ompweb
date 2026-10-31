package io.github.kahme247.ompweb.ui.git

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.GitCollapseReason
import io.github.kahme247.ompweb.domain.GitFileStatus
import io.github.kahme247.ompweb.domain.GitFileStatusKind
import io.github.kahme247.ompweb.domain.fileDirectory
import io.github.kahme247.ompweb.domain.fileName
import io.github.kahme247.ompweb.domain.gitChangeGroups
import io.github.kahme247.ompweb.domain.relativeFilePath
import io.github.kahme247.ompweb.ui.files.FileOpenMode
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/**
 * The Git tab (web `GitChangesPanel`): filter/clear, refresh, one row per
 * changed file with its status label and one-letter badge, and the
 * `.gitattributes` group. A tap opens Slice A's file viewer in Diff mode —
 * this pane owns no diff renderer.
 *
 * Non-repo workspaces and a missing cwd render their own empty/unsupported
 * state, so the shell may show the tab unconditionally.
 */
@Composable
fun GitChangesPane(
    cwd: String?,
    onOpenFile: (path: String, mode: FileOpenMode) -> Unit,
    viewModel: GitChangesViewModel,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    LaunchedEffect(cwd) { viewModel.activate(cwd) }

    Column(modifier.fillMaxSize()) {
        GitFilterBar(
            filter = state.filter,
            onFilterChange = viewModel::setFilter,
            onClear = viewModel::clearFilter,
            onRefresh = viewModel::refresh,
        )

        val groups = remember(state.files, state.filter, state.cwd) {
            gitChangeGroups(state.files, state.filter, state.cwd)
        }

        val loadError = state.error
        when {
            state.cwd == null -> GitEmptyState(
                title = stringResource(R.string.git_no_workspace),
                hint = stringResource(R.string.git_no_workspace_hint),
            )
            loadError != null -> GitErrorState(
                message = stringResource(R.string.git_load_failed, loadError),
                onRetry = viewModel::refresh,
            )
            state.loading && !state.loaded -> Text(
                text = stringResource(R.string.git_loading),
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                color = LocalOmpColors.current.textDim,
                fontSize = 11.sp,
            )
            !state.isRepo -> GitEmptyState(
                title = stringResource(R.string.git_not_a_repo),
                hint = stringResource(R.string.git_not_a_repo_hint),
            )
            state.files.isEmpty() -> GitEmptyState(
                title = stringResource(R.string.git_no_changes),
                hint = stringResource(R.string.git_no_changes_hint),
                tint = LocalOmpColors.current.statusSuccess,
                icon = Icons.Filled.Check,
            )
            else -> Column(Modifier.fillMaxSize()) {
                Text(
                    text = pluralStringResource(
                        R.plurals.git_files_changed,
                        state.files.size,
                        state.files.size,
                    ),
                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 4.dp),
                    color = LocalOmpColors.current.textDim,
                    fontSize = 10.sp,
                )
                LazyColumn(Modifier.fillMaxSize()) {
                    if (groups.primary.isEmpty() && groups.collapsed.isEmpty()) {
                        item { GitNoMatches() }
                    }
                    items(groups.primary, key = { it.filePath }) { file ->
                        GitChangeRow(
                            file = file,
                            cwd = state.cwd,
                            reasonLabel = null,
                            selected = file.filePath == state.selectedPath,
                            onOpen = {
                                viewModel.select(file.filePath)
                                onOpenFile(file.filePath, FileOpenMode.Diff)
                            },
                        )
                    }
                    if (groups.collapsed.isNotEmpty()) {
                        item(key = "git-attributes") {
                            GitAttributeHeader(
                                count = groups.collapsed.size,
                                open = state.attributeGroupOpen,
                                onToggle = viewModel::toggleAttributeGroup,
                            )
                        }
                        if (state.attributeGroupOpen) {
                            items(groups.collapsed, key = { "collapsed:${it.filePath}" }) { file ->
                                GitChangeRow(
                                    file = file,
                                    cwd = state.cwd,
                                    reasonLabel = gitReasonLabel(file.collapseReason),
                                    selected = file.filePath == state.selectedPath,
                                    onOpen = {
                                        viewModel.select(file.filePath)
                                        onOpenFile(file.filePath, FileOpenMode.Diff)
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

@Composable
private fun GitFilterBar(
    filter: String,
    onFilterChange: (String) -> Unit,
    onClear: () -> Unit,
    onRefresh: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val focusManager = LocalFocusManager.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            imageVector = Icons.Filled.Search,
            contentDescription = null,
            tint = colors.textDim,
            modifier = Modifier.size(13.dp),
        )
        Box(
            modifier = Modifier
                .weight(1f)
                .heightIn(min = 28.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(colors.background)
                .border(1.dp, colors.border, RoundedCornerShape(6.dp))
                .padding(horizontal = 8.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (filter.isEmpty()) {
                Text(
                    text = stringResource(R.string.git_filter_files),
                    color = colors.textDim,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            BasicTextField(
                value = filter,
                onValueChange = onFilterChange,
                singleLine = true,
                textStyle = LocalTextStyle.current.copy(color = colors.text, fontSize = 12.sp),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (filter.isNotEmpty()) {
            IconButton(onClick = onClear) {
                Icon(
                    imageVector = Icons.Filled.Close,
                    contentDescription = stringResource(R.string.git_clear_filter),
                    tint = colors.textDim,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
        IconButton(onClick = onRefresh) {
            Icon(
                imageVector = Icons.Filled.Refresh,
                contentDescription = stringResource(R.string.git_refresh_changes),
                tint = colors.textDim,
                modifier = Modifier.size(15.dp),
            )
        }
    }
}

@Composable
private fun GitChangeRow(
    file: GitFileStatus,
    cwd: String?,
    reasonLabel: String?,
    selected: Boolean,
    onOpen: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val relative = relativeFilePath(file.filePath, cwd)
    val name = fileName(relative)
    val directory = fileDirectory(relative)
    val statusLabel = stringResource(gitStatusLabel(file.status))
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (selected) colors.selected else Color.Transparent)
            .clickable(
                role = Role.Button,
                onClickLabel = stringResource(R.string.git_open_file),
                onClick = onOpen,
            )
            .padding(start = 8.dp, end = 8.dp, top = 7.dp, bottom = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = name,
            modifier = Modifier.weight(1f, fill = false),
            color = colors.text,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (directory.isNotEmpty()) {
            Text(
                text = directory,
                modifier = Modifier.weight(1f),
                color = colors.textDim,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (reasonLabel != null) {
            Text(
                text = reasonLabel,
                color = colors.textDim,
                fontSize = 10.sp,
                maxLines = 1,
            )
        }
        Text(
            text = statusLabel,
            color = gitStatusColor(file.status),
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
        )
        Text(
            text = file.code,
            color = gitStatusColor(file.status),
            fontFamily = OmpMonoFontFamily,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.width(14.dp),
        )
    }
}

@Composable
private fun GitAttributeHeader(count: Int, open: Boolean, onToggle: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(
                role = Role.Button,
                onClickLabel = stringResource(R.string.git_attribute_files_hint),
                onClick = onToggle,
            )
            .padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            imageVector = Icons.Filled.KeyboardArrowDown,
            contentDescription = null,
            tint = colors.textDim,
            modifier = Modifier.size(12.dp).rotate(if (open) 0f else -90f),
        )
        Text(
            text = pluralStringResource(R.plurals.git_attribute_files, count, count),
            color = colors.textDim,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun GitNoMatches() {
    Text(
        text = stringResource(R.string.git_no_matching_files),
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
        color = LocalOmpColors.current.textDim,
        fontSize = 11.sp,
    )
}

@Composable
private fun GitEmptyState(
    title: String,
    hint: String,
    tint: Color? = null,
    icon: androidx.compose.ui.graphics.vector.ImageVector = Icons.Filled.Info,
) {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tint ?: colors.textDim,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = title,
            color = colors.text,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = hint,
            color = colors.textDim,
            fontSize = 11.sp,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun GitErrorState(message: String, onRetry: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = message,
            modifier = Modifier.weight(1f),
            color = colors.statusError,
            fontSize = 11.sp,
        )
        TextButton(onClick = onRetry) {
            Text(stringResource(R.string.git_retry), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** The web's `GIT_STATUS_LABEL_KEYS`. */
private fun gitStatusLabel(kind: GitFileStatusKind): Int = when (kind) {
    GitFileStatusKind.MODIFIED -> R.string.git_status_modified
    GitFileStatusKind.ADDED -> R.string.git_status_added
    GitFileStatusKind.DELETED -> R.string.git_status_deleted
    GitFileStatusKind.RENAMED -> R.string.git_status_renamed
    GitFileStatusKind.UNTRACKED -> R.string.git_status_untracked
    GitFileStatusKind.CONFLICT -> R.string.git_status_conflict
}

/** The web's `GIT_STATUS_COLORS`, mapped onto the app palette. */
@Composable
private fun gitStatusColor(kind: GitFileStatusKind): Color {
    val colors = LocalOmpColors.current
    return when (kind) {
        GitFileStatusKind.MODIFIED -> colors.statusModified
        GitFileStatusKind.ADDED, GitFileStatusKind.UNTRACKED -> colors.statusSuccess
        GitFileStatusKind.DELETED, GitFileStatusKind.CONFLICT -> colors.statusError
        GitFileStatusKind.RENAMED -> colors.statusRenamed
    }
}

/** The web's `COLLAPSE_REASON_LABEL_KEYS`. */
@Composable
private fun gitReasonLabel(reason: GitCollapseReason?): String? = when (reason) {
    null -> null
    GitCollapseReason.GENERATED -> stringResource(R.string.git_reason_generated)
    GitCollapseReason.VENDORED -> stringResource(R.string.git_reason_vendored)
    GitCollapseReason.DOCUMENTATION -> stringResource(R.string.git_reason_documentation)
    GitCollapseReason.NO_DIFF -> stringResource(R.string.git_reason_no_diff)
}
