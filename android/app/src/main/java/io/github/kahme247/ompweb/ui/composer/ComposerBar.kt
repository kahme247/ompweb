package io.github.kahme247.ompweb.ui.composer

import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.chat.AutoRetry
import io.github.kahme247.ompweb.chat.QueueSnapshot
import io.github.kahme247.ompweb.domain.AttachedTextFile
import io.github.kahme247.ompweb.domain.ComposerImage
import io.github.kahme247.ompweb.domain.DictationState
import io.github.kahme247.ompweb.domain.SttAfter
import io.github.kahme247.ompweb.domain.SubmitDuringRunBehavior
import io.github.kahme247.ompweb.domain.streamingSubmitBehavior
import io.github.kahme247.ompweb.domain.ToolPreset
import io.github.kahme247.ompweb.domain.WordGhost
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsRow
import io.github.kahme247.ompweb.ui.composer.controls.ContextDetailSheet
import io.github.kahme247.ompweb.ui.composer.controls.ComposerControlsViewModel
import io.github.kahme247.ompweb.ui.composer.controls.ghostTextTransformation
import io.github.kahme247.ompweb.ui.composer.dictation.DictationViewModel
import io.github.kahme247.ompweb.ui.composer.dictation.LiveDictationStrip
import io.github.kahme247.ompweb.ui.composer.dictation.MicButton
import io.github.kahme247.ompweb.ui.composer.dictation.RecordingDeck
import io.github.kahme247.ompweb.ui.composer.dictation.ReportVisibility
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpDropdownMenu
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The shared composer surface (`components/ChatInput.tsx`): attachments, the
 * slash/at/history palettes, the queue bar, status and auto-retry banners, word
 * prediction, dictation and the primary Send/Queue/Stop action.
 *
 * The chat screen and the new-session pane render the same composable; both
 * own the view model that routes the actions.
 */
