package io.github.kahme247.ompweb.ui.panels.extension

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.terminalKeyData
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/** `\u0003` is the Ctrl+C the extension terminal expects from its Stop/Back action. */
private const val TERMINAL_INTERRUPT = "\u0003"

/**
 * The custom extension panel (`method: "custom"` frames), a full-screen
 * terminal that sends `extension_ui_input` for every key. Back and Close send
 * Ctrl+C and close the panel locally, as the web modal does; the extension can
 * still send `closed: true` to end it.
 */
@Composable
fun ExtensionTerminalPanel(controller: ExtensionUiController) {
    val terminal by controller.terminal.collectAsStateWithLifecycle()
    val state = terminal ?: return
    var dismissed by remember(state.id) { mutableStateOf(false) }
    if (dismissed) return

    val close = {
        controller.sendInput(JsonPrimitive(TERMINAL_INTERRUPT))
        dismissed = true
    }
    OmpDialog(
        onDismissRequest = close,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        ExtensionTerminalSheet(
            lines = normalizeCustomPanelLines(state.lines),
            onInput = controller::sendInput,
            onClose = close,
        )
    }
}

@Composable
private fun ExtensionTerminalSheet(
    lines: List<String>,
    onInput: (JsonElement) -> Unit,
    onClose: () -> Unit,
) {
    val colors = LocalOmpColors.current
    var input by remember { mutableStateOf("") }
    val send = { text: String ->
        if (text.isNotEmpty()) onInput(JsonPrimitive(text))
        input = ""
    }
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = colors.background,
        contentColor = colors.text,
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    stringResource(R.string.extension_terminal_title),
                    style = MaterialTheme.typography.titleSmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { onInput(JsonPrimitive(TERMINAL_INTERRUPT)) }) {
                        Text("Ctrl+C")
                    }
                    TextButton(onClick = onClose) {
                        Text(stringResource(R.string.extension_close))
                    }
                }
            }
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .padding(horizontal = 12.dp),
                shape = RoundedCornerShape(8.dp),
                color = colors.panel,
                contentColor = colors.text,
                border = BorderStroke(1.dp, colors.border),
            ) {
                AnsiLines(
                    lines = lines.ifEmpty { listOf("") },
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(10.dp),
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                )
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text(stringResource(R.string.extension_terminal_input)) },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { send(input) }),
                    modifier = Modifier
                        .weight(1f)
                        .onPreviewKeyEvent { event ->
                            if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                            val key = terminalKeyName(event.key) ?: return@onPreviewKeyEvent false
                            val data = terminalKeyData(
                                key = key,
                                ctrl = event.isCtrlPressed,
                                alt = event.isAltPressed,
                                shift = event.isShiftPressed,
                            ) ?: return@onPreviewKeyEvent false
                            // A visible input line buffers what the web's hidden
                            // textarea fires per keystroke: Enter commits it first.
                            if (key == "Enter" && input.isNotEmpty()) {
                                onInput(JsonPrimitive(input))
                                input = ""
                            }
                            onInput(JsonPrimitive(data))
                            true
                        },
                )
                TextButton(onClick = { send(input) }, enabled = input.isNotEmpty()) {
                    Text(stringResource(R.string.extension_submit))
                }
            }
        }
    }
}

/** Compose key → the DOM name [terminalKeyData] understands. */
private fun terminalKeyName(key: Key): String? = when (key) {
    Key.Enter, Key.NumPadEnter -> "Enter"
    Key.Tab -> "Tab"
    Key.Backspace -> "Backspace"
    Key.Escape -> "Escape"
    Key.DirectionUp -> "ArrowUp"
    Key.DirectionDown -> "ArrowDown"
    Key.DirectionLeft -> "ArrowLeft"
    Key.DirectionRight -> "ArrowRight"
    Key.MoveHome -> "Home"
    Key.MoveEnd -> "End"
    Key.Insert -> "Insert"
    Key.Delete -> "Delete"
    Key.PageUp -> "PageUp"
    Key.PageDown -> "PageDown"
    else -> null
}
