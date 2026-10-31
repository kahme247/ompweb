package io.github.kahme247.ompweb.ui.panels.btw

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.domain.BtwRecord
import io.github.kahme247.ompweb.domain.BtwStatus
import io.github.kahme247.ompweb.domain.BtwTurn
import io.github.kahme247.ompweb.domain.btwTurns
import io.github.kahme247.ompweb.domain.latestBtwAnswer
import io.github.kahme247.ompweb.domain.latestBtwTurn
import io.github.kahme247.ompweb.ui.render.LinkTarget
import io.github.kahme247.ompweb.ui.render.MarkdownText
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.launch

/** The toast text for a side-question failure (web `toastBtwError`). */
@Composable
fun BtwFailure.message(): String = when (kind) {
    BtwFailureKind.UNSUPPORTED -> stringResource(R.string.btw_unsupported)
    BtwFailureKind.FAILED -> detail?.let { stringResource(R.string.btw_failed_detail, it) }
        ?: stringResource(R.string.btw_failed)
}

/**
 * What the composer says about a refused [BtwViewModel.ask]; null = say
 * nothing. Transport failures ([BtwRefusal.UNSUPPORTED], [BtwRefusal.FAILED])
 * are already emitted on [BtwViewModel.errors] — the web's `toastBtwError` —
 * so the composer only has to keep the draft for them, never repeat the text.
 */
@Composable
fun BtwRefusal.message(): String? = when (this) {
    BtwRefusal.NO_SESSION -> stringResource(R.string.btw_no_session)
    BtwRefusal.UNSUPPORTED, BtwRefusal.FAILED, BtwRefusal.EMPTY_QUESTION, BtwRefusal.BUSY -> null
}

/** The streaming topic above the composer (web `components/BtwPanel.tsx`). */
@Composable
fun BtwPanel(
    vm: BtwViewModel,
    onCopy: (String) -> Unit,
    modifier: Modifier = Modifier,
    onLink: (LinkTarget) -> Unit = {},
) {
    val state by vm.state.collectAsState()
    val record = state.active ?: return
    val colors = LocalOmpColors.current
    val latest = latestBtwTurn(record)
    val turns = btwTurns(record)
    val running = latest.status == BtwStatus.RUNNING
    val copyable = latestBtwAnswer(record)
    val scope = rememberCoroutineScope()
    var draft by remember(record.id) { mutableStateOf("") }
    var sending by remember(record.id) { mutableStateOf(false) }
    val scroll = rememberScrollState()
    // Follow the streaming tail until the user scrolls up (web `followTailRef`).
    var followTail by remember(record.id) { mutableStateOf(true) }
    LaunchedEffect(scroll.isScrollInProgress) {
        if (!scroll.isScrollInProgress) followTail = scroll.maxValue - scroll.value < 24
    }
    LaunchedEffect(latest.answer, turns.size, state.expanded) {
        if (state.expanded && followTail && !scroll.isScrollInProgress) {
            scroll.scrollTo(scroll.maxValue)
        }
    }

    fun submit() {
        val question = draft.trim()
        if (question.isEmpty() || running || sending) return
        sending = true
        followTail = true
        scope.launch {
            if (vm.ask(question, record.id) == BtwAskResult.Started) draft = ""
            sending = false
        }
    }

    val toggleLabel = stringResource(if (state.expanded) R.string.btw_collapse_panel else R.string.btw_expand_panel)
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = colors.backgroundSubtle,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(onClickLabel = toggleLabel, onClick = vm::toggle)
                        .padding(start = 10.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = stringResource(R.string.btw_panel_title),
                        color = colors.text,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                    Text(
                        text = record.question,
                        color = colors.textMuted,
                        fontSize = 12.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    BtwStatusLabel(latest.status)
                    Icon(
                        imageVector = Icons.Filled.KeyboardArrowDown,
                        contentDescription = toggleLabel,
                        tint = colors.textDim,
                        modifier = Modifier.size(14.dp).rotate(if (state.expanded) 0f else -90f),
                    )
                }
                IconButton(onClick = vm::close) {
                    Icon(
                        imageVector = Icons.Filled.Close,
                        contentDescription = stringResource(R.string.btw_close),
                        tint = colors.textDim,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            if (state.expanded) {
                // `min(36vh, 320px)` on the web: the panel must never push the composer
                // off-screen. The screen height, not the space left in the
                // composer column, is the reference.
                val turnsMaxHeight = minOf(
                    320.dp,
                    LocalConfiguration.current.screenHeightDp.dp * 0.36f,
                )
                Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(max = turnsMaxHeight)
                                .verticalScroll(scroll),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            turns.forEachIndexed { index, turn ->
                                BtwTurnView(
                                    turn = turn,
                                    live = index == turns.lastIndex,
                                    onLink = onLink,
                                )
                            }
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            if (running) {
                                BtwAction(stringResource(R.string.btw_cancel), onClick = vm::cancel)
                            } else {
                                FollowUpField(
                                    value = draft,
                                    onValueChange = { draft = it },
                                    onSubmit = ::submit,
                                    enabled = !sending,
                                    modifier = Modifier.weight(1f),
                                )
                                BtwAction(
                                    text = stringResource(R.string.btw_ask),
                                    onClick = ::submit,
                                    enabled = !sending && draft.isNotBlank(),
                                )
                            }
                            if (copyable.isNotEmpty()) {
                                BtwAction(stringResource(R.string.btw_copy), onClick = { onCopy(copyable) })
                            }
                        }
                    }
                }
        }
    }
}