@Composable
fun ComposerBar(
    composer: ComposerController,
    controls: ComposerControlsViewModel,
    dictation: DictationViewModel,
    ghost: WordGhost?,
    placeholder: String,
    streaming: Boolean,
    stopping: Boolean,
    bashRunning: Boolean,
    queue: QueueSnapshot,
    autoRetry: AutoRetry?,
    submitDuringRun: SubmitDuringRunBehavior,
    /** A submit is waiting for the live run state; the action reads "Sending…". */
    submitting: Boolean = false,
    onSend: () -> Unit,
    onQueue: () -> Unit,
    onStop: () -> Unit,
    onAbortRetry: () -> Unit,
    onAcceptGhost: () -> Unit,
    onHistory: () -> Unit,
    onQueueEdit: (String, String) -> Unit,
    onQueueDelete: (String, String) -> Unit,
    onQueueSteer: (String) -> Unit,
    modifier: Modifier = Modifier,
    autoFocus: Boolean = false,
    inputEnabled: Boolean = true,
    /** Web `onMinimize`: Esc in an idle, empty composer collapses it into the pill. */
    onMinimize: (() -> Unit)? = null,
    /**
     * Cap of the text field (`ChatLayout.plan`). The field scrolls internally
     * beyond it, so a long draft can never push the transcript out of the pane.
     */
    textFieldMaxHeight: Dp = 180.dp,
    /** Lines the field shows before it scrolls (height and lines cap together). */
    textFieldMaxLines: Int = 9,
    /**
     * The model / thinking / tools row. Hidden while the keyboard is open on a
     * phone so the transcript keeps its height; the row returns as soon as the
     * IME closes (back), and it is reachable before opening the keyboard.
     */
    showControlsRow: Boolean = true,
) {
    val state by composer.state.collectAsStateWithLifecycle()
    val controlsState by controls.state.collectAsStateWithLifecycle()
    val dictationState by dictation.state.collectAsStateWithLifecycle()
    // The composer shell stays mounted while dictation is Live, unlike the mic
    // button and the recording deck, so report ON_START/ON_STOP here: a
    // backgrounded live capture must commit its partial and stop listening.
    ReportVisibility(dictation)
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    val resources = LocalResources.current
    val scope = rememberCoroutineScope()
    val focusRequester = remember { FocusRequester() }

    var field by remember {
        mutableStateOf(
            TextFieldValue(
                text = state.text,
                selection = TextRange(state.caret.coerceIn(0, state.text.length)),
            ),
        )
    }
    var plusOpen by remember { mutableStateOf(false) }
    var queueExpanded by remember { mutableStateOf(false) }
    var deleteTarget by remember { mutableStateOf<Pair<String, String>?>(null) }
    var cameraTarget by remember { mutableStateOf<CameraTarget?>(null) }

    // Programmatic edits (palette accept, history, restore) carry an id; user
    // typing never does, so the field keeps the IME composition intact.
    LaunchedEffect(state.edit) {
        val edit = state.edit ?: return@LaunchedEffect
        if (field.text != edit.text || field.selection.start != edit.caret) {
            field = TextFieldValue(edit.text, TextRange(edit.caret.coerceIn(0, edit.text.length)))
        }
    }
    LaunchedEffect(state.draft.value) {
        // Draft restore from another owner (recoverDraft) without an edit id.
        if (state.edit == null && field.text != state.draft.value) {
            field = TextFieldValue(
                state.draft.value,
                TextRange(state.caret.coerceIn(0, state.draft.value.length)),
            )
        }
    }
    LaunchedEffect(autoFocus) {
        if (autoFocus) focusRequester.requestFocus()
    }

    // A prediction only paints for the exact draft state it was made for.
    val visibleGhost = ghost?.takeIf {
        it.text == state.text && it.caret == field.selection.start && field.text == state.text
    }
    var clipboardHasImage by remember { mutableStateOf(false) }
    LaunchedEffect(plusOpen) {
        if (plusOpen) clipboardHasImage = ComposerAttachments.hasClipboardImage(context)
    }

    fun applyBatch(batch: AttachmentBatch) {
        if (batch.images.isNotEmpty()) composer.addImages(batch.images)
        if (batch.files.isNotEmpty()) composer.addTextFiles(batch.files)
        if (batch.skipped > 0) {
            composer.showNotice(
                resources.getString(R.string.composer_attach_file_skipped, batch.skipped),
            )
        }
    }

    val documentPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        composer.setReadingAttachments(true)
        scope.launch {
            val batch = withContext(Dispatchers.IO) { ComposerAttachments.readTextFiles(context, uris) }
            composer.setReadingAttachments(false)
            applyBatch(batch)
        }
    }
    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES_PER_PICK),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        composer.setReadingAttachments(true)
        scope.launch {
            val batch = withContext(Dispatchers.IO) { ComposerAttachments.readImages(context, uris) }
            composer.setReadingAttachments(false)
            applyBatch(batch)
        }
    }
    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture(),
    ) { saved ->
        val target = cameraTarget
        cameraTarget = null
        if (!saved || target == null) {
            target?.file?.delete()
            return@rememberLauncherForActivityResult
        }
        composer.setReadingAttachments(true)
        scope.launch {
            val image = withContext(Dispatchers.IO) { ComposerAttachments.readImage(context, target.uri) }
            target.file.delete()
            composer.setReadingAttachments(false)
            if (image != null) composer.addImages(listOf(image)) else {
                Toast.makeText(context, R.string.composer_camera_failed, Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun pasteImage() {
        scope.launch {
            val image = ComposerAttachments.clipboardImage(context)
            if (image != null) composer.addImages(listOf(image)) else {
                Toast.makeText(context, R.string.composer_paste_unavailable, Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun primary() {
        // A submit that is still resolving the live state owns the action; a
        // second tap must not route the same draft again.
        if (submitting) return
        // On-device recognition writes its partials into the field, so the
        // primary action ends the take (the text stays) — the strip under the
        // field carries the explicit Stop/Cancel.
        if (dictationState is DictationState.Live) {
            dictation.stop()
            return
        }
        val recording = dictationState as? DictationState.Recording
        if (recording != null) {
            val after = if (!streaming) {
                SttAfter.Send
            } else if (submitDuringRun == SubmitDuringRunBehavior.STEER) {
                SttAfter.Steer
            } else {
                SttAfter.FollowUp
            }
            dictation.finish(after)
            return
        }
        if (streaming) {
            // Same choice as Enter (web `ChatInput`: `omp-web:submit-during-run`).
            // A phone keyboard cannot submit, so the button must not force a
            // follow-up behind the user's Steer preference.
            if (streamingSubmitBehavior(state.hasContent, submitDuringRun) == SubmitDuringRunBehavior.STEER) {
                onSend()
            } else {
                onQueue()
            }
        } else {
            onSend()
        }
    }

    val queued = remember(queue) {
        queue.followUp.map { "followUp" to it } + queue.steering.map { "steering" to it }
    }
    val dictationBusy = dictationState is DictationState.Uploading || dictationState is DictationState.Transcribing
    val recording = dictationState is DictationState.Recording
    val liveListening = dictationState is DictationState.Live
    val primaryEnabled = inputEnabled && !dictationBusy && !submitting &&
        (recording || liveListening || state.hasContent || streaming)
    val primaryLabel = when {
        liveListening -> stringResource(R.string.dictation_live_stop)
        dictationState is DictationState.Recording -> stringResource(R.string.chat_send)
        submitting -> stringResource(R.string.chat_sending)
        streaming -> when (streamingSubmitBehavior(state.hasContent, submitDuringRun)) {
            SubmitDuringRunBehavior.STEER -> stringResource(R.string.composer_steer)
            // Empty composer = Stop, which the label below overrides.
            else -> stringResource(R.string.composer_queue)
        }
        state.bashMode -> stringResource(R.string.composer_run_shell)
        else -> stringResource(R.string.chat_send)
    }

    Column(modifier = modifier.fillMaxWidth()) {
        if (queued.isNotEmpty()) {
            QueueBar(
                entries = queued,
                expanded = queueExpanded,
                onToggle = { queueExpanded = !queueExpanded },
                onEdit = onQueueEdit,
                onDelete = { kind, text -> deleteTarget = kind to text },
                onSteer = onQueueSteer,
            )
        }
        autoRetry?.let { retry ->
            AutoRetryBanner(retry = retry, onAbort = onAbortRetry)
        }

        Surface(
            color = colors.panel,
            contentColor = colors.text,
            shape = RoundedCornerShape(12.dp),
            border = androidx.compose.foundation.BorderStroke(1.dp, colors.border),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
                if (state.images.isNotEmpty() || state.files.isNotEmpty() || state.readingAttachments) {
                    AttachmentStrip(
                        images = state.images,
                        files = state.files,
                        reading = state.readingAttachments,
                        onRemoveImage = composer::removeImage,
                        onRemoveFile = composer::removeFile,
                    )
                }

                state.slash?.let { slash ->
                    SlashPalette(
                        commands = slash.commands,
                        activeIndex = slash.activeIndex,
                        onPick = { index ->
                            composer.setSlashActive(index)
                            composer.acceptSlash()
                        },
                    )
                }
                state.at?.let { at ->
                    AtPalette(
                        entries = at.entries,
                        activeIndex = at.activeIndex,
                        searchingAll = at.searchingAll,
                        onPick = { index ->
                            composer.setAtActive(index)
                            composer.acceptAt()
                        },
                    )
                }
                state.history?.let { history ->
                    HistoryPalette(
                        entries = history.entries,
                        activeIndex = history.activeIndex,
                        onPick = { index ->
                            composer.setHistoryActive(index)
                            composer.acceptHistory()
                        },
                    )
                }

                val dictationActive = dictationState !is DictationState.Idle &&
                    dictationState !is DictationState.Gone &&
                    // On-device recognition types into the field, so the field
                    // must stay visible; only the strip below it is added.
                    dictationState !is DictationState.Live
                if (dictationActive) {
                    RecordingDeck(dictation, Modifier.fillMaxWidth().padding(vertical = 4.dp))
                } else {
                    BasicTextField(
                        value = field,
                        enabled = inputEnabled,
                        onValueChange = { next ->
                            val textChanged = next.text != field.text
                            val caretChanged = next.selection.start != field.selection.start
                            field = next
                            if (textChanged) {
                                composer.onTextChanged(next.text, next.selection.start)
                            } else if (caretChanged) {
                                composer.onCaretMoved(next.selection.start)
                            }
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 40.dp, max = textFieldMaxHeight)
                            .focusRequester(focusRequester)
                            .onPreviewKeyEvent { event ->
                                if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                                when (event.key) {
                                    Key.Enter -> {
                                        val open = state.slash ?: state.at ?: state.history
                                        when (open) {
                                            is SlashMenuUi -> composer.acceptSlash()
                                            is AtMenuUi -> composer.acceptAt()
                                            is HistoryMenuUi -> composer.acceptHistory()
                                            null -> {
                                                if (event.isShiftPressed) return@onPreviewKeyEvent false
                                                // Web `ChatInput` handles Enter with `handleSend`/`sendQueued`
                                                // by `omp-web:submit-during-run`; only the Send/Queue
                                                // button always queues. `primary()` would force a
                                                // follow-up during a run and ignore a `steer` preference.
                                                onSend()
                                            }
                                        }
                                        true
                                    }
                                    Key.Tab -> {
                                        when {
                                            state.history != null -> composer.acceptHistory()
                                            state.slash != null -> composer.acceptSlash()
                                            state.at != null -> composer.acceptAt()
                                            visibleGhost != null && state.canAcceptGhost -> onAcceptGhost()
                                            else -> return@onPreviewKeyEvent false
                                        }
                                        true
                                    }
                                    Key.DirectionUp -> {
                                        when {
                                            state.slash != null -> composer.moveSlash(-1)
                                            state.at != null -> composer.moveAt(-1)
                                            state.history != null -> composer.moveHistory(-1)
                                            state.text.isEmpty() && !streaming -> onHistory()
                                            else -> return@onPreviewKeyEvent false
                                        }
                                        true
                                    }
                                    Key.DirectionDown -> {
                                        when {
                                            state.slash != null -> composer.moveSlash(1)
                                            state.at != null -> composer.moveAt(1)
                                            state.history != null -> composer.moveHistory(1)
                                            else -> return@onPreviewKeyEvent false
                                        }
                                        true
                                    }
                                    Key.DirectionRight -> {
                                        if (visibleGhost != null && state.canAcceptGhost &&
                                            field.selection.start == field.text.length
                                        ) {
                                            onAcceptGhost()
                                            true
                                        } else {
                                            false
                                        }
                                    }
                                    Key.Escape -> {
                                        when {
                                            state.slash != null || state.at != null || state.history != null -> {
                                                composer.closeMenus()
                                                true
                                            }
                                            // Web `ChatInput`: Esc minimizes only an idle,
                                            // empty composer with no menu open.
                                            onMinimize != null && !streaming && state.text.isBlank() -> {
                                                onMinimize()
                                                true
                                            }
                                            else -> false
                                        }
                                    }
                                    else -> false
                                }
                            },
                        textStyle = androidx.compose.ui.text.TextStyle(
                            color = colors.text,
                            fontSize = 14.sp,
                            lineHeight = 20.sp,
                        ),
                        cursorBrush = SolidColor(colors.accent),
                        visualTransformation = ghostTextTransformation(
                            suffix = visibleGhost?.suffix,
                            caret = field.selection.start,
                            textLength = field.text.length,
                            color = colors.textDim,
                        ),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                        maxLines = textFieldMaxLines,
                        decorationBox = { inner ->
                            Box {
                                if (field.text.isEmpty()) {
                                    Text(
                                        text = bashHint(state) ?: placeholder,
                                        color = if (state.bashMode) colors.accent else colors.textDim,
                                        fontSize = 14.sp,
                                    )
                                }
                                inner()
                            }
                        },
                    )
                    (dictationState as? DictationState.Live)?.let { live ->
                        LiveDictationStrip(
                            state = live,
                            onStop = dictation::stop,
                            onCancel = dictation::cancel,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box {
                        IconButton(
                            onClick = { plusOpen = true },
                            enabled = inputEnabled && !dictationBusy,
                        ) {
                            Icon(
                                imageVector = Icons.Filled.Add,
                                contentDescription = stringResource(R.string.composer_add_attachment),
                                tint = colors.textMuted,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                        OmpDropdownMenu(expanded = plusOpen, onDismissRequest = { plusOpen = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.composer_attach_file)) },
                                onClick = {
                                    plusOpen = false
                                    documentPicker.launch(arrayOf("text/*", "application/json", "application/xml"))
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.composer_attach_image)) },
                                onClick = {
                                    plusOpen = false
                                    photoPicker.launch(
                                        PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
                                    )
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.composer_camera)) },
                                onClick = {
                                    plusOpen = false
                                    val target = ComposerAttachments.newCameraTarget(context)
                                    cameraTarget = target
                                    cameraLauncher.launch(target.uri)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.composer_paste_image)) },
                                enabled = clipboardHasImage,
                                onClick = {
                                    plusOpen = false
                                    pasteImage()
                                },
                            )
                            HorizontalDivider()
                            Text(
                                text = stringResource(R.string.composer_tools),
                                color = colors.textDim,
                                fontSize = 11.sp,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            )
                            ToolPreset.entries.forEach { preset ->
                                DropdownMenuItem(
                                    text = {
                                        Row(verticalAlignment = Alignment.CenterVertically) {
                                            Text(toolPresetLabel(preset))
                                            if (controlsState.toolPreset == preset) {
                                                Spacer(Modifier.width(6.dp))
                                                Text("✓", color = colors.accent)
                                            }
                                        }
                                    },
                                    onClick = {
                                        plusOpen = false
                                        controls.onToolPresetChange(preset)
                                    },
                                )
                            }
                        }
                    }
                    if (dictationState is DictationState.Idle || dictationState is DictationState.Gone) {
                        MicButton(vm = dictation, enabled = inputEnabled && !dictationBusy)
                    }
                    Spacer(Modifier.weight(1f))
                    if (bashRunning) {
                        Text(
                            text = stringResource(R.string.composer_bash_running),
                            color = colors.accent,
                            fontSize = 11.sp,
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    // Web `ChatInput.tsx` renders exactly one primary action: Stop
                    // while a run is live and the composer is empty, Queue once a
                    // typed message is waiting. The text Stop covers that queued
                    // case (web only offers Esc for it) and disappears as soon as
                    // Stop becomes the primary action.
                    val primaryStops = streaming && !state.hasContent && !recording && !liveListening
                    if (streaming && !stopping && !primaryStops) {
                        TextButton(onClick = onStop, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text(stringResource(R.string.chat_stop), fontSize = 11.sp)
                        }
                    }
                    val label = if (primaryStops) stringResource(R.string.chat_stop) else primaryLabel
                    val actionable = if (primaryStops) !stopping else primaryEnabled
                    Surface(
                        color = if (actionable) colors.accentStrong else colors.panel,
                        contentColor = if (actionable) colors.onAccent else colors.textDim,
                        shape = RoundedCornerShape(8.dp),
                        modifier = Modifier
                            .clickable(enabled = actionable && inputEnabled) {
                                if (primaryStops) onStop() else primary()
                            }
                            .semantics { contentDescription = label },
                    ) {
                        Text(
                            text = label,
                            fontSize = 12.sp,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        }

        if (state.bashMode) {
            Text(
                text = bashHint(state) ?: "",
                color = if (state.bashExcluded) colors.textMuted else colors.accent,
                fontSize = 11.sp,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp),
            )
        }

        if (showControlsRow) {
            ComposerControlsRow(
                vm = controls,
                streaming = streaming,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }

    if (controlsState.contextSheetOpen) {
        ContextDetailSheet(
            vm = controls,
            onDismiss = controls::closeContextSheet,
            streaming = streaming,
        )
    }

    deleteTarget?.let { (kind, text) ->
        OmpAlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text(stringResource(R.string.composer_queue_delete_title)) },
            text = { Text(stringResource(R.string.composer_queue_delete_body)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        deleteTarget = null
                        onQueueDelete(kind, text)
                    },
                ) { Text(stringResource(R.string.composer_queue_delete_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) {
                    Text(stringResource(R.string.composer_cancel))
                }
            },
        )
    }
}

@Composable
private fun AutoRetryBanner(retry: AutoRetry, onAbort: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = retry.message ?: retryLabel(retry.attempt, retry.maxAttempts),
            color = colors.statusWarning,
            fontSize = 11.sp,
            modifier = Modifier.weight(1f),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        TextButton(onClick = onAbort, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.composer_auto_retry_stop), fontSize = 11.sp)
        }
    }
}

@Composable
private fun QueueBar(
    entries: List<Pair<String, String>>,
    expanded: Boolean,
    onToggle: () -> Unit,
    onEdit: (String, String) -> Unit,
    onDelete: (String, String) -> Unit,
    onSteer: (String) -> Unit,
) {
    val colors = LocalOmpColors.current
    val shown = if (expanded) entries else entries.take(1)
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 2.dp)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .clickable(onClick = onToggle)
                .semantics { role = Role.Button }
                .padding(horizontal = 6.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (expanded) {
                    stringResource(R.string.composer_queue_count, entries.size)
                } else {
                    stringResource(R.string.composer_queue_show_all, entries.size)
                },
                color = colors.textMuted,
                fontSize = 11.sp,
                modifier = Modifier.weight(1f),
            )
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = null,
                tint = colors.textDim,
                modifier = Modifier.size(14.dp),
            )
        }
        shown.forEach { (kind, text) ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 6.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (kind == "steering") {
                        stringResource(R.string.composer_queue_steer)
                    } else {
                        stringResource(R.string.composer_queue_follow_up)
                    },
                    color = if (kind == "steering") colors.accent else colors.textDim,
                    fontSize = 10.sp,
                    modifier = Modifier.widthIn(min = 52.dp),
                )
                Text(
                    text = text,
                    color = colors.text,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).padding(horizontal = 6.dp),
                )
                if (kind == "followUp") {
                    QueueAction(
                        text = stringResource(R.string.composer_steer),
                        color = colors.accent,
                        description = stringResource(R.string.composer_steer_action_desc),
                        onClick = { onSteer(text) },
                    )
                }
                QueueAction(
                    text = stringResource(R.string.composer_queue_edit),
                    color = colors.textMuted,
                    onClick = { onEdit(kind, text) },
                )
                QueueAction(
                    text = stringResource(R.string.composer_queue_delete),
                    color = colors.statusError,
                    onClick = { onDelete(kind, text) },
                )
            }
        }
    }
}

