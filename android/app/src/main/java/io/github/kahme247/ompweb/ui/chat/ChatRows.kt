package io.github.kahme247.ompweb.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.chat.AssistantBlock
import io.github.kahme247.ompweb.chat.ChatDisplayPrefs
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.ChatState
import io.github.kahme247.ompweb.chat.formatGenerationRate
import io.github.kahme247.ompweb.chat.HeaderSlot
import io.github.kahme247.ompweb.chat.MOUNT_NOTICE
import io.github.kahme247.ompweb.chat.messageSpeed
import io.github.kahme247.ompweb.chat.PASSIVE_TOOL_CONTEXT
import io.github.kahme247.ompweb.chat.Speaker
import io.github.kahme247.ompweb.chat.SpeakerRole
import io.github.kahme247.ompweb.chat.TranscriptFormat
import io.github.kahme247.ompweb.chat.TurnSegment
import io.github.kahme247.ompweb.chat.TranscriptRow
import io.github.kahme247.ompweb.domain.formatCompactNumber
import io.github.kahme247.ompweb.domain.formatCost
import io.github.kahme247.ompweb.domain.formatDuration
import io.github.kahme247.ompweb.domain.formatTokens
import io.github.kahme247.ompweb.domain.shortModel
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.ui.render.DiffView
import io.github.kahme247.ompweb.ui.render.GithubRepoRef
import io.github.kahme247.ompweb.ui.render.LinkTarget
import io.github.kahme247.ompweb.ui.render.MarkdownText
import io.github.kahme247.ompweb.ui.render.RemoteImage
import io.github.kahme247.ompweb.ui.render.ToolDiff
import io.github.kahme247.ompweb.ui.render.copyTextToClipboard
import io.github.kahme247.ompweb.ui.render.formatMessageSize
import io.github.kahme247.ompweb.ui.render.imageSourceFor
import io.github.kahme247.ompweb.ui.render.isLargeMessage
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpAlertDialog
import io.github.kahme247.ompweb.ui.theme.OmpCardRadius
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import kotlin.math.roundToInt
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

private const val RAW_VIEW_THRESHOLD = 12_000

/** Actions a transcript row can trigger (all owned by the chat screen/view model). */
internal class ChatRowCallbacks(
    val onLink: (LinkTarget) -> Unit,
    val onFork: (String, Boolean) -> Unit,
    val onLoadThinking: (String?, Int) -> Unit,
    val onToggleSpeech: (String?, String, String) -> Unit,
    val onStopSpeech: () -> Unit,
    val onLoadBashOutput: (String) -> Unit,
    val onDownloadBashOutput: (String) -> Unit,
    /** "Edit from here": branch back to the previous assistant answer and prefill. */
    val onEditFromHere: (prevAssistantEntryId: String, text: String) -> Unit,
)

/** One rendered LazyColumn item of the transcript. */
@Composable
internal fun ChatRow(
    row: TranscriptRow,
    messages: List<ChatMessage>,
    state: ChatUiState,
    liveTail: Boolean,
    indexByKey: Map<String, Int>,
    callbacks: ChatRowCallbacks,
    /**
     * The transcript's last group while its turn still runs: its fold has to
     * show live activity instead of a static summary.
     */
    runningTurn: Boolean = false,
    /** The in-chat search marks the rows its query matched. */
    highlight: ChatRowHighlight = ChatRowHighlight.None,
    /**
     * Speaker headers and day separators keyed by header block (see
     * [TranscriptFormat.headerBlocks]): `row.key` for a row's anchor and
     * `row.key + ":assistant"` for a turn's folded assistant block.
     */
    headers: Map<String, HeaderSlot> = emptyMap(),
    /**
     * Day separators keyed by the element that draws one ([TranscriptFormat
     * .daySeparators]): row keys, the group's assistant header key and turn
     * segment keys. A day change inside one turn is an own element, so it is
     * never lost.
     */
    dayBreaks: Map<String, Long> = emptyMap(),
) {
    if (highlight == ChatRowHighlight.None) {
        ChatRowContent(row, messages, state, liveTail, indexByKey, callbacks, runningTurn, headers, dayBreaks)
        return
    }
    val colors = LocalOmpColors.current
    val shape = RoundedCornerShape(6.dp)
    val tint = if (highlight == ChatRowHighlight.Active) 0.16f else 0.08f
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 1.dp)
            .background(colors.accent.copy(alpha = tint), shape)
            .then(
                if (highlight == ChatRowHighlight.Active) {
                    Modifier.border(1.dp, colors.accent.copy(alpha = 0.45f), shape)
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 3.dp, vertical = 2.dp),
    ) {
        ChatRowContent(row, messages, state, liveTail, indexByKey, callbacks, runningTurn, headers, dayBreaks)
    }
}

@Composable
private fun ChatRowContent(
    row: TranscriptRow,
    messages: List<ChatMessage>,
    state: ChatUiState,
    liveTail: Boolean,
    indexByKey: Map<String, Int>,
    callbacks: ChatRowCallbacks,
    runningTurn: Boolean,
    headers: Map<String, HeaderSlot>,
    dayBreaks: Map<String, Long>,
) {
    when (row) {
        is TranscriptRow.Message -> {
            val index = indexByKey[row.message.key] ?: -1
            MessageRow(
                message = row.message,
                state = state,
                forkTarget = state.forkTargets.getOrNull(index),
                header = headers[row.key],
                streaming = false,
                prevAssistantEntryId = previousAssistantEntryId(messages, index),
                callbacks = callbacks,
                dayBreak = dayBreaks[row.key],
            )
        }

        is TranscriptRow.Group -> {
            if (liveTail) {
                // Flat live tail: same messages the fold would contain, so the
                // running turn stays readable while its activity streams in.
                // Its headers come from the group's own blocks, so the tail
                // shows the same speaker runs as the folded view; the header
                // hangs on the first assistant message that really renders,
                // and a day change inside the tail draws its own separator.
                val firstAssistantIndex = TranscriptFormat.firstVisibleAssistantIndex(
                    messages = messages,
                    startIndex = row.anchorIndex,
                    endIndex = row.endIndex,
                    hideThinking = state.preferences.hideThinking,
                )
                val tailBreaks = remember(messages, row, state.preferences.hideThinking) {
                    TranscriptFormat.messageDaySeparators(
                        messages = messages,
                        startIndex = row.anchorIndex,
                        endIndex = row.endIndex,
                        hideThinking = state.preferences.hideThinking,
                    )
                }
                for (index in row.anchorIndex until row.endIndex) {
                    val message = messages[index]
                    if (message is ChatMessage.ToolResult) continue
                    if (message is ChatMessage.Custom &&
                        (message.customType == MOUNT_NOTICE || message.customType == PASSIVE_TOOL_CONTEXT)
                    ) {
                        continue
                    }
                    val header = when {
                        index == row.anchorIndex -> headers[row.key]
                        index == firstAssistantIndex -> headers[row.key + TranscriptFormat.ASSISTANT_HEADER_SUFFIX]
                        else -> null
                    }
                    MessageRow(
                        message = message,
                        state = state,
                        forkTarget = state.forkTargets.getOrNull(index),
                        header = header,
                        streaming = false,
                        prevAssistantEntryId = previousAssistantEntryId(messages, index),
                        callbacks = callbacks,
                        dayBreak = if (index == row.anchorIndex) {
                            dayBreaks[row.key]
                        } else {
                            tailBreaks[message.key]
                        },
                    )
                }
                return
            }
            val anchorIndex = row.anchorIndex
            val anchor = row.anchor
            MessageRow(
                message = anchor,
                state = state,
                forkTarget = state.forkTargets.getOrNull(anchorIndex),
                header = headers[row.key],
                streaming = false,
                prevAssistantEntryId = previousAssistantEntryId(messages, anchorIndex),
                callbacks = callbacks,
                dayBreak = dayBreaks[row.key],
            )
            var attached = false
            val lastActivity = row.segments.indexOfLast { it is TurnSegment.Activity }
            val live = if (runningTurn) liveActivity(state.engine) else null
            // The last timestamp of the turn: the fold shows the settled
            // duration once the turn is over (nothing ticks then).
            val finishedAt = row.segments
                .flatMap { segment ->
                    when (segment) {
                        is TurnSegment.Text -> listOfNotNull(segment.message.timestamp)
                        is TurnSegment.Activity -> segment.pieces.mapNotNull { it.message.timestamp }
                    }
                }
                .maxOrNull()
            row.segments.forEachIndexed { segmentIndex, segment ->
                // One header for the whole assistant turn, above its first
                // segment (text or the folded activity). A day change is drawn
                // above that header, where the change really starts.
                if (segmentIndex == 0) {
                    val segmentKey = when (segment) {
                        is TurnSegment.Text -> segment.key
                        is TurnSegment.Activity -> segment.key
                    }
                    val headerBreak = dayBreaks[row.key + TranscriptFormat.ASSISTANT_HEADER_SUFFIX]
                        ?: dayBreaks[segmentKey]
                    if (headerBreak != null) DaySeparatorRow(headerBreak)
                    BlockHeader(headers[row.key + TranscriptFormat.ASSISTANT_HEADER_SUFFIX])
                }
                when (segment) {
                    is TurnSegment.Text -> {
                        val message = segment.message
                        val copy = message.copy(
                            blocks = segment.blocks,
                            durationMs = if (segment.last) message.durationMs else null,
                            usageOutput = if (segment.last) message.usageOutput else null,
                            ttftMs = if (segment.last) message.ttftMs else null,
                            completedAt = if (segment.last) message.completedAt else null,
                            errorMessage = if (segment.last) message.errorMessage else null,
                        )
                        MessageRow(
                            message = copy,
                            state = state,
                            forkTarget = if (attached) null else state.forkTargets.getOrNull(segment.messageIndex),
                            header = null,
                            streaming = false,
                            callbacks = callbacks,
                            dayBreak = if (segmentIndex == 0) null else dayBreaks[segment.key],
                        )
                        attached = true
                    }

                    is TurnSegment.Activity -> {
                        if (segmentIndex != 0) {
                            dayBreaks[segment.key]?.let { DaySeparatorRow(it) }
                        }
                        ProcessDetailsGroup(
                            key = segment.key,
                            messageCount = segment.stepCount,
                            toolCallCount = segment.toolCallCount,
                            live = if (segmentIndex == lastActivity) live else null,
                            startedAt = row.anchor.timestamp,
                            finishedAt = finishedAt,
                        ) {
                            segment.pieces.forEachIndexed { pieceIndex, piece ->
                                val message = piece.message
                                when (message) {
                                    is ChatMessage.Assistant -> {
                                        val blocks = piece.blocks ?: message.blocks
                                        AssistantBlockColumn(
                                            message = message,
                                            blocks = blocks,
                                            state = state,
                                            streaming = false,
                                            callbacks = callbacks,
                                        )
                                    }

                                    is ChatMessage.Custom -> CustomRow(message, state, callbacks)
                                    is ChatMessage.BashExecution -> BashRow(message, state, callbacks)
                                    is ChatMessage.Other -> Unit
                                    else -> Unit
                                }
                                // Avoid collapsing the last folded row into the anchor.
                                if (pieceIndex != segment.pieces.lastIndex) Spacer(Modifier.height(2.dp))
                            }
                        }
                        attached = true
                    }
                }
                if (segmentIndex != row.segments.lastIndex) Spacer(Modifier.height(2.dp))
            }
        }
    }
}

