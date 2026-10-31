package io.github.kahme247.ompweb.ui.chat

import io.github.kahme247.ompweb.chat.AgentPhase
import io.github.kahme247.ompweb.chat.AssistantBlock
import io.github.kahme247.ompweb.chat.ChatMessage
import io.github.kahme247.ompweb.chat.ChatState
import io.github.kahme247.ompweb.chat.LiveTool
import io.github.kahme247.ompweb.chat.RunningTool
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The folded row of the running turn is the only progress signal once "hide
 * tool activity" folds the live cards away, so what it says has to follow the
 * engine state exactly.
 */
class LiveFoldTest {

    @Test
    fun `an idle transcript has no live activity`() {
        assertNull(liveActivity(ChatState()))
    }

    @Test
    fun `a finished turn falls back to the static summary`() {
        // The last phase stays in the state after the run ends.
        val state = ChatState(
            agentRunning = false,
            streamingActive = false,
            agentPhase = AgentPhase.RunningTools(listOf(RunningTool("t1", "read"))),
        )
        assertNull(liveActivity(state))
    }

    @Test
    fun `waiting for the model before any text is thinking`() {
        val state = ChatState(agentRunning = true, agentPhase = AgentPhase.WaitingModel)
        assertEquals(LiveActivity.Thinking, liveActivity(state))
    }

    @Test
    fun `waiting for the model with streamed text is writing`() {
        val state = ChatState(
            agentRunning = true,
            streamingActive = true,
            agentPhase = AgentPhase.WaitingModel,
            streaming = assistant(text = "The answer starts"),
        )
        assertEquals(LiveActivity.Writing, liveActivity(state))
    }

    @Test
    fun `blank streamed text still reads as thinking`() {
        val state = ChatState(
            agentRunning = true,
            streamingActive = true,
            agentPhase = null,
            streaming = assistant(text = "   \n"),
        )
        assertEquals(LiveActivity.Thinking, liveActivity(state))
    }

    @Test
    fun `a running tool is named with its intent preview`() {
        val state = ChatState(
            agentRunning = true,
            agentPhase = AgentPhase.RunningTools(listOf(RunningTool("t1", "read"))),
            liveTools = listOf(liveTool(id = "t1", name = "read", args = "path" to "notes.md")),
        )
        assertEquals(LiveActivity.Tool("read", "notes.md", more = 0), liveActivity(state))
    }

    @Test
    fun `a tool without known arguments still names the tool`() {
        val state = ChatState(
            agentRunning = true,
            agentPhase = AgentPhase.RunningTools(listOf(RunningTool("t1", "bash"))),
        )
        assertEquals(LiveActivity.Tool("bash", "", more = 0), liveActivity(state))
    }

    @Test
    fun `parallel tool calls report how many others run`() {
        val state = ChatState(
            agentRunning = true,
            agentPhase = AgentPhase.RunningTools(
                listOf(RunningTool("t1", "bash"), RunningTool("t2", "read"), RunningTool("t3", "grep")),
            ),
            liveTools = listOf(liveTool(id = "t1", name = "bash", args = "command" to "ls -la")),
        )
        assertEquals(LiveActivity.Tool("bash", "ls -la", more = 2), liveActivity(state))
    }

    @Test
    fun `a running shell command is reported as such`() {
        val state = ChatState(agentRunning = true, agentPhase = AgentPhase.RunningCommand)
        assertEquals(LiveActivity.RunningCommand, liveActivity(state))
    }

    @Test
    fun `compaction wins over the last agent phase`() {
        val state = ChatState(
            agentRunning = true,
            compacting = true,
            agentPhase = AgentPhase.WaitingModel,
        )
        assertEquals(LiveActivity.Compacting, liveActivity(state))
    }

    @Test
    fun `a running prompt without an agent phase is thinking`() {
        val state = ChatState(promptRunning = true, streamingActive = true)
        assertEquals(LiveActivity.Thinking, liveActivity(state))
    }