/**
 * One queue-bar action. It carries a button role and the theme's minimum touch
 * target: as 11sp text with 2dp padding the promote-to-steer action was ~20dp
 * tall, so whether a queued message steered depended on a lucky tap.
 */
@Composable
private fun QueueAction(
    text: String,
    color: Color,
    description: String? = null,
    onClick: () -> Unit,
) {
    val target = LocalMinimumInteractiveComponentSize.current
    Box(
        modifier = Modifier
            .sizeIn(minWidth = target, minHeight = target)
            .clickable(onClick = onClick)
            .semantics {
                role = Role.Button
                if (description != null) contentDescription = description
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(text = text, color = color, fontSize = 11.sp)
    }
}

@Composable
private fun AttachmentStrip(
    images: List<ComposerImage>,
    files: List<AttachedTextFile>,
    reading: Boolean,
    onRemoveImage: (Int) -> Unit,
    onRemoveFile: (Int) -> Unit,
) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        images.forEachIndexed { index, _ ->
            AttachmentChip(
                label = stringResource(R.string.chat_attached_image) + " ${index + 1}",
                onRemove = { onRemoveImage(index) },
            )
        }
        files.forEachIndexed { index, file ->
            AttachmentChip(label = file.name, onRemove = { onRemoveFile(index) })
        }
        if (reading) {
            Text(
                text = stringResource(R.string.composer_reading_attachments),
                color = colors.textDim,
                fontSize = 11.sp,
            )
        }
    }
}

