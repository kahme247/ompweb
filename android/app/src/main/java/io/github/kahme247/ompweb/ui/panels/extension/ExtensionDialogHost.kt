package io.github.kahme247.ompweb.ui.panels.extension

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.AskForm
import io.github.kahme247.ompweb.domain.AskQuestion
import io.github.kahme247.ompweb.domain.ExtensionDialogState
import io.github.kahme247.ompweb.domain.ExtensionResponse
import io.github.kahme247.ompweb.domain.initialAskForm
import io.github.kahme247.ompweb.ui.hosttools.AndroidClipboard
import io.github.kahme247.ompweb.ui.hosttools.openExternalUrl
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors

/**
 * The extension UI of the open session: the blocking dialog and, attached to
 * it, the clipboard and Custom-Tab seams the controller needs.
 *
 * The panel is always composer-attached (`attached: true` in the web), which is
 * the only placement the app has: `select` picks a row and confirms with Next,
 * `confirm`/`cancel`/system back answer `{cancelled:true}` and Enter submits
 * input. The web's overlay rendering (immediate select responses) has no
 * Android counterpart and is deliberately not reproduced.
 */
@Composable
fun ExtensionDialogHost(controller: ExtensionUiController) {
    val context = LocalContext.current
    DisposableEffect(controller, context) {
        controller.attachPlatform(
            opener = { url -> openExternalUrl(context, url) },
            clipboard = AndroidClipboard(context),
        )
        onDispose { controller.detachPlatform() }
    }
    val dialog by controller.dialog.collectAsStateWithLifecycle()
    val clipboardPrompt by controller.clipboardPrompt.collectAsStateWithLifecycle()
    if (clipboardPrompt != null) {
        ClipboardConsentDialog(
            onAllow = controller::approveClipboardRead,
            onDeny = controller::denyClipboardRead,
        )
    }
    val request = dialog ?: return
    BackHandler { controller.respond(ExtensionResponse.Cancelled(request.id)) }
    ExtensionDialogPanel(
        request = request,
        onRespond = controller::respond,
    )
}

/**
 * `pi-web://clipboard` reads are default-deny: omp asked for the clipboard and
 * the answer waits for this dialog. A denial sticks for the chat.
 */
@Composable
private fun ClipboardConsentDialog(onAllow: () -> Unit, onDeny: () -> Unit) {
    OmpAlertDialog(
        onDismissRequest = onDeny,
        title = { Text(stringResource(R.string.extension_clipboard_title)) },
        text = { Text(stringResource(R.string.extension_clipboard_body)) },
        confirmButton = {
            TextButton(onClick = onAllow) {
                Text(stringResource(R.string.extension_clipboard_allow))
            }
        },
        dismissButton = {
            TextButton(onClick = onDeny) {
                Text(stringResource(R.string.extension_clipboard_deny))
            }
        },
    )
}

