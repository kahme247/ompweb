package io.github.kahme247.ompweb.ui.panels

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.kahme247.ompweb.ui.theme.OmpDialog
import androidx.compose.ui.window.DialogProperties
import io.github.kahme247.ompweb.R
import io.github.kahme247.ompweb.chat.Speaker
import io.github.kahme247.ompweb.chat.SpeakerRole
import io.github.kahme247.ompweb.domain.SubagentActivityEvent
import io.github.kahme247.ompweb.domain.SubagentActivityKind
import io.github.kahme247.ompweb.domain.SubagentTranscriptMessage
import io.github.kahme247.ompweb.ui.chat.SpeakerHeaderRow
import io.github.kahme247.ompweb.ui.chat.SubagentDialogState
import io.github.kahme247.ompweb.ui.chat.SubagentTranscriptState
import io.github.kahme247.ompweb.ui.render.GithubRepoRef
import io.github.kahme247.ompweb.ui.render.LinkTarget
import io.github.kahme247.ompweb.ui.render.MarkdownText
import io.github.kahme247.ompweb.ui.theme.LocalOmpColors
import io.github.kahme247.ompweb.ui.theme.OmpMonoFontFamily
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The subagent transcript dialog (web `SubagentTranscriptDialog`): live header
 * telemetry, the recent activity tail while the child still runs, the task and
 * the settled completion (JSON-aware), and a paged raw transcript with an
 * RPC-first / disk-fallback pager driven by the view model.
 */