@Composable
private fun AttachmentChip(label: String, onRemove: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .background(colors.backgroundSubtle, RoundedCornerShape(6.dp))
            .padding(start = 6.dp, end = 2.dp, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = colors.textMuted,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.widthIn(max = 150.dp),
        )
        IconButton(onClick = onRemove) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = stringResource(R.string.composer_remove),
                tint = colors.textDim,
                modifier = Modifier.size(12.dp),
            )
        }
    }
}

@Composable
private fun SlashPalette(
    commands: List<io.github.kahme247.ompweb.domain.SlashCommandItem>,
    activeIndex: Int,
    onPick: (Int) -> Unit,
) {
    val colors = LocalOmpColors.current
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .verticalScroll(rememberScrollState())
            .padding(vertical = 2.dp),
    ) {
        commands.forEachIndexed { index, command ->
            PaletteRow(
                label = "/" + command.name,
                detail = command.argumentHint ?: command.description,
                active = index == activeIndex,
                onClick = { onPick(index) },
            )
        }
    }
}

@Composable
private fun AtPalette(
    entries: List<io.github.kahme247.ompweb.domain.FileIndexEntry>,
    activeIndex: Int,
    searchingAll: Boolean,
    onPick: (Int) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .verticalScroll(rememberScrollState())
            .padding(vertical = 2.dp),
    ) {
        entries.forEachIndexed { index, entry ->
            PaletteRow(
                label = entry.path,
                detail = if (searchingAll) stringResource(R.string.composer_at_searching_all) else null,
                active = index == activeIndex,
                onClick = { onPick(index) },
            )
        }
    }
}

