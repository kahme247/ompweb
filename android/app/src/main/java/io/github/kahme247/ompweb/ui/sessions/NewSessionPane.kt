package io.github.kahme247.ompweb.ui.sessions

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.SubagentInfo
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.domain.TodoPhase
import io.github.kahme247.ompweb.domain.displayCwd
import io.github.kahme247.ompweb.domain.projectLabel
import io.github.kahme247.ompweb.net.ManagedProject
import io.github.kahme247.ompweb.net.WorktreeEntry
import io.github.kahme247.ompweb.ui.composer.ComposerBar
import io.github.kahme247.ompweb.ui.panels.ComposerPanels
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu

/**
 * New-session composer: workspace/worktree plus the same composer surface as a
 * chat (text, attachments, palettes, Slice B's model/thinking/advisor row and
 * Slice C's dictation). Creation follows `app/api/agent/new/route.ts`
 * (`ensure_session` with the spawn options, then the first prompt with images).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun NewSessionPane(
    viewModel: NewSessionViewModel,
    cwd: String?,
    projects: List<ManagedProject>,
    home: String?,
    compact: Boolean,
    onBack: () -> Unit,
    onBrowse: () -> Unit,
    onCreated: (CreatedSession) -> Unit,
    /** Installed app version for the intro line (supplied by the shell). */
    appVersion: String = "",
    /** Configured server's `/api/app-info` version, null until known. */
    serverVersion: String? = null,
    /** Planned todo/subagent panels (web renders the empty stack here). */
    todoPhases: List<TodoPhase> = emptyList(),
    subagents: List<SubagentInfo> = emptyList(),
    /** The shell's update announcement, shown below this pane's top bar. */
    updateBanner: @Composable () -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    // The picker and the worktree/project menus update the view model's cwd;
    // the incoming parameter is only the initial workspace, so the body must
    // render state.cwd.
    val selectedCwd = state.cwd
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    // A9: an invalid workspace always says so, even when the server answered
    // without a reason of its own (the controller keeps `error` empty then).
    val cwdError = state.error ?: if (state.cwdValid == false && !state.validating) {
        stringResource(R.string.cwd_invalid)
    } else {
        null
    }
    var todoCollapsed by rememberSaveable { mutableStateOf(false) }
    var subagentsCollapsed by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(cwd) { viewModel.prepare(cwd) }
    // Both the Send tap and a dictated first prompt report the session here.
    val createdHandler by rememberUpdatedState(onCreated)
    LaunchedEffect(viewModel) {
        viewModel.created.collect { created -> createdHandler(created) }
    }
    LaunchedEffect(state.notice) {
        val notice = state.notice ?: return@LaunchedEffect
        Toast.makeText(context, notice, Toast.LENGTH_SHORT).show()
        viewModel.consumeNotice()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.new_session_title)) },
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
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .imePadding(),
        ) {
            updateBanner()
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                // Web `ChatWindow`'s new-chat intro: wordmark, what this pane
                // does and the app/server versions from `/api/app-info`.
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = "omp",
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                        color = colors.accent,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = stringResource(R.string.new_session_intro_title),
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = stringResource(R.string.new_session_intro_body),
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textDim,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                    )
                    Spacer(Modifier.height(6.dp))
                    Text(
                        text = stringResource(
                            R.string.new_session_intro_versions,
                            appVersion.ifBlank { "—" },
                            serverVersion ?: "—",
                        ),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textDim,
                    )
                }

                Column {
                    Text(
                        text = stringResource(R.string.new_session_workspace),
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textDim,
                    )
                    Spacer(Modifier.height(4.dp))
                    val currentProject = projects.firstOrNull { project ->
                        selectedCwd != null &&
                            (selectedCwd == project.path || selectedCwd.startsWith(project.path))
                    }
                    DropdownField(
                        value = displayCwd(selectedCwd ?: "—", home),
                        options = projects.map { projectLabel(it) to it.path },
                        onSelect = { path -> viewModel.setCwd(path) },
                    )
                    Spacer(Modifier.height(4.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = currentProject?.path ?: selectedCwd ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.textMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        TextButton(onClick = onBrowse) {
                            Text(stringResource(R.string.new_session_browse))
                        }
                    }
                }

                if (state.worktrees.size > 1) {
                    Column {
                        Text(
                            text = stringResource(R.string.new_session_worktree),
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.textDim,
                        )
                        Spacer(Modifier.height(4.dp))
                        val current = state.worktrees.firstOrNull { it.path == selectedCwd }
                            ?: state.worktrees.firstOrNull { it.path == state.currentWorktreePath }
                            ?: state.worktrees.firstOrNull { it.isMain }
                        DropdownField(
                            value = worktreeLabel(current),
                            options = state.worktrees.map { worktreeLabel(it) to it.path },
                            onSelect = { path -> viewModel.setCwd(path) },
                        )
                    }
                }

                if (state.worktreesLoading) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(8.dp))
                        Text(stringResource(R.string.picker_loading), style = MaterialTheme.typography.bodySmall)
                    }
                }
                Spacer(Modifier.height(8.dp))
            }

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            ) {
                // A18: the same panel stack as the chat (web renders it on the
                // new chat too, with the session's plan once one exists).
                ComposerPanels(
                    todoPhases = todoPhases,
                    subagents = subagents,
                    todoCollapsed = todoCollapsed,
                    subagentsCollapsed = subagentsCollapsed,
                    onTodoCollapsedChange = { todoCollapsed = it },
                    onSubagentsCollapsedChange = { subagentsCollapsed = it },
                    onSelectSubagent = {},
                )
                if (state.validating) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(8.dp))
                        Text(stringResource(R.string.picker_loading), style = MaterialTheme.typography.bodySmall)
                    }
                }
                if (state.sending) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.size(8.dp))
                        Text(stringResource(R.string.new_session_sending), style = MaterialTheme.typography.bodySmall)
                    }
                }
                cwdError?.let { error ->
                    Text(
                        text = error,
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.statusError,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
                ComposerBar(
                    composer = viewModel.composer,
                    controls = viewModel.controls,
                    dictation = viewModel.dictation,
                    ghost = null,
                    placeholder = stringResource(R.string.composer_placeholder_new),
                    streaming = false,
                    stopping = false,
                    bashRunning = false,
                    queue = QueueSnapshotEmpty,
                    autoRetry = null,
                    submitDuringRun = SubmitDuringRunBehavior.DEFAULT,
                    onSend = viewModel::send,
                    onQueue = viewModel::send,
                    onStop = {},
                    onAbortRetry = {},
                    onAcceptGhost = {},
                    onHistory = {},
                    onQueueEdit = { _, _ -> },
                    onQueueDelete = { _, _ -> },
                    onQueueSteer = {},
                    autoFocus = true,
                    inputEnabled = !state.sending,
                )
            }
        }
    }
}

private val QueueSnapshotEmpty = io.github.kahme247.ompweb.chat.QueueSnapshot()

@Composable
private fun DropdownField(
    value: String,
    options: List<Pair<String, String>>,
    onSelect: (String) -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Box(modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(
            onClick = { expanded = true },
            shape = RoundedCornerShape(8.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = value,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null)
        }
        OmpDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (label, key) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    onClick = {
                        expanded = false
                        onSelect(key)
                    },
                )
            }
        }
    }
}

private fun worktreeLabel(worktree: WorktreeEntry?): String {
    if (worktree == null) return "—"
    val branch = worktree.branch?.takeIf { it.isNotBlank() }
    return if (branch != null) "$branch · ${worktree.path}" else worktree.path
}