@Composable
private fun MessageRow(
    message: ChatMessage,
    state: ChatUiState,
    forkTarget: io.github.kahme247.ompweb.chat.ForkTarget?,
    header: HeaderSlot?,
    streaming: Boolean,
    prevAssistantEntryId: String? = null,
    callbacks: ChatRowCallbacks,
    /** Timestamp of the day separator this message draws, if it starts a day. */
    dayBreak: Long? = null,
) {
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        if (dayBreak != null) DaySeparatorRow(dayBreak)
        BlockHeader(header)
        when (message) {
            is ChatMessage.User -> UserRow(
                message = message,
                state = state,
                forkTarget = forkTarget,
                prevAssistantEntryId = prevAssistantEntryId,
                callbacks = callbacks,
            )
            is ChatMessage.Assistant -> AssistantRow(
                message = message,
                state = state,
                forkTarget = forkTarget,
                streaming = streaming,
                callbacks = callbacks,
            )

            is ChatMessage.ToolResult -> Unit
            is ChatMessage.BashExecution -> BashRow(message, state, callbacks)
            is ChatMessage.Custom -> CustomRow(message, state, callbacks)
            is ChatMessage.Other -> Unit
        }
    }
}

// --------------------------------------------------------------------- user

@Composable
private fun UserRow(
    message: ChatMessage.User,
    state: ChatUiState,
    forkTarget: io.github.kahme247.ompweb.chat.ForkTarget?,
    prevAssistantEntryId: String?,
    callbacks: ChatRowCallbacks,
) {
    val colors = LocalOmpColors.current
    if (message.branchSummary) {
        BranchSummaryRow(message)
        return
    }
    val showFork = forkTarget != null && !state.busy
    val editTarget = prevAssistantEntryId?.takeIf { !state.busy && message.text.isNotBlank() }
    val scrollState = rememberScrollState()
    var expanded by remember(message.key) { mutableStateOf(false) }
    var overflows by remember(message.key) { mutableStateOf(false) }
    LaunchedEffect(message.text) {
        // The cap only scrolls once the content actually overflows it.
        snapshotFlow { scrollState.maxValue }.collect { overflows = it > 0 }
    }
    Surface(
        color = colors.userBackground,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
            if (message.text.isNotBlank()) {
                // A long paste is capped like the web bubble: the body scrolls
                // inside a fixed height and "Show full" lifts the cap.
                Box(
                    modifier = if (expanded) {
                        Modifier.fillMaxWidth()
                    } else {
                        Modifier
                            .fillMaxWidth()
                            .heightIn(max = MAX_USER_BUBBLE_HEIGHT)
                            .verticalScroll(scrollState)
                    },
                ) {
                    SafeMarkdownText(
                        markdown = message.text,
                        githubRepo = state.githubRepo,
                        onLink = callbacks.onLink,
                    )
                }
                if (overflows || expanded) {
                    TextButton(onClick = { expanded = !expanded }) {
                        Text(
                            text = stringResource(
                                if (expanded) R.string.chat_collapse else R.string.chat_show_full,
                            ),
                            fontSize = 11.sp,
                            color = colors.textDim,
                        )
                    }
                }
            }
            if (message.images.isNotEmpty()) {
                FlowRow(
                    modifier = Modifier.padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    message.images.forEach { image ->
                        val source = chatImageSource(image, thumbnail = true) ?: return@forEach
                        RemoteImage(
                            source = source,
                            contentDescription = stringResource(R.string.chat_attached_image),
                            modifier = Modifier.widthIn(max = 220.dp).heightIn(max = 220.dp),
                        )
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CopyAction(text = message.text)
                if (editTarget != null) {
                    TextButton(onClick = { callbacks.onEditFromHere(editTarget, message.text) }) {
                        Text(
                            text = stringResource(R.string.chat_edit_from_here),
                            fontSize = 11.sp,
                            color = colors.textDim,
                        )
                    }
                }
                if (showFork && forkTarget != null) {
                    ForkAction(state, forkTarget, callbacks)
                }
            }
        }
    }
}

/** Height a user bubble clamps to before "Show full" appears (web 300px). */
private val MAX_USER_BUBBLE_HEIGHT = 300.dp

/** The assistant answer before [index], the branch target of "edit from here". */
private fun previousAssistantEntryId(messages: List<ChatMessage>, index: Int): String? =
    (messages.getOrNull(index - 1) as? ChatMessage.Assistant)?.entryId

/**
 * Markdown text with the web's two size guards: past [MAX_MARKDOWN_CHARS] the
 * body is not parsed at all until the user asks for it, and past
 * [RAW_VIEW_THRESHOLD] the rendered/raw toggle stays available.
 */
@Composable
private fun SafeMarkdownText(
    markdown: String,
    githubRepo: GithubRepoRef?,
    onLink: (LinkTarget) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (isLargeMessage(markdown)) {
        var revealed by remember(markdown) { mutableStateOf(false) }
        if (!revealed) {
            TextButton(onClick = { revealed = true }) {
                Text(
                    text = stringResource(
                        R.string.chat_large_message_reveal,
                        formatMessageSize(markdown.length),
                    ),
                    fontSize = 11.sp,
                )
            }
            return
        }
        val colors = LocalOmpColors.current
        Box(
            modifier = modifier
                .fillMaxWidth()
                .heightIn(max = 420.dp)
                .border(1.dp, colors.border, RoundedCornerShape(6.dp))
                .verticalScroll(rememberScrollState())
                .padding(8.dp),
        ) {
            SelectionContainer {
                Text(
                    text = markdown,
                    color = colors.text,
                    fontSize = 12.sp,
                    lineHeight = 18.sp,
                    fontFamily = OmpMonoFontFamily,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        return
    }
    if (markdown.length > RAW_VIEW_THRESHOLD) {
        var raw by remember(markdown) { mutableStateOf(false) }
        Column {
            if (raw) {
                SelectionContainer {
                    Text(
                        text = markdown,
                        fontSize = 12.sp,
                        fontFamily = OmpMonoFontFamily,
                    )
                }
            } else {
                MarkdownText(
                    markdown = markdown,
                    githubRepo = githubRepo,
                    onLink = onLink,
                    modifier = modifier,
                )
            }
            TextButton(onClick = { raw = !raw }) {
                Text(
                    stringResource(if (raw) R.string.chat_show_rendered else R.string.chat_show_all),
                    fontSize = 11.sp,
                )
            }
        }
        return
    }
    MarkdownText(
        markdown = markdown,
        githubRepo = githubRepo,
        onLink = onLink,
        modifier = modifier,
    )
}

@Composable
private fun BranchSummaryRow(message: ChatMessage.User) {
    val colors = LocalOmpColors.current
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).height(1.dp).background(colors.border))
            Text(
                text = stringResource(R.string.chat_branch_summary),
                modifier = Modifier.padding(horizontal = 8.dp),
                color = colors.textDim,
                fontSize = 10.sp,
                fontFamily = OmpMonoFontFamily,
            )
            Box(Modifier.weight(1f).height(1.dp).background(colors.border))
        }
        if (message.text.isNotBlank()) {
            SafeMarkdownText(
                markdown = message.text,
                githubRepo = null,
                onLink = {},
                modifier = Modifier.padding(top = 6.dp),
            )
        }
    }
}