@Composable
private fun HistoryPalette(
    entries: List<String>,
    activeIndex: Int,
    onPick: (Int) -> Unit,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .heightIn(max = 220.dp)
            .verticalScroll(rememberScrollState())
            .padding(vertical = 2.dp),
    ) {
        entries.forEachIndexed { index, text ->
            PaletteRow(
                label = text,
                detail = null,
                active = index == activeIndex,
                onClick = { onPick(index) },
            )
        }
    }
}

@Composable
private fun PaletteRow(label: String, detail: String?, active: Boolean, onClick: () -> Unit) {
    val colors = LocalOmpColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (active) colors.selected else colors.panel, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            color = if (active) colors.accent else colors.text,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (!detail.isNullOrBlank()) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = detail,
                color = colors.textDim,
                fontSize = 11.sp,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun retryLabel(attempt: Int?, maxAttempts: Int?): String = when {
    attempt != null && maxAttempts != null ->
        stringResource(R.string.composer_auto_retry, "$attempt/$maxAttempts")
    attempt != null -> stringResource(R.string.composer_auto_retry, "$attempt")
    else -> stringResource(R.string.composer_auto_retry_plain)
}

@Composable
private fun bashHint(state: ComposerUiState): String? = when {
    !state.bashMode -> null
    state.bashExcluded -> stringResource(R.string.composer_bash_excluded_hint)
    else -> stringResource(R.string.composer_bash_hint)
}

@Composable
private fun toolPresetLabel(preset: ToolPreset): String = when (preset) {
    ToolPreset.NONE -> stringResource(R.string.composer_tools_none)
    ToolPreset.DEFAULT -> stringResource(R.string.composer_tools_default)
    ToolPreset.FULL -> stringResource(R.string.composer_tools_full)
}

private const val MAX_IMAGES_PER_PICK = 10