@Composable
private fun ExtensionDialogPanel(
    request: ExtensionDialogState,
    onRespond: (ExtensionResponse) -> Unit,
) {
    val colors = LocalOmpColors.current
    val title = when (request) {
        is ExtensionDialogState.Ask -> stringResource(R.string.extension_ask_title)
        is ExtensionDialogState.Select -> request.title
        is ExtensionDialogState.Confirm -> request.title
        is ExtensionDialogState.Input -> request.title
        is ExtensionDialogState.Editor -> request.title
    }

    var value by remember(request.id) {
        mutableStateOf((request as? ExtensionDialogState.Editor)?.prefill.orEmpty())
    }
    var selectedOption by remember(request.id) { mutableStateOf<String?>(null) }
    var form by remember(request.id) { mutableStateOf(initialAskForm((request as? ExtensionDialogState.Ask)?.questions.orEmpty())) }
    val questions = (request as? ExtensionDialogState.Ask)?.questions.orEmpty()
    val otherFocus = remember(request.id) { List(questions.size) { FocusRequester() } }
    val inputHint = (request as? ExtensionDialogState.Input)?.placeholder
    val inputPlaceholder: (@Composable () -> Unit)? = if (inputHint != null) {
        { Text(inputHint) }
    } else {
        null
    }

    val canSubmit = when (request) {
        is ExtensionDialogState.Select -> selectedOption != null
        is ExtensionDialogState.Ask -> form.canSubmit(questions)
        else -> true
    }

    val submit: () -> Unit = {
        when (request) {
            is ExtensionDialogState.Select -> selectedOption?.let {
                onRespond(ExtensionResponse.Value(request.id, it))
            }

            is ExtensionDialogState.Confirm ->
                onRespond(ExtensionResponse.Confirmed(request.id, true))

            is ExtensionDialogState.Input ->
                onRespond(ExtensionResponse.Value(request.id, value))

            is ExtensionDialogState.Editor ->
                onRespond(ExtensionResponse.Value(request.id, value))

            is ExtensionDialogState.Ask -> if (form.canSubmit(questions)) {
                onRespond(ExtensionResponse.Answers(request.id, form.answers(questions)))
            }
        }
    }
    val cancel = { onRespond(ExtensionResponse.Cancelled(request.id)) }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp),
        shape = RoundedCornerShape(10.dp),
        color = colors.panel,
        contentColor = colors.text,
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column {
            Column(Modifier.padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = 8.dp)) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    stringResource(R.string.extension_request),
                    fontFamily = FontFamily.Monospace,
                    color = colors.textDim,
                    style = MaterialTheme.typography.labelSmall,
                )
            }
            Column(
                Modifier
                    // The body is the only flexible part: on a short window
                    // (split screen, 200 % font) it shrinks and scrolls instead
                    // of squeezing the action row below it to a few pixels.
                    .weight(1f, fill = false)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 14.dp, vertical = 6.dp),
            ) {
                when (request) {
                    is ExtensionDialogState.Confirm -> Text(request.message)
                    is ExtensionDialogState.Select -> ExtensionSelect(request, selectedOption) {
                        selectedOption = it
                    }

                    is ExtensionDialogState.Input -> OutlinedTextField(
                        value = value,
                        onValueChange = { value = it },
                        placeholder = inputPlaceholder,
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { submit() }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .onPreviewKeyEvent { event ->
                                val enter = event.key == Key.Enter && event.type == KeyEventType.KeyDown
                                if (enter) submit()
                                enter
                            },
                    )

                    is ExtensionDialogState.Editor -> OutlinedTextField(
                        value = value,
                        onValueChange = { value = it },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                        textStyle = if (request.promptStyle) {
                            MaterialTheme.typography.bodyMedium
                        } else {
                            MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 88.dp, max = 220.dp)
                            .onPreviewKeyEvent { event ->
                                val submitShortcut = event.type == KeyEventType.KeyDown &&
                                    event.isCtrlPressed && event.key == Key.Enter
                                if (submitShortcut) submit()
                                submitShortcut
                            },
                    )

                    is ExtensionDialogState.Ask -> ExtensionAskFields(
                        questions = questions,
                        form = form,
                        otherFocus = otherFocus,
                        onFormChange = { form = it },
                        onSubmit = submit,
                    )
                }
            }
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = cancel) { Text(stringResource(R.string.extension_cancel)) }
                Spacer(Modifier.width(8.dp))
                when (request) {
                    is ExtensionDialogState.Confirm -> Button(onClick = submit) {
                        Text(stringResource(R.string.extension_confirm))
                    }

                    is ExtensionDialogState.Select -> Button(onClick = submit, enabled = canSubmit) {
                        Text(stringResource(R.string.extension_next))
                    }

                    is ExtensionDialogState.Ask -> Button(onClick = submit, enabled = canSubmit) {
                        Text(stringResource(R.string.extension_submit))
                    }

                    is ExtensionDialogState.Input, is ExtensionDialogState.Editor -> Button(onClick = submit) {
                        Text(stringResource(R.string.extension_submit))
                    }
                }
            }
        }
    }
}

@Composable
private fun ExtensionSelect(
    request: ExtensionDialogState.Select,
    selected: String?,
    onSelect: (String) -> Unit,
) {
    val colors = LocalOmpColors.current
    Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        request.options.forEach { option ->
            val isSelected = selected == option
            Text(
                text = option,
                modifier = Modifier
                    .fillMaxWidth()
                    .border(
                        1.dp,
                        if (isSelected) colors.accent else colors.border,
                        RoundedCornerShape(6.dp),
                    )
                    .background(
                        if (isSelected) colors.selected else colors.panel,
                        RoundedCornerShape(6.dp),
                    )
                    .selectable(selected = isSelected, role = Role.RadioButton) { onSelect(option) }
                    .padding(horizontal = 10.dp, vertical = 9.dp),
            )
        }
    }
}

