package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.ProjectLaunchConfig

/**
 * Server-side directory picker with the optional clone flow
 * (`components/DirectoryPicker.tsx`). Selecting a cloned folder reports the
 * checkout itself, exactly like the web picker.
 */
@Composable
internal fun DirectoryPickerDialog(
    viewModel: DirectoryPickerViewModel,
    initialPath: String?,
    onDismiss: () -> Unit,
    onSelected: (String, ProjectLaunchConfig?) -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var dismissed by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.start(initialPath) }

    fun close() {
        if (dismissed || state.cloneRunning) return
        dismissed = true
        viewModel.reset()
        onDismiss()
    }

    OmpDialog(
        onDismissRequest = { close() },
        // Edge-to-edge so the dialog can react to the keyboard: with the
        // default system-window fit the window is only *panned* when the IME
        // opens, which leaves the action row ("Select this folder") behind the
        // keyboard — a tap there hit the IME and typed its key (a "." on the
        // path) instead of selecting the folder.
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(8.dp),
            shape = RoundedCornerShape(14.dp),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 4.dp),
                ) {
                    Text(
                        text = stringResource(R.string.picker_title),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.weight(1f),
                    )
                    IconButton(onClick = { close() }, enabled = !state.cloneRunning) {
                        Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.picker_cancel))
                    }
                }
                HorizontalDivider()

                Column(
                    modifier = Modifier
                        .weight(1f)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp),
                ) {
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = state.pathInput,
                            onValueChange = viewModel::setPathInput,
                            label = { Text(stringResource(R.string.picker_path)) },
                            singleLine = true,
                            enabled = !state.cloneRunning,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.size(8.dp))
                        Button(
                            onClick = viewModel::submitPath,
                            enabled = !state.cloneRunning && state.pathInput.isNotBlank(),
                        ) {
                            Text(stringResource(R.string.picker_go))
                        }
                        IconButton(
                            onClick = { viewModel.navigate(state.parentPath) },
                            enabled = !state.cloneRunning && state.parentPath != null,
                        ) {
                            Icon(
                                Icons.Filled.KeyboardArrowUp,
                                contentDescription = stringResource(R.string.picker_up),
                            )
                        }
                    }
                    if (state.hasUncommittedPath) {
                        Text(
                            text = state.pathInput.trim(),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 2.dp),
                        )
                    }

                    state.error?.let { error ->
                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = error,
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = viewModel::submitPath) {
                                Text(stringResource(R.string.picker_retry))
                            }
                        }
                    }

                    if (state.drives.isNotEmpty()) {
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = stringResource(R.string.picker_drives),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            state.drives.forEach { drive ->
                                TextButton(
                                    onClick = { viewModel.navigate(drive.path) },
                                    enabled = !state.cloneRunning,
                                ) {
                                    Text(drive.name)
                                }
                            }
                        }
                    }

                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.picker_directories),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (state.loading) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.size(8.dp))
                            Text(stringResource(R.string.picker_loading))
                        }
                    } else if (state.directories.isEmpty()) {
                        Text(
                            text = stringResource(R.string.picker_empty),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    } else {
                        state.directories.forEach { directory ->
                            Text(
                                text = directory.name,
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = !state.cloneRunning) {
                                        viewModel.navigate(directory.path)
                                    }
                                    .padding(vertical = 10.dp),
                            )
                        }
                    }

                    Spacer(Modifier.height(12.dp))
                    HorizontalDivider()
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = state.cloneUrl,
                        onValueChange = viewModel::setCloneUrl,
                        label = { Text(stringResource(R.string.picker_clone_url)) },
                        placeholder = { Text(stringResource(R.string.picker_clone_url_placeholder)) },
                        singleLine = true,
                        enabled = !state.cloneRunning,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (state.cloneUrl.isNotBlank() && !state.cloneRunning) {
                        Spacer(Modifier.height(4.dp))
                        val target = state.cloneTarget
                        Text(
                            text = if (target != null) {
                                stringResource(R.string.picker_clone_target, target)
                            } else {
                                stringResource(R.string.picker_invalid_url)
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (target != null) {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            } else {
                                MaterialTheme.colorScheme.error
                            },
                        )
                    }
                    state.cloneStatus?.let { status ->
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = status,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (state.cloneLog.isNotBlank()) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            text = state.cloneLog.replace("\r", ""),
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 12,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = 150.dp)
                                .padding(6.dp),
                        )
                    }

                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = state.profile,
                        onValueChange = viewModel::setProfile,
                        label = { Text(stringResource(R.string.picker_profile)) },
                        placeholder = { Text(stringResource(R.string.picker_profile_placeholder)) },
                        singleLine = true,
                        enabled = !state.cloneRunning,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = state.advisor,
                            onCheckedChange = viewModel::setAdvisor,
                            enabled = !state.cloneRunning,
                        )
                        Text(stringResource(R.string.picker_advisor))
                    }
                    OutlinedTextField(
                        value = state.extraArgs,
                        onValueChange = viewModel::setExtraArgs,
                        label = { Text(stringResource(R.string.picker_extra_args)) },
                        minLines = 2,
                        maxLines = 4,
                        enabled = !state.cloneRunning,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        text = stringResource(R.string.picker_reserved),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                }

                HorizontalDivider()
                Row(
                    horizontalArrangement = Arrangement.End,
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    if (state.cloneRunning) {
                        TextButton(onClick = viewModel::cancelClone) {
                            Text(
                                text = stringResource(R.string.picker_cancel_clone),
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        Button(onClick = {}, enabled = false) {
                            Text(stringResource(R.string.picker_clone_here))
                        }
                    } else {
                        TextButton(onClick = { close() }) {
                            Text(stringResource(R.string.picker_cancel))
                        }
                        Spacer(Modifier.weight(1f))
                        Button(
                            onClick = {
                                viewModel.select { path, config -> onSelected(path, config) }
                            },
                            enabled = state.canSelect,
                        ) {
                            Text(
                                if (state.cloneUrl.isNotBlank()) {
                                    stringResource(R.string.picker_clone_here)
                                } else {
                                    stringResource(R.string.picker_select)
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}