/** `/btw` alone: every side question of the session, newest first (web `BtwHistoryDialog`). */
@Composable
fun BtwHistoryDialog(
    vm: BtwViewModel,
    onCopy: (String) -> Unit,
    onLink: (LinkTarget) -> Unit = {},
) {
    val state by vm.state.collectAsState()
    if (!state.historyOpen) return
    val colors = LocalOmpColors.current
    var expandedId by remember { mutableStateOf<String?>(null) }
    OmpDialog(
        onDismissRequest = vm::closeHistory,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        BoxWithConstraints(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            contentAlignment = Alignment.Center,
        ) {
            val dialogWidth = minOf(maxWidth * 0.92f, 640.dp)
            val dialogMaxHeight = maxHeight * 0.85f
            Surface(
                modifier = Modifier.width(dialogWidth).heightIn(max = dialogMaxHeight),
                color = colors.background,
                shape = RoundedCornerShape(14.dp),
                tonalElevation = 4.dp,
            ) {
                Column(Modifier.fillMaxWidth()) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(colors.panel)
                            .padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = stringResource(R.string.btw_history_title),
                            color = colors.text,
                            fontSize = 15.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = vm::closeHistory) {
                            Icon(
                                imageVector = Icons.Filled.Close,
                                contentDescription = stringResource(R.string.common_close),
                                tint = colors.textMuted,
                            )
                        }
                    }
                    if (state.records.isEmpty()) {
                        Text(
                            text = stringResource(R.string.btw_history_empty),
                            color = colors.textMuted,
                            fontSize = 13.sp,
                            modifier = Modifier.padding(16.dp),
                        )
                    } else {
                        LazyColumn(
                            modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
                            contentPadding = PaddingValues(10.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            items(state.records, key = { it.id }) { record ->
                                BtwHistoryRow(
                                    record = record,
                                    expanded = expandedId == record.id,
                                    onToggle = {
                                        expandedId = if (expandedId == record.id) null else record.id
                                    },
                                    onFollowUp = { vm.openRecord(record.id) },
                                    onCopy = onCopy,
                                    onLink = onLink,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** One exchange. `live` marks the turn whose answer streams. */
@Composable
private fun BtwTurnView(turn: BtwTurn, live: Boolean, onLink: (LinkTarget) -> Unit) {
    val colors = LocalOmpColors.current
    val running = turn.status == BtwStatus.RUNNING
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = turn.question,
            color = colors.textMuted,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
        )
        val liveModifier = if (live && running) {
            Modifier.semantics { liveRegion = LiveRegionMode.Polite }
        } else {
            Modifier
        }
        Box(Modifier.fillMaxWidth().then(liveModifier)) {
            when {
                turn.answer.isNotEmpty() -> MarkdownText(markdown = turn.answer, onLink = onLink)
                running -> Text(
                    text = stringResource(R.string.btw_waiting),
                    color = colors.textDim,
                    fontSize = 12.sp,
                )
            }
        }
        turn.error?.let { error ->
            Text(text = error, color = colors.statusError, fontSize = 12.sp)
        }
    }
}

@Composable
private fun BtwStatusLabel(status: BtwStatus) {
    val colors = LocalOmpColors.current
    val tint = if (status == BtwStatus.ERROR) colors.statusError else colors.textMuted
    val icon = when (status) {
        BtwStatus.RUNNING -> Icons.Filled.Refresh
        BtwStatus.COMPLETE -> Icons.Filled.Check
        BtwStatus.ERROR -> Icons.Filled.Warning
        BtwStatus.CANCELLED -> Icons.Filled.Close
        BtwStatus.INTERRUPTED -> Icons.Filled.Info
    }
    val label = when (status) {
        BtwStatus.RUNNING -> stringResource(R.string.btw_status_running)
        BtwStatus.COMPLETE -> stringResource(R.string.btw_status_complete)
        BtwStatus.CANCELLED -> stringResource(R.string.btw_status_cancelled)
        BtwStatus.ERROR -> stringResource(R.string.btw_status_error)
        BtwStatus.INTERRUPTED -> stringResource(R.string.btw_status_interrupted)
    }
    val spin = if (status == BtwStatus.RUNNING) {
        val transition = rememberInfiniteTransition(label = "btw-status")
        val angle by transition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(tween(durationMillis = 1200, easing = LinearEasing)),
            label = "btw-status-angle",
        )
        angle
    } else {
        0f
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = tint,
            modifier = Modifier.size(12.dp).rotate(spin),
        )
        Text(text = label, color = tint, fontSize = 11.sp, maxLines = 1)
    }
}

@Composable
private fun BtwAction(text: String, onClick: () -> Unit, enabled: Boolean = true) {
    val colors = LocalOmpColors.current
    TextButton(
        onClick = onClick,
        enabled = enabled,
        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp),
        colors = ButtonDefaults.textButtonColors(
            contentColor = colors.textMuted,
            disabledContentColor = colors.textDim,
        ),
    ) {
        Text(text = text, fontSize = 12.sp, maxLines = 1)
    }
}

/** The panel's follow-up input: Enter (IME send) submits, composition stays intact. */
@Composable
private fun FollowUpField(
    value: String,
    onValueChange: (String) -> Unit,
    onSubmit: () -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = LocalOmpColors.current
    val label = stringResource(R.string.btw_follow_up_label)
    val placeholder = stringResource(R.string.btw_follow_up_placeholder)
    Box(
        modifier = modifier
            .heightIn(min = 34.dp)
            .border(1.dp, colors.border, RoundedCornerShape(8.dp))
            .padding(horizontal = 8.dp, vertical = 7.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (value.isEmpty()) {
            Text(
                text = placeholder,
                color = colors.textDim,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            textStyle = TextStyle(color = colors.text, fontSize = 13.sp),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSubmit() }),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = label },
        )
    }
}

@Composable
private fun BtwHistoryRow(
    record: BtwRecord,
    expanded: Boolean,
    onToggle: () -> Unit,
    onFollowUp: () -> Unit,
    onCopy: (String) -> Unit,
    onLink: (LinkTarget) -> Unit,
) {
    val colors = LocalOmpColors.current
    val latest = latestBtwTurn(record)
    val copyable = latestBtwAnswer(record)
    val stamp = remember(record.id, latest.updatedAt) {
        DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
            .format(Date(latest.updatedAt))
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = colors.backgroundSubtle,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(onClick = onToggle)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = colors.textDim,
                    modifier = Modifier.size(13.dp).rotate(if (expanded) 0f else -90f),
                )
                Text(
                    text = record.question,
                    color = colors.text,
                    fontSize = 13.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                BtwStatusLabel(latest.status)
                Text(text = stamp, color = colors.textDim, fontSize = 11.sp, maxLines = 1)
            }
            if (expanded) {
                HorizontalDivider(color = colors.border)
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    btwTurns(record).forEach { turn ->
                        BtwTurnView(turn = turn, live = false, onLink = onLink)
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (latest.status != BtwStatus.RUNNING) {
                            BtwAction(stringResource(R.string.btw_follow_up), onClick = onFollowUp)
                        }
                        if (copyable.isNotEmpty()) {
                            BtwAction(stringResource(R.string.btw_copy), onClick = { onCopy(copyable) })
                        }
                    }
                }
            }
        }
    }
}
