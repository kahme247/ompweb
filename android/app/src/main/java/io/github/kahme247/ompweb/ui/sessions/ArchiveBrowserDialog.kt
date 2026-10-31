package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.ArchiveEntry
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * Archive browser (`components/ArchiveBrowser.tsx`): search, metadata of the
 * selected archived session and restore-as-copy. The body lives in
 * [ArchiveBrowserContent] because a dialog window cannot be captured by the
 * screenshot matrix.
 */
@Composable
internal fun ArchiveBrowserDialog(
    state: ArchiveUiState,
    onClose: () -> Unit,
    onRefresh: () -> Unit,
    onSearch: (String) -> Unit,
    onSelect: (String?) -> Unit,
    onRestore: (String) -> Unit,
    onCopyId: (String) -> Unit,
) {
    OmpDialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .padding(8.dp),
            shape = RoundedCornerShape(14.dp),
        ) {
            ArchiveBrowserContent(
                state = state,
                onClose = onClose,
                onRefresh = onRefresh,
                onSearch = onSearch,
                onSelect = onSelect,
                onRestore = onRestore,
                onCopyId = onCopyId,
            )
        }
    }
}

@Composable
internal fun ArchiveBrowserContent(
    state: ArchiveUiState,
    onClose: () -> Unit,
    onRefresh: () -> Unit,
    onSearch: (String) -> Unit,
    onSelect: (String?) -> Unit,
    onRestore: (String) -> Unit,
    onCopyId: (String) -> Unit,
) {
    val colors = LocalOmpColors.current
    val visible = visibleArchiveEntries(state.entries, state.search)
    val selected = state.entries.firstOrNull { it.key == state.selectedKey }

    // The web selects `filteredArchives[0]` and clears the selection when the
    // filter matches nothing; without it the detail pane kept showing an
    // entry that was no longer in the list.
    LaunchedEffect(visible, state.selectedKey) {
        when {
            visible.isEmpty() -> if (state.selectedKey != null) onSelect(null)
            visible.none { it.key == state.selectedKey } -> onSelect(visible.first().key)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 4.dp),
        ) {
            Text(
                text = stringResource(R.string.archive_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onRefresh, enabled = !state.loading) {
                Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.archive_refresh))
            }
            IconButton(onClick = onClose) {
                Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.common_close))
            }
        }
        HorizontalDivider()
        OutlinedTextField(
            value = state.search,
            onValueChange = onSearch,
            label = { Text(stringResource(R.string.archive_search)) },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 6.dp),
        )
        when {
            state.loading && state.entries.isEmpty() -> Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(16.dp),
            ) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(10.dp))
                Text(stringResource(R.string.picker_loading))
            }

            state.error != null && state.entries.isEmpty() -> Column(
                modifier = Modifier.padding(16.dp),
            ) {
                Text(state.error ?: stringResource(R.string.archive_invalid), color = colors.statusError)
                TextButton(onClick = onRefresh) {
                    Text(stringResource(R.string.common_retry))
                }
            }

            visible.isEmpty() -> Text(
                text = stringResource(R.string.archive_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textDim,
                modifier = Modifier.padding(16.dp),
            )

            else -> LazyColumn(modifier = Modifier.weight(1f)) {
                items(items = visible, key = { it.key }) { entry ->
                    ArchiveRow(
                        entry = entry,
                        selected = entry.key == state.selectedKey,
                        onClick = { onSelect(entry.key) },
                    )
                    HorizontalDivider()
                }
            }
        }
        if (selected != null) {
            HorizontalDivider()
            ArchiveDetail(
                entry = selected,
                restoring = state.restoringKey == selected.key,
                onRestore = { onRestore(selected.key) },
                onCopyId = { onCopyId(selected.id) },
            )
        } else if (visible.isNotEmpty()) {
            Text(
                text = stringResource(R.string.archive_select),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textDim,
                modifier = Modifier.padding(16.dp),
            )
        }
    }
}

@Composable
private fun ArchiveRow(entry: ArchiveEntry, selected: Boolean, onClick: () -> Unit) {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Text(
            text = entry.name?.takeIf { it.isNotBlank() }
                ?: entry.firstMessage.lineSequence().firstOrNull { it.isNotBlank() }
                ?: entry.id.take(12),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = if (selected) colors.accent else colors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = listOfNotNull(
                entry.status.takeIf { it.isNotBlank() },
                entry.archivedAt.takeIf { it.isNotBlank() },
                formatBytes(entry.size),
            ).joinToString(" · "),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun ArchiveDetail(
    entry: ArchiveEntry,
    restoring: Boolean,
    onRestore: () -> Unit,
    onCopyId: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = entry.cwd,
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
        )
        Text(
            text = stringResource(R.string.archive_messages, entry.messageCount),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textDim,
        )
        entry.firstMessage.takeIf { it.isNotBlank() }?.let { first ->
            Text(
                text = first,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(top = 4.dp),
        ) {
            TextButton(onClick = onCopyId) {
                Text(stringResource(R.string.archive_copy_id))
            }
            TextButton(onClick = onRestore, enabled = !restoring) {
                if (restoring) {
                    CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(6.dp))
                    Text(stringResource(R.string.archive_restoring))
                } else {
                    Text(stringResource(R.string.archive_restore))
                }
            }
            Spacer(Modifier.height(0.dp))
        }
    }
}
