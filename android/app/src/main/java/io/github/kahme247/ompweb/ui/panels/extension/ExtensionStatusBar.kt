package io.github.kahme247.ompweb.ui.panels.extension

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.ExtensionStatusItem
import io.github.kahme247.ompweb.domain.ExtensionWidgetItem
import io.github.kahme247.ompweb.domain.ExtensionWidgetPlacement
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The extension status bar (`setStatus` frames) and the above-editor widgets
 * (`setWidget`, placement `aboveEditor`), exactly where the web renders them:
 * in the chat column above the panel stack.
 */
@Composable
fun ExtensionStatusBar(controller: ExtensionUiController) {
    val statuses by controller.statusItems.collectAsStateWithLifecycle()
    val widgets by controller.widgets.collectAsStateWithLifecycle()
    ExtensionStatusItems(statuses)
    ExtensionWidgetList(widgets.filter { it.placement == ExtensionWidgetPlacement.AboveEditor })
}

/**
 * The deferred `open_url`: an extension URL never opens by itself, the user
 * taps Open here (S4 on the phase-7 review). Dismissing drops the request.
 */
@Composable
fun ExtensionOpenUrlNotice(controller: ExtensionUiController) {
    val prompt by controller.openUrlPrompt.collectAsStateWithLifecycle()
    val current = prompt ?: return
    val colors = LocalOmpColors.current
    val text = if (current.instructions.isNullOrBlank()) {
        stringResource(R.string.extension_open_url_offer, current.url)
    } else {
        stringResource(R.string.extension_open_url_instructions, current.instructions, current.url)
    }
    Surface(
        color = colors.accent.copy(alpha = 0.08f),
        contentColor = colors.text,
        shape = RoundedCornerShape(6.dp),
        border = BorderStroke(1.dp, colors.accent.copy(alpha = 0.32f)),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier = Modifier.padding(start = 9.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
            Text(
                text = text,
                fontSize = 11.5.sp,
                modifier = Modifier.weight(1f),
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            TextButton(onClick = controller::openUrlNow) {
                Text(stringResource(R.string.extension_open_url_open), fontSize = 11.sp, color = colors.accent)
            }
            TextButton(onClick = controller::dismissOpenUrl) {
                Text(stringResource(R.string.extension_open_url_dismiss), fontSize = 11.sp, color = colors.textMuted)
            }
        }
    }
}

/**
 * The widgets of one placement. The composer area renders the `belowEditor`
 * widgets through
 * `ExtensionWidgets(controller, ExtensionWidgetPlacement.BelowEditor)`; both
 * placements share this list.
 */
@Composable
fun ExtensionWidgets(controller: ExtensionUiController, placement: ExtensionWidgetPlacement) {
    val widgets by controller.widgets.collectAsStateWithLifecycle()
    ExtensionWidgetList(widgets.filter { it.placement == placement })
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ExtensionStatusItems(statuses: List<ExtensionStatusItem>) {
    if (statuses.isEmpty()) return
    val colors = LocalOmpColors.current
    FlowRow(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        statuses.forEach { status ->
            Surface(
                shape = RoundedCornerShape(6.dp),
                color = colors.accent.copy(alpha = 0.07f),
                contentColor = colors.textMuted,
                border = BorderStroke(1.dp, colors.accent.copy(alpha = 0.24f)),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        status.key,
                        color = colors.accent,
                        fontFamily = FontFamily.Monospace,
                        style = MaterialTheme.typography.labelSmall,
                    )
                    Text(
                        stripAnsi(status.text),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.widthIn(max = 240.dp),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun ExtensionWidgetList(widgets: List<ExtensionWidgetItem>) {
    if (widgets.isEmpty()) return
    val colors = LocalOmpColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        widgets.forEach { widget ->
            Surface(
                shape = RoundedCornerShape(6.dp),
                color = colors.panel,
                contentColor = colors.text,
                border = BorderStroke(1.dp, colors.border),
            ) {
                AnsiLines(
                    lines = widget.lines,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 9.dp, vertical = 8.dp),
                    fontSize = 12.sp,
                )
            }
        }
    }
}
