package io.github.kahme247.ompweb.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.ProjectLaunchConfig
import io.github.kahme247.ompweb.net.SessionSummary
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/** True for the keys that confirm a single-line text dialog. */
private fun isEnter(key: Key): Boolean = key == Key.Enter || key == Key.NumPadEnter

/** Web no-op rules: an empty or unchanged name is neither sent nor stored. */
internal fun renamedValue(initial: String, edited: String): String? {
    val name = edited.trim()
    return name.takeIf { it.isNotEmpty() && it != initial.trim() }
}

/**
 * The rename field (A21): Enter commits, Esc cancels, leaving the field
 * commits. Extracted from [NameDialog] because a `Dialog` window never becomes
 * idle under Robolectric (upstream Compose bug with popup text fields), so the
 * keyboard contract is tested with this field rendered inline.
 */
@Composable
internal fun NameField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    onCommit: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var focused by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        modifier = modifier
            .fillMaxWidth()
            .testTag("name-dialog-field")
            .onFocusChanged { state ->
                if (state.isFocused) focused = true else if (focused) onCommit()
            }
            .onPreviewKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                when {
                    isEnter(event.key) -> {
                        onCommit()
                        true
                    }
                    event.key == Key.Escape -> {
                        onCancel()
                        true
                    }
                    else -> false
                }
            },
    )
}

/**
 * Shared rename prompt for sessions and project aliases.
 *
 * Web `SessionSidebar-rows.tsx` commits a rename on Enter and on blur (only
 * when the trimmed value differs and is not empty) and cancels on Esc; the
 * dialog used to be button-only (A21).
 */
@Composable
internal fun NameDialog(
    title: String,
    label: String,
    initial: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    var value by rememberSaveable(initial) { mutableStateOf(initial) }
    // Set before the dialog closes so the blur that follows the click on
    // Cancel/Esc cannot commit the value as well.
    var settled by remember { mutableStateOf(false) }

    fun commit() {
        if (settled) return
        settled = true
        val name = renamedValue(initial, value)
        if (name == null) onDismiss() else onConfirm(name)
    }

    fun cancel() {
        if (settled) return
        settled = true
        onDismiss()
    }

    OmpAlertDialog(
        onDismissRequest = ::cancel,
        title = { Text(title) },
        text = {
            NameField(
                value = value,
                onValueChange = { value = it },
                label = label,
                onCommit = ::commit,
                onCancel = ::cancel,
            )
        },
        confirmButton = {
            TextButton(onClick = ::commit, enabled = value.isNotBlank()) {
                Text(stringResource(R.string.common_rename))
            }
        },
        dismissButton = {
            TextButton(onClick = ::cancel) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

@Composable
internal fun ConfirmDialog(
    title: String,
    body: String,
    confirmLabel: String,
    danger: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOmpColors.current
    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = { Text(body) },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(
                    text = confirmLabel,
                    color = if (danger) colors.statusError else colors.accent,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.common_cancel))
            }
        },
    )
}

/** Workspace launch configuration (`components/ProjectLaunchConfigDialog.tsx`). */
@Composable
internal fun LaunchConfigDialog(
    project: ManagedProject,
    onSave: (ProjectLaunchConfig?) -> Unit,
    onDismiss: () -> Unit,
) {
    val config = project.launchConfig
    var profile by rememberSaveable(project.path) { mutableStateOf(config?.profile.orEmpty()) }
    var advisor by rememberSaveable(project.path) { mutableStateOf(config?.advisor == true) }
    var extraArgs by rememberSaveable(project.path) {
        mutableStateOf(config?.extraArgs?.joinToString("\n").orEmpty())
    }
    val colors = LocalOmpColors.current

    OmpAlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.launch_title)) },
        text = {
            Column(modifier = Modifier.heightIn(max = 460.dp)) {
                Text(
                    text = project.path,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                )
                Spacer(Modifier.height(6.dp))
                OutlinedTextField(
                    value = profile,
                    onValueChange = { profile = it },
                    label = { Text(stringResource(R.string.launch_profile)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = advisor, onCheckedChange = { advisor = it })
                    Text(stringResource(R.string.launch_advisor))
                }
                OutlinedTextField(
                    value = extraArgs,
                    onValueChange = { extraArgs = it },
                    label = { Text(stringResource(R.string.launch_extra_args)) },
                    minLines = 2,
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    text = stringResource(R.string.picker_reserved),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val args = extraArgs.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
                    val next = ProjectLaunchConfig(
                        profile = profile.trim().takeIf { it.isNotEmpty() },
                        advisor = advisor.takeIf { it },
                        extraArgs = args.takeIf { it.isNotEmpty() },
                    )
                    onSave(next.takeIf { !it.isEmpty() })
                },
            ) {
                Text(stringResource(R.string.launch_save))
            }
        },
        dismissButton = {
            Row {
                TextButton(onClick = { onSave(null) }) {
                    Text(stringResource(R.string.launch_clear))
                }
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.launch_cancel))
                }
            }
        },
    )
}

/**
 * Ctrl+K / "Go to session" (`components/CommandPalette.tsx`): sessions first,
 * then "New session" and "Theme", then the current model as a disabled
 * information line. ↑/↓/Home/End move the roving selection (disabled rows are
 * skipped), Enter activates it, Esc closes (A7).
 */
