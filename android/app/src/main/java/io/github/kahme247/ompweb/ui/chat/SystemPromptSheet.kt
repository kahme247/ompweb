package io.github.kahme247.ompweb.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDialog

/**
 * Lazy-loaded system prompt of the bound session (web `AppShell` terminal
 * popover). Read-only: the prompt is composed by omp from the host config, the
 * project and the tool set, so editing here would lie about what is running.
 */
sealed interface SystemPromptState {
    /** Panel closed; nothing was requested yet. */
    data object Idle : SystemPromptState

    data object Loading : SystemPromptState

    data class Loaded(val text: String) : SystemPromptState

    /** omp answered with an empty prompt (e.g. tools disabled). */
    data object Empty : SystemPromptState

    /** Request failed, or this omp build does not serve `systemPrompt`. */
    data class Failed(val reason: String?) : SystemPromptState
}

@Composable
internal fun SystemPromptSheet(state: SystemPromptState, onDismiss: () -> Unit) {
    if (state is SystemPromptState.Idle) return
    OmpDialog(onDismissRequest = onDismiss) {
        SystemPromptBody(state = state, onDismiss = onDismiss)
    }
}

/**
 * The sheet's content without the dialog window. Dialogs compose in their own
 * window, so screenshots and layout checks render this body inside the
 * hardened matrix (200 % font) instead.
 */
@Composable
internal fun SystemPromptBody(state: SystemPromptState, onDismiss: () -> Unit) {
    if (state is SystemPromptState.Idle) return
    val colors = LocalOmpColors.current
    Surface(
        color = colors.panel,
        contentColor = colors.text,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier
                .heightIn(max = 560.dp)
                .verticalScroll(rememberScrollState())
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(R.string.system_prompt_title),
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = stringResource(R.string.system_prompt_close),
                        tint = colors.textMuted,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
            when (state) {
                is SystemPromptState.Loading -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(14.dp),
                        strokeWidth = 1.5.dp,
                        color = colors.textMuted,
                    )
                    Text(
                        text = stringResource(R.string.system_prompt_loading),
                        color = colors.textMuted,
                        fontSize = 12.sp,
                    )
                }

                is SystemPromptState.Loaded -> Text(
                    text = state.text,
                    color = colors.text,
                    fontSize = 12.sp,
                    fontFamily = FontFamily.Monospace,
                )

                is SystemPromptState.Empty -> Text(
                    text = stringResource(R.string.system_prompt_empty),
                    color = colors.textMuted,
                    fontSize = 12.sp,
                )

                is SystemPromptState.Failed -> Text(
                    text = state.reason ?: stringResource(R.string.system_prompt_unavailable),
                    color = colors.statusError,
                    fontSize = 12.sp,
                )

                is SystemPromptState.Idle -> Unit
            }
        }
    }
}