@Composable
private fun ExtensionAskFields(
    questions: List<AskQuestion>,
    form: AskForm,
    otherFocus: List<FocusRequester>,
    onFormChange: (AskForm) -> Unit,
    onSubmit: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        questions.forEachIndexed { index, question ->
            val draft = form.draftAt(index)
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    question.header?.let { header ->
                        Text(
                            header,
                            modifier = Modifier
                                .border(1.dp, colors.border, RoundedCornerShape(999.dp))
                                .padding(horizontal = 7.dp, vertical = 1.dp),
                            color = colors.textMuted,
                            style = MaterialTheme.typography.labelSmall,
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(question.question, style = MaterialTheme.typography.bodyMedium)
                }
                Spacer(Modifier.width(8.dp))
                Column(
                    Modifier.selectableGroup(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    question.options.forEachIndexed { optionIndex, option ->
                        val checked = option.label in draft.selected
                        AskOptionRow(
                            checked = checked,
                            multi = question.multi,
                            label = option.label,
                            description = option.description,
                            preview = option.preview,
                            recommended = optionIndex == question.recommended,
                            onCheckedChange = {
                                onFormChange(form.toggleOption(questions, index, option.label))
                            },
                        )
                    }
                    AskOtherRow(
                        question = question,
                        draftOther = draft.other,
                        chosen = draft.otherChosen,
                        focusRequester = otherFocus.getOrNull(index),
                        onChoose = { chosen ->
                            onFormChange(form.chooseOther(questions, index, chosen))
                            if (chosen) otherFocus.getOrNull(index)?.requestFocus()
                        },
                        onFocusOther = {
                            onFormChange(form.focusOther(questions, index))
                        },
                        onTextChange = { text ->
                            onFormChange(form.setOther(questions, index, text))
                        },
                        onSubmit = onSubmit,
                    )
                }
            }
        }
    }
}

@Composable
private fun AskOptionRow(
    checked: Boolean,
    multi: Boolean,
    label: String,
    description: String?,
    preview: String?,
    recommended: Boolean,
    onCheckedChange: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        Modifier
            .fillMaxWidth()
            .border(1.dp, if (checked) colors.accent else colors.border, RoundedCornerShape(7.dp))
            .background(
                if (checked) colors.selected else colors.panel,
                RoundedCornerShape(7.dp),
            )
            .then(
                if (multi) {
                    Modifier.toggleable(value = checked, role = Role.Checkbox) { onCheckedChange() }
                } else {
                    Modifier.selectable(selected = checked, role = Role.RadioButton) { onCheckedChange() }
                },
            )
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        if (multi) {
            Checkbox(checked = checked, onCheckedChange = { onCheckedChange() })
        } else {
            RadioButton(selected = checked, onClick = { onCheckedChange() })
        }
        Spacer(Modifier.width(6.dp))
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.bodyMedium)
                if (recommended) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        stringResource(R.string.extension_ask_recommended),
                        color = colors.accent,
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            description?.let {
                Text(it, color = colors.textMuted, style = MaterialTheme.typography.bodySmall)
            }
            preview?.let {
                Text(
                    it,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 6.dp)
                        .background(colors.toolBackground, RoundedCornerShape(6.dp))
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
    }
}

@Composable
private fun AskOtherRow(
    question: AskQuestion,
    draftOther: String,
    chosen: Boolean,
    focusRequester: FocusRequester?,
    onChoose: (Boolean) -> Unit,
    onFocusOther: () -> Unit,
    onTextChange: (String) -> Unit,
    onSubmit: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        Modifier
            .fillMaxWidth()
            .border(1.dp, if (chosen) colors.accent else colors.border, RoundedCornerShape(7.dp))
            .background(
                if (chosen) colors.selected else colors.panel,
                RoundedCornerShape(7.dp),
            )
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        if (question.multi) {
            Checkbox(checked = chosen, onCheckedChange = onChoose)
        } else {
            RadioButton(selected = chosen, onClick = { onChoose(true) })
        }
        Spacer(Modifier.width(6.dp))
        OutlinedTextField(
            value = draftOther,
            onValueChange = onTextChange,
            placeholder = { Text(stringResource(R.string.extension_ask_other)) },
            maxLines = 4,
            modifier = Modifier
                .weight(1f)
                .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                .onFocusChanged { focus ->
                    // Tapping back into kept Other text answers with it again (web `onFocus`).
                    if (focus.isFocused) onFocusOther()
                }
                .onPreviewKeyEvent { event ->
                    if (event.type == KeyEventType.KeyDown && event.isCtrlPressed && event.key == Key.Enter) {
                        onSubmit()
                        true
                    } else {
                        false
                    }
                },
        )
    }
}