// ---------------------------------------------------------------- assistant

@Composable
internal fun AssistantRow(
    message: ChatMessage.Assistant,
    state: ChatUiState,
    forkTarget: io.github.kahme247.ompweb.chat.ForkTarget?,
    streaming: Boolean,
    callbacks: ChatRowCallbacks,
    /** Header of a standalone (streaming) reply; transcript rows pass theirs to [MessageRow]. */
    header: HeaderSlot? = null,
) {
    val blocks = displayedBlocks(message, state)
    if (blocks.isEmpty() && message.errorMessage == null && !streaming) return
    val colors = LocalOmpColors.current
    Column(modifier = Modifier.fillMaxWidth()) {
        BlockHeader(header)
        if (!blocks.any { it is AssistantBlock.Thinking || it is AssistantBlock.ToolCall } && streaming) {
            // While the reply streams, only the throughput stays next to the
            // text; the model name now lives in the speaker header.
            Row(
                modifier = Modifier.padding(bottom = 3.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                StreamingMeta(message, state.engine.liveTokensPerSecond)
            }
        }
        AssistantBlockColumn(
            message = message,
            blocks = blocks,
            state = state,
            streaming = streaming,
            callbacks = callbacks,
        )
        message.errorMessage?.takeIf { it.isNotBlank() }?.let { error ->
            ErrorBanner(error, interrupted = isInterruptedMessage(error, message.stopReason))
        }
        val text = blocks.filterIsInstance<AssistantBlock.Text>().joinToString("\n\n") { it.text }
        // Tool-only answers and split segments without usage carry no rate.
        val speed = if (!streaming && text.isNotBlank()) messageSpeed(message) else null
        val canFork = forkTarget != null && !state.busy && !streaming
        val speakId = message.entryId ?: message.key
        if (!streaming && (text.isNotBlank() || canFork || speed != null)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (text.isNotBlank()) CopyAction(text = text)
                if (text.isNotBlank()) {
                    val speaking = state.speakingId == speakId
                    TextButton(onClick = {
                        if (speaking) callbacks.onStopSpeech()
                        else callbacks.onToggleSpeech(message.entryId, speakId, text)
                    }) {
                        Icon(
                            imageVector = if (speaking) Icons.Filled.Close else Icons.Filled.PlayArrow,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = if (speaking) colors.accent else colors.textDim,
                        )
                        Spacer(Modifier.width(3.dp))
                        Text(
                            text = stringResource(if (speaking) R.string.chat_stop else R.string.chat_read),
                            fontSize = 11.sp,
                            color = if (speaking) colors.accent else colors.textDim,
                        )
                    }
                }
                if (canFork && forkTarget != null) {
                    ForkAction(state, forkTarget, callbacks)
                }
                if (speed != null) {
                    Spacer(Modifier.weight(1f))
                    Text(
                        text = stringResource(
                            R.string.chat_tokens_per_second,
                            formatGenerationRate(speed.tokensPerSecond),
                        ),
                        color = colors.textDim,
                        fontSize = 10.sp,
                        fontFamily = OmpMonoFontFamily,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun StreamingMeta(message: ChatMessage.Assistant, liveTokensPerSecond: Double?) {
    val colors = LocalOmpColors.current
    val chars = message.blocks.sumOf { block ->
        when (block) {
            is AssistantBlock.Text -> block.text.length
            is AssistantBlock.Thinking -> block.thinking.length
            else -> 0
        }
    }
    val estimate = (chars / 4.0).roundToInt()
    if (estimate <= 0) return
    Text(text = "$estimate", color = colors.text, fontSize = 11.sp)
    if (liveTokensPerSecond != null) {
        val tone = when {
            liveTokensPerSecond >= 50 -> colors.statusSuccess
            liveTokensPerSecond >= 30 -> colors.statusRenamed
            liveTokensPerSecond >= 15 -> colors.statusWarning
            else -> colors.statusError
        }
        Surface(
            color = tone.copy(alpha = 0.14f),
            contentColor = tone,
            shape = RoundedCornerShape(4.dp),
        ) {
            Text(
                text = stringResource(
                    R.string.chat_tokens_per_second,
                    formatGenerationRate(liveTokensPerSecond),
                ),
                fontSize = 11.sp,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun AssistantBlockColumn(
    message: ChatMessage.Assistant,
    blocks: List<AssistantBlock>,
    state: ChatUiState,
    streaming: Boolean,
    callbacks: ChatRowCallbacks,
) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        blocks.forEachIndexed { position, block ->
            when (block) {
                is AssistantBlock.Text -> {
                    if (block.text.isNotBlank()) {
                        SafeMarkdownText(
                            markdown = block.text,
                            githubRepo = state.githubRepo,
                            onLink = callbacks.onLink,
                        )
                    }
                }

                is AssistantBlock.Thinking -> ThinkingRow(
                    message = message,
                    block = block,
                    blockIndex = originalBlockIndex(message, block),
                    state = state,
                    streaming = streaming,
                    callbacks = callbacks,
                )

                is AssistantBlock.ToolCall -> ToolCallCard(
                    block = block,
                    result = state.toolResults[block.toolCallId],
                    state = state,
                    callbacks = callbacks,
                    startedAt = message.timestamp,
                    liveRun = isCurrentRunMessage(state.engine, message.key),
                )

                is AssistantBlock.Image -> {
                    val source = chatImageSource(block.image, thumbnail = true) ?: return@forEachIndexed
                    RemoteImage(
                        source = source,
                        contentDescription = null,
                        modifier = Modifier.widthIn(max = 320.dp).heightIn(max = 320.dp),
                    )
                }

                is AssistantBlock.Other -> Unit
            }
            if (position != blocks.lastIndex) Spacer(Modifier.height(1.dp))
        }
    }
}

private fun displayedBlocks(
    message: ChatMessage.Assistant,
    state: ChatUiState,
): List<AssistantBlock> = message.blocks.filter { block ->
    if (state.preferences.hideThinking && block is AssistantBlock.Thinking) return@filter false
    if (block is AssistantBlock.Thinking && !block.deferred && !message.streaming && block.thinking.isBlank()) {
        return@filter false
    }
    true
}

private fun originalBlockIndex(
    message: ChatMessage.Assistant,
    block: AssistantBlock.Thinking,
): Int = message.blocks.indexOf(block).takeIf { it >= 0 } ?: block.blockIndex

// -------------------------------------------------------------- thinking row

@Composable
private fun ThinkingRow(
    message: ChatMessage.Assistant,
    block: AssistantBlock.Thinking,
    blockIndex: Int,
    state: ChatUiState,
    streaming: Boolean,
    callbacks: ChatRowCallbacks,
) {
    val colors = LocalOmpColors.current
    var expanded by remember(message.entryId, blockIndex) {
        mutableStateOf(ChatDisplayPrefs.thinkingExpanded(state.preferences.expandThinking))
    }
    val key = "${message.entryId ?: message.key}:$blockIndex"
    val fetched = state.thinking[key]
    LaunchedEffect(expanded, block.deferred, message.entryId) {
        if (expanded && block.deferred) callbacks.onLoadThinking(message.entryId, blockIndex)
    }
    Column(
        modifier = Modifier.fillMaxWidth().border(1.dp, colors.border, RoundedCornerShape(OmpCardRadius)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = 9.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = stringResource(R.string.chat_thinking),
                color = colors.textMuted,
                fontSize = 11.5.sp,
                fontFamily = OmpMonoFontFamily,
                fontWeight = FontWeight.SemiBold,
            )
            if (message.durationMs != null) {
                Text(
                    text = "${(message.durationMs / 1000).roundToInt()}s",
                    color = colors.textDim,
                    fontSize = 10.sp,
                )
            }
            Spacer(Modifier.weight(1f))
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = stringResource(if (expanded) R.string.chat_collapse else R.string.chat_expand),
                modifier = Modifier.size(16.dp),
                tint = colors.textDim,
            )
        }
        if (expanded) {
            val text = when (val entry = fetched) {
                ThinkingEntry.Loading -> stringResource(R.string.chat_loading_block)
                is ThinkingEntry.Error -> entry.message
                is ThinkingEntry.Text -> entry.text
                null -> if (block.deferred) stringResource(R.string.chat_loading_block) else block.thinking
            }
            Text(
                text = text,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 9.dp, vertical = 7.dp),
                color = if (fetched is ThinkingEntry.Error) colors.statusError else colors.textMuted,
                fontSize = 12.sp,
                fontFamily = OmpMonoFontFamily,
                lineHeight = 18.sp,
            )
        }
    }
    if (streaming && !expanded) {
        // A streaming thinking block stays discoverable without opening it.
        Text(
            text = (block.thinking.takeLast(60).replace("\n", " ") + if (block.thinking.length > 60) "…" else ""),
            color = colors.textDim,
            fontSize = 11.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 4.dp, top = 1.dp),
        )
    }
}

// --------------------------------------------------------------- tool cards

/**
 * Whether [key] names the message the running turn is working on right now:
 * the streamed reply while it streams, else the transcript's newest message.
 * A tool call found in an older message belongs to an earlier run and must not
 * read as running.
 */
private fun isCurrentRunMessage(engine: ChatState, key: String): Boolean {
    val streaming = engine.streaming
    return if (streaming != null) streaming.key == key else engine.messages.lastOrNull()?.key == key
}

@Composable
private fun ToolCallCard(
    block: AssistantBlock.ToolCall,
    result: ChatMessage.ToolResult?,
    state: ChatUiState,
    callbacks: ChatRowCallbacks,
    /** The assistant message's timestamp: when this call started running. */
    startedAt: Long? = null,
    /**
     * Whether this call belongs to the run that is streaming right now. Only
     * such a call without a result may read as running; a call left without a
     * result by an earlier, aborted run must not pulse or tick in every later
     * stream.
     */
    liveRun: Boolean = false,
) {
    val colors = LocalOmpColors.current
    val isRunning = result?.partial == true ||
        state.engine.liveTools.any { it.toolCallId == block.toolCallId && it.endedAt == null } ||
        (result == null && liveRun && state.engine.streamingActive)
    val isError = result?.isError == true
    var expanded by remember(block.toolCallId) {
        mutableStateOf(ChatDisplayPrefs.toolCallExpanded(state.preferences.toolCallsCollapsed, isRunning))
    }
    var inputExpanded by remember(block.toolCallId) { mutableStateOf(false) }
    val category = getToolCategory(block.toolName)
    val hubSend = if (category == ToolCategory.Hub) getHubSendSummary(block.input) else null
    val hubJobs = if (category == ToolCategory.Hub) getHubJobs(result?.details) else null
    val receipts = hubReceipts(result?.details)
    val hubReceiptOutcome = receipts
        .map { it.second }
        .takeIf { outcomes -> outcomes.isNotEmpty() && outcomes.all { it == outcomes.first() } }
        ?.firstOrNull()
    val title = when {
        hubSend != null -> "IRC → ${hubSend.to.joinToString(", ")}" + (hubReceiptOutcome?.let { " $it" } ?: "")
        hubJobs != null -> getHubJobsHeader(hubJobs)
        else -> block.toolName
    }
    val preview = when {
        hubSend != null -> hubSend.snippet.ifEmpty { hubSend.to.joinToString(", ") }
        hubJobs != null -> hubJobs.joinToString(" · ") { it.label }
        else -> getToolPreview(block)
    }
    val semantic = getSemanticToolLabel(block)
    val resultText = result?.text
    val resultEmpty = resultText != null && resultText.trim().let { it == "(no output)" || it.isEmpty() }
    val diff = if (expanded && result != null && !isError) {
        ToolDiff.resolve(
            patch = result.details?.str("patch"),
            diff = result.details?.str("diff"),
        )
    } else {
        null
    }
    val meta = getToolResultMeta(result?.details)
    // The live tool frame knows the real start; the message timestamp is the
    // fallback for a call whose frame has not arrived (or a finished one).
    val liveStart = state.engine.liveTools
        .firstOrNull { it.toolCallId == block.toolCallId && it.endedAt == null }
        ?.startedAt
        ?: startedAt
    val reportedDuration = result?.details?.get("durationMs")
        ?.let { (it as? JsonPrimitive)?.contentOrNull?.toDoubleOrNull() }
        ?.toLong()
    val settledDuration = reportedDuration ?: run {
        val finished = result?.timestamp
        if (finished != null && startedAt != null && finished > startedAt) finished - startedAt else null
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.toolBackground, RoundedCornerShape(OmpCardRadius))
            .border(1.dp, colors.border, RoundedCornerShape(OmpCardRadius)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .testTag("chat-tool-card-header")
                .clickable(
                    onClickLabel = stringResource(if (expanded) R.string.chat_collapse else R.string.chat_expand),
                ) { expanded = !expanded }
                // TalkBack reads the tool name, preview and state as one button.
                .semantics(mergeDescendants = true) {}
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ToolCategoryIcon(toolName = block.toolName, size = 14.dp)
            Text(
                text = title,
                color = if (isError) colors.statusError else colors.text,
                fontSize = 11.5.sp,
                fontFamily = OmpMonoFontFamily,
                fontWeight = FontWeight.SemiBold,
            )
            if (preview.isNotEmpty()) {
                val clickableFile = semantic.isFile && block.input.str("path") != null
                Text(
                    text = preview,
                    color = colors.textDim,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier
                        .weight(1f)
                        .then(
                            if (clickableFile) {
                                Modifier.clickable { callbacks.onLink(LinkTarget.File(block.input.str("path")!!, null)) }
                            } else {
                                Modifier
                            },
                        ),
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            // The duration slot is always laid out, empty before a call has run,
            // so switching between running and finished never shifts the row.
            // Only this text recomposes per tick.
            Box(Modifier.widthIn(min = 34.dp), contentAlignment = Alignment.CenterEnd) {
                ElapsedText(
                    startedAt = liveStart,
                    running = isRunning,
                    settledMs = settledDuration,
                    color = if (isRunning) colors.accent else colors.textDim,
                    fontSize = 10.sp,
                    textAlign = TextAlign.End,
                )
            }
            ToolStateIcon(isError = isError, running = isRunning, done = result != null)
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = stringResource(if (expanded) R.string.chat_collapse else R.string.chat_expand),
                modifier = Modifier.size(16.dp),
                tint = colors.textDim,
            )
        }
        if (meta != null) {
            Text(
                text = meta,
                color = colors.textDim,
                fontSize = 10.sp,
                fontFamily = OmpMonoFontFamily,
                modifier = Modifier.padding(start = 30.dp, bottom = 5.dp),
            )
        }
        result?.passiveContext?.let { context ->
            if (!expanded) {
                Text(
                    text = "↳ $context",
                    color = colors.textDim,
                    fontSize = 10.5.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 30.dp, end = 9.dp, bottom = 5.dp),
                )
            }
        }
        if (expanded) {
            Column(modifier = Modifier.padding(start = 9.dp, end = 9.dp, top = 2.dp, bottom = 7.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("$", color = colors.textDim, fontFamily = OmpMonoFontFamily, fontSize = 11.sp)
                    Spacer(Modifier.width(5.dp))
                    Text(
                        text = formatToolCommand(block),
                        color = colors.textMuted,
                        fontFamily = OmpMonoFontFamily,
                        fontSize = 11.sp,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    if (block.input.isNotEmpty()) {
                        TextButton(onClick = { inputExpanded = !inputExpanded }) {
                            Text(
                                text = if (inputExpanded) stringResource(R.string.chat_collapse_input) else stringResource(R.string.chat_show_full_input),
                                fontSize = 10.sp,
                                color = colors.accent,
                            )
                        }
                    }
                }
                if (inputExpanded) {
                    CodeSurface(block.input.toString())
                }
                val todo = if (category == ToolCategory.Todo) getTodoSummary(block.input) else null
                if (todo != null) {
                    Row(
                        modifier = Modifier.padding(vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            text = todo.action,
                            color = colors.accent,
                            fontSize = 10.sp,
                            fontFamily = OmpMonoFontFamily,
                        )
                        Text(todo.task ?: todo.label, fontSize = 11.sp, color = colors.text)
                    }
                }
                TaskResultPanel(result?.details)
                HubResultPanel(block.input, result)
                when {
                    isRunning && resultText.isNullOrBlank() -> Text(
                        text = stringResource(R.string.chat_running),
                        color = colors.textDim,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    diff != null -> DiffView(
                        path = null,
                        oldText = null,
                        newText = null,
                        unifiedPatch = diff,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    result != null -> {
                        if (result.images.isNotEmpty()) {
                            ToolImages(result.images)
                        }
                        if (!(hubJobs != null || (hubSend != null && !isError)) &&
                            !(resultEmpty && result.images.isNotEmpty())
                        ) {
                            CodeSurface(
                                if (resultEmpty) stringResource(R.string.chat_no_output)
                                else formatToolOutput(resultText.orEmpty(), block.toolName),
                                error = isError,
                            )
                        }
                    }
                }
                result?.passiveContext?.let { context ->
                    Text(
                        text = "↳ $context",
                        color = colors.textDim,
                        fontSize = 10.5.sp,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ToolImages(images: List<io.github.kahme247.ompweb.chat.ChatImage>) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        images.forEach { image ->
            val source = chatImageSource(image, thumbnail = true) ?: return@forEach
            RemoteImage(
                source = source,
                contentDescription = null,
                modifier = Modifier.widthIn(max = 240.dp).heightIn(max = 240.dp),
            )
        }
    }
}

/**
 * The state slot of a tool row: a pulsing accent dot while the call runs, a
 * muted check once it settles and an alert when it failed.
 */
@Composable
private fun ToolStateIcon(isError: Boolean, running: Boolean, done: Boolean) {
    val colors = LocalOmpColors.current
    Box(Modifier.size(14.dp), contentAlignment = Alignment.Center) {
        when {
            isError -> Icon(
                imageVector = Icons.Filled.Warning,
                contentDescription = stringResource(R.string.chat_failed),
                modifier = Modifier.size(13.dp),
                tint = colors.statusError,
            )
            running -> LivePulseDot(size = 8.dp)
            done -> Icon(
                imageVector = Icons.Filled.Check,
                contentDescription = stringResource(R.string.chat_done),
                modifier = Modifier.size(13.dp),
                tint = colors.textDim,
            )
        }
    }
}

@Composable
private fun CodeSurface(text: String, error: Boolean = false) {
    val colors = LocalOmpColors.current
    Surface(
        color = colors.background,
        shape = RoundedCornerShape(6.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 3.dp)
            .border(1.dp, if (error) colors.statusError.copy(alpha = 0.4f) else colors.border, RoundedCornerShape(6.dp)),
    ) {
        Text(
            text = text,
            modifier = Modifier
                .heightIn(max = 360.dp)
                .padding(horizontal = 9.dp, vertical = 7.dp),
            color = if (error) colors.statusError else colors.textMuted,
            fontFamily = OmpMonoFontFamily,
            fontSize = 11.sp,
            lineHeight = 16.sp,
        )
    }
}

// ------------------------------------------------------------------- panels

@Composable
private fun TaskResultPanel(details: JsonObject?) {
    if (details == null) return
    val colors = LocalOmpColors.current
    val results = details.arr("results")?.filterIsInstance<JsonObject>().orEmpty()
    val progress = details.arr("progress")?.filterIsInstance<JsonObject>().orEmpty()
    val async = details.obj("async")
    if (results.isEmpty() && progress.isEmpty() && async == null) return
    val rows = when {
        results.isNotEmpty() -> results
        progress.isNotEmpty() -> progress
        async?.str("jobId") != null -> listOf(
            JsonObject(
                mapOf(
                    "id" to JsonPrimitive(async.str("jobId")!!),
                    "agent" to JsonPrimitive("task"),
                    "status" to JsonPrimitive("started"),
                    "task" to JsonPrimitive(async.str("jobId")!!),
                ),
            ),
        )
        else -> emptyList()
    }
    val totalTokens = rows.sumOf { it.int("tokens") ?: 0 }
    val totalCost = rows.sumOf { it.num("cost") ?: 0.0 }
    val totalParts = listOfNotNull(
        stringResource(R.string.chat_task_subagent_count, rows.size),
        formatTokens(totalTokens)?.let { "$it tokens" },
        formatCost(totalCost),
        formatDuration(details.num("totalDurationMs")?.toLong()),
    )
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp)
            .background(colors.backgroundSubtle, RoundedCornerShape(6.dp))
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.chat_task_subagents), color = colors.text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.weight(1f))
            Text(totalParts.joinToString(" · "), color = colors.textDim, fontSize = 10.sp, fontFamily = OmpMonoFontFamily)
        }
        rows.forEachIndexed { index, row ->
            val status = taskRowStatus(row)
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text = when (status) {
                        "completed" -> "✓"
                        "failed" -> "✗"
                        "aborted" -> "⊘"
                        else -> "•"
                    },
                    color = when (status) {
                        "completed" -> colors.statusSuccess
                        "failed" -> colors.statusError
                        else -> colors.accent
                    },
                    fontSize = 11.sp,
                )
                Text(
                    text = row.str("agent") ?: "subagent",
                    color = colors.accent,
                    fontSize = 10.5.sp,
                    fontFamily = OmpMonoFontFamily,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = row.str("task") ?: row.str("assignment") ?: "",
                    color = colors.text,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                val rowParts = listOfNotNull(
                    formatTokens(row.int("tokens"))?.let { "$it tokens" },
                    formatCost(row.num("cost")),
                    if (status != "started") formatDuration(row.num("durationMs")?.toLong()) else null,
                    shortModel(row.str("resolvedModel")),
                )
                if (rowParts.isNotEmpty()) {
                    Text(
                        text = rowParts.joinToString(" · "),
                        color = colors.textDim,
                        fontSize = 10.sp,
                        fontFamily = OmpMonoFontFamily,
                    )
                }
            }
            if (index == rows.lastIndex) Spacer(Modifier.height(1.dp))
        }
    }
}

private fun taskRowStatus(row: JsonObject): String {
    if (row.bool("aborted") == true) return "aborted"
    if (!row.str("error").isNullOrEmpty()) return "failed"
    val exitCode = row.int("exitCode")
    if (exitCode != null) return if (exitCode == 0) "completed" else "failed"
    return when (row.str("status")) {
        "completed" -> "completed"
        "failed" -> "failed"
        "aborted" -> "aborted"
        else -> "started"
    }
}

@Composable
private fun HubResultPanel(input: JsonObject, result: ChatMessage.ToolResult?) {
    val colors = LocalOmpColors.current
    when (input.str("op")) {
        "send" -> {
            val send = getHubSendSummary(input) ?: return
            val receipts = hubReceipts(result?.details)
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp)
                    .background(colors.backgroundSubtle, RoundedCornerShape(6.dp))
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = "IRC → ${send.to.joinToString(", ")}",
                        color = colors.text,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.weight(1f))
                    if (receipts.isNotEmpty()) {
                        Text(
                            text = receipts.joinToString(" · ") { it.second },
                            color = colors.textDim,
                            fontSize = 10.sp,
                            fontFamily = OmpMonoFontFamily,
                        )
                    }
                }
                if (send.message.isNotBlank()) {
                    MarkdownText(markdown = send.message, onLink = {}, modifier = Modifier.fillMaxWidth())
                }
            }
        }

        "jobs" -> {
            val jobs = getHubJobs(result?.details) ?: return
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp)
                    .background(colors.backgroundSubtle, RoundedCornerShape(6.dp))
                    .padding(8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(getHubJobsHeader(jobs), color = colors.text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
                jobs.forEach { job ->
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            text = job.status,
                            color = when (job.status) {
                                "completed" -> colors.statusSuccess
                                "failed" -> colors.statusError
                                else -> colors.accent
                            },
                            fontSize = 10.sp,
                        )
                        Text(
                            text = "[${job.type}]",
                            color = colors.accent,
                            fontSize = 10.5.sp,
                            fontFamily = OmpMonoFontFamily,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = job.label,
                            color = colors.text,
                            fontSize = 11.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        formatJobDuration(job.durationMs)?.let {
                            Text(it, color = colors.textDim, fontSize = 10.sp, fontFamily = OmpMonoFontFamily)
                        }
                    }
                }
            }
        }
    }
}

