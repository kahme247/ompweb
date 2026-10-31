package io.github.kahme247.ompweb.screenshot

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import io.github.kahme247.ompweb.chat.AgentPhase
import io.github.kahme247.ompweb.chat.AssistantBlock
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.ChatState
import io.github.kahme247.ompweb.chat.ContextUsage
import io.github.kahme247.ompweb.chat.HeaderSlot
import io.github.kahme247.ompweb.chat.LiveTool
import io.github.kahme247.ompweb.chat.ForkTarget
import io.github.kahme247.ompweb.chat.ModelRef
import io.github.kahme247.ompweb.chat.RunningTool
import io.github.kahme247.ompweb.chat.TranscriptFormat
import io.github.kahme247.ompweb.chat.TranscriptPlan
import io.github.kahme247.ompweb.chat.TranscriptRow
import io.github.kahme247.ompweb.domain.SkillDiagnostic
import io.github.kahme247.ompweb.domain.SkillDiagnosticReason
import io.github.kahme247.ompweb.domain.SkillDiagnosticsSnapshot
import io.github.kahme247.ompweb.domain.SkillDuplicate
import io.github.kahme247.ompweb.domain.SkillEntry
import io.github.kahme247.ompweb.events.ConnectionState
import io.github.kahme247.ompweb.ui.chat.AssistantRow
import io.github.kahme247.ompweb.ui.chat.ChatFooter
import io.github.kahme247.ompweb.ui.chat.ChatPreferences
import io.github.kahme247.ompweb.ui.chat.ChatRow
import io.github.kahme247.ompweb.ui.chat.ChatRowCallbacks
import io.github.kahme247.ompweb.ui.chat.ChatUiState
import io.github.kahme247.ompweb.ui.chat.CompactionNotice
import io.github.kahme247.ompweb.ui.chat.LocalChatClock
import io.github.kahme247.ompweb.ui.chat.LocalChatMotion
import io.github.kahme247.ompweb.ui.chat.ComposerModeStatus
import io.github.kahme247.ompweb.ui.chat.SkillDiagnosticsBody
import io.github.kahme247.ompweb.ui.chat.SystemPromptBody
import io.github.kahme247.ompweb.ui.chat.SystemPromptState
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.junit.Test

/**
 * The transcript at every matrix cell: user row, assistant markdown with a
 * highlighted code block and list, an edit tool row with its unified diff, and
 * a failed tool row. The diff expands before the capture, so the widest content
 * (side-by-side/split diff at 320 dp) is part of the golden.
 */
class ChatTranscriptScreenshotsTest : ScreenshotTest() {

    @Test
    fun transcript() = composeRule.verifyScreenshotMatrix(
        name = "chat-transcript",
        heightDp = 1600,
        interact = {
            composeRule.onAllNodesWithTag("chat-tool-card-header").onFirst().performClick()
        },
    ) {
        ChatTranscriptFixture()
    }
}

@Composable
internal fun ChatTranscriptFixture() {
    val messages = remember { transcriptMessages() }
    val state = remember { transcriptState(messages) }
    val indexByKey = remember(messages) {
        messages.mapIndexed { index, message -> message.key to index }.toMap()
    }
    val callbacks = remember {
        ChatRowCallbacks(
            onLink = {},
            onFork = { _, _ -> },
            onLoadThinking = { _, _ -> },
            onToggleSpeech = { _, _, _ -> },
            onStopSpeech = {},
            onLoadBashOutput = {},
            onDownloadBashOutput = {},
            onEditFromHere = { _, _ -> },
        )
    }
    val headers = remember(messages) { messageHeaders(messages) }
    val dayBreaks = remember(messages) { messageDayBreaks(messages) }
    Column(
        modifier = Modifier.fillMaxWidth().padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        messages.forEach { message ->
            ChatRow(
                row = TranscriptRow.Message(message),
                messages = messages,
                state = state,
                liveTail = false,
                indexByKey = indexByKey,
                callbacks = callbacks,
                headers = headers,
                dayBreaks = dayBreaks,
            )
        }
    }
}

/** Day separators of a flat message fixture, exactly as the chat screen computes them. */
private fun messageDayBreaks(messages: List<ChatMessage>): Map<String, Long> =
    TranscriptFormat.daySeparators(messages.map { TranscriptRow.Message(it) })

