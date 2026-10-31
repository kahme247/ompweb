package io.github.kahme247.ompweb.ui.worktrees

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.comparableProjectPath
import io.github.kahme247.ompweb.domain.worktreeTargetPath
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily

/**
 * What the Worktrees pane calls (web `WorktreeContext`'s `select`/`create`/
 * `remove`): the shell only passes these through, the view model owns the
 * server calls and the effective-cwd event.
 */
class WorktreeActions(
    val onSwitch: (path: String) -> Unit,
    val onCreate: (branch: String) -> Unit,
    val onRemove: (path: String, force: Boolean) -> Unit,
    val onCancelRemove: () -> Unit,
    val onRefresh: () -> Unit,
    val onClearError: () -> Unit,
)

/** Binds [WorktreesPane] to a view model once per view-model instance. */
@Composable
fun rememberWorktreeActions(viewModel: WorktreesViewModel): WorktreeActions =
    remember(viewModel) { viewModel.actions() }

/**
 * The Worktrees tab (web `WorktreesPanel`): the active repo's worktrees, the
 * current one marked, main checkout badged and not removable, a Create row
 * with the branch name (the server places the checkout under
 * `<repoRoot>-worktrees/<sanitized-branch>`) and the dirty → force flow.
 *
 * Switching changes the effective/new-session cwd only; the open session keeps
 * its own cwd. Non-Git directories and repo subdirectories render the
 * "repository roots only" state.
 */
@Composable
fun WorktreesPane(
    context: WorktreeContextState,
    actions: WorktreeActions,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    if (!context.available) {
        WorktreesUnavailable(
            loading = context.loading && !context.ready,
            error = context.error,
            onRetry = actions.onRefresh,
            modifier = modifier,
        )
        return
    }

    var newOpen by rememberSaveable { mutableStateOf(false) }
    var newBranch by rememberSaveable { mutableStateOf("") }
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current

    // A successful create makes the new checkout current under the typed
    // branch: close the input like the web does.
    LaunchedEffect(context.worktrees, context.currentPath, context.busy, context.error) {
        if (!newOpen || context.busy || context.error != null) return@LaunchedEffect
        val branch = newBranch.trim()
        if (branch.isEmpty()) return@LaunchedEffect
        val created = context.worktrees.firstOrNull {
            it.path == context.currentPath && it.branch == branch
        }
        if (created != null) {
            newOpen = false
            newBranch = ""
        }
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        context.worktrees.forEach { worktree ->
            if (context.confirmRemove == worktree.path) {
                ForceRemoveRow(
                    busy = context.busy,
                    onForce = { actions.onRemove(worktree.path, true) },
                    onCancel = actions.onCancelRemove,
                )
            } else {
                WorktreeRow(
                    worktree = worktree,
                    current = worktree.path == context.currentPath ||
                        comparableProjectPath(worktree.path) == comparableProjectPath(context.currentPath.orEmpty()),
                    busy = context.busy,
                    onSelect = { actions.onSwitch(worktree.path) },
                    onRemove = { actions.onRemove(worktree.path, false) },
                )
            }
        }

        if (!newOpen) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(
                        role = Role.Button,
                        onClickLabel = stringResource(R.string.worktree_new_title),
                    ) {
                        newOpen = true
                        newBranch = ""
                        actions.onClearError()
                    }
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = null,
                    tint = colors.textMuted,
                    modifier = Modifier.size(12.dp),
                )
                Text(
                    text = stringResource(R.string.worktree_new),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                )
            }
        } else {
            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 28.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(colors.background)
                        .border(1.dp, colors.accent, RoundedCornerShape(6.dp))
                        .padding(horizontal = 8.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (newBranch.isEmpty()) {
                        Text(
                            text = stringResource(R.string.worktree_branch_placeholder),
                            color = colors.textDim,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                            maxLines = 1,
                        )
                    }
                    BasicTextField(
                        value = newBranch,
                        onValueChange = {
                            newBranch = it
                            actions.onClearError()
                        },
                        singleLine = true,
                        textStyle = LocalTextStyle.current.copy(
                            color = colors.text,
                            fontSize = 11.sp,
                            fontFamily = FontFamily.Monospace,
                        ),
                        cursorBrush = SolidColor(colors.accent),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = {
                            focusManager.clearFocus()
                            actions.onCreate(newBranch)
                        }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focusRequester)
                            .onPreviewKeyEvent { event ->
                                if (event.type == KeyEventType.KeyDown && event.key == Key.Escape) {
                                    newOpen = false
                                    newBranch = ""
                                    actions.onClearError()
                                    focusManager.clearFocus()
                                    true
                                } else {
                                    false
                                }
                            },
                    )
                }
                val target = context.projectRoot?.let { root ->
                    worktreeTargetPath(root, newBranch)
                }
                if (target != null) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = stringResource(R.string.worktree_target_hint, target),
                        color = colors.textDim,
                        fontSize = 10.sp,
                        fontFamily = OmpMonoFontFamily,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.height(5.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    CreateButton(
                        enabled = !context.busy && newBranch.isNotBlank(),
                        busy = context.busy,
                        modifier = Modifier.weight(1f),
                        onClick = { actions.onCreate(newBranch) },
                    )
                    TextButton(
                        onClick = {
                            newOpen = false
                            newBranch = ""
                            actions.onClearError()
                        },
                        modifier = Modifier.weight(1f),
                    ) {
                        Text(stringResource(R.string.worktree_cancel), fontSize = 11.sp, color = colors.textMuted)
                    }
                }
            }
            LaunchedEffect(newOpen) { focusRequester.requestFocus() }
        }

        if (context.loading && context.worktrees.isEmpty()) {
            Text(
                text = stringResource(R.string.worktree_loading),
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
                color = colors.textDim,
                fontSize = 11.sp,
            )
        }

        context.error?.let { error ->
            Text(
                text = error,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 10.dp, end = 10.dp, top = 5.dp, bottom = 8.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite },
                color = colors.accent,
                fontSize = 11.sp,
            )
        }
    }
}