private fun hubReceipts(details: JsonObject?): List<Pair<String, String>> {
    val receipts = details?.arr("receipts") ?: return emptyList()
    return receipts.filterIsInstance<JsonObject>().mapNotNull { raw ->
        val to = raw.str("to") ?: return@mapNotNull null
        to to (raw.str("outcome") ?: "sent")
    }
}

// ----------------------------------------------------------- bash & custom

@Composable
private fun BashRow(
    message: ChatMessage.BashExecution,
    state: ChatUiState,
    callbacks: ChatRowCallbacks,
) {
    val colors = LocalOmpColors.current
    val pending = message.output.isNullOrEmpty() && message.exitCode == null && !message.cancelled
    val isError = message.cancelled || (message.exitCode != null && message.exitCode != 0)
    val toolName = "bash"
    val block = AssistantBlock.ToolCall(
        toolCallId = "bash-${message.key}",
        toolName = toolName,
        input = JsonObject(mapOf("command" to JsonPrimitive(message.command))),
    )
    val result = if (pending) {
        null
    } else {
        ChatMessage.ToolResult(
            key = message.key,
            timestamp = message.timestamp,
            entryId = message.entryId,
            toolCallId = block.toolCallId,
            toolName = toolName,
            text = message.output.orEmpty(),
            isError = isError,
        )
    }
    ToolCallCard(
        block = block,
        result = result,
        state = state,
        callbacks = callbacks,
        startedAt = message.timestamp,
        liveRun = isCurrentRunMessage(state.engine, message.key),
    )
    message.fullOutputPath?.let { path ->
        val output = state.bashOutputs[path]
        Column(modifier = Modifier.padding(start = 6.dp, top = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (output !is BashOutputUi.Ready) {
                    TextButton(
                        enabled = output !is BashOutputUi.Loading,
                        onClick = { callbacks.onLoadBashOutput(path) },
                    ) {
                        Text(
                            text = stringResource(if (output is BashOutputUi.Loading) R.string.chat_loading_full_output else R.string.chat_view_full_output),
                            fontSize = 11.sp,
                            color = colors.accent,
                        )
                    }
                }
                Text(
                    text = stringResource(R.string.chat_download),
                    color = colors.textDim,
                    fontSize = 11.sp,
                    modifier = Modifier.clickable { callbacks.onDownloadBashOutput(path) },
                )
            }
            when (output) {
                is BashOutputUi.Ready -> CodeSurface(output.text)
                is BashOutputUi.Error -> Text(
                    text = output.message,
                    color = colors.statusError,
                    fontSize = 11.sp,
                    modifier = Modifier.padding(vertical = 4.dp),
                )
                else -> Unit
            }
        }
    }
}