internal fun transcriptState(messages: List<ChatMessage>): ChatUiState = ChatUiState(
    engine = ChatState(messages = messages),
    toolResults = mapOf(
        "call-edit" to editResult(),
        "call-fail" to failedResult(),
    ),
    preferences = ChatPreferences(toolCallsCollapsed = true, hideToolActivity = false),
)

/** Speaker headers of standalone message rows, computed exactly like the transcript. */
internal fun messageHeaders(messages: List<ChatMessage>): Map<String, HeaderSlot> =
    TranscriptFormat.headerSlots(
        TranscriptFormat.headerBlocks(messages.map { TranscriptRow.Message(it) }),
    )

/** Speaker headers of already planned rows (a turn group keeps its own blocks). */
internal fun rowHeaders(rows: List<TranscriptRow>): Map<String, HeaderSlot> =
    TranscriptFormat.headerSlots(TranscriptFormat.headerBlocks(rows))

internal fun transcriptMessages(): List<ChatMessage> = listOf(
    ChatMessage.User(
        key = "user-1",
        timestamp = SCREENSHOT_NOW - 13 * 3_600_000L,
        entryId = "entry-user-1",
        text = "The composer's **+** button is unusable with TalkBack. " +
            "Show me the diff and run the unit tests.",
    ),
    ChatMessage.Assistant(
        key = "assistant-1",
        timestamp = SCREENSHOT_NOW - 12 * 3_600_000L - 55 * 60_000L,
        entryId = "entry-assistant-1",
        blocks = listOf(
            AssistantBlock.Text(
                """
                ### Composer hardening

                Two changes in `ComposerBar.kt`:

                - the attach button now exposes **Add attachment** to TalkBack
                - the touch target is 48 dp at every font scale

                ```kotlin
                IconButton(onClick = { plusOpen = true }) {
                    Text("+", fontSize = 20.sp)
                }
                ```

                The menu still offers file, image, camera and clipboard.
                """.trimIndent(),
            ),
        ),
        model = "claude-sonnet-4",
        provider = "anthropic",
        durationMs = 2400.0,
    ),
    ChatMessage.Assistant(
        key = "assistant-2",
        timestamp = SCREENSHOT_NOW - 60_000L,
        entryId = "entry-assistant-2",
        blocks = listOf(
            AssistantBlock.ToolCall(
                toolCallId = "call-edit",
                toolName = "edit",
                input = buildJsonObject {
                    put("path", "android/app/src/main/java/io/github/kahme247/ompweb/ui/composer/ComposerBar.kt")
                    put("old_string", "modifier = Modifier.size(28.dp),")
                    put("new_string", "modifier = Modifier.semantics { contentDescription = attachLabel },")
                },
            ),
            AssistantBlock.ToolCall(
                toolCallId = "call-fail",
                toolName = "bash",
                input = buildJsonObject { put("command", "./gradlew testDebugUnitTest --tests '*Composer*'") },
            ),
        ),
        model = "claude-sonnet-4",
        provider = "anthropic",
    ),
)

private fun editResult(): ChatMessage.ToolResult = ChatMessage.ToolResult(
    key = "result-edit",
    timestamp = null,
    entryId = null,
    toolCallId = "call-edit",
    toolName = "edit",
    text = "Applied 1 edit to ComposerBar.kt",
    details = buildJsonObject {
        put(
            "diff",
            """
            --- a/android/app/src/main/java/io/github/kahme247/ompweb/ui/composer/ComposerBar.kt
            +++ b/android/app/src/main/java/io/github/kahme247/ompweb/ui/composer/ComposerBar.kt
            @@ -455,9 +455,11 @@
                             Box {
                                 IconButton(
                                     onClick = { plusOpen = true },
            -                        modifier = Modifier.size(28.dp),
            +                        modifier = Modifier.semantics {
            +                            contentDescription = attachLabel
            +                        },
                                 ) {
                                     Text("+", color = colors.textMuted, fontSize = 20.sp)
                                 }
            """.trimIndent(),
        )
        put("durationMs", 320)
    },
)

private fun failedResult(): ChatMessage.ToolResult = ChatMessage.ToolResult(
    key = "result-fail",
    timestamp = null,
    entryId = null,
    toolCallId = "call-fail",
    toolName = "bash",
    text = "FAILED testComposerAttachmentChip\n1 test failed",
    isError = true,
    details = buildJsonObject {
        put("durationMs", 41_000)
    },
)

