package io.github.kahme247.ompweb.ui.hosttools

import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.HostToolKind
import io.github.kahme247.ompweb.domain.HostToolPrompt

/**
 * The consent dialog for a host-tool call (`open_url` / `open_file`) and the
 * Android actions behind it. Web `AppShell` shows one prompt at a time from a
 * queue; the controller keeps that queue, this host renders its head.
 *
 * The call itself is already answered when the prompt appears (web
 * `requestOpenUrl` answers "Asked the user to confirm …"), so declining only
 * dismisses the prompt — the agent never waits for it.
 */
@Composable
fun HostToolPromptHost(
    controller: HostToolsController,
    onOpenFile: (sessionId: String, path: String) -> Unit,
) {
    val context = LocalContext.current
    val latestOpenFile by rememberUpdatedState(onOpenFile)
    DisposableEffect(controller, context) {
        controller.attach(
            opener = AndroidHostToolOpener(context),
            onOpenFile = { sessionId, path -> latestOpenFile(sessionId, path) },
        )
        onDispose { controller.detach() }
    }
    val prompt by controller.pending.collectAsStateWithLifecycle()
    val current = prompt ?: return
    OmpAlertDialog(
        onDismissRequest = controller::deny,
        title = { Text(stringResource(titleRes(current))) },
        text = { Text(stringResource(bodyRes(current), current.target)) },
        confirmButton = {
            TextButton(onClick = controller::approve) {
                Text(stringResource(R.string.host_tool_open))
            }
        },
        dismissButton = {
            TextButton(onClick = controller::deny) {
                Text(stringResource(R.string.host_tool_cancel))
            }
        },
    )
}

private fun titleRes(prompt: HostToolPrompt): Int = when {
    prompt.kind == HostToolKind.OpenFile -> R.string.host_tool_open_file_title
    prompt.crossSession -> R.string.host_tool_open_url_cross_session_title
    else -> R.string.host_tool_open_url_same_session_title
}

private fun bodyRes(prompt: HostToolPrompt): Int = when {
    prompt.kind == HostToolKind.OpenFile -> R.string.host_tool_open_file_body
    prompt.crossSession -> R.string.host_tool_open_url_cross_session_body
    else -> R.string.host_tool_open_url_same_session_body
}