@Composable
private fun CustomRow(
    message: ChatMessage.Custom,
    state: ChatUiState,
    callbacks: ChatRowCallbacks,
) {
    if (message.customType == "compaction") {
        CompactionRow(message)
        return
    }
    if (message.customType == PASSIVE_TOOL_CONTEXT || message.customType == MOUNT_NOTICE) return
    if (!message.display) return
    val colors = LocalOmpColors.current
    val isDeveloper = message.customType == "developer"
    val isNotice = isDeveloper || message.customType == "async-result" || message.customType == "lsp-late-diagnostic"
    var contentExpanded by remember(message.key) { mutableStateOf(!isNotice) }
    var detailsExpanded by remember(message.key) { mutableStateOf(false) }
    val isPlainText = message.customType == "async-result" || message.customType == "lsp-late-diagnostic"
    val displayText = if (isDeveloper) stripHiddenWrappers(message.text) else message.text
    val firstLine = displayText.lineSequence().firstOrNull { it.trim().isNotEmpty() }?.trim().orEmpty()
    val collapsedPreview = if (firstLine.isNotEmpty() && firstLine != displayText.trim()) "$firstLine …" else firstLine
    val title = when {
        isDeveloper -> leadingWrapperTitle(message.text) ?: "developer"
        message.customType == "advisor" -> stringResource(R.string.chat_advisor)
        else -> formatCustomType(message.customType)
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, colors.border, RoundedCornerShape(OmpCardRadius)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .then(if (isNotice) Modifier.clickable { contentExpanded = !contentExpanded } else Modifier)
                .padding(horizontal = 9.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (isNotice) {
                Icon(
                    imageVector = Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                    tint = colors.textDim,
                )
            }
            Text(
                text = title,
                color = colors.textMuted,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.weight(1f))
            TimestampLabel(message.timestamp)
        }
        if (contentExpanded) {
            Column(modifier = Modifier.padding(horizontal = 9.dp, vertical = 6.dp)) {
                if (displayText.isBlank()) {
                    Text(stringResource(R.string.chat_no_message), color = colors.textDim, fontSize = 11.sp)
                } else if (isPlainText) {
                    Text(
                        text = displayText,
                        color = colors.textMuted,
                        fontFamily = OmpMonoFontFamily,
                        fontSize = 11.sp,
                        lineHeight = 16.sp,
                        modifier = Modifier.heightIn(max = 420.dp),
                    )
                } else {
                    MarkdownText(
                        markdown = displayText,
                        githubRepo = state.githubRepo,
                        onLink = callbacks.onLink,
                    )
                }
            }
        } else {
            Text(
                text = collapsedPreview.ifEmpty { displayText.take(120) },
                color = colors.textDim,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { contentExpanded = true }
                    .padding(horizontal = 9.dp, vertical = 6.dp),
            )
        }
        Row(
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CopyAction(text = displayText.ifBlank { message.details?.toString().orEmpty() })
            message.details?.let { details ->
                TextButton(onClick = { detailsExpanded = !detailsExpanded }) {
                    Text(
                        text = if (detailsExpanded) stringResource(R.string.chat_hide_details) else stringResource(R.string.chat_details),
                        fontSize = 10.sp,
                        color = colors.textDim,
                    )
                }
            }
            Spacer(Modifier.weight(1f))
        }
        if (detailsExpanded) {
            CodeSurface(message.details.toString())
        }
    }
}