// ------------------------------------------------------------- A13 guard

/**
 * A13: a 100 001-character message renders as its reveal button, never as
 * parsed markdown — and the button names the size.
 */
class ChatLargeMessageScreenshotsTest : ScreenshotTest() {

    @Test
    fun largeMessage() = composeRule.verifyScreenshotMatrix(name = "chat-large-message", heightDp = 620) {
        val messages = remember { largeMessageFixture() }
        val state = remember(messages) { ChatUiState(engine = ChatState(messages = messages)) }
        val indexByKey = remember(messages) { messages.mapIndexed { index, m -> m.key to index }.toMap() }
        val headers = remember(messages) { messageHeaders(messages) }
        val dayBreaks = remember(messages) { messageDayBreaks(messages) }
        Column(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            messages.forEach { message ->
                val row = TranscriptRow.Message(message)
                ChatRow(
                    row = row,
                    messages = messages,
                    state = state,
                    liveTail = false,
                    indexByKey = indexByKey,
                    callbacks = screenshotCallbacks(),
                    headers = headers,
                    dayBreaks = dayBreaks,
                )
            }
        }
    }
}

private fun largeMessageFixture(): List<ChatMessage> = listOf(
    ChatMessage.User(
        key = "user-large",
        timestamp = SCREENSHOT_NOW - 600_000L,
        entryId = "entry-user-large",
        text = "Here is the whole log. Summarize the failures.",
    ),
    ChatMessage.Assistant(
        key = "assistant-large",
        timestamp = SCREENSHOT_NOW - 590_000L,
        entryId = "entry-assistant-large",
        blocks = listOf(AssistantBlock.Text("x".repeat(100_001))),
        model = "claude-sonnet-4",
        provider = "anthropic",
    ),
)

// ----------------------------------------------------- A14 user row actions

/**
 * A14: a long user prompt is clamped to 300 dp with "Show full", and the row
 * offers Copy, "Edit from here" and the fork action.
 */
class ChatUserRowScreenshotsTest : ScreenshotTest() {

    @Test
    fun userRow() = composeRule.verifyScreenshotMatrix(name = "chat-user-row", heightDp = 620) {
        val messages = remember { userRowFixture() }
        val state = remember(messages) {
            ChatUiState(
                engine = ChatState(messages = messages),
                forkTargets = listOf(null, ForkTarget("entry-user-2", editPrompt = false)),
            )
        }
        Column(Modifier.fillMaxWidth().padding(10.dp)) {
            val row = TranscriptRow.Message(messages[1])
            ChatRow(
                row = row,
                messages = messages,
                state = state,
                liveTail = false,
                indexByKey = mapOf("entry-assistant-1" to 0, "entry-user-2" to 1),
                callbacks = screenshotCallbacks(),
                headers = messageHeaders(messages),
                dayBreaks = TranscriptFormat.daySeparators(listOf(row)),
            )
        }
    }
}

private fun userRowFixture(): List<ChatMessage> = listOf(
    ChatMessage.Assistant(
        key = "entry-assistant-1",
        timestamp = SCREENSHOT_NOW - 120_000L,
        entryId = "entry-assistant-1",
        blocks = listOf(AssistantBlock.Text("Which part should I change?")),
    ),
    ChatMessage.User(
        key = "entry-user-2",
        timestamp = SCREENSHOT_NOW - 60_000L,
        entryId = "entry-user-2",
        text = (1..40).joinToString(" ") {
            "Sentence $it keeps the pasted prompt long enough to overflow the bubble."
        },
    ),
)

// ------------------------------------------------------ A15 footer phases

/**
 * A15: the status line names the phase (waiting for the model, running tools,
 * running a shell command) instead of a blanket "working".
 */
class ChatFooterPhasesScreenshotsTest : ScreenshotTest() {