@Composable
fun SubagentTranscriptDialog(
    state: SubagentDialogState,
    githubRepo: GithubRepoRef?,
    onLink: (LinkTarget) -> Unit,
    onToggleTranscript: () -> Unit,
    onLoadMore: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LocalOmpColors.current
    val configuration = LocalConfiguration.current
    val maxWidth = (configuration.screenWidthDp * 0.94f).coerceAtMost(920f).dp
    val transcriptMax = (configuration.screenHeightDp * 0.50f).dp
    OmpDialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 6.dp, vertical = 12.dp),
            color = colors.background,
            contentColor = colors.text,
            shape = RoundedCornerShape(14.dp),
            tonalElevation = 4.dp,
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    val transcriptTitle = stringResource(R.string.panels_transcript_title)
                    Row(
                        modifier = Modifier.semantics { contentDescription = transcriptTitle },
                        verticalAlignment = Alignment.Top,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                text = state.agent ?: state.id,
                                color = colors.accent,
                                fontSize = 14.sp,
                                fontFamily = OmpMonoFontFamily,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            state.description?.takeIf { it.isNotBlank() }?.let { description ->
                                Text(
                                    text = description,
                                    color = colors.textMuted,
                                    fontSize = 12.5.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            SubagentModelRow(state.resolvedModel)
                            Text(
                                text = state.sessionFile ?: state.id,
                                color = colors.textDim,
                                fontSize = 11.sp,
                                fontFamily = OmpMonoFontFamily,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            StateHistoryMeta(state)
                            state.outcomeError?.takeIf { it.isNotBlank() }?.let { outcome ->
                                Text(
                                    text = outcome,
                                    color = colors.statusError,
                                    fontSize = 11.sp,
                                    modifier = Modifier.padding(top = 2.dp),
                                )
                            }
                        }
                        IconButton(onClick = onDismiss) {
                            Icon(
                                imageVector = Icons.Filled.Close,
                                contentDescription = stringResource(R.string.panels_transcript_close),
                                tint = colors.textMuted,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }

                    state.activity.takeLast(4)
                        .takeIf { state.live && state.completion == null && it.isNotEmpty() }
                        ?.let { events -> RecentActivity(events) }

                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f, fill = false)
                            .verticalScroll(rememberScrollState())
                            .padding(top = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        state.error?.let { error ->
                            Text(text = error, color = colors.statusError, fontSize = 12.sp)
                        } ?: run {
                            state.task?.takeIf { it.isNotBlank() }?.let { task ->
                                LabeledBlock(
                                    label = stringResource(R.string.panels_transcript_task),
                                    container = colors.backgroundSubtle,
                                ) {
                                    MarkdownText(
                                        markdown = task,
                                        githubRepo = githubRepo,
                                        onLink = onLink,
                                    )
                                }
                            }
                            LabeledBlock(
                                label = stringResource(R.string.panels_transcript_result),
                                container = colors.panel,
                                trailing = if (state.truncated) {
                                    {
                                        Text(
                                            text = stringResource(R.string.panels_transcript_truncated),
                                            color = colors.textDim,
                                            fontSize = 10.5.sp,
                                        )
                                    }
                                } else {
                                    null
                                },
                            ) {
                                CompletionBody(
                                    completion = state.completion,
                                    githubRepo = githubRepo,
                                    onLink = onLink,
                                )
                            }
                            if (state.loading) {
                                Text(
                                    text = stringResource(R.string.panels_transcript_loading),
                                    color = colors.textDim,
                                    fontSize = 11.sp,
                                )
                            }
                            Text(
                                text = stringResource(
                                    if (state.transcript.open) {
                                        R.string.panels_transcript_hide
                                    } else {
                                        R.string.panels_transcript_show
                                    },
                                ),
                                color = colors.accent,
                                fontSize = 12.sp,
                                modifier = Modifier
                                    .clickable(role = Role.Button, onClick = onToggleTranscript)
                                    .padding(vertical = 2.dp),
                            )
                            if (state.transcript.open) {
                                TranscriptPanel(
                                    transcript = state.transcript,
                                    maxHeight = transcriptMax,
                                    agentName = state.agent ?: state.id,
                                    onLoadMore = onLoadMore,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SubagentModelRow(resolvedModel: String?) {
    val colors = LocalOmpColors.current
    val model = io.github.kahme247.ompweb.domain.fullModel(resolvedModel) ?: return
    val effort = io.github.kahme247.ompweb.domain.modelEffort(resolvedModel)
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            text = stringResource(R.string.panels_transcript_model),
            color = colors.textDim,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
        )
        Text(
            text = model,
            color = colors.textMuted,
            fontSize = 11.sp,
            fontFamily = OmpMonoFontFamily,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (effort != null) {
            Text(
                text = stringResource(R.string.panels_transcript_effort),
                color = colors.textDim,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
            )
            Text(
                text = effort,
                color = colors.textMuted,
                fontSize = 11.sp,
                fontFamily = OmpMonoFontFamily,
            )
        }
    }
}

@Composable
private fun StateHistoryMeta(state: SubagentDialogState) {
    val tokens = io.github.kahme247.ompweb.domain.formatTokens(state.tokens)
    val meta = listOfNotNull(
        tokens?.let { stringResource(R.string.panels_tokens_unit, it) },
        io.github.kahme247.ompweb.domain.formatCost(state.cost),
        io.github.kahme247.ompweb.domain.formatDuration(state.durationMs),
    ).joinToString(" · ")
    if (meta.isEmpty()) return
    val colors = LocalOmpColors.current
    Text(
        text = meta,
        color = colors.textDim,
        fontSize = 10.5.sp,
        fontFamily = OmpMonoFontFamily,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun RecentActivity(events: List<SubagentActivityEvent>) {
    val colors = LocalOmpColors.current
    Surface(
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
        color = colors.panel,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            events.forEach { event ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = when (event.kind) {
                            SubagentActivityKind.TOOL -> "·"
                            SubagentActivityKind.NOTICE -> "!"
                            SubagentActivityKind.TEXT -> "»"
                        },
                        color = colors.textDim,
                        fontSize = 11.sp,
                        fontFamily = OmpMonoFontFamily,
                    )
                    Text(
                        text = event.label,
                        color = if (event.kind == SubagentActivityKind.TOOL) colors.accent else colors.textMuted,
                        fontSize = 11.sp,
                        fontFamily = OmpMonoFontFamily,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun LabeledBlock(
    label: String,
    container: androidx.compose.ui.graphics.Color,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val colors = LocalOmpColors.current
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = container,
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = label.uppercase(),
                    color = colors.textDim,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 0.4.sp,
                    fontFamily = OmpMonoFontFamily,
                )
                trailing?.invoke()
            }
            Box(Modifier.padding(top = 6.dp)) { content() }
        }
    }
}

/** The settled `<id>.md` output: a single JSON string unwraps to its text. */
@Composable
private fun CompletionBody(
    completion: String?,
    githubRepo: GithubRepoRef?,
    onLink: (LinkTarget) -> Unit,
) {
    val colors = LocalOmpColors.current
    val parsed = rememberParsedCompletion(completion)
    val singleText = parsed
        ?.takeIf { it.size == 1 }
        ?.values
        ?.firstOrNull()
        ?.let { it as? JsonPrimitive }
        ?.takeIf { it.isString }
        ?.content
    when {
        singleText != null -> Text(
            text = singleText,
            color = colors.textMuted,
            fontSize = 12.sp,
            lineHeight = 19.sp,
        )
        parsed != null -> JsonValue(parsed)
        completion != null -> MarkdownText(
            markdown = completion,
            githubRepo = githubRepo,
            onLink = onLink,
        )
        else -> Text(
            text = stringResource(R.string.panels_transcript_no_completion),
            color = colors.textDim,
            fontSize = 12.sp,
        )
    }
}

@Composable
private fun rememberParsedCompletion(completion: String?): JsonObject? {
    if (completion.isNullOrBlank()) return null
    return androidx.compose.runtime.remember(completion) {
        runCatching {
            kotlinx.serialization.json.Json.parseToJsonElement(completion) as? JsonObject
        }.getOrNull()
    }
}

/** Recursive structured-completion renderer (web `JsonValue`). */
@Composable
private fun JsonValue(value: JsonElement) {
    val colors = LocalOmpColors.current
    when (value) {
        is JsonObject -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            value.keys.forEach { key ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        text = key,
                        color = colors.textDim,
                        fontSize = 10.5.sp,
                        fontFamily = OmpMonoFontFamily,
                        modifier = Modifier.widthIn(max = 130.dp),
                    )
                    Box(Modifier.weight(1f)) { JsonValue(value.getValue(key)) }
                }
            }
        }
        is JsonArray -> Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            value.forEach { item ->
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(text = "•", color = colors.textDim, fontSize = 12.sp)
                    Box(Modifier.weight(1f)) { JsonValue(item) }
                }
            }
        }
        is JsonPrimitive -> Text(
            text = if (value is JsonNull) "null" else value.content,
            color = colors.textMuted,
            fontSize = 12.sp,
            lineHeight = 19.sp,
        )
        else -> Text(text = value.toString(), color = colors.textMuted, fontSize = 12.sp)
    }
}

@Composable
private fun TranscriptPanel(
    transcript: SubagentTranscriptState,
    maxHeight: androidx.compose.ui.unit.Dp,
    agentName: String?,
    onLoadMore: () -> Unit,
) {
    val colors = LocalOmpColors.current
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = colors.panel,
        shape = RoundedCornerShape(10.dp),
        border = BorderStroke(1.dp, colors.border),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            if (transcript.error != null && transcript.messages.isNotEmpty()) {
                Text(
                    text = transcript.error,
                    color = colors.statusError,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = maxHeight)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (transcript.messages.isEmpty() && !transcript.loading) {
                    Text(
                        text = transcript.error ?: stringResource(R.string.panels_transcript_no_messages),
                        color = if (transcript.error != null) colors.statusError else colors.textDim,
                        fontSize = 12.sp,
                    )
                } else {
                    // The role column is always reserved (web
                    // `SubagentTranscriptDialog` renders its label cell on
                    // every row), so a tool result no longer shifts the text
                    // column left. A run also survives non-speaker rows: the
                    // header repeats only when the speaker really changes.
                    var previous: Speaker? = null
                    transcript.messages.forEach { message ->
                        val speaker = transcriptSpeaker(message.role, agentName)
                        if (speaker != null && speaker != previous) {
                            SpeakerHeaderRow(
                                speaker = speaker,
                                timestamp = null,
                            )
                        }
                        if (speaker != null) previous = speaker
                        TranscriptRow(message = message)
                    }
                }
                if (transcript.loading) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(12.dp),
                            strokeWidth = 1.5.dp,
                            color = colors.accent,
                        )
                        Text(
                            text = stringResource(R.string.panels_transcript_loading),
                            color = colors.textDim,
                            fontSize = 11.sp,
                        )
                    }
                }
                if (!transcript.exhausted && !transcript.loading) {
                    Text(
                        text = stringResource(R.string.panels_transcript_load_more),
                        color = colors.accent,
                        fontSize = 12.sp,
                        modifier = Modifier.clickable(role = Role.Button, onClick = onLoadMore),
                    )
                }
            }
        }
    }
}