@Composable
private fun CompactionRow(message: ChatMessage.Custom) {
    val colors = LocalOmpColors.current
    val parsed = remember(message.text) { parseCompactionSummary(message.text) }
    val tokensBefore = message.details?.int("tokensBefore")
    val tokensAfter = message.details?.int("tokensAfter")
    val method = message.details?.str("method")?.takeIf { it.isNotBlank() }
    var filesExpanded by remember(message.key) { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, colors.border, RoundedCornerShape(OmpCardRadius)),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.panel)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = stringResource(R.string.chat_compaction),
                color = colors.textMuted,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(Modifier.weight(1f))
            TimestampLabel(message.timestamp)
        }
        Column(modifier = Modifier.padding(horizontal = 11.dp, vertical = 9.dp)) {
            Text(
                text = stringResource(R.string.chat_conversation_compacted),
                color = colors.text,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
            )
            if (method != null || (tokensBefore != null && tokensAfter != null)) {
                Row(
                    modifier = Modifier.padding(top = 4.dp, bottom = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    method?.let {
                        Text(
                            text = it,
                            color = colors.textMuted,
                            fontSize = 11.sp,
                            fontFamily = OmpMonoFontFamily,
                            modifier = Modifier
                                .background(colors.backgroundSubtle, RoundedCornerShape(4.dp))
                                .padding(horizontal = 7.dp, vertical = 1.dp),
                        )
                    }
                    if (tokensBefore != null && tokensAfter != null) {
                        Text(
                            text = "${formatCompactNumber(tokensBefore.toDouble())} → ${formatCompactNumber(tokensAfter.toDouble())} tokens",
                            color = colors.textMuted,
                            fontSize = 11.sp,
                        )
                    }
                }
            }
            Text(
                text = stringResource(R.string.chat_compaction_hint),
                color = colors.text,
                fontSize = 13.sp,
            )
            if (parsed.body.isNotBlank()) {
                MarkdownText(
                    markdown = parsed.body,
                    modifier = Modifier.padding(top = 6.dp),
                    onLink = {},
                )
            } else {
                Text(stringResource(R.string.chat_no_summary), color = colors.textDim, fontSize = 11.sp)
            }
            val total = parsed.readFiles.size + parsed.modifiedFiles.size
            if (total > 0) {
                TextButton(onClick = { filesExpanded = !filesExpanded }) {
                    val parts = buildList {
                        if (parsed.readFiles.isNotEmpty()) add(stringResource(R.string.chat_file_context_read, parsed.readFiles.size))
                        if (parsed.modifiedFiles.isNotEmpty()) add(stringResource(R.string.chat_file_context_modified, parsed.modifiedFiles.size))
                    }
                    Text(
                        text = stringResource(R.string.chat_file_context, parts.joinToString(", ")),
                        fontSize = 11.sp,
                        color = colors.accent,
                    )
                }
                if (filesExpanded) {
                    if (parsed.modifiedFiles.isNotEmpty()) CompactionFiles(stringResource(R.string.chat_modified_files), parsed.modifiedFiles)
                    if (parsed.readFiles.isNotEmpty()) CompactionFiles(stringResource(R.string.chat_read_files), parsed.readFiles)
                }
            }
        }
    }
}