    @Test
    fun footerPhases() = composeRule.verifyScreenshotMatrix(name = "chat-footer-phases", heightDp = 140) {
        val base = ChatState(
            agentRunning = true,
            promptRunning = true,
            model = ModelRef("anthropic", "claude-sonnet-4"),
            thinkingLevel = "high",
            contextUsage = ContextUsage(tokens = 68_000, contextWindow = 200_000, percent = 34.0),
        )
        Column(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ChatFooter(ChatUiState(engine = base.copy(agentPhase = AgentPhase.WaitingModel)))
            ChatFooter(
                ChatUiState(
                    engine = base.copy(
                        agentPhase = AgentPhase.RunningTools(
                            listOf(RunningTool("1", "bash"), RunningTool("2", "read")),
                        ),
                    ),
                ),
            )
            ChatFooter(ChatUiState(engine = base.copy(agentPhase = AgentPhase.RunningCommand)))
        }
    }
}

// --------------------------------------------------------- B10 plan banner

/** B10: the `/plan` banner above the composer names the running objective. */
class ChatPlanBannerScreenshotsTest : ScreenshotTest() {

    @Test
    fun planBanner() = composeRule.verifyScreenshotMatrix(name = "chat-plan-banner", heightDp = 160) {
        Column(Modifier.fillMaxWidth().padding(10.dp)) {
            ComposerModeStatus(goal = null, plan = "Migrate the composer to the attachment API")
        }
    }
}

// ------------------------------------------------------- B11 live tok/s pill

/**
 * B11: the streaming reply shows its running token estimate and the live
 * tokens-per-second pill.
 */
class ChatStreamingScreenshotsTest : ScreenshotTest() {

    @Test
    fun streaming() = composeRule.verifyScreenshotMatrix(name = "chat-streaming", heightDp = 420) {
        val message = remember {
            ChatMessage.Assistant(
                key = "streaming",
                timestamp = SCREENSHOT_NOW - 5_000L,
                entryId = null,
                blocks = listOf(
                    AssistantBlock.Text(
                        "The composer now keeps its attachments across a session switch, " +
                            "and the reveal button names the size of a large paste.",
                    ),
                ),
                model = "claude-sonnet-4",
                provider = "anthropic",
                streaming = true,
            )
        }
        val state = remember {
            ChatUiState(
                engine = ChatState(
                    messages = emptyList(),
                    streamingActive = true,
                    agentRunning = true,
                    promptRunning = true,
                    tokensPerSecond = 12.3,
                    liveTokensPerSecond = 12.3,
                ),
            )
        }
        Column(Modifier.fillMaxWidth().padding(10.dp)) {
            AssistantRow(
                message = message,
                state = state,
                forkTarget = null,
                streaming = true,
                callbacks = screenshotCallbacks(),
                header = HeaderSlot(
                    key = "streaming",
                    showHeader = true,
                    speaker = TranscriptFormat.speakerOf(message),
                    timestamp = message.timestamp,
                ),
            )
        }
    }
}

// ------------------------------------------------------ B19 hidden tools

/**
 * B19: with tool activity hidden the running turn keeps its fold instead of a
 * flat live tail, and collapsed tool cards stay folded.
 */
class ChatHiddenToolsScreenshotsTest : ScreenshotTest() {

    @Test
    fun hiddenTools() = composeRule.verifyScreenshotMatrix(name = "chat-hidden-tools", heightDp = 520) {
        val messages = remember { specialFixture() }
        val state = remember(messages) {
            ChatUiState(
                engine = ChatState(messages = messages, streamingActive = true, agentRunning = true),
                preferences = ChatPreferences(
                    toolCallsCollapsed = true,
                    hideToolActivity = true,
                    expandThinking = false,
                ),
            )
        }
        val indexByKey = remember(messages) { messages.mapIndexed { index, m -> m.key to index }.toMap() }
        val headers = remember(messages) { messageHeaders(messages) }
        val dayBreaks = remember(messages) { messageDayBreaks(messages) }
        Column(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            messages.forEach { message ->
                ChatRow(
                    row = TranscriptRow.Message(message),
                    messages = messages,
                    state = state,
                    liveTail = false,
                    indexByKey = indexByKey,
                    callbacks = screenshotCallbacks(),
                    headers = headers,
                    dayBreaks = dayBreaks,
                )
            }
        }
    }