@Composable
internal fun QuickSwitcherDialog(
    sessions: List<SessionSummary>,
    runningIds: Set<String>,
    home: String?,
    /** Display name of the composer's model, null while unknown. */
    currentModel: String?,
    onSelectSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onChangeTheme: () -> Unit,
    onDismiss: () -> Unit,
) {
    OmpDialog(onDismissRequest = onDismiss) {
        Surface(shape = MaterialTheme.shapes.large) {
            QuickSwitcherContent(
                sessions = sessions,
                runningIds = runningIds,
                home = home,
                currentModel = currentModel,
                onSelectSession = onSelectSession,
                onNewSession = onNewSession,
                onChangeTheme = onChangeTheme,
                onDismiss = onDismiss,
            )
        }
    }
}

/**
 * The palette body (A7): query, roving selection and the rows. Separate from
 * [QuickSwitcherDialog] because a dialog opens its own window, which the
 * screenshot matrix cannot capture; the golden renders this content inside
 * the matrix surface.
 */
@Composable
internal fun QuickSwitcherContent(
    sessions: List<SessionSummary>,
    runningIds: Set<String>,
    home: String?,
    currentModel: String?,
    onSelectSession: (String) -> Unit,
    onNewSession: () -> Unit,
    onChangeTheme: () -> Unit,
    onDismiss: () -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    val colors = LocalOmpColors.current
    val untitled = stringResource(R.string.session_untitled)
    val items = quickSwitcherItems(
        query = query,
        sessions = sessions,
        runningIds = runningIds,
        currentModel = currentModel,
        untitledLabel = untitled,
        newSessionLabel = stringResource(R.string.quick_switcher_new),
        themeLabel = stringResource(R.string.menu_theme),
        modelLabel = stringResource(R.string.quick_switcher_current_model),
        home = home,
    )
    var activeIndex by remember { mutableIntStateOf(quickSwitcherFirst(items)) }
    // A new filter always selects the first enabled row.
    LaunchedEffect(query) { activeIndex = quickSwitcherFirst(items) }

    fun activate(item: QuickSwitcherItem?) {
        if (item == null || !item.enabled) return
        when (item.kind) {
            QuickSwitcherKind.Session -> item.sessionId?.let {
                onDismiss()
                onSelectSession(it)
            }
            QuickSwitcherKind.NewSession -> {
                onDismiss()
                onNewSession()
            }
            QuickSwitcherKind.Theme -> {
                onDismiss()
                onChangeTheme()
            }
            // The model line is information only.
            QuickSwitcherKind.Model -> Unit
        }
    }

    val searchFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { searchFocus.requestFocus() }

    Column(modifier = Modifier.padding(12.dp)) {
        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text(stringResource(R.string.quick_switcher_search)) },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(searchFocus)
                .onPreviewKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    when (event.key) {
                        // The web's Ctrl/Cmd+K toggles: while the palette owns
                        // the window it must close itself (B17/Bug 8).
                        Key.K -> {
                            if (!event.isCtrlPressed && !event.isMetaPressed) return@onPreviewKeyEvent false
                            onDismiss()
                            true
                        }
                        Key.DirectionDown -> {
                            activeIndex = quickSwitcherMove(items, activeIndex, 1)
                            true
                        }
                        Key.DirectionUp -> {
                            activeIndex = quickSwitcherMove(items, activeIndex, -1)
                            true
                        }
                        Key.MoveHome -> {
                            activeIndex = quickSwitcherFirst(items)
                            true
                        }
                        Key.MoveEnd -> {
                            activeIndex = quickSwitcherLast(items)
                            true
                        }
                        Key.Enter, Key.NumPadEnter -> {
                            activate(items.getOrNull(activeIndex))
                            true
                        }
                        Key.Escape -> {
                            onDismiss()
                            true
                        }
                        else -> false
                    }
                },
        )
        Spacer(Modifier.height(8.dp))
        Column(
            modifier = Modifier
                .heightIn(max = 420.dp)
                .fillMaxWidth(),
        ) {
            if (items.isEmpty()) {
                Text(
                    text = stringResource(R.string.quick_switcher_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textDim,
                    modifier = Modifier.padding(vertical = 16.dp),
                )
            } else {
                LazyColumn {
                    itemsIndexed(items = items, key = { _, item ->
                        "${item.kind}:${item.sessionId ?: item.label}"
                    }) { index, item ->
                        QuickSwitcherRow(
                            item = item,
                            active = index == activeIndex,
                            onClick = { activate(item) },
                        )
                    }
                }
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = stringResource(R.string.quick_switcher_hints),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textDim,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
        }
    }
}

@Composable
private fun QuickSwitcherRow(
    item: QuickSwitcherItem,
    active: Boolean,
    onClick: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(6.dp))
            .background(if (active) colors.hover else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(enabled = item.enabled, onClick = onClick)
            .testTag("quick-${item.kind.name.lowercase()}-${item.sessionId ?: item.label}")
            .padding(vertical = 8.dp, horizontal = 4.dp),
    ) {
        when (item.kind) {
            QuickSwitcherKind.Session -> Box(
                modifier = Modifier
                    .padding(end = 8.dp)
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(if (item.running) colors.statusSuccess else colors.textDim),
            )
            else -> Box(Modifier.padding(end = 8.dp))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = item.label,
                color = when {
                    !item.enabled -> colors.textDim
                    item.kind == QuickSwitcherKind.Session -> MaterialTheme.colorScheme.onSurface
                    else -> colors.accent
                },
                fontWeight = if (item.kind == QuickSwitcherKind.Session) null else FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val detail = item.detail
            if (!detail.isNullOrEmpty()) {
                Text(
                    text = detail,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textDim,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