@Composable
private fun CompactionFiles(title: String, files: List<String>) {
    val colors = LocalOmpColors.current
    Text(
        text = title,
        color = colors.textMuted,
        fontSize = 10.5.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 4.dp),
    )
    files.forEach { file ->
        Text(
            text = "• $file",
            color = colors.textDim,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
        )
    }
}

// ------------------------------------------------------------------- pieces

@Composable
private fun ProcessDetailsGroup(
    key: String,
    messageCount: Int,
    toolCallCount: Int,
    live: LiveActivity? = null,
    startedAt: Long? = null,
    /** The turn's last timestamp; the settled duration is derived from it. */
    finishedAt: Long? = null,
    content: @Composable () -> Unit,
) {
    val colors = LocalOmpColors.current
    var expanded by remember(key) { mutableStateOf(false) }
    val settled = if (
        live == null && startedAt != null && finishedAt != null && finishedAt > startedAt
    ) {
        finishedAt - startedAt
    } else {
        null
    }
    Column {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(horizontal = 4.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = stringResource(if (expanded) R.string.chat_collapse else R.string.chat_expand),
                modifier = Modifier.size(14.dp),
                tint = if (live != null) colors.accent else colors.textDim,
            )
            if (live == null) {
                Icon(
                    imageVector = Icons.Filled.Check,
                    contentDescription = stringResource(R.string.chat_done),
                    modifier = Modifier.size(12.dp),
                    tint = colors.textDim,
                )
            }
            val parts = buildList {
                add(stringResource(R.string.chat_process_details))
                add(stringResource(if (messageCount == 1) R.string.chat_process_message else R.string.chat_process_messages, messageCount))
                if (toolCallCount > 0) {
                    add(stringResource(if (toolCallCount == 1) R.string.chat_process_tool_call else R.string.chat_process_tool_calls, toolCallCount))
                }
            }
            // The duration ticks in its own composable, so a running fold
            // recomposes only this text every second, not the whole row.
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = parts.joinToString(" · "),
                    color = if (live != null) colors.textMuted else colors.textDim,
                    fontSize = 11.sp,
                )
                ElapsedText(
                    startedAt = startedAt,
                    running = live != null,
                    settledMs = settled,
                    prefix = " · ",
                    color = if (live != null) colors.textMuted else colors.textDim,
                    fontSize = 11.sp,
                )
            }
        }
        // The collapsed row of the running turn must still show that work is in
        // progress: what it waits on right now, with a live indicator. The
        // static summary returns as soon as the turn ends (live == null).
        if (live != null) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 24.dp, end = 4.dp, bottom = 4.dp)
                    .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (live is LiveActivity.Tool) {
                    ToolCategoryIcon(toolName = live.name, size = 12.dp)
                }
                LivePulseDot()
                Text(
                    text = liveActivityText(live),
                    color = colors.textMuted,
                    fontSize = 11.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (expanded) {
            Column(
                modifier = Modifier.padding(start = 6.dp, top = 2.dp, bottom = 2.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                content()
            }
        }
    }
}

/** The live activity line: current tool and its intent, or the phase. */
@Composable
private fun liveActivityText(live: LiveActivity): String = when (live) {
    is LiveActivity.Tool -> buildString {
        append(live.name)
        if (live.intent.isNotBlank()) append(" · ").append(live.intent)
        if (live.more > 0) append(' ').append(stringResource(R.string.chat_live_more, live.more))
    }

    LiveActivity.Thinking -> stringResource(R.string.chat_live_thinking)
    LiveActivity.Writing -> stringResource(R.string.chat_live_writing)
    LiveActivity.RunningCommand -> stringResource(R.string.chat_phase_running_command)
    LiveActivity.Compacting -> stringResource(R.string.chat_status_compacting)
    LiveActivity.Working -> stringResource(R.string.chat_status_working)
}

// ---------------------------------------------------------------- utilities

@Composable
private fun CopyAction(text: String) {
    if (text.isBlank()) return
    val colors = LocalOmpColors.current
    val context = LocalContext.current
    TextButton(onClick = { copyTextToClipboard(context, "message", text) }) {
        Text(stringResource(R.string.chat_copy), fontSize = 11.sp, color = colors.textDim)
    }
}

/**
 * Fork button of a message row. Spawning omp for a large session or branching a
 * long history is not instant, so the in-flight request renders as a spinner:
 * without it a slow fork looks exactly like a dead button, and only a transient
 * system Toast told the user that nothing was created.
 */
@Composable
private fun ForkAction(
    state: ChatUiState,
    forkTarget: io.github.kahme247.ompweb.chat.ForkTarget,
    callbacks: ChatRowCallbacks,
) {
    val colors = LocalOmpColors.current
    val forking = state.forkingEntryId == forkTarget.entryId
    // One fork at a time (the view model ignores extra taps); disabling the
    // other rows makes that rule visible instead of silently swallowing taps.
    TextButton(
        onClick = { callbacks.onFork(forkTarget.entryId, forkTarget.editPrompt) },
        enabled = state.forkingEntryId == null,
    ) {
        if (forking) {
            CircularProgressIndicator(
                modifier = Modifier.size(12.dp),
                strokeWidth = 1.5.dp,
                color = colors.textDim,
            )
            Spacer(Modifier.width(5.dp))
            Text(stringResource(R.string.chat_forking), fontSize = 11.sp, color = colors.textDim)
        } else {
            Text(stringResource(R.string.chat_new_session), fontSize = 11.sp, color = colors.textDim)
        }
    }
}