    /**
     * The folded row of the RUNNING turn: live indicator, current tool with its
     * intent, the counters and the ticking elapsed time. Reduced motion (the
     * platform's animator scale off) keeps the dot static.
     */
    @Test
    fun runningFold() = composeRule.verifyScreenshotMatrix(name = "chat-hidden-tools-running", heightDp = 420) {
        val messages = remember { runningFoldFixture() }
        val state = remember(messages) {
            ChatUiState(
                engine = ChatState(
                    messages = messages,
                    streamingActive = true,
                    agentRunning = true,
                    agentPhase = AgentPhase.RunningTools(
                        listOf(RunningTool("call-bash", "bash"), RunningTool("call-read", "read")),
                    ),
                    liveTools = listOf(
                        LiveTool(
                            toolCallId = "call-bash",
                            toolName = "bash",
                            args = buildJsonObject { put("command", "pnpm test") },
                            result = null,
                            startedAt = RUNNING_TURN_START,
                        ),
                    ),
                ),
                preferences = ChatPreferences(
                    toolCallsCollapsed = true,
                    hideToolActivity = true,
                    expandThinking = false,
                ),
            )
        }
        val row = remember(messages) {
            TranscriptPlan.build(messages, hideThinking = false)
                .filterIsInstance<TranscriptRow.Group>()
                .single()
        }
        val indexByKey = remember(messages) { messages.mapIndexed { index, m -> m.key to index }.toMap() }
        val headers = remember(row) { rowHeaders(listOf(row)) }
        val dayBreaks = remember(row) { TranscriptFormat.daySeparators(listOf(row)) }
        CompositionLocalProvider(
            LocalChatMotion provides false,
            LocalChatClock provides { RUNNING_TURN_START + 42_000 },
        ) {
            Column(Modifier.fillMaxWidth().padding(10.dp)) {
                ChatRow(
                    row = row,
                    messages = messages,
                    state = state,
                    liveTail = false,
                    indexByKey = indexByKey,
                    callbacks = screenshotCallbacks(),
                    runningTurn = true,
                    headers = headers,
                    dayBreaks = dayBreaks,
                )
            }
        }
    }
}

private val RUNNING_TURN_START = SCREENSHOT_NOW - 60_000L

private fun runningFoldFixture(): List<ChatMessage> = listOf(
    ChatMessage.User(
        key = "user-run",
        timestamp = RUNNING_TURN_START,
        entryId = "entry-user-run",
        text = "Run the suite and fix what fails.",
    ),
    ChatMessage.Assistant(
        key = "assistant-run",
        timestamp = RUNNING_TURN_START,
        entryId = "entry-assistant-run",
        blocks = listOf(
            AssistantBlock.Thinking(
                thinking = "Run the suite first; the read follows the failure.",
                deferred = false,
                blockIndex = 0,
            ),
            AssistantBlock.ToolCall(
                toolCallId = "call-bash",
                toolName = "bash",
                input = buildJsonObject { put("command", "pnpm test") },
            ),
            AssistantBlock.ToolCall(
                toolCallId = "call-read",
                toolName = "read",
                input = buildJsonObject { put("path", "app/src/main.kt") },
            ),
        ),
        model = "claude-sonnet-4",
        provider = "anthropic",
    ),
)

private fun specialFixture(): List<ChatMessage> = listOf(
    ChatMessage.User(
        key = "user-1",
        timestamp = SCREENSHOT_NOW - 300_000L,
        entryId = "entry-user-1",
        text = "Run the tests and review the diff.",
    ),
    ChatMessage.Assistant(
        key = "assistant-tools",
        timestamp = SCREENSHOT_NOW - 240_000L,
        entryId = "entry-assistant-tools",
        blocks = listOf(
            AssistantBlock.Thinking(
                thinking = "First run the suite, then hand the diff to a reviewer.",
                deferred = false,
                blockIndex = 0,
            ),
            AssistantBlock.ToolCall(
                toolCallId = "call-task",
                toolName = "task",
                input = buildJsonObject {
                    put("agent", "reviewer")
                    put("task", "Review the composer diff")
                },
            ),
        ),
        model = "claude-sonnet-4",
        provider = "anthropic",
    ),
    ChatMessage.Assistant(
        key = "assistant-answer",
        timestamp = SCREENSHOT_NOW - 120_000L,
        entryId = "entry-assistant-answer",
        blocks = listOf(AssistantBlock.Text("The suite is green; the reviewer found one nit.")),
        model = "claude-sonnet-4",
        provider = "anthropic",
        durationMs = 2400.0,
    ),
)

// ------------------------------------------------------ B32 special rows