/** Who speaks in a subagent transcript: the agent's own output is named. */
private fun transcriptSpeaker(role: String, agentName: String?): Speaker? = when (role) {
    "user" -> Speaker(SpeakerRole.You)
    "assistant" -> Speaker(SpeakerRole.Subagent, agentName)
    else -> null
}

@Composable
private fun TranscriptRow(message: SubagentTranscriptMessage) {
    val colors = LocalOmpColors.current
    val (label, labelColor) = when (message.role) {
        "user" -> "U" to colors.accent
        "assistant" -> "A" to colors.textMuted
        else -> "R" to colors.textDim
    }
    val toolResult = message.role == "toolResult"
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        // The label cell is always laid out, even next to a speaker header, so
        // every row starts its text at the same x (web parity).
        Text(
            text = label,
            color = labelColor,
            fontSize = 10.sp,
            fontFamily = OmpMonoFontFamily,
            modifier = Modifier.width(10.dp).padding(top = 2.dp),
        )
        Text(
            text = message.text,
            color = if (toolResult) colors.textMuted else colors.text,
            fontSize = if (toolResult || message.role == "assistant") 11.5.sp else 12.5.sp,
            lineHeight = 18.sp,
            fontFamily = if (toolResult) FontFamily.Monospace else null,
            modifier = Modifier.weight(1f),
        )
    }
}