/**
 * A block's speaker header. Absent while the same speaker continues on the
 * same day, so a run of messages reads as one block; a day separator is a
 * separate element of the rendered transcript ([TranscriptFormat.daySeparators]).
 */
@Composable
internal fun BlockHeader(slot: HeaderSlot?) {
    if (slot == null) return
    val speaker = slot.speaker
    if (slot.showHeader && speaker != null) {
        SpeakerHeaderRow(speaker = speaker, timestamp = slot.timestamp)
    }
}

/** The line between two transcript days: `Today`, `Yesterday`, or a date. */
@Composable
private fun DaySeparatorRow(timestamp: Long?) {
    if (timestamp == null) return
    val colors = LocalOmpColors.current
    val formatter = rememberChatTimeFormatter()
    val clock = LocalChatClock.current
    val now = LocalChatNow.current ?: clock()
    val label = remember(timestamp, now, formatter) { formatter.daySeparator(timestamp, now) }
    Row(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).height(1.dp).background(colors.border))
        Text(
            text = label,
            modifier = Modifier.padding(horizontal = 8.dp),
            color = colors.textDim,
            fontSize = 10.sp,
            fontFamily = OmpMonoFontFamily,
        )
        Box(Modifier.weight(1f).height(1.dp).background(colors.border))
    }
}

/**
 * The compact "who is speaking" header: a round role badge with the speaker's
 * initial, its name and the block's time. The user's badge is filled with the
 * accent and the assistant's is outlined, so the two never read alike.
 */
@Composable
internal fun SpeakerHeaderRow(speaker: Speaker, timestamp: Long?) {
    val colors = LocalOmpColors.current
    val name = when (speaker.role) {
        SpeakerRole.You -> stringResource(R.string.chat_speaker_you)
        SpeakerRole.Assistant -> speaker.name ?: stringResource(R.string.chat_speaker_assistant)
        SpeakerRole.Subagent -> speaker.name ?: stringResource(R.string.chat_speaker_subagent)
    }
    val badgeColor = when (speaker.role) {
        SpeakerRole.You -> colors.accent
        SpeakerRole.Subagent -> colors.secondaryAccent ?: colors.accent
        SpeakerRole.Assistant -> colors.backgroundSubtle
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 2.dp, end = 2.dp, top = 6.dp, bottom = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(
            modifier = Modifier
                .size(18.dp)
                .background(badgeColor, CircleShape)
                .then(
                    if (speaker.role == SpeakerRole.Assistant) {
                        Modifier.border(1.dp, colors.border, CircleShape)
                    } else {
                        Modifier
                    },
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = speaker.initial.toString(),
                color = if (speaker.role == SpeakerRole.Assistant) colors.textMuted else colors.onAccent,
                fontSize = 9.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = OmpMonoFontFamily,
            )
        }
        Text(
            text = name,
            color = if (speaker.role == SpeakerRole.You) colors.text else colors.textMuted,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Spacer(Modifier.weight(1f))
        TimestampLabel(timestamp)
    }
}

/**
 * A timestamp in the transcript. Tapping it shows the full date and time: the
 * header uses the short shape (today `HH:mm`, yesterday `Yesterday HH:mm`, this
 * year `d MMM, HH:mm`), which cannot carry a weekday or a year.
 */
@Composable
private fun TimestampLabel(timestamp: Long?) {
    if (timestamp == null) return
    val colors = LocalOmpColors.current
    val formatter = rememberChatTimeFormatter()
    val clock = LocalChatClock.current
    val now = LocalChatNow.current ?: clock()
    val formatted = remember(timestamp, now, formatter) { formatter.header(timestamp, now) }
    var full by remember(timestamp) { mutableStateOf(false) }
    Text(
        text = formatted,
        modifier = Modifier
            .clickable(onClickLabel = stringResource(R.string.chat_timestamp_full_title)) { full = true }
            .padding(horizontal = 4.dp, vertical = 3.dp),
        color = colors.textDim,
        fontSize = 10.sp,
    )
    if (full) {
        OmpAlertDialog(
            onDismissRequest = { full = false },
            confirmButton = {
                TextButton(onClick = { full = false }) {
                    Text(
                        text = stringResource(R.string.common_close),
                        fontSize = 12.sp,
                        color = colors.accent,
                    )
                }
            },
            title = {
                Text(
                    text = stringResource(R.string.chat_timestamp_full_title),
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                )
            },
            text = {
                Text(
                    text = formatter.full(timestamp),
                    fontFamily = OmpMonoFontFamily,
                    fontSize = 12.sp,
                )
            },
        )
    }
}

@Composable
private fun ErrorBanner(message: String, interrupted: Boolean) {
    val colors = LocalOmpColors.current
    val tone = if (interrupted) colors.textMuted else colors.statusError
    Surface(
        color = tone.copy(alpha = 0.08f),
        contentColor = tone,
        shape = RoundedCornerShape(6.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 2.dp)
            .border(1.dp, tone.copy(alpha = 0.35f), RoundedCornerShape(6.dp)),
    ) {
        Row(modifier = Modifier.padding(7.dp), verticalAlignment = Alignment.Top) {
            if (!interrupted) {
                Icon(
                    imageVector = Icons.Filled.Warning,
                    contentDescription = null,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
            }
            Text(
                text = if (interrupted) stringResource(R.string.chat_interrupted) else message,
                fontSize = 12.sp,
                lineHeight = 17.sp,
            )
        }
    }
}

@Composable
internal fun PendingUserBubble(text: String, header: HeaderSlot? = null) {
    val colors = LocalOmpColors.current
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        BlockHeader(header)
        Surface(
            color = colors.userBackground,
            shape = RoundedCornerShape(OmpCardRadius),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                Text(text, color = colors.text, fontSize = 14.sp)
                Text(
                    text = stringResource(R.string.chat_sending),
                    color = colors.textDim,
                    fontSize = 10.sp,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
    }
}

internal fun isInterruptedMessage(errorMessage: String?, stopReason: String?): Boolean {
    if (stopReason == "aborted") return true
    if (errorMessage.isNullOrBlank()) return false
    val lower = errorMessage.lowercase().trim()
    return lower == "interrupted by user" ||
        lower == "interrupted" ||
        lower == "generation stopped by user" ||
        lower.startsWith("interrupted by user") ||
        lower.startsWith("interrupted:") ||
        lower == "aborted" ||
        lower == "cancelled"
}

private fun chatImageSource(
    image: io.github.kahme247.ompweb.chat.ChatImage,
    thumbnail: Boolean,
): io.github.kahme247.ompweb.ui.render.ImageSource? {
    image.url?.takeIf { it.isNotBlank() }?.let { url ->
        val withThumb = if (thumbnail && !url.contains("thumb=")) {
            if (url.contains('?')) "$url&thumb=1" else "$url?thumb=1"
        } else {
            url
        }
        return io.github.kahme247.ompweb.ui.render.ImageSource.Url(withThumb)
    }
    image.base64?.takeIf { it.isNotBlank() }?.let {
        return imageSourceFor("data:${image.mimeType ?: "image/png"};base64,$it")
    }
    return null
}

private fun stripHiddenWrappers(text: String): String {
    var value = text.trim()
    value = value.replace(Regex("^<!--[\\s\\S]*?-->\\s*"), "").trim()
    val outer = Regex("^<([a-zA-Z0-9_-]+)(?:\\s(?:[^>\"]|\"[^\"]*\")*)?>([\\s\\S]*)</\\1>$").find(value)
    return outer?.groups?.get(2)?.value?.trim() ?: value
}

private fun leadingWrapperTitle(text: String): String? {
    val match = Regex("""^<(\w+)((?:\s+[\w-]+="[^"]*")*)\s*>""").find(text.trim()) ?: return null
    val tag = match.groups[1]!!.value
    val attrs = Regex("""([\w-]+)="([^"]*)"""")
        .findAll(match.groups[2]!!.value)
        .map { it.groups[1]!!.value to it.groups[2]!!.value }
        .filter { it.second.isNotEmpty() }
        .map { (key, value) -> "$key=$value" }
    return (listOf(tag) + attrs).joinToString(" · ")
}

private fun formatCustomType(type: String): String {
    if (type.isBlank()) return "Extension"
    return type.replace('-', ' ').replace('_', ' ')
        .split(' ')
        .joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } }
}