/**
 * B32: the non-text transcript rows — a task panel, a hub panel, the
 * compacted-history notice with the compaction row, and a custom (advisor) row.
 */
class ChatSpecialRowsScreenshotsTest : ScreenshotTest() {

    @Test
    fun specialRows() = composeRule.verifyScreenshotMatrix(name = "chat-special-rows", heightDp = 1400) {
        val messages = remember { specialRowsFixture() }
        val state = remember(messages) {
            ChatUiState(
                engine = ChatState(messages = messages, includePreCompaction = false),
                toolResults = mapOf(
                    "call-task" to taskResult(),
                    "call-hub" to hubResult(),
                ),
                hasCompaction = true,
                connection = ConnectionState.Connected,
                preferences = ChatPreferences(toolCallsCollapsed = false, hideToolActivity = false),
            )
        }
        val indexByKey = remember(messages) { messages.mapIndexed { index, m -> m.key to index }.toMap() }
        val headers = remember(messages) { messageHeaders(messages) }
        Column(
            modifier = Modifier.fillMaxWidth().padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // The compacted-history notice is the transcript's first item (web
            // `ChatWindow`), not a composer banner.
            CompactionNotice(includePreCompaction = false, onToggle = {})
            val dayBreaks = remember(messages) { messageDayBreaks(messages) }
            messages.forEach { message ->
                ChatRow(
                    row = TranscriptRow.Message(message),
                    messages = messages,
                    state = state,
                    liveTail = false,
                    indexByKey = indexByKey,
                    callbacks = screenshotCallbacks(),
                    headers = headers,
                    dayBreaks = dayBreaks,
                )
            }
        }
    }
}

private fun specialRowsFixture(): List<ChatMessage> = listOf(
    ChatMessage.Custom(
        key = "compaction",
        timestamp = SCREENSHOT_NOW - 7_200_000L,
        entryId = "entry-compaction",
        customType = "compaction",
        text = """
            The composer work landed in three slices and the parity audit closed.

            <read-files>
            android/app/src/main/java/io/github/kahme247/ompweb/ui/composer/ComposerBar.kt
            </read-files>
            <modified-files>
            android/app/src/main/java/io/github/kahme247/ompweb/ui/chat/ChatRows.kt
            </modified-files>
        """.trimIndent(),
        details = buildJsonObject {
            put("method", "manual")
            put("tokensBefore", 120_400)
            put("tokensAfter", 28_900)
        },
    ),
    ChatMessage.Assistant(
        key = "assistant-task",
        timestamp = SCREENSHOT_NOW - 3_000_000L,
        entryId = "entry-assistant-task",
        blocks = listOf(
            AssistantBlock.ToolCall(
                toolCallId = "call-task",
                toolName = "task",
                input = buildJsonObject {
                    put("agent", "reviewer")
                    put("task", "Review the composer diff")
                },
            ),
        ),
        model = "claude-sonnet-4",
        provider = "anthropic",
    ),
    ChatMessage.Assistant(
        key = "assistant-hub",
        timestamp = SCREENSHOT_NOW - 1_000_000L,
        entryId = "entry-assistant-hub",
        blocks = listOf(
            AssistantBlock.ToolCall(
                toolCallId = "call-hub",
                toolName = "hub",
                input = buildJsonObject {
                    put("op", "send")
                    put("to", "#dev")
                    put("message", "The composer audit is green; ready for review.")
                },
            ),
        ),
        model = "claude-sonnet-4",
        provider = "anthropic",
    ),
    ChatMessage.Custom(
        key = "advisor",
        timestamp = null,
        entryId = "entry-advisor",
        customType = "advisor",
        text = "**Advisor:** switch to the smaller model for this task.",
    ),
)

private fun taskResult(): ChatMessage.ToolResult = ChatMessage.ToolResult(
    key = "result-task",
    timestamp = null,
    entryId = null,
    toolCallId = "call-task",
    toolName = "task",
    text = "1 subagent finished",
    details = buildJsonObject {
        putJsonArray("results") {
            addJsonObject {
                put("agent", "reviewer")
                put("status", "completed")
                put("task", "Review the composer diff")
                put("tokens", 12_400)
                put("cost", 0.42)
                put("durationMs", 92_000)
                put("resolvedModel", "claude-sonnet-4")
            }
            addJsonObject {
                put("agent", "verifier")
                put("status", "started")
                put("task", "Run the 320 dp golden")
                put("tokens", 3_100)
            }
        }
        put("totalDurationMs", 92_000)
    },
    partial = true,
)