    @Test
    fun `a tool call without a result names the running tool`() {
        // The real server reports `waiting for model` while a 60 s bash call
        // runs; the transcript still says which tool is pending.
        val messages = listOf(
            user("run it"),
            assistant(
                text = "",
                blocks = listOf(
                    AssistantBlock.ToolCall(
                        toolCallId = "t1",
                        toolName = "bash",
                        input = buildJsonObject { put("command", "sleep 60") },
                    ),
                ),
            ),
        )
        val state = ChatState(
            messages = messages,
            agentRunning = true,
            agentPhase = AgentPhase.WaitingModel,
        )
        assertEquals(LiveActivity.Tool("bash", "sleep 60", more = 0), liveActivity(state))
    }

    @Test
    fun `a resolved tool call is no longer the running activity`() {
        val messages = listOf(
            user("run it"),
            assistant(
                text = "",
                blocks = listOf(
                    AssistantBlock.ToolCall(
                        toolCallId = "t1",
                        toolName = "bash",
                        input = buildJsonObject { put("command", "sleep 60") },
                    ),
                ),
            ),
            ChatMessage.ToolResult(
                key = "r1",
                timestamp = 2L,
                entryId = null,
                toolCallId = "t1",
                toolName = "bash",
                text = "done",
            ),
        )
        val state = ChatState(
            messages = messages,
            agentRunning = true,
            agentPhase = AgentPhase.WaitingModel,
        )
        assertEquals(LiveActivity.Thinking, liveActivity(state))
    }

    @Test
    fun `parallel pending calls report how many others run`() {
        val messages = listOf(
            user("run both"),
            assistant(
                text = "",
                blocks = listOf(
                    AssistantBlock.ToolCall("t1", "bash", buildJsonObject { put("command", "ls") }),
                    AssistantBlock.ToolCall("t2", "read", buildJsonObject { put("path", "a.kt") }),
                ),
            ),
        )
        val state = ChatState(messages = messages, agentRunning = true)
        assertEquals(LiveActivity.Tool("read", "a.kt", more = 1), liveActivity(state))
    }

    @Test
    fun `a call from an older turn is not the running activity`() {
        val messages = listOf(
            user("run it"),
            assistant(
                text = "",
                blocks = listOf(
                    AssistantBlock.ToolCall("t1", "bash", buildJsonObject { put("command", "ls") }),
                ),
            ),
            assistant(text = "The suite is green."),
        )
        val state = ChatState(messages = messages, agentRunning = true)
        // The turn ended with an answer: the unanswered call above is history,
        // not something the running turn waits on.
        assertEquals(LiveActivity.Writing, liveActivity(state))
    }

    @Test
    fun `an answer in the running transcript is writing`() {
        val messages = listOf(
            user("write an essay"),
            assistant(text = "Long before anyone typed a word, inventors were trying."),
        )
        val state = ChatState(
            messages = messages,
            agentRunning = true,
            agentPhase = AgentPhase.WaitingModel,
        )
        assertEquals(LiveActivity.Writing, liveActivity(state))
    }

    @Test
    fun `the previous answer does not read as writing for a new prompt`() {
        val messages = listOf(
            assistant(text = "The suite is green."),
            user("now write an essay"),
        )
        val state = ChatState(
            messages = messages,
            agentRunning = true,
            agentPhase = AgentPhase.WaitingModel,
        )
        assertEquals(LiveActivity.Thinking, liveActivity(state))
    }

    private fun user(text: String) = ChatMessage.User(
        key = "u:${text.hashCode()}",
        timestamp = 0L,
        entryId = null,
        text = text,
    )

    private fun assistant(
        text: String,
        blocks: List<AssistantBlock> = listOf(AssistantBlock.Text(text)),
    ) = ChatMessage.Assistant(
        key = "a:${blocks.hashCode()}",
        timestamp = 1L,
        entryId = null,
        blocks = blocks,
        streaming = true,
    )

    private fun liveTool(id: String, name: String, args: Pair<String, String>) = LiveTool(
        toolCallId = id,
        toolName = name,
        args = buildJsonObject { put(args.first, args.second) },
        result = null,
        startedAt = 1L,
    )
}