@Composable
private fun WorktreeRow(
    worktree: WorktreeEntry,
    current: Boolean,
    busy: Boolean,
    onSelect: () -> Unit,
    onRemove: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val label = worktree.branch?.takeIf { it.isNotBlank() } ?: worktree.path
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(
            modifier = Modifier
                .weight(1f)
                .clickable(role = Role.Button, onClickLabel = stringResource(R.string.worktree_switch), onClick = onSelect)
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            if (current) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = null,
                    tint = colors.accent,
                    modifier = Modifier.size(10.dp),
                )
            } else {
                Spacer(Modifier.width(10.dp))
            }
            Text(
                text = label,
                modifier = Modifier.weight(1f),
                color = if (current) colors.text else colors.textMuted,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (worktree.isMain) {
                Text(
                    text = stringResource(R.string.worktree_main_badge),
                    color = colors.textDim,
                    fontSize = 10.sp,
                    maxLines = 1,
                )
            }
        }
        if (!worktree.isMain) {
            IconButton(
                onClick = onRemove,
                enabled = !busy,
                modifier = Modifier.size(34.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.Delete,
                    contentDescription = stringResource(R.string.worktree_remove_title, worktree.path),
                    tint = colors.textDim,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}

@Composable
private fun ForceRemoveRow(busy: Boolean, onForce: () -> Unit, onCancel: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.hover)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(
            text = stringResource(R.string.worktree_uncommitted_force_remove),
            modifier = Modifier.weight(1f),
            color = colors.text,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(onClick = onForce, enabled = !busy) {
            Text(
                text = stringResource(R.string.worktree_force),
                color = colors.onAccent,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.accentStrong)
                    .padding(horizontal = 9.dp, vertical = 3.dp),
            )
        }
        TextButton(onClick = onCancel) {
            Text(stringResource(R.string.worktree_cancel), fontSize = 11.sp, color = colors.textMuted)
        }
    }
}

@Composable
private fun CreateButton(
    enabled: Boolean,
    busy: Boolean,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val colors = LocalOmpColors.current
    TextButton(onClick = onClick, enabled = enabled, modifier = modifier) {
        Text(
            text = stringResource(if (busy) R.string.worktree_creating else R.string.worktree_create),
            color = if (enabled) colors.onAccent else colors.textDim,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .clip(RoundedCornerShape(6.dp))
                .background(if (enabled) colors.accentStrong else colors.hover)
                .padding(horizontal = 9.dp, vertical = 3.dp),
        )
    }
}

@Composable
private fun WorktreesUnavailable(
    loading: Boolean,
    error: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = Icons.Filled.Info,
            contentDescription = null,
            tint = colors.textDim,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = stringResource(R.string.worktree_tab_title),
            color = colors.text,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = if (loading) stringResource(R.string.worktree_loading) else stringResource(R.string.worktree_repo_root_only),
            color = colors.textDim,
            fontSize = 11.sp,
            textAlign = TextAlign.Center,
        )
        if (error != null) {
            Spacer(Modifier.height(8.dp))
            Text(
                text = error,
                color = colors.statusError,
                fontSize = 11.sp,
                textAlign = TextAlign.Center,
            )
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.git_retry), fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