private fun hubResult(): ChatMessage.ToolResult = ChatMessage.ToolResult(
    key = "result-hub",
    timestamp = null,
    entryId = null,
    toolCallId = "call-hub",
    toolName = "hub",
    text = "sent",
    details = buildJsonObject {
        putJsonArray("receipts") {
            addJsonObject {
                put("to", "#dev")
                put("outcome", "sent")
            }
        }
    },
    partial = true,
)

// ------------------------------------------------------------ A26 dialogs

/**
 * A26: the system-prompt sheet and the skill-diagnostics dialog render through
 * the matrix, so the 200 % cells cover their layout (the dialog window itself
 * is scaled by `OmpDialogContent`).
 */
class ChatDialogsScreenshotsTest : ScreenshotTest() {

    @Test
    fun systemPromptDialog() = composeRule.verifyScreenshotMatrix(name = "chat-system-prompt-dialog", heightDp = 760) {
        Column(Modifier.fillMaxWidth().padding(10.dp)) {
            SystemPromptBody(
                state = SystemPromptState.Loaded(SYSTEM_PROMPT),
                onDismiss = {},
            )
        }
    }

    @Test
    fun skillDiagnosticsDialog() = composeRule.verifyScreenshotMatrix(
        name = "chat-skill-diagnostics-dialog",
        heightDp = 900,
    ) {
        Column(Modifier.fillMaxWidth().padding(10.dp)) {
            SkillDiagnosticsBody(snapshot = skillDiagnosticsFixture(), onDismiss = {})
        }
    }
}

private const val SYSTEM_PROMPT = """You are omp, a terminal coding agent.

Work in the repository you were started in. Read before you edit, keep the
diff minimal, and verify what you changed.

Available tools: read, write, edit, bash, grep, glob, ast_edit, task, hub.
The user's project is a Next.js web app with an Android client; both must stay
in parity. Never run a production build from a coding session."""

private fun skillDiagnosticsFixture(): SkillDiagnosticsSnapshot = SkillDiagnosticsSnapshot(
    cwd = "/home/dev/ompweb",
    showStartupDiagnostics = true,
    diagnostics = listOf(
        SkillDiagnostic(
            name = "code-review",
            reason = SkillDiagnosticReason.CUSTOM_DIRECTORY,
            skills = listOf(
                SkillEntry(
                    name = "code-review",
                    filePath = "/home/dev/ompweb/.omp/skills/code-review/SKILL.md",
                    source = "custom",
                ),
                SkillEntry(
                    name = "code-review",
                    filePath = "/home/dev/ompweb/android/.omp/skills/code-review/SKILL.md",
                    source = "project",
                ),
            ),
            duplicates = listOf(
                SkillDuplicate(
                    skill = SkillEntry(
                        name = "code-review",
                        filePath = "/home/dev/ompweb/.omp/skills/code-review/SKILL.md",
                        source = "custom",
                    ),
                    retained = SkillEntry(
                        name = "code-review",
                        filePath = "/home/dev/ompweb/android/.omp/skills/code-review/SKILL.md",
                        source = "project",
                    ),
                ),
            ),
        ),
        SkillDiagnostic(
            name = "yara",
            reason = SkillDiagnosticReason.AUTHORED_OVER_INSTALLED,
            skills = listOf(
                SkillEntry(
                    name = "yara",
                    filePath = "/home/dev/ompweb/.omp/skills/yara/SKILL.md",
                    source = "authored",
                ),
                SkillEntry(
                    name = "yara",
                    filePath = "/opt/omp/plugins/security/skills/yara/SKILL.md",
                    source = "plugin",
                    pluginName = "security",
                ),
            ),
            duplicates = emptyList(),
        ),
    ),
)

private fun screenshotCallbacks(): ChatRowCallbacks = ChatRowCallbacks(
    onLink = {},
    onFork = { _, _ -> },
    onLoadThinking = { _, _ -> },
    onToggleSpeech = { _, _, _ -> },
    onStopSpeech = {},
    onLoadBashOutput = {},
    onDownloadBashOutput = {},
    onEditFromHere = { _, _ -> },
)
